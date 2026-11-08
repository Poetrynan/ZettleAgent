import React from 'react';
import { useApp, View } from '../../contexts/AppContext';
import { IconSidebar, IconChat, IconSearch } from '../icons';
import { t } from '../../lib/i18n';

interface WorkstageHeaderProps {
  view: View;
  viewTitle: string;
  currentFileName?: string | null;
  toggleSidebar: () => void;
  toggleChat: () => void;
  isSidebarOpen: boolean;
  isChatOpen: boolean;
  actions?: React.ReactNode;
}

/**
 * WorkstageHeader — the window title bar, laid out like VS Code's:
 * sidebar toggle and view name on the leading edge, a command center in
 * the middle (opens the Quick Switcher, same as Ctrl+P), and the
 * secondary-sidebar (chat) toggle on the trailing edge.
 *
 * The open note's name is not repeated here: the editor's tab bar and
 * breadcrumbs already say which note is open.
 */
export function WorkstageHeader({
  viewTitle,
  toggleSidebar,
  toggleChat,
  isSidebarOpen,
  isChatOpen,
  actions,
}: WorkstageHeaderProps) {
  const { state } = useApp();
  const isZh = state.lang === 'zh';
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

  const openCommandCenter = () => {
    window.dispatchEvent(new CustomEvent('zettel:open-quick-switcher', { detail: { mode: 'notes' } }));
  };

  return (
    <div className="swiss-header-root">
      <header className="swiss-workstage-bar mac-toolbar" aria-label={isZh ? '工具栏' : 'Toolbar'}>
        <div className="swiss-workstage-bar__left">
          <button
            type="button"
            className={`swiss-icon-btn ${isSidebarOpen ? 'active' : ''}`}
            onClick={toggleSidebar}
            title={isZh ? '切换侧边栏 (Ctrl+B)' : 'Toggle Sidebar (Ctrl+B)'}
            aria-label="Toggle Sidebar"
            aria-pressed={isSidebarOpen}
          >
            <IconSidebar size={16} />
          </button>

          <div className="mac-toolbar-title">
            <span className="mac-toolbar-title__main">{viewTitle}</span>
          </div>
        </div>

        <button
          type="button"
          className="command-center"
          onClick={openCommandCenter}
          aria-label={t('toolbar.commandCenter')}
        >
          <IconSearch size={13} />
          <span className="command-center__label">{t('toolbar.commandCenter')}</span>
          <kbd className="command-center__kbd">{isMac ? '⌘P' : 'Ctrl+P'}</kbd>
        </button>

        <div className="swiss-workstage-bar__right">
          {actions}

          {/* Agent Desk Toggle */}
          <button
            type="button"
            className={`swiss-icon-btn ${isChatOpen ? 'active' : ''}`}
            onClick={toggleChat}
            title={t('toolbar.chat')}
            aria-label={t('toolbar.chat')}
            aria-pressed={isChatOpen}
          >
            <IconChat size={16} />
          </button>
        </div>
      </header>
    </div>
  );
}
