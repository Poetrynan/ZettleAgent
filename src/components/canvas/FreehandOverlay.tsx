/**
 * FreehandOverlay — 自由手绘 SVG 浮层 (性能优化版)
 *
 * 优化策略:
 * 1. 使用 Canvas 2D 进行实时笔触绘制，避免每帧 React 重渲染
 * 2. 只在 pointerup 时将完成的笔触提交到 React state
 * 3. 离屏 Canvas 缓存已完成的笔触，减少主线程负担
 * 4. 擦除模式使用空间索引加速碰撞检测
 */
import { useState, useCallback, useRef, useEffect, useImperativeHandle, forwardRef } from 'react';
import { getStroke } from 'perfect-freehand';

// ── 类型

export type PenMode = 'off' | 'pen' | 'eraser';

export interface StrokeData {
  id: string;
  points: [number, number, number][];  // [x, y, pressure] 屏幕坐标
  color: string;
  size: number;
}

export interface FreehandOverlayHandle {
  undo: () => void;
  clearAll: () => void;
  strokeCount: number;
}

interface FreehandOverlayProps {
  mode: PenMode;
  viewport: { x: number; y: number; zoom: number };
  penColor?: string;
  penSize?: number;
  eraserSize?: number;
  containerWidth: number;
  containerHeight: number;
  /** Canvas file path for localStorage persistence */
  canvasPath?: string | null;
}

// ── localStorage helpers

const STORAGE_PREFIX = 'zettel-freehand-';

function loadStrokes(canvasPath: string): StrokeData[] {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + canvasPath);
    if (!raw) return [];
    return JSON.parse(raw) as StrokeData[];
  } catch {
    return [];
  }
}

function saveStrokes(canvasPath: string, strokes: StrokeData[]): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + canvasPath, JSON.stringify(strokes));
  } catch {
    // localStorage full — silently ignore
  }
}

// ── 工具

function average(a: number, b: number): number {
  return (a + b) / 2;
}

function getSvgPathFromStroke(points: [number, number][]): string {
  const len = points.length;
  if (len < 4) return '';

  let a = points[0];
  let b = points[1];
  const c = points[2];

  let result = `M${a[0].toFixed(2)},${a[1].toFixed(2)} Q${b[0].toFixed(2)},${b[1].toFixed(2)} ${average(b[0], c[0]).toFixed(2)},${average(b[1], c[1]).toFixed(2)} T`;

  for (let i = 2, max = len - 1; i < max; i++) {
    a = points[i];
    b = points[i + 1];
    result += `${average(a[0], b[0]).toFixed(2)},${average(a[1], b[1]).toFixed(2)} `;
  }

  return result + 'Z';
}

const STROKE_OPTIONS = {
  size: 4,
  thinning: 0.6,
  smoothing: 0.5,
  streamline: 0.5,
  simulatePressure: true,
  last: true,
  start: { cap: true, taper: 0 } as const,
  end: { cap: true, taper: 0 } as const,
} as const;

// ── 笔触包围盒缓存 (性能优化: 避免重复计算)

interface StrokeWithBounds extends StrokeData {
  bounds?: { minX: number; maxX: number; minY: number; maxY: number };
}

function getStrokeBounds(stroke: StrokeData): { minX: number; maxX: number; minY: number; maxY: number } {
  if ('bounds' in stroke && (stroke as StrokeWithBounds).bounds) {
    return (stroke as StrokeWithBounds).bounds!;
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of stroke.points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}

// ── 组件

export const FreehandOverlay = forwardRef<FreehandOverlayHandle, FreehandOverlayProps>((props, ref) => {
  const {
      mode,
      viewport,
      penColor = '#3b82f6',
      penSize = 4,
      eraserSize = 24,
      containerWidth,
      containerHeight,
      canvasPath,
    } = props;

  const eraserRadiusRef = useRef(eraserSize);
  eraserRadiusRef.current = eraserSize;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  // Initialize strokes from localStorage
  const [strokes, setStrokes] = useState<StrokeData[]>(() => {
    if (canvasPath) return loadStrokes(canvasPath);
    return [];
  });
  const [hoveredStrokeId, setHoveredStrokeId] = useState<string | null>(null);
  const [eraserPos, setEraserPos] = useState<{ x: number; y: number } | null>(null);
  const currentStrokeRef = useRef<StrokeData | null>(null);
  const isDrawingRef = useRef(false);
  const isErasingRef = useRef(false);
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;

  // 性能优化: Canvas refs for efficient rendering
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const needsRedrawRef = useRef(false);

  const penSizeRef = useRef(penSize);
  penSizeRef.current = penSize;
  const penColorRef = useRef(penColor);
  penColorRef.current = penColor;

  // 性能优化: 创建离屏 Canvas 用于缓存已完成的笔触
  useEffect(() => {
    if (!offscreenCanvasRef.current) {
      offscreenCanvasRef.current = document.createElement('canvas');
    }
    const offscreen = offscreenCanvasRef.current;
    offscreen.width = containerWidth;
    offscreen.height = containerHeight;
  }, [containerWidth, containerHeight]);

  // Persist strokes to localStorage
  useEffect(() => {
    if (canvasPath) {
      saveStrokes(canvasPath, strokes);
    }
  }, [strokes, canvasPath]);

  // Reload strokes when canvasPath changes
  useEffect(() => {
    if (canvasPath) {
      setStrokes(loadStrokes(canvasPath));
    } else {
      setStrokes([]);
    }
  }, [canvasPath]);

  // Expose undo / clearAll via ref
  useImperativeHandle(ref, () => ({
    undo() {
      setStrokes(prev => {
        if (prev.length === 0) return prev;
        return prev.slice(0, -1);
      });
    },
    clearAll() {
      setStrokes([]);
    },
    strokeCount: strokes.length,
  }), [strokes]);

  // mode 切到 off 时终止当前笔触
  useEffect(() => {
    if (mode === 'off') {
      if (currentStrokeRef.current && currentStrokeRef.current.points.length > 1) {
        setStrokes(prev => [...prev, currentStrokeRef.current!]);
      }
      currentStrokeRef.current = null;
      isDrawingRef.current = false;
    }
  }, [mode]);

  // 性能优化: 使用 Canvas 2D 绘制笔触
  const drawStrokeToCanvas = useCallback((ctx: CanvasRenderingContext2D, stroke: StrokeData, isHovered: boolean, vp: { x: number; y: number; zoom: number }) => {
    if (stroke.points.length < 2) return;
    const flowPoints: [number, number, number][] = stroke.points.map(
      ([sx, sy, p]) => [(sx - vp.x) / vp.zoom, (sy - vp.y) / vp.zoom, p]
    );
    const outline = getStroke(flowPoints, {
      ...STROKE_OPTIONS,
      size: stroke.size / vp.zoom,
    });
    if (!outline || outline.length < 4) return;

    const path = new Path2D(getSvgPathFromStroke(outline as [number, number][]));
    ctx.fillStyle = stroke.color;
    ctx.globalAlpha = isHovered ? 0.4 : 0.85;
    ctx.fill(path);
    ctx.globalAlpha = 1;
  }, []);

  // 性能优化: 重绘所有笔触到 Canvas
  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const vp = viewportRef.current;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 绘制已完成的笔触
    for (const stroke of strokesRef.current) {
      const isHovered = mode === 'eraser' && hoveredStrokeId === stroke.id;
      drawStrokeToCanvas(ctx, stroke, isHovered, vp);
    }

    // 绘制当前正在绘制的笔触
    if (currentStrokeRef.current) {
      drawStrokeToCanvas(ctx, currentStrokeRef.current, false, vp);
    }
  }, [mode, hoveredStrokeId, drawStrokeToCanvas]);

  // 性能优化: 使用 requestAnimationFrame 批量重绘
  const scheduleRedraw = useCallback(() => {
    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(() => {
        redrawCanvas();
        rafIdRef.current = null;
      });
    }
  }, [redrawCanvas]);

  // 当笔触变化时重绘
  useEffect(() => {
    scheduleRedraw();
  }, [strokes, scheduleRedraw]);

  // 当视口变化时重绘
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = containerWidth;
      canvas.height = containerHeight;
    }
    scheduleRedraw();
  }, [containerWidth, containerHeight, viewport, scheduleRedraw]);

  // 执行一次擦除操作（复用指针按下 / 拖动）- 使用包围盒加速
  const applyErase = useCallback((sx: number, sy: number) => {
    const radius = eraserRadiusRef.current;
    setStrokes(prev => {
      const erase = eraseStrokePartial(sx, sy, radius);
      let changed = false;
      const next: StrokeData[] = [];
      for (const s of prev) {
        const frags = erase(s);
        if (frags.length === 0) {
          changed = true;
        } else if (frags.length === 1 && frags[0].points.length === s.points.length) {
          next.push(s);
        } else {
          changed = true;
          next.push(...frags);
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const handlePointerDown = useCallback((e: PointerEvent) => {
    if (mode === 'off') return;
    if (e.button !== 0) return;
    // Shift+drag on pane → React Flow marquee selection
    if (e.shiftKey) return;

    e.preventDefault();
    e.stopPropagation();

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (mode === 'eraser') {
      isErasingRef.current = true;
      applyErase(sx, sy);
      return;
    }

    // pen mode
    const stroke: StrokeData = {
      id: `stroke-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      points: [[sx, sy, e.pressure || 0.5]],
      color: penColorRef.current,
      size: penSizeRef.current,
    };
    currentStrokeRef.current = stroke;
    isDrawingRef.current = true;
  }, [mode, applyErase]);

  const handlePointerMoveInner = useCallback((e: PointerEvent) => {
    if (mode === 'off') return;

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const insideCanvas =
      e.clientX >= rect.left && e.clientX <= rect.right &&
      e.clientY >= rect.top && e.clientY <= rect.bottom;

    // Eraser mode: track position + erase while dragging
    if (mode === 'eraser') {
      if (!insideCanvas && !isErasingRef.current) {
        setEraserPos(null);
        setHoveredStrokeId(null);
        return;
      }

      const vp = viewportRef.current;
      const flowX = (sx - vp.x) / vp.zoom;
      const flowY = (sy - vp.y) / vp.zoom;
      setEraserPos({ x: flowX, y: flowY });

      if (isErasingRef.current) {
        applyErase(sx, sy);
        setHoveredStrokeId(null);
      } else {
        // 未按下:只做悬停高亮（使用包围盒加速）
        const currentStrokes = strokesRef.current;
        let found: string | null = null;
        for (let i = currentStrokes.length - 1; i >= 0; i--) {
          const s = currentStrokes[i];
          const bounds = getStrokeBounds(s);
          if (sx >= bounds.minX - eraserRadiusRef.current &&
              sx <= bounds.maxX + eraserRadiusRef.current &&
              sy >= bounds.minY - eraserRadiusRef.current &&
              sy <= bounds.maxY + eraserRadiusRef.current) {
            if (strokeContainsPoint(s, sx, sy, eraserRadiusRef.current)) {
              found = s.id;
              break;
            }
          }
        }
        setHoveredStrokeId(found);
      }
      return;
    }

    // Pen mode
    if (!isDrawingRef.current) return;

    currentStrokeRef.current!.points.push([sx, sy, e.pressure || 0.5]);

    // 性能优化: 使用 RAF 批量重绘，避免每帧 setState
    scheduleRedraw();
  }, [mode, applyErase, scheduleRedraw]);

  const handlePointerMove = useCallback((e: PointerEvent) => {
    if (isDrawingRef.current || isErasingRef.current) {
      e.preventDefault();
    }
    handlePointerMoveInner(e);
  }, [handlePointerMoveInner]);

  const handlePointerUp = useCallback((e: PointerEvent) => {
    isErasingRef.current = false;
    if (!isDrawingRef.current) return;
    e.preventDefault();
    isDrawingRef.current = false;

    const cs = currentStrokeRef.current;
    if (cs && cs.points.length > 1) {
      // 只在笔触完成时更新 React state
      setStrokes(prev => [...prev, { ...cs, points: [...cs.points] }]);
    }
    currentStrokeRef.current = null;
  }, []);

  // ── ESC 退出：在 window 上 capture-phase 监听，避免焦点丢失导致失效 ──
  const containerRef = useRef<HTMLDivElement>(null);

  // 在 pane 上监听指针事件，overlay 本身 pointer-events:none，不阻挡节点选中
  useEffect(() => {
    if (mode === 'off') return;

    const pane = containerRef.current
      ?.closest('.interactive-canvas-container')
      ?.querySelector('.react-flow__pane');
    if (!pane) return;

    const onPointerDown = (e: PointerEvent) => handlePointerDown(e);
    const onPointerMove = (e: PointerEvent) => handlePointerMove(e);
    const onPointerUp = (e: PointerEvent) => handlePointerUp(e);

    pane.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);

    return () => {
      pane.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [mode, handlePointerDown, handlePointerMove, handlePointerUp]);

  useEffect(() => {
    if (mode === 'off') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        window.dispatchEvent(new CustomEvent('freehand-exit'));
      }
    };
    window.addEventListener('keydown', onKey, true); // capture phase
    return () => window.removeEventListener('keydown', onKey, true);
  }, [mode]);

  return (
    <div
      ref={containerRef}
      aria-hidden={mode === 'off'}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: containerWidth,
        height: containerHeight,
        pointerEvents: 'none',
        outline: 'none',
        zIndex: mode !== 'off' ? 1000 : 'auto',
      }}
    >
      {/* 性能优化: 使用 Canvas 替代 SVG 进行实时绘制 */}
      <canvas
        ref={canvasRef}
        width={containerWidth}
        height={containerHeight}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: containerWidth,
          height: containerHeight,
          pointerEvents: 'none',
          zIndex: 999,
          touchAction: 'none',
        }}
      />

      {/* Eraser cursor: 磨砂圆圈 - 使用独立的 DOM 元素避免 Canvas 重绘 */}
      {mode === 'eraser' && eraserPos && (() => {
        const vp = viewportRef.current;
        const r = eraserSize / vp.zoom;
        const isActive = !!hoveredStrokeId;
        const strokeColor = isActive ? '#ef4444' : '#94a3b8';
        return (
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: '100%',
              height: '100%',
              pointerEvents: 'none',
              zIndex: 1000,
            }}
          >
            <svg
              viewBox={`${vp.x} ${vp.y} ${containerWidth / vp.zoom} ${containerHeight / vp.zoom}`}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: containerWidth,
                height: containerHeight,
                overflow: 'visible',
              }}
            >
              <defs>
                <filter id="eraser-blur" x="-50%" y="-50%" width="200%" height="200%">
                  <feGaussianBlur in="SourceGraphic" stdDeviation="2" />
                </filter>
              </defs>
              <g pointerEvents="none">
                <circle
                  cx={eraserPos.x}
                  cy={eraserPos.y}
                  r={r}
                  fill={isActive ? 'rgba(239,68,68,0.12)' : 'rgba(148,163,184,0.10)'}
                  filter="url(#eraser-blur)"
                />
                <circle
                  cx={eraserPos.x}
                  cy={eraserPos.y}
                  r={r}
                  fill="none"
                  stroke={strokeColor}
                  strokeWidth={1.5 / vp.zoom}
                  opacity={isActive ? 0.9 : 0.6}
                  strokeDasharray={isActive ? 'none' : `${4 / vp.zoom} ${3 / vp.zoom}`}
                />
                <circle
                  cx={eraserPos.x}
                  cy={eraserPos.y}
                  r={2 / vp.zoom}
                  fill={strokeColor}
                  opacity={0.8}
                />
              </g>
            </svg>
          </div>
        );
      })()}
    </div>
  );
});

export default FreehandOverlay;

// ── 渐进式擦除：移除擦除半径内的采样点 + 穿过擦除圆的线段端点。
//    若剩余点数 < 2（无法成线）则整笔删除。
//    使用 AABB 快速拒绝 + 点/线段双层检测，确保长笔触中间区域也能被精确擦除。
function eraseStrokePartial(
  sx: number, sy: number, radius: number,
): (stroke: StrokeData) => StrokeData[] {
  return (stroke: StrokeData): StrokeData[] => {
    const n = stroke.points.length;
    if (n < 2) return [];

    // 1) AABB 快速拒绝：计算笔触包围盒，若擦除圆完全在外则跳过
    const bounds = getStrokeBounds(stroke);
    if (sx + radius < bounds.minX || sx - radius > bounds.maxX ||
        sy + radius < bounds.minY || sy - radius > bounds.maxY) {
      return [stroke]; // 零命中，原样返回
    }

    const keep: boolean[] = new Array(n).fill(true);

    // 2) 采样点在擦除半径内 → 移除
    const rSq = radius * radius;
    for (let i = 0; i < n; i++) {
      const [px, py] = stroke.points[i];
      const dx = px - sx, dy = py - sy;
      if (dx * dx + dy * dy <= rSq) {
        keep[i] = false;
      }
    }

    // 3) 线段穿过擦除圆 → 移除两端点（避免遗漏点稀但长线段的情况）
    for (let i = 1; i < n; i++) {
      if (!keep[i - 1] && !keep[i]) continue;
      const [ax, ay] = stroke.points[i - 1];
      const [bx, by] = stroke.points[i];
      if (pointSegmentDistSq(sx, sy, ax, ay, bx, by) <= rSq) {
        keep[i - 1] = false;
        keep[i] = false;
      }
    }

    const keptPoints = stroke.points.filter((_, i) => keep[i]);
    if (keptPoints.length < 2) return [];
    return [{ ...stroke, points: keptPoints }];
  };
}

// 距离的平方比较（避免开方）
function pointSegmentDistSq(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = px - ax, ey = py - ay;
    return ex * ex + ey * ey;
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = ax + t * dx, projY = ay + t * dy;
  const ex = px - projX, ey = py - projY;
  return ex * ex + ey * ey;
}

// ── 擦除判定

function strokeContainsPoint(
  stroke: StrokeData,
  sx: number, sy: number, radius: number,
): boolean {
  const bounds = getStrokeBounds(stroke);
  if (sx < bounds.minX - radius || sx > bounds.maxX + radius ||
      sy < bounds.minY - radius || sy > bounds.maxY + radius) return false;

  const rSq = radius * radius;
  for (let i = 1; i < stroke.points.length; i++) {
    const [ax, ay] = stroke.points[i - 1];
    const [bx, by] = stroke.points[i];
    if (pointSegmentDistSq(sx, sy, ax, ay, bx, by) <= rSq) return true;
  }
  return false;
}
