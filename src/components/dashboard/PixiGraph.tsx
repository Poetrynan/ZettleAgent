/**
 * PixiGraph — 基于 Pixi.js v8 + d3-force 的知识图谱渲染组件
 *
 * 设计要点(对齐 Obsidian 力导向图 + 用户"水上漂浮"需求):
 *  - d3-force 作力引擎;alphaTarget=0.02 让仿真永不停止,节点持续温柔漂浮
 *  - 拖拽节点:pin fx/fy 跟随鼠标,视口内钳制;释放后解除 pin,不回弹原位
 *  - 自定义 bbox force:轻量把越界节点推回当前视角内(按 alpha 缩放,不暴力)
 *  - Pixi Container(isRenderGroup) 作为相机:平移/缩放在 GPU 上做
 *  - 节点/边视觉复用 graphHelpers;hover 暗化、hub 星标、orphan 环、选择环、局部焦点环
 *  - 力参数(charge/link/center/decay)沿用 KnowledgeGraph 原值,保持物理不变
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import {
  Application,
  Container,
  Graphics,
  Text,
  Circle,
  Rectangle,
  type FederatedPointerEvent,
} from 'pixi.js';
import { Point } from 'pixi.js';
import {
  type SimulationNodeDatum,
} from 'd3-force';
import { GraphNode } from '../../lib/tauri';
import {
  getNodeColor,
  getNodeRadius,
  getLinkColor,
} from './graphHelpers';
import { getVizPalette, hexToPixi } from '../../lib/vizPalette';

// rgba/hex → number(忽略 alpha,alpha 由 Graphics 控制)。缓存以免每帧解析字符串。
const colorHexCache = new Map<string, number>();
function colorNum(s: string): number {
  let v = colorHexCache.get(s);
  if (v !== undefined) return v;
  if (s.startsWith('#')) {
    v = parseInt(s.slice(1), 16);
  } else {
    const m = s.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) {
      v = (parseInt(m[1]) << 16) | (parseInt(m[2]) << 8) | parseInt(m[3]);
    } else {
      v = 0x64748b;
    }
  }
  colorHexCache.set(s, v);
  return v;
}

// ── 类型 ────────────────────────────────────────────────────────────

export interface PGNode extends GraphNode, SimulationNodeDatum {
  degree?: number;
}
export interface PGLink {
  source: string | PGNode;
  target: string | PGNode;
  edge_type: string;
  weight: number;
  label?: string;
}
export interface PGGraphData {
  nodes: PGNode[];
  links: PGLink[];
}

export interface PixiGraphHandle {
  fitToScreen: (durationMs?: number) => void;
  zoomTo: (factor: number, screenX?: number, screenY?: number) => void;
}

interface PixiGraphProps {
  graphData: PGGraphData;
  width: number;
  height: number;
  // 状态(用于样式)
  hoveredNode: PGNode | null;
  selectedNodes: PGNode[];
  selectedCluster: number | null;
  methodology: string;
  isLocalMode: boolean;
  focusNodeId: string | null;
  // 力参数(Obsidian 风格 UI 调节)
  forceParams: ForceParams;
  // 回调
  onNodeClick: (node: PGNode, event: FederatedPointerEvent) => void;
  onNodeHover: (node: PGNode | null) => void;
  onNodeRightClick: (node: PGNode, event: FederatedPointerEvent) => void;
  onBackgroundClick: () => void;
}

// ── 力参数(Obsidian 风格,可由 UI 动态调节) ──────────────────────────

export interface ForceParams {
  centerStrength: number;   // 中心引力(对应 vis-network centralGravity)
  chargeStrength: number;   // 排斥力(负值,对应 vis-network gravitationalConstant)
  linkStrength: number;     // 连线拉力(对应 vis-network springConstant)
  linkDistance: number;     // 连线长度(对应 vis-network springLength)
}

// vis-network → d3-force 参数映射(参考 knowledge_graph.html):
//   gravitationalConstant: -22000  → chargeStrength: -1200  (缩放系数 ≈ /18)
//   centralGravity: 0.25           → centerStrength: 0.04   (缩放系数 ≈ /6)
//   springLength: 120              → linkDistance: 160      (坐标空间差异)
//   springConstant: 0.04           → linkStrength: 0.3      (d3 的 strength 范围 0-1)
//   damping: 0.2                   → velocityDecay: 0.2     (直接对应,已在 forceWorker 中设置)
//   avoidOverlap: 0.2              → 由 chargeStrength + bbox 力近似
export const DEFAULT_FORCE_PARAMS: ForceParams = {
  centerStrength: 0.000,   // 无中心引力(节点自由分布)
  chargeStrength: -1300,   // 较强排斥(vis-network gravitationalConstant=-22000 的等效值)
  linkStrength: 0.50,      // 中等弹簧拉力(vis-network springConstant=0.04 的等效值)
  linkDistance: 420,       // 宽松连线(vis-network springLength=120 的等效值)
};

// 物理漂浮阈值:≤此值时 worker 用 alphaTarget>0 让仿真永不停(vis-network 风格)
const FLOATING_PHYSICS_THRESHOLD = 500;

// ── 常量 ────────────────────────────────────────────────────────────
// 力学常量(ALPHA_DECAY / VELOCITY_DECAY / FLOATING_ALPHA / CHARGE_DISTANCE_MAX /
// BBOX_STRENGTH / BBOX_MARGIN / DRAG_ALPHA)已移入 forceWorker.ts

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 8;
const LABEL_SHOW_ZOOM = 0.3;   // 缩放高于此值显示标签
const LABEL_HOVER_FORCE = true;
const SEMANTIC_DASH_ZOOM = 0.6;  // zoom > 0.6 才画语义边虚线,否则实线(38x 段数减少)

// ── 节点显示对象池 ──────────────────────────────────────────────────

interface NodeView {
  node: PGNode;
  container: Container;
  glow: Graphics;
  body: Graphics;
  ring: Graphics;
  star: Text;
  label: Text;
  radius: number;
  color: string;       // hex string(保留用于调试/标签)
  colorNum: number;    // 缓存的数值型颜色(Pixi 填充用,免去每帧解析字符串)
  phaseX: number;      // 漂浮动画相位(预计算,避免每帧 charCodeAt)
  phaseY: number;
  phaseZ: number;      // 涟漪频率相位(双频漂浮的第二频率)
  ampScale: number;    // 漂浮幅度缩放(大节点更重,漂浮更轻)
  // 脏标记:样式相关状态变化时需要重绘 glow/body/ring
  dirty: boolean;
}

// bbox 力已移入 forceWorker.ts,主线程不再跑 d3-force。

// ── 组件 ────────────────────────────────────────────────────────────

export const PixiGraph = forwardRef<PixiGraphHandle, PixiGraphProps>(function PixiGraph(
  props,
  ref,
) {
  const {
    graphData,
    width,
    height,
    hoveredNode,
    selectedNodes,
    selectedCluster,
    methodology,
    isLocalMode,
    focusNodeId,
    forceParams,
    onNodeClick,
    onNodeHover,
    onNodeRightClick,
    onBackgroundClick,
  } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const worldRef = useRef<Container | null>(null);
  const linkLayerRef = useRef<Graphics | null>(null);
  const linkHighlightRef = useRef<Graphics | null>(null); // hover 高亮边层
  const nodeLayerRef = useRef<Container | null>(null);
  // Worker:d3-force 物理仿真在 worker 线程跑,主线程零阻塞
  const workerRef = useRef<Worker | null>(null);
  // 主线程镜像的 node x/y 数组(Worker 通过 Transferable 回传)
  const nodePositionsRef = useRef<Float32Array | null>(null);
  // 主线程镜像的 idx→view 数组(与 worker 内节点顺序一致,onTick 时 O(1) 定位写入位置)
  const idx2viewRef = useRef<NodeView[]>([]);
  const viewsRef = useRef<Map<string, NodeView>>(new Map());
  // 边标签 Text 池:key = "srcId|tgtId",value = Text 对象
  const linkLabelRef = useRef<Map<string, Text>>(new Map());
  const styleStateRef = useRef({
    hoveredNode,
    selectedNodes,
    selectedNodeIds: new Set(selectedNodes.map(n => n.id)),
    selectedCluster,
    methodology,
    isLocalMode,
    focusNodeId,
  });
  const liveBoundsRef = useRef({ minX: -Infinity, maxX: Infinity, minY: -Infinity, maxY: Infinity });
  // 已同步给 worker 的 bounds 缓存:仅当值变化时才 postMessage,避免每帧结构化克隆开销
  const sentBoundsRef = useRef({ minX: NaN, maxX: NaN, minY: NaN, maxY: NaN });
  const bboxEnabledRef = useRef(true);
  // 最新画布尺寸(由 width/height props 同步),供 onTick/onGlobalPointerMove 闭包读取,
  // 避免 init effect 空依赖导致 width/height 被锁死在 mount 时的值。
  const sizeRef = useRef({ width, height });
  const neighborSetRef = useRef<Set<string>>(new Set());
  // 预建邻接表:rebuildGraph 时构建,hover 时 O(1) 查询邻居,避免遍历所有 links
  const adjacencyRef = useRef<Map<string, Set<string>>>(new Map());
  // 边元数据缓存:rebuildGraph 时算一次颜色/宽度,避免每帧调用 getLinkColor
  const linkMetaRef = useRef<Array<{
    s: PGNode; t: PGNode; color: number; colorHL: number; width: number; isSemantic: boolean;
    labelKey: string; displayLabel: string | null;
  }>>([]);
  // forceParams 节流:RAF 合并连续滑动
  const forceRafRef = useRef<number | null>(null);
  // 边层 dirty 门控:仅在仿真 tick / graphData / forceParams / zoom 阈值跨越时重绘
  const linksDirtyRef = useRef(true);
  // 高亮边 dirty:仅在 hover 变化时设置,只重绘高亮层(5~20 条边)
  const linksHighlightDirtyRef = useRef(false);
  // drawLinks 复用容器(消除每帧 new Map/数组分配)
  const strokeGroupsRef = useRef(new Map<number, { width: number; color: number; alpha: number; segs: number[] }>());
  const arrowBufRef = useRef<Float32Array>(new Float32Array(8192));
  // toLocal 复用临时点(消除每帧 Point 分配)
  const tmpP1 = useRef(new Point());
  const tmpP2 = useRef(new Point());
  // canvas rect 缓存(避免 wheel 每次 getBoundingClientRect 触发 reflow)
  const canvasRectRef = useRef<DOMRect | null>(null);
  // 拖拽/平移状态
  const dragStateRef = useRef<{
    mode: 'none' | 'pan' | 'node';
    node?: PGNode;
    offsetGraph?: { x: number; y: number };
    lastGlobal?: { x: number; y: number };
    moved: boolean;
    downGlobal?: { x: number; y: number };
    downTime: number;
  }>({ mode: 'none', moved: false, downTime: 0 });
  // 双击检测
  const lastClickRef = useRef<{ id: string; time: number }>({ id: '', time: 0 });
  // 力参数 ref(rebuildGraph 闭包读取最新值)
  const forceParamsRef = useRef(forceParams);
  // dragMove RAF 节流(高刷新率显示器 120/240Hz 下将 postMessage 对齐到 60fps)
  const dragMoveRafRef = useRef<number | null>(null);
  const dragMoveDataRef = useRef<{ id: string; x: number; y: number } | null>(null);
  // 边索引:rebuildGraph 时构建,drawHighlightEdges 用邻接表 O(degree) 查找替代 O(E) 全量遍历
  const edgeIndexByPairRef = useRef<Map<string, number>>(new Map());
  // 空间网格:onContextMenu 时懒构建,O(1) 查找最近节点(替代 O(V) 全量遍历)
  const nodeGridRef = useRef<Map<string, string[]>>(new Map());
  const NODE_GRID_CELL = 200;

  // ── 同步 styleState ──
  useEffect(() => {
    const prevHovered = styleStateRef.current.hoveredNode;
    styleStateRef.current = {
      hoveredNode,
      selectedNodes,
      selectedNodeIds: new Set(selectedNodes.map(n => n.id)),
      selectedCluster,
      methodology,
      isLocalMode,
      focusNodeId,
    };
    // 重算邻居集:用预建邻接表 O(1) 查询,不再遍历所有 links
    const set = new Set<string>();
    if (hoveredNode) {
      set.add(hoveredNode.id);
      adjacencyRef.current.get(hoveredNode.id)?.forEach(id => set.add(id));
    }
    neighborSetRef.current = set;
    linksHighlightDirtyRef.current = true; // hover 变化只需重绘高亮层
    // 精准标记 dirty:只标记前后两次 hover 涉及的节点(hovered 本身 + 其邻居),
    // 避免对全量节点调 drawNode。restyleAll 只在 cluster/methodology 变化时需要。
    if (prevHovered?.id !== hoveredNode?.id) {
      const toDirty = new Set<string>();
      if (prevHovered) {
        toDirty.add(prevHovered.id);
        adjacencyRef.current.get(prevHovered.id)?.forEach(id => toDirty.add(id));
      }
      if (hoveredNode) {
        toDirty.add(hoveredNode.id);
        adjacencyRef.current.get(hoveredNode.id)?.forEach(id => toDirty.add(id));
      }
      for (const id of toDirty) {
        const v = viewsRef.current.get(id);
        if (v) v.dirty = true;
      }
    } else {
      // selectedNodes/cluster/methodology/focus 变化:全量标记
      restyleAll();
    }
  }, [hoveredNode, selectedNodes, selectedCluster, methodology, isLocalMode, focusNodeId]);

  // ── 力参数变化时实时更新仿真(Obsidian 风格滑动条,RAF 节流) ──
  useEffect(() => {
    forceParamsRef.current = forceParams;
    if (forceRafRef.current !== null) return;
    forceRafRef.current = requestAnimationFrame(() => {
      forceRafRef.current = null;
      workerRef.current?.postMessage({ type: 'params', params: forceParamsRef.current });
    });
    return () => {
      if (forceRafRef.current !== null) {
        cancelAnimationFrame(forceRafRef.current);
        forceRafRef.current = null;
      }
    };
  }, [forceParams]);

  // ── Viz theme: surface + label/edge colors (separate from UI chrome) ──
  useEffect(() => {
    const applyVizTheme = () => {
      const p = getVizPalette();
      const app = appRef.current;
      if (app?.renderer) {
        app.renderer.background.color = hexToPixi(p.surface.bg);
      }
      for (const t of linkLabelRef.current.values()) {
        t.style.fill = hexToPixi(p.label.edgeFill);
        t.style.stroke = { width: 3, color: hexToPixi(p.label.edgeHalo), join: 'round' };
      }
      for (const v of viewsRef.current.values()) {
        v.star.style.fill = hexToPixi(p.label.hubStar);
        v.label.style.fill = hexToPixi(p.label.nodeFill);
        v.label.style.stroke = { width: 3, color: hexToPixi(p.label.nodeHalo), join: 'round' };
        v.dirty = true;
      }
      linkMetaRef.current.forEach((meta, i) => {
        const l = graphData.links[i];
        if (!l) return;
        meta.color = colorNum(getLinkColor(l.label, false, l.edge_type));
        meta.colorHL = colorNum(getLinkColor(l.label, true, l.edge_type));
      });
      linksDirtyRef.current = true;
      linksHighlightDirtyRef.current = true;
      restyleAll();
    };
    window.addEventListener('zettel:theme-changed', applyVizTheme);
    return () => window.removeEventListener('zettel:theme-changed', applyVizTheme);
  }, [graphData.links]);

  // ── 初始化 Pixi Application ──
  useEffect(() => {
    let destroyed = false;
    const mount = async () => {
      const app = new Application();
      await app.init({
        width,
        height,
        background: hexToPixi(getVizPalette().surface.bg),
        antialias: true,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
        preference: 'webgl',
      });
      if (destroyed) {
        app.destroy(true, { children: true, texture: true, textureSource: true });
        return;
      }
      appRef.current = app;
      const host = containerRef.current;
      if (host) host.appendChild(app.canvas);

      // world 容器(相机),用 renderGroup 让平移/缩放在 GPU 做
      const world = new Container({ isRenderGroup: true });
      app.stage.addChild(world);
      worldRef.current = world;

      const linkLayer = new Graphics();
      world.addChild(linkLayer);
      linkLayerRef.current = linkLayer;

      const linkHighlight = new Graphics();
      world.addChild(linkHighlight);
      linkHighlightRef.current = linkHighlight;

      const nodeLayer = new Container();
      world.addChild(nodeLayer);
      nodeLayerRef.current = nodeLayer;

      // stage 接收背景事件 + globalpointermove
      app.stage.eventMode = 'static';
      app.stage.hitArea = new Rectangle(0, 0, width, height);
      app.stage.on('pointerdown', onStagePointerDown);
      app.stage.on('globalpointermove', onGlobalPointerMove);
      app.stage.on('pointerup', onPointerUp);
      app.stage.on('pointerupoutside', onPointerUp);

      // wheel 缩放
      app.canvas.addEventListener('wheel', onWheel, { passive: false });

      // 创建 Worker:d3-force 物理仿真在 worker 线程跑,主线程零阻塞
      const worker = new Worker(new URL('./forceWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent) => {
        const data = e.data;
        if (data.type === 'positions') {
          nodePositionsRef.current = data.buffer as Float32Array;
          linksDirtyRef.current = true;
        }
      };
      workerRef.current = worker;

      // 初始构建 + 仿真
      rebuildGraph();

      // Pixi Ticker:每帧更新节点视觉位置 + 漂浮 + 边层按需重绘
    app.ticker.add(onTick);

    // resize / scroll 时清除缓存的 canvas rect

      // 暴露 fit
      scheduleFit();
    };
    mount();

    return () => {
      destroyed = true;
      if (dragMoveRafRef.current !== null) {
        cancelAnimationFrame(dragMoveRafRef.current);
        dragMoveRafRef.current = null;
      }
      const app = appRef.current;
      if (app) {
        app.canvas.removeEventListener('wheel', onWheel);
        app.stage?.removeAllListeners();
        app.destroy(true, { children: true, texture: true, textureSource: true });
      }
      appRef.current = null;
      worldRef.current = null;
      linkLayerRef.current = null;
      linkHighlightRef.current = null;
      nodeLayerRef.current = null;
      viewsRef.current.clear();
      workerRef.current?.postMessage({ type: 'stop' });
      workerRef.current?.terminate();
      workerRef.current = null;
      nodePositionsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 尺寸变化 ──
  useEffect(() => {
    sizeRef.current = { width, height };
    canvasRectRef.current = null; // 视口变了,清除缓存的 rect
    linksDirtyRef.current = true;
    const app = appRef.current;
    if (!app) return;
    app.renderer.resize(width, height);
    if (app.stage) app.stage.hitArea = new Rectangle(0, 0, width, height);
  }, [width, height]);

  // ── 数据变化:重建图谱 ──
  useEffect(() => {
    if (!appRef.current) return;
    rebuildGraph();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphData]);

  // ── 暴露 ref 方法 ──
  useImperativeHandle(ref, () => ({
    fitToScreen: (_dur?: number) => fitToScreen(),
    zoomTo: (factor: number, sx?: number, sy?: number) => {
      const world = worldRef.current;
      if (!world) return;
      const cx = sx ?? width / 2;
      const cy = sy ?? height / 2;
      const gx = world.toLocal({ x: cx, y: cy });
      let z = world.scale.x * factor;
      z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
      world.scale.set(z);
      const nc = world.toLocal({ x: cx, y: cy });
      world.position.x += (nc.x - gx.x) * 0; // no-op 占位
      // 重新对齐:使 gx 在缩放后仍对应屏幕 cx,cy
      world.position.x = cx - gx.x * z;
      world.position.y = cy - gx.y * z;
    },
  }), [width, height]);

  // ── 构建节点/边视图 + 仿真 ──
  function rebuildGraph() {
    const world = worldRef.current;
    const nodeLayer = nodeLayerRef.current;
    const linkLayer = linkLayerRef.current;
    if (!world || !nodeLayer || !linkLayer) return;

    // 清理旧视图
    for (const v of viewsRef.current.values()) {
      v.container.destroy({ children: true });
    }
    viewsRef.current.clear();
    nodeLayer.removeChildren();
    linkLayer.clear();
    linkHighlightRef.current?.clear();

    // 清理旧边标签(包括可能因重复 key 碰撞而孤立的标签)
    for (const t of linkLabelRef.current.values()) t.destroy();
    linkLabelRef.current.clear();
    // 额外清理:移除因同一节点对多条边导致 key 碰撞而孤立的标签 Text。
    // 后端按 (source, target, edge_type, label) 去重,同一节点对可能有多条边,
    // 旧代码用 `${sid}|${tid}` 作 key 会导致前几条边的 Text 被覆盖后成为孤立对象,
    // 永远停留在 world 原点(0,0),表现为「标签脱落后固定在画布上」。
    for (let i = world.children.length - 1; i >= 0; i--) {
      const child = world.children[i];
      if (child instanceof Text) {
        child.destroy();
      }
    }

    const nodes = graphData.nodes;
    const links = graphData.links;

    // 边标签 Text 池(只为有 label 的边创建)
    const viz = getVizPalette();
    for (const l of links) {
      const sid = typeof l.source === 'string' ? l.source : l.source.id;
      const tid = typeof l.target === 'string' ? l.target : l.target.id;
      const displayLabel = l.label || (l.edge_type === 'semantic' ? `${Math.round(l.weight * 100)}%` : null);
      if (!displayLabel) continue;
      const labelKey = `${sid}|${tid}`;
      // 同一节点对可能有多条边(link + semantic + relation),
      // 只创建一个标签 Text,避免 key 碰撞导致前一个 Text 成为孤立对象。
      if (linkLabelRef.current.has(labelKey)) continue;
      const t = new Text({
        text: displayLabel,
        style: {
          fontFamily: 'system-ui, sans-serif',
          fontSize: 9,
          fill: hexToPixi(viz.label.edgeFill),
          stroke: { width: 3, color: hexToPixi(viz.label.edgeHalo), join: 'round' },
          align: 'center',
        },
      });
      t.anchor.set(0.5);
      t.eventMode = 'none';
      world.addChild(t);
      linkLabelRef.current.set(labelKey, t);
    }

    // 预建邻接表(rebuildGraph 时一次性构建,hover O(1) 查询邻居)
    const adj = new Map<string, Set<string>>();
    for (const n of nodes) adj.set(n.id, new Set());
    for (const l of links) {
      const sid = typeof l.source === 'string' ? l.source : l.source.id;
      const tid = typeof l.target === 'string' ? l.target : l.target.id;
      adj.get(sid)?.add(tid);
      adj.get(tid)?.add(sid);
    }
    adjacencyRef.current = adj;

    // 节点索引(ID → PGNode),供 linkMeta 构建用
    const nodeById = new Map<string, PGNode>();
    for (const n of nodes) nodeById.set(n.id, n);

    // 缓存边元数据(颜色/宽度),避免每帧调用 getLinkColor
    linkMetaRef.current = links.map(l => {
      const sid = typeof l.source === 'string' ? l.source : l.source.id;
      const tid = typeof l.target === 'string' ? l.target : l.target.id;
      const s = nodeById.get(sid)!;
      const t = nodeById.get(tid)!;
      const isSemantic = l.edge_type === 'semantic';
      const displayLabel = l.label || (isSemantic ? `${Math.round(l.weight * 100)}%` : null);
      return {
        s, t,
        color: colorNum(getLinkColor(l.label, false, l.edge_type)),
        colorHL: colorNum(getLinkColor(l.label, true, l.edge_type)),
        width: isSemantic ? 1.0 : Math.max(0.8, Math.min(l.weight * 2.5, 3.5)),
        isSemantic,
        labelKey: `${sid}|${tid}`,
        displayLabel,
      };
    });

    // 构建边索引(双向),供 drawHighlightEdges O(degree) 查找替代 O(E) 全量遍历
    const edgeIdx = edgeIndexByPairRef.current;
    edgeIdx.clear();
    for (let li = 0; li < links.length; li++) {
      const l = links[li];
      const lsid = typeof l.source === 'string' ? l.source : l.source.id;
      const ltid = typeof l.target === 'string' ? l.target : l.target.id;
      edgeIdx.set(`${lsid}|${ltid}`, li);
      edgeIdx.set(`${ltid}|${lsid}`, li);
    }

    // 节点视图
    for (const n of nodes) {
      if (!n.x) n.x = (Math.random() - 0.5) * 400;
      if (!n.y) n.y = (Math.random() - 0.5) * 400;
      const color = getNodeColor(n, selectedCluster !== null, methodology);
      const radius = getNodeRadius(n);
      const container = new Container();
      container.eventMode = 'static';
      container.hitArea = new Circle(0, 0, radius + 4);
      container.x = n.x;
      container.y = n.y;

      const glow = new Graphics();
      const body = new Graphics();
      const ring = new Graphics();
      container.addChild(glow, body, ring);

      const star = new Text({
        text: '★',
        style: { fontFamily: 'sans-serif', fontSize: Math.max(8, radius * 0.7), fill: hexToPixi(viz.label.hubStar) },
      });
      star.anchor.set(0.5);
      star.eventMode = 'none';
      container.addChild(star);

      const label = new Text({
        text: n.label.length > 16 ? n.label.slice(0, 16) + '…' : n.label,
        style: {
          fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif',
          fontSize: radius > 18 ? 11 : 10,
          fill: hexToPixi(viz.label.nodeFill),
          stroke: { width: 3, color: hexToPixi(viz.label.nodeHalo), join: 'round' },
          align: 'center',
        },
      });
      label.anchor.set(0.5, 0);
      label.eventMode = 'none';
      label.position.set(0, radius + 6);
      container.addChild(label);

      // 事件
      container.on('pointerdown', (e: FederatedPointerEvent) => onNodePointerDown(e, n));
      container.on('pointerenter', () => {
        if (dragStateRef.current.mode === 'node') return;
        onNodeHover(n);
      });
      container.on('pointerleave', () => {
        if (dragStateRef.current.mode === 'node') return;
        onNodeHover(null);
      });
      // 右键:Pixi 不直接有 rightclick,用 pointertap + button 判断或在 stage 处理 contextmenu
      container.on('pointertap', (e: FederatedPointerEvent) => onNodeTap(e, n));

      nodeLayer.addChild(container);
      // 预计算漂浮相位(避免每帧 charCodeAt)
      // 三组相位 + 幅度缩放:模拟"水上漂浮"的双重波叠加(慢涌 + 快涟)
      const phX = (n.id.charCodeAt(0) || 0) + (n.id.charCodeAt(Math.max(0, n.id.length - 1)) || 0);
      const phY = phX + 2;
      const phZ = ((n.id.charCodeAt(1) || 0) * 7 + (n.id.charCodeAt(2) || 0) * 13) % 360;
      // 大节点更重,漂浮幅度减半;小节点全幅(vis-network 中大节点更稳定)
      const ampScale = radius > 18 ? 0.5 : radius > 12 ? 0.75 : 1.0;
      viewsRef.current.set(n.id, {
        node: n,
        container,
        glow,
        body,
        ring,
        star,
        label,
        radius,
        color,
        colorNum: colorNum(color),
        phaseX: phX,
        phaseY: phY,
        phaseZ: phZ,
        ampScale,
        dirty: true,
      });
    }

    // 构建 idx→view 映射(与 worker 内节点顺序一致),onTick 时 O(1) 应用位置
    const idx2view: NodeView[] = new Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      const v = viewsRef.current.get(nodes[i].id);
      if (v) idx2view[i] = v;
    }
    idx2viewRef.current = idx2view;

    // 交给 Worker 跑 d3-force(序列化节点/边数据,worker 内部构建自己的仿真)
    const fp = forceParamsRef.current;
    // 根据节点数自适应漂浮模式:
    //   小图(≤500): alphaTarget=0.03,仿真永不停 → 真物理漂浮(vis-network 风格)
    //   大图(>500):  alphaTarget=0,仿真收敛后停 → 主线程 sin/cos 漂浮(高性能)
    const physicsFloating = nodes.length <= FLOATING_PHYSICS_THRESHOLD;
    workerRef.current?.postMessage({
      type: 'init',
      nodes: nodes.map(n => ({ id: n.id, x: n.x, y: n.y, is_hub: n.is_hub, is_orphan: n.is_orphan })),
      links: links.map(l => ({
        source: typeof l.source === 'string' ? l.source : l.source.id,
        target: typeof l.target === 'string' ? l.target : l.target.id,
        edge_type: l.edge_type, weight: l.weight, label: l.label,
      })),
      params: fp,
    });
    workerRef.current?.postMessage({
      type: 'floatingMode',
      alpha: physicsFloating ? 0.03 : 0,
    });
    // 同步当前 bbox 状态到 worker
    const lb0 = liveBoundsRef.current;
    workerRef.current?.postMessage({ type: 'bounds', minX: lb0.minX, maxX: lb0.maxX, minY: lb0.minY, maxY: lb0.maxY });
    sentBoundsRef.current.minX = lb0.minX; sentBoundsRef.current.maxX = lb0.maxX;
    sentBoundsRef.current.minY = lb0.minY; sentBoundsRef.current.maxY = lb0.maxY;
    workerRef.current?.postMessage({ type: 'bboxEnabled', enabled: bboxEnabledRef.current });

    linksDirtyRef.current = true; // rebuild 后首次必然需要重绘

    restyleAll();
    drawLinks();
  }

  // ── 每帧:更新位置 + 视口边界 + 标签可见性 + 按需重绘边 ──
  function onTick() {
    const world = worldRef.current;
    const linkLayer = linkLayerRef.current;
    if (!world) return;

    // 更新 liveBoundsRef(当前视角图坐标,用最新尺寸 + 复用临时 Point)
    const { width: w, height: h } = sizeRef.current;
    world.toLocal({ x: 0, y: 0 }, undefined, tmpP1.current);
    world.toLocal({ x: w, y: h }, undefined, tmpP2.current);
    const pad = 20 / Math.max(world.scale.x, 0.0001);
    // 就地修改,避免每帧 new 对象
    const lb = liveBoundsRef.current;
    lb.minX = tmpP1.current.x + pad;
    lb.maxX = tmpP2.current.x - pad;
    lb.minY = tmpP1.current.y + pad;
    lb.maxY = tmpP2.current.y - pad;

    // 同步视口边界到 Worker(bbox 力在 worker 内运行)。
    // 仅当 bounds 相对上次发送有显著变化时才 postMessage,避免每帧结构化克隆开销。
    // 阈值取 1 像素:平移/缩放每帧移动量通常 >1px,而浮点抖动 <1px。
    const sb = sentBoundsRef.current;
    if (Math.abs(lb.minX - sb.minX) > 1 || Math.abs(lb.maxX - sb.maxX) > 1 ||
        Math.abs(lb.minY - sb.minY) > 1 || Math.abs(lb.maxY - sb.maxY) > 1) {
      sb.minX = lb.minX; sb.maxX = lb.maxX; sb.minY = lb.minY; sb.maxY = lb.maxY;
      workerRef.current?.postMessage({ type: 'bounds', minX: lb.minX, maxX: lb.maxX, minY: lb.minY, maxY: lb.maxY });
    }

    // 合并:Worker 位置写入 + 漂浮动画 + 视口剔除 (单次遍历)
    const pos = nodePositionsRef.current;
    const time = (appRef.current?.ticker.lastTime ?? 0) * 0.001;
    const zoom = world.scale.x;
    const showLabels = zoom >= LABEL_SHOW_ZOOM;
    const cullMinX = lb.minX - 100, cullMaxX = lb.maxX + 100;
    const cullMinY = lb.minY - 100, cullMaxY = lb.maxY + 100;
    const hoveredId = styleStateRef.current.hoveredNode?.id;
    const dragNodeId = dragStateRef.current.mode === 'node' ? dragStateRef.current.node?.id : null;

    const views = idx2viewRef.current;
    const n = views.length;
    for (let i = 0; i < n; i++) {
      const v = views[i];
      if (!v) continue;

      // Worker 位置写入
      if (pos) {
        v.node.x = pos[i * 2];
        v.node.y = pos[i * 2 + 1];
      }

      const base_x = v.node.x!;
      const base_y = v.node.y!;

      // 先用基础位置做视口剔除,视口外节点跳过 sin/cos 计算
      // (万级节点下省去 90%+ 的三角函数调用,cull margin 100px 远大于偏移 2.5px)
      v.container.x = base_x;
      v.container.y = base_y;
      v.container.visible = base_x >= cullMinX && base_x <= cullMaxX && base_y >= cullMinY && base_y <= cullMaxY;
      if (!v.container.visible) continue;

      // 视口内节点才计算漂浮偏移(双频正弦叠加,模拟"水上漂浮"的慢涌+快涟)
      // 对齐 vis-network 的物理漂浮感:低阻尼(damping=0.2) + 残余力自然漂移
      const isPinned = v.node.fx !== undefined && v.node.fy !== undefined;
      const isDragging = isPinned && dragNodeId === v.node.id;
      if (!isDragging) {
        const amp = v.ampScale;
        // 慢涌:大振幅低频(水上主体波动)
        const swellX = Math.sin(time * 0.3 + v.phaseX) * 2.0 * amp;
        const swellY = Math.cos(time * 0.25 + v.phaseY) * 2.0 * amp;
        // 快涟:小振幅高频(水面涟漪叠加,打破周期感)
        const rippleX = Math.sin(time * 0.8 + v.phaseZ) * 0.7 * amp;
        const rippleY = Math.cos(time * 0.7 + v.phaseZ * 1.3) * 0.7 * amp;
        v.container.x += swellX + rippleX;
        v.container.y += swellY + rippleY;
      }

      // 标签可见性(LOD: zoom < 0.3 隐藏)
      v.label.visible = showLabels || (LABEL_HOVER_FORCE && hoveredId === v.node.id);
      if (v.dirty) drawNode(v, zoom);
    }

    // 边层按需重绘:仅在 sim tick 标记 dirty 时执行。
    // 悬停选择导致浮动时 sim 持续运行 → dirty 持续 true → 正常重绘。
    // 仿真完全静态时 → 漂浮仍在但节点 node.x/y 不变 → 边端点不变 → 跳过重绘。
    // 漂浮是写入 container 的视觉偏移,不影响 node.x/y,故边层内容确实不变。
    if (linkLayer && linksDirtyRef.current) {
      drawLinks();
      drawHighlightEdges(); // 高亮层同步更新(拖拽/仿真时边端点变化)
      linksDirtyRef.current = false;
      linksHighlightDirtyRef.current = false;
    } else if (linkLayer && linksHighlightDirtyRef.current) {
      // 仅 hover 变化:只重绘高亮层(~5~20 条边),基础层不动
      drawHighlightEdges();
      linksHighlightDirtyRef.current = false;
    }

    // 修复"标签脱落"问题:每帧更新边标签位置,跟随节点的漂浮动画。
    // 边标签位置需要基于 container.x/y(含漂浮偏移)而非 node.x/y(基础位置),
    // 否则仿真收敛后标签会固定在基础位置,与漂浮的节点视觉上脱节。
    if (showLabels) {
      updateEdgeLabelsFollowFloating();
    }
  }

  // ── 每帧更新边标签位置,跟随节点漂浮动画 ──
  function updateEdgeLabelsFollowFloating() {
    const meta = linkMetaRef.current;
    const len = meta.length;
    const views = viewsRef.current; // Map<string, NodeView>,O(1) 查找
    for (let i = 0; i < len; i++) {
      const m = meta[i];
      if (!m.displayLabel) continue;
      const labelObj = linkLabelRef.current.get(m.labelKey);
      if (!labelObj || !labelObj.visible) continue;
      const sView = views.get(m.s.id);
      const tView = views.get(m.t.id);
      if (sView && tView) {
        // 使用 container 位置(包含漂浮偏移)计算中点
        labelObj.position.set(
          (sView.container.x + tView.container.x) / 2,
          (sView.container.y + tView.container.y) / 2
        );
      }
    }
  }

  // ── 重绘所有节点(样式变化时) ──
  function restyleAll() {
    for (const v of viewsRef.current.values()) {
      // 重新计算颜色/半径(方法/聚类切换)
      v.color = getNodeColor(v.node, styleStateRef.current.selectedCluster !== null, styleStateRef.current.methodology);
      v.colorNum = colorNum(v.color);
      const newRadius = getNodeRadius(v.node);
      if (newRadius !== v.radius) {
        v.radius = newRadius;
        v.container.hitArea = new Circle(0, 0, newRadius + 4);
      }
      v.dirty = true;
    }
  }

  // ── 绘制单个节点 glow/body/ring (LOD: 低缩放跳过 glow/ring) ──
  function drawNode(v: NodeView, zoom: number) {
    v.dirty = false;
    const st = styleStateRef.current;
    const hovered = st.hoveredNode?.id === v.node.id;
    const isNeighbor = neighborSetRef.current.has(v.node.id);
    const dimmed = st.hoveredNode && !isNeighbor;
    const selected = st.selectedNodeIds.has(v.node.id);
    const isFocus = st.isLocalMode && st.focusNodeId === v.node.id;
    const colorN = v.colorNum;
    const r = v.radius;

    // LOD: zoom < 0.3 只画 body(点云模式)
    const isLowDetail = zoom < 0.3;
    const isMidDetail = zoom < 0.5;

    // glow (低 LOD 跳过)
    v.glow.clear();
    if (!isLowDetail) {
      const glowR = r + (hovered ? 14 : v.node.is_hub ? 10 : 6);
      v.glow.circle(0, 0, glowR).fill({ color: colorN, alpha: hovered ? 0.3 : 0.15 });
    }

    // body
    v.body.clear();
    const bodyAlpha = dimmed ? 0.15 : 1.0;
    v.body.circle(0, 0, r).fill({ color: colorN, alpha: bodyAlpha });
    if (!isLowDetail) {
      v.body.circle(0, 0, r).stroke({ width: 1.5, color: colorN, alpha: dimmed ? 0.1 : 0.6 });
    }

    const ring = getVizPalette().ring;
    // ring (低 LOD 跳过)
    v.ring.clear();
    if (!isLowDetail) {
      if (hovered) {
        v.ring.circle(0, 0, r + 4).stroke({ width: 2, color: hexToPixi(ring.selectedStrong), alpha: 0.5 });
      }
      if (selected) {
        v.ring.circle(0, 0, r + 4).stroke({ width: 2.5, color: hexToPixi(ring.selected), alpha: 0.8 });
      }
      if (isFocus) {
        v.ring.circle(0, 0, r + 6).stroke({ width: 2.5, color: hexToPixi(ring.multiSelect), alpha: 0.7 });
      }
      const isPinned = v.node.fx !== undefined && v.node.fy !== undefined;
      if (isPinned) {
        v.ring.circle(0, 0, r + 3).stroke({ width: 1.5, color: hexToPixi(ring.hub), alpha: 0.7 });
      }
      if (v.node.is_orphan) {
        v.ring.circle(0, 0, r + 3).stroke({ width: 1.2, color: colorN, alpha: 0.4 });
      }
    }

    // hub star (中 LOD 以上才显示)
    v.star.visible = !isMidDetail && v.node.is_hub === true;
  }

  // ── 绘制所有边(按需调用:仅 sim 跳动 / hover / 数据变化时) ──
  // 优化:复用 Map/Float32Array,视口剔除,数值 key 消除字符串拼接
  function drawLinks() {
    const linkLayer = linkLayerRef.current;
    if (!linkLayer) return;
    linkLayer.clear();
    const st = styleStateRef.current;
    const hovered = st.hoveredNode;
    const world = worldRef.current;
    const zoom = world?.scale.x ?? 1;
    const showLabels = zoom >= LABEL_SHOW_ZOOM;
    const showArrows = zoom > 0.35;
    const b = liveBoundsRef.current;
    const minX = b.minX - 200, maxX = b.maxX + 200;
    const minY = b.minY - 200, maxY = b.maxY + 200;

    // 复用分组容器(每帧 clear 而非 new,消除 GC 压力)
    const strokeGroups = strokeGroupsRef.current;
    strokeGroups.clear();
    const arrowBuf = arrowBufRef.current;
    let arrowCount = 0;
    let arrowNormalCount = 0;

    const meta = linkMetaRef.current;
    const metaLen = meta.length;

    for (let mi = 0; mi < metaLen; mi++) {
      const m = meta[mi];
      const s = m.s;
      const t = m.t;
      const sx = s.x, sy = s.y, tx = t.x, ty = t.y;
      if (sx == null || sy == null || tx == null || ty == null) continue;
      // 视口剔除
      if ((sx < minX && tx < minX) || (sx > maxX && tx > maxX)) continue;
      if ((sy < minY && ty < minY) || (sy > maxY && ty > maxY)) continue;

      const isHL = !!hovered && (s.id === hovered.id || t.id === hovered.id);
      const isDim = !!hovered && !isHL;
      const color = isHL ? m.colorHL : m.color;
      const w = isHL ? Math.max(m.width + 1, 2.5) : m.width;
      const alpha = isDim ? 0.08 : (!isHL && m.isSemantic ? 0.6 : 1.0);

      // 数值 key 消除字符串拼接
      const key = (Math.round(w * 10) << 20) | (color & 0xfffff) | (Math.round(alpha * 100) << 24);
      let grp = strokeGroups.get(key);
      if (!grp) {
        grp = { width: w, color, alpha, segs: [] };
        strokeGroups.set(key, grp);
      }
      const segs = grp.segs;

      if (m.isSemantic && zoom > SEMANTIC_DASH_ZOOM) {
        // 高 zoom:虚线分段(每 5px 一段,step 10px)
        const dx = tx - sx;
        const dy = ty - sy;
        const dist = Math.hypot(dx, dy);
        if (dist > 1) {
          const ux = dx / dist;
          const uy = dy / dist;
          let d = 0;
          while (d < dist) {
            const e2 = Math.min(d + 5, dist);
            segs.push(sx + ux * d, sy + uy * d, sx + ux * e2, sy + uy * e2);
            d += 10;
          }
        }
      } else {
        // 低 zoom 或非语义边:实线(1 段 vs 38 段,性能提升 38x)
        segs.push(sx, sy, tx, ty);
      }

      // 箭头收集到复用 buffer
      if (showArrows) {
        const dx = tx - sx;
        const dy = ty - sy;
        const ang = Math.atan2(dy, dx);
        const tView = viewsRef.current.get(t.id);
        const tRad = tView ? tView.radius : 8;
        const tipX = tx - tRad * Math.cos(ang);
        const tipY = ty - tRad * Math.sin(ang);
        const alen = isHL ? 10 : 8;
        const ha = 0.38;
        const cosHa = Math.cos(ang - ha);
        const sinHa = Math.sin(ang - ha);
        const cosHa2 = Math.cos(ang + ha);
        const sinHa2 = Math.sin(ang + ha);
        if (isHL) {
          const boff = arrowCount * 6;
          if (boff + 5 < arrowBuf.length) {
            arrowBuf[boff] = tipX; arrowBuf[boff + 1] = tipY;
            arrowBuf[boff + 2] = tipX - alen * cosHa; arrowBuf[boff + 3] = tipY - alen * sinHa;
            arrowBuf[boff + 4] = tipX - alen * cosHa2; arrowBuf[boff + 5] = tipY - alen * sinHa2;
            arrowCount++;
          }
        } else {
          const boff = (999 - arrowNormalCount) * 6;
          if (boff >= 0 && boff + 5 < arrowBuf.length) {
            arrowBuf[boff] = tipX; arrowBuf[boff + 1] = tipY;
            arrowBuf[boff + 2] = tipX - alen * cosHa; arrowBuf[boff + 3] = tipY - alen * sinHa;
            arrowBuf[boff + 4] = tipX - alen * cosHa2; arrowBuf[boff + 5] = tipY - alen * sinHa2;
            arrowNormalCount++;
          }
        }
      }

      // 边标签
      if (showLabels && !isDim) {
        const labelObj = linkLabelRef.current.get(m.labelKey);
        if (labelObj) {
          labelObj.position.set((sx + tx) / 2, (sy + ty) / 2);
          labelObj.visible = true;
          labelObj.alpha = isHL ? 1.0 : 0.85;
        }
      } else {
        const labelObj = linkLabelRef.current.get(m.labelKey);
        if (labelObj) labelObj.visible = false;
      }
    }

    // 批量绘制线段(每个分组一次 stroke)
    for (const grp of strokeGroups.values()) {
      const { width, color, alpha, segs } = grp;
      const segLen = segs.length;
      for (let i = 0; i < segLen; i += 4) {
        linkLayer.moveTo(segs[i], segs[i + 1]).lineTo(segs[i + 2], segs[i + 3]);
      }
      linkLayer.stroke({ width, color, alpha });
    }

    const highlight = hexToPixi(getVizPalette().ring.highlight);
    const arrowMuted = hexToPixi(getVizPalette().filterAll);

    // 批量绘制箭头(高亮 + 普通,各合并为单次 beginPath/fill)
    if (showArrows) {
      if (arrowCount > 0) {
        linkLayer.beginPath();
        for (let i = 0; i < arrowCount; i++) {
          const off = i * 6;
          linkLayer.moveTo(arrowBuf[off], arrowBuf[off + 1]);
          linkLayer.lineTo(arrowBuf[off + 2], arrowBuf[off + 3]);
          linkLayer.lineTo(arrowBuf[off + 4], arrowBuf[off + 5]);
          linkLayer.closePath();
        }
        linkLayer.fill({ color: highlight, alpha: 1.0 });
      }
      if (arrowNormalCount > 0) {
        const normalStart = 1000 - arrowNormalCount;
        linkLayer.beginPath();
        for (let i = 0; i < arrowNormalCount; i++) {
          const off = (normalStart + i) * 6;
          linkLayer.moveTo(arrowBuf[off], arrowBuf[off + 1]);
          linkLayer.lineTo(arrowBuf[off + 2], arrowBuf[off + 3]);
          linkLayer.lineTo(arrowBuf[off + 4], arrowBuf[off + 5]);
          linkLayer.closePath();
        }
        linkLayer.fill({ color: arrowMuted, alpha: 0.9 });
      }
    }
  }

  // ── 仅重绘高亮边(hover 变化时调用) ──
  // 优化:使用邻接表 O(degree) 查找替代 O(E) 全量遍历(degree 通常 5~20,E 可达数万)
  function drawHighlightEdges() {
    const hl = linkHighlightRef.current;
    if (!hl) return;
    hl.clear();
    const st = styleStateRef.current;
    const hovered = st.hoveredNode;
    if (!hovered) return; // 无 hover → 高亮层为空

    const world = worldRef.current;
    const zoom = world?.scale.x ?? 1;
    const showArrows = zoom > 0.35;
    const b = liveBoundsRef.current;
    const minX = b.minX - 200, maxX = b.maxX + 200;
    const minY = b.minY - 200, maxY = b.maxY + 200;

    const meta = linkMetaRef.current;
    const edgeIdx = edgeIndexByPairRef.current;

    // 邻接表 O(degree) 查找:仅遍历 hovered 节点的邻居,而非全部边
    const neighbors = adjacencyRef.current.get(hovered.id);
    if (!neighbors || neighbors.size === 0) return;

    const segs: number[] = [];
    const arrowBuf = new Float32Array(60);
    let arrowCount = 0;
    const processed = new Set<number>();

    for (const neighborId of neighbors) {
      const idx = edgeIdx.get(`${hovered.id}|${neighborId}`);
      if (idx === undefined || processed.has(idx)) continue;
      processed.add(idx);

      const m = meta[idx];
      const s = m.s;
      const t = m.t;
      const sx = s.x, sy = s.y, tx = t.x, ty = t.y;
      if (sx == null || sy == null || tx == null || ty == null) continue;
      if ((sx < minX && tx < minX) || (sx > maxX && tx > maxX)) continue;
      if ((sy < minY && ty < minY) || (sy > maxY && ty > maxY)) continue;

      if (m.isSemantic && zoom > SEMANTIC_DASH_ZOOM) {
        const dx = tx - sx;
        const dy = ty - sy;
        const dist = Math.hypot(dx, dy);
        if (dist > 1) {
          const ux = dx / dist;
          const uy = dy / dist;
          let d = 0;
          while (d < dist) {
            const e2 = Math.min(d + 5, dist);
            segs.push(sx + ux * d, sy + uy * d, sx + ux * e2, sy + uy * e2);
            d += 10;
          }
        }
      } else {
        segs.push(sx, sy, tx, ty);
      }

      if (showArrows) {
        const dx = tx - sx;
        const dy = ty - sy;
        const ang = Math.atan2(dy, dx);
        const tView = viewsRef.current.get(t.id);
        const tRad = tView ? tView.radius : 8;
        const tipX = tx - tRad * Math.cos(ang);
        const tipY = ty - tRad * Math.sin(ang);
        const alen = 10;
        const ha = 0.38;
        const off = arrowCount * 6;
        if (off + 5 < arrowBuf.length) {
          arrowBuf[off] = tipX;
          arrowBuf[off + 1] = tipY;
          arrowBuf[off + 2] = tipX - alen * Math.cos(ang - ha);
          arrowBuf[off + 3] = tipY - alen * Math.sin(ang - ha);
          arrowBuf[off + 4] = tipX - alen * Math.cos(ang + ha);
          arrowBuf[off + 5] = tipY - alen * Math.sin(ang + ha);
          arrowCount++;
        }
      }
    }

    const highlight = hexToPixi(getVizPalette().ring.highlight);

    // 绘制高亮线段
    const segLen = segs.length;
    for (let i = 0; i < segLen; i += 4) {
      hl.moveTo(segs[i], segs[i + 1]).lineTo(segs[i + 2], segs[i + 3]);
    }
    if (segLen > 0) hl.stroke({ width: 2.5, color: highlight, alpha: 1.0 });

    // 绘制高亮箭头
    if (arrowCount > 0) {
      hl.beginPath();
      for (let i = 0; i < arrowCount; i++) {
        const off = i * 6;
        hl.moveTo(arrowBuf[off], arrowBuf[off + 1]);
        hl.lineTo(arrowBuf[off + 2], arrowBuf[off + 3]);
        hl.lineTo(arrowBuf[off + 4], arrowBuf[off + 5]);
        hl.closePath();
      }
      hl.fill({ color: highlight, alpha: 1.0 });
    }
  }

  // ── 交互:拖拽/平移 ──
  function onStagePointerDown(e: FederatedPointerEvent) {
    // 仅背景(目标是 stage)触发平移
    if (e.target !== appRef.current?.stage) return;
    const g = e.global;
    dragStateRef.current = {
      mode: 'pan',
      lastGlobal: { x: g.x, y: g.y },
      downGlobal: { x: g.x, y: g.y },
      moved: false,
      downTime: Date.now(),
    };
  }

  function onNodePointerDown(e: FederatedPointerEvent, node: PGNode) {
    e.stopPropagation();
    const world = worldRef.current;
    if (!world) return;
    const g = e.global;
    const graphPos = world.toLocal(g);
    dragStateRef.current = {
      mode: 'node',
      node,
      offsetGraph: { x: node.x! - graphPos.x, y: node.y! - graphPos.y },
      downGlobal: { x: g.x, y: g.y },
      moved: false,
      downTime: Date.now(),
    };
    // 通知 Worker:pin 节点 + 提高 alpha 让邻接节点跟随
    workerRef.current?.postMessage({ type: 'pin', id: node.id, x: node.x!, y: node.y! });
    // 拖拽期间禁用 bbox 力(在 worker 内),让节点及其邻居可自由移动到任意位置
    bboxEnabledRef.current = false;
    workerRef.current?.postMessage({ type: 'bboxEnabled', enabled: false });
    // 主线程镜像 fx/fy(用于 pinned ring 指示 + dragMove 偏移计算)
    node.fx = node.x;
    node.fy = node.y;
  }

  function onGlobalPointerMove(e: FederatedPointerEvent) {
    const ds = dragStateRef.current;
    if (ds.mode === 'none') return;
    const g = e.global;
    const world = worldRef.current;
    if (!world) return;

    if (ds.mode === 'pan') {
      const last = ds.lastGlobal!;
      const dx = g.x - last.x;
      const dy = g.y - last.y;
      if (Math.abs(g.x - ds.downGlobal!.x) > 3 || Math.abs(g.y - ds.downGlobal!.y) > 3) ds.moved = true;
      world.position.x += dx;
      world.position.y += dy;
      ds.lastGlobal = { x: g.x, y: g.y };
      // 平移由 GPU isRenderGroup 处理,边在世界空间中位置不变,无需每帧重绘
      // 边可见性仅在松手后或 zoom 阈值变化时更新
    } else if (ds.mode === 'node' && ds.node) {
      if (Math.abs(g.x - ds.downGlobal!.x) > 3 || Math.abs(g.y - ds.downGlobal!.y) > 3) ds.moved = true;
      const gp = world.toLocal(g);
      let nx = gp.x + ds.offsetGraph!.x;
      let ny = gp.y + ds.offsetGraph!.y;
      // 软视口钳制:先在屏幕空间钳制到窗口边界,再转回图坐标。
      // 这样无论是否有 NVIDIA ShadowPlay 等覆盖层偏移鼠标坐标,节点都能贴到真实窗口边缘。
      const { width: w, height: h } = sizeRef.current;
      const screenPos = world.toGlobal({ x: nx, y: ny });
      const margin = 10;
      if (screenPos.x < margin || screenPos.x > w - margin || screenPos.y < margin || screenPos.y > h - margin) {
        const clampedX = Math.max(margin, Math.min(w - margin, screenPos.x));
        const clampedY = Math.max(margin, Math.min(h - margin, screenPos.y));
        const clamped = world.toLocal({ x: clampedX, y: clampedY });
        nx = clamped.x;
        ny = clamped.y;
      }
      // 主线程立即更新(视觉零延迟)
      ds.node.fx = nx;
      ds.node.fy = ny;
      ds.node.x = nx;
      ds.node.y = ny;
      // RAF 节流:高刷新率显示器(120/240Hz)下将 postMessage 频率对齐到 60fps,
      // 连续 mousemove 合并为单条消息,避免消息风暴
      dragMoveDataRef.current = { id: ds.node.id, x: nx, y: ny };
      if (dragMoveRafRef.current === null) {
        dragMoveRafRef.current = requestAnimationFrame(() => {
          dragMoveRafRef.current = null;
          const d = dragMoveDataRef.current;
          if (d) workerRef.current?.postMessage({ type: 'dragMove', id: d.id, x: d.x, y: d.y });
        });
      }
    }
  }

  function onPointerUp() {
    const ds = dragStateRef.current;
    if (ds.mode === 'node' && ds.node) {
      // 释放 pin:节点不再钉在松手位置,可自由漂浮(符合"像水上漂浮"需求)
      ds.node.fx = undefined;
      ds.node.fy = undefined;
      // 通知 Worker:解除 pin + reheat,让 link force 把网络拉回平衡(保持边长)
      workerRef.current?.postMessage({ type: 'unpin', id: ds.node.id });
      // 恢复 bbox 力
      bboxEnabledRef.current = true;
      workerRef.current?.postMessage({ type: 'bboxEnabled', enabled: true });
      // 只标记被拖节点 dirty(重绘以去掉 pinned ring 指示),不全量 restyleAll
      const v = viewsRef.current.get(ds.node.id);
      if (v) v.dirty = true;
    }
    if (ds.mode === 'pan') {
      // 平移结束后重绘一次边(更新视口剔除)
      linksDirtyRef.current = true;
      if (!ds.moved) onBackgroundClick();
    }
    dragStateRef.current = { mode: 'none', moved: false, downTime: 0 };
  }

  function onNodeTap(e: FederatedPointerEvent, node: PGNode) {
    // Click / Double Click
    const now = Date.now();
    const last = lastClickRef.current;
    if (last.id === node.id && now - last.time < 400) {
      // Double click: Toggle pinned state (Pin/Unpin node)
      const isPinned = node.fx !== undefined && node.fy !== undefined;
      if (isPinned) {
        node.fx = undefined;
        node.fy = undefined;
        workerRef.current?.postMessage({ type: 'unpin', id: node.id });
      } else {
        node.fx = node.x;
        node.fy = node.y;
        workerRef.current?.postMessage({ type: 'pin', id: node.id, x: node.x!, y: node.y! });
      }
      restyleAll();
      workerRef.current?.postMessage({ type: 'reheat', alpha: 0.3 });
      lastClickRef.current = { id: '', time: 0 };
    } else {
      lastClickRef.current = { id: node.id, time: now };
    }
    onNodeClick(node, e);
  }

  // 右键:监听 canvas contextmenu
  // 优化:懒构建空间网格 O(1) 查找最近节点,替代 O(V) 全量遍历(万级节点下从 ~0.2ms → ~0.01ms)
  function onContextMenu(e: MouseEvent) {
    e.preventDefault();
    const world = worldRef.current;
    if (!world) return;
    const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    const g = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const gp = world.toLocal(g);

    // 懒构建空间网格(右键不频繁,构建开销可接受)
    const grid = nodeGridRef.current;
    grid.clear();
    for (const v of viewsRef.current.values()) {
      if (v.node.x == null || v.node.y == null) continue;
      const key = Math.floor(v.node.x / NODE_GRID_CELL) + ',' + Math.floor(v.node.y / NODE_GRID_CELL);
      let arr = grid.get(key);
      if (!arr) { arr = []; grid.set(key, arr); }
      arr.push(v.node.id);
    }

    // 查询鼠标位置所在 cell 及周围 8 个 cell
    const mcx = Math.floor(gp.x / NODE_GRID_CELL);
    const mcy = Math.floor(gp.y / NODE_GRID_CELL);
    let best: PGNode | null = null;
    let bestD = Infinity;
    for (let dcx = -1; dcx <= 1; dcx++) {
      for (let dcy = -1; dcy <= 1; dcy++) {
        const ids = grid.get((mcx + dcx) + ',' + (mcy + dcy));
        if (!ids) continue;
        for (const id of ids) {
          const v = viewsRef.current.get(id);
          if (!v || v.node.x == null || v.node.y == null) continue;
          const d = Math.hypot(v.node.x - gp.x, v.node.y - gp.y);
          if (d < v.radius + 6 && d < bestD) {
            bestD = d;
            best = v.node;
          }
        }
      }
    }
    if (best) {
      onNodeRightClick(best, { ...({} as any), clientX: e.clientX, clientY: e.clientY, preventDefault: () => {} } as any);
    }
  }

  // ── wheel 缩放(缓存 rect 避免每次 getBoundingClientRect 触发 reflow) ──
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const world = worldRef.current;
    const app = appRef.current;
    if (!world || !app) return;
    let rect = canvasRectRef.current;
    if (!rect) {
      rect = app.canvas.getBoundingClientRect();
      canvasRectRef.current = rect;
    }
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    // toLocal 复用临时点
    const gx = world.toLocal({ x: sx, y: sy }, undefined, tmpP1.current);
    const prevZoom = world.scale.x;
    let z = prevZoom * factor;
    z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    if (Math.abs(z - prevZoom) < 0.001) return;
    world.scale.set(z);
    world.position.x = sx - gx.x * z;
    world.position.y = sy - gx.y * z;
    // 缩放跨越阈值时标记边层 dirty(箭头/标签可见性变化)
    if ((prevZoom < 0.35) !== (z < 0.35) || (prevZoom < 0.5) !== (z < 0.5)) {
      linksDirtyRef.current = true;
    }
  }

  // ── 适应屏幕 ──
  function fitToScreen() {
    const world = worldRef.current;
    if (!world) return;
    const nodes = graphData.nodes;
    if (nodes.length === 0) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, sumX = 0, sumY = 0;
    for (const n of nodes) {
      if (n.x == null || n.y == null) continue;
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
      sumX += n.x; sumY += n.y;
    }
    if (!isFinite(minX)) return;
    const cx = sumX / nodes.length;
    const cy = sumY / nodes.length;
    const bboxW = maxX - minX || 1;
    const bboxH = maxY - minY || 1;
    const padding = Math.min(width, height) * 0.15;
    const availW = Math.max(width - padding * 2, 100);
    const availH = Math.max(height - padding * 2, 100);
    let z = Math.min(availW / bboxW, availH / bboxH) * 0.85;
    z = Math.max(MIN_ZOOM, Math.min(z, 1.5));
    world.scale.set(z);
    world.position.x = width / 2 - cx * z;
    world.position.y = height / 2 - cy * z;
  }

  function scheduleFit() {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => fitToScreen());
    });
  }

  // 绑定 contextmenu
  useEffect(() => {
    const app = appRef.current;
    if (!app) return;
    app.canvas.addEventListener('contextmenu', onContextMenu);
    return () => app.canvas.removeEventListener('contextmenu', onContextMenu);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphData]);

  return <div ref={containerRef} className="pixi-graph-host" style={{ width: '100%', height: '100%' }} />;
});
