import type { ColorLayer, RGB } from '../types/editor';
import { loadImage } from './canvasRenderer';

const ANALYSIS_SIZE = 256;
const MIN_SHARE = 0.002;
const OPAQUE_ALPHA = 128;

/** Distância "redmean": aproximação barata da percepção humana de cor (ao quadrado). */
function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number) {
  const rMean = (r1 + r2) / 2;
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return (2 + rMean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rMean) / 256) * db * db;
}

function readPixels(image: HTMLImageElement, maxSize?: number) {
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;
  const ratio = maxSize ? Math.min(1, maxSize / Math.max(naturalWidth, naturalHeight)) : 1;
  const width = Math.max(1, Math.round(naturalWidth * ratio));
  const height = Math.max(1, Math.round(naturalHeight * ratio));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('Canvas indisponível');
  }

  ctx.drawImage(image, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/** Encontra as cores dominantes da arte (ignorando áreas transparentes). */
export async function detectColors(imageSrc: string, maxColors: number): Promise<ColorLayer[]> {
  const image = await loadImage(imageSrc);
  const { data } = readPixels(image, ANALYSIS_SIZE);

  const pixels: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] >= OPAQUE_ALPHA) {
      pixels.push(data[i], data[i + 1], data[i + 2]);
    }
  }

  const total = pixels.length / 3;
  if (total === 0) {
    return [];
  }

  // Histograma com 5 bits por canal para achar os candidatos mais frequentes.
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  for (let i = 0; i < pixels.length; i += 3) {
    const key = ((pixels[i] >> 3) << 10) | ((pixels[i + 1] >> 3) << 5) | (pixels[i + 2] >> 3);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.r += pixels[i];
      bucket.g += pixels[i + 1];
      bucket.b += pixels[i + 2];
    } else {
      buckets.set(key, { count: 1, r: pixels[i], g: pixels[i + 1], b: pixels[i + 2] });
    }
  }

  const candidates = [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .map((bucket) => [bucket.r / bucket.count, bucket.g / bucket.count, bucket.b / bucket.count] as RGB);

  // Escolhe candidatos frequentes e bem diferentes entre si, afrouxando o critério aos poucos.
  const centers: RGB[] = [];
  for (const threshold of [9000, 5000, 2500, 1200]) {
    for (const candidate of candidates) {
      if (centers.length >= maxColors) {
        break;
      }

      const distinct = centers.every(
        (center) => colorDistance(...candidate, ...center) > threshold,
      );
      if (distinct) {
        centers.push(candidate);
      }
    }
  }

  // Refina os centros com algumas iterações de k-means.
  const assignment = new Uint8Array(total);
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let p = 0; p < total; p += 1) {
      const r = pixels[p * 3];
      const g = pixels[p * 3 + 1];
      const b = pixels[p * 3 + 2];
      let best = 0;
      let bestDistance = Infinity;
      for (let c = 0; c < centers.length; c += 1) {
        const distance = colorDistance(r, g, b, ...centers[c]);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = c;
        }
      }
      assignment[p] = best;
      sums[best][0] += r;
      sums[best][1] += g;
      sums[best][2] += b;
      sums[best][3] += 1;
    }

    sums.forEach(([r, g, b, count], c) => {
      if (count > 0) {
        centers[c] = [r / count, g / count, b / count];
      }
    });
  }

  const counts = centers.map(() => 0);
  assignment.forEach((c) => {
    counts[c] += 1;
  });

  return centers
    .map((center, index) => ({
      id: `color-${index}-${Math.random().toString(16).slice(2, 8)}`,
      color: center.map((channel) => Math.round(channel)) as RGB,
      share: counts[index] / total,
      level: 1,
    }))
    .filter((layer) => layer.share >= MIN_SHARE)
    .sort((a, b) => b.share - a.share);
}

interface ColorMap {
  width: number;
  height: number;
  base: Uint8ClampedArray;
  /** Cor mais próxima de cada pixel. */
  nearest: Uint8Array;
  /** Segunda cor mais próxima (para suavizar bordas). */
  second: Uint8Array;
  /** Quanto o pixel puxa para a segunda cor (0-255). */
  blend: Uint8Array;
}

const MAP_CACHE_LIMIT = 4;
const mapCache = new Map<string, Promise<ColorMap>>();

async function buildColorMap(imageSrc: string, palette: RGB[]): Promise<ColorMap> {
  const image = await loadImage(imageSrc);
  const { data, width, height } = readPixels(image);
  const length = width * height;
  const nearest = new Uint8Array(length);
  const second = new Uint8Array(length);
  const blend = new Uint8Array(length);

  for (let p = 0; p < length; p += 1) {
    if (data[p * 4 + 3] === 0) {
      continue;
    }

    const r = data[p * 4];
    const g = data[p * 4 + 1];
    const b = data[p * 4 + 2];
    let first = 0;
    let firstDistance = Infinity;
    let next = 0;
    let nextDistance = Infinity;
    for (let c = 0; c < palette.length; c += 1) {
      const distance = colorDistance(r, g, b, ...palette[c]);
      if (distance < firstDistance) {
        next = first;
        nextDistance = firstDistance;
        first = c;
        firstDistance = distance;
      } else if (distance < nextDistance) {
        next = c;
        nextDistance = distance;
      }
    }

    nearest[p] = first;
    second[p] = next;
    if (Number.isFinite(nextDistance)) {
      const d1 = Math.sqrt(firstDistance);
      const d2 = Math.sqrt(nextDistance);
      blend[p] = d1 + d2 > 0 ? Math.round((d1 / (d1 + d2)) * 255) : 0;
    }
  }

  return { width, height, base: data, nearest, second, blend };
}

function getColorMap(imageSrc: string, palette: RGB[]) {
  const key = `${palette.map((color) => color.join(',')).join('|')}::${imageSrc}`;
  let entry = mapCache.get(key);
  if (entry) {
    mapCache.delete(key);
  } else {
    entry = buildColorMap(imageSrc, palette);
    entry.catch(() => mapCache.delete(key));
  }

  mapCache.set(key, entry);
  while (mapCache.size > MAP_CACHE_LIMIT) {
    mapCache.delete(mapCache.keys().next().value as string);
  }

  return entry;
}

export function hasActiveColorLayers(layers?: ColorLayer[]): layers is ColorLayer[] {
  return Boolean(layers?.some((layer) => layer.level < 1 || layer.replacement));
}

/** Aplica a intensidade (transparência) e a troca de cor de cada camada, sem alterar a imagem original. */
export async function renderColorLayers(imageSrc: string, layers: ColorLayer[]): Promise<ImageData> {
  const map = await getColorMap(imageSrc, layers.map((layer) => layer.color));
  const levels = layers.map((layer) => Math.max(0, Math.min(1, layer.level)));
  // Deslocamento aplicado a cada pixel da camada: nova cor - cor detectada (preserva sombras e bordas suaves).
  const shifts = layers.map((layer) =>
    layer.replacement
      ? [
          layer.replacement[0] - layer.color[0],
          layer.replacement[1] - layer.color[1],
          layer.replacement[2] - layer.color[2],
        ]
      : [0, 0, 0],
  );
  const output = new ImageData(map.width, map.height);
  const out = output.data;
  out.set(map.base);

  for (let p = 0; p < map.nearest.length; p += 1) {
    const alpha = map.base[p * 4 + 3];
    if (alpha === 0) {
      continue;
    }

    const first = map.nearest[p];
    const next = map.second[p];
    const t = map.blend[p] / 255;
    const level = levels[first] * (1 - t) + levels[next] * t;
    out[p * 4 + 3] = alpha * level;

    for (let channel = 0; channel < 3; channel += 1) {
      const shift = shifts[first][channel] * (1 - t) + shifts[next][channel] * t;
      if (shift !== 0) {
        out[p * 4 + channel] = Math.max(0, Math.min(255, map.base[p * 4 + channel] + shift));
      }
    }
  }

  return output;
}

export function toHex([r, g, b]: RGB) {
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}
