import type { ChatSession } from '../../lib/tauri';
import { t } from '../../lib/i18n';
import { IconRobot, IconSearch } from '../icons';

interface SessionListPanelProps {
  sessions: ChatSession[];
  sessionId: string;
  editingSessionId: string | null;
  editTitle: string;
  /** Session currently receiving a streaming AI reply — its delete button is locked */
  lockedSessionId?: string | null;
  onLoadSession: (sid: string) => void;
  onNewSession: () => void;
  onDelete: (sid: string) => void;
  onStartRename: (sid: string, currentTitle: string) => void;
  onRename: (sid: string) => void;
  onExport: (sid: string) => void;
  onEditTitleChange: (val: string) => void;
}

export function SessionListPanel({
  sessions, sessionId, editingSessionId, editTitle, lockedSessionId,
  onLoadSession, onNewSession, onDelete,
  onStartRename, onRename, onExport, onEditTitleChange,
}: SessionListPanelProps) {
  return (
    <div className="session-list-panel-v2">
      <div className="session-list-header-v2">
        <span className="session-list-header-label">
          {t('chat.sessionCount' as any).replace('{n}', String(sessions.length))}
        </span>
        <button className="session-list-new-btn" onClick={onNewSession}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          {t('chat.newChat' as any)}
        </button>
      </div>
      {sessions.length === 0 ? (
        <div className="session-list-empty-v2">{t('chat.noSessions' as any)}</div>
      ) : (
        <div className="session-list-items">
          {sessions.map(s => (
            <div
              key={s.id}
              className={`session-item-v2 ${s.id === sessionId ? 'active' : ''}`}
              onClick={() => onLoadSession(s.id)}
            >
              <span className={`session-item-v2-icon ${s.mode === 'agent' ? 'mode-agent' : 'mode-rag'}`}>
                {s.mode === 'agent' ? <IconRobot size={12} /> : <IconSearch size={12} />}
              </span>
              {editingSessionId === s.id ? (
                <input
                  className="session-rename-input-v2"
                  value={editTitle}
                  onChange={e => onEditTitleChange(e.target.value)}
                  onBlur={() => onRename(s.id)}
                  onKeyDown={e => e.key === 'Enter' && onRename(s.id)}
                  autoFocus
                  onClick={e => e.stopPropagation()}
                />
              ) : (
                <span className="session-item-v2-title">{s.title || t('chat.noTitle' as any)}</span>
              )}
              <span className="session-item-v2-count">{s.messageCount || 0}</span>
              <div className="session-item-v2-actions" onClick={e => e.stopPropagation()}>
                <button className="session-item-v2-action" onClick={() => onStartRename(s.id, s.title)} title={t('chat.renameSession' as any)}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                <button className="session-item-v2-action" onClick={() => onExport(s.id)} title={t('chat.exportSession' as any)}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                </button>
                <button
                  className="session-item-v2-action session-item-v2-delete"
                  onClick={() => onDelete(s.id)}
                  disabled={s.id === lockedSessionId}
                  title={s.id === lockedSessionId ? t('chat.cannotDeleteWhileStreaming' as any) : t('chat.deleteSession' as any)}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
