import { Eye, EyeOff, Maximize2, RotateCcw, Undo2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ColorLayer, DesignElement } from '../types/editor';
import { addStroke, refineEdges, removeColorAt, removeSolidBackground } from '../utils/backgroundRemoval';
import { eraseStroke } from '../utils/canvasRenderer';
import { detectColors, hasActiveColorLayers, toHex } from '../utils/colorLayers';
import { artBoxSize, normalizePosition, pointerToArtPixel } from '../utils/geometry';
import { ArtImage, type FabricShading } from './ArtImage';

export type StudioTab = 'colors' | 'background' | 'erase' | 'edges';

/** O que a janela altera na arte; tudo é aplicado de uma vez no OK. */
export interface ArtDraft {
  image: string;
  naturalWidth: number;
  naturalHeight: number;
  colorLayers?: ColorLayer[];
}

type Backdrop = 'shirt' | 'light' | 'dark' | 'checker';

const TABS: Array<{ id: StudioTab; label: string }> = [
  { id: 'colors', label: 'Cores' },
  { id: 'background', label: 'Fundo' },
  { id: 'erase', label: 'Apagar' },
  { id: 'edges', label: 'Bordas' },
];

const BACKDROPS: Array<{ id: Backdrop; label: string }> = [
  { id: 'shirt', label: 'Camiseta' },
  { id: 'light', label: 'Claro' },
  { id: 'dark', label: 'Escuro' },
  { id: 'checker', label: 'Xadrez' },
];

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 16;
/** Cada passo guarda uma cópia da imagem; o limite evita pesar a memória. */
const HISTORY_LIMIT = 20;
const CLICK_DISTANCE = 5;

interface ArtStudioModalProps {
  element: DesignElement;
  /** Foto da camiseta atual (frente/costas na cor ativa). */
  shirtImage: string;
  /** Sombreado das dobras; só é usado quando o fundo é a camiseta. */
  fabric: { relief: HTMLCanvasElement | null; strength: number };
  initialTab: StudioTab;
  initialColorCount: number;
  onApply: (draft: ArtDraft, colorCount: number) => void;
  onCancel: () => void;
}

function hexToRgb(value: string): [number, number, number] {
  return [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16)];
}

/** Janela de foco para tratar a arte em detalhe: cores, fundo, borracha e bordas, com zoom e fundos de teste. */
export function ArtStudioModal({
  element,
  shirtImage,
  fabric,
  initialTab,
  initialColorCount,
  onApply,
  onCancel,
}: ArtStudioModalProps) {
  const [draft, setDraft] = useState<ArtDraft>({
    image: element.image,
    naturalWidth: element.naturalWidth,
    naturalHeight: element.naturalHeight,
    colorLayers: element.colorLayers,
  });
  const draftRef = useRef(draft);
  const [tab, setTab] = useState<StudioTab>(initialTab);
  const [colorCount, setColorCount] = useState(initialColorCount);
  const [busy, setBusy] = useState(false);
  const [backdrop, setBackdrop] = useState<Backdrop>('shirt');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [contentSize, setContentSize] = useState({ width: 0, height: 0 });
  const [eraserSize, setEraserSize] = useState(26);
  const [tolerance, setTolerance] = useState(28);
  const [edgeRadius, setEdgeRadius] = useState(1);
  const [strokeWidth, setStrokeWidth] = useState(1);
  const [strokeColor, setStrokeColor] = useState('#ffffff');
  const [cursor, setCursor] = useState({ x: 0, y: 0, visible: false });
  const [notice, setNotice] = useState('');
  const stageRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pastRef = useRef<ArtDraft[]>([]);
  const [pastCount, setPastCount] = useState(0);
  const dragRef = useRef<{ clientX: number; clientY: number; x: number; y: number; moved: boolean } | null>(null);
  const strokeRef = useRef<{ pending: Array<{ x: number; y: number }>; radius: number; last: { x: number; y: number } | null; running: boolean } | null>(null);
  const spaceRef = useRef(false);
  const fittedRef = useRef(false);
  const viewRef = useRef({ zoom: 1, pan: { x: 0, y: 0 } });
  viewRef.current = { zoom, pan };

  const commit = (next: ArtDraft) => {
    draftRef.current = next;
    setDraft(next);
  };

  /** Guarda o estado atual para o "desfazer" (uma vez por gesto, não a cada pixel do slider). */
  const record = () => {
    const past = pastRef.current;
    if (past[past.length - 1] === draftRef.current) {
      return;
    }

    past.push(draftRef.current);
    if (past.length > HISTORY_LIMIT) {
      past.shift();
    }
    setPastCount(past.length);
  };

  const undo = () => {
    const previous = pastRef.current.pop();
    if (previous) {
      commit(previous);
      setPastCount(pastRef.current.length);
    }
  };

  const updateLayer = (layerId: string, patch: Partial<ColorLayer>) => {
    commit({
      ...draftRef.current,
      colorLayers: draftRef.current.colorLayers?.map((layer) => (layer.id === layerId ? { ...layer, ...patch } : layer)),
    });
  };

  /** Roda uma operação que gera uma nova imagem para a arte (fundo, bordas...). */
  const runImageOperation = async (
    operation: (image: string) => Promise<{ image: string; width?: number; height?: number } | null>,
    message: string,
  ) => {
    setBusy(true);
    try {
      const result = await operation(draftRef.current.image);
      if (result) {
        record();
        commit({
          ...draftRef.current,
          image: result.image,
          naturalWidth: result.width ?? draftRef.current.naturalWidth,
          naturalHeight: result.height ?? draftRef.current.naturalHeight,
        });
        setNotice(message);
      }
    } catch {
      setNotice('Não foi possível aplicar');
    } finally {
      setBusy(false);
    }
  };

  const runDetection = async () => {
    setBusy(true);
    try {
      const detected = await detectColors(draftRef.current.image, colorCount);
      record();
      commit({ ...draftRef.current, colorLayers: detected });
    } finally {
      setBusy(false);
    }
  };

  // Abre já analisando, se for na aba de cores e a arte ainda não tem cores detectadas.
  useEffect(() => {
    if (initialTab === 'colors' && !element.colorLayers) {
      void runDetection();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target instanceof HTMLInputElement && !['range', 'color', 'checkbox'].includes(target.type);
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        undo();
      } else if (event.key === ' ' && !typing && !(target instanceof HTMLButtonElement)) {
        spaceRef.current = true;
        event.preventDefault();
      } else if (event.key === '[' || event.key === ']') {
        event.preventDefault();
        setEraserSize((size) => Math.max(8, Math.min(120, size + (event.key === ']' ? 4 : -4))));
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === ' ') {
        spaceRef.current = false;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onCancel]);

  // Tamanho da camiseta na tela (sem zoom): posição e tamanho da arte dependem dele.
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

  const box = artBoxSize({ scale: element.scale, naturalWidth: draft.naturalWidth, naturalHeight: draft.naturalHeight }, contentSize.width);

  /** Enquadra a arte na tela (ou a camiseta inteira, com `wholeShirt`). */
  const fitView = (wholeShirt = false) => {
    const stage = stageRef.current;
    if (!stage || !contentSize.width) {
      return;
    }

    if (wholeShirt) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
      return;
    }

    const target = Math.min((stage.clientWidth * 0.8) / box.width, (stage.clientHeight * 0.8) / box.height);
    const nextZoom = Math.max(1, Math.min(MAX_ZOOM, target));
    const offsetX = (normalizePosition(element.x) - 0.5) * contentSize.width;
    const offsetY = (normalizePosition(element.y) - 0.5) * contentSize.height;
    setZoom(nextZoom);
    setPan({ x: -offsetX * nextZoom, y: -offsetY * nextZoom });
  };

  // Começa já aproximado na arte, para analisar de perto.
  useEffect(() => {
    if (!fittedRef.current && contentSize.width > 0) {
      fittedRef.current = true;
      fitView();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentSize.width]);

  // Roda do mouse: zoom em torno do ponteiro.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const px = event.clientX - rect.left - rect.width / 2;
      const py = event.clientY - rect.top - rect.height / 2;
      const { zoom: currentZoom, pan: currentPan } = viewRef.current;
      const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, currentZoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
      setZoom(nextZoom);
      setPan({
        x: px - ((px - currentPan.x) / currentZoom) * nextZoom,
        y: py - ((py - currentPan.y) / currentZoom) * nextZoom,
      });
    };

    stage.addEventListener('wheel', handleWheel, { passive: false });
    return () => stage.removeEventListener('wheel', handleWheel);
  }, []);

  /** Ponto da imagem sob o ponteiro, considerando a arte exibida (com o tamanho do rascunho). */
  const pixelAt = (clientX: number, clientY: number) => {
    if (!contentRef.current) {
      return null;
    }

    return pointerToArtPixel(contentRef.current, clientX, clientY, {
      x: element.x,
      y: element.y,
      scale: element.scale,
      rotation: element.rotation,
      naturalWidth: draftRef.current.naturalWidth,
      naturalHeight: draftRef.current.naturalHeight,
    });
  };

  // Apaga os pontos acumulados do traço em lotes, sem travar o ponteiro enquanto a imagem é regravada.
  const pumpStroke = async () => {
    const stroke = strokeRef.current;
    if (!stroke || stroke.running) {
      return;
    }

    stroke.running = true;
    try {
      while (stroke.pending.length > 0) {
        const points = stroke.pending.splice(0);
        const image = await eraseStroke(draftRef.current.image, points, stroke.radius);
        commit({ ...draftRef.current, image });
      }
    } finally {
      stroke.running = false;
    }
  };

  const addStrokePoint = (clientX: number, clientY: number) => {
    const stroke = strokeRef.current;
    const point = pixelAt(clientX, clientY);
    if (!stroke || !point) {
      return;
    }

    // Preenche o caminho entre dois movimentos para o traço não ficar pontilhado.
    const last = stroke.last;
    if (last) {
      const distance = Math.hypot(point.x - last.x, point.y - last.y);
      const step = Math.max(1, stroke.radius / 2);
      for (let travelled = step; travelled < distance; travelled += step) {
        const t = travelled / distance;
        stroke.pending.push({ x: last.x + (point.x - last.x) * t, y: last.y + (point.y - last.y) * t });
      }
    }
    stroke.pending.push({ x: point.x, y: point.y });
    stroke.last = { x: point.x, y: point.y };
    void pumpStroke();
  };

  const handleStagePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('.color-modal-tools') || busy) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    const panning = event.button !== 0 || spaceRef.current;

    if (tab === 'erase' && !panning) {
      const point = pixelAt(event.clientX, event.clientY);
      record();
      strokeRef.current = {
        pending: [],
        // O pincel tem o tamanho do controle na tela, qualquer que seja o zoom.
        radius: point ? eraserSize / viewRef.current.zoom / point.imageScale : eraserSize,
        last: null,
        running: false,
      };
      addStrokePoint(event.clientX, event.clientY);
      return;
    }

    dragRef.current = { clientX: event.clientX, clientY: event.clientY, x: pan.x, y: pan.y, moved: false };
  };

  const handleStagePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setCursor({ x: event.clientX - rect.left, y: event.clientY - rect.top, visible: true });

    if (strokeRef.current) {
      addStrokePoint(event.clientX, event.clientY);
      return;
    }

    const drag = dragRef.current;
    if (drag) {
      const dx = event.clientX - drag.clientX;
      const dy = event.clientY - drag.clientY;
      if (Math.hypot(dx, dy) > CLICK_DISTANCE) {
        drag.moved = true;
      }
      setPan({ x: drag.x + dx, y: drag.y + dy });
    }
  };

  const handleStagePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    strokeRef.current = null;
    const drag = dragRef.current;
    dragRef.current = null;

    // Varinha: um clique (sem arrastar) apaga a região daquela cor.
    if (drag && !drag.moved && tab === 'background' && event.button === 0 && !busy) {
      const point = pixelAt(event.clientX, event.clientY);
      if (point) {
        void runImageOperation(async (image) => {
          const cleaned = await removeColorAt(image, point.x, point.y, tolerance);
          return cleaned ? { image: cleaned } : null;
        }, 'Cor removida');
      }
    }
  };

  const shading: FabricShading | null =
    backdrop === 'shirt' && fabric.relief && fabric.strength > 0 && contentSize.width > 0
      ? {
          relief: fabric.relief,
          strength: fabric.strength,
          contentWidth: contentSize.width,
          contentHeight: contentSize.height,
        }
      : null;

  const previewElement: DesignElement = {
    ...element,
    image: draft.image,
    naturalWidth: draft.naturalWidth,
    naturalHeight: draft.naturalHeight,
    colorLayers: draft.colorLayers,
  };
  const layers = draft.colorLayers ?? [];
  const changed = hasActiveColorLayers(layers);
  const eraserCursorSize = eraserSize * 2;

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="color-modal" role="dialog" aria-modal="true" aria-label="Tratamento da arte">
        <div
          ref={stageRef}
          className={`color-modal-stage backdrop-${backdrop} tool-${tab}`}
          onPointerDown={handleStagePointerDown}
          onPointerMove={handleStagePointerMove}
          onPointerUp={handleStagePointerUp}
          onPointerLeave={() => setCursor((current) => ({ ...current, visible: false }))}
          onDoubleClick={(event) => {
            if (tab !== 'erase' && !(event.target as HTMLElement).closest('.color-modal-tools')) {
              fitView();
            }
          }}
        >
          <div
            ref={contentRef}
            className="color-modal-content"
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
          >
            {backdrop === 'shirt' && <img className="mockup-base" src={shirtImage} alt="Camiseta" draggable={false} />}
            {contentSize.width > 0 && (
              <div
                className="art-layer color-modal-art"
                style={{
                  left: `${normalizePosition(element.x) * 100}%`,
                  top: `${normalizePosition(element.y) * 100}%`,
                  width: `${box.width}px`,
                  height: `${box.height}px`,
                  opacity: element.opacity,
                  transform: `translate(-50%, -50%) rotate(${element.rotation}deg)`,
                }}
              >
                <ArtImage element={previewElement} shading={shading} />
              </div>
            )}
          </div>

          {tab === 'erase' && cursor.visible && (
            <div
              className="eraser-cursor"
              aria-hidden="true"
              style={{ left: cursor.x, top: cursor.y, width: eraserCursorSize, height: eraserCursorSize }}
            />
          )}

          <div className="color-modal-tools">
            <div className="backdrop-switch" aria-label="Fundo da visualização">
              {BACKDROPS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={backdrop === option.id ? 'active' : ''}
                  onClick={() => setBackdrop(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="backdrop-switch">
              <button type="button" title="Enquadrar na arte" onClick={() => fitView()}>
                <Maximize2 aria-hidden="true" /> Arte
              </button>
              <button type="button" title="Ver a camiseta inteira" onClick={() => fitView(true)}>
                Camiseta
              </button>
              <span className="zoom-readout">{`${Math.round(zoom * 100)}%`}</span>
            </div>
          </div>
        </div>

        <aside className="color-modal-panel">
          <div className="color-modal-header">
            <h2>Tratar arte</h2>
            <div className="color-modal-header-actions">
              <button
                type="button"
                className="icon-button"
                title="Desfazer (Ctrl+Z)"
                aria-label="Desfazer"
                disabled={pastCount === 0 || busy}
                onClick={undo}
              >
                <Undo2 aria-hidden="true" />
              </button>
              <button type="button" className="icon-button" title="Cancelar (Esc)" aria-label="Cancelar" onClick={onCancel}>
                <X aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="studio-tabs" role="tablist">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                className={tab === item.id ? 'active' : ''}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="studio-body">
            {tab === 'colors' && (
              <>
                <div className="color-modal-detect">
                  <label>
                    <span>Quantidade de cores</span>
                    <input
                      type="range"
                      min="2"
                      max="16"
                      step="1"
                      value={colorCount}
                      onChange={(event) => setColorCount(Number(event.target.value))}
                      onDoubleClick={() => setColorCount(8)}
                    />
                    <strong>{`até ${colorCount}`}</strong>
                  </label>
                  <div className="studio-row">
                    <button type="button" disabled={busy} onClick={() => void runDetection()}>
                      {busy ? 'Analisando...' : layers.length > 0 ? 'Detectar novamente' : 'Detectar cores'}
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      title="Restaurar todas as cores"
                      aria-label="Restaurar todas as cores"
                      disabled={!changed}
                      onClick={() => {
                        record();
                        commit({
                          ...draftRef.current,
                          colorLayers: draftRef.current.colorLayers?.map(({ replacement: _replacement, ...layer }) => ({
                            ...layer,
                            level: 1,
                          })),
                        });
                      }}
                    >
                      <RotateCcw aria-hidden="true" />
                    </button>
                  </div>
                </div>

                <ul className="color-layer-list color-modal-list">
                  {layers.map((layer) => {
                    const hex = toHex(layer.color);
                    const hidden = layer.level === 0;

                    return (
                      <li key={layer.id} className={hidden ? 'hidden-color' : ''}>
                        <label
                          className="color-layer-swatch"
                          style={{ backgroundColor: layer.replacement ? toHex(layer.replacement) : hex }}
                          title={`${hex.toUpperCase()} · ${(layer.share * 100).toFixed(1)}% da arte. Clique para trocar a cor${
                            layer.replacement ? '; duplo clique para voltar à original' : ''
                          }`}
                          onDoubleClick={() => {
                            if (layer.replacement) {
                              record();
                              updateLayer(layer.id, { replacement: undefined });
                            }
                          }}
                        >
                          <input
                            type="color"
                            aria-label={`Trocar a cor ${hex.toUpperCase()}`}
                            value={toHex(layer.replacement ?? layer.color)}
                            onClick={record}
                            onChange={(event) => updateLayer(layer.id, { replacement: hexToRgb(event.target.value) })}
                          />
                        </label>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          step="1"
                          value={Math.round(layer.level * 100)}
                          aria-label={`Intensidade da cor ${hex.toUpperCase()}`}
                          onPointerDown={record}
                          onKeyDown={record}
                          onChange={(event) => updateLayer(layer.id, { level: Number(event.target.value) / 100 })}
                        />
                        <strong>{`${Math.round(layer.level * 100)}%`}</strong>
                        <button
                          type="button"
                          className="icon-button"
                          title={hidden ? 'Mostrar cor' : 'Ocultar cor'}
                          aria-label={`${hidden ? 'Mostrar' : 'Ocultar'} cor ${hex.toUpperCase()}`}
                          aria-pressed={hidden}
                          onClick={() => {
                            record();
                            updateLayer(layer.id, { level: hidden ? 1 : 0 });
                          }}
                        >
                          {hidden ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                        </button>
                      </li>
                    );
                  })}
                  {layers.length === 0 && !busy && <li className="panel-hint">Nenhuma cor detectada ainda.</li>}
                </ul>
              </>
            )}

            {tab === 'background' && (
              <div className="studio-section">
                <label className="studio-slider">
                  <span>Tolerância</span>
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
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void runImageOperation(async (image) => ({ image: await removeSolidBackground(image, tolerance) }), 'Fundo removido')
                  }
                >
                  Remover fundo automático
                </button>
                <p className="panel-hint">
                  Ou clique na arte para apagar só a região contínua daquela cor. Arrastar move a visualização.
                  Experimente os fundos Escuro e Xadrez para enxergar sobras claras.
                </p>
              </div>
            )}

            {tab === 'erase' && (
              <div className="studio-section">
                <label className="studio-slider">
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
                <p className="panel-hint">
                  Arraste sobre a arte para apagar. O pincel tem sempre o mesmo tamanho na tela, com qualquer zoom.
                  Use [ e ] para ajustar o tamanho e mantenha Espaço pressionado (ou o botão do meio) para mover a visualização.
                </p>
              </div>
            )}

            {tab === 'edges' && (
              <div className="studio-section">
                <label className="studio-slider">
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
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void runImageOperation(async (image) => ({ image: await refineEdges(image, edgeRadius) }), 'Arestas refinadas')
                  }
                >
                  Refinar arestas
                </button>

                <label className="studio-slider">
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
                <div className="studio-row">
                  <input
                    type="color"
                    className="stroke-color"
                    title="Cor do traçado"
                    aria-label="Cor do traçado"
                    value={strokeColor}
                    onChange={(event) => setStrokeColor(event.target.value)}
                  />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void runImageOperation(async (image) => {
                        const stroked = await addStroke(image, strokeWidth, strokeColor);
                        return { image: stroked.image, width: stroked.width, height: stroked.height };
                      }, 'Traçado adicionado')
                    }
                  >
                    Adicionar traçado
                  </button>
                </div>
              </div>
            )}
          </div>

          <p className="studio-notice" role="status" aria-live="polite">
            {notice}
          </p>

          <div className="color-modal-footer">
            <button type="button" onClick={onCancel}>
              Cancelar
            </button>
            <button type="button" className="primary-action" disabled={busy} onClick={() => onApply(draftRef.current, colorCount)}>
              OK
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
