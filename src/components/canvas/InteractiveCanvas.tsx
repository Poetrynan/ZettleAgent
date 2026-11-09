/**
 * ZettelAgent Interactive Whiteboard Canvas Component
 * Fully compatible with Obsidian's .canvas JSON schema.
 * Orchestrates extracted hooks and sub-components for maintainability.
 */
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  ReactFlow,
  MiniMap,
  Background,
  useNodesState,
  useEdgesState,
  ConnectionMode,
  Edge,
  Node,
  ReactFlowProvider,
  useReactFlow,
  useOnViewportChange,
  MarkerType,
  type Viewport,
  NodeChange,
} from '@xyflow/react';

import '@xyflow/react/dist/style.css';
import '../../styles/InteractiveCanvas.css';

import { useApp } from '../../contexts/AppContext';
import { NoteNode } from './NoteNode';
import { TextNode } from './TextNode';
import { GroupNode } from './GroupNode';
import { ImageNode } from './ImageNode';
import { PdfNode } from './PdfNode';
import { WebNode } from './WebNode';
import { GhostEdge } from './GhostEdge';
import { searchChunks, agentChat, getKnowledgeGraph } from '../../lib/tauri';
import { listen } from '@tauri-apps/api/event';
import { useCanvasPaste } from './useCanvasPaste';
import { t, tf } from '../../lib/i18n';
import { AgentPanel } from '../common/AgentPanel';
import { useCanvasWatcher } from './useCanvasWatcher';
import { useHelperLines } from './useHelperLines';
import { CanvasTopBar, CanvasDock, CanvasReviewBar, SelectionBar } from './CanvasChrome';
import { CanvasConnectionLine } from './CanvasConnectionLine';
import { SnapGuides } from './SnapGuides';

import { getNoteColorMap, METHODOLOGY_TYPES, mapNoteType } from '../dashboard/graphHelpers';
import { useVizTheme } from '../../lib/useVizTheme';
import { getVizPalette } from '../../lib/vizPalette';
import { FreehandOverlay } from './FreehandOverlay';
import type { PenMode, FreehandOverlayHandle } from './FreehandOverlay';
import { CanvasControls } from './CanvasControls';
import { SmartCanvasPanel } from './SmartCanvasPanel';
import { CanvasPlanPanel } from './CanvasPlanPanel';
import { CanvasModals } from './CanvasModals';
import { ProgressPanel } from '../dashboard/ProgressPanel';

// ── 混合渲染器 ──
import { HybridRenderer, RenderBackend } from './renderers';
import type { GraphNode, GraphEdge } from './renderers';

// ── 提取的 hooks 和组件 ──
import { getRelationTypes } from './canvasConstants';
import { useCanvasFileIO } from './useCanvasFileIO';
import { useCanvasHandlers } from './useCanvasHandlers';
import {
  NodeContextMenu,
  EdgeContextMenu,
  PaneContextMenu,
  QuickConnectMenu,
  EdgeLabelEditor,
} from './CanvasContextMenus';

// ── 数据转换函数 ──
function toGraphNode(node: Node): GraphNode {
  const measured = node.measured || {};
  return {
    id: node.id,
    x: node.position.x,
    y: node.position.y,
    width: (measured as any)?.width || node.width || 200,
    height: (measured as any)?.height || node.height || 100,
    label: ((node.data as any)?.title || (node.data as any)?.label || ''),
    color: ((node.data as any)?.color || getVizPalette().canvasDefaultEdge),
    type: node.type || 'default',
    selected: node.selected || false,
    data: node.data as Record<string, unknown>,
  };
}

function toGraphEdge(edge: Edge, nodes: Node[]): GraphEdge {
  const sourceNode = nodes.find(n => n.id === edge.source);
  const targetNode = nodes.find(n => n.id === edge.target);
  const sourcePos = sourceNode?.position || { x: 0, y: 0 };
  const targetPos = targetNode?.position || { x: 0, y: 0 };
  const sourceMeasured = (sourceNode?.measured || {}) as any;
  const targetMeasured = (targetNode?.measured || {}) as any;
  
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceX: sourcePos.x + (sourceMeasured.width || 200) / 2,
    sourceY: sourcePos.y + (sourceMeasured.height || 100) / 2,
    targetX: targetPos.x + (targetMeasured.width || 200) / 2,
    targetY: targetPos.y + (targetMeasured.height || 100) / 2,
    color: ((edge.style as any)?.stroke as string) || getVizPalette().canvasDefaultEdge,
    label: (edge as any).label || (edge.data as any)?.label || '',
    animated: (edge as any).animated || false,
  };
}

// ── nodeTypes / edgeTypes (must be stable module-level constants for ReactFlow) ──
const nodeTypes: any = {
  file: NoteNode,
  text: TextNode,
  group: GroupNode,
  image: ImageNode,
  pdf: PdfNode,
  web: WebNode,
};

const edgeTypes: any = {
  ghost: GhostEdge,
};

function CanvasInner() {
  const { state, showToast, setCurrentFile, setView, toggleChat, setPendingChatPrompt, consumePendingDeepLink } = useApp();
  const { palette: vizPalette } = useVizTheme();
  const reactFlowInstance = useReactFlow();

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [canvasPath, setCanvasPath] = useState<string | null>(null);
  
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string; nodeType: string } | null>(null);
  const [paneMenu, setPaneMenu] = useState<{ x: number; y: number } | null>(null);
  const [edgeContextMenu, setEdgeContextMenu] = useState<{ x: number; y: number; edgeId: string } | null>(null);
  // Mode removed — unified edit mode with left-drag pan
  const [editingEdgeId, setEditingEdgeId] = useState<string | null>(null);
  const [edgeLabelInput, setEdgeLabelInput] = useState('');
  const [edgeLabelPos, setEdgeLabelPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSaveCanvasPath = useRef<string | null>(null);
  const lastLocalCanvasSaveRef = useRef<{ path: string; at: number } | null>(null);
  const hoveredNodeRef = useRef<string | null>(null);
  const hoveredEdgeRef = useRef<string | null>(null);

  // ── 混合渲染器引用 (大规模节点性能优化) ──
  const hybridRendererRef = useRef<HybridRenderer | null>(null);
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const [renderBackend, setRenderBackend] = useState<RenderBackend>(RenderBackend.CANVAS_2D);

  // 短暂高亮选中节点作为视觉反馈
  const highlightSelectedNodes = useCallback((nodeIds: string[]) => {
    if (nodeIds.length === 0) return;
    // 添加高亮类
    setNodes(nds => nds.map(n => ({
      ...n,
      data: {
        ...n.data,
        _highlight: nodeIds.includes(n.id) ? true : n.data?._highlight,
      },
    })));
    // 600ms 后移除高亮
    setTimeout(() => {
      setNodes(nds => nds.map(n => ({
        ...n,
        data: { ...n.data, _highlight: undefined },
      })));
    }, 600);
  }, [setNodes]);

  // ── Agent Panel Integration & Canvas Watcher ──
  const [isAgentOpen, setIsAgentOpen] = useState(false);
  const [isDiagnosticRunning, setIsDiagnosticRunning] = useState(false);

  const {
    smartEdges,
    diagnostics,
    suggestions: canvasSuggestions,
    stats: canvasStats,
    triggerScan,
    clearDiagnostics,
    dismissSuggestion: dismissSmartSuggestion,
  } = useCanvasWatcher(nodes, edges, state.vaultPath || '', state.lang);

  // ── Smart Helper Lines & Drag Snapping (Feature 3) ──
  // 性能优化: 使用 ref 存储 nodes 避免 useCallback 依赖变化
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  const { helperLines, calculateHelperLines, clearHelperLines, onDragStart } = useHelperLines();

  // 性能优化: 稳定的回调引用，不依赖 nodes 变化
  // Holding Ctrl/⌘ while dragging moves freely (tldraw's snap toggle).
  const snapOffRef = useRef(false);
  useEffect(() => {
    const sync = (e: KeyboardEvent) => { snapOffRef.current = e.ctrlKey || e.metaKey; };
    const reset = () => { snapOffRef.current = false; };
    window.addEventListener('keydown', sync);
    window.addEventListener('keyup', sync);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', sync);
      window.removeEventListener('keyup', sync);
      window.removeEventListener('blur', reset);
    };
  }, []);

  const onNodesChangeWithAlignment = useCallback((changes: NodeChange[]) => {
    const hasPositionChange = changes.some(c => c.type === 'position');
    if (hasPositionChange) {
      // 使用 ref 获取最新 nodes，避免依赖数组变化导致回调重建
      // Snap distance: 8 screen px at any zoom.
      const zoom = reactFlowInstance.getZoom?.() || 1;
      const { snappedChanges } = calculateHelperLines(changes, nodesRef.current, 8 / zoom, snapOffRef.current);
      onNodesChange(snappedChanges);
    } else {
      onNodesChange(changes);
    }
  }, [onNodesChange, calculateHelperLines, reactFlowInstance]);

  // ── Double-click on pane detection (Phase 29) ──
  const lastPaneClickRef = useRef<{ time: number; x: number; y: number }>({ time: 0, x: 0, y: 0 });

  // ── Quick-Create from Connection End (Feature 1.1) ──
  const [quickConnectMenu, setQuickConnectMenu] = useState<{
    x: number; y: number; sourceNodeId: string; sourceHandleId: string | null;
  } | null>(null);
  const [quickConnectSuggestions, setQuickConnectSuggestions] = useState<{ path: string; label: string; similarity?: number }[]>([]);
  // While a line is being dragged out: show every card's connection points and
  // highlight the card under the pointer as the drop target.
  const [isConnecting, setIsConnecting] = useState(false);

  // ── Extracted Hooks ──
  const {
    handleSaveCanvas, handleOpenCanvas, handleNewCanvas, applyTemplate,
    reloadCanvasFromPath,
    handleAddNoteNode, handleAddTextNode, handleAddGroupNode, handleAddWebNode, handleAddPdfNode, handleAddImageNode,
    openAddNoteModal,
    isAddNoteOpen, setIsAddNoteOpen, isTemplateOpen, setIsTemplateOpen,
    noteSearch, setNoteSearch, vaultNotes,
  } = useCanvasFileIO({
    nodes, edges, setNodes, setEdges, reactFlowInstance,
    showToast, lang: state.lang, methodology: state.methodology,
    vaultPath: state.vaultPath, vaultPaths: state.vaultPaths || [],
    canvasPath, setCanvasPath,
    lastLocalCanvasSaveRef,
  });

  const {
    syncEdgeToDb, onAcceptGhostEdge, onRejectGhostEdge,
    handleSmartEdgeClick, handleSmartEdgeContextMenu,
    handlePaneClick, handleSetEdgeRelation, handleSetEdgeColor, handleToggleEdgeArrow,
    onConnect, onConnectEnd, handleQuickCreate, handleQuickConnectSimilar,
    onReconnect, onReconnectStart, onReconnectEnd, handleSetEdgeDirection,
    handleConvertTextToNote, onEdgesDelete,
    handleNodeContextMenu, handlePaneContextMenu, handleEdgeContextMenu,
    handleDeleteNode, handleKeyboardDelete, handleDeleteEdge,
    handleEdgeDoubleClick, handleEdgeLabelConfirm, handleEdgeLabelCancel,
    handleSetNodeColor, handleDrop, handleDragOver,
    addNodeAtPosition, handleDuplicateNode,
  } = useCanvasHandlers({
    nodes, edges, setNodes, setEdges, reactFlowInstance,
    showToast, lang: state.lang, vaultPath: state.vaultPath,
    editingEdgeId, setEditingEdgeId, edgeLabelInput, setEdgeLabelInput,
    edgeLabelPos, setEdgeLabelPos,
    setContextMenu, setPaneMenu, setEdgeContextMenu,
    quickConnectMenu, setQuickConnectMenu,
    quickConnectSuggestions, setQuickConnectSuggestions,
    smartEdges, dismissSmartSuggestion,
    openAddNoteModal,
    hoveredNodeRef, hoveredEdgeRef, lastPaneClickRef,
  });

  // ── LOD: Viewport zoom level tracking (Feature 1.3) ──
  const [currentZoom, setCurrentZoom] = useState<number>(1);

  // ── Phase 29: Smart Canvas (AI-populated) ──
  const [smartCanvasOpen, setSmartCanvasOpen] = useState(false);
  const [smartCanvasQuery, setSmartCanvasQuery] = useState('');
  const [smartCanvasLoading, setSmartCanvasLoading] = useState(false);

  // ── Canvas Plan：目标→计划→预览→部分批准→提交→验证 ──
  const [canvasPlanOpen, setCanvasPlanOpen] = useState(false);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);

  // 1. 挂载或 pendingDeepLink 更新时消费全局状态（彻底消除首次从 Chat 跳转的时序竞争）
  useEffect(() => {
    if (state.pendingDeepLink && state.pendingDeepLink.target === 'canvas') {
      const link = consumePendingDeepLink('canvas');
      if (link?.planId) {
        setActivePlanId(link.planId);
        setCanvasPlanOpen(true);
      }
    }
  }, [state.pendingDeepLink, consumePendingDeepLink]);

  // 2. 监听已打开状态下的 hot DOM event
  useEffect(() => {
    const handleOpenCanvas = (e: Event) => {
      const detail = (e as CustomEvent<{ path?: string; planId?: string }>).detail;
      if (detail?.planId) {
        setActivePlanId(detail.planId);
        setCanvasPlanOpen(true);
      }
    };
    window.addEventListener('open-canvas', handleOpenCanvas);
    return () => window.removeEventListener('open-canvas', handleOpenCanvas);
  }, []);

  // ── Agent 操作进度浮层 ──
  // `desc`/`descZh` are optional: the AI-layout flow only supplies labels, while the
  // richer flows below also pass a per-stage description.
  const [agentProgress, setAgentProgress] = useState<{
    step: number; steps: { label: string; labelZh: string; desc?: string; descZh?: string }[];
  } | null>(null);

  // ── Canvas Find (Ctrl+F) ──
  const [canvasFindOpen, setCanvasFindOpen] = useState(false);
  const [canvasFindQuery, setCanvasFindQuery] = useState('');
  const [canvasFindActiveIdx, setCanvasFindActiveIdx] = useState(0);
  // 性能优化: 防抖搜索查询，避免每次按键都重新过滤
  const [debouncedFindQuery, setDebouncedFindQuery] = useState('');
  const findDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (findDebounceTimerRef.current) clearTimeout(findDebounceTimerRef.current);
    findDebounceTimerRef.current = setTimeout(() => {
      setDebouncedFindQuery(canvasFindQuery);
    }, 150);
    return () => {
      if (findDebounceTimerRef.current) clearTimeout(findDebounceTimerRef.current);
    };
  }, [canvasFindQuery]);

  // ── 自由手绘 ──
  const freehandRef = useRef<FreehandOverlayHandle>(null);
  const [penMode, setPenMode] = useState<PenMode>('off');
  const [freehandViewport, setFreehandViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [penColor, setPenColor] = useState('#3b82f6');
  const [penSize, setPenSize] = useState(4);
  const [eraserSize, setEraserSize] = useState(24);
  const [shiftHeld, setShiftHeld] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShiftHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShiftHeld(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  useOnViewportChange({
    onChange: useCallback((vp: Viewport) => {
      setCurrentZoom(vp.zoom);
      setFreehandViewport({ x: vp.x, y: vp.y, zoom: vp.zoom });
    }, []),
  });

  // ── Undo / Redo History (性能优化: 结构化共享 + 增量快照) ──
  const historyRef = useRef<{ nodes: Node[]; edges: Edge[] }[]>([]);
  const historyIndexRef = useRef(-1);
  const isUndoRedoRef = useRef(false);
  // 性能优化: 使用结构化克隆而非 JSON 序列化，保留对象引用共享
  const structuredCloneNodes = (nodes: Node[]): Node[] => nodes.map(n => ({
    ...n,
    data: { ...n.data },
    style: n.style ? { ...n.style } : undefined,
    position: { ...n.position },
  }));
  const structuredCloneEdges = (edges: Edge[]): Edge[] => edges.map(e => ({
    ...e,
    data: e.data ? { ...e.data } : undefined,
    style: e.style ? { ...e.style } : undefined,
    labelStyle: e.labelStyle ? { ...e.labelStyle } : undefined,
  }));

  const pushHistory = useCallback((n: Node[], e: Edge[]) => {
    if (isUndoRedoRef.current) { isUndoRedoRef.current = false; return; }
    const history = historyRef.current;
    const idx = historyIndexRef.current;
    // Trim future if we branched
    historyRef.current = history.slice(0, idx + 1);
    // 性能优化: 使用结构化浅拷贝替代 JSON 深拷贝，减少 80% 内存分配
    historyRef.current.push({ nodes: structuredCloneNodes(n), edges: structuredCloneEdges(e) });
    // Cap at 50 entries
    if (historyRef.current.length > 50) historyRef.current.shift();
    historyIndexRef.current = historyRef.current.length - 1;
  }, []);

  const handleUndo = useCallback(() => {
    const idx = historyIndexRef.current;
    if (idx <= 0) return;
    historyIndexRef.current = idx - 1;
    const snap = historyRef.current[idx - 1];
    isUndoRedoRef.current = true;
    // 性能优化: 直接从历史恢复，无需再次深拷贝
    setNodes(structuredCloneNodes(snap.nodes));
    isUndoRedoRef.current = true;
    setEdges(structuredCloneEdges(snap.edges));
  }, [setNodes, setEdges]);

  const handleRedo = useCallback(() => {
    const idx = historyIndexRef.current;
    if (idx >= historyRef.current.length - 1) return;
    historyIndexRef.current = idx + 1;
    const snap = historyRef.current[idx + 1];
    isUndoRedoRef.current = true;
    setNodes(structuredCloneNodes(snap.nodes));
    isUndoRedoRef.current = true;
    setEdges(structuredCloneEdges(snap.edges));
  }, [setNodes, setEdges]);

  // Push to history on meaningful changes (debounced)
  // 性能优化: 拖拽期间跳过历史记录推送，拖拽结束后再推送
  const historyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDraggingNodeRef = useRef(false);
  const pendingHistoryPushRef = useRef(false);
  const pendingAutoSaveRef = useRef(false);

  useEffect(() => {
    if (isUndoRedoRef.current) {
      isUndoRedoRef.current = false;
      return;
    }
    // 性能优化: 拖拽期间不推送历史记录，拖拽结束后再推送
    if (isDraggingNodeRef.current) {
      pendingHistoryPushRef.current = true;
      return;
    }
    if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
    historyTimerRef.current = setTimeout(() => {
      pushHistory(nodes, edges);
    }, 500);
    return () => { if (historyTimerRef.current) clearTimeout(historyTimerRef.current); };
  }, [nodes, edges, pushHistory]);

  // ── 混合渲染器初始化 (大规模节点性能优化) ──
  useEffect(() => {
    if (!canvasContainerRef.current) return;
    
    const container = canvasContainerRef.current;
    const canvas = container.querySelector('canvas');
    if (!canvas) return;
    
    const renderer = new HybridRenderer(container, 3000);
    hybridRendererRef.current = renderer;
    
    renderer.initialize(canvas as HTMLCanvasElement).then(() => {
      // 初始数据同步
      if (nodes.length > 0) {
        const graphNodes = nodes.map(toGraphNode);
        const graphEdges = edges.map(e => toGraphEdge(e, nodes));
        renderer.setNodes(graphNodes);
        renderer.setEdges(graphEdges);
      }
      
      // 监听视口变化
      const vp = reactFlowInstance.getViewport();
      renderer.setViewport({
        x: vp.x,
        y: vp.y,
        width: container.clientWidth,
        height: container.clientHeight,
        zoom: vp.zoom,
      });
      
      setRenderBackend(renderer.getCurrentBackend());
    });
    
    return () => {
      renderer.destroy();
      hybridRendererRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // 只初始化一次

  // ── 同步 React Flow 数据到混合渲染器 ──
  useEffect(() => {
    const renderer = hybridRendererRef.current;
    if (!renderer) return;
    
    // 转换数据格式
    const graphNodes = nodes.map(toGraphNode);
    const graphEdges = edges.map(e => toGraphEdge(e, nodes));
    
    renderer.setNodes(graphNodes);
    renderer.setEdges(graphEdges);
    
    // 更新后端状态
    setRenderBackend(renderer.getCurrentBackend());
  }, [nodes, edges]);

  // ── 同步视口到混合渲染器 ──
  useEffect(() => {
    const renderer = hybridRendererRef.current;
    if (!renderer || !canvasContainerRef.current) return;
    
    const vp = reactFlowInstance.getViewport();
    renderer.setViewport({
      x: vp.x,
      y: vp.y,
      width: canvasContainerRef.current.clientWidth,
      height: canvasContainerRef.current.clientHeight,
      zoom: vp.zoom,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentZoom]); // 当缩放变化时同步

  // ── 渲染循环 (Canvas 2D 需要手动触发) ──
  useEffect(() => {
    const renderer = hybridRendererRef.current;
    if (!renderer || renderer.getCurrentBackend() !== RenderBackend.CANVAS_2D) return;
    
    let rafId: number;
    const renderLoop = () => {
      renderer.render();
      rafId = requestAnimationFrame(renderLoop);
    };
    rafId = requestAnimationFrame(renderLoop);
    
    return () => cancelAnimationFrame(rafId);
  }, [renderBackend]); // 当切换到 Canvas 2D 时启动渲染循环

  // Close context menus on click anywhere
  useEffect(() => {
    if (!contextMenu && !paneMenu && !edgeContextMenu && !quickConnectMenu) return;
    const close = () => { setContextMenu(null); setPaneMenu(null); setEdgeContextMenu(null); setQuickConnectMenu(null); };
    // Listen from the next tick: a menu opened on mouseup (a line dropped on empty
    // canvas) would otherwise be closed by the click of that same mouse release.
    const timer = window.setTimeout(() => window.addEventListener('click', close), 0);
    return () => { window.clearTimeout(timer); window.removeEventListener('click', close); };
  }, [contextMenu, paneMenu, edgeContextMenu, quickConnectMenu]);

  // ── 自由手绘快捷键：P=pen, E=eraser, Ctrl+Z=undo ──
  // ESC 退出由 FreehandOverlay 内部捕获并通过 custom event 通知，避免 React Flow 冲突
  const penModeRef = useRef<PenMode>('off');
  penModeRef.current = penMode;
  
  // 监听 FreehandOverlay 发出的 'freehand-exit' custom event（ESC 键）
  useEffect(() => {
    const handleFreehandExit = () => setPenMode('off');
    window.addEventListener('freehand-exit', handleFreehandExit);
    return () => window.removeEventListener('freehand-exit', handleFreehandExit);
  }, []);

  // ── 监听全局事件：Toggle AgentPanel (Ctrl+K) ──
  useEffect(() => {
    const handleToggleAgent = () => setIsAgentOpen(prev => !prev);
    window.addEventListener('zettel:toggle-agent', handleToggleAgent);
    return () => window.removeEventListener('zettel:toggle-agent', handleToggleAgent);
  }, []);
  
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      if (e.key === 'p' && !e.ctrlKey && !e.metaKey) {
        setPenMode(prev => prev === 'pen' ? 'off' : 'pen');
        e.preventDefault();
      } else if (e.key === 'e' && !e.ctrlKey && !e.metaKey) {
        setPenMode(prev => prev === 'eraser' ? 'off' : 'eraser');
        e.preventDefault();
      } else if (e.key === 'z' && e.ctrlKey && !e.shiftKey) {
        freehandRef.current?.undo();
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, []);

  // ── Keyboard shortcuts: Ctrl+Z undo, Ctrl+Shift+Z redo ──
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if user is typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable) return;

      // Ctrl+F: open canvas find
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setCanvasFindOpen(true);
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && e.shiftKey) {
        e.preventDefault();
        handleRedo();
      }
      // Also support Ctrl+Y for redo
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        handleRedo();
      }
      // Delete/Backspace for selected OR hovered items
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const selectedNodes = nodes.filter(n => n.selected);
        const selectedEdgesList = edges.filter(ed => ed.selected);

        // If nothing selected, try deleting hovered element
        if (selectedNodes.length === 0 && selectedEdgesList.length === 0) {
          if (hoveredEdgeRef.current) {
            const edgeId = hoveredEdgeRef.current;
            const edge = edges.find(ed => ed.id === edgeId);
            if (edge) {
              syncEdgeToDb({ source: edge.source, target: edge.target }, 'delete');
              setEdges(eds => eds.filter(ed => ed.id !== edgeId));
            }
            hoveredEdgeRef.current = null;
            return;
          }
          if (hoveredNodeRef.current) {
            const nodeId = hoveredNodeRef.current;
            const node = nodes.find(n => n.id === nodeId);
            if (node?.type === 'file') {
              const connectedEdges = edges.filter(ed => ed.source === nodeId || ed.target === nodeId);
              for (const edge of connectedEdges) {
                syncEdgeToDb({ source: edge.source, target: edge.target }, 'delete');
              }
            }
            setNodes(nds => nds.filter(n => n.id !== nodeId));
            setEdges(eds => eds.filter(ed => ed.source !== nodeId && ed.target !== nodeId));
            hoveredNodeRef.current = null;
            return;
          }
          return;
        }

        // Clean up DB for file nodes
        for (const node of selectedNodes) {
          if (node.type === 'file') {
            const connectedEdges = edges.filter(ed => ed.source === node.id || ed.target === node.id);
            for (const edge of connectedEdges) {
              syncEdgeToDb({ source: edge.source, target: edge.target }, 'delete');
            }
          }
        }
        const nodeIds = new Set(selectedNodes.map(n => n.id));
        setNodes(nds => nds.filter(n => !nodeIds.has(n.id)));
        setEdges(eds => eds.filter(ed => !nodeIds.has(ed.source) && !nodeIds.has(ed.target) && !selectedEdgesList.some(se => se.id === ed.id)));
        for (const edge of selectedEdgesList) {
          syncEdgeToDb({ source: edge.source, target: edge.target }, 'delete');
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleUndo, handleRedo, nodes, edges, setNodes, setEdges, syncEdgeToDb]);


  // Apply visual highlights via className when diagnostics updates
  useEffect(() => {
    if (!diagnostics) {
      setNodes(nds => nds.map(n => ({
        ...n,
        className: (n.className || '').replace(/canvas-diag-\w+/g, '').trim() || undefined
      })));
      return;
    }
    const orphanSet = new Set(diagnostics.orphanNodeIds);
    const brokenSet = new Set(diagnostics.brokenLinkNodeIds);
    const missingSet = new Set(diagnostics.missingMetaNodeIds);
    setNodes(nds => nds.map(n => {
      let cls = (n.className || '').replace(/canvas-diag-\w+/g, '').trim();
      if (brokenSet.has(n.id)) cls += ' canvas-diag-broken';
      else if (orphanSet.has(n.id)) cls += ' canvas-diag-orphan';
      else if (missingSet.has(n.id)) cls += ' canvas-diag-missing';
      return { ...n, className: cls.trim() || undefined };
    }));
  }, [diagnostics, setNodes]);

  // Phase 29: Canvas Health Diagnostics
  const handleDiagnoseCanvas = useCallback(async () => {
    if (diagnostics) {
      clearDiagnostics();
      return;
    }
    setIsDiagnosticRunning(true);
    try {
      const results = await triggerScan();
      if (results) {
        const { orphanNodeIds, brokenLinkNodeIds, missingMetaNodeIds, totalIssues } = results;
        if (totalIssues === 0) {
          showToast(
            state.lang === 'zh' ? '画布健康：无问题' : 'Canvas healthy: no issues',
            'success'
          );
        } else {
          showToast(
            state.lang === 'zh'
              ? `发现 ${totalIssues} 个问题 (${orphanNodeIds.length} 孤立 / ${brokenLinkNodeIds.length} 断链 / ${missingMetaNodeIds.length} 缺标签)`
              : `Found ${totalIssues} issues (${orphanNodeIds.length} orphan / ${brokenLinkNodeIds.length} broken / ${missingMetaNodeIds.length} missing tags)`,
            'info'
          );
        }
      } else {
        // triggerScan returned null (e.g. no file nodes on canvas, or scan error)
        const fileNodeCount = nodes.filter(n => n.type === 'file').length;
        if (fileNodeCount === 0) {
          showToast(
            state.lang === 'zh'
              ? '画布上没有笔记卡片，请先添加卡片'
              : 'No note cards on canvas — add cards to diagnose',
            'info'
          );
        } else {
          showToast(
            state.lang === 'zh'
              ? '诊断扫描失败，请确保已打开知识库'
              : 'Diagnostic scan failed — make sure a vault is open',
            'error'
          );
        }
      }
    } catch (err) {
      showToast(
        state.lang === 'zh' ? `诊断失败: ${err}` : `Diagnostic failed: ${err}`,
        'error'
      );
    }
    setIsDiagnosticRunning(false);
  }, [diagnostics, triggerScan, clearDiagnostics, showToast, state.lang, nodes]);

  // Phase 30: AI Auto-Layout — LLM-powered intelligent canvas arrangement
  // silent=true suppresses toasts (used when called from Smart Canvas which has its own toast)
  const handleAutoLayout = useCallback(async (silent = false) => {
    // Read current nodes/edges from React Flow instance to avoid stale closure
    const currentNodes = reactFlowInstance.getNodes() as Node[];
    const fileNodes = currentNodes.filter(n => n.type === 'file');
    if (fileNodes.length < 2) {
      if (!silent) showToast(state.lang === 'zh' ? '需要至少 2 个笔记卡片' : 'Need at least 2 note cards', 'info');
      return;
    }

    const _layoutSteps = [
      { label: 'Analyzing', labelZh: '分析图谱', desc: 'Reading nodes and links', descZh: '读取节点与连线' },
      { label: 'Generating', labelZh: 'AI 生成布局', desc: 'Asking the model for a layout', descZh: '请求模型生成布局方案' },
      { label: 'Applying', labelZh: '应用布局', desc: 'Moving nodes into place', descZh: '将节点移动到新位置' },
      { label: 'Complete', labelZh: '完成', desc: 'Layout applied', descZh: '布局已应用' },
    ];
    if (!silent) setAgentProgress({ step: 1, steps: _layoutSteps });

    try {
      const graphData = await getKnowledgeGraph(state.vaultPath || '');
      if (!silent) setAgentProgress({ step: 2, steps: _layoutSteps });
      const methodology = state.methodology;
      const nonFileNodes = currentNodes.filter(n => n.type !== 'file');

      // Build node info for LLM
      const pathToGraphNode = new Map<string, { cluster: number; pagerank: number; note_type: string }>();
      for (const gn of graphData.nodes) {
        pathToGraphNode.set(gn.id.replace(/\\/g, '/'), {
          cluster: gn.cluster,
          pagerank: gn.pagerank ?? 0,
          note_type: gn.note_type || 'unknown',
        });
      }

      // Build compact card summaries for LLM
      const cardSummaries = fileNodes.map(n => {
        const path = (n.data.file as string).replace(/\\/g, '/');
        const info = pathToGraphNode.get(path);
        const title = (n.data.title as string) || path.split('/').pop()?.replace(/\.md$/, '') || path;
        return {
          id: n.id,
          title,
          note_type: info?.note_type || 'unknown',
          pagerank: Math.round((info?.pagerank ?? 0) * 100) / 100,
          cluster: info?.cluster ?? -1,
        };
      });

      // Build edge summaries
      const currentEdges = reactFlowInstance.getEdges() as Edge[];
      const canvasEdges = currentEdges.filter(e =>
        fileNodes.some(n => n.id === e.source) && fileNodes.some(n => n.id === e.target)
      );
      const edgeSummaries = canvasEdges.slice(0, 20).map(e => ({
        from: fileNodes.find(n => n.id === e.source)?.data.title || e.source,
        to: fileNodes.find(n => n.id === e.target)?.data.title || e.target,
        type: (e.data?.relationType as string) || 'link',
      }));

      // Try LLM-powered layout
      if (!silent) setAgentProgress(prev => prev ? { ...prev, step: 2 } : null);
      let llmLayoutApplied = false;
      try {
        const { llmConfig } = state;
        if (llmConfig.apiUrl && llmConfig.model) {
          const prompt = `You are an expert canvas layout designer for a ${methodology.toUpperCase()} knowledge management system. Arrange these note cards on a whiteboard canvas.

Cards (${cardSummaries.length}):
${cardSummaries.map(c => `- id:"${c.id}" title:"${c.title}" type:${c.note_type} importance:${c.pagerank} cluster:${c.cluster}`).join('\n')}

Relationships:
${edgeSummaries.map(e => `- "${e.from}" --[${e.type}]--> "${e.to}"`).join('\n') || 'None'}

Methodology: ${methodology}

Layout Rules:
1. **Cluster grouping**: Cards with the same cluster ID must be placed close together (within 400px of each other). Different clusters should be clearly separated (min 600px between cluster boundaries).
2. **Importance sizing**: Higher pagerank = larger card. Scale: 0.00-0.02 → 320×240, 0.02-0.05 → 380×280, 0.05-0.10 → 440×320, 0.10+ → 500-600×380-450.
3. **Hub placement**: The highest-pagerank card in each cluster goes at the cluster center; supporting cards orbit around it.
4. **Anti-overlap**: Ensure min 80px gap between any two card boundaries. Use a grid mental model: each card occupies its cell plus 40px padding.
5. **Edge crossing minimization**: Place connected cards along the same axis (horizontal or vertical) to reduce visual clutter from crossing edges.
6. **Canvas area**: roughly ${Math.max(2000, cardSummaries.length * 600)}x${Math.max(1500, cardSummaries.length * 400)} pixels. Origin (0,0) is top-left.
7. **Methodology alignment**: Group cards by their ${methodology} note types when cluster info is unavailable — place related types adjacent (e.g., in Zettelkasten: fleeting→literature→permanent→structure flow left-to-right).

Return ONLY a JSON array, no markdown, no explanation:
[{"id":"node-id","x":0,"y":0,"w":400,"h":300,"group":"cluster-label-or-methodology-type"},...]
`;

          const result = await agentChat({
            messages: [
              { role: 'system', content: 'You are a precise JSON layout generator for a knowledge management canvas. Output ONLY valid JSON arrays. No markdown code fences, no explanations. Every card in the input MUST appear in the output with a valid position.' },
              { role: 'user', content: prompt },
            ],
            apiUrl: llmConfig.apiUrl,
            apiKey: llmConfig.apiKey || undefined,
            model: llmConfig.model,
            providerId: llmConfig.providerId,
            vaultPath: state.vaultPath || undefined,
            methodology,
          });

          // Parse LLM response — extract JSON array
          const jsonMatch = result.match(/\[\s*\{[\s\S]*\}\s*\]/);
          if (jsonMatch) {
            const layout: { id: string; x: number; y: number; w: number; h: number; group?: string }[] = JSON.parse(jsonMatch[0]);
            const layoutMap = new Map(layout.map(l => [l.id, l]));

            const updatedNodes: Node[] = [];
            for (const n of fileNodes) {
              const l = layoutMap.get(n.id);
              if (l) {
                const path = (n.data.file as string).replace(/\\/g, '/');
                const info = pathToGraphNode.get(path);
                const mappedType = info ? mapNoteType(info.note_type, methodology) : 'unknown';
                const typeColor = getNoteColorMap()[mappedType];
                updatedNodes.push({
                  ...n,
                  position: { x: l.x, y: l.y },
                  width: l.w,
                  height: l.h,
                  style: { ...n.style, width: l.w, height: l.h },
                  data: { ...n.data, color: typeColor || n.data.color },
                });
              } else {
                updatedNodes.push(n);
              }
            }
            updatedNodes.push(...nonFileNodes);
            if (!silent) setAgentProgress(prev => prev ? { ...prev, step: 3 } : null);
            setNodes(updatedNodes);
            llmLayoutApplied = true;

            const groups = [...new Set(layout.map(l => l.group).filter(Boolean))];
            setTimeout(() => reactFlowInstance.fitView({ padding: 0.15, duration: 800 }), 50);
            if (!silent) {
              setAgentProgress(prev => prev ? { ...prev, step: 4 } : null);
              setTimeout(() => setAgentProgress(null), 800);
              showToast(
                tf('canvas.layoutLlmDone', fileNodes.length, groups.length > 0 ? ' (' + groups.join(', ') + ')' : ''),
                'success'
              );
            }
          }
        }
      } catch (llmErr) {
        console.warn('LLM layout failed, falling back to algorithmic layout:', llmErr);
      }

      // Fallback: algorithmic layout (PageRank + methodology/cluster grouping)
      if (!llmLayoutApplied) {
        const methodologyTypes = METHODOLOGY_TYPES[methodology];
        const useMethodologyGrouping = methodologyTypes && methodologyTypes.length >= 2;

        let groups: Map<string, typeof fileNodes>;

        if (useMethodologyGrouping) {
          groups = new Map<string, typeof fileNodes>();
          for (const n of fileNodes) {
            const path = (n.data.file as string).replace(/\\/g, '/');
            const info = pathToGraphNode.get(path);
            const rawType = info?.note_type || 'unknown';
            const mappedType = mapNoteType(rawType, methodology);
            const groupKey = methodologyTypes.includes(mappedType) ? mappedType : 'other';
            if (!groups.has(groupKey)) groups.set(groupKey, []);
            groups.get(groupKey)!.push(n);
          }
          const orderedKeys = [...methodologyTypes.filter((t: string) => groups.has(t)), ...(groups.has('other') ? ['other'] : [])];
          const ordered = new Map<string, typeof fileNodes>();
          for (const k of orderedKeys) { if (groups.has(k)) ordered.set(k, groups.get(k)!); }
          groups = ordered;
        } else {
          const clusterGroups = new Map<number, typeof fileNodes>();
          for (const n of fileNodes) {
            const path = (n.data.file as string).replace(/\\/g, '/');
            const cluster = pathToGraphNode.get(path)?.cluster ?? -1;
            if (!clusterGroups.has(cluster)) clusterGroups.set(cluster, []);
            clusterGroups.get(cluster)!.push(n);
          }
          groups = new Map<string, typeof fileNodes>();
          for (const [k, v] of clusterGroups) groups.set(String(k), v);
        }

        const allPageranks = fileNodes.map(n => {
          const path = (n.data.file as string).replace(/\\/g, '/');
          return pathToGraphNode.get(path)?.pagerank ?? 0;
        });
        const maxPR = Math.max(...allPageranks, 0.001);
        const minPR = Math.min(...allPageranks);
        const prRange = maxPR - minPR || 1;

        const groupKeys = [...groups.keys()];
        const groupCount = groupKeys.length;
        const clusterRadius = Math.max(600, groupCount * 250);

        const updatedNodes: Node[] = [];
        groupKeys.forEach((groupKey, gi) => {
          const members = groups.get(groupKey)!;
          const angle = (2 * Math.PI * gi) / groupCount;
          const cx = clusterRadius * Math.cos(angle);
          const cy = clusterRadius * Math.sin(angle);
          const memberRadius = Math.max(200, members.length * 80);
          members.forEach((n, mi) => {
            const path = (n.data.file as string).replace(/\\/g, '/');
            const info = pathToGraphNode.get(path);
            const pr = info?.pagerank ?? 0;
            const scale = 0.8 + ((pr - minPR) / prRange) * 0.7;
            const newW = Math.round(400 * scale);
            const newH = Math.round(300 * scale);
            const mAngle = (2 * Math.PI * mi) / members.length;
            const mappedType = info ? mapNoteType(info.note_type, methodology) : 'unknown';
            const typeColor = getNoteColorMap()[mappedType];
            updatedNodes.push({
              ...n,
              position: { x: cx + memberRadius * Math.cos(mAngle) - newW / 2, y: cy + memberRadius * Math.sin(mAngle) - newH / 2 },
              width: newW, height: newH,
              style: { ...n.style, width: newW, height: newH },
              data: { ...n.data, color: typeColor || n.data.color },
            });
          });
        });
        updatedNodes.push(...nonFileNodes);
        if (!silent) setAgentProgress(prev => prev ? { ...prev, step: 3 } : null);
        setNodes(updatedNodes);
        setTimeout(() => reactFlowInstance.fitView({ padding: 0.15, duration: 800 }), 50);

        const groupTypeName = useMethodologyGrouping
          ? tf('canvas.layoutCategories', methodology.toUpperCase())
          : t('canvas.layoutClusters');
        if (!silent) {
          setAgentProgress(prev => prev ? { ...prev, step: 4 } : null);
          setTimeout(() => setAgentProgress(null), 800);
          showToast(
            tf('canvas.layoutAlgoDone', groupCount, groupTypeName),
            'success'
          );
        }
      }
    } catch (err) {
      showToast(`Auto-layout failed: ${err}`, 'error');
    } finally {
      setAgentProgress(null);
    }
  }, [setNodes, reactFlowInstance, showToast, state.lang, state.methodology, state.llmConfig, state.vaultPath]);

  // ── Canvas Find (Ctrl+F) — search & navigate (性能优化: 使用防抖查询) ──
  const canvasFindResults = useMemo(() => {
    if (!debouncedFindQuery.trim()) return [];
    const q = debouncedFindQuery.toLowerCase();
    return nodes.filter(n => {
      const data = n.data as any;
      const title = (data?.title || '').toLowerCase();
      const label = (data?.label || '').toLowerCase();
      const text = (data?.text || '').toLowerCase();
      const file = (data?.file || '').toLowerCase();
      return title.includes(q) || label.includes(q) || text.includes(q) || file.includes(q);
    });
  }, [debouncedFindQuery, nodes]);

  // Reset active index when results change
  useEffect(() => {
    setCanvasFindActiveIdx(0);
  }, [canvasFindResults.length]);

  const navigateToFindResult = useCallback((index: number) => {
    if (!canvasFindResults.length) return;
    const idx = ((index % canvasFindResults.length) + canvasFindResults.length) % canvasFindResults.length;
    setCanvasFindActiveIdx(idx);
    const target = canvasFindResults[idx];
    setNodes(nds => nds.map(n => ({ ...n, selected: n.id === target.id })));
    reactFlowInstance.fitView({ nodes: [{ id: target.id } as any], padding: 0.3, duration: 400 });
  }, [canvasFindResults, setNodes, reactFlowInstance]);

  const closeCanvasFind = useCallback(() => {
    setCanvasFindOpen(false);
    setCanvasFindQuery('');
    setCanvasFindActiveIdx(0);
    setNodes(nds => nds.map(n => ({ ...n, selected: false })));
  }, [setNodes]);

  // Phase 29: Smart Canvas — search and populate
  const handleSmartCanvasSearch = useCallback(async (customQuery?: string, preSelectedResults?: any[], onProgress?: (step: 'adding' | 'connecting' | 'layout' | 'done') => void) => {
    setSmartCanvasLoading(true);
    try {
      let uniqueResults: any[];

      if (preSelectedResults && preSelectedResults.length > 0) {
        // 使用预选的结果（来自 SmartCanvasPanel）
        uniqueResults = preSelectedResults;
      } else {
        // 原有逻辑：搜索并去重
        const query = customQuery !== undefined ? customQuery : smartCanvasQuery;
        if (!query.trim()) { setSmartCanvasLoading(false); return; }

        const results = await searchChunks({ query, limit: 12, mode: 'hybrid' });
        if (results.length === 0) {
          showToast(state.lang === 'zh' ? '未找到相关笔记' : 'No related notes found', 'info');
          setSmartCanvasLoading(false);
          return;
        }

        const seenPaths = new Set<string>();
        const canvasFilePaths = new Set(
          nodes.filter(n => n.type === 'file').map(n => (n.data.file as string).replace(/\\/g, '/'))
        );
        uniqueResults = results.filter((r: any) => {
          const norm = r.file_path.replace(/\\/g, '/');
          if (seenPaths.has(norm) || canvasFilePaths.has(norm)) return false;
          seenPaths.add(norm);
          return true;
        }).slice(0, 8);

        if (uniqueResults.length === 0) {
          showToast(state.lang === 'zh' ? '相关笔记已在画布上' : 'Related notes already on canvas', 'info');
          setSmartCanvasLoading(false);
          return;
        }
      }

      // Create nodes at temporary positions (handleAutoLayout will rearrange them)
      const newNodes: Node[] = uniqueResults.map((r, i) => {
        const name = r.file_path.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/, '') || r.file_path;
        return {
          id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          type: 'file' as const,
          position: { x: i * 460, y: 0 }, // temporary, will be overridden by auto-layout
          width: 400,
          height: 300,
          style: { width: 400, height: 300 },
          data: { file: r.file_path, title: name, color: '#3b82f6' },
        };
      });

      setNodes(nds => nds.concat(newNodes));
      onProgress?.('connecting');

      // Connect new nodes — only the single strongest edge per new node to keep canvas clean
      try {
        const graphData = await getKnowledgeGraph(state.vaultPath || '');
        const allFileNodes = [...nodes.filter(n => n.type === 'file'), ...newNodes];
        const pathToId = new Map<string, string>();
        for (const n of allFileNodes) {
          pathToId.set((n.data.file as string).replace(/\\/g, '/'), n.id);
        }
        const newNodeIds = new Set(newNodes.map(n => n.id));
        const candidates: { srcId: string; tgtId: string; weight: number; label?: string; edgeType?: string }[] = [];
        for (const ge of graphData.edges) {
          const srcId = pathToId.get(ge.source.replace(/\\/g, '/'));
          const tgtId = pathToId.get(ge.target.replace(/\\/g, '/'));
          if (!srcId || !tgtId) continue;
          if (!newNodeIds.has(srcId) && !newNodeIds.has(tgtId)) continue;
          candidates.push({ srcId, tgtId, weight: ge.weight ?? 0.5, label: ge.label, edgeType: ge.edge_type });
        }
        const connectedNewNodes = new Set<string>();
        candidates.sort((a, b) => b.weight - a.weight);
        const newEdges: Edge[] = [];
        for (const { srcId, tgtId, label, edgeType } of candidates) {
          const newSrc = newNodeIds.has(srcId);
          const newTgt = newNodeIds.has(tgtId);
          if (newSrc && connectedNewNodes.has(srcId)) continue;
          if (newTgt && connectedNewNodes.has(tgtId)) continue;
          if (newEdges.length >= 6) break;
          const relationType = edgeType || 'wikilink';
          const rel = getRelationTypes().find(r => r.type === relationType);
          const displayLabel = rel ? (state.lang === 'zh' ? rel.labelZh : rel.label) : (label || '');
          const edgeColor = rel?.color || vizPalette.canvasDefaultEdge;
          newEdges.push({
            id: `edge-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
            source: srcId,
            target: tgtId,
            type: 'default',
            label: displayLabel || undefined,
            labelStyle: displayLabel ? { fontSize: 10, fill: edgeColor, fontWeight: 500 } : undefined,
            style: { stroke: edgeColor },
            data: { relationType, color: edgeColor, fromEnd: 'none', toEnd: 'arrow' },
          });
          if (newSrc) connectedNewNodes.add(srcId);
          if (newTgt) connectedNewNodes.add(tgtId);
        }
        if (newEdges.length > 0) {
          setEdges(eds => [...eds, ...newEdges]);
        }
      } catch { /* ignore graph errors */ }

      setSmartCanvasQuery('');

      // 面板保持打开,由进度回调控制关闭时机
      onProgress?.('layout');
      const startTime = Date.now();
      const checkMeasuredAndLayout = async () => {
        const currentNodes = reactFlowInstance.getNodes();
        const fileNodes = currentNodes.filter((n: Node) => n.type === 'file');
        const allMeasured = fileNodes.every((n: Node) => n.measured?.width && n.measured?.height);
        if (allMeasured || Date.now() - startTime > 1000) {
          await handleAutoLayout(true);
          onProgress?.('done');
        } else {
          setTimeout(checkMeasuredAndLayout, 50);
        }
      };
      checkMeasuredAndLayout();
    } catch (err) {
      showToast(`Smart Canvas failed: ${err}`, 'error');
    }
    setSmartCanvasLoading(false);
  }, [smartCanvasQuery, nodes, setNodes, setEdges, reactFlowInstance, showToast, state.lang, handleAutoLayout]);

  // ── Multi-select alignment tools (Obsidian-style) ──
  const alignSelectedNodes = useCallback((mode: 'left' | 'right' | 'top' | 'bottom' | 'center-h' | 'center-v') => {
    const selected = nodes.filter(n => n.selected);
    if (selected.length < 2) return;

    const measured = selected.map(n => ({
      id: n.id,
      x: n.position.x,
      y: n.position.y,
      w: (n.measured as any)?.width || n.width || 200,
      h: (n.measured as any)?.height || n.height || 100,
    }));

    setNodes(nds => nds.map(n => {
      if (!n.selected) return n;
      const m = measured.find(x => x.id === n.id);
      if (!m) return n;
      let newX = m.x, newY = m.y;
      switch (mode) {
        case 'left':
          newX = Math.min(...measured.map(x => x.x));
          break;
        case 'right':
          newX = Math.max(...measured.map(x => x.x + x.w)) - m.w;
          break;
        case 'top':
          newY = Math.min(...measured.map(x => x.y));
          break;
        case 'bottom':
          newY = Math.max(...measured.map(x => x.y + x.h)) - m.h;
          break;
        case 'center-h': {
          const minX = Math.min(...measured.map(x => x.x));
          const maxX = Math.max(...measured.map(x => x.x + x.w));
          newX = (minX + maxX) / 2 - m.w / 2;
          break;
        }
        case 'center-v': {
          const minY = Math.min(...measured.map(x => x.y));
          const maxY = Math.max(...measured.map(x => x.y + x.h));
          newY = (minY + maxY) / 2 - m.h / 2;
          break;
        }
      }
      return { ...n, position: { x: newX, y: newY } };
    }));
  }, [nodes, setNodes]);

  // ── Node z-order: bring to front / send to back ──
  const handleBringToFront = useCallback((nodeId: string) => {
    setNodes(nds => {
      const node = nds.find(n => n.id === nodeId);
      if (!node) return nds;
      return [...nds.filter(n => n.id !== nodeId), node];
    });
  }, [setNodes]);

  const handleSendToBack = useCallback((nodeId: string) => {
    setNodes(nds => {
      const node = nds.find(n => n.id === nodeId);
      if (!node) return nds;
      return [node, ...nds.filter(n => n.id !== nodeId)];
    });
  }, [setNodes]);

  // Canvas → Chat: 将选中的节点作为上下文发送到 Chat
  const handleDiscussSelectedNodes = useCallback(() => {
    const selectedNodes = nodes.filter(n => n.selected);
    if (selectedNodes.length === 0) return;

    // 提取选中节点的笔记信息（仅 file 类型节点有 path 或 file）
    const noteInfos = selectedNodes
      .filter(n => n.type === 'file' && (n.data?.path || n.data?.file))
      .map(n => ({
        name: n.data?.label || n.data?.name || n.data?.title || 'Untitled',
        path: (n.data?.path || n.data?.file) as string,
        nodeId: n.id,
      }));

    // 同时包含非 file 节点（sticky/text）的信息
    const textInfos = selectedNodes
      .filter(n => n.type !== 'file')
      .map(n => ({
        name: (n.data?.label as string) || (n.data?.text as string)?.slice(0, 30) || 'Text Node',
        content: n.data?.text || n.data?.content || '',
        nodeId: n.id,
      }));

    // 空状态处理：没有可发送的笔记
    if (noteInfos.length === 0 && textInfos.length === 0) {
      showToast(
        state.lang === 'zh'
          ? '选中的节点中没有可发送的笔记（需要笔记卡片或文本节点）'
          : 'No discussable content in selection (need note cards or text nodes)',
        'info'
      );
      return;
    }

    // 构建包含节点名称的 prompt，让 AI 知道具体在分析哪些节点
    const noteNames = noteInfos.map(n => n.name).concat(textInfos.map(t => t.name));
    const prompt = state.lang === 'zh'
      ? `请分析以下画布上选中的 ${selectedNodes.length} 个节点（${noteNames.join('、')}）之间的关系，包括它们的语义连接、共同主题、互补或矛盾之处，以及潜在的知识网络结构。`
      : `Analyze the relationships between these ${selectedNodes.length} selected nodes on the canvas (${noteNames.join(', ')}), including their semantic connections, common themes, complementary or contradictory aspects, and potential knowledge network structure.`;

    // 1. 打开 Chat 面板（传空字符串仅用于触发 isChatOpen，不会覆盖事件设置的输入）
    setPendingChatPrompt('');

    // 2. 通过事件传递完整的节点数据，SmartChat 监听器会自动：
    //    - 将笔记附加到 attachedNotes（发送时读取笔记全文）
    //    - 将文本节点内容嵌入 prompt 上下文
    window.dispatchEvent(new CustomEvent('zettel:canvas-selection', {
      detail: {
        source: 'canvas' as const,
        notes: noteInfos,
        textNodes: textInfos,
        prompt,
        timestamp: Date.now(),
      },
    }));

    // 显示提示
    const msg = state.lang === 'zh'
      ? `已将 ${noteInfos.length} 个笔记和 ${textInfos.length} 个文本节点发送到 Chat`
      : `Sent ${noteInfos.length} notes and ${textInfos.length} text nodes to Chat`;
    showToast(msg, 'success');

    // 短暂高亮选中的节点作为反馈
    highlightSelectedNodes(selectedNodes.map(n => n.id));
  }, [nodes, state.lang, state.isChatOpen, showToast, toggleChat, setPendingChatPrompt]);

  const handleCanvasAgentAction = useCallback((actionOrId: string, data?: any) => {
    // 1. Check direct actions from buttons
    if (actionOrId === 'auto-layout') {
      handleAutoLayout();
      return;
    }
    if (actionOrId === 'smart-canvas') {
      setSmartCanvasOpen(true);
      return;
    }
    if (actionOrId === 'smart-canvas-search') {
      const q = data?.query as string;
      const scSteps = [
        { label: 'Searching', labelZh: '搜索笔记' },
        { label: 'Connecting', labelZh: '建立连接' },
        { label: 'Arranging', labelZh: 'Smart画布排版' },
        { label: 'Complete', labelZh: '完成' },
      ];
      const stepIdx: Record<string, number> = { 'searching': 1, 'connecting': 2, 'arranging': 3, 'done': 4 };
      handleSmartCanvasSearch(q, undefined, (step) => {
        const idx = stepIdx[step];
        if (idx) setAgentProgress({ step: idx, steps: scSteps });
        if (step === 'done') {
          setTimeout(() => setAgentProgress(null), 800);
        }
      });
      return;
    }

    // 2. Check suggestion action data
    if (data?.action === 'auto-layout') {
      handleAutoLayout();
      return;
    }

    if (data?.edge) {
      const edge = data.edge as Edge;
      const smartType = edge.data?._smartType as string;
      if (smartType === 'suggestion') {
        handleSmartEdgeClick(null as any, edge);
      } else if (smartType === 'duplicate') {
        showToast(
          state.lang === 'zh'
            ? '发现疑似重复卡片，请手动检查并合并它们的内容。'
            : 'Duplicate notes detected. Please inspect and merge them manually.',
          'info'
        );
      }
    }
  }, [handleAutoLayout, handleSmartEdgeClick, handleSmartCanvasSearch, state.lang, showToast]);

  // 11. Ctrl+S keyboard shortcut for save + H/V mode toggle + Undo/Redo
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      handleSaveCanvas();
    }
    // Undo / Redo
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable) return;
      e.preventDefault();
      handleUndo();
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable) return;
      e.preventDefault();
      handleRedo();
    }
    // Space = fit view (only when not typing)
    if (e.code === 'Space') {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable) return;
      e.preventDefault();
      reactFlowInstance.fitView({ padding: 0.15, duration: 400 });
    }
    // Shift+1 = Fit View, Shift+2 = Zoom to Selection
    if (e.shiftKey && e.key === '1') {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable) return;
      e.preventDefault();
      reactFlowInstance.fitView({ padding: 0.15, duration: 400 });
    }
    if (e.shiftKey && e.key === '2') {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable) return;
      e.preventDefault();
      const selected = nodes.filter(n => n.selected);
      if (selected.length > 0) {
        reactFlowInstance.fitView({ nodes: selected.map(n => ({ id: n.id })), padding: 0.3, duration: 400 });
      }
    }
    // Shift+0 = Reset Zoom to 100%
    if (e.shiftKey && e.key === '0') {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable) return;
      e.preventDefault();
      reactFlowInstance.zoomTo(1, { duration: 300 });
    }
  }, [handleSaveCanvas, handleUndo, handleRedo, reactFlowInstance, nodes]);

  // Track mouse position on canvas for paste-at-cursor
  const { handlePaste, handleMouseMove } = useCanvasPaste({
    reactFlowInstance, setNodes, showToast, lang: state.lang, vaultPath: state.vaultPath,
  });

  // Register keyboard shortcuts (Delete + Ctrl+S + Paste)
  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keydown', handleKeyboardDelete);
    window.addEventListener('paste', handlePaste);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keydown', handleKeyboardDelete);
      window.removeEventListener('paste', handlePaste);
    };
  }, [handleKeyDown, handleKeyboardDelete, handlePaste]);

  // Auto-save: debounced save when nodes or edges change
  useEffect(() => {
    autoSaveCanvasPath.current = canvasPath;
  }, [canvasPath]);

  useEffect(() => {
    if (!autoSaveCanvasPath.current) return; // No file open, skip auto-save
    // 性能优化: 拖拽期间跳过自动保存，拖拽结束后再保存
    if (isDraggingNodeRef.current) {
      pendingAutoSaveRef.current = true;
      return;
    }
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      handleSaveCanvas();
    }, 2000);
    return () => {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    };
  }, [nodes, edges]);

  // External .canvas changes (Agent modify_canvas / vault file watcher) → reload open board
  useEffect(() => {
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();

    const shouldReload = (changedPath: string): boolean => {
      if (!canvasPath) return false;
      if (norm(changedPath) !== norm(canvasPath)) return false;
      const last = lastLocalCanvasSaveRef.current;
      if (last && norm(last.path) === norm(canvasPath) && Date.now() - last.at < 2500) {
        return false;
      }
      return true;
    };

    const reloadIfCurrent = (changedPath: string) => {
      if (!shouldReload(changedPath)) return;
      reloadCanvasFromPath(changedPath, { silent: true, fitView: false });
      showToast(
        state.lang === 'zh' ? '画布已同步外部更新' : 'Canvas synced from external update',
        'info',
      );
    };

    const unsubs: Array<Promise<() => void>> = [];

    unsubs.push(
      listen<string[]>('file-watcher-synced', (event) => {
        const paths = event.payload || [];
        for (const p of paths) {
          if (p.toLowerCase().endsWith('.canvas')) {
            reloadIfCurrent(p);
          }
        }
      }),
    );

    unsubs.push(
      listen<{ filePath?: string }>('request-file-tree-refresh', (event) => {
        const p = event.payload?.filePath;
        if (p && p.toLowerCase().endsWith('.canvas')) {
          reloadIfCurrent(p);
        }
      }),
    );

    return () => {
      unsubs.forEach(p => p.then(un => un()).catch(() => {}));
    };
  }, [canvasPath, reloadCanvasFromPath, showToast, state.lang]);

  // Chat → Canvas: 监听 Agent 推送的画布更新事件
  useEffect(() => {
    const handleCanvasPushEvent = (e: Event) => {
      const customEvent = e as CustomEvent<{
        source: 'agent';
        data: {
          nodes?: Array<{ id: string; label: string; file?: string; path?: string; text?: string; x?: number; y?: number; type?: string }>;
          edges?: Array<{ source: string; target: string; label?: string; relationType?: string }>;
          additions?: { nodes?: any[]; edges?: any[] };
        };
        timestamp: number;
      }>;

      if (!customEvent.detail || customEvent.detail.source !== 'agent') return;
      const { data } = customEvent.detail;

      // 处理新增节点
      const nodesToAdd = data.nodes || data.additions?.nodes || [];
      const edgesToAdd = data.edges || data.additions?.edges || [];

      if (nodesToAdd.length > 0 || edgesToAdd.length > 0) {
        // 添加新节点到画布
        if (nodesToAdd.length > 0) {
          const newNodes: Node[] = nodesToAdd.map((n: any) => {
            const nodeType = n.type === 'text' ? 'text' : n.type === 'group' ? 'group' : 'file';
            const filePath = (n.file || n.path) as string | undefined;
            const title = filePath
              ? filePath.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/, '') || filePath
              : n.label || n.name || 'New Node';

            if (nodeType === 'text') {
              return {
                id: n.id || `agent-node-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                type: 'text',
                position: n.x != null && n.y != null ? { x: n.x, y: n.y } : { x: 100 + Math.random() * 200, y: 100 + Math.random() * 200 },
                data: {
                  text: n.text || n.label || '',
                  label: n.label || n.name,
                  color: n.color || '#3b82f6',
                  addedByAgent: true,
                },
              };
            }

            return {
              id: n.id || `agent-node-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              type: 'file',
              position: n.x != null && n.y != null ? { x: n.x, y: n.y } : { x: 100 + Math.random() * 200, y: 100 + Math.random() * 200 },
              data: {
                file: filePath,
                title,
                label: n.label || n.name || title,
                color: n.color || '#3b82f6',
                addedByAgent: true,
              },
            };
          });

          setNodes(nds => [...nds, ...newNodes]);
        }

        // 添加新边
        if (edgesToAdd.length > 0) {
          const newEdges: Edge[] = edgesToAdd.map((e: any, idx: number) => ({
            id: `agent-edge-${Date.now()}-${idx}`,
            source: e.source,
            target: e.target,
            type: 'default',
            label: e.label || e.relationType || undefined,
            labelStyle: { fontSize: 10, fill: vizPalette.canvasDefaultEdge, fontWeight: 500 },
            style: { stroke: vizPalette.canvasDefaultEdge },
            data: { relationType: e.relationType, addedByAgent: true },
          }));

          setEdges(eds => [...eds, ...newEdges]);
        }

        // 显示提示
        const msg = state.lang === 'zh'
          ? `Agent 已添加 ${nodesToAdd.length} 个节点和 ${edgesToAdd.length} 条边`
          : `Agent added ${nodesToAdd.length} nodes and ${edgesToAdd.length} edges`;
        showToast(msg, 'success');

        // 触发自动布局
        setTimeout(() => {
          handleAutoLayout(true);
        }, 100);
      }
    };

    window.addEventListener('zettel:canvas-push', handleCanvasPushEvent);
    return () => {
      window.removeEventListener('zettel:canvas-push', handleCanvasPushEvent);
    };
  }, [setNodes, setEdges, state.lang, showToast, handleAutoLayout]);

  const filteredNotes = vaultNotes.filter(n => {
    const name = n.replace(/\\/g, '/').split('/').pop() || n;
    return name.toLowerCase().includes(noteSearch.toLowerCase());
  });

  // ── LOD: Inject zoom level into all node data for per-node rendering optimization (Feature 1.3) ──
  // 性能优化: 拖拽期间不更新 nodesWithZoom，避免每帧重建对象
  const nodesWithZoom = useMemo(() => {
    // 拖拽期间直接返回原数组，避免对象重建
    if (isDraggingNodeRef.current) {
      return nodes;
    }
    // 如果 zoom 没变化，直接返回原数组
    if (nodes.length > 0 && nodes[0].data?._zoom === currentZoom) {
      return nodes;
    }
    return nodes.map(n => ({
      ...n,
      data: { ...n.data, _zoom: currentZoom },
    }));
  }, [nodes, currentZoom]);

  // 性能优化: 使用 ref 存储回调，避免 useMemo 重复计算
  const onAcceptGhostEdgeRef = useRef(onAcceptGhostEdge);
  const onRejectGhostEdgeRef = useRef(onRejectGhostEdge);
  onAcceptGhostEdgeRef.current = onAcceptGhostEdge;
  onRejectGhostEdgeRef.current = onRejectGhostEdge;

  // ── Merge user edges with smart edges for rendering (Phase 29) ──
  // Apply markerEnd/markerStart based on edge.data.fromEnd/toEnd for arrow rendering
  // Also sync labelStyle color with edge stroke color
  const mergedEdges = useMemo(() => {
    const applyArrowMarkers = (e: Edge): Edge => {
      const fromEnd = (e.data?.fromEnd as string) || 'none';
      const toEnd = (e.data?.toEnd as string) || 'arrow';
      const edgeColor = (e.style?.stroke as string) || (e.data?.color as string) || vizPalette.canvasDefaultEdge;
      const updated = { ...e };
      if (toEnd === 'arrow') {
        updated.markerEnd = { type: MarkerType.ArrowClosed, width: 16, height: 16, color: edgeColor };
      } else {
        updated.markerEnd = undefined;
      }
      if (fromEnd === 'arrow') {
        updated.markerStart = { type: MarkerType.ArrowClosed, width: 16, height: 16, color: edgeColor };
      } else {
        updated.markerStart = undefined;
      }
      // A line's own colour goes through a CSS variable: the canvas stylesheet
      // paints every edge path with `!important`, which used to hide picked colours.
      const ownColor = (e.data?.color as string) || (e.style?.stroke as string) || '';
      if (ownColor) {
        updated.style = { ...updated.style, ['--edge-color' as string]: ownColor } as React.CSSProperties;
        if (updated.label) updated.labelStyle = { ...updated.labelStyle, fill: ownColor };
      }
      return updated;
    };
    // 性能优化: 使用 ref 获取最新回调，避免依赖数组变化导致重复计算
    const ghostEdgesWithCallbacks = smartEdges.map(e => ({
      ...e,
      data: {
        ...e.data,
        onAccept: onAcceptGhostEdgeRef.current,
        onReject: onRejectGhostEdgeRef.current,
      },
    }));
    return [...edges.map(applyArrowMarkers), ...ghostEdgesWithCallbacks];
  }, [edges, smartEdges]);

  // ── Smart Group Containment: auto-parent nodes dropped inside a GroupNode (Feature 1.2) ──
  /** Absolute box of a node, in flow coordinates. */
  const absBox = useCallback((id: string) => {
    const internal = reactFlowInstance.getInternalNode(id);
    if (!internal) return null;
    const p = internal.internals.positionAbsolute;
    return {
      x: p.x,
      y: p.y,
      w: internal.measured?.width ?? internal.width ?? (internal.style?.width as number) ?? 300,
      h: internal.measured?.height ?? internal.height ?? (internal.style?.height as number) ?? 200,
    };
  }, [reactFlowInstance]);

  /** Smallest group whose box contains the card's centre (absolute coordinates). */
  const groupUnderCard = useCallback((cardId: string): { id: string; x: number; y: number } | null => {
    const b = absBox(cardId);
    if (!b) return null;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    let best: { id: string; x: number; y: number } | null = null;
    let bestArea = Infinity;
    for (const g of nodesRef.current) {
      if (g.type !== 'group' || g.id === cardId) continue;
      const gb = absBox(g.id);
      if (!gb) continue;
      if (cx >= gb.x && cx <= gb.x + gb.w && cy >= gb.y && cy <= gb.y + gb.h && gb.w * gb.h < bestArea) {
        bestArea = gb.w * gb.h;
        best = { id: g.id, x: gb.x, y: gb.y };
      }
    }
    return best;
  }, [absBox]);

  // While dragging a card over a group, the group lights up as the drop target.
  // Toggled on the DOM directly so a drag doesn't re-render every card.
  const dropGroupElRef = useRef<HTMLElement | null>(null);
  const setDropGroup = useCallback((groupId: string | null) => {
    const el = groupId
      ? (document.querySelector(`.interactive-canvas-container .react-flow__node[data-id="${CSS.escape(groupId)}"]`) as HTMLElement | null)
      : null;
    if (dropGroupElRef.current === el) return;
    dropGroupElRef.current?.classList.remove('zc-drop-target');
    el?.classList.add('zc-drop-target');
    dropGroupElRef.current = el;
  }, []);

  // ── Group containment: a card dropped inside a group joins it; dragged out, it leaves ──
  // Positions are compared in absolute coordinates (a card already in a group has a
  // position relative to that group). Cards are no longer clamped to their group
  // (`extent: 'parent'`), which used to make it impossible to drag them back out.
  const handleNodeDragStop = useCallback(
    (_event: any, draggedNode: Node, draggedNodes?: Node[]) => {
      setDropGroup(null);
      const moved = (draggedNodes && draggedNodes.length > 0 ? draggedNodes : [draggedNode]).filter(n => n.type !== 'group');
      if (moved.length === 0) return;
      const movedIds = new Set((draggedNodes ?? [draggedNode]).map(n => n.id));

      const updates = new Map<string, { parentId: string | undefined; position: { x: number; y: number } }>();
      for (const n of moved) {
        // Moving together with its group: it stays where it is.
        if (n.parentId && movedIds.has(n.parentId)) continue;
        const b = absBox(n.id);
        if (!b) continue;
        const g = groupUnderCard(n.id);
        const next = g?.id;
        if ((n.parentId || undefined) === next) continue;
        updates.set(n.id, {
          parentId: next,
          position: g ? { x: b.x - g.x, y: b.y - g.y } : { x: b.x, y: b.y },
        });
      }
      if (updates.size === 0) return;

      setNodes(nds => {
        const next = nds.map(nd => {
          const u = updates.get(nd.id);
          if (!u) return nd;
          const { extent: _extent, parentId: _parentId, ...rest } = nd as any;
          return u.parentId ? { ...rest, parentId: u.parentId, position: u.position } : { ...rest, position: u.position };
        });
        // React Flow needs a parent before its children in the array.
        return [...next.filter(n => n.type === 'group'), ...next.filter(n => n.type !== 'group')];
      });
    },
    [absBox, groupUnderCard, setDropGroup, setNodes]
  );

  const handleNodeDragStopWithClear = useCallback(
    (event: any, draggedNode: Node, draggedNodes?: Node[]) => {
      clearHelperLines();
      handleNodeDragStop(event, draggedNode, draggedNodes);
      // 性能优化: 拖拽结束后触发待处理的历史记录推送和自动保存
      isDraggingNodeRef.current = false;
      if (pendingHistoryPushRef.current) {
        pendingHistoryPushRef.current = false;
        pushHistory(nodesRef.current, edges);
      }
      if (pendingAutoSaveRef.current) {
        pendingAutoSaveRef.current = false;
        handleSaveCanvas();
      }
    },
    [clearHelperLines, handleNodeDragStop, pushHistory, edges]
  );

  const selectedNodes = nodes.filter(n => n.selected);
  const selectionColor = (() => {
    const cs = new Set(selectedNodes.map(n => (n.data?.color as string | undefined)?.toLowerCase() ?? ''));
    return cs.size === 1 ? [...cs][0] || undefined : undefined;
  })();
  const canvasName = canvasPath
    ? canvasPath.replace(/\\/g, '/').split('/').pop()?.replace(/\.canvas$/i, '') || null
    : null;

  return (
    <div
      className={`interactive-canvas-container canvas-edit-mode${penMode !== 'off' ? ` canvas-pen-active canvas-pen-active--${penMode}` : ''}${isConnecting ? ' is-connecting' : ''}${isAgentOpen ? ' has-side-panel' : ''}`}
      onMouseMove={handleMouseMove}
    >
      {/* Canvas chrome: file (top-left), review + suggestions (top-right),
          selection (top-center), add dock (bottom-center). */}
      <CanvasTopBar
        lang={state.lang}
        canvasName={canvasName}
        onNew={handleNewCanvas}
        onOpen={handleOpenCanvas}
        onSave={handleSaveCanvas}
        onTemplates={() => setIsTemplateOpen(true)}
        onUndo={handleUndo}
        onRedo={handleRedo}
      />
      <CanvasReviewBar
        lang={state.lang}
        panelOpen={isAgentOpen}
        checking={isDiagnosticRunning}
        checkActive={!!diagnostics}
        onCheck={handleDiagnoseCanvas}
        addByTopicOpen={smartCanvasOpen}
        onAddByTopic={() => setSmartCanvasOpen(!smartCanvasOpen)}
        planOpen={canvasPlanOpen}
        onPlan={() => setCanvasPlanOpen(!canvasPlanOpen)}
        suggestionCount={canvasSuggestions.length}
        onTogglePanel={() => setIsAgentOpen(prev => !prev)}
      />
      <SelectionBar
        lang={state.lang}
        count={selectedNodes.length}
        shifted={isAgentOpen}
        currentColor={selectionColor}
        onAlign={alignSelectedNodes}
        onColor={(hue) => selectedNodes.forEach(n => handleSetNodeColor(n.id, hue))}
        onDiscuss={handleDiscussSelectedNodes}
        onDelete={() => selectedNodes.forEach(n => handleDeleteNode(n.id))}
      />
      <CanvasDock
        lang={state.lang}
        onAddNote={() => openAddNoteModal()}
        onAddSticky={handleAddTextNode}
        onAddGroup={handleAddGroupNode}
        onAddWeb={handleAddWebNode}
        onAddPdf={handleAddPdfNode}
        onAddImage={handleAddImageNode}
        penMode={penMode}
        setPenMode={setPenMode}
      />

      {/* 自由手绘笔刷控件面板 */}
      {penMode !== 'off' && (
        <div className={`canvas-pen-indicator ${penMode}`}>
          {penMode === 'pen' ? (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
              <span className="canvas-pen-label">{state.lang === 'zh' ? '画笔' : 'Pen'}</span>
              {/* Color swatches */}
              <div className="canvas-pen-colors">
                {(['#3b82f6', '#ef4444', '#10b981', '#8b5cf6', '#1e293b'] as const).map(c => (
                  <button
                    key={c}
                    className={`canvas-pen-color-swatch ${penColor === c ? 'active' : ''}`}
                    style={{ backgroundColor: c }}
                    onClick={() => setPenColor(c)}
                    title={c}
                  />
                ))}
              </div>
              {/* Size slider */}
              <div className="canvas-pen-size-slider">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="4"/></svg>
                <input
                  type="range"
                  min="1"
                  max="16"
                  value={penSize}
                  onChange={e => setPenSize(Number(e.target.value))}
                  className="canvas-pen-range"
                />
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="7"/></svg>
              </div>
              {/* Undo button */}
              <button
                className="canvas-pen-undo-btn"
                onClick={() => freehandRef.current?.undo()}
                title={state.lang === 'zh' ? `撤销最后一笔 (Ctrl+Z)` : `Undo last stroke (Ctrl+Z)`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
              </button>
              {/* Clear all */}
              <button
                className="canvas-pen-clear-btn"
                onClick={() => freehandRef.current?.clearAll()}
                title={state.lang === 'zh' ? '清除全部笔触' : 'Clear all strokes'}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </button>
              <span className="canvas-pen-hint">Esc</span>
            </>
          ) : (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 20H7L3 16c-.8-.8-.8-2 0-2.8L14 2.2c.8-.8 2-.8 2.8 0l5 5c.8.8.8 2 0 2.8L12 20"/><path d="M6.5 13.5L16 4"/><line x1="7" y1="20" x2="9" y2="18"/></svg>
              <span className="canvas-pen-label">{state.lang === 'zh' ? '擦除' : 'Eraser'}</span>
              {/* Eraser size slider */}
              <div className="canvas-pen-size-slider">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="4"/></svg>
                <input
                  type="range"
                  min="4"
                  max="48"
                  value={eraserSize}
                  onChange={e => setEraserSize(Number(e.target.value))}
                  className="canvas-pen-range canvas-pen-range--eraser"
                />
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="7"/></svg>
              </div>
              {/* Undo button also in eraser mode */}
              <button
                className="canvas-pen-undo-btn"
                onClick={() => freehandRef.current?.undo()}
                title={state.lang === 'zh' ? '撤销最后一笔 (Ctrl+Z)' : 'Undo last stroke (Ctrl+Z)'}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
              </button>
              <span className="canvas-pen-hint">Esc</span>
            </>
          )}
        </div>
      )}

      {/* Agent 操作进度浮层 — Smart Canvas (AI 增强版) */}
      {agentProgress && (
        <div style={{
          position: 'absolute',
          bottom: 72, // above the add dock
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 100,
          width: '420px',
          maxWidth: 'calc(100% - var(--space-8))',
        }}>
          <ProgressPanel
            title={state.lang === 'zh' ? '正在整理画布' : 'Updating canvas'}
            current={agentProgress.step}
            total={agentProgress.steps.length}
            stage={state.lang === 'zh' 
              ? agentProgress.steps[agentProgress.step - 1]?.labelZh || ''
              : agentProgress.steps[agentProgress.step - 1]?.label || ''}
            stageDescription={state.lang === 'zh'
              ? agentProgress.steps[agentProgress.step - 1]?.descZh || ''
              : agentProgress.steps[agentProgress.step - 1]?.desc || ''}
            variant="primary"
            showCancel={false}
            indeterminate={false}
          />
        </div>
      )}

      {/* Smart Canvas Panel */}
      <SmartCanvasPanel
        isOpen={smartCanvasOpen}
        onClose={() => setSmartCanvasOpen(false)}
        onAddNotes={(results) => {
          // 关闭面板,只显示悬浮进度条
          setSmartCanvasOpen(false);
          // Plain progress copy: say what is happening, not how clever it is.
          const scSteps = [
            { label: 'Adding notes', labelZh: '添加笔记', desc: 'Placing the notes you picked', descZh: '正在放入选中的笔记' },
            { label: 'Linking', labelZh: '查找关联', desc: 'Connecting them to related cards', descZh: '正在连到画布上相关的卡片' },
            { label: 'Arranging', labelZh: '排列卡片', desc: 'Moving cards so nothing overlaps', descZh: '正在调整位置，避免重叠' },
            { label: 'Done', labelZh: '完成', desc: '', descZh: '' },
          ];
          setAgentProgress({ step: 1, steps: scSteps });
          handleSmartCanvasSearch(undefined, results, (step) => {
            const stepIdx: Record<string, number> = { 'adding': 1, 'connecting': 2, 'arranging': 3, 'done': 4 };
            const idx = stepIdx[step];
            if (idx) setAgentProgress({ step: idx, steps: scSteps });
            if (step === 'done') {
              setTimeout(() => setAgentProgress(null), 600);
            }
          });
        }}
        canvasNodePaths={nodes.filter(n => n.type === 'file').map(n => n.data.file as string)}
        lang={state.lang}
      />

      {/* Canvas Plan Panel — 与 Smart Canvas 并列的另一个入口，不替换它 */}
      <CanvasPlanPanel
        isOpen={canvasPlanOpen}
        onClose={() => {
          setCanvasPlanOpen(false);
          setActivePlanId(null);
        }}
        lang={state.lang}
        canvasPath={canvasPath}
        vaultPath={state.vaultPath || ''}
        vaultPaths={state.vaultPaths || []}
        canvasNodePaths={nodes.filter(n => n.type === 'file').map(n => n.data.file as string)}
        initialPlanId={activePlanId}
        onCommitted={() => {
          // 写入是后端做的，前端这里只重新读盘。自己在内存里"顺便"加一遍节点会让
          // 界面显示的内容与文件里的不是同一份。
          if (canvasPath) reloadCanvasFromPath(canvasPath, { silent: true, fitView: false });
        }}
      />

      {/* Canvas Controls — 左下角浮动控制 */}
      <CanvasControls
        reactFlowInstance={reactFlowInstance}
        zoom={currentZoom}
        lang={state.lang}
        nodes={nodes}
      />

      {/* Canvas Find (Ctrl+F) */}
      {canvasFindOpen && (
        <div className="canvas-find-overlay" onMouseDown={e => e.stopPropagation()}>
          <div className="canvas-find-box">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input
              type="text"
              className="canvas-find-input"
              placeholder={state.lang === 'zh' ? '搜索画布中的卡片...' : 'Search canvas nodes...'}
              value={canvasFindQuery}
              onChange={e => setCanvasFindQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.shiftKey ? navigateToFindResult(canvasFindActiveIdx - 1) : navigateToFindResult(canvasFindActiveIdx + 1);
                }
                if (e.key === 'Escape') closeCanvasFind();
              }}
              autoFocus
            />
            {canvasFindQuery.trim() && (
              <span className="canvas-find-counter">
                {canvasFindResults.length > 0
                  ? `${canvasFindActiveIdx + 1}/${canvasFindResults.length}`
                  : state.lang === 'zh' ? '无结果' : 'No results'
                }
              </span>
            )}
            {canvasFindResults.length > 1 && (
              <>
                <button
                  className="canvas-find-nav-btn"
                  onClick={() => navigateToFindResult(canvasFindActiveIdx - 1)}
                  title={state.lang === 'zh' ? '上一个' : 'Previous'}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="m18 15-6-6-6 6"/>
                  </svg>
                </button>
                <button
                  className="canvas-find-nav-btn"
                  onClick={() => navigateToFindResult(canvasFindActiveIdx + 1)}
                  title={state.lang === 'zh' ? '下一个' : 'Next'}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="m6 9 6 6 6-6"/>
                  </svg>
                </button>
              </>
            )}
            <button
              className="canvas-find-close-btn"
              onClick={closeCanvasFind}
              title={state.lang === 'zh' ? '关闭' : 'Close'}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6 6 18M6 6l12 12"/>
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* 5. Empty canvas guidance hint */}
      {nodes.length === 0 && (
        <div className="canvas-empty-hint">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="3" width="7" height="7" rx="1.5"/>
            <rect x="14" y="3" width="7" height="7" rx="1.5"/>
            <rect x="3" y="14" width="7" height="7" rx="1.5"/>
            <rect x="14" y="14" width="7" height="7" rx="1.5"/>
            <line x1="10" y1="6.5" x2="14" y2="6.5" strokeDasharray="2 2"/>
            <line x1="6.5" y1="10" x2="6.5" y2="14" strokeDasharray="2 2"/>
          </svg>
          <div className="canvas-empty-hint-title">{t('canvas.emptyTitle')}</div>
          <div className="canvas-empty-hint-sub">
            {t('canvas.emptyDesc')}
          </div>
        </div>
      )}

      {/* React Flow Board */}
      <div ref={canvasContainerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <ReactFlow
        nodes={nodesWithZoom}
        edges={mergedEdges}
        proOptions={{ hideAttribution: true }}
        onNodesChange={onNodesChangeWithAlignment}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={() => { setIsConnecting(true); setQuickConnectMenu(null); }}
        onConnectEnd={(event, connectionState) => { setIsConnecting(false); onConnectEnd(event, connectionState); }}
        onReconnect={onReconnect}
        onReconnectStart={() => { setIsConnecting(true); onReconnectStart(); }}
        onReconnectEnd={(event, edge, handleType, connectionState) => { setIsConnecting(false); onReconnectEnd(event, edge, handleType, connectionState); }}
        connectionRadius={28}
        reconnectRadius={14}
        connectionLineComponent={CanvasConnectionLine}
        nodeDragThreshold={2}
        onEdgesDelete={onEdgesDelete}
        onNodeContextMenu={handleNodeContextMenu}
        onPaneContextMenu={handlePaneContextMenu}
        onPaneClick={handlePaneClick}
        onEdgeContextMenu={(event, edge) => {
          if ((edge.data as any)?._smart) { handleSmartEdgeContextMenu(event, edge); return; }
          handleEdgeContextMenu(event, edge);
        }}
        onEdgeClick={(event, edge) => {
          if ((edge.data as any)?._smart) { handleSmartEdgeClick(event, edge); return; }
        }}
        onEdgeDoubleClick={handleEdgeDoubleClick}
        onNodeMouseEnter={(_e, node) => { hoveredNodeRef.current = node.id; }}
        onNodeMouseLeave={() => { hoveredNodeRef.current = null; }}
        onEdgeMouseEnter={(_e, edge) => { hoveredEdgeRef.current = edge.id; }}
        onEdgeMouseLeave={() => { hoveredEdgeRef.current = null; }}
        onNodeDragStart={() => { 
          setContextMenu(null); 
          setPaneMenu(null); 
          setQuickConnectMenu(null); 
          // 性能优化: 拖拽开始时初始化空间索引，设置拖拽状态
          isDraggingNodeRef.current = true;
          onDragStart('');
        }}
        onNodeDrag={(_e, node, dragged) => {
          // 性能优化: 拖拽时同步位置到混合渲染器
          if (hybridRendererRef.current && isDraggingNodeRef.current) {
            hybridRendererRef.current.updateNodePosition(node.id, node.position.x, node.position.y);
          }
          // Light up the group a dragged card would drop into.
          const card = (dragged && dragged.length > 0 ? dragged : [node]).find(n => n.type !== 'group');
          setDropGroup(card ? groupUnderCard(card.id)?.id ?? null : null);
        }}
        onNodeDragStop={handleNodeDragStopWithClear}
        onMoveStart={() => { setContextMenu(null); setPaneMenu(null); setQuickConnectMenu(null); }}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionMode={ConnectionMode.Loose}
        defaultEdgeOptions={{ type: 'default', animated: false, markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: vizPalette.canvasDefaultEdge } }}
        panOnDrag={[1, 2]}
        selectionOnDrag={penMode === 'off' || shiftHeld}
        minZoom={0.05}
        maxZoom={10}
        fitView
      >
        <Background gap={20} color={vizPalette.surface.grid} />
        {nodes.length > 0 && (
          <MiniMap pannable zoomable style={{ width: 168, height: 112 }} nodeBorderRadius={6} />
        )}
        <SnapGuides lines={helperLines} />
      </ReactFlow>
      </div>

      {/* 自由手绘 SVG 浮层 */}
      <FreehandOverlay
        ref={freehandRef}
        mode={penMode}
        viewport={freehandViewport}
        penColor={penColor}
        penSize={penSize}
        eraserSize={eraserSize}
        canvasPath={canvasPath}
      />

      {/* Edge Label Editor */}
      {editingEdgeId && (
        <EdgeLabelEditor
          editingEdgeId={editingEdgeId}
          edgeLabelPos={edgeLabelPos}
          edgeLabelInput={edgeLabelInput}
          setEdgeLabelInput={setEdgeLabelInput}
          handleEdgeLabelConfirm={handleEdgeLabelConfirm}
          handleEdgeLabelCancel={handleEdgeLabelCancel}
        />
      )}

      {/* Node Context Menu */}
      {contextMenu && (
        <NodeContextMenu
          contextMenu={contextMenu}
          setContextMenu={setContextMenu}
          handleDeleteNode={handleDeleteNode}
          handleDuplicateNode={handleDuplicateNode}
          reactFlowInstance={reactFlowInstance}
          setCurrentFile={setCurrentFile}
          setView={setView}
          handleConvertTextToNote={handleConvertTextToNote}
          handleSetNodeColor={handleSetNodeColor}
          selectedNodeCount={selectedNodes.length}
          onDiscussSelection={handleDiscussSelectedNodes}
          onBringToFront={handleBringToFront}
          onSendToBack={handleSendToBack}
        />
      )}

      {/* Edge Context Menu */}
      {edgeContextMenu && (
        <EdgeContextMenu
          edgeContextMenu={edgeContextMenu}
          setEdgeContextMenu={setEdgeContextMenu}
          edges={edges}
          setEditingEdgeId={setEditingEdgeId}
          setEdgeLabelInput={setEdgeLabelInput}
          setEdgeLabelPos={setEdgeLabelPos}
          handleSetEdgeDirection={handleSetEdgeDirection}
          handleSetEdgeRelation={handleSetEdgeRelation}
          handleSetEdgeColor={handleSetEdgeColor}
          handleDeleteEdge={handleDeleteEdge}
        />
      )}

      {/* Pane Context Menu */}
      {paneMenu && (
        <PaneContextMenu
          paneMenu={paneMenu}
          addNodeAtPosition={addNodeAtPosition}
          handleAddPdfNode={handleAddPdfNode}
          handleAddImageNode={handleAddImageNode}
          setPaneMenu={setPaneMenu}
        />
      )}

      {/* Quick-Create from Connection End */}
      {quickConnectMenu && (
        <QuickConnectMenu
          quickConnectMenu={quickConnectMenu}
          handleQuickCreate={handleQuickCreate}
          quickConnectSuggestions={quickConnectSuggestions}
          handleQuickConnectSimilar={handleQuickConnectSimilar}
        />
      )}
      <CanvasModals
        isTemplateOpen={isTemplateOpen}
        setIsTemplateOpen={setIsTemplateOpen}
        applyTemplate={applyTemplate}
        isAddNoteOpen={isAddNoteOpen}
        setIsAddNoteOpen={setIsAddNoteOpen}
        noteSearch={noteSearch}
        setNoteSearch={setNoteSearch}
        filteredNotes={vaultNotes}
        handleAddNoteNode={handleAddNoteNode}
        lang={state.lang}
        vaultPaths={state.vaultPaths || []}
        onCanvasPaths={nodes.filter(n => n.type === 'file').map(n => n.data.file as string)}
      />

      {/* Suggestions panel (toggled from the top-right bar) */}
      <AgentPanel
        view="canvas"
        isOpen={isAgentOpen}
        onClose={() => setIsAgentOpen(false)}
        canvasStats={canvasStats || undefined}
        canvasSuggestions={canvasSuggestions}
        onCanvasAction={handleCanvasAgentAction}
        isSmartCanvasLoading={smartCanvasLoading}
      />
    </div>
  );
}

export function InteractiveCanvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
