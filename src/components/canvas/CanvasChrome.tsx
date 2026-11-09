/**
 * Canvas chrome: everything that floats over the board.
 *
 *   top-left      file menu + canvas name + undo/redo
 *   top-right     review tools and the suggestions toggle (one row, so nothing
 *                 can slide underneath anything else)
 *   top-center    selection bar, only while something is selected
 *   bottom-center the add dock (cards, media, pen)
 *
 * Laid out the way Obsidian Canvas / tldraw keep "make things" at the bottom and
 * "this file" at the top, instead of one long strip that runs into the panel.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PenMode } from './FreehandOverlay';
import { CARD_HUES } from './cardContent';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl+';

// ── icons (16px grid, 1.75 stroke) ─────────────────────────────────────
const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
const Ico = ({ children, size = 16 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...P} aria-hidden="true">{children}</svg>
);
export const Icons = {
  menu: <Ico><line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="20" y2="17" /></Ico>,
  chevron: <Ico size={12}><polyline points="6 9 12 15 18 9" /></Ico>,
  undo: <Ico><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></Ico>,
  redo: <Ico><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></Ico>,
  note: <Ico><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><line x1="9" y1="13" x2="15" y2="13" /><line x1="9" y1="17" x2="13" y2="17" /></Ico>,
  sticky: <Ico><path d="M5 4h14a1 1 0 0 1 1 1v9l-6 6H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" /><path d="M14 20v-5a1 1 0 0 1 1-1h5" /></Ico>,
  group: <Ico><rect x="3.5" y="5" width="17" height="14" rx="3" /><line x1="3.5" y1="9" x2="11" y2="9" /></Ico>,
  web: <Ico><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17" /><path d="M12 3.5c2.4 2.4 3.5 5.3 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.3-3.5-8.5S9.6 5.9 12 3.5z" /></Ico>,
  pdf: <Ico><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 16v-4h1.5a1.5 1.5 0 0 1 0 3H9" /></Ico>,
  image: <Ico><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="10" r="1.6" /><path d="m20.5 16-4.5-4.5L7 19.5" /></Ico>,
  pen: <Ico><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z" /></Ico>,
  eraser: <Ico><path d="m7 21-4-4a1.5 1.5 0 0 1 0-2.1L13.9 4a1.5 1.5 0 0 1 2.1 0l4 4a1.5 1.5 0 0 1 0 2.1L10 20" /><line x1="7" y1="21" x2="20" y2="21" /><line x1="8.5" y1="10.5" x2="14" y2="16" /></Ico>,
  check: <Ico><path d="M20 12a8 8 0 1 1-4.2-7" /><polyline points="9 11.5 12 14.5 20 6" /></Ico>,
  addByTopic: <Ico><circle cx="10.5" cy="10.5" r="6" /><line x1="15" y1="15" x2="20" y2="20" /><line x1="10.5" y1="8" x2="10.5" y2="13" /><line x1="8" y1="10.5" x2="13" y2="10.5" /></Ico>,
  plan: <Ico><rect x="4" y="4" width="16" height="16" rx="3" /><polyline points="8 9.5 9.5 11 12 8.5" /><line x1="13.5" y1="10" x2="16" y2="10" /><polyline points="8 15 9.5 16.5 12 14" /><line x1="13.5" y1="15.5" x2="16" y2="15.5" /></Ico>,
  inbox: <Ico><path d="M4 13.5 6.5 5h11l2.5 8.5" /><path d="M4 13.5V18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4.5h-5a3 3 0 0 1-6 0z" /></Ico>,
  chat: <Ico><path d="M20 12a7.5 7.5 0 0 1-11 6.6L4 20l1.4-4.6A7.5 7.5 0 1 1 20 12z" /></Ico>,
  trash: <Ico><path d="M4.5 7h15" /><path d="M9.5 7V4.5h5V7" /><path d="M6.5 7l.8 12a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5l.8-12" /></Ico>,
  palette: <Ico><path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.1 0 1.6-.8 1.6-1.6 0-1-.9-1.4-.9-2.4 0-.9.7-1.5 1.6-1.5H16a4.5 4.5 0 0 0 4.5-4.5c0-3.9-3.8-7-8.5-7z" /><circle cx="8" cy="11" r="1" /><circle cx="11" cy="7.5" r="1" /><circle cx="15.5" cy="8.5" r="1" /></Ico>,
  alignLeft: <Ico><line x1="4" y1="3.5" x2="4" y2="20.5" /><rect x="7" y="6" width="9" height="4.5" rx="1" /><rect x="7" y="13.5" width="13" height="4.5" rx="1" /></Ico>,
  alignCenterH: <Ico><line x1="12" y1="3.5" x2="12" y2="20.5" /><rect x="7.5" y="6" width="9" height="4.5" rx="1" /><rect x="5.5" y="13.5" width="13" height="4.5" rx="1" /></Ico>,
  alignRight: <Ico><line x1="20" y1="3.5" x2="20" y2="20.5" /><rect x="8" y="6" width="9" height="4.5" rx="1" /><rect x="4" y="13.5" width="13" height="4.5" rx="1" /></Ico>,
  alignTop: <Ico><line x1="3.5" y1="4" x2="20.5" y2="4" /><rect x="6" y="7" width="4.5" height="9" rx="1" /><rect x="13.5" y="7" width="4.5" height="13" rx="1" /></Ico>,
  alignCenterV: <Ico><line x1="3.5" y1="12" x2="20.5" y2="12" /><rect x="6" y="7.5" width="4.5" height="9" rx="1" /><rect x="13.5" y="5.5" width="4.5" height="13" rx="1" /></Ico>,
  alignBottom: <Ico><line x1="3.5" y1="20" x2="20.5" y2="20" /><rect x="6" y="8" width="4.5" height="9" rx="1" /><rect x="13.5" y="4" width="4.5" height="13" rx="1" /></Ico>,
  newFile: <Ico><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><line x1="12" y1="11.5" x2="12" y2="17.5" /><line x1="9" y1="14.5" x2="15" y2="14.5" /></Ico>,
  open: <Ico><path d="M3.5 18V6a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /></Ico>,
  save: <Ico><path d="M5 4h11l4 4v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" /><path d="M8 4v4h7V4" /><rect x="7.5" y="13" width="9" height="7" rx="1" /></Ico>,
  templates: <Ico><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></Ico>,
  close: <Ico size={14}><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></Ico>,
};

/** Closes a popover on outside pointer-down or Escape. */
function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as globalThis.Node)) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, close, ref]);
}

function ToolButton({
  icon, label, shortcut, onClick, active, disabled, tipBelow, className = '', children,
}: {
  icon: ReactNode; label: string; shortcut?: string; onClick: () => void;
  active?: boolean; disabled?: boolean; tipBelow?: boolean; className?: string; children?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`zc-tool ${active ? 'is-active' : ''} ${className}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active || undefined}
      data-tip={shortcut ? `${label}  ${shortcut}` : label}
      data-tip-pos={tipBelow ? 'below' : 'above'}
    >
      {icon}
      {children}
    </button>
  );
}

// ── Top-left: file ─────────────────────────────────────────────────────
interface TopBarProps {
  lang: string;
  canvasName: string | null;
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onTemplates: () => void;
  onUndo: () => void;
  onRedo: () => void;
}

export function CanvasTopBar({ lang, canvasName, onNew, onOpen, onSave, onTemplates, onUndo, onRedo }: TopBarProps) {
  const zh = lang === 'zh';
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);
  const run = (fn: () => void) => () => { setOpen(false); fn(); };

  return (
    <div className="zc-chrome zc-topbar" ref={ref} onMouseDown={e => e.stopPropagation()}>
      <button
        type="button"
        className={`zc-file-btn ${open ? 'is-open' : ''}`}
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="zc-file-name">{canvasName || (zh ? '未命名画布' : 'Untitled canvas')}</span>
        <span className="zc-file-caret">{Icons.chevron}</span>
      </button>
      <span className="zc-chrome-sep" />
      <ToolButton icon={Icons.undo} label={zh ? '撤销' : 'Undo'} shortcut={`${MOD}Z`} onClick={onUndo} tipBelow />
      <ToolButton icon={Icons.redo} label={zh ? '重做' : 'Redo'} shortcut={`${MOD}⇧Z`} onClick={onRedo} tipBelow />

      {open && (
        <div className="zc-menu zc-menu--dropdown" role="menu">
          <MenuItem icon={Icons.newFile} label={zh ? '新建画布' : 'New canvas'} onClick={run(onNew)} />
          <MenuItem icon={Icons.open} label={zh ? '打开画布…' : 'Open canvas…'} onClick={run(onOpen)} />
          <MenuItem icon={Icons.save} label={zh ? '保存' : 'Save'} shortcut={`${MOD}S`} onClick={run(onSave)} />
          <div className="zc-menu-sep" />
          <MenuItem icon={Icons.templates} label={zh ? '从模板开始…' : 'Start from template…'} onClick={run(onTemplates)} />
        </div>
      )}
    </div>
  );
}

// ── Bottom-center: add dock ────────────────────────────────────────────
interface DockProps {
  lang: string;
  onAddNote: () => void;
  onAddSticky: () => void;
  onAddGroup: () => void;
  onAddWeb: () => void;
  onAddPdf: () => void;
  onAddImage: () => void;
  penMode: PenMode;
  setPenMode: (fn: (p: PenMode) => PenMode) => void;
}

export function CanvasDock({ lang, onAddNote, onAddSticky, onAddGroup, onAddWeb, onAddPdf, onAddImage, penMode, setPenMode }: DockProps) {
  const zh = lang === 'zh';
  return (
    <div className="zc-chrome zc-dock" onMouseDown={e => e.stopPropagation()}>
      <ToolButton icon={Icons.note} label={zh ? '添加笔记' : 'Add note'} onClick={onAddNote} />
      <ToolButton icon={Icons.sticky} label={zh ? '便签' : 'Sticky'} onClick={onAddSticky} />
      <ToolButton icon={Icons.group} label={zh ? '分组' : 'Group'} onClick={onAddGroup} />
      <span className="zc-chrome-sep" />
      <ToolButton icon={Icons.web} label={zh ? '网页' : 'Web page'} onClick={onAddWeb} />
      <ToolButton icon={Icons.pdf} label="PDF" onClick={onAddPdf} />
      <ToolButton icon={Icons.image} label={zh ? '图片' : 'Image'} onClick={onAddImage} />
      <span className="zc-chrome-sep" />
      <ToolButton
        icon={Icons.pen}
        label={zh ? '画笔' : 'Pen'}
        shortcut="P"
        active={penMode === 'pen'}
        onClick={() => setPenMode(p => (p === 'pen' ? 'off' : 'pen'))}
      />
      <ToolButton
        icon={Icons.eraser}
        label={zh ? '橡皮' : 'Eraser'}
        shortcut="E"
        active={penMode === 'eraser'}
        onClick={() => setPenMode(p => (p === 'eraser' ? 'off' : 'eraser'))}
      />
    </div>
  );
}

// ── Top-right: review tools + suggestions ──────────────────────────────
interface ReviewBarProps {
  lang: string;
  panelOpen: boolean;
  checking: boolean;
  checkActive: boolean;
  onCheck: () => void;
  addByTopicOpen: boolean;
  onAddByTopic: () => void;
  planOpen: boolean;
  onPlan: () => void;
  suggestionCount: number;
  onTogglePanel: () => void;
}

export function CanvasReviewBar({
  lang, panelOpen, checking, checkActive, onCheck, addByTopicOpen, onAddByTopic, planOpen, onPlan, suggestionCount, onTogglePanel,
}: ReviewBarProps) {
  const zh = lang === 'zh';
  return (
    <div className={`zc-chrome zc-reviewbar ${panelOpen ? 'is-shifted' : ''}`} onMouseDown={e => e.stopPropagation()}>
      <ToolButton icon={Icons.check} label={zh ? '检查画布' : 'Check canvas'} active={checkActive} disabled={checking} onClick={onCheck} tipBelow className={checking ? 'is-busy' : ''} />
      <ToolButton icon={Icons.addByTopic} label={zh ? '按主题添加笔记' : 'Add notes by topic'} active={addByTopicOpen} onClick={onAddByTopic} tipBelow />
      <ToolButton icon={Icons.plan} label={zh ? '计划改动' : 'Plan changes'} active={planOpen} onClick={onPlan} tipBelow />
      <span className="zc-chrome-sep" />
      <button
        type="button"
        className={`zc-suggest-btn ${panelOpen ? 'is-active' : ''}`}
        onClick={onTogglePanel}
        aria-pressed={panelOpen}
      >
        {Icons.inbox}
        <span>{zh ? '建议' : 'Suggestions'}</span>
        {suggestionCount > 0 && <span className="zc-count">{suggestionCount > 99 ? '99+' : suggestionCount}</span>}
      </button>
    </div>
  );
}

// ── Top-center: selection ──────────────────────────────────────────────
export type AlignDir = 'left' | 'center-h' | 'right' | 'top' | 'center-v' | 'bottom';

interface SelectionBarProps {
  lang: string;
  count: number;
  shifted: boolean;
  currentColor?: string;
  onAlign: (dir: AlignDir) => void;
  onColor: (hue: string | undefined) => void;
  onDiscuss: () => void;
  onDelete: () => void;
}

export function SelectionBar({ lang, count, shifted, currentColor, onAlign, onColor, onDiscuss, onDelete }: SelectionBarProps) {
  const zh = lang === 'zh';
  const [paletteOpen, setPaletteOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(paletteOpen, () => setPaletteOpen(false), ref);
  if (count === 0) return null;

  return (
    <div className={`zc-chrome zc-selectionbar ${shifted ? 'is-shifted' : ''}`} ref={ref} onMouseDown={e => e.stopPropagation()}>
      <span className="zc-selection-count">{zh ? `已选 ${count}` : `${count} selected`}</span>
      {count >= 2 && (
        <>
          <span className="zc-chrome-sep" />
          <ToolButton icon={Icons.alignLeft} label={zh ? '左对齐' : 'Align left'} onClick={() => onAlign('left')} />
          <ToolButton icon={Icons.alignCenterH} label={zh ? '水平居中' : 'Align centers'} onClick={() => onAlign('center-h')} />
          <ToolButton icon={Icons.alignRight} label={zh ? '右对齐' : 'Align right'} onClick={() => onAlign('right')} />
          <ToolButton icon={Icons.alignTop} label={zh ? '顶部对齐' : 'Align top'} onClick={() => onAlign('top')} />
          <ToolButton icon={Icons.alignCenterV} label={zh ? '垂直居中' : 'Align middles'} onClick={() => onAlign('center-v')} />
          <ToolButton icon={Icons.alignBottom} label={zh ? '底部对齐' : 'Align bottom'} onClick={() => onAlign('bottom')} />
        </>
      )}
      <span className="zc-chrome-sep" />
      <div className="zc-popover-anchor">
        <ToolButton icon={Icons.palette} label={zh ? '颜色' : 'Color'} active={paletteOpen} onClick={() => setPaletteOpen(o => !o)} />
        {paletteOpen && (
          <div className="zc-menu zc-menu--palette">
            {CARD_HUES.map(h => (
              <button
                key={h.value}
                type="button"
                className={`zc-swatch ${currentColor?.toLowerCase() === h.value.toLowerCase() ? 'is-active' : ''}`}
                style={{ ['--dot-hue' as string]: h.value }}
                title={zh ? h.nameZh : h.name}
                onClick={() => { onColor(h.value); setPaletteOpen(false); }}
              />
            ))}
            <button
              type="button"
              className="zc-swatch zc-swatch--none"
              title={zh ? '无颜色' : 'No color'}
              onClick={() => { onColor(undefined); setPaletteOpen(false); }}
            />
          </div>
        )}
      </div>
      <ToolButton icon={Icons.chat} label={zh ? '在对话中讨论' : 'Discuss in chat'} onClick={onDiscuss} />
      <ToolButton icon={Icons.trash} label={zh ? '删除' : 'Delete'} shortcut="Del" onClick={onDelete} className="zc-tool--danger" />
    </div>
  );
}

// ── shared menu row ────────────────────────────────────────────────────
export function MenuItem({
  icon, label, shortcut, onClick, danger, disabled, active,
}: {
  icon?: ReactNode; label: ReactNode; shortcut?: string; onClick: () => void;
  danger?: boolean; disabled?: boolean; active?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`zc-menu-item ${danger ? 'is-danger' : ''} ${active ? 'is-active' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="zc-menu-icon">{icon}</span>
      <span className="zc-menu-label">{label}</span>
      {shortcut && <span className="zc-menu-shortcut">{shortcut}</span>}
    </button>
  );
}

export { MOD };
