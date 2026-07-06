import { Edge } from '@xyflow/react';
import { t } from '../../lib/i18n';
import { CARD_COLORS, getRelationTypes, getRelationLabel } from './canvasConstants';

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
  onAIAnalyzeSelection?: () => void;
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
  onAIAnalyzeSelection,
  onBringToFront,
  onSendToBack,
}: NodeContextMenuProps) {
  const node = reactFlowInstance.getNode(contextMenu.nodeId);
  return (
    <div
      className="canvas-context-menu"
      style={{ left: contextMenu.x, top: contextMenu.y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className="canvas-context-menu-item danger"
        onClick={() => handleDeleteNode(contextMenu.nodeId)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        <span>{t('common.delete' as any)}</span>
      </div>
      <div
        className="canvas-context-menu-item"
        onClick={() => handleDuplicateNode(contextMenu.nodeId)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        <span>{t('canvas.duplicate')}</span>
      </div>
      {contextMenu.nodeType === 'file' && (
        <div
          className="canvas-context-menu-item"
          onClick={() => {
            if (node?.data.file) {
              setCurrentFile(node.data.file as string);
              setView('note');
            }
            setContextMenu(null);
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          <span>{t('common.open' as any)}</span>
        </div>
      )}
      {contextMenu.nodeType === 'text' && (
        <div
          className="canvas-context-menu-item"
          onClick={() => handleConvertTextToNote(contextMenu.nodeId)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 12 15 15"/></svg>
          <span>{t('canvas.convertToNote')}</span>
        </div>
      )}
      {/* Z-order: bring to front / send to back */}
      <div
        className="canvas-context-menu-item"
        onClick={() => { onBringToFront?.(contextMenu.nodeId); setContextMenu(null); }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 11 12 6 7 11"/><polyline points="17 18 12 13 7 18"/></svg>
        <span>{t('canvas.bringToFront')}</span>
      </div>
      <div
        className="canvas-context-menu-item"
        onClick={() => { onSendToBack?.(contextMenu.nodeId); setContextMenu(null); }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="7 13 12 18 17 13"/><polyline points="7 6 12 11 17 6"/></svg>
        <span>{t('canvas.sendToBack')}</span>
      </div>
      {selectedNodeCount >= 2 && (
        <>
          <div className="canvas-context-menu-divider" />
          <div
            className="canvas-context-menu-item ai-action"
            onClick={() => {
              onAIAnalyzeSelection?.();
              setContextMenu(null);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
            </svg>
            <span>{t('canvas.aiAnalyzeSelected')}</span>
          </div>
        </>
      )}
      {contextMenu.nodeType !== 'pdf' && contextMenu.nodeType !== 'web' && (
        <>
          <div className="canvas-context-menu-divider" />
          <div className="canvas-context-menu-label">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="13.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="15.5" r="2.5"/><circle cx="8.5" cy="15.5" r="2.5"/></svg>
            <span>{t('canvas.cardColor')}</span>
          </div>
          <div className="canvas-context-color-row">
            {CARD_COLORS.map(c => (
              <div
                key={c.value}
                className={`canvas-context-color-dot ${(node?.data.color === c.value) ? 'active' : ''}`}
                style={{ backgroundColor: c.value }}
                title={c.name}
                onClick={() => handleSetNodeColor(contextMenu.nodeId, c.value)}
              />
            ))}
            <div
              className="canvas-context-color-dot reset"
              title={t('common.reset')}
              onClick={() => handleSetNodeColor(contextMenu.nodeId, undefined)}
            >
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </div>
          </div>
        </>
      )}
    </div>
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
  handleToggleEdgeArrow: (edgeId: string) => void;
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
  handleToggleEdgeArrow,
  handleSetEdgeRelation,
  handleSetEdgeColor,
  handleDeleteEdge,
}: EdgeContextMenuProps) {
  const edge = edges.find(e => e.id === edgeContextMenu.edgeId);
  const currentType = edge?.data?.relationType || 'wikilink';
  const currentColor = edge?.data?.color || edge?.style?.stroke;

  return (
    <div
      className="canvas-context-menu canvas-edge-menu-expanded"
      style={{ left: edgeContextMenu.x, top: edgeContextMenu.y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className="canvas-context-menu-item"
        onClick={() => {
          if (edge) {
            setEditingEdgeId(edge.id);
            setEdgeLabelInput((edge.label as string) || '');
            setEdgeLabelPos({ x: edgeContextMenu.x, y: edgeContextMenu.y });
          }
          setEdgeContextMenu(null);
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        <span>{t('canvas.editLabel')}</span>
      </div>

      <div
        className="canvas-context-menu-item"
        onClick={() => handleToggleEdgeArrow(edgeContextMenu.edgeId)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
        </svg>
        <span>
          {(() => {
            const from = edge?.data?.fromEnd || 'none';
            const to = edge?.data?.toEnd || 'arrow';
            if (from === 'none' && to === 'arrow') return t('canvas.arrowOneWay');
            if (from === 'arrow' && to === 'arrow') return t('canvas.arrowBoth');
            return t('canvas.arrowNone');
          })()}
        </span>
      </div>

      <div className="canvas-context-menu-divider" />

      <div className="canvas-context-menu-label">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
        <span>{t('canvas.relationType')}</span>
      </div>
      <div className="canvas-edge-relation-list">
        {getRelationTypes().map(rel => (
          <div
            key={rel.type}
            className={`canvas-edge-relation-item ${currentType === rel.type ? 'active' : ''}`}
            onClick={() => handleSetEdgeRelation(edgeContextMenu.edgeId, rel.type)}
          >
            <div className="canvas-edge-relation-dot" style={{ backgroundColor: rel.color }} />
            <span>{getRelationLabel(rel)}</span>
          </div>
        ))}
      </div>

      <div className="canvas-context-menu-divider" />

      <div className="canvas-context-menu-label">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="13.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="15.5" r="2.5"/><circle cx="8.5" cy="15.5" r="2.5"/></svg>
        <span>{t('canvas.lineColor')}</span>
      </div>
      <div className="canvas-context-color-row">
        {CARD_COLORS.map(c => (
          <div
            key={c.value}
            className={`canvas-context-color-dot ${currentColor === c.value ? 'active' : ''}`}
            style={{ backgroundColor: c.value }}
            title={c.name}
            onClick={() => handleSetEdgeColor(edgeContextMenu.edgeId, c.value)}
          />
        ))}
        <div
          className="canvas-context-color-dot reset"
          title={t('common.reset')}
          onClick={() => handleSetEdgeColor(edgeContextMenu.edgeId, undefined)}
        >
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </div>
      </div>

      <div className="canvas-context-menu-divider" />
      <div
        className="canvas-context-menu-item danger"
        onClick={() => handleDeleteEdge(edgeContextMenu.edgeId)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        <span>{t('canvas.deleteEdge')}</span>
      </div>
    </div>
  );
}


// ── Pane Context Menu ──
interface PaneContextMenuProps {
  paneMenu: { x: number; y: number };
  addNodeAtPosition: (type: 'note' | 'text' | 'group' | 'web', screenX: number, screenY: number) => void;
  handleAddPdfNode: () => void;
  setPaneMenu: (menu: any) => void;
}

export function PaneContextMenu({
  paneMenu,
  addNodeAtPosition,
  handleAddPdfNode,
  setPaneMenu,
}: PaneContextMenuProps) {
  return (
    <div
      className="canvas-context-menu"
      style={{ left: paneMenu.x, top: paneMenu.y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className="canvas-context-menu-item"
        onClick={() => addNodeAtPosition('note', paneMenu.x, paneMenu.y)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <span>{t('canvas.addNote')}</span>
      </div>
      <div
        className="canvas-context-menu-item"
        onClick={() => addNodeAtPosition('text', paneMenu.x, paneMenu.y)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        <span>{t('canvas.addSticky')}</span>
      </div>
      <div
        className="canvas-context-menu-item"
        onClick={() => addNodeAtPosition('group', paneMenu.x, paneMenu.y)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" strokeDasharray="3 3"/></svg>
        <span>{t('canvas.addGroup')}</span>
      </div>
      <div className="canvas-context-menu-divider" />
      <div
        className="canvas-context-menu-item"
        onClick={() => addNodeAtPosition('web', paneMenu.x, paneMenu.y)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
        <span>{t('canvas.addWeb')}</span>
      </div>
      <div
        className="canvas-context-menu-item"
        onClick={() => { handleAddPdfNode(); setPaneMenu(null); }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        <span>{t('canvas.addPdf')}</span>
      </div>
    </div>
  );
}


// ── Quick Connect Menu ──
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
  return (
    <div
      className="canvas-quick-connect-menu"
      style={{ left: quickConnectMenu.x, top: quickConnectMenu.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="canvas-quick-connect-title">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v6M12 17v6M4.22 4.22l4.24 4.24M15.54 15.54l4.24 4.24M1 12h6M17 12h6M4.22 19.78l4.24-4.24M15.54 8.46l4.24-4.24"/></svg>
        <span>{t('canvas.quickCreate')}</span>
      </div>
      <div
        className="canvas-context-menu-item"
        onClick={() => handleQuickCreate('text')}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        <span>{t('canvas.quickCreateSticky')}</span>
      </div>
      <div
        className="canvas-context-menu-item"
        onClick={() => handleQuickCreate('file')}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <span>{t('canvas.quickCreateNote')}</span>
      </div>
      <div
        className="canvas-context-menu-item"
        onClick={() => handleQuickCreate('web')}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
        <span>{t('canvas.addWeb')}</span>
      </div>
      {quickConnectSuggestions.length > 0 && (
        <>
          <div className="canvas-context-menu-divider" />
          <div className="canvas-context-menu-label">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            <span>{t('canvas.relatedNotes')}</span>
          </div>
          {quickConnectSuggestions.map(s => (
            <div
              key={s.path}
              className="canvas-context-menu-item canvas-suggest-item"
              onClick={() => handleQuickConnectSimilar(s.path)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              <span className="canvas-suggest-label">{s.label}</span>
              {s.similarity !== undefined && (
                <span className="canvas-suggest-score">{s.similarity}%</span>
              )}
            </div>
          ))}
        </>
      )}
    </div>
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
