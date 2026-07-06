import { useState, useCallback } from 'react';
import { VaultInsight } from '../components/common/AgentPanel';
import { useApp } from '../contexts/AppContext';

// 后端 run_vault_lint 返回的 LintReport 结构（与 src-tauri/src/lint.rs 对应）
export interface LintResult {
  orphans?: Array<{ file_path: string; title: string }>;
  broken_links?: Array<{ file_path: string; target_title: string; line_number: number; context: string; suggested_fix?: string }>;
  missing_metadata?: Array<{ file_path: string; title: string }>;
  graph_health?: {
    connected_components: number;
    largest_component_size: number;
    total_nodes: number;
    total_edges: number;
    hub_overload: Array<{ file_path: string; title: string; degree: number }>;
    unidirectional_relations: Array<any>;
    missing_embeddings: number;
  };
  semantic_duplicates?: Array<{ file_path_a: string; title_a: string; file_path_b: string; title_b: string; similarity: number }>;
  hidden_connections?: Array<{ file_path_a: string; title_a: string; file_path_b: string; title_b: string; similarity: number }>;
}

/**
 * Hook 用于管理知识库洞察（Vault Insights）
 * 提供与 Chat 联动的能力：点击洞察 action 时自动打开 Chat 并预填 prompt
 */
export function useVaultInsights(vaultPath: string | undefined) {
  const { state, toggleChat } = useApp();
  const [insights, setInsights] = useState<VaultInsight[]>([]);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  // 处理洞察 action：打开 Chat 并预填 prompt
  const handleInsightAction = useCallback((insightId: string, actionData?: any) => {
    const insight = insights.find(i => i.id === insightId);
    if (!insight) return;

    // 构建 Chat prompt
    const prompt = buildInsightPrompt(insight, actionData);

    // 确保 Chat 面板已打开（如果未打开则先打开）
    if (!state.isChatOpen) {
      toggleChat();
    }

    // 触发 zettel:agent-task 事件（SmartChat 会监听）
    // 使用 requestAnimationFrame 确保 Chat 面板渲染后再发送事件
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('zettel:agent-task', {
        detail: {
          prompt,
          mode: 'agent',
        },
      }));
    });

    // 标记为已处理
    setDismissedIds(prev => new Set([...prev, insightId]));
  }, [insights, state.isChatOpen, toggleChat]);

  // 忽略某个洞察
  const dismissInsight = useCallback((insightId: string) => {
    setDismissedIds(prev => new Set([...prev, insightId]));
  }, []);

  // 清除所有忽略记录（重新显示所有洞察）
  const resetDismissed = useCallback(() => {
    setDismissedIds(new Set());
  }, []);

  // 从 LintResult 更新洞察
  const updateFromLintResult = useCallback((result: LintResult) => {
    const isZh = state.lang === 'zh';
    const newInsights: VaultInsight[] = [];

    // 计算碎片化程度（从 connected_components 和 largest_component_size 推导）
    const fragmentation = result.graph_health
      ? Math.round((1 - (result.graph_health.largest_component_size / Math.max(result.graph_health.total_nodes, 1))) * 100)
      : 0;

    // Critical: hub overload
    if (result.graph_health?.hub_overload && result.graph_health.hub_overload.length > 0) {
      const id = 'hub-overload';
      if (!dismissedIds.has(id)) {
        const n = result.graph_health.hub_overload.length;
        newInsights.push({
          id,
          severity: 'critical',
          category: 'hub_overload',
          title: isZh ? `${n} 个枢纽笔记连接过多` : `${n} hub notes overloaded`,
          description: isZh ? '这些笔记有超过 20 条连接，可能需要拆分主题。' : 'These notes have 20+ connections — consider splitting topics.',
          affectedNotes: result.graph_health.hub_overload.slice(0, 5).map(h => h.file_path),
          actionLabel: isZh ? '分析并建议' : 'Analyze',
          actionData: { type: 'hub_overload', hubs: result.graph_health.hub_overload },
        });
      }
    }

    // Warning: orphan notes
    if (result.orphans && result.orphans.length > 0) {
      const id = 'orphans';
      if (!dismissedIds.has(id)) {
        const n = result.orphans.length;
        newInsights.push({
          id,
          severity: 'warning',
          category: 'orphan',
          title: isZh ? `${n} 篇笔记没有连接` : `${n} notes have no connections`,
          description: isZh ? '这些笔记和其他笔记没有链接关系。' : 'These notes are not linked to any other notes.',
          affectedNotes: result.orphans.slice(0, 5).map(o => o.file_path),
          actionLabel: isZh ? '查找连接' : 'Find links',
          actionData: { type: 'orphans', notes: result.orphans.map(o => o.file_path) },
        });
      }
    }

    // Warning: semantic duplicates
    if (result.semantic_duplicates && result.semantic_duplicates.length > 0) {
      const id = 'duplicates';
      if (!dismissedIds.has(id)) {
        const allNotes = new Set<string>();
        result.semantic_duplicates.forEach(d => {
          allNotes.add(d.file_path_a);
          allNotes.add(d.file_path_b);
        });
        const n = result.semantic_duplicates.length;
        newInsights.push({
          id,
          severity: 'warning',
          category: 'semantic_duplicate',
          title: isZh ? `${n} 对笔记内容重复` : `${n} pairs of duplicate notes`,
          description: isZh ? '相似度 ≥92%，可以考虑合并。' : 'Similarity ≥92% — consider merging.',
          affectedNotes: Array.from(allNotes).slice(0, 5),
          actionLabel: isZh ? '审查重复' : 'Review duplicates',
          actionData: {
            type: 'duplicates',
            pairs: result.semantic_duplicates.map(d => [d.file_path_a, d.file_path_b]),
          },
        });
      }
    }

    // Info: hidden connections
    if (result.hidden_connections && result.hidden_connections.length > 0) {
      const id = 'hidden-connections';
      if (!dismissedIds.has(id)) {
        const allNotes = new Set<string>();
        result.hidden_connections.forEach(h => {
          allNotes.add(h.file_path_a);
          allNotes.add(h.file_path_b);
        });
        const n = result.hidden_connections.length;
        newInsights.push({
          id,
          severity: 'info',
          category: 'missing_link',
          title: isZh ? `${n} 对笔记可以建立链接` : `${n} pairs could be linked`,
          description: isZh ? '这些笔记内容相关但目前没有连接。' : 'These notes are related but not yet connected.',
          affectedNotes: Array.from(allNotes).slice(0, 5),
          actionLabel: isZh ? '添加链接' : 'Add links',
          actionData: {
            type: 'hidden_connections',
            pairs: result.hidden_connections.map(h => [h.file_path_a, h.file_path_b]),
          },
        });
      }
    }

    // Info/Warning: fragmentation
    if (result.graph_health && fragmentation > 20) {
      const id = 'fragmentation';
      if (!dismissedIds.has(id)) {
        const cc = result.graph_health.connected_components;
        newInsights.push({
          id,
          severity: fragmentation > 50 ? 'warning' : 'info',
          category: 'fragmentation',
          title: isZh ? `图谱有 ${cc} 个独立群组` : `Graph has ${cc} isolated groups`,
          description: isZh ? `${fragmentation}% 的笔记没有互相连接。` : `${fragmentation}% of notes are not interconnected.`,
          actionLabel: isZh ? '分析结构' : 'Analyze structure',
          actionData: {
            type: 'fragmentation',
            components: cc,
            fragmentation,
          },
        });
      }
    }

    // Warning: broken links
    if (result.broken_links && result.broken_links.length > 0) {
      const id = 'broken-links';
      if (!dismissedIds.has(id)) {
        const n = result.broken_links.length;
        newInsights.push({
          id,
          severity: 'warning',
          category: 'missing_link',
          title: isZh ? `${n} 个链接指向不存在的笔记` : `${n} links point to missing notes`,
          description: isZh ? '目标笔记可能已被移动或删除。' : 'Target notes may have been moved or deleted.',
          affectedNotes: result.broken_links.slice(0, 5).map(b => b.file_path),
          actionLabel: isZh ? '修复链接' : 'Fix links',
          actionData: { type: 'broken_links', links: result.broken_links },
        });
      }
    }

    // Info: missing metadata
    if (result.missing_metadata && result.missing_metadata.length > 0) {
      const id = 'missing-metadata';
      if (!dismissedIds.has(id)) {
        const n = result.missing_metadata.length;
        newInsights.push({
          id,
          severity: 'info',
          category: 'missing_link',
          title: isZh ? `${n} 篇笔记缺少标题或标签` : `${n} notes missing title or tags`,
          description: isZh ? '补充元数据可以改善搜索和图谱展示。' : 'Adding metadata improves search and graph display.',
          affectedNotes: result.missing_metadata.slice(0, 5).map(m => m.file_path),
          actionLabel: isZh ? '补充元数据' : 'Add metadata',
          actionData: { type: 'missing_metadata', notes: result.missing_metadata.map(m => m.file_path) },
        });
      }
    }

    setInsights(newInsights);
    setLastUpdated(Date.now());
  }, [dismissedIds, state.lang]);

  // 过滤掉已忽略的洞察
  const visibleInsights = insights.filter(i => !dismissedIds.has(i.id));

  return {
    insights: visibleInsights,
    allInsights: insights,
    lastUpdated,
    dismissedIds,
    handleInsightAction,
    dismissInsight,
    resetDismissed,
    updateFromLintResult,
  };
}

// 根据洞察类型构建 Chat prompt
function buildInsightPrompt(insight: VaultInsight, actionData?: any): string {
  const isZh = navigator.language?.startsWith('zh') ?? true;

  switch (insight.category) {
    case 'orphan':
      if (isZh) {
        return `以下笔记尚未建立任何连接，请在我的知识库中查找可能与它们相关的笔记，并建议链接：\n${insight.affectedNotes?.slice(0, 5).map(n => `[[${n?.replace('.md', '')}]]`).join('\n')}`;
      }
      return `These notes have no connections. Find related notes in my vault and suggest links:\n${insight.affectedNotes?.slice(0, 5).map(n => `[[${n?.replace('.md', '')}]]`).join('\n')}`;

    case 'semantic_duplicate':
      if (isZh) {
        return `以下笔记对高度相似，请审查它们并建议是合并还是保持独立：\n${(actionData?.pairs || []).map((pair: string[]) => `[[${pair[0]?.replace('.md', '')}]] ↔ [[${pair[1]?.replace('.md', '')}]]`).join('\n')}`;
      }
      return `These note pairs are highly similar. Review and suggest merge or keep separate:\n${(actionData?.pairs || []).map((pair: string[]) => `[[${pair[0]?.replace('.md', '')}]] ↔ [[${pair[1]?.replace('.md', '')}]]`).join('\n')}`;

    case 'hub_overload':
      if (isZh) {
        return `以下枢纽节点连接了过多笔记（>20条边），请分析它们的结构并建议如何优化：\n${insight.affectedNotes?.slice(0, 5).map(n => `[[${n?.replace('.md', '')}]]`).join('\n')}`;
      }
      return `These hub nodes have too many connections (>20 edges). Analyze and suggest optimization:\n${insight.affectedNotes?.slice(0, 5).map(n => `[[${n?.replace('.md', '')}]]`).join('\n')}`;

    case 'missing_link':
      if (actionData?.type === 'hidden_connections') {
        if (isZh) {
          return `以下笔记对语义相似但未建立链接，请分析它们的关系并建议合适的链接类型：\n${(actionData?.pairs || []).map((pair: string[]) => `[[${pair[0]?.replace('.md', '')}]] ↔ [[${pair[1]?.replace('.md', '')}]]`).join('\n')}`;
        }
        return `These note pairs are semantically similar but not linked. Analyze and suggest link types:\n${(actionData?.pairs || []).map((pair: string[]) => `[[${pair[0]?.replace('.md', '')}]] ↔ [[${pair[1]?.replace('.md', '')}]]`).join('\n')}`;
      }
      if (actionData?.type === 'broken_links') {
        if (isZh) {
          return `以下笔记包含断链（指向不存在的笔记），请帮助修复：\n${(actionData?.links || []).slice(0, 5).map((l: any) => `[[${l.file_path?.replace('.md', '')}]] → ${l.target_title}`).join('\n')}`;
        }
        return `These notes have broken links. Help fix them:\n${(actionData?.links || []).slice(0, 5).map((l: any) => `[[${l.file_path?.replace('.md', '')}]] → ${l.target_title}`).join('\n')}`;
      }
      if (actionData?.type === 'missing_metadata') {
        if (isZh) {
          return `以下笔记缺少元数据（标题或 frontmatter），请帮助补充：\n${(actionData?.notes || []).slice(0, 5).map((n: string) => `[[${n?.replace('.md', '')}]]`).join('\n')}`;
        }
        return `These notes are missing metadata. Help add frontmatter:\n${(actionData?.notes || []).slice(0, 5).map((n: string) => `[[${n?.replace('.md', '')}]]`).join('\n')}`;
      }
      // Generic missing_link fallback
      if (isZh) {
        return `请分析以下知识库链接问题并提供修复建议：\n${insight.affectedNotes?.slice(0, 5).map(n => `[[${n?.replace('.md', '')}]]`).join('\n')}`;
      }
      return `Analyze these link issues and suggest fixes:\n${insight.affectedNotes?.slice(0, 5).map(n => `[[${n?.replace('.md', '')}]]`).join('\n')}`;

    case 'fragmentation':
      if (isZh) {
        return `我的知识图谱碎片化程度较高（${actionData?.fragmentation}%），分为 ${actionData?.components} 个连通分量。请分析整体结构并提出改进建议。`;
      }
      return `My knowledge graph has high fragmentation (${actionData?.fragmentation}%), with ${actionData?.connected_components} components. Analyze the structure and suggest improvements.`;

    default:
      if (isZh) {
        return `请分析以下知识库洞察并提供建议：${insight.title}`;
      }
      return `Analyze this vault insight and provide suggestions: ${insight.title}`;
  }
}
