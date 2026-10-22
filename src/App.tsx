import { useEffect, useRef, useState } from 'react';
import { Check, Download, Eraser, Eye, EyeOff, Minus, MousePointer2, Plus, Redo2, Undo2, WandSparkles, ZoomIn, ZoomOut } from 'lucide-react';
import { MOCKUP_BY_ID, MOCKUPS } from './config/mockups';
import { addStroke, refineEdges, removeColorAt, removeSolidBackground } from './utils/backgroundRemoval';
import { ArtImage, type FabricShading } from './components/ArtImage';
import { ArtStudioModal, type StudioTab } from './components/ArtStudioModal';
import { normalizePosition, pointerToArtPixel, toStagePoint } from './utils/geometry';
import { getFabricRelief } from './utils/fabricShading';
import { toHex } from './utils/colorLayers';
import { applyEraserToImage, loadImage, renderArtOnly, renderMockupComposition, saturationToFactor } from './utils/canvasRenderer';
import { exportZip } from './utils/zipExporter';
import type { AppState, DesignElement, MockupId, Side, ToolMode } from './types/editor';
import './App.css';

const STORAGE_KEY = 'tshirt-mockup-creator-v1';
const HISTORY_LIMIT = 50;
const ZOOM_LEVELS = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6];
const EXPORT_SIDES: Array<{ id: Side; label: string; fileSuffix: string }> = [
  { id: 'front', label: 'Frente', fileSuffix: 'frente' },
  { id: 'back', label: 'Costas', fileSuffix: 'costas' },
];

function clampPan(pan: { x: number; y: number }, zoom: number, stage: HTMLElement | null) {
  if (!stage) {
    return { x: 0, y: 0 };
  }

  const maxX = ((zoom - 1) * stage.clientWidth) / 2;
  const maxY = ((zoom - 1) * stage.clientHeight) / 2;
  return {
    x: Math.max(-maxX, Math.min(maxX, pan.x)),
    y: Math.max(-maxY, Math.min(maxY, pan.y)),
  };
}

/** Só conta como passo de histórico o que muda as artes (não seleção, lado ou cor). */
function sameArtwork(a: AppState, b: AppState) {
  return a.front.elements === b.front.elements && a.back.elements === b.back.elements;
}

const ARROW_DIRECTIONS: Record<string, { x: number; y: number }> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

function isTextField(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable || target instanceof HTMLTextAreaElement) {
    return true;
  }

  return target instanceof HTMLInputElement && !['range', 'checkbox', 'radio', 'button'].includes(target.type);
}

function buildSampleArt(): string {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="900" height="900" viewBox="0 0 900 900">
      <defs>
        <linearGradient id="sample" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="#ff73d6" />
          <stop offset="50%" stop-color="#7c5cff" />
          <stop offset="100%" stop-color="#58d6ff" />
        </linearGradient>
      </defs>
      <rect width="900" height="900" fill="transparent"/>
      <circle cx="450" cy="400" r="220" fill="url(#sample)" opacity="0.9"/>
      <path d="M450 180 L510 330 L680 330 L540 430 L610 610 L450 500 L290 610 L360 430 L220 330 L390 330 Z" fill="#fff" opacity="0.96"/>
      <text x="450" y="465" font-size="120" font-family="Arial, sans-serif" font-weight="700" fill="#1a1f2d" text-anchor="middle">TS</text>
    </svg>
  `;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function createInitialState(): AppState {
  const sampleArt = buildSampleArt();

  return {
    productName: 'caveira-rosa',
    activeColor: 'black',
    activeSide: 'front',
    front: {
      selectedId: 'sample-front',
      elements: [
        {
          id: 'sample-front',
          name: 'Arte principal',
          image: sampleArt,
          x: 0.5,
          y: 0.48,
          scale: 0.7,
          rotation: 0,
          opacity: 1,
          visible: true,
          naturalWidth: 900,
          naturalHeight: 900,
        },
      ],
    },
    back: {
      selectedId: null,
      elements: [],
    },
  };
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'arte';
}

function toSafeFileName(value: string) {
  return slugify(value).replace(/^-+|-+$/g, '') || 'arte';
}

function App() {
  const [state, setState] = useState<AppState>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) {
      return createInitialState();
    }

    try {
      return JSON.parse(saved) as AppState;
    } catch {
      return createInitialState();
    }
  });
  const [toolMode, setToolMode] = useState<ToolMode>('select');
  const [eraserSize, setEraserSize] = useState(26);
  const [tolerance, setTolerance] = useState(28);
  const [edgeRadius, setEdgeRadius] = useState(1);
  const [strokeWidth, setStrokeWidth] = useState(1);
  const [strokeColor, setStrokeColor] = useState('#ffffff');
  const [colorCount, setColorCount] = useState(8);
  const [fabricEffect, setFabricEffect] = useState(15);
  const [includeArt, setIncludeArt] = useState(true);
  const [relief, setRelief] = useState<HTMLCanvasElement | null>(null);
  const [contentSize, setContentSize] = useState({ width: 0, height: 0 });
  const [studioTab, setStudioTab] = useState<StudioTab | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [status, setStatus] = useState('Pronto');
  const [selectedColors, setSelectedColors] = useState<MockupId[]>(MOCKUPS.map((mockup) => mockup.id));
  const [selectedSides, setSelectedSides] = useState<Side[]>(['front', 'back']);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const [eraserCursor, setEraserCursor] = useState({ x: 0, y: 0, visible: false });
  const previewRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panStartRef = useRef<{ clientX: number; clientY: number; x: number; y: number } | null>(null);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const eraseActiveRef = useRef(false);
  const stateRef = useRef(state);
  const pastRef = useRef<AppState[]>([]);
  const futureRef = useRef<AppState[]>([]);
  const restoringRef = useRef(false);
  const [historyCounts, setHistoryCounts] = useState({ past: 0, future: 0 });

  const activeMockup = MOCKUP_BY_ID[state.activeColor];
  const activeMockupImage = activeMockup[state.activeSide];

  // Relevo das dobras da camiseta que está na tela (calculado uma vez por foto e guardado).
  useEffect(() => {
    let cancelled = false;
    void getFabricRelief(activeMockupImage)
      .then((canvas) => {
        if (!cancelled) {
          setRelief(canvas);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRelief(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeMockupImage]);

  // Tamanho da camiseta na tela (sem zoom): o sombreado depende dele.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) {
      return;
    }

    const update = () => setContentSize({ width: content.offsetWidth, height: content.offsetHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  /** O estúdio abre na aba da ferramenta ativa: cores, fundo (varinha) ou apagar (borracha). */
  const studioTabForTool: StudioTab = toolMode === 'eraser' ? 'erase' : toolMode === 'remove-bg' ? 'background' : 'colors';

  const fabricShading: FabricShading | null =
    relief && fabricEffect > 0 && contentSize.width > 0
      ? { relief, strength: fabricEffect / 100, contentWidth: contentSize.width, contentHeight: contentSize.height }
      : null;
  const activeSideState = state[state.activeSide];
  const selectedElement =
    activeSideState.elements.find((element) => element.id === activeSideState.selectedId) ?? null;
  const showSelectionControls = toolMode === 'select' && selectedElement;
  const showEraserControls = toolMode === 'eraser';
  const showBackgroundControls = toolMode === 'remove-bg';

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    stateRef.current = state;
  }, [state]);

  const syncHistoryCounts = () => {
    setHistoryCounts({ past: pastRef.current.length, future: futureRef.current.length });
  };

  // Uma nova edição (que não seja desfazer/refazer) invalida o "refazer".
  useEffect(() => {
    if (restoringRef.current) {
      restoringRef.current = false;
      return;
    }

    if (futureRef.current.length > 0) {
      futureRef.current = [];
      setHistoryCounts((counts) => ({ ...counts, future: 0 }));
    }
  }, [state.front.elements, state.back.elements]);

  /** Guarda o estado atual antes de uma edição, para poder desfazê-la. */
  const checkpoint = () => {
    const snapshot = stateRef.current;
    const past = pastRef.current;
    if (past.length > 0 && sameArtwork(past[past.length - 1], snapshot)) {
      return;
    }

    past.push(snapshot);
    if (past.length > HISTORY_LIMIT) {
      past.shift();
    }
    syncHistoryCounts();
  };

  const restoreSnapshot = (from: AppState[], to: AppState[], label: string) => {
    const current = stateRef.current;
    let entry = from.pop();
    // Descarta passos que não mudaram nada (ex.: clique sem arrastar).
    while (entry && sameArtwork(entry, current)) {
      entry = from.pop();
    }

    if (!entry) {
      syncHistoryCounts();
      return;
    }

    to.push(current);
    const next: AppState = {
      ...entry,
      activeColor: current.activeColor,
      productName: current.productName,
    };
    restoringRef.current = true;
    stateRef.current = next;
    setState(next);
    syncHistoryCounts();
    setStatus(label);
  };

  const undo = () => restoreSnapshot(pastRef.current, futureRef.current, 'Desfeito');
  const redo = () => restoreSnapshot(futureRef.current, pastRef.current, 'Refeito');

  const undoRef = useRef(undo);
  const redoRef = useRef(redo);
  useEffect(() => {
    undoRef.current = undo;
    redoRef.current = redo;
  });

  // Ações dos atalhos de teclado; atualizada a cada render para o listener (registrado uma vez) não ficar com estado velho.
  const colorEditorOpenRef = useRef(false);
  colorEditorOpenRef.current = studioTab !== null;
  const keyboardActionsRef = useRef<{
    nudgeSelected: (dx: number, dy: number, fast: boolean, repeat: boolean) => boolean;
    resizeTool: (direction: 1 | -1) => void;
  }>({
    nudgeSelected: () => false,
    resizeTool: () => {},
  });
  useEffect(() => {
    keyboardActionsRef.current = {
      // Move a arte selecionada em pixels da camiseta (Shift = 10px). Devolve se tratou a tecla.
      nudgeSelected: (dx, dy, fast, repeat) => {
        const current = stateRef.current;
        const selectedId = current[current.activeSide].selectedId;
        const content = contentRef.current;
        if (toolMode !== 'select' || !selectedId || !content || !content.offsetWidth || !content.offsetHeight) {
          return false;
        }

        if (!repeat) {
          checkpoint();
        }

        const step = fast ? 10 : 1;
        const clamp = (value: number) => Math.max(0, Math.min(1, value));
        setState((latest) => {
          const side = latest[latest.activeSide];
          return {
            ...latest,
            [latest.activeSide]: {
              ...side,
              elements: side.elements.map((element) =>
                element.id === selectedId
                  ? {
                      ...element,
                      x: clamp(normalizePosition(element.x) + (dx * step) / content.offsetWidth),
                      y: clamp(normalizePosition(element.y) + (dy * step) / content.offsetHeight),
                    }
                  : element,
              ),
            },
          };
        });
        return true;
      },
      // "[" diminui e "]" aumenta o tamanho da ferramenta ativa (hoje, a borracha).
      resizeTool: (direction) => {
        if (toolMode === 'eraser') {
          setEraserSize((size) => Math.max(8, Math.min(120, size + direction * 4)));
        }
      },
    };
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Com o editor de cores aberto, os atalhos da tela principal ficam desligados.
      if (colorEditorOpenRef.current || isTextField(event.target)) {
        return;
      }

      // "[" e "]" podem exigir AltGr (Ctrl+Alt no Windows) em teclados ABNT2, por isso vêm antes do filtro de Alt.
      // Usa o caractere (event.key), não a tecla física: no ABNT2 o código de "[" é BracketRight.
      const isBracketLeft = event.key === '[';
      const isBracketRight = event.key === ']';
      if ((isBracketLeft || isBracketRight) && !((event.ctrlKey || event.metaKey) && !event.altKey)) {
        event.preventDefault();
        keyboardActionsRef.current.resizeTool(isBracketRight ? 1 : -1);
        return;
      }

      if (event.altKey) {
        return;
      }

      const key = event.key.toLowerCase();

      const arrow = ARROW_DIRECTIONS[event.key];
      if (arrow && !(event.ctrlKey || event.metaKey)) {
        // Num slider focado, as setas já ajustam o próprio slider.
        if (event.target instanceof HTMLInputElement && event.target.type === 'range') {
          return;
        }

        if (keyboardActionsRef.current.nudgeSelected(arrow.x, arrow.y, event.shiftKey, event.repeat)) {
          event.preventDefault();
        }
        return;
      }

      if (key === 'delete') {
        const snapshot = stateRef.current;
        const selectedId = snapshot[snapshot.activeSide].selectedId;
        if (selectedId) {
          event.preventDefault();
          deleteElementRef.current(selectedId);
        }
        return;
      }

      if (!(event.ctrlKey || event.metaKey)) {
        if (event.shiftKey || event.repeat) {
          return;
        }
        if (key === 'v') {
          setToolMode('select');
        } else if (key === 'e') {
          setToolMode('eraser');
        } else if (key === 'w') {
          setToolMode('remove-bg');
        } else if (key === 'f') {
          setState((current) => ({ ...current, activeSide: 'front' }));
        } else if (key === 'c') {
          setState((current) => ({ ...current, activeSide: 'back' }));
        } else if (/^Digit[1-9]$/.test(event.code)) {
          // Teclas numéricas do topo: 1, 2, 3... na ordem das cores da barra.
          const mockup = MOCKUPS[Number(event.code.slice(5)) - 1];
          if (mockup) {
            setState((current) => ({ ...current, activeColor: mockup.id }));
          }
        }
        return;
      }

      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        undoRef.current();
      } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
        event.preventDefault();
        redoRef.current();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (!exportMenuOpen) {
      return;
    }

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !exportMenuRef.current?.contains(event.target)) {
        setExportMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setExportMenuOpen(false);
      }
    };

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [exportMenuOpen]);

  const updateCurrentSide = (updater: (next: AppState) => AppState) => {
    setState((current) => updater(current));
  };

  const handleSelectSide = (side: Side) => {
    setState((current) => ({
      ...current,
      activeSide: side,
    }));
  };

  const handleSelectElement = (id: string | null) => {
    setState((current) => ({
      ...current,
      [current.activeSide]: {
        ...current[current.activeSide],
        selectedId: id,
      },
    }));
  };

  const handleAddImages = async (files: File[] | FileList | null, nameOverride?: string) => {
    if (!files || files.length === 0) {
      return;
    }

    const loadedFiles = Array.from(files as File[]);
    const entries = await Promise.all(
      loadedFiles.map(async (file) => {
        const url = await fileToDataUrl(file);
        const image = await loadImage(url);

        return {
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          name: nameOverride ?? (file.name.replace(/\.[^/.]+$/, '') || 'Arte'),
          image: url,
          x: 0.5,
          y: 0.5,
          scale: Math.min(0.9, 480 / Math.max(image.naturalWidth, image.naturalHeight)),
          rotation: 0,
          opacity: 1,
          saturation: 0,
          visible: true,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
        } satisfies DesignElement;
      }),
    );

    checkpoint();
    updateCurrentSide((current) => {
      const side = current[current.activeSide];
      const updated = [...side.elements, ...entries];
      return {
        ...current,
        productName: '',
        [current.activeSide]: {
          ...side,
          elements: updated,
          selectedId: entries[entries.length - 1]?.id ?? side.selectedId,
        },
      };
    });

    setStatus(`${entries.length} imagem(ns) adicionada(s)`);
  };

  const handleAddImagesRef = useRef(handleAddImages);
  useEffect(() => {
    handleAddImagesRef.current = handleAddImages;
  });

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const images = Array.from(event.clipboardData?.files ?? []).filter((file) =>
        file.type.startsWith('image/'),
      );
      if (images.length === 0) {
        return;
      }

      event.preventDefault();
      void handleAddImagesRef.current(images, 'Imagem colada');
    };

    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, []);

  const updateSelectedElement = (patch: Partial<DesignElement>) => {
    if (!selectedElement) {
      return;
    }

    setState((current) => {
      const side = current[current.activeSide];
      const updated = side.elements.map((element) =>
        element.id === selectedElement.id ? { ...element, ...patch } : element,
      );

      return {
        ...current,
        [current.activeSide]: {
          ...side,
          elements: updated,
        },
      };
    });
  };

  const handleDeleteElement = (elementId: string) => {
    checkpoint();
    updateCurrentSide((current) => {
      const side = current[current.activeSide];
      const filtered = side.elements.filter((element) => element.id !== elementId);
      return {
        ...current,
        [current.activeSide]: {
          ...side,
          elements: filtered,
          selectedId: side.selectedId === elementId ? filtered[0]?.id ?? null : side.selectedId,
        },
      };
    });

    setStatus('Elemento removido');
  };

  const deleteElementRef = useRef(handleDeleteElement);
  useEffect(() => {
    deleteElementRef.current = handleDeleteElement;
  });

  const handleToggleVisibility = (elementId: string) => {
    checkpoint();
    updateCurrentSide((current) => {
      const side = current[current.activeSide];
      const elements = side.elements.map((element) =>
        element.id === elementId ? { ...element, visible: !element.visible } : element,
      );

      return {
        ...current,
        [current.activeSide]: {
          ...side,
          elements,
        },
      };
    });
  };

  // Converte a posição do ponteiro para coordenadas em pixels da imagem original da arte.
  const toImagePoint = (event: React.PointerEvent<HTMLDivElement>, element: DesignElement) => {
    if (!contentRef.current) {
      return null;
    }

    return pointerToArtPixel(contentRef.current, event.clientX, event.clientY, element);
  };

  const applyEraser = async (event: React.PointerEvent<HTMLDivElement>, element: DesignElement) => {
    if (!element.visible) {
      return;
    }

    const point = toImagePoint(event, element);
    if (!point) {
      return;
    }

    const radius = eraserSize / point.imageScale;

    try {
      const erased = await applyEraserToImage(element.image, point.x, point.y, radius);

      updateCurrentSide((current) => {
        const side = current[current.activeSide];
        const updated = side.elements.map((art) =>
          art.id === element.id ? { ...art, image: erased } : art,
        );

        return {
          ...current,
          [current.activeSide]: {
            ...side,
            elements: updated,
          },
        };
      });
    } catch {
      setStatus('Erro ao aplicar borracha');
    }
  };

  const handleRemoveBackground = async () => {
    if (!selectedElement) {
      return;
    }

    try {
      const cleaned = await removeSolidBackground(selectedElement.image, tolerance);
      checkpoint();
      updateCurrentSide((current) => {
        const side = current[current.activeSide];
        const updated = side.elements.map((element) =>
          element.id === selectedElement.id ? { ...element, image: cleaned } : element,
        );

        return {
          ...current,
          [current.activeSide]: {
            ...side,
            elements: updated,
          },
        };
      });
      setStatus('Fundo removido');
    } catch {
      setStatus('Não foi possível remover o fundo');
    }
  };

  const handleRefineEdges = async () => {
    if (!selectedElement) {
      return;
    }

    try {
      const refined = await refineEdges(selectedElement.image, edgeRadius);
      checkpoint();
      updateCurrentSide((current) => {
        const side = current[current.activeSide];
        const updated = side.elements.map((element) =>
          element.id === selectedElement.id ? { ...element, image: refined } : element,
        );

        return {
          ...current,
          [current.activeSide]: {
            ...side,
            elements: updated,
          },
        };
      });
      setStatus(`Arestas refinadas (${edgeRadius}px)`);
    } catch {
      setStatus('Não foi possível refinar as arestas');
    }
  };

  const handleAddStroke = async () => {
    if (!selectedElement) {
      return;
    }

    try {
      const stroked = await addStroke(selectedElement.image, strokeWidth, strokeColor);
      checkpoint();
      updateCurrentSide((current) => {
        const side = current[current.activeSide];
        const updated = side.elements.map((element) =>
          element.id === selectedElement.id
            ? { ...element, image: stroked.image, naturalWidth: stroked.width, naturalHeight: stroked.height }
            : element,
        );

        return {
          ...current,
          [current.activeSide]: {
            ...side,
            elements: updated,
          },
        };
      });
      setStatus(`Traçado de ${strokeWidth}px adicionado`);
    } catch {
      setStatus('Não foi possível adicionar o traçado');
    }
  };

  const handleRemoveColorAtPoint = async (event: React.PointerEvent<HTMLDivElement>, element: DesignElement) => {
    if (!element.visible) {
      return;
    }

    const point = toImagePoint(event, element);
    if (!point) {
      return;
    }

    try {
      const cleaned = await removeColorAt(element.image, point.x, point.y, tolerance);
      if (!cleaned) {
        return;
      }

      checkpoint();
      updateCurrentSide((current) => {
        const side = current[current.activeSide];
        const updated = side.elements.map((art) =>
          art.id === element.id ? { ...art, image: cleaned } : art,
        );

        return {
          ...current,
          [current.activeSide]: {
            ...side,
            elements: updated,
          },
        };
      });
      setStatus('Cor removida');
    } catch {
      setStatus('Não foi possível remover a cor');
    }
  };

  const toggleColorSelection = (colorId: MockupId) => {
    setSelectedColors((current) =>
      current.includes(colorId)
        ? current.filter((id) => id !== colorId)
        : [...current, colorId],
    );
  };

  const toggleSideSelection = (side: Side) => {
    setSelectedSides((current) =>
      current.includes(side)
        ? current.filter((id) => id !== side)
        : [...current, side],
    );
  };

  const handleExportAll = async () => {
    if (!state.productName.trim()) {
      setStatus('Preencha o nome da arte para exportar');
      return;
    }

    if (selectedColors.length === 0 && !includeArt) {
      setStatus('Selecione pelo menos uma cor');
      return;
    }

    if (selectedSides.length === 0) {
      setStatus('Selecione frente, costas ou ambos');
      return;
    }

    setExporting(true);
    setStatus('Exportando mockups...');

    try {
      const files: Array<{ name: string; dataUrl: string }> = [];
      const mockupsToExport = MOCKUPS.filter((mockup) => selectedColors.includes(mockup.id));
      const sidesToExport = EXPORT_SIDES.filter((side) => selectedSides.includes(side.id));

      for (const mockup of mockupsToExport) {
        for (const side of sidesToExport) {
          const png = await renderMockupComposition({
            mockupImage: mockup[side.id],
            elements: state[side.id].elements,
            fabricStrength: fabricEffect / 100,
          });

          files.push({
            name: `${toSafeFileName(state.productName)}-${toSafeFileName(mockup.name)}-${side.fileSuffix}.png`,
            dataUrl: png,
          });
        }
      }

      // A arte sozinha (fundo transparente), na maior resolução que o navegador permite.
      if (includeArt) {
        for (const side of sidesToExport) {
          const art = await renderArtOnly(state[side.id].elements);
          if (art) {
            files.push({ name: `${toSafeFileName(state.productName)}-arte-${side.fileSuffix}.png`, dataUrl: art });
          }
        }
      }

      if (files.length === 0) {
        setStatus('Nada para exportar: adicione uma arte visível');
        return;
      }

      await exportZip({
        zipName: `${toSafeFileName(state.productName)}-mockups.zip`,
        files,
      });
      setExportMenuOpen(false);
      setStatus(`${files.length} imagens exportadas`);
    } catch {
      setStatus('Erro ao exportar o ZIP');
    } finally {
      setExporting(false);
    }
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>, element: DesignElement) => {
    if (toolMode === 'remove-bg') {
      handleSelectElement(element.id);
      void handleRemoveColorAtPoint(event, element);
      return;
    }

    checkpoint();
    if (toolMode === 'eraser') {
      eraseActiveRef.current = true;
      void applyEraser(event, element);
      return;
    }

    // Guarda a distância entre o clique e o centro da arte, para ela não "pular" para o ponteiro ao arrastar.
    if (contentRef.current) {
      const point = toStagePoint(contentRef.current, event.clientX, event.clientY);
      dragOffsetRef.current = {
        x: normalizePosition(element.x) - point.x / point.width,
        y: normalizePosition(element.y) - point.y / point.height,
      };
    } else {
      dragOffsetRef.current = { x: 0, y: 0 };
    }

    setDraggingId(element.id);
    handleSelectElement(element.id);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>, element: DesignElement) => {
    if (draggingId !== element.id) {
      if (toolMode === 'eraser' && eraseActiveRef.current) {
        void applyEraser(event, element);
      }
      return;
    }

    if (!contentRef.current) {
      return;
    }

    const point = toStagePoint(contentRef.current, event.clientX, event.clientY);
    const x = point.x / point.width + dragOffsetRef.current.x;
    const y = point.y / point.height + dragOffsetRef.current.y;

    updateSelectedElement({ x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) });
  };

  const handlePointerUp = () => {
    setDraggingId(null);
    eraseActiveRef.current = false;
  };

  const changeZoom = (direction: 1 | -1) => {
    const index = ZOOM_LEVELS.findIndex((level) => level >= zoom);
    const nextIndex = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, index + direction));
    const nextZoom = ZOOM_LEVELS[nextIndex];
    // Mantém o mesmo ponto no centro da tela ao trocar o zoom.
    const ratio = nextZoom / zoom;
    setZoom(nextZoom);
    setPan((current) => clampPan({ x: current.x * ratio, y: current.y * ratio }, nextZoom, previewRef.current));
  };

  const resetZoom = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  // Ctrl + roda dá zoom; sem Ctrl, com zoom, a roda navega pela imagem em vez de rolar a página.
  useEffect(() => {
    const stage = previewRef.current;
    if (!stage) {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        if (event.deltaY !== 0) {
          changeZoom(event.deltaY < 0 ? 1 : -1);
        }
        return;
      }

      if (zoom === 1) {
        return;
      }

      event.preventDefault();
      const dx = event.shiftKey ? event.deltaY : event.deltaX;
      const dy = event.shiftKey ? 0 : event.deltaY;
      setPan((current) => clampPan({ x: current.x - dx, y: current.y - dy }, zoom, stage));
    };

    stage.addEventListener('wheel', handleWheel, { passive: false });
    return () => stage.removeEventListener('wheel', handleWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  // Arrastar uma área vazia do palco (com zoom) move a visualização.
  const handleStagePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (zoom === 1 || target.closest('.art-layer, .zoom-controls')) {
      return;
    }

    panStartRef.current = { clientX: event.clientX, clientY: event.clientY, ...pan };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePreviewPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const panStart = panStartRef.current;
    if (panStart) {
      setPan(
        clampPan(
          {
            x: panStart.x + event.clientX - panStart.clientX,
            y: panStart.y + event.clientY - panStart.clientY,
          },
          zoom,
          previewRef.current,
        ),
      );
      return;
    }

    if (toolMode !== 'eraser' || !contentRef.current) {
      return;
    }

    const point = toStagePoint(contentRef.current, event.clientX, event.clientY);
    setEraserCursor({ x: point.x, y: point.y, visible: true });
  };

  const handleStagePointerUp = () => {
    panStartRef.current = null;
    handlePointerUp();
  };

  return (
    <div className="app-shell">
      <div className="status-announcer" role="status" aria-live="polite">
        {status}
      </div>

      <main className="workspace">
        <section className="preview-panel panel">
          <div className="editor-layout">
          <div className="editor-toolbar">
            <div className="tool-switch" aria-label="Ferramentas do editor">
              <button
                type="button"
                title="Mover (V)"
                aria-label="Seta de seleção"
                className={toolMode === 'select' ? 'active' : ''}
                onClick={() => setToolMode('select')}
              >
                <MousePointer2 aria-hidden="true" />
              </button>
              <button
                type="button"
                title="Borracha (E)"
                aria-label="Borracha"
                className={toolMode === 'eraser' ? 'active' : ''}
                onClick={() => setToolMode('eraser')}
              >
                <Eraser aria-hidden="true" />
              </button>
              <button
                type="button"
                title="Remover fundo (W)"
                aria-label="Varinha para remover fundo"
                className={toolMode === 'remove-bg' ? 'active' : ''}
                onClick={() => setToolMode('remove-bg')}
              >
                <WandSparkles aria-hidden="true" />
              </button>
            </div>

            <div className="mockup-switcher" aria-label="Lado e cores do mockup">
            <div className="segmented-control">
              <button
                type="button"
                title="Frente (F)"
                className={state.activeSide === 'front' ? 'active' : ''}
                onClick={() => handleSelectSide('front')}
              >
                Frente
              </button>
              <button
                type="button"
                title="Costas (C)"
                className={state.activeSide === 'back' ? 'active' : ''}
                onClick={() => handleSelectSide('back')}
              >
                Costas
              </button>
            </div>
            {MOCKUPS.map((mockup, index) => (
              <button
                key={mockup.id}
                type="button"
                className={state.activeColor === mockup.id ? 'active' : ''}
                title={`${mockup.name} (${index + 1})`}
                aria-label={mockup.name}
                onClick={() => setState((current) => ({ ...current, activeColor: mockup.id }))}
              >
                <span
                  className="color-swatch"
                  style={{ backgroundColor: mockup.swatch }}
                  aria-hidden="true"
                />
              </button>
            ))}
            <div className="history-switch" aria-label="Histórico">
              <button
                type="button"
                title="Desfazer (Ctrl+Z)"
                aria-label="Desfazer"
                disabled={historyCounts.past === 0}
                onClick={undo}
              >
                <Undo2 aria-hidden="true" />
              </button>
              <button
                type="button"
                title="Refazer (Ctrl+Y)"
                aria-label="Refazer"
                disabled={historyCounts.future === 0}
                onClick={redo}
              >
                <Redo2 aria-hidden="true" />
              </button>
            </div>
            </div>
            <div className="export-menu" ref={exportMenuRef}>
              {exportMenuOpen && (
                <div id="export-options" className="export-dropdown" role="dialog" aria-label="Opções de exportação">
                  <input
                    className="art-name-input"
                    aria-label="Nome da arte"
                    placeholder="Nome da arte"
                    value={state.productName}
                    onChange={(event) =>
                      setState((current) => ({
                        ...current,
                        productName: event.target.value,
                      }))
                    }
                  />
                  <div className="export-color-picker">
                    <div className="list-header">
                      <span>Cores para exportar</span>
                    </div>
                    <div className="color-checklist">
                      {MOCKUPS.map((mockup) => (
                        <label key={mockup.id} className="color-toggle">
                          <input
                            type="checkbox"
                            checked={selectedColors.includes(mockup.id)}
                            onChange={() => toggleColorSelection(mockup.id)}
                            aria-label={`Exportar ${mockup.name}`}
                            title={mockup.name}
                          />
                          <span
                            className="color-swatch"
                            style={{ backgroundColor: mockup.swatch }}
                            aria-hidden="true"
                          >
                            {selectedColors.includes(mockup.id) && <Check aria-hidden="true" />}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="export-side-picker">
                    <div className="list-header">
                      <span>Lados para exportar</span>
                    </div>
                    <div className="side-checklist">
                      {EXPORT_SIDES.map((side) => {
                        const checked = selectedSides.includes(side.id);

                        return (
                          <label key={side.id} className="side-toggle">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleSideSelection(side.id)}
                              aria-label={`Exportar ${side.label}`}
                            />
                            <span className="side-chip">
                              <span className="side-check" aria-hidden="true">
                                {checked && <Check />}
                              </span>
                              {side.label}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                  <label className="export-art-option">
                    <input type="checkbox" checked={includeArt} onChange={() => setIncludeArt((value) => !value)} />
                    <span>Baixar também a arte (PNG transparente, na maior resolução)</span>
                  </label>
                  <button
                    className="primary-action"
                    type="button"
                    onClick={() => void handleExportAll()}
                    disabled={
                      exporting ||
                      !state.productName.trim() ||
                      (selectedColors.length === 0 && !includeArt) ||
                      selectedSides.length === 0
                    }
                    aria-busy={exporting || undefined}
                  >
                    {exporting
                      ? 'Exportando...'
                      : !state.productName.trim()
                        ? 'Preencha o nome da arte'
                        : selectedColors.length === 0 && !includeArt
                        ? 'Selecione uma cor'
                        : selectedSides.length === 0
                          ? 'Selecione um lado'
                          : `Exportar ${selectedColors.length * selectedSides.length} imagens${includeArt ? ' + arte' : ''}`}
                  </button>
                </div>
              )}
              <button
                className="export-trigger"
                type="button"
                title="Opções de exportação"
                aria-label="Abrir opções de exportação"
                aria-haspopup="dialog"
                aria-expanded={exportMenuOpen}
                aria-controls="export-options"
                onClick={() => setExportMenuOpen((open) => !open)}
              >
                <Download aria-hidden="true" />
              </button>
            </div>
          </div>

          <div
            ref={previewRef}
            className={`preview-stage ${toolMode === 'eraser' ? 'eraser-active' : ''} ${toolMode === 'remove-bg' ? 'wand-active' : ''} ${zoom > 1 ? 'zoomed' : ''}`}
            onPointerDown={handleStagePointerDown}
            onPointerMove={handlePreviewPointerMove}
            onPointerLeave={() => {
              handleStagePointerUp();
              setEraserCursor((cursor) => ({ ...cursor, visible: false }));
            }}
            onPointerUp={handleStagePointerUp}
          >
            <div
              ref={contentRef}
              className="preview-content"
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
            >
            <img
              src={activeMockup[state.activeSide]}
              alt="Mockup base"
              className="mockup-base"
            />

            {activeSideState.elements.map((element) => {
              const isSelected = element.id === activeSideState.selectedId;
              // 0.45 px por px natural numa camiseta de 760px de largura, mantido proporcional (cqw)
              // para a arte não mudar de tamanho em relação à camiseta quando o palco se ajusta à janela.
              const displayWidth = `max(40px, ${((element.naturalWidth * element.scale * 0.45) / 760) * 100}cqw)`;
              const displayHeight = `max(40px, ${((element.naturalHeight * element.scale * 0.45) / 760) * 100}cqw)`;

              return (
                <div
                  key={element.id}
                  className={`art-layer ${isSelected ? 'selected' : ''}`}
                  style={{
                    left: `${normalizePosition(element.x) * 100}%`,
                    top: `${normalizePosition(element.y) * 100}%`,
                    width: displayWidth,
                    height: displayHeight,
                    opacity: element.opacity,
                    filter: element.saturation ? `saturate(${saturationToFactor(element.saturation)})` : undefined,
                    visibility: element.visible ? 'visible' : 'hidden',
                    transform: `translate(-50%, -50%) rotate(${element.rotation}deg)`,
                  }}
                  onPointerDown={(event) => handlePointerDown(event, element)}
                  onPointerMove={(event) => handlePointerMove(event, element)}
                  onPointerUp={handlePointerUp}
                  onDoubleClick={() => {
                    if (toolMode === 'select') {
                      handleSelectElement(element.id);
                      setStudioTab('colors');
                    }
                  }}
                >
                  <ArtImage element={element} shading={fabricShading} />
                </div>
              );
            })}
            {toolMode === 'eraser' && eraserCursor.visible && (
              <div
                className="eraser-cursor"
                aria-hidden="true"
                style={{
                  left: eraserCursor.x,
                  top: eraserCursor.y,
                  width: eraserSize * 2,
                  height: eraserSize * 2,
                }}
              />
            )}
            </div>

            <div className="zoom-controls" aria-label="Zoom de visualização">
              <button
                type="button"
                title="Diminuir zoom"
                aria-label="Diminuir zoom"
                disabled={zoom === ZOOM_LEVELS[0]}
                onClick={() => changeZoom(-1)}
              >
                <ZoomOut aria-hidden="true" />
              </button>
              <button
                type="button"
                className="zoom-value"
                title="Voltar para 100%"
                aria-label={`Zoom ${Math.round(zoom * 100)}%. Voltar para 100%`}
                onClick={resetZoom}
              >
                {`${Math.round(zoom * 100)}%`}
              </button>
              <button
                type="button"
                title="Aumentar zoom"
                aria-label="Aumentar zoom"
                disabled={zoom === ZOOM_LEVELS[ZOOM_LEVELS.length - 1]}
                onClick={() => changeZoom(1)}
              >
                <ZoomIn aria-hidden="true" />
              </button>
            </div>
          </div>
          </div>
        </section>

        <aside className="controls-panel panel">
          <img
            className="brand-logo"
            src="/logo%20artshirt%20studio.png"
            alt="Artshirt Studio"
          />

          <div className="controls-list">
            {showSelectionControls && (
              <>
                <label>
                  <span>Tamanho</span>
                  <input
                    type="range"
                    min="0.1"
                    max="2"
                    step="0.01"
                    value={selectedElement.scale}
                    onPointerDown={checkpoint}
                    onKeyDown={checkpoint}
                    onChange={(event) => updateSelectedElement({ scale: Number(event.target.value) })}
                    onDoubleClick={() => {
                      checkpoint();
                      updateSelectedElement({ scale: 1 });
                    }}
                  />
                  <strong>{`${selectedElement.scale.toFixed(2)}x`}</strong>
                </label>

                <label>
                  <span>Rotação</span>
                  <input
                    type="range"
                    min="-180"
                    max="180"
                    step="1"
                    value={selectedElement.rotation}
                    onPointerDown={checkpoint}
                    onKeyDown={checkpoint}
                    onChange={(event) => updateSelectedElement({ rotation: Number(event.target.value) })}
                    onDoubleClick={() => {
                      checkpoint();
                      updateSelectedElement({ rotation: 0 });
                    }}
                  />
                  <strong>{`${selectedElement.rotation.toFixed(0)}°`}</strong>
                </label>

                <label>
                  <span>Opacidade</span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={selectedElement.opacity}
                    onPointerDown={checkpoint}
                    onKeyDown={checkpoint}
                    onChange={(event) => updateSelectedElement({ opacity: Number(event.target.value) })}
                    onDoubleClick={() => {
                      checkpoint();
                      updateSelectedElement({ opacity: 1 });
                    }}
                  />
                  <strong>{`${Math.round((selectedElement.opacity || 0) * 100)}%`}</strong>
                </label>

                <label>
                  <span>Efeito do tecido</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={fabricEffect}
                    onChange={(event) => setFabricEffect(Number(event.target.value))}
                    onDoubleClick={() => setFabricEffect(15)}
                    title="Luz e sombra das dobras da camiseta sobre a arte (vale para todas as artes e para a exportação)"
                  />
                  <strong>{fabricEffect === 0 ? 'Off' : `${fabricEffect}%`}</strong>
                </label>

                <details className="panel-section">
                  <summary>Cores da arte</summary>
                  <div className="section-body saturation-row">
                    <label>
                      <span>Saturação</span>
                      <input
                        type="range"
                        min="-100"
                        max="100"
                        step="1"
                        value={selectedElement.saturation ?? 0}
                        onPointerDown={checkpoint}
                        onKeyDown={checkpoint}
                        onChange={(event) => updateSelectedElement({ saturation: Number(event.target.value) })}
                        onDoubleClick={() => {
                          checkpoint();
                          updateSelectedElement({ saturation: 0 });
                        }}
                        title="Duplo clique para voltar ao original"
                      />
                      <strong>
                        {(selectedElement.saturation ?? 0) === 0
                          ? 'Original'
                          : `${(selectedElement.saturation ?? 0) > 0 ? '+' : ''}${selectedElement.saturation}`}
                      </strong>
                    </label>
                  </div>
                  <div className="section-body">
                    {selectedElement.colorLayers && selectedElement.colorLayers.length > 0 && (
                      <div className="color-summary" aria-hidden="true">
                        {selectedElement.colorLayers.map((layer) => (
                          <span
                            key={layer.id}
                            className={layer.level === 0 ? 'hidden-color' : ''}
                            style={{ backgroundColor: toHex(layer.replacement ?? layer.color) }}
                          />
                        ))}
                      </div>
                    )}
                    <button type="button" onClick={() => setStudioTab('colors')}>
                      {selectedElement.colorLayers ? 'Editar cores' : 'Detectar cores'}
                    </button>
                  </div>
                </details>

                <details className="panel-section">
                  <summary>Traçado</summary>
                  <div className="section-body">
              <label>
                <span>Traçado</span>
                <input
                  type="range"
                  min="1"
                  max="20"
                  step="1"
                  value={strokeWidth}
                  onChange={(event) => setStrokeWidth(Number(event.target.value))}
                  onDoubleClick={() => setStrokeWidth(1)}
                />
                <strong>{strokeWidth}px</strong>
              </label>
              <div className="stroke-actions">
                <input
                  type="color"
                  className="stroke-color"
                  title="Cor do traçado"
                  aria-label="Cor do traçado"
                  value={strokeColor}
                  onChange={(event) => setStrokeColor(event.target.value)}
                />
                <button type="button" onClick={() => void handleAddStroke()}>
                  Adicionar traçado
                </button>
              </div>
                  </div>
                </details>

              </>
            )}

            {showEraserControls && (
              <div className="eraser-controls">
              <label>
                <span>Tamanho da borracha</span>
                <input
                  type="range"
                  min="8"
                  max="120"
                  value={eraserSize}
                  onChange={(event) => setEraserSize(Number(event.target.value))}
                  onDoubleClick={() => setEraserSize(26)}
                />
                <strong>{eraserSize}px</strong>
              </label>
              </div>
            )}

            {showBackgroundControls && !selectedElement && (
              <p className="panel-hint">Selecione uma arte para usar a varinha.</p>
            )}

            {showBackgroundControls && selectedElement && (
              <div className="removal-controls">
              <label>
                <span>Remover fundo automático</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={tolerance}
                  onChange={(event) => setTolerance(Number(event.target.value))}
                  onDoubleClick={() => setTolerance(28)}
                />
                <strong>{tolerance}%</strong>
              </label>
              <button type="button" onClick={() => void handleRemoveBackground()}>
                Aplicar remoção
              </button>
              <label>
                <span>Refinar arestas</span>
                <input
                  type="range"
                  min="1"
                  max="5"
                  step="1"
                  value={edgeRadius}
                  onChange={(event) => setEdgeRadius(Number(event.target.value))}
                  onDoubleClick={() => setEdgeRadius(1)}
                />
                <strong>{edgeRadius}px</strong>
              </label>
              <button type="button" onClick={() => void handleRefineEdges()}>
                Refinar arestas
              </button>
              <p className="panel-hint">Ou clique na arte com a varinha para apagar só a área daquela cor.</p>
              </div>
            )}
          </div>

          <div className="element-list-panel">
            <div className="list-header">
              <span>Elementos</span>
              <div className="upload-box">
                <label
                  htmlFor="art-upload"
                  className="upload-button add-image-button"
                  title="Adicionar imagem"
                  aria-label="Adicionar imagem"
                >
                  <Plus aria-hidden="true" />
                </label>
                <input
                  id="art-upload"
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(event) => {
                    void handleAddImages(event.target.files);
                    event.target.value = '';
                  }}
                />
              </div>
            </div>
            <ul>
              {activeSideState.elements.map((element) => (
                <li key={element.id} className={element.id === activeSideState.selectedId ? 'selected' : ''}>
                  <button
                    type="button"
                    className="element-name"
                    onClick={() => handleSelectElement(element.id)}
                    onDoubleClick={() => {
                      handleSelectElement(element.id);
                      setStudioTab(studioTabForTool);
                    }}
                    title="Duplo clique para editar em foco"
                  >
                    {element.name}
                  </button>
                  <button
                    type="button"
                    className="visibility-toggle"
                    title={element.visible ? `Ocultar ${element.name}` : `Exibir ${element.name}`}
                    aria-label={element.visible ? `Ocultar ${element.name}` : `Exibir ${element.name}`}
                    aria-pressed={element.visible}
                    onClick={() => handleToggleVisibility(element.id)}
                  >
                    {element.visible ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
                  </button>
                  <button
                    type="button"
                    className="delete-layer"
                    title={`Excluir ${element.name}`}
                    aria-label={`Excluir ${element.name}`}
                    onClick={() => handleDeleteElement(element.id)}
                  >
                    <Minus aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </main>
      {studioTab && selectedElement && (
        <ArtStudioModal
          element={selectedElement}
          shirtImage={activeMockupImage}
          fabric={{ relief, strength: fabricEffect / 100 }}
          initialTab={studioTab}
          initialColorCount={colorCount}
          onCancel={() => setStudioTab(null)}
          onApply={(draft, count) => {
            checkpoint();
            updateSelectedElement(draft);
            setColorCount(count);
            setStudioTab(null);
            setStatus('Arte atualizada');
          }}
        />
      )}
    </div>
  );
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export default App;
