import { useState } from 'react';
import { t } from '../../lib/i18n';
import type { TranslationKey } from '../../lib/i18n';
import { useApp } from '../../contexts/AppContext';
import { KnowledgeInbox } from './KnowledgeInbox';
import { AgentActivity } from './AgentActivity';
import { ChangesTab, HealthTab, MemoryTab, TasksTab } from '../chat/KnowledgePanel';
import { KcCount } from './states';
import { useInboxCounts } from './useInboxCounts';
import '../../styles/knowledge-center.css';

/**
 * 知识中心 / the Agent's own working surface.
 *
 * 存在的理由：Agent 持续产出记忆、变更、承诺和索引状态，而这些东西的寿命比一次对话
 * 长得多。只把它们放在 Chat 侧栏，等于要求用户"记得回到那次对话"才能处理自己的待办。
 *
 * 这不是开发者后台。每一页回答的都是一个用户问题：
 *
 * - 收件箱：现在有什么需要我处理？
 * - 记忆：Agent 记住了什么？
 * - 变更：Agent 想改什么？
 * - 任务：还有什么没结的事？
 * - 健康：Agent 现在能可靠地用我的知识库吗？
 * - 活动：Agent 最近做了什么？
 *
 * 记忆/变更/任务/健康四页直接复用 Chat 侧栏那四块的真实实现（`KnowledgePanel` 导出），
 * 不复制一份。后续批次会把它们逐个升级成完整页面，那时两处一起变。
 */

export type KnowledgePage = 'inbox' | 'memory' | 'changes' | 'tasks' | 'health' | 'activity';

const PAGES: { key: KnowledgePage; labelKey: TranslationKey; hintKey: TranslationKey }[] = [
  { key: 'inbox', labelKey: 'knowledge.tab.inbox', hintKey: 'knowledge.tabHint.inbox' },
  { key: 'memory', labelKey: 'knowledge.tab.memory', hintKey: 'knowledge.tabHint.memory' },
  { key: 'changes', labelKey: 'knowledge.tab.changes', hintKey: 'knowledge.tabHint.changes' },
  { key: 'tasks', labelKey: 'knowledge.tab.tasks', hintKey: 'knowledge.tabHint.tasks' },
  { key: 'health', labelKey: 'knowledge.tab.health', hintKey: 'knowledge.tabHint.health' },
  { key: 'activity', labelKey: 'knowledge.tab.activity', hintKey: 'knowledge.tabHint.activity' },
];

/**
 * 收件箱计数 / the pending counts.
 *
 * 实现在 `useInboxCounts.ts`，这里只是再导出：顶栏角标和本页 tab 角标必须是同一个
 * 数字，所以它们共用同一个 hook。
 */
export { useInboxCounts } from './useInboxCounts';

export function KnowledgeCenter() {
  const { state, toggleChat } = useApp();
  const [page, setPage] = useState<KnowledgePage>('inbox');
  const { counts, refresh } = useInboxCounts();
  const isZh = state.lang === 'zh';
  const vaultPath = state.vaultPath ?? null;
  const current = PAGES.find(p => p.key === page) ?? PAGES[0];

  const badge = (key: KnowledgePage): number => {
    if (!counts) return 0;
    switch (key) {
      case 'inbox':
        return counts.total;
      case 'memory':
        return counts.memory;
      case 'changes':
        return counts.changes;
      case 'tasks':
        return counts.tasks;
      case 'health':
        return counts.health;
      default:
        return 0;
    }
  };

  return (
    <div className="kc-root">
      <nav className="kc-nav" aria-label={t('knowledge.navTitle')}>
        {PAGES.map(item => (
          <button
            key={item.key}
            className={`kc-nav-item ${page === item.key ? 'active' : ''}`}
            aria-current={page === item.key ? 'page' : undefined}
            title={t(item.hintKey)}
            onClick={() => setPage(item.key)}
          >
            <span className="kc-nav-label">{t(item.labelKey)}</span>
            <KcCount count={badge(item.key)} />
          </button>
        ))}
      </nav>

      <section className="kc-page">
        <header className="kc-page-head">
          <h2 className="kc-page-title">{t(current.labelKey)}</h2>
          <p className="kc-page-hint">{t(current.hintKey)}</p>
        </header>

        <div className="kc-page-body">
          {page === 'inbox' && (
            <KnowledgeInbox
              vaultPath={vaultPath}
              onOpenPage={setPage}
              onChanged={refresh}
              onOpenChat={state.isChatOpen ? undefined : toggleChat}
            />
          )}
          {/* 这四块是 Chat 侧栏那四块的同一份实现，不是复制品。 */}
          {page === 'memory' && <MemoryTab isZh={isZh} vaultPath={vaultPath} />}
          {page === 'changes' && <ChangesTab isZh={isZh} />}
          {page === 'tasks' && <TasksTab isZh={isZh} />}
          {page === 'health' && <HealthTab isZh={isZh} />}
          {page === 'activity' && <AgentActivity />}
        </div>
      </section>
    </div>
  );
}
