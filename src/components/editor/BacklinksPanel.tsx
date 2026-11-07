import { useState, useEffect, useCallback } from 'react';
import { useApp } from '../../contexts/AppContext';
import {
  getBacklinks,
  BacklinkEntry,
  getUnlinkedMentions,
  linkUnlinkedMention,
  undoLinkMention,
  MentionsReport,
  UnlinkedMention,
  LinkMentionResult,
} from '../../lib/tauri';
import { t, tf } from '../../lib/i18n';
import { IconLink } from '../icons';

const getFileName = (path: string) =>
  path.replace(/\\/g, '/').split('/').pop()?.replace('.md', '') || path;

const mentionKey = (m: UnlinkedMention) => `${m.filePath}:${m.line}:${m.column}`;

/**
 * Backlinks Panel — notes that link to the current note, and (collapsed by
 * default) unlinked mentions: notes that name it without a [[link]], each of
 * which can be turned into a link in place and undone again.
 * Displayed at the bottom of MarkdownViewer in read mode.
 */
export function BacklinksPanel({ filePath }: { filePath: string }) {
  const { setCurrentFile, setView, showToast } = useApp();
  const [backlinks, setBacklinks] = useState<BacklinkEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isExpanded, setIsExpanded] = useState(true);

  // Mentions read every candidate note from disk, so they load only on demand.
  const [mentionsOpen, setMentionsOpen] = useState(false);
  const [mentions, setMentions] = useState<MentionsReport | null>(null);
  const [mentionsLoading, setMentionsLoading] = useState(false);
  const [mentionsError, setMentionsError] = useState<string | null>(null);
  /** Mentions linked in this session, keyed by position, so each can be undone. */
  const [linked, setLinked] = useState<Record<string, LinkMentionResult>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const loadBacklinks = useCallback(() => {
    if (!filePath) return;
    getBacklinks(filePath)
      .then(setBacklinks)
      .catch(err => console.error('Failed to load backlinks:', err))
      .finally(() => setIsLoading(false));
  }, [filePath]);

  const loadMentions = useCallback(() => {
    if (!filePath) return;
    setMentionsLoading(true);
    setMentionsError(null);
    getUnlinkedMentions(filePath)
      .then(setMentions)
      .catch(err => setMentionsError(String(err)))
      .finally(() => setMentionsLoading(false));
  }, [filePath]);

  useEffect(() => {
    setIsLoading(true);
    setMentions(null);
    setLinked({});
    loadBacklinks();
  }, [loadBacklinks]);

  useEffect(() => {
    if (mentionsOpen && mentions === null && !mentionsLoading) loadMentions();
  }, [mentionsOpen, mentions, mentionsLoading, loadMentions]);

  const open = (path: string) => {
    setCurrentFile(path);
    setView('note');
  };

  const handleLink = async (m: UnlinkedMention) => {
    const key = mentionKey(m);
    setBusy(key);
    try {
      const result = await linkUnlinkedMention(m.filePath, filePath, m);
      setLinked(prev => ({ ...prev, [key]: result }));
      loadBacklinks();
    } catch (err) {
      showToast(`${t('mentions.linkFailed')}: ${String(err)}`, 'error');
      // The note changed under the list; show what is there now.
      loadMentions();
    } finally {
      setBusy(null);
    }
  };

  const handleUndo = async (m: UnlinkedMention) => {
    const key = mentionKey(m);
    const result = linked[key];
    if (!result) return;
    setBusy(key);
    try {
      await undoLinkMention(m.filePath, result);
      setLinked(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      loadBacklinks();
    } catch (err) {
      showToast(`${t('mentions.undoFailed')}: ${String(err)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  if (isLoading) return null;

  const mentionCount = mentions ? mentions.mentions.length - Object.keys(linked).length : null;

  return (
    <div className="backlinks-panel">
      <button
        className="backlinks-header"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <IconLink size={14} />
        <span>Backlinks</span>
        <span className="backlinks-count">{backlinks.length}</span>
        <span className="backlinks-chevron">{isExpanded ? '▼' : '▶'}</span>
      </button>

      {isExpanded && (
        <div className="backlinks-list">
          {backlinks.length === 0 ? (
            <div className="backlinks-empty">No other notes link here yet.</div>
          ) : (
            backlinks.map((bl) => (
              <button
                key={bl.file_path}
                className="backlinks-item"
                onClick={() => open(bl.file_path)}
              >
                <span className="backlinks-item-title">{bl.title || getFileName(bl.file_path)}</span>
                {bl.context && (
                  <span className="backlinks-item-context">{bl.context}</span>
                )}
              </button>
            ))
          )}
        </div>
      )}

      <button
        className="backlinks-header mentions-header"
        onClick={() => setMentionsOpen(!mentionsOpen)}
        title={t('mentions.hint')}
      >
        <span>{t('mentions.title')}</span>
        {mentionCount !== null && <span className="backlinks-count">{mentionCount}</span>}
        <span className="backlinks-chevron">{mentionsOpen ? '▼' : '▶'}</span>
      </button>

      {mentionsOpen && (
        <div className="backlinks-list">
          {mentionsLoading && !mentions && (
            <div className="backlinks-empty">{t('mentions.loading')}</div>
          )}
          {mentionsError && <div className="backlinks-empty mentions-error">{mentionsError}</div>}
          {mentions && mentions.mentions.length === 0 && (
            <div className="backlinks-empty">{t('mentions.empty')}</div>
          )}
          {mentions?.mentions.map((m) => {
            const key = mentionKey(m);
            const done = linked[key];
            return (
              <div key={key} className={`mention-item${done ? ' is-linked' : ''}`}>
                <button className="mention-open" onClick={() => open(m.filePath)}>
                  <span className="backlinks-item-title">
                    {m.title || getFileName(m.filePath)}
                    <span className="mention-line">:{m.line}</span>
                  </span>
                  <span className="backlinks-item-context">
                    {m.before}
                    <mark className="mention-match">{m.matched}</mark>
                    {m.after}
                  </span>
                </button>
                {done ? (
                  <span className="mention-actions">
                    <span className="mention-done">{t('mentions.linked')}</span>
                    <button className="mention-btn" disabled={busy === key} onClick={() => handleUndo(m)}>
                      {t('mentions.undo')}
                    </button>
                  </span>
                ) : (
                  <button
                    className="mention-btn"
                    disabled={busy !== null}
                    onClick={() => handleLink(m)}
                    title={t('mentions.linkTitle')}
                  >
                    {t('mentions.link')}
                  </button>
                )}
              </div>
            );
          })}
          {mentions?.truncated && (
            <div className="backlinks-empty">{tf('mentions.truncated', mentions.mentions.length)}</div>
          )}
          {mentions && mentions.terms.length > 0 && (
            <div className="mentions-terms">{tf('mentions.searchedFor', mentions.terms.join(' · '))}</div>
          )}
        </div>
      )}
    </div>
  );
}
