import { t } from '../../lib/i18n';

interface NoteSelectorModalProps {
  isAddNoteOpen: boolean;
  setIsAddNoteOpen: (open: boolean) => void;
  noteSearch: string;
  setNoteSearch: (val: string) => void;
  filteredNotes: string[];
  handleAddNoteNode: (note: string) => void;
  state: any;
}

export function NoteSelectorModal({
  isAddNoteOpen,
  setIsAddNoteOpen,
  noteSearch,
  setNoteSearch,
  filteredNotes,
  handleAddNoteNode,
  state,
}: NoteSelectorModalProps) {
  if (!isAddNoteOpen) return null;

  return (
    <div className="modal-overlay" style={{ zIndex: 100 }} onClick={() => setIsAddNoteOpen(false)}>
      <div className="modal-container canvas-note-selector" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">{t('canvas.selectNote')}</h3>
          <button className="modal-close-btn" onClick={() => setIsAddNoteOpen(false)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div className="modal-content canvas-note-selector-body">
          <input
            type="text"
            className="input"
            placeholder={t('canvas.searchNotes')}
            value={noteSearch}
            onChange={(e) => setNoteSearch(e.target.value)}
            autoFocus
          />
          <div className="canvas-note-list">
            {filteredNotes.length === 0 ? (
              <div className="canvas-note-empty">{t('canvas.noNotes')}</div>
            ) : (
              filteredNotes.map((note) => {
                const fileName = note.replace(/\\/g, '/').split('/').pop() || note;
                const ext = fileName.split('.').pop()?.toLowerCase() || '';
                const name = ext === 'md' ? fileName.replace(/\.md$/, '') : fileName;
                const normalizedNote = note.replace(/\\/g, '/');
                let displayPath = note;
                let folderName = '';
                if (state.vaultPaths && state.vaultPaths.length > 0) {
                  for (const vp of state.vaultPaths) {
                    const normalizedVp = vp.replace(/\\/g, '/');
                    if (normalizedNote.startsWith(normalizedVp)) {
                      displayPath = normalizedNote.slice(normalizedVp.length + 1);
                      folderName = normalizedVp.split('/').pop() || '';
                      break;
                    }
                  }
                }
                const extColors: Record<string, string> = {
                  pdf: '#ef4444', docx: '#2563eb', csv: '#16a34a',
                  html: '#f97316', htm: '#f97316',
                  png: '#8b5cf6', jpg: '#8b5cf6', jpeg: '#8b5cf6',
                  gif: '#8b5cf6', webp: '#8b5cf6', svg: '#8b5cf6',
                };
                const badgeColor = extColors[ext] || 'var(--text-muted)';
                return (
                  <button
                    key={note}
                    className="canvas-note-item"
                    onClick={() => handleAddNoteNode(note)}
                  >
                    <div className="canvas-note-item-name" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      {name}
                      {ext !== 'md' && (
                        <span style={{
                          background: badgeColor,
                          color: '#fff',
                          padding: '1px 5px',
                          borderRadius: 'var(--radius-full)',
                          fontSize: '9px',
                          fontWeight: 600,
                          textTransform: 'uppercase',
                          letterSpacing: '0.5px',
                          flexShrink: 0,
                        }}>{ext}</span>
                      )}
                    </div>
                    <div className="canvas-note-item-path">
                      {state.vaultPaths && state.vaultPaths.length > 1 && folderName && (
                        <span style={{
                          background: 'var(--bg-tertiary)',
                          padding: '1px 6px',
                          borderRadius: 'var(--radius-full)',
                          fontSize: '10px',
                          marginRight: '4px',
                          fontWeight: 500,
                          color: 'var(--text-secondary)',
                        }}>{folderName}</span>
                      )}
                      {(() => {
                        const parts = displayPath.replace(/\\/g, '/').split('/');
                        parts.pop();
                        return parts.length > 0 ? parts.join('/') + '/' : (folderName ? folderName + '/' : '/');
                      })()}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
