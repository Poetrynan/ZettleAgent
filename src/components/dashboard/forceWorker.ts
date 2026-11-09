/**
 * ForceWorker: d3-force-3d simulation off the main thread.
 *
 * Two driving modes:
 *  - 'free'    (default, used by the 3D view): d3's own timer ticks the
 *              simulation and positions are posted as they change.
 *  - 'stepped' (used by the 2D Pixi view): the main thread sends one `step`
 *              per display frame and gets exactly one tick back, so physics
 *              and rendering never drift apart (no repeated / skipped frames).
 *              The step also carries the dragged node's position, and the
 *              reply says when the layout has settled so the main thread can
 *              stop asking — a resting graph costs nothing.
 *
 * Physics follows the Obsidian / d3 feel: the graph cools down and comes to
 * rest; dragging warms it (alphaTarget 0.3) so neighbours follow on springs,
 * and releasing lets it cool again.
 */

import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from 'd3-force-3d';

interface WorkerParams {
  centerStrength: number;
  chargeStrength: number;
  linkStrength: number;
  linkDistance: number;
}

const ALPHA_DECAY = 0.0228;   // d3 default: ~300 ticks from hot to rest
const VELOCITY_DECAY = 0.4;   // d3 default: damped, no endless wobble
const DRAG_ALPHA_TARGET = 0.3;
const CHARGE_DISTANCE_MAX = 600;
const CHARGE_THETA = 0.9;
/** The UI's default link slider value; it maps to d3's default link strength. */
const LINK_STRENGTH_BASELINE = 0.2;
/** Cold start: pre-run the layout before the first frame for at most this long. */
const WARMUP_BUDGET_MS = 160;
const WARMUP_ALPHA = 0.12;

let nodes: any[] = [];
let nodeIdx: Map<string, number> = new Map();
let links: any[] = [];
let degree: Map<string, number> = new Map();
let dims = 3;
let stepped = false;
let sim: any = null;

let params: WorkerParams = {
  centerStrength: 0.05,
  chargeStrength: -500,
  linkStrength: LINK_STRENGTH_BASELINE,
  linkDistance: 200,
};

const post = (msg: any, transfer?: Transferable[]) =>
  (self as unknown as { postMessage: (m: any, t?: Transferable[]) => void }).postMessage(msg, transfer);

// ── Init: keep positions of nodes we already know, spawn new ones next to a neighbour ──
function initSim(nds: any[], lks: any[], fp: WorkerParams, warm: boolean) {
  params = fp;

  const history = new Map<string, { x: number; y: number; z: number; vx: number; vy: number; vz: number }>();
  for (const n of nodes) {
    if (n.x !== undefined && n.y !== undefined) {
      history.set(n.id, { x: n.x, y: n.y, z: n.z ?? 0, vx: n.vx ?? 0, vy: n.vy ?? 0, vz: n.vz ?? 0 });
    }
  }

  const neighbours = new Map<string, string[]>();
  degree = new Map();
  for (const l of lks) {
    const s = typeof l.source === 'string' ? l.source : l.source.id;
    const t = typeof l.target === 'string' ? l.target : l.target.id;
    if (!neighbours.has(s)) neighbours.set(s, []);
    if (!neighbours.has(t)) neighbours.set(t, []);
    neighbours.get(s)!.push(t);
    neighbours.get(t)!.push(s);
    degree.set(s, (degree.get(s) ?? 0) + 1);
    degree.set(t, (degree.get(t) ?? 0) + 1);
  }

  // Centroid of the previous layout: where unconnected newcomers appear.
  let cx = 0, cy = 0, cz = 0;
  if (history.size > 0) {
    history.forEach(p => { cx += p.x; cy += p.y; cz += p.z; });
    cx /= history.size; cy /= history.size; cz /= history.size;
  }

  nodeIdx.clear();
  nodes = nds.map((n, i) => {
    nodeIdx.set(n.id, i);
    const base = { id: n.id, index: i, r: n.r ?? 8, fx: n.fx, fy: n.fy, fz: dims === 3 ? n.fz : undefined };
    const hist = history.get(n.id);
    if (hist) {
      return { ...base, x: hist.x, y: hist.y, z: hist.z, vx: hist.vx * 0.5, vy: hist.vy * 0.5, vz: hist.vz * 0.5 };
    }
    // Use the caller's position (e.g. restored layout) when given.
    if (typeof n.x === 'number' && typeof n.y === 'number' && isFinite(n.x) && isFinite(n.y)) {
      return { ...base, x: n.x, y: n.y, z: 0, vx: 0, vy: 0, vz: 0 };
    }
    let sx = cx, sy = cy, sz = cz;
    let anchored = false;
    for (const nb of neighbours.get(n.id) ?? []) {
      const h = history.get(nb);
      if (h) { sx = h.x; sy = h.y; sz = h.z; anchored = true; break; }
    }
    if (!anchored && history.size === 0) {
      // Cold start: d3's phyllotaxis-like spread is decided by the simulation itself.
      return { ...base, vx: 0, vy: 0, vz: 0 };
    }
    // Small jitter so two points never coincide (avoids infinite repulsion).
    return {
      ...base,
      x: sx + (Math.random() * 8 - 4),
      y: sy + (Math.random() * 8 - 4),
      z: dims === 3 ? sz + (Math.random() * 8 - 4) : 0,
      vx: 0, vy: 0, vz: 0,
    };
  });

  links = lks.map(l => ({
    source: typeof l.source === 'string' ? l.source : l.source.id,
    target: typeof l.target === 'string' ? l.target : l.target.id,
    edge_type: l.edge_type,
    weight: l.weight,
    label: l.label,
  }));

  rebuildSim(warm);
}

/** d3's default link strength (1 / min degree) scaled by the UI slider, so hubs are not dragged into a knot. */
function linkStrength(l: any): number {
  const s = typeof l.source === 'object' ? l.source.id : l.source;
  const t = typeof l.target === 'object' ? l.target.id : l.target;
  const k = params.linkStrength / LINK_STRENGTH_BASELINE;
  const base = k / Math.max(1, Math.min(degree.get(s) ?? 1, degree.get(t) ?? 1));
  return l.edge_type === 'semantic' ? base * 0.05 : base;
}

function linkDistance(l: any): number {
  return l.edge_type === 'semantic' ? params.linkDistance * 1.5 : params.linkDistance;
}

function rebuildSim(warm: boolean) {
  if (sim) sim.stop();
  sim = forceSimulation(nodes, dims)
    .force('charge', forceManyBody().strength(params.chargeStrength).distanceMax(CHARGE_DISTANCE_MAX).theta(CHARGE_THETA))
    .force('link', forceLink(links).id((d: any) => d.id).distance(linkDistance).strength(linkStrength))
    .force('center', forceCenter(0, 0, 0).strength(params.centerStrength))
    .force('collide', forceCollide((d: any) => (d.r ?? 8) + 4).strength(0.7).iterations(1))
    .alphaDecay(ALPHA_DECAY)
    .velocityDecay(VELOCITY_DECAY)
    .alpha(warm ? 0.15 : 1)
    .alphaTarget(0);

  if (stepped) {
    sim.stop(); // the main thread drives ticks
    if (!warm) {
      // Settle the rough shape before the first frame so the graph does not "explode" on open.
      const t0 = performance.now();
      while (sim.alpha() > WARMUP_ALPHA && performance.now() - t0 < WARMUP_BUDGET_MS) sim.tick();
    }
    sendPositions(null, false);
  } else {
    sim.on('tick', () => sendPositions(null, false));
  }
}

function isSettled(): boolean {
  return !sim || (sim.alphaTarget() === 0 && sim.alpha() < sim.alphaMin());
}

let lastFreeSend = 0;
let freeBuf: Float32Array | null = null;

/** Positions as [x0, y0, (z0,) x1, y1, ...]. Stepped mode reuses the main thread's buffer and transfers it back. */
function sendPositions(reuse: Float32Array | null, settled: boolean, gen?: number) {
  const len = nodes.length * dims;
  if (stepped) {
    const buf = reuse && reuse.length === len ? reuse : new Float32Array(len);
    fill(buf);
    post({ type: 'positions', buffer: buf, settled, gen }, [buf.buffer]);
    return;
  }
  const now = performance.now();
  if (now - lastFreeSend < 16) return;
  lastFreeSend = now;
  if (!freeBuf || freeBuf.length !== len) freeBuf = new Float32Array(len);
  fill(freeBuf);
  post({ type: 'positions', buffer: freeBuf });
}

function fill(buf: Float32Array) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    buf[i * dims] = n.x;
    buf[i * dims + 1] = n.y;
    if (dims === 3) buf[i * dims + 2] = n.z ?? 0;
  }
}

/** Wake the simulation: free mode restarts d3's timer; stepped mode waits for the next `step`. */
function wake(alpha?: number) {
  if (!sim) return;
  if (alpha !== undefined) sim.alpha(Math.max(sim.alpha(), alpha));
  if (!stepped) sim.restart();
}

self.onmessage = (e: MessageEvent) => {
  const d = e.data;
  switch (d.type) {
    case 'init': {
      dims = d.dims === 2 ? 2 : 3;
      stepped = d.stepped === true;
      initSim(d.nodes, d.links, d.params, d.warm ?? false);
      break;
    }
    case 'step': {
      // One tick per display frame. The dragged node follows the pointer exactly.
      if (d.drag) {
        const i = nodeIdx.get(d.drag.id);
        if (i !== undefined) {
          const n = nodes[i];
          n.fx = n.x = d.drag.x;
          n.fy = n.y = d.drag.y;
        }
      }
      if (sim && !isSettled()) sim.tick();
      sendPositions(d.buffer ?? null, isSettled(), d.gen);
      break;
    }
    case 'params': {
      params = d.params;
      if (sim) {
        sim.force('charge')?.strength(params.chargeStrength);
        sim.force('center')?.strength(params.centerStrength);
        sim.force('link')?.distance(linkDistance).strength(linkStrength);
        wake(0.3);
      }
      break;
    }
    case 'pin': {
      const i = nodeIdx.get(d.id);
      if (i !== undefined && sim) {
        nodes[i].fx = d.x;
        nodes[i].fy = d.y;
        if (dims === 3) nodes[i].fz = d.z ?? 0;
        sim.alphaTarget(DRAG_ALPHA_TARGET);
        wake();
      }
      break;
    }
    case 'unpin': {
      const i = nodeIdx.get(d.id);
      if (i !== undefined && sim) {
        const n = nodes[i];
        n.fx = n.fy = n.fz = undefined;
        n.vx = n.vy = n.vz = 0;
        sim.alphaTarget(0);
        wake();
      }
      break;
    }
    case 'release': {
      // End of a drag on a node that should stay pinned (double-click pinned): just cool down.
      if (sim) { sim.alphaTarget(0); wake(); }
      break;
    }
    case 'reheat': {
      wake(d.alpha ?? 0.15);
      break;
    }
    case 'dragMove': {
      // Free mode (3D) drag; stepped mode sends the drag inside `step`.
      const i = nodeIdx.get(d.id);
      if (i !== undefined && nodes[i].fx !== undefined) {
        const n = nodes[i];
        n.fx = n.x = d.x;
        n.fy = n.y = d.y;
        if (d.z !== undefined && dims === 3) n.fz = n.z = d.z;
      }
      break;
    }
    case 'stop': {
      if (sim) sim.stop();
      break;
    }
  }
};

export {};
