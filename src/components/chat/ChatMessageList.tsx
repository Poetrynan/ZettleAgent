import { useState, useCallback, useEffect, useRef, RefObject } from 'react';
import type { ReactNode } from 'react';
import { Message } from './useChatSessions';
import {
  IconRobot,
  IconCheck,
  IconClipboard,
  IconSearch,
  IconWarning,
  IconFile,
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
import { DecisionGate } from '../primitives/DecisionGate';

// ── Helpers ────────────────────────────────────────────────────────

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

function resolveThinkingAndAnswer(msg: Message): { thinking: string; answer: string } {
  const hasToolCalls = !!(msg.toolCalls && msg.toolCalls.length > 0);
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
      aria-label={copied ? 'Copied' : 'Copy'}
    >
      {copied ? <IconCheck size={13} /> : <IconClipboard size={13} />}
    </button>
  );
}

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

function UserMessageEditor({
  initial, onSubmit, onCancel, isZh,
}: { initial: string; onSubmit: (v: string) => void; onCancel: () => void; isZh: boolean }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
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
  /** 审批卡片解决回调 */
  onApprovalResolved?: (approvalId: string, approved: boolean) => void;
  onRegenerate?: (assistantIndex: number) => void;
  onEditResend?: (userIndex: number, newContent: string) => void;
  onRetryError?: (assistantIndex: number) => void;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
  showScrollToBottom?: boolean;
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
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  return (
    <div
      className="panel-content chat-scroll-area"
      style={{ padding: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}
      onScroll={onScroll}
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {messages.length === 0 ? (
        <div className="chat-empty-desk" style={{ margin: 'auto', maxWidth: '360px', width: '100%', padding: '32px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '16px' }}>
          {/* Header Info */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'center' }}>
            <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>
              {isZh ? '智能助手 · 本地知识库' : 'INTELLIGENT AGENT'}
            </div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.5, maxWidth: '320px' }}>
              {isZh 
                ? '支持自主文件检索、知识图谱推演、笔记批处理与内容重构。随时输入问题或从下方推荐指令开始。'
                : 'Supports autonomous retrieval, graph reasoning, batch note refactoring and synthesis. Ask a question or pick a command below.'}
            </div>
          </div>

          {/* Quick template triggers */}
          {activeTemplates && activeTemplates.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%', marginTop: '8px' }}>
              <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>
                {isZh ? '推荐指令 · COMMANDS' : 'COMMANDS'}
              </div>
              {activeTemplates.map((tmpl) => {
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
            <article
              key={msg.id}
              className={`chat-turn ${msg.role === 'user' ? 'chat-turn-user' : 'chat-turn-agent'}`}
              aria-label={msg.role === 'user' ? 'User Message' : 'Assistant Message'}
            >
              <div className="chat-turn-col">
                <div className={`chat-turn-body ${msg.role === 'user' ? 'chat-turn-body-user' : ''}`}>
                  {msg.role === 'assistant' && msg.agentName && (
                    <div className="chat-turn-agent-label">{msg.agentName}</div>
                  )}

                  {/* Agent Execution Ledger (Thought Stream / Tool Traces) */}
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

                  {/* Message Content: Primary Answer Surface */}
                  {msg.role === 'assistant' ? (
                    (() => {
                      if (msg.isApprovalRequest && msg.approvalId) {
                        return (
                          <DecisionGate
                            title={isZh ? '写盘操作待审核' : 'Pending Write Operation'}
                            status="pending"
                            className="chat-turn-decision-gate"
                          >
                            <DiffApprovalCard
                              approvalId={msg.approvalId}
                              actionDescription={msg.approvalDescription || ''}
                              diffJson={msg.approvalDiffJson}
                              onResolved={(approved) => {
                                onApprovalResolved?.(msg.approvalId!, approved);
                              }}
                              lang={isZh ? 'zh' : 'en'}
                            />
                          </DecisionGate>
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

                      if (isAgentLayout && msg.streaming && streamingAnswer && msg.answerStreaming) {
                        return (
                          <div className="chat-turn-answer-box">
                            {msg.thinkingContent && <ThinkingBlock content={msg.thinkingContent} />}
                            <MarkdownRenderer content={streamingAnswer} className="chat-markdown" />
                            <span className="chat-stream-cursor" aria-hidden="true" />
                          </div>
                        );
                      }

                      if (isAgentLayout && msg.streaming) {
                        return null;
                      }

                      const { thinking, answer } = resolveThinkingAndAnswer(msg);
                      const showThinkingBlock = thinking && !hasTimeline;

                      return (
                        <div className="chat-turn-answer-box">
                          {showThinkingBlock && <ThinkingBlock content={thinking} />}
                          {answer && <MarkdownRenderer content={answer} className="chat-markdown" />}
                          {msg.streaming && answer && <span className="chat-stream-cursor" aria-hidden="true" />}
                          {msg.streaming && !answer && (
                            ragProgress && mode === 'rag'
                              ? <RagProgressIndicator stage={ragProgress} searchMode={searchMode} />
                              : showTyping ? <TypingIndicator /> : null
                          )}
                        </div>
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
                      /```/.test(msg.content)
                        ? <MarkdownRenderer content={msg.content} className="chat-markdown" />
                        : <div className="chat-user-text">{msg.content}</div>
                    )
                  )}
                </div>

                {/* Turn Actions */}
                {msg.role === 'user' && editingIndex !== idx && (
                  <div className="chat-msg-actions user-actions">
                    <EditButton
                      onClick={() => setEditingIndex(idx)}
                      label={isZh ? '编辑' : 'Edit'}
                    />
                  </div>
                )}

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
            </article>
          ))}
          <div ref={messagesEndRef} />
        </div>
      )}

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
