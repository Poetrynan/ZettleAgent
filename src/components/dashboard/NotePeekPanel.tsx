import { useState, useEffect } from 'react';
import { MarkdownRenderer } from '../editor/MarkdownRenderer';
import { readMarkdownFile } from '../../lib/tauri';
import { t } from '../../lib/i18n';

interface NotePeekPanelProps {
  /** Vault path of the note to preview. */
  path: string;
  title: string | null;
  /** Close the peek pane. */
  onClose: () => void;
  /** Navigate to the full note view (setCurrentFile + setView('note')). */
  onOpenFull: (path: string) => void;
}

/**
 * Right-hand preview pane for the Notes Overview. Clicking a row opens the note
 * *here* instead of navigating away, so the "scan a big list" flow is never
 * interrupted. A single button escalates to the full editor when the user
 * actually wants to edit.
 */
export function NotePeekPanel({ path, title, onClose, onOpenFull }: NotePeekPanelProps) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    readMarkdownFile(path)
      .then(text => {
        if (!cancelled) setContent(text);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [path]);

  return (
    <div className="overview-peek" data-testid="peek-panel">
      <div className="overview-peek-header">
        <span className="overview-peek-title" title={title || path}>{title || path}</span>
        <div className="overview-peek-actions">
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => onOpenFull(path)}
            data-testid="peek-open-full"
          >
            {t('overview.peekOpen')}
          </button>
          <button
            className="btn btn-ghost btn-icon-sm"
            onClick={onClose}
            title={t('overview.peekClose')}
            aria-label={t('overview.peekClose')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
      <div className="overview-peek-body">
        {loading && <div className="overview-peek-status">{t('overview.peekLoading')}</div>}
        {error && <div className="overview-peek-status overview-peek-error">{t('overview.peekError')}</div>}
        {!loading && !error && <MarkdownRenderer content={content} />}
      </div>
    </div>
  );
}
