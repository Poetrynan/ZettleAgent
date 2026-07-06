import { useState, useEffect } from 'react';
import { useApp } from '../../contexts/AppContext';
import { runVaultLint, fixBrokenLink, createNoteForLink, type LintReport, type BrokenLinkInfo } from '../../lib/tauri';
import { t } from '../../lib/i18n';
import { IconClose, IconWarning, IconCheck, IconNote, IconLink, IconRobot, IconSync } from '../icons';

interface LintModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function LintModal({ isOpen, onClose }: LintModalProps) {
  const { setView, setCurrentFile, showToast } = useApp();
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<LintReport | null>(null);
  const [activeTab, setActiveTab] = useState<'broken' | 'orphans' | 'missing' | 'graph' | 'semantic'>('broken');
  const [fixingId, setFixingId] = useState<string | null>(null);
  const [creatingTitle, setCreatingTitle] = useState<string | null>(null);

  const loadReport = async () => {
    setLoading(true);
    try {
      const data = await runVaultLint();
      setReport(data);
    } catch (err) {
      showToast(t('common.error') + ': ' + err, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadReport();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleOpenNote = (filePath: string) => {
    setCurrentFile(filePath);
    setView('note');
    onClose();
  };

  const handleFixLink = async (
    item: BrokenLinkInfo,
    action: 'remove_brackets' | 'replace',
    replacement?: string
  ) => {
    const fixKey = `${item.file_path}-${item.target_title}-${item.line_number}`;
    setFixingId(fixKey);
    try {
      await fixBrokenLink(item.file_path, item.target_title, item.line_number, action, replacement);
      showToast(t('lint.fixedSuccess'), 'success');
      await loadReport();
    } catch (err) {
      showToast(t('lint.fixedFail') + ': ' + err, 'error');
    } finally {
      setFixingId(null);
    }
  };

  const handleCreateNote = async (targetTitle: string) => {
    setCreatingTitle(targetTitle);
    try {
      await createNoteForLink(targetTitle);
      const zh = navigator.language.startsWith('zh');
      showToast(zh ? `已创建笔记「${targetTitle}」` : `Created note "${targetTitle}"`, 'success');
      await loadReport();
    } catch (err) {
      showToast(t('common.error') + ': ' + err, 'error');
    } finally {
      setCreatingTitle(null);
    }
  };

  // Get total issue counts
  const brokenCount = report?.broken_links?.length ?? 0;
  const orphanCount = report?.orphans?.length ?? 0;
  const missingCount = report?.missing_metadata?.length ?? 0;
  const gh = report?.graph_health;
  const graphIssues = (gh?.hub_overload?.length ?? 0) + (gh?.missing_embeddings ?? 0);
  const dupCount = report?.semantic_duplicates?.length ?? 0;
  const hiddenCount = report?.hidden_connections?.length ?? 0;
  const semanticCount = dupCount + hiddenCount;
  const totalIssues = brokenCount + orphanCount + missingCount;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div 
        className="modal-container" 
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '800px', height: '85vh' }}
      >
        {/* Header */}
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <span style={{ display: 'flex', color: totalIssues > 0 ? 'var(--warning)' : 'var(--success)' }}>
              <IconWarning size={20} />
            </span>
            <h2 style={{ margin: 0, fontSize: 'var(--text-xl)', fontWeight: 600 }}>
              {t('lint.modalTitle')}
            </h2>
            {totalIssues > 0 && (
              <span className="badge badge-danger" style={{ fontSize: 'var(--text-xs)' }}>
                {t('lint.issueCount').replace('{n}', String(totalIssues))}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <button 
              className="btn btn-ghost btn-icon-sm" 
              onClick={loadReport} 
              disabled={loading}
              title={t('lint.checkBtn')}
            >
              <IconSync size={18} spinning={loading} />
            </button>
            <button className="btn btn-ghost btn-icon-sm" onClick={onClose}>
              <IconClose size={18} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="modal-content" style={{ display: 'flex', flexDirection: 'column', padding: 0 }}>
          {/* Tabs header */}
          <div style={{
            display: 'flex',
            borderBottom: '1px solid var(--border-subtle)',
            background: 'var(--bg-primary)',
            padding: 'var(--space-2) var(--space-5) 0 var(--space-5)',
            gap: 'var(--space-1)',
            flexShrink: 0
          }}>
            <button
              onClick={() => setActiveTab('broken')}
              style={{
                padding: 'var(--space-3) var(--space-4)',
                border: 'none',
                background: 'none',
                borderBottom: activeTab === 'broken' ? '2px solid var(--accent-primary)' : '2px solid transparent',
                color: activeTab === 'broken' ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontWeight: activeTab === 'broken' ? 600 : 500,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                fontSize: 'var(--text-sm)'
              }}
            >
              <IconLink size={16} />
              {t('lint.brokenLinks')}
              <span style={{
                background: activeTab === 'broken' ? 'var(--accent-primary)' : 'var(--border)',
                color: activeTab === 'broken' ? '#fff' : 'var(--text-secondary)',
                borderRadius: '10px',
                padding: '2px 6px',
                fontSize: 'var(--text-xs)',
                fontWeight: 600
              }}>
                {brokenCount}
              </span>
            </button>

            <button
              onClick={() => setActiveTab('orphans')}
              style={{
                padding: 'var(--space-3) var(--space-4)',
                border: 'none',
                background: 'none',
                borderBottom: activeTab === 'orphans' ? '2px solid var(--accent-primary)' : '2px solid transparent',
                color: activeTab === 'orphans' ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontWeight: activeTab === 'orphans' ? 600 : 500,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                fontSize: 'var(--text-sm)'
              }}
            >
              <IconNote size={16} />
              {t('lint.orphans')}
              <span style={{
                background: activeTab === 'orphans' ? 'var(--accent-primary)' : 'var(--border)',
                color: activeTab === 'orphans' ? '#fff' : 'var(--text-secondary)',
                borderRadius: '10px',
                padding: '2px 6px',
                fontSize: 'var(--text-xs)',
                fontWeight: 600
              }}>
                {orphanCount}
              </span>
            </button>

            <button
              onClick={() => setActiveTab('missing')}
              style={{
                padding: 'var(--space-3) var(--space-4)',
                border: 'none',
                background: 'none',
                borderBottom: activeTab === 'missing' ? '2px solid var(--accent-primary)' : '2px solid transparent',
                color: activeTab === 'missing' ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontWeight: activeTab === 'missing' ? 600 : 500,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                fontSize: 'var(--text-sm)'
              }}
            >
              <IconRobot size={16} />
              {t('lint.missingMeta')}
              <span style={{
                background: activeTab === 'missing' ? 'var(--accent-primary)' : 'var(--border)',
                color: activeTab === 'missing' ? '#fff' : 'var(--text-secondary)',
                borderRadius: '10px',
                padding: '2px 6px',
                fontSize: 'var(--text-xs)',
                fontWeight: 600
              }}>
                {missingCount}
              </span>
            </button>

            <button
              onClick={() => setActiveTab('graph')}
              style={{
                padding: 'var(--space-3) var(--space-4)',
                border: 'none',
                background: 'none',
                borderBottom: activeTab === 'graph' ? '2px solid var(--accent-primary)' : '2px solid transparent',
                color: activeTab === 'graph' ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontWeight: activeTab === 'graph' ? 600 : 500,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                fontSize: 'var(--text-sm)'
              }}
            >
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/>
                <line x1="7" y1="7" x2="10" y2="10"/><line x1="14" y1="10" x2="17" y2="7"/><line x1="7" y1="17" x2="10" y2="14"/><line x1="14" y1="14" x2="17" y2="17"/>
              </svg>
              {t('lint.graphHealth') || (navigator.language.startsWith('zh') ? '图谱健康' : 'Graph Health')}
              <span style={{
                background: activeTab === 'graph' ? (graphIssues > 0 ? 'var(--warning)' : 'var(--accent-primary)') : 'var(--border)',
                color: activeTab === 'graph' ? '#fff' : 'var(--text-secondary)',
                borderRadius: '10px',
                padding: '2px 6px',
                fontSize: 'var(--text-xs)',
                fontWeight: 600
              }}>
                {graphIssues > 0 ? graphIssues : '✓'}
              </span>
            </button>

            <button
              onClick={() => setActiveTab('semantic')}
              style={{
                padding: 'var(--space-3) var(--space-4)',
                border: 'none',
                background: 'none',
                borderBottom: activeTab === 'semantic' ? '2px solid var(--accent-primary)' : '2px solid transparent',
                color: activeTab === 'semantic' ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontWeight: activeTab === 'semantic' ? 600 : 500,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                fontSize: 'var(--text-sm)'
              }}
            >
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                <line x1="8" y1="11" x2="14" y2="11"/><line x1="11" y1="8" x2="11" y2="14"/>
              </svg>
              {navigator.language.startsWith('zh') ? '语义分析' : 'Semantic'}
              <span style={{
                background: activeTab === 'semantic' ? 'var(--accent-primary)' : 'var(--border)',
                color: activeTab === 'semantic' ? '#fff' : 'var(--text-secondary)',
                borderRadius: '10px',
                padding: '2px 6px',
                fontSize: 'var(--text-xs)',
                fontWeight: 600
              }}>
                {semanticCount > 0 ? semanticCount : '✓'}
              </span>
            </button>
          </div>

          {/* Tab Content Panel */}
          <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-5)' }}>
            {loading ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-12)', gap: 'var(--space-3)' }}>
                <span className="spinner" style={{ width: '32px', height: '32px', borderTopColor: 'var(--accent-primary)' }} />
                <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>{t('lint.running')}</p>
              </div>
            ) : totalIssues === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-12)', gap: 'var(--space-4)', textAlign: 'center' }}>
                <div style={{
                  width: '64px',
                  height: '64px',
                  borderRadius: '50%',
                  background: 'rgba(16, 185, 129, 0.1)',
                  color: 'var(--success)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}>
                  <IconCheck size={36} />
                </div>
                <div>
                  <h3 style={{ margin: '0 0 var(--space-2) 0', fontSize: 'var(--text-lg)', fontWeight: 600 }}>
                    {t('lint.healthy')}
                  </h3>
                </div>
              </div>
            ) : (
              <>
                {/* ── Broken Links Tab ── */}
                {activeTab === 'broken' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                    <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', margin: 0 }}>
                      {t('lint.brokenLinksDesc')}
                    </p>

                    {brokenCount === 0 ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', color: 'var(--success)', padding: 'var(--space-4)', background: 'var(--bg-primary)', borderRadius: 'var(--radius-lg)' }}>
                        <IconCheck size={16} />
                        <span>{t('lint.noBrokenLinks')}</span>
                      </div>
                    ) : (
                      report?.broken_links.map((item, index) => {
                        const fixKey = `${item.file_path}-${item.target_title}-${item.line_number}`;
                        const isFixing = fixingId === fixKey;

                        return (
                          <div 
                            key={index} 
                            style={{
                              border: '1px solid var(--border)',
                              borderRadius: 'var(--radius-lg)',
                              padding: 'var(--space-4)',
                              background: 'var(--bg-secondary)',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 'var(--space-3)'
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                              <div>
                                <button
                                  onClick={() => handleOpenNote(item.file_path)}
                                  style={{
                                    border: 'none',
                                    background: 'none',
                                    padding: 0,
                                    color: 'var(--accent-primary)',
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                    fontSize: 'var(--text-md)',
                                    textAlign: 'left'
                                  }}
                                >
                                  {item.file_path.split(/[\\/]/).pop()?.replace('.md', '') || 'Note'}
                                </button>
                                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', wordBreak: 'break-all' }}>
                                  {item.file_path}
                                </div>
                              </div>
                              <span className="badge badge-danger" style={{ fontSize: 'var(--text-xs)' }}>
                                {t('lint.linkTo')
                                  .replace('{target}', item.target_title)
                                  .replace('{line}', String(item.line_number))}
                              </span>
                            </div>

                            {/* Line Context */}
                            <div style={{
                              background: 'var(--bg-primary)',
                              borderLeft: '3px solid var(--warning)',
                              padding: 'var(--space-2) var(--space-3)',
                              borderRadius: 'var(--radius-sm)',
                              fontFamily: 'monospace',
                              fontSize: 'var(--text-sm)',
                              overflowX: 'auto',
                              color: 'var(--text-primary)'
                            }}>
                              {item.context}
                            </div>

                            {/* Auto-fix Action Panel */}
                            <div style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'flex-end',
                              gap: 'var(--space-2)',
                              marginTop: 'var(--space-1)',
                              borderTop: '1px dashed var(--border-subtle)',
                              paddingTop: 'var(--space-3)'
                            }}>
                              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginRight: 'auto' }}>
                                {t('lint.autoFix')}:
                              </span>

                              <button
                                className="btn btn-sm"
                                disabled={creatingTitle === item.target_title || fixingId !== null}
                                onClick={() => handleCreateNote(item.target_title)}
                                style={{
                                  background: 'linear-gradient(135deg, #10b981, #059669)',
                                  color: '#fff',
                                  border: 'none',
                                  fontWeight: 600,
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 'var(--space-1)'
                                }}
                              >
                                {creatingTitle === item.target_title ? <span className="spinner" /> : (
                                  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                                  </svg>
                                )}
                                {navigator.language.startsWith('zh') ? '创建笔记' : 'Create Note'}
                              </button>

                              <button
                                className="btn btn-sm btn-ghost"
                                disabled={isFixing || fixingId !== null}
                                title={isFixing ? '正在修复中...' : fixingId !== null ? '请等待其他修复完成' : undefined}
                                onClick={() => handleFixLink(item, 'remove_brackets')}
                              >
                                {isFixing ? <span className="spinner" /> : null}
                                {t('lint.removeBrackets')}
                              </button>

                              {item.suggested_fix && (
                                <button
                                  className="btn btn-sm btn-primary"
                                  disabled={isFixing || fixingId !== null}
                                  title={isFixing ? '正在修复中...' : fixingId !== null ? '请等待其他修复完成' : undefined}
                                  onClick={() => handleFixLink(item, 'replace', item.suggested_fix || undefined)}
                                >
                                  {isFixing ? <span className="spinner" /> : null}
                                  {t('lint.replaceWith').replace('{target}', item.suggested_fix)}
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}

                {/* ── Orphans Tab ── */}
                {activeTab === 'orphans' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                    <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', margin: 0 }}>
                      {t('lint.orphansDesc')}
                    </p>

                    {orphanCount === 0 ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', color: 'var(--success)', padding: 'var(--space-4)', background: 'var(--bg-primary)', borderRadius: 'var(--radius-lg)' }}>
                        <IconCheck size={16} />
                        <span>{t('lint.noOrphans')}</span>
                      </div>
                    ) : (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 'var(--space-3)' }}>
                        {report?.orphans.map((item, index) => (
                          <div 
                            key={index} 
                            style={{
                              border: '1px solid var(--border)',
                              borderRadius: 'var(--radius-lg)',
                              padding: 'var(--space-4)',
                              background: 'var(--bg-secondary)',
                              display: 'flex',
                              flexDirection: 'column',
                              justifyContent: 'space-between',
                              gap: 'var(--space-3)'
                            }}
                          >
                            <div>
                              <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 'var(--text-md)' }}>
                                {item.title}
                              </div>
                              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', wordBreak: 'break-all', marginTop: '4px' }}>
                                {item.file_path}
                              </div>
                            </div>
                            <button
                              className="btn btn-sm btn-ghost"
                              style={{ width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 'var(--space-2)' }}
                              onClick={() => handleOpenNote(item.file_path)}
                            >
                              <IconNote size={14} />
                              {t('common.open')}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* ── Missing Metadata Tab ── */}
                {activeTab === 'missing' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                    <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', margin: 0 }}>
                      {t('lint.missingMetaDesc')}
                    </p>

                    {missingCount === 0 ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', color: 'var(--success)', padding: 'var(--space-4)', background: 'var(--bg-primary)', borderRadius: 'var(--radius-lg)' }}>
                        <IconCheck size={16} />
                        <span>{t('lint.allOrganized')}</span>
                      </div>
                    ) : (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 'var(--space-3)' }}>
                        {report?.missing_metadata.map((item, index) => (
                          <div 
                            key={index} 
                            style={{
                              border: '1px solid var(--border)',
                              borderRadius: 'var(--radius-lg)',
                              padding: 'var(--space-4)',
                              background: 'var(--bg-secondary)',
                              display: 'flex',
                              flexDirection: 'column',
                              justifyContent: 'space-between',
                              gap: 'var(--space-3)'
                            }}
                          >
                            <div>
                              <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 'var(--text-md)' }}>
                                {item.title}
                              </div>
                              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', wordBreak: 'break-all', marginTop: '4px' }}>
                                {item.file_path}
                              </div>
                            </div>
                            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                              <button
                                className="btn btn-sm btn-ghost"
                                style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 'var(--space-2)' }}
                                onClick={() => handleOpenNote(item.file_path)}
                              >
                                <IconNote size={14} />
                                {t('common.open')}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* ── Graph Health Tab ── */}
                {activeTab === 'graph' && gh && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                    <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', margin: 0 }}>
                      {navigator.language.startsWith('zh')
                        ? '知识图谱的结构健康指标：连通性、Hub 过载、单向关系、Embedding 覆盖率。'
                        : 'Structural health metrics: connectivity, hub overload, unidirectional relations, embedding coverage.'}
                    </p>

                    {/* Stats Grid */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-3)' }}>
                      {[
                        {
                          label: navigator.language.startsWith('zh') ? '节点' : 'Nodes',
                          value: gh.total_nodes,
                          color: 'var(--accent-primary)'
                        },
                        {
                          label: navigator.language.startsWith('zh') ? '边' : 'Edges',
                          value: gh.total_edges,
                          color: 'var(--accent-secondary, #0EA5E9)'
                        },
                        {
                          label: navigator.language.startsWith('zh') ? '连通分量' : 'Components',
                          value: gh.connected_components,
                          color: gh.connected_components > 1 ? 'var(--warning)' : 'var(--success)'
                        },
                        {
                          label: navigator.language.startsWith('zh') ? '最大分量' : 'Largest',
                          value: gh.total_nodes > 0
                            ? `${Math.round((gh.largest_component_size / gh.total_nodes) * 100)}%`
                            : '—',
                          color: 'var(--accent-primary)'
                        }
                      ].map((stat, i) => (
                        <div key={i} style={{
                          background: 'var(--bg-secondary)',
                          border: '1px solid var(--border)',
                          borderRadius: 'var(--radius-lg)',
                          padding: 'var(--space-4)',
                          textAlign: 'center'
                        }}>
                          <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 700, color: stat.color }}>
                            {stat.value}
                          </div>
                          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginTop: '2px' }}>
                            {stat.label}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Missing Embeddings */}
                    {gh.missing_embeddings > 0 && (
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--space-3)',
                        padding: 'var(--space-3) var(--space-4)',
                        background: 'rgba(245, 158, 11, 0.08)',
                        border: '1px solid rgba(245, 158, 11, 0.2)',
                        borderRadius: 'var(--radius-lg)',
                        color: 'var(--warning)',
                        fontSize: 'var(--text-sm)'
                      }}>
                        <IconWarning size={16} />
                        <span>
                          {navigator.language.startsWith('zh')
                            ? `${gh.missing_embeddings} 个文件缺少 Embedding，请在设置中生成 Embedding 索引。`
                            : `${gh.missing_embeddings} files missing embeddings. Generate embedding index in Settings.`}
                        </span>
                      </div>
                    )}

                    {/* Hub Overload */}
                    {gh.hub_overload.length > 0 && (
                      <div>
                        <h4 style={{ margin: '0 0 var(--space-3) 0', fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-primary)' }}>
                          {navigator.language.startsWith('zh') ? `Hub 过载 (${gh.hub_overload.length})` : `Hub Overload (${gh.hub_overload.length})`}
                        </h4>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                          {gh.hub_overload.map((hub, i) => (
                            <div key={i} style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              padding: 'var(--space-3) var(--space-4)',
                              background: 'var(--bg-secondary)',
                              border: '1px solid var(--border)',
                              borderRadius: 'var(--radius-md)',
                            }}>
                              <button
                                onClick={() => handleOpenNote(hub.file_path)}
                                style={{ border: 'none', background: 'none', padding: 0, color: 'var(--accent-primary)', fontWeight: 600, cursor: 'pointer', textAlign: 'left', fontSize: 'var(--text-sm)' }}
                              >
                                {hub.title}
                              </button>
                              <span className="badge badge-danger" style={{ fontSize: 'var(--text-xs)' }}>
                                {hub.degree} {navigator.language.startsWith('zh') ? '条边' : 'edges'}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Unidirectional Relations */}
                    {gh.unidirectional_relations.length > 0 && (
                      <div>
                        <h4 style={{ margin: '0 0 var(--space-3) 0', fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-primary)' }}>
                          {navigator.language.startsWith('zh')
                            ? `单向关系 (${gh.unidirectional_relations.length})`
                            : `Unidirectional (${gh.unidirectional_relations.length})`}
                        </h4>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                          {gh.unidirectional_relations.map((rel, i) => (
                            <div key={i} style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 'var(--space-2)',
                              padding: 'var(--space-2) var(--space-3)',
                              background: 'var(--bg-secondary)',
                              border: '1px solid var(--border)',
                              borderRadius: 'var(--radius-md)',
                              fontSize: 'var(--text-sm)',
                              flexWrap: 'wrap'
                            }}>
                              <span style={{ color: 'var(--text-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '35%' }}>
                                {rel.source.split(/[\\/]/).pop()?.replace('.md', '')}
                              </span>
                              <span style={{ color: 'var(--accent-primary)', fontSize: 'var(--text-xs)', fontWeight: 600 }}>→ {rel.relation_type}</span>
                              <span style={{ color: 'var(--text-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '35%' }}>
                                {rel.target.split(/[\\/]/).pop()?.replace('.md', '')}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* All clear */}
                    {gh.hub_overload.length === 0 && gh.missing_embeddings === 0 && gh.unidirectional_relations.length === 0 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', color: 'var(--success)', padding: 'var(--space-4)', background: 'var(--bg-primary)', borderRadius: 'var(--radius-lg)' }}>
                        <IconCheck size={16} />
                        <span>{navigator.language.startsWith('zh') ? '图谱结构健康，无异常' : 'Graph structure is healthy'}</span>
                      </div>
                    )}
                  </div>
                )}

                {/* ── Semantic Analysis Tab ── */}
                {activeTab === 'semantic' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                    <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', margin: 0 }}>
                      {navigator.language.startsWith('zh')
                        ? '基于 Embedding 语义相似度分析：检测疑似重复笔记和隐藏关联。需先构建向量索引。'
                        : 'Embedding-based semantic analysis: detect near-duplicate notes and hidden connections. Requires vector index.'}
                    </p>

                    {semanticCount === 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-8)', gap: 'var(--space-3)', textAlign: 'center' }}>
                        <div style={{
                          width: '48px', height: '48px', borderRadius: '50%',
                          background: 'rgba(16, 185, 129, 0.1)', color: 'var(--success)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center'
                        }}>
                          <IconCheck size={28} />
                        </div>
                        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                          {navigator.language.startsWith('zh') ? '未发现语义异常' : 'No semantic issues found'}
                        </div>
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                          {navigator.language.startsWith('zh')
                            ? '如果尚未构建向量索引，请先在 Dashboard 中运行「构建向量索引」'
                            : 'If vector index is not built, run "Build Vector Index" in Dashboard first'}
                        </div>
                      </div>
                    ) : (
                      <>
                        {/* Near Duplicates */}
                        {dupCount > 0 && (
                          <div>
                            <h4 style={{ margin: '0 0 var(--space-3) 0', fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                              <span style={{ color: '#EF4444' }}>⚠</span>
                              {navigator.language.startsWith('zh') ? `疑似重复 (${dupCount})` : `Near Duplicates (${dupCount})`}
                            </h4>
                            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', margin: '0 0 var(--space-3) 0' }}>
                              {navigator.language.startsWith('zh')
                                ? '这些笔记对的语义相似度 ≥ 92%，可能包含重复内容，建议检查是否需要合并。'
                                : 'These note pairs have ≥ 92% semantic similarity and may contain duplicate content.'}
                            </p>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                              {report?.semantic_duplicates.map((item, i) => (
                                <div key={i} style={{
                                  display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
                                  padding: 'var(--space-3) var(--space-4)',
                                  background: 'rgba(239, 68, 68, 0.04)',
                                  border: '1px solid rgba(239, 68, 68, 0.15)',
                                  borderRadius: 'var(--radius-md)',
                                  flexWrap: 'wrap'
                                }}>
                                  <button
                                    onClick={() => handleOpenNote(item.file_path_a)}
                                    style={{ border: 'none', background: 'none', padding: 0, color: 'var(--accent-primary)', fontWeight: 600, cursor: 'pointer', fontSize: 'var(--text-sm)', textAlign: 'left' }}
                                  >
                                    {item.title_a}
                                  </button>
                                  <span style={{
                                    fontSize: 'var(--text-xs)', fontWeight: 700, color: '#EF4444',
                                    background: 'rgba(239, 68, 68, 0.1)', padding: '2px 8px', borderRadius: '10px'
                                  }}>
                                    {Math.round(item.similarity * 100)}%
                                  </span>
                                  <button
                                    onClick={() => handleOpenNote(item.file_path_b)}
                                    style={{ border: 'none', background: 'none', padding: 0, color: 'var(--accent-primary)', fontWeight: 600, cursor: 'pointer', fontSize: 'var(--text-sm)', textAlign: 'left' }}
                                  >
                                    {item.title_b}
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Hidden Connections */}
                        {hiddenCount > 0 && (
                          <div>
                            <h4 style={{ margin: '0 0 var(--space-3) 0', fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                              <span style={{ color: '#8B5CF6' }}>🔗</span>
                              {navigator.language.startsWith('zh') ? `隐藏关联 (${hiddenCount})` : `Hidden Connections (${hiddenCount})`}
                            </h4>
                            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', margin: '0 0 var(--space-3) 0' }}>
                              {navigator.language.startsWith('zh')
                                ? '这些笔记语义相似度 ≥ 75%，但没有任何 Wikilink 或关系连接。建议添加链接加强知识网络。'
                                : 'These notes have ≥ 75% semantic similarity but no wikilinks or relations. Consider adding links.'}
                            </p>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                              {report?.hidden_connections.map((item, i) => (
                                <div key={i} style={{
                                  display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
                                  padding: 'var(--space-3) var(--space-4)',
                                  background: 'rgba(139, 92, 246, 0.04)',
                                  border: '1px solid rgba(139, 92, 246, 0.12)',
                                  borderRadius: 'var(--radius-md)',
                                  flexWrap: 'wrap'
                                }}>
                                  <button
                                    onClick={() => handleOpenNote(item.file_path_a)}
                                    style={{ border: 'none', background: 'none', padding: 0, color: 'var(--accent-primary)', fontWeight: 600, cursor: 'pointer', fontSize: 'var(--text-sm)', textAlign: 'left' }}
                                  >
                                    {item.title_a}
                                  </button>
                                  <span style={{
                                    fontSize: 'var(--text-xs)', fontWeight: 700, color: '#8B5CF6',
                                    background: 'rgba(139, 92, 246, 0.1)', padding: '2px 8px', borderRadius: '10px'
                                  }}>
                                    {Math.round(item.similarity * 100)}%
                                  </span>
                                  <button
                                    onClick={() => handleOpenNote(item.file_path_b)}
                                    style={{ border: 'none', background: 'none', padding: 0, color: 'var(--accent-primary)', fontWeight: 600, cursor: 'pointer', fontSize: 'var(--text-sm)', textAlign: 'left' }}
                                  >
                                    {item.title_b}
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>
            {t('lint.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
