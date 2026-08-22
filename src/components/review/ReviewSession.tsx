/**
 * The study surface for Task #30 — spaced repetition.
 *
 * ## Why a full view rather than a side panel
 *
 * Reviewing is a *mode*, not an annotation: you are not editing the note, you
 * are being tested on it. It needs the note body legible at reading width, a
 * reveal step, four buttons wide enough to carry their own interval labels, and
 * keyboard focus it does not have to share. The right-hand `ResizablePanel` is
 * already occupied by chat and would leave the note ~360 px wide; an in-note
 * strip (the `BacklinksPanel` shape) cannot own the keyboard at all. So this is
 * a `view`, alongside `note` / `graph` / `canvas`.
 *
 * ## Session semantics
 *
 * The queue is snapshotted once when a session starts. Grading a card rewrites
 * its schedule, so a live re-query would reshuffle the list under the user's
 * cursor and make the progress counter go backwards. Lapsed cards therefore come
 * back in the *next* session, not later in this one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../contexts/AppContext';
import { t, tf } from '../../lib/i18n';
import { IconBrain, IconSync, IconCheck, IconTrash, IconWarning, IconNote } from '../icons';
import { MarkdownRenderer } from '../editor/MarkdownRenderer';
import {
  getReviewQueue, gradeCard, readMarkdownFile, suspendCard, removeCardFromReview,
  GRADE_AGAIN, GRADE_HARD, GRADE_GOOD, GRADE_EASY,
  type ReviewQueue, type ReviewQueueEntry, type ReviewGrade, type GradePreview,
} from '../../lib/tauri';

/** The four buttons, in the order FSRS numbers them. */
const GRADES: Array<{ grade: ReviewGrade; labelKey: Parameters<typeof t>[0]; tone: string }> = [
  { grade: GRADE_AGAIN as ReviewGrade, labelKey: 'review.grade.again', tone: 'var(--danger, #ef4444)' },
  { grade: GRADE_HARD as ReviewGrade, labelKey: 'review.grade.hard', tone: 'var(--warning, #d97706)' },
  { grade: GRADE_GOOD as ReviewGrade, labelKey: 'review.grade.good', tone: 'var(--accent-primary, #10b981)' },
  { grade: GRADE_EASY as ReviewGrade, labelKey: 'review.grade.easy', tone: 'var(--accent-secondary, #3b82f6)' },
];

/**
 * Human-readable interval for a grade button.
 *
 * Days when the card graduates, minutes while it is still in a learning step —
 * "in 0 d" would read as "right now", which is not what a 10-minute step means.
 */
export function formatInterval(preview: GradePreview | undefined): string {
  if (!preview) return '';
  if (preview.intervalDays >= 1) return tf('review.nextIn.days', preview.intervalDays);
  return tf('review.nextIn.minutes', Math.max(1, preview.intervalMinutes));
}

export function ReviewSession() {
  const { setCurrentFile, setView, showToast } = useApp();

  const [queue, setQueue] = useState<ReviewQueue | null>(null);
  const [session, setSession] = useState<ReviewQueueEntry[]>([]);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [body, setBody] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [graded, setGraded] = useState(0);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const next = await getReviewQueue(50);
      setQueue(next);
      // Due cards first: they are the ones actually at risk of being forgotten,
      // and new cards can always wait until the backlog is cleared.
      setSession([...next.due, ...next.newCards]);
      setIndex(0);
      setGraded(0);
      setRevealed(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const current = session[index];

  // Load the note body for the card in front of the user. Read from disk rather
  // than reusing the queue's `preview`, which is a 120-char teaser.
  useEffect(() => {
    if (!current) { setBody(''); return; }
    let alive = true;
    readMarkdownFile(current.filePath)
      .then(text => { if (alive) setBody(text); })
      // A missing file must not strand the session — the preview is still shown.
      .catch(() => { if (alive) setBody(''); });
    return () => { alive = false; };
  }, [current?.filePath]);

  const advance = useCallback(() => {
    setRevealed(false);
    setIndex(i => i + 1);
  }, []);

  const submit = useCallback(async (grade: ReviewGrade) => {
    if (!current || busy) return;
    setBusy(true);
    try {
      const view = await gradeCard(current.filePath, grade);
      setGraded(n => n + 1);
      const label = view.intervalDays >= 1
        ? tf('review.nextIn.days', view.intervalDays)
        : tf('review.nextIn.minutes', Math.max(1, view.intervalMinutes));
      showToast(tf('review.nextReview', label), 'success');
      advance();
    } catch (e) {
      setError(`${t('review.gradeFailed')}: ${e}`);
    } finally {
      setBusy(false);
    }
  }, [current, busy, advance, showToast]);

  // Keyboard is the whole point of a review UI: a session is dozens of cards and
  // reaching for the mouse each time is what makes people stop reviewing.
  //
  // The listener is bound once, on mount, and reads the card through a ref.
  // Binding it to `Boolean(current)` instead would attach it only *after* the
  // queue fetch resolves, which leaves a window where the card is already
  // painted but the keys are still dead — a race a user hits by typing during
  // the load and a test hits by acting as soon as the card appears.
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const hasCardRef = useRef(false);
  hasCardRef.current = Boolean(current);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hasCardRef.current) return;
      // Never steal keys from a field the user is typing in.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        setRevealed(true);
        return;
      }
      if (['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        // Grading before revealing would defeat the retrieval practice the whole
        // algorithm is measuring, so the shortcut reveals instead.
        setRevealed(r => {
          if (r) void submitRef.current(Number(e.key) as ReviewGrade);
          return true;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const previewFor = useMemo(() => {
    const map = new Map<number, GradePreview>();
    for (const p of current?.gradePreviews ?? []) map.set(p.grade, p);
    return map;
  }, [current]);

  if (isLoading) {
    return (
      <div className="empty-state" data-testid="review-loading">
        <span className="spinner" />
      </div>
    );
  }

  if (error && !current) {
    return (
      <div className="empty-state" data-testid="review-error">
        <IconWarning size={22} />
        <div className="empty-state-title">{t('review.loadFailed')}</div>
        <div className="empty-state-description">{error}</div>
        <button type="button" className="btn btn-sm" onClick={() => void load()}>
          <IconSync size={14} /> {t('review.startSession')}
        </button>
      </div>
    );
  }

  // Two distinct empty states. "Deck is empty" is a setup problem and needs a
  // different instruction from "you are done for today", which is a reward.
  if (!current) {
    const deckIsEmpty = (queue?.dueTotal ?? 0) === 0
      && (queue?.newTotal ?? 0) === 0
      && (queue?.reviewsDoneToday ?? 0) === 0
      && (queue?.newDoneToday ?? 0) === 0;
    const finishedASession = graded > 0;
    return (
      <div className="empty-state" data-testid={deckIsEmpty ? 'review-empty-deck' : 'review-empty-due'}>
        <div style={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.12), rgba(168, 85, 247, 0.12))',
          border: '1px solid rgba(99, 102, 241, 0.25)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--accent-primary, #6366f1)',
          boxShadow: '0 4px 16px rgba(99, 102, 241, 0.1)',
          marginBottom: 4,
        }}>
          <IconBrain size={28} />
        </div>
        <div className="empty-state-title">
          {deckIsEmpty ? t('review.emptyDeck.title') : t('review.empty.title')}
        </div>
        <div className="empty-state-description">
          {finishedASession
            ? tf('review.sessionDone', graded)
            : deckIsEmpty ? t('review.emptyDeck.desc') : t('review.empty.desc')}
        </div>
        {/* The rollover explanation only makes sense when something was held back. */}
        {!deckIsEmpty && queue && queue.dueTotal > queue.due.length + queue.reviewsDoneToday && (
          <div className="empty-state-description" data-testid="review-cap-notice">
            {tf(
              'review.capReached',
              queue.newDoneToday,
              queue.reviewsDoneToday,
              queue.dueTotal - queue.due.length,
            )}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
          {deckIsEmpty && (
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setView('bases')}>
              <IconNote size={14} /> {t('review.browseNotes')}
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={() => void load()} data-testid="review-refresh">
            <IconSync size={14} /> {deckIsEmpty ? t('review.refreshDeck') : t('review.startSession')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="review-session" data-testid="review-session" style={{
      display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
    }}>
      {/* ── Header: progress + what this card is ─────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
        padding: 'var(--space-3) var(--space-4)',
        borderBottom: '1px solid var(--border-subtle)',
        flexWrap: 'wrap',
      }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
          <IconBrain size={16} /> {t('review.navTitle')}
        </span>
        <span data-testid="review-progress" style={{
          fontFamily: 'var(--font-mono, monospace)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)',
        }}>
          {tf('review.progress', index + 1, session.length)}
        </span>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
          {tf('review.dueCount', queue?.dueTotal ?? 0)} · {tf('review.newCount', queue?.newTotal ?? 0)}
        </span>
        {current.overdueDays > 0 && (
          <span data-testid="review-overdue" style={{ fontSize: 'var(--text-xs)', color: 'var(--warning, #d97706)' }}>
            {tf('review.overdue', current.overdueDays)}
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--space-2)' }}>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            data-testid="review-open-note"
            onClick={() => { setCurrentFile(current.filePath); setView('note'); }}
          >
            {t('review.openNote')}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            data-testid="review-suspend"
            title={t('review.suspend')}
            onClick={async () => {
              try {
                await suspendCard(current.filePath, true);
                showToast(t('review.suspend'), 'success');
                advance();
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            <IconCheck size={14} />
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            data-testid="review-remove"
            title={t('review.remove')}
            onClick={async () => {
              try {
                await removeCardFromReview(current.filePath);
                showToast(t('review.removed'), 'success');
                advance();
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            <IconTrash size={14} />
          </button>
        </span>
      </div>

      {/* ── The card ─────────────────────────────────────────────────── */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 'var(--space-5) var(--space-4)' }}>
        <div style={{ maxWidth: 760, margin: '0 auto' }}>
          <h2 style={{ fontSize: 'var(--text-xl)', fontWeight: 600, marginBottom: 'var(--space-2)' }}>
            {current.title}
          </h2>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-4)' }}>
            {tf('review.reps', current.reps + 1)}
            {current.lapses > 0 && <> · {tf('review.lapses', current.lapses)}</>}
          </div>

          {revealed ? (
            /* Reuse the app's renderer: wikilinks, code, math and CJK typography
               are all already solved there, and a second renderer would drift. */
            <div data-testid="review-answer">
              <MarkdownRenderer content={body || current.preview} />
            </div>
          ) : (
            <div data-testid="review-prompt" style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-3)',
              padding: 'var(--space-6) var(--space-4)',
              border: '1px dashed var(--border)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--text-tertiary)',
              textAlign: 'center',
            }}>
              <span style={{ fontSize: 'var(--text-sm)' }}>{t('review.revealHint')}</span>
              <button
                type="button"
                className="btn btn-primary"
                data-testid="review-reveal"
                onClick={() => setRevealed(true)}
              >
                {t('review.reveal')}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Grade bar ────────────────────────────────────────────────── */}
      <div style={{
        borderTop: '1px solid var(--border-subtle)',
        padding: 'var(--space-3) var(--space-4)',
      }}>
        {error && (
          <div data-testid="review-grade-error" style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)', marginBottom: 'var(--space-2)' }}>
            {error}
          </div>
        )}
        <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'center', flexWrap: 'wrap' }}>
          {GRADES.map(({ grade, labelKey, tone }) => (
            <button
              key={grade}
              type="button"
              className="btn"
              data-testid={`review-grade-${grade}`}
              disabled={!revealed || busy}
              onClick={() => void submit(grade)}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                minWidth: 120,
                padding: 'var(--space-2) var(--space-3)',
                borderColor: tone,
                color: revealed ? tone : 'var(--text-muted)',
                opacity: revealed ? 1 : 0.5,
              }}
            >
              <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>
                <kbd style={{ opacity: 0.6, marginRight: 4 }}>{grade}</kbd>
                {t(labelKey)}
              </span>
              {/* The interval has to be visible *before* the click, or the four
                  buttons are indistinguishable guesses. */}
              <span data-testid={`review-interval-${grade}`} style={{
                fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono, monospace)', opacity: 0.85,
              }}>
                {formatInterval(previewFor.get(grade))}
              </span>
            </button>
          ))}
        </div>
        <div style={{ textAlign: 'center', fontSize: 10, color: 'var(--text-muted)', marginTop: 'var(--space-2)' }}>
          {t('review.shortcuts')}
        </div>
      </div>
    </div>
  );
}
