import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useApp } from '../../contexts/AppContext';
import { readMarkdownFile, writeMarkdownFile } from '../../lib/tauri';
import { t } from '../../lib/i18n';
import { IconFile, IconDownload } from '../icons';
import { MilkdownEditor } from './MilkdownEditor';
import { PropertiesEditor, parseFrontmatter, serializeFrontmatter } from './PropertiesEditor';
import { KnowledgeTimeline } from '../temporal/KnowledgeTimeline';
import { BacklinksPanel } from './BacklinksPanel';
import { OutlinePanel } from './OutlinePanel';
import { exportAsHtml, exportAsPdf } from '../../lib/exportNote';
import { saveSnapshot, getSnapshots, FileSnapshot } from '../../lib/snapshots';
import { TimelinePanel } from './TimelinePanel';
import { DiffEditorView } from './DiffEditorView';

interface DiffLine {
  value: string;
  type: 'added' | 'removed' | 'unchanged';
  oldLineNum?: number;
  newLineNum?: number;
}

interface DiffStats {
  additions: number;
  deletions: number;
  unchanged: number;
}

function getDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const diff: DiffLine[] = [];
  
  let i = 0;
  let j = 0;
  let oldLineNum = 0;
  let newLineNum = 0;
  
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      oldLineNum++;
      newLineNum++;
      diff.push({ value: oldLines[i], type: 'unchanged', oldLineNum, newLineNum });
      i++;
      j++;
    } else {
      let foundMatch = false;
      for (let k = 1; k < 10; k++) {
        if (i + k < oldLines.length && oldLines[i + k] === newLines[j]) {
          for (let m = 0; m < k; m++) {
            oldLineNum++;
            diff.push({ value: oldLines[i + m], type: 'removed', oldLineNum });
          }
          i += k;
          foundMatch = true;
          break;
        }
        if (j + k < newLines.length && oldLines[i] === newLines[j + k]) {
          for (let m = 0; m < k; m++) {
            newLineNum++;
            diff.push({ value: newLines[j + m], type: 'added', newLineNum });
          }
          j += k;
          foundMatch = true;
          break;
        }
      }
      if (!foundMatch) {
        if (i < oldLines.length) {
          oldLineNum++;
          diff.push({ value: oldLines[i], type: 'removed', oldLineNum });
          i++;
        }
        if (j < newLines.length) {
          newLineNum++;
          diff.push({ value: newLines[j], type: 'added', newLineNum });
          j++;
        }
      }
    }
  }
  return diff;
}

function getDiffStats(diff: DiffLine[]): DiffStats {
  let additions = 0, deletions = 0, unchanged = 0;
  for (const line of diff) {
    if (line.type === 'added') additions++;
    else if (line.type === 'removed') deletions++;
    else unchanged++;
  }
  return { additions, deletions, unchanged };
}

function getRelativeTime(timestamp: number, lang: 'zh' | 'en' | 'ja' | 'ko'): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const isZh = lang === 'zh';
  if (seconds < 60) return isZh ? '刚刚' : 'just now';
  if (minutes < 60) return isZh ? `${minutes} 分钟前` : `${minutes}m ago`;
  if (hours < 24) return isZh ? `${hours} 小时前` : `${hours}h ago`;
  if (days < 7) return isZh ? `${days} 天前` : `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/**
 * Wrapper that strips YAML frontmatter before passing to MilkdownEditor
 * and prepends it back when MilkdownEditor emits changes.
 * This prevents Milkdown from processing/mangling the YAML block.
 *
 * KEY DESIGN: We only propagate onChange when the user actually edits the body
 * in Milkdown. We suppress the onChange that fires from replaceAll() when
 * the content prop changes externally (e.g. from PropertiesEditor).
 */
function MilkdownEditorWithFrontmatter({
  content,
  onChange,
}: {
  content: string;
  onChange: (newContent: string) => void;
}) {
  const { fields, body } = useMemo(() => parseFrontmatter(content), [content]);
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;

  // Track the body we last sent to Milkdown to detect external vs user changes
  const lastPushedBodyRef = useRef(body);
  // Start suppressed: Milkdown fires markdownUpdated on initialization
  const suppressNextOnChangeRef = useRef(true);

  // When content prop changes (e.g. PropertiesEditor edited frontmatter),
  // we need to suppress the markdownUpdated from the resulting replaceAll
  useEffect(() => {
    if (body !== lastPushedBodyRef.current) {
      suppressNextOnChangeRef.current = true;
      lastPushedBodyRef.current = body;
    }
  }, [body]);

  const handleBodyChange = useCallback((newBody: string) => {
    // If this onChange was triggered by replaceAll (external prop change),
    // suppress it to avoid the infinite loop
    if (suppressNextOnChangeRef.current) {
      suppressNextOnChangeRef.current = false;
      // Update our ref to whatever Milkdown reformatted the body as
      lastPushedBodyRef.current = newBody;
      return;
    }

    lastPushedBodyRef.current = newBody;

    // User actually edited — reconstruct full content with frontmatter
    if (fieldsRef.current.length > 0) {
      onChange(serializeFrontmatter(fieldsRef.current, newBody));
    } else {
      onChange(newBody);
    }
  }, [onChange]);

  return <MilkdownEditor value={body} onChange={handleBodyChange} />;
}

interface MarkdownViewerProps {
  /** Override the active file path for this pane (used by split editor secondary pane) */
  filePath?: string | null;
  /** Pane identifier — 'primary' shows the tab bar, 'secondary' shows a close button */
  paneId?: 'primary' | 'secondary';
}

export function MarkdownViewer({ filePath, paneId = 'primary' }: MarkdownViewerProps) {
  const { state, closeTab, setCurrentFile, setView, showToast, reorderTabs, toggleSplitView, closeSplit } = useApp();

  // Resolve which file this pane is editing
  const activeFile = filePath !== undefined ? filePath : state.currentFile;
  const isSecondary = paneId === 'secondary';

  // Tab drag-and-drop state (mouse-event based, since HTML5 DnD is unreliable in Tauri WebView2)
  const [tabDragState, setTabDragState] = useState<{
    dragging: boolean;
    fromIndex: number;
    overIndex: number | null;
  } | null>(null);
  const tabRefs = useRef<(HTMLDivElement | null)[]>([]);
  const activeDragIndexRef = useRef<number | null>(null);
  const [editContent, setEditContent] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHelpModal, setShowHelpModal] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exportStatus, setExportStatus] = useState<'idle' | 'exporting' | 'success' | 'error'>('idle');
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'unsaved'>('saved');

  // Recovery snapshot states
  const [showRecoveryModal, setShowRecoveryModal] = useState(false);
  const [snapshots, setSnapshots] = useState<FileSnapshot[]>([]);
  const [selectedSnapshot, setSelectedSnapshot] = useState<FileSnapshot | null>(null);
  const [snapshotDiff, setSnapshotDiff] = useState<DiffLine[]>([]);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [showChangesOnly, setShowChangesOnly] = useState(false);

  // Inline timeline + diff view state (VS Code-style)
  const [showTimelinePanel, setShowTimelinePanel] = useState(false);
  const [inlineDiffSnapshot, setInlineDiffSnapshot] = useState<FileSnapshot | null>(null);

  const panelContentRef = useRef<HTMLDivElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadFile = useCallback(async () => {
    if (!activeFile) { setEditContent(''); return; }
    setIsLoading(true); setError(null);
    try { const data = await readMarkdownFile(activeFile); setEditContent(data); }
    catch (err) { setError(String(err)); }
    finally { setIsLoading(false); }
  }, [activeFile]);

  // Load file when it changes
  useEffect(() => {
    loadFile();
  }, [activeFile, loadFile]);

  // Note: frontmatter parsing is handled by MilkdownEditorWithFrontmatter internally

  // Auto-save debounced handler wrapper (needed to pass to handleChange)
  const handleChange = useCallback((newContent: string) => {
    setEditContent(newContent);
    setSaveStatus('unsaved');

    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }

    autoSaveTimerRef.current = setTimeout(async () => {
      if (!activeFile) return;
      setSaveStatus('saving');
      try {
        await writeMarkdownFile(activeFile, newContent);
        setSaveStatus('saved');
        await saveSnapshot(activeFile, newContent);
      } catch (err) {
        setError(String(err));
        setSaveStatus('unsaved');
      }
    }, 1500);
  }, [activeFile]);

  const loadSnapshots = useCallback(async () => {
    if (!activeFile) return;
    setSnapshotLoading(true);
    const list = await getSnapshots(activeFile);
    setSnapshots(list);
    setSelectedSnapshot(null);
    setSnapshotDiff([]);
    setSnapshotLoading(false);
  }, [activeFile]);

  const handleSelectSnapshot = (snap: FileSnapshot) => {
    setSelectedSnapshot(snap);
    const diff = getDiff(snap.content, editContent);
    setSnapshotDiff(diff);
  };

  const handleRestoreSnapshot = async (snap: FileSnapshot) => {
    if (!activeFile) return;
    try {
      setSaveStatus('saving');
      await writeMarkdownFile(activeFile, snap.content);
      setEditContent(snap.content);
      setSaveStatus('saved');
      setShowRecoveryModal(false);
      await loadFile();
    } catch (err) {
      console.error('Failed to restore snapshot:', err);
      setError(String(err));
    }
  };


  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
  }, []);

  // Flush pending save when changing file
  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, [activeFile]);

  const getFileName = (path: string) => { const parts = path.replace(/\\/g, '/').split('/'); return parts[parts.length - 1].replace(/\.md$/, ''); };

  // Shared tab drag handler (handles both tab bars)
  const handleTabMouseDown = useCallback((e: React.MouseEvent, tabIdx: number) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.tab-close-btn')) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let started = false;

    const onMouseMove = (ev: MouseEvent) => {
      if (!started && (Math.abs(ev.clientX - startX) > 5 || Math.abs(ev.clientY - startY) > 5)) {
        started = true;
        activeDragIndexRef.current = tabIdx;
        setTabDragState({ dragging: true, fromIndex: tabIdx, overIndex: null });
      }
      if (started && activeDragIndexRef.current !== null) {
        const elements = tabRefs.current;
        const curIdx = activeDragIndexRef.current;
        
        let closestIdx = curIdx;
        let minDistance = Infinity;
        for (let i = 0; i < elements.length; i++) {
          const el = elements[i];
          if (el && i < state.openFiles.length) {
            const rect = el.getBoundingClientRect();
            const center = rect.left + rect.width / 2;
            const dist = Math.abs(ev.clientX - center);
            if (dist < minDistance) {
              minDistance = dist;
              closestIdx = i;
            }
          }
        }
        
        if (closestIdx !== curIdx) {
          reorderTabs(curIdx, closestIdx);
          activeDragIndexRef.current = closestIdx;
          setTabDragState({ dragging: true, fromIndex: closestIdx, overIndex: null });
        }
      }
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      activeDragIndexRef.current = null;
      setTabDragState(null);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [reorderTabs, state.openFiles]);

  // Close export menu on outside click
  useEffect(() => {
    if (!showExportMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showExportMenu]);

  const handleExportHtml = async () => {
    setShowExportMenu(false);
    const el = panelContentRef.current?.querySelector('.milkdown-editor-container .ProseMirror') as HTMLElement;
    if (!el || !activeFile) return;
    setExportStatus('exporting');
    try {
      const ok = await exportAsHtml(el, getFileName(activeFile));
      setExportStatus(ok ? 'success' : 'idle');
      if (ok) setTimeout(() => setExportStatus('idle'), 2000);
    } catch {
      setExportStatus('error');
      setTimeout(() => setExportStatus('idle'), 2000);
    }
  };

  const handleExportPdf = () => {
    setShowExportMenu(false);
    const el = panelContentRef.current?.querySelector('.milkdown-editor-container .ProseMirror') as HTMLElement;
    if (!el || !activeFile) return;
    exportAsPdf(el, getFileName(activeFile));
  };


  const closeSplitButton = (variant: 'icon' | 'text' = 'icon') => (
    <button
      type="button"
      className={variant === 'text' ? 'split-close-text-btn' : 'btn btn-ghost btn-icon-sm split-close-btn'}
      onClick={closeSplit}
      title={t('viewer.closeSplit')}
    >
      {variant === 'text' ? (
        t('viewer.closeSplit')
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      )}
    </button>
  );

  if (!activeFile) {
    return (
      <div className={`panel ${isSecondary ? 'panel-split-secondary' : ''}`}>
        {!isSecondary && state.openFiles && state.openFiles.length > 0 && (
          <div className={`tab-bar ${tabDragState?.dragging ? 'dragging' : ''}`}>
            {state.openFiles.map((tpath, tabIdx) => {
              const parts = tpath.replace(/\\/g, '/').split('/');
              const name = parts[parts.length - 1].replace(/\.md$/, '');
              const isDragging = tabDragState?.dragging && tabDragState.fromIndex === tabIdx;
              return (
                <div
                  key={tpath}
                  className={`tab-item ${isDragging ? 'dragging' : ''}`}
                  ref={(el) => { tabRefs.current[tabIdx] = el; }}
                  onMouseDown={(e) => handleTabMouseDown(e, tabIdx)}
                  onClick={() => {
                    setCurrentFile(tpath);
                    setView('note');
                  }}
                >
                  <span style={{ display: 'flex', flexShrink: 0, alignItems: 'center' }}><IconFile size={12} /></span>
                  <span className="tab-item-name">{name}</span>
                  <span
                    className="tab-close-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tpath);
                    }}
                  >
                    &times;
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {state.isSplitView && (
          <div className="panel-header split-pane-empty-header">
            <span className="split-pane-empty-label">
              {isSecondary
                ? (state.lang === 'zh' ? '分屏面板' : 'Split pane')
                : (state.lang === 'zh' ? '未选择笔记' : 'No note selected')}
            </span>
            {closeSplitButton(isSecondary ? 'text' : 'icon')}
          </div>
        )}
        <div className="panel-content">
          <div className="empty-state">
            <IconFile size={48} />
            <div className="empty-state-title">{t('viewer.noNote')}</div>
            <div className="empty-state-description">{t('viewer.noNoteDesc')}</div>
            {state.isSplitView && (
              <button type="button" className="split-close-text-btn split-close-text-btn--center" onClick={closeSplit}>
                {t('viewer.closeSplit')}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`panel ${isSecondary ? 'panel-split-secondary' : ''}`}>
      {/* Tab bar only shown in primary pane */}
      {!isSecondary && state.openFiles && state.openFiles.length > 0 && (
        <div className={`tab-bar ${tabDragState?.dragging ? 'dragging' : ''}`}>
          {state.openFiles.map((tpath, tabIdx) => {
            const isActive = activeFile === tpath;
            const parts = tpath.replace(/\\/g, '/').split('/');
            const name = parts[parts.length - 1].replace(/\.md$/, '');
            const isDragging = tabDragState?.dragging && tabDragState.fromIndex === tabIdx;
            return (
              <div
                key={tpath}
                className={`tab-item ${isActive ? 'active' : ''} ${isDragging ? 'dragging' : ''}`}
                ref={(el) => { tabRefs.current[tabIdx] = el; }}
                onMouseDown={(e) => handleTabMouseDown(e, tabIdx)}
                onClick={() => {
                  setCurrentFile(tpath);
                  setView('note');
                }}
              >
                <span style={{ display: 'flex', flexShrink: 0, alignItems: 'center' }}><IconFile size={12} /></span>
                <span className="tab-item-name">{name}</span>
                <span
                  className="tab-close-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tpath);
                  }}
                >
                  &times;
                </span>
              </div>
            );
          })}
        </div>
      )}
      <div className="panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <span style={{ fontSize: 'var(--text-lg)', fontWeight: 600 }}>{getFileName(activeFile)}</span>
          <span className="badge badge-default">{t('viewer.markdown')}</span>
          {/* Auto-save indicator */}
          <span style={{
            fontSize: '11px',
            color: saveStatus === 'saved' ? 'var(--text-tertiary)' : saveStatus === 'saving' ? 'var(--accent-primary)' : '#f59e0b',
            fontWeight: 500,
            transition: 'color 0.3s',
          }}>
            {saveStatus === 'saved' ? '' : saveStatus === 'saving' ? t('viewer.saving') : t('viewer.unsaved')}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'center' }}>
          {/* Split editor toggle (primary pane only) */}
          {!isSecondary && (
            <button
              className="btn btn-ghost btn-icon-sm"
              onClick={toggleSplitView}
              title={state.lang === 'zh' ? '分屏编辑 (Split Editor)' : 'Split Editor'}
              style={{ width: '28px', height: '28px', borderRadius: '50%', border: '1px solid rgba(0,0,0,0.08)', padding: 0, display: 'flex', justifyContent: 'center', alignItems: 'center', color: state.isSplitView ? 'var(--accent-primary)' : undefined }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="12" y1="3" x2="12" y2="21" />
              </svg>
            </button>
          )}
          {state.isSplitView && closeSplitButton(isSecondary ? 'text' : 'icon')}
          {/* Export dropdown */}
          <div ref={exportMenuRef} style={{ position: 'relative' }}>
            <button
              className="btn btn-ghost btn-icon-sm"
              onClick={() => setShowExportMenu(!showExportMenu)}
              title={t('viewer.export') || 'Export'}
              style={{ width: '28px', height: '28px', borderRadius: '50%', border: '1px solid rgba(0,0,0,0.08)', padding: 0, display: 'flex', justifyContent: 'center', alignItems: 'center' }}
            >
              {exportStatus === 'exporting' ? (
                <span className="spinner" style={{ width: '14px', height: '14px' }} />
              ) : exportStatus === 'success' ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              ) : (
                <IconDownload size={14} />
              )}
            </button>
            {showExportMenu && (
              <div style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                marginTop: '4px',
                background: '#FFFFFF',
                border: '1px solid rgba(0,0,0,0.1)',
                borderRadius: '8px',
                boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                zIndex: 100,
                minWidth: '160px',
                overflow: 'hidden',
                animation: 'fadeIn 0.15s ease-out',
              }}>
                <button
                  onClick={handleExportHtml}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    width: '100%', padding: '10px 14px',
                    border: 'none', background: 'none', cursor: 'pointer',
                    fontSize: '13px', color: '#1E293B', textAlign: 'left',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = '#F1F5F9')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                  {t('viewer.exportHtml') || 'Export as HTML'}
                </button>
                <div style={{ height: '1px', background: 'rgba(0,0,0,0.06)' }} />
                <button
                  onClick={handleExportPdf}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    width: '100%', padding: '10px 14px',
                    border: 'none', background: 'none', cursor: 'pointer',
                    fontSize: '13px', color: '#1E293B', textAlign: 'left',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = '#F1F5F9')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 15v-2h6v2"/><path d="M12 13v5"/></svg>
                  {t('viewer.exportPdf') || 'Export as PDF'}
                </button>
              </div>
            )}
          </div>
          {/* Timeline toggle (VS Code-style inline timeline) */}
          <button
            className="btn btn-ghost btn-icon-sm"
            onClick={() => setShowTimelinePanel(!showTimelinePanel)}
            title={state.lang === 'zh' ? '时间线 (Timeline)' : 'Timeline'}
            style={{
              width: '28px', height: '28px', borderRadius: '50%', border: '1px solid rgba(0,0,0,0.08)',
              padding: 0, display: 'flex', justifyContent: 'center', alignItems: 'center',
              color: showTimelinePanel ? 'var(--accent-primary)' : undefined,
              background: showTimelinePanel ? 'rgba(99, 102, 241, 0.08)' : undefined,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <circle cx="3.5" cy="6" r="1.5" />
              <circle cx="3.5" cy="12" r="1.5" />
              <circle cx="3.5" cy="18" r="1.5" />
            </svg>
          </button>
          <button
            className="btn btn-ghost btn-icon-sm"
            onClick={() => {
              loadSnapshots();
              setShowRecoveryModal(true);
            }}
            title={state.lang === 'zh' ? '文件恢复 (File Recovery)' : 'File Recovery'}
            style={{ width: '28px', height: '28px', borderRadius: '50%', border: '1px solid rgba(0,0,0,0.08)', padding: 0, display: 'flex', justifyContent: 'center', alignItems: 'center' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
              <polyline points="3 3 3 8 8 8"/>
              <line x1="12" y1="7" x2="12" y2="12"/>
              <line x1="12" y1="12" x2="16" y2="14"/>
            </svg>
          </button>
          <button
            className="btn btn-ghost btn-icon-sm"
            onClick={() => setShowTimeline(true)}
            title={t('viewer.timeline') || 'Knowledge Timeline'}
            style={{ width: '28px', height: '28px', borderRadius: '50%', border: '1px solid rgba(0,0,0,0.08)', padding: 0, display: 'flex', justifyContent: 'center', alignItems: 'center' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </button>
          <button 
            className="btn btn-ghost btn-icon-sm" 
            onClick={() => setShowHelpModal(true)} 
            title={t('viewer.helpTitle')} 
            style={{ width: '28px', height: '28px', borderRadius: '50%', border: '1px solid rgba(0,0,0,0.08)', padding: 0, display: 'flex', justifyContent: 'center', alignItems: 'center' }}
          >
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>?</span>
          </button>
        </div>
      </div>

      <div
        className="panel-content"
        ref={panelContentRef}
        style={{
          padding: inlineDiffSnapshot ? 0 : (showTimelinePanel ? 0 : 'var(--space-4)'),
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {inlineDiffSnapshot && activeFile ? (
          /* Inline diff view (VS Code-style — replaces editor content) */
          <DiffEditorView
            filePath={activeFile}
            snapshotTimestamp={inlineDiffSnapshot.timestamp}
            snapshotId={inlineDiffSnapshot.id}
            currentContent={editContent}
            onRestore={async (content) => {
              try {
                setSaveStatus('saving');
                await writeMarkdownFile(activeFile, content);
                setEditContent(content);
                setSaveStatus('saved');
                setInlineDiffSnapshot(null);
                showToast(state.lang === 'zh' ? '已恢复到历史版本' : 'Restored to selected version', 'success');
              } catch (err) {
                setError(String(err));
                setSaveStatus('unsaved');
              }
            }}
            onBack={() => setInlineDiffSnapshot(null)}
            lang={state.lang}
          />
        ) : showTimelinePanel && activeFile ? (
          /* Timeline panel + editor side by side (VS Code-style) */
          <div className="timeline-editor-layout">
            <TimelinePanel
              filePath={activeFile}
              currentContent={editContent}
              onSelectSnapshot={(snap) => {
                setInlineDiffSnapshot(snap);
                setShowTimelinePanel(false);
              }}
              lang={state.lang}
            />
            <div className="timeline-editor-main" style={{ padding: 'var(--space-4)', overflowY: 'auto' }}>
              <OutlinePanel content={editContent} lang={state.lang} />
              <PropertiesEditor content={editContent} onChange={handleChange} lang={state.lang} />
              <MilkdownEditorWithFrontmatter content={editContent} onChange={handleChange} />
              {!isLoading && !error && activeFile && (
                <BacklinksPanel filePath={activeFile} />
              )}
            </div>
          </div>
        ) : isLoading ? (
          <div className="empty-state"><span className="spinner" /><div className="empty-state-title">{t('viewer.loading')}</div></div>
        ) : error ? (
          <div className="empty-state"><div className="empty-state-title">{t('viewer.error')}</div><div className="empty-state-description">{error}</div></div>
        ) : (
          <div className="viewer-document-container">
            {/* Outline panel at the top */}
            <OutlinePanel content={editContent} lang={state.lang} />

            <PropertiesEditor
              content={editContent}
              onChange={handleChange}
              lang={state.lang}
            />
            <MilkdownEditorWithFrontmatter content={editContent} onChange={handleChange} />

            {/* Backlinks panel at bottom */}
            {!isLoading && !error && activeFile && (
              <BacklinksPanel filePath={activeFile} />
            )}
          </div>
        )}
      </div>

      {showTimeline && (
        <div className="modal-overlay" onClick={() => setShowTimeline(false)}>
          <div className="modal-container" style={{ width: 560, maxWidth: '95vw' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">{t('viewer.timeline')}</h3>
              <button className="modal-close-btn" onClick={() => setShowTimeline(false)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <div className="modal-content">
              <KnowledgeTimeline notePath={activeFile || undefined} />
            </div>

            <div className="file-recovery-footer">
              <button className="btn btn-primary btn-sm" onClick={() => setShowTimeline(false)}>
                {t('common.close') || 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showHelpModal && (
        <div className="modal-overlay" onClick={() => setShowHelpModal(false)}>
          <div className="modal-container org-guide-modal" onClick={(e) => e.stopPropagation()}>
            <div className="org-guide-header">
              <div className="org-guide-header-main">
                <div className="org-guide-icon" aria-hidden="true">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2l2.09 6.26L20 10l-5.91 1.74L12 18l-2.09-6.26L4 10l5.91-1.74z"/>
                    <circle cx="18" cy="18" r="3"/>
                  </svg>
                </div>
                <div>
                  <h3 className="org-guide-title">{t('viewer.helpTitle')}</h3>
                  <p className="org-guide-subtitle">{t('viewer.helpSubtitle')}</p>
                </div>
              </div>
              <button className="modal-close-btn" onClick={() => setShowHelpModal(false)} aria-label={t('common.close')}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <div className="org-guide-body">
              <section className="org-guide-section">
                <div className="org-guide-section-head">
                  <span className="org-guide-section-badge">01</span>
                  <div>
                    <h4 className="org-guide-section-title">{t('viewer.helpTypes')}</h4>
                    <p className="org-guide-section-desc">{t('viewer.helpTypesDesc')}</p>
                  </div>
                </div>
                <div className="org-guide-type-grid">
                  {([
                    { key: 'permanent', label: t('viewer.helpTypePermanent'), desc: t('viewer.helpPermanent'), tone: 'emerald' },
                    { key: 'literature', label: t('viewer.helpTypeLiterature'), desc: t('viewer.helpLiterature'), tone: 'blue' },
                    { key: 'fleeting', label: t('viewer.helpTypeFleeting'), desc: t('viewer.helpFleeting'), tone: 'amber' },
                    { key: 'structure', label: t('viewer.helpTypeStructure'), desc: t('viewer.helpStructure'), tone: 'violet' },
                  ] as const).map((item) => (
                    <article key={item.key} className={`org-guide-type-card org-guide-type-card--${item.tone}`}>
                      <span className="org-guide-type-label">{item.label}</span>
                      <p className="org-guide-type-desc">{item.desc}</p>
                    </article>
                  ))}
                </div>
              </section>

              <section className="org-guide-section">
                <div className="org-guide-section-head">
                  <span className="org-guide-section-badge">02</span>
                  <div>
                    <h4 className="org-guide-section-title">{t('viewer.helpMarkers')}</h4>
                    <p className="org-guide-section-desc">{t('viewer.helpMarkersDesc')}</p>
                  </div>
                </div>

                <div className="org-guide-zone org-guide-zone--ai">
                  <div className="org-guide-zone-tag">
                    <code>&lt;!-- @generated --&gt;</code>
                  </div>
                  <div className="org-guide-zone-copy">
                    <strong>{t('viewer.helpGeneratedLabel')}</strong>
                    <p>{t('viewer.helpGenerated')}</p>
                  </div>
                </div>

                <div className="org-guide-zone org-guide-zone--user">
                  <div className="org-guide-zone-tag">
                    <code>&lt;!-- @user --&gt;</code>
                  </div>
                  <div className="org-guide-zone-copy">
                    <strong>{t('viewer.helpUserLabel')}</strong>
                    <p>{t('viewer.helpUser')}</p>
                  </div>
                </div>

                <div className="org-guide-tip">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
                  </svg>
                  <span>{t('viewer.helpTip')}</span>
                </div>
              </section>
            </div>

            <div className="modal-footer">
              <button type="button" className="btn btn-primary org-guide-ok-btn" onClick={() => setShowHelpModal(false)}>
                {t('common.ok')}
              </button>
            </div>
          </div>
        </div>
      )}
      {showRecoveryModal && (
        <div className="file-recovery-overlay" onClick={() => setShowRecoveryModal(false)}>
          <div className="file-recovery-modal" onClick={(e) => e.stopPropagation()}>
            <div className="file-recovery-header">
              <h3 className="file-recovery-title">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                </svg>
                {state.lang === 'zh' ? '文件恢复' : 'File Recovery'} — {getFileName(activeFile)}
              </h3>
              <button className="file-recovery-close" onClick={() => setShowRecoveryModal(false)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <div className="file-recovery-body">
              {/* Left Column: Snapshot List */}
              <div className="file-recovery-sidebar">
                <div className="file-recovery-sidebar-title">
                  {state.lang === 'zh' ? '历史快照版本' : 'Snapshots History'}
                  {snapshots.length > 0 && (
                    <span className="file-recovery-sidebar-count">{snapshots.length}</span>
                  )}
                </div>
                {snapshotLoading ? (
                  <div className="file-recovery-empty">
                    <span className="diff-approval-spinner" />
                    <span className="file-recovery-empty-text">
                      {state.lang === 'zh' ? '加载中...' : 'Loading...'}
                    </span>
                  </div>
                ) : snapshots.length === 0 ? (
                  <div className="file-recovery-empty">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                    </svg>
                    <div className="file-recovery-empty-text">
                      {state.lang === 'zh' ? '暂无快照记录' : 'No snapshots found'}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', opacity: 0.7, maxWidth: '180px', lineHeight: '1.5' }}>
                      {state.lang === 'zh' ? '编辑笔记后会自动保存快照' : 'Snapshots are saved automatically when you edit'}
                    </div>
                  </div>
                ) : (
                  snapshots.map((snap, snapIdx) => {
                    const dateStr = new Date(snap.timestamp).toLocaleString();
                    const relativeTime = getRelativeTime(snap.timestamp, state.lang);
                    const sizeKB = (snap.content.length / 1024).toFixed(2);
                    const isSelected = selectedSnapshot?.id === snap.id;
                    const isLatest = snapIdx === 0;
                    return (
                      <button
                        key={snap.id}
                        className={`snapshot-card ${isSelected ? 'selected' : ''}`}
                        onClick={() => handleSelectSnapshot(snap)}
                      >
                        <div className="snapshot-card-header">
                          <span className="snapshot-card-time">{dateStr}</span>
                          {isLatest && (
                            <span className="snapshot-card-badge">
                              {state.lang === 'zh' ? '最新' : 'Latest'}
                            </span>
                          )}
                        </div>
                        <span className="snapshot-card-relative">{relativeTime}</span>
                        <span className="snapshot-card-size">{sizeKB} KB · {snap.content.length} {state.lang === 'zh' ? '字符' : 'chars'}</span>
                      </button>
                    );
                  })
                )}
              </div>

              {/* Right Column: Comparison Diff */}
              <div className="file-recovery-diff-panel">
                {selectedSnapshot ? (
                  <>
                    <div className="file-recovery-diff-header">
                      <div className="file-recovery-diff-header-left">
                        <span className="file-recovery-diff-info">
                          {state.lang === 'zh'
                            ? `快照 ${new Date(selectedSnapshot.timestamp).toLocaleTimeString()} → 当前`
                            : `Snapshot ${new Date(selectedSnapshot.timestamp).toLocaleTimeString()} → Current`}
                        </span>
                        {/* Diff stats badges */}
                        {(() => {
                          const stats = getDiffStats(snapshotDiff);
                          return (
                            <div className="file-recovery-diff-stats">
                              <span className="diff-stat diff-stat-additions">+{stats.additions}</span>
                              <span className="diff-stat diff-stat-deletions">-{stats.deletions}</span>
                              {stats.unchanged > 0 && (
                                <span className="diff-stat diff-stat-unchanged">~{stats.unchanged}</span>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                      <div className="file-recovery-diff-actions">
                        {/* Show changes only toggle */}
                        <button
                          className={`btn btn-sm ${showChangesOnly ? 'btn-primary' : 'btn-secondary'}`}
                          onClick={() => setShowChangesOnly(!showChangesOnly)}
                          title={state.lang === 'zh' ? '仅显示变更行' : 'Show changes only'}
                          style={{ gap: '4px', fontSize: '11px' }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>
                          </svg>
                          {state.lang === 'zh' ? '仅变更' : 'Changes'}
                        </button>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            navigator.clipboard.writeText(selectedSnapshot.content);
                            showToast(state.lang === 'zh' ? '已复制快照内容' : 'Copied snapshot content', 'success');
                          }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                          {state.lang === 'zh' ? '复制' : 'Copy'}
                        </button>
                        <button
                          className="btn btn-primary btn-sm btn-success"
                          onClick={() => handleRestoreSnapshot(selectedSnapshot)}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                          </svg>
                          {state.lang === 'zh' ? '恢复此版本' : 'Restore'}
                        </button>
                      </div>
                    </div>

                    {/* Diff Scroll Container */}
                    <div className="file-recovery-diff-container">
                      {(showChangesOnly
                        ? snapshotDiff.filter(l => l.type !== 'unchanged')
                        : snapshotDiff
                      ).map((line, idx) => {
                        const lineClass = line.type === 'added' ? 'diff-line-added'
                          : line.type === 'removed' ? 'diff-line-removed' : 'diff-line-unchanged';
                        const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
                        const lineNumStr = line.type === 'added'
                          ? line.newLineNum
                          : line.type === 'removed'
                            ? line.oldLineNum
                            : line.newLineNum;
                        return (
                          <div key={idx} className={`diff-line ${lineClass}`}>
                            <span className="diff-line-gutter">{lineNumStr ?? ''}</span>
                            <span className="diff-line-prefix">{prefix}</span>
                            <span className="diff-line-content">{line.value || ' '}</span>
                          </div>
                        );
                      })}
                      {showChangesOnly && snapshotDiff.filter(l => l.type !== 'unchanged').length === 0 && (
                        <div className="file-recovery-diff-no-changes">
                          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M20 6L9 17l-5-5"/>
                          </svg>
                          <div>{state.lang === 'zh' ? '没有差异' : 'No changes'}</div>
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="file-recovery-select-prompt">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" />
                    </svg>
                    <div className="file-recovery-select-prompt-text">
                      {state.lang === 'zh' ? '在左侧选择一个快照版本进行比对' : 'Select a snapshot from the left to compare'}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="file-recovery-footer">
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setShowRecoveryModal(false)}
              >
                {t('common.close') || 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
