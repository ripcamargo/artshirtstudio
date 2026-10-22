import { useEffect, useRef, useState } from 'react';
import type { DesignElement } from '../types/editor';
import { loadImage } from '../utils/canvasRenderer';
import { hasActiveColorLayers, renderColorLayers } from '../utils/colorLayers';
import { shadeArtWithFabric } from '../utils/fabricShading';
import { normalizePosition } from '../utils/geometry';

export interface FabricShading {
  relief: HTMLCanvasElement;
  /** 0..1 */
  strength: number;
  contentWidth: number;
  contentHeight: number;
}

/** Resolução máxima (lado maior) do canvas que recebe o sombreado de tecido. */
const SHADED_ART_MAX_SIZE = 1024;

/**
 * Mostra a arte. Com cores reduzidas/trocadas ou com o efeito de tecido, desenha a versão processada
 * num canvas (a arte original nunca é alterada).
 */
export function ArtImage({ element, shading }: { element: DesignElement; shading: FabricShading | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const [baseVersion, setBaseVersion] = useState(0);
  const layers = hasActiveColorLayers(element.colorLayers) ? element.colorLayers : null;
  const useCanvas = Boolean(layers || shading);

  // Arte-base (já com as cores ajustadas), redesenhada só quando a imagem ou as cores mudam.
  useEffect(() => {
    if (!useCanvas) {
      return;
    }

    let cancelled = false;
    const prepare = async () => {
      const base = document.createElement('canvas');
      if (layers) {
        const imageData = await renderColorLayers(element.image, layers);
        base.width = imageData.width;
        base.height = imageData.height;
        base.getContext('2d')?.putImageData(imageData, 0, 0);
      } else {
        const image = await loadImage(element.image);
        base.width = image.naturalWidth || image.width;
        base.height = image.naturalHeight || image.height;
        base.getContext('2d')?.drawImage(image, 0, 0);
      }

      if (!cancelled) {
        baseRef.current = base;
        setBaseVersion((version) => version + 1);
      }
    };

    void prepare();
    return () => {
      cancelled = true;
    };
  }, [element.image, layers, useCanvas]);

  const x = normalizePosition(element.x);
  const y = normalizePosition(element.y);

  // Desenha na posição atual: o sombreado depende de onde a arte está sobre a camiseta.
  useEffect(() => {
    const canvas = canvasRef.current;
    const base = baseRef.current;
    if (!canvas || !base || !useCanvas) {
      return;
    }

    if (!shading) {
      canvas.width = base.width;
      canvas.height = base.height;
      canvas.getContext('2d')?.drawImage(base, 0, 0);
      return;
    }

    const boxWidth = Math.max(40, (element.naturalWidth * element.scale * 0.45 * shading.contentWidth) / 760);
    const boxHeight = Math.max(40, (element.naturalHeight * element.scale * 0.45 * shading.contentWidth) / 760);
    const ratio = Math.min(1, SHADED_ART_MAX_SIZE / Math.max(base.width, base.height));
    const width = Math.max(1, Math.round(base.width * ratio));
    const height = Math.max(1, Math.round((width * boxHeight) / boxWidth));

    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      return;
    }

    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(base, 0, 0, width, height);
    shadeArtWithFabric({
      art: canvas,
      relief: shading.relief,
      strength: shading.strength,
      centerX: x * shading.contentWidth,
      centerY: y * shading.contentHeight,
      boxWidth,
      boxHeight,
      rotation: (element.rotation * Math.PI) / 180,
      contentWidth: shading.contentWidth,
      contentHeight: shading.contentHeight,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseVersion, useCanvas, shading?.relief, shading?.strength, shading?.contentWidth, shading?.contentHeight, x, y, element.scale, element.rotation, element.naturalWidth, element.naturalHeight]);

  if (!useCanvas) {
    return <img src={element.image} alt={element.name} draggable={false} />;
  }

  return <canvas ref={canvasRef} role="img" aria-label={element.name} />;
}
