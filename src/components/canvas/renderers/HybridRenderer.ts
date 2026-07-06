/**
 * 混合渲染器 - 根据节点数量自动选择最优渲染后端
 * 
 * 自动切换策略:
 * - 0-3000 节点: Canvas 2D (DOM 交互完整)
 * - 3000-5000 节点: Canvas 2D (简化渲染)
 * - 5000+ 节点: WebGL (GPU 加速)
 * 
 * 手动切换:
 * - 调用 switchTo(RenderBackend.CANVAS_2D) 或 switchTo(RenderBackend.WEBGL)
 */

import type { GraphNode, GraphEdge, Viewport, RendererStats } from './types';
import { LODLevel, RenderBackend, type IGraphRenderer } from './types';
import { Canvas2DRenderer } from './Canvas2DRenderer';
import { WebGLRenderer } from './WebGLRenderer';

export class HybridRenderer {
  private container: HTMLElement;
  private currentBackend: RenderBackend = RenderBackend.CANVAS_2D;
  private canvas2d: Canvas2DRenderer | null = null;
  private webgl: WebGLRenderer | null = null;
  private activeRenderer: Canvas2DRenderer | WebGLRenderer | null = null;
  
  // 配置
  private switchThreshold = 3000; // 节点数阈值
  private manualBackend: RenderBackend | null = null; // 手动指定的后端
  
  // 数据缓存
  private nodes: GraphNode[] = [];
  private edges: GraphEdge[] = [];
  private viewport: Viewport = { x: 0, y: 0, width: 800, height: 600, zoom: 1 };
  
  // 事件回调
  private onStatsUpdate?: (stats: RendererStats) => void;

  constructor(container: HTMLElement, switchThreshold = 3000) {
    this.container = container;
    this.switchThreshold = switchThreshold;
  }

  /** 初始化渲染器 */
  async initialize(canvas: HTMLCanvasElement): Promise<void> {
    // 创建 Canvas 2D 渲染器
    this.canvas2d = new Canvas2DRenderer(this.container);
    this.canvas2d.initialize(canvas);
    
    // 默认使用 Canvas 2D
    this.activeRenderer = this.canvas2d;
    this.currentBackend = RenderBackend.CANVAS_2D;
    
    // 同步数据
    if (this.nodes.length > 0) {
      this.canvas2d.setNodes(this.nodes);
      this.canvas2d.setEdges(this.edges);
      this.canvas2d.setViewport(this.viewport);
    }
  }

  /** 销毁所有渲染器 */
  destroy(): void {
    this.canvas2d?.destroy();
    this.webgl?.destroy();
    this.canvas2d = null;
    this.webgl = null;
    this.activeRenderer = null;
  }

  /** 手动切换渲染后端 */
  async switchTo(backend: RenderBackend): Promise<void> {
    if (this.currentBackend === backend && this.activeRenderer) return;
    
    this.manualBackend = backend;
    
    if (backend === RenderBackend.WEBGL) {
      await this.ensureWebGL();
      this.activeRenderer = this.webgl;
      this.currentBackend = RenderBackend.WEBGL;
    } else {
      this.activeRenderer = this.canvas2d;
      this.currentBackend = RenderBackend.CANVAS_2D;
    }
    
    // 同步数据到新渲染器
    this.syncData();
  }

  /** 自动选择最佳后端 */
  private autoSelectBackend(): RenderBackend {
    if (this.manualBackend) return this.manualBackend;
    
    const nodeCount = this.nodes.length;
    if (nodeCount >= this.switchThreshold) {
      return RenderBackend.WEBGL;
    }
    return RenderBackend.CANVAS_2D;
  }

  /** 确保 WebGL 渲染器已创建 */
  private async ensureWebGL(): Promise<void> {
    if (!this.webgl) {
      this.webgl = new WebGLRenderer(this.container);
      const canvas = this.container.querySelector('canvas');
      if (canvas) {
        await this.webgl.initialize(canvas as HTMLCanvasElement);
      }
    }
  }

  /** 同步数据到所有渲染器 */
  private syncData(): void {
    if (this.canvas2d) {
      this.canvas2d.setNodes(this.nodes);
      this.canvas2d.setEdges(this.edges);
      this.canvas2d.setViewport(this.viewport);
    }
    
    if (this.webgl) {
      this.webgl.setNodes(this.nodes);
      this.webgl.setEdges(this.edges);
      this.webgl.setViewport(this.viewport);
    }
  }

  /** 设置节点数据 */
  setNodes(nodes: GraphNode[]): void {
    this.nodes = nodes;
    
    // 自动切换策略
    const targetBackend = this.autoSelectBackend();
    if (targetBackend !== this.currentBackend && !this.manualBackend) {
      this.switchTo(targetBackend);
      return;
    }
    
    // 同步到当前渲染器
    this.activeRenderer?.setNodes(nodes);
  }

  /** 设置边数据 */
  setEdges(edges: GraphEdge[]): void {
    this.edges = edges;
    this.activeRenderer?.setEdges(edges);
  }

  /** 设置视口 */
  setViewport(viewport: Viewport): void {
    this.viewport = viewport;
    this.activeRenderer?.setViewport(viewport);
  }

  /** 更新单个节点位置 (拖拽时使用) */
  updateNodePosition(nodeId: string, x: number, y: number): void {
    // 同步到所有渲染器
    this.canvas2d?.updateNodePosition(nodeId, x, y);
    this.webgl?.updateNodePosition(nodeId, x, y);
    
    // 同时更新本地数据
    const node = this.nodes.find(n => n.id === nodeId);
    if (node) {
      node.x = x;
      node.y = y;
    }
  }

  /** 渲染当前帧 */
  render(): void {
    if (this.activeRenderer instanceof Canvas2DRenderer) {
      (this.activeRenderer as Canvas2DRenderer).render();
    }
    // WebGL 使用 Pixi.js ticker 自动渲染
  }

  /** 调整大小 */
  resize(width: number, height: number): void {
    this.viewport.width = width;
    this.viewport.height = height;
    this.canvas2d?.resize(width, height);
    this.webgl?.resize(width, height);
  }

  /** 获取当前后端类型 */
  getCurrentBackend(): RenderBackend {
    return this.currentBackend;
  }

  /** 获取当前 LOD 级别 */
  getLODLevel(zoom: number, nodeCount: number): LODLevel {
    if (this.activeRenderer instanceof Canvas2DRenderer) {
      return (this.activeRenderer as Canvas2DRenderer).getLODLevel(zoom, nodeCount);
    } else if (this.activeRenderer instanceof WebGLRenderer) {
      return (this.activeRenderer as WebGLRenderer).getLODLevel(zoom, nodeCount);
    }
    return LODLevel.FULL;
  }

  /** 屏幕坐标转画布坐标 */
  screenToCanvas(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: (screenX - this.viewport.x) / this.viewport.zoom,
      y: (screenY - this.viewport.y) / this.viewport.zoom,
    };
  }

  /** 画布坐标转屏幕坐标 */
  canvasToScreen(canvasX: number, canvasY: number): { x: number; y: number } {
    return {
      x: canvasX * this.viewport.zoom + this.viewport.x,
      y: canvasY * this.viewport.zoom + this.viewport.y,
    };
  }

  /** 节点命中检测 */
  pickNode(screenX: number, screenY: number): GraphNode | null {
    if (this.activeRenderer instanceof Canvas2DRenderer) {
      return (this.activeRenderer as Canvas2DRenderer).pickNode(screenX, screenY);
    } else if (this.activeRenderer instanceof WebGLRenderer) {
      return (this.activeRenderer as WebGLRenderer).pickNode(screenX, screenY);
    }
    return null;
  }

  /** 边命中检测 */
  pickEdge(screenX: number, screenY: number): GraphEdge | null {
    if (this.activeRenderer instanceof Canvas2DRenderer) {
      return (this.activeRenderer as Canvas2DRenderer).pickEdge(screenX, screenY);
    } else if (this.activeRenderer instanceof WebGLRenderer) {
      return (this.activeRenderer as WebGLRenderer).pickEdge(screenX, screenY);
    }
    return null;
  }

  /** 获取统计信息 */
  getStats(): RendererStats {
    if (this.activeRenderer instanceof Canvas2DRenderer) {
      return (this.activeRenderer as Canvas2DRenderer).getStats();
    } else if (this.activeRenderer instanceof WebGLRenderer) {
      return (this.activeRenderer as WebGLRenderer).getStats();
    }
    return {
      renderedNodes: 0,
      renderedEdges: 0,
      culledNodes: 0,
      visibleNodes: 0,
      fps: 0,
      backend: this.currentBackend,
      lodLevel: LODLevel.FULL,
    };
  }

  /** 设置统计更新回调 */
  onStats(cb: (stats: RendererStats) => void): void {
    this.onStatsUpdate = cb;
  }

  /** 设置切换阈值 */
  setSwitchThreshold(threshold: number): void {
    this.switchThreshold = threshold;
  }

  /** 清除手动设置，恢复自动选择 */
  clearManualBackend(): void {
    this.manualBackend = null;
    const target = this.autoSelectBackend();
    if (target !== this.currentBackend) {
      this.switchTo(target);
    }
  }
}
