/**
 * EditorSuggestionOverlay — Renders AI fact-check suggestion cards.
 *
 * Two modes:
 * 1. **Anchored card mode** (primary): When `activeSuggestionId` + `cardPos`
 *    are provided, renders a single card positioned at the wave underlined
 *    text via ProseMirror Decoration. This is the new mode that replaces
 *    the old detached floating card list.
 * 2. **Floating list mode** (fallback): When no active suggestion, renders
 *    a small status pill + the scanning indicator in the corner.
 *
 * The "Apply Fix" button calls `onAccept`, which triggers
 * `acceptSuggestion()` to replace the conflicting text in the editor
 * via ProseMirror transaction.
 */
import { useState, useEffect, useRef } from 'react';
import type { EditorSuggestion } from './useEditorSuggestions';
import { IconTimeline, IconContradicted, IconSuperseded, IconMerge, IconClose, IconLink, IconCheck } from '../icons';

interface EditorSuggestionOverlayProps {
  suggestions: EditorSuggestion[];
  isScanning: boolean;
  onDismiss: (id: string) => void;
  onNavigateToSource?: (path: string) => void;
  /** Resolve a reconciliation conflict with user's choice */
  onResolveReconciliation?: (id: string, resolution: 'keep_user' | 'keep_ai') => Promise<boolean>;
  /** Apply a suggested fix — replaces the conflicting text in the editor */
  onAccept?: (id: string) => void;
  lang: string;
  /** Currently active suggestion (for anchored card mode) */
  activeSuggestionId?: string | null;
  /** Position for the active card (relative to editor container, px) */
  cardPos?: { top: number; left: number } | null;
  /** Close the active card */
  onCloseActive?: () => void;
}

function getTypeIcon(type: string, size = 14) {
  switch (type) {
    case 'temporal_conflict': return <IconTimeline size={size} />;
    case 'factual_conflict': return <IconContradicted size={size} />;
    case 'outdated_claim': return <IconSuperseded size={size} />;
    case 'reconciliation_conflict': return <IconMerge size={size} />;
    default: return <IconContradicted size={size} />;
  }
}

const TYPE_COLORS: Record<string, { border: string; bg: string; text: string; wave: string }> = {
  temporal_conflict: {
    border: 'rgba(234, 179, 8, 0.5)',
    bg: 'rgba(234, 179, 8, 0.06)',
    text: '#b45309',
    wave: '#eab308',
  },
  factual_conflict: {
    border: 'rgba(239, 68, 68, 0.5)',
    bg: 'rgba(239, 68, 68, 0.06)',
    text: '#dc2626',
    wave: '#ef4444',
  },
  outdated_claim: {
    border: 'rgba(249, 115, 22, 0.4)',
    bg: 'rgba(249, 115, 22, 0.06)',
    text: '#c2410c',
    wave: '#f97316',
  },
  reconciliation_conflict: {
    border: 'rgba(139, 92, 246, 0.5)',
    bg: 'rgba(139, 92, 246, 0.06)',
    text: '#7c3aed',
    wave: '#8b5cf6',
  },
};

function getTypeLabel(type: string, isZh: boolean): string {
  switch (type) {
    case 'temporal_conflict': return isZh ? '时态冲突' : 'Temporal Conflict';
    case 'outdated_claim': return isZh ? '过时信息' : 'Outdated Claim';
    case 'reconciliation_conflict': return isZh ? '协调冲突' : 'Reconciliation Conflict';
    default: return isZh ? '事实矛盾' : 'Factual Conflict';
  }
}

export function EditorSuggestionOverlay({
  suggestions,
  isScanning,
  onDismiss,
  onNavigateToSource,
  onResolveReconciliation,
  onAccept,
  lang,
  activeSuggestionId,
  cardPos,
  onCloseActive,
}: EditorSuggestionOverlayProps) {
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const isZh = lang === 'zh';
  const cardRef = useRef<HTMLDivElement>(null);

  // Close the active card when clicking outside
  useEffect(() => {
    if (!activeSuggestionId) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        // Don't close if clicking a badge (they have their own handler)
        const target = e.target as HTMLElement;
        if (target.closest('.suggestion-wave-badge')) return;
        onCloseActive?.();
      }
    };
    // Use setTimeout to avoid closing immediately on the badge click
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [activeSuggestionId, onCloseActive]);

  // ── Anchored card mode: render the active suggestion card ──
  const activeSuggestion = activeSuggestionId
    ? suggestions.find(s => s.id === activeSuggestionId)
    : null;

  if (activeSuggestion && cardPos) {
    const sug = activeSuggestion;
    const colors = TYPE_COLORS[sug.type] || TYPE_COLORS.factual_conflict;
    const confidencePct = Math.round(sug.confidence * 100);
    const hasFix = !!sug.suggestedFix;

    return (
      <div
        ref={cardRef}
        className="editor-suggestion-card anchored"
        style={{
          borderColor: colors.border,
          background: 'var(--bg-primary, #fff)',
          position: 'absolute',
          top: cardPos.top,
          left: cardPos.left,
          width: 340,
          zIndex: 2000,
        }}
      >
        {/* Header row */}
        <div className="editor-suggestion-header">
          <span className="editor-suggestion-icon">{getTypeIcon(sug.type)}</span>
          <span className="editor-suggestion-title" style={{ color: colors.text }}>
            {getTypeLabel(sug.type, isZh)}
          </span>
          <span className="editor-suggestion-confidence">{confidencePct}%</span>
          <button
            className="editor-suggestion-dismiss"
            onClick={(e) => { e.stopPropagation(); onCloseActive?.(); }}
            title={isZh ? '关闭' : 'Close'}
            aria-label={isZh ? '关闭' : 'Close'}
          >
            <IconClose size={12} />
          </button>
        </div>

        {/* Brief explanation */}
        <div className="editor-suggestion-explanation">
          {sug.explanation}
        </div>

        {/* Detail quotes */}
        <div className="editor-suggestion-details">
          {sug.type === 'reconciliation_conflict' ? (
            <>
              <div className="editor-suggestion-quote">
                <div className="editor-suggestion-quote-label">
                  {isZh ? '📝 你的版本' : '📝 Your Version'}
                </div>
                <div className="editor-suggestion-quote-text">
                  {(sug.userVersion || sug.triggerText).slice(0, 300)}
                  {(sug.userVersion || sug.triggerText).length > 300 ? '...' : ''}
                </div>
              </div>

              <div className="editor-suggestion-quote conflicting">
                <div className="editor-suggestion-quote-label">
                  {isZh ? '🤖 AI 的版本' : '🤖 AI Version'}
                </div>
                <div className="editor-suggestion-quote-text">
                  {(sug.aiVersion || sug.conflictingClaim).slice(0, 300)}
                  {(sug.aiVersion || sug.conflictingClaim).length > 300 ? '...' : ''}
                </div>
              </div>

              <div className="editor-suggestion-actions">
                <button
                  className="editor-suggestion-btn editor-suggestion-btn-ignore"
                  disabled={resolvingId === sug.id}
                  onClick={async (e) => {
                    e.stopPropagation();
                    setResolvingId(sug.id);
                    await onResolveReconciliation?.(sug.id, 'keep_user');
                    setResolvingId(null);
                  }}
                >
                  {isZh ? '保留我的' : 'Keep Mine'}
                </button>
                <button
                  className="editor-suggestion-btn editor-suggestion-btn-source"
                  disabled={resolvingId === sug.id}
                  onClick={async (e) => {
                    e.stopPropagation();
                    setResolvingId(sug.id);
                    await onResolveReconciliation?.(sug.id, 'keep_ai');
                    setResolvingId(null);
                  }}
                >
                  {isZh ? '保留 AI' : 'Keep AI'}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="editor-suggestion-quote">
                <div className="editor-suggestion-quote-label">
                  {isZh ? '当前文本' : 'Current Text'}
                </div>
                <div className="editor-suggestion-quote-text">
                  {sug.triggerText.slice(0, 200)}{sug.triggerText.length > 200 ? '...' : ''}
                </div>
              </div>

              <div className="editor-suggestion-quote conflicting">
                <div className="editor-suggestion-quote-label">
                  {isZh ? `来源: ${sug.sourceTitle}` : `Source: ${sug.sourceTitle}`}
                </div>
                <div className="editor-suggestion-quote-text">
                  {sug.conflictingClaim.slice(0, 200)}{sug.conflictingClaim.length > 200 ? '...' : ''}
                </div>
              </div>

              {/* Suggested fix preview */}
              {hasFix && (
                <div className="editor-suggestion-quote" style={{ borderLeftColor: colors.wave, background: 'rgba(0,0,0,0.02)' }}>
                  <div className="editor-suggestion-quote-label" style={{ color: colors.text }}>
                    {isZh ? '✏️ 建议修正' : '✏️ Suggested Fix'}
                  </div>
                  <div className="editor-suggestion-quote-text">
                    {sug.suggestedFix!.slice(0, 300)}{(sug.suggestedFix!.length > 300) ? '...' : ''}
                  </div>
                </div>
              )}

              <div className="editor-suggestion-actions">
                {onNavigateToSource && (
                  <button
                    className="editor-suggestion-btn editor-suggestion-btn-source"
                    onClick={(e) => { e.stopPropagation(); onNavigateToSource(sug.sourcePath); }}
                  >
                    <IconLink size={12} />
                    {isZh ? '查看来源' : 'Source'}
                  </button>
                )}
                {hasFix && onAccept && (
                  <button
                    className="editor-suggestion-btn editor-suggestion-btn-accept"
                    onClick={(e) => { e.stopPropagation(); onAccept(sug.id); }}
                  >
                    <IconCheck size={12} />
                    {isZh ? '应用修正' : 'Apply Fix'}
                  </button>
                )}
                <button
                  className="editor-suggestion-btn editor-suggestion-btn-ignore"
                  onClick={(e) => { e.stopPropagation(); onDismiss(sug.id); }}
                >
                  {isZh ? '忽略' : 'Dismiss'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // ── Floating mode: scanning indicator + suggestion count pill ──
  if (suggestions.length === 0 && !isScanning) return null;

  return (
    <div className="editor-suggestion-overlay">
      {/* Scanning indicator */}
      {isScanning && (
        <div className="editor-suggestion-scanning">
          <div className="editor-suggestion-scanning-dot" />
          <span>{isZh ? 'AI 正在核验事实...' : 'AI fact-checking...'}</span>
        </div>
      )}

      {/* Suggestion count pill — shows how many suggestions exist */}
      {suggestions.length > 0 && !isScanning && (
        <div className="editor-suggestion-count-pill">
          {suggestions.length} {isZh ? '个建议' : 'suggestions'}
        </div>
      )}
    </div>
  );
}
