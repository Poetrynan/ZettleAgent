/**
 * useCanvasAI — Canvas Health Diagnostics, AI Auto-Layout, and Smart Canvas hooks.
 * Extracted from InteractiveCanvas.tsx for separation of concerns.
 */
import { useCallback } from 'react';
import type { Node, Edge } from '@xyflow/react';
import {
  runVaultLint,
  getKnowledgeGraph,
  searchChunks,
  agentChat,
} from '../../lib/tauri';
import { t, tf } from '../../lib/i18n';
import { getRelationTypes } from './canvasConstants';
import { getNoteColorMap, METHODOLOGY_TYPES, mapNoteType } from '../dashboard/graphHelpers';

// ── Types ──

interface DiagnosticResults {
  orphanNodeIds: string[];
  brokenLinkNodeIds: string[];
  missingMetaNodeIds: string[];
  totalIssues: number;
}

interface CanvasAIParams {
  nodes: Node[];
  edges: Edge[];
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>;
  reactFlowInstance: any;
  showToast: (msg: string, type: string) => void;
  lang: string;
  methodology: string;
  llmConfig: { apiUrl: string; apiKey: string; model: string; providerId: string };
  vaultPath: string | null;
  // Diagnostic state
  diagnosticResults: DiagnosticResults | null;
  setDiagnosticResults: (v: DiagnosticResults | null) => void;
  setIsDiagnosticRunning: (v: boolean) => void;
  // Smart Canvas state
  smartCanvasQuery: string;
  setSmartCanvasLoading: (v: boolean) => void;
  setSmartCanvasOpen: (v: boolean) => void;
  setSmartCanvasQuery: (v: string) => void;
}

export function useCanvasAI(params: CanvasAIParams) {
  const {
    nodes, edges, setNodes, setEdges, reactFlowInstance,
    showToast, lang, methodology, llmConfig, vaultPath,
    diagnosticResults, setDiagnosticResults, setIsDiagnosticRunning,
    smartCanvasQuery, setSmartCanvasLoading, setSmartCanvasOpen, setSmartCanvasQuery,
  } = params;

  // ── Canvas Health Diagnostics ──
  const handleDiagnoseCanvas = useCallback(async () => {
    if (diagnosticResults) {
      // Toggle off: clear highlights
      setDiagnosticResults(null);
      setNodes(nds => nds.map(n => ({ ...n, className: (n.className || '').replace(/canvas-diag-\w+/g, '').trim() || undefined })));
      return;
    }
    setIsDiagnosticRunning(true);
    try {
      const lint = await runVaultLint();
      const fileNodes = nodes.filter(n => n.type === 'file');
      if (fileNodes.length === 0) {
        showToast(t('canvas.diagNoCards'), 'info');
        setIsDiagnosticRunning(false);
        return;
      }

      // Build file path → node ID map
      const pathToId = new Map<string, string>();
      for (const n of fileNodes) {
        const p = (n.data.file as string).replace(/\\/g, '/');
        pathToId.set(p, n.id);
      }

      // Find canvas orphans (file nodes with no edges on canvas)
      const connectedNodeIds = new Set<string>();
      for (const e of edges) {
        connectedNodeIds.add(e.source);
        connectedNodeIds.add(e.target);
      }
      const orphanNodeIds = fileNodes.filter(n => !connectedNodeIds.has(n.id)).map(n => n.id);

      // Match broken links from lint
      const brokenLinkNodeIds: string[] = [];
      for (const bl of lint.broken_links) {
        const norm = bl.file_path.replace(/\\/g, '/');
        const nodeId = pathToId.get(norm);
        if (nodeId) brokenLinkNodeIds.push(nodeId);
      }

      // Match missing metadata from lint
      const missingMetaNodeIds: string[] = [];
      for (const mm of lint.missing_metadata) {
        const norm = mm.file_path.replace(/\\/g, '/');
        const nodeId = pathToId.get(norm);
        if (nodeId) missingMetaNodeIds.push(nodeId);
      }

      const totalIssues = orphanNodeIds.length + brokenLinkNodeIds.length + missingMetaNodeIds.length;

      // Apply visual highlights via className
      const orphanSet = new Set(orphanNodeIds);
      const brokenSet = new Set(brokenLinkNodeIds);
      const missingSet = new Set(missingMetaNodeIds);
      setNodes(nds => nds.map(n => {
        let cls = (n.className || '').replace(/canvas-diag-\w+/g, '').trim();
        if (brokenSet.has(n.id)) cls += ' canvas-diag-broken';
        else if (orphanSet.has(n.id)) cls += ' canvas-diag-orphan';
        else if (missingSet.has(n.id)) cls += ' canvas-diag-missing';
        return { ...n, className: cls.trim() || undefined };
      }));

      setDiagnosticResults({ orphanNodeIds, brokenLinkNodeIds, missingMetaNodeIds, totalIssues });
      if (totalIssues === 0) {
        showToast(t('canvas.diagHealthy'), 'success');
      } else {
        showToast(
          tf('canvas.diagIssues', totalIssues, orphanNodeIds.length, brokenLinkNodeIds.length, missingMetaNodeIds.length),
          'info'
        );
      }
    } catch (err) {
      showToast(`Diagnostic failed: ${err}`, 'error');
    }
    setIsDiagnosticRunning(false);
  }, [diagnosticResults, nodes, edges, setNodes, showToast, lang, setDiagnosticResults, setIsDiagnosticRunning]);

  // ── AI Auto-Layout — LLM-powered intelligent canvas arrangement ──
  // silent=true suppresses toasts (used when called from Smart Canvas which has its own toast)
  const handleAutoLayout = useCallback(async (silent = false) => {
    // Read current nodes from React Flow instance to avoid stale closure
    const currentNodes = reactFlowInstance.getNodes() as Node[];
    const fileNodes = currentNodes.filter(n => n.type === 'file');
    if (fileNodes.length < 2) {
      if (!silent) showToast(t('canvas.layoutMinCards'), 'info');
      return;
    }

    if (!silent) showToast(t('canvas.layoutAnalyzing'), 'info');

    try {
      const graphData = await getKnowledgeGraph(vaultPath || '');
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
      let llmLayoutApplied = false;
      try {
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
            vaultPath: vaultPath || undefined,
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
            setNodes(updatedNodes);
            llmLayoutApplied = true;

            const groups = [...new Set(layout.map(l => l.group).filter(Boolean))];
            setTimeout(() => reactFlowInstance.fitView({ padding: 0.15, duration: 800 }), 50);
            if (!silent) showToast(
              tf('canvas.layoutLlmDone', fileNodes.length, groups.length > 0 ? ' (' + groups.join(', ') + ')' : ''),
              'success'
            );
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
          const orderedKeys = [...methodologyTypes.filter(t => groups.has(t)), ...(groups.has('other') ? ['other'] : [])];
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
        const useMethodGrouping = methodologyTypes && methodologyTypes.length >= 2;

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
        setNodes(updatedNodes);
        setTimeout(() => reactFlowInstance.fitView({ padding: 0.15, duration: 800 }), 50);

        const groupTypeName = useMethodGrouping
          ? tf('canvas.layoutCategories', methodology.toUpperCase())
          : t('canvas.layoutClusters');
        if (!silent) showToast(
          tf('canvas.layoutAlgoDone', groupCount, groupTypeName),
          'success'
        );
      }
    } catch (err) {
      showToast(`Auto-layout failed: ${err}`, 'error');
    }
  }, [setNodes, reactFlowInstance, showToast, lang, methodology, llmConfig, vaultPath]);

  // ── Smart Canvas — search and populate ──
  const handleSmartCanvasSearch = useCallback(async (
    overrideQuery?: string,
    overrideResults?: Awaited<ReturnType<typeof searchChunks>>,
    onProgress?: (step: 'searching' | 'connecting' | 'arranging' | 'done') => void,
  ) => {
    const query = overrideQuery || smartCanvasQuery;
    if (!query.trim() && !overrideResults?.length) return;
    setSmartCanvasLoading(true);
    onProgress?.('searching');
    try {
      // Search for relevant chunks (use override results if provided)
      const results = overrideResults || (await searchChunks({ query, limit: 12 }));
      if (results.length === 0) {
        showToast(t('canvas.smartNoResults'), 'info');
        setSmartCanvasLoading(false);
        return;
      }

      // Deduplicate by file path
      const seenPaths = new Set<string>();
      const canvasFilePaths = new Set(
        nodes.filter(n => n.type === 'file').map(n => (n.data.file as string).replace(/\\/g, '/'))
      );
      const uniqueResults = results.filter(r => {
        const norm = r.file_path.replace(/\\/g, '/');
        if (seenPaths.has(norm) || canvasFilePaths.has(norm)) return false;
        seenPaths.add(norm);
        return true;
      }).slice(0, 8); // max 8 new notes

      if (uniqueResults.length === 0) {
        showToast(t('canvas.smartAlreadyOnCanvas'), 'info');
        setSmartCanvasLoading(false);
        return;
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
        const graphData = await getKnowledgeGraph(vaultPath || '');
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
          const displayLabel = rel ? (lang === 'zh' ? rel.labelZh : rel.label) : (label || '');
          const edgeColor = rel?.color || '#64748b';
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

      showToast(tf('canvas.smartAddedNotes', uniqueResults.length), 'success');
      setSmartCanvasOpen(false);
      setSmartCanvasQuery('');

      // Wait for React Flow to measure all newly added nodes before layout, avoiding hardcoded timeout (Fix 3)
      const startTime = Date.now();
      const checkMeasuredAndLayout = async () => {
        const currentNodes = reactFlowInstance.getNodes();
        const fileNodes = currentNodes.filter((n: Node) => n.type === 'file');
        const allMeasured = fileNodes.every((n: Node) => n.measured?.width && n.measured?.height);
        if (allMeasured || Date.now() - startTime > 1000) {
          onProgress?.('arranging');
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
  }, [smartCanvasQuery, nodes, setNodes, setEdges, reactFlowInstance, showToast, lang, handleAutoLayout, setSmartCanvasLoading, setSmartCanvasOpen, setSmartCanvasQuery]);

  return {
    handleDiagnoseCanvas,
    handleAutoLayout,
    handleSmartCanvasSearch,
  };
}
