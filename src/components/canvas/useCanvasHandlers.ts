/**
 * useCanvasHandlers — canvas interaction handlers extracted from InteractiveCanvas.
 *
 * Covers node/edge CRUD, context menus, quick-create, drag-and-drop,
 * ghost-edge lifecycle, edge-label editing, and pane double-click.
 */
import { useCallback, useRef } from 'react';
import {
  type Node,
  type Edge,
  type Connection,
  addEdge,
} from '@xyflow/react';
import {
  addCanvasRelation,
  deleteCanvasRelation,
  createNoteForLink,
  writeMarkdownFile,
  getLocalGraph,
} from '../../lib/tauri';
import { tf } from '../../lib/i18n';
import { getRelationTypes } from './canvasConstants';

// ── Parameter interface ──

export interface CanvasHandlersParams {
  nodes: Node[];
  edges: Edge[];
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>;
  reactFlowInstance: any;
  showToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
  lang: string;
  vaultPath: string | null;

  // Edge label editing state
  editingEdgeId: string | null;
  setEditingEdgeId: (id: string | null) => void;
  edgeLabelInput: string;
  setEdgeLabelInput: (v: string) => void;
  edgeLabelPos: { x: number; y: number };
  setEdgeLabelPos: (v: { x: number; y: number }) => void;

  // Context menu state setters
  setContextMenu: (menu: { x: number; y: number; nodeId: string; nodeType: string } | null) => void;
  setPaneMenu: (menu: { x: number; y: number } | null) => void;
  setEdgeContextMenu: (menu: { x: number; y: number; edgeId: string } | null) => void;

  // Quick connect state
  quickConnectMenu: { x: number; y: number; sourceNodeId: string; sourceHandleId: string | null } | null;
  setQuickConnectMenu: (menu: any) => void;
  quickConnectSuggestions: { path: string; label: string; similarity?: number }[];
  setQuickConnectSuggestions: (s: any[]) => void;

  // Smart edges (ghost edge suggestions)
  smartEdges: any[];
  dismissSmartSuggestion: (id: string) => void;

  // For add-note modal (context menu "add note" action)
  openAddNoteModal: () => void;

  // Refs for double-click pane detection
  lastPaneClickRef: React.MutableRefObject<{ time: number; x: number; y: number }>;

  // Refs for hovered-element keyboard deletion fallback
  hoveredEdgeRef: React.MutableRefObject<string | null>;
  hoveredNodeRef: React.MutableRefObject<string | null>;
}

// ── Hook ──

export function useCanvasHandlers(params: CanvasHandlersParams) {
  const {
    nodes,
    edges,
    setNodes,
    setEdges,
    reactFlowInstance,
    showToast,
    lang,
    vaultPath: _vaultPath,
    editingEdgeId,
    setEditingEdgeId,
    edgeLabelInput,
    setEdgeLabelInput,
    edgeLabelPos: _edgeLabelPos,
    setEdgeLabelPos,
    setContextMenu,
    setPaneMenu,
    setEdgeContextMenu,
    quickConnectMenu,
    setQuickConnectMenu,
    quickConnectSuggestions: _quickConnectSuggestions,
    setQuickConnectSuggestions,
    smartEdges,
    dismissSmartSuggestion,
    openAddNoteModal,
    lastPaneClickRef,
    hoveredEdgeRef,
    hoveredNodeRef,
  } = params;

  // Internal ref for tracking mouse position (useful for paste operations)
  const mousePositionRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // ────────────────────────────────────────────────────────────────────────
  //  1. syncEdgeToDb — persist an edge add/delete to the database
  // ────────────────────────────────────────────────────────────────────────

  const syncEdgeToDb = useCallback(
    async (
      connection: { source: string; target: string },
      action: 'add' | 'delete',
      relationType?: string,
    ) => {
      const sourceNode = reactFlowInstance.getNode(connection.source);
      const targetNode = reactFlowInstance.getNode(connection.target);
      if (sourceNode?.type === 'file' && targetNode?.type === 'file') {
        const sourcePath = sourceNode.data.file as string;
        const targetPath = targetNode.data.file as string;
        try {
          if (action === 'add') {
            await addCanvasRelation(sourcePath, targetPath, relationType || 'wikilink');
          } else {
            await deleteCanvasRelation(sourcePath, targetPath);
          }
        } catch (err) {
          console.error('Failed to sync canvas connection to DB:', err);
        }
      }
    },
    [reactFlowInstance],
  );

  // ────────────────────────────────────────────────────────────────────────
  //  2. Ghost edge accept / reject
  // ────────────────────────────────────────────────────────────────────────

  /** Accept a ghost-edge suggestion: convert it to a real edge and persist. */
  const onAcceptGhostEdge = useCallback(
    (edgeId: string) => {
      const ghostEdge = smartEdges.find((e) => e.id === edgeId);
      if (!ghostEdge) return;
      const srcNode = reactFlowInstance.getNode(ghostEdge.source);
      const tgtNode = reactFlowInstance.getNode(ghostEdge.target);
      if (srcNode?.type === 'file' && tgtNode?.type === 'file') {
        const relType = (ghostEdge.data?.relationType as string) || 'supplementary';
        const newEdge: Edge = {
          id: `edge-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          source: ghostEdge.source,
          target: ghostEdge.target,
          type: 'default',
          label: lang === 'zh' ? '已确认' : 'Confirmed',
        };
        setEdges((eds) => addEdge(newEdge, eds));
        syncEdgeToDb(
          { source: ghostEdge.source, target: ghostEdge.target },
          'add',
          relType,
        );
        showToast(lang === 'zh' ? '✅ 已接受连接' : '✅ Connection accepted', 'success');
      }
      dismissSmartSuggestion(edgeId);
    },
    [smartEdges, reactFlowInstance, setEdges, syncEdgeToDb, showToast, lang, dismissSmartSuggestion],
  );

  /** Reject (dismiss) a ghost-edge suggestion. */
  const onRejectGhostEdge = useCallback(
    (edgeId: string) => {
      dismissSmartSuggestion(edgeId);
      showToast(lang === 'zh' ? '❌ 已忽略建议' : '❌ Suggestion dismissed', 'info');
    },
    [dismissSmartSuggestion, showToast, lang],
  );

  // ────────────────────────────────────────────────────────────────────────
  //  3. Smart edge click / context-menu (legacy wrappers)
  // ────────────────────────────────────────────────────────────────────────

  /** Left-click on a smart (ghost) edge accepts it. */
  const handleSmartEdgeClick = useCallback(
    (_event: React.MouseEvent, edge: Edge) => {
      if (!edge.data?._smart) return;
      onAcceptGhostEdge(edge.id);
    },
    [onAcceptGhostEdge],
  );

  /** Right-click on a smart (ghost) edge rejects it. */
  const handleSmartEdgeContextMenu = useCallback(
    (event: React.MouseEvent, edge: Edge) => {
      if (!edge.data?._smart) return;
      event.preventDefault();
      onRejectGhostEdge(edge.id);
    },
    [onRejectGhostEdge],
  );

  // ────────────────────────────────────────────────────────────────────────
  //  4. handlePaneClick — double-click on blank pane creates a text card
  // ────────────────────────────────────────────────────────────────────────

  const handlePaneClick = useCallback(
    (event: React.MouseEvent) => {
      const now = Date.now();
      const { time, x, y } = lastPaneClickRef.current;
      const isDoubleClick =
        now - time < 400 &&
        Math.abs(event.clientX - x) < 15 &&
        Math.abs(event.clientY - y) < 15;

      lastPaneClickRef.current = { time: now, x: event.clientX, y: event.clientY };

      if (isDoubleClick) {
        const position = reactFlowInstance.screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        });
        const newNode: Node = {
          id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          type: 'text',
          position,
          width: 260,
          height: 200,
          style: { width: 260, height: 200 },
          data: { text: '', color: '#fef08a' },
        };
        setNodes((nds) => nds.concat(newNode));
        // Reset to prevent triple-click creating two cards
        lastPaneClickRef.current = { time: 0, x: 0, y: 0 };
      }
    },
    [reactFlowInstance, setNodes, lastPaneClickRef],
  );

  // ────────────────────────────────────────────────────────────────────────
  //  5. Edge property changes (relation type, color, arrow toggle)
  // ────────────────────────────────────────────────────────────────────────

  /** Change an edge's semantic relation type and persist to DB. */
  const handleSetEdgeRelation = useCallback(
    (edgeId: string, relationType: string) => {
      const rel = getRelationTypes().find((r) => r.type === relationType);
      setEdges((eds) =>
        eds.map((e) => {
          if (e.id !== edgeId) return e;
          return {
            ...e,
            label: rel ? (lang === 'zh' ? rel.labelZh : rel.label) : e.label,
            labelStyle: {
              ...e.labelStyle,
              fill: rel?.color || '#64748b',
              fontSize: 10,
              fontWeight: 500,
            },
            style: { ...e.style, stroke: rel?.color },
            data: { ...e.data, relationType, color: rel?.color },
          };
        }),
      );
      // Sync updated relation to DB
      const edge = edges.find((e) => e.id === edgeId);
      if (edge) {
        syncEdgeToDb({ source: edge.source, target: edge.target }, 'add', relationType);
      }
      setEdgeContextMenu(null);
    },
    [setEdges, edges, syncEdgeToDb, lang, setEdgeContextMenu],
  );

  /** Change an edge's stroke color (cosmetic only, no DB sync). */
  const handleSetEdgeColor = useCallback(
    (edgeId: string, color: string | undefined) => {
      setEdges((eds) =>
        eds.map((e) => {
          if (e.id !== edgeId) return e;
          return {
            ...e,
            style: { ...e.style, stroke: color },
            data: { ...e.data, color },
          };
        }),
      );
      setEdgeContextMenu(null);
    },
    [setEdges, setEdgeContextMenu],
  );

  /**
   * Cycle arrow direction on an edge:
   *   single-arrow (→)  →  bidirectional (↔)  →  no arrows (—)  →  single-arrow (→)
   */
  const handleToggleEdgeArrow = useCallback(
    (edgeId: string) => {
      setEdges((eds) =>
        eds.map((e) => {
          if (e.id !== edgeId) return e;
          const fromEnd = e.data?.fromEnd || 'none';
          const toEnd = e.data?.toEnd || 'arrow';
          let newFrom: string, newTo: string;
          if (fromEnd === 'none' && toEnd === 'arrow') {
            newFrom = 'arrow';
            newTo = 'arrow'; // bidirectional
          } else if (fromEnd === 'arrow' && toEnd === 'arrow') {
            newFrom = 'none';
            newTo = 'none'; // no arrows
          } else {
            newFrom = 'none';
            newTo = 'arrow'; // default single arrow
          }
          return { ...e, data: { ...e.data, fromEnd: newFrom, toEnd: newTo } };
        }),
      );
    },
    [setEdges],
  );

  // ────────────────────────────────────────────────────────────────────────
  //  6. onConnect — React Flow new connection handler
  // ────────────────────────────────────────────────────────────────────────

  const onConnect = useCallback(
    (params: Connection) => {
      setEdges((eds) => addEdge(params, eds));
      if (params.source && params.target) {
        syncEdgeToDb({ source: params.source, target: params.target }, 'add');
      }
    },
    [setEdges, syncEdgeToDb],
  );

  // ────────────────────────────────────────────────────────────────────────
  //  7. onConnectEnd — quick-create menu when connection drops on empty canvas
  // ────────────────────────────────────────────────────────────────────────

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
      // Only trigger if the drop didn't land on a valid handle
      const target = event.target as HTMLElement;
      if (target?.classList?.contains('react-flow__handle')) return;

      // Resolve the source node from React Flow's internal connection state
      const connectingNodeId = (reactFlowInstance as any).getState?.()?.connectionNodeId;
      const connectingHandleId = (reactFlowInstance as any).getState?.()?.connectionHandleId;
      const store = (reactFlowInstance as any).store;
      const storeState = store?.getState?.();
      const sourceNodeId = connectingNodeId || storeState?.connectionNodeId;
      const sourceHandleId = connectingHandleId || storeState?.connectionHandleId;
      if (!sourceNodeId) return;

      // Extract client coordinates (mouse or touch)
      const clientX =
        'clientX' in event
          ? event.clientX
          : event.changedTouches?.[0]?.clientX || 0;
      const clientY =
        'clientY' in event
          ? event.clientY
          : event.changedTouches?.[0]?.clientY || 0;

      setQuickConnectMenu({
        x: clientX,
        y: clientY,
        sourceNodeId,
        sourceHandleId: sourceHandleId || null,
      });

      // Load semantic suggestions for file-type source nodes
      const sourceNode = reactFlowInstance.getNode(sourceNodeId);
      if (sourceNode?.type === 'file' && sourceNode.data.file) {
        const filePath = sourceNode.data.file as string;
        getLocalGraph(filePath)
          .then((graphData) => {
            const canvasFilePaths = new Set(
              nodes
                .filter((n) => n.type === 'file')
                .map((n) => (n.data.file as string).replace(/\\/g, '/')),
            );
            const suggestions = graphData.edges
              .map((e: any) => {
                const otherPath =
                  e.source === filePath.replace(/\\/g, '/') ? e.target : e.source;
                return {
                  path: otherPath,
                  weight: e.weight,
                  label: e.label || '',
                  edgeType: e.edge_type,
                };
              })
              .filter(
                (s: any) => !canvasFilePaths.has(s.path.replace(/\\/g, '/')),
              )
              .sort((a: any, b: any) => b.weight - a.weight)
              .slice(0, 5)
              .map((s: any) => ({
                path: s.path,
                label:
                  s.path
                    .replace(/\\/g, '/')
                    .split('/')
                    .pop()
                    ?.replace(/\.md$/, '') || s.path,
                similarity:
                  s.edgeType === 'semantic'
                    ? Math.round(s.weight * 100)
                    : undefined,
              }));
            setQuickConnectSuggestions(suggestions);
          })
          .catch(() => setQuickConnectSuggestions([]));
      } else {
        setQuickConnectSuggestions([]);
      }
    },
    [
      reactFlowInstance,
      nodes,
      setQuickConnectMenu,
      setQuickConnectSuggestions,
    ],
  );

  // ────────────────────────────────────────────────────────────────────────
  //  8. Quick-create handlers
  // ────────────────────────────────────────────────────────────────────────

  /** Generate a unique node ID. */
  const genNodeId = () =>
    `node-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  /**
   * Create a new node of the given type at the quick-connect menu position
   * and auto-connect it to the source node.
   */
  const handleQuickCreate = useCallback(
    (type: 'text' | 'file' | 'web') => {
      if (!quickConnectMenu) return;
      const { x, y, sourceNodeId, sourceHandleId } = quickConnectMenu;
      const position = reactFlowInstance.screenToFlowPosition({ x, y });
      const newId = genNodeId();
      let newNode: Node;

      if (type === 'text') {
        newNode = {
          id: newId,
          type: 'text',
          position,
          width: 250,
          height: 250,
          style: { width: 250, height: 250 },
          data: { text: '', color: '#fef08a' },
        };
      } else if (type === 'web') {
        newNode = {
          id: newId,
          type: 'web',
          position,
          width: 360,
          height: 280,
          style: { width: 360, height: 280 },
          data: { url: '', lang },
        };
      } else {
        // 'file' — delegate to the note selector modal
        setQuickConnectMenu(null);
        openAddNoteModal();
        return;
      }

      setNodes((nds) => nds.concat(newNode));

      // Auto-connect: source → new node
      const newEdge: Edge = {
        id: `edge-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        source: sourceNodeId,
        sourceHandle: sourceHandleId || 'right',
        target: newId,
        targetHandle: 'left',
        data: {
          relationType: 'wikilink',
          fromEnd: 'none',
          toEnd: 'arrow',
          color: '#64748b',
        },
      };
      setEdges((eds) => addEdge(newEdge, eds));
      setQuickConnectMenu(null);
    },
    [
      quickConnectMenu,
      reactFlowInstance,
      lang,
      setNodes,
      setEdges,
      setQuickConnectMenu,
      openAddNoteModal,
    ],
  );

  /**
   * Quick-connect to an existing note suggestion: add a file node for the
   * suggested path and connect it to the source.
   */
  const handleQuickConnectSimilar = useCallback(
    (filePath: string) => {
      if (!quickConnectMenu) return;
      const { x, y, sourceNodeId, sourceHandleId } = quickConnectMenu;
      const position = reactFlowInstance.screenToFlowPosition({ x, y });
      const name =
        filePath
          .replace(/\\/g, '/')
          .split('/')
          .pop()
          ?.replace(/\.md$/, '') || filePath;
      const newId = genNodeId();

      const newNode: Node = {
        id: newId,
        type: 'file',
        position,
        width: 400,
        height: 300,
        style: { width: 400, height: 300 },
        data: { file: filePath, title: name, color: '#3b82f6' },
      };
      setNodes((nds) => nds.concat(newNode));

      const newEdge: Edge = {
        id: `edge-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        source: sourceNodeId,
        sourceHandle: sourceHandleId || 'right',
        target: newId,
        targetHandle: 'left',
        data: {
          relationType: 'wikilink',
          fromEnd: 'none',
          toEnd: 'arrow',
          color: '#64748b',
        },
      };
      setEdges((eds) => addEdge(newEdge, eds));
      syncEdgeToDb({ source: sourceNodeId, target: newId }, 'add');
      setQuickConnectMenu(null);
      setQuickConnectSuggestions([]);
    },
    [
      quickConnectMenu,
      reactFlowInstance,
      setNodes,
      setEdges,
      syncEdgeToDb,
      setQuickConnectMenu,
      setQuickConnectSuggestions,
    ],
  );

  // ────────────────────────────────────────────────────────────────────────
  //  9. handleConvertTextToNote — turn a text sticky into a markdown file node
  // ────────────────────────────────────────────────────────────────────────

  const handleConvertTextToNote = useCallback(
    async (nodeId: string) => {
      const node = reactFlowInstance.getNode(nodeId);
      if (!node || node.type !== 'text') return;
      const text = (node.data.text as string) || '';
      if (!text.trim()) {
        showToast(lang === 'zh' ? '便签内容为空' : 'Sticky note is empty', 'error');
        return;
      }
      try {
        // Derive a title from the first meaningful line
        const firstLine = text.split('\n').find((l) => l.trim()) || text;
        const title = firstLine
          .replace(/^#+\s*/, '')
          .replace(/[*_~`]/g, '')
          .trim()
          .slice(0, 40);

        // Create the file and write content
        const filePath = await createNoteForLink(title);
        await writeMarkdownFile(filePath, text);

        // Replace the text node with a file node in-place
        const name =
          filePath
            .replace(/\\/g, '/')
            .split('/')
            .pop()
            ?.replace(/\.md$/, '') || filePath;
        setNodes((nds) =>
          nds.map((n) => {
            if (n.id !== nodeId) return n;
            return {
              ...n,
              type: 'file',
              data: { file: filePath, title: name, color: '#3b82f6' },
            };
          }),
        );
        showToast(tf('canvas.convertedToNote', name), 'success');
      } catch (err) {
        showToast(`Failed: ${err}`, 'error');
      }
      setContextMenu(null);
    },
    [reactFlowInstance, setNodes, showToast, lang, setContextMenu],
  );

  // ────────────────────────────────────────────────────────────────────────
  //  10. onEdgesDelete — clean up DB when React Flow deletes edges
  // ────────────────────────────────────────────────────────────────────────

  const onEdgesDelete = useCallback(
    (deletedEdges: Edge[]) => {
      for (const edge of deletedEdges) {
        syncEdgeToDb({ source: edge.source, target: edge.target }, 'delete');
      }
    },
    [syncEdgeToDb],
  );

  // ────────────────────────────────────────────────────────────────────────
  //  11. Context menu triggers
  // ────────────────────────────────────────────────────────────────────────

  /** Right-click on a node. */
  const handleNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault();
      event.stopPropagation();
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        nodeId: node.id,
        nodeType: node.type || 'text',
      });
    },
    [setContextMenu],
  );

  /** Right-click on blank pane. */
  const handlePaneContextMenu = useCallback(
    (event: MouseEvent | React.MouseEvent) => {
      event.preventDefault();
      setPaneMenu({
        x: (event as React.MouseEvent).clientX,
        y: (event as React.MouseEvent).clientY,
      });
      setContextMenu(null);
      setEdgeContextMenu(null);
    },
    [setPaneMenu, setContextMenu, setEdgeContextMenu],
  );

  /** Right-click on an edge. */
  const handleEdgeContextMenu = useCallback(
    (event: React.MouseEvent, edge: Edge) => {
      event.preventDefault();
      event.stopPropagation();
      setEdgeContextMenu({
        x: event.clientX,
        y: event.clientY,
        edgeId: edge.id,
      });
      setContextMenu(null);
      setPaneMenu(null);
    },
    [setEdgeContextMenu, setContextMenu, setPaneMenu],
  );

  // ────────────────────────────────────────────────────────────────────────
  //  12. Deletion handlers
  // ────────────────────────────────────────────────────────────────────────

  /** Delete a single node and its connected edges (from context menu). */
  const handleDeleteNode = useCallback(
    (nodeId: string) => {
      const node = reactFlowInstance.getNode(nodeId);
      // Clean up DB relations for file nodes
      if (node?.type === 'file') {
        const connectedEdges = edges.filter(
          (e) => e.source === nodeId || e.target === nodeId,
        );
        for (const edge of connectedEdges) {
          syncEdgeToDb({ source: edge.source, target: edge.target }, 'delete');
        }
      }
      setNodes((nds) => nds.filter((n) => n.id !== nodeId));
      setEdges((eds) =>
        eds.filter((e) => e.source !== nodeId && e.target !== nodeId),
      );
      setContextMenu(null);
    },
    [reactFlowInstance, edges, setNodes, setEdges, syncEdgeToDb, setContextMenu],
  );

  /**
   * Delete selected nodes/edges via keyboard (Delete / Backspace).
   * Also handles hovered-element fallback when nothing is selected.
   */
  const handleKeyboardDelete = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;

      // Don't fire if the user is typing in an input/textarea
      const tag = (event.target as HTMLElement)?.tagName?.toLowerCase();
      if (
        tag === 'input' ||
        tag === 'textarea' ||
        (event.target as HTMLElement)?.isContentEditable
      )
        return;

      const selectedNodes = nodes.filter((n) => n.selected);
      const selectedEdges = edges.filter((e) => e.selected);

      // Nothing selected — try falling back to hovered element
      if (selectedNodes.length === 0 && selectedEdges.length === 0) {
        if (hoveredEdgeRef.current) {
          const edgeId = hoveredEdgeRef.current;
          const edge = edges.find((ed) => ed.id === edgeId);
          if (edge) {
            syncEdgeToDb(
              { source: edge.source, target: edge.target },
              'delete',
            );
            setEdges((eds) => eds.filter((ed) => ed.id !== edgeId));
          }
          hoveredEdgeRef.current = null;
          return;
        }
        if (hoveredNodeRef.current) {
          const nodeId = hoveredNodeRef.current;
          const node = nodes.find((n) => n.id === nodeId);
          if (node?.type === 'file') {
            const connectedEdges = edges.filter(
              (ed) => ed.source === nodeId || ed.target === nodeId,
            );
            for (const edge of connectedEdges) {
              syncEdgeToDb(
                { source: edge.source, target: edge.target },
                'delete',
              );
            }
          }
          setNodes((nds) => nds.filter((n) => n.id !== nodeId));
          setEdges((eds) =>
            eds.filter(
              (ed) => ed.source !== nodeId && ed.target !== nodeId,
            ),
          );
          hoveredNodeRef.current = null;
          return;
        }
        return;
      }

      // Clean up DB for selected file nodes' edges
      for (const node of selectedNodes) {
        if (node.type === 'file') {
          const connectedEdges = edges.filter(
            (e) => e.source === node.id || e.target === node.id,
          );
          for (const edge of connectedEdges) {
            syncEdgeToDb(
              { source: edge.source, target: edge.target },
              'delete',
            );
          }
        }
      }

      const nodeIds = new Set(selectedNodes.map((n) => n.id));
      setNodes((nds) => nds.filter((n) => !nodeIds.has(n.id)));
      setEdges((eds) =>
        eds.filter(
          (ed) =>
            !nodeIds.has(ed.source) &&
            !nodeIds.has(ed.target) &&
            !selectedEdges.some((se) => se.id === ed.id),
        ),
      );

      // Clean up deleted edges in DB
      for (const edge of selectedEdges) {
        syncEdgeToDb({ source: edge.source, target: edge.target }, 'delete');
      }
    },
    [
      nodes,
      edges,
      setNodes,
      setEdges,
      syncEdgeToDb,
      hoveredEdgeRef,
      hoveredNodeRef,
    ],
  );

  /** Delete an edge from the edge context menu. */
  const handleDeleteEdge = useCallback(
    (edgeId: string) => {
      const edge = edges.find((e) => e.id === edgeId);
      if (edge) {
        syncEdgeToDb({ source: edge.source, target: edge.target }, 'delete');
      }
      setEdges((eds) => eds.filter((e) => e.id !== edgeId));
      setEdgeContextMenu(null);
    },
    [edges, setEdges, syncEdgeToDb, setEdgeContextMenu],
  );

  // ────────────────────────────────────────────────────────────────────────
  //  13. Edge label editing
  // ────────────────────────────────────────────────────────────────────────

  /** Open the inline label editor on double-click. */
  const handleEdgeDoubleClick = useCallback(
    (_event: React.MouseEvent, edge: Edge) => {
      setEditingEdgeId(edge.id);
      setEdgeLabelInput((edge.label as string) || '');
      setEdgeLabelPos({ x: _event.clientX, y: _event.clientY });
    },
    [setEditingEdgeId, setEdgeLabelInput, setEdgeLabelPos],
  );

  /** Confirm the edge label edit and apply it. */
  const handleEdgeLabelConfirm = useCallback(() => {
    if (editingEdgeId) {
      setEdges((eds) =>
        eds.map((e) =>
          e.id === editingEdgeId
            ? { ...e, label: edgeLabelInput.trim() || undefined }
            : e,
        ),
      );
    }
    setEditingEdgeId(null);
    setEdgeLabelInput('');
  }, [editingEdgeId, edgeLabelInput, setEdges, setEditingEdgeId, setEdgeLabelInput]);

  /** Cancel the edge label edit. */
  const handleEdgeLabelCancel = useCallback(() => {
    setEditingEdgeId(null);
    setEdgeLabelInput('');
  }, [setEditingEdgeId, setEdgeLabelInput]);

  // ────────────────────────────────────────────────────────────────────────
  //  14. handleSetNodeColor — change a node's background color
  // ────────────────────────────────────────────────────────────────────────

  const handleSetNodeColor = useCallback(
    (nodeId: string, color: string | undefined) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== nodeId) return n;
          return { ...n, data: { ...n.data, color } };
        }),
      );
      setContextMenu(null);
    },
    [setNodes, setContextMenu],
  );

  // ────────────────────────────────────────────────────────────────────────
  //  15. Drag & drop (images / PDFs onto canvas)
  // ────────────────────────────────────────────────────────────────────────

  /** Handle dropped files — creates image or PDF nodes at the drop location. */
  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const files = event.dataTransfer.files;
      if (!files || files.length === 0) return;

      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      const IMAGE_EXTS = new Set([
        'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp',
      ]);
      let offsetY = 0;

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const ext = file.name.split('.').pop()?.toLowerCase() || '';
        const isImage = IMAGE_EXTS.has(ext);
        const isPdf = ext === 'pdf';
        if (!isImage && !isPdf) continue;

        // In Tauri the real file path is available via dataTransfer
        const filePath = (file as any).path || file.name;

        if (isPdf) {
          const newNode: Node = {
            id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${i}`,
            type: 'pdf',
            position: { x: position.x, y: position.y + offsetY },
            width: 420,
            height: 450,
            style: { width: 420, height: 450 },
            data: { file: filePath, lang },
          };
          setNodes((nds) => nds.concat(newNode));
          offsetY += 470;
        } else {
          const newNode: Node = {
            id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${i}`,
            type: 'image',
            position: { x: position.x, y: position.y + offsetY },
            width: 320,
            height: 240,
            style: { width: 320, height: 240 },
            data: { file: filePath },
          };
          setNodes((nds) => nds.concat(newNode));
          offsetY += 260;
        }
      }
    },
    [reactFlowInstance, setNodes, lang],
  );

  /** Required dragover handler to allow drops. */
  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  // ────────────────────────────────────────────────────────────────────────
  //  16. addNodeAtPosition — context menu "add node here"
  // ────────────────────────────────────────────────────────────────────────

  const addNodeAtPosition = useCallback(
    (
      type: 'note' | 'text' | 'group' | 'web',
      screenX: number,
      screenY: number,
    ) => {
      const position = reactFlowInstance.screenToFlowPosition({
        x: screenX,
        y: screenY,
      });

      if (type === 'note') {
        // Delegate to the note selector modal (position stored externally)
        openAddNoteModal();
      } else if (type === 'text') {
        const newNode: Node = {
          id: genNodeId(),
          type: 'text',
          position,
          width: 250,
          height: 250,
          style: { width: 250, height: 250 },
          data: { text: '', color: '#fef08a' },
        };
        setNodes((nds) => nds.concat(newNode));
      } else if (type === 'web') {
        const newNode: Node = {
          id: genNodeId(),
          type: 'web',
          position,
          width: 360,
          height: 280,
          style: { width: 360, height: 280 },
          data: { url: '', lang },
        };
        setNodes((nds) => nds.concat(newNode));
      } else {
        const newNode: Node = {
          id: genNodeId(),
          type: 'group',
          position,
          width: 600,
          height: 400,
          style: { width: 600, height: 400 },
          data: { label: 'New Group', color: 'var(--border-color)' },
        };
        setNodes((nds) => nds.concat(newNode));
      }
      setPaneMenu(null);
    },
    [reactFlowInstance, setNodes, lang, openAddNoteModal, setPaneMenu],
  );

  // ────────────────────────────────────────────────────────────────────────
  //  17. handleDuplicateNode — clone a node with a small offset
  // ────────────────────────────────────────────────────────────────────────

  const handleDuplicateNode = useCallback(
    (nodeId: string) => {
      const node = reactFlowInstance.getNode(nodeId);
      if (!node) return;
      const newNode: Node = {
        ...node,
        id: genNodeId(),
        position: { x: node.position.x + 30, y: node.position.y + 30 },
        selected: false,
      };
      setNodes((nds) => nds.concat(newNode));
      setContextMenu(null);
    },
    [reactFlowInstance, setNodes, setContextMenu],
  );

  // ────────────────────────────────────────────────────────────────────────
  //  Return all handlers
  // ────────────────────────────────────────────────────────────────────────

  return {
    // Edge persistence
    syncEdgeToDb,

    // Ghost edges
    onAcceptGhostEdge,
    onRejectGhostEdge,
    handleSmartEdgeClick,
    handleSmartEdgeContextMenu,

    // Pane interaction
    handlePaneClick,

    // Edge property changes
    handleSetEdgeRelation,
    handleSetEdgeColor,
    handleToggleEdgeArrow,

    // Connections
    onConnect,
    onConnectEnd,

    // Quick-create
    handleQuickCreate,
    handleQuickConnectSimilar,

    // Text-to-note conversion
    handleConvertTextToNote,

    // Edge deletion cleanup
    onEdgesDelete,

    // Context menus
    handleNodeContextMenu,
    handlePaneContextMenu,
    handleEdgeContextMenu,

    // Deletion
    handleDeleteNode,
    handleKeyboardDelete,
    handleDeleteEdge,

    // Edge label editing
    handleEdgeDoubleClick,
    handleEdgeLabelConfirm,
    handleEdgeLabelCancel,

    // Node color
    handleSetNodeColor,

    // Drag & drop
    handleDrop,
    handleDragOver,

    // Add / duplicate
    addNodeAtPosition,
    handleDuplicateNode,

    // Internal ref (exposed for paste tracking if needed)
    mousePositionRef,
  };
}
