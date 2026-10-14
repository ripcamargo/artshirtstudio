export type Side = 'front' | 'back';
export type MockupId = 'black' | 'white' | 'wine' | 'gray' | 'navy';
export type ToolMode = 'select' | 'eraser' | 'remove-bg';

export type RGB = [number, number, number];

export interface ColorLayer {
  id: string;
  color: RGB;
  /** Fração da arte ocupada por essa cor (0..1). */
  share: number;
  /** Intensidade: 1 = original, 0 = oculta. */
  level: number;
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
