/**
 * CanvasModals — 画布弹窗（模板选择 + 添加笔记）
 */
import { useEffect, useMemo, useRef, useState } from 'react';
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
  /** Files already on this canvas, marked in the add-note list. */
  onCanvasPaths?: string[];
}

export function CanvasModals({
  isTemplateOpen, setIsTemplateOpen, applyTemplate,
  isAddNoteOpen, setIsAddNoteOpen, noteSearch, setNoteSearch,
  filteredNotes, handleAddNoteNode, lang, vaultPaths, onCanvasPaths = [],
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
                  <div className="canvas-template-title">{t('canvas.templateBlank')}</div>
                  <div className="canvas-template-desc">{t('canvas.templateBlankDesc')}</div>
                </button>
                {CANVAS_TEMPLATES.map(tpl => {
                  const capName = tpl.id.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
                  return (
                    <button key={tpl.id} className="canvas-template-card" onClick={() => applyTemplate(tpl.id)} title={t(`canvas.template${capName}` as any)}>
                      <div className="canvas-template-thumb" dangerouslySetInnerHTML={{ __html: tpl.thumbnail }} />
                      <div className="canvas-template-title">{t(`canvas.template${capName}` as any)}</div>
                      <div className="canvas-template-desc">{t(`canvas.template${capName}Desc` as any)}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 添加笔记：命令面板式的快速插入 */}
      {isAddNoteOpen && (
        <AddNoteDialog
          isZh={isZh}
          notes={filteredNotes}
          query={noteSearch}
          setQuery={setNoteSearch}
          onPick={handleAddNoteNode}
          onClose={() => setIsAddNoteOpen(false)}
          vaultPaths={vaultPaths}
          onCanvasPaths={onCanvasPaths}
        />
      )}
    </>
  );
}

const MAX_ROWS = 200;

interface NoteRow { path: string; name: string; ext: string; folder: string }

function toRow(path: string, vaultPaths: string[]): NoteRow {
  const norm = path.replace(/\\/g, '/');
  const fileName = norm.split('/').pop() || norm;
  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
  const name = ext === 'md' ? fileName.slice(0, -3) : fileName;
  let rel = norm;
  let vaultName = '';
  for (const vp of vaultPaths) {
    const nvp = vp.replace(/\\/g, '/').replace(/\/$/, '');
    if (norm.startsWith(nvp + '/')) {
      rel = norm.slice(nvp.length + 1);
      vaultName = nvp.split('/').pop() || '';
      break;
    }
  }
  const dir = rel.split('/').slice(0, -1).join('/');
  const folder = vaultPaths.length > 1 && vaultName ? (dir ? `${vaultName}/${dir}` : vaultName) : dir;
  return { path, name, ext, folder };
}

/** Name-prefix matches first, then word-start, then anywhere; path matches last. */
function rank(row: NoteRow, q: string): number {
  if (!q) return 0;
  const n = row.name.toLowerCase();
  if (n.startsWith(q)) return 0;
  if (n.split(/[\s_\-·.]+/).some(w => w.startsWith(q))) return 1;
  if (n.includes(q)) return 2;
  return 3;
}

function AddNoteDialog({
  isZh, notes, query, setQuery, onPick, onClose, vaultPaths, onCanvasPaths,
}: {
  isZh: boolean; notes: string[]; query: string; setQuery: (v: string) => void;
  onPick: (path: string) => void; onClose: () => void; vaultPaths: string[]; onCanvasPaths: string[];
}) {
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const onCanvas = useMemo(() => new Set(onCanvasPaths.map(p => p.replace(/\\/g, '/'))), [onCanvasPaths]);
  const q = query.trim().toLowerCase();

  const rows = useMemo(() => {
    const all = notes.map(p => toRow(p, vaultPaths));
    const matched = q
      ? all.filter(r => r.name.toLowerCase().includes(q) || r.folder.toLowerCase().includes(q))
      : all;
    return matched
      .map(r => ({ r, k: rank(r, q) }))
      .sort((a, b) => a.k - b.k || a.r.name.localeCompare(b.r.name))
      .slice(0, MAX_ROWS)
      .map(x => x.r);
  }, [notes, vaultPaths, q]);

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(rows.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (rows[active]) onPick(rows[active].path); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  return (
    <div className="zc-palette-overlay" onMouseDown={onClose}>
      <div className="zc-palette" role="dialog" aria-label={isZh ? '添加笔记' : 'Add note'} onMouseDown={e => e.stopPropagation()}>
        <div className="zc-palette-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"><circle cx="11" cy="11" r="6.5" /><line x1="16" y1="16" x2="20" y2="20" /></svg>
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder={isZh ? '搜索笔记或文件…' : 'Search notes and files…'}
            spellCheck={false}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="zc-palette-list" ref={listRef}>
          {rows.length === 0 ? (
            <div className="zc-palette-empty">{q ? (isZh ? '没有匹配的文件' : 'No matching files') : t('canvas.noNotes')}</div>
          ) : rows.map((r, i) => {
            const already = onCanvas.has(r.path.replace(/\\/g, '/'));
            return (
              <button
                key={r.path}
                type="button"
                data-index={i}
                className={`zc-palette-row ${i === active ? 'is-active' : ''}`}
                onMouseMove={() => i !== active && setActive(i)}
                onClick={() => onPick(r.path)}
              >
                <span className={`zc-palette-icon ${r.ext && r.ext !== 'md' ? 'is-file' : ''}`}>
                  {r.ext && r.ext !== 'md' ? r.ext.slice(0, 4).toUpperCase() : (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>
                  )}
                </span>
                <span className="zc-palette-text">
                  <span className="zc-palette-name">{r.name}</span>
                  {r.folder && <span className="zc-palette-folder">{r.folder}</span>}
                </span>
                {already && <span className="zc-palette-tag">{isZh ? '已在画布' : 'On canvas'}</span>}
              </button>
            );
          })}
        </div>
        <div className="zc-palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> {isZh ? '选择' : 'Move'}</span>
          <span><kbd>↵</kbd> {isZh ? '添加到画布' : 'Add to canvas'}</span>
          {notes.length > MAX_ROWS && rows.length === MAX_ROWS && (
            <span className="zc-palette-more">{isZh ? `仅显示前 ${MAX_ROWS} 项，继续输入以缩小范围` : `Showing first ${MAX_ROWS}; keep typing to narrow`}</span>
          )}
        </div>
      </div>
    </div>
  );
}
