export type Side = 'front' | 'back';
export type MockupId = 'black' | 'white' | 'wine' | 'gray' | 'navy' | 'yellow' | 'purple' | 'brown';
export type ToolMode = 'select' | 'eraser' | 'remove-bg';

export type RGB = [number, number, number];

export interface ColorLayer {
  id: string;
  color: RGB;
  /** Fração da arte ocupada por essa cor (0..1). */
  share: number;
  /** Intensidade: 1 = original, 0 = oculta. */
  level: number;
  /** Cor que substitui a detectada (mantém o sombreado); ausente = cor original. */
  replacement?: RGB;
}

export interface HalftoneSettings {
  enabled: boolean;
  /**
   * transparency: só degradês/semitransparências viram pontos;
   * colors: a luminosidade vira o tamanho do ponto e as cores originais são mantidas;
   * tones: a luminosidade vira o tamanho do ponto e tudo passa a ser uma cor de tinta.
   */
  mode: 'transparency' | 'colors' | 'tones';
  /** Tamanho da célula da retícula, em px da imagem original da arte. */
  cell: number;
  /** Ângulo da retícula em graus. */
  angle: number;
  shape: 'circle' | 'square' | 'diamond';
  /** 0.5 .. 2 (1 = sem alteração). */
  contrast: number;
  /** Cor da tinta no modo tones (#rrggbb). */
  ink: string;
  /** Nos modos colors/tones: pontos maiores nas áreas claras em vez das escuras (útil em camisetas escuras). */
  invert?: boolean;
}

export interface DesignElement {
  id: string;
  name: string;
  image: string;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  /** -100 (preto e branco) .. 0 (original) .. 100 (saturação máxima) */
  saturation?: number;
  colorLayers?: ColorLayer[];
  halftone?: HalftoneSettings;
  visible: boolean;
  naturalWidth: number;
  naturalHeight: number;
}

export interface SideState {
  elements: DesignElement[];
  selectedId: string | null;
}

export interface AppState {
  productName: string;
  activeColor: MockupId;
  activeSide: Side;
  front: SideState;
  back: SideState;
}

export interface MockupDefinition {
  id: MockupId;
  name: string;
  swatch: string;
  front: string;
  back: string;
  width: number;
  height: number;
}
