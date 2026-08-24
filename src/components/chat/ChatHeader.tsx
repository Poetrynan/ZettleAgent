import { SearchMode } from '../../lib/tauri';
import { IconRobot, IconSearch, IconClose, IconInspect } from '../icons';
import { t, getLang } from '../../lib/i18n';

/**
 * Chat header / the agent panel's command strip.
 *
 * 这块头部原来是两行：第一行模式 tab + 动作图标，第二行在 RAG 模式下放检索方式，在
 * Agent 模式下放一句常驻说明「Agent 可自主调用工具、读写笔记」。那句话是引导文案，
 * 不是状态——第一次有用，第二次开始就是在一条 400px 宽的面板里长期占掉一整行。
 * 现在第二行只在真的有可调项（RAG 检索方式）时才出现。
 *
 * 模式指示器原来是一个 JS 驱动的滑动药丸：ResizeObserver + 双 rAF 量 offsetLeft/
 * offsetWidth，420ms 贝塞尔滑动加挤压。一个两档开关不值这些机器，而且它每次切换都要
 * 读一次布局。现在是纯 CSS 的选中态。
 */

interface ChatHeaderProps {
  mode: 'agent' | 'rag';
  setMode: (mode: 'agent' | 'rag') => void;
  searchMode: SearchMode;
  setSearchMode: (searchMode: SearchMode) => void;
  isLoading: boolean;
  showSessionList: boolean;
  setShowSessionList: (show: boolean | ((p: boolean) => boolean)) => void;
  /** 这一轮：Agent 用了什么、调了什么。长期状态在知识中心。 */
  showKnowledgePanel: boolean;
  setShowKnowledgePanel: (show: boolean | ((p: boolean) => boolean)) => void;
  toggleChat: () => void;
}

const SEARCH_MODES: { key: SearchMode; label: string; labelZh: string }[] = [
  { key: 'hybrid', label: 'Hybrid', labelZh: '混合' },
  { key: 'vector', label: 'Vector', labelZh: '向量' },
  { key: 'fts', label: 'FTS', labelZh: '全文' },
];

export function ChatHeader({
  mode,
  setMode,
  searchMode,
  setSearchMode,
  isLoading,
  showSessionList,
  setShowSessionList,
  showKnowledgePanel,
  setShowKnowledgePanel,
  toggleChat,
}: ChatHeaderProps) {
  const isZh = getLang() === 'zh';

  return (
    <div className="chat-header-v2">
      <div className="chat-header-row-main">
        <div className="chat-mode-tabs" role="tablist" aria-label={isZh ? '对话模式' : 'Chat mode'}>
          <button
            role="tab"
            aria-selected={mode === 'agent'}
            className={`chat-mode-tab ${mode === 'agent' ? 'active' : ''} ${isLoading && mode !== 'agent' ? 'locked' : ''}`}
            onClick={() => !isLoading && setMode('agent')}
            disabled={isLoading && mode !== 'agent'}
            title={isLoading && mode !== 'agent' ? t('chat.modeLockedTip' as any) : t('chat.agentModeTip' as any)}
          >
            <IconRobot size={13} />
            <span className="chat-mode-tab-label">{t('chat.agentMode' as any)}</span>
          </button>
          <button
            role="tab"
            aria-selected={mode === 'rag'}
            className={`chat-mode-tab ${mode === 'rag' ? 'active' : ''} ${isLoading && mode !== 'rag' ? 'locked' : ''}`}
            onClick={() => !isLoading && setMode('rag')}
            disabled={isLoading && mode !== 'rag'}
            title={isLoading && mode !== 'rag' ? t('chat.modeLockedTip' as any) : t('chat.ragModeTip' as any)}
          >
            <IconSearch size={13} />
            <span className="chat-mode-tab-label">{t('chat.ragMode' as any)}</span>
          </button>
        </div>

        <div className="chat-header-actions">
          <button
            className={`chat-header-icon-btn ${showKnowledgePanel ? 'active' : ''}`}
            onClick={() => setShowKnowledgePanel(p => !p)}
            title={isZh ? '这一轮：Agent 用了什么、调了什么' : 'This turn: what the agent used and did'}
          >
            <IconInspect size={15} />
          </button>
          <button
            className={`chat-header-icon-btn ${showSessionList ? 'active' : ''}`}
            onClick={() => setShowSessionList(p => !p)}
            title={t('chat.sessionHistory' as any)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="8" y1="6" x2="21" y2="6"/>
              <line x1="8" y1="12" x2="21" y2="12"/>
              <line x1="8" y1="18" x2="21" y2="18"/>
              <line x1="3" y1="6" x2="3.01" y2="6"/>
              <line x1="3" y1="12" x2="3.01" y2="12"/>
              <line x1="3" y1="18" x2="3.01" y2="18"/>
            </svg>
          </button>
          <button
            className="chat-header-icon-btn"
            onClick={toggleChat}
            title={t('common.close' as any) || 'Close'}
          >
            <IconClose size={16} />
          </button>
        </div>
      </div>

      {/* Only rendered when there is something to set. Agent mode has no
          retrieval knob, so it gets no second row at all. */}
      {mode === 'rag' && (
        <div className="chat-header-row-sub">
          <div className="chat-search-modes">
            <span className="chat-search-modes-label">
              {isZh ? '检索' : 'Search'}
            </span>
            <div className="chat-search-modes-group" role="tablist" aria-label={isZh ? '检索方式' : 'Retrieval mode'}>
              {SEARCH_MODES.map(m => (
                <button
                  key={m.key}
                  role="tab"
                  aria-selected={searchMode === m.key}
                  className={`chat-search-mode-chip ${searchMode === m.key ? 'active' : ''}`}
                  onClick={() => setSearchMode(m.key)}
                  title={t(`search.${m.key}Desc` as any)}
                >
                  {isZh ? m.labelZh : m.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
