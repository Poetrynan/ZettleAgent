/**
 * 渲染器模块导出
 * 
 * 使用示例:
 * ```typescript
 * import { HybridRenderer, RenderBackend } from './renderers';
 * 
 * const renderer = new HybridRenderer(container);
 * await renderer.initialize(canvas);
 * renderer.setNodes(nodes);
 * renderer.setEdges(edges);
 * ```
 */

export * from './types';
export { SpatialIndex, cullNodes, cullEdges } from './SpatialIndex';
export { Canvas2DRenderer } from './Canvas2DRenderer';
export { WebGLRenderer } from './WebGLRenderer';
export { HybridRenderer } from './HybridRenderer';
