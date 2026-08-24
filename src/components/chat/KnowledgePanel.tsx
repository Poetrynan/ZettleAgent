import { useState } from 'react';
import { ContextPackageSummary } from '../../lib/tauri';
import { t } from '../../lib/i18n';
import { ContextInspector } from '../knowledge/ContextInspector';
import { AuditTrail } from '../knowledge/AgentActivity';

/**
 * 这一轮 / the agent's in-chat activity panel.
 *
 * 定位是 **This Turn Inspector**，而且只是这个：回答"这一轮 Agent 依据什么、调了什么"。
 *
 * 这里曾经有五个 tab（这一轮 / 记忆 / 变更 / 任务 / 健康），后四个是转发到知识中心的
 * 同名组件。转发本身没错，错的是位置：
 *
 * 1. 会话和活动流是两件事。对话线程是你下指令的地方，活动面板是你看 Agent 干了什么的
 *    地方；把长期状态管理也塞进来，这块面板就同时做不好三件事。
 * 2. 记忆 / 变更 / 任务 / 健康 是 vault 的**长期状态**，不属于"这一轮"。它们需要筛选、
 *    批量、历史，而这是一条 360px 宽、46vh 高的侧栏——放得下摘要，放不下工作台。
 * 3. 更要命的是，侧栏那四份是**降级版**：`ChangeReview` / `TaskCenter` /
 *    `KnowledgeHealth` 在这里一个 prop 都没拿到，所以"打开来源""去设置""刷新角标"
 *    在侧栏里静默失效。同一个组件，少一半能力，用户不会知道差别在哪。
 *
 * 所以长期状态全部回到知识中心（Activity Rail 上的「知识中心」），这块面板只留这一轮，
 * 并保留一个去知识中心的入口。
 */

interface KnowledgePanelProps {
  /** 本轮编译出来的上下文，来自 `context_package_ready`。 */
  contextPackage: ContextPackageSummary | null;
  /** 本轮的 run id，用于拉这一轮的审计明细。 */
  runId: string | null;
  /** 跳到知识中心。没传就不显示跳转入口。 */
  onOpenCenter?: () => void;
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
  onOpenCenter,
  onOpenSource,
  onClose,
}: KnowledgePanelProps) {
  return (
    <div className="knowledge-panel">
      <div className="knowledge-panel-header">
        <h2 className="knowledge-panel-title">{t('knowledge.tab.context')}</h2>
        {onOpenCenter && (
          <button
            className="knowledge-panel-open-center"
            onClick={onOpenCenter}
            title={t('knowledge.panel.openCenter')}
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
        <ContextTab pkg={contextPackage} runId={runId} onOpenSource={onOpenSource} />
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










