/**
 * Canvas 2D 渲染器 - 支持 0-5000 节点
 * 
 * 特性:
 * - 视口剔除 (Viewport Culling)
 * - LOD 分级渲染
 * - 批量绘制优化
 * - 空间索引加速
 */

import type { GraphNode, GraphEdge, Viewport, RendererStats } from './types';
import { LODLevel, RenderBackend } from './types';
import { SpatialIndex, cullEdges } from './SpatialIndex';

export class Canvas2DRenderer {
  readonly backend = RenderBackend.CANVAS_2D;
  readonly container: HTMLElement;
  
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private spatialIndex: SpatialIndex;
  
  private nodes: GraphNode[] = [];
  private edges: GraphEdge[] = [];
  private viewport: Viewport = { x: 0, y: 0, width: 800, height: 600, zoom: 1 };
  private currentLOD: LODLevel = LODLevel.FULL;
  
  private stats: RendererStats = {
    renderedNodes: 0,
    renderedEdges: 0,
    culledNodes: 0,
    visibleNodes: 0,
    fps: 0,
    backend: RenderBackend.CANVAS_2D,
    lodLevel: LODLevel.FULL,
  };
  
  private lastFrameTime = 0;
  private frameCount = 0;
  private fpsUpdateTime = 0;
  
  // 缓存
  private visibleNodeIds: Set<string> = new Set();
  private visibleNodesCache: GraphNode[] = [];
  private visibleEdgesCache: GraphEdge[] = [];
  private cacheValid = false;

  constructor(container: HTMLElement) {
    this.container = container;
    this.spatialIndex = new SpatialIndex(200);
  }

  initialize(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.resize(canvas.clientWidth, canvas.clientHeight);
  }

  destroy(): void {
    this.ctx = null;
    this.canvas = null;
    this.spatialIndex.clear();
  }

  resize(width: number, height: number): void {
    if (this.canvas) {
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = width * dpr;
      this.canvas.height = height * dpr;
      this.viewport.width = width;
      this.viewport.height = height;
      this.ctx?.scale(dpr, dpr);
      this.invalidateCache();
    }
  }

  setViewport(viewport: Viewport): void {
    const zoomChanged = Math.abs(this.viewport.zoom - viewport.zoom) > 0.001;
    this.viewport = viewport;
    if (zoomChanged) {
      this.currentLOD = this.getLODLevel(viewport.zoom, this.nodes.length);
      this.invalidateCache();
    }
  }

  /** 更新节点数据 */
  setNodes(nodes: GraphNode[]): void {
    this.nodes = nodes;
    this.spatialIndex.bulkLoad(nodes);
    this.currentLOD = this.getLODLevel(this.viewport.zoom, nodes.length);
    this.invalidateCache();
  }

  /** 更新边数据 */
  setEdges(edges: GraphEdge[]): void {
    this.edges = edges;
    this.invalidateCache();
  }

  /** 增量更新单个节点位置 (拖拽时使用) */
  updateNodePosition(nodeId: string, x: number, y: number): void {
    const node = this.nodes.find(n => n.id === nodeId);
    if (node) {
      node.x = x;
      node.y = y;
      this.spatialIndex.updateNode(node);
      this.invalidateCache();
    }
  }

  /** 主渲染函数 */
  render(): void {
    const { ctx, canvas } = this;
    if (!ctx || !canvas) return;

    const now = performance.now();
    this.updateFPS(now);

    // 清空画布
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, this.viewport.width, this.viewport.height);

    // 获取可见节点和边
    this.updateVisibleCache();

    // 绘制顺序: 边 -> 节点 -> 标签
    this.renderEdges(ctx, this.visibleEdgesCache);
    this.renderNodes(ctx, this.visibleNodesCache, this.currentLOD);

    // 更新统计
    this.stats.renderedNodes = this.visibleNodesCache.length;
    this.stats.renderedEdges = this.visibleEdgesCache.length;
    this.stats.culledNodes = this.nodes.length - this.visibleNodesCache.length;
    this.stats.visibleNodes = this.visibleNodesCache.length;
    this.stats.lodLevel = this.currentLOD;
  }

  /** 更新可见节点/边缓存 */
  private updateVisibleCache(): void {
    if (this.cacheValid) return;

    // 基于空间索引的视口剔除
    this.spatialIndex.queryViewport(this.viewport, 150);
    const visibles = this.spatialIndex.getNodesInViewport(this.viewport, 150);
    
    this.visibleNodesCache = visibles;
    this.visibleNodeIds = new Set(visibles.map(n => n.id));
    
    // 边剔除 - 只保留有可见端点的边
    this.visibleEdgesCache = cullEdges(this.edges, this.visibleNodeIds, this.viewport, 150);
    
    this.cacheValid = true;
  }

  private invalidateCache(): void {
    this.cacheValid = false;
  }

  /** 批量绘制节点 */
  private renderNodes(ctx: CanvasRenderingContext2D, nodes: GraphNode[], lod: LODLevel): void {
    switch (lod) {
      case LODLevel.DOT:
        this.renderNodesAsDots(ctx, nodes);
        break;
      case LODLevel.CIRCLE:
        this.renderNodesAsCircles(ctx, nodes);
        break;
      case LODLevel.FULL:
        this.renderNodesFull(ctx, nodes);
        break;
      default:
        this.renderNodesAsDots(ctx, nodes);
    }
  }

  /** LOD: 点 */
  private renderNodesAsDots(ctx: CanvasRenderingContext2D, nodes: GraphNode[]): void {
    const { zoom } = this.viewport;
    const radius = Math.max(2, 4 / zoom);
    
    ctx.beginPath();
    for (const n of nodes) {
      const cx = n.x + n.width / 2;
      const cy = n.y + n.height / 2;
      ctx.moveTo(cx + radius, cy);
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    }
    ctx.fillStyle = '#64748b';
    ctx.fill();
  }

  /** LOD: 圆形 */
  private renderNodesAsCircles(ctx: CanvasRenderingContext2D, nodes: GraphNode[]): void {
    const { zoom } = this.viewport;
    
    for (const n of nodes) {
      const cx = n.x + n.width / 2;
      const cy = n.y + n.height / 2;
      const radius = n.width / 2;
      
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = n.selected ? '#3b82f6' : n.color;
      ctx.fill();
      
      if (n.selected) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }

  /** LOD: 完整 */
  private renderNodesFull(ctx: CanvasRenderingContext2D, nodes: GraphNode[]): void {
    for (const n of nodes) {
      const { x, y, width, height } = n;
      
      // 节点背景
      ctx.beginPath();
      ctx.roundRect(x, y, width, height, 8);
      ctx.fillStyle = n.selected ? '#1e40af' : n.color + '22';
      ctx.fill();
      
      // 边框
      ctx.strokeStyle = n.selected ? '#3b82f6' : n.color;
      ctx.lineWidth = n.selected ? 2 : 1;
      ctx.stroke();
      
      // 标签
      ctx.font = '11px Inter, system-ui, sans-serif';
      ctx.fillStyle = '#f1f5f9';
      ctx.textAlign = 'center';
      ctx.fillText(
        this.truncateLabel(n.label, width),
        x + width / 2,
        y + height / 2 + 4
      );
    }
  }

  /** 批量绘制边 */
  private renderEdges(ctx: CanvasRenderingContext2D, edges: GraphEdge[]): void {
    if (edges.length === 0) return;

    const { zoom } = this.viewport;
    const isSimplified = this.currentLOD <= LODLevel.DOT;

    if (isSimplified) {
      // 简化模式: 单次 Path2D
      ctx.beginPath();
      for (const e of edges) {
        ctx.moveTo(e.sourceX, e.sourceY);
        ctx.lineTo(e.targetX, e.targetY);
      }
      ctx.strokeStyle = 'rgba(100, 116, 139, 0.3)';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      // 完整模式: 支持颜色和标签
      for (const e of edges) {
        ctx.beginPath();
        ctx.moveTo(e.sourceX, e.sourceY);
        ctx.lineTo(e.targetX, e.targetY);
        ctx.strokeStyle = e.color;
        ctx.lineWidth = e.animated ? 2 : 1;
        ctx.stroke();

        if (e.label) {
          const mx = (e.sourceX + e.targetX) / 2;
          const my = (e.sourceY + e.targetY) / 2;
          ctx.font = '10px Inter, system-ui, sans-serif';
          ctx.fillStyle = '#94a3b8';
          ctx.textAlign = 'center';
          ctx.fillText(e.label, mx, my);
        }
      }
    }
  }

  /** LOD 判定 */
  getLODLevel(zoom: number, nodeCount: number): LODLevel {
    if (nodeCount === 0) return LODLevel.INVISIBLE;
    if (zoom < 0.05) return LODLevel.INVISIBLE;
    if (zoom < 0.15 || nodeCount > 3000) return LODLevel.DOT;
    if (zoom < 0.3 || nodeCount > 1000) return LODLevel.CIRCLE;
    return LODLevel.FULL;
  }

  /** 交互: 节点命中检测 */
  pickNode(screenX: number, screenY: number): GraphNode | null {
    const canvasPos = this.screenToCanvas(screenX, screenY);
    return this.spatialIndex.nearest(canvasPos.x, canvasPos.y, 30 / this.viewport.zoom);
  }

  pickEdge(screenX: number, screenY: number): GraphEdge | null {
    const canvasPos = this.screenToCanvas(screenX, screenY);
    const threshold = 5 / this.viewport.zoom;
    
    for (const edge of this.visibleEdgesCache) {
      if (pointToSegmentDistance(canvasPos.x, canvasPos.y, edge.sourceX, edge.sourceY, edge.targetX, edge.targetY) < threshold) {
        return edge;
      }
    }
    return null;
  }

  screenToCanvas(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: (screenX - this.viewport.x) / this.viewport.zoom,
      y: (screenY - this.viewport.y) / this.viewport.zoom,
    };
  }

  canvasToScreen(canvasX: number, canvasY: number): { x: number; y: number } {
    return {
      x: canvasX * this.viewport.zoom + this.viewport.x,
      y: canvasY * this.viewport.zoom + this.viewport.y,
    };
  }

  getStats(): RendererStats {
    return { ...this.stats, fps: Math.round(this.stats.fps) };
  }

  /** FPS 计算 */
  private updateFPS(now: number): void {
    this.frameCount++;
    if (now - this.fpsUpdateTime >= 1000) {
      this.stats.fps = this.frameCount * 1000 / (now - this.fpsUpdateTime);
      this.frameCount = 0;
      this.fpsUpdateTime = now;
    }
  }

  private truncateLabel(label: string, maxWidth: number): string {
    const maxChars = Math.floor(maxWidth / 6);
    if (label.length <= maxChars) return label;
    return label.slice(0, maxChars - 2) + '...';
  }
}

function pointSegmentDistSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = px - ax;
    const ey = py - ay;
    return ex * ex + ey * ey;
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = ax + t * dx;
  const projY = ay + t * dy;
  const ex = px - projX;
  const ey = py - projY;
  return ex * ex + ey * ey;
}

function pointToSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt(pointSegmentDistSq(px, py, ax, ay, bx, by));
}
