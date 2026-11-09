import { useState, useCallback, useRef } from 'react';
import { Node, NodeChange } from '@xyflow/react';

/**
 * Object snapping while dragging cards, modelled on tldraw / Figma:
 *
 * - The threshold is in screen pixels (the caller passes px / zoom), so the
 *   pull feels the same at every zoom level instead of vanishing when zoomed out.
 * - The whole selection snaps as one box and every dragged card moves by the
 *   same delta, so a multi-card drag never pulls the cards out of formation.
 * - Edges and centres snap to the nearest match, not the first one found.
 * - Equal spacing: a card dropped next to a row/column picks up the gap the
 *   neighbours already use (tldraw's "gap snapping").
 * - Everything is in absolute flow coordinates, so cards inside groups line up
 *   with cards outside them.
 *
 * Lines are only re-set when they actually change, so a drag that isn't near
 * anything doesn't re-render the canvas on every frame.
 */

export interface HelperLine {
  id: string;
  /** 'vertical' = an x-coordinate line; 'horizontal' = a y-coordinate line. */
  type: 'vertical' | 'horizontal';
  coordinate: number;
  min: number;
  max: number;
  /** 'align' guide, or one of the equal 'gap' segments. */
  kind?: 'align' | 'gap';
}

export interface Box { x: number; y: number; w: number; h: number }

const DEFAULT_DIMENSIONS: Record<string, { width: number; height: number }> = {
  file: { width: 300, height: 200 },
  text: { width: 220, height: 180 },
  group: { width: 600, height: 400 },
  image: { width: 300, height: 300 },
  pdf: { width: 400, height: 500 },
  web: { width: 500, height: 400 },
};

function dims(node: Node): { w: number; h: number } {
  return {
    w: node.measured?.width || node.width || (node.style?.width as number) || DEFAULT_DIMENSIONS[node.type || '']?.width || 300,
    h: node.measured?.height || node.height || (node.style?.height as number) || DEFAULT_DIMENSIONS[node.type || '']?.height || 200,
  };
}

/** Absolute position of every node (parents' offsets added). */
function absolutePositions(nodes: Node[]): Map<string, { x: number; y: number }> {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const out = new Map<string, { x: number; y: number }>();
  const resolve = (n: Node, depth = 0): { x: number; y: number } => {
    const hit = out.get(n.id);
    if (hit) return hit;
    const parent = n.parentId ? byId.get(n.parentId) : undefined;
    const base = parent && depth < 16 ? resolve(parent, depth + 1) : { x: 0, y: 0 };
    const p = { x: base.x + n.position.x, y: base.y + n.position.y };
    out.set(n.id, p);
    return p;
  };
  for (const n of nodes) resolve(n);
  return out;
}

const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;

interface AxisSnap { delta: number; lines: HelperLine[] }

/** Best alignment snap on one axis: edges and centres of the selection to those of others. */
export function alignAxis(sel: Box, others: Box[], axis: 'x' | 'y', threshold: number): AxisSnap | null {
  const pts = (b: Box) => axis === 'x' ? [b.x, b.x + b.w / 2, b.x + b.w] : [b.y, b.y + b.h / 2, b.y + b.h];
  const mine = pts(sel);
  let best = Infinity;
  for (const o of others) {
    for (const t of pts(o)) {
      for (const d of mine) {
        const diff = t - d;
        if (Math.abs(diff) <= threshold && Math.abs(diff) < Math.abs(best)) best = diff;
      }
    }
  }
  if (!isFinite(best)) return null;

  // Every guide that the snapped selection now lies on (several cards may share it).
  const snapped: Box = axis === 'x' ? { ...sel, x: sel.x + best } : { ...sel, y: sel.y + best };
  const mineAfter = pts(snapped);
  const lines = new Map<number, HelperLine>();
  for (const o of others) {
    for (const t of pts(o)) {
      if (!mineAfter.some(d => Math.abs(d - t) < 0.5)) continue;
      const key = Math.round(t * 2) / 2;
      const lo = axis === 'x' ? Math.min(snapped.y, o.y) : Math.min(snapped.x, o.x);
      const hi = axis === 'x' ? Math.max(snapped.y + snapped.h, o.y + o.h) : Math.max(snapped.x + snapped.w, o.x + o.w);
      const prev = lines.get(key);
      lines.set(key, {
        id: `${axis}-${key}`,
        type: axis === 'x' ? 'vertical' : 'horizontal',
        coordinate: t,
        min: prev ? Math.min(prev.min, lo) : lo,
        max: prev ? Math.max(prev.max, hi) : hi,
        kind: 'align',
      });
    }
  }
  return { delta: best, lines: [...lines.values()] };
}

/**
 * Equal-gap snap on one axis. Looks at the cards in the selection's row (x) or
 * column (y), and offers: repeat a neighbour pair's gap on either side, or sit
 * centred between two neighbours.
 */
export function gapAxis(sel: Box, others: Box[], axis: 'x' | 'y', threshold: number): AxisSnap | null {
  const lo = (b: Box) => (axis === 'x' ? b.x : b.y);
  const len = (b: Box) => (axis === 'x' ? b.w : b.h);
  const hi = (b: Box) => lo(b) + len(b);
  const crossLo = (b: Box) => (axis === 'x' ? b.y : b.x);
  const crossHi = (b: Box) => crossLo(b) + (axis === 'x' ? b.h : b.w);

  const row = others
    .filter(o => overlaps(crossLo(o), crossHi(o), crossLo(sel), crossHi(sel)))
    .filter(o => !overlaps(lo(o), hi(o), lo(sel), hi(sel)))
    .sort((a, b) => lo(a) - lo(b));
  if (row.length === 0) return null;

  type Cand = { delta: number; segs: [number, number, number][] }; // [from, to, cross]
  const cands: Cand[] = [];
  const cross = (a: Box, b: Box) => (Math.max(crossLo(a), crossLo(b)) + Math.min(crossHi(a), crossHi(b))) / 2;

  for (let i = 0; i + 1 < row.length; i++) {
    const a = row[i];
    const b = row[i + 1];
    const g = lo(b) - hi(a);
    if (g <= 0) continue;
    // Repeat after b:  b | g | sel
    if (lo(sel) >= hi(b)) {
      const target = hi(b) + g;
      cands.push({ delta: target - lo(sel), segs: [[hi(a), lo(b), cross(a, b)], [hi(b), target, cross(b, sel)]] });
    }
    // Repeat before a:  sel | g | a
    if (hi(sel) <= lo(a)) {
      const target = lo(a) - g - len(sel);
      cands.push({ delta: target - lo(sel), segs: [[target + len(sel), lo(a), cross(sel, a)], [hi(a), lo(b), cross(a, b)]] });
    }
  }
  // Centred between two neighbours: a | g | sel | g | b
  const left = [...row].reverse().find(o => hi(o) <= lo(sel) + threshold);
  const right = row.find(o => lo(o) >= hi(sel) - threshold);
  if (left && right && left !== right) {
    const space = lo(right) - hi(left) - len(sel);
    if (space > 0) {
      const target = hi(left) + space / 2;
      cands.push({
        delta: target - lo(sel),
        segs: [[hi(left), target, cross(left, sel)], [target + len(sel), lo(right), cross(sel, right)]],
      });
    }
  }

  let best: Cand | null = null;
  for (const c of cands) {
    if (Math.abs(c.delta) <= threshold && (!best || Math.abs(c.delta) < Math.abs(best.delta))) best = c;
  }
  if (!best) return null;
  return {
    delta: best.delta,
    lines: best.segs.map(([from, to, at], i) => ({
      id: `gap-${axis}-${i}`,
      // A gap along x is drawn as a horizontal segment at a y position.
      type: axis === 'x' ? 'horizontal' : 'vertical',
      coordinate: at,
      min: Math.min(from, to),
      max: Math.max(from, to),
      kind: 'gap',
    })),
  };
}

const linesKey = (ls: HelperLine[]) =>
  ls.map(l => `${l.id}:${Math.round(l.coordinate)}:${Math.round(l.min)}:${Math.round(l.max)}`).join('|');

export function useHelperLines() {
  const [helperLines, setHelperLines] = useState<HelperLine[]>([]);
  const lastKeyRef = useRef('');

  const publish = useCallback((lines: HelperLine[]) => {
    const key = linesKey(lines);
    if (key === lastKeyRef.current) return;
    lastKeyRef.current = key;
    setHelperLines(lines);
  }, []);

  /** Kept for callers; snapping state is rebuilt per frame from the nodes. */
  const onDragStart = useCallback((_nodeId: string) => {}, []);

  /**
   * Snap the dragged selection. `snapThreshold` is in flow units — pass
   * screenPx / zoom. `disabled` (e.g. while Ctrl/⌘ is held) lets the drag move freely.
   */
  const calculateHelperLines = useCallback((
    changes: NodeChange[],
    allNodes: Node[],
    snapThreshold = 6,
    disabled = false,
  ): { snappedChanges: NodeChange[]; activeLines: HelperLine[] } => {
    const moving = changes.filter(
      (c): c is NodeChange & { type: 'position'; id: string; position: { x: number; y: number } } =>
        c.type === 'position' && !!(c as any).position && (c as any).dragging === true,
    );
    if (moving.length === 0 || disabled) {
      publish([]);
      return { snappedChanges: changes, activeLines: [] };
    }

    const byId = new Map(allNodes.map(n => [n.id, n]));
    const abs = absolutePositions(allNodes);
    const movingIds = new Set(moving.map(c => c.id));

    // Selection box at the proposed positions, in absolute coordinates.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const parentsOfMoving = new Set<string>();
    for (const c of moving) {
      const n = byId.get(c.id);
      if (!n) continue;
      const pAbs = n.parentId ? abs.get(n.parentId) ?? { x: 0, y: 0 } : { x: 0, y: 0 };
      if (n.parentId) parentsOfMoving.add(n.parentId);
      const { w, h } = dims(n);
      const ax = pAbs.x + c.position.x;
      const ay = pAbs.y + c.position.y;
      x0 = Math.min(x0, ax); y0 = Math.min(y0, ay);
      x1 = Math.max(x1, ax + w); y1 = Math.max(y1, ay + h);
    }
    if (!isFinite(x0)) {
      publish([]);
      return { snappedChanges: changes, activeLines: [] };
    }
    const sel: Box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };

    // Children of a dragged group move with it, so they're not targets either.
    const isMovingOrInside = (n: Node): boolean => {
      let cur: Node | undefined = n;
      for (let i = 0; cur && i < 16; i++) {
        if (movingIds.has(cur.id)) return true;
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      return false;
    };

    const others: Box[] = [];
    const margin = Math.max(sel.w, sel.h) * 3 + 1200;
    for (const n of allNodes) {
      if (n.hidden || isMovingOrInside(n) || parentsOfMoving.has(n.id)) continue;
      const p = abs.get(n.id)!;
      const { w, h } = dims(n);
      // Far-away cards can't be on screen next to the selection; skip them.
      if (p.x > sel.x + sel.w + margin || p.x + w < sel.x - margin || p.y > sel.y + sel.h + margin || p.y + h < sel.y - margin) continue;
      others.push({ x: p.x, y: p.y, w, h });
    }

    const pick = (a: AxisSnap | null, g: AxisSnap | null) =>
      a && g ? (Math.abs(g.delta) < Math.abs(a.delta) - 0.01 ? g : a) : a || g;
    const sx = pick(alignAxis(sel, others, 'x', snapThreshold), gapAxis(sel, others, 'x', snapThreshold));
    const sy = pick(alignAxis(sel, others, 'y', snapThreshold), gapAxis(sel, others, 'y', snapThreshold));
    const dx = sx?.delta ?? 0;
    const dy = sy?.delta ?? 0;

    // Guides were measured against the selection moved on one axis only; shift
    // their extents by the other axis' delta so they meet the final position.
    const stretch = (l: HelperLine, d: number) => (l.kind === 'gap' ? l : { ...l, min: l.min + Math.min(0, d), max: l.max + Math.max(0, d) });
    const lines: HelperLine[] = [
      ...(sx?.lines ?? []).map(l => stretch(l, dy)),
      ...(sy?.lines ?? []).map(l => stretch(l, dx)),
    ];

    const snappedChanges = (dx === 0 && dy === 0) ? changes : changes.map(c => {
      if (c.type !== 'position' || !movingIds.has(c.id) || !(c as any).position) return c;
      const p = (c as any).position as { x: number; y: number };
      return { ...c, position: { x: p.x + dx, y: p.y + dy } } as NodeChange;
    });

    publish(lines);
    return { snappedChanges, activeLines: lines };
  }, [publish]);

  const clearHelperLines = useCallback(() => publish([]), [publish]);

  return {
    helperLines,
    calculateHelperLines,
    clearHelperLines,
    onDragStart,
  };
}
