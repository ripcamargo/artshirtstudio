import type { DesignElement } from '../types/editor';
import { hasActiveColorLayers, renderColorLayers } from './colorLayers';
import { getFabricRelief, shadeArtWithFabric } from './fabricShading';

/** Largura de referência da camiseta na prévia e tamanho mínimo da arte (px nessa referência). */
const REFERENCE_SHIRT_WIDTH = 760;
const MIN_ART_SIZE = 40;

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
  if (factor === 1 && !colorLayers) {
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
    const normalizedX = element.x > 1 ? element.x / 1000 : element.x;
    const normalizedY = element.y > 1 ? element.y / 1000 : element.y;
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
