import { useState, useEffect, useMemo, useCallback } from 'react';
import { getNoteSnapshots, NoteSnapshot } from '../../lib/tauri';

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

interface DiffEditorViewProps {
  filePath: string;
  snapshotTimestamp: number;
  snapshotId?: number;
  currentContent: string;
  onRestore: (content: string) => void;
  onBack: () => void;
  lang: 'zh' | 'en' | 'ja' | 'ko';
}

export function DiffEditorView({ filePath, snapshotTimestamp, snapshotId, currentContent, onRestore, onBack, lang }: DiffEditorViewProps) {
  const [oldContent, setOldContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [showChangesOnly, setShowChangesOnly] = useState(false);

  // Load the snapshot content from SQLite
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const snapshots = await getNoteSnapshots(filePath);
        const snap = snapshotId !== undefined
          ? snapshots.find(s => s.id === snapshotId)
          : snapshots.find(s => s.created_at_ms === snapshotTimestamp);
        if (snap && !cancelled) {
          setOldContent(snap.content);
        }
      } catch (err) {
        console.error('Failed to load snapshot for diff:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [filePath, snapshotId, snapshotTimestamp]);

  const diff = useMemo(() => {
    if (!oldContent) return [];
    return getDiff(oldContent, currentContent);
  }, [oldContent, currentContent]);

  const stats = useMemo(() => getDiffStats(diff), [diff]);

  const displayDiff = showChangesOnly ? diff.filter(l => l.type !== 'unchanged') : diff;

  const handleRestore = useCallback(() => {
    onRestore(oldContent);
  }, [oldContent, onRestore]);

  return (
    <div className="diff-editor-view">
      {/* Diff toolbar */}
      <div className="diff-editor-toolbar">
        <div className="diff-editor-toolbar-left">
          <button className="btn btn-ghost btn-sm" onClick={onBack}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="19" y1="12" x2="5" y2="12" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
            {lang === 'zh' ? '返回编辑' : 'Back to Editor'}
          </button>
          <span className="diff-editor-title">
            {lang === 'zh' ? '对比' : 'Comparing'}: {new Date(snapshotTimestamp).toLocaleString()} → {lang === 'zh' ? '当前' : 'Current'}
          </span>
        </div>
        <div className="diff-editor-toolbar-right">
          {/* Stats badges */}
          <div className="diff-editor-stats">
            <span className="diff-stat diff-stat-additions">+{stats.additions}</span>
            <span className="diff-stat diff-stat-deletions">-{stats.deletions}</span>
            {stats.unchanged > 0 && (
              <span className="diff-stat diff-stat-unchanged">~{stats.unchanged}</span>
            )}
          </div>
          {/* Changes only toggle */}
          <button
            className={`btn btn-sm ${showChangesOnly ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setShowChangesOnly(!showChangesOnly)}
            style={{ gap: '4px', fontSize: '11px' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
            </svg>
            {lang === 'zh' ? '仅变更' : 'Changes'}
          </button>
          {/* Restore button */}
          <button
            className="btn btn-primary btn-sm btn-success"
            onClick={handleRestore}
            disabled={loading}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
            {lang === 'zh' ? '恢复此版本' : 'Restore'}
          </button>
        </div>
      </div>

      {/* Split diff view: left = old, right = current */}
      <div className="diff-editor-split">
        {/* Left: old version (snapshot) */}
        <div className="diff-editor-pane diff-editor-pane-old">
          <div className="diff-editor-pane-header">
            <span className="diff-editor-pane-label">
              {new Date(snapshotTimestamp).toLocaleTimeString()}
            </span>
          </div>
          <div className="diff-editor-pane-body">
            {loading ? (
              <div className="diff-editor-loading">
                <span className="diff-approval-spinner" style={{ width: '14px', height: '14px' }} />
                <span>{lang === 'zh' ? '加载中...' : 'Loading...'}</span>
              </div>
            ) : (
              displayDiff.filter(l => l.type !== 'added').map((line, idx) => (
                <div
                  key={idx}
                  className={`diff-line ${line.type === 'removed' ? 'diff-line-removed' : 'diff-line-unchanged'}`}
                >
                  <span className="diff-line-gutter">{line.oldLineNum ?? ''}</span>
                  <span className="diff-line-prefix">{line.type === 'removed' ? '-' : ' '}</span>
                  <span className="diff-line-content">{line.value || ' '}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Divider */}
        <div className="diff-editor-divider" />

        {/* Right: current version */}
        <div className="diff-editor-pane diff-editor-pane-new">
          <div className="diff-editor-pane-header">
            <span className="diff-editor-pane-label">
              {lang === 'zh' ? '当前' : 'Current'}
            </span>
          </div>
          <div className="diff-editor-pane-body">
            {loading ? null : (
              <>
                {displayDiff.filter(l => l.type !== 'removed').map((line, idx) => (
                  <div
                    key={idx}
                    className={`diff-line ${line.type === 'added' ? 'diff-line-added' : 'diff-line-unchanged'}`}
                  >
                    <span className="diff-line-gutter">{line.newLineNum ?? ''}</span>
                    <span className="diff-line-prefix">{line.type === 'added' ? '+' : ' '}</span>
                        <span className="diff-line-content">{line.value || ' '}</span>
                  </div>
                ))}
                {showChangesOnly && displayDiff.length === 0 && (
                  <div className="diff-editor-no-changes">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                    <div>{lang === 'zh' ? '没有差异' : 'No changes'}</div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
