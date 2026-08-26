import { SearchMode } from '../../lib/tauri';
import { IconRobot, IconSearch, IconClose, IconInspect } from '../icons';
import { t, getLang } from '../../lib/i18n';
import { StatusStamp } from '../primitives/StatusStamp';

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
  onNewSession?: () => void;
  sessionTitle?: string;
  hasPendingApproval?: boolean;
}

const SEARCH_MODES: { key: SearchMode; label: string; labelZh: string }[] = [
  { key: 'hybrid', label: 'Hybrid', labelZh: '混合' },
  { key: 'vector', label: 'Vector', labelZh: '向量' },
  { key: 'fts', label: 'FTS', labelZh: '全文' },
];

/**
 * ChatHeader — Desk command header adhering to Swiss Knowledge Atlas principles.
 * Houses mode segment switches, quick new-chat action, session navigator, inspection, and status badges.
 */
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
  onNewSession,
  sessionTitle,
  hasPendingApproval,
}: ChatHeaderProps) {
  const isZh = getLang() === 'zh';

  return (
    <header className="chat-header-v2" aria-label="Agent Desk Header">
      <div className="chat-header-row-main">
        {/* Left: Brand Desk Title & Session Title */}
        <div className="chat-header-brand-title">
          <span className="chat-header-brand-icon">
            <IconRobot size={14} />
          </span>
          <span className="chat-header-desk-name">
            {isZh ? '智能助手' : 'Agent Desk'}
          </span>
          {sessionTitle && (
            <>
              <span className="chat-header-title-sep">/</span>
              <span className="chat-header-session-title" title={sessionTitle}>
                {sessionTitle}
              </span>
            </>
          )}
        </div>

        {/* Center: Pending approval badge if any */}
        <div className="chat-header-status-slot">
          {hasPendingApproval && (
            <StatusStamp variant="pending" size="xs">
              {isZh ? '待决审批' : 'DECISION'}
            </StatusStamp>
          )}
        </div>

        {/* Right: Quick actions */}
        <div className="chat-header-actions">
          {onNewSession && (
            <button
              className="chat-header-icon-btn chat-header-new-btn"
              onClick={onNewSession}
              title={isZh ? '新建会话 (Ctrl+N)' : 'New Chat Session'}
              aria-label="New Chat"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          )}
          <button
            className={`chat-header-icon-btn ${showKnowledgePanel ? 'active' : ''}`}
            onClick={() => {
              const next = !showKnowledgePanel;
              setShowKnowledgePanel(next);
              if (next) setShowSessionList(false);
            }}
            title={isZh ? '本轮上下文分析 · Context Inspector' : 'This turn: context inspector'}
            aria-label="Toggle Context Inspector"
          >
            <IconInspect size={14} />
          </button>
          <button
            className={`chat-header-icon-btn ${showSessionList ? 'active' : ''}`}
            onClick={() => {
              const next = !showSessionList;
              setShowSessionList(next);
              if (next) setShowKnowledgePanel(false);
            }}
            title={t('chat.sessionHistory' as any)}
            aria-label="Session History"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
            aria-label="Close Chat"
          >
            <IconClose size={15} />
          </button>
        </div>
      </div>
    </header>
  );
}
