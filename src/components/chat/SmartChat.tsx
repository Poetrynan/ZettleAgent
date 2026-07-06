import { useState, useRef, useEffect, useCallback } from 'react';
import { ragSearchAndStream, agentChat, cancelAgentTurn, saveChatMessage, readMarkdownFile, emitRefreshEvent, exportChatSession, resolveRagSearchMode, ragNeedsQueryEmbedding } from '../../lib/tauri';
import type { SearchMode, AgentEvent, SearchResult, PlanStep } from '../../lib/tauri';
import { useApp } from '../../contexts/AppContext';
import { IconSend, IconGlobe } from '../icons';
import { t } from '../../lib/i18n';

import { listen } from '@tauri-apps/api/event';
import { useChatSessions } from './useChatSessions';
import type { Message, TimelineEntry } from './useChatSessions';

import { SessionListPanel } from './SessionListPanel';
import { ChatHeader } from './ChatHeader';
import { ChatMessageList } from './ChatMessageList';
import { Modal } from '../common/Modal';
import { pickAgentFinalAnswer, isOrchestrationNoise, stripReportFromTimeline, finalizeAgentTimeline, stripRecoveryEcho, isAgentAnswerStream, initialAgentTimeline } from './agentAnswer';

/** Turn ended — in_progress steps are done (mark as done). */
function settlePlanSteps(steps?: PlanStep[]): PlanStep[] | undefined {
  if (!steps?.length) return steps;
  return steps.map((s) =>
    s.status === 'in_progress' ? { ...s, status: 'done' as const } : s,
  );
}

/** Stop spinners / running tools when the user cancels or the turn errors out. */
function finalizeAgentTraceOnInterrupt(msg: Message): Message {
  const now = new Date();
  const toolCalls = msg.toolCalls?.map((tc) =>
    tc.status === 'running' || tc.status === 'pending'
      ? {
          ...tc,
          status: 'error' as const,
          endTime: now,
          result: tc.result || 'Interrupted',
        }
      : tc
  );
  const agentTimeline = msg.agentTimeline?.map((e) => {
    if (e.type === 'tool_call' && e.toolCall) {
      const updated = toolCalls?.find((t) => t.id === e.toolCall!.id);
      return updated ? { ...e, toolCall: updated } : e;
    }
    return e;
  });
  return {
    ...msg,
    streaming: false,
    answerStreaming: false,
    toolCalls,
    agentTimeline,
    agentInterrupted: true,
  };
}

const WORKFLOW_TEMPLATES: Record<string, {
  id: string;
  icon: string;
  label: string;
  labelZh: string;
  prompt: string;
  promptZh: string;
  description: string;
  descriptionZh: string;
}[]> = {
  graph: [
    {
      id: 'explore-cluster',
      icon: '🔬',
      label: 'Analyze Cluster',
      labelZh: '分析这个簇',
      prompt: 'Analyze the main clusters in my knowledge graph: identify hub nodes, explain how the notes relate, and suggest how to strengthen or expand each cluster.',
      promptZh: '请对当前知识图谱中的主要聚类（簇）进行结构与关联分析，找出其中的核心枢纽节点，解释各卡片间的概念关系，并建议如何补全或丰富该簇。',
      description: 'Deep-dive into nodes and links in the selected graph cluster',
      descriptionZh: '深入分析当前图谱中选中簇的各节点及关联结构'
    },
    {
      id: 'suggest-connections',
      icon: '🔗',
      label: 'Complete Links',
      labelZh: '补全缺失连接',
      prompt: 'Review my knowledge graph and find note pairs that are semantically related but not yet linked with wikilinks. List each pair with a clear reason to connect them.',
      promptZh: '分析当前的知识图谱，寻找语义高度相关但尚未建立 Wikilink 链接的笔记对，并列出推荐连接的具体理由。',
      description: 'Find semantically related notes missing links and suggest connections',
      descriptionZh: '寻找语义相关但未连接的卡片并推荐连线'
    },
    {
      id: 'canvas-from-topic',
      icon: '🎨',
      label: 'Board from Topic',
      labelZh: '以话题创建画布',
      prompt: 'Using “[enter a topic, e.g. deep learning]” as the center, pull all related notes from my vault and build a visual canvas with logical connections.',
      promptZh: '请以 “在此输入主题（如：深度学习）” 为中心，自动抓取我笔记库中所有相关的笔记卡片，并自动生成一张带有逻辑关联的可视化画布。',
      description: 'Build a visual board from notes matching a topic',
      descriptionZh: '输入特定话题自动抓取卡片构建可视化白板'
    }
  ],
  canvas: [
    {
      id: 'arrange-layout',
      icon: '🧠',
      label: 'Arrange Layout',
      labelZh: '整理画布布局',
      prompt: 'Auto-arrange and optimize the layout of all cards on my current canvas so the structure is clear and readable.',
      promptZh: '请帮我使用 AI 智能排版算法或图拓扑排版，自动重排和优化我当前画布上所有卡片的位置，使整个画布结构清晰美观。',
      description: 'Auto-layout and tidy all cards on the current canvas',
      descriptionZh: '自动对当前画布中的所有卡片进行美化排版'
    },
    {
      id: 'canvas-connections',
      icon: '🔗',
      label: 'Suggest Canvas Links',
      labelZh: '建议潜在连接',
      prompt: 'Scan every card on my current canvas, find hidden semantic relationships, and suggest links with relationship types.',
      promptZh: '扫描当前画布上的所有卡片，寻找隐藏在其内容中的语义关联，并为我建议可以建立的连线与关联性质。',
      description: 'Recommend new links between notes on this canvas',
      descriptionZh: '扫描当前画布笔记并推荐可连接的线条'
    },
    {
      id: 'canvas-health',
      icon: '🏥',
      label: 'Diagnose Canvas',
      labelZh: '诊断画布健康',
      prompt: 'Run a structural health check on my current canvas: orphan nodes, broken links, and cards with no relationships. Give concrete fix suggestions.',
      promptZh: '对当前画布进行结构健康诊断，扫描所有孤立节点、失效连接以及未建立关系的卡片，提供具体的优化修复建议。',
      description: 'Find orphan nodes and broken links on this canvas',
      descriptionZh: '分析当前画布的孤岛节点与失效链接情况'
    }
  ],
  note: [
    {
      id: 'recommend-links',
      icon: '💡',
      label: 'Recommend Links',
      labelZh: '关联内容推荐',
      prompt: 'Based on the note I have open, recommend 3–5 other notes in my vault that would connect well, and explain why each link makes sense.',
      promptZh: '基于当前打开的这篇笔记内容，在我的整个知识库中推荐 3-5 篇最适合与其建立关联的其他笔记，并详细解释关联的依据。',
      description: 'Find notes that pair well with the one you are editing',
      descriptionZh: '为当前笔记寻找能产生碰撞的其他卡片进行关联'
    },
    {
      id: 'note-history',
      icon: '⏳',
      label: 'Analyze Evolution',
      labelZh: '时态演进对比',
      prompt: 'Compare how the topic of my open note evolved across past versions and summarize how my thinking changed over time.',
      promptZh: '请对比我当前打开笔记的主题在过去的历史时间版本中的内容变化与观点演进，分析我的认知经历了怎样的变迁。',
      description: 'Track how this note’s ideas changed across versions',
      descriptionZh: '对比并解读当前笔记的历史版本与看法变化'
    },
    {
      id: 'contradiction-check',
      icon: '⚡',
      label: 'Check Contradictions',
      labelZh: '知识矛盾检查',
      prompt: 'Check whether claims in my open note contradict other notes in my vault. Point out each conflict clearly.',
      promptZh: '检查我当前这篇笔记中的观点或论据，是否与我笔记库中已有的其他笔记观点存在矛盾或冲突，并清晰地指出冲突点。',
      description: 'Spot conflicts between this note and the rest of the vault',
      descriptionZh: '检查当前笔记是否与库中其他卡片产生冲突'
    }
  ],
  calendar: [
    {
      id: 'weekly-review',
      icon: '📋',
      label: 'Weekly Review',
      labelZh: '周度知识回顾',
      prompt: 'Scan all notes created or edited in the last 7 days, summarize my learning threads, and produce a structured weekly review.',
      promptZh: '请帮我扫描本周（最近 7 天）新增或修改的所有笔记卡片，梳理我的学习脉络，并自动生成一份结构化的周度知识总结报告。',
      description: 'Summarize this week’s notes into a review report',
      descriptionZh: '扫描本周创作，自动梳理脉络并生成总结报告'
    },
    {
      id: 'note-trends',
      icon: '📈',
      label: 'Creation Trends',
      labelZh: '笔记创作趋势',
      prompt: 'Using my calendar history, analyze recent note frequency and themes. Summarize shifting focus areas and blind spots.',
      promptZh: '结合日历历史分析我近期笔记的创作频次和主题偏好，总结我最近主要的思考领域、知识重心的演变以及盲区。',
      description: 'See how your writing themes shifted over time',
      descriptionZh: '根据日历记录分析我最近的思考领域变迁'
    }
  ],
  generic: [
    {
      id: 'synthesize-topic',
      icon: '📝',
      label: 'Topic Summary',
      labelZh: '主题综述生成',
      prompt: 'Search my vault for notes related to “[enter a topic, e.g. AI safety]” and synthesize a structured MOC-style topic overview.',
      promptZh: '请在我的整个笔记库中搜索与 “在此输入主题（如：AI 安全）” 相关的笔记，帮我汇总并生成一份结构化的 MOC（内容地图）主题综述。',
      description: 'Search and merge notes on a topic into a structured MOC',
      descriptionZh: '搜索并整合特定主题的所有笔记，生成结构化 MOC'
    },
    {
      id: 'vault-diagnose',
      icon: '🔍',
      label: 'Vault Diagnosis',
      labelZh: '全库盲区诊断',
      prompt: 'Run a structural blind-spot scan of my entire vault: orphan cards, redundant topics, MOC consolidation opportunities, and an immediate action plan.',
      promptZh: '对我的整个知识库进行结构性盲区扫描，列出孤立卡片、冗余话题及潜在的 MOC 整合机会，并给出一份即时行动计划。',
      description: 'Scan the vault for orphans, links, and action items',
      descriptionZh: '对整个知识库进行盲区扫描、链接诊断及行动建议'
    }
  ]
};

export function SmartChat() {
  const { state, toggleChat, clearPendingAttachments, clearPendingChatPrompt, showToast } = useApp();
  const currentView = state.view;
  const viewTemplates = WORKFLOW_TEMPLATES[currentView] || [];
  const activeTemplates = [...viewTemplates, ...WORKFLOW_TEMPLATES.generic].slice(0, 4);

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const { llmConfig } = state;
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [mode, setMode] = useState<'rag' | 'agent'>('agent');
  const [searchMode, setSearchMode] = useState<SearchMode>(state.searchMode);
  const [showTyping, setShowTyping] = useState(false);
  const [expandedToolCalls, setExpandedToolCalls] = useState<Set<string>>(new Set());
  const [attachedNotes, setAttachedNotes] = useState<{ name: string; path: string; source?: 'canvas' | 'manual' }[]>([]);
  const [ragProgress, setRagProgress] = useState<string | null>(null);

  const [webSearch, setWebSearch] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const timelineIndexRef = useRef(0);
  const answerSourceRef = useRef<string | undefined>(undefined);
  /** After clear_text, next text_delta stream is the final answer (synthesis), not trace narration. */
  const answerStreamAfterClearRef = useRef(false);

  // Export Modal states
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportSessionId, setExportSessionId] = useState<string | null>(null);
  const [exportFormat, setExportFormat] = useState<'markdown' | 'json'>('markdown');
  const [exportSuccessPath, setExportSuccessPath] = useState<string | null>(null);
  const [exportIsRunning, setExportIsRunning] = useState(false);

  const isZh = (state.lang || 'zh') === 'zh';

  // Session management (extracted hook)
  const sess = useChatSessions(state.vaultPath);

  // Load sessions on mount
  useEffect(() => { sess.refreshSessions(); }, []);

  // Consume pending attachments from context (sent by Sidebar)
  useEffect(() => {
    if (state.pendingAttachments.length > 0) {
      setAttachedNotes(prev => {
        const newOnes = state.pendingAttachments.filter(
          pa => !prev.some(p => p.path === pa.path)
        );
        return [...prev, ...newOnes];
      });
      clearPendingAttachments();
      inputRef.current?.focus();
    }
  }, [state.pendingAttachments, clearPendingAttachments]);

  // Consume pending chat prompt from context (sent by Canvas discuss button)
  useEffect(() => {
    if (state.pendingChatPrompt) {
      setInput(state.pendingChatPrompt);
      clearPendingChatPrompt();
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.style.height = 'auto';
          inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 150) + 'px';
        }
      }, 100);
    }
  }, [state.pendingChatPrompt, clearPendingChatPrompt]);

  // Wrap load session to also set messages and restore session mode
  const handleLoadSession = useCallback(async (sid: string) => {
    const loaded = await sess.handleLoadSession(sid);
    setMessages(loaded);
    const sessionMeta = sess.sessions.find(s => s.id === sid);
    if (sessionMeta?.mode === 'agent' || sessionMeta?.mode === 'rag') {
      setMode(sessionMeta.mode);
    }
  }, [sess]);

  // Wrap delete to also clear messages.
  // Guard: the session receiving an in-flight AI reply cannot be deleted (Cursor-style lock).
  const handleDeleteSession = useCallback(async (sid: string) => {
    if (isLoading && sid === sess.sessionId) {
      showToast(t('chat.cannotDeleteWhileStreaming' as any), 'info');
      return;
    }
    const newId = await sess.handleDeleteSession(sid, sess.sessionId);
    if (newId) setMessages([]);
  }, [sess, isLoading, showToast]);

  // Wrap new session to also clear messages
  const handleNewSession = useCallback(() => {
    sess.handleNewSession();
    setMessages([]);
    setInput('');
    setAttachedNotes([]);
    setRagProgress(null);
    setExpandedToolCalls(new Set());
  }, [sess]);

  /** Switch Agent/RAG — always starts a fresh chat session (Cursor-style). */
  const handleModeChange = useCallback((nextMode: 'agent' | 'rag') => {
    if (nextMode === mode || isLoading) return;
    handleNewSession();
    setMode(nextMode);
    inputRef.current?.focus();
  }, [mode, isLoading, handleNewSession]);

  // Save a message to the database (including full agent trace for history restore)
  const persistMessage = useCallback((msg: Message, sid: string) => {
    saveChatMessage(
      msg.id, sid, msg.role, msg.content,
      msg.sources ? JSON.stringify(msg.sources) : undefined,
      msg.toolCalls ? JSON.stringify(msg.toolCalls) : undefined,
      msg.thinkingContent || undefined,
      msg.agentTimeline && msg.agentTimeline.length > 0 ? JSON.stringify(msg.agentTimeline) : undefined,
      msg.agentPlanSteps && msg.agentPlanSteps.length > 0 ? JSON.stringify(msg.agentPlanSteps) : undefined,
    ).catch(e => console.error('Failed to persist message:', e));
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [messages, showTyping]);

  const toggleToolCallExpand = useCallback((id: string) => {
    setExpandedToolCalls(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Listen for streaming chunks (chat/RAG mode)
  useEffect(() => {
    const unlisten = listen<{ content: string; done: boolean }>('llm-stream-chunk', (event) => {
      const { content, done } = event.payload;
      setShowTyping(false);
      // Only clear RAG progress when actual content arrives (not empty first chunk)
      if (content) setRagProgress(null);

      if (content) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.streaming) {
            return [...prev.slice(0, -1), { ...last, content: last.content + content, streaming: !done }];
          }
          return prev;
        });
      }

      if (done) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.streaming) {
            const finalMsg = { ...last, streaming: false };
            persistMessage(finalMsg, sess.sessionId);
            sess.refreshSessions();
            return [...prev.slice(0, -1), finalMsg];
          }
          return prev;
        });
        setIsLoading(false);
      }
    });

    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Listen for RAG sources
  useEffect(() => {
    const unlisten = listen<{ sources: SearchResult[] }>('rag-sources', (event) => {
      const { sources } = event.payload;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === 'assistant') {
          return [...prev.slice(0, -1), { ...last, sources }];
        }
        return prev;
      });
    });

    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Listen for RAG progress events
  useEffect(() => {
    const unlisten = listen<{ stage: string }>('rag-progress', (event) => {
      setRagProgress(event.payload.stage);
    });

    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Listen for Agent events (tool_call_detected, tool_start, tool_result, done)
  useEffect(() => {
    const unlisten = listen<AgentEvent>('agent-event', (event) => {
      const e = event.payload;
      switch (e.type) {
        case 'thinking':
          setShowTyping(false);
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant') {
              if (last.streaming === false) return prev;
              const delta = (e.message || '');
              if (!delta) return prev;
              const hasTools = !!(last.toolCalls && last.toolCalls.length > 0);
              // Agent mode: pre-tool narration → trace only. Non-agent / synthesis → answer bubble.
              if (!hasTools && !last.isAgentStep && !isOrchestrationNoise(delta)) {
                const timeline = (last.agentTimeline || []).filter(
                  (t) => !(t.type === 'thought' && t.isStage),
                );
                return [...prev.slice(0, -1), {
                  ...last,
                  content: last.content + delta,
                  answerStreaming: true,
                  agentTimeline: timeline.length ? timeline : undefined,
                }];
              }
              const timeline = [...(last.agentTimeline || [])];
              // Orchestration nudges (plan_guard / budget / stagnation / suppress_todo_write)
              // are surfaced as a dedicated system_note entry instead of being dropped, so the
              // user can see WHY the model was redirected. They never merge with model thoughts.
              if (isOrchestrationNoise(delta)) {
                const note: TimelineEntry = { type: 'system_note', content: delta.trim(), index: timelineIndexRef.current++ };
                return [...prev.slice(0, -1), { ...last, agentTimeline: [...timeline, note] }];
              }
              const lastEntry = timeline[timeline.length - 1];
              // Never merge into a stage status line — it is orchestration UI, not model thinking.
              if (lastEntry?.type === 'thought' && !lastEntry.isStage) {
                const updated: TimelineEntry = {
                  ...lastEntry,
                  content: stripRecoveryEcho((lastEntry.content || '') + delta),
                };
                if (!updated.content?.trim()) return prev;
                timeline[timeline.length - 1] = updated;
                return [...prev.slice(0, -1), {
                  ...last,
                  agentTimeline: timeline,
                }];
              }
              const entry: TimelineEntry = { type: 'thought', content: stripRecoveryEcho(delta), index: timelineIndexRef.current++ };
              if (!entry.content?.trim()) return prev;
              return [...prev.slice(0, -1), {
                ...last,
                agentTimeline: [...timeline, entry],
              }];
            }
            return prev;
          });
          break;
        case 'plan_update': {
          // Live plan from the model's todo_write tool call (Cursor-style checklist).
          const steps = e.steps || [];
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant' && last.streaming !== false) {
              return [...prev.slice(0, -1), { ...last, agentPlanSteps: steps }];
            }
            return prev;
          });
          break;
        }
        case 'stage': {
          // Pre-execution stage feedback: routing / loading_tools / planning.
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last?.role !== 'assistant' || last.streaming === false) return prev;
            const STAGE_ZH: Record<string, string> = {
              routing: '正在路由到合适的 Agent…',
              loading_tools: '正在加载工具与构建 Agent…',
              planning: '正在规划与执行…',
              executing: '正在执行…',
            };
            const STAGE_EN: Record<string, string> = {
              routing: 'Routing request to the right agent…',
              loading_tools: 'Loading tools & building agent…',
              planning: 'Planning & executing…',
              executing: 'Executing…',
            };
            const isZh = (e.message || '').match(/[\u4e00-\u9fff]/);
            const label = isZh
              ? (STAGE_ZH[e.stage || ''] || e.message || '')
              : (STAGE_EN[e.stage || ''] || e.message || '');
            // Replace any prior stage line to avoid stacking. Stage entries are
            // identified by the isStage flag (no emoji-prefix regex).
            const entry: TimelineEntry = { type: 'thought', content: label, index: timelineIndexRef.current++, isStage: true };
            return [...prev.slice(0, -1), {
              ...last,
              agentTimeline: [...(last.agentTimeline || []).filter(t => !(t.type === 'thought' && t.isStage)), entry],
            }];
          });
          break;
        }
        case 'intent_classified': {
          // Intent classification trace — show which layer classified the query
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last?.role !== 'assistant' || last.streaming === false) return prev;
            const layer = e.layer || 'L1';
            const confidence = e.confidence ?? 0;
            const intentName = e.intent_name || e.intent || 'unknown';
            const isZh = (e.intent_name || '').match(/[\u4e00-\u9fff]/);
            // Format: "意图识别: {intent_name} (via {layer}, {confidence}%)"
            const confidencePct = Math.round(confidence * 100);
            const label = isZh
              ? `识别为：${intentName}（via ${layer}，${confidencePct}%）`
              : `Intent: ${intentName} (via ${layer}, ${confidencePct}%)`;
            const entry: TimelineEntry = {
              type: 'thought',
              content: label,
              index: timelineIndexRef.current++,
              isStage: true, // Stage-like: gets replaced by subsequent stages
            };
            // Replace any prior intent_classified entry to avoid stacking
            return [...prev.slice(0, -1), {
              ...last,
              agentTimeline: [...(last.agentTimeline || []).filter(t => !(t.type === 'thought' && t.isStage)), entry],
            }];
          });
          break;
        }
        case 'tool_call_detected':
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant') {
              if (last.streaming === false) return prev;
              const existing = last.toolCalls || [];
              if (existing.some(tc => tc.id === e.tool_call_id)) return prev;
              const newTc = {
                id: e.tool_call_id!,
                name: e.name!,
                arguments: '{}',
                status: 'pending' as const,
              };
              const entry: TimelineEntry = { type: 'tool_call', toolCall: newTc, index: timelineIndexRef.current++ };
              return [...prev.slice(0, -1), {
                ...last,
                toolCalls: [...existing, newTc],
                agentTimeline: [...(last.agentTimeline || []), entry],
              }];
            }
            return prev;
          });
          break;
        case 'tool_start':
          answerStreamAfterClearRef.current = false;
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant') {
              if (last.streaming === false) return prev;
              const existing = last.toolCalls || [];
              const existingIdx = existing.findIndex(tc => tc.id === e.tool_call_id);
              let updatedTc: typeof existing[number];

              // When first tool fires, move any bubble content to timeline as narration
              // This prevents duplication when synthesis later writes to the bubble
              const isFirstTool = existing.length === 0 && existingIdx < 0;
              let updatedTimeline = last.agentTimeline || [];
              let clearedContent = last.content;
              if (isFirstTool && last.content && last.content.trim()) {
                updatedTimeline = [...updatedTimeline, {
                  type: 'thought',
                  content: last.content.trim(),
                  index: timelineIndexRef.current++,
                }];
                clearedContent = '';
              }

              if (existingIdx >= 0) {
                const updated = [...existing];
                updated[existingIdx] = {
                  ...updated[existingIdx],
                  arguments: e.arguments || updated[existingIdx].arguments,
                  status: 'running' as const,
                  startTime: new Date(),
                };
                updatedTc = updated[existingIdx];
                updatedTimeline = updatedTimeline.map(te =>
                  te.type === 'tool_call' && te.toolCall?.id === e.tool_call_id
                    ? { ...te, toolCall: updatedTc }
                    : te
                );
                return [...prev.slice(0, -1), {
                  ...last,
                  toolCalls: updated,
                  agentTimeline: updatedTimeline,
                  answerStreaming: false,
                  content: clearedContent,
                }];
              }
              updatedTc = {
                id: e.tool_call_id!,
                name: e.name!,
                arguments: e.arguments || '{}',
                status: 'running' as const,
                startTime: new Date(),
              };
              const entry: TimelineEntry = { type: 'tool_call', toolCall: updatedTc, index: timelineIndexRef.current++ };
              return [...prev.slice(0, -1), {
                ...last,
                toolCalls: [...existing, updatedTc],
                agentTimeline: [...updatedTimeline, entry],
                answerStreaming: false,
                content: clearedContent,
              }];
            }
            return prev;
          });
          break;
        case 'tool_progress':
          // Streaming progress: update the tool card with a stage label + optional preview.
          // This makes long-running tools (fetch_web_content, generate_structure_note, etc.)
          // feel alive instead of showing a silent spinner.
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant') {
              if (last.streaming === false) return prev;
              const tcList = last.toolCalls || [];
              const updatedToolCalls = tcList.map(tc =>
                tc.id === e.tool_call_id
                  ? { ...tc, progressStage: e.stage || '', progressPreview: e.preview }
                  : tc
              );
              const updatedTimeline: TimelineEntry[] = (last.agentTimeline || []).map(te =>
                te.type === 'tool_call' && te.toolCall && te.toolCall.id === e.tool_call_id
                  ? { ...te, toolCall: { ...te.toolCall, progressStage: e.stage || '', progressPreview: e.preview } }
                  : te
              );
              return [...prev.slice(0, -1), {
                ...last,
                toolCalls: updatedToolCalls,
                agentTimeline: updatedTimeline,
              }];
            }
            return prev;
          });
          break;
        case 'tool_result':
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant') {
              if (last.streaming === false) return prev;
              const tcList = last.toolCalls || [];
              const tc = tcList.find(t => t.id === e.tool_call_id);
              if (tc) {
                try {
                   const args = JSON.parse(tc.arguments);
                  let workspacePath = stateRef.current.vaultPath;
                  if (args.workspace) {
                    const ws = args.workspace;
                    const idx = parseInt(ws, 10);
                    if (!isNaN(idx) && stateRef.current.vaultPaths && idx < stateRef.current.vaultPaths.length) {
                      workspacePath = stateRef.current.vaultPaths[idx];
                    } else if (stateRef.current.vaultPaths && stateRef.current.vaultPaths.includes(ws)) {
                      workspacePath = ws;
                    }
                  }
                  if (args.path || args.canvas_path) {
                    const relPath = (args.path || args.canvas_path) as string;
                    const isAbsolute = /^([a-zA-Z]:[\\/]|\/)/.test(relPath);
                    const fullPath = isAbsolute
                      ? relPath.replace(/\\/g, '/')
                      : workspacePath
                        ? workspacePath.replace(/\\/g, '/') + '/' + relPath.replace(/\\/g, '/')
                        : relPath.replace(/\\/g, '/');
                    console.log('[SmartChat] Tool result triggers refresh & reveal for:', fullPath);
                    emitRefreshEvent(fullPath);
                  } else {
                    console.log('[SmartChat] Tool result triggers general refresh');
                    emitRefreshEvent();
                  }
                } catch (err) {
                  console.log('[SmartChat] Tool result triggers general refresh (fallback):', err);
                  emitRefreshEvent();
                }
              } else {
                emitRefreshEvent();
              }

              const updatedToolCalls = tcList.map(tc =>
                tc.id === e.tool_call_id
                  ? { ...tc, result: e.content || '', status: 'done' as const, endTime: new Date() }
                  : tc
              );
              const doneTc = updatedToolCalls.find(tc => tc.id === e.tool_call_id);
              const updatedTimeline = (last.agentTimeline || []).map(te =>
                te.type === 'tool_call' && te.toolCall?.id === e.tool_call_id
                  ? { ...te, toolCall: doneTc || te.toolCall }
                  : te
              );
              return [...prev.slice(0, -1), {
                ...last,
                toolCalls: updatedToolCalls,
                agentTimeline: updatedTimeline,
              }];
            }
            return prev;
          });
          break;
        case 'text_delta':
          setShowTyping(false);
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant') {
              if (last.streaming === false) return prev;
              const delta = e.content || '';
              const isAnswerStream = isAgentAnswerStream(last, answerStreamAfterClearRef.current);
              // Pre-tool narration → timeline only; synthesis / non-agent reply → content only.
              let updatedTimeline = last.agentTimeline;
              if (isAnswerStream && delta && updatedTimeline?.length) {
                // Drop orchestration stage lines once the real answer starts streaming.
                updatedTimeline = updatedTimeline.filter(t => !(t.type === 'thought' && t.isStage));
              }
              if (!isAnswerStream && updatedTimeline && delta) {
                const lastEntry = updatedTimeline[updatedTimeline.length - 1];
                // Never merge into stage status — same rule as the `thinking` handler.
                if (lastEntry?.type === 'thought' && !lastEntry.isStage) {
                  const merged = stripRecoveryEcho((lastEntry.content || '') + delta);
                  if (!merged) {
                    updatedTimeline = updatedTimeline.slice(0, -1);
                  } else {
                    updatedTimeline = [
                      ...updatedTimeline.slice(0, -1),
                      { ...lastEntry, content: merged },
                    ];
                  }
                } else {
                  const stripped = stripRecoveryEcho(delta);
                  if (stripped) {
                    updatedTimeline = [...updatedTimeline, { type: 'thought', content: stripped, index: timelineIndexRef.current++ }];
                  }
                }
              }
              return [...prev.slice(0, -1), {
                ...last,
                content: isAnswerStream ? last.content + delta : last.content,
                streaming: true,
                answerStreaming: isAnswerStream ? true : last.answerStreaming,
                agentTimeline: updatedTimeline,
              }];
            }
            return prev;
          });
          break;
        case 'clear_text': {
          const forAnswer = e.answer_stream === true;
          answerStreamAfterClearRef.current = forAnswer;
          // Reset content buffer; only mark answerStreaming for synthesis/final report pass.
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant' && last.streaming) {
              return [...prev.slice(0, -1), {
                ...last,
                content: '',
                answerStreaming: forAnswer,
              }];
            }
            return prev;
          });
          break;
        }
        case 'done':
          if (e.answer_source) {
            answerSourceRef.current = e.answer_source;
          }
          console.log('[SmartChat] Agent done.', e.answer_source ? `source=${e.answer_source}` : '');
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant') {
              const hasTools = !!(last.toolCalls && last.toolCalls.length > 0);
              const agentTimeline = finalizeAgentTimeline(
                last.agentTimeline,
                last.content || '',
                hasTools,
              );
              return [...prev.slice(0, -1), {
                ...last,
                streaming: false,
                answerStreaming: false,
                agentPlanSteps: settlePlanSteps(last.agentPlanSteps),
                agentTimeline,
              }];
            }
            return prev;
          });
          setIsLoading(false);
          setShowTyping(false);
          emitRefreshEvent();
          break;
        case 'role_selected':
          setShowTyping(false);
          // Unified single-agent model: we no longer surface an "Agent activated"
          // badge in the trace (it was legacy multi-agent noise). Keep only the
          // metadata so downstream UI (name/icon) still works if needed.
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant' && last.streaming !== false) {
              return [...prev.slice(0, -1), {
                ...last,
                agentId: e.agent_id,
                agentName: e.agent_name,
                agentIcon: e.agent_icon,
              }];
            }
            return prev;
          });
          break;
        case 'pipeline_progress': {
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant') {
              if (last.streaming === false) return prev;
              const isZh = document.documentElement.lang === 'zh' || /[\u4e00-\u9fff]/.test(last.content || '');
              const step = e.current_step ?? 0;
              const total = e.total_steps ?? 1;
              const agentName = e.agent_name || 'Agent';
              const label = step === 0
                ? (isZh ? `🧩 多 Agent 流水线启动（共 ${total} 步）` : `🧩 Multi-agent pipeline (${total} steps)`)
                : (isZh
                  ? `🧩 步骤 ${step}/${total}：${agentName}`
                  : `🧩 Step ${step}/${total}: ${agentName}`);
              const entry: TimelineEntry = {
                type: 'pipeline',
                content: label,
                index: timelineIndexRef.current++,
                pipelineStep: step,
                pipelineTotal: total,
                pipelineAgent: agentName,
              };
              return [...prev.slice(0, -1), {
                ...last,
                agentTimeline: [...(last.agentTimeline || []), entry],
              }];
            }
            return prev;
          });
          break;
        }
        case 'approval_required':
          // Show approval card in chat with structured diff data
          setMessages(prev => {
            const approvalMsg: Message = {
              id: `approval-${e.approval_id}-${Date.now()}`,
              role: 'assistant',
              content: '',
              streaming: false,
              isApprovalRequest: true,
              approvalId: e.approval_id,
              approvalDescription: e.action_description,
              approvalDiffJson: e.diff_json || '',
              timestamp: new Date(),
            };
            return [...prev, approvalMsg];
          });
          break;
        case 'approval_resolved':
          // 后端通知审批已解决(超时/拒绝)。用户主动点击的情况已由 onApprovalResolved 处理,
          // 这里只处理用户未操作、后端 60s 超时或通道关闭的情况——把卡片变形为状态消息。
          setMessages(prev => prev.map(m => {
            if (m.approvalId !== e.approval_id) return m;
            if (!m.isApprovalRequest) return m;   // 已被 onApprovalResolved 处理过,跳过
            const reasonText = e.reason === 'timeout'
              ? (isZh ? '⏱️ 审批超时(60秒未操作)' : '⏱️ Approval timed out')
              : (isZh ? '🚫 已拒绝该操作' : '🚫 Rejected');
            return {
              ...m,
              isApprovalRequest: false,
              content: reasonText,
              isError: true,
            };
          }));
          break;
      }
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  const handleStop = useCallback(() => {
    // Signal the backend agent loop to stop at the next iteration check.
    // This makes the stop button actually halt tool execution, not just
    // cancel the frontend's await on the invoke promise.
    cancelAgentTurn().catch((e) => console.warn('cancelAgentTurn failed:', e));
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setMessages(prev => {
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant' && (last.streaming || last.isAgentStep)) {
        const stoppedContent = last.content || '';
        const stoppedMsg = finalizeAgentTraceOnInterrupt({
          ...last,
          content: stoppedContent + (stoppedContent ? '\n\n' : '') + `[${t('chat.stopGeneration' as any)}]`,
        });
        // Persist the partial response so it survives page reload
        persistMessage(stoppedMsg, sess.sessionId);
        sess.refreshSessions();
        return [...prev.slice(0, -1), stoppedMsg];
      }
      return prev;
    });
    setIsLoading(false);
    setShowTyping(false);
  }, [sess.sessionId]);

  // 解析 Agent 回复中的 [CANVAS_PUSH] 标记，推送结果到画布
  const parseAndDispatchCanvasPush = useCallback((content: string) => {
    const pushRegex = /\[CANVAS_PUSH\]\s*```(?:json)?\s*([\s\S]*?)\s*```\s*\[\/CANVAS_PUSH\]/gi;
    const matches = [...content.matchAll(pushRegex)];

    for (const match of matches) {
      try {
        const jsonStr = match[1].trim();
        const canvasData = JSON.parse(jsonStr);

        // 验证数据结构
        if (canvasData && (canvasData.nodes || canvasData.edges || canvasData.additions)) {
          window.dispatchEvent(new CustomEvent('zettel:canvas-push', {
            detail: {
              source: 'agent',
              data: canvasData,
              timestamp: Date.now(),
            },
          }));
          console.log('[SmartChat] Dispatched canvas push event with', canvasData.nodes?.length || 0, 'nodes');
        }
      } catch (e) {
        console.warn('[SmartChat] Failed to parse CANVAS_PUSH JSON:', e);
      }
    }
  }, []);

  const handleSend = async (customPrompt?: string, customMode?: 'agent' | 'rag') => {
    const activeMode = customMode || mode;
    const rawInput = customPrompt !== undefined ? customPrompt : input;
    if ((!rawInput.trim() && attachedNotes.length === 0) || isLoading) return;

    const noteRefDisplay = attachedNotes.length > 0
      ? attachedNotes.map(n => `@[[${n.name}]]`).join(' ')
      : '';
    const displayContent = rawInput.trim()
      ? (noteRefDisplay ? `${noteRefDisplay}\n${rawInput.trim()}` : rawInput.trim())
      : noteRefDisplay;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: displayContent,
      timestamp: new Date(),
    };

    const assistantId = (Date.now() + 1).toString();
    const isZhLang = isZh;
    const assistantPlaceholder: Message = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      streaming: true,
      isAgentStep: activeMode === 'agent',
      agentTimeline: activeMode === 'agent' ? initialAgentTimeline(isZhLang) : undefined,
    };

    setMessages((prev) => [...prev, userMessage, assistantPlaceholder]);
    timelineIndexRef.current = activeMode === 'agent' ? 1 : 0;
    answerSourceRef.current = undefined;
    answerStreamAfterClearRef.current = false;
    const userInput = rawInput.trim();
    const noteRefs = [...attachedNotes];
    setInput('');
    setAttachedNotes([]);
    setIsLoading(true);
    setShowTyping(true);

    sess.handleCreateSession(sess.sessionId, userInput.slice(0, 30), activeMode);
    persistMessage(userMessage, sess.sessionId);
    sess.refreshSessions();

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      if (activeMode === 'rag') {
        const effectiveMode = await resolveRagSearchMode(searchMode);
        setRagProgress(ragNeedsQueryEmbedding(effectiveMode) ? 'embedding' : 'searching');
      }
      const historyMsgs: Array<{role: string; content: string}> = [];
      for (const m of messages) {
        if (m.streaming || !m.content.trim()) continue;
        // Strip the "[stopped generation]" tag so the AI doesn't continue from where it left off
        const cleanedContent = m.content.replace(/\n*\[.*?已停止生成.*?\]\s*$/, '').replace(/\n*\[.*?stopped.*?\]\s*$/, '').trim();
        if (!cleanedContent) continue;
        historyMsgs.push({ role: m.role, content: cleanedContent });
      }

      const MAX_RECENT = 20;
      const MAX_CHARS_PER_MSG = 2000;
      let recentHistory: Array<{role: string; content: string}>;

      if (historyMsgs.length > MAX_RECENT) {
        const olderMsgs = historyMsgs.slice(0, -MAX_RECENT);
        const olderTopics = olderMsgs
          .filter(m => m.role === 'user')
          .map(m => m.content.slice(0, 80))
          .slice(-5);
        const summaryPrefix = `[Earlier in this conversation, the user discussed: ${olderTopics.join('; ')}. There were ${olderMsgs.length} earlier messages.]`;

        recentHistory = [
          { role: 'system', content: summaryPrefix },
          ...historyMsgs.slice(-MAX_RECENT).map(m => ({
            ...m,
            content: m.content.length > MAX_CHARS_PER_MSG
              ? m.content.slice(0, MAX_CHARS_PER_MSG) + '\n[...truncated]'
              : m.content,
          })),
        ];
      } else {
        recentHistory = historyMsgs.map(m => ({
          ...m,
          content: m.content.length > MAX_CHARS_PER_MSG
            ? m.content.slice(0, MAX_CHARS_PER_MSG) + '\n[...truncated]'
            : m.content,
        }));
      }

      let attachedContext = '';
      if (noteRefs.length > 0) {
        const noteContents: string[] = [];
        for (const note of noteRefs) {
          try {
            const content = await readMarkdownFile(note.path);
            noteContents.push(`--- Note: ${note.name} ---\n${content}\n--- End of ${note.name} ---`);
          } catch (e) {
            noteContents.push(`--- Note: ${note.name} ---\n[Failed to read: ${e}]\n--- End of ${note.name} ---`);
          }
        }
        attachedContext = '\n\nThe user has attached the following note(s) for context:\n\n' + noteContents.join('\n\n');
      }

      if (activeMode === 'agent') {
        const result = await agentChat({
          messages: [
            ...recentHistory,
            { role: 'user', content: userInput },
          ],
          apiUrl: llmConfig.apiUrl,
          apiKey: llmConfig.apiKey || undefined,
          model: llmConfig.model,
          providerId: llmConfig.providerId,
          contextWindow: llmConfig.contextWindow,
          supportsThinking: llmConfig.supportsThinking || undefined,
          vaultPath: state.vaultPath || undefined,
          vaultPaths: state.vaultPaths?.length ? state.vaultPaths : undefined,
          methodology: state.methodology,
          webSearch: webSearch || undefined,
          currentFile: state.currentFile || undefined,
          attachedContext: attachedContext || undefined,
        });

        setShowTyping(false);
        setMessages(prev => {
          const last = prev[prev.length - 1];
            if (last?.role === 'assistant') {
            if (last.streaming === false && last.content?.trim() && !result?.trim()) {
              return prev;
            }
            // `result` is the clean final answer (the agent loop's last iteration
            // content). `last.content` accumulated ALL streamed text — per-iteration
            // narration (CoT) PLUS the final answer. Split them so the chain-of-thought
            // and the answer render separately (Manus/Genspark-style) instead of mixed.
            const accumulated = last.content || '';
            const hasTools = !!(last.toolCalls && last.toolCalls.length > 0);
            const picked = result && result.trim()
              ? pickAgentFinalAnswer(result.trim(), last.agentTimeline, answerSourceRef.current)
              : pickAgentFinalAnswer('', last.agentTimeline, answerSourceRef.current);
            const cleanResult = picked.answer;
            let content: string;
            let thinkingContent: string | undefined;
            if (hasTools && cleanResult) {
              // Find where cleanResult begins in accumulated to split thinking vs answer
              const trimmedAccum = accumulated.trim();
              const trimmedClean = cleanResult.trim();

              // Search for cleanResult's first 50 chars in accumulated
              const searchLen = Math.min(50, trimmedClean.length);
              const searchStr = trimmedClean.substring(0, searchLen);
              const overlapIdx = trimmedAccum.indexOf(searchStr);

              if (overlapIdx > 0) {
                // accumulated = "thinking...answer_start" + cleanResult = "answer_start..."
                // → thinking = part before overlap, content = cleanResult
                content = cleanResult;
                thinkingContent = trimmedAccum.substring(0, overlapIdx).trim() || undefined;
              } else if (overlapIdx === 0) {
                // accumulated starts with the same text as cleanResult
                // → No separate thinking content, just use cleanResult
                content = cleanResult;
                thinkingContent = undefined;
              } else if (trimmedAccum.endsWith(trimmedClean)) {
                // accumulated ends with cleanResult (original working case)
                content = cleanResult;
                thinkingContent = trimmedAccum.slice(0, trimmedAccum.length - trimmedClean.length).trim() || undefined;
              } else {
                // No overlap found — use cleanResult as content, accumulated as thinking
                content = cleanResult;
                thinkingContent = trimmedAccum || undefined;
              }
            } else {
              content = accumulated || result;
              thinkingContent = undefined;
            }

            const updatedTimeline = finalizeAgentTimeline(
              stripReportFromTimeline(last.agentTimeline, cleanResult),
              content,
              hasTools,
            );

            const finalMsg = {
              ...last,
              content,
              thinkingContent,
              streaming: false,
              answerStreaming: false,
              agentTimeline: updatedTimeline,
              agentPlanSteps: settlePlanSteps(last.agentPlanSteps),
              answerSource: picked.source,
            };
            persistMessage(finalMsg, sess.sessionId);

            // 解析 [CANVAS_PUSH] 标记，将 Agent 分析结果推送回画布
            parseAndDispatchCanvasPush(content);

            return [...prev.slice(0, -1), finalMsg];
          }
          return prev;
        });
        setIsLoading(false);
        sess.refreshSessions();
      } else {
        const dynamicLimit = userInput.length > 50 ? 8 : userInput.length > 20 ? 5 : 3;

        let excludePaths: string[] | undefined;
        const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.sources && m.sources.length > 0);
        const lastUser = [...messages].reverse().find(m => m.role === 'user');
        if (lastAssistant?.sources && lastUser) {
          const prevQuery = lastUser.content.trim().toLowerCase();
          const newQuery = userInput.trim().toLowerCase();
          const isSameQuery = prevQuery === newQuery || prevQuery.includes(newQuery) || newQuery.includes(prevQuery);
          if (!isSameQuery) {
            excludePaths = lastAssistant.sources.map(s => s.file_path);
          }
        }

        await ragSearchAndStream({
          query: userInput,
          searchLimit: dynamicLimit,
          apiUrl: llmConfig.apiUrl,
          apiKey: llmConfig.apiKey || undefined,
          model: llmConfig.model,
          providerId: llmConfig.providerId,
          searchMode: searchMode,
          chatHistory: recentHistory,
          methodology: state.methodology,
          currentFile: state.currentFile || undefined,
          attachedContext: attachedContext || undefined,
          excludePaths,
        });
      }
    } catch (err) {
      if (String(err).includes('abort') || String(err).includes('cancel')) {
        // User-initiated stop already finalized the message in handleStop;
        // still make sure the loading indicators are cleared (a provider
        // error containing "canceled" would otherwise leave the dots forever).
        setShowTyping(false);
        setIsLoading(false);
        setRagProgress(null);
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === 'assistant' && last.streaming) {
            return [...prev.slice(0, -1), finalizeAgentTraceOnInterrupt(last)];
          }
          return prev;
        });
        return;
      }
      console.error('Chat error:', err);
      setShowTyping(false);
      setRagProgress(null);
      const rawErr = String(err).replace(/^.*?LLM request failed:\s*/, '');
      const errorText = rawErr || String(err);
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && (last.streaming || last.isAgentStep)) {
          const errorMsg = finalizeAgentTraceOnInterrupt({
            ...last,
            content: errorText,
            isError: true,
          });
          return [...prev.slice(0, -1), errorMsg];
        }
        return prev;
      });
      setIsLoading(false);
    } finally {
      abortControllerRef.current = null;
      setRagProgress(null);
    }
  };

  const [copied, setCopied] = useState(false);
  const handleExecuteExport = async () => {
    if (!exportSessionId) return;
    try {
      if (!state.vaultPath) {
        alert(isZh ? '请先选择知识库路径' : 'Please select a vault path first');
        return;
      }
      setExportIsRunning(true);
      const filePath = await exportChatSession(exportSessionId, exportFormat, state.vaultPath);
      setExportSuccessPath(filePath);
    } catch (e) {
      console.error('Export failed:', e);
      alert(isZh ? `导出失败: ${e}` : `Export failed: ${e}`);
    } finally {
      setExportIsRunning(false);
    }
  };

  const handleCopyPath = () => {
    if (!exportSuccessPath) return;
    navigator.clipboard.writeText(exportSuccessPath);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSendRef = useRef(handleSend);
  useEffect(() => {
    handleSendRef.current = handleSend;
  });

  useEffect(() => {
    const handleAgentTaskEvent = (e: Event) => {
      const customEvent = e as CustomEvent<{ prompt: string; mode?: 'agent' | 'rag' }>;
      if (!customEvent.detail || !customEvent.detail.prompt) return;
      const { prompt, mode: targetMode } = customEvent.detail;
      if (targetMode === 'agent' || targetMode === 'rag') {
        setMode(targetMode);
      }
      handleSendRef.current(prompt, targetMode);
    };

    window.addEventListener('zettel:agent-task', handleAgentTaskEvent);
    return () => {
      window.removeEventListener('zettel:agent-task', handleAgentTaskEvent);
    };
  }, []);

  // Canvas → Chat: 监听画布选中节点事件，自动附加笔记到 Chat
  useEffect(() => {
    const handleCanvasSelectionEvent = (e: Event) => {
      const customEvent = e as CustomEvent<{
        source: 'canvas';
        notes: Array<{ name: string; path: string; nodeId: string }>;
        textNodes: Array<{ name: string; content: string; nodeId: string }>;
        prompt: string;
        timestamp: number;
      }>;

      if (!customEvent.detail || customEvent.detail.source !== 'canvas') return;
      const { notes, textNodes, prompt } = customEvent.detail;

      // 将画布选中的笔记附加到 attachedNotes 状态（标记来源为 canvas）
      const canvasNotes = notes.map(n => ({ name: n.name, path: n.path, source: 'canvas' as const }));
      setAttachedNotes(prev => {
        // 避免重复添加
        const existingPaths = new Set(prev.map(p => p.path));
        const newNotes = canvasNotes.filter(n => !existingPaths.has(n.path));
        return [...prev, ...newNotes];
      });

      // 构建附加上下文的说明（包含文本节点内容）
      let additionalContext = '';
      if (textNodes && textNodes.length > 0) {
        const textContents = textNodes.map(t =>
          `--- Canvas Node: ${t.name} ---\n${t.content}\n--- End ---`
        );
        additionalContext = '\n\nThe user has also selected these canvas text nodes:\n\n' + textContents.join('\n\n');
      }

      // 设置输入框为 prompt + 上下文，但不自动发送
      const fullPrompt = additionalContext
        ? `${prompt}${additionalContext}`
        : prompt;

      // 使用 setInput 更新受控 textarea 的值
      setInput(fullPrompt);
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.style.height = 'auto';
          inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 150) + 'px';
        }
      }, 100);
    };

    window.addEventListener('zettel:canvas-selection', handleCanvasSelectionEvent);
    return () => {
      window.removeEventListener('zettel:canvas-selection', handleCanvasSelectionEvent);
    };
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } };

  const autoResize = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 150) + 'px';
  }, []);

  useEffect(() => {
    if (!input) {
      const el = inputRef.current;
      if (el) el.style.height = 'auto';
    }
  }, [input]);

  if (!state.isChatOpen) {
    return (
      <aside className="panel chat-hidden-panel">
        {/* Keep event listeners alive */}
      </aside>
    );
  }

  return (
    <aside
      className="panel chat-panel"
      style={{ width: '100%', height: '100%', position: 'relative' }}
    >
      <ChatHeader
        mode={mode}
        setMode={handleModeChange}
        searchMode={searchMode}
        setSearchMode={setSearchMode}
        isLoading={isLoading}
        showSessionList={sess.showSessionList}
        setShowSessionList={sess.setShowSessionList}
        toggleChat={toggleChat}
      />

      {/* Session list panel */}
      {sess.showSessionList && (
        <SessionListPanel
          sessions={sess.sessions}
          sessionId={sess.sessionId}
          editingSessionId={sess.editingSessionId}
          editTitle={sess.editTitle}
          lockedSessionId={isLoading ? sess.sessionId : null}
          onLoadSession={handleLoadSession}
          onNewSession={handleNewSession}
          onDelete={(sid) => handleDeleteSession(sid)}
          onStartRename={(sid, title) => { sess.setEditTitle(title); sess.setEditingSessionId(sid); }}
          onRename={sess.handleRenameSession}
          onExport={(sid) => {
            setExportSessionId(sid);
            setExportFormat('markdown');
            setExportSuccessPath(null);
            setExportModalOpen(true);
          }}
          onEditTitleChange={sess.setEditTitle}
        />
      )}

      <ChatMessageList
        messages={messages}
        messagesEndRef={messagesEndRef}
        mode={mode}
        searchMode={searchMode}
        ragProgress={ragProgress}
        showTyping={showTyping}
        isLoading={isLoading}
        expandedToolCalls={expandedToolCalls}
        toggleToolCallExpand={toggleToolCallExpand}
        activeTemplates={activeTemplates}
        onSelectTemplate={(prompt) => {
          setInput(prompt);
          setTimeout(() => {
            autoResize();
            inputRef.current?.focus();
          }, 50);
        }}
        onApprovalResolved={(approvalId, approved) => {
          // 审批卡片已操作:把它从 approval 卡片变形为普通状态消息(避免永久转圈)
          setMessages((prev) => prev.map((m) => {
            if (m.approvalId !== approvalId) return m;
            return {
              ...m,
              isApprovalRequest: false,
              // approved → 前端只显示"已批准";rejected → 显示拒绝原因(由后端 ToolEnd 触发后续)
              content: approved
                ? (isZh ? '✅ 已批准该操作' : '✅ Approved')
                : (isZh ? '🚫 已拒绝该操作' : '🚫 Rejected'),
              isError: !approved,
            };
          }));
        }}
        isZh={isZh}
      />

      <div className="panel-footer">
        {/* Attached notes chips */}
        {attachedNotes.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', padding: '0 0 6px 0' }}>
            {attachedNotes.map((note, idx) => (
              <span
                key={`${note.path}-${idx}`}
                className={`chat-attached-note-chip ${note.source === 'canvas' ? 'from-canvas' : ''}`}
              >
                {note.source === 'canvas' && (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <path d="M3 9h18M9 3v18" />
                  </svg>
                )}
                {note.source !== 'canvas' && (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                )}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{note.name}</span>
                {note.source === 'canvas' && (
                  <span className="chip-canvas-badge">
                    {isZh ? '画布' : 'Canvas'}
                  </span>
                )}
                <button
                  onClick={() => setAttachedNotes(prev => prev.filter((_, i) => i !== idx))}
                  style={{
                    border: 'none', background: 'none', cursor: 'pointer', padding: '0 0 0 2px',
                    color: 'var(--text-tertiary)', fontSize: '14px', lineHeight: 1, display: 'flex',
                  }}
                  title={t('common.remove' as any) || 'Remove'}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Input container V2 — elevated card */}
        <div className="chat-input-container">
          <textarea
            ref={inputRef}
            className="chat-input-textarea"
            rows={1}
            placeholder={mode === 'agent' ? t('chat.agentPlaceholder') : t('chat.placeholder')}
            value={input}
            onChange={(e) => { setInput(e.target.value); autoResize(); }}
            onKeyDown={handleKeyDown}
            disabled={isLoading}
            title={isLoading ? t('chat.inputDisabledTip' as any) : undefined}
          />
          <div className="chat-input-bar">
            <div className="chat-input-bar-left">
              <button
                className={`chat-feature-btn ${webSearch ? 'active-search' : ''}`}
                onClick={() => setWebSearch(prev => !prev)}
                title={isZh ? '联网搜索' : 'Web Search'}
              >
                <IconGlobe size={12} />
                <span>{isZh ? '联网' : 'Web'}</span>
              </button>
            </div>
            <div className="chat-input-bar-right">
              {isLoading ? (
                <button
                  className="chat-send-btn-v2"
                  onClick={handleStop}
                  title={t('chat.stopGeneration' as any)}
                  style={{ background: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--danger-border)' }}
                >
                  <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                </button>
              ) : (
                <button
                  className="chat-send-btn-v2"
                  onClick={() => handleSend()}
                  disabled={!input.trim() && attachedNotes.length === 0}
                  title={!input.trim() ? t('chat.inputEmptyTip' as any) : undefined}
                >
                  <IconSend size={15} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Custom Export Modal */}
      <Modal
        isOpen={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        title={isZh ? '导出聊天会话' : 'Export Chat Session'}
        style={{ maxWidth: '400px', width: '90%' }}
      >
        <div style={{ padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          {!exportSuccessPath ? (
            <>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                {isZh ? '请选择导出格式，会话记录将自动保存至您的当前知识库根目录下。' : 'Please select the export format. The chat log will be saved to your vault root.'}
              </div>
              <div className="export-format-options" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
                <div
                  className={`export-format-card ${exportFormat === 'markdown' ? 'active' : ''}`}
                  onClick={() => setExportFormat('markdown')}
                >
                  <div className="export-format-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  </div>
                  <div className="export-format-title">Markdown</div>
                  <div className="export-format-desc">{isZh ? '适合阅读与归档 (.md)' : 'Best for reading (.md)'}</div>
                </div>

                <div
                  className={`export-format-card ${exportFormat === 'json' ? 'active' : ''}`}
                  onClick={() => setExportFormat('json')}
                >
                  <div className="export-format-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
                  </div>
                  <div className="export-format-title">JSON</div>
                  <div className="export-format-desc">{isZh ? '适合数据分析 (.json)' : 'Best for analysis (.json)'}</div>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                <button className="btn btn-ghost" onClick={() => setExportModalOpen(false)} disabled={exportIsRunning}>
                  {isZh ? '取消' : 'Cancel'}
                </button>
                <button className="btn btn-primary" onClick={handleExecuteExport} disabled={exportIsRunning} style={{ minWidth: '80px' }}>
                  {exportIsRunning ? (isZh ? '导出中...' : 'Exporting...') : (isZh ? '确认导出' : 'Confirm')}
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-3)', padding: 'var(--space-2) 0' }}>
                <div className="export-success-icon">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                </div>
                <div style={{ fontSize: 'var(--text-base)', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {isZh ? '会话导出成功！' : 'Session Exported Successfully!'}
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1.5)' }}>
                <span style={{ fontSize: 'var(--text-xs)', fontWeight: 500, color: 'var(--text-tertiary)' }}>
                  {isZh ? '文件保存路径：' : 'File Saved Path:'}
                </span>
                <input
                  type="text"
                  readOnly
                  value={exportSuccessPath}
                  className="input"
                  style={{
                    fontSize: '11px',
                    fontFamily: 'var(--font-mono)',
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--border-subtle)',
                    padding: '8px 10px',
                    borderRadius: 'var(--radius-md)',
                    color: 'var(--text-secondary)',
                    width: '100%',
                  }}
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                <button className="btn btn-ghost" onClick={handleCopyPath} style={{ minWidth: '90px' }}>
                  {copied ? (isZh ? '已复制！' : 'Copied!') : (isZh ? '复制文件路径' : 'Copy Path')}
                </button>
                <button className="btn btn-primary" onClick={() => setExportModalOpen(false)}>
                  {isZh ? '完成' : 'Done'}
                </button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </aside>
  );
}
