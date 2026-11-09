/**
 * forceWorker protocol: the 2D graph is driven one tick per `step`, comes to
 * rest (and says so), follows a dragged node exactly and cools down again;
 * the 3D view keeps its free-running mode.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Msg = { type: string; buffer?: Float32Array; settled?: boolean; gen?: number };

let sent: Msg[] = [];
let fakeSelf: { postMessage: (m: Msg) => void; onmessage: ((e: { data: unknown }) => void) | null };

async function loadWorker() {
  vi.resetModules();
  sent = [];
  fakeSelf = { postMessage: (m: Msg) => { sent.push(m); }, onmessage: null };
  vi.stubGlobal('self', fakeSelf);
  await import('../forceWorker');
  return (data: unknown) => fakeSelf.onmessage!({ data });
}

const params = { centerStrength: 0.05, chargeStrength: -500, linkStrength: 0.2, linkDistance: 200 };
const graph = {
  nodes: ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, r: 8 })),
  links: [
    { source: 'a', target: 'b', edge_type: 'link', weight: 1 },
    { source: 'a', target: 'c', edge_type: 'link', weight: 1 },
    { source: 'c', target: 'd', edge_type: 'link', weight: 1 },
  ],
};

/** Step until the worker reports settled; returns how many steps it took. */
function runToRest(send: (d: unknown) => void, max = 2000, gen = 1): number {
  for (let i = 1; i <= max; i++) {
    send({ type: 'step', gen });
    if (sent[sent.length - 1].settled) return i;
  }
  return Infinity;
}

describe('forceWorker (stepped 2D mode)', () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('sends a warmed-up 2D layout right after init', async () => {
    const send = await loadWorker();
    send({ type: 'init', dims: 2, stepped: true, warm: false, params, ...graph });
    const first = sent[0];
    expect(first.type).toBe('positions');
    expect(first.buffer).toHaveLength(graph.nodes.length * 2);
    expect(Array.from(first.buffer!).every(Number.isFinite)).toBe(true);
    expect(first.gen).toBeUndefined();
  });

  it('comes to rest and then stops ticking', async () => {
    const send = await loadWorker();
    send({ type: 'init', dims: 2, stepped: true, warm: false, params, ...graph });
    const steps = runToRest(send);
    expect(steps).toBeLessThan(400);

    const before = Array.from(sent[sent.length - 1].buffer!);
    send({ type: 'step', gen: 1 });
    const after = sent[sent.length - 1];
    expect(after.settled).toBe(true);
    expect(Array.from(after.buffer!)).toEqual(before); // no tick once settled
  });

  it('keeps the dragged node exactly under the pointer, then cools down after release', async () => {
    const send = await loadWorker();
    send({ type: 'init', dims: 2, stepped: true, warm: false, params, ...graph });
    runToRest(send);

    send({ type: 'pin', id: 'a', x: 0, y: 0 });
    for (let i = 0; i < 30; i++) {
      send({ type: 'step', gen: 2, drag: { id: 'a', x: 300 + i, y: -120 } });
      const buf = sent[sent.length - 1].buffer!;
      expect(buf[0]).toBe(300 + i); // node 'a' is index 0
      expect(buf[1]).toBe(-120);
      expect(sent[sent.length - 1].settled).toBe(false); // warm while dragging
    }

    send({ type: 'unpin', id: 'a' });
    expect(runToRest(send, 2000, 3)).toBeLessThan(600);
  });

  it('a double-click pin (pin + release) does not keep the graph hot forever', async () => {
    const send = await loadWorker();
    send({ type: 'init', dims: 2, stepped: true, warm: false, params, ...graph });
    runToRest(send);
    send({ type: 'pin', id: 'b', x: 50, y: 50 });
    send({ type: 'release' });
    send({ type: 'reheat', alpha: 0.1 });
    expect(runToRest(send, 2000, 4)).toBeLessThan(600);
  });

  it('reuses the buffer handed back with a step', async () => {
    const send = await loadWorker();
    send({ type: 'init', dims: 2, stepped: true, warm: false, params, ...graph });
    const buf = new Float32Array(graph.nodes.length * 2);
    send({ type: 'step', gen: 1, buffer: buf });
    expect(sent[sent.length - 1].buffer).toBe(buf);
  });
});

describe('forceWorker (free 3D mode, used by the 3D view)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('ticks on its own and posts 3D positions', async () => {
    const send = await loadWorker();
    send({ type: 'init', params, warm: false, ...graph });
    send({ type: 'reheat', alpha: 0.3 });
    await new Promise(r => setTimeout(r, 120));
    send({ type: 'stop' }); // d3's own timer would otherwise outlive the test
    const positions = sent.filter(m => m.type === 'positions');
    expect(positions.length).toBeGreaterThan(0);
    expect(positions[positions.length - 1].buffer).toHaveLength(graph.nodes.length * 3);
  });
});
