/** Posições antigas eram guardadas em milésimos (0..1000); hoje são frações (0..1). */
export function normalizePosition(value: number) {
  if (value > 1) {
    return value / 1000;
  }

  return value;
}

/** Largura de referência da camiseta (px) em que a arte mede `natural * escala * 0.45`. */
export const REFERENCE_SHIRT_WIDTH = 760;
export const MIN_ART_SIZE = 40;

interface ArtGeometry {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  naturalWidth: number;
  naturalHeight: number;
}

/** Tamanho da arte na tela (px), proporcional à largura da camiseta exibida. */
export function artBoxSize(element: Pick<ArtGeometry, 'scale' | 'naturalWidth' | 'naturalHeight'>, contentWidth: number) {
  const factor = (element.scale * 0.45 * contentWidth) / REFERENCE_SHIRT_WIDTH;
  return {
    width: Math.max(MIN_ART_SIZE, element.naturalWidth * factor),
    height: Math.max(MIN_ART_SIZE, element.naturalHeight * factor),
  };
}

export interface StagePoint {
  /** Posição no palco em pixels sem zoom (o mesmo sistema de coordenadas das artes). */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Converte o ponteiro para coordenadas do palco sem zoom. O zoom é só visual (transform),
 * então desfazer a escala aqui garante que posição, borracha etc. não mudam com ele.
 */
export function toStagePoint(content: HTMLElement, clientX: number, clientY: number): StagePoint {
  const rect = content.getBoundingClientRect();
  const width = content.offsetWidth;
  const height = content.offsetHeight;
  const scale = rect.width / width || 1;

  return {
    x: (clientX - rect.left) / scale,
    y: (clientY - rect.top) / scale,
    width,
    height,
  };
}

/** Converte o ponteiro em pixels da imagem original da arte (null se cair fora dela). */
export function pointerToArtPixel(content: HTMLElement, clientX: number, clientY: number, element: ArtGeometry) {
  const { x: pointerX, y: pointerY, width: stageWidth, height: stageHeight } = toStagePoint(content, clientX, clientY);
  const centerX = normalizePosition(element.x) * stageWidth;
  const centerY = normalizePosition(element.y) * stageHeight;
  const box = artBoxSize(element, stageWidth);
  const imageScale = Math.min(box.width / element.naturalWidth, box.height / element.naturalHeight);
  const imageWidth = element.naturalWidth * imageScale;
  const imageHeight = element.naturalHeight * imageScale;
  const radians = (element.rotation * Math.PI) / 180;
  const deltaX = pointerX - centerX;
  const deltaY = pointerY - centerY;
  const localDisplayX = deltaX * Math.cos(radians) + deltaY * Math.sin(radians);
  const localDisplayY = -deltaX * Math.sin(radians) + deltaY * Math.cos(radians);
  const localX = (localDisplayX + imageWidth / 2) / imageScale;
  const localY = (localDisplayY + imageHeight / 2) / imageScale;

  if (localX < 0 || localX > element.naturalWidth || localY < 0 || localY > element.naturalHeight) {
    return null;
  }

  return { x: localX, y: localY, imageScale };
}
