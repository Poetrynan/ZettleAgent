/**
 * "Add to review" affordance for the note being read.
 *
 * Mounted next to `BacklinksPanel` in `MarkdownViewer` — the same in-note strip
 * pattern, and for the same reason: this is a one-click status control, not a
 * workspace. The actual studying happens in the `review` view.
 *
 * The control has to know which of two states it is in *before* the user clicks,
 * so it loads the card on mount rather than optimistically labelling itself
 * "Add" and surprising the user with "already in deck".
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { t, tf } from '../../lib/i18n';
import { useApp } from '../../contexts/AppContext';
import { IconBrain, IconCheck, IconTrash } from '../icons';
import {
  getReviewCard, addCardsToReview, removeCardFromReview,
  type ReviewCardView,
} from '../../lib/tauri';

export function ReviewCardBadge({ filePath }: { filePath: string }) {
  const { showToast } = useApp();
  const [card, setCard] = useState<ReviewCardView | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!filePath) return;
    setIsLoading(true);
    try {
      setCard(await getReviewCard(filePath));
    } catch (err) {
      // Not in the deck and "the command failed" look the same to this control,
      // and neither is worth an error banner on top of someone's note.
      console.warn('Failed to load review card:', err);
      setCard(null);
    } finally {
      setIsLoading(false);
    }
  }, [filePath]);

  useEffect(() => { void reload(); }, [reload]);

  if (isLoading) return null;

  const add = async () => {
    setBusy(true);
    try {
      await addCardsToReview([filePath]);
      showToast(t('review.added'), 'success');
      await reload();
    } catch (err) {
      showToast(String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await removeCardFromReview(filePath);
      showToast(t('review.removed'), 'success');
      setCard(null);
    } catch (err) {
      showToast(String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!card) {
    return (
      <div className="review-badge" style={rowStyle}>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          data-testid="review-add-note"
          disabled={busy}
          onClick={() => void add()}
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <IconBrain size={14} /> {t('review.addToDeck')}
        </button>
      </div>
    );
  }

  // Already scheduled: show *when*, because "in the deck" without a date tells
  // the reader nothing about whether they are on top of this note.
  const dueLabel = card.intervalDays >= 1
    ? tf('review.nextIn.days', card.intervalDays)
    : tf('review.nextIn.minutes', Math.max(1, card.intervalMinutes));

  return (
    <div className="review-badge" style={rowStyle} data-testid="review-in-deck">
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
        <IconCheck size={14} /> {t('review.inDeck')}
        <span style={{ fontFamily: 'var(--font-mono, monospace)', color: 'var(--text-tertiary)' }}>
          {tf('review.nextReview', dueLabel)}
        </span>
        <span style={{ color: 'var(--text-muted)' }}>
          {tf('review.reps', card.reps + 1)}
        </span>
      </span>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        data-testid="review-remove-note"
        title={t('review.remove')}
        disabled={busy}
        onClick={() => void remove()}
      >
        <IconTrash size={14} />
      </button>
    </div>
  );
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--space-2)',
  padding: 'var(--space-2) 0',
  borderTop: '1px solid var(--border-subtle)',
};
