import type { HalftoneSettings } from '../types/editor';

/** Valores iniciais; o tamanho da célula acompanha a resolução da arte. */
export function defaultHalftone(naturalWidth: number, naturalHeight: number): HalftoneSettings {
  return {
    enabled: true,
    mode: 'transparency',
    cell: Math.max(4, Math.round(Math.max(naturalWidth, naturalHeight) / 160)),
    angle: 45,
    shape: 'circle',
    contrast: 1,
    ink: '#000000',
  };
}

function parseInk(value: string): [number, number, number] {
  return [parseInt(value.slice(1, 3), 16) || 0, parseInt(value.slice(3, 5), 16) || 0, parseInt(value.slice(5, 7), 16) || 0];
}

/**
 * Aplica a retícula de halftone sobre os pixels (altera `imageData`).
 *
 * - `transparency`: áreas sólidas ficam intactas; só o que é semitransparente (degradês, sombras, bordas
 *   suaves) vira pontos, mantendo a cor original. É o que a impressão DTF precisa, pois meio-tom de tinta
 *   branca não imprime bem.
 * - `colors`: a luminosidade vira o tamanho do ponto, mantendo as cores originais (serve para qualquer arte).
 * - `tones`: a luminosidade vira o tamanho do ponto e toda a arte passa a ser uma só cor de tinta.
 *
 * A retícula é calculada pixel a pixel (limiar periódico), então as bordas continuam nítidas.
 */
export function applyHalftone(imageData: ImageData, settings: HalftoneSettings) {
  const { width, height, data } = imageData;
  const cell = Math.max(2, settings.cell);
  const radians = (settings.angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const ink = parseInk(settings.ink);
  const tones = settings.mode === 'tones';
  const byLuminosity = tones || settings.mode === 'colors';

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const alpha = data[index + 3];
      if (alpha === 0) {
        continue;
      }

      let coverage: number;
      if (byLuminosity) {
        const lum = (0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2]) / 255;
        coverage = (settings.invert ? lum : 1 - lum) * (alpha / 255);
      } else {
        coverage = alpha / 255;
        if (coverage >= 0.999) {
          continue;
        }
      }

      coverage = Math.max(0, Math.min(1, (coverage - 0.5) * settings.contrast + 0.5));

      // Posição dentro da célula da grade girada, com origem no centro do ponto.
      const u = x * cos + y * sin;
      const v = -x * sin + y * cos;
      const du = (((u % cell) + cell) % cell) - cell / 2;
      const dv = (((v % cell) + cell) % cell) - cell / 2;

      let distance: number;
      let radius: number;
      if (settings.shape === 'square') {
        distance = Math.max(Math.abs(du), Math.abs(dv));
        radius = (cell / 2) * Math.sqrt(coverage);
      } else if (settings.shape === 'diamond') {
        distance = Math.abs(du) + Math.abs(dv);
        radius = cell * Math.sqrt(coverage);
      } else {
        distance = Math.hypot(du, dv);
        radius = cell * 0.7071 * Math.sqrt(coverage);
      }

      // ~1px de suavização na borda do ponto.
      const inside = Math.max(0, Math.min(1, 0.5 + radius - distance));

      if (tones) {
        data[index] = ink[0];
        data[index + 1] = ink[1];
        data[index + 2] = ink[2];
      }
      data[index + 3] = inside * 255;
    }
  }
}
