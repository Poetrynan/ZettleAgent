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
import { DEFAULT_STICKY_HUE } from './cardContent';
import {
  OPPOSITE_SIDE, isSide, placeAgainst, sideFacing,
  type AddNoteTarget, type Box, type Side,
} from './canvasGeometry';

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
  openAddNoteModal: (target?: AddNoteTarget) => void;

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

  const relationTypeOf = (edge?: Edge | null, fallback?: string) =>
    (edge?.data?.relationType as string | undefined)
    || (typeof edge?.label === 'string' ? edge.label : undefined)
    || fallback
    || 'wikilink';

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
        const edge = reactFlowInstance
          .getEdges()
          .find((e: Edge) => e.source === connection.source && e.target === connection.target);
        const rel = relationTypeOf(edge, relationType);
        try {
          if (action === 'add') {
            await addCanvasRelation(sourcePath, targetPath, rel);
          } else {
            await deleteCanvasRelation(sourcePath, targetPath, rel);
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
        showToast(lang === 'zh' ? '已接受连接' : 'Connection accepted', 'success');
      }
      dismissSmartSuggestion(edgeId);
    },
    [smartEdges, reactFlowInstance, setEdges, syncEdgeToDb, showToast, lang, dismissSmartSuggestion],
  );

  /** Reject (dismiss) a ghost-edge suggestion. */
  const onRejectGhostEdge = useCallback(
    (edgeId: string) => {
      dismissSmartSuggestion(edgeId);
      showToast(lang === 'zh' ? '已忽略建议' : 'Suggestion dismissed', 'info');
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
          data: { text: '', color: DEFAULT_STICKY_HUE },
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

  /** Set a line's arrows directly: none (—), forward (→) or both (↔). */
  const handleSetEdgeDirection = useCallback(
    (edgeId: string, dir: 'none' | 'forward' | 'both') => {
      const fromEnd = dir === 'both' ? 'arrow' : 'none';
      const toEnd = dir === 'none' ? 'none' : 'arrow';
      setEdges((eds) => eds.map((e) => (e.id === edgeId ? { ...e, data: { ...e.data, fromEnd, toEnd } } : e)));
    },
    [setEdges],
  );

  // ────────────────────────────────────────────────────────────────────────
  //  6. onConnect — React Flow new connection handler
  // ────────────────────────────────────────────────────────────────────────

  /** A node's box in flow coordinates (absolute, also for cards inside groups). */
  const nodeBox = useCallback((id: string): Box | null => {
    const internal = reactFlowInstance.getInternalNode?.(id);
    const n = internal ?? reactFlowInstance.getNode(id);
    if (!n) return null;
    const abs = internal?.internals?.positionAbsolute ?? n.position;
    return {
      x: abs.x,
      y: abs.y,
      w: n.measured?.width ?? n.width ?? (n.style?.width as number) ?? 300,
      h: n.measured?.height ?? n.height ?? (n.style?.height as number) ?? 200,
    };
  }, [reactFlowInstance]);

  /** Add a user edge between two cards; no duplicates, no self-loops. */
  const connectCards = useCallback(
    (source: string, sourceSide: Side, target: string, targetSide: Side) => {
      if (source === target) return false;
      const existing: Edge[] = reactFlowInstance.getEdges();
      if (existing.some((e) => e.source === source && e.target === target && e.sourceHandle === sourceSide && e.targetHandle === targetSide)) {
        return false;
      }
      setEdges((eds) => eds.concat({
        id: `edge-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        source,
        sourceHandle: sourceSide,
        target,
        targetHandle: targetSide,
        data: { relationType: 'wikilink', fromEnd: 'none', toEnd: 'arrow' },
      }));
      syncEdgeToDb({ source, target }, 'add', 'wikilink');
      return true;
    },
    [reactFlowInstance, setEdges, syncEdgeToDb],
  );

  const onConnect = useCallback(
    (params: Connection) => {
      if (!params.source || !params.target || params.source === params.target) return;
      const sBox = nodeBox(params.source);
      const tBox = nodeBox(params.target);
      const sourceSide = isSide(params.sourceHandle) ? params.sourceHandle : sBox && tBox ? sideFacing(sBox, tBox) : 'right';
      const targetSide = isSide(params.targetHandle) ? params.targetHandle : sBox && tBox ? sideFacing(tBox, sBox) : 'left';
      connectCards(params.source, sourceSide, params.target, targetSide);
    },
    [connectCards, nodeBox],
  );

  /** The card under a screen point, if any (groups don't count: their inside is open canvas). */
  const cardAtPoint = (clientX: number, clientY: number, excludeId?: string): string | null => {
    const els = document.elementsFromPoint(clientX, clientY);
    for (const el of els) {
      const nodeEl = (el as HTMLElement).closest?.('.react-flow__node') as HTMLElement | null;
      if (!nodeEl) continue;
      const id = nodeEl.dataset.id;
      if (!id || id === excludeId || nodeEl.classList.contains('react-flow__node-group')) continue;
      return id;
    }
    return null;
  };

  // ────────────────────────────────────────────────────────────────────────
  //  7. onConnectEnd — dropping on a card connects to it (anywhere on the
  //     card, not just its small handle); dropping on empty canvas offers to
  //     create a connected card there, as Obsidian Canvas does.
  // ────────────────────────────────────────────────────────────────────────

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState?: any) => {
      if (connectionState?.isValid) return; // landed on a handle: onConnect handled it

      const sourceNodeId: string | undefined = connectionState?.fromNode?.id;
      const fromHandleId = connectionState?.fromHandle?.id;
      if (!sourceNodeId) return;

      const clientX = 'clientX' in event ? event.clientX : event.changedTouches?.[0]?.clientX || 0;
      const clientY = 'clientY' in event ? event.clientY : event.changedTouches?.[0]?.clientY || 0;

      const sBox = nodeBox(sourceNodeId);
      const targetId = cardAtPoint(clientX, clientY, sourceNodeId);
      if (targetId) {
        const tBox = nodeBox(targetId);
        const sourceSide = isSide(fromHandleId) ? fromHandleId : sBox && tBox ? sideFacing(sBox, tBox) : 'right';
        const targetSide = sBox && tBox ? sideFacing(tBox, sBox) : OPPOSITE_SIDE[sourceSide];
        connectCards(sourceNodeId, sourceSide, targetId, targetSide);
        return;
      }

      // Dropped on the card it started from: nothing to do.
      if (cardAtPoint(clientX, clientY) === sourceNodeId) return;

      const sourceHandleId = isSide(fromHandleId) ? fromHandleId : null;
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
              // A note linked both ways (or both by link and similarity) appears once.
              .filter((s: any, i: number, all: any[]) =>
                all.findIndex((o: any) => o.path.replace(/\\/g, '/') === s.path.replace(/\\/g, '/')) === i)
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
      nodeBox,
      connectCards,
      setQuickConnectMenu,
      setQuickConnectSuggestions,
    ],
  );

  // ────────────────────────────────────────────────────────────────────────
  //  7b. Reconnect: drag either end of a line onto another card; drop it on
  //      empty canvas to disconnect (Obsidian's behaviour).
  // ────────────────────────────────────────────────────────────────────────

  const reconnectDoneRef = useRef(true);

  const onReconnectStart = useCallback(() => {
    reconnectDoneRef.current = false;
  }, []);

  const replaceEdgeEnds = useCallback(
    (oldEdge: Edge, next: { source: string; sourceHandle: Side; target: string; targetHandle: Side }) => {
      if (next.source === next.target) return;
      setEdges((eds) => eds.map((e) => (e.id === oldEdge.id ? { ...e, ...next } : e)));
      if (oldEdge.source !== next.source || oldEdge.target !== next.target) {
        syncEdgeToDb({ source: oldEdge.source, target: oldEdge.target }, 'delete', relationTypeOf(oldEdge));
        syncEdgeToDb({ source: next.source, target: next.target }, 'add', relationTypeOf(oldEdge));
      }
    },
    [setEdges, syncEdgeToDb],
  );

  const onReconnect = useCallback(
    (oldEdge: Edge, conn: Connection) => {
      reconnectDoneRef.current = true;
      if (!conn.source || !conn.target) return;
      const sBox = nodeBox(conn.source);
      const tBox = nodeBox(conn.target);
      replaceEdgeEnds(oldEdge, {
        source: conn.source,
        sourceHandle: isSide(conn.sourceHandle) ? conn.sourceHandle : sBox && tBox ? sideFacing(sBox, tBox) : 'right',
        target: conn.target,
        targetHandle: isSide(conn.targetHandle) ? conn.targetHandle : sBox && tBox ? sideFacing(tBox, sBox) : 'left',
      });
    },
    [nodeBox, replaceEdgeEnds],
  );

  const onReconnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, edge: Edge, _handleType: unknown, connectionState?: any) => {
      if (reconnectDoneRef.current) return;
      reconnectDoneRef.current = true;
      const clientX = 'clientX' in event ? event.clientX : event.changedTouches?.[0]?.clientX || 0;
      const clientY = 'clientY' in event ? event.clientY : event.changedTouches?.[0]?.clientY || 0;
      // The end that stays put is where the drag "comes from".
      const fixedId: string | undefined = connectionState?.fromNode?.id;
      const movingTarget = fixedId ? fixedId === edge.source : true;
      const fixed = movingTarget ? edge.source : edge.target;
      const dropId = cardAtPoint(clientX, clientY, fixed);
      if (dropId) {
        const fBox = nodeBox(fixed);
        const dBox = nodeBox(dropId);
        const fixedSide = (movingTarget ? edge.sourceHandle : edge.targetHandle) as Side | null | undefined;
        const keep = isSide(fixedSide) ? fixedSide : fBox && dBox ? sideFacing(fBox, dBox) : 'right';
        const dropSide = fBox && dBox ? sideFacing(dBox, fBox) : OPPOSITE_SIDE[keep];
        replaceEdgeEnds(edge, movingTarget
          ? { source: fixed, sourceHandle: keep, target: dropId, targetHandle: dropSide }
          : { source: dropId, sourceHandle: dropSide, target: fixed, targetHandle: keep });
        return;
      }
      // Released on empty canvas: the line is removed.
      setEdges((eds) => eds.filter((e) => e.id !== edge.id));
      syncEdgeToDb({ source: edge.source, target: edge.target }, 'delete', relationTypeOf(edge));
    },
    [nodeBox, replaceEdgeEnds, setEdges, syncEdgeToDb],
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
  /**
   * Drop point (flow coords) and the side of the source card that faces it.
   * The line leaves from that side even if the drag began on another handle,
   * so a card created to the left of its source isn't joined by a loop.
   */
  const quickDropGeometry = (menu: { x: number; y: number; sourceNodeId: string; sourceHandleId: string | null }) => {
    const at = reactFlowInstance.screenToFlowPosition({ x: menu.x, y: menu.y });
    const b = nodeBox(menu.sourceNodeId);
    const fromSide: Side = b
      ? sideFacing(b, { x: at.x, y: at.y, w: 0, h: 0 })
      : isSide(menu.sourceHandleId) ? menu.sourceHandleId : 'right';
    return { at, fromSide };
  };

  const handleQuickCreate = useCallback(
    (type: 'text' | 'file' | 'web') => {
      if (!quickConnectMenu) return;
      const { sourceNodeId } = quickConnectMenu;
      const { at, fromSide } = quickDropGeometry(quickConnectMenu);
      setQuickConnectMenu(null);

      if (type === 'file') {
        // Pick a note; it lands here and connects (see useCanvasFileIO).
        openAddNoteModal({ kind: 'connect', at, sourceNodeId, fromSide });
        return;
      }

      const newId = genNodeId();
      const size = type === 'text' ? { w: 250, h: 250 } : { w: 360, h: 280 };
      const newNode: Node = {
        id: newId,
        type,
        position: placeAgainst(at, size.w, size.h, fromSide),
        width: size.w,
        height: size.h,
        style: { width: size.w, height: size.h },
        data: type === 'text' ? { text: '', color: DEFAULT_STICKY_HUE } : { url: '', lang },
      };
      setNodes((nds) => nds.concat(newNode));
      setEdges((eds) => eds.concat({
        id: `edge-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        source: sourceNodeId,
        sourceHandle: fromSide,
        target: newId,
        targetHandle: OPPOSITE_SIDE[fromSide],
        data: { relationType: 'wikilink', fromEnd: 'none', toEnd: 'arrow' },
      }));
    },
    [quickConnectMenu, lang, setNodes, setEdges, setQuickConnectMenu, openAddNoteModal],
  );

  /** Quick-connect to a related note: it lands at the drop point, connected. */
  const handleQuickConnectSimilar = useCallback(
    (filePath: string) => {
      if (!quickConnectMenu) return;
      const { sourceNodeId } = quickConnectMenu;
      const { at, fromSide } = quickDropGeometry(quickConnectMenu);
      const name = filePath.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/, '') || filePath;
      const newId = genNodeId();

      setNodes((nds) => nds.concat({
        id: newId,
        type: 'file',
        position: placeAgainst(at, 400, 300, fromSide),
        width: 400,
        height: 300,
        style: { width: 400, height: 300 },
        data: { file: filePath, title: name },
      }));
      setEdges((eds) => eds.concat({
        id: `edge-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        source: sourceNodeId,
        sourceHandle: fromSide,
        target: newId,
        targetHandle: OPPOSITE_SIDE[fromSide],
        data: { relationType: 'wikilink', fromEnd: 'none', toEnd: 'arrow' },
      }));
      // The new card is in the store on the next tick; sync after it lands.
      setTimeout(() => syncEdgeToDb({ source: sourceNodeId, target: newId }, 'add', 'wikilink'), 0);
      setQuickConnectMenu(null);
      setQuickConnectSuggestions([]);
    },
    [quickConnectMenu, setNodes, setEdges, syncEdgeToDb, setQuickConnectMenu, setQuickConnectSuggestions],
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
              data: { file: filePath, title: name },
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
        syncEdgeToDb(
          { source: edge.source, target: edge.target },
          'delete',
          (edge.data?.relationType as string | undefined)
            || (typeof edge.label === 'string' ? edge.label : undefined)
            || 'wikilink',
        );
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
        syncEdgeToDb(
          { source: edge.source, target: edge.target },
          'delete',
          (edge.data?.relationType as string | undefined)
            || (typeof edge.label === 'string' ? edge.label : undefined)
            || 'wikilink',
        );
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
        // The picked note lands where the menu was opened.
        openAddNoteModal({ kind: 'at', at: position });
      } else if (type === 'text') {
        const newNode: Node = {
          id: genNodeId(),
          type: 'text',
          position: placeAgainst(position, 250, 250),
          width: 250,
          height: 250,
          style: { width: 250, height: 250 },
          data: { text: '', color: DEFAULT_STICKY_HUE },
        };
        setNodes((nds) => nds.concat(newNode));
      } else if (type === 'web') {
        const newNode: Node = {
          id: genNodeId(),
          type: 'web',
          position: placeAgainst(position, 360, 280),
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
          position: placeAgainst(position, 600, 400),
          width: 600,
          height: 400,
          style: { width: 600, height: 400 },
          data: { label: lang === 'zh' ? '新分组' : 'New group' },
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
    onReconnect,
    onReconnectStart,
    onReconnectEnd,
    handleSetEdgeDirection,

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
