import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Edge } from '@xyflow/react';
import { t, getLang } from '../../lib/i18n';
import { getRelationTypes, getRelationLabel } from './canvasConstants';
import { CARD_HUES, cardHue } from './cardContent';
import { Icons, MenuItem } from './CanvasChrome';

const zh = () => getLang() === 'zh';

/**
 * A menu anchored at a screen point that flips/shifts to stay inside the
 * window (a menu opened near the bottom-right corner used to run off-screen).
 */
function FloatingMenu({ x, y, className = '', children }: { x: number; y: number; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    let left = x;
    let top = y;
    if (left + r.width > window.innerWidth - pad) left = Math.max(pad, x - r.width);
    if (top + r.height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - pad - r.height);
    setPos({ left, top });
  }, [x, y]);
  return (
    <div
      ref={ref}
      className={`zc-menu zc-menu--context ${className}`}
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>
  );
}

function HueRow({ current, onPick }: { current?: string; onPick: (hue: string | undefined) => void }) {
  const isZh = zh();
  const cur = current ? cardHue(current, '').toLowerCase() : '';
  return (
    <div className="zc-menu-swatches">
      {CARD_HUES.map((h) => (
        <button
          key={h.value}
          type="button"
          className={`zc-swatch ${cur === h.value.toLowerCase() ? 'is-active' : ''}`}
          style={{ ['--dot-hue' as string]: h.value }}
          title={isZh ? h.nameZh : h.name}
          onClick={() => onPick(h.value)}
        />
      ))}
      <button
        type="button"
        className={`zc-swatch zc-swatch--none ${!cur ? 'is-active' : ''}`}
        title={isZh ? '无颜色' : 'No color'}
        onClick={() => onPick(undefined)}
      />
    </div>
  );
}

// ── Node Context Menu ──
interface NodeContextMenuProps {
  contextMenu: { x: number; y: number; nodeId: string; nodeType: string };
  setContextMenu: (menu: any) => void;
  handleDeleteNode: (nodeId: string) => void;
  handleDuplicateNode: (nodeId: string) => void;
  reactFlowInstance: any;
  setCurrentFile: (file: string) => void;
  setView: (view: any) => void;
  handleConvertTextToNote: (nodeId: string) => void;
  handleSetNodeColor: (nodeId: string, color: string | undefined) => void;
  selectedNodeCount: number;
  onDiscussSelection?: () => void;
  onBringToFront?: (nodeId: string) => void;
  onSendToBack?: (nodeId: string) => void;
}

export function NodeContextMenu({
  contextMenu,
  setContextMenu,
  handleDeleteNode,
  handleDuplicateNode,
  reactFlowInstance,
  setCurrentFile,
  setView,
  handleConvertTextToNote,
  handleSetNodeColor,
  selectedNodeCount,
  onDiscussSelection,
  onBringToFront,
  onSendToBack,
}: NodeContextMenuProps) {
  const isZh = zh();
  const node = reactFlowInstance.getNode(contextMenu.nodeId);
  const close = () => setContextMenu(null);
  const type = contextMenu.nodeType;
  const colorable = type !== 'pdf' && type !== 'web' && type !== 'image';

  return (
    <FloatingMenu x={contextMenu.x} y={contextMenu.y}>
      {type === 'file' && (
        <MenuItem
          icon={Icons.open}
          label={isZh ? '打开笔记' : 'Open note'}
          onClick={() => {
            if (node?.data.file) {
              setCurrentFile(node.data.file as string);
              setView('note');
            }
            close();
          }}
        />
      )}
      {type === 'text' && (
        <MenuItem icon={Icons.note} label={t('canvas.convertToNote')} onClick={() => handleConvertTextToNote(contextMenu.nodeId)} />
      )}
      <MenuItem icon={Icons.templates} label={isZh ? '创建副本' : 'Duplicate'} onClick={() => handleDuplicateNode(contextMenu.nodeId)} />
      {selectedNodeCount >= 2 && onDiscussSelection && (
        <MenuItem
          icon={Icons.chat}
          label={isZh ? `在对话中讨论所选 ${selectedNodeCount} 张` : `Discuss ${selectedNodeCount} selected in chat`}
          onClick={() => { onDiscussSelection(); close(); }}
        />
      )}

      <div className="zc-menu-sep" />
      <MenuItem
        icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 4H6a2 2 0 0 0-2 2v10" /></svg>}
        label={t('canvas.bringToFront')}
        onClick={() => { onBringToFront?.(contextMenu.nodeId); close(); }}
      />
      <MenuItem
        icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="12" height="12" rx="2" /><path d="M8 20h10a2 2 0 0 0 2-2V8" /></svg>}
        label={t('canvas.sendToBack')}
        onClick={() => { onSendToBack?.(contextMenu.nodeId); close(); }}
      />

      {colorable && (
        <>
          <div className="zc-menu-sep" />
          <div className="zc-menu-heading">{isZh ? '颜色' : 'Color'}</div>
          <HueRow current={node?.data.color as string | undefined} onPick={(h) => handleSetNodeColor(contextMenu.nodeId, h)} />
        </>
      )}

      <div className="zc-menu-sep" />
      <MenuItem icon={Icons.trash} label={t('common.delete' as any)} shortcut="Del" danger onClick={() => handleDeleteNode(contextMenu.nodeId)} />
    </FloatingMenu>
  );
}


// ── Edge Context Menu ──
interface EdgeContextMenuProps {
  edgeContextMenu: { x: number; y: number; edgeId: string };
  setEdgeContextMenu: (menu: any) => void;
  edges: Edge[];
  setEditingEdgeId: (id: string | null) => void;
  setEdgeLabelInput: (val: string) => void;
  setEdgeLabelPos: (pos: { x: number; y: number }) => void;
  handleSetEdgeDirection: (edgeId: string, dir: 'none' | 'forward' | 'both') => void;
  handleSetEdgeRelation: (edgeId: string, relationType: string) => void;
  handleSetEdgeColor: (edgeId: string, color: string | undefined) => void;
  handleDeleteEdge: (edgeId: string) => void;
}

export function EdgeContextMenu({
  edgeContextMenu,
  setEdgeContextMenu,
  edges,
  setEditingEdgeId,
  setEdgeLabelInput,
  setEdgeLabelPos,
  handleSetEdgeDirection,
  handleSetEdgeRelation,
  handleSetEdgeColor,
  handleDeleteEdge,
}: EdgeContextMenuProps) {
  const isZh = zh();
  const edge = edges.find(e => e.id === edgeContextMenu.edgeId);
  const currentType = (edge?.data?.relationType as string) || 'wikilink';
  const currentColor = (edge?.data?.color as string) || (edge?.style?.stroke as string);
  const from = (edge?.data?.fromEnd as string) || 'none';
  const to = (edge?.data?.toEnd as string) || 'arrow';
  const dir: 'none' | 'forward' | 'both' = from === 'arrow' && to === 'arrow' ? 'both' : to === 'arrow' ? 'forward' : 'none';
  const id = edgeContextMenu.edgeId;

  const dirs: { k: 'none' | 'forward' | 'both'; label: string; icon: ReactNode }[] = [
    { k: 'none', label: isZh ? '无方向' : 'None', icon: <svg width="22" height="12" viewBox="0 0 22 12"><line x1="2" y1="6" x2="20" y2="6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg> },
    { k: 'forward', label: isZh ? '单向' : 'One way', icon: <svg width="22" height="12" viewBox="0 0 22 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><line x1="2" y1="6" x2="19" y2="6" /><polyline points="15 2.5 19 6 15 9.5" /></svg> },
    { k: 'both', label: isZh ? '双向' : 'Both ways', icon: <svg width="22" height="12" viewBox="0 0 22 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="6" x2="19" y2="6" /><polyline points="15 2.5 19 6 15 9.5" /><polyline points="7 2.5 3 6 7 9.5" /></svg> },
  ];

  return (
    <FloatingMenu x={edgeContextMenu.x} y={edgeContextMenu.y} className="zc-menu--wide">
      <MenuItem
        icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7V5h16v2" /><line x1="12" y1="5" x2="12" y2="19" /><line x1="9" y1="19" x2="15" y2="19" /></svg>}
        label={edge?.label ? (isZh ? '编辑标签' : 'Edit label') : (isZh ? '添加标签' : 'Add label')}
        shortcut={isZh ? '双击' : 'Dbl-click'}
        onClick={() => {
          if (edge) {
            setEditingEdgeId(edge.id);
            setEdgeLabelInput((edge.label as string) || '');
            setEdgeLabelPos({ x: edgeContextMenu.x, y: edgeContextMenu.y });
          }
          setEdgeContextMenu(null);
        }}
      />

      <div className="zc-menu-heading">{isZh ? '方向' : 'Direction'}</div>
      <div className="zc-segmented" role="radiogroup">
        {dirs.map(d => (
          <button
            key={d.k}
            type="button"
            role="radio"
            aria-checked={dir === d.k}
            className={dir === d.k ? 'is-active' : ''}
            title={d.label}
            onClick={() => handleSetEdgeDirection(id, d.k)}
          >
            {d.icon}
          </button>
        ))}
      </div>

      <div className="zc-menu-sep" />
      <div className="zc-menu-heading">{t('canvas.relationType')}</div>
      <div className="zc-menu-grid">
        {getRelationTypes().map(rel => (
          <MenuItem
            key={rel.type}
            icon={<span className="zc-rel-dot" style={{ ['--dot-hue' as string]: rel.color }} />}
            label={getRelationLabel(rel)}
            active={currentType === rel.type}
            onClick={() => handleSetEdgeRelation(id, rel.type)}
          />
        ))}
      </div>

      <div className="zc-menu-sep" />
      <div className="zc-menu-heading">{t('canvas.lineColor')}</div>
      <HueRow current={currentColor} onPick={(h) => handleSetEdgeColor(id, h)} />

      <div className="zc-menu-sep" />
      <MenuItem icon={Icons.trash} label={t('canvas.deleteEdge')} shortcut="Del" danger onClick={() => handleDeleteEdge(id)} />
    </FloatingMenu>
  );
}


// ── Pane Context Menu ──
interface PaneContextMenuProps {
  paneMenu: { x: number; y: number };
  addNodeAtPosition: (type: 'note' | 'text' | 'group' | 'web', screenX: number, screenY: number) => void;
  handleAddPdfNode: () => void;
  handleAddImageNode?: () => void;
  setPaneMenu: (menu: any) => void;
}

export function PaneContextMenu({
  paneMenu,
  addNodeAtPosition,
  handleAddPdfNode,
  handleAddImageNode,
  setPaneMenu,
}: PaneContextMenuProps) {
  const isZh = zh();
  const at = (type: 'note' | 'text' | 'group' | 'web') => () => addNodeAtPosition(type, paneMenu.x, paneMenu.y);
  return (
    <FloatingMenu x={paneMenu.x} y={paneMenu.y}>
      <div className="zc-menu-heading">{isZh ? '在此处添加' : 'Add here'}</div>
      <MenuItem icon={Icons.note} label={isZh ? '笔记…' : 'Note…'} onClick={at('note')} />
      <MenuItem icon={Icons.sticky} label={isZh ? '便签' : 'Sticky'} shortcut={isZh ? '双击空白处' : 'Dbl-click'} onClick={at('text')} />
      <MenuItem icon={Icons.group} label={isZh ? '分组' : 'Group'} onClick={at('group')} />
      <div className="zc-menu-sep" />
      <MenuItem icon={Icons.web} label={isZh ? '网页' : 'Web page'} onClick={at('web')} />
      <MenuItem icon={Icons.pdf} label="PDF…" onClick={() => { handleAddPdfNode(); setPaneMenu(null); }} />
      {handleAddImageNode && (
        <MenuItem icon={Icons.image} label={isZh ? '图片…' : 'Image…'} onClick={() => { handleAddImageNode(); setPaneMenu(null); }} />
      )}
    </FloatingMenu>
  );
}


// ── Quick Connect Menu (a line dropped on empty canvas) ──
interface QuickConnectMenuProps {
  quickConnectMenu: { x: number; y: number; sourceNodeId: string; sourceHandleId: string | null };
  handleQuickCreate: (type: 'text' | 'file' | 'web') => void;
  quickConnectSuggestions: { path: string; label: string; similarity?: number }[];
  handleQuickConnectSimilar: (filePath: string) => void;
}

export function QuickConnectMenu({
  quickConnectMenu,
  handleQuickCreate,
  quickConnectSuggestions,
  handleQuickConnectSimilar,
}: QuickConnectMenuProps) {
  const isZh = zh();
  return (
    <FloatingMenu x={quickConnectMenu.x + 6} y={quickConnectMenu.y + 6} className="zc-menu--quick">
      <div className="zc-menu-heading">{isZh ? '连接到新的…' : 'Connect to a new…'}</div>
      <MenuItem icon={Icons.sticky} label={isZh ? '便签' : 'Sticky'} onClick={() => handleQuickCreate('text')} />
      <MenuItem icon={Icons.note} label={isZh ? '笔记…' : 'Note…'} onClick={() => handleQuickCreate('file')} />
      <MenuItem icon={Icons.web} label={isZh ? '网页' : 'Web page'} onClick={() => handleQuickCreate('web')} />
      {quickConnectSuggestions.length > 0 && (
        <>
          <div className="zc-menu-sep" />
          <div className="zc-menu-heading">{t('canvas.relatedNotes')}</div>
          {quickConnectSuggestions.map(s => (
            <MenuItem
              key={s.path}
              icon={Icons.note}
              label={<span className="zc-menu-ellipsis">{s.label}</span>}
              shortcut={s.similarity !== undefined ? `${s.similarity}%` : undefined}
              onClick={() => handleQuickConnectSimilar(s.path)}
            />
          ))}
        </>
      )}
    </FloatingMenu>
  );
}


// ── Edge Label Editor ──
interface EdgeLabelEditorProps {
  editingEdgeId: string;
  edgeLabelPos: { x: number; y: number };
  edgeLabelInput: string;
  setEdgeLabelInput: (val: string) => void;
  handleEdgeLabelConfirm: () => void;
  handleEdgeLabelCancel: () => void;
}

export function EdgeLabelEditor({
  editingEdgeId: _editingEdgeId,
  edgeLabelPos,
  edgeLabelInput,
  setEdgeLabelInput,
  handleEdgeLabelConfirm,
  handleEdgeLabelCancel,
}: EdgeLabelEditorProps) {
  return (
    <div
      className="canvas-edge-label-editor"
      style={{ left: edgeLabelPos.x, top: edgeLabelPos.y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <input
        type="text"
        className="input canvas-edge-label-input"
        value={edgeLabelInput}
        onChange={(e) => setEdgeLabelInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleEdgeLabelConfirm();
          if (e.key === 'Escape') handleEdgeLabelCancel();
        }}
        onBlur={handleEdgeLabelConfirm}
        autoFocus
        placeholder={t('canvas.labelPlaceholder')}
      />
    </div>
  );
}
