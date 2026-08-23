import { useCallback, useEffect, useState } from 'react';
import {
  ContextPackageSummary,
  KnowledgeAuditEvent,
  MemoryItem,
  confirmMemory,
  forgetMemory,
  getKnowledgeAuditTrail,
  getMemoryInbox,
  rejectMemory,
  syncMemoryFile,
} from '../../lib/tauri';
import { getLang } from '../../lib/i18n';
import { ContextInspector } from '../knowledge/ContextInspector';
import { ChangeReview } from '../knowledge/ChangeReview';
import { TaskCenter } from '../knowledge/TaskCenter';
import { KnowledgeHealth } from '../knowledge/KnowledgeHealth';

/**
 * 知识层面板 / the knowledge layer's in-chat surface.
 *
 * 定位是 **This Turn Inspector**：回答"这一轮 Agent 依据什么"。全局的记忆、变更、
 * 承诺、健康管理属于知识中心（`KnowledgeCenter`），不属于一条 360px 宽的侧栏——
 * 那里放得下的只有摘要，放不下筛选、批量和历史。
 *
 * 五个 tab 保留为兼容入口：老用户的肌肉记忆还在这里，而且看完上下文顺手处理一条
 * 候选记忆是合理的动线。但每个 tab 都提供"在知识中心打开"，侧栏不再是唯一入口。
 *
 * 每一块都读真实命令。没有一个数字是写死的，拿不到数据就说拿不到，不显示占位。
 */

type TabKey = 'context' | 'memory' | 'changes' | 'tasks' | 'health';

const TABS: { key: TabKey; label: string; labelZh: string }[] = [
  { key: 'context', label: 'This Turn', labelZh: '这一轮' },
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
  /** 跳到知识中心的对应页面。没传就不显示跳转入口。 */
  onOpenCenter?: (page: 'inbox' | 'memory' | 'changes' | 'tasks' | 'health') => void;
  /**
   * 打开某条召回内容的来源文件。没传就不显示"打开来源"。
   *
   * 只到文件级：编辑器还没有行级导航，所以 `locator` 里的行号不会被当成能跳到的
   * 位置用——按钮不承诺它做不到的事。
   */
  onOpenSource?: (locator: string) => void;
  onClose: () => void;
}

export function KnowledgePanel({
  contextPackage,
  runId,
  vaultPath,
  onOpenCenter,
  onOpenSource,
  onClose,
}: KnowledgePanelProps) {
  const isZh = getLang() === 'zh';
  const [tab, setTab] = useState<TabKey>('context');

  // 上下文是这一轮的事，只在侧栏有意义；其余四个 tab 在知识中心都有完整版。
  const centerPage = tab === 'context' ? 'inbox' : tab;

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
        {onOpenCenter && (
          <button
            className="knowledge-panel-open-center"
            onClick={() => onOpenCenter(centerPage)}
            title={isZh ? '在知识中心打开完整视图' : 'Open the full view in the Knowledge Center'}
            aria-label={isZh ? '在知识中心打开完整视图' : 'Open the full view in the Knowledge Center'}
          >
            {isZh ? '知识中心' : 'Knowledge Center'}
          </button>
        )}
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
          <ContextTab pkg={contextPackage} runId={runId} isZh={isZh} onOpenSource={onOpenSource} />
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
//
// 实现在 `components/knowledge/ContextInspector.tsx`：知识中心和侧栏用的是同一个
// 组件，避免"侧栏说召回了 3 条、中心说 5 条"这种自相矛盾。这里只负责把本轮审计
// 明细塞进它的尾部插槽——审计是"这一轮"的东西，只在聊天侧栏有意义。

function ContextTab({
  pkg,
  runId,
  isZh,
  onOpenSource,
}: {
  pkg: ContextPackageSummary | null;
  runId: string | null;
  isZh: boolean;
  onOpenSource?: (locator: string) => void;
}) {
  const [showAudit, setShowAudit] = useState(false);

  return (
    <ContextInspector pkg={pkg} onOpenSource={onOpenSource}>
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
    </ContextInspector>
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
export function MemoryTab({ isZh, vaultPath }: { isZh: boolean; vaultPath: string | null }) {
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
/**
 * 侧栏的变更页 / the sidebar's Changes tab.
 *
 * 这里曾经是第二套实现：把后端状态串（`awaiting_approval`）直接印给用户，diff 是
 * before/after 两坨原文并排。现在它就是知识中心那一份 `ChangeReview`——同一份改动在
 * 侧栏和中心看到的必须是同一个 diff、同一套状态词，否则用户会以为是两件事。
 *
 * `isZh` 不再需要：文案走 i18n 字典，不在组件里分叉。留着参数是为了不动调用点。
 */
export function ChangesTab(_props: { isZh: boolean }) {
  return <ChangeReview />;
}


// ── Task / Commitment View ──────────────────────────────────────────────────

/**
 * 承诺 / delegated to {@link TaskCenter}.
 *
 * 侧栏原来只读收件箱，看不到推迟的、做完的、日期已过的，于是"我上周答应的那件事后来
 * 怎么了"在侧栏里无法回答。现在两处是同一个任务台：同一套状态词、同一个"完成必须带
 * 证据"的规则、同一个任意时刻的推迟。
 *
 * `isZh` 不再需要：文案走 i18n 字典，不在组件里分叉。留着参数是为了不动调用点。
 */
export function TasksTab(_props: { isZh: boolean }) {
  return <TaskCenter />;
}


// ── Index Health ────────────────────────────────────────────────────────────

/**
 * 索引健康 / delegated to {@link KnowledgeHealth}.
 *
 * 旧版是一格一格的 COUNT，数字都真、但没有一个回答"现在能不能用、缺什么、怎么补"。
 * 侧栏和知识中心现在看的是同一页，包括同一句结论和同一批真实修复动作。
 *
 * `isZh` 不再需要：文案走 i18n 字典。留着参数是为了不动调用点。
 */
export function HealthTab(_props: { isZh: boolean }) {
  return <KnowledgeHealth />;
}








