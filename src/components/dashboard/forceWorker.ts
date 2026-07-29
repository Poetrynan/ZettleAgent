/**
 * ForceWorker: WebWorker 中运行 d3-force-3d 物理仿真。
 * 主线程负责渲染，Worker 负责 Barnes-Hut n-body 力三维计算，
 * 通过 Transferable Float32Array 高效回传三维位置数据，避免主线程阻塞。
 */

import { forceSimulation, forceLink, forceManyBody, forceCenter } from 'd3-force-3d';

let ctx: any = null;

interface WorkerParams {
  centerStrength: number;
  chargeStrength: number;
  linkStrength: number;
  linkDistance: number;
}

const ALPHA_DECAY = 0.015;
const VELOCITY_DECAY = 0.2;   // 对齐 vis-network damping=0.2
let floatingAlpha = 0;
const FLOATING_PHYSICS_THRESHOLD = 500;  // ≤500 节点启用物理漂浮
const CHARGE_DISTANCE_MAX = 600;

// 节点 data (只在 worker 内部)
let nodes: any[] = [];
let nodeIdx: Map<string, number> = new Map();
// 回传位置缓冲 (3D: [x0, y0, z0, x1, y1, z1, ...])
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

// ── 温启动继承位置与派生出生点仿真初始化 ──
function initSim(nds: any[], lks: any[], fp: WorkerParams, warm: boolean = false) {
  params = fp;

  // 1. 保存当前现有的节点位置和速度缓存
  const history = new Map<string, { x: number; y: number; z: number; vx: number; vy: number; vz: number }>();
  nodes.forEach(n => {
    if (n.x !== undefined && n.y !== undefined) {
      history.set(n.id, { x: n.x, y: n.y, z: n.z ?? 0, vx: n.vx ?? 0, vy: n.vy ?? 0, vz: n.vz ?? 0 });
    }
  });

  // 2. 映射当前连线，帮助新涌现节点从邻居锚点平滑长出
  const linkRelations = new Map<string, string[]>();
  lks.forEach(l => {
    const s = typeof l.source === 'string' ? l.source : l.source.id;
    const t = typeof l.target === 'string' ? l.target : l.target.id;
    if (!linkRelations.has(s)) linkRelations.set(s, []);
    if (!linkRelations.has(t)) linkRelations.set(t, []);
    linkRelations.get(s)?.push(t);
    linkRelations.get(t)?.push(s);
  });

  nodeIdx.clear();
  nodes = nds.map((n, i) => {
    const idx = i;
    nodeIdx.set(n.id, idx);
    
    // 优先：如果节点在历史中已计算过位置，直接继承
    const hist = history.get(n.id);
    if (hist) {
      return {
        id: n.id,
        index: idx,
        x: hist.x,
        y: hist.y,
        z: hist.z,
        vx: hist.vx * 0.6, // 速度打折继承，确保网络平稳过度
        vy: hist.vy * 0.6,
        vz: hist.vz * 0.6,
        fx: n.fx,
        fy: n.fy,
        fz: n.fz,
        is_hub: n.is_hub,
        is_orphan: n.is_orphan,
      };
    }

    // 次选：全新节点，寻找相连的已有节点作为锚点出生
    let spawnX = 0;
    let spawnY = 0;
    let spawnZ = 0;
    let foundAnchor = false;

    const neighbors = linkRelations.get(n.id) || [];
    for (const nbId of neighbors) {
      const nbHist = history.get(nbId);
      if (nbHist) {
        spawnX = nbHist.x;
        spawnY = nbHist.y;
        spawnZ = nbHist.z;
        foundAnchor = true;
        break;
      }
    }

    if (!foundAnchor) {
      // 若没有邻居，采用当前系统物理中心作为出生点
      let sumX = 0, sumY = 0, sumZ = 0, count = 0;
      history.forEach(pos => {
        sumX += pos.x;
        sumY += pos.y;
        sumZ += pos.z;
        count++;
      });
      if (count > 0) {
        spawnX = sumX / count;
        spawnY = sumY / count;
        spawnZ = sumZ / count;
      } else {
        // 全新冷启动随机小球
        spawnX = Math.random() * 80 - 40;
        spawnY = Math.random() * 80 - 40;
        spawnZ = Math.random() * 80 - 40;
      }
    }

    // 附带微小偏差，避免两点重合除以零产生无穷大斥力“炸飞”
    return {
      id: n.id,
      index: idx,
      x: spawnX + (Math.random() * 8 - 4),
      y: spawnY + (Math.random() * 8 - 4),
      z: spawnZ + (Math.random() * 8 - 4),
      vx: 0,
      vy: 0,
      vz: 0,
      fx: n.fx,
      fy: n.fy,
      fz: n.fz,
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

  posBuf = new Float32Array(nodes.length * 3);
  rebuildSim(warm);
  (ctx as any).postMessage({ type: 'ready' });
}

let sim: any = null;
function rebuildSim(warm: boolean = false) {
  if (sim) sim.stop();
  sim = forceSimulation(nodes, 3)
    .force('charge', forceManyBody().strength(params.chargeStrength).distanceMax(CHARGE_DISTANCE_MAX).theta(1.2))
    .force('link', forceLink(links).id((d: any) => d.id)
      .distance((l: any) => (l.edge_type === 'semantic' ? params.linkDistance * 1.5 : params.linkDistance))
      .strength((l: any) => (l.edge_type === 'semantic' ? params.linkStrength * 0.05 : params.linkStrength)))
    .force('center', forceCenter(0, 0, 0).strength(params.centerStrength))
    .alphaDecay(ALPHA_DECAY)
    .velocityDecay(VELOCITY_DECAY)
    // 降低温启动热度（由 0.3 降到 0.15），配合历史继承，完全消除滑块拖拽时的夸张波动
    .alpha(warm ? 0.15 : 1)
    .alphaTarget(floatingAlpha);

  // 自定义 3D bbox 力
  sim.force('bbox', () => {
    if (!bboxEnabled) return;
    const margin = 80;
    const strength = 0.02;
    for (const n of nodes) {
      if (n.fx !== undefined || n.fy !== undefined || n.fz !== undefined) continue;
      if (!isFinite(bbox.minX)) continue;
      
      // X 轴边界
      if (n.x < bbox.minX + margin) n.vx += (bbox.minX + margin - n.x) * strength;
      else if (n.x > bbox.maxX - margin) n.vx += (bbox.maxX - margin - n.x) * strength;
      
      // Y 轴边界
      if (n.y < bbox.minY + margin) n.vy += (bbox.minY + margin - n.y) * strength;
      else if (n.y > bbox.maxY - margin) n.vy += (bbox.maxY - margin - n.y) * strength;
      
      // Z 轴边界
      const minZ = -400, maxZ = 400;
      if (n.z < minZ + margin) n.vz += (minZ + margin - n.z) * strength;
      else if (n.z > maxZ - margin) n.vz += (maxZ - margin - n.z) * strength;
    }
  });

  sim.on('tick', sendPositions);
}

let lastSendTs = 0;
const SEND_INTERVAL_MS = 16;   // ≈60fps

function sendPositions() {
  const now = Date.now();
  if (now - lastSendTs < SEND_INTERVAL_MS) return;
  lastSendTs = now;
  if (!posBuf || posBuf.length !== nodes.length * 3) {
    posBuf = new Float32Array(nodes.length * 3);
  }
  for (let i = 0; i < nodes.length; i++) {
    posBuf[i * 3] = nodes[i].x;
    posBuf[i * 3 + 1] = nodes[i].y;
    posBuf[i * 3 + 2] = nodes[i].z ?? 0;
  }
  (ctx as any).postMessage({ type: 'positions', buffer: posBuf });
}

self.onmessage = (e: MessageEvent) => {
  ctx = self;
  const d = e.data;
  switch (d.type) {
    case 'init': {
      initSim(d.nodes, d.links, d.params, d.warm ?? false);
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
        sim.alpha(0.15).restart();
      }
      break;
    }
    case 'pin': {
      const i = nodeIdx.get(d.id);
      if (i !== undefined) {
        nodes[i].fx = d.x;
        nodes[i].fy = d.y;
        nodes[i].fz = d.z ?? 0;
        if (sim) sim.alphaTarget(0.3).alpha(0.15).restart();
      }
      break;
    }
    case 'unpin': {
      const i = nodeIdx.get(d.id);
      if (i !== undefined) {
        nodes[i].fx = undefined;
        nodes[i].fy = undefined;
        nodes[i].fz = undefined;
        nodes[i].vx = 0;
        nodes[i].vy = 0;
        nodes[i].vz = 0;
        if (sim) {
          sim.alphaTarget(floatingAlpha);
          sim.alpha(0.15).restart();
        }
      }
      break;
    }
    case 'reheat': {
      // 如果是微调，降低 reheat 热度
      if (sim) sim.alpha(d.alpha ?? 0.15).restart();
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
      const i = nodeIdx.get(d.id);
      if (i !== undefined && nodes[i].fx !== undefined) {
        nodes[i].fx = d.x;
        nodes[i].fy = d.y;
        if (d.z !== undefined) nodes[i].fz = d.z;
        nodes[i].x = d.x;
        nodes[i].y = d.y;
        if (d.z !== undefined) nodes[i].z = d.z;
      }
      break;
    }
    case 'floatingMode': {
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
