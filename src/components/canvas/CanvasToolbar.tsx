import { t } from '../../lib/i18n';

interface CanvasToolbarProps {
  handleNewCanvas: () => void;
  handleOpenCanvas: () => void;
  handleSaveCanvas: () => void;
  openAddNoteModal: () => void;
  handleAddTextNode: () => void;
  handleAddGroupNode: () => void;
  handleAddWebNode: () => void;
  handleAddPdfNode: () => void;
  reactFlowInstance: any;
  diagnosticResults: any;
  handleDiagnoseCanvas: () => void;
  isDiagnosticRunning: boolean;
  smartCanvasOpen: boolean;
  setSmartCanvasOpen: (open: boolean | ((p: boolean) => boolean)) => void;
}

export function CanvasToolbar({
  handleNewCanvas,
  handleOpenCanvas,
  handleSaveCanvas,
  openAddNoteModal,
  handleAddTextNode,
  handleAddGroupNode,
  handleAddWebNode,
  handleAddPdfNode,
  reactFlowInstance,
  diagnosticResults,
  handleDiagnoseCanvas,
  isDiagnosticRunning,
  smartCanvasOpen,
  setSmartCanvasOpen,
}: CanvasToolbarProps) {
  return (
    <div className="canvas-toolbar">
      <button className="canvas-toolbar-btn" onClick={handleNewCanvas} data-tooltip={t('canvas.new')}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      </button>
      <button className="canvas-toolbar-btn" onClick={handleOpenCanvas} data-tooltip={t('canvas.open')}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      </button>
      <button className="canvas-toolbar-btn" onClick={handleSaveCanvas} data-tooltip={t('canvas.save')}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
      </button>
      <div className="canvas-toolbar-divider" />
      <button className="canvas-toolbar-btn" onClick={openAddNoteModal} data-tooltip={t('canvas.addNote')}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
      <button className="canvas-toolbar-btn" onClick={handleAddTextNode} data-tooltip={t('canvas.addSticky')}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
      </button>
      <button className="canvas-toolbar-btn" onClick={handleAddGroupNode} data-tooltip={t('canvas.addGroup')}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" strokeDasharray="3 3"/></svg>
      </button>
      <button className="canvas-toolbar-btn" onClick={handleAddWebNode} data-tooltip={t('canvas.addWeb')}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
      </button>
      <button className="canvas-toolbar-btn" onClick={handleAddPdfNode} data-tooltip={t('canvas.addPdf')}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
      </button>
      <div className="canvas-toolbar-divider" />
      <button
        className="canvas-toolbar-btn"
        onClick={() => reactFlowInstance.fitView({ padding: 0.15, duration: 400 })}
        data-tooltip={t('canvas.fitView')}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
        </svg>
      </button>
      <button
        className={`canvas-toolbar-btn ${diagnosticResults ? 'canvas-mode-active' : ''}`}
        onClick={handleDiagnoseCanvas}
        disabled={isDiagnosticRunning}
        data-tooltip={t('canvas.diagnose')}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
        </svg>
      </button>
      <button
        className={`canvas-toolbar-btn ${smartCanvasOpen ? 'canvas-mode-active' : ''}`}
        onClick={() => setSmartCanvasOpen(!smartCanvasOpen)}
        data-tooltip={t('canvas.smartCanvas')}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2l2.09 6.26L20 10l-5.91 1.74L12 18l-2.09-6.26L4 10l5.91-1.74z"/><path d="M19 16l1 3 3 1-3 1-1 3-1-3-3-1 3-1z"/>
        </svg>
      </button>
    </div>
  );
}
