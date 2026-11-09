/**
 * PixiGraph — 基于 Pixi.js v8 + d3-force 的知识图谱渲染组件
 *
 * 设计要点(对齐 Obsidian 力导向图):
 *  - 2D d3-force 仿真在 Worker 中,按帧驱动:每个显示帧发一次 step、Worker 推进一步并回传
 *    (Transferable 双缓冲),物理与渲染严格同步;布局收敛后 Worker 报告 settled,主线程停止
 *    请求 → 静止的图零开销。不再有永不停止的漂浮或随视口变化的边界力。
 *  - 拖拽节点:以主线程指针位置为准(零延迟),位置随 step 一起交给 Worker;拖拽时加热
 *    (alphaTarget 0.3)让邻居弹性跟随,松手后冷却直至静止
 *  - hover:非邻居节点/边按帧平滑淡出(只改 alpha,不重绘几何)
 *  - Pixi Container(isRenderGroup) 作为相机:平移/缩放在 GPU 上做
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
// The app ships a strict CSP without 'unsafe-eval' (tauri.conf.json). Pixi v8
// generates shader/uniform code with `new Function` unless this polyfill module
// is loaded first, which swaps in eval-free implementations.
import 'pixi.js/unsafe-eval';
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
  z?: number;
  vz?: number;
  fz?: number;
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

// vis-network → d3-force 参数映射(参考 vis-network barnesHut 官方文档):
//   gravitationalConstant: -2000   → chargeStrength: -500   (÷坐标比例²≈4；原注释误写为-22000)
//   centralGravity: 0.3            → centerStrength: 0.05   (×alphaTarget÷damping_vis≈0.05)
//   springLength: 95               → linkDistance: 200      (×坐标比例≈2；原注释误写为120)
//   springConstant: 0.04           → linkStrength: 0.20     (d3 strength 等效换算)
// 阻尼/冷却按 d3 默认(velocityDecay 0.4、alphaDecay 0.0228),布局会静止;linkStrength 滑块是
// d3 默认连线强度(1/较小度数)的倍率,0.20 = 1×;另有弱碰撞力防止节点重叠。见 forceWorker.ts。
export const DEFAULT_FORCE_PARAMS: ForceParams = {
  centerStrength: 0.05,    // vis-network centralGravity=0.3 → ×(alphaTarget/damping_vis)≈0.05；开启后节点自发涌现二维库仑晶体圆形分布
  chargeStrength: -500,    // vis-network gravitationalConstant=-2000(官方值，非注释误写的-22000) ÷ 坐标比例²≈-500
  linkStrength: 0.20,      // vis-network springConstant=0.04 → d3等效≈0.20（原0.50偏高）
  linkDistance: 200,       // vis-network springLength=95 × 坐标比例≈200（原420偏大2倍）
};




// hover 淡出:非邻居节点 / 普通边层的目标不透明度,以及时间常数(ms,约 3τ 完成)
const DIM_NODE_ALPHA = 0.15;
const DIM_LINK_ALPHA = 0.15;
const EDGE_LABEL_ALPHA = 0.85;
const FADE_TAU_MS = 55;

// ── 常量 ────────────────────────────────────────────────────────────
// 力学常量(ALPHA_DECAY / VELOCITY_DECAY / FLOATING_ALPHA / CHARGE_DISTANCE_MAX /
// BBOX_STRENGTH / BBOX_MARGIN / DRAG_ALPHA)已移入 forceWorker.ts

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 15;
const LABEL_SHOW_ZOOM = 0.3;   // 缩放高于此值显示标签
const LABEL_HOVER_FORCE = true;
const SEMANTIC_DASH_ZOOM = 0.6;  // zoom > 0.6 才画语义边虚线,否则实线(38x 段数减少)
const HIDE_LINKS_ZOOM = 0.08;  // zoom < 此值时完全隐藏普通连接线(点云/星系宏观模式)

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
  // 按帧驱动的仿真:simActive=是否还需要 step;awaitingStep=已发出 step 尚未收到回包;
  // simGen=每次唤醒(拖拽/调参/重建)自增,过期回包的 settled 不能让刚唤醒的仿真停下。
  const simActiveRef = useRef(false);
  const awaitingStepRef = useRef(false);
  const simGenRef = useRef(0);
  // hover 淡出动画进行中(收敛后停止逐帧插值)
  const fadeActiveRef = useRef(false);
  // 有节点被标记 dirty(样式待重绘):onTick 据此决定本帧是否遍历节点
  const nodesDirtyRef = useRef(true);
  // 上次绘制边时用的剔除范围(图坐标)
  const drawnEdgeBoundsRef = useRef({ minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
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
  // 记录上一次 pointerup 是否来自拖拽(moved=true),用于在 onNodeTap 中跳过双击 pin。
  // Pixi.js 的 pointertap 在 pointerup 后触发,且不区分「纯点击」和「拖拽后释放」,
  // 若不跳过,快速连续拖拽同一节点会误触发双击 → 永久 pin 该节点。
  const wasDragMovedRef = useRef(false);
  // 力参数 ref(rebuildGraph 闭包读取最新值)
  const forceParamsRef = useRef(forceParams);
  // 边索引:rebuildGraph 时构建,drawHighlightEdges 用邻接表 O(degree) 查找替代 O(E) 全量遍历
  const edgeIndexByPairRef = useRef<Map<string, number>>(new Map());
  // 上一次 rebuild 时的节点位置缓存,用于时间滑块等增量更新场景:
  // 保留已有节点位置,避免全量重新随机分布导致的网络剧烈震荡。
  const prevPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  // 空间网格:onContextMenu 时懒构建,O(1) 查找最近节点(替代 O(V) 全量遍历)
  const nodeGridRef = useRef<Map<string, string[]>>(new Map());
  const NODE_GRID_CELL = 200;

  /** Ask the worker for steps again (after a drag, a parameter change or a rebuild). */
  function wakeSim() {
    simActiveRef.current = true;
    simGenRef.current++;
  }

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
    if (prevHovered?.id !== hoveredNode?.id) {
      // 变暗/恢复由 onTick 逐帧插值 alpha 完成(所有节点一致,不重绘几何);
      // 只有新旧 hover 节点本身需要重绘光晕/外环。
      fadeActiveRef.current = true;
      if (hoveredNode && linkHighlightRef.current) linkHighlightRef.current.alpha = 0;
      for (const id of [prevHovered?.id, hoveredNode?.id]) {
        const v = id ? viewsRef.current.get(id) : undefined;
        if (v) v.dirty = true;
      }
      nodesDirtyRef.current = true;
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
      wakeSim();
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
      if (app?.renderer?.background) {
        app.renderer.background.alpha = 0;
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
      const initW = width > 0 ? width : (containerRef.current?.clientWidth || window.innerWidth);
      const initH = height > 0 ? height : (containerRef.current?.clientHeight || window.innerHeight);
      await app.init({
        width: initW,
        height: initH,
        backgroundAlpha: 0,
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
      if (host) {
        app.canvas.style.width = '100%';
        app.canvas.style.height = '100%';
        app.canvas.style.display = 'block';
        host.appendChild(app.canvas);
      }

      // world 容器(相机),用 renderGroup 让平移/缩放在 GPU 做
      const world = new Container({ isRenderGroup: true });
      app.stage.addChild(world);
      worldRef.current = world;
      
      // 初始隐藏 world，等布局稳定后再显示，避免闪烁
      world.alpha = 0;

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

      // wheel 缩放 & contextmenu
      if (app.canvas) {
        app.canvas.addEventListener('wheel', onWheel, { passive: false });
        app.canvas.addEventListener('contextmenu', onContextMenu);
      }

      // 创建 Worker:d3-force 物理仿真在 worker 线程跑,主线程零阻塞
      const worker = new Worker(new URL('./forceWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent) => {
        const data = e.data;
        if (data.type === 'positions') {
          nodePositionsRef.current = data.buffer as Float32Array;
          linksDirtyRef.current = true;
          // Replies to `step` carry gen; the initial/warm-up positions after `init` do not.
          if (data.gen !== undefined) {
            awaitingStepRef.current = false;
            if (data.settled && data.gen === simGenRef.current) simActiveRef.current = false;
          }
        }
      };
      workerRef.current = worker;

      // 初始构建 + 仿真
      rebuildGraph();

      // Pixi Ticker:每帧更新节点视觉位置 + 漂浮 + 边层按需重绘
    app.ticker.add(onTick);

    // resize / scroll 时清除缓存的 canvas rect

      // 初始适应屏幕 - 使用智能预设 + 渐进式 reveal
      // 1. 先根据节点数量设置一个合理的初始缩放（避免过大/过小）
      const initialZoom = calculateInitialZoom(graphData.nodes.length);
      world.scale.set(initialZoom);
      world.position.x = width / 2;
      world.position.y = height / 2;
      
      // 2. 等待布局稳定后再调整到最佳视角并淡入显示（只执行一次）
      let stabilityFrames = 0;
      let hasFitted = false;
      const checkStability = () => {
        if (hasFitted) return; // 防止重复执行
        stabilityFrames++;
        // Worker 在首帧前已预跑布局,这里只需等几帧让第一批位置到达
        if (stabilityFrames >= 8) {
          hasFitted = true;
          fitToScreen();
          // 淡入显示
          fadeInWorld();
        } else {
          requestAnimationFrame(checkStability);
        }
      };
      requestAnimationFrame(checkStability);
    };
    mount();

    return () => {
      destroyed = true;
      simActiveRef.current = false;
      const app = appRef.current;
      if (app) {
        if (app.canvas) {
          app.canvas.removeEventListener('wheel', onWheel);
          app.canvas.removeEventListener('contextmenu', onContextMenu);
        }
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

    // 保存当前节点位置(用于增量更新时保留已有节点位置)
    const savedPositions = new Map<string, { x: number; y: number }>();
    for (const [id, v] of viewsRef.current) {
      if (v.node.x != null && v.node.y != null) {
        savedPositions.set(id, { x: v.node.x, y: v.node.y });
      }
    }
    prevPositionsRef.current = savedPositions;

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
      t.alpha = EDGE_LABEL_ALPHA;
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
    // 计算已有节点的质心,用作无邻居新节点的回退放置位置
    let centroidX = 0, centroidY = 0, centroidCount = 0;
    for (const sp of savedPositions.values()) {
      centroidX += sp.x; centroidY += sp.y; centroidCount++;
    }
    if (centroidCount > 0) {
      centroidX /= centroidCount;
      centroidY /= centroidCount;
    } else {
      centroidX = 0; centroidY = 0;
    }

    for (const n of nodes) {
      const saved = savedPositions.get(n.id);
      if (saved) {
        // 已有节点:保留之前的位置(零扰动)
        n.x = saved.x;
        n.y = saved.y;
      } else {
        // 新节点:放置在已定位邻居的质心附近,最大程度减少初始扰动
        const neighbors = adj.get(n.id);
        let nx = 0, ny = 0, nc = 0;
        if (neighbors) {
          for (const nid of neighbors) {
            const sp = savedPositions.get(nid);
            if (sp) { nx += sp.x; ny += sp.y; nc++; }
          }
        }
        if (nc > 0) {
          // 有已定位邻居:放在邻居质心附近,加小随机偏移避免重叠
          n.x = nx / nc + (Math.random() - 0.5) * 30;
          n.y = ny / nc + (Math.random() - 0.5) * 30;
        } else {
          // 无已定位邻居:放在全局质心附近
          n.x = centroidX + (Math.random() - 0.5) * 100;
          n.y = centroidY + (Math.random() - 0.5) * 100;
        }
      }
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
    // 温启动:之前有节点位置,说明是增量更新(如时间滑块),保留位置、低 alpha,避免整图震荡。
    // 冷启动:不传坐标,由 d3 的初始分布 + Worker 首帧前预跑决定布局。
    const warm = savedPositions.size > 0;
    workerRef.current?.postMessage({
      type: 'init',
      dims: 2,
      stepped: true,
      nodes: nodes.map(n => ({
        id: n.id,
        r: viewsRef.current.get(n.id)?.radius ?? 8,
        ...(warm ? { x: n.x, y: n.y } : {}),
      })),
      links: links.map(l => ({
        source: typeof l.source === 'string' ? l.source : l.source.id,
        target: typeof l.target === 'string' ? l.target : l.target.id,
        edge_type: l.edge_type, weight: l.weight, label: l.label,
      })),
      params: fp,
      warm,
    });
    awaitingStepRef.current = false;
    wakeSim();

    linksDirtyRef.current = true; // rebuild 后首次必然需要重绘

    restyleAll();
    drawLinks();
  }

  // ── 每帧:应用 Worker 位置 → 请求下一步仿真 → hover 淡出 → 视口剔除 / 标签 LOD → 按需重绘边 ──
  const lastCameraRef = useRef({ x: NaN, y: NaN, s: NaN, w: 0, h: 0 });
  function onTick() {
    const world = worldRef.current;
    const linkLayer = linkLayerRef.current;
    if (!world) return;

    // 更新 liveBoundsRef(当前视角图坐标,用最新尺寸 + 复用临时 Point)
    const { width: w, height: h } = sizeRef.current;
    world.toLocal({ x: 0, y: 0 }, undefined, tmpP1.current);
    world.toLocal({ x: w, y: h }, undefined, tmpP2.current);
    const pad = 20 / Math.max(world.scale.x, 0.0001);
    const lb = liveBoundsRef.current;
    lb.minX = tmpP1.current.x + pad;
    lb.maxX = tmpP2.current.x - pad;
    lb.minY = tmpP1.current.y + pad;
    lb.maxY = tmpP2.current.y - pad;

    const views = idx2viewRef.current;
    const n = views.length;
    const ds = dragStateRef.current;
    const dragNode = ds.mode === 'node' ? ds.node ?? null : null;

    // 1. Worker 位置写入(被拖节点以主线程指针位置为准,不被回包覆盖 → 零延迟跟手)
    const pos = nodePositionsRef.current;
    if (pos) {
      const stride = pos.length === n * 3 ? 3 : 2;
      for (let i = 0; i < n; i++) {
        const v = views[i];
        if (!v || v.node === dragNode) continue;
        v.node.x = pos[i * stride];
        v.node.y = pos[i * stride + 1];
      }
    }

    // 2. 每个显示帧最多请求一步仿真;缓冲区转移回 Worker 复用(双缓冲,无拷贝)
    const worker = workerRef.current;
    if (worker && (simActiveRef.current || dragNode) && !awaitingStepRef.current) {
      awaitingStepRef.current = true;
      const msg: { type: 'step'; gen: number; drag?: { id: string; x: number; y: number }; buffer?: Float32Array } =
        { type: 'step', gen: simGenRef.current };
      if (dragNode) msg.drag = { id: dragNode.id, x: dragNode.x!, y: dragNode.y! };
      if (pos) {
        msg.buffer = pos;
        worker.postMessage(msg, [pos.buffer]);
      } else {
        worker.postMessage(msg);
      }
    }
    nodePositionsRef.current = null;

    // 3. 本帧是否需要遍历节点:位置变了、相机变了、正在淡出,或有节点样式待重绘
    const cam = lastCameraRef.current;
    const cameraMoved = cam.x !== world.position.x || cam.y !== world.position.y || cam.s !== world.scale.x || cam.w !== w || cam.h !== h;
    if (cameraMoved) {
      cam.x = world.position.x; cam.y = world.position.y; cam.s = world.scale.x; cam.w = w; cam.h = h;
      const db = drawnEdgeBoundsRef.current;
      if (lb.minX < db.minX || lb.maxX > db.maxX || lb.minY < db.minY || lb.maxY > db.maxY) {
        linksDirtyRef.current = true;
      }
    }
    const fading = fadeActiveRef.current;
    if (pos || dragNode || cameraMoved || fading || nodesDirtyRef.current) {
      nodesDirtyRef.current = false;
      const zoom = world.scale.x;
      const showLabels = zoom >= LABEL_SHOW_ZOOM;
      const cullMinX = lb.minX - 100, cullMaxX = lb.maxX + 100;
      const cullMinY = lb.minY - 100, cullMaxY = lb.maxY + 100;
      const hoveredId = styleStateRef.current.hoveredNode?.id;
      const nb = neighborSetRef.current;
      const k = 1 - Math.exp(-(appRef.current?.ticker.deltaMS ?? 16.7) / FADE_TAU_MS);
      let stillFading = false;
      const approach = (a: number, target: number) => {
        if (a === target) return a;
        const next = a + (target - a) * k;
        if (Math.abs(target - next) < 0.01) return target;
        stillFading = true;
        return next;
      };

      for (let i = 0; i < n; i++) {
        const v = views[i];
        if (!v) continue;
        const x = v.node.x!;
        const y = v.node.y!;
        v.container.x = x;
        v.container.y = y;
        // hover:非邻居平滑淡出(所有节点一致,只改 alpha)
        if (fading) v.container.alpha = approach(v.container.alpha, !hoveredId || nb.has(v.node.id) ? 1 : DIM_NODE_ALPHA);
        const visible = x >= cullMinX && x <= cullMaxX && y >= cullMinY && y <= cullMaxY;
        v.container.visible = visible;
        if (!visible) continue;
        // 标签 LOD:缩放足够时全部显示;hover 时强制显示 hover 节点与邻居的标签
        v.label.visible = showLabels || (LABEL_HOVER_FORCE && !!hoveredId && nb.has(v.node.id));
        if (v.dirty) drawNode(v, zoom);
      }

      if (fading) {
        if (linkLayer) linkLayer.alpha = approach(linkLayer.alpha, hoveredId ? DIM_LINK_ALPHA : 1);
        const hl = linkHighlightRef.current;
        if (hl) hl.alpha = approach(hl.alpha, 1);
        const seen = new Set<string>();
        for (const m of linkMetaRef.current) {
          if (!m.displayLabel || seen.has(m.labelKey)) continue;
          seen.add(m.labelKey);
          const t = linkLabelRef.current.get(m.labelKey);
          if (!t) continue;
          const incident = !!hoveredId && (m.s.id === hoveredId || m.t.id === hoveredId);
          t.alpha = approach(t.alpha, !hoveredId ? EDGE_LABEL_ALPHA : incident ? 1 : 0.08);
        }
        if (!stillFading) fadeActiveRef.current = false;
      }
    }

    // 4. 边层按需重绘:位置变化 / 拖拽 / 相机越过剔除边界后才重绘;hover 只重绘高亮层
    if (linkLayer && (linksDirtyRef.current || dragNode)) {
      drawLinks();
      drawHighlightEdges();
      linksDirtyRef.current = false;
      linksHighlightDirtyRef.current = false;
    } else if (linkLayer && linksHighlightDirtyRef.current) {
      drawHighlightEdges();
      linksHighlightDirtyRef.current = false;
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
    nodesDirtyRef.current = true;
  }

  // ── 绘制单个节点 glow/body/ring (LOD: 低缩放跳过 glow/ring) ──
  function drawNode(v: NodeView, zoom: number) {
    v.dirty = false;
    const st = styleStateRef.current;
    const hovered = st.hoveredNode?.id === v.node.id;
    // hover 变暗不在这里画:onTick 对 container.alpha 做平滑插值,几何与 hover 无关
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
    v.body.circle(0, 0, r).fill({ color: colorN, alpha: 1 });
    if (!isLowDetail) {
      v.body.circle(0, 0, r).stroke({ width: 1.5, color: colorN, alpha: 0.6 });
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
    const world = worldRef.current;
    const zoom = world?.scale.x ?? 1;
    const showLabels = zoom >= LABEL_SHOW_ZOOM;
    const showArrows = zoom > 0.35;

    // LOD 极小缩放优化:点云/星系宏观模式下完全跳过连接线绘制,大幅提升帧率
    const db = drawnEdgeBoundsRef.current;
    if (zoom < HIDE_LINKS_ZOOM) {
      const linkLayer = linkLayerRef.current;
      if (linkLayer) linkLayer.clear();
      // 空范围:相机一动就会重新判断(放大回来时边能重新出现)
      db.minX = Infinity; db.maxX = -Infinity; db.minY = Infinity; db.maxY = -Infinity;
      return;
    }

    const b = liveBoundsRef.current;
    const minX = b.minX - 200, maxX = b.maxX + 200;
    const minY = b.minY - 200, maxY = b.maxY + 200;
    // 记录本次剔除范围:相机移出这个范围时 onTick 会触发重绘(仿真静止后边不会自动重画)
    db.minX = minX; db.maxX = maxX; db.minY = minY; db.maxY = maxY;

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

      // 基础层与 hover 无关:hover 时整层 alpha 平滑淡出(onTick),相连的边在高亮层上重画
      const isHL = false;
      const color = m.color;
      const w = m.width;
      const alpha = m.isSemantic ? 0.6 : 1.0;

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

      // 边标签(透明度由 onTick 的 hover 淡出管理)
      if (showLabels) {
        const labelObj = linkLabelRef.current.get(m.labelKey);
        if (labelObj) {
          labelObj.position.set((sx + tx) / 2, (sy + ty) / 2);
          labelObj.visible = true;
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
    // 通知 Worker:pin 节点 + 加热(alphaTarget 0.3)让邻接节点弹性跟随
    workerRef.current?.postMessage({ type: 'pin', id: node.id, x: node.x!, y: node.y! });
    wakeSim();
    // 主线程镜像 fx/fy(用于 pinned ring 指示)
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
      // 主线程立即更新(视觉零延迟);onTick 不会用 Worker 回包覆盖被拖节点,
      // 位置随下一帧的 step 消息交给 Worker(天然按帧合并,不会出现消息风暴或乱序)
      ds.node.fx = nx;
      ds.node.fy = ny;
      ds.node.x = nx;
      ds.node.y = ny;
      linksDirtyRef.current = true;
    }
  }

  function onPointerUp() {
    const ds = dragStateRef.current;
    // 保存 moved 状态供 onNodeTap 判断(pointertap 在 pointerup 之后触发,
    // 此时 dragStateRef 已被重置,无法直接读取)
    wasDragMovedRef.current = ds.moved;
    if (ds.mode === 'node' && ds.node) {
      // 释放 pin:节点留在松手处、不回弹;Worker 冷却(alphaTarget 0),
      // link force 把网络拉回平衡后整图静止。拖拽状态在本函数末尾清空,
      // 之后的 step 不再携带 drag,不会出现“松手后又被钉住”的乱序问题。
      ds.node.fx = undefined;
      ds.node.fy = undefined;
      workerRef.current?.postMessage({ type: 'unpin', id: ds.node.id });
      wakeSim();
      // 只标记被拖节点 dirty(重绘以去掉 pinned ring 指示),不全量 restyleAll
      const v = viewsRef.current.get(ds.node.id);
      if (v) v.dirty = true;
      nodesDirtyRef.current = true;
    }
    if (ds.mode === 'pan') {
      // 平移结束后重绘一次边(更新视口剔除)
      linksDirtyRef.current = true;
      if (!ds.moved) onBackgroundClick();
    }
    dragStateRef.current = { mode: 'none', moved: false, downTime: 0 };
  }

  function onNodeTap(e: FederatedPointerEvent, node: PGNode) {
    // 拖拽后的 pointertap 不触发双击 pin(避免快速连续拖拽同一节点误触发固定)
    if (wasDragMovedRef.current) {
      wasDragMovedRef.current = false;
      // 拖拽不算点击,重置双击检测窗口,避免后续点击误判为双击
      lastClickRef.current = { id: '', time: 0 };
      onNodeClick(node, e);
      return;
    }
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
        // 双击固定不是拖拽:固定后立刻冷却,否则 alphaTarget 停在 0.3,整图永不静止
        workerRef.current?.postMessage({ type: 'release' });
      }
      restyleAll();
      workerRef.current?.postMessage({ type: 'reheat', alpha: 0.1 });
      wakeSim();
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
    if (!world || !app || !app.canvas) return;
    let rect = canvasRectRef.current;
    if (!rect) {
      rect = app.canvas.getBoundingClientRect();
      canvasRectRef.current = rect;
    }
    if (!rect) return;
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
    // 缩放跨越阈值时标记边层 dirty(箭头/标签/虚线/隐藏连线的 LOD 变化)
    const crossed = (t: number) => (prevZoom < t) !== (z < t);
    if (crossed(0.3) || crossed(0.5)) restyleAll(); // 节点 LOD(光晕/外环/星标)
    if (crossed(0.35) || crossed(0.5) || crossed(SEMANTIC_DASH_ZOOM) || crossed(HIDE_LINKS_ZOOM) || crossed(LABEL_SHOW_ZOOM)) {
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
    const padding = Math.min(width, height) * 0.12; // 减小边距，让图谱更大
    const availW = Math.max(width - padding * 2, 100);
    const availH = Math.max(height - padding * 2, 100);
    let z = Math.min(availW / bboxW, availH / bboxH) * 0.9; // 增加填充比例
    
    // 对于小图谱（节点数少于10），允许更大的初始缩放
    const isSmallGraph = nodes.length < 10;
    const maxInitialZoom = isSmallGraph ? 2.5 : 1.2; // 小图谱允许更大缩放，大图谱更小
    z = Math.max(MIN_ZOOM, Math.min(z, maxInitialZoom));
    
    // 确保至少能看到整个图谱的 80%
    if (z > 1.5 && !isSmallGraph) {
      z = Math.max(0.8, z * 0.7); // 对于大图谱，进一步缩小以适应屏幕
    }
    
    world.scale.set(z);
    world.position.x = width / 2 - cx * z;
    world.position.y = height / 2 - cy * z;
  }

  function scheduleFit() {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => fitToScreen());
    });
  }

  // ── 智能初始缩放计算（基于节点数量）──
  function calculateInitialZoom(nodeCount: number): number {
    // 根据节点数量返回一个合理的初始缩放值
    // 避免初始显示过大或过小
    if (nodeCount <= 1) return 1.5;
    if (nodeCount <= 3) return 1.2;
    if (nodeCount <= 5) return 1.0;
    if (nodeCount <= 10) return 0.8;
    if (nodeCount <= 20) return 0.6;
    if (nodeCount <= 50) return 0.4;
    return 0.3; // 大量节点时进一步缩小
  }

  // ── 淡入显示 world ──
  function fadeInWorld() {
    const world = worldRef.current;
    if (!world) return;
    
    const duration = 400; // 400ms 淡入
    const startTime = performance.now();
    const startAlpha = world.alpha;
    
    const animate = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // 使用 ease-out 缓动
      const easeProgress = 1 - Math.pow(1 - progress, 3);
      world.alpha = startAlpha + (1 - startAlpha) * easeProgress;
      
      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };
    requestAnimationFrame(animate);
  }

  return <div ref={containerRef} className="pixi-graph-host" style={{ width: '100%', height: '100%' }} />;
});
