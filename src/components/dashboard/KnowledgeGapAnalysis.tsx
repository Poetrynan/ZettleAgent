import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useApp } from '../../contexts/AppContext';
import {
  getKnowledgeGraph,
  chatWithLlm,
  agentChat,
  knowledgeGraphCreatePlan,
  knowledgeGraphGetPlan,
  knowledgeGraphStagePlan,
  knowledgeGraphCommitPlan,
  knowledgeGraphRollbackPlan,
  knowledgeGraphVerifyPlan,
  GraphData,
  AgentEvent,
  type GraphObservation,
  type GraphPlan,
  type GraphProposal,
  type PlanOutcome,
  type PlanVerification,
} from '../../lib/tauri';
import { t, tf, getLang } from '../../lib/i18n';
import type { TranslationKey } from '../../lib/i18n';
import { IconBrain, IconRobot } from '../icons';
import { MarkdownRenderer } from '../editor/MarkdownRenderer';
import { GraphEvidenceCard } from '../knowledge/RelationEvidenceDrawer';
import { KcPill } from '../knowledge/states';
import { listen } from '@tauri-apps/api/event';

/**
 * 修复流程的当前位置 / where the fix loop currently is.
 *
 * 一部分是前端的过程步骤（读图谱、分析、生成计划），一部分直接来自后端返回的 `state`。
 * 区别很重要：`preview_ready` / `conflict` / `rejected` 都意味着**还没有任何东西写进
 * 图谱**，而 `partial_success` 意味着写了一部分——这三类绝不能长得一样。
 */
type FixPhase =
  | 'idle'
  | 'retrieving'
  | 'analyzing'
  | 'planning'
  | 'awaiting_approval'
  | 'preview_ready'
  | 'applying'
  | 'verifying'
  | 'completed'
  | 'partial_success'
  | 'conflict'
  | 'rejected'
  | 'failed'
  | 'rolled_back';

/** 默认勾选的置信度门槛。低于它的提议一律要用户自己勾。 */
const AUTO_SELECT_CONFIDENCE = 0.8;

/** 观察分组的显示顺序，未知种类排在最后。 */
const OBSERVATION_KIND_ORDER = ['orphan', 'hub_overload', 'duplicate', 'missing_link'];


interface GapInsight {
  type: 'orphan' | 'island' | 'hub_risk' | 'suggestion';
  title: string;
  description: string;
  notes?: string[];
  notePaths?: string[]; // Maps note names to actual node file paths
}

interface LogItem {
  type: 'thinking' | 'tool_start' | 'tool_result' | 'done';
  text: string;
}

const LOG_META: Record<LogItem['type'], { icon: string; cls: string }> = {
  thinking:   { icon: 'M11 11m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0M12 2a10 10 0 1 0 0 20a10 10 0 0 0 0-20z', cls: 'log-thinking' },
  tool_start: { icon: 'M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83', cls: 'log-tool' },
  tool_result: { icon: 'M20 6L9 17l-5-5', cls: 'log-result' },
  done:       { icon: 'M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4 12 14.01 9 11.01', cls: 'log-done' },
};

/**
 * KnowledgeGapAnalysis — Dashboard card that analyzes knowledge graph
 * for blind spots, isolated clusters, and over-relied hubs.
 *
 * V3: Overhauled UI/UX with computed health scoreboard, tabbed diagnostics,
 * interactive note tags with workspace editor navigation, and terminal log styles.
 */
export interface KnowledgeGapAnalysisProps {
  initialPlanId?: string | null;
}

export function KnowledgeGapAnalysis({ initialPlanId }: KnowledgeGapAnalysisProps = {}) {
  const { state, showToast, setCurrentFile, setView } = useApp();
  const [insights, setInsights] = useState<GapInsight[]>([]);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [aiSummary, setAiSummary] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [hasAnalyzed, setHasAnalyzed] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);
  const [progress, setProgress] = useState({ step: 0, total: 4, label: '' });

  // Navigation tabs
  const [activeTab, setActiveTab] = useState<'overview' | 'diagnostics' | 'report' | 'fix'>('overview');

  // Agent diagnosis states
  const [analysisMode, setAnalysisMode] = useState<'quick' | 'agent' | null>(null);
  const [agentLog, setAgentLog] = useState<LogItem[]>([]);
  const [streamedResponse, setStreamedResponse] = useState('');
  const [showLogs, setShowLogs] = useState(true);

  // ── 修复：目标 → 诊断/计划 → 预览 → 部分批准 → 提交 → 验证 → 结果 ──
  const [fixPhase, setFixPhase] = useState<FixPhase>('idle');
  const [plan, setPlan] = useState<GraphPlan | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [stageOutcome, setStageOutcome] = useState<PlanOutcome | null>(null);
  const [commitOutcome, setCommitOutcome] = useState<PlanOutcome | null>(null);
  const [verification, setVerification] = useState<PlanVerification | null>(null);
  const [rollbackOutcome, setRollbackOutcome] = useState<PlanOutcome | null>(null);
  const [fixError, setFixError] = useState<string | null>(null);
  /** Agent 修复报告只作为「执行详情」里的旁证，不再是主界面。 */
  const [fixResult, setFixResult] = useState<string>('');

  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showLogs && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [agentLog, showLogs]);

  // 1. 响应 prop 传入的 initialPlanId（从 KnowledgeCenter 或其他父级传入）
  useEffect(() => {
    if (initialPlanId) {
      setActiveTab('fix');
      knowledgeGraphGetPlan(initialPlanId)
        .then((existingPlan) => {
          if (existingPlan) {
            setPlan(existingPlan);
            // 默认只勾选高置信度 (>= 0.8) 的提议
            const highConf = existingPlan.proposals
              .filter((p) => p.confidence >= 0.8)
              .map((p) => p.id);
            setSelectedIds(highConf.length > 0 ? highConf : existingPlan.proposals.map((p) => p.id));
            setFixPhase('preview_ready');
          }
        })
        .catch((err) => setFixError(String(err)));
    }
  }, [initialPlanId]);

  // 2. 监听从 Chat 或全局派发的直达图谱修复计划事件
  useEffect(() => {
    const handleOpenPlan = (e: Event) => {
      const detail = (e as CustomEvent<{ tab?: string; planId?: string }>).detail;
      if (detail?.planId) {
        setActiveTab('fix');
        knowledgeGraphGetPlan(detail.planId)
          .then((existingPlan) => {
            if (existingPlan) {
              setPlan(existingPlan);
              // 默认只勾选高置信度 (>= 0.8) 的提议
              const highConf = existingPlan.proposals
                .filter((p) => p.confidence >= 0.8)
                .map((p) => p.id);
              setSelectedIds(highConf.length > 0 ? highConf : existingPlan.proposals.map((p) => p.id));
              setFixPhase('preview_ready');
            }
          })
          .catch((err) => setFixError(String(err)));
      }
    };
    window.addEventListener('open-knowledge-center', handleOpenPlan);
    window.addEventListener('open-knowledge-gap-analysis', handleOpenPlan);
    return () => {
      window.removeEventListener('open-knowledge-center', handleOpenPlan);
      window.removeEventListener('open-knowledge-gap-analysis', handleOpenPlan);
    };
  }, []);

  // Click-to-navigate action
  const openNote = useCallback((filePath: string) => {
    if (!filePath) return;
    setCurrentFile(filePath);
    setView('note');
    showToast(state.lang === 'zh' ? '已在编辑器中打开笔记' : 'Opened note in editor', 'success');
  }, [setCurrentFile, setView, showToast, state.lang]);

  const analyze = useCallback(async (mode: 'quick' | 'agent') => {
    setIsAnalyzing(true);
    setAnalysisMode(mode);
    setInsights([]);
    setGraphData(null);
    setAiSummary('');
    setStreamedResponse('');
    setAgentLog([]);
    setShowLogs(true);
    setActiveTab('overview');

    const totalSteps = mode === 'quick' ? 4 : 2;
    setProgress({ step: 1, total: totalSteps, label: t('gap.stepGraph') });
    
    let graph: GraphData;
    try {
      graph = await getKnowledgeGraph(state.vaultPath || '');
      setGraphData(graph);
    } catch (e) {
      console.error('Failed to load knowledge graph:', e);
      showToast(t('gap.title') + ' - ' + (state.lang === 'zh' ? '获取图谱失败' : 'Failed to fetch graph'), 'error');
      setIsAnalyzing(false);
      return;
    }

    if (mode === 'quick') {
      const tick = () => new Promise<void>(r => setTimeout(r, 250));
      try {
        const localInsights: GapInsight[] = [];

        setProgress({ step: 2, total: 4, label: t('gap.stepOrphan') });
        await tick();
        const orphans = graph.nodes.filter(n => n.is_orphan);
        if (orphans.length > 0) {
          localInsights.push({
            type: 'orphan',
            title: t('gap.orphanTitle').replace('{n}', String(orphans.length)),
            description: t('gap.orphanDesc'),
            notes: orphans.slice(0, 8).map(n => n.label),
            notePaths: orphans.slice(0, 8).map(n => n.id),
          });
        }

        setProgress({ step: 3, total: 4, label: t('gap.stepIsland') });
        await tick();
        const smallClusters = graph.clusters.filter(c => c.node_count <= 2 && c.node_count > 0);
        if (smallClusters.length > 0) {
          const isolatedNodes = graph.nodes.filter(n =>
            smallClusters.some(c => c.id === n.cluster)
          );
          if (isolatedNodes.length > 0) {
            localInsights.push({
              type: 'island',
              title: t('gap.islandTitle').replace('{n}', String(smallClusters.length)),
              description: t('gap.islandDesc'),
              notes: isolatedNodes.slice(0, 8).map(n => n.label),
              notePaths: isolatedNodes.slice(0, 8).map(n => n.id),
            });
          }
        }

        const hubs = graph.nodes.filter(n => n.is_hub);
        if (hubs.length > 0) {
          localInsights.push({
            type: 'hub_risk',
            title: t('gap.hubTitle').replace('{n}', String(hubs.length)),
            description: t('gap.hubDesc'),
            notes: hubs.slice(0, 5).map(n => n.label),
            notePaths: hubs.slice(0, 5).map(n => n.id),
          });
        }

        setInsights(localInsights);

        setProgress({ step: 4, total: 4, label: t('gap.stepAi') });
        if (graph.nodes.length > 0 && state.llmConfig.apiUrl) {
          const topicList = graph.nodes.slice(0, 40).map(n => n.label).join(', ');
          const clusterLabels = graph.clusters.map(c => c.label).filter(Boolean).join(', ');
          const orphanList = orphans.slice(0, 10).map(n => n.label).join(', ');

          const langInstruction = getLang() === 'zh'
            ? '请用中文回答。'
            : 'Answer in English.';

          const prompt = `You are a knowledge management advisor analyzing a Zettelkasten vault.

The vault has ${graph.nodes.length} notes and ${graph.edges.length} connections.

Topics covered: ${topicList}
Knowledge clusters: ${clusterLabels || 'none detected'}
Orphan notes (unlinked): ${orphanList || 'none'}
Hub notes (highly connected): ${hubs.map(n => n.label).join(', ') || 'none'}

Based on the topics covered, identify:
1. **Knowledge gaps**: What related topics are MISSING from this vault that would strengthen the existing knowledge? (2-3 specific suggestions)
2. **Bridge opportunities**: Which isolated topics could be connected to form stronger understanding? (1-2 specific connections)
3. **One actionable recommendation** for the next note to write.

Be specific and concise. Use bullet points. Max 200 words. ${langInstruction}`;

          try {
            const result = await chatWithLlm({
              messages: [{ role: 'user', content: prompt }],
              apiUrl: state.llmConfig.apiUrl,
              model: state.llmConfig.model,
              apiKey: state.llmConfig.apiKey || undefined,
              providerId: state.llmConfig.providerId,
            });
            setAiSummary(result.content);
          } catch (e) {
            console.error('AI analysis failed:', e);
          }
        }

        setHasAnalyzed(true);
      } catch (e) {
        console.error('Gap analysis failed:', e);
      } finally {
        setIsAnalyzing(false);
      }
    } else if (mode === 'agent') {
      setProgress({ step: 2, total: 2, label: t('gap.stepAi') });
      
      // Calculate local insights for diagnostics tab availability during agent runs
      const localInsights: GapInsight[] = [];
      const orphans = graph.nodes.filter(n => n.is_orphan);
      if (orphans.length > 0) {
        localInsights.push({
          type: 'orphan',
          title: t('gap.orphanTitle').replace('{n}', String(orphans.length)),
          description: t('gap.orphanDesc'),
          notes: orphans.slice(0, 8).map(n => n.label),
          notePaths: orphans.slice(0, 8).map(n => n.id),
        });
      }
      const smallClusters = graph.clusters.filter(c => c.node_count <= 2 && c.node_count > 0);
      if (smallClusters.length > 0) {
        const isolatedNodes = graph.nodes.filter(n =>
          smallClusters.some(c => c.id === n.cluster)
        );
        if (isolatedNodes.length > 0) {
          localInsights.push({
            type: 'island',
            title: t('gap.islandTitle').replace('{n}', String(smallClusters.length)),
            description: t('gap.islandDesc'),
            notes: isolatedNodes.slice(0, 8).map(n => n.label),
            notePaths: isolatedNodes.slice(0, 8).map(n => n.id),
          });
        }
      }
      const hubs = graph.nodes.filter(n => n.is_hub);
      if (hubs.length > 0) {
        localInsights.push({
          type: 'hub_risk',
          title: t('gap.hubTitle').replace('{n}', String(hubs.length)),
          description: t('gap.hubDesc'),
          notes: hubs.slice(0, 5).map(n => n.label),
          notePaths: hubs.slice(0, 5).map(n => n.id),
        });
      }
      setInsights(localInsights);

      const unlistenPromise = listen<AgentEvent>('agent-event', (event) => {
        const e = event.payload;
        switch (e.type) {
          case 'thinking': {
            const cleanMsg = (e.message || '').trim();
            if (cleanMsg) {
              setAgentLog(prev => [...prev, { type: 'thinking', text: cleanMsg }]);
            }
            break;
          }
          case 'tool_start': {
            const displayName = e.name ? (t(`chat.tool.${e.name}` as any) !== `chat.tool.${e.name}` ? t(`chat.tool.${e.name}` as any) : e.name.replace(/_/g, ' ')) : 'tool';
            const logText = t('gap.agentLogToolStart').replace('{name}', displayName).replace('{args}', e.arguments || '{}');
            setAgentLog(prev => [...prev, { type: 'tool_start', text: logText }]);
            break;
          }
          case 'tool_result': {
            const displayName = e.name ? (t(`chat.tool.${e.name}` as any) !== `chat.tool.${e.name}` ? t(`chat.tool.${e.name}` as any) : e.name.replace(/_/g, ' ')) : 'tool';
            const logText = t('gap.agentLogToolResult').replace('{name}', displayName);
            setAgentLog(prev => [...prev, { type: 'tool_result', text: logText }]);
            break;
          }
          case 'text_delta': {
            setStreamedResponse(prev => prev + (e.content || ''));
            break;
          }
          case 'done': {
            setAgentLog(prev => [...prev, { type: 'done', text: t('gap.agentLogDone') }]);
            break;
          }
          default:
            break;
        }
      });

      try {
        const langInstruction = getLang() === 'zh'
          ? '请对我的整个 Zettelkasten 笔记库进行深度诊断，分析知识盲区、结构问题、孤立笔记、失效 Wikilink 以及笔记聚类机会。\n请调用你的内置工具（如使用 `run_lint` 检查失效链接和孤立笔记，使用 `get_vault_stats` 获取笔记库整体统计信息）来生成一份详尽的健康与盲区分析报告。\n在运行完工具并得到结果后，请撰写一份结构化的 Markdown 报告，包含以下内容：\n1. **笔记库健康状态**：孤立笔记、失效链接及缺失 AI 整理标记的摘要。\n2. **知识盲区与冗余分析**：哪些主题被过度探讨，哪些有盲区/结构缺失，哪些有语义重复或冗余。\n3. **关联与 MOC（内容地图）机会**：建议可以进行横向关联或整合成 MOC 的主题。\n4. **可执行行动计划**：为用户提供 3-5 条具体、即时的写作或链接优化建议。\n\n语气要专业、有洞察力且实用。请使用中文回答。'
          : 'Please perform a deep, comprehensive diagnosis of my entire Zettelkasten vault to find knowledge gaps, structure issues, orphaned notes, broken links, and clustering opportunities.\nPlease use your tools (like `run_lint` to check for broken links and orphans, and `get_vault_stats` to see overall statistics) to compile a detailed health and gap report.\nAfter running these tools, write a structured Markdown report that covers:\n1. **Vault Health Status**: summary of orphans, broken links, and missing metadata.\n2. **Knowledge Gaps & Redundancies**: topics that are under-explored, missing, or overly duplicated/redundant.\n3. **Bridge & MOC Opportunities**: suggesting areas that can be connected or grouped into a Map of Content (MOC).\n4. **Actionable Action Plan**: 3-5 specific, immediate writing or linking tasks for the user.\n\nKeep the tone professional, helpful, and insightful. Ensure the final output is in English.';

        const result = await agentChat({
          messages: [{ role: 'user', content: langInstruction }],
          apiUrl: state.llmConfig.apiUrl,
          apiKey: state.llmConfig.apiKey || undefined,
          model: state.llmConfig.model,
          providerId: state.llmConfig.providerId,
          vaultPath: state.vaultPath || undefined,
          vaultPaths: state.vaultPaths?.length ? state.vaultPaths : undefined,
          methodology: state.methodology,
        });

        setAiSummary(result);
        setHasAnalyzed(true);
      } catch (e) {
        console.error('Agent analysis failed:', e);
      } finally {
        setIsAnalyzing(false);
        unlistenPromise.then(fn => fn());
      }
    }
  }, [state.llmConfig, state.vaultPath, state.vaultPaths, state.methodology, state.lang, showToast]);

  // ── 修复闭环：目标 → 计划 → 预览 → 部分批准 → 提交 → 验证 → 结果 ──
  //
  // 这里没有「一键修复完成」这条路。生成计划只读库；预览只做 dry-run；提交是唯一写入
  // 的一步；提交后立刻回查。每一句话都对应后端返回的一个数字或状态串。

  const resetFixRun = () => {
    setStageOutcome(null);
    setCommitOutcome(null);
    setVerification(null);
    setRollbackOutcome(null);
    setFixError(null);
  };

  /** 目标 → 诊断/计划。只读数据库，什么都不写。 */
  const handleBuildPlan = useCallback(async () => {
    if (!state.vaultPath) {
      showToast(t('gap.plan.needVault'), 'error');
      return;
    }
    setActiveTab('fix');
    resetFixRun();
    setPlan(null);
    setSelectedIds([]);
    setFixResult('');
    setFixPhase('retrieving');
    try {
      const next = await knowledgeGraphCreatePlan({
        goalType: 'diagnose',
        scope: { paths: [], cluster: null },
        anchorPaths: [],
        question: t('gap.plan.goalDiagnose'),
        constraints: [],
        maxProposals: null,
      });
      setFixPhase('analyzing');
      setPlan(next);
      // 默认只勾置信度达标的那些。其余一律不选，由用户逐条 opt-in——
      // 「全选」等于把审查责任偷偷推回给用户，同时又让他以为自己审过了。
      setSelectedIds(
        next.proposals.filter(p => p.confidence >= AUTO_SELECT_CONFIDENCE).map(p => p.id),
      );
      setFixPhase('awaiting_approval');
    } catch (e) {
      setFixError(String(e));
      setFixPhase('failed');
    }
  }, [state.vaultPath, showToast]);

  const toggleProposal = useCallback((id: string) => {
    setSelectedIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
    // 改了选择，之前那份预览就不再对应现在勾的东西了。
    setStageOutcome(null);
    setCommitOutcome(null);
    setVerification(null);
    setFixPhase('awaiting_approval');
  }, []);

  /** 预览：生成 ChangeSet，图谱写入零条。 */
  const handlePreview = useCallback(async () => {
    if (!plan || selectedIds.length === 0) return;
    setFixPhase('planning');
    setFixError(null);
    setCommitOutcome(null);
    setVerification(null);
    setRollbackOutcome(null);
    try {
      const outcome = await knowledgeGraphStagePlan(
        plan.id,
        selectedIds,
        state.vaultPath || '',
        state.vaultPaths?.length ? state.vaultPaths : undefined,
      );
      setStageOutcome(outcome);
      // refusal 非空 = 门禁拒绝，一律按「未执行」处理，且后面不给「应用」。
      if (outcome.refusal) {
        setFixPhase('rejected');
      } else if (outcome.state === 'conflict') {
        setFixPhase('conflict');
      } else if (outcome.state === 'rejected') {
        setFixPhase('rejected');
      } else {
        setFixPhase('preview_ready');
      }
    } catch (e) {
      setFixError(String(e));
      setFixPhase('failed');
    }
  }, [plan, selectedIds, state.vaultPath, state.vaultPaths]);

  /** 提交，然后立刻回查。成功与否由 `applied` 决定，不由「调用没报错」决定。 */
  const handleApply = useCallback(async () => {
    if (!plan) return;
    setFixPhase('applying');
    setFixError(null);
    try {
      const outcome = await knowledgeGraphCommitPlan(plan.id);
      setCommitOutcome(outcome);
      setFixPhase('verifying');
      try {
        setVerification(await knowledgeGraphVerifyPlan(plan.id));
      } catch (e) {
        // 回查挂了不代表提交没发生，也不代表提交成功——两件事分开记。
        setFixError(String(e));
      }
      setFixPhase(phaseOfOutcome(outcome));
      if (outcome.applied > 0) {
        try {
          const { emitRefreshEvent } = await import('../../lib/tauri');
          await emitRefreshEvent();
        } catch (err) {
          console.warn('Failed to emit graph refresh:', err);
        }
      }
    } catch (e) {
      setFixError(String(e));
      setFixPhase('failed');
    }
  }, [plan]);

  const handleRollback = useCallback(async () => {
    if (!plan) return;
    setFixError(null);
    try {
      const outcome = await knowledgeGraphRollbackPlan(plan.id);
      setRollbackOutcome(outcome);
      setFixPhase(outcome.state === 'rolled_back' ? 'rolled_back' : phaseOfOutcome(outcome));
      try {
        const { emitRefreshEvent } = await import('../../lib/tauri');
        await emitRefreshEvent();
      } catch (err) {
        console.warn('Failed to emit graph refresh:', err);
      }
    } catch (e) {
      setFixError(String(e));
      setFixPhase('failed');
    }
  }, [plan]);

  /** 观察按种类分组，顺序固定，未知种类归到最后。 */
  const groupedObservations = useMemo(() => {
    const groups = new Map<string, GraphObservation[]>();
    for (const obs of plan?.observations ?? []) {
      const list = groups.get(obs.kind);
      if (list) list.push(obs);
      else groups.set(obs.kind, [obs]);
    }
    return [...groups.entries()].sort((a, b) => kindRank(a[0]) - kindRank(b[0]));
  }, [plan]);

  const fixBusy =
    fixPhase === 'retrieving' ||
    fixPhase === 'analyzing' ||
    fixPhase === 'planning' ||
    fixPhase === 'applying' ||
    fixPhase === 'verifying';

  // 「应用」只在预览真的生成了、门禁没拒绝、且还没提交过的时候出现。
  const canApply =
    !!stageOutcome &&
    !stageOutcome.refusal &&
    stageOutcome.state === 'awaiting_approval' &&
    !commitOutcome;
  // 撤销只在真的写进去了东西之后才有意义。
  const canRollback = !!commitOutcome && commitOutcome.applied > 0 && !rollbackOutcome;


  if (!state.vaultPath) return null;

  const getInsightMeta = (type: string) => {
    switch (type) {
      case 'orphan': return { color: 'var(--warning, #F59E0B)', label: state.lang === 'zh' ? '孤立' : 'Orphan', cls: 'gap-type-orphan' };
      case 'island': return { color: 'var(--info, #8B5CF6)', label: state.lang === 'zh' ? '孤岛' : 'Island', cls: 'gap-type-island' };
      case 'hub_risk': return { color: 'var(--danger, #EF4444)', label: state.lang === 'zh' ? '枢纽' : 'Hub Risk', cls: 'gap-type-hub' };
      default: return { color: 'var(--accent-primary)', label: state.lang === 'zh' ? '建议' : 'Suggestion', cls: 'gap-type-suggestion' };
    }
  };

  // Compute stats and health score
  const totalNotes = graphData?.nodes.length || 0;
  const orphans = graphData?.nodes.filter(n => n.is_orphan) || [];
  const hubs = graphData?.nodes.filter(n => n.is_hub) || [];
  const smallClusters = graphData?.clusters.filter(c => c.node_count <= 2 && c.node_count > 0) || [];

  const orphanRatio = totalNotes > 0 ? orphans.length / totalNotes : 0;
  const islandRatio = graphData && graphData.clusters.length > 0 ? smallClusters.length / graphData.clusters.length : 0;
  const hubRatio = totalNotes > 0 ? hubs.length / totalNotes : 0;

  const healthScore = totalNotes > 0
    ? Math.max(0, Math.min(100, Math.round(100 - (orphanRatio * 45) - (islandRatio * 35) - (hubRatio * 20))))
    : 100;

  const strokeDashoffset = 251.2 - (healthScore / 100) * 251.2; // Circumference of radius 40 circle

  const getScoreColor = (score: number) => {
    if (score >= 85) return 'var(--success, #10B981)';
    if (score >= 70) return 'var(--accent-secondary, #3B82F6)';
    if (score >= 50) return 'var(--warning, #F59E0B)';
    return 'var(--danger, #EF4444)';
  };

  const getScoreLabel = (score: number) => {
    if (score >= 85) return state.lang === 'zh' ? '健康状况极佳' : 'Excellent Health';
    if (score >= 70) return state.lang === 'zh' ? '结构良好' : 'Good Structure';
    if (score >= 50) return state.lang === 'zh' ? '有待优化' : 'Needs Optimization';
    return state.lang === 'zh' ? '存在严重盲区' : 'Critical Issues';
  };

  // Extract a brief bullet point overview for the dashboard summary
  const getQuickRecommendation = (text: string) => {
    if (!text) return '';
    const lines = text.split('\n');
    const bullets = lines.filter(l => l.trim().startsWith('- ') || l.trim().startsWith('* ') || /^\d+\.\s/.test(l.trim()));
    if (bullets.length > 0) {
      return bullets.slice(0, 2).join('\n');
    }
    const paragraphs = lines.map(l => l.trim()).filter(Boolean);
    return paragraphs.slice(0, 1).join('\n\n');
  };

  return (
    <div className="gap-analysis-card card">
      <button
        className="gap-analysis-header"
        onClick={() => setIsExpanded(!isExpanded)}
        aria-label="Toggle knowledge gap analysis"
      >
        <div className="gap-analysis-header-left">
          <IconTarget size={18} />
          <h3>{t('gap.title')}</h3>
          {hasAnalyzed && (
            <span className="gap-header-score" style={{ backgroundColor: getScoreColor(healthScore) + '22', color: getScoreColor(healthScore) }}>
              {healthScore}
            </span>
          )}
        </div>
        <span className={`gap-analysis-chevron ${isExpanded ? 'open' : ''}`}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </span>
      </button>

      {isExpanded && (
        <div className="gap-analysis-content">
          {/* ── Initial CTA ── */}
          {!hasAnalyzed && !isAnalyzing && (
            <div className="gap-analysis-cta">
              <div className="gap-cta-icon">
                <IconTarget size={28} />
              </div>
              <p>{t('gap.cta')}</p>
              <div className="gap-cta-buttons">
                <button
                  className="gap-btn gap-btn-secondary"
                  onClick={() => analyze('quick')}
                  disabled={isAnalyzing}
                >
                  <IconTarget size={15} />
                  <span>{t('gap.runQuick')}</span>
                </button>
                <button
                  className="gap-btn gap-btn-primary"
                  onClick={() => analyze('agent')}
                  disabled={isAnalyzing}
                >
                  <IconRobot size={15} />
                  <span>{t('gap.runAgent')}</span>
                </button>
              </div>
            </div>
          )}

          {/* ── Loading State ── */}
          {isAnalyzing && (
            <div className="gap-analysis-loading" role="status" aria-live="polite" aria-label={progress.label || t('gap.analyzing')}>
              <div className="gap-loading-header">
                <span className="gap-loading-spinner" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                </span>
                <span>{progress.label || t('gap.analyzing')}</span>
              </div>

              {analysisMode === 'quick' ? (
                <div className="gap-progress-track">
                  <div className="gap-progress-bar">
                    <div
                      className="gap-progress-fill"
                      style={{ width: `${(progress.step / progress.total) * 100}%` }}
                    />
                  </div>
                  <span className="gap-progress-count">
                    {progress.step}/{progress.total}
                  </span>
                </div>
              ) : (
                <div className="gap-agent-loading-section">
                  {/* Streaming Terminal logs during agent run */}
                  <div className="gap-terminal-wrapper">
                    <div className="gap-terminal-header">
                      <div className="terminal-dots">
                        <span className="dot dot-red" />
                        <span className="dot dot-yellow" />
                        <span className="dot dot-green" />
                      </div>
                      <span className="terminal-title">
                        {state.lang === 'zh' ? 'AI Agent 诊断终端' : 'AI Agent Diagnostic Terminal'}
                      </span>
                    </div>
                    <div className="gap-terminal-body" style={{ maxHeight: '140px' }}>
                      {agentLog.map((log, i) => {
                        const meta = LOG_META[log.type];
                        return (
                          <div key={i} className={`gap-terminal-line ${meta.cls}`}>
                            <span className="terminal-prompt">$</span>
                            <span className="terminal-text">{log.text}</span>
                          </div>
                        );
                      })}
                      <div className="gap-terminal-line log-thinking">
                        <span className="terminal-prompt">$</span>
                        <span className="terminal-text terminal-cursor">
                          {state.lang === 'zh' ? '正在执行深度诊断，调用内置工具...' : 'Executing deep diagnosis, calling workspace tools...'}
                        </span>
                      </div>
                      <div ref={logEndRef} />
                    </div>
                  </div>

                  {streamedResponse && (
                    <div className="gap-analysis-ai gap-ai-streaming">
                      <div className="gap-analysis-ai-header">
                        <IconBrain size={14} />
                        <span>{t('gap.aiTitle')} ({state.lang === 'zh' ? '流式诊断报告中...' : 'Streaming Report...'})</span>
                        <span className="gap-streaming-dot" />
                      </div>
                      <div className="gap-analysis-ai-content" style={{ maxHeight: '180px', overflowY: 'auto' }}>
                        <MarkdownRenderer content={streamedResponse} className="gap-ai-markdown" />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Results Dashboard ── */}
          {hasAnalyzed && !isAnalyzing && (
            <div className="gap-results-container">
              {/* Tab Selector */}
              <div className="gap-tabs" role="tablist">
                <button
                  className={`gap-tab ${activeTab === 'overview' ? 'active' : ''}`}
                  onClick={() => setActiveTab('overview')}
                  role="tab"
                  aria-selected={activeTab === 'overview'}
                >
                  <IconChart size={14} />
                  <span>{state.lang === 'zh' ? '健康总览' : 'Overview'}</span>
                </button>
                <button
                  className={`gap-tab ${activeTab === 'diagnostics' ? 'active' : ''}`}
                  onClick={() => setActiveTab('diagnostics')}
                  role="tab"
                  aria-selected={activeTab === 'diagnostics'}
                >
                  <IconActivity size={14} />
                  <span>{state.lang === 'zh' ? '结构诊断' : 'Diagnostics'}</span>
                  {insights.length > 0 && (
                    <span className="gap-tab-badge">{insights.length}</span>
                  )}
                </button>
                <button
                  className={`gap-tab ${activeTab === 'report' ? 'active' : ''}`}
                  onClick={() => setActiveTab('report')}
                  role="tab"
                  aria-selected={activeTab === 'report'}
                >
                  <IconBrain size={14} />
                  <span>{state.lang === 'zh' ? '深度分析' : 'AI Report'}</span>
                </button>
                <button
                  className={`gap-tab ${activeTab === 'fix' ? 'active' : ''}`}
                  onClick={() => setActiveTab('fix')}
                  role="tab"
                  aria-selected={activeTab === 'fix'}
                >
                  <IconTools size={14} />
                  <span>{t('gap.plan.sectionFix')}</span>
                </button>
              </div>

              {/* ── Tab Contents ── */}
              <div className="gap-tab-content-wrapper">
                
                {/* 1. OVERVIEW TAB */}
                {activeTab === 'overview' && (
                  <div className="gap-overview-tab animated-fade-in">
                    <div className="gap-score-section">
                      <div className="gap-score-gauge-container">
                        <svg width="100" height="100" viewBox="0 0 100 100" className="gap-health-gauge">
                          <circle
                            cx="50"
                            cy="50"
                            r="40"
                            fill="transparent"
                            stroke="var(--border-subtle, #e2e8f0)"
                            strokeWidth="7"
                          />
                          <circle
                            cx="50"
                            cy="50"
                            r="40"
                            fill="transparent"
                            stroke={getScoreColor(healthScore)}
                            strokeWidth="7.5"
                            strokeDasharray="251.2"
                            strokeDashoffset={strokeDashoffset}
                            strokeLinecap="butt"
                            transform="rotate(-90 50 50)"
                            style={{ transition: 'stroke-dashoffset 0.8s ease-out, stroke 0.5s ease' }}
                          />
                          <text
                            x="50"
                            y="46"
                            textAnchor="middle"
                            dominantBaseline="middle"
                            className="gap-health-gauge-value"
                            style={{ fill: 'var(--text-primary)', fontSize: '22px', fontWeight: '800', fontFamily: 'inherit' }}
                          >
                            {healthScore}
                          </text>
                          <text
                            x="50"
                            y="66"
                            textAnchor="middle"
                            dominantBaseline="middle"
                            className="gap-health-gauge-label"
                            style={{ fill: 'var(--text-tertiary)', fontSize: '8px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.05em' }}
                          >
                            {state.lang === 'zh' ? '健康度' : 'HEALTH'}
                          </text>
                        </svg>
                        <div className="gap-score-text">
                          <span className="gap-score-status" style={{ color: getScoreColor(healthScore) }}>
                            {getScoreLabel(healthScore)}
                          </span>
                          <p className="gap-score-desc">
                            {state.lang === 'zh'
                              ? `基于笔记库中 ${totalNotes} 篇笔记的关系网络及孤立率进行图谱诊断。`
                              : `Diagnostic review computed over your vault of ${totalNotes} notes.`
                            }
                          </p>
                        </div>
                      </div>

                      {/* Score Metrics Grid */}
                      <div className="gap-metrics-grid">
                        <div className="gap-metric-tile">
                          <span className="gap-metric-icon" style={{ color: 'var(--text-secondary)' }}><IconBook size={15} /></span>
                          <div className="gap-metric-data">
                            <span className="gap-metric-num">{totalNotes}</span>
                            <span className="gap-metric-name">{state.lang === 'zh' ? '总笔记数' : 'Total Notes'}</span>
                          </div>
                        </div>
                        <div className="gap-metric-tile clickable-tile" onClick={() => setActiveTab('diagnostics')}>
                          <span className="gap-metric-icon" style={{ color: 'var(--warning, #F59E0B)' }}><IconOrphan size={15} /></span>
                          <div className="gap-metric-data">
                            <span className="gap-metric-num">{orphans.length}</span>
                            <span className="gap-metric-name">{state.lang === 'zh' ? '孤立卡片' : 'Orphans'}</span>
                          </div>
                        </div>
                        <div className="gap-metric-tile clickable-tile" onClick={() => setActiveTab('diagnostics')}>
                          <span className="gap-metric-icon" style={{ color: 'var(--info, #8B5CF6)' }}><IconIsland size={15} /></span>
                          <div className="gap-metric-data">
                            <span className="gap-metric-num">{smallClusters.length}</span>
                            <span className="gap-metric-name">{state.lang === 'zh' ? '结构孤岛' : 'Islands'}</span>
                          </div>
                        </div>
                        <div className="gap-metric-tile clickable-tile" onClick={() => setActiveTab('diagnostics')}>
                          <span className="gap-metric-icon" style={{ color: 'var(--danger, #EF4444)' }}><IconHub size={15} /></span>
                          <div className="gap-metric-data">
                            <span className="gap-metric-num">{hubs.length}</span>
                            <span className="gap-metric-name">{state.lang === 'zh' ? '枢纽过载' : 'Hub Risks'}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Quick Recommendation Summary from AI */}
                    {(aiSummary || streamedResponse) && (
                      <div className="gap-quick-rec-card">
                        <div className="gap-quick-rec-header">
                          <span style={{ color: 'var(--accent-primary)', display: 'inline-flex' }}>
                            <IconBrain size={14} />
                          </span>
                          <h4>{state.lang === 'zh' ? 'AI 写作引导策略' : 'AI Action Strategy'}</h4>
                        </div>
                        <div className="gap-quick-rec-body">
                          <MarkdownRenderer
                            content={getQuickRecommendation(aiSummary || streamedResponse)}
                            className="gap-ai-markdown gap-quick-rec-markdown"
                          />
                          <button className="gap-view-report-link-btn" onClick={() => setActiveTab('report')}>
                            <span>{state.lang === 'zh' ? '查看完整诊断报告' : 'Read Full Report'}</span>
                            <IconArrowRight size={12} />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* 2. DIAGNOSTICS TAB */}
                {activeTab === 'diagnostics' && (
                  <div className="gap-diagnostics-tab animated-fade-in">
                    {insights.length === 0 ? (
                      <div className="gap-analysis-perfect">
                        <IconCheckCircle size={20} />
                        <span>{t('gap.perfect')}</span>
                      </div>
                    ) : (
                      <div className="gap-analysis-insights">
                        {insights.map((insight, i) => {
                          const meta = getInsightMeta(insight.type);
                          return (
                            <div key={i} className={`gap-insight-item ${meta.cls}`}>
                              <div className="gap-insight-header">
                                <span className="gap-insight-icon" style={{ color: meta.color }}>
                                  {insight.type === 'orphan' && <IconOrphan size={16} />}
                                  {insight.type === 'island' && <IconIsland size={16} />}
                                  {insight.type === 'hub_risk' && <IconHub size={16} />}
                                  {insight.type === 'suggestion' && <IconBrain size={16} />}
                                </span>
                                <strong className="gap-insight-title">{insight.title}</strong>
                                <span className="gap-insight-badge" style={{ background: meta.color + '15', color: meta.color, borderColor: meta.color + '30' }}>
                                  {meta.label}
                                </span>
                              </div>
                              <p className="gap-insight-desc">{insight.description}</p>
                              
                              {insight.notes && insight.notes.length > 0 && (
                                <div className="gap-insight-notes-container">
                                  <span className="gap-insight-notes-label">
                                    {state.lang === 'zh' ? '涉及卡片 (点击可直接在编辑器打开):' : 'Affected Notes (Click to open in editor):'}
                                  </span>
                                  <div className="gap-insight-notes">
                                    {insight.notes.map((n, j) => {
                                      const path = insight.notePaths?.[j];
                                      return (
                                        <button
                                          key={j}
                                          className="gap-insight-note-tag interactive-tag"
                                          onClick={() => path && openNote(path)}
                                          title={path || n}
                                        >
                                          <IconLink size={10} className="tag-link-icon" />
                                          <span>{n}</span>
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* 3. REPORT TAB */}
                {activeTab === 'report' && (
                  <div className="gap-report-tab animated-fade-in">
                    {!(aiSummary || streamedResponse) ? (
                      <div className="gap-empty-state">
                        <span style={{ color: 'var(--text-tertiary)', opacity: 0.5, display: 'inline-flex' }}>
                          <IconBrain size={24} />
                        </span>
                        <span>{state.lang === 'zh' ? '无报告数据。请运行深度诊断。' : 'No report data. Please run deep diagnosis.'}</span>
                      </div>
                    ) : (
                      <div className="gap-analysis-ai">
                        <div className="gap-analysis-ai-header">
                          {analysisMode === 'agent' ? <IconRobot size={14} /> : <IconBrain size={14} />}
                          <span>
                            {analysisMode === 'agent'
                              ? (state.lang === 'zh' ? 'AI Agent 深度诊断报告' : 'AI Agent Deep Diagnostic Report')
                              : t('gap.aiTitle')}
                          </span>
                        </div>
                        <div className="gap-analysis-ai-content">
                          <MarkdownRenderer content={aiSummary || streamedResponse} className="gap-ai-markdown" />
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* 4. FIX TAB — 目标 / 发现 / 计划 / 结果，全部用后端的数字说话 */}
                {activeTab === 'fix' && (
                  <div className="gap-fix-tab animated-fade-in">
                    <div className="gap-fix-controls">
                      <div className="gap-fix-info">
                        <h4>{t('gap.plan.sectionFix')} · {t('gap.plan.goalTitle')}</h4>
                        <p>{t('gap.plan.goalDiagnose')}</p>
                        <p className="gap-plan-note">{t('gap.plan.goalNote')}</p>
                      </div>
                      <button
                        className="gap-fix-btn gap-btn-primary"
                        disabled={fixBusy}
                        onClick={handleBuildPlan}
                      >
                        <svg className={fixBusy ? 'spin-icon' : ''} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
                        </svg>
                        <span>{plan ? t('gap.plan.regenerate') : t('gap.plan.start')}</span>
                      </button>
                    </div>

                    {fixPhase !== 'idle' && (
                      <div className="gap-plan-status" role="status" aria-live="polite">
                        <KcPill
                          tone={phaseTone(fixPhase)}
                          label={t(`gap.plan.status.${fixPhase}` as TranslationKey)}
                        />
                      </div>
                    )}

                    {fixError && (
                      <div className="gap-plan-warn" role="alert">{tf('gap.plan.error', fixError)}</div>
                    )}

                    {plan && (
                      <div className="gap-plan-block">
                        <h5 className="gap-plan-heading">{t('gap.plan.observations')}</h5>
                        {groupedObservations.length === 0 ? (
                          <p className="gap-plan-note">{t('gap.plan.noObservations')}</p>
                        ) : (
                          groupedObservations.map(([kind, list]) => (
                            <div className="gap-plan-group" key={kind}>
                              <div className="gap-plan-group-title">{observationKindLabel(kind)}</div>
                              {list.map(obs => (
                                <div className="gap-plan-observation" key={obs.id}>
                                  <strong className="gap-plan-observation-title">{obs.title}</strong>
                                  <p className="gap-plan-observation-summary">{obs.summary}</p>
                                  {obs.warnings.map((w, i) => (
                                    <div className="gap-plan-warn" key={i}>{w}</div>
                                  ))}
                                  {obs.evidence.length > 0 && (
                                    <>
                                      <div className="gap-plan-label">{t('gap.plan.evidence')}</div>
                                      {obs.evidence.map((ev, i) => (
                                        <GraphEvidenceCard key={`${obs.id}-${i}`} ev={ev} />
                                      ))}
                                    </>
                                  )}
                                </div>
                              ))}
                            </div>
                          ))
                        )}
                      </div>
                    )}

                    {plan && (
                      <div className="gap-plan-block">
                        <h5 className="gap-plan-heading">{t('gap.plan.proposals')}</h5>
                        {plan.proposals.length === 0 ? (
                          <p className="gap-plan-note">{t('gap.plan.noProposals')}</p>
                        ) : (
                          <>
                            <p className="gap-plan-note">{t('gap.plan.proposalsHint')}</p>
                            <div className="gap-plan-count">
                              {tf('gap.plan.selectedCount', selectedIds.length, plan.proposals.length)}
                            </div>
                            {plan.proposals.map(p => (
                              <ProposalRow
                                key={p.id}
                                proposal={p}
                                checked={selectedIds.includes(p.id)}
                                onToggle={() => toggleProposal(p.id)}
                              />
                            ))}
                            {selectedIds.length === 0 && (
                              <p className="gap-plan-note">{t('gap.plan.nothingSelected')}</p>
                            )}
                          </>
                        )}

                        {plan.validationSteps.length > 0 && (
                          <>
                            <div className="gap-plan-label">{t('gap.plan.validationSteps')}</div>
                            <ul className="gap-plan-list">
                              {plan.validationSteps.map((s, i) => <li key={i}>{s}</li>)}
                            </ul>
                          </>
                        )}
                        {plan.unresolvedQuestions.length > 0 && (
                          <>
                            <div className="gap-plan-label">{t('gap.plan.unresolved')}</div>
                            <ul className="gap-plan-list">
                              {plan.unresolvedQuestions.map((q, i) => <li key={i}>{q}</li>)}
                            </ul>
                          </>
                        )}
                      </div>
                    )}

                    {plan && plan.proposals.length > 0 && (
                      <div className="gap-plan-actions">
                        <button
                          className="gap-btn gap-btn-secondary gap-btn-sm"
                          disabled={fixBusy || selectedIds.length === 0}
                          onClick={handlePreview}
                        >
                          <span>{t('gap.plan.preview')}</span>
                        </button>
                        {/* 只有预览确实生成了、且门禁没拒绝，才给「应用」。 */}
                        {canApply && (
                          <button
                            className="gap-btn gap-btn-primary gap-btn-sm"
                            disabled={fixBusy}
                            onClick={handleApply}
                          >
                            <span>{t('gap.plan.apply')}</span>
                          </button>
                        )}
                        {canRollback && (
                          <button
                            className="gap-btn gap-btn-secondary gap-btn-sm"
                            disabled={fixBusy}
                            onClick={handleRollback}
                          >
                            <span>{t('gap.plan.rollback')}</span>
                          </button>
                        )}
                      </div>
                    )}

                    {stageOutcome && (
                      <OutcomeBlock
                        title={t('gap.plan.previewTitle')}
                        outcome={stageOutcome}
                        applied={false}
                      />
                    )}

                    {commitOutcome && (
                      <OutcomeBlock
                        title={t('gap.plan.resultTitle')}
                        outcome={commitOutcome}
                        applied={commitOutcome.applied > 0}
                      />
                    )}

                    {verification && (
                      <div className="gap-plan-block">
                        <h5 className="gap-plan-heading">{t('gap.plan.verifyTitle')}</h5>
                        <p className="gap-plan-note">
                          {tf(
                            'gap.plan.verifyCounts',
                            verification.relationTotal,
                            verification.proposalsPresent,
                            verification.proposalsAbsent,
                          )}
                        </p>
                        {verification.danglingEndpoints.length > 0 && (
                          <>
                            <div className="gap-plan-label">{t('gap.plan.dangling')}</div>
                            <ul className="gap-plan-list">
                              {verification.danglingEndpoints.map((d, i) => <li key={i}>{d}</li>)}
                            </ul>
                          </>
                        )}
                      </div>
                    )}

                    {rollbackOutcome && (
                      <OutcomeBlock
                        title={t('gap.plan.status.rolled_back')}
                        outcome={rollbackOutcome}
                        applied={false}
                      />
                    )}

                    {/* 执行详情：终端日志与逐条结果。次要披露，不是主界面。 */}
                    {(agentLog.length > 0 || fixResult || commitOutcome || stageOutcome) && (
                      <details className="gap-plan-details">
                        <summary>{t('gap.plan.execDetails')}</summary>

                        {(commitOutcome ?? stageOutcome) && (
                          <ul className="gap-plan-list">
                            {(commitOutcome ?? stageOutcome)!.details.map((d, i) => (
                              <li key={i}>
                                <span className="gap-plan-mono">
                                  {shortLabel(d.source)} → {shortLabel(d.target)} · {d.relationType}
                                </span>
                                {' — '}
                                {t(`gap.plan.itemOutcome.${d.outcome}` as TranslationKey)}
                                {d.message ? ` · ${d.message}` : ''}
                              </li>
                            ))}
                          </ul>
                        )}

                        {agentLog.length > 0 && (
                          <div className="gap-terminal-wrapper">
                            <div className="gap-terminal-header">
                              <div className="terminal-dots">
                                <span className="dot dot-red" />
                                <span className="dot dot-yellow" />
                                <span className="dot dot-green" />
                              </div>
                              <span className="terminal-title">{t('gap.agentLogTitle')}</span>
                            </div>
                            <div className="gap-terminal-body">
                              {agentLog.map((log, i) => {
                                const meta = LOG_META[log.type];
                                return (
                                  <div key={i} className={`gap-terminal-line ${meta.cls}`}>
                                    <span className="terminal-prompt">$</span>
                                    <span className="terminal-text">{log.text}</span>
                                  </div>
                                );
                              })}
                              <div ref={logEndRef} />
                            </div>
                          </div>
                        )}

                        {fixResult && (
                          <MarkdownRenderer content={fixResult} className="gap-ai-markdown" />
                        )}
                      </details>
                    )}
                  </div>
                )}
              </div>

              {/* 重新诊断。诊断与修复是两件事，这一行只属于诊断。 */}
              <div className="gap-rerun-section">
                <span className="gap-plan-label">{t('gap.plan.sectionDiagnose')}</span>
                <button className="gap-btn gap-btn-secondary gap-btn-sm" onClick={() => analyze('quick')} disabled={isAnalyzing || fixBusy}>
                  <IconTarget size={13} />
                  <span>{state.lang === 'zh' ? '重新快速诊断' : 'Run Quick Scan'}</span>
                </button>
                <button className="gap-btn gap-btn-primary gap-btn-sm" onClick={() => analyze('agent')} disabled={isAnalyzing || fixBusy}>
                  <IconRobot size={13} />
                  <span>{state.lang === 'zh' ? '重新 Agent 深度诊断' : 'Run Deep Agent Scan'}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── 修复闭环的展示部件与词表 ─────────────────────────────────────────

/**
 * 一条提议 / one proposal, one checkbox.
 *
 * 每行必须同时给出理由、置信度、风险与依据。少了任何一项，用户就只能凭「AI 说的」
 * 来勾选，那这个复选框就是装饰。
 */
function ProposalRow({
  proposal,
  checked,
  onToggle,
}: {
  proposal: GraphProposal;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="gap-plan-proposal">
      <label className="gap-plan-proposal-head">
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <span className="gap-plan-mono">
          {shortLabel(proposal.sourcePath)}
          {proposal.targetPath ? ` → ${shortLabel(proposal.targetPath)}` : ''}
        </span>
        {proposal.relationType && (
          <span className="gap-plan-mono">
            {t('gap.plan.relationType')}: {proposal.relationType}
          </span>
        )}
      </label>

      <div className="gap-plan-proposal-meta">
        <span>{t('gap.plan.confidence')}: {proposal.confidence.toFixed(2)}</span>
        <span>{t('gap.plan.risk')}: {riskLabel(proposal.risk)}</span>
      </div>

      <p className="gap-plan-proposal-reason">
        {t('gap.plan.reason')}: {proposal.reason}
      </p>

      {/* 已存在不是成功，勾了也只会换来一句「已存在」，所以先说清楚。 */}
      {proposal.alreadyExists && (
        <div className="gap-plan-warn">{t('gap.plan.alreadyExists')}</div>
      )}

      {proposal.evidence.length > 0 && (
        <>
          <div className="gap-plan-label">{t('gap.plan.evidence')}</div>
          {proposal.evidence.map((ev, i) => (
            <GraphEvidenceCard key={`${proposal.id}-${i}`} ev={ev} />
          ))}
        </>
      )}
    </div>
  );
}

/**
 * 一次 stage / commit / rollback 的结果 / the numbers, and nothing but the numbers.
 *
 * 成功样式只在 `applied > 0` 时出现。`refusal` 非空一律显示「未执行」，
 * 而 `state === 'partial_success'` 要读起来像「部分」，不能像「完成」。
 */
function OutcomeBlock({
  title,
  outcome,
  applied,
}: {
  title: string;
  outcome: PlanOutcome;
  /** 是否用成功样式。调用方必须传 `outcome.applied > 0`，不许为了好看传 true。 */
  applied: boolean;
}) {
  const refused = outcome.refusal !== null && outcome.refusal !== undefined;
  return (
    <div className={`gap-plan-block ${applied ? 'gap-plan-block-ok' : ''}`}>
      <h5 className="gap-plan-heading">{title}</h5>

      {refused ? (
        <>
          <div className="gap-plan-warn" role="alert">
            {t('gap.plan.notExecuted')} — {t('gap.plan.refusalTitle')}
          </div>
          <p className="gap-plan-note">{outcome.refusal}</p>
          <p className="gap-plan-note">{t('gap.plan.refusalHint')}</p>
        </>
      ) : (
        <div className="gap-plan-status">
          <KcPill
            tone={applied ? 'success' : outcome.state === 'partial_success' ? 'warning' : 'neutral'}
            label={t(`gap.plan.status.${outcome.state}` as TranslationKey)}
          />
        </div>
      )}

      <ul className="gap-plan-list">
        <li>{tf('gap.plan.resultApplied', outcome.applied)}</li>
        <li>{tf('gap.plan.resultAlready', outcome.alreadyExisted)}</li>
        <li>{tf('gap.plan.resultRejected', outcome.rejectedByUser)}</li>
        <li>{tf('gap.plan.resultFailed', outcome.failed)}</li>
        {outcome.missing > 0 && <li>{tf('gap.plan.resultMissing', outcome.missing)}</li>}
      </ul>

      {/* 一条都没写进去必须明说，否则一排 0 会被读成「本来就没什么可做」。 */}
      {!refused && outcome.applied === 0 && (
        <p className="gap-plan-note">{t('gap.plan.resultNothingApplied')}</p>
      )}

      {outcome.selected > 0 && (
        <p className="gap-plan-note">
          {tf(
            'gap.plan.previewCounts',
            outcome.selected,
            outcome.alreadyExisted,
            outcome.rejectedByUser,
          )}
        </p>
      )}

      {/* 冲突串原样列出：概括它等于把最重要的那句话丢掉。 */}
      {outcome.conflicts.length > 0 && (
        <>
          <div className="gap-plan-label">{t('gap.plan.conflictsTitle')}</div>
          <ul className="gap-plan-list">
            {outcome.conflicts.map((c, i) => (
              <li key={i} className="gap-plan-warn-line">{c}</li>
            ))}
          </ul>
        </>
      )}

      {outcome.message && <p className="gap-plan-note">{outcome.message}</p>}
    </div>
  );
}

/** 后端 state → 前端阶段。未知串一律当失败，不当成功。 */
function phaseOfOutcome(outcome: PlanOutcome): FixPhase {
  switch (outcome.state) {
    case 'completed':
      return 'completed';
    case 'partial_success':
      return 'partial_success';
    case 'conflict':
      return 'conflict';
    case 'rejected':
      return 'rejected';
    case 'rolled_back':
      return 'rolled_back';
    case 'awaiting_approval':
      return 'preview_ready';
    default:
      return 'failed';
  }
}

/** 阶段 → pill 色调。只有真的全写进去了才用 success。 */
function phaseTone(phase: FixPhase): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  switch (phase) {
    case 'completed':
      return 'success';
    case 'partial_success':
    case 'conflict':
      return 'warning';
    case 'failed':
    case 'rejected':
      return 'danger';
    case 'retrieving':
    case 'analyzing':
    case 'planning':
    case 'applying':
    case 'verifying':
      return 'info';
    default:
      return 'neutral';
  }
}

/** 观察种类的人话标签，未知种类归到「其他发现」。 */
function observationKindLabel(kind: string): string {
  const key = `gap.plan.obsKind.${kind}` as TranslationKey;
  const text = t(key);
  return text === key ? t('gap.plan.obsKind.other') : text;
}

function kindRank(kind: string): number {
  const i = OBSERVATION_KIND_ORDER.indexOf(kind);
  return i === -1 ? OBSERVATION_KIND_ORDER.length : i;
}

/** 风险等级的人话标签，未知等级原样显示而不是编一个。 */
function riskLabel(risk: string): string {
  const key = `gap.plan.risk.${risk}` as TranslationKey;
  const text = t(key);
  return text === key ? risk : text;
}

/** 绝对路径不进主文案，只留文件名。 */
function shortLabel(path: string): string {
  const name = path.split(/[/\\]/).filter(Boolean).pop();
  return name || path;
}


function IconTarget({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>
    </svg>
  );
}

function IconOrphan({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4"/><path d="M16 8V5a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v3"/><path d="M8 16v3a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-3"/>
    </svg>
  );
}

function IconIsland({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7" cy="7" r="3"/><circle cx="17" cy="17" r="3"/>
    </svg>
  );
}

function IconHub({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/><line x1="12" y1="3" x2="12" y2="9"/><line x1="12" y1="15" x2="12" y2="21"/><line x1="3" y1="12" x2="9" y2="12"/><line x1="15" y1="12" x2="21" y2="12"/>
    </svg>
  );
}

function IconCheckCircle({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--success, #10B981)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
    </svg>
  );
}

function IconChart({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
    </svg>
  );
}

function IconActivity({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
    </svg>
  );
}

function IconTools({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
    </svg>
  );
}

function IconBook({ size = 16, style }: { size?: number; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={style}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 0 6.5 22H20M4 19.5V3a1 1 0 0 1 1-1h15v20H5a1 1 0 0 1-1-1z" />
    </svg>
  );
}

function IconLink({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function IconArrowRight({ size = 16, style }: { size?: number; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={style}>
      <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
    </svg>
  );
}
