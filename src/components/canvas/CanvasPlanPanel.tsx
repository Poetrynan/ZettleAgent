/**
 * CanvasPlanPanel — 目标 → 计划 → 预览 → 部分批准 → 提交 → 验证
 *
 * 与 SmartCanvasPanel 的区别不是多了几个按钮，而是**每一步的话都有出处**：
 *
 * - 提议按后端算出的 `confidence` 排，只有 ≥ 0.8 的默认勾选，其余要用户自己点；
 * - 「预览」只 stage，不写盘，卡片上写的就是后端返回的 `state`；
 * - 成功/失败文案全部由 `outcomeHeadline` 从后端计数推出，不在调用返回后乐观弹一句；
 * - 请求的布局做不到时，`layoutFallbackReason` 原样显示出来。
 *
 * 视觉上完全复用画布已有的 `smart-canvas-*` / `canvas-smart-*` 类，不引入新样式。
 */
import { useCallback, useMemo, useState } from 'react';
import {
  CANVAS_PLAN_STAGES,
  type CanvasGoal,
  type CanvasPlan,
  type CanvasPlanOutcome,
  type CanvasPlanStage,
  type CanvasPlanVerification,
  type CanvasProposal,
  commitCanvasPlan,
  createCanvasPlan,
  defaultSelection,
  outcomeHeadline,
  outcomeTone,
  rollbackCanvasPlan,
  stageCanvasPlan,
  verifyCanvasPlan,
} from '../../lib/canvasPlan';

interface CanvasPlanPanelProps {
  isOpen: boolean;
  onClose: () => void;
  lang: string;
  /** 当前打开的画布文件。没有画布时面板给出说明而不是静默不动。 */
  canvasPath: string | null;
  vaultPath: string;
  vaultPaths: string[];
  /** 画布上已有的笔记路径，用作锚点候选。 */
  canvasNodePaths: string[];
  /** 提交成功后让画布重新读盘。 */
  onCommitted: () => void;
}

/**
 * 面板自己的文案表 / this panel's strings.
 *
 * 共享 i18n 文件由别处占着，而周围的画布组件本来就用 `isZh ? 'zh' : 'en'` 的字面量写
 * 法。跟着它们走，不在一个组件里混两套 i18n 机制。
 */
const T = {
  title: ['Canvas Plan', 'Canvas Plan'],
  goal: ['目标', 'Goal'],
  explain: ['解释一篇笔记', 'Explain a note'],
  compare: ['对比多篇笔记', 'Compare notes'],
  trace: ['追溯推理链', 'Trace a chain'],
  cluster: ['把相关笔记分堆', 'Cluster related notes'],
  question: ['想弄清什么？（可留空）', 'What do you want to see? (optional)'],
  anchors: ['锚点笔记', 'Anchor notes'],
  noAnchors: ['画布上还没有笔记节点，先添加一篇再生成计划。', 'No note nodes on the canvas yet — add one first.'],
  build: ['生成计划', 'Build plan'],
  noCanvas: ['先打开或保存一张画布，计划才知道要写到哪里。', 'Open or save a canvas first, so the plan knows where to write.'],
  proposals: ['提议', 'Proposals'],
  selected: ['已选', 'selected'],
  layoutUsed: ['实际布局', 'Layout used'],
  fallback: ['布局降级说明', 'Layout fell back'],
  preview: ['生成预览（不写入）', 'Preview (writes nothing)'],
  commit: ['写入画布', 'Write to canvas'],
  verify: ['验证', 'Verify'],
  rollback: ['撤销', 'Undo'],
  unresolved: ['这一轮没能回答的问题', 'Left unanswered this round'],
  observations: ['观察', 'Observations'],
  evidence: ['依据', 'Evidence'],
  fileLevel: ['文件级依据（没有精确到片段）', 'File-level evidence (no chunk)'],
  willAdd: ['预览将加入', 'Preview will add'],
  nodes: ['个节点', 'nodes'],
  groups: ['个分组', 'groups'],
  edges: ['条连线', 'edges'],
} as const;

/** 提议卡片上显示的操作名。 */
const OPERATION_LABEL: Record<string, readonly [string, string]> = {
  add_node: ['加节点', 'add node'],
  add_group: ['加分组', 'add group'],
  add_edge: ['加连线', 'add edge'],
  arrange: ['排版', 'arrange'],
};

export function CanvasPlanPanel({
  isOpen,
  onClose,
  lang,
  canvasPath,
  vaultPath,
  vaultPaths,
  canvasNodePaths,
  onCommitted,
}: CanvasPlanPanelProps) {
  const isZh = lang === 'zh';
  const t = useCallback(
    (key: keyof typeof T) => (isZh ? T[key][0] : T[key][1]),
    [isZh],
  );

  const [goalType, setGoalType] = useState<CanvasGoal['goalType']>('explain');
  const [question, setQuestion] = useState('');
  const [anchors, setAnchors] = useState<string[]>([]);
  const [plan, setPlan] = useState<CanvasPlan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [stage, setStage] = useState<CanvasPlanStage>('idle');
  const [outcome, setOutcome] = useState<CanvasPlanOutcome | null>(null);
  const [verification, setVerification] = useState<CanvasPlanVerification | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileName = (path: string) =>
    path.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/, '') || path;

  const toggleAnchor = (path: string) =>
    setAnchors((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path],
    );

  const toggleProposal = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** 预览会加入什么。数的是**勾中的**提议，不是整份计划。 */
  const previewCounts = useMemo(() => {
    const chosen = (plan?.proposals ?? []).filter((p) => selected.has(p.id));
    return {
      nodes: chosen.filter((p) => p.operation === 'add_node').length,
      groups: chosen.filter((p) => p.operation === 'add_group').length,
      edges: chosen.filter((p) => p.operation === 'add_edge').length,
    };
  }, [plan, selected]);

  const handleBuild = useCallback(async () => {
    if (!canvasPath) return;
    setBusy(true);
    setError(null);
    setOutcome(null);
    setVerification(null);
    setStage('retrieving');
    try {
      const goal: CanvasGoal = {
        goalType,
        scope: { paths: [], cluster: null },
        anchorPaths: anchors,
        question,
        constraints: [],
        maxNodes: null,
      };
      setStage('analyzing');
      const built = await createCanvasPlan(goal, canvasPath);
      setPlan(built);
      // 只勾高置信度的那几条。其余保持未勾选，等用户逐条看过再决定。
      setSelected(new Set(defaultSelection(built.proposals)));
      setStage('preview_ready');
    } catch (e) {
      setError(String(e));
      setStage('idle');
    }
    setBusy(false);
  }, [anchors, canvasPath, goalType, question]);

  const handlePreview = useCallback(async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    setVerification(null);
    try {
      const result = await stageCanvasPlan(
        plan.id,
        Array.from(selected),
        vaultPath,
        vaultPaths,
      );
      // 阶段直接用后端返回的 state，前端不另猜一个。
      setOutcome(result);
      setStage(result.state as CanvasPlanStage);
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  }, [plan, selected, vaultPath, vaultPaths]);

  const handleCommit = useCallback(async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    setStage('applying');
    try {
      const result = await commitCanvasPlan(plan.id);
      setOutcome(result);
      setStage(result.state as CanvasPlanStage);
      // 只有后端说真写进去了才让画布重新读盘。
      if (result.applied > 0) onCommitted();
    } catch (e) {
      setError(String(e));
      setStage('failed' as CanvasPlanStage);
    }
    setBusy(false);
  }, [onCommitted, plan]);

  const handleVerify = useCallback(async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    setStage('verifying');
    try {
      setVerification(await verifyCanvasPlan(plan.id));
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  }, [plan]);

  const handleRollback = useCallback(async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const result = await rollbackCanvasPlan(plan.id);
      setOutcome(result);
      setStage(result.state as CanvasPlanStage);
      if (result.state === 'rolled_back') onCommitted();
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  }, [onCommitted, plan]);

  if (!isOpen) return null;


  const tone = outcome ? outcomeTone(outcome) : null;
  const stageIndex = CANVAS_PLAN_STAGES.indexOf(stage as (typeof CANVAS_PLAN_STAGES)[number]);

  return (
    <div className="smart-canvas-panel" onMouseDown={(e) => e.stopPropagation()}>
      <div className="smart-canvas-header">
        <div className="smart-canvas-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" />
          </svg>
          <span>{t('title')}</span>
        </div>
        <button className="smart-canvas-close" onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* 目标 */}
      <div className="smart-canvas-search">
        <div className="smart-canvas-search-inner">
          <select
            className="smart-canvas-input"
            aria-label={t('goal')}
            value={goalType}
            onChange={(e) => setGoalType(e.target.value as CanvasGoal['goalType'])}
            disabled={busy}
          >
            <option value="explain">{t('explain')}</option>
            <option value="compare">{t('compare')}</option>
            <option value="trace">{t('trace')}</option>
            <option value="cluster">{t('cluster')}</option>
          </select>
        </div>
        <button
          className="smart-canvas-search-btn"
          onClick={handleBuild}
          disabled={busy || !canvasPath}
        >
          {busy ? (
            <span className="smart-canvas-spinner" />
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          )}
        </button>
      </div>

      <div className="smart-canvas-search">
        <div className="smart-canvas-search-inner">
          <input
            type="text"
            className="smart-canvas-input"
            placeholder={t('question')}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            disabled={busy}
          />
        </div>
      </div>

      {/* 锚点：只列画布上真有的节点，避免让用户填一个库里不存在的路径 */}
      <div className="smart-canvas-results">
        <div className="smart-canvas-results-header">
          <span className="smart-canvas-results-count">
            {t('anchors')} · {anchors.length}
          </span>
        </div>
        {canvasNodePaths.length === 0 ? (
          <div className="smart-canvas-hint">
            <span>{t('noAnchors')}</span>
          </div>
        ) : (
          <div className="smart-canvas-results-list">
            {canvasNodePaths.slice(0, 12).map((path) => (
              <div
                key={path}
                className={`smart-canvas-result-card ${anchors.includes(path) ? 'selected' : ''}`}
                onClick={() => toggleAnchor(path)}
              >
                <div className="smart-canvas-result-checkbox">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    {anchors.includes(path) ? (
                      <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="m9 12 2 2 4-4" /></>
                    ) : (
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                    )}
                  </svg>
                </div>
                <div className="smart-canvas-result-content">
                  <div className="smart-canvas-result-title">
                    <span className="smart-canvas-result-name">{fileName(path)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {!canvasPath && (
        <div className="smart-canvas-hint">
          <span>{t('noCanvas')}</span>
        </div>
      )}

      {/* 进度：用后端的状态词表，不另造词 */}
      {stage !== 'idle' && (
        <div className="canvas-smart-progress">
          <div className="canvas-smart-steps">
            {CANVAS_PLAN_STAGES.map((s, i) => (
              <span
                key={s}
                className={`canvas-smart-step-dot ${
                  stageIndex > i ? 'done' : stageIndex === i ? 'current' : ''
                }`}
              />
            ))}
          </div>
          <div className="canvas-smart-label">{stage}</div>
        </div>
      )}

      {error && (
        <div className="smart-canvas-empty">
          <span>{error}</span>
        </div>
      )}

      {plan && (
        <div className="smart-canvas-results">
          <div className="smart-canvas-results-header">
            <span className="smart-canvas-results-count">
              {t('layoutUsed')}: {plan.layout} · {plan.generatedBy}
            </span>
          </div>

          {/* 布局降级：请求的那种做不到时，把原因原样说出来 */}
          {plan.layoutFallbackReason && (
            <div className="smart-canvas-hint">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12" y2="16" />
              </svg>
              <span>{t('fallback')}</span>
              <span className="smart-canvas-hint-detail">{plan.layoutFallbackReason}</span>
            </div>
          )}

          {plan.unresolvedQuestions.length > 0 && (
            <div className="smart-canvas-hint">
              <span>{t('unresolved')}</span>
              {plan.unresolvedQuestions.map((q, i) => (
                <span className="smart-canvas-hint-detail" key={i}>{q}</span>
              ))}
            </div>
          )}

          <div className="smart-canvas-results-header">
            <span className="smart-canvas-results-count">
              {t('proposals')} {plan.proposals.length} · {t('selected')} {selected.size}
            </span>
          </div>

          <div className="smart-canvas-results-list">
            {plan.proposals.map((p: CanvasProposal) => {
              const isSelected = selected.has(p.id);
              const score = Math.round(p.confidence * 100);
              const label = OPERATION_LABEL[p.operation] ?? [p.operation, p.operation];
              return (
                <div
                  key={p.id}
                  className={`smart-canvas-result-card ${isSelected ? 'selected' : ''}`}
                  onClick={() => toggleProposal(p.id)}
                >
                  <div className="smart-canvas-result-checkbox">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      {isSelected ? (
                        <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="m9 12 2 2 4-4" /></>
                      ) : (
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                      )}
                    </svg>
                  </div>
                  <div className="smart-canvas-result-content">
                    <div className="smart-canvas-result-title">
                      <span className="smart-canvas-result-name">
                        {isZh ? label[0] : label[1]}
                        {' · '}
                        {p.groupTitle ?? p.nodePaths.map(fileName).join(' → ')}
                      </span>
                      <span className="smart-canvas-result-score">{score}%</span>
                    </div>
                    <div className="smart-canvas-result-snippet">{p.reason}</div>
                    {p.evidence.map((ev, i) => (
                      <div className="smart-canvas-result-snippet" key={i}>
                        {t('evidence')}: {fileName(ev.path)}
                        {ev.kind === 'file_level'
                          ? ` — ${t('fileLevel')}`
                          : ev.excerpt
                            ? ` — ${ev.excerpt}`
                            : ''}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 预览摘要 + 动作。写入按钮只在后端说"已生成预览"之后才可用 */}
      {plan && (
        <div className="smart-canvas-footer">
          <div className="smart-canvas-result-snippet">
            {t('willAdd')}: {previewCounts.nodes} {t('nodes')} · {previewCounts.groups}{' '}
            {t('groups')} · {previewCounts.edges} {t('edges')}
          </div>
          <button
            className="smart-canvas-add-btn"
            onClick={handlePreview}
            disabled={busy || selected.size === 0}
          >
            {t('preview')}
          </button>
          <button
            className="smart-canvas-add-btn"
            onClick={handleCommit}
            disabled={busy || outcome?.state !== 'awaiting_approval'}
          >
            {t('commit')}
          </button>
          <button
            className="smart-canvas-add-btn"
            onClick={handleVerify}
            disabled={busy || !outcome || outcome.applied === 0}
          >
            {t('verify')}
          </button>
          <button
            className="smart-canvas-add-btn"
            onClick={handleRollback}
            disabled={busy || !outcome || outcome.applied === 0}
          >
            {t('rollback')}
          </button>
        </div>
      )}

      {/* 结果：文案全部由后端计数推出，不在调用返回后乐观宣布成功 */}
      {outcome && (
        <div className={`smart-canvas-hint canvas-plan-outcome-${tone}`} role="status">
          <span>{outcomeHeadline(outcome, isZh)}</span>
          <span className="smart-canvas-hint-detail">{outcome.message}</span>
          {outcome.conflicts.map((c, i) => (
            <span className="smart-canvas-hint-detail" key={i}>{c}</span>
          ))}
          {outcome.details
            .filter((d) => d.status === 'absent' || d.status === 'failed')
            .map((d) => (
              <span className="smart-canvas-hint-detail" key={d.proposalId}>
                {d.paths.map(fileName).join(' → ')} — {d.detail ?? d.status}
              </span>
            ))}
        </div>
      )}

      {verification && (
        <div className="smart-canvas-hint" role="status">
          <span>{verification.message}</span>
          {verification.danglingNodePaths.map((p) => (
            <span className="smart-canvas-hint-detail" key={p}>{fileName(p)}</span>
          ))}
          {verification.steps.map((s, i) => (
            <span className="smart-canvas-hint-detail" key={i}>{s}</span>
          ))}
        </div>
      )}
    </div>
  );
}


