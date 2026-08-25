import { useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import { t } from '../../lib/i18n';
import type { TranslationKey } from '../../lib/i18n';
import { useApp } from '../../contexts/AppContext';
import { KnowledgeInbox } from './KnowledgeInbox';
import { AgentActivity } from './AgentActivity';
import { MemoryCenter } from './MemoryCenter';
import { ChangeReview } from './ChangeReview';
import { TaskCenter } from './TaskCenter';
import { KnowledgeHealth } from './KnowledgeHealth';
import { KnowledgeGapAnalysis } from '../dashboard/KnowledgeGapAnalysis';
import { KcCount } from './states';
import { useInboxCounts } from './useInboxCounts';
import {
  IconBrain,
  IconChart,
  IconCheck,
  IconClipboard,
  IconMerge,
  IconTimeline,
} from '../icons';
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
 * - 图谱计划：图谱存在哪些盲区，Agent 提议了哪些结构性链接与重构？
 * - 活动：Agent 最近做了什么？
 *
 * 记忆/变更/任务/健康四页直接复用 Chat 侧栏那四块的真实实现（`KnowledgePanel` 导出），
 * 不复制一份。后续批次会把它们逐个升级成完整页面，那时两处一起变。
 */

export type KnowledgePage = 'inbox' | 'memory' | 'changes' | 'tasks' | 'health' | 'activity' | 'gap_analysis';

/**
 * 页面配对应图标与多语言词条。全部取自 `components/icons.tsx`，不新画。
 */
const PAGES: {
  key: KnowledgePage;
  labelKey: TranslationKey;
  hintKey: TranslationKey;
  Icon: ComponentType<{ size?: number }>;
}[] = [
  { key: 'inbox', labelKey: 'knowledge.tab.inbox', hintKey: 'knowledge.tabHint.inbox', Icon: IconClipboard },
  { key: 'memory', labelKey: 'knowledge.tab.memory', hintKey: 'knowledge.tabHint.memory', Icon: IconBrain },
  { key: 'changes', labelKey: 'knowledge.tab.changes', hintKey: 'knowledge.tabHint.changes', Icon: IconMerge },
  { key: 'tasks', labelKey: 'knowledge.tab.tasks', hintKey: 'knowledge.tabHint.tasks', Icon: IconCheck },
  { key: 'health', labelKey: 'knowledge.tab.health', hintKey: 'knowledge.tabHint.health', Icon: IconChart },
  { key: 'gap_analysis', labelKey: 'knowledge.tab.gap_analysis', hintKey: 'knowledge.tabHint.gap_analysis', Icon: IconBrain },
  { key: 'activity', labelKey: 'knowledge.tab.activity', hintKey: 'knowledge.tabHint.activity', Icon: IconTimeline },
];

/**
 * 收件箱计数 / the pending counts.
 *
 * 实现在 `useInboxCounts.ts`，这里只是再导出：顶栏角标和本页 tab 角标必须是同一个
 * 数字，所以它们共用同一个 hook。
 */
export { useInboxCounts } from './useInboxCounts';

export function KnowledgeCenter() {
  const { state, toggleChat, setCurrentFile, setView, consumePendingDeepLink } = useApp();
  const [page, setPage] = useState<KnowledgePage>('inbox');
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const { counts, refresh } = useInboxCounts();
  const vaultPath = state.vaultPath ?? null;
  const current = PAGES.find(p => p.key === page) ?? PAGES[0];

  // 1. 消费全局 pendingDeepLink（彻底消除首次从 Chat / QuickSwitcher 跳转的时序丢失）
  useEffect(() => {
    if (state.pendingDeepLink && state.pendingDeepLink.target === 'knowledge') {
      const link = consumePendingDeepLink('knowledge');
      if (link?.tab) {
        if (link.tab === 'gap_analysis' || PAGES.some(p => p.key === link.tab)) {
          setPage(link.tab as KnowledgePage);
        }
      }
      if (link?.planId) {
        setActivePlanId(link.planId);
      }
    }
  }, [state.pendingDeepLink, consumePendingDeepLink]);

  // 2. 监听已打开状态下的 hot DOM events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ tab?: string; planId?: string } | KnowledgePage>).detail;
      if (typeof detail === 'string') {
        if (detail === 'gap_analysis' || PAGES.some(p => p.key === detail)) {
          setPage(detail as KnowledgePage);
        }
      } else if (detail && typeof detail === 'object') {
        if (detail.tab === 'gap_analysis' || (detail.tab && PAGES.some(p => p.key === detail.tab))) {
          setPage(detail.tab as KnowledgePage);
        }
        if (detail.planId) {
          setActivePlanId(detail.planId);
        }
      }
    };
    window.addEventListener('open-knowledge-center', handler);
    window.addEventListener('zettel:knowledge-page', handler);
    return () => {
      window.removeEventListener('open-knowledge-center', handler);
      window.removeEventListener('zettel:knowledge-page', handler);
    };
  }, []);


  /**
   * 打开被改动的那个文件 / jump to the file a change touched.
   *
   * 只到文件一级。编辑器现在没有"跳到某一行"的入口，硬做一个会得到一个假的定位——
   * 打开正确的文件、停在顶部，比声称跳到了某处更诚实。
   */
  const openFile = (path: string) => {
    setCurrentFile(path);
    setView('note');
  };


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
        <div className="kc-nav-title">{t('knowledge.navTitle')}</div>
        {PAGES.map(item => (
          <button
            key={item.key}
            className={`kc-nav-item ${page === item.key ? 'active' : ''}`}
            aria-current={page === item.key ? 'page' : undefined}
            title={t(item.hintKey)}
            onClick={() => setPage(item.key)}
          >
            <item.Icon size={15} />
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
          {/* 记忆与变更都有了完整页面（变更：一个 diff 渲染器、一套状态词、一条时间线、
              可用时才出现的撤销）；任务/健康这两块仍是 Chat 侧栏那同一份实现，不是复制
              品，后续批次会一起升级。 */}
          {page === 'memory' && (
            <MemoryCenter vaultPath={vaultPath} onChanged={refresh} />
          )}
          {page === 'changes' && <ChangeReview onOpenSource={openFile} />}
          {page === 'tasks' && <TaskCenter onOpenSource={openFile} onChanged={refresh} />}
          {page === 'health' && (
            <KnowledgeHealth
              vaultPath={vaultPath}
              onOpenPage={setPage}
              onOpenFile={openFile}
              onOpenSettings={() => setView('settings')}
            />
          )}
          {page === 'gap_analysis' && (
            <KnowledgeGapAnalysis initialPlanId={activePlanId} />
          )}
          {page === 'activity' && <AgentActivity onOpenFile={openFile} />}
        </div>
      </section>
    </div>
  );
}
