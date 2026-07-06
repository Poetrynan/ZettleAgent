/**
 * 混合渲染器类型定义
 * 
 * 渲染层级:
 * - Canvas 2D: 0-5000 节点，DOM 交互完整
 * - WebGL (Pixi.js): 5000+ 节点，GPU 加速
 */

import type { Node, Edge } from '@xyflow/react';

export interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
  zoom: number;
}

export interface GraphNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  color: string;
  type: string;
  selected: boolean;
  data?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  color: string;
  label?: string;
  animated?: boolean;
}

export enum LODLevel {
  /** 不渲染 */
  INVISIBLE = 0,
  /** 聚合点 */
  CLUSTER = 1,
  /** 小圆点 */
  DOT = 2,
  /** 圆形 + 标签 */
  CIRCLE = 3,
  /** 完整渲染 */
  FULL = 4,
}

export enum RenderBackend {
  CANVAS_2D = 'canvas2d',
  WEBGL = 'webgl',
}

export interface RenderContext {
  ctx?: CanvasRenderingContext2D;
  viewport: Viewport;
  lod: LODLevel;
  hoveredNodeId?: string;
  selectedNodeIds: Set<string>;
}

export interface RendererStats {
  renderedNodes: number;
  renderedEdges: number;
  culledNodes: number;
  visibleNodes: number;
  fps: number;
  backend: RenderBackend;
  lodLevel: LODLevel;
}

export interface IGraphRenderer {
  readonly backend: RenderBackend;
  readonly container: HTMLElement;
  
  initialize(canvas: HTMLCanvasElement): void;
  destroy(): void;
  
  render(nodes: GraphNode[], edges: GraphEdge[]): void;
  resize(width: number, height: number): void;
  
  setViewport(viewport: Viewport): void;
  getLODLevel(zoom: number, nodeCount: number): LODLevel;
  
  screenToCanvas(screenX: number, screenY: number): { x: number; y: number };
  canvasToScreen(canvasX: number, canvasY: number): { x: number; y: number };
  
  getStats(): RendererStats;
  
  pickNode(screenX: number, screenY: number): GraphNode | null;
  pickEdge(screenX: number, screenY: number): GraphEdge | null;
}
