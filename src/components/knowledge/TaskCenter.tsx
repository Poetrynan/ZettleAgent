import { useEffect, useRef, useState } from 'react';
import {
  CommitmentListQuery,
  CommitmentStatus,
  ProactiveDigest,
  TaskCommitment,
  decideCommitment,
  getCommitmentList,
  getProactiveDigest,
  getSetting,
  markCommitmentNotified,
  scanCommitments,
  setSetting,
} from '../../lib/tauri';
import { t, tf } from '../../lib/i18n';
import type { TranslationKey } from '../../lib/i18n';
import { KcEmpty, KcFailed, KcLoading, KcPill, KcTone, translateCode, useAsync } from './states';

/**
 * 任务台 / the open-loops workbench.
 *
 * 侧栏那份只回答一个问题："现在有什么等我？"——它读收件箱，只看得到 `proposed` 和
 * `active`。于是任何被推迟的、已经做完的、日期已经过去的事情，一旦离开收件箱就等于
 * 从产品里消失了。用户没法回答"我上周答应的那件事后来怎么了"。
 *
 * 这一页把同一批数据换成六个视图：等我决定 / 已接受 / 已过日期 / 已推迟 / 没写日期 /
 * 已完成。筛选在后端做（`knowledge_commitment_list`），因为"已完成"那一批可能很长，
 * 拉回全部再在前端筛是在假装分页。
 *
 * 三件事刻意保持和后端一致，而不是在界面上放宽：
 *
 * 1. **完成必须带一句说明。** `deliver_result` 会把它登记成内容寻址的完成证据并绑回
 *    源对象。没有说明的"完成"是一句无法核对的断言，所以按钮在输入框空着时是禁用的。
 * 2. **推迟是一个任意时刻**，不是"明天"这一个档。`remind_at_ms` 本来就能存任意时间戳。
 * 3. **关掉不等于删掉。** dismissed 的任务留在列表里可查，只是不再自己冒出来。
 */

/** 六种状态的色调。只有"等我决定"和"已过日期"值得升到警示色。 */
const STATUS_TONE: Record<CommitmentStatus, KcTone> = {
  proposed: 'warning',
  active: 'info',
  done: 'success',
  snoozed: 'neutral',
  dismissed: 'neutral',
  expired: 'danger',
};

export type TaskView = 'needs' | 'active' | 'overdue' | 'snoozed' | 'undated' | 'done';

const VIEWS: { key: TaskView; labelKey: TranslationKey }[] = [
  { key: 'needs', labelKey: 'knowledge.task.view.needs' },
  { key: 'active', labelKey: 'knowledge.task.view.active' },
  { key: 'overdue', labelKey: 'knowledge.task.view.overdue' },
  { key: 'snoozed', labelKey: 'knowledge.task.view.snoozed' },
  { key: 'undated', labelKey: 'knowledge.task.view.undated' },
  { key: 'done', labelKey: 'knowledge.task.view.done' },
];

/**
 * 视图 → 查询条件 / one view, one server-side filter.
 *
 * "已过日期"故意同时收 `proposed` 和 `active`：一件还没被接受、日期却已经过去的事，
 * 正是最需要被看见的那一类，把它只留在"等我决定"里等于把它埋掉。
 */
export function queryFor(view: TaskView, search: string, now: number): CommitmentListQuery {
  const q: CommitmentListQuery = { limit: 200 };
  if (search) q.search = search;
  switch (view) {
    case 'needs':
      q.statuses = ['proposed'];
      break;
    case 'active':
      q.statuses = ['active'];
      break;
    case 'overdue':
      q.statuses = ['proposed', 'active', 'expired'];
      q.dueBeforeMs = now;
      break;
    case 'snoozed':
      q.statuses = ['snoozed'];
      break;
    case 'undated':
      q.statuses = ['proposed', 'active'];
      q.undatedOnly = true;
      break;
    case 'done':
      q.statuses = ['done'];
      break;
  }
  return q;
}

function whenLabel(ms: number): string {
  return new Date(ms).toLocaleString();
}

/** `datetime-local` 的值 → 毫秒。浏览器给的是本地时间，`new Date` 也按本地解析。 */
function localInputToMs(value: string): number | null {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

type CardMode = null | 'complete' | 'snooze';

/**
 * 一条任务 / one commitment.
 *
 * 动作按"这条现在处于什么状态"给，而不是全都摆出来：已经完成的不给"完成"按钮，
 * 已经关掉的不给"别再提醒"。给一个按下去只会报错的按钮，比不给更糟。
 */
export function TaskCard({
  item,
  onAct,
  onOpenSource,
  busy,
}: {
  item: TaskCommitment;
  onAct: (payload: Parameters<typeof decideCommitment>[0]) => Promise<void>;
  onOpenSource?: (path: string) => void;
  busy: boolean;
}) {
  const [mode, setMode] = useState<CardMode>(null);
  const [summary, setSummary] = useState('');
  const [until, setUntil] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const overdue =
    item.due_at_ms !== null && item.due_at_ms < Date.now() && item.status !== 'done';
  // 只有从文件扫出来的才有真的路径可打开。object id 或 session id 点开会是一个假跳转。
  const filePath =
    item.source && item.source.source_type === 'file' ? item.source.source_id : null;
  const closed = item.status === 'done' || item.status === 'dismissed';

  const snoozeTo = (ms: number) => void onAct({ commitmentId: item.id, action: 'snooze', untilMs: ms });

  return (
    <article className={`kc-card${overdue ? ' kc-item-warning' : ''}`}>
      <header className="kc-card-head">
        <KcPill
          tone={overdue ? 'danger' : STATUS_TONE[item.status]}
          label={t(`knowledge.task.status.${item.status}` as TranslationKey)}
        />
        <span className="kc-card-title">{item.title}</span>
        <span className="kc-muted">{translateCode('knowledge.task.type.', item.commitment_type)}</span>
      </header>

      <div className="kc-task-meta">
        {item.due_at_ms !== null ? (
          <time className={overdue ? 'kc-warn-line' : undefined} dateTime={new Date(item.due_at_ms).toISOString()}>
            {tf(overdue ? 'knowledge.task.overdueBy' : 'knowledge.task.due', whenLabel(item.due_at_ms))}
          </time>
        ) : (
          <span className="kc-muted">{t('knowledge.task.noDue')}</span>
        )}
        {item.status === 'snoozed' && item.remind_at_ms !== null && (
          <span>{tf('knowledge.task.remindAt', whenLabel(item.remind_at_ms))}</span>
        )}
        {item.notify_count > 0 && <span className="kc-muted">{tf('knowledge.task.nudged', item.notify_count)}</span>}
        {item.completion_evidence_id && (
          <span className="kc-muted">{t('knowledge.task.evidenceRecorded')}</span>
        )}
      </div>

      {filePath ? (
        onOpenSource && (
          <div className="kc-card-actions">
            <button className="kc-btn-quiet" onClick={() => onOpenSource(filePath)}>
              {t('knowledge.task.openSource')}
            </button>
          </div>
        )
      ) : (
        <p className="kc-muted">{t('knowledge.task.noSource')}</p>
      )}

      {localError && <p className="kc-warn" role="alert">{localError}</p>}

      {mode === 'complete' && (
        <div className="kc-edit">
          <label className="kc-field-label" htmlFor={`done-${item.id}`}>
            {t('knowledge.task.completeLabel')}
          </label>
          <input
            id={`done-${item.id}`}
            className="kc-input"
            value={summary}
            autoFocus
            placeholder={t('knowledge.task.completePlaceholder')}
            onChange={e => setSummary(e.target.value)}
          />
          <p className="kc-muted">{t('knowledge.task.completeWhy')}</p>
          <div className="kc-card-actions">
            <button
              className="kc-btn kc-btn-primary"
              disabled={busy || !summary.trim()}
              onClick={() =>
                void onAct({
                  commitmentId: item.id,
                  action: 'complete',
                  resultSummary: summary.trim(),
                })
              }
            >
              {t('knowledge.task.save')}
            </button>
            <button className="kc-btn" onClick={() => setMode(null)}>
              {t('knowledge.task.cancel')}
            </button>
          </div>
        </div>
      )}

      {mode === 'snooze' && (
        <div className="kc-edit">
          <label className="kc-field-label" htmlFor={`snooze-${item.id}`}>
            {t('knowledge.task.snoozeCustomLabel')}
          </label>
          <input
            id={`snooze-${item.id}`}
            className="kc-input"
            type="datetime-local"
            value={until}
            onChange={e => setUntil(e.target.value)}
          />
          <div className="kc-card-actions">
            <button
              className="kc-btn kc-btn-primary"
              disabled={busy || !until}
              onClick={() => {
                const ms = localInputToMs(until);
                if (ms === null || ms <= Date.now()) {
                  setLocalError(t('knowledge.task.snoozePast'));
                  return;
                }
                setLocalError(null);
                snoozeTo(ms);
              }}
            >
              {t('knowledge.task.snoozeApply')}
            </button>
            <button className="kc-btn" onClick={() => snoozeTo(Date.now() + 86_400_000)} disabled={busy}>
              {t('knowledge.task.snoozeTomorrow')}
            </button>
            <button
              className="kc-btn"
              onClick={() => snoozeTo(Date.now() + 7 * 86_400_000)}
              disabled={busy}
            >
              {t('knowledge.task.snoozeNextWeek')}
            </button>
            <button className="kc-btn" onClick={() => setMode(null)}>
              {t('knowledge.task.cancel')}
            </button>
          </div>
        </div>
      )}

      {mode === null && (
        <div className="kc-card-actions">
          {item.status === 'proposed' && (
            <button
              className="kc-btn kc-btn-primary"
              disabled={busy}
              onClick={() => void onAct({ commitmentId: item.id, action: 'activate' })}
            >
              {t('knowledge.task.accept')}
            </button>
          )}
          {item.status !== 'done' && (
            <button
              className="kc-btn"
              disabled={busy}
              onClick={() => {
                setSummary('');
                setLocalError(null);
                setMode('complete');
              }}
            >
              {t('knowledge.task.complete')}
            </button>
          )}
          {!closed && (
            <button
              className="kc-btn"
              disabled={busy}
              onClick={() => {
                setUntil('');
                setLocalError(null);
                setMode('snooze');
              }}
            >
              {t('knowledge.task.snooze')}
            </button>
          )}
          {!closed && (
            <button
              className="kc-btn kc-btn-danger"
              disabled={busy}
              title={t('knowledge.task.dismissWhy')}
              onClick={() => void onAct({ commitmentId: item.id, action: 'dismiss' })}
            >
              {t('knowledge.task.dismiss')}
            </button>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * 提醒规则 / the four gates, as controls.
 *
 * 默认值和后端 `NotifyPolicy::default()` 对齐：总开关默认**关**。一个刚装好的应用不该
 * 先开口，用户打开的那一刻才算同意。读不到设置时显示的也是这套默认值，而不是"全部允许"。
 */
export function ProactivePolicy({ onSaved }: { onSaved?: () => void }) {
  const [enabled, setEnabled] = useState(false);
  const [quiet, setQuiet] = useState('22-8');
  const [maxPerDay, setMaxPerDay] = useState('3');
  const [gap, setGap] = useState('240');
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const loaded = useAsync<void>(async () => {
    const [e, q, m, g] = await Promise.all([
      getSetting('proactive_enabled'),
      getSetting('proactive_quiet_hours'),
      getSetting('proactive_max_per_day'),
      getSetting('proactive_min_gap_minutes'),
    ]);
    setEnabled(e === 'true' || e === '1');
    if (q) setQuiet(q);
    if (m) setMaxPerDay(m);
    if (g) setGap(g);
  }, []);

  const save = async () => {
    setProblem(null);
    setNote(null);
    const [from, to] = quiet.split('-').map(s => Number(s.trim()));
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > 23 || to < 0 || to > 23) {
      setProblem(t('knowledge.proactive.policyBadQuiet'));
      return;
    }
    const max = Number(maxPerDay);
    const minutes = Number(gap);
    if (!Number.isInteger(max) || max <= 0 || !Number.isInteger(minutes) || minutes <= 0) {
      setProblem(t('knowledge.proactive.policyBadNumber'));
      return;
    }
    try {
      await setSetting('proactive_enabled', enabled ? 'true' : 'false');
      await setSetting('proactive_quiet_hours', `${from}-${to}`);
      await setSetting('proactive_max_per_day', String(max));
      await setSetting('proactive_min_gap_minutes', String(minutes));
      setNote(t('knowledge.proactive.policySaved'));
      onSaved?.();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
  };

  if (loaded.error) return <KcFailed error={loaded.error} onRetry={loaded.reload} />;

  return (
    <details className="kc-details">
      <summary>{t('knowledge.proactive.policy')}</summary>
      <div className="kc-filters">
        <label className="kc-field">
          <span className="kc-field-label">{t('knowledge.proactive.policyEnabled')}</span>
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
        </label>
        <label className="kc-field">
          <span className="kc-field-label">{t('knowledge.proactive.policyQuiet')}</span>
          <input className="kc-input" value={quiet} onChange={e => setQuiet(e.target.value)} />
        </label>
        <label className="kc-field">
          <span className="kc-field-label">{t('knowledge.proactive.policyMax')}</span>
          <input
            className="kc-input"
            type="number"
            min={1}
            value={maxPerDay}
            onChange={e => setMaxPerDay(e.target.value)}
          />
        </label>
        <label className="kc-field">
          <span className="kc-field-label">{t('knowledge.proactive.policyGap')}</span>
          <input
            className="kc-input"
            type="number"
            min={1}
            value={gap}
            onChange={e => setGap(e.target.value)}
          />
        </label>
      </div>
      <p className="kc-muted">{t('knowledge.proactive.policyQuietHint')}</p>
      {problem && <p className="kc-warn" role="alert">{problem}</p>}
      {note && <p className="kc-note" role="status">{note}</p>}
      <div className="kc-card-actions">
        <button className="kc-btn kc-btn-primary" onClick={() => void save()}>
          {t('knowledge.proactive.policySave')}
        </button>
      </div>
    </details>
  );
}

/**
 * 这一轮该提醒什么 / the nudges the policy actually allows.
 *
 * 两件事这里必须诚实：
 *
 * 1. **被闸门挡住时说出是哪一道。** 只显示"暂无提醒"会让用户以为没事，其实是免打扰
 *    时段或今天的条数用完了——那正是他们该去改规则的时刻。
 * 2. **真的展示了才记一笔。** `markCommitmentNotified` 是日上限和最小间隔唯一的推进
 *    方式；渲染了却不记，等于克制机制形同虚设。所以标记发生在 items 非空之后，
 *    每个 id 在本次挂载里只记一次。
 */
export function ProactiveNudges({
  onOpenSource,
  onAct,
  busy,
}: {
  onOpenSource?: (path: string) => void;
  onAct: (payload: Parameters<typeof decideCommitment>[0]) => Promise<void>;
  busy: boolean;
}) {
  const digest = useAsync<ProactiveDigest>(() => getProactiveDigest(5), []);
  const marked = useRef<Set<string>>(new Set());

  const items = digest.data?.items ?? [];
  useEffect(() => {
    for (const item of digest.data?.items ?? []) {
      if (marked.current.has(item.id)) continue;
      marked.current.add(item.id);
      void markCommitmentNotified(item.id).catch(() => {
        // 记不上就让它下轮再试：这里失败只会让提醒多出现一次，不会丢数据。
        marked.current.delete(item.id);
      });
    }
  }, [digest.data]);

  if (digest.error) return <KcFailed error={digest.error} onRetry={digest.reload} />;
  if (!digest.data) return <KcLoading rows={1} />;

  const { silenced, expired } = digest.data;

  return (
    <section className="kc-nudges" aria-label={t('knowledge.proactive.title')}>
      {expired > 0 && <p className="kc-muted">{tf('knowledge.proactive.expired', expired)}</p>}
      {silenced && (
        <p className="kc-note" role="status">
          {translateCode('knowledge.proactive.silenced.', silenced)}
        </p>
      )}
      {!silenced && items.length === 0 && <p className="kc-muted">{t('knowledge.proactive.none')}</p>}
      {items.map(item => (
        <TaskCard key={item.id} item={item} onAct={onAct} onOpenSource={onOpenSource} busy={busy} />
      ))}
      <ProactivePolicy onSaved={digest.reload} />
    </section>
  );
}

/**
 * 任务台 / the page.
 *
 * 提醒区在最上面，因为它回答的是"现在"；下面六个视图回答"整体"。搜索有 300ms 的节流：
 * 每敲一个字打一次后端查询，在几千条任务上会把界面卡住。
 */
export function TaskCenter({
  onOpenSource,
  onChanged,
}: {
  onOpenSource?: (path: string) => void;
  onChanged?: () => void;
}) {
  const [view, setView] = useState<TaskView>('needs');
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);

  useEffect(() => {
    const handle = setTimeout(() => setSearch(typed.trim()), 300);
    return () => clearTimeout(handle);
  }, [typed]);

  const list = useAsync<TaskCommitment[]>(
    () => getCommitmentList(queryFor(view, search, Date.now())),
    [view, search],
  );

  const act = async (payload: Parameters<typeof decideCommitment>[0]) => {
    setActing(true);
    setActionError(null);
    try {
      await decideCommitment(payload);
      await list.reload();
      onChanged?.();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setActing(false);
    }
  };

  const scan = async () => {
    setScanning(true);
    setScanNote(null);
    setActionError(null);
    try {
      const result = await scanCommitments(200);
      setScanNote(tf('knowledge.task.scanResult', result.found, result.created));
      await list.reload();
      onChanged?.();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="kc-tasks">
      <ProactiveNudges onOpenSource={onOpenSource} onAct={act} busy={acting} />

      <div className="kc-chipset" role="tablist" aria-label={t('knowledge.task.which')}>
        {VIEWS.map(v => (
          <button
            key={v.key}
            role="tab"
            aria-selected={view === v.key}
            className={`kc-chip${view === v.key ? ' active' : ''}`}
            onClick={() => setView(v.key)}
          >
            {t(v.labelKey)}
          </button>
        ))}
      </div>

      <div className="kc-filters">
        <label className="kc-field">
          <span className="kc-field-label">{t('knowledge.task.searchLabel')}</span>
          <input
            className="kc-input"
            type="search"
            value={typed}
            placeholder={t('knowledge.task.searchPlaceholder')}
            onChange={e => setTyped(e.target.value)}
          />
        </label>
        <button className="kc-btn" disabled={scanning} onClick={() => void scan()}>
          {scanning ? t('knowledge.task.scanning') : t('knowledge.task.scan')}
        </button>
      </div>

      {scanNote && <p className="kc-note" role="status">{scanNote}</p>}
      {actionError && (
        <div className="kc-failed" role="alert">
          <div className="kc-failed-text">{actionError}</div>
        </div>
      )}

      {list.error && <KcFailed error={list.error} onRetry={list.reload} />}
      {!list.error && list.busy && !list.data && <KcLoading rows={3} />}
      {!list.error && list.data?.length === 0 && (
        <KcEmpty
          title={t(view === 'needs' ? 'knowledge.task.emptyNeeds' : 'knowledge.task.emptyOther')}
          hint={t(
            view === 'needs' ? 'knowledge.task.emptyNeedsHint' : 'knowledge.task.emptyOtherHint',
          )}
          action={
            view === 'needs' ? { label: t('knowledge.task.scan'), onClick: () => void scan() } : undefined
          }
        />
      )}

      <div className="kc-list">
        {list.data?.map(item => (
          <TaskCard
            key={item.id}
            item={item}
            onAct={act}
            onOpenSource={onOpenSource}
            busy={acting}
          />
        ))}
      </div>
    </div>
  );
}






