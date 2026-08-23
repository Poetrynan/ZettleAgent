import { useRef, useState } from 'react';
import {
  EmbeddingStats,
  KnowledgeBackfillProgress,
  KnowledgeIndexHealth,
  LintReport,
  createNoteForLink,
  finalizeEmbeddingIndex,
  fixBrokenLink,
  getEmbeddingStats,
  getKnowledgeIndexHealth,
  runKnowledgeBackfill,
  runVaultLint,
  syncVault,
} from '../../lib/tauri';
import { t, tf } from '../../lib/i18n';
import { KcFailed, KcLoading, KcPill, KcTone, useAsync } from './states';
import type { KnowledgePage } from './KnowledgeCenter';

/**
 * 知识健康 / can the Agent rely on this knowledge base right now?
 *
 * 之前这一页是一格一格的 COUNT：`schemaVersion 3`、`blockObjects 412`。数字都是真的，
 * 但没有一个回答用户的问题。用户想知道的只有三件事：现在能不能用、缺了什么、我怎么补。
 *
 * 所以改成三层：
 *
 * 1. **一句结论**，由真实数字按写死的规则推出来（见 [`verdictOf`]），不是一个"健康分"。
 *    分数是最容易撒的谎——87 分意味着什么没人说得清。
 * 2. **按后果分节**：身份与索引 / 按意思找 / 笔记本身的问题 / 等你处理。每一节先说
 *    "缺这个会怎样"，再给数字，最后才是按钮。
 * 3. **技术详情**折叠起来，包括这一页**做不到**什么。
 *
 * 关于"真实修复动作"的边界，后端只有这些：分批 backfill、重新扫描 vault、重算语义边、
 * 单条断链修复、新建缺失的目标笔记。**没有** FTS/向量索引重建（唯一路径会先删数据）、
 * 没有单个 job 重试、没有批量改链接。这些不画按钮，而是在"做不到什么"里说出来——一个
 * 按下去什么都不会发生的修复按钮，比没有按钮更糟。
 *
 * 另外后端的 `lastRunAtMs` 实际上是"你这次查询的时间"，不是上次索引时间，所以这里
 * 不显示它。显示一个看起来像索引时间的错值，会让人以为索引刚跑过。
 */

export type HealthVerdict = 'ok' | 'degraded' | 'blocked';

export interface HealthReason {
  /** i18n key 后缀，同时用作 React key。 */
  code: string;
  text: string;
}

/**
 * 从真实数字推出一句结论 / the verdict, derived from counts only.
 *
 * 规则写死在这里，方便被测试钉住：
 *
 * - 有笔记但一篇都没建立身份 → `blocked`：证据层是空的，Agent 引用不了任何东西。
 * - 有笔记没身份、有失败任务、报过错、或者一段向量都没有 → `degraded`。
 * - 只是还有一部分段落没做向量 → 仍然 `degraded`，但理由不同：按意思找是残缺的。
 */
export function verdictOf(
  health: KnowledgeIndexHealth,
  embedding: EmbeddingStats | null,
): { verdict: HealthVerdict; reasons: HealthReason[] } {
  const gap = Math.max(0, health.totalFiles - health.indexedDocuments);
  const reasons: HealthReason[] = [];

  if (gap > 0) {
    reasons.push({ code: 'identityGap', text: tf('knowledge.health.reason.identityGap', gap) });
  }
  if (health.failedJobs > 0) {
    reasons.push({
      code: 'failedJobs',
      text: tf('knowledge.health.reason.failedJobs', health.failedJobs),
    });
  }
  if (health.lastError) {
    reasons.push({ code: 'lastError', text: t('knowledge.health.reason.lastError') });
  }
  if (embedding && embedding.total_chunks > 0) {
    const missing = embedding.total_chunks - embedding.indexed_chunks;
    if (embedding.indexed_chunks === 0) {
      reasons.push({ code: 'noEmbeddings', text: t('knowledge.health.reason.noEmbeddings') });
    } else if (missing > 0) {
      reasons.push({
        code: 'someEmbeddings',
        text: tf('knowledge.health.reason.someEmbeddings', missing),
      });
    }
  }

  const blocked = health.totalFiles > 0 && health.indexedDocuments === 0;
  const verdict: HealthVerdict = blocked ? 'blocked' : reasons.length > 0 ? 'degraded' : 'ok';
  return { verdict, reasons };
}

const VERDICT_TONE: Record<HealthVerdict, KcTone> = {
  ok: 'success',
  degraded: 'warning',
  blocked: 'danger',
};

function Kv({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="kc-kv-row">
      <span className="kc-kv-key">{label}</span>
      <span className="kc-kv-val">{value}</span>
    </div>
  );
}

function Section({
  title,
  why,
  children,
}: {
  title: string;
  why: string;
  children: React.ReactNode;
}) {
  return (
    <section className="kc-health-section">
      <h3 className="kc-section-title">{title}</h3>
      <p className="kc-muted">{why}</p>
      {children}
    </section>
  );
}

/**
 * 身份与索引 / the section with the only bulk repair that exists.
 *
 * backfill 是分批的，而且循环可以被打断：一次点击跑到底、中间不能停，在几万篇的库上
 * 就是一个假的"处理中…"。停下之后已经建立的身份不会退回去，所以停是安全的，文案也这么说。
 */
function IdentitySection({
  health,
  vaultPath,
  onChanged,
}: {
  health: KnowledgeIndexHealth;
  vaultPath: string | null;
  onChanged: () => void;
}) {
  const [progress, setProgress] = useState<KnowledgeBackfillProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const stop = useRef(false);

  const gap = Math.max(0, health.totalFiles - health.indexedDocuments);

  const advance = async () => {
    setRunning(true);
    setProblem(null);
    setNote(null);
    stop.current = false;
    try {
      // 分批跑，但显示的是**累计**：只显示最后一批的数字，会让一次 20 批的运行看起来
      // 像只处理了 100 条。`remaining` 取最新一批的，因为它本身就是剩余量。
      const total = { processed: 0, created: 0, failed: 0 };
      let batch = await runKnowledgeBackfill(100);
      do {
        total.processed += batch.processed;
        total.created += batch.created;
        total.failed += batch.failed;
        setProgress({ ...total, remaining: batch.remaining, hasMore: batch.hasMore });
        if (!batch.hasMore || stop.current) break;
        batch = await runKnowledgeBackfill(100);
      } while (true);
      if (stop.current) setNote(t('knowledge.health.action.stopped'));
      onChanged();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const rescan = async () => {
    if (!vaultPath) return;
    setScanning(true);
    setProblem(null);
    setNote(null);
    try {
      const result = await syncVault(vaultPath);
      setNote(
        tf(
          'knowledge.health.rescanResult',
          result.files_updated,
          result.files_removed,
          result.total_files,
        ),
      );
      onChanged();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  };

  return (
    <Section
      title={t('knowledge.health.section.identity')}
      why={t('knowledge.health.identityWhy')}
    >
      <Kv label={t('knowledge.health.kv.notes')} value={health.totalFiles} />
      <Kv label={t('knowledge.health.kv.withIdentity')} value={health.indexedDocuments} />
      <Kv label={t('knowledge.health.kv.gap')} value={gap} />
      <Kv label={t('knowledge.health.kv.pendingJobs')} value={health.pendingJobs} />
      <Kv label={t('knowledge.health.kv.failedJobs')} value={health.failedJobs} />
      <p className="kc-muted">{t('knowledge.health.jobScope')}</p>
      <p className="kc-muted">{t('knowledge.health.filesNote')}</p>

      {health.lastError && (
        <p className="kc-warn" role="alert">
          {t('knowledge.health.reason.lastError')}
          <span className="kc-sr-only"> {health.lastError}</span>
        </p>
      )}
      {problem && <p className="kc-warn" role="alert">{problem}</p>}
      {note && <p className="kc-note" role="status">{note}</p>}
      {progress && (
        <p className="kc-muted">
          {tf(
            'knowledge.health.progress',
            progress.processed,
            progress.created,
            progress.failed,
            progress.remaining,
          )}
        </p>
      )}

      <div className="kc-card-actions">
        <button
          className="kc-btn kc-btn-primary"
          disabled={running || (gap === 0 && health.pendingJobs === 0 && health.failedJobs === 0)}
          onClick={() => void advance()}
        >
          {running ? t('knowledge.health.action.advancing') : t('knowledge.health.action.advance')}
        </button>
        {running && (
          <button className="kc-btn" onClick={() => { stop.current = true; }}>
            {t('knowledge.health.action.stop')}
          </button>
        )}
        {vaultPath && (
          <button className="kc-btn" disabled={scanning || running} onClick={() => void rescan()}>
            {scanning
              ? t('knowledge.health.action.rescanning')
              : t('knowledge.health.action.rescan')}
          </button>
        )}
      </div>
    </Section>
  );
}

/**
 * 按意思找 / semantic recall.
 *
 * 这里刻意**不**再实现一遍"把没做向量的段落补齐"的循环。那件事需要用户配好的向量模型，
 * 已经在设置里有一份实现；在这里复制第三份，等于同一件事有三个入口、三种失败方式。
 * 这一节只回答"现在能不能按意思找、缺多少"，补齐的入口指向设置。
 *
 * 「重算相关笔记连线」是真的：`finalize_embedding_index` 会用已有向量重算语义边。它
 * **不会**重建向量索引本身——那件事后端没有安全的实现，所以不在这里假装有。
 */
function SemanticSection({
  stats,
  onOpenSettings,
}: {
  stats: EmbeddingStats | null;
  onOpenSettings?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const recompute = async () => {
    setBusy(true);
    setProblem(null);
    setNote(null);
    try {
      await finalizeEmbeddingIndex();
      setNote(t('knowledge.health.edgesDone'));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const missing = stats ? stats.total_chunks - stats.indexed_chunks : 0;

  return (
    <Section
      title={t('knowledge.health.section.semantic')}
      why={t('knowledge.health.semanticWhy')}
    >
      {stats && (
        <Kv
          label={t('knowledge.health.kv.embedded')}
          value={tf('knowledge.health.embeddedOf', stats.indexed_chunks, stats.total_chunks)}
        />
      )}
      {stats && stats.indexed_chunks === 0 && stats.total_chunks > 0 && (
        <p className="kc-warn">{t('knowledge.health.semanticOff')}</p>
      )}
      {missing > 0 && (
        <p className="kc-muted">{tf('knowledge.health.reason.someEmbeddings', missing)}</p>
      )}
      <p className="kc-muted">{t('knowledge.health.semanticProvider')}</p>
      {problem && <p className="kc-warn" role="alert">{problem}</p>}
      {note && <p className="kc-note" role="status">{note}</p>}

      <div className="kc-card-actions">
        <button className="kc-btn" disabled={busy} onClick={() => void recompute()}>
          {busy
            ? t('knowledge.health.action.recomputing')
            : t('knowledge.health.action.recomputeEdges')}
        </button>
        {onOpenSettings && missing > 0 && (
          <button className="kc-btn" onClick={onOpenSettings}>
            {t('knowledge.health.action.openEmbeddingSettings')}
          </button>
        )}
      </div>
    </Section>
  );
}

/** 一次列这么多条断链。全列出来在一个几千条的库上会把这一页变成滚不完的日志。 */
const MAX_LINKS_SHOWN = 8;

function fileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * 笔记本身的问题 / content problems, checked on demand.
 *
 * `run_vault_lint` 读每一篇笔记，所以不在进页面时自动跑：一个每次打开都卡两秒的健康页，
 * 用户会学会不打开它。
 *
 * 修复是**一条一条**的，因为后端只有单条 `fix_broken_link`。没有批量修复就不画批量按钮。
 * 没有相近目标时不猜：给"新建这篇笔记"和"自己去改"两条路，而不是替用户选一个可能错的
 * 目标——链接指错地方比断链更难发现。
 */
function NotesSection({ onOpenFile }: { onOpenFile?: (path: string) => void }) {
  const [report, setReport] = useState<LintReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const lint = async () => {
    setBusy(true);
    setProblem(null);
    try {
      setReport(await runVaultLint());
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const act = async (run: () => Promise<string>) => {
    setActing(true);
    setProblem(null);
    setNote(null);
    try {
      setNote(await run());
      setReport(await runVaultLint());
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setActing(false);
    }
  };

  const broken = report?.broken_links ?? [];

  return (
    <Section title={t('knowledge.health.section.notes')} why={t('knowledge.health.notesWhy')}>
      {problem && <p className="kc-warn" role="alert">{problem}</p>}
      {note && <p className="kc-note" role="status">{note}</p>}

      {report && (
        <>
          <Kv label={t('knowledge.health.lintBroken')} value={broken.length} />
          <Kv label={t('knowledge.health.lintOrphans')} value={report.orphans.length} />
          <Kv
            label={t('knowledge.health.lintMissingMeta')}
            value={report.missing_metadata.length}
          />
          {broken.length === 0 && report.orphans.length === 0 && (
            <p className="kc-note">{t('knowledge.health.lintClean')}</p>
          )}
        </>
      )}

      {broken.slice(0, MAX_LINKS_SHOWN).map(link => (
        <div className="kc-health-link" key={`${link.file_path}:${link.line_number}:${link.target_title}`}>
          <span className="kc-kv-key">
            {tf('knowledge.health.brokenAt', fileName(link.file_path), link.line_number)}
          </span>
          <span className="kc-kv-val">{link.target_title}</span>
          <div className="kc-card-actions">
            {link.suggested_fix ? (
              <button
                className="kc-btn"
                disabled={acting}
                onClick={() =>
                  void act(async () => {
                    await fixBrokenLink(
                      link.file_path,
                      link.target_title,
                      link.line_number,
                      'replace',
                      link.suggested_fix as string,
                    );
                    return t('knowledge.health.linkFixed');
                  })
                }
              >
                {tf('knowledge.health.action.fixLink', link.suggested_fix)}
              </button>
            ) : (
              <span className="kc-muted">{t('knowledge.health.noSuggestion')}</span>
            )}
            <button
              className="kc-btn"
              disabled={acting}
              onClick={() =>
                void act(async () => {
                  const path = await createNoteForLink(link.target_title);
                  return tf('knowledge.health.linkCreated', fileName(path));
                })
              }
            >
              {tf('knowledge.health.action.createTarget', link.target_title)}
            </button>
            {onOpenFile && (
              <button className="kc-btn-quiet" onClick={() => onOpenFile(link.file_path)}>
                {t('knowledge.health.action.open')}
              </button>
            )}
          </div>
        </div>
      ))}
      {broken.length > MAX_LINKS_SHOWN && (
        <p className="kc-muted">
          {tf('knowledge.health.lintMore', broken.length - MAX_LINKS_SHOWN)}
        </p>
      )}

      <div className="kc-card-actions">
        <button className="kc-btn" disabled={busy} onClick={() => void lint()}>
          {busy ? t('knowledge.health.action.linting') : t('knowledge.health.action.lint')}
        </button>
      </div>
    </Section>
  );
}

/** 等你处理的三个队列。它们不是错误，所以动作是"去处理"，不是"修复"。 */
function QueuesSection({
  health,
  onOpenPage,
}: {
  health: KnowledgeIndexHealth;
  onOpenPage?: (page: KnowledgePage) => void;
}) {
  const rows: { key: KnowledgePage; labelKey: string; value: number }[] = [
    { key: 'memory', labelKey: 'knowledge.health.kv.memoryInbox', value: health.memoryInbox },
    { key: 'changes', labelKey: 'knowledge.health.kv.openChanges', value: health.openChangesets },
    { key: 'tasks', labelKey: 'knowledge.health.kv.openTasks', value: health.openCommitments },
  ];

  return (
    <Section title={t('knowledge.health.section.queues')} why={t('knowledge.health.queuesWhy')}>
      {rows.map(row => (
        <div className="kc-kv-row" key={row.key}>
          <span className="kc-kv-key">{t(row.labelKey as never)}</span>
          <span className="kc-kv-val">{row.value}</span>
          {onOpenPage && row.value > 0 && (
            <button className="kc-btn-quiet" onClick={() => onOpenPage(row.key)}>
              {t('knowledge.health.action.open')}
            </button>
          )}
        </div>
      ))}
    </Section>
  );
}

export function KnowledgeHealth({
  vaultPath,
  onOpenPage,
  onOpenFile,
  onOpenSettings,
}: {
  vaultPath?: string | null;
  onOpenPage?: (page: KnowledgePage) => void;
  onOpenFile?: (path: string) => void;
  onOpenSettings?: () => void;
}) {
  const health = useAsync<KnowledgeIndexHealth>(() => getKnowledgeIndexHealth(), []);
  const embedding = useAsync<EmbeddingStats>(() => getEmbeddingStats(), []);

  if (health.error) return <KcFailed error={health.error} onRetry={health.reload} />;
  if (!health.data) return <KcLoading rows={4} />;

  const { verdict, reasons } = verdictOf(health.data, embedding.data);
  const reload = () => {
    void health.reload();
    void embedding.reload();
  };

  return (
    <div className="kc-health">
      <section className="kc-card kc-health-verdict">
        <header className="kc-card-head">
          <KcPill tone={VERDICT_TONE[verdict]} label={t(`knowledge.health.verdict.${verdict}` as never)} />
        </header>
        <p className="kc-muted">
          {t(verdict === 'ok' ? 'knowledge.health.verdictHintOk' : 'knowledge.health.verdictHintBad')}
        </p>
        {reasons.length > 0 && (
          <ul className="kc-health-reasons">
            {reasons.map(reason => (
              <li key={reason.code}>{reason.text}</li>
            ))}
          </ul>
        )}
        <div className="kc-card-actions">
          <button className="kc-btn" disabled={health.busy} onClick={reload}>
            {t('knowledge.retry')}
          </button>
        </div>
      </section>

      <IdentitySection health={health.data} vaultPath={vaultPath ?? null} onChanged={reload} />
      {embedding.error && <p className="kc-warn" role="alert">{t('knowledge.loadFailed')}</p>}
      <SemanticSection stats={embedding.data} onOpenSettings={onOpenSettings} />
      <NotesSection onOpenFile={onOpenFile} />
      <QueuesSection health={health.data} onOpenPage={onOpenPage} />

      <details className="kc-details">
        <summary>{t('knowledge.advanced')}</summary>
        <Kv label={t('knowledge.health.schemaVersion')} value={health.data.schemaVersion} />
        <p className="kc-muted">{t('knowledge.health.cannot')}</p>
        <ul className="kc-health-reasons">
          <li>{t('knowledge.health.cannot.rebuild')}</li>
          <li>{t('knowledge.health.cannot.retryJob')}</li>
          <li>{t('knowledge.health.cannot.bulkLinks')}</li>
          <li>{t('knowledge.health.cannot.lastRun')}</li>
        </ul>
        {health.data.lastError && <pre className="kc-pre">{health.data.lastError}</pre>}
      </details>
    </div>
  );
}




