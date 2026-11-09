/**
 * Small geometry helpers for connecting and placing cards.
 *
 * Every card has four connection points with the ids Obsidian's .canvas format
 * uses for `fromSide` / `toSide`: top, right, bottom, left.
 */

export type Side = 'top' | 'right' | 'bottom' | 'left';

export const OPPOSITE_SIDE: Record<Side, Side> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};

export interface Box { x: number; y: number; w: number; h: number }
export interface Pt { x: number; y: number }

export function isSide(v: unknown): v is Side {
  return v === 'top' || v === 'right' || v === 'bottom' || v === 'left';
}

/** The side of `box` closest to `p` (a point inside or outside the box). */
export function nearestSide(box: Box, p: Pt): Side {
  const d: [Side, number][] = [
    ['left', Math.abs(p.x - box.x)],
    ['right', Math.abs(box.x + box.w - p.x)],
    ['top', Math.abs(p.y - box.y)],
    ['bottom', Math.abs(box.y + box.h - p.y)],
  ];
  // Outside the box on one axis: that axis decides, so a point far to the
  // right of a tall card still picks "right" and not a nearby corner side.
  const outX = p.x < box.x || p.x > box.x + box.w;
  const outY = p.y < box.y || p.y > box.y + box.h;
  const pool = outX && !outY ? d.filter(([s]) => s === 'left' || s === 'right')
    : outY && !outX ? d.filter(([s]) => s === 'top' || s === 'bottom')
    : d;
  return pool.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
}

/** The side of `box` that faces `other` (centre to centre, by the dominant axis). */
export function sideFacing(box: Box, other: Box): Side {
  const dx = other.x + other.w / 2 - (box.x + box.w / 2);
  const dy = other.y + other.h / 2 - (box.y + box.h / 2);
  // Normalise by size so wide cards side-by-side still connect left/right.
  const nx = dx / Math.max(1, (box.w + other.w) / 2);
  const ny = dy / Math.max(1, (box.h + other.h) / 2);
  if (Math.abs(nx) >= Math.abs(ny)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

/**
 * Top-left for a new w×h card at `at`. Coming off a line that left its card on
 * `fromSide`, the new card's facing side sits on the drop point (the way
 * Obsidian drops a new card at the end of a line); otherwise it is centred.
 */
export function placeAgainst(at: Pt, w: number, h: number, fromSide?: Side): Pt {
  const r = (v: number) => Math.round(v);
  switch (fromSide) {
    case 'right': return { x: r(at.x), y: r(at.y - h / 2) };
    case 'left': return { x: r(at.x - w), y: r(at.y - h / 2) };
    case 'bottom': return { x: r(at.x - w / 2), y: r(at.y) };
    case 'top': return { x: r(at.x - w / 2), y: r(at.y - h) };
    default: return { x: r(at.x - w / 2), y: r(at.y - h / 2) };
  }
}

/** Where the next "add note" pick goes. Points are in flow coordinates. */
export type AddNoteTarget =
  | { kind: 'at'; at: Pt }
  | { kind: 'connect'; at: Pt; sourceNodeId: string; fromSide: Side };
