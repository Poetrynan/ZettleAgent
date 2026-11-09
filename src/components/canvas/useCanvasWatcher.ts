import { useState, useEffect, useCallback, useRef } from 'react';
import { Node, Edge } from '@xyflow/react';
import { getKnowledgeGraph, getEdgesByRelation, runVaultLint } from '../../lib/tauri';
import { AgentSuggestion } from '../common/AgentPanel';

interface CanvasStats {
  totalNodes: number;
  totalEdges: number;
  orphanCount: number;
  brokenCount: number;
  missingMetaCount: number;
}

export function useCanvasWatcher(
  nodes: Node[],
  edges: Edge[],
  vaultPath: string,
  lang: string
) {
  const [smartEdges, setSmartEdges] = useState<Edge[]>([]);
  const [diagnostics, setDiagnostics] = useState<{
    orphanNodeIds: string[];
    brokenLinkNodeIds: string[];
    missingMetaNodeIds: string[];
    totalIssues: number;
  } | null>(null);
  const [suggestions, setSuggestions] = useState<AgentSuggestion[]>([]);
  const [stats, setStats] = useState<CanvasStats | null>(null);
  
  const ignoredSuggestionsRef = useRef<Set<string>>(new Set());
  const isZh = lang === 'zh';

  const triggerScan = useCallback(async () => {
    try {
      const fileNodes = nodes.filter(n => n.type === 'file');
      if (fileNodes.length === 0) {
        setSmartEdges([]);
        setDiagnostics(null);
        setSuggestions([]);
        return null;
      }

      // Build file path → node ID map
      const pathToNodeId = new Map<string, string>();
      for (const n of fileNodes) {
        const p = (n.data.file as string).replace(/\\/g, '/');
        pathToNodeId.set(p, n.id);
      }

      // Find canvas orphans (file nodes with no edges on canvas)
      const connectedNodeIds = new Set<string>();
      for (const e of edges) {
        if (e.data?._smart) continue;
        connectedNodeIds.add(e.source);
        connectedNodeIds.add(e.target);
      }
      const orphanNodeIds = fileNodes.filter(n => !connectedNodeIds.has(n.id)).map(n => n.id);

      // Run vault lint
      const lint = await runVaultLint();

      // Match broken links
      const brokenLinkNodeIds: string[] = [];
      for (const bl of lint.broken_links) {
        const norm = bl.file_path.replace(/\\/g, '/');
        const nodeId = pathToNodeId.get(norm);
        if (nodeId) brokenLinkNodeIds.push(nodeId);
      }

      // Match missing metadata
      const missingMetaNodeIds: string[] = [];
      for (const mm of lint.missing_metadata) {
        const norm = mm.file_path.replace(/\\/g, '/');
        const nodeId = pathToNodeId.get(norm);
        if (nodeId) missingMetaNodeIds.push(nodeId);
      }

      const totalIssues = orphanNodeIds.length + brokenLinkNodeIds.length + missingMetaNodeIds.length;
      setDiagnostics({ orphanNodeIds, brokenLinkNodeIds, missingMetaNodeIds, totalIssues });

      // Build stats
      setStats({
        totalNodes: nodes.length,
        totalEdges: edges.filter(e => !e.data?._smart).length,
        orphanCount: orphanNodeIds.length,
        brokenCount: brokenLinkNodeIds.length,
        missingMetaCount: missingMetaNodeIds.length,
      });

      // Build Smart Edges (contradictions, supports, semantic suggestions, semantic duplicates)
      const newSmartEdges: Edge[] = [];
      const existingPairs = new Set<string>();
      for (const e of edges) {
        if (e.data?._smart) continue;
        existingPairs.add(`${e.source}::${e.target}`);
        existingPairs.add(`${e.target}::${e.source}`);
      }

      // Contradictions
      try {
        const contradictEdges = await getEdgesByRelation('contradicts');
        for (const ce of contradictEdges) {
          const srcNorm = ce.source.replace(/\\/g, '/');
          const tgtNorm = ce.target.replace(/\\/g, '/');
          const srcId = pathToNodeId.get(srcNorm);
          const tgtId = pathToNodeId.get(tgtNorm);
          if (!srcId || !tgtId) continue;
          if (existingPairs.has(`${srcId}::${tgtId}`)) continue;
          newSmartEdges.push({
            id: `smart-contradict-${srcId}-${tgtId}`,
            source: srcId,
            target: tgtId,
            type: 'ghost',
            data: {
              _smart: true,
              _smartType: 'contradiction',
              relationType: 'contradicts',
              label: isZh ? '矛盾冲突' : 'Contradiction',
            },
          });
        }
      } catch (err) {
        console.warn('CanvasWatcher contradiction query failed:', err);
      }

      // Semantic Similarity from Knowledge Graph
      try {
        const graphData = await getKnowledgeGraph(vaultPath);
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
          newSmartEdges.push({
            id: `smart-suggest-${srcId}-${tgtId}`,
            source: srcId,
            target: tgtId,
            type: 'ghost',
            data: {
              _smart: true,
              _smartType: 'suggestion',
              similarity,
              label: `${similarity}%`,
            },
          });
        }
      } catch (err) {
        console.warn('CanvasWatcher semantic suggestion query failed:', err);
      }

      // Semantic Duplicates from lint
      for (const dup of lint.semantic_duplicates) {
        const normA = dup.file_path_a.replace(/\\/g, '/');
        const normB = dup.file_path_b.replace(/\\/g, '/');
        const idA = pathToNodeId.get(normA);
        const idB = pathToNodeId.get(normB);
        if (!idA || !idB) continue;
        if (existingPairs.has(`${idA}::${idB}`)) continue;
        const pairKey = `${idA}::${idB}`;
        if (ignoredSuggestionsRef.current.has(pairKey)) continue;
        const simPct = Math.round(dup.similarity * 100);
        newSmartEdges.push({
          id: `smart-duplicate-${idA}-${idB}`,
          source: idA,
          target: idB,
          type: 'ghost',
          data: {
            _smart: true,
            _smartType: 'duplicate',
            similarity: simPct,
            label: `${isZh ? '内容重复' : 'Duplicate'} ${simPct}%`,
          },
        });
      }

      setSmartEdges(newSmartEdges);

      // Build suggestions list for AgentPanel
      const newSuggestions: AgentSuggestion[] = [];

      for (const se of newSmartEdges) {
        const srcNode = nodes.find(n => n.id === se.source);
        const tgtNode = nodes.find(n => n.id === se.target);
        const srcTitle = srcNode?.data.title || srcNode?.id || '';
        const tgtTitle = tgtNode?.data.title || tgtNode?.id || '';
        const smartType = se.data?._smartType as string;

        const pair: [string, string] = [String(srcTitle), String(tgtTitle)];
        if (smartType === 'suggestion') {
          newSuggestions.push({
            id: se.id,
            type: 'action',
            kind: isZh ? '可以连接' : 'Could connect',
            pair,
            title: `${srcTitle} ↔ ${tgtTitle}`,
            description: isZh
              ? `内容相似度 ${se.data?.similarity}%，也许值得连在一起。`
              : `${se.data?.similarity}% similar in content — maybe worth linking.`,
            actionLabel: isZh ? '连接' : 'Connect',
            actionData: { edge: se },
          });
        } else if (smartType === 'duplicate') {
          newSuggestions.push({
            id: se.id,
            type: 'warning',
            kind: isZh ? '可能重复' : 'Possible duplicate',
            pair,
            title: `${srcTitle} ↔ ${tgtTitle}`,
            description: isZh
              ? `内容相似度 ${se.data?.similarity}%，可能写的是同一件事。`
              : `${se.data?.similarity}% similar — they may say the same thing.`,
            actionLabel: isZh ? '合并' : 'Merge',
            actionData: { edge: se },
          });
        } else if (smartType === 'contradiction') {
          newSuggestions.push({
            id: se.id,
            type: 'warning',
            kind: isZh ? '说法不一致' : 'Disagreement',
            pair,
            title: `${srcTitle} ↔ ${tgtTitle}`,
            description: isZh
              ? '两张卡片里有说法对不上的地方，值得对照看看。'
              : 'These two cards seem to disagree somewhere; worth reading side by side.',
          });
        }
      }

      if (orphanNodeIds.length > 0) {
        newSuggestions.push({
          id: 'diag-orphans-action',
          type: 'info',
          kind: isZh ? '未连接' : 'Unconnected',
          title: isZh ? `${orphanNodeIds.length} 张卡片还没有连线` : `${orphanNodeIds.length} cards have no lines yet`,
          description: isZh
            ? '自动排列会把它们挪到相关卡片旁边。'
            : 'Arranging moves them next to related cards.',
          actionLabel: isZh ? '自动排列' : 'Arrange',
          actionData: { action: 'auto-layout' },
        });
      }
      setSuggestions(newSuggestions);
      return { orphanNodeIds, brokenLinkNodeIds, missingMetaNodeIds, totalIssues };
    } catch (err) {
      console.warn('CanvasWatcher scan failed:', err);
      return null;
    }
  }, [nodes, edges, vaultPath, lang, isZh]);

  // Debounced auto-scan when card count changes
  // 性能优化: 使用 nodes/edges 的长度作为依赖，避免拖拽时重复触发
  const nodesLengthRef = useRef(0);
  const edgesLengthRef = useRef(0);
  const nodesFingerprintRef = useRef('');
  const fileNodeCount = useRef(0);
  
  // 计算 nodes 的轻量指纹（只关注结构变化，不关注位置）
  const nodesFingerprint = nodes.map(n => n.id).join(',');
  
  useEffect(() => {
    const count = nodes.filter(n => n.type === 'file').length;
    // 只在文件节点数量变化或节点ID列表变化时触发扫描
    if (count !== fileNodeCount.current || nodesFingerprint !== nodesFingerprintRef.current) {
      fileNodeCount.current = count;
      nodesFingerprintRef.current = nodesFingerprint;
      const timer = setTimeout(() => {
        triggerScan();
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [nodes, edges, triggerScan, nodesFingerprint]);

  const clearDiagnostics = useCallback(() => {
    setDiagnostics(null);
  }, []);

  const dismissSuggestion = useCallback((edgeId: string) => {
    const se = smartEdges.find(e => e.id === edgeId);
    if (se) {
      const pairKey = `${se.source}::${se.target}`;
      ignoredSuggestionsRef.current.add(pairKey);
      ignoredSuggestionsRef.current.add(`${se.target}::${se.source}`);
      setSmartEdges(prev => prev.filter(e => e.id !== edgeId));
      setSuggestions(prev => prev.filter(sug => sug.id !== edgeId));
    }
  }, [smartEdges]);

  return {
    smartEdges,
    diagnostics,
    suggestions,
    stats,
    triggerScan,
    clearDiagnostics,
    dismissSuggestion,
  };
}
