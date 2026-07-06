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

        if (smartType === 'suggestion') {
          newSuggestions.push({
            id: se.id,
            type: 'action',
            title: isZh ? `建议连接: ${srcTitle} ↔ ${tgtTitle}` : `Suggested Link: ${srcTitle} ↔ ${tgtTitle}`,
            description: isZh
              ? `AI 扫描发现这两张卡片有 ${se.data?.similarity}% 的概念语义相关性，建议建立关联。`
              : `AI detected ${se.data?.similarity}% semantic similarity between these concepts.`,
            actionLabel: isZh ? '接受连接' : 'Accept Link',
            actionData: { edge: se },
          });
        } else if (smartType === 'duplicate') {
          newSuggestions.push({
            id: se.id,
            type: 'warning',
            title: isZh ? `可能重复: ${srcTitle} ↔ ${tgtTitle}` : `Possible Duplicate: ${srcTitle} ↔ ${tgtTitle}`,
            description: isZh
              ? `检测到 ${se.data?.similarity}% 的极高语义重合度，它们可能描述了相同的核心知识概念。`
              : `Extremely high similarity (${se.data?.similarity}%). They might be duplicates.`,
            actionLabel: isZh ? '合并卡片' : 'Merge Notes',
            actionData: { edge: se },
          });
        } else if (smartType === 'contradiction') {
          newSuggestions.push({
            id: se.id,
            type: 'warning',
            title: isZh ? `矛盾警告: ${srcTitle} ↔ ${tgtTitle}` : `Contradiction: ${srcTitle} ↔ ${tgtTitle}`,
            description: isZh
              ? '检测到这两张卡片在事实层面上存在潜在冲突或矛盾，请审视其逻辑关联。'
              : 'Potential factual conflict or contradiction detected between these notes.',
          });
        }
      }

      if (orphanNodeIds.length > 0) {
        newSuggestions.push({
          id: 'diag-orphans-action',
          type: 'info',
          title: isZh ? '整理画布上的孤立卡片' : 'Arrange Orphan Cards',
          description: isZh
            ? `当前画布上有 ${orphanNodeIds.length} 张卡片没有建立任何连线。`
            : `There are ${orphanNodeIds.length} cards with no connections.`,
          actionLabel: isZh ? '一键智能排版' : 'Run Auto-Layout',
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
