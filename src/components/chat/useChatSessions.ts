import { useState, useCallback } from 'react';
import {
  listChatSessions, getChatSession, createChatSession,
  deleteChatSession, renameChatSession, exportChatSession,
} from '../../lib/tauri';
import type { ChatSession, PlanStep } from '../../lib/tauri';
import { t } from '../../lib/i18n';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: import('../../lib/tauri').SearchResult[];
  timestamp: Date;
  streaming?: boolean;
  toolCalls?: ToolCallInfo[];
  agentThinkingSteps?: string[];
  isAgentStep?: boolean;
  isError?: boolean;
  // Separated chain-of-thought / agent narration. The final answer lives in `content`
  // (Manus/Genspark-style separation at the source, not regex-guessed on the frontend).
  thinkingContent?: string;
  // Unified timeline — interleaves thinking steps and tool calls in chronological order.
  // When present, AgentThoughtStream renders this instead of the grouped sections.
  agentTimeline?: TimelineEntry[];
  // Live plan emitted by the model's `todo_write` tool calls (Cursor-style checklist).
  agentPlanSteps?: PlanStep[];
  // Multi-Agent fields
  agentId?: string;
  agentName?: string;
  agentIcon?: string;
  /** Dev: where the final answer came from (loop / mandatory / timeline …) */
  answerSource?: string;
  /** True while streaming the final Answer block (post-synthesis clear_text). */
  answerStreaming?: boolean;
  /** Turn ended early (user stop or API error) — trace spinners should be off. */
  agentInterrupted?: boolean;
  // Approval gate fields
  isApprovalRequest?: boolean;
  approvalId?: string;
  approvalDescription?: string;
  /** Structured diff data JSON string from backend for real diff view */
  approvalDiffJson?: string;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: string;
  result?: string;
  status: 'pending' | 'running' | 'done' | 'error';
  startTime?: Date;
  endTime?: Date;
  /** Streaming progress stage label (from tool_progress events). */
  progressStage?: string;
  /** Optional partial content preview from tool_progress events. */
  progressPreview?: string;
}

// Unified timeline entry — interleaves thinking, tool calls, and text in chronological order.
// This models the exact event stream: plan → tool → think → tool → text → tool → text …
// 'thought' is the unified type for both `thinking` and `text` events (merged channel).
// 'system_note' surfaces orchestration nudge messages that were previously silently dropped.
export interface TimelineEntry {
  type: 'tool_call' | 'pipeline' | 'thought' | 'system_note';
  content?: string;        // for thinking / text / thought / system_note
  toolCall?: ToolCallInfo;  // for tool_call
  index: number;            // insertion order (monotonic)
  /** Transient pre-execution stage line (routing / loading tools / planning) —
   *  replaced as stages advance, rendered without markdown. */
  isStage?: boolean;
  /** Multi-agent pipeline step (Composite / handoff) */
  pipelineStep?: number;
  pipelineTotal?: number;
  pipelineAgent?: string;
  /** True for the final synthesis/report pass (rendered with a distinct style). */
  isFinal?: boolean;
}

export function useChatSessions(vaultPath: string | null) {
  const [sessionId, setSessionId] = useState<string>(() => Date.now().toString());
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [showSessionList, setShowSessionList] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');

  const refreshSessions = useCallback(() => {
    listChatSessions().then(setSessions).catch(e => console.error('Failed to list sessions:', e));
  }, []);

  const handleNewSession = useCallback(() => {
    const newId = Date.now().toString();
    setSessionId(newId);
    setShowSessionList(false);
    return newId;
  }, []);

  const handleLoadSession = useCallback(async (sid: string): Promise<Message[]> => {
    try {
      const records = await getChatSession(sid);
      const loaded: Message[] = records.map(r => {
        let toolCalls: ToolCallInfo[] | undefined;
        let agentTimeline: TimelineEntry[] | undefined;
        let agentPlanSteps: PlanStep[] | undefined;
        try { toolCalls = r.toolCalls ? JSON.parse(r.toolCalls) : undefined; } catch { toolCalls = undefined; }
        try { agentTimeline = r.agentTimeline ? JSON.parse(r.agentTimeline) : undefined; } catch { agentTimeline = undefined; }
        try { agentPlanSteps = r.planSteps ? JSON.parse(r.planSteps) : undefined; } catch { agentPlanSteps = undefined; }
        // Restored tool calls are historical — normalize any stale pending/running status
        toolCalls = toolCalls?.map(tc =>
          tc.status === 'pending' || tc.status === 'running' ? { ...tc, status: 'done' as const } : tc
        );
        agentTimeline = agentTimeline?.map(e =>
          e.type === 'tool_call' && e.toolCall && (e.toolCall.status === 'pending' || e.toolCall.status === 'running')
            ? { ...e, toolCall: { ...e.toolCall, status: 'done' as const } }
            : e
        );
        // Restored plan steps are historical — an in_progress step can't still be running
        agentPlanSteps = agentPlanSteps?.map(s =>
          s.status === 'in_progress' ? { ...s, status: 'done' as const } : s
        );
        return {
          id: r.id,
          role: r.role as 'user' | 'assistant',
          content: r.content,
          timestamp: new Date(r.createdAt),
          toolCalls,
          sources: r.sources ? JSON.parse(r.sources) : undefined,
          thinkingContent: r.thinkingContent || undefined,
          agentTimeline,
          agentPlanSteps,
        };
      });
      setSessionId(sid);
      setShowSessionList(false);
      return loaded;
    } catch (e) {
      console.error('Failed to load session:', e);
      return [];
    }
  }, []);

  const handleDeleteSession = useCallback(async (sid: string, currentSessionId: string) => {
    try {
      await deleteChatSession(sid);
    } catch (e) {
      console.error('Failed to delete session:', e);
    }
    setSessions(prev => prev.filter(s => s.id !== sid));
    if (sid === currentSessionId) {
      return handleNewSession();
    }
    return null;
  }, [handleNewSession]);

  const handleRenameSession = useCallback(async (sid: string) => {
    if (!editTitle.trim()) return;
    try {
      await renameChatSession(sid, editTitle.trim());
    } catch (e) {
      console.error('Failed to rename session:', e);
    }
    setSessions(prev => prev.map(s => s.id === sid ? { ...s, title: editTitle.trim() } : s));
    setEditingSessionId(null);
  }, [editTitle]);

  const handleExportSession = useCallback(async (sid: string) => {
    try {
      if (!vaultPath) {
        alert('Please select a vault path first / 请先选择知识库路径');
        return;
      }
      const filePath = await exportChatSession(sid, 'markdown', vaultPath);
      alert(t('chat.exportSuccess' as any).replace('{path}', filePath));
    } catch (e) {
      console.error('Export failed:', e);
    }
  }, [vaultPath]);

  const handleCreateSession = useCallback(async (sid: string, title: string, mode: string) => {
    try {
      await createChatSession(sid, title, mode);
    } catch (e) {
      console.error('Failed to create session:', e);
    }
  }, []);

  return {
    sessionId, setSessionId, sessions, setSessions,
    showSessionList, setShowSessionList,
    editingSessionId, setEditingSessionId,
    editTitle, setEditTitle,
    refreshSessions, handleNewSession, handleLoadSession,
    handleDeleteSession, handleRenameSession,
    handleExportSession, handleCreateSession,
  };
}
