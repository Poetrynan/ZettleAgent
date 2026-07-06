/**
 * Agent Thought Stream — Cursor-style agent trace visualization
 *
 * Design principles (ui-ux-pro-max compliant):
 * - SVG icons only, no emojis
 * - Vertical rail timeline with icon nodes (Cursor/Trae style)
 * - Live streaming thought text; older thoughts collapse to 1-line preview
 * - Whole trace collapses to a summary line when the run completes
 * - Keyboard accessible (role/tabIndex/aria-expanded), reduced-motion aware
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { ToolCallInfo, TimelineEntry } from './useChatSessions';
import type { PlanStep } from '../../lib/tauri';
import { t, tf, getLang } from '../../lib/i18n';
import { IconChevronDown } from '../icons';
import { MarkdownRenderer } from '../editor/MarkdownRenderer';
import { isOrchestrationNoise, cleanThoughtForDisplay, extractStageLabelOnly } from './agentAnswer';

// ── Helpers ────────────────────────────────────────────────────────

function isZhLang(): boolean {
  return getLang() === 'zh';
}

function getToolDisplayName(name: string): string {
  const key = `chat.tool.${name}` as any;
  const translated = t(key);
  if (translated !== key) return translated;
  if (name.startsWith('mcp_')) return name.replace('mcp_', '').replace(/_/g, ' ');
  return name.replace(/_/g, ' ');
}

/** Extract a short human-readable summary from tool call JSON arguments. */
function summarizeArguments(args: string): string {
  if (!args || args === '{}') return '';
  try {
    const parsed = JSON.parse(args);
    const preferred = ['path', 'query', 'title', 'name', 'url', 'keyword', 'note_path', 'source_path'];
    for (const key of preferred) {
      if (typeof parsed[key] === 'string' && parsed[key]) {
        return truncate(parsed[key], 48);
      }
    }
    const firstString = Object.values(parsed).find(v => typeof v === 'string' && v);
    if (firstString) return truncate(firstString as string, 48);
    return '';
  } catch {
    return '';
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function formatJson(raw: string, maxLen: number): string {
  const body = raw.length > maxLen ? raw.substring(0, maxLen) + '\n… (truncated)' : raw;
  try { return JSON.stringify(JSON.parse(raw), null, 2).substring(0, maxLen + 200); }
  catch { return body; }
}

/** Human-readable tool result; todo_write never shows bare "ok". */
function formatToolResultDisplay(name: string, result: string): {
  text: string;
  copyText: string;
  outcomeLabel: boolean;
} {
  if (name === 'todo_write') {
    try {
      const parsed = JSON.parse(result) as {
        status?: string;
        steps_total?: number;
        next_required_tool?: string;
      };
      if (parsed.status === 'plan_updated') {
        const count = parsed.steps_total ?? 0;
        const nextTool = parsed.next_required_tool;
        if (nextTool) {
          return {
            text: tf('chat.tool.todo_write.resultWithNext', count, getToolDisplayName(nextTool)),
            copyText: result,
            outcomeLabel: true,
          };
        }
        return {
          text: tf('chat.tool.todo_write.result', count),
          copyText: result,
          outcomeLabel: true,
        };
      }
    } catch {
      /* fall through */
    }
    if (result.trim() === 'ok') {
      return {
        text: t('chat.tool.todo_write.resultLegacy'),
        copyText: result,
        outcomeLabel: true,
      };
    }
  }
  return { text: formatJson(result, 1000), copyText: result, outcomeLabel: false };
}

// ── Tool category icons (inline SVG, 24x24, stroke) ────────────────

type ToolCategory = 'search' | 'read' | 'write' | 'web' | 'graph' | 'canvas' | 'memory' | 'default';

function categorizeToolName(name: string): ToolCategory {
  if (/^(web_search|fetch_web_content)/.test(name)) return 'web';
  if (/search|find_similar|query|resolve_wikilink/.test(name)) return 'search';
  if (/^(read_|batch_read|list_|get_)/.test(name)) return 'read';
  if (/^(create_|edit_|patch_|append_|update_|rename_|move_|merge_|delete_|fix_|extract_|generate_|trigger_|rebuild_|propagate_)/.test(name)) return 'write';
  if (/graph|relation|backlink|link/.test(name)) return 'graph';
  if (/canvas/.test(name)) return 'canvas';
  if (/memory/.test(name)) return 'memory';
  return 'default';
}

function ToolIcon({ category, size = 13 }: { category: ToolCategory; size?: number }) {
  const common = {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  };
  switch (category) {
    case 'search':
      return <svg {...common}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>;
    case 'read':
      return <svg {...common}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>;
    case 'write':
      return <svg {...common}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>;
    case 'web':
      return <svg {...common}><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>;
    case 'graph':
      return <svg {...common}><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>;
    case 'canvas':
      return <svg {...common}><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>;
    case 'memory':
      return <svg {...common}><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><line x1="10" y1="12" x2="14" y2="12"/></svg>;
    default:
      return <svg {...common}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>;
  }
}

function ThoughtIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z"/>
      <line x1="9" y1="21" x2="15" y2="21"/>
    </svg>
  );
}

// ── Status indicator (spinner / check / cross) ─────────────────────

function StatusIndicator({ status, size = 13 }: { status: string; size?: number }) {
  if (status === 'running') {
    return (
      <svg className="trace-spinner" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-label="running">
        <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
      </svg>
    );
  }
  if (status === 'done') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--success, #16a34a)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-label="done">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    );
  }
  if (status === 'error') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--danger, #dc2626)" strokeWidth="2.5" strokeLinecap="round" aria-label="error">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    );
  }
  // pending
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-label="pending" opacity={0.45}>
      <circle cx="12" cy="12" r="9"/>
    </svg>
  );
}

// ── Copy-to-clipboard mini button ──────────────────────────────────

function TraceCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  }, [text]);
  return (
    <button className="trace-copy-btn" onClick={onCopy} aria-label={copied ? 'Copied' : 'Copy'} title={copied ? (isZhLang() ? '已复制' : 'Copied') : (isZhLang() ? '复制' : 'Copy')}>
      {copied ? (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--success, #16a34a)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      ) : (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      )}
    </button>
  );
}

// ── Elapsed-time hook (for running tools) ──────────────────────────

function useElapsed(tc?: ToolCallInfo): number | null {
  const [elapsed, setElapsed] = useState<number | null>(null);
  useEffect(() => {
    if (!tc) { setElapsed(null); return; }
    if (tc.status === 'running' && tc.startTime) {
      const start = new Date(tc.startTime).getTime();
      const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000));
      tick();
      const interval = setInterval(tick, 1000);
      return () => clearInterval(interval);
    }
    if (tc.status === 'done' && tc.startTime && tc.endTime) {
      setElapsed(Math.floor((new Date(tc.endTime).getTime() - new Date(tc.startTime).getTime()) / 1000));
    } else {
      setElapsed(null);
    }
  }, [tc?.status, tc?.startTime, tc?.endTime]);
  return elapsed;
}

// ── Trace entry: tool call ─────────────────────────────────────────

function TraceToolItem({
  tc, isExpanded, onToggle, isLast,
}: {
  tc: ToolCallInfo; isExpanded: boolean; onToggle: () => void; isLast: boolean;
}) {
  const elapsed = useElapsed(tc);
  const argSummary = summarizeArguments(tc.arguments);
  const category = categorizeToolName(tc.name);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
  };

  return (
    <div className={`trace-item trace-item-tool status-${tc.status} ${isLast ? 'trace-item-last' : ''}`}>
      <div className="trace-node" aria-hidden="true">
        <ToolIcon category={category} />
      </div>
      <div className="trace-body">
        <div
          className="trace-row"
          role="button"
          tabIndex={0}
          aria-expanded={isExpanded}
          onClick={onToggle}
          onKeyDown={handleKey}
        >
          <span className="trace-tool-name">{getToolDisplayName(tc.name)}</span>
          {argSummary && <span className="trace-arg-summary">{argSummary}</span>}
          <span className="trace-row-meta">
            {elapsed !== null && elapsed >= 1 && (
              <span className="trace-duration">{elapsed}s</span>
            )}
            <StatusIndicator status={tc.status} />
            <span className={`trace-chevron ${isExpanded ? 'open' : ''}`} aria-hidden="true">
              <IconChevronDown size={12} />
            </span>
          </span>
        </div>
        {tc.status === 'running' && tc.progressStage && (
          <div className="trace-tool-progress">
            <span className="trace-tool-progress-stage">{tc.progressStage}</span>
            {tc.progressPreview && (
              <span className="trace-tool-progress-preview">{tc.progressPreview.slice(0, 200)}</span>
            )}
          </div>
        )}
        {isExpanded && (
          <div className="trace-detail">
            {tc.arguments && tc.arguments !== '{}' && (
              <div className="trace-detail-section">
                <div className="trace-detail-label">
                  {isZhLang() ? '参数' : 'Arguments'}
                  <TraceCopyButton text={tc.arguments} />
                </div>
                <pre className="trace-detail-code">{formatJson(tc.arguments, 1000)}</pre>
              </div>
            )}
            {tc.result && (() => {
              const formatted = formatToolResultDisplay(tc.name, tc.result);
              return (
              <div className="trace-detail-section">
                <div className="trace-detail-label">
                  {formatted.outcomeLabel
                    ? t('chat.tool.todo_write.outcomeLabel')
                    : (isZhLang() ? '结果' : 'Result')}
                  <TraceCopyButton text={formatted.copyText} />
                </div>
                <pre className={`trace-detail-code${formatted.outcomeLabel ? ' trace-detail-prose' : ''}`}>{formatted.text}</pre>
              </div>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Trace entry: thought ───────────────────────────────────────────

function TraceThoughtItem({
  content, isLive, isExpanded, onToggle, isLast, isStage, stageActive,
}: {
  content: string; isLive: boolean; isExpanded: boolean; onToggle: () => void; isLast: boolean; isStage?: boolean; stageActive?: boolean;
}) {
  const isZh = isZhLang();
  // Live (currently streaming) thought shows full text; older ones show 1-line preview
  const showFull = isLive || isExpanded;
  const displayContent = cleanThoughtForDisplay(content);
  const preview = displayContent.replace(/\s+/g, ' ').trim();

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
  };

  if (isStage) {
    return (
      <div className={`trace-item trace-item-stage ${isLast ? 'trace-item-last' : ''}`}>
        <div className="trace-node trace-node-stage" aria-hidden="true">
          <StatusIndicator status={stageActive ? 'running' : 'pending'} size={11} />
        </div>
        <div className="trace-body">
          <span className="trace-stage-label">{extractStageLabelOnly(content)}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`trace-item trace-item-thought ${isLive ? 'trace-item-live' : ''} ${isLast ? 'trace-item-last' : ''}`}>
      <div className="trace-node trace-node-thought" aria-hidden="true">
        <ThoughtIcon />
      </div>
      <div className="trace-body">
        {showFull ? (
          <div
            className="trace-thought-full"
            role={isLive ? undefined : 'button'}
            tabIndex={isLive ? undefined : 0}
            aria-expanded={isLive ? undefined : true}
            onClick={isLive ? undefined : onToggle}
            onKeyDown={isLive ? undefined : handleKey}
          >
            <span className="trace-thought-label">
              {isLive ? (isZh ? '思考中' : 'Thinking') : (isZh ? '思考' : 'Thought')}
            </span>
            <div className="trace-thought-text">
              <MarkdownRenderer content={displayContent || content} className="chat-markdown" />
            </div>
          </div>
        ) : (
          <div
            className="trace-row"
            role="button"
            tabIndex={0}
            aria-expanded={false}
            onClick={onToggle}
            onKeyDown={handleKey}
          >
            <span className="trace-thought-label">{isZh ? '思考' : 'Thought'}</span>
            <span className="trace-thought-preview trace-thought-preview-clamp">{preview}</span>
            <span className="trace-row-meta">
              <span className="trace-chevron" aria-hidden="true"><IconChevronDown size={12} /></span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Plan checklist (model-driven via todo_write) ───────────────────

function PlanChecklist({ steps, isStreaming }: { steps: PlanStep[]; isStreaming: boolean }) {
  const isZh = isZhLang();
  if (steps.length === 0) return null;
  const doneCount = steps.filter(s => s.status === 'done').length;
  const inProgress = steps.find(s => s.status === 'in_progress');

  return (
    <div className={`agent-plan-checklist ${isStreaming ? 'streaming' : 'finished'}`}>
      <div className="agent-plan-header">
        <PlanIcon />
        <span className="agent-plan-title">{isZh ? '计划' : 'Plan'}</span>
        <span className="agent-plan-progress">{doneCount}/{steps.length}</span>
      </div>
      <ul className="agent-plan-list" role="list">
        {steps.map((step, idx) => (
          <li
            key={idx}
            className={`agent-plan-step status-${step.status} ${step.status === 'in_progress' && isStreaming ? 'live' : ''}`}
          >
            <span className="agent-plan-step-icon" aria-hidden="true">
              {step.status === 'done' ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--success, #16a34a)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-label="done">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              ) : step.status === 'in_progress' && isStreaming ? (
                <svg className="trace-spinner" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-label="in progress">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                </svg>
              ) : step.status === 'in_progress' ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-label="interrupted" opacity={0.45}>
                  <circle cx="12" cy="12" r="9"/>
                  <line x1="8" y1="12" x2="16" y2="12"/>
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-label="pending" opacity={0.45}>
                  <circle cx="12" cy="12" r="9"/>
                </svg>
              )}
            </span>
            <span className="agent-plan-step-text">{step.text}</span>
          </li>
        ))}
      </ul>
      {isStreaming && inProgress && (
        <div className="agent-plan-current" aria-live="polite">
          {isZh ? '当前：' : 'Now: '}{inProgress.text}
        </div>
      )}
    </div>
  );
}

function PlanIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l3 3L22 4"/>
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
    </svg>
  );
}

// ── Main component ─────────────────────────────────────────────────

type ChainItem =
  | { kind: 'thought'; id: string; content: string; isStage?: boolean }
  | { kind: 'system_note'; id: string; content: string }
  | { kind: 'pipeline'; id: string; content: string; step?: number; total?: number }
  | { kind: 'tool'; id: string; toolCall: ToolCallInfo };

export function AgentThoughtStream({
  steps,
  toolCalls,
  isStreaming,
  expandedToolCalls,
  toggleToolCallExpand,
  agentTimeline,
  planSteps,
  interrupted,
  terminalError,
}: {
  steps: string[];
  toolCalls?: ToolCallInfo[];
  isStreaming: boolean;
  expandedToolCalls: Set<string>;
  toggleToolCallExpand: (id: string) => void;
  agentTimeline?: TimelineEntry[];
  planSteps?: PlanStep[];
  /** Turn stopped early (cancel / API error) — no live spinners. */
  interrupted?: boolean;
  /** Show error styling on the trace header (API failure). */
  terminalError?: boolean;
}) {
  const isZh = isZhLang();
  const [expandedThoughts, setExpandedThoughts] = useState<Set<string>>(new Set());
  // Trace container: open while streaming, auto-collapse to summary when done
  const [traceOpen, setTraceOpen] = useState(isStreaming);
  const wasStreaming = useRef(isStreaming);

  useEffect(() => {
    if (!wasStreaming.current && isStreaming) {
      setTraceOpen(true);
    }
    wasStreaming.current = isStreaming;
  }, [isStreaming]);

  const toggleThought = useCallback((id: string) => {
    setExpandedThoughts(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  // Build unified chain from timeline (preferred) or legacy steps/toolCalls
  const chain = useMemo<ChainItem[]>(() => {
    if (agentTimeline && agentTimeline.length > 0) {
      const items: ChainItem[] = [];
      agentTimeline.forEach((entry, idx) => {
        if (entry.type === 'system_note' && entry.content?.trim()) {
          // Orchestration nudges (plan guard, budget, stagnation…) — surface
          // them so the user can see WHY the model was redirected, instead of
          // silently dropping the text.
          items.push({ kind: 'system_note', id: `snote-${idx}`, content: entry.content.trim() });
        } else if (entry.type === 'thought' && entry.content?.trim()) {
          const cleaned = cleanThoughtForDisplay(entry.content);
          if (!cleaned || isOrchestrationNoise(cleaned)) return;
          items.push({
            kind: 'thought',
            id: `thought-${idx}`,
            content: cleaned,
            isStage: entry.isStage,
          });
        } else if (entry.type === 'pipeline' && entry.content?.trim()) {
          items.push({
            kind: 'pipeline',
            id: `pipeline-${idx}`,
            content: entry.content,
            step: entry.pipelineStep,
            total: entry.pipelineTotal,
          });
        } else if (entry.type === 'tool_call' && entry.toolCall) {
          items.push({ kind: 'tool', id: `tool-${entry.toolCall.id}`, toolCall: entry.toolCall });
        }
      });
      return items;
    }
    // Legacy fallback: steps then tools
    const items: ChainItem[] = steps
      .filter(s => s.trim())
      .map((s, i) => ({ kind: 'thought' as const, id: `step-${i}`, content: s }));
    (toolCalls || []).forEach(tc => items.push({ kind: 'tool', id: `tool-${tc.id}`, toolCall: tc }));
    return items;
  }, [agentTimeline, steps, toolCalls, isStreaming]);

  if (chain.length === 0) return null;

  const toolCount = chain.filter(c => c.kind === 'tool').length;
  const pipelineCount = chain.filter(c => c.kind === 'pipeline').length;
  const thoughtCount = chain.length - toolCount - pipelineCount;
  const hasToolError = chain.some(c => c.kind === 'tool' && c.toolCall.status === 'error');
  const hasError = terminalError || hasToolError;
  const runningTool = isStreaming
    ? [...chain].reverse().find(
        (c): c is Extract<ChainItem, { kind: 'tool' }> => c.kind === 'tool' && c.toolCall.status === 'running'
      )
    : undefined;

  // Header label
  let headerLabel: string;
  if (isStreaming) {
    headerLabel = runningTool
      ? (isZh ? `正在运行 ${getToolDisplayName(runningTool.toolCall.name)}…` : `Running ${getToolDisplayName(runningTool.toolCall.name)}…`)
      : (isZh ? '思考中…' : 'Thinking…');
  } else if (interrupted) {
    headerLabel = terminalError
      ? (isZh ? '已中断' : 'Interrupted')
      : (isZh ? '已停止' : 'Stopped');
  } else {
    const parts: string[] = [];
    if (thoughtCount > 0) parts.push(isZh ? `${thoughtCount} 步思考` : `${thoughtCount} thought${thoughtCount > 1 ? 's' : ''}`);
    if (toolCount > 0) parts.push(isZh ? `${toolCount} 次工具调用` : `${toolCount} tool call${toolCount > 1 ? 's' : ''}`);
    if (pipelineCount > 0) parts.push(isZh ? `${pipelineCount} 步流水线` : `${pipelineCount} pipeline step${pipelineCount > 1 ? 's' : ''}`);
    headerLabel = (isZh ? '已完成' : 'Completed') + (parts.length ? ' · ' + parts.join(' · ') : '');
  }

  const handleHeaderKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTraceOpen(o => !o); }
  };

  return (
    <div className={`agent-trace ${isStreaming ? 'streaming' : 'finished'}`}>
      {/* Summary header — always visible, toggles the trace body */}
      <div
        className={`agent-trace-header ${isStreaming ? 'shimmer' : ''}`}
        role="button"
        tabIndex={0}
        aria-expanded={traceOpen}
        onClick={() => setTraceOpen(o => !o)}
        onKeyDown={handleHeaderKey}
      >
        <span className="agent-trace-header-icon" aria-hidden="true">
          {isStreaming ? <StatusIndicator status="running" /> : hasError ? <StatusIndicator status="error" /> : <ThoughtIcon />}
        </span>
        <span className="agent-trace-header-label">{headerLabel}</span>
        <span className={`trace-chevron ${traceOpen ? 'open' : ''}`} aria-hidden="true">
          <IconChevronDown size={13} />
        </span>
      </div>

      {/* Trace body — directly under the header when expanded */}
      {traceOpen && (
        <div className="agent-trace-body">
          {chain.map((item, idx) => {
            const isLast = idx === chain.length - 1;
            if (item.kind === 'pipeline') {
              return (
                <div key={item.id} className="agent-trace-pipeline-row">
                  <span className="agent-trace-pipeline-label">{item.content}</span>
                </div>
              );
            }
            if (item.kind === 'system_note') {
              return (
                <div key={item.id} className="trace-item trace-item-system-note">
                  <div className="trace-node trace-node-system-note" aria-hidden="true">
                    <span className="trace-system-note-icon">⚠</span>
                  </div>
                  <div className="trace-body">
                    <span className="trace-system-note-label">{isZh ? '系统提示' : 'System'}</span>
                    <span className="trace-system-note-text">{item.content}</span>
                  </div>
                </div>
              );
            }
            if (item.kind === 'thought') {
              const isLive = isStreaming && isLast;
              return (
                <TraceThoughtItem
                  key={item.id}
                  content={item.content}
                  isLive={isLive && !item.isStage}
                  isExpanded={expandedThoughts.has(item.id)}
                  onToggle={() => toggleThought(item.id)}
                  isLast={isLast}
                  isStage={item.isStage}
                  stageActive={isStreaming && isLast && !!item.isStage}
                />
              );
            }
            return (
              <TraceToolItem
                key={item.id}
                tc={item.toolCall}
                isExpanded={expandedToolCalls.has(item.toolCall.id)}
                onToggle={() => toggleToolCallExpand(item.toolCall.id)}
                isLast={isLast}
              />
            );
          })}
        </div>
      )}

      {/* Live plan checklist — below trace details so expand does not jump past the plan block */}
      {planSteps && planSteps.length > 0 && (
        <PlanChecklist steps={planSteps} isStreaming={isStreaming} />
      )}
    </div>
  );
}

// ── Thinking Block (standalone collapsible, used for RAG/simple mode) ──

export function ThinkingBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const isZh = isZhLang();

  return (
    <div className="thinking-block">
      <button
        className="thinking-block-toggle"
        onClick={() => setExpanded(prev => !prev)}
        aria-expanded={expanded}
      >
        <ThoughtIcon size={12} />
        <span>{isZh ? '思考过程' : 'Thinking Process'}</span>
        <span className={`trace-chevron ${expanded ? 'open' : ''}`} aria-hidden="true">
          <IconChevronDown size={13} />
        </span>
      </button>
      {expanded && (
        <div className="thinking-block-content">
          <MarkdownRenderer content={content} className="chat-markdown" />
        </div>
      )}
    </div>
  );
}

// ── Tool Call Bubble (legacy standalone, used by non-timeline fallback) ──

export function ToolCallBubble({ tc, isExpanded, onToggle }: { tc: ToolCallInfo; isExpanded: boolean; onToggle: () => void }) {
  const elapsed = useElapsed(tc);
  const argSummary = summarizeArguments(tc.arguments);
  const category = categorizeToolName(tc.name);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
  };

  return (
    <div className={`tool-call-bubble status-${tc.status}`}>
      <div
        className="tool-call-header"
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        onClick={onToggle}
        onKeyDown={handleKey}
      >
        <span className="tool-call-icon" aria-hidden="true"><ToolIcon category={category} /></span>
        <span className="tool-call-name">{getToolDisplayName(tc.name)}</span>
        {argSummary && <span className="trace-arg-summary">{argSummary}</span>}
        {elapsed !== null && elapsed >= 1 && (
          <span className="tool-call-duration">{elapsed}s</span>
        )}
        <StatusIndicator status={tc.status} />
        <span className={`trace-chevron ${isExpanded ? 'open' : ''}`} aria-hidden="true">
          <IconChevronDown size={12} />
        </span>
      </div>
      {tc.status === 'running' && tc.progressStage && (
        <div className="trace-tool-progress">
          <span className="trace-tool-progress-stage">{tc.progressStage}</span>
          {tc.progressPreview && (
            <span className="trace-tool-progress-preview">{tc.progressPreview.slice(0, 200)}</span>
          )}
        </div>
      )}

      {isExpanded && (
        <div className="tool-call-detail">
          {tc.arguments && tc.arguments !== '{}' && (
            <div className="trace-detail-section">
              <div className="trace-detail-label">
                {isZhLang() ? '参数' : 'Arguments'}
                <TraceCopyButton text={tc.arguments} />
              </div>
              <pre className="trace-detail-code">{formatJson(tc.arguments, 800)}</pre>
            </div>
          )}
          {tc.result && (() => {
            const formatted = formatToolResultDisplay(tc.name, tc.result);
            return (
            <div className="trace-detail-section">
              <div className="trace-detail-label">
                {formatted.outcomeLabel
                  ? t('chat.tool.todo_write.outcomeLabel')
                  : (isZhLang() ? '结果' : 'Result')}
                <TraceCopyButton text={formatted.copyText} />
              </div>
              <pre className={`trace-detail-code${formatted.outcomeLabel ? ' trace-detail-prose' : ''}`}>{formatted.text}</pre>
            </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// ── Typing Indicator ───────────────────────────────────────────────

export function TypingIndicator() {
  return (
    <div className="typing-indicator" aria-label="typing">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="typing-dot"
          style={{ animation: `typingBounce 1.2s ease-in-out ${i * 0.15}s infinite` }}
        />
      ))}
    </div>
  );
}

// ── RAG Progress Indicator ─────────────────────────────────────────

const RAG_STEPS_FTS = [
  { key: 'searching', label: 'Searching…' },
  { key: 'context',   label: 'Building context…' },
  { key: 'generating', label: 'Generating…' },
];

const RAG_STEPS_VECTOR = [
  { key: 'embedding', label: 'Embedding…' },
  { key: 'searching', label: 'Searching…' },
  { key: 'context',   label: 'Building context…' },
  { key: 'generating', label: 'Generating…' },
];

export function RagProgressIndicator({ stage, searchMode }: { stage: string; searchMode?: string }) {
  const steps = (searchMode === 'hybrid' || searchMode === 'vector') ? RAG_STEPS_VECTOR : RAG_STEPS_FTS;
  const currentIdx = steps.findIndex(s => s.key === stage);

  return (
    <div className="rag-progress">
      {steps.map((step, i) => {
        const isDone = i < currentIdx;
        const isActive = i === currentIdx;
        return (
          <div
            key={step.key}
            className={`rag-progress-step ${isDone ? 'done' : ''} ${isActive ? 'active' : ''}`}
          >
            <span className="rag-progress-icon" aria-hidden="true">
              {isDone
                ? <StatusIndicator status="done" size={11} />
                : isActive
                  ? <StatusIndicator status="running" size={11} />
                  : <StatusIndicator status="pending" size={11} />}
            </span>
            <span className="rag-progress-label">{step.label}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Icon Sync (kept for backward-compat imports) ───────────────────

export function IconSync({ size = 16, spinning = false }: { size?: number; spinning?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={spinning ? 'animate-spin' : ''}>
      <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
    </svg>
  );
}

export default AgentThoughtStream;
