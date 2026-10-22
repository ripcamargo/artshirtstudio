import { loadImage } from './canvasRenderer';

/**
 * Relevo de luz e sombra da camiseta (dobras), extraído da própria foto e aplicado sobre as artes
 * para elas não parecerem coladas. O mapa é cinza: 128 = neutro, mais claro = luz, mais escuro = sombra.
 */

const reliefCache = new Map<string, Promise<HTMLCanvasElement>>();

function boxBlur(source: Float32Array, width: number, height: number, radius: number) {
  const horizontal = new Float32Array(source.length);
  const result = new Float32Array(source.length);
  const window = radius * 2 + 1;

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x += 1) {
      sum += source[row + Math.max(0, Math.min(width - 1, x))];
    }
    for (let x = 0; x < width; x += 1) {
      horizontal[row + x] = sum / window;
      sum += source[row + Math.min(width - 1, x + radius + 1)] - source[row + Math.max(0, x - radius)];
    }
  }

  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1) {
      sum += horizontal[Math.max(0, Math.min(height - 1, y)) * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      result[y * width + x] = sum / window;
      sum +=
        horizontal[Math.min(height - 1, y + radius + 1) * width + x] -
        horizontal[Math.max(0, y - radius) * width + x];
    }
  }

  return result;
}

async function buildRelief(mockupSrc: string): Promise<HTMLCanvasElement> {
  const image = await loadImage(mockupSrc);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return canvas;
  }

  ctx.drawImage(image, 0, 0, width, height);
  const pixels = ctx.getImageData(0, 0, width, height);
  const { data } = pixels;

  const luminance = new Float32Array(width * height);
  for (let i = 0; i < luminance.length; i += 1) {
    luminance[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }

  // Tira o ruído fino do tecido/JPEG e compara com a luz "média" da região: o que sobra são as dobras.
  const smooth = boxBlur(luminance, width, height, 2);
  const local = boxBlur(boxBlur(luminance, width, height, Math.round(width * 0.014)), width, height, Math.round(width * 0.014));

  for (let i = 0; i < smooth.length; i += 1) {
    const alpha = data[i * 4 + 3];
    // Relativo à luz local, para a camiseta preta também ter relevo, e limitado para não estourar.
    const delta = alpha < 250 ? 0 : ((smooth[i] - local[i]) / (local[i] + 24)) * 255 * 1.4;
    const value = 128 + Math.max(-110, Math.min(110, delta));
    data[i * 4] = value;
    data[i * 4 + 1] = value;
    data[i * 4 + 2] = value;
    data[i * 4 + 3] = 255;
  }

  ctx.putImageData(pixels, 0, 0);
  return canvas;
}

export function getFabricRelief(mockupSrc: string): Promise<HTMLCanvasElement> {
  let entry = reliefCache.get(mockupSrc);
  if (!entry) {
    entry = buildRelief(mockupSrc);
    entry.catch(() => reliefCache.delete(mockupSrc));
    reliefCache.set(mockupSrc, entry);
  }

  return entry;
}

interface ShadeOptions {
  /** Canvas com a arte já desenhada (será alterado). */
  art: HTMLCanvasElement;
  relief: HTMLCanvasElement;
  /** 0..1 */
  strength: number;
  /** Centro da arte e tamanho da sua caixa, em px do espaço da camiseta (o mesmo do `contentWidth/Height`). */
  centerX: number;
  centerY: number;
  boxWidth: number;
  boxHeight: number;
  rotation: number;
  contentWidth: number;
  contentHeight: number;
}

const scratch = document.createElement('canvas');

/** Desenha o trecho do relevo que fica sob a arte, já girado/escalado para o espaço da própria arte. */
function readLocalRelief({ art, relief, centerX, centerY, boxWidth, boxHeight, rotation, contentWidth, contentHeight }: ShadeOptions) {
  scratch.width = art.width;
  scratch.height = art.height;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return null;
  }

  ctx.fillStyle = 'rgb(128,128,128)';
  ctx.fillRect(0, 0, scratch.width, scratch.height);
  ctx.save();
  ctx.scale(art.width / boxWidth, art.height / boxHeight);
  ctx.translate(boxWidth / 2, boxHeight / 2);
  ctx.rotate(-rotation);
  ctx.translate(-centerX, -centerY);
  ctx.scale(contentWidth / relief.width, contentHeight / relief.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(relief, 0, 0);
  ctx.restore();

  return ctx.getImageData(0, 0, scratch.width, scratch.height).data;
}

/** Aplica luz e sombra das dobras sobre a arte, respeitando posição, tamanho e rotação dela. */
export function shadeArtWithFabric(options: ShadeOptions) {
  const { art, strength } = options;
  const artCtx = art.getContext('2d', { willReadFrequently: true });
  if (!artCtx || strength <= 0 || !art.width || !art.height) {
    return;
  }

  const reliefData = readLocalRelief(options);
  if (!reliefData) {
    return;
  }

  const artData = artCtx.getImageData(0, 0, art.width, art.height);
  const out = artData.data;

  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] === 0) {
      continue;
    }

    // -1 (sombra) .. 1 (luz); sombra escurece proporcionalmente, luz clareia em direção ao branco.
    const delta = ((reliefData[i] - 128) / 128) * strength;
    for (let channel = 0; channel < 3; channel += 1) {
      const value = out[i + channel];
      out[i + channel] = delta >= 0 ? value + (255 - value) * delta * 0.5 : value + value * delta * 0.7;
    }
  }

  artCtx.putImageData(artData, 0, 0);
}
