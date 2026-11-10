import React, { useEffect, useState, useCallback } from 'react';
import {
  researchAction,
  type Claim,
  type ClaimEvidence,
  type ResearchProject,
  type ClaimTraceResult,
  type ImpactPreviewResult,
  type ReviewDraftItem,
} from '../../lib/research';
import { SourceViewer } from './SourceViewer';
import {
  IconFile,
  IconCheck,
  IconWarning,
  IconContradicted,
  IconLoader,
  IconSearch,
  IconSparkle,
  IconNetwork,
  IconChart,
} from '../icons';

interface ClaimsWorkspaceProps {
  vaultPath: string | null;
  onOpenFile?: (path: string) => void;
}

export function ClaimsWorkspace({
  vaultPath,
  onOpenFile,
}: ClaimsWorkspaceProps) {
  const [claims, setClaims] = useState<Claim[]>([]);
  const [projects, setProjects] = useState<ResearchProject[]>([]);
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null);
  const [selectedClaim, setSelectedClaim] = useState<Claim | null>(null);
  const [selectedProjectFilter, setSelectedProjectFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Trace & Impact Modals
  const [traceData, setTraceData] = useState<ClaimTraceResult | null>(null);
  const [impactData, setImpactData] = useState<ImpactPreviewResult | null>(null);
  const [reviewDrafts, setReviewDrafts] = useState<ReviewDraftItem[] | null>(null);

  // Source Viewer Modal
  const [activeSource, setActiveSource] = useState<{
    path: string;
    quote?: string;
    quoteKind?: 'original' | 'translation' | 'paraphrase';
  } | null>(null);

  // Create Claim Modal
  const [isCreating, setIsCreating] = useState(false);
  const [formTitle, setFormTitle] = useState('');
  const [formContent, setFormContent] = useState('');
  const [formConditions, setFormConditions] = useState('');
  const [formStatus, setFormStatus] = useState<'proposed' | 'confirmed' | 'disputed' | 'superseded'>('proposed');
  const [formProjectId, setFormProjectId] = useState('');
  const [formEvidencePath, setFormEvidencePath] = useState('');
  const [formEvidenceQuote, setFormEvidenceQuote] = useState('');
  const [formEvidenceKind, setFormEvidenceKind] = useState<'original' | 'translation' | 'paraphrase'>('original');
  const [formEvidenceRole, setFormEvidenceRole] = useState<'supports' | 'contradicts' | 'source'>('supports');
  const [formEvidenceLocator, setFormEvidenceLocator] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadData = useCallback(async () => {
    if (!vaultPath) return;
    setLoading(true);
    setError(null);
    try {
      const [claimsRes, projectsRes] = await Promise.all([
        researchAction<Claim[]>(
          vaultPath,
          'list_claims',
          selectedProjectFilter !== 'all' ? { project_id: selectedProjectFilter } : {}
        ),
        researchAction<ResearchProject[]>(vaultPath, 'list_projects', {}),
      ]);
      setClaims(claimsRes);
      setProjects(projectsRes);
      if (claimsRes.length > 0 && !selectedClaimId) {
        setSelectedClaimId(claimsRes[0].id);
        setSelectedClaim(claimsRes[0]);
      } else if (selectedClaimId) {
        const found = claimsRes.find(c => c.id === selectedClaimId);
        if (found) setSelectedClaim(found);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [vaultPath, selectedProjectFilter, selectedClaimId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleSelectClaim = (claim: Claim) => {
    setSelectedClaimId(claim.id);
    setSelectedClaim(claim);
    setTraceData(null);
    setImpactData(null);
    setReviewDrafts(null);
  };

  const handleCreateClaim = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!vaultPath || !formTitle.trim() || !formContent.trim()) return;

    setSubmitting(true);
    try {
      const evidence_inputs = formEvidencePath.trim()
        ? [
            {
              path: formEvidencePath.trim(),
              quote: formEvidenceQuote.trim(),
              quote_kind: formEvidenceKind,
              role: formEvidenceRole,
              locator: formEvidenceLocator.trim() || undefined,
            },
          ]
        : [];

      const saved = await researchAction<Claim>(vaultPath, 'save_claim', {
        title: formTitle.trim(),
        content: formContent.trim(),
        conditions: formConditions.trim(),
        status: formStatus,
        project_id: formProjectId.trim() || undefined,
        evidence_inputs,
      });

      setIsCreating(false);
      setFormTitle('');
      setFormContent('');
      setFormConditions('');
      setFormEvidencePath('');
      setFormEvidenceQuote('');
      setFormEvidenceLocator('');

      await loadData();
      setSelectedClaimId(saved.id);
      setSelectedClaim(saved);
    } catch (err) {
      alert(`保存主张失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleTraceClaim = async () => {
    if (!vaultPath || !selectedClaim) return;
    try {
      const res = await researchAction<ClaimTraceResult>(vaultPath, 'trace_claim', {
        id: selectedClaim.id,
      });
      setTraceData(res);
    } catch (err) {
      alert(`追踪主张失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handlePreviewImpact = async () => {
    if (!vaultPath || !selectedClaim) return;
    try {
      const res = await researchAction<ImpactPreviewResult>(vaultPath, 'preview_change_impact', {
        id: selectedClaim.id,
      });
      setImpactData(res);
    } catch (err) {
      alert(`预览影响失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleGenerateReviews = async () => {
    if (!vaultPath || !selectedClaim) return;
    try {
      const res = await researchAction<{ items: ReviewDraftItem[]; count: number }>(
        vaultPath,
        'generate_review_items',
        { id: selectedClaim.id }
      );
      setReviewDrafts(res.items);
    } catch (err) {
      alert(`生成复习题失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const filteredClaims = claims.filter(c => {
    return (
      !searchQuery ||
      c.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.conditions.toLowerCase().includes(searchQuery.toLowerCase())
    );
  });

  const supportingEvidence = selectedClaim?.evidence.filter(e => e.role === 'supports') ?? [];
  const opposingEvidence = selectedClaim?.evidence.filter(e => e.role === 'contradicts') ?? [];
  const otherEvidence = selectedClaim?.evidence.filter(e => e.role !== 'supports' && e.role !== 'contradicts') ?? [];

  return (
    <div className="claims-workspace">
      {/* Sidebar: Claims list */}
      <aside className="claims-sidebar">
        <div className="claims-sidebar-header">
          <div className="claims-search-bar">
            <IconSearch size={14} />
            <input
              type="text"
              placeholder="搜索主张与适用条件…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="kc-btn kc-btn-primary kc-btn-sm"
            onClick={() => setIsCreating(true)}
          >
            + 记录主张
          </button>
        </div>

        {projects.length > 0 && (
          <div className="claims-project-filter">
            <label>筛选所属项目：</label>
            <select
              value={selectedProjectFilter}
              onChange={e => setSelectedProjectFilter(e.target.value)}
            >
              <option value="all">所有研究项目</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="claims-list">
          {loading && claims.length === 0 && (
            <div className="kc-loading-box">
              <IconLoader size={16} />
              <span>读取主张与证据…</span>
            </div>
          )}

          {!loading && filteredClaims.length === 0 && (
            <div className="kc-empty-box">暂无匹配的主张条目</div>
          )}

          {filteredClaims.map(c => (
            <div
              key={c.id}
              className={`claim-card ${selectedClaimId === c.id ? 'active' : ''}`}
              onClick={() => handleSelectClaim(c)}
            >
              <div className="claim-card-header">
                <span className="claim-card-title">{c.title}</span>
                <span className={`claim-status-pill status-${c.status}`}>
                  {c.status === 'confirmed'
                    ? '已证实'
                    : c.status === 'disputed'
                    ? '有争议'
                    : c.status === 'superseded'
                    ? '已取代'
                    : '待确认'}
                </span>
              </div>
              <p className="claim-card-content-preview">{c.content}</p>
              <div className="claim-card-meta">
                <span>{c.evidence.length} 条证据</span>
                {c.conditions && <span className="claim-card-cond-tag">有适用条件</span>}
                <span>v{c.version}</span>
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* Main Details Panel */}
      <main className="claims-main">
        {error && (
          <div className="kc-error-box">
            <IconWarning size={16} />
            <span>{error}</span>
          </div>
        )}

        {!selectedClaim ? (
          <div className="claims-placeholder">
            <IconFile size={36} />
            <p>请选择一个左侧主张条目查看支持/反驳证据，或记录新的核心主张。</p>
          </div>
        ) : (
          <div className="claim-detail">
            <header className="claim-detail-head">
              <div className="claim-detail-title-group">
                <div className="claim-badges-row">
                  <span className={`claim-status-pill status-${selectedClaim.status}`}>
                    {selectedClaim.status === 'confirmed'
                      ? '已证实 (Confirmed)'
                      : selectedClaim.status === 'disputed'
                      ? '有争议 (Disputed)'
                      : selectedClaim.status === 'superseded'
                      ? '已被取代 (Superseded)'
                      : '待确认观点 (Proposed)'}
                  </span>
                  <span className="claim-version-badge">Version v{selectedClaim.version}</span>
                  <span className="claim-id-badge">ID: {selectedClaim.id}</span>
                </div>
                <h1 className="claim-main-title">{selectedClaim.title}</h1>
              </div>

              <div className="claim-action-buttons">
                <button
                  type="button"
                  className="kc-btn kc-btn-ghost"
                  onClick={handleTraceClaim}
                  title="查看主张关联的完整证据与关系依赖链"
                >
                  <IconNetwork size={14} />
                  <span>追踪依赖</span>
                </button>

                <button
                  type="button"
                  className="kc-btn kc-btn-ghost"
                  onClick={handlePreviewImpact}
                  title="修改前预览受影响的笔记、衍生主张与项目"
                >
                  <IconChart size={14} />
                  <span>影响预览</span>
                </button>

                <button
                  type="button"
                  className="kc-btn kc-btn-ghost"
                  onClick={handleGenerateReviews}
                  title="将本主张转化为有证据支持的复习题草稿并接入 FSRS"
                >
                  <IconSparkle size={14} />
                  <span>生成复习题</span>
                </button>
              </div>
            </header>

            {/* Trace Panel if active */}
            {traceData && (
              <div className="claim-sub-panel">
                <div className="claim-sub-panel-head">
                  <h4>🔗 主张依赖网络与来源追踪</h4>
                  <button type="button" className="kc-btn kc-btn-xs" onClick={() => setTraceData(null)}>
                    收起
                  </button>
                </div>
                <div className="claim-sub-panel-content">
                  <p>
                    包含支持证据 {traceData.supporting_evidence.length} 条，反对证据{' '}
                    {traceData.opposing_evidence.length} 条，依赖关系{' '}
                    {traceData.dependencies.length} 条。
                  </p>
                  {traceData.dependencies.length > 0 && (
                    <ul className="claim-deps-list">
                      {traceData.dependencies.map((d, idx) => (
                        <li key={idx}>
                          <span>{d.relation_type}:</span> {d.source} ➔ {d.target} (置信度 {d.confidence})
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}

            {/* Impact Panel if active */}
            {impactData && (
              <div className="claim-sub-panel impact-panel">
                <div className="claim-sub-panel-head">
                  <h4>⚠️ 修改影响预估 (Impact Analysis)</h4>
                  <button type="button" className="kc-btn kc-btn-xs" onClick={() => setImpactData(null)}>
                    收起
                  </button>
                </div>
                <div className="claim-sub-panel-content">
                  <p>
                    若修改或撤回此事实，将影响 <strong>{impactData.total_impacted}</strong> 处直接依赖项：
                  </p>
                  <ul>
                    {impactData.affected_claims.map((ac, idx) => (
                      <li key={idx}>主张: {ac.title} ({ac.id})</li>
                    ))}
                    {impactData.affected_projects.map((ap, idx) => (
                      <li key={idx}>研究项目: {ap.title} ({ap.id})</li>
                    ))}
                    {impactData.affected_notes.map((an, idx) => (
                      <li key={idx}>笔记: {an.path || an.id} [{an.relation}]</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {/* Review Drafts Panel if active */}
            {reviewDrafts && (
              <div className="claim-sub-panel review-panel">
                <div className="claim-sub-panel-head">
                  <h4>🧠 自动生成的 FSRS 间隔复习题草稿</h4>
                  <button type="button" className="kc-btn kc-btn-xs" onClick={() => setReviewDrafts(null)}>
                    收起
                  </button>
                </div>
                <div className="claim-sub-panel-content">
                  {reviewDrafts.map((rd, idx) => (
                    <div key={idx} className="review-draft-card">
                      <div className="review-question"><strong>Q:</strong> {rd.question}</div>
                      <div className="review-answer"><strong>A:</strong> {rd.answer}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Claim Content */}
            <section className="claim-section">
              <h3 className="claim-section-title">核心主张论断 (Claim Statement)</h3>
              <div className="claim-statement-box">
                <p>{selectedClaim.content}</p>
              </div>
            </section>

            {/* Conditions Box */}
            <section className="claim-section">
              <h3 className="claim-section-title">适用条件与成立前提 (Conditions & Scope)</h3>
              <div className="claim-conditions-box">
                {selectedClaim.conditions ? (
                  <p>{selectedClaim.conditions}</p>
                ) : (
                  <p className="kc-hint-text">未限定特定成立前提（普遍主张）</p>
                )}
              </div>
            </section>

            {/* Evidence Comparison Grid */}
            <div className="claim-evidence-grid">
              {/* Supporting Evidence */}
              <div className="evidence-column supports">
                <h4 className="evidence-column-title">
                  <IconCheck size={16} />
                  <span>支持证据 (Supporting Evidence) · {supportingEvidence.length}</span>
                </h4>
                {supportingEvidence.length === 0 ? (
                  <p className="kc-hint-text">暂无已登记的支持证据</p>
                ) : (
                  <div className="evidence-cards-list">
                    {supportingEvidence.map(ev => (
                      <div key={ev.id} className="evidence-card card-supports">
                        <div className="evidence-card-head">
                          <span className="evidence-source-link">{ev.source_id}</span>
                          {ev.locator && <span className="evidence-locator">{ev.locator}</span>}
                        </div>
                        {ev.excerpt && <blockquote className="evidence-excerpt">“{ev.excerpt}”</blockquote>}
                        <div className="evidence-card-footer">
                          <button
                            type="button"
                            className="kc-btn kc-btn-xs"
                            onClick={() =>
                              setActiveSource({
                                path: ev.locator ? `${ev.source_id}${ev.locator}` : ev.source_id,
                                quote: ev.excerpt,
                              })
                            }
                          >
                            核验原句
                          </button>
                          {onOpenFile && (
                            <button
                              type="button"
                              className="kc-btn kc-btn-xs kc-btn-ghost"
                              onClick={() => onOpenFile(ev.source_id)}
                            >
                              打开原文件
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Contradicting Evidence */}
              <div className="evidence-column contradicts">
                <h4 className="evidence-column-title">
                  <IconContradicted size={16} />
                  <span>反驳 / 限制证据 (Opposing Evidence) · {opposingEvidence.length}</span>
                </h4>
                {opposingEvidence.length === 0 ? (
                  <p className="kc-hint-text">暂无相反或限制性证据</p>
                ) : (
                  <div className="evidence-cards-list">
                    {opposingEvidence.map(ev => (
                      <div key={ev.id} className="evidence-card card-contradicts">
                        <div className="evidence-card-head">
                          <span className="evidence-source-link">{ev.source_id}</span>
                          {ev.locator && <span className="evidence-locator">{ev.locator}</span>}
                        </div>
                        {ev.excerpt && <blockquote className="evidence-excerpt">“{ev.excerpt}”</blockquote>}
                        <div className="evidence-card-footer">
                          <button
                            type="button"
                            className="kc-btn kc-btn-xs"
                            onClick={() =>
                              setActiveSource({
                                path: ev.locator ? `${ev.source_id}${ev.locator}` : ev.source_id,
                                quote: ev.excerpt,
                              })
                            }
                          >
                            核验原句
                          </button>
                          {onOpenFile && (
                            <button
                              type="button"
                              className="kc-btn kc-btn-xs kc-btn-ghost"
                              onClick={() => onOpenFile(ev.source_id)}
                            >
                              打开原文件
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Other general sources */}
            {otherEvidence.length > 0 && (
              <section className="claim-section">
                <h4 className="evidence-column-title">其他参考来源资料 ({otherEvidence.length})</h4>
                <div className="evidence-cards-list">
                  {otherEvidence.map(ev => (
                    <div key={ev.id} className="evidence-card">
                      <div className="evidence-card-head">
                        <span className="evidence-source-link">{ev.source_id}</span>
                        {ev.locator && <span className="evidence-locator">{ev.locator}</span>}
                      </div>
                      {ev.excerpt && <blockquote className="evidence-excerpt">“{ev.excerpt}”</blockquote>}
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </main>

      {/* Create Claim Modal */}
      {isCreating && (
        <div className="kc-modal-overlay">
          <div className="kc-modal-content">
            <header className="kc-modal-header">
              <h3>记录新论断 / 主张 (New Claim)</h3>
              <button
                type="button"
                className="kc-btn kc-btn-icon"
                onClick={() => setIsCreating(false)}
              >
                ✕
              </button>
            </header>
            <form onSubmit={handleCreateClaim}>
              <div className="kc-form-group">
                <label>主张标题 (Claim Title):</label>
                <input
                  type="text"
                  required
                  placeholder="例如：间歇性禁食对啮齿类寿命的延长受品系调控"
                  value={formTitle}
                  onChange={e => setFormTitle(e.target.value)}
                />
              </div>

              <div className="kc-form-group">
                <label>核心主张陈述 (Statement):</label>
                <textarea
                  required
                  rows={2}
                  placeholder="准确陈述主张内容…"
                  value={formContent}
                  onChange={e => setFormContent(e.target.value)}
                />
              </div>

              <div className="kc-form-group">
                <label>适用条件与前提 (Conditions):</label>
                <textarea
                  rows={2}
                  placeholder="在什么样本、实验条件、定义或时间跨度下成立？不同条件下的不同结论不应简单标为矛盾。"
                  value={formConditions}
                  onChange={e => setFormConditions(e.target.value)}
                />
              </div>

              <div className="kc-form-row">
                <div className="kc-form-group">
                  <label>初始状态:</label>
                  <select
                    value={formStatus}
                    onChange={e => setFormStatus(e.target.value as any)}
                  >
                    <option value="proposed">待确认 (Proposed)</option>
                    <option value="confirmed">已证实 (Confirmed)</option>
                    <option value="disputed">有争议 (Disputed)</option>
                  </select>
                </div>

                {projects.length > 0 && (
                  <div className="kc-form-group">
                    <label>所属研究课题:</label>
                    <select
                      value={formProjectId}
                      onChange={e => setFormProjectId(e.target.value)}
                    >
                      <option value="">(无独立关联项目)</option>
                      {projects.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.title}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              <div className="kc-form-divider">附带第一条来源证据（可选）：</div>

              <div className="kc-form-row">
                <div className="kc-form-group flex-2">
                  <label>来源文件路径:</label>
                  <input
                    type="text"
                    placeholder="sources/weindruch1986.pdf"
                    value={formEvidencePath}
                    onChange={e => setFormEvidencePath(e.target.value)}
                  />
                </div>
                <div className="kc-form-group">
                  <label>坐标 (#L10-L20 / #page=4):</label>
                  <input
                    type="text"
                    placeholder="#page=4"
                    value={formEvidenceLocator}
                    onChange={e => setFormEvidenceLocator(e.target.value)}
                  />
                </div>
              </div>

              <div className="kc-form-row">
                <div className="kc-form-group flex-2">
                  <label>证据角色:</label>
                  <select
                    value={formEvidenceRole}
                    onChange={e => setFormEvidenceRole(e.target.value as any)}
                  >
                    <option value="supports">支持该主张 (Supports)</option>
                    <option value="contradicts">反驳 / 限制该主张 (Contradicts)</option>
                    <option value="source">一般参考源 (Source)</option>
                  </select>
                </div>
                <div className="kc-form-group">
                  <label>引文属性:</label>
                  <select
                    value={formEvidenceKind}
                    onChange={e => setFormEvidenceKind(e.target.value as any)}
                  >
                    <option value="original">一手原文 (Original)</option>
                    <option value="translation">译文 (Translation)</option>
                    <option value="paraphrase">转述 (Paraphrase)</option>
                  </select>
                </div>
              </div>

              <div className="kc-form-group">
                <label>原文摘录:</label>
                <textarea
                  rows={2}
                  placeholder="引用原文具体句子（翻译/转述已明确区分）…"
                  value={formEvidenceQuote}
                  onChange={e => setFormEvidenceQuote(e.target.value)}
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
                  {submitting ? '保存中…' : '保存主张'}
                </button>
              </footer>
            </form>
          </div>
        </div>
      )}

      {/* Precise Source Viewer Modal */}
      {activeSource && (
        <SourceViewer
          vaultPath={vaultPath}
          path={activeSource.path}
          quote={activeSource.quote}
          quoteKind={activeSource.quoteKind}
          onClose={() => setActiveSource(null)}
          onOpenFile={onOpenFile}
        />
      )}
    </div>
  );
}
