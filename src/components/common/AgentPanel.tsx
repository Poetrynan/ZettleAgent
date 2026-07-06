import { useState, useEffect } from 'react';
import { useApp } from '../../contexts/AppContext';
import { t } from '../../lib/i18n';
import { IconRobot, IconBrain, IconSparkle, IconLink, IconWarning, IconCheck, IconKey } from '../icons';
import '../../styles/AgentPanel.css';
import { useVaultInsights, LintResult } from '../../hooks/useVaultInsights';

// Suggestion interface
export interface AgentSuggestion {
  id: string;
  type: 'info' | 'action' | 'warning';
  title: string;
  description: string;
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
  const isZh = state.lang === 'zh';
  const [showGenerateInput, setShowGenerateInput] = useState(false);
  const [panelQuery, setPanelQuery] = useState('');

  // 内部 Vault Insights 管理（如果父组件没有传入，则使用内部状态）
  const {
    insights: hookInsights,
    handleInsightAction: hookInsightAction,
    updateFromLintResult,
  } = useVaultInsights(state.vaultPath ?? undefined);

  // 优先使用父组件传入的 insights，否则使用 hook 内部的
  const vaultInsights = propInsights.length > 0 ? propInsights : hookInsights;
  const onInsightAction = propInsightAction || hookInsightAction;

  // 面板打开时自动触发 lint 检查
  useEffect(() => {
    if (isOpen && state.vaultPath) {
      // 请求父组件运行 lint（或直接触发事件）
      window.dispatchEvent(new CustomEvent('zettel:request-lint', {
        detail: { vaultPath: state.vaultPath },
      }));
    }
  }, [isOpen, state.vaultPath]);

  // 监听 lint 结果事件
  useEffect(() => {
    const handleLintResult = (e: Event) => {
      const customEvent = e as CustomEvent<{ result: LintResult }>;
      if (customEvent.detail?.result) {
        updateFromLintResult(customEvent.detail.result);
      }
    };
    window.addEventListener('zettel:lint-result', handleLintResult);
    return () => window.removeEventListener('zettel:lint-result', handleLintResult);
  }, [updateFromLintResult]);

  if (!isOpen) return null;

  return (
    <div className="agent-sidebar-panel">
      {/* Header */}
      <div className="agent-panel-header">
        <div className="agent-panel-title">
          <IconRobot size={16} />
          <span>{isZh ? 'Agent 助手' : 'Agent Assistant'}</span>
        </div>
        <button className="agent-panel-close" onClick={onClose} title={t('common.close' as any)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="agent-panel-body">
        {/* VIEW: GRAPH */}
        {view === 'graph' && (
          <>
            {/* Context info */}
            <div className="agent-section">
              <span className="agent-section-title">{isZh ? '当前图谱上下文' : 'Graph Context'}</span>
              
              {hoveredNode && (
                <div className="agent-context-card">
                  <div><strong>{isZh ? '悬停节点：' : 'Hovered Node: '}</strong>{hoveredNode.label}</div>
                  <div className="agent-meta-text">
                    {isZh ? `簇 ID: ${hoveredNode.cluster ?? '无'}` : `Cluster ID: ${hoveredNode.cluster ?? 'None'}`}
                  </div>
                </div>
              )}

              {selectedNodes.length > 0 ? (
                <div className="agent-context-card">
                  <div><strong>{isZh ? `已选择 ${selectedNodes.length} 个节点` : `Selected ${selectedNodes.length} Nodes`}</strong></div>
                  <ul className="agent-muted-list">
                    {selectedNodes.slice(0, 5).map(node => (
                      <li key={node.id}>{node.label}</li>
                    ))}
                    {selectedNodes.length > 5 && <li>...</li>}
                  </ul>
                  {selectedNodes.length >= 2 && onGraphAction && (
                    <div className="agent-action-row" style={{ marginTop: '8px' }}>
                      <button 
                        className="agent-btn agent-btn-primary"
                        onClick={() => onGraphAction('explain-relation', selectedNodes)}
                      >
                        <IconLink size={10} />
                        <span>{isZh ? '分析关联' : 'Analyze Relations'}</span>
                      </button>
                      <button 
                        className="agent-btn agent-btn-secondary"
                        onClick={() => onGraphAction('create-canvas', selectedNodes)}
                      >
                        <IconSparkle size={10} />
                        <span>{isZh ? '生成画布' : 'Create Canvas'}</span>
                      </button>
                    </div>
                  )}
                  {selectedNodes.length < 2 && (
                    <div className="agent-hint-row">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: 'var(--warning)' }}>
                        <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A5 5 0 0 0 8 8c0 1 .3 2.2 1.5 3 .7.7 1.3 1.5 1.5 2.5"/>
                        <path d="M9 18h6"/>
                        <path d="M10 22h4"/>
                      </svg>
                      <span>{isZh ? '按住 Ctrl + 鼠标左键可选择多个节点进行关联分析或生成白板。' : 'Hold Ctrl + Left Click to select multiple nodes for relation analysis or canvas.'}</span>
                    </div>
                  )}
                </div>
              ) : (
                !hoveredNode && (
                  <div className="agent-context-card agent-context-card--empty">
                    <div style={{ fontWeight: 500, fontSize: '11px' }}>{isZh ? '在图谱中单击选择节点以触发分析。' : 'Click nodes on the graph for analysis.'}</div>
                    <div className="agent-hint-row agent-hint-row--compact">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: 'var(--warning)' }}>
                        <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A5 5 0 0 0 8 8c0 1 .3 2.2 1.5 3 .7.7 1.3 1.5 1.5 2.5"/>
                        <path d="M9 18h6"/>
                        <path d="M10 22h4"/>
                      </svg>
                      <span>{isZh ? '按住 Ctrl + 鼠标左键可以多选节点。' : 'Hold Ctrl + Left Click to select multiple.'}</span>
                    </div>
                  </div>
                )
              )}
            </div>

            {/* Global statistics and suggestions */}
            {graphStats && (
              <div className="agent-section" style={{ marginTop: '8px' }}>
                <span className="agent-section-title">{isZh ? '图谱健康扫描' : 'Graph Health Diagnostics'}</span>
                
                {graphStats.orphanCount > 0 && (
                  <div className="agent-suggestion-card">
                    <div className="agent-suggestion-title">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent-secondary)' }}>
                        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                        <circle cx="12" cy="10" r="3" />
                      </svg>
                      <span>{isZh ? `发现 ${graphStats.orphanCount} 个孤立节点` : `Found ${graphStats.orphanCount} Orphans`}</span>
                    </div>
                    <div className="agent-suggestion-desc">
                      {isZh 
                        ? '这些笔记没有建立任何 wikilink 链接或语义关联，可能成为知识遗忘区。' 
                        : 'These notes have no connections. They might become lost knowledge.'}
                    </div>
                    <div className="agent-action-row">
                      <button 
                        className="agent-btn agent-btn-primary" 
                        onClick={() => onGraphAction?.('highlight-orphans')}
                      >
                        {isZh ? '高亮显示' : 'Highlight'}
                      </button>
                    </div>
                  </div>
                )}

                {graphStats.hubCount > 0 && (
                  <div className="agent-suggestion-card">
                    <div className="agent-suggestion-title">
                      <span style={{ color: 'var(--warning)', display: 'inline-flex' }}><IconKey size={13} /></span>
                      <span>{isZh ? `发现 ${graphStats.hubCount} 个核心枢纽` : `Found ${graphStats.hubCount} Core Hubs`}</span>
                    </div>
                    <div className="agent-suggestion-desc">
                      {isZh 
                        ? '这些笔记重要性 score (PageRank) 高，代表了知识图谱的骨架概念。' 
                        : 'These are high importance nodes representing skeleton concepts.'}
                    </div>
                  </div>
                )}

                {graphStats.orphanCount === 0 && (
                  <div className="agent-context-card agent-context-card--success">
                    <span style={{ display: 'inline-flex' }}><IconCheck size={14} /></span>
                    <span>{isZh ? '知识结构完整，未发现孤立节点。' : 'Graph is fully connected, no orphans found.'}</span>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* VIEW: CANVAS */}
        {view === 'canvas' && (
          <>
            {/* Canvas Health Summary */}
            {canvasStats && (
              <div className="agent-section">
                <span className="agent-section-title">{isZh ? '白板状态摘要' : 'Canvas Diagnostics'}</span>
                <div className="agent-context-card">
                  <div>{isZh ? `总节点：${canvasStats.totalNodes} | 连线：${canvasStats.totalEdges}` : `Nodes: ${canvasStats.totalNodes} | Edges: ${canvasStats.totalEdges}`}</div>
                  {canvasStats.orphanCount > 0 && (
                    <div className="agent-status-row agent-status-row--warning">
                      <span style={{ display: 'inline-flex' }}><IconWarning size={14} /></span>
                      <span>{isZh ? `${canvasStats.orphanCount} 个孤立卡片 (无连线)` : `${canvasStats.orphanCount} Orphan cards`}</span>
                    </div>
                  )}
                  {canvasStats.brokenCount > 0 && (
                    <div className="agent-status-row agent-status-row--danger">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--danger)' }}>
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                      </svg>
                      <span>{isZh ? `${canvasStats.brokenCount} 个失效链接 (断链)` : `${canvasStats.brokenCount} Broken links`}</span>
                    </div>
                  )}
                  {canvasStats.orphanCount === 0 && canvasStats.brokenCount === 0 && canvasStats.totalNodes > 0 && (
                    <div className="agent-status-row agent-status-row--success">
                      <span style={{ display: 'inline-flex' }}><IconCheck size={14} /></span>
                      <span>{isZh ? '画布状态健康' : 'Canvas is healthy'}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Layout Options */}
            <div className="agent-section">
              <span className="agent-section-title">{isZh ? '自动布局与重组' : 'Canvas Arrangement'}</span>
              <div className="agent-context-card" style={{ gap: '8px' }}>
                <div className="agent-canvas-desc">
                  {isZh ? '使用 AI 或图拓扑算法重新排列卡片布局。' : 'Rearrange note cards using AI or graph algorithms.'}
                </div>
                
                {showGenerateInput ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' }}>
                    <div style={{ display: 'flex', gap: '6px', width: '100%' }}>
                      <input
                        type="text"
                        placeholder={isZh ? "输入主题自动扩充画布..." : "Enter topic to populate canvas..."}
                        value={panelQuery}
                        onChange={(e) => setPanelQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !isSmartCanvasLoading && panelQuery.trim()) {
                            onCanvasAction?.('smart-canvas-search', { query: panelQuery });
                          }
                        }}
                        className="agent-smart-input"
                        autoFocus
                        disabled={isSmartCanvasLoading}
                      />
                      <button
                        className="agent-btn agent-btn-primary"
                        onClick={() => {
                          if (panelQuery.trim()) {
                            onCanvasAction?.('smart-canvas-search', { query: panelQuery });
                          }
                        }}
                        disabled={isSmartCanvasLoading || !panelQuery.trim()}
                        style={{ padding: '0 10px', height: '26px' }}
                      >
                        {isSmartCanvasLoading ? (
                          <span className="agent-spinner" />
                        ) : (
                          isZh ? '生成' : 'Generate'
                        )}
                      </button>
                    </div>
                    <button
                      className="agent-btn agent-btn-secondary"
                      onClick={() => setShowGenerateInput(false)}
                      disabled={isSmartCanvasLoading}
                      style={{ alignSelf: 'flex-start', padding: '2px 6px', fontSize: '10px' }}
                    >
                      {isZh ? '取消' : 'Cancel'}
                    </button>
                  </div>
                ) : (
                  <div className="agent-action-row">
                    <button 
                      className="agent-btn agent-btn-primary" 
                      onClick={() => onCanvasAction?.('auto-layout')}
                    >
                      <IconBrain size={12} />
                      <span>{isZh ? '智能布局' : 'AI Layout'}</span>
                    </button>
                    <button 
                      className="agent-btn agent-btn-sparkle" 
                      onClick={() => setShowGenerateInput(true)}
                    >
                      <IconSparkle size={12} />
                      <span>{isZh ? '智能生成' : 'Smart Canvas'}</span>
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Smart Edge and suggestions list */}
            {canvasSuggestions.length > 0 && (
              <div className="agent-section">
                <span className="agent-section-title">{isZh ? '实时关联与连接建议' : 'Connection Suggestions'}</span>
                {canvasSuggestions.map(sug => (
                  <div className="agent-suggestion-card" key={sug.id}>
                    <div className="agent-suggestion-title">
                      {sug.type === 'warning' ? (
                        <span style={{ color: 'var(--warning)', display: 'inline-flex' }}><IconWarning size={13} /></span>
                      ) : (
                        <span style={{ color: 'var(--accent-secondary)', display: 'inline-flex' }}><IconLink size={13} /></span>
                      )}
                      <span>{sug.title}</span>
                    </div>
                    <div className="agent-suggestion-desc">{sug.description}</div>
                    {sug.actionLabel && onCanvasAction && (
                      <div className="agent-action-row">
                        <button 
                          className="agent-btn agent-btn-primary"
                          onClick={() => onCanvasAction(sug.id, sug.actionData)}
                        >
                          {sug.actionLabel}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* VIEW: NOTE */}
        {view === 'note' && (
          <>
            {/* Active Note metadata */}
            <div className="agent-section">
              <span className="agent-section-title">{isZh ? '当前笔记' : 'Active Note'}</span>
              <div className="agent-context-card">
                <strong title={notePath || ''}>
                  {notePath ? notePath.split('/').pop() : (isZh ? '未选择笔记' : 'No active note')}
                </strong>
                <div className="agent-note-path">
                  {notePath || ''}
                </div>
              </div>
            </div>

            {/* Similar notes */}
            {similarNotes.length > 0 && (
              <div className="agent-section">
                <span className="agent-section-title">{isZh ? '相关联笔记推荐' : 'Related Notes (RAG)'}</span>
                {similarNotes.slice(0, 4).map((note, idx) => {
                  const title = note.file_path.split('/').pop()?.replace('.md', '') || note.file_path;
                  return (
                    <div className="agent-suggestion-card agent-suggestion-card--compact" key={`${note.file_path}-${idx}`}>
                      <div className="agent-related-row">
                        <span className="agent-related-title">
                          [[{title}]]
                        </span>
                        <span className="agent-related-score">
                          {Math.round(note.score * 100)}%
                        </span>
                      </div>
                      <div className="agent-action-row" style={{ marginTop: '4px' }}>
                        <button 
                          className="agent-btn agent-btn-primary agent-btn-compact"
                          onClick={() => onNoteAction?.('open-note', note.file_path)}
                        >
                          {isZh ? '打开' : 'Open'}
                        </button>
                        <button 
                          className="agent-btn agent-btn-secondary agent-btn-compact"
                          onClick={() => onNoteAction?.('insert-link', title)}
                        >
                          {isZh ? '插链' : 'Link'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Note key facts */}
            {noteFacts.length > 0 && (
              <div className="agent-section">
                <span className="agent-section-title">{isZh ? 'AI 提取核心事实' : 'Key Facts Extracted'}</span>
                <div className="agent-context-card" style={{ gap: '6px', maxHeight: '200px', overflowY: 'auto' }}>
                  {noteFacts.map((fact, idx) => (
                    <div key={idx} className="agent-fact-row">
                      <span className="agent-fact-badge">
                        {fact.category}
                      </span>
                      <span className="agent-fact-content">{fact.content}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* ═══════════════════════════════════════════════════════════════ */}
        {/* VAULT INSIGHTS: Scheduler 发现的聚合展示区（所有视图共享）          */}
        {/* ═══════════════════════════════════════════════════════════════ */}
        {vaultInsights.length > 0 && (
          <div className="agent-section vault-insights-section">
            <span className="agent-section-title">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '4px', verticalAlign: 'middle' }}>
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
              </svg>
              {isZh ? '知识库洞察' : 'Vault Insights'}
            </span>

            {/* 按 severity 分组：critical 在前，warning 次之，info 最后 */}
            {['critical', 'warning', 'info'].map(severity => {
              const insights = vaultInsights.filter(i => i.severity === severity);
              if (insights.length === 0) return null;

              return (
                <div key={severity} className={`vault-insight-group vault-insight-${severity}`}>
                  <div className="vault-insight-group-header">
                    <span className={`vault-insight-severity-badge severity-${severity}`}>
                      {severity === 'critical' ? (isZh ? '需要关注' : 'Critical') :
                       severity === 'warning' ? (isZh ? '建议' : 'Suggestions') :
                       (isZh ? '提示' : 'Info')}
                    </span>
                    <span className="vault-insight-count">{insights.length}</span>
                  </div>

                  {insights.map(insight => (
                    <div className="vault-insight-card" key={insight.id}>
                      <div className="vault-insight-header">
                        <span className={`vault-insight-category category-${insight.category}`}>
                          {insight.category === 'contradiction' && (
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ verticalAlign: 'middle', marginRight: 3 }}><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                          )}
                          {insight.category === 'orphan' && (
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ verticalAlign: 'middle', marginRight: 3 }}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                          )}
                          {insight.category === 'missing_link' && (
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ verticalAlign: 'middle', marginRight: 3 }}><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
                          )}
                          {insight.category === 'hub_overload' && (
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ verticalAlign: 'middle', marginRight: 3 }}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                          )}
                          {insight.category === 'semantic_duplicate' && (
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ verticalAlign: 'middle', marginRight: 3 }}><rect x="8" y="2" width="8" height="6" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>
                          )}
                          {insight.category === 'fragmentation' && (
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ verticalAlign: 'middle', marginRight: 3 }}><circle cx="12" cy="5" r="3"/><circle cx="5" cy="19" r="3"/><circle cx="19" cy="19" r="3"/></svg>
                          )}
                          {insight.category === 'contradiction' ? (isZh ? '矛盾' : 'Contradiction') :
                           insight.category === 'orphan' ? (isZh ? '孤立' : 'Orphan') :
                           insight.category === 'missing_link' ? (isZh ? '缺链' : 'Missing Link') :
                           insight.category === 'hub_overload' ? (isZh ? '过载' : 'Hub Overload') :
                           insight.category === 'semantic_duplicate' ? (isZh ? '重复' : 'Duplicate') :
                           (isZh ? '碎片' : 'Fragmentation')}
                        </span>
                      </div>
                      <div className="vault-insight-title">{insight.title}</div>
                      <div className="vault-insight-desc">{insight.description}</div>
                      {insight.affectedNotes && insight.affectedNotes.length > 0 && (
                        <div className="vault-insight-notes">
                          {insight.affectedNotes.slice(0, 3).map((note, idx) => (
                            <span key={idx} className="vault-insight-note-chip">
                              {note.replace('.md', '')}
                            </span>
                          ))}
                          {insight.affectedNotes.length > 3 && (
                            <span className="vault-insight-more">+{insight.affectedNotes.length - 3}</span>
                          )}
                        </div>
                      )}
                      <div className="vault-insight-action">
                        <button
                          className="agent-btn agent-btn-primary agent-btn-xs"
                          onClick={() => onInsightAction?.(insight.id, insight.actionData)}
                        >
                          {insight.actionLabel}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
