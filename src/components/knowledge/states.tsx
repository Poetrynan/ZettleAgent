import { useCallback, useEffect, useRef, useState } from 'react';
import { t, tf } from '../../lib/i18n';
import type { TranslationKey } from '../../lib/i18n';
import { IconEmpty } from '../icons';

/**
 * 知识中心的四种状态 / the four states every knowledge surface has.
 *
 * 一个页面只要读后端，就有四种可能：在读、读失败、读到了但是空的、读到了有内容。
 * 把失败静默成空列表是这类界面最常见的谎——用户会以为"没有待办"，其实是查询挂了。
 * 所以这里没有"没数据就渲染空"的捷径：`useAsync` 把三者分开返回，调用方必须各写一次。
 */

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  /** 请求在飞。首次加载时 `data` 仍是 null，刷新时 `data` 是上一批。 */
  busy: boolean;
  reload: () => Promise<void>;
}

export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 卸载后到达的响应不许再 setState：切换 tab 比请求快是常态。
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await load();
      if (alive.current) setData(next);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller owns the dep list
  }, deps);

  useEffect(() => {
    void run();
  }, [run]);

  return { data, error, busy, reload: run };
}

/** 骨架屏。空白闪一下再出内容会被读成"这里本来就是空的"。 */
export function KcLoading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="kc-skeleton" role="status" aria-live="polite" aria-busy="true">
      <span className="kc-sr-only">{t('knowledge.loading')}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div className="kc-skeleton-row" key={i} />
      ))}
    </div>
  );
}

/**
 * 空状态 / the empty state.
 *
 * 光写 `No data` 等于把解释工作推给用户。空状态必须说明为什么空，以及下一步能做什么。
 */
export function KcEmpty({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="kc-empty">
      {/* 一个中性的线稿图标，不是 emoji、也不套彩色圆盘：它只负责让这块空白看起来
          是"设计过的空"，而不是"渲染失败"。aria-hidden 因为标题已经把话说完了。 */}
      <span className="kc-empty-icon" aria-hidden="true">
        <IconEmpty size={44} />
      </span>
      <div className="kc-empty-title">{title}</div>
      {hint && <div className="kc-empty-hint">{hint}</div>}
      {action && (
        <button className="kc-btn" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

/**
 * 失败状态 / the failed state.
 *
 * 原始错误留在"技术详情"里而不是主文案里：用户先要知道"没读到、也没改坏任何东西"，
 * 排查的人才需要那串堆栈。
 */
export function KcFailed({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="kc-failed" role="alert">
      <div className="kc-failed-text">{t('knowledge.loadFailed')}</div>
      <details className="kc-details">
        <summary>{t('knowledge.advanced')}</summary>
        <pre className="kc-pre">{error}</pre>
      </details>
      <button className="kc-btn" onClick={onRetry}>
        {t('knowledge.retry')}
      </button>
    </div>
  );
}

export type KcTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/**
 * 状态标 / one status pill.
 *
 * 颜色不是唯一信号：每个 pill 都带文字，图标位用一个几何形状区分色盲下的三个警示级别。
 */
export function KcPill({ tone, label }: { tone: KcTone; label: string }) {
  return (
    <span className={`kc-pill kc-pill-${tone}`}>
      <span className="kc-pill-mark" aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * 未处理数量角标 / the unread badge.
 *
 * 零不显示。一个醒目的 `0` 会训练用户忽略角标本身。
 */
export function KcCount({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="kc-count" aria-label={tf('knowledge.pendingCount', count)}>
      {count > 99 ? '99+' : count}
    </span>
  );
}

/** 有翻译就用翻译，没有就退回代码本身——但会在 dev 控制台喊一声。 */
export function translateCode(prefix: string, code: string): string {
  const key = `${prefix}${code}` as TranslationKey;
  const text = t(key);
  if (text === key && import.meta.env?.DEV) {
    console.warn(`[knowledge] missing translation for ${key}`);
  }
  return text === key ? code : text;
}
