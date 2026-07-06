/**
 * CanvasControls — 浮动在画布左下角的视图控制按钮组 V2
 *
 * 独立于工具栏，手绘/擦除模式下不会被禁用。
 * 包含：缩放 +/-、当前缩放百分比、适配视图、重置缩放、缩放到选中
 */
import { type ReactFlowInstance, type Node } from '@xyflow/react';

interface CanvasControlsProps {
  reactFlowInstance: ReactFlowInstance | null;
  zoom: number;
  lang: string;
  nodes?: Node[];
}

export function CanvasControls({ reactFlowInstance, zoom, lang, nodes = [] }: CanvasControlsProps) {
  const isZh = lang === 'zh';
  const zoomPercent = Math.round(zoom * 100);

  const handleFitView = () => {
    reactFlowInstance?.fitView({ padding: 0.15, duration: 400 });
  };

  const handleZoomIn = () => {
    reactFlowInstance?.zoomTo(zoom + 0.2, { duration: 200 });
  };

  const handleZoomOut = () => {
    reactFlowInstance?.zoomTo(zoom - 0.2, { duration: 200 });
  };

  const handleResetZoom = () => {
    reactFlowInstance?.zoomTo(1, { duration: 300 });
  };

  const handleZoomToSelection = () => {
    const selected = nodes.filter(n => n.selected);
    if (selected.length === 0) {
      reactFlowInstance?.fitView({ padding: 0.15, duration: 400 });
      return;
    }
    reactFlowInstance?.fitView({
      nodes: selected.map(n => ({ id: n.id })),
      padding: 0.3,
      duration: 400,
    });
  };

  const hasSelection = nodes.some(n => n.selected);

  return (
    <div className="canvas-controls">
      <button
        className="canvas-controls-btn"
        onClick={handleZoomOut}
        data-tooltip={isZh ? '缩小' : 'Zoom Out'}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>

      <span className="canvas-controls-zoom" onClick={handleFitView} data-tooltip={isZh ? '适配视图' : 'Fit View'}>
        {zoomPercent}%
      </span>

      <button
        className="canvas-controls-btn"
        onClick={handleZoomIn}
        data-tooltip={isZh ? '放大' : 'Zoom In'}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>

      <div className="canvas-controls-divider" />

      {/* Fit View */}
      <button
        className="canvas-controls-btn"
        onClick={handleFitView}
        data-tooltip={isZh ? '适配视图 (Shift+1)' : 'Fit View (Shift+1)'}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
        </svg>
      </button>

      {/* Zoom to Selection */}
      <button
        className="canvas-controls-btn"
        onClick={handleZoomToSelection}
        data-tooltip={isZh ? '缩放到选中 (Shift+2)' : 'Zoom to Selection (Shift+2)'}
        style={{ opacity: hasSelection ? 1 : 0.4 }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
        </svg>
      </button>

      {/* Reset Zoom */}
      <button
        className="canvas-controls-btn"
        onClick={handleResetZoom}
        data-tooltip={isZh ? '重置缩放 (100%)' : 'Reset Zoom (100%)'}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
        </svg>
      </button>
    </div>
  );
}
