import type { DesignElement } from '../types/editor';

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Unable to load image'));
    image.src = src;
  });
}

export async function renderMockupComposition({
  mockupImage,
  elements,
}: {
  mockupImage: string;
  elements: DesignElement[];
}): Promise<string> {
  const base = await loadImage(mockupImage);
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

    const image = await loadImage(element.image);
    const naturalWidth = image.naturalWidth || image.width;
    const naturalHeight = image.naturalHeight || image.height;
    const normalizedX = element.x > 1 ? element.x / 1000 : element.x;
    const normalizedY = element.y > 1 ? element.y / 1000 : element.y;
    const scaleFactor = Math.min(canvasWidth, canvasHeight) / 1000;
    const width = naturalWidth * element.scale * scaleFactor;
    const height = naturalHeight * element.scale * scaleFactor;

    context.save();
    context.translate(normalizedX * canvasWidth, normalizedY * canvasHeight);
    context.rotate((element.rotation * Math.PI) / 180);
    context.globalAlpha = element.opacity;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, -width / 2, -height / 2, width, height);
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
