/**
 * WebGL 渲染器 - 支持 5000-100,000+ 节点
 * 
 * 使用 Pixi.js 实现 GPU 加速渲染
 * 特性:
 * - ParticleContainer 批量渲染
 * - 视口剔除
 * - LOD 分级
 * - 增量更新
 */

import * as PIXI from 'pixi.js';
import type { GraphNode, GraphEdge, Viewport, RendererStats } from './types';
import { LODLevel, RenderBackend } from './types';
import { SpatialIndex } from './SpatialIndex';
import { getVizPalette, hexToPixi } from '../../../lib/vizPalette';

export class WebGLRenderer {
  readonly backend = RenderBackend.WEBGL;
  readonly container: HTMLElement;
  
  private app: PIXI.Application | null = null;
  private spatialIndex: SpatialIndex;
  
  private nodeContainer: PIXI.Container | null = null;
  private edgeGraphics: PIXI.Graphics | null = null;
  private labelContainer: PIXI.Container | null = null;
  
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
    backend: RenderBackend.WEBGL,
    lodLevel: LODLevel.FULL,
  };
  
  // 节点精灵缓存
  private nodeSprites: Map<string, PIXI.Graphics> = new Map();
  private labelSprites: Map<string, PIXI.Text> = new Map();
  
  // 可见性缓存
  private visibleNodeIds: Set<string> = new Set();
  private visibleNodesCache: GraphNode[] = [];
  private visibleEdgesCache: GraphEdge[] = [];
  private cacheValid = false;
  
  // 渲染循环
  private rafId: number | null = null;
  private lastFrameTime = 0;
  private frameCount = 0;
  private fpsUpdateTime = 0;
  private isRendering = false;

  constructor(container: HTMLElement) {
    this.container = container;
    this.spatialIndex = new SpatialIndex(150);
  }

  async initialize(canvas: HTMLCanvasElement): Promise<void> {
    this.app = new PIXI.Application();
    
    await this.app.init({
      view: canvas,
      width: canvas.clientWidth,
      height: canvas.clientHeight,
      backgroundColor: 0x0f172a,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      preference: 'webgl',
    });

    // 创建渲染层级
    this.edgeGraphics = new PIXI.Graphics();
    this.nodeContainer = new PIXI.Container();
    this.labelContainer = new PIXI.Container();
    
    this.app.stage.addChild(this.edgeGraphics);
    this.app.stage.addChild(this.nodeContainer);
    this.app.stage.addChild(this.labelContainer);
    
    // 启动渲染循环
    this.startRenderLoop();
  }

  destroy(): void {
    this.stopRenderLoop();
    
    if (this.app) {
      this.app.destroy(true, { children: true, texture: true });
      this.app = null;
    }
    
    this.nodeSprites.clear();
    this.labelSprites.clear();
    this.spatialIndex.clear();
  }

  resize(width: number, height: number): void {
    if (this.app) {
      this.app.renderer.resize(width, height);
      this.viewport.width = width;
      this.viewport.height = height;
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

  setNodes(nodes: GraphNode[]): void {
    this.nodes = nodes;
    this.spatialIndex.bulkLoad(nodes);
    this.currentLOD = this.getLODLevel(this.viewport.zoom, nodes.length);
    this.rebuildNodeSprites();
    this.invalidateCache();
  }

  setEdges(edges: GraphEdge[]): void {
    this.edges = edges;
    this.invalidateCache();
  }

  updateNodePosition(nodeId: string, x: number, y: number): void {
    const node = this.nodes.find(n => n.id === nodeId);
    if (node) {
      node.x = x;
      node.y = y;
      this.spatialIndex.updateNode(node);
      
      // 更新精灵位置
      const sprite = this.nodeSprites.get(nodeId);
      if (sprite) {
        sprite.x = x;
        sprite.y = y;
      }
      const label = this.labelSprites.get(nodeId);
      if (label) {
        label.x = x + node.width / 2;
        label.y = y + node.height / 2;
      }
      
      this.invalidateCache();
    }
  }

  /** 重建所有节点精灵 */
  private rebuildNodeSprites(): void {
    if (!this.nodeContainer) return;
    
    // 清除旧精灵
    this.nodeContainer.removeChildren();
    this.labelContainer?.removeChildren();
    this.nodeSprites.clear();
    this.labelSprites.clear();
    
    // 创建新精灵
    for (const node of this.nodes) {
      const sprite = this.createNodeSprite(node);
      this.nodeContainer.addChild(sprite);
      this.nodeSprites.set(node.id, sprite);
      
      if (this.currentLOD >= LODLevel.CIRCLE) {
        const label = this.createLabelSprite(node);
        this.labelContainer?.addChild(label);
        this.labelSprites.set(node.id, label);
      }
    }
  }

  private createNodeSprite(node: GraphNode): PIXI.Graphics {
    const g = new PIXI.Graphics();
    const cx = node.width / 2;
    const cy = node.height / 2;
    const radius = Math.min(node.width, node.height) / 2;
    
    // 解析颜色
    const fallback = hexToPixi(getVizPalette().canvasDefaultEdge);
    const color = parseInt(node.color.replace('#', ''), 16) || fallback;
    
    g.circle(cx, cy, radius);
    g.fill(node.selected ? 0x3b82f6 : color);
    
    if (node.selected) {
      g.circle(cx, cy, radius);
      g.stroke({ width: 2, color: 0xffffff });
    }
    
    g.x = node.x;
    g.y = node.y;
    
    return g;
  }

  private createLabelSprite(node: GraphNode): PIXI.Text {
    const text = new PIXI.Text({
      text: this.truncateLabel(node.label, node.width),
      style: {
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: 11,
        fill: 0xf1f5f9,
        align: 'center',
      },
    });
    text.anchor.set(0.5);
    text.x = node.x + node.width / 2;
    text.y = node.y + node.height / 2;
    return text;
  }

  /** 启动渲染循环 */
  private startRenderLoop(): void {
    if (!this.app || this.isRendering) return;
    this.isRendering = true;
    
    this.app.ticker.add(this.onTick);
  }

  private stopRenderLoop(): void {
    if (this.app) {
      this.app.ticker.remove(this.onTick);
    }
    this.isRendering = false;
  }

  private onTick = (): void => {
    const now = performance.now();
    this.updateFPS(now);
    this.render();
  };

  /** 主渲染 */
  render(): void {
    if (!this.edgeGraphics || !this.nodeContainer) return;
    
    // 更新可见性缓存
    this.updateVisibleCache();
    
    // 绘制边
    this.renderEdges();
    
    // 更新节点可见性
    this.updateNodeVisibility();
    
    // 更新统计
    this.stats.renderedNodes = this.visibleNodesCache.length;
    this.stats.renderedEdges = this.visibleEdgesCache.length;
    this.stats.culledNodes = this.nodes.length - this.visibleNodesCache.length;
    this.stats.visibleNodes = this.visibleNodesCache.length;
    this.stats.lodLevel = this.currentLOD;
  }

  private updateVisibleCache(): void {
    if (this.cacheValid) return;
    
    const visibles = this.spatialIndex.getNodesInViewport(this.viewport, 200);
    this.visibleNodesCache = visibles;
    this.visibleNodeIds = new Set(visibles.map(n => n.id));
    
    // 边剔除
    this.visibleEdgesCache = this.edges.filter(e => 
      this.visibleNodeIds.has(e.source) || this.visibleNodeIds.has(e.target)
    );
    
    this.cacheValid = true;
  }

  private invalidateCache(): void {
    this.cacheValid = false;
  }

  private renderEdges(): void {
    if (!this.edgeGraphics) return;
    
    this.edgeGraphics.clear();
    
    if (this.currentLOD <= LODLevel.DOT) {
      // 批量绘制 - 单线条
      this.edgeGraphics.moveTo(0, 0);
      for (const e of this.visibleEdgesCache) {
        this.edgeGraphics.moveTo(e.sourceX, e.sourceY);
        this.edgeGraphics.lineTo(e.targetX, e.targetY);
      }
      this.edgeGraphics.stroke({ width: 1, color: hexToPixi(getVizPalette().canvasDefaultEdge), alpha: 0.3 });
    } else {
      const fallback = hexToPixi(getVizPalette().canvasDefaultEdge);
      // 单独绘制 - 支持颜色
      for (const e of this.visibleEdgesCache) {
        const color = parseInt(e.color.replace('#', ''), 16) || fallback;
        this.edgeGraphics.moveTo(e.sourceX, e.sourceY);
        this.edgeGraphics.lineTo(e.targetX, e.targetY);
        this.edgeGraphics.stroke({ width: e.animated ? 2 : 1, color });
      }
    }
  }

  private updateNodeVisibility(): void {
    for (const node of this.nodes) {
      const sprite = this.nodeSprites.get(node.id);
      const label = this.labelSprites.get(node.id);
      
      if (sprite) {
        const isVisible = this.visibleNodeIds.has(node.id);
        sprite.visible = isVisible;
        
        // LOD: 缩放时调整大小
        if (this.currentLOD === LODLevel.DOT) {
          const scale = Math.max(0.5, 2 / this.viewport.zoom);
          sprite.scale.set(scale);
        } else {
          sprite.scale.set(1);
        }
      }
      
      if (label) {
        label.visible = this.visibleNodeIds.has(node.id) && this.currentLOD >= LODLevel.CIRCLE;
      }
    }
  }

  getLODLevel(zoom: number, nodeCount: number): LODLevel {
    if (nodeCount === 0) return LODLevel.INVISIBLE;
    if (zoom < 0.03) return LODLevel.INVISIBLE;
    if (zoom < 0.1) return LODLevel.DOT;
    if (zoom < 0.25) return LODLevel.CIRCLE;
    return LODLevel.FULL;
  }

  pickNode(screenX: number, screenY: number): GraphNode | null {
    const canvasPos = this.screenToCanvas(screenX, screenY);
    return this.spatialIndex.nearest(canvasPos.x, canvasPos.y, 40 / this.viewport.zoom);
  }

  pickEdge(screenX: number, screenY: number): GraphEdge | null {
    const canvasPos = this.screenToCanvas(screenX, screenY);
    const threshold = 8 / this.viewport.zoom;
    
    for (const edge of this.visibleEdgesCache) {
      if (this.pointToSegmentDistance(canvasPos.x, canvasPos.y, edge.sourceX, edge.sourceY, edge.targetX, edge.targetY) < threshold) {
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

  private pointToSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) {
      const ex = px - ax;
      const ey = py - ay;
      return Math.sqrt(ex * ex + ey * ey);
    }
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const projX = ax + t * dx;
    const projY = ay + t * dy;
    const ex = px - projX;
    const ey = py - projY;
    return Math.sqrt(ex * ex + ey * ey);
  }
}
