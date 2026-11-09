import { useState, useEffect, type ReactNode } from 'react';
import { useApp } from '../../contexts/AppContext';
import { t } from '../../lib/i18n';
import '../../styles/AgentPanel.css';
import { useVaultInsights, LintResult } from '../../hooks/useVaultInsights';

/**
 * The suggestions panel shared by the graph, canvas and note views.
 *
 * Written to read like an inspector, not a chatbot: plain headings, numbers
 * where numbers help, one short line of reason per suggestion and a single
 * action. No robots, sparkles or "AI found…" copy; what it says is the finding.
 */

// Suggestion interface
export interface AgentSuggestion {
  id: string;
  type: 'info' | 'action' | 'warning';
  title: string;
  description: string;
  /** Short label for the kind of finding ("Could connect", "Possible duplicate"). */
  kind?: string;
  /** The two cards a suggestion is about, shown as a pair instead of in the title. */
  pair?: [string, string];
  actionLabel?: string;
  actionData?: any;
}

// Vault Insight interface for Scheduler discoveries
export interface VaultInsight {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  category: 'contradiction' | 'orphan' | 'missing_link' | 'hub_overload' | 'semantic_duplicate' | 'fragmentation';
  title: string;
  description: string;
  affectedNotes?: string[];
  actionLabel: string;
  actionData?: any;
}

interface AgentPanelProps {
  view: 'graph' | 'canvas' | 'note';
  isOpen: boolean;
  onClose: () => void;
  isSmartCanvasLoading?: boolean;
  // Graph view inputs
  selectedNodes?: { id: string; label: string; cluster?: number; pagerank?: number }[];
  hoveredNode?: { id: string; label: string; cluster?: number } | null;
  graphStats?: { totalNodes: number; totalEdges: number; clusterCount: number; hubCount: number; orphanCount: number };
  onGraphAction?: (action: string, data?: any) => void;
  // Canvas view inputs
  canvasStats?: { totalNodes: number; totalEdges: number; orphanCount: number; brokenCount: number; missingMetaCount: number };
  canvasSuggestions?: AgentSuggestion[];
  onCanvasAction?: (action: string, data?: any) => void;
  // Note view inputs
  notePath?: string | null;
  noteFacts?: { content: string; category: string }[];
  similarNotes?: { file_path: string; score: number }[];
  onNoteAction?: (action: string, data?: any) => void;
  // Vault insights (Scheduler discoveries)
  vaultInsights?: VaultInsight[];
  onInsightAction?: (action: string, data?: any) => void;
}

const I = {
  link: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" /><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" /></svg>,
  copy: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 4H6a2 2 0 0 0-2 2v10" /></svg>,
  split: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v18" /><path d="m7 8-4 4 4 4" /><path d="m17 8 4 4-4 4" /></svg>,
  dot: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="7" strokeDasharray="3 3" /></svg>,
  arrange: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="4" width="7" height="6" rx="1.5" /><rect x="13.5" y="4" width="7" height="6" rx="1.5" /><rect x="8.5" y="14" width="7" height="6" rx="1.5" /></svg>,
  plus: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="10.5" cy="10.5" r="6" /><line x1="15" y1="15" x2="20" y2="20" /><line x1="10.5" y1="8" x2="10.5" y2="13" /><line x1="8" y1="10.5" x2="13" y2="10.5" /></svg>,
  check: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="5 12.5 10 17 19 7.5" /></svg>,
  close: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>,
};

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="ap-section">
      <header className="ap-section-head">
        <span>{title}</span>
        {count !== undefined && count > 0 && <span className="ap-section-count">{count}</span>}
      </header>
      {children}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: 'warn' | 'bad' }) {
  return (
    <div className={`ap-stat ${tone ? `is-${tone}` : ''}`}>
      <span className="ap-stat-value">{value}</span>
      <span className="ap-stat-label">{label}</span>
    </div>
  );
}

function Row({
  icon, tone, kind, title, pair, detail, chips, actions,
}: {
  icon?: ReactNode; tone?: 'warn' | 'bad' | 'info' | 'ok'; kind?: string; title?: ReactNode; pair?: [string, string];
  detail?: ReactNode; chips?: string[]; actions?: ReactNode;
}) {
  return (
    <div className={`ap-row ${tone ? `is-${tone}` : ''}`}>
      {icon && <span className="ap-row-icon">{icon}</span>}
      <div className="ap-row-main">
        {kind && <div className="ap-row-kind">{kind}</div>}
        {pair ? (
          <div className="ap-pair">
            <span className="ap-pair-name" title={pair[0]}>{pair[0]}</span>
            <span className="ap-pair-sep">↔</span>
            <span className="ap-pair-name" title={pair[1]}>{pair[1]}</span>
          </div>
        ) : title ? <div className="ap-row-title">{title}</div> : null}
        {detail && <div className="ap-row-detail">{detail}</div>}
        {chips && chips.length > 0 && (
          <div className="ap-chips">
            {chips.slice(0, 3).map((c, i) => <span key={i} className="ap-chip" title={c}>{c}</span>)}
            {chips.length > 3 && <span className="ap-chip ap-chip--more">+{chips.length - 3}</span>}
          </div>
        )}
        {actions && <div className="ap-row-actions">{actions}</div>}
      </div>
    </div>
  );
}

const Btn = ({ children, primary, onClick, disabled }: { children: ReactNode; primary?: boolean; onClick?: () => void; disabled?: boolean }) => (
  <button type="button" className={`ap-btn ${primary ? 'ap-btn--primary' : ''}`} onClick={onClick} disabled={disabled}>{children}</button>
);

export function AgentPanel({
  view,
  isOpen,
  onClose,
  isSmartCanvasLoading = false,
  selectedNodes = [],
  hoveredNode = null,
  graphStats,
  onGraphAction,
  canvasStats,
  canvasSuggestions = [],
  onCanvasAction,
  notePath,
  noteFacts = [],
  similarNotes = [],
  onNoteAction,
  vaultInsights: propInsights = [],
  onInsightAction: propInsightAction,
}: AgentPanelProps) {
  const { state } = useApp();
  const zh = state.lang === 'zh';
  const [showTopicInput, setShowTopicInput] = useState(false);
  const [topic, setTopic] = useState('');

  const {
    insights: hookInsights,
    handleInsightAction: hookInsightAction,
    updateFromLintResult,
  } = useVaultInsights(state.vaultPath ?? undefined);

  const vaultInsights = propInsights.length > 0 ? propInsights : hookInsights;
  const onInsightAction = propInsightAction || hookInsightAction;

  // Opening the panel asks for a fresh vault check.
  useEffect(() => {
    if (isOpen && state.vaultPath) {
      window.dispatchEvent(new CustomEvent('zettel:request-lint', { detail: { vaultPath: state.vaultPath } }));
    }
  }, [isOpen, state.vaultPath]);

  useEffect(() => {
    const handleLintResult = (e: Event) => {
      const customEvent = e as CustomEvent<{ result: LintResult }>;
      if (customEvent.detail?.result) updateFromLintResult(customEvent.detail.result);
    };
    window.addEventListener('zettel:lint-result', handleLintResult);
    return () => window.removeEventListener('zettel:lint-result', handleLintResult);
  }, [updateFromLintResult]);

  if (!isOpen) return null;

  const title = view === 'note' ? (zh ? '相关' : 'Related') : (zh ? '建议' : 'Suggestions');
  const subtitle = view === 'canvas' ? (zh ? '当前画布' : 'This canvas')
    : view === 'graph' ? (zh ? '知识图谱' : 'Knowledge graph')
    : notePath ? notePath.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/, '') : (zh ? '未打开笔记' : 'No note open');

  const submitTopic = () => {
    if (topic.trim() && !isSmartCanvasLoading) onCanvasAction?.('smart-canvas-search', { query: topic.trim() });
  };

  const insightKind = (c: VaultInsight['category']) => ({
    contradiction: zh ? '说法不一致' : 'Disagreement',
    orphan: zh ? '孤立笔记' : 'Orphan',
    missing_link: zh ? '缺少链接' : 'Missing link',
    hub_overload: zh ? '链接过多' : 'Overloaded hub',
    semantic_duplicate: zh ? '可能重复' : 'Possible duplicate',
    fragmentation: zh ? '内容分散' : 'Fragmented',
  }[c]);
  const insightIcon = (c: VaultInsight['category']) =>
    c === 'semantic_duplicate' ? I.copy : c === 'contradiction' ? I.split : c === 'orphan' ? I.dot : I.link;
  const sevTone = (s: VaultInsight['severity']) => (s === 'critical' ? 'bad' : s === 'warning' ? 'warn' : 'info');
  const sortedInsights = [...vaultInsights].sort((a, b) => {
    const o = { critical: 0, warning: 1, info: 2 } as const;
    return o[a.severity] - o[b.severity];
  });

  return (
    <aside className="agent-sidebar-panel" aria-label={title}>
      <header className="ap-header">
        <div className="ap-header-text">
          <h2 className="ap-title">{title}</h2>
          {subtitle && <div className="ap-subtitle">{subtitle}</div>}
        </div>
        <button type="button" className="ap-close" onClick={onClose} title={t('common.close' as any)} aria-label={t('common.close' as any)}>
          {I.close}
        </button>
      </header>

      <div className="ap-body">
        {/* ── Canvas ── */}
        {view === 'canvas' && (
          <>
            {canvasStats && (
              <div className="ap-stats">
                <Stat label={zh ? '卡片' : 'Cards'} value={canvasStats.totalNodes} />
                <Stat label={zh ? '连线' : 'Lines'} value={canvasStats.totalEdges} />
                <Stat label={zh ? '未连接' : 'Unlinked'} value={canvasStats.orphanCount} tone={canvasStats.orphanCount > 0 ? 'warn' : undefined} />
                {canvasStats.brokenCount > 0 && <Stat label={zh ? '失效' : 'Broken'} value={canvasStats.brokenCount} tone="bad" />}
              </div>
            )}

            <Section title={zh ? '整理' : 'Tidy up'}>
              <div className="ap-actions-grid">
                <button type="button" className="ap-tile" onClick={() => onCanvasAction?.('auto-layout')}>
                  {I.arrange}
                  <span>{zh ? '自动排列' : 'Arrange'}</span>
                </button>
                <button type="button" className={`ap-tile ${showTopicInput ? 'is-active' : ''}`} onClick={() => setShowTopicInput(v => !v)}>
                  {I.plus}
                  <span>{zh ? '按主题添加笔记' : 'Add notes by topic'}</span>
                </button>
              </div>
              {showTopicInput && (
                <div className="ap-topic">
                  <input
                    autoFocus
                    value={topic}
                    onChange={e => setTopic(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') submitTopic(); if (e.key === 'Escape') setShowTopicInput(false); }}
                    placeholder={zh ? '例如：间隔重复' : 'e.g. spaced repetition'}
                    disabled={isSmartCanvasLoading}
                  />
                  <Btn primary onClick={submitTopic} disabled={isSmartCanvasLoading || !topic.trim()}>
                    {isSmartCanvasLoading ? <span className="ap-spinner" /> : (zh ? '添加' : 'Add')}
                  </Btn>
                </div>
              )}
            </Section>

            <Section title={zh ? '发现' : 'Findings'} count={canvasSuggestions.length}>
              {canvasSuggestions.length === 0 ? (
                <div className="ap-empty">
                  <span className="ap-empty-icon">{I.check}</span>
                  {canvasStats && canvasStats.totalNodes > 0
                    ? (zh ? '暂时没有要处理的地方。' : 'Nothing to look at right now.')
                    : (zh ? '添加几张卡片后，这里会列出可以连接或合并的地方。' : 'Add a few cards and this lists what could be linked or merged.')}
                </div>
              ) : canvasSuggestions.map(sug => (
                <Row
                  key={sug.id}
                  tone={sug.type === 'warning' ? 'warn' : sug.type === 'action' ? 'info' : undefined}
                  icon={sug.type === 'warning' ? (sug.kind && /重复|duplicate/i.test(sug.kind) ? I.copy : I.split) : sug.id === 'diag-orphans-action' ? I.dot : I.link}
                  kind={sug.kind}
                  pair={sug.pair}
                  title={sug.pair ? undefined : sug.title}
                  detail={sug.description}
                  actions={sug.actionLabel && onCanvasAction ? (
                    <Btn primary onClick={() => onCanvasAction(sug.id, sug.actionData)}>{sug.actionLabel}</Btn>
                  ) : undefined}
                />
              ))}
            </Section>
          </>
        )}

        {/* ── Graph ── */}
        {view === 'graph' && (
          <>
            {graphStats && (
              <div className="ap-stats">
                <Stat label={zh ? '笔记' : 'Notes'} value={graphStats.totalNodes} />
                <Stat label={zh ? '链接' : 'Links'} value={graphStats.totalEdges} />
                <Stat label={zh ? '孤立' : 'Orphans'} value={graphStats.orphanCount} tone={graphStats.orphanCount > 0 ? 'warn' : undefined} />
                <Stat label={zh ? '核心' : 'Hubs'} value={graphStats.hubCount} />
              </div>
            )}

            <Section title={zh ? '选中' : 'Selection'} count={selectedNodes.length}>
              {selectedNodes.length > 0 ? (
                <div className="ap-card">
                  <ul className="ap-list">
                    {selectedNodes.slice(0, 6).map(n => <li key={n.id} title={n.label}>{n.label}</li>)}
                    {selectedNodes.length > 6 && <li className="ap-list-more">{zh ? `还有 ${selectedNodes.length - 6} 个` : `+${selectedNodes.length - 6} more`}</li>}
                  </ul>
                  {selectedNodes.length >= 2 && onGraphAction ? (
                    <div className="ap-row-actions">
                      <Btn primary onClick={() => onGraphAction('explain-relation', selectedNodes)}>{zh ? '说明它们的关系' : 'Explain the relation'}</Btn>
                      <Btn onClick={() => onGraphAction('create-canvas', selectedNodes)}>{zh ? '放到新画布' : 'Open on a canvas'}</Btn>
                    </div>
                  ) : (
                    <div className="ap-hint">{zh ? '再选一个（Ctrl+点击）即可比较两者。' : 'Ctrl+click another note to compare them.'}</div>
                  )}
                </div>
              ) : (
                <div className="ap-empty">
                  {hoveredNode
                    ? <><strong className="ap-hover-name">{hoveredNode.label}</strong>{zh ? '　点击选中，Ctrl+点击多选' : ' — click to select, Ctrl+click for more'}</>
                    : (zh ? '点击图谱中的笔记来查看；Ctrl+点击可多选。' : 'Click a note on the graph; Ctrl+click to pick several.')}
                </div>
              )}
            </Section>

            {graphStats && (
              <Section title={zh ? '发现' : 'Findings'}>
                {graphStats.orphanCount > 0 ? (
                  <Row
                    tone="warn"
                    icon={I.dot}
                    kind={zh ? '孤立笔记' : 'Orphans'}
                    title={zh ? `${graphStats.orphanCount} 篇笔记没有任何链接` : `${graphStats.orphanCount} notes have no links`}
                    detail={zh ? '没有链接的笔记很难再被找到。' : 'Notes without links are hard to find again.'}
                    actions={<Btn primary onClick={() => onGraphAction?.('highlight-orphans')}>{zh ? '在图中标出' : 'Show on graph'}</Btn>}
                  />
                ) : (
                  <div className="ap-empty"><span className="ap-empty-icon">{I.check}</span>{zh ? '每篇笔记都至少有一个链接。' : 'Every note has at least one link.'}</div>
                )}
                {graphStats.hubCount > 0 && (
                  <Row
                    icon={I.link}
                    kind={zh ? '核心笔记' : 'Hubs'}
                    title={zh ? `${graphStats.hubCount} 篇笔记连接最多` : `${graphStats.hubCount} notes hold the most links`}
                    detail={zh ? '它们是图谱的骨架，适合作为入口。' : 'They hold the graph together and make good starting points.'}
                  />
                )}
              </Section>
            )}
          </>
        )}

        {/* ── Note ── */}
        {view === 'note' && (
          <>
            {similarNotes.length > 0 && (
              <Section title={zh ? '内容相近的笔记' : 'Similar notes'} count={similarNotes.length}>
                {similarNotes.slice(0, 6).map((note, idx) => {
                  const name = note.file_path.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/, '') || note.file_path;
                  return (
                    <div className="ap-related" key={`${note.file_path}-${idx}`}>
                      <button type="button" className="ap-related-name" onClick={() => onNoteAction?.('open-note', note.file_path)} title={note.file_path}>
                        {name}
                      </button>
                      <span className="ap-related-score">{Math.round(note.score * 100)}%</span>
                      <button type="button" className="ap-link-btn" onClick={() => onNoteAction?.('insert-link', name)}>
                        {zh ? '插入链接' : 'Link'}
                      </button>
                    </div>
                  );
                })}
              </Section>
            )}
            {noteFacts.length > 0 && (
              <Section title={zh ? '要点' : 'Key points'} count={noteFacts.length}>
                <div className="ap-card ap-facts">
                  {noteFacts.map((fact, idx) => (
                    <div key={idx} className="ap-fact">
                      <span className="ap-fact-tag">{fact.category}</span>
                      <span>{fact.content}</span>
                    </div>
                  ))}
                </div>
              </Section>
            )}
            {similarNotes.length === 0 && noteFacts.length === 0 && (
              <div className="ap-empty">{zh ? '这篇笔记还没有相近的内容。' : 'Nothing similar to this note yet.'}</div>
            )}
          </>
        )}

        {/* ── Vault (all views) ── */}
        {sortedInsights.length > 0 && (
          <Section title={zh ? '整个知识库' : 'Whole vault'} count={sortedInsights.length}>
            {sortedInsights.map(insight => (
              <Row
                key={insight.id}
                tone={sevTone(insight.severity)}
                icon={insightIcon(insight.category)}
                kind={insightKind(insight.category)}
                title={insight.title}
                detail={insight.description}
                chips={insight.affectedNotes?.map(n => n.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/, '') || n)}
                actions={<Btn onClick={() => onInsightAction?.(insight.id, insight.actionData)}>{insight.actionLabel}</Btn>}
              />
            ))}
          </Section>
        )}
      </div>
    </aside>
  );
}
