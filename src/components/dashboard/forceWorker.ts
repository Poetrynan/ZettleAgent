/**
 * ForceWorker:WebWorker 中运行 d3-force 物理仿真。
 * 主线程负责渲染,Worker 负责 Barnes-Hut n-body 力计算,
 * 通过 Transferable Float32Array 高效回传位置数据,避免主线程阻塞。
 */

import { forceSimulation, forceLink, forceManyBody, forceCenter } from 'd3-force';

let ctx: any = null;

interface WorkerParams {
  centerStrength: number;
  chargeStrength: number;
  linkStrength: number;
  linkDistance: number;
}

const ALPHA_DECAY = 0.015;
const VELOCITY_DECAY = 0.2;   // 对齐 vis-network damping=0.2,阻尼更低→更"水上漂浮"感
// 物理漂浮:小图(<FLOATING_PHYSICS_THRESHOLD)用 alphaTarget>0 让仿真永不停,
// 节点在残余力下自然漂移(vis-network 风格);
// 大图用 0 + 主线程 sin/cos(高性能)。
let floatingAlpha = 0;
const FLOATING_PHYSICS_THRESHOLD = 500;  // ≤500 节点启用物理漂浮
const CHARGE_DISTANCE_MAX = 600;

// 节点数据(只在 worker 内部)
let nodes: any[] = [];
let nodeIdx: Map<string, number> = new Map();
// 回传位置缓冲
let posBuf: Float32Array | null = null;
// links 原始 + d3-force 期望格式
let links: any[] = [];

// bbox boundary
let bbox = { minX: -Infinity, maxX: Infinity, minY: -Infinity, maxY: Infinity };
let bboxEnabled = true;

// 力参数
let params: WorkerParams = {
  centerStrength: 0.03,
  chargeStrength: -500,
  linkStrength: 0.06,
  linkDistance: 200,
};

// 力初始化(每次 init 调用 forceSimulation)
function initSim(nds: any[], lks: any[], fp: WorkerParams) {
  params = fp;
  nodes = nds.map((n, i) => {
    const idx = i;
    nodeIdx.set(n.id, idx);
    return {
      id: n.id,
      index: idx,
      x: n.x ?? (Math.random() * 800 - 400),
      y: n.y ?? (Math.random() * 600 - 300),
      vx: 0,
      vy: 0,
      fx: undefined as (number | undefined),
      fy: undefined as (number | undefined),
      is_hub: n.is_hub,
      is_orphan: n.is_orphan,
    };
  });
  links = lks.map(l => ({
    source: typeof l.source === 'string' ? l.source : l.source.id,
    target: typeof l.target === 'string' ? l.target : l.target.id,
    edge_type: l.edge_type,
    weight: l.weight,
    label: l.label,
  }));
  posBuf = new Float32Array(nodes.length * 2);
  rebuildSim();
  (ctx as any).postMessage({ type: 'ready' });
}

let sim: any = null;
function rebuildSim() {
  if (sim) sim.stop();   // 停止旧仿真定时器,避免泄漏
  sim = forceSimulation(nodes)
    .force('charge', forceManyBody().strength(params.chargeStrength).distanceMax(CHARGE_DISTANCE_MAX).theta(1.2))
    .force('link', forceLink(links).id((d: any) => d.id)
      .distance((l: any) => (l.edge_type === 'semantic' ? params.linkDistance * 1.5 : params.linkDistance))
      .strength((l: any) => (l.edge_type === 'semantic' ? params.linkStrength * 0.05 : params.linkStrength)))
    .force('center', forceCenter(0, 0).strength(params.centerStrength))
    .alphaDecay(ALPHA_DECAY)
    .velocityDecay(VELOCITY_DECAY)
    .alpha(1)
    .alphaTarget(floatingAlpha);

  // 自定义 bbox 力
  sim.force('bbox', () => {
    if (!bboxEnabled) return;
    const margin = 80;
    const strength = 0.02;
    for (const n of nodes) {
      if (n.fx !== undefined || n.fy !== undefined) continue;
      if (!isFinite(bbox.minX)) continue;
      if (n.x < bbox.minX + margin) n.vx += (bbox.minX + margin - n.x) * strength;
      else if (n.x > bbox.maxX - margin) n.vx += (bbox.maxX - margin - n.x) * strength;
      if (n.y < bbox.minY + margin) n.vy += (bbox.minY + margin - n.y) * strength;
      else if (n.y > bbox.maxY - margin) n.vy += (bbox.maxY - margin - n.y) * strength;
    }
  });

  sim.on('tick', sendPositions);
}

// 位置回传节流:d3-force 默认 ~230 tick/s,但主线程渲染只有 60fps。
// 若每次 tick 都 postMessage,~3/4 的 Transferable 传输 + Float32Array 分配是纯浪费,
// 且 230/s 的 postMessage 风暴对中小图反而比主线程跑 d3 更慢。
// 限制到 ~60/s,与渲染帧率对齐。
let lastSendTs = 0;
const SEND_INTERVAL_MS = 16;   // ≈60fps 上限

function sendPositions() {
  const now = Date.now();
  if (now - lastSendTs < SEND_INTERVAL_MS) return;   // 帧间丢弃,避免风暴
  lastSendTs = now;
  if (!posBuf || posBuf.length !== nodes.length * 2) {
    posBuf = new Float32Array(nodes.length * 2);
  }
  for (let i = 0; i < nodes.length; i++) {
    posBuf[i * 2] = nodes[i].x;
    posBuf[i * 2 + 1] = nodes[i].y;
  }
  // structured clone:worker 端复用 posBuf,消除每帧 new Float32Array 分配。
  // 主线程收到数据的拷贝(memcpy ~0.01ms for 10k nodes),
  // 但省去 60 次/s 的堆分配 + GC 压力,万级节点下帧时间更稳定。
  (ctx as any).postMessage({ type: 'positions', buffer: posBuf });
}

self.onmessage = (e: MessageEvent) => {
  ctx = self;
  const d = e.data;
  switch (d.type) {
    case 'init': {
      initSim(d.nodes, d.links, d.params);
      break;
    }
    case 'params': {
      params = d.params;
      if (sim) {
        sim.force('charge')?.strength(params.chargeStrength);
        sim.force('center')?.strength(params.centerStrength);
        const lf = sim.force('link');
        if (lf) {
          lf.distance((l: any) => (l.edge_type === 'semantic' ? params.linkDistance * 1.5 : params.linkDistance));
          lf.strength((l: any) => (l.edge_type === 'semantic' ? params.linkStrength * 0.05 : params.linkStrength));
        }
        sim.alpha(0.3).restart();
      }
      break;
    }
    case 'pin': {
      const i = nodeIdx.get(d.id);
      if (i !== undefined) {
        nodes[i].fx = d.x;
        nodes[i].fy = d.y;
        if (sim) sim.alphaTarget(0.3).alpha(0.3).restart();
      }
      break;
    }
    case 'unpin': {
      const i = nodeIdx.get(d.id);
      if (i !== undefined) {
        nodes[i].fx = undefined;
        nodes[i].fy = undefined;
        nodes[i].vx = 0;
        nodes[i].vy = 0;
        if (sim) {
          sim.alphaTarget(floatingAlpha);
          sim.alpha(0.2).restart();
        }
      }
      break;
    }
    case 'reheat': {
      if (sim) sim.alpha(d.alpha ?? 0.3).restart();
      break;
    }
    case 'bounds': {
      bbox = { minX: d.minX, maxX: d.maxX, minY: d.minY, maxY: d.maxY };
      break;
    }
    case 'bboxEnabled': {
      bboxEnabled = d.enabled;
      break;
    }
    case 'dragMove': {
      // 拖拽中持续更新 fx/fy
      const i = nodeIdx.get(d.id);
      if (i !== undefined) {
        nodes[i].fx = d.x;
        nodes[i].fy = d.y;
        nodes[i].x = d.x;
        nodes[i].y = d.y;
      }
      break;
    }
    case 'floatingMode': {
      // 主线程根据节点数决定:小图用物理漂浮(alphaTarget>0),大图用 sin/cos
      floatingAlpha = d.alpha;
      if (sim) sim.alphaTarget(floatingAlpha);
      break;
    }
    case 'stop': {
      if (sim) sim.stop();
      break;
    }
  }
};

export {};
