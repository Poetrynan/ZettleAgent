import React from 'react';
import { useApp, View } from '../../contexts/AppContext';
import { IconSidebar, IconChat } from '../icons';
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
 * WorkstageHeader — the unified title bar / toolbar of the main window.
 *
 * macOS layout: sidebar toggle on the leading edge, a bold window title with
 * the open document as a quiet subtitle, and toolbar items on the trailing
 * edge. The bar sits on a translucent toolbar material so content scrolling
 * beneath it stays faintly visible.
 */
export function WorkstageHeader({
  view,
  viewTitle,
  currentFileName,
  toggleSidebar,
  toggleChat,
  isSidebarOpen,
  isChatOpen,
  actions,
}: WorkstageHeaderProps) {
  const { state } = useApp();
  const isZh = state.lang === 'zh';

  const docContext = currentFileName || (state.currentFile ? state.currentFile.split(/[\\/]/).pop() : null);
  const showDoc = Boolean(docContext && view === 'note');

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
            <span className="mac-toolbar-title__main">{showDoc ? docContext : viewTitle}</span>
            {showDoc && <span className="mac-toolbar-title__sub">{viewTitle}</span>}
          </div>
        </div>

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
