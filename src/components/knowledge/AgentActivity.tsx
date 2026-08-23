import { useState } from 'react';
import {
  AgentRunSummary,
  KnowledgeAuditEvent,
  getKnowledgeAuditTrail,
  listAgentRuns,
  undoAgentRun,
} from '../../lib/tauri';
import { t, tf } from '../../lib/i18n';
import type { TranslationKey } from '../../lib/i18n';
import { KcEmpty, KcFailed, KcLoading, KcPill, translateCode, useAsync } from './states';

/**
 * Agent 活动 / what the Agent has actually been doing.
 *
 * 展示的是可审计事件，不是模型的思考过程：谁在什么时候改了哪些文件、留下了什么审计
 * 记录、还能不能撤销。把隐性思维链摊开来给用户看没有意义——用户要判断的是副作用。
 *
 * 数据来自两个已有的真实来源：`agent_run_journal`（改过文件的回合）和 `audit_events`
 * （每一轮里发生过什么）。这里不新建第三套时间线。
 *
 * 两处刻意不照抄后端的表示法：
 *
 * - 事件名与结果码翻译成人话。`changeset_state / awaiting_approval` 是给排查用的，
 *   不是给用户读的；原始码留在"技术详情"里。
 * - 路径只显示文件名，完整路径进 `title` 和技术详情。一列盘符开头的绝对路径既看不出
 *   改了什么，也会把窄侧栏撑破。
 */

/** 文件名，不是绝对路径。 */
function fileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * 结果码 → 人话 / the result column, in words.
 *
 * 结果码来自三套词汇：审计自己的 `ok`，ChangeSet 的九个状态，任务的六个状态。所以按
 * 顺序在这三本字典里找，而不是把它们各复制一份——复制出来的那份迟早和真的对不上。
 * 三本都没有的照原样显示，那说明后端加了一个还没登记的码，显示一个猜的翻译更糟。
 */
export function resultLabel(result: string): string {
  for (const prefix of [
    'knowledge.activity.result.',
    'knowledge.change.state.',
    'knowledge.task.status.',
  ]) {
    const key = `${prefix}${result}` as TranslationKey;
    const text = t(key);
    if (text !== key) return text;
  }
  return result;
}

/** 失败才是需要被看见的。其余状态一律中性，避免把"被拒绝"渲染成错误。 */
function resultIsBad(result: string): boolean {
  return result === 'error' || result === 'failed';
}

export function AgentActivity({ onOpenFile }: { onOpenFile?: (path: string) => void } = {}) {
  const { data, error, busy, reload } = useAsync(() => listAgentRuns(30), []);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const undo = async (run: AgentRunSummary) => {
    setUndoing(run.run_id);
    setActionError(null);
    setNote(null);
    try {
      const report = await undoAgentRun(run.run_id);
      setNote(tf('knowledge.activity.undoDone', report.restored, report.trashed.length));
      setConfirming(null);
      await reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setUndoing(null);
    }
  };

  if (error) return <KcFailed error={error} onRetry={reload} />;
  if (busy && !data) return <KcLoading rows={3} />;
  if (!data || data.length === 0) {
    return (
      <KcEmpty
        title={t('knowledge.activity.empty')}
        hint={t('knowledge.activity.emptyHint')}
      />
    );
  }

  return (
    <div className="kc-list">
      {note && <div className="kc-note" role="status">{note}</div>}
      {actionError && (
        <div className="kc-failed" role="alert">
          <div className="kc-failed-text">{actionError}</div>
        </div>
      )}

      {data.map(run => (
        <article className="kc-card" key={run.run_id}>
          <header className="kc-card-head">
            {run.undone ? (
              <KcPill tone="neutral" label={t('knowledge.activity.undone')} />
            ) : (
              <KcPill
                tone="info"
                label={tf('knowledge.activity.changeCount', run.change_count)}
              />
            )}
            <time className="kc-card-time" dateTime={new Date(run.started_at_ms).toISOString()}>
              {new Date(run.started_at_ms).toLocaleString()}
            </time>
          </header>

          {run.affected_paths.length > 0 && (
            <ul className="kc-path-list">
              {run.affected_paths.map(p => (
                <li className="kc-path" key={p} title={p}>
                  {fileName(p)}
                  {onOpenFile && (
                    <button className="kc-btn-quiet" onClick={() => onOpenFile(p)}>
                      {t('knowledge.activity.openFile')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="kc-card-actions">
            <button
              className="kc-btn"
              aria-expanded={openRun === run.run_id}
              onClick={() => setOpenRun(openRun === run.run_id ? null : run.run_id)}
            >
              {t('knowledge.activity.auditTrail')}
            </button>
            {!run.undone && confirming !== run.run_id && (
              <button className="kc-btn" onClick={() => setConfirming(run.run_id)}>
                {t('knowledge.activity.undo')}
              </button>
            )}
            {!run.undone && confirming === run.run_id && (
              <>
                <button
                  className="kc-btn kc-btn-danger"
                  disabled={undoing === run.run_id}
                  onClick={() => void undo(run)}
                >
                  {tf('knowledge.activity.undoConfirm', run.change_count)}
                </button>
                <button className="kc-btn" onClick={() => setConfirming(null)}>
                  {t('knowledge.cancel')}
                </button>
              </>
            )}
          </div>

          {openRun === run.run_id && <AuditTrail runId={run.run_id} />}

          <details className="kc-details">
            <summary>{t('knowledge.advanced')}</summary>
            <dl className="kc-kv">
              <dt>run id</dt>
              <dd>{run.run_id}</dd>
              {run.affected_paths.map(p => (
                <dd className="kc-mono" key={p}>
                  {p}
                </dd>
              ))}
            </dl>
          </details>
        </article>
      ))}
    </div>
  );
}

/** 某一轮的审计明细 / the audit trail for one run. */
function AuditTrail({ runId }: { runId: string }) {
  const { data, error, busy, reload } = useAsync<KnowledgeAuditEvent[]>(
    () => getKnowledgeAuditTrail({ runId, limit: 100 }),
    [runId],
  );

  if (error) return <KcFailed error={error} onRetry={reload} />;
  if (busy && !data) return <KcLoading rows={2} />;
  if (!data || data.length === 0) {
    return <div className="kc-note">{t('knowledge.activity.noAudit')}</div>;
  }

  return (
    <table className="kc-table">
      <tbody>
        {data.map(ev => (
          <tr key={ev.id}>
            <td className="kc-table-event">
              {translateCode('knowledge.activity.event.', ev.event)}
            </td>
            <td className={resultIsBad(ev.result) ? 'kc-table-bad' : 'kc-table-ok'}>
              {resultLabel(ev.result)}
            </td>
            <td>
              {t(
                ev.actor === 'user' ? 'knowledge.activity.whoUser' : 'knowledge.activity.whoAgent',
              )}
            </td>
            <td className="kc-table-time">{new Date(ev.created_at_ms).toLocaleTimeString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
