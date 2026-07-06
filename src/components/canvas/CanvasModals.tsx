/**
 * CanvasModals — 画布弹窗（模板选择 + 添加笔记）
 */
import { t } from '../../lib/i18n';
import { CANVAS_TEMPLATES, BLANK_THUMBNAIL } from './canvasTemplates';

interface CanvasModalsProps {
  // 模板选择
  isTemplateOpen: boolean;
  setIsTemplateOpen: (v: boolean) => void;
  applyTemplate: (id: string | null) => void;
  // 添加笔记
  isAddNoteOpen: boolean;
  setIsAddNoteOpen: (v: boolean) => void;
  noteSearch: string;
  setNoteSearch: (v: string) => void;
  filteredNotes: string[];
  handleAddNoteNode: (path: string) => void;
  lang: string;
  vaultPaths: string[];
}

export function CanvasModals({
  isTemplateOpen, setIsTemplateOpen, applyTemplate,
  isAddNoteOpen, setIsAddNoteOpen, noteSearch, setNoteSearch,
  filteredNotes, handleAddNoteNode, lang, vaultPaths,
}: CanvasModalsProps) {
  const isZh = lang === 'zh';

  return (
    <>
      {/* 模板选择 */}
      {isTemplateOpen && (
        <div className="modal-overlay" style={{ zIndex: 100 }} onClick={() => setIsTemplateOpen(false)}>
          <div className="modal-container" style={{ maxWidth: 680 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h3 className="modal-title">{t('canvas.templateTitle')}</h3>
                <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted, #6b7280)' }}>{t('canvas.templateDesc')}</p>
              </div>
              <button className="modal-close-btn" onClick={() => setIsTemplateOpen(false)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
            <div className="modal-content" style={{ padding: 16 }}>
              <div className="canvas-template-grid">
                <button className="canvas-template-card" onClick={() => applyTemplate(null)} title={t('canvas.templateBlank')}>
                  <div className="canvas-template-thumb" dangerouslySetInnerHTML={{ __html: BLANK_THUMBNAIL }} />
                  <div className="canvas-template-title"><span>⬜</span>{t('canvas.templateBlank')}</div>
                  <div className="canvas-template-desc">{t('canvas.templateBlankDesc')}</div>
                </button>
                {CANVAS_TEMPLATES.map(tpl => {
                  const capName = tpl.id.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
                  return (
                    <button key={tpl.id} className="canvas-template-card" onClick={() => applyTemplate(tpl.id)} title={t(`canvas.template${capName}` as any)}>
                      <div className="canvas-template-thumb" dangerouslySetInnerHTML={{ __html: tpl.thumbnail }} />
                      <div className="canvas-template-title"><span>{tpl.icon}</span>{t(`canvas.template${capName}` as any)}</div>
                      <div className="canvas-template-desc">{t(`canvas.template${capName}Desc` as any)}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 添加笔记 */}
      {isAddNoteOpen && (
        <div className="modal-overlay" style={{ zIndex: 100 }} onClick={() => setIsAddNoteOpen(false)}>
          <div className="modal-container canvas-note-selector" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">{isZh ? '选择要添加的文件' : 'Select File to Add'}</h3>
              <button className="modal-close-btn" onClick={() => setIsAddNoteOpen(false)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
            <div className="modal-content canvas-note-selector-body">
              <input type="text" className="input" placeholder={isZh ? '搜索文件...' : 'Search files...'} value={noteSearch} onChange={e => setNoteSearch(e.target.value)} autoFocus />
              <div className="canvas-note-list">
                {filteredNotes.length === 0 ? (
                  <div className="canvas-note-empty">{t('canvas.noNotes')}</div>
                ) : (
                  filteredNotes.map(note => {
                    const fileName = note.replace(/\\/g, '/').split('/').pop() || note;
                    const ext = fileName.split('.').pop()?.toLowerCase() || '';
                    const name = ext === 'md' ? fileName.replace(/\.md$/, '') : fileName;
                    const normalizedNote = note.replace(/\\/g, '/');
                    let displayPath = note;
                    let folderName = '';
                    if (vaultPaths.length > 0) {
                      for (const vp of vaultPaths) {
                        const nvp = vp.replace(/\\/g, '/');
                        if (normalizedNote.startsWith(nvp)) {
                          displayPath = normalizedNote.slice(nvp.length + 1);
                          folderName = nvp.split('/').pop() || '';
                          break;
                        }
                      }
                    }
                    const extColors: Record<string, string> = { pdf: '#ef4444', docx: '#2563eb', csv: '#16a34a', html: '#f97316', htm: '#f97316', png: '#8b5cf6', jpg: '#8b5cf6', jpeg: '#8b5cf6', gif: '#8b5cf6', webp: '#8b5cf6', svg: '#8b5cf6' };
                    const badgeColor = extColors[ext] || 'var(--text-muted)';
                    return (
                      <button key={note} className="canvas-note-item" onClick={() => handleAddNoteNode(note)}>
                        <div className="canvas-note-item-name" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          {name}
                          {ext !== 'md' && <span style={{ background: badgeColor, color: '#fff', padding: '1px 5px', borderRadius: 'var(--radius-full)', fontSize: '9px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', flexShrink: 0 }}>{ext}</span>}
                        </div>
                        <div className="canvas-note-item-path">
                          {vaultPaths.length > 1 && folderName && <span style={{ background: 'var(--bg-tertiary)', padding: '1px 6px', borderRadius: 'var(--radius-full)', fontSize: '10px', marginRight: '4px', fontWeight: 500, color: 'var(--text-secondary)' }}>{folderName}</span>}
                          {(() => { const parts = displayPath.replace(/\\/g, '/').split('/'); parts.pop(); return parts.length > 0 ? parts.join('/') + '/' : (folderName ? folderName + '/' : '/'); })()}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
