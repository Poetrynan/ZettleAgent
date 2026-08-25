import { useState } from 'react';
import {
  ChangeSetDetail,
  ChangeOpDetail,
  ChangeSetState,
  PendingChangeSet,
  decideChangeSet,
  getChangeSetDetail,
  getChangeSetHistory,
  getPendingChangeSets,
  previewChangeSet,
  undoAgentRun,
} from '../../lib/tauri';
import { collapseUnchanged, diffLines } from '../../lib/diff';
import { t, tf } from '../../lib/i18n';
import { KcEmpty, KcFailed, KcLoading, KcPill, KcTone, translateCode, useAsync } from './states';

/**
 * 变更审阅 / one place to review every write the Agent proposed or made.
 *
 * 这个界面替掉的是三套各说各话的东西：侧栏那份把后端状态串直接印出来的列表
 * （`awaiting_approval` 就这么摊在用户脸上）、把 before/after 两坨原文并排放的"diff"、
 * 以及审批卡片里另一套只有 `low/medium/high` 的严重度词汇。
 *
 * 三件事被统一了：
 *
 * 1. **一个 diff 渲染器**。行级 LCS 在 `lib/diff.ts`，创建/删除/改名各有各的说法，
 *    但都由同一份算法算出来，所以同一份改动在哪儿看都一样。
 * 2. **一个状态模型**。九个后端状态都有中英文案与色调，没有"漏了就退回原始串"。
 * 3. **一条时间线**。提议 → 预演 → 批准 → 落盘，当前停在哪一步说清楚，而不是只给
 *    一个词。
 *
 * 撤销刻意不自己实现：`undo_agent_run` 已经按 journal 逐条回滚、幂等、会报部分失败。
 * 这里只负责问清楚"这一轮还有几条能撤"，撤不了就不给按钮，而不是给一个按下去毫无
 * 效果的按钮。
 */

/** 九个状态各自的色调。只有需要用户动手或出了问题的才升到警示色。 */
const STATE_TONE: Record<ChangeSetState, KcTone> = {
  proposed: 'neutral',
  previewed: 'info',
  awaiting_approval: 'warning',
  approved: 'info',
  committed: 'success',
  rejected: 'neutral',
  conflicted: 'warning',
  rolled_back: 'neutral',
  failed: 'danger',
};

export function changeStateLabel(state: ChangeSetState): string {
  return t(`knowledge.change.state.${state}` as never);
}

export function changeStateTone(state: ChangeSetState): KcTone {
  return STATE_TONE[state] ?? 'neutral';
}

/** 文件名，不是绝对路径。绝对路径当标题会把 UI 变成一串盘符。 */
function shortPath(path: string | null): string {
  if (!path) return t('knowledge.change.noPath');
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * 一条边的改动 / one relation change, rendered as an edge.
 *
 * 关系操作不能走文本 diff。一条边没有正文，`before` / `after` 里那两行字是给人读的摘
 * 要——把它们喂进行级 diff 会得到"整行被删、整行新增"这种既正确又毫无信息量的结果。
 *
 * 三件事必须显式说出来，因为它们决定用户要不要点批准：
 *
 * - **方向**。`A → B` 和 `B → A` 是两条不同的边，图谱上的推理方向也随之相反。
 * - **来源**。AI 推断的边和用户自己连的边不能长得一样，否则下一次回看时无从分辨
 *   "这是我连的还是它猜的"。
 * - **置信度**。0.6 与 0.95 对应的是"值得看一眼"和"基本可以当事实"，混在一起显示等于
 *   没有显示。
 */
function RelationChange({ op }: { op: ChangeOpDetail }) {
  const rel = op.relation;
  if (!rel) {
    // 关系操作却没有载荷：这是数据问题，不是空状态。说出来比画一个空框好。
    return <p className="kc-warn">{t('knowledge.change.relationPayloadMissing')}</p>;
  }
  const removing = op.opKind === 'delete_relation';
  const confidence = removing ? rel.oldConfidence ?? rel.confidence : rel.confidence;

  return (
    <div className="kc-diff kc-diff-move">
      <div className="kc-kv-row">
        <span className="kc-kv-key">{t('knowledge.change.relationFrom')}</span>
        <span className="kc-kv-val" title={rel.sourcePath}>
          {shortPath(rel.sourcePath)}
        </span>
      </div>
      <div className="kc-kv-row">
        <span className="kc-kv-key">{t('knowledge.change.relationType')}</span>
        <span className="kc-kv-val">
          {translateCode('knowledge.change.relationKind.', rel.relationType)}
        </span>
      </div>
      <div className="kc-kv-row">
        <span className="kc-kv-key">{t('knowledge.change.relationTo')}</span>
        <span className="kc-kv-val" title={rel.targetPath}>
          {shortPath(rel.targetPath)}
        </span>
      </div>
      <div className="kc-kv-row">
        <span className="kc-kv-key">{t('knowledge.change.relationOrigin')}</span>
        <span className="kc-kv-val">
          {translateCode('knowledge.change.relationSource.', rel.origin)}
          {' · '}
          {tf('knowledge.change.relationConfidence', confidence.toFixed(2))}
        </span>
      </div>
      {rel.reason && <p className="kc-change-op-reason">{rel.reason}</p>}
      <p className="kc-muted">
        {t(removing ? 'knowledge.change.relationRemoves' : 'knowledge.change.relationAdds')}
      </p>
    </div>
  );
}

/**
 * 一步改动的 diff / one operation, rendered as a diff.
 *
 * 四种情况分开说，因为它们对用户的意义不同：新建（没有"改之前"）、删除（没有"改之
 * 后"）、改名（内容没动，位置动了）、关系（压根没有正文）。把它们都塞进"全行标绿"或
 * "全行标红"是在制造一个假 diff。
 */
export function ChangeDiff({ op }: { op: ChangeOpDetail }) {
  if (op.opKind === 'add_relation' || op.opKind === 'delete_relation') {
    return <RelationChange op={op} />;
  }

  if (op.opKind === 'rename' || op.opKind === 'move') {
    return (
      <div className="kc-diff kc-diff-move">
        <div className="kc-kv-row">
          <span className="kc-kv-key">{t('knowledge.change.movedFrom')}</span>
          <span className="kc-kv-val">{shortPath(op.path)}</span>
        </div>
        <div className="kc-kv-row">
          <span className="kc-kv-key">{t('knowledge.change.movedTo')}</span>
          <span className="kc-kv-val">{shortPath(op.newPath)}</span>
        </div>
        <p className="kc-muted">{t('knowledge.change.moveKeepsContent')}</p>
      </div>
    );
  }

  const before = op.before ?? '';
  const after = op.opKind === 'delete' ? '' : op.after ?? '';

  // 内容这一侧压根没记下来时不画 diff：画出来的会是"整篇被删/整篇新增"，那是假的。
  if (op.opKind !== 'delete' && op.after === null) {
    return (
      <p className="kc-warn">
        {t('knowledge.change.contentUnknown')}
        {op.beforeSource === 'none' && ` ${t('knowledge.change.beforeUnknown')}`}
      </p>
    );
  }

  const { lines, stats, exact } = diffLines(before, after);
  if (lines.length === 0) {
    return <p className="kc-muted">{t('knowledge.change.noTextChange')}</p>;
  }
  const chunks = collapseUnchanged(lines);

  return (
    <div className="kc-diff">
      <p className="kc-diff-summary">
        {tf('knowledge.change.diffSummary', stats.added, stats.removed)}
        {!exact && <span className="kc-warn"> {t('knowledge.change.diffApprox')}</span>}
      </p>
      {op.beforeSource === 'current_index' && (
        <p className="kc-muted">{t('knowledge.change.beforeFromIndex')}</p>
      )}
      {chunks.map((chunk, ci) => (
        <div className="kc-diff-chunk" key={ci}>
          {chunk.skippedBefore > 0 && (
            <div className="kc-diff-skip">{tf('knowledge.change.linesHidden', chunk.skippedBefore)}</div>
          )}
          {chunk.lines.map((line, li) => (
            <div className={`kc-diff-line kc-diff-${line.type}`} key={li}>
              <span className="kc-diff-gutter" aria-hidden="true">
                {line.oldLine ?? line.newLine ?? ''}
              </span>
              <span className="kc-diff-sign">
                {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                <span className="kc-sr-only">
                  {t(`knowledge.change.line.${line.type}` as never)}
                </span>
              </span>
              <span className="kc-diff-text">{line.text || '\u00a0'}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** 四步：提议 → 预演 → 裁决 → 落盘。九个状态各归其中一步。 */
const TIMELINE: Array<{ step: string; states: ChangeSetState[] }> = [
  { step: 'proposed', states: ['proposed'] },
  { step: 'previewed', states: ['previewed', 'conflicted'] },
  { step: 'decided', states: ['awaiting_approval', 'approved', 'rejected'] },
  { step: 'written', states: ['committed', 'failed', 'rolled_back'] },
];

/**
 * 状态时间线 / the four steps every write goes through.
 *
 * 只给一个状态词的问题是用户无从判断"还差什么"。四步摊开之后，`approved` 意味着
 * "已经批准、还没落盘"这件事不用再解释一遍。
 */
function ChangeTimeline({ state }: { state: ChangeSetState }) {
  const reachedIndex = TIMELINE.findIndex(s => s.states.includes(state));
  return (
    <ol className="kc-timeline" aria-label={t('knowledge.change.timeline')}>
      {TIMELINE.map((entry, index) => {
        const done = reachedIndex >= 0 && index < reachedIndex;
        const current = index === reachedIndex;
        return (
          <li
            key={entry.step}
            className={`kc-timeline-step${done ? ' kc-timeline-done' : ''}${current ? ' kc-timeline-current' : ''}`}
            aria-current={current ? 'step' : undefined}
          >
            <span className="kc-timeline-mark" aria-hidden="true" />
            {t(`knowledge.change.step.${entry.step}` as never)}
            {current && <span className="kc-sr-only"> — {changeStateLabel(state)}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * 能做什么、为什么不能 / the actions, and why one is missing.
 *
 * 撤销按钮只在 journal 里真的还有条目时出现。看得见但按下去什么也不发生的按钮，比没
 * 有按钮更伤：用户会以为已经撤销了。
 */
function ChangeSetActions({
  state,
  conflicted,
  pending,
  acting,
  runId,
  undoableEntries,
  journalEntries,
  onApprove,
  onReject,
  onUndo,
}: {
  state: ChangeSetState;
  conflicted: boolean;
  pending: boolean;
  acting: boolean;
  runId: string | null;
  undoableEntries: number;
  journalEntries: number;
  onApprove: () => void;
  onReject: () => void;
  onUndo: (runId: string) => void;
}) {
  const [confirmUndo, setConfirmUndo] = useState(false);

  if (pending) {
    return (
      <div className="kc-card-actions">
        <button className="kc-btn" disabled={acting || conflicted} onClick={onApprove}>
          {t('knowledge.action.approve')}
        </button>
        <button className="kc-btn kc-btn-danger" disabled={acting} onClick={onReject}>
          {t('knowledge.action.reject')}
        </button>
        {conflicted && <p className="kc-warn">{t('knowledge.change.conflictBlocksApproval')}</p>}
      </div>
    );
  }

  if (state !== 'committed') {
    return null;
  }

  if (!runId || journalEntries === 0) {
    return <p className="kc-muted">{t('knowledge.change.undoNoJournal')}</p>;
  }
  if (undoableEntries === 0) {
    return <p className="kc-muted">{t('knowledge.change.undoAlreadyDone')}</p>;
  }

  return (
    <div className="kc-card-actions">
      {!confirmUndo && (
        <button className="kc-btn" onClick={() => setConfirmUndo(true)}>
          {t('knowledge.activity.undo')}
        </button>
      )}
      {confirmUndo && (
        <>
          <button
            className="kc-btn kc-btn-danger"
            disabled={acting}
            onClick={() => onUndo(runId)}
          >
            {tf('knowledge.activity.undoConfirm', undoableEntries)}
          </button>
          <button className="kc-btn" onClick={() => setConfirmUndo(false)}>
            {t('knowledge.cancel')}
          </button>
        </>
      )}
      <p className="kc-muted">{t('knowledge.change.undoScope')}</p>
    </div>
  );
}

/** 一个批次展开后的样子 / one change set, expanded. */
function ChangeSetBody({
  changesetId,
  onDecided,
  onOpenSource,
}: {
  changesetId: string;
  onDecided: () => void;
  onOpenSource?: (path: string) => void;
}) {
  const { data, error, busy, reload } = useAsync<ChangeSetDetail | null>(
    () => getChangeSetDetail(changesetId),
    [changesetId],
  );
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const run = async (work: () => Promise<string | null>) => {
    setActing(true);
    setActionError(null);
    setNote(null);
    try {
      setNote(await work());
      await reload();
      onDecided();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setActing(false);
    }
  };

  if (error) return <KcFailed error={error} onRetry={reload} />;
  if (!data) return <KcLoading rows={2} />;

  const { changeset, ops, undoableEntries, journalEntries } = data;
  const conflicted = ops.some(op => op.conflict);
  const pending = !['committed', 'rejected', 'rolled_back', 'failed'].includes(changeset.state);

  return (
    <div className="kc-change-body">
      <ChangeTimeline state={changeset.state} />
      {note && <p className="kc-note" role="status">{note}</p>}
      {actionError && (
        <div className="kc-failed" role="alert">
          <div className="kc-failed-text">{actionError}</div>
        </div>
      )}

      {ops.length === 0 && <p className="kc-warn">{t('knowledge.change.noOps')}</p>}

      {ops.map(op => (
        <section className="kc-change-op" key={op.opId}>
          <header className="kc-change-op-head">
            <KcPill tone={op.conflict ? 'warning' : 'neutral'} label={t(`knowledge.change.opKind.${op.opKind}` as never)} />
            <span className="kc-change-op-path" title={op.path ?? undefined}>
              {shortPath(op.path)}
            </span>
            {op.path && onOpenSource && (
              <button className="kc-btn-quiet" onClick={() => onOpenSource(op.path as string)}>
                {t('knowledge.change.openFile')}
              </button>
            )}
          </header>
          {op.reason && <p className="kc-change-op-reason">{op.reason}</p>}
          {op.conflict && (
            <p className="kc-warn" role="alert">
              {op.conflictMessage ?? t('knowledge.change.conflictGeneric')}
            </p>
          )}
          <ChangeDiff op={op} />
          {op.affectedObjects.length > 0 && (
            <p className="kc-muted">{tf('knowledge.change.alsoTouches', op.affectedObjects.length)}</p>
          )}
          <details className="kc-details">
            <summary>{t('knowledge.advanced')}</summary>
            <dl className="kc-kv">
              <dt>{t('knowledge.change.fullPath')}</dt>
              <dd className="kc-mono">{op.path ?? '—'}</dd>
              <dt>op id</dt>
              <dd className="kc-mono">{op.opId}</dd>
            </dl>
          </details>
        </section>
      ))}
      <ChangeSetActions
        state={changeset.state}
        conflicted={conflicted}
        pending={pending}
        acting={acting}
        runId={changeset.run_id}
        undoableEntries={undoableEntries}
        journalEntries={journalEntries}
        onApprove={() =>
          void run(async () => {
            await previewChangeSet(changesetId);
            await decideChangeSet(changesetId, true);
            return t('knowledge.change.approved');
          })
        }
        onReject={() =>
          void run(async () => {
            await decideChangeSet(changesetId, false);
            return t('knowledge.change.rejected');
          })
        }
        onUndo={runId =>
          void run(async () => {
            const report = await undoAgentRun(runId);
            return tf('knowledge.activity.undoDone', report.restored, report.trashed.length);
          })
        }
      />
    </div>
  );
}

/**
 * 变更列表 / the two lists: what needs a decision, and what already happened.
 *
 * 分成两组而不是一个长列表：待处理的要"做决定"，已落地的要"回看和撤销"。混在一起用户
 * 得先分辨哪一行还能操作。
 */
export function ChangeReview({ onOpenSource }: { onOpenSource?: (path: string) => void }) {
  const [showHistory, setShowHistory] = useState(false);
  const pending = useAsync<PendingChangeSet[]>(() => getPendingChangeSets(50), []);
  const history = useAsync<PendingChangeSet[]>(
    () => (showHistory ? getChangeSetHistory(50) : Promise.resolve([])),
    [showHistory],
  );
  const [openId, setOpenId] = useState<string | null>(null);

  const refreshAll = () => {
    void pending.reload();
    if (showHistory) void history.reload();
  };

  const list = showHistory ? history : pending;

  return (
    <div className="kc-change-review">
      <div className="kc-chipset" role="tablist" aria-label={t('knowledge.change.which')}>
        <button
          role="tab"
          aria-selected={!showHistory}
          className={`kc-chip${!showHistory ? ' active' : ''}`}
          onClick={() => setShowHistory(false)}
        >
          {t('knowledge.change.pending')}
        </button>
        <button
          role="tab"
          aria-selected={showHistory}
          className={`kc-chip${showHistory ? ' active' : ''}`}
          onClick={() => setShowHistory(true)}
        >
          {t('knowledge.change.history')}
        </button>
      </div>

      {list.error && <KcFailed error={list.error} onRetry={list.reload} />}
      {!list.error && list.busy && !list.data && <KcLoading rows={3} />}
      {!list.error && list.data?.length === 0 && (
        <KcEmpty
          title={t(showHistory ? 'knowledge.change.historyEmpty' : 'knowledge.change.pendingEmpty')}
          hint={t(
            showHistory ? 'knowledge.change.historyEmptyHint' : 'knowledge.change.pendingEmptyHint',
          )}
        />
      )}

      {list.data?.map(cs => (
        <article className="kc-card" key={cs.id}>
          <header className="kc-card-head">
            <KcPill tone={changeStateTone(cs.state)} label={changeStateLabel(cs.state)} />
            <span className="kc-card-title">
              {cs.intent ? translateCode('knowledge.change.intent.', cs.intent) : cs.actor}
            </span>
            <span className="kc-muted">{tf('knowledge.change.opCount', cs.opCount)}</span>
            <time className="kc-card-time" dateTime={new Date(cs.updatedAtMs).toISOString()}>
              {new Date(cs.updatedAtMs).toLocaleString()}
            </time>
          </header>
          {cs.commitError && (
            <p className="kc-warn" role="alert">
              {t('knowledge.change.writeFailed')}
              <span className="kc-sr-only"> {cs.commitError}</span>
            </p>
          )}
          <div className="kc-card-actions">
            <button
              className="kc-btn"
              aria-expanded={openId === cs.id}
              onClick={() => setOpenId(openId === cs.id ? null : cs.id)}
            >
              {openId === cs.id ? t('knowledge.change.hideDiff') : t('knowledge.action.preview')}
            </button>
          </div>
          {openId === cs.id && (
            <ChangeSetBody
              changesetId={cs.id}
              onDecided={refreshAll}
              onOpenSource={onOpenSource}
            />
          )}
        </article>
      ))}
    </div>
  );
}



