import { useEffect, useRef, useState } from 'react';
import { Check, Download, Eraser, Eye, EyeOff, Minus, MousePointer2, Redo2, RotateCcw, Undo2, WandSparkles, ZoomIn, ZoomOut } from 'lucide-react';
import { MOCKUP_BY_ID, MOCKUPS } from './config/mockups';
import { removeSolidBackground } from './utils/backgroundRemoval';
import { detectColors, hasActiveColorLayers, renderColorLayers, toHex } from './utils/colorLayers';
import { applyEraserToImage, loadImage, renderMockupComposition, saturationToFactor } from './utils/canvasRenderer';
import { exportZip } from './utils/zipExporter';
import type { AppState, ColorLayer, DesignElement, MockupId, Side, ToolMode } from './types/editor';
import './App.css';

const STORAGE_KEY = 'tshirt-mockup-creator-v1';
const HISTORY_LIMIT = 50;
const ZOOM_LEVELS = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6];
const EXPORT_SIDES: Array<{ id: Side; label: string; fileSuffix: string }> = [
  { id: 'front', label: 'Frente', fileSuffix: 'frente' },
  { id: 'back', label: 'Costas', fileSuffix: 'costas' },
];

interface StagePoint {
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
function toStagePoint(content: HTMLElement, clientX: number, clientY: number): StagePoint {
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

function normalizePosition(value: number) {
  if (value > 1) {
    return value / 1000;
  }

  return value;
}

/** Mostra a arte; quando há cores reduzidas/ocultas, desenha a versão processada num canvas. */
function ArtImage({ element }: { element: DesignElement }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const layers = hasActiveColorLayers(element.colorLayers) ? element.colorLayers : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!layers || !canvas) {
      return;
    }

    let cancelled = false;
    void renderColorLayers(element.image, layers).then((imageData) => {
      if (cancelled) {
        return;
      }

      canvas.width = imageData.width;
      canvas.height = imageData.height;
      canvas.getContext('2d')?.putImageData(imageData, 0, 0);
    });

    return () => {
      cancelled = true;
    };
  }, [element.image, layers]);

  if (!layers) {
    return <img src={element.image} alt={element.name} draggable={false} />;
  }

  return <canvas ref={canvasRef} role="img" aria-label={element.name} />;
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
  const [colorCount, setColorCount] = useState(8);
  const [detectingColors, setDetectingColors] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [status, setStatus] = useState('Pronto');
  const [selectedColors, setSelectedColors] = useState<MockupId[]>(['black', 'white', 'wine', 'gray', 'navy']);
  const [selectedSides, setSelectedSides] = useState<Side[]>(['front', 'back']);
  const [draggingId, setDraggingId] = useState<string | null>(null);
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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || isTextField(event.target)) {
        return;
      }

      const key = event.key.toLowerCase();
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

  const applyEraser = async (event: React.PointerEvent<HTMLDivElement>, element: DesignElement) => {
    if (!contentRef.current || !element.visible) {
      return;
    }

    const {
      x: pointerX,
      y: pointerY,
      width: stageWidth,
      height: stageHeight,
    } = toStagePoint(contentRef.current, event.clientX, event.clientY);
    const centerX = normalizePosition(element.x) * stageWidth;
    const centerY = normalizePosition(element.y) * stageHeight;
    const displayWidth = Math.max(40, element.naturalWidth * element.scale * 0.45);
    const displayHeight = Math.max(40, element.naturalHeight * element.scale * 0.45);
    const imageScale = Math.min(
      displayWidth / element.naturalWidth,
      displayHeight / element.naturalHeight,
    );
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
      return;
    }

    const radius = eraserSize / imageScale;

    try {
      const erased = await applyEraserToImage(
        element.image,
        Math.max(0, Math.min(localX, element.naturalWidth)),
        Math.max(0, Math.min(localY, element.naturalHeight)),
        radius,
      );

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

  const handleDetectColors = async () => {
    if (!selectedElement) {
      return;
    }

    setDetectingColors(true);
    setStatus('Analisando cores...');
    try {
      const layers = await detectColors(selectedElement.image, colorCount);
      checkpoint();
      updateSelectedElement({ colorLayers: layers });
      setStatus(`${layers.length} cores encontradas`);
    } catch {
      setStatus('Não foi possível analisar as cores');
    } finally {
      setDetectingColors(false);
    }
  };

  const updateColorLayer = (layerId: string, patch: Partial<ColorLayer>) => {
    if (!selectedElement?.colorLayers) {
      return;
    }

    updateSelectedElement({
      colorLayers: selectedElement.colorLayers.map((layer) =>
        layer.id === layerId ? { ...layer, ...patch } : layer,
      ),
    });
  };

  const resetColorLayers = () => {
    if (!selectedElement?.colorLayers) {
      return;
    }

    checkpoint();
    updateSelectedElement({
      colorLayers: selectedElement.colorLayers.map((layer) => ({ ...layer, level: 1 })),
    });
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
    if (selectedColors.length === 0) {
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
          });

          files.push({
            name: `${toSafeFileName(state.productName)}-${toSafeFileName(mockup.name)}-${side.fileSuffix}.png`,
            dataUrl: png,
          });
        }
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
    checkpoint();
    if (toolMode === 'eraser') {
      eraseActiveRef.current = true;
      void applyEraser(event, element);
      return;
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
    const x = point.x / point.width;
    const y = point.y / point.height;

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

  // Com zoom, a roda do mouse navega pela imagem em vez de rolar a página.
  useEffect(() => {
    const stage = previewRef.current;
    if (!stage || zoom === 1) {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const dx = event.shiftKey ? event.deltaY : event.deltaX;
      const dy = event.shiftKey ? 0 : event.deltaY;
      setPan((current) => clampPan({ x: current.x - dx, y: current.y - dy }, zoom, stage));
    };

    stage.addEventListener('wheel', handleWheel, { passive: false });
    return () => stage.removeEventListener('wheel', handleWheel);
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
      <header className="topbar">
        <img
          className="brand-logo"
          src="/logo%20artshirt%20studio.png"
          alt="Artshirt Studio"
        />
        <div className="status-announcer" role="status" aria-live="polite">
          {status}
        </div>
      </header>

      <main className="workspace">
        <section className="preview-panel panel">
          <div className="preview-header">
            <div className="segmented-control">
              <button
                type="button"
                className={state.activeSide === 'front' ? 'active' : ''}
                onClick={() => handleSelectSide('front')}
              >
                Frente
              </button>
              <button
                type="button"
                className={state.activeSide === 'back' ? 'active' : ''}
                onClick={() => handleSelectSide('back')}
              >
                Costas
              </button>
            </div>
          </div>

          <div className="mockup-switcher" aria-label="Cores do mockup">
            {MOCKUPS.map((mockup) => (
              <button
                key={mockup.id}
                type="button"
                className={state.activeColor === mockup.id ? 'active' : ''}
                title={mockup.name}
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
            <div className="upload-box">
              <label htmlFor="art-upload" className="upload-button">
                + Adicionar imagem
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
            <div className="export-menu" ref={exportMenuRef}>
              {exportMenuOpen && (
                <div id="export-options" className="export-dropdown" role="dialog" aria-label="Opções de exportação">
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
                  <button
                    className="primary-action"
                    type="button"
                    onClick={() => void handleExportAll()}
                    disabled={exporting || selectedColors.length === 0 || selectedSides.length === 0}
                    aria-busy={exporting || undefined}
                  >
                    {exporting
                      ? 'Exportando...'
                      : selectedColors.length === 0
                        ? 'Selecione uma cor'
                        : selectedSides.length === 0
                          ? 'Selecione um lado'
                          : `Exportar ${selectedColors.length * selectedSides.length} imagens`}
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
            className={`preview-stage ${toolMode === 'eraser' ? 'eraser-active' : ''} ${zoom > 1 ? 'zoomed' : ''}`}
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
              const displayWidth = Math.max(40, element.naturalWidth * element.scale * 0.45);
              const displayHeight = Math.max(40, element.naturalHeight * element.scale * 0.45);

              return (
                <div
                  key={element.id}
                  className={`art-layer ${isSelected ? 'selected' : ''}`}
                  style={{
                    left: `${normalizePosition(element.x) * 100}%`,
                    top: `${normalizePosition(element.y) * 100}%`,
                    width: `${displayWidth}px`,
                    height: `${displayHeight}px`,
                    opacity: element.opacity,
                    filter: element.saturation ? `saturate(${saturationToFactor(element.saturation)})` : undefined,
                    visibility: element.visible ? 'visible' : 'hidden',
                    transform: `translate(-50%, -50%) rotate(${element.rotation}deg)`,
                  }}
                  onPointerDown={(event) => handlePointerDown(event, element)}
                  onPointerMove={(event) => handlePointerMove(event, element)}
                  onPointerUp={handlePointerUp}
                >
                  <ArtImage element={element} />
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
        </section>

        <aside className="controls-panel panel">
          <div className="field">
            <label htmlFor="product-name">Nome da arte</label>
            <input
              id="product-name"
              value={state.productName}
              onChange={(event) =>
                setState((current) => ({
                  ...current,
                  productName: event.target.value,
                }))
              }
            />
            <small>{`Arquivo: ${toSafeFileName(state.productName)}-mockups.zip`}</small>
          </div>

          <div className="tool-switch" aria-label="Ferramentas do editor">
            <button
              type="button"
              title="Mover"
              aria-label="Seta de seleção"
              className={toolMode === 'select' ? 'active' : ''}
              onClick={() => setToolMode('select')}
            >
              <MousePointer2 aria-hidden="true" />
            </button>
            <button
              type="button"
              title="Borracha"
              aria-label="Borracha"
              className={toolMode === 'eraser' ? 'active' : ''}
              onClick={() => setToolMode('eraser')}
            >
              <Eraser aria-hidden="true" />
            </button>
            <button
              type="button"
              title="Remover fundo"
              aria-label="Varinha para remover fundo"
              className={toolMode === 'remove-bg' ? 'active' : ''}
              onClick={() => setToolMode('remove-bg')}
            >
              <WandSparkles aria-hidden="true" />
            </button>
            <span aria-hidden="true" />
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
                  />
                  <strong>{`${Math.round((selectedElement.opacity || 0) * 100)}%`}</strong>
                </label>

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
                />
                <strong>{eraserSize}px</strong>
              </label>
              </div>
            )}

            {showBackgroundControls && !selectedElement && (
              <p className="panel-hint">Selecione uma arte para ajustar as cores.</p>
            )}

            {showBackgroundControls && selectedElement && (
              <div className="removal-controls">
              <div className="color-layers">
                <div className="list-header">
                  <span>Cores da arte</span>
                  {selectedElement.colorLayers && selectedElement.colorLayers.length > 0 && (
                    <button
                      type="button"
                      className="icon-button"
                      title="Restaurar todas as cores"
                      aria-label="Restaurar todas as cores"
                      disabled={!hasActiveColorLayers(selectedElement.colorLayers)}
                      onClick={resetColorLayers}
                    >
                      <RotateCcw aria-hidden="true" />
                    </button>
                  )}
                </div>

                <label>
                  <span>Quantidade de cores</span>
                  <input
                    type="range"
                    min="2"
                    max="16"
                    step="1"
                    value={colorCount}
                    onChange={(event) => setColorCount(Number(event.target.value))}
                  />
                  <strong>{`até ${colorCount}`}</strong>
                </label>
                <button
                  type="button"
                  disabled={detectingColors}
                  onClick={() => void handleDetectColors()}
                >
                  {detectingColors
                    ? 'Analisando...'
                    : selectedElement.colorLayers
                      ? 'Detectar novamente'
                      : 'Detectar cores'}
                </button>

                {selectedElement.colorLayers && (
                  <ul className="color-layer-list">
                    {selectedElement.colorLayers.map((layer) => {
                      const hex = toHex(layer.color);
                      const hidden = layer.level === 0;

                      return (
                        <li key={layer.id} className={hidden ? 'hidden-color' : ''}>
                          <span
                            className="color-layer-swatch"
                            style={{ backgroundColor: hex }}
                            title={`${hex.toUpperCase()} · ${(layer.share * 100).toFixed(1)}% da arte`}
                            aria-hidden="true"
                          />
                          <input
                            type="range"
                            min="0"
                            max="100"
                            step="1"
                            value={Math.round(layer.level * 100)}
                            aria-label={`Intensidade da cor ${hex.toUpperCase()}`}
                            onPointerDown={checkpoint}
                            onKeyDown={checkpoint}
                            onChange={(event) =>
                              updateColorLayer(layer.id, { level: Number(event.target.value) / 100 })
                            }
                          />
                          <strong>{`${Math.round(layer.level * 100)}%`}</strong>
                          <button
                            type="button"
                            className="icon-button"
                            title={hidden ? 'Mostrar cor' : 'Ocultar cor'}
                            aria-label={`${hidden ? 'Mostrar' : 'Ocultar'} cor ${hex.toUpperCase()}`}
                            aria-pressed={hidden}
                            onClick={() => {
                              checkpoint();
                              updateColorLayer(layer.id, { level: hidden ? 1 : 0 });
                            }}
                          >
                            {hidden ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              <label>
                <span>Remover fundo automático</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={tolerance}
                  onChange={(event) => setTolerance(Number(event.target.value))}
                />
                <strong>{tolerance}%</strong>
              </label>
              <button type="button" onClick={() => void handleRemoveBackground()}>
                Aplicar remoção
              </button>
              </div>
            )}
          </div>

          <div className="element-list-panel">
            <div className="list-header">
              <span>Elementos</span>
            </div>
            <ul>
              {activeSideState.elements.map((element) => (
                <li key={element.id} className={element.id === activeSideState.selectedId ? 'selected' : ''}>
                  <button
                    type="button"
                    className="element-name"
                    onClick={() => handleSelectElement(element.id)}
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
