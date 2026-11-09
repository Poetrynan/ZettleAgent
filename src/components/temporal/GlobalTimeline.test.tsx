import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
const app = vi.hoisted(() => ({
  state: { vaultPath: '/vault', vaultPaths: ['/vault'], lang: 'en' },
  setCurrentFile: vi.fn(), setView: vi.fn(),
}));
vi.mock('../../contexts/AppContext', () => ({ useApp: () => app }));
vi.mock('../../lib/tauri', () => ({ getGlobalTimeline: vi.fn() }));
import { getGlobalTimeline } from '../../lib/tauri';
import { GlobalTimeline } from './GlobalTimeline';

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  vi.useRealTimers();
  vi.mocked(getGlobalTimeline).mockResolvedValue([
    { id: 1, note_path: '/vault/a.md', event_type: 'updated', event_timestamp: '2026-11-08T23:50:00+08:00', event_details: 'Edited passage', old_fact_id: null, new_fact_id: null },
  ]);
});

describe('GlobalTimeline', () => {
  it('uses calendar dates, opens the editor, and states its date range', async () => {
    // Local calendar boundaries must work in CI's timezone as well as Singapore.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 10, 9, 0, 10).getTime());
    vi.mocked(getGlobalTimeline).mockResolvedValue([
      { id: 1, note_path: '/vault/a.md', event_type: 'updated', event_timestamp: new Date(2026, 10, 8, 23, 50).toISOString(), event_details: 'Edited passage', old_fact_id: null, new_fact_id: null },
    ]);
    render(<GlobalTimeline />);
    const event = await screen.findByRole('button', { name: /a.*Edited passage/ });
    expect(screen.getAllByText('Yesterday').length).toBeGreaterThan(0);
    expect(screen.getByText('Last 90 days')).toBeInTheDocument();
    fireEvent.click(event);
    expect(app.setCurrentFile).toHaveBeenCalledWith('/vault/a.md');
    expect(app.setView).toHaveBeenCalledWith('note');
    clock.mockRestore();
  });

  it('refreshes when a completed task changes the refresh key', async () => {
    const { rerender } = render(<GlobalTimeline refreshKey={0} />);
    await waitFor(() => expect(getGlobalTimeline).toHaveBeenCalledTimes(1));
    rerender(<GlobalTimeline refreshKey={1} />);
    await waitFor(() => expect(getGlobalTimeline).toHaveBeenCalledTimes(2));
  });

  it('distinguishes a fetch error from an empty timeline', async () => {
    vi.mocked(getGlobalTimeline).mockRejectedValue(new Error('offline'));
    render(<GlobalTimeline />);
    expect(await screen.findByRole('button', { name: 'Retry timeline' })).toBeEnabled();
    expect(screen.queryByText('No timeline events yet')).not.toBeInTheDocument();
  });
});
