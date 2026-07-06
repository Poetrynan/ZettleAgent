import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getKnowledgeGraph, GraphData, GraphNode, deleteFile, syncVault } from '../../lib/tauri';
import { useApp } from '../../contexts/AppContext';
import { t } from '../../lib/i18n';
import { IconBrain, IconLink, IconRobot } from '../icons';
import {
  RelationFilter,
  mapNoteType,
} from './graphHelpers';
import '../../styles/KnowledgeGraph.css';

import { PixiGraph, type PixiGraphHandle, type PGNode, type PGGraphData, type ForceParams, DEFAULT_FORCE_PARAMS } from './PixiGraph';

import { GraphHud } from './GraphHud';
import { GraphTimeSlider } from './GraphTimeSlider';
import { GraphHoverCard } from './GraphHoverCard';
import { GraphContextMenu } from './GraphContextMenu';
import { AgentPanel } from '../common/AgentPanel';






// ── Types ──────────────────────────────────────────────────────────

export interface FGNode extends GraphNode {
  x?: number;
  y?: number;
  degree?: number;
}

interface FGLink {
  source: string | FGNode;
  target: string | FGNode;
  edge_type: string;
  weight: number;
  label?: string;
}

interface FGGraphData {
  nodes: FGNode[];
  links: FGLink[];
}



// ══════════════════════════════════════════════════════════════════════
// ── Main Component ──────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

export function KnowledgeGraph() {
  const containerRef = useRef<HTMLDivElement>(null);
  const pixiRef = useRef<PixiGraphHandle | null>(null);

  const [rawGraphData, setRawGraphData] = useState<GraphData | null>(null);
  const [semanticThreshold, setSemanticThreshold] = useState(0.70);

  const [hoveredNode, setHoveredNode] = useState<FGNode | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: FGNode } | null>(null);
  const [selectedCluster, setSelectedCluster] = useState<number | null>(null);
  const [relationFilter, setRelationFilter] = useState<RelationFilter>('all');
  const [timeSliderValue, setTimeSliderValue] = useState(-1);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [isDraggingBg, setIsDraggingBg] = useState(false);

  // ── Local Graph + Depth + Orphans ──
  const [isLocalMode, setIsLocalMode] = useState(false);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [localDepth, setLocalDepth] = useState(1);
  const [hideOrphans, setHideOrphans] = useState(false);
  const [folderFilter, setFolderFilter] = useState<Set<string>>(new Set());
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const folderPickerRef = useRef<HTMLDivElement>(null);
  const folderBtnRef = useRef<HTMLDivElement>(null);
  const [hudCollapsed, setHudCollapsed] = useState(false);
  const [tipsCollapsed, setTipsCollapsed] = useState(false);

  // ── Force parameters (Obsidian-style live sliders) ──
  const [forceParams, setForceParams] = useState<ForceParams>(DEFAULT_FORCE_PARAMS);

  // Suppress unused compiler warnings
  if (false as boolean) {
    console.log(setIsLocalMode, setLocalDepth, setHideOrphans, focusNodeId);
  }

  const { setCurrentFile, setView, state, showToast, toggleChat } = useApp();
  const isZh = state.lang === 'zh';

  const [isAgentOpen, setIsAgentOpen] = useState(false);
  const [selectedNodes, setSelectedNodes] = useState<FGNode[]>([]);

  // Track last click time for double-click detection
  const lastClickTime = useRef(0);
  const lastClickNodeId = useRef<string | null>(null);

  // ── Measure container dimensions ─────────────────────────────────
  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width > 0 && height > 0) {
      setDimensions({ width, height });
    }
  }, []);

  // ── Resize observer ──────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => measure());
    observer.observe(container);

    measure();

    return () => {
      observer.disconnect();
    };
  }, [measure]);

  // ── 监听全局事件：Toggle AgentPanel (Ctrl+K) ──
  useEffect(() => {
    const handleToggleAgent = () => setIsAgentOpen(prev => !prev);
    window.addEventListener('zettel:toggle-agent', handleToggleAgent);
    return () => window.removeEventListener('zettel:toggle-agent', handleToggleAgent);
  }, []);

  // Re-measure when active tab or view mode changes
  useEffect(() => {
    if (state.view === 'graph') {
      measure();
      const timer = setTimeout(measure, 100);
      return () => clearTimeout(timer);
    }
  }, [state.view, measure]);

  // ── Drag background cursor state ──────────────────────────────────
  const handleMouseDown = useCallback(() => {
    if (!hoveredNode) {
      setIsDraggingBg(true);
    }
  }, [hoveredNode]);

  const handleMouseUpOrLeave = useCallback(() => {
    setIsDraggingBg(false);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('mousedown', handleMouseDown);
    container.addEventListener('mouseup', handleMouseUpOrLeave);
    container.addEventListener('mouseleave', handleMouseUpOrLeave);

    return () => {
      container.removeEventListener('mousedown', handleMouseDown);
      container.removeEventListener('mouseup', handleMouseUpOrLeave);
      container.removeEventListener('mouseleave', handleMouseUpOrLeave);
    };
  }, [handleMouseDown, handleMouseUpOrLeave]);

  // ── Load graph data ──────────────────────────────────────────────
  const loadGraph = useCallback(async () => {
    try {
      // Sync all vault paths
      if (state.vaultPaths && state.vaultPaths.length > 0) {
        for (const vp of state.vaultPaths) {
          await syncVault(vp).catch(e => console.error('Failed to sync vault for graph:', e));
        }
      } else if (state.vaultPath) {
        await syncVault(state.vaultPath).catch(e => console.error('Failed to sync vault for graph:', e));
      }
      const data = await getKnowledgeGraph(state.vaultPath || '');
      setRawGraphData(data);
    } catch (err) {
      console.warn('Failed to load graph (no vault?):', err);
      setRawGraphData({ nodes: [], edges: [], clusters: [] });
    }
  }, [state.vaultPaths, state.vaultPath]);

  useEffect(() => {
    loadGraph();
  }, [loadGraph, state.methodology]);

  // ── Auto-refresh graph after smart organize completes ───────────
  useEffect(() => {
    const unlisten = listen<{ stage: string }>('scheduler-progress', (event) => {
      if (event.payload.stage === 'done') {
        // Reload graph data after organize finishes
        loadGraph();
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [loadGraph]);

  // ── Close context menu on click anywhere ─────────────────────────
  useEffect(() => {
    const handleGlobalClick = (e: MouseEvent) => {
      setContextMenu(null);
      // Close folder picker if clicking outside both dropdown and trigger button
      if (showFolderPicker && folderPickerRef.current && folderBtnRef.current
          && !folderPickerRef.current.contains(e.target as Node)
          && !folderBtnRef.current.contains(e.target as Node)) {
        setShowFolderPicker(false);
      }
    };
    if (contextMenu || showFolderPicker) {
      document.addEventListener('click', handleGlobalClick);
      return () => document.removeEventListener('click', handleGlobalClick);
    }
  }, [contextMenu, showFolderPicker]);

  // ── Filter raw graph data by active vault paths ──────────────────
  const activeGraphData = useMemo(() => {
    if (!rawGraphData) return null;

    const activeVaults = state.vaultPaths && state.vaultPaths.length > 0
      ? state.vaultPaths
      : state.vaultPath
        ? [state.vaultPath]
        : [];

    if (activeVaults.length === 0) return rawGraphData;

    // Filter nodes by active vault paths
    const nodes = rawGraphData.nodes.filter(n => {
      const normalizedPath = n.id.replace(/\\/g, '/').toLowerCase();
      return activeVaults.some(vp => {
        const normalizedVault = vp.replace(/\\/g, '/').toLowerCase();
        return normalizedPath.startsWith(normalizedVault);
      });
    });

    const activeNodeIds = new Set(nodes.map(n => n.id));

    // Filter edges
    const edges = rawGraphData.edges.filter(e =>
      activeNodeIds.has(e.source) && activeNodeIds.has(e.target) &&
      (e.edge_type !== 'semantic' || e.weight >= semanticThreshold)
    );

    // Re-calculate cluster node counts dynamically for active nodes
    const clusterCounts = new Map<number, number>();
    for (const node of nodes) {
      if (node.cluster !== undefined) {
        clusterCounts.set(node.cluster, (clusterCounts.get(node.cluster) || 0) + 1);
      }
    }

    // Filter clusters to only include those with active nodes, and update count
    const clusters = (rawGraphData.clusters || [])
      .map(c => ({
        ...c,
        node_count: clusterCounts.get(Number(c.id)) || 0
      }))
      .filter(c => c.node_count > 0);

    return { nodes, edges, clusters };
  }, [rawGraphData, state.vaultPaths, state.vaultPath, semanticThreshold]);

  // Compute graph statistics for AgentPanel
  const graphStats = useMemo(() => {
    if (!activeGraphData) return undefined;
    const hubCount = activeGraphData.nodes.filter(n => n.is_hub).length;
    const orphanCount = activeGraphData.nodes.filter(n => n.is_orphan).length;
    return {
      totalNodes: activeGraphData.nodes.length,
      totalEdges: activeGraphData.edges.length,
      clusterCount: activeGraphData.clusters?.length || 0,
      hubCount,
      orphanCount,
    };
  }, [activeGraphData]);

  const handleGraphAgentAction = useCallback(async (action: string, data?: any) => {
    if (action === 'highlight-orphans') {
      setHideOrphans(false);
      showToast(isZh ? '已在图谱中展示所有孤立卡片，标有虚线外圈' : 'All orphan cards shown with dotted rings', 'info');
    } else if (action === 'explain-relation') {
      if (!data || data.length < 2) return;
      const list = data as { id: string; label: string }[];
      window.dispatchEvent(new CustomEvent('zettel:agent-task', {
        detail: {
          prompt: isZh
            ? `请帮我深入分析并解读笔记库中这几篇笔记之间的概念关系：\n${list.map(n => `- [[${n.label}]]`).join('\n')}\n请调取相关内容并建立分析。`
            : `Please analyze the conceptual relationship between these notes in the vault:\n${list.map(n => `- [[${n.label}]]`).join('\n')}\nUse your tools to read and explain.`,
          mode: 'agent',
          label: isZh ? '分析概念关联' : 'Explaining Relations'
        }
      }));
      if (!state.isChatOpen) {
        toggleChat();
      }
    } else if (action === 'create-canvas') {
      if (!data || data.length === 0) return;
      const list = data as { id: string; label: string }[];
      const canvasName = isZh ? '智能生成白板.canvas' : 'Smart Board.canvas';
      window.dispatchEvent(new CustomEvent('zettel:agent-task', {
        detail: {
          prompt: isZh
            ? `请创建一个名为 "${canvasName}" 的白板，并将以下笔记作为卡片放入画布中，根据它们的关系自动连线并排版：\n${list.map(n => `- [[${n.label}]]`).join('\n')}`
            : `Please create a canvas named "${canvasName}" containing these notes as cards. Auto-link and arrange them:\n${list.map(n => `- [[${n.label}]]`).join('\n')}`,
          mode: 'agent',
          label: isZh ? '生成关系白板' : 'Creating Canvas'
        }
      }));
      if (!state.isChatOpen) {
        toggleChat();
      }
    }
  }, [isZh, toggleChat, state.isChatOpen, showToast]);

  // ── Sorted nodes for time travel ─────────────────────────────────
  const sortedNodeIds = useMemo(() => {
    if (!activeGraphData) return [];
    return [...activeGraphData.nodes]
      .sort((a, b) => {
        const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
        const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
        if (ta !== tb) return ta - tb;
        return a.id.localeCompare(b.id);
      })
      .map(n => n.id);
  }, [activeGraphData]);

  // ── Transform + filter graph data ────────────────────────────────
  const graphData: FGGraphData = useMemo(() => {
    if (!activeGraphData) return { nodes: [], links: [] };

    // Time filter
    let visibleNodeIds: Set<string>;
    if (timeSliderValue >= 0 && timeSliderValue < sortedNodeIds.length) {
      visibleNodeIds = new Set(sortedNodeIds.slice(0, timeSliderValue));
    } else {
      visibleNodeIds = new Set(activeGraphData.nodes.map(n => n.id));
    }

    // Cluster filter
    let nodes = activeGraphData.nodes.filter(n => visibleNodeIds.has(n.id));
    if (selectedCluster !== null) {
      nodes = nodes.filter(n => n.cluster === selectedCluster);
    }

    // ── Methodology mapping: remap note_type to current methodology's vocabulary ──
    // Instead of filtering out notes from other methodologies, we map their types.
    // This allows instant methodology switching with zero API cost.
    const currentMethodology = state.methodology || 'generic';
    nodes = nodes.map(n => ({
      ...n,
      note_type: mapNoteType(n.note_type, currentMethodology),
    }));

    // ── Folder filter (multi-workspace) ──
    if (folderFilter.size > 0 && state.vaultPaths && state.vaultPaths.length > 1) {
      nodes = nodes.filter(n => {
        const normalizedId = n.id.replace(/\\/g, '/');
        return Array.from(folderFilter).some(fp => {
          const prefix = fp.replace(/\\/g, '/');
          return normalizedId.startsWith(prefix);
        });
      });
    }

    // ── Local Graph: BFS from focusNodeId ──
    if (isLocalMode && focusNodeId) {
      const allNodeIds = new Set(nodes.map(n => n.id));
      // Build adjacency map from ALL edges (not yet filtered)
      const adj = new Map<string, Set<string>>();
      for (const e of activeGraphData.edges) {
        if (!allNodeIds.has(e.source) || !allNodeIds.has(e.target)) continue;
        if (!adj.has(e.source)) adj.set(e.source, new Set());
        if (!adj.has(e.target)) adj.set(e.target, new Set());
        adj.get(e.source)!.add(e.target);
        adj.get(e.target)!.add(e.source);
      }
      // BFS up to localDepth
      const visited = new Set<string>();
      let frontier = [focusNodeId];
      visited.add(focusNodeId);
      for (let d = 0; d < localDepth; d++) {
        const nextFrontier: string[] = [];
        for (const nodeId of frontier) {
          const neighbors = adj.get(nodeId);
          if (neighbors) {
            for (const nbr of neighbors) {
              if (!visited.has(nbr)) {
                visited.add(nbr);
                nextFrontier.push(nbr);
              }
            }
          }
        }
        frontier = nextFrontier;
      }
      nodes = nodes.filter(n => visited.has(n.id));
    }

    // ── Orphan filter ──
    if (hideOrphans) {
      const connectedIds = new Set<string>();
      for (const e of activeGraphData.edges) {
        connectedIds.add(e.source);
        connectedIds.add(e.target);
      }
      nodes = nodes.filter(n => connectedIds.has(n.id));
    }

    const nodeIdSet = new Set(nodes.map(n => n.id));

    // Edge filter
    let edges = activeGraphData.edges.filter(e =>
      nodeIdSet.has(e.source) && nodeIdSet.has(e.target)
    );
    if (relationFilter !== 'all') {
      edges = edges.filter(e => {
        if (relationFilter === 'semantic') {
          return e.edge_type === 'semantic';
        }
        const lbl = (e.label || '').toLowerCase();
        return lbl === relationFilter;
      });
    }

    // Map to force-graph format (edges → links)
    const links: FGLink[] = edges.map(e => ({
      source: e.source,
      target: e.target,
      edge_type: e.edge_type,
      weight: e.weight,
      label: e.label,
    }));

    // Compute degree (connection count) for each node
    const degreeMap = new Map<string, number>();
    for (const link of links) {
      const srcId = typeof link.source === 'string' ? link.source : link.source.id;
      const tgtId = typeof link.target === 'string' ? link.target : link.target.id;
      degreeMap.set(srcId, (degreeMap.get(srcId) || 0) + 1);
      degreeMap.set(tgtId, (degreeMap.get(tgtId) || 0) + 1);
    }

    const nodesWithDegree: FGNode[] = (nodes as FGNode[]).map(n => ({
      ...n,
      degree: degreeMap.get(n.id) || 0,
    }));

    return { nodes: nodesWithDegree, links };
  }, [rawGraphData, selectedCluster, relationFilter, timeSliderValue, sortedNodeIds, isLocalMode, focusNodeId, localDepth, hideOrphans, folderFilter, state.vaultPaths, state.methodology]);

  // ── Event handlers ───────────────────────────────────────────────
  const handleNodeClick = useCallback((node: FGNode, event: MouseEvent) => {
    const now = Date.now();
    if (lastClickNodeId.current === node.id && now - lastClickTime.current < 400) {
      // Double click → open in editor
      setCurrentFile(node.id);
      setView('note');
    } else {
      // Single click → only focus within graph, do NOT set currentFile
      if (isLocalMode) {
        setFocusNodeId(node.id);
      }

      // Update selection
      if (event.ctrlKey || event.metaKey) {
        setSelectedNodes(prev => {
          const exists = prev.some(n => n.id === node.id);
          if (exists) return prev.filter(n => n.id !== node.id);
          return [...prev, node];
        });
      } else {
        setSelectedNodes([node]);
      }
    }
    lastClickTime.current = now;
    lastClickNodeId.current = node.id;
  }, [setCurrentFile, setView, isLocalMode]);


  const handleNodeHover = useCallback((node: FGNode | null) => {
    setHoveredNode(node || null);
    if (containerRef.current) {
      containerRef.current.style.cursor = node ? 'pointer' : 'default';
    }
  }, []);

  const handleNodeRightClick = useCallback((node: FGNode, event: MouseEvent) => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, node });
  }, []);

  const handleDeleteNode = useCallback(async () => {
    if (!contextMenu) return;
    const nodePath = contextMenu.node.id;
    setContextMenu(null);
    try {
      await deleteFile(nodePath);
      setRawGraphData((prev) => {
        if (!prev) return prev;
        return {
          nodes: prev.nodes.filter((n) => n.id !== nodePath),
          edges: prev.edges.filter((e) => e.source !== nodePath && e.target !== nodePath),
          clusters: prev.clusters,
        };
      });
    } catch (err) {
      console.error('Failed to delete file:', err);
    }
  }, [contextMenu]);

  const handleFitToScreen = useCallback(() => {
    pixiRef.current?.fitToScreen();
  }, []);

  // Zoom-out-then-fit transition for filter switches
  const handleFilterSwitch = useCallback((changeFn: () => void) => {
    changeFn();
  }, []);

  // Space key → fit to screen
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      if (activeEl && (
        activeEl.tagName === 'INPUT' || 
        activeEl.tagName === 'TEXTAREA' || 
        activeEl.getAttribute('contenteditable') === 'true'
      )) return;
      if (e.code === 'Space') {
        e.preventDefault();
        handleFitToScreen();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleFitToScreen]);

  // Auto-fit only on first stabilization (mount), not after every drag
  const hasFittedOnMount = useRef(false);

  // Re-center graph only on first mount, not on every tab switch
  const hasFittedOnce = useRef(false);
  useEffect(() => {
    if (state.view === 'graph' && graphData.nodes.length > 0 && !hasFittedOnce.current) {
      hasFittedOnce.current = true;
      const fit1 = setTimeout(() => handleFitToScreen(), 300);
      const fit2 = setTimeout(() => handleFitToScreen(), 800);
      return () => { clearTimeout(fit1); clearTimeout(fit2); };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.view]);

  // Fallback: fit once on mount, not on every data change
  useEffect(() => {
    if (graphData.nodes.length === 0 || hasFittedOnMount.current) return;
    const timer = setTimeout(() => {
      if (!hasFittedOnMount.current) {
        handleFitToScreen();
        hasFittedOnMount.current = true;
      }
    }, 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);









  // U1: Compute relation breakdown for hovered node (must be before early returns)
  const hoveredRelationBreakdown = useMemo(() => {
    if (!hoveredNode || !activeGraphData) return null;
    const relEdges = activeGraphData.edges.filter(
      e => (e.source === hoveredNode.id || e.target === hoveredNode.id) && e.label
    );
    if (relEdges.length === 0) return null;
    const counts: Record<string, number> = {};
    for (const e of relEdges) {
      const lbl = e.label!;
      counts[lbl] = (counts[lbl] || 0) + 1;
    }
    return counts;
  }, [hoveredNode, activeGraphData]);

  // ── Loading / Empty states ───────────────────────────────────────
  if (!activeGraphData) {
    return (
      <div className="empty-state" style={{ padding: 'var(--space-8)' }}>
        <IconBrain size={48} />
        <div className="empty-state-title">{t('graph.loading')}</div>
      </div>
    );
  }

  if (activeGraphData.nodes.length === 0) {
    const methodologyLabel = state.methodology === 'zettelkasten' ? 'Zettelkasten'
      : state.methodology === 'para' ? 'PARA'
      : state.methodology === 'code' ? 'CODE'
      : state.methodology === 'evergreen' ? (isZh ? '常青笔记' : 'Evergreen')
      : state.methodology === 'gtd' ? 'GTD'
      : state.methodology === 'cornell' ? (isZh ? '康奈尔' : 'Cornell')
      : state.methodology === 'moc' ? 'MOC / LYT'
      : (isZh ? '通用' : 'Generic');

    return (
      <div className="empty-state" style={{ padding: 'var(--space-8)' }}>
        <IconLink size={48} />
        <div className="empty-state-title">
          {isZh ? `当前流派「${methodologyLabel}」没有知识图谱` : `No graph data for "${methodologyLabel}" methodology`}
        </div>
        <div className="empty-state-description">
          {isZh
            ? '请在仪表盘点击「立即智能整理」，AI 将按当前流派分类所有笔记并生成知识图谱。'
            : 'Click "Smart Organize" on the dashboard. AI will classify all notes with the current methodology and generate the knowledge graph.'}
        </div>
      </div>
    );
  }



  const linkCount = activeGraphData.edges.filter((e) => e.edge_type === 'link').length;
  const semanticCount = activeGraphData.edges.filter((e) => e.edge_type === 'semantic').length;
  const hoveredConnections = hoveredNode
    ? activeGraphData.edges.filter(e => e.source === hoveredNode.id || e.target === hoveredNode.id).length
    : 0;


  return (
    <div ref={containerRef} className={`kg-container ${isDraggingBg ? 'is-dragging-bg' : ''}`}>
      {/* ── Pixi Graph Renderer ── */}
      <PixiGraph
        ref={pixiRef}
        graphData={graphData as unknown as PGGraphData}
        width={dimensions.width}
        height={dimensions.height}
        hoveredNode={hoveredNode as PGNode | null}
        selectedNodes={selectedNodes as PGNode[]}
        selectedCluster={selectedCluster}
        methodology={state.methodology || 'generic'}
        isLocalMode={isLocalMode}
        focusNodeId={focusNodeId}
        forceParams={forceParams}
        onNodeClick={handleNodeClick as any}
        onNodeHover={handleNodeHover as any}
        onNodeRightClick={handleNodeRightClick as any}
        onBackgroundClick={() => {
          setSelectedNodes([]);
          setContextMenu(null);
        }}
      />



      {/* Tips Panel */}
      <div className={`kg-tips ${tipsCollapsed ? 'kg-tips--collapsed' : ''}`}>
        <span
          className="kg-tips-title"
          onClick={() => setTipsCollapsed(prev => !prev)}
          style={{ cursor: 'pointer', pointerEvents: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          <svg
            width={8} height={8} viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
            style={{ transition: 'transform 0.2s ease', transform: tipsCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
          {isZh ? '操作提示' : 'Tips'}
        </span>
        {!tipsCollapsed && (
          <>
            <span>• {t('graph.tipZoom')}</span>
            <span>• {t('graph.tipPan')}</span>
            <span>• {t('graph.tipDragNode')}</span>
            <span>• {t('graph.tipDoubleClick')}</span>
            <span>• {t('graph.tipSpace')}</span>
          </>
        )}
      </div>

      <GraphHud
        rawGraphData={activeGraphData}
        linkCount={linkCount}
        semanticCount={semanticCount}
        semanticThreshold={semanticThreshold}
        setSemanticThreshold={setSemanticThreshold}
        hudCollapsed={hudCollapsed}
        setHudCollapsed={setHudCollapsed}
        isZh={isZh}
        state={state}
        selectedCluster={selectedCluster}
        setSelectedCluster={setSelectedCluster}
        relationFilter={relationFilter}
        setRelationFilter={setRelationFilter}
        isLocalMode={isLocalMode}
        setIsLocalMode={setIsLocalMode}
        focusNodeId={focusNodeId}
        setFocusNodeId={setFocusNodeId}
        localDepth={localDepth}
        setLocalDepth={setLocalDepth}
        hideOrphans={hideOrphans}
        setHideOrphans={setHideOrphans}
        folderFilter={folderFilter}
        setFolderFilter={setFolderFilter}
        showFolderPicker={showFolderPicker}
        setShowFolderPicker={setShowFolderPicker}
        folderPickerRef={folderPickerRef}
        folderBtnRef={folderBtnRef}
        handleFilterSwitch={handleFilterSwitch}
        forceParams={forceParams}
        setForceParams={setForceParams}
      />

      {hoveredNode && (
        <GraphHoverCard
          hoveredNode={hoveredNode}
          hoveredConnections={hoveredConnections}
          hoveredRelationBreakdown={hoveredRelationBreakdown}
          isZh={isZh}
          style={{
            right: isAgentOpen ? 352 : 12,
            transition: 'right 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        />
      )}

      {contextMenu && (
        <GraphContextMenu
          contextMenu={contextMenu}
          setContextMenu={setContextMenu}
          setCurrentFile={setCurrentFile}
          setView={setView}
          setIsLocalMode={setIsLocalMode}
          setFocusNodeId={setFocusNodeId}
          handleDeleteNode={handleDeleteNode}
          handleFilterSwitch={handleFilterSwitch}
          isZh={isZh}
        />
      )}

      <GraphTimeSlider
        rawGraphData={activeGraphData}
        sortedNodeIds={sortedNodeIds}
        timeSliderValue={timeSliderValue}
        setTimeSliderValue={setTimeSliderValue}
        isZh={isZh}
        style={{
          transform: isAgentOpen ? 'translateX(calc(-50% - 172px))' : 'translateX(-50%)',
          transition: 'transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      />

      {/* Agent Floating Toggle Button */}
      <button
        className={`agent-floating-toggle ${isAgentOpen ? 'active' : ''}`}
        onClick={() => setIsAgentOpen(prev => !prev)}
        style={{
          right: isAgentOpen ? 344 : 12,
          top: 12,
          transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
          pointerEvents: isAgentOpen ? 'none' : 'auto',
          opacity: isAgentOpen ? 0 : 1,
        }}
      >
        <IconRobot size={14} />
        <span>{isZh ? 'Agent 建议' : 'Agent Panel'}</span>
      </button>

      {/* Agent Panel */}
      <AgentPanel
        view="graph"
        isOpen={isAgentOpen}
        onClose={() => setIsAgentOpen(false)}
        selectedNodes={selectedNodes}
        hoveredNode={hoveredNode}
        graphStats={graphStats}
        onGraphAction={handleGraphAgentAction}
      />
    </div>
  );
}
