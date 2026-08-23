import { useState } from 'react';
import {
  KnowledgeInboxItem,
  confirmMemory,
  decideCommitment,
  forgetMemory,
  getKnowledgeInbox,
  rejectMemory,
} from '../../lib/tauri';
import { t, tf } from '../../lib/i18n';
import { KcEmpty, KcFailed, KcLoading, KcPill, translateCode, useAsync } from './states';
import type { KcTone } from './states';

/**
 * 统一收件箱 / the one place the Agent asks for a decision.
 *
 * 这不是消息列表，是控制面：每一项都是一个还没有人拍板的判断——候选记忆、待审变更、
 * 待接受承诺、索引故障。分散在四个页面时，用户要点四次才知道自己有没有活；合成一条
 * 流之后，"现在有什么需要我处理"变成一眼能答的问题。
 *
 * 卡片上不出现绝对路径、UUID、`fts`、`rerank` 或 Rust 枚举名。技术字段在折叠区里，
 * 需要排查的人打开就有，不需要的人一眼扫过去只看到人话。
 */

/** 每类的主色。索引故障是危险色，因为它会让后面所有判断都基于不完整的知识库。 */
const KIND_TONE: Record<KnowledgeInboxItem['kind'], KcTone> = {
  health: 'danger',
  change: 'warning',
  memory: 'info',
  task: 'neutral',
};

export interface KnowledgeInboxProps {
  vaultPath: string | null;
  /** 跳到需要完整界面的页面（看 diff、填完成说明、修索引）。 */
  onOpenPage: (page: 'memory' | 'changes' | 'tasks' | 'health') => void;
  /** 收件箱清空/减少后，外面的角标要跟着变。 */
  onChanged?: () => void;
  /** 空状态里"去聊天"。没传就不显示。 */
  onOpenChat?: () => void;
}

export function KnowledgeInbox({
  vaultPath,
  onOpenPage,
  onChanged,
  onOpenChat,
}: KnowledgeInboxProps) {
  const { data, error, busy, reload } = useAsync(() => getKnowledgeInbox(50), []);
  const [acting, setActing] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const act = async (id: string, run: () => Promise<unknown>) => {
    setActing(id);
    setActionError(null);
    try {
      await run();
      await reload();
      onChanged?.();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setActing(null);
    }
  };

  if (error) return <KcFailed error={error} onRetry={reload} />;
  if (busy && !data) return <KcLoading rows={4} />;
  if (!data || data.length === 0) {
    return (
      <KcEmpty
        title={t('knowledge.inbox.empty')}
        hint={t('knowledge.inbox.emptyHint')}
        action={onOpenChat ? { label: t('knowledge.inbox.goChat'), onClick: onOpenChat } : undefined}
      />
    );
  }

  return (
    <div className="kc-list">
      {actionError && (
        <div className="kc-failed" role="alert">
          <div className="kc-failed-text">{actionError}</div>
        </div>
      )}
      {data.map(item => (
        <InboxCard
          key={`${item.kind}:${item.id}`}
          item={item}
          busy={acting === item.id}
          vaultPath={vaultPath}
          onOpenPage={onOpenPage}
          onAct={act}
        />
      ))}
    </div>
  );
}

function InboxCard({
  item,
  busy,
  vaultPath,
  onOpenPage,
  onAct,
}: {
  item: KnowledgeInboxItem;
  busy: boolean;
  vaultPath: string | null;
  onOpenPage: (page: 'memory' | 'changes' | 'tasks' | 'health') => void;
  onAct: (id: string, run: () => Promise<unknown>) => Promise<void>;
}) {
  /**
   * 一个动作按钮 / one action button.
   *
   * `run` 为 null 表示这个动作需要一个完整界面（逐行 diff、完成说明），此时按钮
   * 只负责跳过去，不假装能在卡片上就地完成。
   */
  const action = (code: string) => {
    const label = translateCode('knowledge.action.', code);
    const primary = code === 'confirm' || code === 'preview' || code === 'activate';
    const danger = code === 'forget' || code === 'dismiss';

    const run: (() => Promise<unknown>) | null = (() => {
      switch (code) {
        case 'confirm':
          return () => confirmMemory(item.id, vaultPath ?? undefined);
        case 'reject':
          return () => rejectMemory(item.id);
        case 'forget':
          return () => forgetMemory(item.id);
        case 'activate':
          return () => decideCommitment({ commitmentId: item.id, action: 'activate' });
        case 'snooze':
          // 明天这个时候。真正的自定义延后在任务页。
          return () =>
            decideCommitment({
              commitmentId: item.id,
              action: 'snooze',
              untilMs: Date.now() + 86_400_000,
            });
        case 'dismiss':
          return () => decideCommitment({ commitmentId: item.id, action: 'dismiss' });
        default:
          return null;
      }
    })();

    const jump = () => {
      if (code === 'preview') onOpenPage('changes');
      else if (code === 'open_health') onOpenPage('health');
      else if (code === 'complete') onOpenPage('tasks');
    };

    return (
      <button
        key={code}
        className={`kc-btn ${primary ? 'kc-btn-primary' : ''} ${danger ? 'kc-btn-danger' : ''}`}
        disabled={busy}
        onClick={() => (run ? void onAct(item.id, run) : jump())}
      >
        {label}
      </button>
    );
  };

  return (
    <article className="kc-card">
      <header className="kc-card-head">
        <KcPill
          tone={KIND_TONE[item.kind]}
          label={translateCode('knowledge.inbox.kind.', item.kind)}
        />
        <time className="kc-card-time" dateTime={new Date(item.updatedAtMs).toISOString()}>
          {new Date(item.updatedAtMs).toLocaleString()}
        </time>
      </header>

      <h3 className="kc-card-title">{item.title}</h3>

      {item.kind === 'change' && item.summary && (
        <div className="kc-card-summary">{tf('knowledge.inbox.opCount', item.summary)}</div>
      )}
      {item.kind === 'health' && item.summary && (
        <div className="kc-card-summary kc-card-summary-bad">{item.summary}</div>
      )}

      <p className="kc-card-why">
        <span className="kc-card-why-label">{t('knowledge.whyNow')}</span>
        {translateCode('knowledge.reason.', item.reason)}
      </p>

      {item.sourceId && (
        <div className="kc-card-source">
          <span className="kc-card-source-label">{t('knowledge.source')}</span>
          <span className="kc-card-source-value" title={item.sourceId}>
            {shortSource(item.sourceId)}
          </span>
        </div>
      )}

      <div className="kc-card-actions">{item.actions.map(action)}</div>

      <details className="kc-details">
        <summary>{t('knowledge.advanced')}</summary>
        <dl className="kc-kv">
          <dt>id</dt>
          <dd>{item.id}</dd>
          <dt>status</dt>
          <dd>{item.status}</dd>
          {item.risk && (
            <>
              <dt>risk</dt>
              <dd>{item.risk}</dd>
            </>
          )}
          {item.sourceType && (
            <>
              <dt>source</dt>
              <dd>
                {item.sourceType}:{item.sourceId}
              </dd>
            </>
          )}
          <dt>reason</dt>
          <dd>{item.reason}</dd>
        </dl>
      </details>
    </article>
  );
}

/** 路径只显示末两段：完整路径在 title 和技术详情里。 */
function shortSource(sourceId: string): string {
  const parts = sourceId.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? sourceId : `…/${parts.slice(-2).join('/')}`;
}
