import { useState, useMemo } from 'react';
import { approveToolCall, rejectToolCall } from '../../lib/tauri';
import type { ApprovalDiffData } from '../../lib/tauri';

interface DiffApprovalCardProps {
  approvalId: string;
  actionDescription: string;
  /** Structured diff data JSON from the backend */
  diffJson?: string;
  onResolved: (approved: boolean) => void;
  lang: string;
}

/**
 * DiffApprovalCard — Shows a pending Agent write operation with a real diff view.
 *
 * When `diffJson` is available (backend emits structured data), renders:
 *   - File path header with tool name icon
 *   - Color-coded line-by-line diff for patch/apply_edit tools
 *   - Content preview for create/edit/append/delete
 *   - Path change arrows for rename/move
 *
 * Falls back to a plain `<pre>` text display for backward compatibility.
 */
export function DiffApprovalCard({
  approvalId,
  actionDescription,
  diffJson,
  onResolved,
  lang,
}: DiffApprovalCardProps) {
  const [status, setStatus] = useState<'pending' | 'approving' | 'rejecting'>('pending');
  const [expanded, setExpanded] = useState(false);
  const isZh = lang === 'zh';

  const diffData: ApprovalDiffData | null = useMemo(() => {
    if (!diffJson) return null;
    try {
      return JSON.parse(diffJson) as ApprovalDiffData;
    } catch {
      return null;
    }
  }, [diffJson]);

  const handleApprove = async () => {
    setStatus('approving');
    try {
      await approveToolCall(approvalId);
      onResolved(true);
    } catch (e) {
      console.error('Failed to approve:', e);
      setStatus('pending');
    }
  };

  const handleReject = async () => {
    setStatus('rejecting');
    try {
      await rejectToolCall(approvalId);
      onResolved(false);
    } catch (e) {
      console.error('Failed to reject:', e);
      setStatus('pending');
    }
  };

  // ── Processing state ──────────────────────────────────────────
  if (status !== 'pending') {
    return (
      <div className="diff-approval-card diff-approval-processing">
        <span className="diff-approval-spinner" />
        <span>{isZh ? '处理中...' : 'Processing...'}</span>
      </div>
    );
  }

  // ── Fallback: no structured diff data → show plain text ──────
  if (!diffData) {
    return (
      <div className="diff-approval-card">
        <div className="diff-approval-header">
          <svg className="diff-approval-icon-warn" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <span className="diff-approval-title">
            {isZh ? 'Agent 请求修改文件' : 'Agent requests to modify file'}
          </span>
        </div>
        <div className="diff-approval-body">
          <pre className="diff-approval-preview">{actionDescription}</pre>
        </div>
        <Actions
          isZh={isZh}
          onApprove={handleApprove}
          onReject={handleReject}
          pending={status === 'pending'}
        />
      </div>
    );
  }

  // ── Tool args parsed ──────────────────────────────────────────
  let toolArgs: Record<string, unknown> = {};
  try {
    toolArgs = JSON.parse(diffData.tool_args_json);
  } catch { /* ignore parse errors */ }

  // ── Structured diff view ──────────────────────────────────────
  return (
    <div className="diff-approval-card">
      {/* Header: tool icon + title */}
      <div className="diff-approval-header">
        <span className="diff-approval-icon"><ToolIcon diffType={diffData.diff_type} /></span>
        <div className="diff-approval-title-area">
          <span className="diff-approval-title">{diffData.title}</span>
          {diffData.tool_name !== diffData.diff_type && (
            <span className="diff-approval-subtitle">{diffData.tool_name}</span>
          )}
        </div>
      </div>

      {/* Body: diff-type specific rendering */}
      <div className="diff-approval-body">
        {diffData.diff_type === 'patch' || diffData.diff_type === 'apply_edit' ? (
          <PatchDiffView toolArgs={toolArgs} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
        ) : diffData.diff_type === 'create' ? (
          <CreateView toolArgs={toolArgs} filePath={diffData.file_path} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
        ) : diffData.diff_type === 'edit' ? (
          <EditView toolArgs={toolArgs} filePath={diffData.file_path} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
        ) : diffData.diff_type === 'delete' ? (
          <DeleteView filePath={diffData.file_path} />
        ) : diffData.diff_type === 'append' ? (
          <AppendView toolArgs={toolArgs} filePath={diffData.file_path} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
        ) : diffData.diff_type === 'rename' || diffData.diff_type === 'move' ? (
          <RenameView filePath={diffData.file_path} altPath={diffData.file_path_alt} />
        ) : (
          <FallbackView toolArgs={toolArgs} />
        )}
      </div>

      {/* Actions */}
      <Actions
        isZh={isZh}
        onApprove={handleApprove}
        onReject={handleReject}
        pending={status === 'pending'}
      />
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────

/** SVG icon for each diff type — no emojis per UI/UX guidelines */
function ToolIcon({ diffType }: { diffType: string }) {
  const common = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (diffType) {
    case 'create':
      return <svg {...common}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>;
    case 'delete':
      return <svg {...common}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>;
    case 'edit':
      return <svg {...common}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>;
    case 'patch': case 'apply_edit':
      return <svg {...common}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>;
    case 'append':
      return <svg {...common}><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>;
    case 'rename': case 'move':
      return <svg {...common}><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>;
    default:
      return <svg {...common}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>;
  }
}

// ── Actions ─────────────────────────────────────────────────────────

function Actions({ isZh, onApprove, onReject, pending }: {
  isZh: boolean; onApprove: () => void; onReject: () => void; pending: boolean;
}) {
  return (
    <div className="diff-approval-actions">
      <button className="diff-approval-btn diff-approval-btn-approve" onClick={onApprove} disabled={!pending}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        {isZh ? '批准' : 'Approve'}
      </button>
      <button className="diff-approval-btn diff-approval-btn-reject" onClick={onReject} disabled={!pending}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
        {isZh ? '拒绝' : 'Reject'}
      </button>
    </div>
  );
}

/** Chevron used by expand/collapse toggles — SVG per no-glyph-icon guideline */
function Chevron({ up }: { up: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {up ? <polyline points="18 15 12 9 6 15" /> : <polyline points="6 9 12 15 18 9" />}
    </svg>
  );
}

// ── Patch / Apply Edit: real line diff ──────────────────────────────

function PatchDiffView({ toolArgs, expanded, onToggle }: {
  toolArgs: Record<string, unknown>; expanded: boolean; onToggle: () => void;
}) {
  // Extract edits or patches
  const hunks = useMemo(() => {
    const edits = toolArgs.edits as Array<{ old_string: string; new_string: string }> | undefined;
    const patches = toolArgs.patches as Array<{ search: string; replace?: string }> | undefined;

    if (edits) {
      return edits.map(e => ({ oldText: e.old_string, newText: e.new_string }));
    }
    if (patches) {
      return patches.map(p => ({ oldText: p.search, newText: p.replace || '' }));
    }
    return [];
  }, [toolArgs]);

  const totalChanges = hunks.reduce((sum, h) => sum + countDiffs(h.oldText, h.newText), 0);

  if (hunks.length === 0) {
    return <FallbackView toolArgs={toolArgs} />;
  }

  const displayHunks = expanded ? hunks : hunks.slice(0, 3);

  return (
    <div className="diff-view-container">
      <div className="diff-summary-bar">
        <span className="diff-summary-count">{hunks.length} change{hunks.length !== 1 ? 's' : ''}</span>
        <span className="diff-summary-lines">+{totalChanges} / -{totalChanges} lines</span>
        {hunks.length > 3 && (
          <button className="diff-expand-toggle" onClick={onToggle} aria-expanded={expanded}>
            <Chevron up={expanded} />
            {expanded ? 'Collapse' : `Show all (${hunks.length} total)`}
          </button>
        )}
      </div>
      <div className={`diff-hunks ${expanded ? 'diff-hunks-expanded' : ''}`}>
        {displayHunks.map((hunk, i) => (
          <DiffHunk key={i} oldText={hunk.oldText} newText={hunk.newText} index={i} />
        ))}
      </div>
    </div>
  );
}

function countDiffs(oldText: string, newText: string): number {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const lcs = computeLCS(oldLines, newLines);
  return Math.max(oldLines.length - lcs, newLines.length - lcs);
}

/** Compute LCS (longest common subsequence) length for line arrays */
function computeLCS(a: string[], b: string[]): number {
  const m = a.length, n = b.length;
  if (m === 0 || n === 0) return 0;
  if (m > 100 || n > 100) return Math.min(m, n); // bail for large inputs
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp[m][n];
}

/** Render a single old→new diff hunk with colored lines */
function DiffHunk({ oldText, newText, index }: { oldText: string; newText: string; index: number }) {
  const oldLines = oldText.split('\n').filter(l => l.length > 0 || oldText === '' || oldText.includes('\n'));
  const newLines = newText.split('\n').filter(l => l.length > 0 || newText === '' || newText.includes('\n'));

  // For single-line diffs, just show old vs new side-by-side
  if (oldLines.length <= 1 && newLines.length <= 1) {
    return (
      <div className="diff-hunk">
        <div className="diff-hunk-header">Change #{index + 1}</div>
        <div className="diff-hunk-body">
          {oldText && <div className="diff-line diff-line-removed"><span className="diff-prefix">-</span>{truncate(oldText, 500)}</div>}
          {newText && <div className="diff-line diff-line-added"><span className="diff-prefix">+</span>{truncate(newText, 500)}</div>}
        </div>
      </div>
    );
  }

  // Multi-line: compute actual line diff
  const lineDiff = buildLineDiff(oldLines, newLines);
  return (
    <div className="diff-hunk">
      <div className="diff-hunk-header">Change #{index + 1} ({lineDiff.length} lines)</div>
      <div className="diff-hunk-body">
        {lineDiff.map((ld, li) => (
          <div key={li} className={`diff-line ${ld.type === 'removed' ? 'diff-line-removed' : ld.type === 'added' ? 'diff-line-added' : 'diff-line-unchanged'}`}>
            <span className="diff-prefix">{ld.type === 'removed' ? '-' : ld.type === 'added' ? '+' : ' '}</span>
            {ld.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function buildLineDiff(oldLines: string[], newLines: string[]): Array<{ type: 'removed' | 'added' | 'unchanged'; text: string }> {
  // Simple LCS-based diff
  const m = oldLines.length, n = newLines.length;
  if (m > 80 || n > 80) {
    // Too large for DP — show old and new separately
    const result: Array<{ type: 'removed' | 'added' | 'unchanged'; text: string }> = [];
    for (const l of oldLines) result.push({ type: 'removed', text: l });
    result.push({ type: 'added', text: '─── replaced with ───' });
    for (const l of newLines) result.push({ type: 'added', text: l });
    return result;
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = oldLines[i - 1] === newLines[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);

  // Backtrack
  const result: Array<{ type: 'removed' | 'added' | 'unchanged'; text: string }> = [];
  let i = m, j = n;
  const temp: string[] = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      temp.unshift(oldLines[i - 1]);
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      temp.unshift('+' + newLines[j - 1]);
      j--;
    } else {
      temp.unshift('-' + oldLines[i - 1]);
      i--;
    }
  }
  for (const raw of temp) {
    if (raw.startsWith('+')) result.push({ type: 'added', text: raw.slice(1) });
    else if (raw.startsWith('-')) result.push({ type: 'removed', text: raw.slice(1) });
    else result.push({ type: 'unchanged', text: raw });
  }
  return result;
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '...';
}

// ── Create View ─────────────────────────────────────────────────────

function CreateView({ toolArgs, filePath, expanded, onToggle }: {
  toolArgs: Record<string, unknown>; filePath: string; expanded: boolean; onToggle: () => void;
}) {
  const content = String(toolArgs.content || '');
  const lines = content.split('\n');
  const previewLines = expanded ? lines : lines.slice(0, 25);
  const hasMore = lines.length > 25;

  return (
    <div className="diff-view-container">
      <div className="diff-summary-bar">
        <span className="diff-summary-filename">{filePath}</span>
        <span className="diff-summary-count">{lines.length} lines</span>
        {hasMore && (
          <button className="diff-expand-toggle" onClick={onToggle} aria-expanded={expanded}>
            <Chevron up={expanded} />
            {expanded ? 'Collapse' : `Show all (${lines.length} lines)`}
          </button>
        )}
      </div>
      <div className="diff-insertion-block">
        {previewLines.map((line, i) => (
          <div key={i} className="diff-line diff-line-added">
            <span className="diff-prefix">+</span>
            {line || '\u00A0'}
          </div>
        ))}
        {hasMore && !expanded && (
          <div className="diff-line diff-line-more">... {lines.length - 25} more lines ...</div>
        )}
      </div>
    </div>
  );
}

// ── Edit View ───────────────────────────────────────────────────────

function EditView({ toolArgs, filePath, expanded, onToggle }: {
  toolArgs: Record<string, unknown>; filePath: string; expanded: boolean; onToggle: () => void;
}) {
  const content = String(toolArgs.content || '');
  const lines = content.split('\n');
  const previewLines = expanded ? lines : lines.slice(0, 25);
  const hasMore = lines.length > 25;

  return (
    <div className="diff-view-container">
      <div className="diff-summary-bar">
        <span className="diff-summary-filename">{filePath}</span>
        <span className="diff-summary-warning">full file rewrite</span>
        <span className="diff-summary-count">{lines.length} lines</span>
        {hasMore && (
          <button className="diff-expand-toggle" onClick={onToggle} aria-expanded={expanded}>
            <Chevron up={expanded} />
            {expanded ? 'Collapse' : `Show all (${lines.length} lines)`}
          </button>
        )}
      </div>
      <div className="diff-insertion-block">
        {previewLines.map((line, i) => (
          <div key={i} className="diff-line diff-line-added">
            <span className="diff-prefix">+</span>
            {line || '\u00A0'}
          </div>
        ))}
        {hasMore && !expanded && (
          <div className="diff-line diff-line-more">... {lines.length - 25} more lines ...</div>
        )}
      </div>
    </div>
  );
}

// ── Delete View ─────────────────────────────────────────────────────

function DeleteView({ filePath }: { filePath: string }) {
  return (
    <div className="diff-view-container">
      <div className="diff-summary-bar">
        <span className="diff-summary-filename">{filePath}</span>
        <span className="diff-summary-danger">DESTRUCTIVE</span>
      </div>
      <div className="diff-delete-warning">
        This file will be <strong>permanently deleted</strong>.
      </div>
    </div>
  );
}

// ── Append View ─────────────────────────────────────────────────────

function AppendView({ toolArgs, filePath, expanded, onToggle }: {
  toolArgs: Record<string, unknown>; filePath: string; expanded: boolean; onToggle: () => void;
}) {
  const content = String(toolArgs.content || '');
  const lines = content.split('\n');
  const previewLines = expanded ? lines : lines.slice(0, 25);
  const hasMore = lines.length > 25;

  return (
    <div className="diff-view-container">
      <div className="diff-summary-bar">
        <span className="diff-summary-filename">{filePath}</span>
        <span className="diff-summary-count">+{lines.length} lines appended</span>
        {hasMore && (
          <button className="diff-expand-toggle" onClick={onToggle} aria-expanded={expanded}>
            <Chevron up={expanded} />
            {expanded ? 'Collapse' : `Show all (${lines.length} lines)`}
          </button>
        )}
      </div>
      <div className="diff-insertion-block">
        {previewLines.map((line, i) => (
          <div key={i} className="diff-line diff-line-added">
            <span className="diff-prefix">+</span>
            {line || '\u00A0'}
          </div>
        ))}
        {hasMore && !expanded && (
          <div className="diff-line diff-line-more">... {lines.length - 25} more lines ...</div>
        )}
      </div>
    </div>
  );
}

// ── Rename / Move View ──────────────────────────────────────────────

function RenameView({ filePath, altPath }: { filePath: string; altPath?: string }) {
  return (
    <div className="diff-view-container">
      <div className="diff-rename-path">
        <span className="diff-rename-old">{filePath}</span>
        <svg className="diff-rename-arrow" width="20" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
        <span className="diff-rename-new">{altPath || '?'}</span>
      </div>
    </div>
  );
}

// ── Fallback: plain JSON display ────────────────────────────────────

function FallbackView({ toolArgs }: { toolArgs: Record<string, unknown> }) {
  const json = JSON.stringify(toolArgs, null, 2);
  const truncated = json.length > 1000 ? json.slice(0, 1000) + '\n... (truncated)' : json;
  return (
    <pre className="diff-approval-fallback">{truncated}</pre>
  );
}