import { useState, useCallback, useEffect, useRef, RefObject } from 'react';
import type { ReactNode } from 'react';
import { Message } from './useChatSessions';
import {
  IconRobot,
  IconCheck,
  IconClipboard,
  IconSearch,
  IconWarning,
} from '../icons';
import { t } from '../../lib/i18n';
import { MarkdownRenderer } from '../editor/MarkdownRenderer';
import {
  AgentThoughtStream,
  ToolCallBubble,
  ThinkingBlock,
  RagProgressIndicator,
  TypingIndicator,
} from './AgentThoughtStream';
import { DiffApprovalCard } from './DiffApprovalCard';

// ── Helpers ────────────────────────────────────────────────────────

// Separate chain-of-thought from the final answer ONLY via reliable structured
// markers (DeepSeek-style <think></think> tags). We do NOT guess by paragraph
// patterns (e.g. "思考：/Step/Action:"), which is exactly what mixed CoT into the
// answer — Manus/Genspark keep reasoning in a dedicated channel, never regex-parsed text.
function extractThinkTags(content: string): { thinking: string; answer: string } {
  const tagRegex = /<think>([\s\S]*?)(?:<\/think>|$)/gi;
  const thinkingParts: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(content)) !== null) {
    const part = match[1].trim();
    if (part) thinkingParts.push(part);
  }
  const answer = thinkingParts.length > 0
    ? content.replace(tagRegex, '').trim()
    : content;
  return { thinking: thinkingParts.join('\n\n'), answer };
}

// Resolve what goes into the ThinkingBlock vs the MarkdownRenderer for a message.
// Agent narration (already split off into `thinkingContent` by the streaming layer)
// takes precedence; otherwise fall back to extracting <think> tags from `content`.
function resolveThinkingAndAnswer(msg: Message): { thinking: string; answer: string } {
  const hasToolCalls = !!(msg.toolCalls && msg.toolCalls.length > 0);
  // While an agent step is still streaming, the accumulating text is narration —
  // don't render it as the answer yet (a typing indicator shows instead).
  if (msg.streaming && msg.isAgentStep && hasToolCalls && !msg.thinkingContent) {
    return { thinking: msg.content, answer: '' };
  }
  if (msg.thinkingContent) {
    return { thinking: msg.thinkingContent, answer: msg.content };
  }
  return extractThinkTags(msg.content);
}

function parseErrorMessage(raw: string, isZh = true): string {
  const lower = raw.toLowerCase();
  if (lower.includes('error decoding response body') || lower.includes('invalid json') || lower.includes('empty response body')) {
    return isZh
      ? 'LLM API 返回无法解析的响应（连接中断、空响应体或非 JSON）。请检查 API 余额、网络与上下文长度。'
      : 'The LLM API returned a response that could not be decoded. Check API balance, network, and context size.';
  }
  if (lower.includes('api key') || lower.includes('unauthorized')) {
    return t('chat.errorApiKey' as any) || 'Invalid API Key. Please verify settings.';
  }
  if (lower.includes('model_not_found') || lower.includes('not found')) {
    return t('chat.errorModel' as any) || 'Model not found or unauthorized.';
  }
  if (lower.includes('rate limit') || lower.includes('too many requests')) {
    return t('chat.errorRateLimit' as any) || 'Rate limit exceeded. Please retry later.';
  }
  return raw;
}

// ── Copy Button Component ───────────────────────────────────────────

export function CopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = content;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [content]);

  return (
    <button
      className="chat-copy-btn"
      onClick={handleCopy}
      title={copied ? 'Copied!' : 'Copy'}
    >
      {copied ? <IconCheck size={13} /> : <IconClipboard size={13} />}
    </button>
  );
}

// ── Message action buttons ─────────────────────────────────────────
// Hover-revealed regenerate / edit / retry actions. They share the "reset the
// conversation to this point and re-run" primitive on the parent — this UI
// layer just decides which anchor to point at.

function IconRegenerate({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  );
}

function IconEdit({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  );
}

function RegenerateButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button className="chat-msg-action-btn" onClick={onClick} title={label} aria-label={label}>
      <IconRegenerate size={13} />
    </button>
  );
}

function EditButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button className="chat-msg-action-btn" onClick={onClick} title={label} aria-label={label}>
      <IconEdit size={13} />
    </button>
  );
}

/**
 * Inline editor over a user message. Enter submits, Shift+Enter newlines,
 * Escape cancels. Committing calls `onSubmit` with the trimmed content —
 * parent handles truncation and resend.
 */
function UserMessageEditor({
  initial, onSubmit, onCancel, isZh,
}: { initial: string; onSubmit: (v: string) => void; onCancel: () => void; isZh: boolean }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Place caret at end and auto-grow to fit initial content.
    el.setSelectionRange(el.value.length, el.value.length);
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 300)}px`;
  }, []);
  const commit = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== initial.trim()) onSubmit(trimmed);
    else onCancel();
  };
  return (
    <div className="chat-user-edit">
      <textarea
        ref={ref}
        className="chat-user-edit-textarea"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          const el = e.currentTarget;
          el.style.height = 'auto';
          el.style.height = `${Math.min(el.scrollHeight, 300)}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
      />
      <div className="chat-user-edit-actions">
        <button className="chat-user-edit-btn" onClick={onCancel}>{isZh ? '取消' : 'Cancel'}</button>
        <button className="chat-user-edit-btn primary" onClick={commit}>
          {isZh ? '发送' : 'Send'}
        </button>
      </div>
    </div>
  );
}

// ── Main Messages List component ───────────────────────────────────

interface ChatMessageListProps {
  messages: Message[];
  messagesEndRef: RefObject<HTMLDivElement | null>;
  mode: 'agent' | 'rag';
  searchMode: string;
  ragProgress: string | null;
  showTyping: boolean;
  isLoading: boolean;
  expandedToolCalls: Set<string>;
  toggleToolCallExpand: (id: string) => void;
  activeTemplates?: {
    id: string;
    icon: ReactNode;
    label: string;
    labelZh: string;
    prompt: string;
    promptZh: string;
    description: string;
    descriptionZh: string;
  }[];
  onSelectTemplate?: (prompt: string) => void;
  /** 审批卡片解决回调(approved/rejected 后由父组件移除卡片) */
  onApprovalResolved?: (approvalId: string, approved: boolean) => void;
  /** Redo the AI reply at this index (walks back to its prompting user turn). */
  onRegenerate?: (assistantIndex: number) => void;
  /** Replace the user message at this index and re-run from there. */
  onEditResend?: (userIndex: number, newContent: string) => void;
  /** Re-run the turn that produced the failed reply at this index. */
  onRetryError?: (assistantIndex: number) => void;
  /** Scroll handler on the scrollable message container (drives stick-to-bottom). */
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
  /** Show the floating scroll-to-bottom button. */
  showScrollToBottom?: boolean;
  /** Jump back to the newest message. */
  onScrollToBottom?: () => void;
  isZh?: boolean;
}

export function ChatMessageList({
  messages,
  messagesEndRef,
  mode,
  searchMode,
  ragProgress,
  showTyping,
  isLoading,
  expandedToolCalls,
  toggleToolCallExpand,
  activeTemplates = [],
  onSelectTemplate,
  onApprovalResolved,
  onRegenerate,
  onEditResend,
  onRetryError,
  onScroll,
  showScrollToBottom,
  onScrollToBottom,
  isZh = true,
}: ChatMessageListProps) {
  // Index of the user message currently being edited inline, if any.
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  return (
    <div className="panel-content chat-scroll-area" style={{ padding: 0, position: 'relative' }} onScroll={onScroll}
      role="log" aria-live="polite" aria-relevant="additions text">
      {messages.length === 0 ? (
        <div className="chat-empty-state">
          <div className="chat-empty-icon">
            {mode === 'agent' ? <IconRobot size={24} /> : <IconSearch size={24} />}
          </div>
          <div className="chat-empty-title">
            {t('chat.askAnything')}
          </div>
          <div className="chat-empty-desc">
            {mode === 'agent' ? t('chat.agentDesc') : t('chat.ragDesc')}
          </div>

          {/* Starting points, not decoration: each one is a real prompt that
              gets loaded into the composer so the user can edit before sending. */}
          {activeTemplates && activeTemplates.length > 0 && (
            <div className="chat-empty-templates">
              {activeTemplates.map((tmpl) => {
                const desc = isZh ? tmpl.descriptionZh : tmpl.description;
                const prompt = isZh ? tmpl.promptZh : tmpl.prompt;
                return (
                  <button
                    key={tmpl.id}
                    onClick={() => onSelectTemplate?.(prompt)}
                    className="chat-empty-template-card"
                  >
                    <span className="chat-empty-template-icon" aria-hidden="true">{tmpl.icon}</span>
                    <div className="chat-empty-template-body">
                      <span className="chat-empty-template-label">
                        {isZh ? tmpl.labelZh : tmpl.label}
                      </span>
                      <span className="chat-empty-template-desc">
                        {desc}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="chat-turn-list">
          {messages.map((msg, idx) => (
            <div key={msg.id} className={`chat-turn ${msg.role === 'user' ? 'chat-turn-user' : 'chat-turn-agent'}`}>
              <div className="chat-turn-col">
              <div className={`chat-turn-body ${msg.role === 'user' ? 'chat-turn-body-user' : ''}`}>
                {/* Which sub-agent answered. Only shown when there is one to name,
                    so the common single-agent case carries no chrome at all. */}
                {msg.role === 'assistant' && msg.agentName && (
                  <div className="chat-turn-agent-label">{msg.agentName}</div>
                )}
                {/* Agent Work Stream — show from first frame when isAgentStep or timeline exists */}
                {(msg.isAgentStep || (msg.agentTimeline && msg.agentTimeline.length > 0)) ? (
                  <AgentThoughtStream
                    steps={msg.agentThinkingSteps || []}
                    toolCalls={msg.toolCalls}
                    isStreaming={msg.streaming || false}
                    interrupted={!!msg.agentInterrupted}
                    terminalError={!!msg.isError}
                    expandedToolCalls={expandedToolCalls}
                    toggleToolCallExpand={toggleToolCallExpand}
                    agentTimeline={msg.agentTimeline}
                    planSteps={msg.agentPlanSteps}
                  />
                ) : (
                  /* Fallback for other sessions that only have toolCalls */
                  msg.toolCalls && msg.toolCalls.length > 0 && (
                    <div className="tool-calls-container">
                      {msg.toolCalls.map(tc => (
                        <ToolCallBubble
                          key={tc.id}
                          tc={tc}
                          isExpanded={expandedToolCalls.has(tc.id)}
                          onToggle={() => toggleToolCallExpand(tc.id)}
                        />
                      ))}
                    </div>
                  )
                )}
                {/* Message Content */}
                {msg.role === 'assistant' ? (
                  (() => {
                    if (msg.isApprovalRequest && msg.approvalId) {
                      return (
                        <DiffApprovalCard
                          approvalId={msg.approvalId}
                          actionDescription={msg.approvalDescription || ''}
                          diffJson={msg.approvalDiffJson}
                          onResolved={(approved) => {
                            // 通知父组件移除/标记该审批卡片
                            onApprovalResolved?.(msg.approvalId!, approved);
                          }}
                          lang={isZh ? 'zh' : 'en'}
                        />
                      );
                    }
                    if (msg.isError) {
                      return (
                        <div className="chat-turn-error" role="alert">
                          <IconWarning size={14} />
                          <span>{parseErrorMessage(msg.content, isZh)}</span>
                        </div>
                      );
                    }
                    const hasTimeline = !!(msg.agentTimeline && msg.agentTimeline.length > 0);
                    const isAgentLayout = !!(msg.isAgentStep || hasTimeline);
                    const streamingAnswer = msg.content?.trim() ?? '';
                    // Agent layout: answer only during explicit synthesis stream (answerStreaming).
                    // Pre-tool narration lives in AgentThoughtStream — never the plain bubble.
                    if (isAgentLayout && msg.streaming && streamingAnswer && msg.answerStreaming) {
                      return (
                        <>
                          {msg.thinkingContent && <ThinkingBlock content={msg.thinkingContent} />}
                          <div className="chat-answer-divider">
                            <span>{isZh ? '回答' : 'Answer'}</span>
                          </div>
                          <MarkdownRenderer content={streamingAnswer} className="chat-markdown" />
                          <span className="chat-stream-cursor" aria-hidden="true" />
                        </>
                      );
                    }
                    if (isAgentLayout && msg.streaming) {
                      return null;
                    }
                    const { thinking, answer } = resolveThinkingAndAnswer(msg);
                    const showThinkingBlock = thinking && !hasTimeline;
                    // Show divider when there's both thinking/tool content AND a final answer
                    const showDivider = (hasTimeline || showThinkingBlock) && answer;
                    return (
                      <>
                        {showThinkingBlock && <ThinkingBlock content={thinking} />}
                        {showDivider && (
                          <div className="chat-answer-divider">
                            <span>{isZh ? '回答' : 'Answer'}</span>
                          </div>
                        )}
                        {answer && <MarkdownRenderer content={answer} className="chat-markdown" />}
                        {/* Blinking caret so "still writing" is visually distinct
                            from "finished" without reading the trace header. */}
                        {msg.streaming && answer && <span className="chat-stream-cursor" aria-hidden="true" />}
                        {msg.streaming && !answer && (
                          ragProgress && mode === 'rag'
                            ? <RagProgressIndicator stage={ragProgress} searchMode={searchMode} />
                            : showTyping ? <TypingIndicator /> : null
                        )}
                      </>
                    );
                  })()
                ) : (
                  editingIndex === idx ? (
                    <UserMessageEditor
                      initial={msg.content}
                      onSubmit={(newContent) => { setEditingIndex(null); onEditResend?.(idx, newContent); }}
                      onCancel={() => setEditingIndex(null)}
                      isZh={isZh}
                    />
                  ) : (
                    /* Full markdown only when the user actually pasted a fenced
                       code block — running the renderer over ordinary prose
                       would turn stray `_` / `*` into unintended emphasis.
                       Everything else just needs newlines preserved. */
                    /```/.test(msg.content)
                      ? <MarkdownRenderer content={msg.content} className="chat-markdown" />
                      : <div className="chat-user-text">{msg.content}</div>
                  )
                )}
              </div>
              {/* Action row — sits OUTSIDE the bubble so buttons never overlap
                  message text. Row-level hover on .chat-bubble-col reveals it. */}
              {msg.role === 'user' && editingIndex !== idx && (
                <div className="chat-msg-actions user-actions">
                  <EditButton
                    onClick={() => setEditingIndex(idx)}
                    label={isZh ? '编辑' : 'Edit'}
                  />
                </div>
              )}
              {/* Copy Button for AI messages */}
              {msg.role === 'assistant' && msg.content && !msg.streaming && !msg.isError && (
                <div className="chat-msg-actions">
                  <CopyButton content={
                    (msg.agentTimeline && msg.agentTimeline.some(e => e.type === 'thought'))
                      ? msg.agentTimeline.filter(e => e.type === 'thought').map(e => e.content || '').join('')
                      : resolveThinkingAndAnswer(msg).answer || msg.content
                  } />
                  <RegenerateButton
                    onClick={() => onRegenerate?.(idx)}
                    label={isZh ? '重新生成' : 'Regenerate'}
                  />
                </div>
              )}
              {/* Retry button for error messages */}
              {msg.role === 'assistant' && msg.isError && !msg.streaming && (
                <div className="chat-msg-actions">
                  <button
                    className="chat-msg-action-btn retry-btn"
                    onClick={() => onRetryError?.(idx)}
                    title={isZh ? '重试' : 'Retry'}
                    aria-label={isZh ? '重试' : 'Retry'}
                  >
                    <IconRegenerate size={13} />
                    <span>{isZh ? '重试' : 'Retry'}</span>
                  </button>
                </div>
              )}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      )}
      {/* Floating jump-to-newest. Only appears once the user has scrolled away,
          which is also when auto-follow is suspended. */}
      {showScrollToBottom && messages.length > 0 && (
        <button
          className="chat-scroll-bottom-btn"
          onClick={onScrollToBottom}
          title={isZh ? '回到最新' : 'Jump to latest'}
          aria-label={isZh ? '回到最新' : 'Jump to latest'}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" />
            <polyline points="19 12 12 19 5 12" />
          </svg>
        </button>
      )}
    </div>
  );
}
