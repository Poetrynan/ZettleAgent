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

const VIEW_CODES: Record<View, string> = {
  dashboard: '01 DASH',
  note: '02 NOTE',
  graph: '03 ATLAS',
  canvas: '04 CANVAS',
  bases: '05 BASES',
  calendar: '06 CAL',
  review: '07 REVIEW',
  knowledge: '08 KC',
  settings: '09 SETTINGS',
};

/**
 * WorkstageHeader — Pure Swiss Editorial Top Header.
 * Displays system meta strip on top, and Document Desk title with [⌘K] and SAVED LOCALLY stamps.
 * No duplicate workspace tabs — workspace switching lives definitively in the left WORKSPACES panel.
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
  const modeCode = VIEW_CODES[view] || '00 WORK';

  return (
    <div className="swiss-header-root">
      {/* Main Document Desk Bar */}
      <header className="swiss-workstage-bar" aria-label="Document Desk Header">
        <div className="swiss-workstage-bar__left">
          <button
            type="button"
            className={`swiss-icon-btn ${isSidebarOpen ? 'active' : ''}`}
            onClick={toggleSidebar}
            title={isZh ? '切换侧边栏 (Ctrl+B)' : 'Toggle Sidebar (Ctrl+B)'}
            aria-label="Toggle Sidebar"
          >
            <IconSidebar size={15} />
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
              {viewTitle}
            </span>
            {docContext && view === 'note' && (
              <>
                <span style={{ color: 'var(--border)', fontSize: '12px' }}>/</span>
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                  {docContext}
                </span>
              </>
            )}
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
          >
            <IconChat size={15} />
          </button>
        </div>
      </header>
    </div>
  );
}
