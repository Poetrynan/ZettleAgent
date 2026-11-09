import { describe, expect, it } from 'vitest';
import { nearestSide, placeAgainst, sideFacing } from '../canvasGeometry';
import { alignAxis, gapAxis } from '../useHelperLines';

const box = (x: number, y: number, w = 100, h = 60) => ({ x, y, w, h });

describe('sideFacing', () => {
  it('picks left/right for cards side by side, top/bottom for stacked cards', () => {
    expect(sideFacing(box(0, 0), box(300, 10))).toBe('right');
    expect(sideFacing(box(300, 10), box(0, 0))).toBe('left');
    expect(sideFacing(box(0, 0), box(10, 300))).toBe('bottom');
    expect(sideFacing(box(10, 300), box(0, 0))).toBe('top');
  });

  it('wide cards next to each other still join on their sides', () => {
    expect(sideFacing(box(0, 0, 400, 300), box(450, 120, 400, 300))).toBe('right');
  });
});

describe('nearestSide', () => {
  it('uses the axis the point is outside on', () => {
    expect(nearestSide(box(0, 0, 100, 400), { x: 500, y: 10 })).toBe('right');
    expect(nearestSide(box(0, 0, 100, 60), { x: 50, y: -40 })).toBe('top');
  });
  it('inside the box, the closest edge wins', () => {
    expect(nearestSide(box(0, 0, 100, 100), { x: 95, y: 50 })).toBe('right');
  });
});

describe('placeAgainst', () => {
  it('puts the facing side of the new card on the drop point', () => {
    expect(placeAgainst({ x: 500, y: 200 }, 250, 100, 'right')).toEqual({ x: 500, y: 150 });
    expect(placeAgainst({ x: 500, y: 200 }, 250, 100, 'left')).toEqual({ x: 250, y: 150 });
    expect(placeAgainst({ x: 500, y: 200 }, 250, 100, 'bottom')).toEqual({ x: 375, y: 200 });
    expect(placeAgainst({ x: 500, y: 200 }, 250, 100)).toEqual({ x: 375, y: 150 });
  });
});

describe('alignAxis', () => {
  it('snaps to the nearest edge, not the first one found', () => {
    const sel = box(103, 200);
    // left edges at 100 (3 away) and 104 (1 away)
    const snap = alignAxis(sel, [box(100, 0), box(104, 400)], 'x', 8);
    expect(snap?.delta).toBe(1);
  });

  it('does nothing beyond the threshold', () => {
    expect(alignAxis(box(120, 200), [box(100, 0)], 'x', 8)).toBeNull();
  });

  it('draws one guide spanning every card on the same line', () => {
    const snap = alignAxis(box(101, 200), [box(100, 0), box(100, 500)], 'x', 8)!;
    const left = snap.lines.find(l => l.coordinate === 100)!;
    expect(left.min).toBe(0);
    expect(left.max).toBe(560);
  });
});

describe('gapAxis', () => {
  it('repeats the gap of the two cards before it in a row', () => {
    // a: 0..100, b: 140..240 → gap 40; dragged card near 280 should land at 280
    const snap = gapAxis(box(284, 0), [box(0, 0), box(140, 0)], 'x', 8);
    expect(snap?.delta).toBe(-4);
    expect(snap?.lines).toHaveLength(2);
    expect(snap?.lines.every(l => l.kind === 'gap')).toBe(true);
  });

  it('centres a card between two neighbours', () => {
    // a: 0..100, b: 400..500, card w=100 → centred at x=200 (gaps of 100 each side)
    const snap = gapAxis(box(204, 0), [box(0, 0), box(400, 0)], 'x', 8);
    expect(snap?.delta).toBe(-4);
  });

  it('ignores cards that are not in the same row', () => {
    expect(gapAxis(box(284, 500), [box(0, 0), box(140, 0)], 'x', 8)).toBeNull();
  });
});
