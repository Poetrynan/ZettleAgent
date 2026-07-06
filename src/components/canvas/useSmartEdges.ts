/**
 * useSmartEdges — Contradiction, supports, semantic suggestion, and duplicate overlay edges.
 * Extracted from InteractiveCanvas.tsx for separation of concerns.
 */
import { useCallback, useRef } from 'react';
import type { Node, Edge } from '@xyflow/react';
import { addEdge } from '@xyflow/react';
import {
  getEdgesByRelation,
  getKnowledgeGraph,
  runVaultLint,
} from '../../lib/tauri';
import { t } from '../../lib/i18n';

interface SmartEdgesParams {
  nodes: Node[];
  edges: Edge[];
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>;
  reactFlowInstance: any;
  syncEdgeToDb: (connection: { source: string; target: string }, action: 'add' | 'delete', relationType?: string) => void;
  showToast: (msg: string, type: string) => void;
  lang: string;
  vaultPath?: string | null;
}

export function useSmartEdges(params: SmartEdgesParams) {
  const { nodes, edges, setEdges, reactFlowInstance, syncEdgeToDb, showToast, lang, vaultPath } = params;

  const ignoredSuggestionsRef = useRef<Set<string>>(new Set());
  const smartEdgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Load smart edges (contradictions + supports + semantic suggestions + duplicates) ──
  const loadSmartEdges = useCallback(async (
    setSmartEdgesState: React.Dispatch<React.SetStateAction<Edge[]>>,
  ) => {
    try {
      const fileNodes = nodes.filter(n => n.type === 'file');
      if (fileNodes.length < 2) { setSmartEdgesState([]); return; }

      const pathToNodeId = new Map<string, string>();
      for (const n of fileNodes) {
        const p = (n.data.file as string).replace(/\\/g, '/');
        pathToNodeId.set(p, n.id);
      }

      const existingPairs = new Set<string>();
      for (const e of edges) {
        if (e.data?._smart) continue;
        existingPairs.add(`${e.source}::${e.target}`);
        existingPairs.add(`${e.target}::${e.source}`);
      }

      const newSmartEdges: Edge[] = [];

      // 1. Contradiction edges
      const contradictEdges = await getEdgesByRelation('contradicts');
      for (const ce of contradictEdges) {
        const srcNorm = ce.source.replace(/\\/g, '/');
        const tgtNorm = ce.target.replace(/\\/g, '/');
        const srcId = pathToNodeId.get(srcNorm);
        const tgtId = pathToNodeId.get(tgtNorm);
        if (!srcId || !tgtId) continue;
        if (existingPairs.has(`${srcId}::${tgtId}`)) continue;
        const edgeId = `smart-contradict-${srcId}-${tgtId}`;
        newSmartEdges.push({
          id: edgeId,
          source: srcId,
          target: tgtId,
          type: 'default',
          animated: true,
          style: { stroke: '#ef4444', strokeDasharray: '8 4', strokeWidth: 2, opacity: 0.8 },
          label: '⚠️ ' + t('canvas.smartContradiction'),
          labelStyle: { fontSize: 10, fill: '#ef4444', fontWeight: 600 },
          data: { _smart: true, _smartType: 'contradiction', relationType: 'contradicts' },
        });
      }

      // 2. Supports edges — limit to top 3
      const supportEdges = await getEdgesByRelation('supports');
      const canvasSupports: { srcId: string; tgtId: string }[] = [];
      for (const se of supportEdges) {
        const srcNorm = se.source.replace(/\\/g, '/');
        const tgtNorm = se.target.replace(/\\/g, '/');
        const srcId = pathToNodeId.get(srcNorm);
        const tgtId = pathToNodeId.get(tgtNorm);
        if (!srcId || !tgtId) continue;
        if (existingPairs.has(`${srcId}::${tgtId}`)) continue;
        canvasSupports.push({ srcId, tgtId });
      }
      for (const { srcId, tgtId } of canvasSupports.slice(0, 3)) {
        const edgeId = `smart-supports-${srcId}-${tgtId}`;
        newSmartEdges.push({
          id: edgeId,
          source: srcId,
          target: tgtId,
          type: 'default',
          style: { stroke: '#22c55e', strokeDasharray: '6 3', strokeWidth: 1.5, opacity: 0.6 },
          label: t('canvas.smartSupports'),
          labelStyle: { fontSize: 9, fill: '#22c55e', fontWeight: 500 },
          data: { _smart: true, _smartType: 'supports', relationType: 'supports' },
        });
      }

      // 3. Semantic similarity edges — top 3 above 0.82
      try {
        const graphData = await getKnowledgeGraph(vaultPath || '');
        const candidates: { srcId: string; tgtId: string; weight: number }[] = [];
        for (const ge of graphData.edges) {
          if (ge.edge_type !== 'semantic') continue;
          if (ge.weight < 0.82) continue;
          const srcNorm = ge.source.replace(/\\/g, '/');
          const tgtNorm = ge.target.replace(/\\/g, '/');
          const srcId = pathToNodeId.get(srcNorm);
          const tgtId = pathToNodeId.get(tgtNorm);
          if (!srcId || !tgtId) continue;
          if (existingPairs.has(`${srcId}::${tgtId}`)) continue;
          if (newSmartEdges.some(e => (e.source === srcId && e.target === tgtId) || (e.source === tgtId && e.target === srcId))) continue;
          const pairKey = `${srcId}::${tgtId}`;
          if (ignoredSuggestionsRef.current.has(pairKey)) continue;
          candidates.push({ srcId, tgtId, weight: ge.weight });
        }
        candidates.sort((a, b) => b.weight - a.weight);
        for (const { srcId, tgtId, weight } of candidates.slice(0, 3)) {
          const similarity = Math.round(weight * 100);
          const edgeId = `smart-suggest-${srcId}-${tgtId}`;
          newSmartEdges.push({
            id: edgeId,
            source: srcId,
            target: tgtId,
            type: 'default',
            style: { stroke: '#60a5fa', strokeDasharray: '4 6', strokeWidth: 1.5, opacity: 0.5 },
            label: `💡 ${similarity}%`,
            labelStyle: { fontSize: 9, fill: '#60a5fa', fontWeight: 500 },
            data: { _smart: true, _smartType: 'suggestion', similarity },
          });
        }
      } catch (err) {
        console.warn('Failed to load semantic edges for canvas:', err);
      }

      // 4. Semantic duplicates (similarity ≥ 0.92) from lint
      try {
        const lint = await runVaultLint();
        for (const dup of lint.semantic_duplicates) {
          const normA = dup.file_path_a.replace(/\\/g, '/');
          const normB = dup.file_path_b.replace(/\\/g, '/');
          const idA = pathToNodeId.get(normA);
          const idB = pathToNodeId.get(normB);
          if (!idA || !idB) continue;
          if (existingPairs.has(`${idA}::${idB}`)) continue;
          if (newSmartEdges.some(e => (e.source === idA && e.target === idB) || (e.source === idB && e.target === idA))) continue;
          const pairKey = `${idA}::${idB}`;
          if (ignoredSuggestionsRef.current.has(pairKey)) continue;
          const simPct = Math.round(dup.similarity * 100);
          const edgeId = `smart-duplicate-${idA}-${idB}`;
          newSmartEdges.push({
            id: edgeId,
            source: idA,
            target: idB,
            type: 'default',
            animated: true,
            style: { stroke: '#f97316', strokeDasharray: '6 4', strokeWidth: 2, opacity: 0.75 },
            label: `⚠️ ${t('canvas.smartDuplicate')} ${simPct}%`,
            labelStyle: { fontSize: 10, fill: '#f97316', fontWeight: 600 },
            data: { _smart: true, _smartType: 'duplicate', similarity: simPct },
          });
        }
      } catch (err) {
        console.warn('Failed to load semantic duplicates for canvas:', err);
      }

      setSmartEdgesState(newSmartEdges);
    } catch (err) {
      console.warn('Failed to load smart edges:', err);
    }
  }, [nodes, edges, lang]);

  // ── Handle smart edge click (confirm suggestion) ──
  const handleSmartEdgeClick = useCallback((
    _event: React.MouseEvent,
    edge: Edge,
    setSmartEdgesState: React.Dispatch<React.SetStateAction<Edge[]>>,
  ) => {
    if (!edge.data?._smart) return;
    const smartType = edge.data._smartType as string;
    if (smartType === 'suggestion') {
      const srcNode = reactFlowInstance.getNode(edge.source);
      const tgtNode = reactFlowInstance.getNode(edge.target);
      if (srcNode?.type === 'file' && tgtNode?.type === 'file') {
        const newEdge: Edge = {
          id: `edge-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          source: edge.source,
          target: edge.target,
          type: 'default',
          label: t('canvas.smartConfirmed'),
        };
        setEdges(eds => addEdge(newEdge, eds));
        syncEdgeToDb({ source: edge.source, target: edge.target }, 'add', 'supplementary');
        showToast(t('canvas.smartConnectionConfirmed'), 'success');
      }
      setSmartEdgesState(prev => prev.filter(e => e.id !== edge.id));
    }
  }, [reactFlowInstance, setEdges, syncEdgeToDb, showToast, lang]);

  // ── Dismiss suggestion (right-click) ──
  const handleSmartEdgeContextMenu = useCallback((
    event: React.MouseEvent,
    edge: Edge,
    setSmartEdgesState: React.Dispatch<React.SetStateAction<Edge[]>>,
  ) => {
    if (!edge.data?._smart) return;
    event.preventDefault();
    const pairKey = `${edge.source}::${edge.target}`;
    ignoredSuggestionsRef.current.add(pairKey);
    ignoredSuggestionsRef.current.add(`${edge.target}::${edge.source}`);
    setSmartEdgesState(prev => prev.filter(e => e.id !== edge.id));
    showToast(t('canvas.smartDismissed'), 'info');
  }, [showToast, lang]);

  return {
    ignoredSuggestionsRef,
    smartEdgeTimerRef,
    loadSmartEdges,
    handleSmartEdgeClick,
    handleSmartEdgeContextMenu,
  };
}
