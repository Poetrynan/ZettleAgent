import { useState, useCallback, RefObject } from 'react';
import { Message } from './useChatSessions';
import {
  IconUser,
  IconRobot,
  IconCheck,
  IconClipboard,
  IconSearch,
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
    icon: string;
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
  isZh = true,
}: ChatMessageListProps) {
  return (
    <div className="panel-content" style={{ padding: 0 }}>
      {messages.length === 0 ? (
        <div className="chat-empty-state">
          <div className="chat-empty-icon">
            {mode === 'agent' ? <IconRobot size={28} /> : <IconSearch size={28} />}
          </div>
          <div className="chat-empty-title">
            {t('chat.askAnything')}
          </div>
          <div className="chat-empty-desc">
            {mode === 'agent' ? t('chat.agentDesc') : t('chat.ragDesc')}
          </div>

          {/* Workflow Templates Grid */}
          {activeTemplates && activeTemplates.length > 0 && (
            <div className="chat-empty-templates">
              {activeTemplates.map((tmpl) => {
                const desc = isZh ? tmpl.descriptionZh : tmpl.description;
                const prompt = isZh ? tmpl.promptZh : tmpl.prompt;
                return (
                  <button
                    key={tmpl.id}
                    onClick={() => onSelectTemplate?.(prompt)}
                    title={desc}
                    className="chat-empty-template-card"
                  >
                    <span className="chat-empty-template-icon">{tmpl.icon}</span>
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
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {messages.map((msg) => (
            <div key={msg.id} className={`chat-message ${msg.role === 'user' ? 'chat-message-user' : ''}`}>
              <div className={`chat-avatar ${msg.role === 'user' ? 'chat-avatar-user' : 'chat-avatar-ai'}`}>
                {msg.role === 'user' ? <IconUser size={14} /> : <IconRobot size={14} />}
              </div>
              <div className={`chat-bubble ${msg.role === 'user' ? 'chat-bubble-user' : 'chat-bubble-ai'}`}>
                {/* Multi-Agent Role Label */}
                {msg.role === 'assistant' && msg.agentName && (
                  <div style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '2px 8px',
                    marginBottom: '6px',
                    borderRadius: '10px',
                    background: 'var(--bg-surface-hover, rgba(99, 102, 241, 0.08))',
                    fontSize: 'var(--text-xxs, 11px)',
                    color: 'var(--text-secondary)',
                    fontWeight: 500,
                    letterSpacing: '0.02em',
                  }}>
                    <span>{msg.agentIcon || '🤖'}</span>
                    <span>{msg.agentName}</span>
                  </div>
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
                        <div style={{
                          display: 'flex', alignItems: 'flex-start', gap: '8px',
                          padding: '8px 12px',
                          background: 'rgba(220, 38, 38, 0.06)',
                          border: '1px solid rgba(220, 38, 38, 0.12)',
                          borderRadius: '8px',
                          fontSize: 'var(--text-xs)',
                          color: 'var(--danger)',
                          lineHeight: 1.5,
                        }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: '1px' }}>
                            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                          </svg>
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
                        {msg.streaming && !answer && (
                          ragProgress && mode === 'rag'
                            ? <RagProgressIndicator stage={ragProgress} searchMode={searchMode} />
                            : showTyping ? <TypingIndicator /> : null
                        )}
                      </>
                    );
                  })()
                ) : (
                  <div>{msg.content}</div>
                )}
                {/* Copy Button for AI messages */}
                {msg.role === 'assistant' && msg.content && !msg.streaming && !msg.isError && (
                  <CopyButton content={
                    (msg.agentTimeline && msg.agentTimeline.some(e => e.type === 'thought'))
                      ? msg.agentTimeline.filter(e => e.type === 'thought').map(e => e.content || '').join('')
                      : resolveThinkingAndAnswer(msg).answer || msg.content
                  } />
                )}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      )}
    </div>
  );
}
