import { useState, useEffect } from 'react';
import { useApp } from '../../contexts/AppContext';
import { getRelatedNotes, RelatedNote, RelatedNotesResult, RelationSignal } from '../../lib/tauri';
import { t, tf, TranslationKey } from '../../lib/i18n';
import { IconBrain, IconLink, IconSparkle, IconSync, IconNetwork } from '../icons';

/**
 * Related Notes panel — the passive half of discovery.
 *
 * Unlike search, the user does not ask for this: it sits under the note being read
 * and surfaces connections they never went looking for. Three signals feed it
 * (explicit AI/canvas relations, incoming wikilinks, semantic similarity) and each
 * entry says *why* it is here, because a list of titles with no reason is noise.
 */

/** Render order = signal specificity. An authored relation outranks a bare cosine hit. */
const GROUPS: { kind: RelationSignal; labelKey: TranslationKey }[] = [
  { kind: 'explicit', labelKey: 'related.group.explicit' },
  { kind: 'link', labelKey: 'related.group.link' },
  { kind: 'semantic', labelKey: 'related.group.semantic' },
];

/** `note_relations.relation_type` values the Agent emits, translated. */
const RELATION_TYPE_KEYS: Record<string, TranslationKey> = {
  supports: 'related.type.supports',
  contradicts: 'related.type.contradicts',
  refines: 'related.type.refines',
  supplementary: 'related.type.supplementary',
  depends_on: 'related.type.depends_on',
  exemplifies: 'related.type.exemplifies',
  supersedes: 'related.type.supersedes',
  wikilink: 'related.type.wikilink',
};

function GroupIcon({ kind }: { kind: RelationSignal }) {
  if (kind === 'explicit') return <IconBrain size={12} />;
  if (kind === 'link') return <IconLink size={12} />;
  return <IconSparkle size={12} />;
}

const fileName = (path: string) =>
  path.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/, '') || path;

/**
 * The human-readable reasons for one entry. The backend deliberately returns
 * structured signals rather than a sentence — the sentence has to be bilingual, and
 * the dictionary lives here.
 */
function reasonsFor(note: RelatedNote): string[] {
  const reasons: string[] = [];
  if (note.relation === 'explicit') {
    const key = note.relation_type ? RELATION_TYPE_KEYS[note.relation_type] : undefined;
    const label = key ? t(key) : note.relation_type;
    reasons.push(label ? tf('related.reason.explicit', label) : t('related.reason.explicitPlain'));
  } else if (note.relation === 'link') {
    reasons.push(t('related.reason.link'));
  }
  // The cosine is worth showing even when it is not the headline signal: it is the
  // only reason that carries a magnitude.
  if (note.signals.includes('semantic')) {
    reasons.push(tf('related.reason.semantic', note.score.toFixed(2)));
  }
  return reasons;
}

export function RelatedNotesPanel({ filePath, limit = 8 }: { filePath: string; limit?: number }) {
  const { setCurrentFile, setView } = useApp();
  const [result, setResult] = useState<RelatedNotesResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(true);
  const [refreshNonce, setRefreshNonce] = useState(0);

  // Keyed on the path, never on the note's content: this is a reading aid, and
  // re-querying on every keystroke would turn editing into a stutter.
  useEffect(() => {
    if (!filePath) return;
    // A fast file switch must not let the slower first answer overwrite the second.
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    getRelatedNotes(filePath, limit)
      .then((r) => { if (!cancelled) setResult(r); })
      .catch((err) => {
        if (!cancelled) {
          console.error('Failed to load related notes:', err);
          setError(String(err));
          setResult(null);
        }
      })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [filePath, limit, refreshNonce]);

  const handleClick = (path: string) => {
    setCurrentFile(path);
    setView('note');
  };

  const notes = result?.notes ?? [];
  // Only meaningful once a request has come back; while loading we must not claim
  // the index is missing.
  const semanticReady = result?.semantic_index_ready ?? true;
  const groups = GROUPS.map((g) => ({
    ...g,
    items: notes.filter((n) => n.relation === g.kind),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="related-panel">
      {/* Header is always rendered — including while loading — so the panel never
          pops into existence and shifts what the reader is looking at. */}
      <div className="related-header">
        <button
          className="related-toggle"
          onClick={() => setIsExpanded(!isExpanded)}
          aria-expanded={isExpanded}
        >
          <IconNetwork size={14} />
          <span>{t('related.title')}</span>
          <span className="related-count">{notes.length}</span>
          <span className="related-chevron">{isExpanded ? '▼' : '▶'}</span>
        </button>
        <button
          className="related-refresh"
          onClick={() => setRefreshNonce((n) => n + 1)}
          title={t('related.refresh')}
          aria-label={t('related.refresh')}
          disabled={isLoading}
        >
          <IconSync size={13} />
        </button>
      </div>

      {isExpanded && (
        <div className="related-list">
          {isLoading ? (
            <div className="related-placeholder">{t('related.loading')}</div>
          ) : error ? (
            <div className="related-placeholder related-error">{t('related.error')}</div>
          ) : notes.length === 0 ? (
            /* "Nothing is related" and "similarity was never computed" are different
               problems with different fixes, so they get different copy. */
            <div className="related-placeholder">
              <div className="related-placeholder-title">
                {semanticReady ? t('related.empty') : t('related.noIndex')}
              </div>
              <div className="related-hint">
                {semanticReady ? t('related.emptyHint') : t('related.noIndexHint')}
              </div>
            </div>
          ) : (
            <>
              {groups.map((group) => (
                <div className="related-group" key={group.kind}>
                  <div className="related-group-label">
                    <GroupIcon kind={group.kind} />
                    <span>{t(group.labelKey)}</span>
                  </div>
                  {group.items.map((note) => (
                    <button
                      key={note.file_path}
                      className="related-item"
                      onClick={() => handleClick(note.file_path)}
                      title={note.file_path}
                    >
                      <span className="related-item-head">
                        <span className="related-item-title">
                          {note.title || fileName(note.file_path)}
                        </span>
                        {/* Two independent signals agreeing is the strongest thing
                            this panel can tell the user. */}
                        {note.signals.length > 1 && (
                          <span
                            className="related-item-badge"
                            title={tf('related.multiSignalHint', note.signals.length)}
                          >
                            {t('related.multiSignal')}
                          </span>
                        )}
                      </span>
                      <span className="related-item-reason">{reasonsFor(note).join(' · ')}</span>
                      {note.preview && (
                        <span className="related-item-preview">{note.preview}</span>
                      )}
                    </button>
                  ))}
                </div>
              ))}
              {/* Links and relations can be present while the semantic half is still
                  unavailable — say so instead of letting the list look complete. */}
              {!semanticReady && <div className="related-hint">{t('related.noIndexHint')}</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
