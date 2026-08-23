import { useCallback, useEffect, useState } from 'react';
import {
  ContextPackageSummary,
  KnowledgeAuditEvent,
  KnowledgeBackfillProgress,
  KnowledgeIndexHealth,
  MemoryItem,
  PendingChangeSet,
  ChangeSetDryRun,
  TaskCommitment,
  confirmMemory,
  decideChangeSet,
  decideCommitment,
  forgetMemory,
  getCommitmentInbox,
  getKnowledgeAuditTrail,
  getKnowledgeIndexHealth,
  getMemoryInbox,
  getPendingChangeSets,
  previewChangeSet,
  rejectMemory,
  runKnowledgeBackfill,
  scanCommitments,
  syncMemoryFile,
} from '../../lib/tauri';
import { getLang } from '../../lib/i18n';

/**
 * 知识层面板 / the knowledge layer's one visible surface.
 *
 * 六块内容合成一个面板而不是六个孤立入口：它们讲的是同一件事——这一轮 Agent 看到了
 * 什么、记住了什么、打算改什么、答应了什么、索引还欠多少。散落成六个抽屉，用户就
 * 永远拼不出全貌。
 *
 * 每一块都读真实命令。没有一个数字是写死的，拿不到数据就说拿不到，不显示占位。
 */

type TabKey = 'context' | 'memory' | 'changes' | 'tasks' | 'health';

const TABS: { key: TabKey; label: string; labelZh: string }[] = [
  { key: 'context', label: 'Context', labelZh: '上下文' },
  { key: 'memory', label: 'Memory', labelZh: '记忆' },
  { key: 'changes', label: 'Changes', labelZh: '变更' },
  { key: 'tasks', label: 'Tasks', labelZh: '承诺' },
  { key: 'health', label: 'Index', labelZh: '索引' },
];

interface KnowledgePanelProps {
  /** 本轮编译出来的上下文，来自 `context_package_ready`。 */
  contextPackage: ContextPackageSummary | null;
  /** 本轮的 run id，用于拉这一轮的审计明细。 */
  runId: string | null;
  /** 当前 vault，`memory.md` 回流需要它。没有 vault 时该入口不出现。 */
  vaultPath: string | null;
  onClose: () => void;
}

export function KnowledgePanel({ contextPackage, runId, vaultPath, onClose }: KnowledgePanelProps) {
  const isZh = getLang() === 'zh';
  const [tab, setTab] = useState<TabKey>('context');

  return (
    <div className="knowledge-panel">
      <div className="knowledge-panel-header">
        <div className="knowledge-panel-tabs" role="tablist">
          {TABS.map(item => (
            <button
              key={item.key}
              role="tab"
              aria-selected={tab === item.key}
              className={`knowledge-panel-tab ${tab === item.key ? 'active' : ''}`}
              onClick={() => setTab(item.key)}
            >
              {isZh ? item.labelZh : item.label}
            </button>
          ))}
        </div>
        <button
          className="knowledge-panel-close"
          onClick={onClose}
          title={isZh ? '关闭' : 'Close'}
          aria-label={isZh ? '关闭知识面板' : 'Close knowledge panel'}
        >
          ×
        </button>
      </div>

      <div className="knowledge-panel-body">
        {tab === 'context' && (
          <ContextTab pkg={contextPackage} runId={runId} isZh={isZh} />
        )}
        {tab === 'memory' && <MemoryTab isZh={isZh} vaultPath={vaultPath} />}
        {tab === 'changes' && <ChangesTab isZh={isZh} />}
        {tab === 'tasks' && <TasksTab isZh={isZh} />}
        {tab === 'health' && <HealthTab isZh={isZh} />}
      </div>
    </div>
  );
}

// ── 共用小件 / shared bits ───────────────────────────────────────────────────

/**
 * 一个最小的加载器 / one small loader.
 *
 * 三个状态都要能显示出来：在读、读失败（带原因）、读到了但是空的。把失败静默成空
 * 列表是这类面板最常见的谎——用户会以为"没有待办"，其实是查询挂了。
 */
function useLoader<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setData(await load());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller owns the dep list
  }, deps);

  useEffect(() => {
    void run();
  }, [run]);

  return { data, error, busy, reload: run };
}

function Empty({ text }: { text: string }) {
  return <div className="knowledge-empty">{text}</div>;
}

function Failed({ error, onRetry, label }: { error: string; onRetry: () => void; label: string }) {
  return (
    <div className="knowledge-error">
      <span className="knowledge-error-text">{error}</span>
      <button className="knowledge-mini-btn" onClick={onRetry}>{label}</button>
    </div>
  );
}

/** 角标。`warning` 一律用警示色——它们的存在就是为了被看见。 */
function Chips({ items, tone }: { items: string[]; tone: 'why' | 'warning' }) {
  if (!items.length) return null;
  return (
    <span className="knowledge-chips">
      {items.map(item => (
        <span key={item} className={`knowledge-chip knowledge-chip-${tone}`}>{item}</span>
      ))}
    </span>
  );
}

function timeLabel(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

// ── Context Inspector ───────────────────────────────────────────────────────

function ContextTab({
  pkg,
  runId,
  isZh,
}: {
  pkg: ContextPackageSummary | null;
  runId: string | null;
  isZh: boolean;
}) {
  const [showAudit, setShowAudit] = useState(false);

  if (!pkg) {
    return (
      <Empty
        text={
          isZh
            ? '这一轮还没有编译上下文。发一条消息后，这里会显示模型实际看到的召回结果。'
            : 'No context compiled yet. Send a message and this shows what the model actually saw.'
        }
      />
    );
  }

  const { budget } = pkg;
  const pct = budget.maxTokens > 0
    ? Math.min(100, Math.round((budget.usedTokens / budget.maxTokens) * 100))
    : 0;

  return (
    <div className="knowledge-section">
      <div className="knowledge-kv">
        <span className="knowledge-kv-key">{isZh ? '问题' : 'Query'}</span>
        <span className="knowledge-kv-val">{pkg.query}</span>
      </div>
      <div className="knowledge-kv">
        <span className="knowledge-kv-key">{isZh ? '意图' : 'Intent'}</span>
        <span className="knowledge-kv-val">{pkg.intent}</span>
      </div>
      <div className="knowledge-kv">
        <span className="knowledge-kv-key">{isZh ? '范围' : 'Scope'}</span>
        <span className="knowledge-kv-val">
          {pkg.scope.length ? pkg.scope.join(', ') : (isZh ? '（未限定）' : '(unscoped)')}
        </span>
      </div>

      {/* 预算：被裁掉多少候选必须显示出来，否则"装不下"会变成静默丢失。 */}
      <div className="knowledge-budget">
        <div className="knowledge-budget-bar">
          <div className="knowledge-budget-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="knowledge-budget-text">
          {budget.usedTokens} / {budget.maxTokens} tokens
          {budget.truncatedCandidates > 0 && (
            <strong className="knowledge-budget-cut">
              {isZh
                ? ` · 裁掉 ${budget.truncatedCandidates} 条候选`
                : ` · ${budget.truncatedCandidates} candidates dropped`}
            </strong>
          )}
        </span>
      </div>

      {pkg.warnings.length > 0 && (
        <div className="knowledge-warn-row">
          <Chips items={pkg.warnings} tone="warning" />
        </div>
      )}

      {pkg.items.length === 0 ? (
        <Empty text={isZh ? '没有召回任何条目。' : 'Nothing was retrieved.'} />
      ) : (
        <div className="knowledge-list">
          {pkg.items.map((item, idx) => (
            <div className="knowledge-item" key={`${item.objectId ?? item.locator ?? idx}`}>
              <div className="knowledge-item-head">
                <span className="knowledge-item-kind">{item.kind}</span>
                <span className="knowledge-item-title">{item.title}</span>
                <span className="knowledge-item-score">{item.score.toFixed(2)}</span>
              </div>
              {item.locator && <div className="knowledge-item-locator">{item.locator}</div>}
              <Chips items={item.why} tone="why" />
              <Chips items={item.warnings} tone="warning" />
            </div>
          ))}
        </div>
      )}

      {pkg.knowledgeGaps.length > 0 && (
        <div className="knowledge-gaps">
          <div className="knowledge-sub-title">{isZh ? '知识缺口' : 'Knowledge gaps'}</div>
          {pkg.knowledgeGaps.map(gap => (
            <div className="knowledge-gap" key={gap}>{gap}</div>
          ))}
        </div>
      )}

      {runId && (
        <div className="knowledge-audit-fold">
          <button className="knowledge-fold-btn" onClick={() => setShowAudit(v => !v)}>
            {showAudit
              ? (isZh ? '收起本轮审计' : 'Hide audit trail')
              : (isZh ? '展开本轮审计' : 'Show audit trail')}
          </button>
          {showAudit && <AuditList runId={runId} isZh={isZh} />}
        </div>
      )}
    </div>
  );
}

/** 某一轮的审计明细 / the audit trail for one run. */
function AuditList({ runId, isZh }: { runId: string; isZh: boolean }) {
  const { data, error, busy, reload } = useLoader<KnowledgeAuditEvent[]>(
    () => getKnowledgeAuditTrail({ runId, limit: 50 }),
    [runId],
  );

  if (error) return <Failed error={error} onRetry={reload} label={isZh ? '重试' : 'Retry'} />;
  if (busy && !data) return <Empty text={isZh ? '读取中…' : 'Loading…'} />;
  if (!data || data.length === 0) {
    return <Empty text={isZh ? '这一轮还没有审计事件。' : 'No audit events for this run.'} />;
  }

  return (
    <div className="knowledge-audit-list">
      {data.map(ev => (
        <div className="knowledge-audit-row" key={ev.id}>
          <span className="knowledge-audit-event">{ev.event}</span>
          <span className={`knowledge-audit-result ${ev.result === 'ok' ? '' : 'bad'}`}>
            {ev.result}
          </span>
          <span className="knowledge-audit-actor">{ev.actor}</span>
          <span className="knowledge-audit-time">{timeLabel(ev.created_at_ms)}</span>
        </div>
      ))}
    </div>
  );
}

// ── Memory Inbox ────────────────────────────────────────────────────────────

/**
 * 候选记忆的裁决台 / where candidate memories get judged.
 *
 * 这一块是"不得让未经确认的 LLM 推断伪装成用户事实"在界面上的落点。确认是唯一会写
 * `confirmed_by` 的路径，所以它必须是用户点出来的。
 */
function MemoryTab({ isZh, vaultPath }: { isZh: boolean; vaultPath: string | null }) {
  const { data, error, busy, reload } = useLoader<MemoryItem[]>(() => getMemoryInbox(50), []);
  const [acting, setActing] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const act = async (id: string, fn: (id: string) => Promise<MemoryItem>) => {
    setActing(id);
    try {
      await fn(id);
      await reload();
    } finally {
      setActing(null);
    }
  };

  /** 用户手改过 `memory.md` 之后，把那些行吸收回记忆层。 */
  const sync = async () => {
    if (!vaultPath) return;
    setSyncing(true);
    setSyncNote(null);
    setSyncError(null);
    try {
      const r = await syncMemoryFile(vaultPath);
      setSyncNote(
        isZh
          ? `采纳 ${r.adopted} 条，已有 ${r.unchanged} 条，忘掉 ${r.forgotten} 条`
          : `${r.adopted} adopted, ${r.unchanged} already known, ${r.forgotten} forgotten`,
      );
      await reload();
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  const toolbar = vaultPath ? (
    <div className="knowledge-toolbar">
      <button className="knowledge-mini-btn" disabled={syncing} onClick={() => void sync()}>
        {syncing
          ? (isZh ? '回流中…' : 'Syncing…')
          : (isZh ? '读回 memory.md 的手工修改' : 'Absorb memory.md edits')}
      </button>
      {syncNote && <span className="knowledge-toolbar-note">{syncNote}</span>}
    </div>
  ) : null;


  // 回流入口在三种状态下都要在：收件箱为空恰恰是最可能想手改文件的时候。
  const shell = (body: React.ReactNode) => (
    <div className="knowledge-section">
      {toolbar}
      {syncError && <div className="knowledge-error-text">{syncError}</div>}
      {body}
    </div>
  );

  if (error) {
    return shell(<Failed error={error} onRetry={reload} label={isZh ? '重试' : 'Retry'} />);
  }
  if (busy && !data) return shell(<Empty text={isZh ? '读取中…' : 'Loading…'} />);
  if (!data || data.length === 0) {
    return shell(
      <Empty text={isZh ? '没有待确认的候选记忆。' : 'No candidate memories to review.'} />,
    );
  }

  return shell(
    <div className="knowledge-list">

      {data.map(item => (
        <div className="knowledge-item" key={item.id}>
          <div className="knowledge-item-head">
            <span className="knowledge-item-kind">{item.kind}</span>
            <span className="knowledge-item-title">{item.claim}</span>
          </div>
          <div className="knowledge-item-meta">
            <span>{isZh ? '置信' : 'confidence'} {item.confidence.toFixed(2)}</span>
            <span>{isZh ? '范围' : 'scope'} {item.scope}</span>
            {item.expires_at_ms && (
              <span>{isZh ? '过期' : 'expires'} {timeLabel(item.expires_at_ms)}</span>
            )}
            {item.source && (
              <span className="knowledge-item-locator">{item.source.source_id}</span>
            )}
          </div>
          {item.conflicts_with_id && (
            <Chips items={[isZh ? '与已有记忆冲突' : 'conflicts']} tone="warning" />
          )}
          <div className="knowledge-item-actions">
            <button
              className="knowledge-mini-btn primary"
              disabled={acting === item.id}
              onClick={() => void act(item.id, id => confirmMemory(id, vaultPath ?? undefined))}
            >
              {isZh ? '确认' : 'Confirm'}
            </button>
            <button
              className="knowledge-mini-btn"
              disabled={acting === item.id}
              onClick={() => void act(item.id, rejectMemory)}
            >
              {isZh ? '拒绝' : 'Reject'}
            </button>
            <button
              className="knowledge-mini-btn danger"
              disabled={acting === item.id}
              onClick={() => void act(item.id, forgetMemory)}
            >
              {isZh ? '遗忘' : 'Forget'}
            </button>
          </div>
        </div>
      ))}
    </div>,
  );
}

// ── Change Preview ──────────────────────────────────────────────────────────


/**
 * 待决变更批次 / change sets that have not landed yet.
 *
 * 展开一个批次会真的跑一次预演（只读），所以显示的 before/after 是当下的现状算出来
 * 的，不是提议那一刻的缓存。有冲突时批准按钮就不该给——那份 diff 是基于旧版本算的。
 */
function ChangesTab({ isZh }: { isZh: boolean }) {
  const { data, error, busy, reload } = useLoader<PendingChangeSet[]>(
    () => getPendingChangeSets(50),
    [],
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const [preview, setPreview] = useState<ChangeSetDryRun | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const open = async (id: string) => {
    if (openId === id) {
      setOpenId(null);
      setPreview(null);
      return;
    }
    setOpenId(id);
    setPreview(null);
    setPreviewError(null);
    try {
      setPreview(await previewChangeSet(id));
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : String(e));
    }
  };

  const decide = async (id: string, approved: boolean) => {
    await decideChangeSet(id, approved);
    setOpenId(null);
    setPreview(null);
    await reload();
  };

  if (error) return <Failed error={error} onRetry={reload} label={isZh ? '重试' : 'Retry'} />;
  if (busy && !data) return <Empty text={isZh ? '读取中…' : 'Loading…'} />;
  if (!data || data.length === 0) {
    return <Empty text={isZh ? '没有待决的变更批次。' : 'No pending change sets.'} />;
  }

  return (
    <div className="knowledge-list">
      {data.map(cs => (
        <div className="knowledge-item" key={cs.id}>
          <div className="knowledge-item-head" onClick={() => void open(cs.id)}>
            <span className={`knowledge-state knowledge-state-${cs.state}`}>{cs.state}</span>
            <span className="knowledge-item-title">{cs.intent ?? cs.actor}</span>
            <span className="knowledge-item-score">{cs.opCount}</span>
          </div>
          <div className="knowledge-item-meta">
            <span>{cs.actor}</span>
            <span>{timeLabel(cs.updatedAtMs)}</span>
            {cs.runId && <span className="knowledge-item-locator">{cs.runId}</span>}
          </div>
          {cs.commitError && (
            <div className="knowledge-error-text">{cs.commitError}</div>
          )}

          {openId === cs.id && (
            <div className="knowledge-preview">
              {previewError && (
                <div className="knowledge-error-text">{previewError}</div>
              )}
              {!preview && !previewError && (
                <Empty text={isZh ? '预演中…' : 'Running dry run…'} />
              )}
              {preview?.ops.map(op => (
                <div className="knowledge-op" key={op.opId}>
                  <div className="knowledge-op-head">
                    <span className="knowledge-item-kind">{op.opKind}</span>
                    <span className="knowledge-item-locator">{op.path ?? '—'}</span>
                  </div>
                  {op.reason && <div className="knowledge-op-reason">{op.reason}</div>}
                  {op.conflict && (
                    <div className="knowledge-op-conflict">
                      {isZh ? '冲突：' : 'Conflict: '}{op.conflict.kind}
                    </div>
                  )}
                  <div className="knowledge-diff">
                    <pre className="knowledge-diff-before">{op.before ?? ''}</pre>
                    <pre className="knowledge-diff-after">{op.after ?? ''}</pre>
                  </div>
                  {op.evidenceIds.length > 0 && (
                    <Chips items={op.evidenceIds} tone="why" />
                  )}
                  {op.affectedObjects.length > 0 && (
                    <Chips items={op.affectedObjects} tone="warning" />
                  )}
                </div>
              ))}
              <div className="knowledge-item-actions">
                <button
                  className="knowledge-mini-btn primary"
                  disabled={!preview || preview.hasConflicts}
                  title={
                    preview?.hasConflicts
                      ? (isZh
                          ? '有冲突：这份改动是基于旧版本算的，先让 Agent 重新读一遍'
                          : 'Conflicted — the diff was computed against a stale version')
                      : undefined
                  }
                  onClick={() => void decide(cs.id, true)}
                >
                  {isZh ? '批准' : 'Approve'}
                </button>
                <button
                  className="knowledge-mini-btn danger"
                  onClick={() => void decide(cs.id, false)}
                >
                  {isZh ? '拒绝' : 'Reject'}
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Task / Commitment View ──────────────────────────────────────────────────

/**
 * 承诺收件箱 / the commitment inbox.
 *
 * "完成"必须带一句说明：后端会把它登记成完成证据并绑回源笔记。没有说明的完成会被
 * 拒——只把状态改成 done 的任务列表干净得毫无意义。
 */
function TasksTab({ isZh }: { isZh: boolean }) {
  const { data, error, busy, reload } = useLoader<TaskCommitment[]>(
    () => getCommitmentInbox(50),
    [],
  );
  const [completing, setCompleting] = useState<string | null>(null);
  const [summary, setSummary] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);

  const act = async (payload: Parameters<typeof decideCommitment>[0]) => {
    setActionError(null);
    try {
      await decideCommitment(payload);
      setCompleting(null);
      setSummary('');
      await reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  const scan = async () => {
    setScanning(true);
    setScanNote(null);
    try {
      const result = await scanCommitments(200);
      setScanNote(
        isZh
          ? `扫到 ${result.found} 条带日期待办，新建 ${result.created} 条`
          : `${result.found} dated todos found, ${result.created} new`,
      );
      await reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="knowledge-section">
      <div className="knowledge-toolbar">
        <button className="knowledge-mini-btn" disabled={scanning} onClick={() => void scan()}>
          {scanning
            ? (isZh ? '扫描中…' : 'Scanning…')
            : (isZh ? '扫描笔记里的待办' : 'Scan notes for todos')}
        </button>
        {scanNote && <span className="knowledge-toolbar-note">{scanNote}</span>}
      </div>

      {actionError && <div className="knowledge-error-text">{actionError}</div>}
      {error && <Failed error={error} onRetry={reload} label={isZh ? '重试' : 'Retry'} />}
      {busy && !data && <Empty text={isZh ? '读取中…' : 'Loading…'} />}
      {data && data.length === 0 && (
        <Empty
          text={
            isZh
              ? '收件箱是空的。带日期的未打勾待办会被扫进来。'
              : 'Inbox is empty. Dated, unchecked todos get harvested here.'
          }
        />
      )}

      <div className="knowledge-list">
        {data?.map(item => (
          <div className="knowledge-item" key={item.id}>
            <div className="knowledge-item-head">
              <span className={`knowledge-state knowledge-state-${item.status}`}>
                {item.status}
              </span>
              <span className="knowledge-item-title">{item.title}</span>
            </div>
            <div className="knowledge-item-meta">
              <span>{item.commitment_type}</span>
              {item.due_at_ms && (
                <span>{isZh ? '截止' : 'due'} {timeLabel(item.due_at_ms)}</span>
              )}
              {item.return_target && (
                <span className="knowledge-item-locator">{item.return_target}</span>
              )}
              {item.notify_count > 0 && (
                <span>{isZh ? '提醒过' : 'nudged'} {item.notify_count}×</span>
              )}
            </div>

            {completing === item.id ? (
              <div className="knowledge-complete-form">
                <input
                  className="knowledge-input"
                  value={summary}
                  autoFocus
                  placeholder={isZh ? '做完了什么？会存为完成证据' : 'What got done? Stored as evidence'}
                  onChange={e => setSummary(e.target.value)}
                />
                <button
                  className="knowledge-mini-btn primary"
                  disabled={!summary.trim()}
                  onClick={() =>
                    void act({
                      commitmentId: item.id,
                      action: 'complete',
                      resultSummary: summary.trim(),
                    })
                  }
                >
                  {isZh ? '提交' : 'Save'}
                </button>
                <button className="knowledge-mini-btn" onClick={() => setCompleting(null)}>
                  {isZh ? '取消' : 'Cancel'}
                </button>
              </div>
            ) : (
              <div className="knowledge-item-actions">
                {item.status === 'proposed' && (
                  <button
                    className="knowledge-mini-btn primary"
                    onClick={() => void act({ commitmentId: item.id, action: 'activate' })}
                  >
                    {isZh ? '接受' : 'Accept'}
                  </button>
                )}
                <button
                  className="knowledge-mini-btn"
                  onClick={() => { setCompleting(item.id); setSummary(''); }}
                >
                  {isZh ? '完成' : 'Complete'}
                </button>
                <button
                  className="knowledge-mini-btn"
                  onClick={() =>
                    void act({
                      commitmentId: item.id,
                      action: 'snooze',
                      untilMs: Date.now() + 86_400_000,
                    })
                  }
                >
                  {isZh ? '明天再说' : 'Tomorrow'}
                </button>
                <button
                  className="knowledge-mini-btn danger"
                  onClick={() => void act({ commitmentId: item.id, action: 'dismiss' })}
                >
                  {isZh ? '不要提醒' : 'Dismiss'}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Index Health ────────────────────────────────────────────────────────────

/**
 * 索引健康 / the real state of the derived projections.
 *
 * 每个数字都来自后端的 `COUNT(*)`。这里不允许出现"看起来一切正常"的固定值——一个
 * 骗人的健康面板比没有面板更糟，它会让人不去查真正的问题。
 */
function HealthTab({ isZh }: { isZh: boolean }) {
  const { data, error, busy, reload } = useLoader<KnowledgeIndexHealth>(
    () => getKnowledgeIndexHealth(),
    [],
  );
  const [progress, setProgress] = useState<KnowledgeBackfillProgress | null>(null);
  const [running, setRunning] = useState(false);

  const advance = async () => {
    setRunning(true);
    try {
      // 一批一批推进：单次调用持锁时间有上界，用户能看到进度也能停。
      let batch = await runKnowledgeBackfill(100);
      setProgress(batch);
      let guard = 0;
      while (batch.hasMore && guard < 50) {
        batch = await runKnowledgeBackfill(100);
        setProgress(batch);
        guard += 1;
      }
      await reload();
    } finally {
      setRunning(false);
    }
  };

  if (error) return <Failed error={error} onRetry={reload} label={isZh ? '重试' : 'Retry'} />;
  if (!data) return <Empty text={isZh ? '读取中…' : 'Loading…'} />;

  const rows: [string, string, number | string][] = [
    [isZh ? 'Schema 版本' : 'Schema version', 'schema', data.schemaVersion],
    [isZh ? '笔记总数' : 'Notes', 'files', data.totalFiles],
    [isZh ? '已有稳定身份' : 'With stable identity', 'objects', data.indexedDocuments],
    [isZh ? '块对象' : 'Block objects', 'blocks', data.blockObjects],
    [isZh ? '待处理任务' : 'Pending jobs', 'pending', data.pendingJobs],
    [isZh ? '失败任务' : 'Failed jobs', 'failed', data.failedJobs],
    [isZh ? '记忆条数' : 'Memories', 'memories', data.memoryItems],
    [isZh ? '待确认记忆' : 'Memory inbox', 'inbox', data.memoryInbox],
    [isZh ? '未落地变更' : 'Open change sets', 'changesets', data.openChangesets],
    [isZh ? '未结承诺' : 'Open commitments', 'commitments', data.openCommitments],
  ];

  const behind = data.totalFiles - data.indexedDocuments;

  return (
    <div className="knowledge-section">
      <div className="knowledge-health-grid">
        {rows.map(([label, key, value]) => (
          <div className="knowledge-health-cell" key={key}>
            <span className="knowledge-health-value">{value}</span>
            <span className="knowledge-health-label">{label}</span>
          </div>
        ))}
      </div>

      {data.lastError && (
        <div className="knowledge-error-text">
          {isZh ? '最近一次错误：' : 'Last error: '}{data.lastError}
        </div>
      )}
      <div className="knowledge-item-meta">
        <span>
          {isZh ? '上次运行' : 'Last run'} {timeLabel(data.lastRunAtMs)}
        </span>
      </div>

      {behind > 0 && (
        <div className="knowledge-warn-row">
          {isZh
            ? `还有 ${behind} 篇笔记没有稳定身份，它们暂时无法被证据、关系或变更引用。`
            : `${behind} notes have no stable identity yet — evidence and change sets cannot reference them.`}
        </div>
      )}

      <div className="knowledge-item-actions">
        <button
          className="knowledge-mini-btn primary"
          disabled={running || busy}
          onClick={() => void advance()}
        >
          {running
            ? (isZh ? '处理中…' : 'Working…')
            : (isZh ? '推进对象化' : 'Advance backfill')}
        </button>
        <button className="knowledge-mini-btn" disabled={busy} onClick={() => void reload()}>
          {isZh ? '刷新' : 'Refresh'}
        </button>
      </div>

      {progress && (
        <div className="knowledge-item-meta">
          <span>{isZh ? '处理' : 'processed'} {progress.processed}</span>
          <span>{isZh ? '新建' : 'created'} {progress.created}</span>
          <span>{isZh ? '失败' : 'failed'} {progress.failed}</span>
          <span>{isZh ? '剩余' : 'remaining'} {progress.remaining}</span>
        </div>
      )}
    </div>
  );
}







