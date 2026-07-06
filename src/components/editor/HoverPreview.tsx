/**
 * HoverPreview — shows a note preview card when hovering over a [[wikilink]].
 * Works in both MarkdownRenderer (read-only) and MilkdownEditor (WYSIWYG).
 */

import { useState, useRef, useCallback, useEffect } from 'react';

export interface HoverPreviewState {
  visible: boolean;
  title: string;
  noteType: string;
  tags: string[];
  snippet: string;
  x: number;
  y: number;
  loading: boolean;
  error: string | null;
}

const EMPTY_STATE: HoverPreviewState = {
  visible: false, title: '', noteType: '', tags: [],
  snippet: '', x: 0, y: 0, loading: false, error: null,
};

const SNIPPET_MAX = 250;

/**
 * Simple frontmatter parser — extract type and tags from YAML frontmatter.
 */
function parseFrontmatterFields(content: string): { noteType: string; tags: string[] } {
  if (!content.startsWith('---')) return { noteType: '', tags: [] };
  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) return { noteType: '', tags: [] };
  const fm = content.substring(3, endIdx);

  let noteType = '';
  let tags: string[] = [];

  const typeMatch = fm.match(/^type:\s*(.+)$/im);
  if (typeMatch) noteType = typeMatch[1].trim();

  // tags: [a, b, c]
  const tagsInline = fm.match(/^tags:\s*\[(.+)\]$/im);
  if (tagsInline) {
    tags = tagsInline[1].split(',').map(s => s.trim().replace(/['"]/g, ''));
  } else {
    // tags:\n  - a\n  - b
    const tagSection = fm.match(/^tags:\s*\n((?:\s*-\s*.+\n?)*)/im);
    if (tagSection) {
      const tagLines = tagSection[1].match(/\s*-\s*(.+)/g);
      if (tagLines) tags = tagLines.map(l => l.replace(/^\s*-\s*/, '').trim());
    }
  }

  return { noteType, tags };
}

/**
 * Hook: returns [state, onHoverStart(wikilinkTitle, el), onHoverEnd].
 * Call onHoverStart with the wikilink target title and the anchor DOM element.
 */
export function useHoverPreview(): [
  HoverPreviewState,
  (title: string, el: HTMLElement) => void,
  () => void
] {
  const [state, setState] = useState<HoverPreviewState>(EMPTY_STATE);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelRef = useRef<AbortController | null>(null);

  const onHoverStart = useCallback((wikilinkTitle: string, anchorEl: HTMLElement) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (cancelRef.current) cancelRef.current.abort();

    const controller = new AbortController();
    cancelRef.current = controller;

    hoverTimer.current = setTimeout(async () => {
      if (controller.signal.aborted) return;

      const rect = anchorEl.getBoundingClientRect();

      setState(prev => ({
        ...prev, visible: true, title: wikilinkTitle,
        x: rect.left, y: rect.bottom + 4,
        loading: true, error: null, noteType: '', tags: [], snippet: '',
      }));

      try {
        const { resolveWikilink, readMarkdownFile } = await import('../../lib/tauri');

        // Resolve [[title]] → file path
        let resolvedPath: string | null = null;
        try { resolvedPath = await resolveWikilink(wikilinkTitle); } catch { /* ignore */ }

        if (controller.signal.aborted) return;

        if (resolvedPath) {
          const rawContent = await readMarkdownFile(resolvedPath);
          if (controller.signal.aborted) return;

          const { noteType, tags } = parseFrontmatterFields(rawContent);

          // Get body snippet (strip frontmatter)
          let body = rawContent;
          if (body.startsWith('---')) {
            const second = body.indexOf('---', 3);
            if (second !== -1) body = body.substring(second + 3).trim();
          }
          const snippet = body.substring(0, SNIPPET_MAX).trim()
            + (body.length > SNIPPET_MAX ? ' …' : '');

          setState(prev => ({ ...prev, loading: false, noteType, tags, snippet }));
        } else {
          setState(prev => ({ ...prev, loading: false, snippet: '', error: null }));
        }
      } catch (e: any) {
        if (controller.signal.aborted) return;
        setState(prev => ({ ...prev, loading: false, error: e?.message || 'Failed' }));
      }
    }, 300);
  }, []);

  const onHoverEnd = useCallback(() => {
    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
    if (cancelRef.current) { cancelRef.current.abort(); cancelRef.current = null; }
    setState(EMPTY_STATE);
  }, []);

  useEffect(() => {
    return () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      if (cancelRef.current) cancelRef.current.abort();
    };
  }, []);

  return [state, onHoverStart, onHoverEnd];
}

/**
 * The floating preview card component. Renders a fixed-position card
 * that shows note metadata and a content snippet.
 */
export function HoverPreviewCard({ state, onClose }: {
  state: HoverPreviewState;
  onClose: () => void;
}) {
  if (!state.visible) return null;

  const cardWidth = 320;
  const adjustedX = Math.min(state.x, window.innerWidth - cardWidth - 16);
  const adjustedY = Math.min(state.y, window.innerHeight - 200);

  return (
    <div
      className="hover-preview-card"
      style={{
        position: 'fixed',
        zIndex: 5000,
        left: Math.max(8, adjustedX),
        top: Math.max(8, adjustedY),
        width: cardWidth,
        maxHeight: 200,
        overflowY: 'auto',
        background: 'var(--bg-primary, #ffffff)',
        border: '1px solid var(--border, #e2e8f0)',
        borderRadius: 10,
        boxShadow: '0 8px 32px rgba(0,0,0,0.15)',
        padding: 14,
        fontFamily: 'var(--font-ui, sans-serif)',
        fontSize: 13,
        lineHeight: 1.5,
        pointerEvents: 'auto',
      }}
      onMouseLeave={onClose}
    >
      {state.loading ? (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          color: 'var(--text-secondary, #94a3b8)',
        }}>
          <span style={{
            display: 'inline-block', width: 14, height: 14,
            border: '2px solid var(--border)', borderTopColor: 'var(--accent, #3b82f6)',
            borderRadius: '50%', animation: 'hover-spin 0.6s linear infinite',
          }} />
          Loading…
          <style>{`@keyframes hover-spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      ) : state.error ? (
        <div style={{ color: 'var(--danger, #ef4444)' }}>{state.error}</div>
      ) : (
        <>
          {/* Header: title + note type */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <strong style={{
              fontSize: 14, color: 'var(--text-primary, #1e293b)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
            }}>
              {state.title}
            </strong>
            {state.noteType && (
              <span style={{
                fontSize: 10, padding: '1px 6px', borderRadius: 4,
                background: 'var(--accent-bg, rgba(59,130,246,0.1))',
                color: 'var(--accent, #3b82f6)', flexShrink: 0,
              }}>
                {state.noteType}
              </span>
            )}
          </div>

          {/* Tags */}
          {state.tags.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginBottom: 6 }}>
              {state.tags.slice(0, 5).map(tag => (
                <span key={tag} style={{
                  fontSize: 10, padding: '0px 5px', borderRadius: 3,
                  background: 'var(--bg-secondary, #f1f5f9)',
                  color: 'var(--text-secondary, #64748b)',
                }}>
                  #{tag}
                </span>
              ))}
            </div>
          )}

          {/* Content snippet */}
          {state.snippet ? (
            <div style={{
              color: 'var(--text-secondary, #475569)', fontSize: 12,
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {state.snippet}
            </div>
          ) : (
            <span style={{
              color: 'var(--text-tertiary, #94a3b8)',
              fontStyle: 'italic', fontSize: 12,
            }}>
              (no preview)
            </span>
          )}
        </>
      )}
    </div>
  );
}