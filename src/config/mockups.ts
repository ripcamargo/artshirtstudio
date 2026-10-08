import type { MockupDefinition, MockupId } from '../types/editor';

const sartorialFiles: Record<MockupId, { name: string; swatch: string; front: string; back: string }> = {
  black: {
    name: 'Preta',
    swatch: '#202124',
    front: '/camisetas/2.%20Preto_Frente.png',
    back: '/camisetas/2.%20Preto_Costas.jpg',
  },
  white: {
    name: 'Branca',
    swatch: '#f5f3ed',
    front: '/camisetas/1.%20Branco_Frente.png',
    back: '/camisetas/1.%20Branco_Costas.jpg',
  },
  gray: {
    name: 'Cinza',
    swatch: '#92979d',
    front: '/camisetas/3.%20Cinza_Frente.png',
    back: '/camisetas/3.%20Cinza_Costas.jpg',
  },
  navy: {
    name: 'Azul',
    swatch: '#183b63',
    front: '/camisetas/4.%20Azul_Frente.png',
    back: '/camisetas/4.%20Azul_Costas.png',
  },
  wine: {
    name: 'Vermelho',
    swatch: '#8b2638',
    front: '/camisetas/5.%20Vermelho_Frente.png',
    back: '/camisetas/5.%20Vermelho_Costas.png',
  },
};

export const MOCKUPS: MockupDefinition[] = (['black', 'white', 'wine', 'gray', 'navy'] as MockupId[]).map((id) => ({
  id,
  name: sartorialFiles[id].name,
  swatch: sartorialFiles[id].swatch,
  front: sartorialFiles[id].front,
  back: sartorialFiles[id].back,
  width: 4000,
  height: 4000,
}));

export const MOCKUP_BY_ID = Object.fromEntries(MOCKUPS.map((mockup) => [mockup.id, mockup])) as Record<MockupId, MockupDefinition>;
