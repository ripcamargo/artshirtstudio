import { useEffect, useRef, useState } from 'react';
import { Check, Download, Eraser, Eye, EyeOff, Minus, MousePointer2, WandSparkles } from 'lucide-react';
import { MOCKUP_BY_ID, MOCKUPS } from './config/mockups';
import { removeSolidBackground } from './utils/backgroundRemoval';
import { applyEraserToImage, loadImage, renderMockupComposition } from './utils/canvasRenderer';
import { exportZip } from './utils/zipExporter';
import type { AppState, DesignElement, MockupId, Side, ToolMode } from './types/editor';
import './App.css';

const STORAGE_KEY = 'tshirt-mockup-creator-v1';

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
  const [exporting, setExporting] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [status, setStatus] = useState('Pronto');
  const [selectedColors, setSelectedColors] = useState<MockupId[]>(['black', 'white', 'wine', 'gray', 'navy']);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [eraserCursor, setEraserCursor] = useState({ x: 0, y: 0, visible: false });
  const previewRef = useRef<HTMLDivElement | null>(null);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const eraseActiveRef = useRef(false);

  const activeMockup = MOCKUP_BY_ID[state.activeColor];
  const activeSideState = state[state.activeSide];
  const selectedElement =
    activeSideState.elements.find((element) => element.id === activeSideState.selectedId) ?? null;
  const showSelectionControls = toolMode === 'select' && selectedElement;
  const showEraserControls = toolMode === 'eraser';
  const showBackgroundControls = toolMode === 'remove-bg';

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

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

  const handleAddImages = async (files: File[] | FileList | null) => {
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
          name: file.name.replace(/\.[^/.]+$/, '') || 'Arte',
          image: url,
          x: 0.5,
          y: 0.5,
          scale: Math.min(0.9, 480 / Math.max(image.naturalWidth, image.naturalHeight)),
          rotation: 0,
          opacity: 1,
          visible: true,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
        } satisfies DesignElement;
      }),
    );

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
    if (!previewRef.current || !element.visible) {
      return;
    }

    const rect = previewRef.current.getBoundingClientRect();
    const stageWidth = previewRef.current.clientWidth;
    const stageHeight = previewRef.current.clientHeight;
    const pointerX = event.clientX - rect.left - previewRef.current.clientLeft;
    const pointerY = event.clientY - rect.top - previewRef.current.clientTop;
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

  const toggleColorSelection = (colorId: MockupId) => {
    setSelectedColors((current) =>
      current.includes(colorId)
        ? current.filter((id) => id !== colorId)
        : [...current, colorId],
    );
  };

  const handleExportAll = async () => {
    if (selectedColors.length === 0) {
      setStatus('Selecione pelo menos uma cor');
      return;
    }

    setExporting(true);
    setStatus('Exportando mockups...');

    try {
      const files: Array<{ name: string; dataUrl: string }> = [];
      const mockupsToExport = MOCKUPS.filter((mockup) => selectedColors.includes(mockup.id));

      for (const mockup of mockupsToExport) {
        const frontPng = await renderMockupComposition({
          mockupImage: mockup.front,
          elements: state.front.elements,
        });
        const backPng = await renderMockupComposition({
          mockupImage: mockup.back,
          elements: state.back.elements,
        });

        files.push({
          name: `${toSafeFileName(state.productName)}-${toSafeFileName(mockup.name)}-frente.png`,
          dataUrl: frontPng,
        });
        files.push({
          name: `${toSafeFileName(state.productName)}-${toSafeFileName(mockup.name)}-costas.png`,
          dataUrl: backPng,
        });
      }

      await exportZip({
        zipName: `${toSafeFileName(state.productName)}-mockups.zip`,
        files,
      });
      setExportMenuOpen(false);
      setStatus(`${files.length / 2} cores exportadas`);
    } catch {
      setStatus('Erro ao exportar o ZIP');
    } finally {
      setExporting(false);
    }
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>, element: DesignElement) => {
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

    const rect = previewRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;

    updateSelectedElement({ x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) });
  };

  const handlePointerUp = () => {
    setDraggingId(null);
    eraseActiveRef.current = false;
  };

  const handlePreviewPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (toolMode !== 'eraser' || !previewRef.current) {
      return;
    }

    const rect = previewRef.current.getBoundingClientRect();
    setEraserCursor({
      x: event.clientX - rect.left - previewRef.current.clientLeft,
      y: event.clientY - rect.top - previewRef.current.clientTop,
      visible: true,
    });
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
                  <button
                    className="primary-action"
                    type="button"
                    onClick={() => void handleExportAll()}
                    disabled={exporting}
                  >
                    {exporting ? 'Exportando...' : 'Exportar selecionadas'}
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
            className={`preview-stage ${toolMode === 'eraser' ? 'eraser-active' : ''}`}
            onPointerMove={handlePreviewPointerMove}
            onPointerLeave={() => {
              handlePointerUp();
              setEraserCursor((cursor) => ({ ...cursor, visible: false }));
            }}
            onPointerUp={handlePointerUp}
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
                    visibility: element.visible ? 'visible' : 'hidden',
                    transform: `translate(-50%, -50%) rotate(${element.rotation}deg)`,
                  }}
                  onPointerDown={(event) => handlePointerDown(event, element)}
                  onPointerMove={(event) => handlePointerMove(event, element)}
                  onPointerUp={handlePointerUp}
                >
                  <img src={element.image} alt={element.name} draggable={false} />
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
                    onChange={(event) => updateSelectedElement({ opacity: Number(event.target.value) })}
                  />
                  <strong>{`${Math.round((selectedElement.opacity || 0) * 100)}%`}</strong>
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

            {showBackgroundControls && (
              <div className="removal-controls">
              <label>
                <span>Remover fundo</span>
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
