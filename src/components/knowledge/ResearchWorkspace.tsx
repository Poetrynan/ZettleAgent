import React, { useEffect, useState, useCallback } from 'react';
import {
  researchAction,
  type ResearchProject,
} from '../../lib/research';
import { SourceViewer } from './SourceViewer';
import {
  IconFile,
  IconCheck,
  IconWarning,
  IconLoader,
  IconSearch,
  IconEdit,
  IconDownload,
  IconChat,
  IconSparkle,
} from '../icons';

interface ResearchWorkspaceProps {
  vaultPath: string | null;
  onOpenFile?: (path: string) => void;
  onOpenChat?: () => void;
}

export function ResearchWorkspace({
  vaultPath,
  onOpenFile,
  onOpenChat,
}: ResearchWorkspaceProps) {
  const [projects, setProjects] = useState<ResearchProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<ResearchProject | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'paused' | 'completed'>('all');

  // Create Modal
  const [isCreating, setIsCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newQuestion, setNewQuestion] = useState('');
  const [newSources, setNewSources] = useState('');
  const [newNextSteps, setNewNextSteps] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Source Viewer Modal
  const [activeSourcePath, setActiveSourcePath] = useState<string | null>(null);

  // Export status
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    if (!vaultPath) return;
    setLoading(true);
    setError(null);
    try {
      const res = await researchAction<ResearchProject[]>(vaultPath, 'list_projects', {});
      setProjects(res);
      if (res.length > 0 && !selectedProjectId) {
        setSelectedProjectId(res[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [vaultPath, selectedProjectId]);

  const loadProjectDetail = useCallback(async (id: string) => {
    if (!vaultPath) return;
    try {
      const res = await researchAction<ResearchProject>(vaultPath, 'get_project', { id });
      setSelectedProject(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [vaultPath]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (selectedProjectId) {
      void loadProjectDetail(selectedProjectId);
    } else {
      setSelectedProject(null);
    }
  }, [selectedProjectId, loadProjectDetail]);

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!vaultPath || !newTitle.trim() || !newQuestion.trim()) return;

    setSubmitting(true);
    try {
      const sources = newSources
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);
      const nextSteps = newNextSteps
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);

      const created = await researchAction<ResearchProject>(vaultPath, 'create_project', {
        title: newTitle.trim(),
        question: newQuestion.trim(),
        source_paths: sources,
        next_steps: nextSteps,
      });

      setIsCreating(false);
      setNewTitle('');
      setNewQuestion('');
      setNewSources('');
      setNewNextSteps('');

      await loadProjects();
      setSelectedProjectId(created.id);
    } catch (err) {
      alert(`创建研究项目失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdateStatus = async (status: 'active' | 'paused' | 'completed') => {
    if (!vaultPath || !selectedProject) return;
    try {
      const updated = await researchAction<ResearchProject>(vaultPath, 'update_project', {
        id: selectedProject.id,
        expected_version: selectedProject.version,
        patch: { status },
      });
      setSelectedProject(prev => (prev ? { ...prev, ...updated } : updated));
      setProjects(prev => prev.map(p => (p.id === updated.id ? { ...p, ...updated } : p)));
    } catch (err) {
      alert(`更新状态失败（可能是版本冲突）：${err instanceof Error ? err.message : String(err)}`);
      void loadProjectDetail(selectedProject.id);
    }
  };

  const handleExportBundle = async () => {
    if (!vaultPath || !selectedProject) return;
    try {
      const res = await researchAction<{ path: string; changeset_ids: string[]; exported_sources_count: number }>(
        vaultPath,
        'export_bundle_data',
        { id: selectedProject.id }
      );
      setExportNotice(`已成功生成研究数据包！包含 ${res.exported_sources_count ?? 0} 个来源副本。`);
      setTimeout(() => setExportNotice(null), 5000);
    } catch (err) {
      alert(`导出数据包失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleResumeInChat = () => {
    if (!selectedProject) return;
    const prompt = `【继续研究项目：${selectedProject.title}】\n核心课题：${selectedProject.question}\n已有关联资料：${selectedProject.source_paths.join(', ')}\n当前下一步：${selectedProject.next_steps.join('; ')}\n请从现有主张和未解决问题继续推进。`;

    window.dispatchEvent(
      new CustomEvent('zettel:chat-send-prompt', {
        detail: { prompt, scope: selectedProject.scope },
      })
    );

    if (onOpenChat) {
      onOpenChat();
    }
  };

  const filteredProjects = projects.filter(p => {
    const matchesSearch =
      !searchQuery ||
      p.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.question.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'all' || p.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <div className="research-workspace">
      {/* Sidebar: Projects List */}
      <aside className="research-sidebar">
        <div className="research-sidebar-header">
          <div className="research-search-bar">
            <IconSearch size={14} />
            <input
              type="text"
              placeholder="搜索研究项目…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="kc-btn kc-btn-primary kc-btn-sm"
            onClick={() => setIsCreating(true)}
          >
            + 新建项目
          </button>
        </div>

        <div className="research-filter-tabs">
          {(['all', 'active', 'paused', 'completed'] as const).map(tab => (
            <button
              key={tab}
              type="button"
              className={`research-filter-btn ${statusFilter === tab ? 'active' : ''}`}
              onClick={() => setStatusFilter(tab)}
            >
              {tab === 'all' && '全部'}
              {tab === 'active' && '进行中'}
              {tab === 'paused' && '已暂停'}
              {tab === 'completed' && '已完成'}
            </button>
          ))}
        </div>

        <div className="research-projects-list">
          {loading && projects.length === 0 && (
            <div className="kc-loading-box">
              <IconLoader size={16} />
              <span>加载研究项目…</span>
            </div>
          )}

          {!loading && filteredProjects.length === 0 && (
            <div className="kc-empty-box">暂无匹配的研究项目</div>
          )}

          {filteredProjects.map(proj => (
            <div
              key={proj.id}
              className={`research-project-card ${selectedProjectId === proj.id ? 'active' : ''}`}
              onClick={() => setSelectedProjectId(proj.id)}
            >
              <div className="research-project-card-header">
                <span className="research-project-title">{proj.title}</span>
                <span className={`research-status-pill status-${proj.status}`}>
                  {proj.status === 'active' ? '进行中' : proj.status === 'paused' ? '暂停' : '已完成'}
                </span>
              </div>
              <p className="research-project-question-preview">{proj.question}</p>
              <div className="research-project-card-meta">
                <span>版本 v{proj.version}</span>
                <span>{proj.source_paths.length} 资料</span>
                <span>{proj.claim_ids.length} 主张</span>
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* Main Details Panel */}
      <main className="research-main">
        {error && (
          <div className="kc-error-box">
            <IconWarning size={16} />
            <span>{error}</span>
          </div>
        )}

        {exportNotice && (
          <div className="kc-success-banner">
            <IconCheck size={16} />
            <span>{exportNotice}</span>
          </div>
        )}

        {!selectedProject ? (
          <div className="research-placeholder">
            <IconFile size={36} />
            <p>请选择一个左侧研究项目查看详情，或新建一个项目以持续保存核心课题。</p>
          </div>
        ) : (
          <div className="research-detail">
            <header className="research-detail-head">
              <div className="research-detail-title-group">
                <div className="research-badges-row">
                  <span className={`research-status-pill status-${selectedProject.status}`}>
                    {selectedProject.status === 'active' ? '进行中' : selectedProject.status === 'paused' ? '暂停' : '已完成'}
                  </span>
                  <span className="research-version-badge">Version v{selectedProject.version}</span>
                  <span className="research-id-badge">ID: {selectedProject.id}</span>
                </div>
                <h1 className="research-main-title">{selectedProject.title}</h1>
              </div>

              <div className="research-action-buttons">
                <button
                  type="button"
                  className="kc-btn kc-btn-primary"
                  onClick={handleResumeInChat}
                  title="携带研究问题与资料进入对话继续推导"
                >
                  <IconChat size={15} />
                  <span>在对话中继续研究</span>
                </button>

                <button
                  type="button"
                  className="kc-btn kc-btn-ghost"
                  onClick={handleExportBundle}
                  title="导出研究项目、主张与原件资料清单"
                >
                  <IconDownload size={15} />
                  <span>导出归档</span>
                </button>

                <div className="research-status-switch">
                  {selectedProject.status !== 'active' && (
                    <button
                      type="button"
                      className="kc-btn kc-btn-sm"
                      onClick={() => handleUpdateStatus('active')}
                    >
                      设为进行中
                    </button>
                  )}
                  {selectedProject.status !== 'paused' && (
                    <button
                      type="button"
                      className="kc-btn kc-btn-sm"
                      onClick={() => handleUpdateStatus('paused')}
                    >
                      暂停项目
                    </button>
                  )}
                  {selectedProject.status !== 'completed' && (
                    <button
                      type="button"
                      className="kc-btn kc-btn-sm"
                      onClick={() => handleUpdateStatus('completed')}
                    >
                      标记已完成
                    </button>
                  )}
                </div>
              </div>
            </header>

            <section className="research-section">
              <h3 className="research-section-title">核心研究课题与假设 (Research Question)</h3>
              <div className="research-question-box">
                <p>{selectedProject.question}</p>
              </div>
            </section>

            <div className="research-columns-grid">
              {/* Unresolved Questions & Next Steps */}
              <section className="research-section">
                <h3 className="research-section-title">待解疑问与行动下一步 (Next Steps)</h3>
                {selectedProject.unresolved_questions.length > 0 && (
                  <div className="research-sub-list">
                    <h4 className="research-sub-title">待解决疑问：</h4>
                    <ul>
                      {selectedProject.unresolved_questions.map((uq, idx) => (
                        <li key={idx}>{uq}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="research-sub-list">
                  <h4 className="research-sub-title">下一步规划：</h4>
                  {selectedProject.next_steps.length === 0 ? (
                    <p className="kc-hint-text">暂无下一步规划</p>
                  ) : (
                    <ul>
                      {selectedProject.next_steps.map((ns, idx) => (
                        <li key={idx}>{ns}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>

              {/* Source Documents */}
              <section className="research-section">
                <h3 className="research-section-title">关联来源资料库 (Sources)</h3>
                {selectedProject.source_paths.length === 0 ? (
                  <p className="kc-hint-text">暂无关联资料</p>
                ) : (
                  <div className="research-sources-list">
                    {selectedProject.source_paths.map((sp, idx) => (
                      <div key={idx} className="research-source-item">
                        <IconFile size={15} />
                        <span className="research-source-path" title={sp}>
                          {sp}
                        </span>
                        <div className="research-source-ops">
                          <button
                            type="button"
                            className="kc-btn kc-btn-xs"
                            onClick={() => setActiveSourcePath(sp)}
                            title="精准核验/查看片段"
                          >
                            核验
                          </button>
                          {onOpenFile && (
                            <button
                              type="button"
                              className="kc-btn kc-btn-xs kc-btn-ghost"
                              onClick={() => onOpenFile(sp)}
                              title="在编辑器打开"
                            >
                              打开
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </div>
        )}
      </main>

      {/* Create Project Modal */}
      {isCreating && (
        <div className="kc-modal-overlay">
          <div className="kc-modal-content">
            <header className="kc-modal-header">
              <h3>新建持久化研究项目</h3>
              <button
                type="button"
                className="kc-btn kc-btn-icon"
                onClick={() => setIsCreating(false)}
              >
                ✕
              </button>
            </header>
            <form onSubmit={handleCreateProject}>
              <div className="kc-form-group">
                <label>项目名称 (Title):</label>
                <input
                  type="text"
                  required
                  placeholder="例如：卢曼卡片盒笔记法一手资料核验"
                  value={newTitle}
                  onChange={e => setNewTitle(e.target.value)}
                />
              </div>
              <div className="kc-form-group">
                <label>核心研究问题与假设 (Research Question):</label>
                <textarea
                  required
                  rows={3}
                  placeholder="围绕什么核心问题进行？例如：卢曼关于'无计划思考'的原话究竟是什么？在什么语境下提出？"
                  value={newQuestion}
                  onChange={e => setNewQuestion(e.target.value)}
                />
              </div>
              <div className="kc-form-group">
                <label>初始关联资料路径 (每行一个):</label>
                <textarea
                  rows={3}
                  placeholder="sources/luhmann1981.pdf&#10;notes/zettelkasten_history.md"
                  value={newSources}
                  onChange={e => setNewSources(e.target.value)}
                />
              </div>
              <div className="kc-form-group">
                <label>下一步规划 (每行一条):</label>
                <textarea
                  rows={2}
                  placeholder="查阅德文一手论文原页&#10;核验关键主张并提取证据"
                  value={newNextSteps}
                  onChange={e => setNewNextSteps(e.target.value)}
                />
              </div>
              <footer className="kc-modal-footer">
                <button
                  type="button"
                  className="kc-btn"
                  onClick={() => setIsCreating(false)}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="kc-btn kc-btn-primary"
                  disabled={submitting}
                >
                  {submitting ? '创建中…' : '创建项目'}
                </button>
              </footer>
            </form>
          </div>
        </div>
      )}

      {/* Precise Source Viewer Modal */}
      {activeSourcePath && (
        <SourceViewer
          vaultPath={vaultPath}
          path={activeSourcePath}
          onClose={() => setActiveSourcePath(null)}
          onOpenFile={onOpenFile}
        />
      )}
    </div>
  );
}
