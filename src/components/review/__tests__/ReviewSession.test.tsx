import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom';

import { ReviewSession, formatInterval } from '../ReviewSession';
import {
  getReviewQueue, gradeCard, readMarkdownFile,
  type ReviewQueue, type ReviewQueueEntry, type GradePreview,
} from '../../../lib/tauri';
import { setLang } from '../../../lib/i18n';

// The whole tauri module is a network boundary in the app; stub the commands
// this component calls, keep everything else (grade constants, types) real.
vi.mock('../../../lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/tauri')>('../../../lib/tauri');
  return {
    ...actual,
    getReviewQueue: vi.fn(),
    gradeCard: vi.fn(),
    readMarkdownFile: vi.fn(),
    suspendCard: vi.fn(),
    removeCardFromReview: vi.fn(),
  };
});

// The session lives inside the app's context; a thin stub is enough since the
// component only reads the actions, never the state.
vi.mock('../../../contexts/AppContext', () => ({
  useApp: () => ({
    setCurrentFile: vi.fn(),
    setView: vi.fn(),
    showToast: vi.fn(),
  }),
}));

// MarkdownRenderer pulls in the whole editor stack; the session only needs to
// know it rendered the answer, so a passthrough keeps the test about behaviour.
vi.mock('../../editor/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="rendered-md">{content}</div>,
}));

const queueMock = getReviewQueue as unknown as ReturnType<typeof vi.fn>;
const gradeMock = gradeCard as unknown as ReturnType<typeof vi.fn>;
const readMock = readMarkdownFile as unknown as ReturnType<typeof vi.fn>;

/** Grade previews in `Again, Hard, Good, Easy` order. */
function previews(): GradePreview[] {
  return [
    { grade: 1, intervalDays: 0, intervalMinutes: 1, state: 'learning' },
    { grade: 2, intervalDays: 0, intervalMinutes: 10, state: 'learning' },
    { grade: 3, intervalDays: 3, intervalMinutes: 4320, state: 'review' },
    { grade: 4, intervalDays: 7, intervalMinutes: 10080, state: 'review' },
  ];
}

function entry(overrides: Partial<ReviewQueueEntry> = {}): ReviewQueueEntry {
  return {
    filePath: 'v/note.md',
    title: 'A note',
    preview: 'preview text',
    dueAtMs: 0,
    state: 'new',
    overdueDays: 0,
    reps: 0,
    lapses: 0,
    gradePreviews: previews(),
    ...overrides,
  };
}

function emptyQueue(overrides: Partial<ReviewQueue> = {}): ReviewQueue {
  return {
    due: [],
    newCards: [],
    dueTotal: 0,
    newTotal: 0,
    reviewsDoneToday: 0,
    newDoneToday: 0,
    reviewsRemainingToday: 200,
    newRemainingToday: 20,
    ...overrides,
  };
}

beforeEach(() => {
  setLang('en');
  queueMock.mockReset();
  gradeMock.mockReset();
  readMock.mockReset();
  readMock.mockResolvedValue('# Full body\n\nThe answer.');
});

describe('formatInterval', () => {
  it('reads days once a card graduates and minutes while it is still learning', () => {
    expect(formatInterval({ grade: 3, intervalDays: 3, intervalMinutes: 4320, state: 'review' })).toBe('in 3 d');
    expect(formatInterval({ grade: 1, intervalDays: 0, intervalMinutes: 10, state: 'learning' })).toBe('in 10 min');
    // A sub-minute step still reads as "1 min", never "0 min".
    expect(formatInterval({ grade: 1, intervalDays: 0, intervalMinutes: 0, state: 'learning' })).toBe('in 1 min');
    expect(formatInterval(undefined)).toBe('');
  });
});

describe('ReviewSession', () => {
  it('shows the deck-empty state when nothing has ever been studied', async () => {
    queueMock.mockResolvedValue(emptyQueue());
    render(<ReviewSession />);
    await waitFor(() => expect(screen.getByTestId('review-empty-deck')).toBeInTheDocument());
    expect(screen.getByText('The review deck is empty')).toBeInTheDocument();
  });

  it('distinguishes "done for today" from "deck empty"', async () => {
    // Deck has cards, they were all studied today.
    queueMock.mockResolvedValue(emptyQueue({ dueTotal: 0, newTotal: 0, reviewsDoneToday: 12 }));
    render(<ReviewSession />);
    await waitFor(() => expect(screen.getByTestId('review-empty-due')).toBeInTheDocument());
  });

  it('gates the grade buttons behind a reveal and labels each with its interval', async () => {
    queueMock.mockResolvedValue(emptyQueue({ newCards: [entry()], newTotal: 1 }));
    render(<ReviewSession />);

    await waitFor(() => expect(screen.getByTestId('review-session')).toBeInTheDocument());

    // Before reveal: prompt is shown and grading is disabled.
    expect(screen.getByTestId('review-prompt')).toBeInTheDocument();
    expect(screen.getByTestId('review-grade-3')).toBeDisabled();

    // The interval labels are visible up front — the entire point of showing
    // "Good → 3 d" before the click.
    expect(screen.getByTestId('review-interval-1')).toHaveTextContent('in 1 min');
    expect(screen.getByTestId('review-interval-3')).toHaveTextContent('in 3 d');
    expect(screen.getByTestId('review-interval-4')).toHaveTextContent('in 7 d');

    fireEvent.click(screen.getByTestId('review-reveal'));

    await waitFor(() => expect(screen.getByTestId('review-answer')).toBeInTheDocument());
    expect(screen.getByTestId('rendered-md')).toHaveTextContent('The answer.');
    expect(screen.getByTestId('review-grade-3')).toBeEnabled();
  });

  it('grades the current card and advances to the next', async () => {
    queueMock.mockResolvedValue(emptyQueue({
      due: [entry({ filePath: 'v/a.md', title: 'First' })],
      newCards: [entry({ filePath: 'v/b.md', title: 'Second' })],
      dueTotal: 1,
      newTotal: 1,
    }));
    gradeMock.mockResolvedValue({
      filePath: 'v/a.md', state: 'review', dueAtMs: 0, stability: 4, difficulty: 5,
      reps: 1, lapses: 0, suspended: false, intervalDays: 3, intervalMinutes: 4320,
    });

    render(<ReviewSession />);
    await waitFor(() => expect(screen.getByText('First')).toBeInTheDocument());
    expect(screen.getByTestId('review-progress')).toHaveTextContent('1 / 2');

    fireEvent.click(screen.getByTestId('review-reveal'));
    await waitFor(() => expect(screen.getByTestId('review-answer')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByTestId('review-grade-3'));
    });

    expect(gradeMock).toHaveBeenCalledWith('v/a.md', 3);
    // Advanced to the second card, and the reveal reset.
    await waitFor(() => expect(screen.getByText('Second')).toBeInTheDocument());
    expect(screen.getByTestId('review-progress')).toHaveTextContent('2 / 2');
    expect(screen.getByTestId('review-prompt')).toBeInTheDocument();
  });

  it('reveals on Space and grades on a number key, but never grades before revealing', async () => {
    queueMock.mockResolvedValue(emptyQueue({ newCards: [entry({ filePath: 'v/a.md' })], newTotal: 1 }));
    gradeMock.mockResolvedValue({
      filePath: 'v/a.md', state: 'review', dueAtMs: 0, stability: 4, difficulty: 5,
      reps: 1, lapses: 0, suspended: false, intervalDays: 7, intervalMinutes: 10080,
    });

    render(<ReviewSession />);
    await waitFor(() => expect(screen.getByTestId('review-session')).toBeInTheDocument());

    // A number key before revealing must reveal, not grade.
    await act(async () => { fireEvent.keyDown(window, { key: '3' }); });
    expect(gradeMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('review-answer')).toBeInTheDocument());

    // Now a number key grades.
    await act(async () => { fireEvent.keyDown(window, { key: '4' }); });
    expect(gradeMock).toHaveBeenCalledWith('v/a.md', 4);
  });

  it('surfaces a grading failure without losing the card', async () => {
    queueMock.mockResolvedValue(emptyQueue({ newCards: [entry({ filePath: 'v/a.md' })], newTotal: 1 }));
    gradeMock.mockRejectedValue(new Error('db lock poisoned'));

    render(<ReviewSession />);
    await waitFor(() => expect(screen.getByTestId('review-session')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('review-reveal'));
    await waitFor(() => expect(screen.getByTestId('review-answer')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByTestId('review-grade-1'));
    });

    expect(screen.getByTestId('review-grade-error')).toHaveTextContent('db lock poisoned');
    // Still on the same card, so the user can retry.
    expect(screen.getByTestId('review-session')).toBeInTheDocument();
  });
});
