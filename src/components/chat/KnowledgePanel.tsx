import { useState } from 'react';
import { ContextPackageSummary } from '../../lib/tauri';
import { t } from '../../lib/i18n';
import type { TranslationKey } from '../../lib/i18n';
import { ContextInspector } from '../knowledge/ContextInspector';
import { ChangeReview } from '../knowledge/ChangeReview';
import { TaskCenter } from '../knowledge/TaskCenter';
import { KnowledgeHealth } from '../knowledge/KnowledgeHealth';
import { MemoryCenter } from '../knowledge/MemoryCenter';
import { AuditTrail } from '../knowledge/AgentActivity';

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
 * 除"这一轮"以外的四个 tab 都是转发，不是第二套实现。同一条记忆在侧栏和中心必须是
 * 同一套状态词、同一套证据规则；各写一遍的结果一定是其中一处开始印后端原始码。
 */

type TabKey = 'context' | 'memory' | 'changes' | 'tasks' | 'health';

const TABS: { key: TabKey; labelKey: TranslationKey }[] = [
  { key: 'context', labelKey: 'knowledge.tab.context' },
  { key: 'memory', labelKey: 'knowledge.tab.memory' },
  { key: 'changes', labelKey: 'knowledge.tab.changes' },
  { key: 'tasks', labelKey: 'knowledge.tab.tasks' },
  { key: 'health', labelKey: 'knowledge.tab.health' },
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
              {t(item.labelKey)}
            </button>
          ))}
        </div>
        {onOpenCenter && (
          <button
            className="knowledge-panel-open-center"
            onClick={() => onOpenCenter(centerPage)}
            title={t('knowledge.panel.openCenter')}
            aria-label={t('knowledge.panel.openCenter')}
          >
            {t('knowledge.navTitle')}
          </button>
        )}
        <button
          className="knowledge-panel-close"
          onClick={onClose}
          title={t('knowledge.panel.close')}
          aria-label={t('knowledge.panel.close')}
        >
          ×
        </button>
      </div>


      <div className="knowledge-panel-body">
        {tab === 'context' && (
          <ContextTab pkg={contextPackage} runId={runId} onOpenSource={onOpenSource} />
        )}
        {tab === 'memory' && <MemoryTab vaultPath={vaultPath} onOpenSource={onOpenSource} />}
        {tab === 'changes' && <ChangesTab />}
        {tab === 'tasks' && <TasksTab />}
        {tab === 'health' && <HealthTab />}
      </div>
    </div>
  );
}


// ── Context Inspector ───────────────────────────────────────────────────────
//
// 实现在 `components/knowledge/ContextInspector.tsx`：知识中心和侧栏用的是同一个
// 组件，避免"侧栏说召回了 3 条、中心说 5 条"这种自相矛盾。这里只负责把本轮审计
// 明细塞进它的尾部插槽——审计是"这一轮"的东西，只在聊天侧栏有意义。

function ContextTab({
  pkg,
  runId,
  onOpenSource,
}: {
  pkg: ContextPackageSummary | null;
  runId: string | null;
  onOpenSource?: (locator: string) => void;
}) {
  const [showAudit, setShowAudit] = useState(false);

  return (
    <ContextInspector pkg={pkg} onOpenSource={onOpenSource}>
      {runId && (
        <div className="knowledge-audit-fold">
          <button
            className="knowledge-fold-btn"
            aria-expanded={showAudit}
            onClick={() => setShowAudit(v => !v)}
          >
            {t(showAudit ? 'knowledge.panel.hideAudit' : 'knowledge.panel.showAudit')}
          </button>
          {showAudit && <AuditTrail runId={runId} />}
        </div>
      )}
    </ContextInspector>
  );
}

// ── Memory ──────────────────────────────────────────────────────────────────

/**
 * 记忆 / delegated to {@link MemoryCenter}.
 *
 * 侧栏原来是第二套收件箱：只看得到候选，把 `kind` / `scope` 和 `0.82` 这样的置信度
 * 直接印给用户，而"确认过的那条后来被谁改了"在这里无法回答。现在两处是同一个记忆
 * 中心——同一套生命周期词、同一份来源证据、同一个"确认是唯一写 confirmed_by 的路径"。
 */
export function MemoryTab({
  vaultPath,
  onOpenSource,
}: {
  vaultPath: string | null;
  onOpenSource?: (locator: string) => void;
}) {
  return <MemoryCenter vaultPath={vaultPath} onOpenSource={onOpenSource} />;
}


// ── Change Preview ──────────────────────────────────────────────────────────



/**
 * 侧栏的变更页 / the sidebar's Changes tab.
 *
 * 这里曾经是第二套实现：把后端状态串（`awaiting_approval`）直接印给用户，diff 是
 * before/after 两坨原文并排。现在它就是知识中心那一份 `ChangeReview`——同一份改动在
 * 侧栏和中心看到的必须是同一个 diff、同一套状态词，否则用户会以为是两件事。
 */
export function ChangesTab() {
  return <ChangeReview />;
}



// ── Task / Commitment View ──────────────────────────────────────────────────

/**
 * 承诺 / delegated to {@link TaskCenter}.
 *
 * 侧栏原来只读收件箱，看不到推迟的、做完的、日期已过的，于是"我上周答应的那件事后来
 * 怎么了"在侧栏里无法回答。现在两处是同一个任务台：同一套状态词、同一个"完成必须带
 * 证据"的规则、同一个任意时刻的推迟。
 */
export function TasksTab() {
  return <TaskCenter />;
}



// ── Index Health ────────────────────────────────────────────────────────────

/**
 * 索引健康 / delegated to {@link KnowledgeHealth}.
 *
 * 旧版是一格一格的 COUNT，数字都真、但没有一个回答"现在能不能用、缺什么、怎么补"。
 * 侧栏和知识中心现在看的是同一页，包括同一句结论和同一批真实修复动作。
 */
export function HealthTab() {
  return <KnowledgeHealth />;
}









