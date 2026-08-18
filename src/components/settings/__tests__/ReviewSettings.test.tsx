import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom';

import { ReviewSettingsSection } from '../ReviewSettings';
import { getFsrsConfig, setFsrsConfig, getReviewStats, DEFAULT_FSRS_CONFIG } from '../../../lib/tauri';
import { setLang } from '../../../lib/i18n';

vi.mock('../../../lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/tauri')>('../../../lib/tauri');
  return {
    ...actual,
    getFsrsConfig: vi.fn(),
    setFsrsConfig: vi.fn(),
    getReviewStats: vi.fn(),
  };
});

const getMock = getFsrsConfig as unknown as ReturnType<typeof vi.fn>;
const setMock = setFsrsConfig as unknown as ReturnType<typeof vi.fn>;
const statsMock = getReviewStats as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  // The app defaults to Chinese; assert against English so the test reads for a
  // non-Chinese maintainer too.
  setLang('en');
  getMock.mockReset();
  setMock.mockReset();
  statsMock.mockReset();
  statsMock.mockRejectedValue(new Error('no history'));
});

describe('ReviewSettingsSection', () => {
  it('marks the stored retention target as selected', async () => {
    getMock.mockResolvedValue({ ...DEFAULT_FSRS_CONFIG, desiredRetention: 0.85 });
    render(<ReviewSettingsSection />);

    await waitFor(() => {
      expect(screen.getByTestId('fsrs-retention-0.85')).toHaveAttribute('aria-checked', 'true');
    });
    expect(screen.getByTestId('fsrs-retention-0.9')).toHaveAttribute('aria-checked', 'false');
  });

  it('sends only the changed field, so the other knobs keep their stored value', async () => {
    getMock.mockResolvedValue({ ...DEFAULT_FSRS_CONFIG });
    setMock.mockResolvedValue({ ...DEFAULT_FSRS_CONFIG, desiredRetention: 0.95 });

    render(<ReviewSettingsSection />);
    await waitFor(() => expect(screen.getByTestId('fsrs-retention-0.9')).toHaveAttribute('aria-checked', 'true'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('fsrs-retention-0.95'));
    });

    // Exactly one field: a full-config write would clobber a knob the user
    // changed in another pane.
    expect(setMock).toHaveBeenCalledWith({ desiredRetention: 0.95 });
    expect(screen.getByTestId('fsrs-retention-0.95')).toHaveAttribute('aria-checked', 'true');
  });

  it('rolls back and shows the reason when the backend rejects a value', async () => {
    getMock.mockResolvedValue({ ...DEFAULT_FSRS_CONFIG });
    setMock.mockRejectedValue(new Error('desiredRetention = 0.95 is outside the allowed range'));

    render(<ReviewSettingsSection />);
    await waitFor(() => expect(screen.getByTestId('fsrs-retention-0.9')).toHaveAttribute('aria-checked', 'true'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('fsrs-retention-0.95'));
    });

    expect(screen.getByTestId('fsrs-retention-0.9')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('fsrs-error')).toHaveTextContent('outside the allowed range');
  });

  it('commits a daily cap on blur, not per keystroke', async () => {
    getMock.mockResolvedValue({ ...DEFAULT_FSRS_CONFIG });
    setMock.mockResolvedValue({ ...DEFAULT_FSRS_CONFIG, newPerDay: 40 });

    render(<ReviewSettingsSection />);
    const input = await screen.findByTestId('fsrs-knob-newPerDay');

    fireEvent.change(input, { target: { value: '40' } });
    // Nothing written yet — typing "40" must not persist "4" on the way.
    expect(setMock).not.toHaveBeenCalled();

    await act(async () => { fireEvent.blur(input); });
    expect(setMock).toHaveBeenCalledWith({ newPerDay: 40 });
  });

  it('renders the forecast and the retention figure once stats are available', async () => {
    getMock.mockResolvedValue({ ...DEFAULT_FSRS_CONFIG });
    statsMock.mockResolvedValue({
      totalCards: 12, newCount: 4, learningCount: 1, reviewCount: 6, relearningCount: 1,
      suspendedCount: 0, dueToday: 3,
      forecast: Array.from({ length: 8 }, (_, i) => ({ dayOffset: i, count: i })),
      retentionRate: 0.917, reviewsToday: 5, totalReviews: 88, streakDays: 4,
    });

    render(<ReviewSettingsSection />);
    await waitFor(() => expect(screen.getByTestId('review-stats')).toBeInTheDocument());
    expect(screen.getByTestId('review-retention')).toHaveTextContent('91.7%');
    expect(screen.getByText('4-day streak · 5 reviewed today')).toBeInTheDocument();
    // One bar per forecast day, today included.
    expect(screen.getByTestId('review-forecast').children).toHaveLength(8);
  });

  it('says so plainly when there is not enough history to measure retention', async () => {
    getMock.mockResolvedValue({ ...DEFAULT_FSRS_CONFIG });
    statsMock.mockResolvedValue({
      totalCards: 2, newCount: 2, learningCount: 0, reviewCount: 0, relearningCount: 0,
      suspendedCount: 0, dueToday: 0,
      forecast: [{ dayOffset: 0, count: 0 }],
      retentionRate: null, reviewsToday: 0, totalReviews: 0, streakDays: 0,
    });

    render(<ReviewSettingsSection />);
    await waitFor(() => expect(screen.getByTestId('review-retention')).toBeInTheDocument());
    // Not "0.0%", which would read as "you forget everything".
    expect(screen.getByTestId('review-retention')).toHaveTextContent('Not enough review history yet');
  });
});
