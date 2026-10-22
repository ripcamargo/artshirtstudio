import type { DesignElement } from '../types/editor';
import { hasActiveColorLayers, renderColorLayers } from './colorLayers';
import { applyHalftone } from './halftone';
import { getFabricRelief, shadeArtWithFabric } from './fabricShading';

import { MIN_ART_SIZE, REFERENCE_SHIRT_WIDTH, normalizePosition } from './geometry';
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Unable to load image'));
    image.src = src;
  });
}

/** Converte o valor do controle (-100..100) no fator do filtro saturate (0 = P&B, 1 = original, 5 = estourado). */
export function saturationToFactor(value = 0): number {
  return value <= 0 ? 1 + value / 100 : 1 + (value / 100) * 4;
}

async function prepareElementImage(element: DesignElement): Promise<HTMLCanvasElement | HTMLImageElement> {
  const image = await loadImage(element.image);
  const factor = saturationToFactor(element.saturation);
  const colorLayers = hasActiveColorLayers(element.colorLayers) ? element.colorLayers : null;
  const halftone = element.halftone?.enabled ? element.halftone : null;
  if (factor === 1 && !colorLayers && !halftone) {
    return image;
  }

  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return image;
  }

  let imageData: ImageData;
  if (colorLayers) {
    imageData = await renderColorLayers(element.image, colorLayers);
  } else {
    ctx.drawImage(image, 0, 0);
    imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  }
  if (factor === 1) {
    if (halftone) {
      applyHalftone(imageData, halftone);
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  const data = imageData.data;
  const s = factor;
  // Mesma matriz do filtro CSS saturate(), para o export bater com o preview.
  const m = [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
  ];

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    data[i] = m[0] * r + m[1] * g + m[2] * b;
    data[i + 1] = m[3] * r + m[4] * g + m[5] * b;
    data[i + 2] = m[6] * r + m[7] * g + m[8] * b;
  }

  if (halftone) {
    applyHalftone(imageData, halftone);
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

export async function renderMockupComposition({
  mockupImage,
  elements,
  fabricStrength = 0,
}: {
  mockupImage: string;
  elements: DesignElement[];
  /** 0..1: quanto das dobras da camiseta aparece sobre a arte. */
  fabricStrength?: number;
}): Promise<string> {
  const base = await loadImage(mockupImage);
  const relief = fabricStrength > 0 ? await getFabricRelief(mockupImage) : null;
  const canvas = document.createElement('canvas');
  const canvasWidth = base.naturalWidth || base.width || 4000;
  const canvasHeight = base.naturalHeight || base.height || 4000;

  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  const context = canvas.getContext('2d');
  if (!context) {
    return mockupImage;
  }

  context.clearRect(0, 0, canvasWidth, canvasHeight);
  context.drawImage(base, 0, 0, canvasWidth, canvasHeight);

  for (const element of elements) {
    if (!element.visible) {
      continue;
    }

    let image = await prepareElementImage(element);
    const naturalWidth = image.width;
    const naturalHeight = image.height;
    const normalizedX = normalizePosition(element.x);
    const normalizedY = normalizePosition(element.y);
    // Mesma regra da prévia: a arte mede `natural * escala * 0.45` px numa camiseta de 760px de largura
    // (e nunca menos que 40px), mantida proporcional à largura da camiseta no PNG.
    const scaleFactor = (0.45 * canvasWidth) / REFERENCE_SHIRT_WIDTH;
    const minSize = (MIN_ART_SIZE * canvasWidth) / REFERENCE_SHIRT_WIDTH;
    const width = Math.max(minSize, naturalWidth * element.scale * scaleFactor);
    const height = Math.max(minSize, naturalHeight * element.scale * scaleFactor);

    if (relief) {
      const shaded = document.createElement('canvas');
      shaded.width = Math.max(1, Math.round(width));
      shaded.height = Math.max(1, Math.round(height));
      const shadedContext = shaded.getContext('2d', { willReadFrequently: true });
      if (shadedContext) {
        shadedContext.imageSmoothingQuality = 'high';
        shadedContext.drawImage(image, 0, 0, shaded.width, shaded.height);
        const fabricOptions = {
          art: shaded,
          relief,
          strength: fabricStrength,
          centerX: normalizedX * canvasWidth,
          centerY: normalizedY * canvasHeight,
          boxWidth: width,
          boxHeight: height,
          rotation: (element.rotation * Math.PI) / 180,
          contentWidth: canvasWidth,
          contentHeight: canvasHeight,
        };
        shadeArtWithFabric(fabricOptions);
        image = shaded;
      }
    }

    context.save();
    context.translate(normalizedX * canvasWidth, normalizedY * canvasHeight);
    context.rotate((element.rotation * Math.PI) / 180);
    context.globalAlpha = element.opacity;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(
      image,
      -width / 2,
      -height / 2,
      width,
      height,
    );
    context.restore();
  }

  return canvas.toDataURL('image/png');
}

export async function applyEraserToImage(
  imageDataUrl: string,
  x: number,
  y: number,
  radius: number,
): Promise<string> {
  const image = await loadImage(imageDataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return imageDataUrl;
  }

  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  return canvas.toDataURL('image/png');
}

/** Apaga vários pontos de uma vez (um traço da borracha), com uma única leitura e gravação da imagem. */
export async function eraseStroke(
  imageDataUrl: string,
  points: Array<{ x: number; y: number }>,
  radius: number,
): Promise<string> {
  const image = await loadImage(imageDataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return imageDataUrl;
  }

  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = 'destination-out';
  for (const point of points) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  return canvas.toDataURL('image/png');
}

/** Maior lado (px) do PNG da arte exportada; acima disso o navegador tende a falhar. */
const MAX_ART_EXPORT_SIDE = 8192;

/**
 * Exporta só a arte (fundo transparente), sem camiseta nem sombreado, na melhor resolução possível:
 * cada arte é desenhada no tamanho original da imagem sempre que o limite do navegador permite.
 * Devolve null se não há arte visível.
 */
export async function renderArtOnly(elements: DesignElement[]): Promise<string | null> {
  const visible = elements.filter((element) => element.visible);
  if (visible.length === 0) {
    return null;
  }

  // Espaço de referência: a camiseta com 1000px de largura (o tamanho relativo entre as artes é o da prévia).
  const reference = 1000;
  const placed = visible.map((element) => {
    const factor = (element.scale * 0.45 * reference) / REFERENCE_SHIRT_WIDTH;
    const width = Math.max((MIN_ART_SIZE * reference) / REFERENCE_SHIRT_WIDTH, element.naturalWidth * factor);
    const height = Math.max((MIN_ART_SIZE * reference) / REFERENCE_SHIRT_WIDTH, element.naturalHeight * factor);
    const radians = (element.rotation * Math.PI) / 180;
    const halfWidth = (Math.abs(width * Math.cos(radians)) + Math.abs(height * Math.sin(radians))) / 2;
    const halfHeight = (Math.abs(width * Math.sin(radians)) + Math.abs(height * Math.cos(radians))) / 2;
    const centerX = normalizePosition(element.x) * reference;
    const centerY = normalizePosition(element.y) * reference;

    return { element, width, height, radians, centerX, centerY, halfWidth, halfHeight };
  });

  const minX = Math.min(...placed.map((item) => item.centerX - item.halfWidth));
  const maxX = Math.max(...placed.map((item) => item.centerX + item.halfWidth));
  const minY = Math.min(...placed.map((item) => item.centerY - item.halfHeight));
  const maxY = Math.max(...placed.map((item) => item.centerY + item.halfHeight));

  // Fator que leva cada arte ao seu tamanho original; vale o maior, para nenhuma perder resolução.
  const nativeFactor = Math.max(...placed.map((item) => item.element.naturalWidth / item.width));
  const limitFactor = MAX_ART_EXPORT_SIDE / Math.max(maxX - minX, maxY - minY);
  const factor = Math.min(nativeFactor, limitFactor);

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round((maxX - minX) * factor));
  canvas.height = Math.max(1, Math.round((maxY - minY) * factor));
  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';

  for (const item of placed) {
    const image = await prepareElementImage(item.element);
    context.save();
    context.translate((item.centerX - minX) * factor, (item.centerY - minY) * factor);
    context.rotate(item.radians);
    context.globalAlpha = item.element.opacity;
    context.drawImage(image, (-item.width * factor) / 2, (-item.height * factor) / 2, item.width * factor, item.height * factor);
    context.restore();
  }

  return canvas.toDataURL('image/png');
}
