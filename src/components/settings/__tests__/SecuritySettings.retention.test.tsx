/**
 * Recycle-bin retention. The subtlety worth locking down: `0` means "never
 * sweep", not "purge everything" — `sweep_expired_trash_impl` returns early on 0.
 * A UI that implied the latter would be actively dangerous.
 */
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom';

import { SecuritySettingsSection } from '../SecuritySettings';
import {
  getTrashRetentionDays, setTrashRetentionDays,
  getPermissionMode, listApprovalRules, listAgentRuns, listTrash,
} from '../../../lib/tauri';

vi.mock('../../../lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/tauri')>('../../../lib/tauri');
  return {
    ...actual,
    getPermissionMode: vi.fn(),
    setPermissionMode: vi.fn(),
    listApprovalRules: vi.fn(),
    deleteApprovalRule: vi.fn(),
    listAgentRuns: vi.fn(),
    undoAgentRun: vi.fn(),
    listTrash: vi.fn(),
    restoreFromTrash: vi.fn(),
    emptyTrash: vi.fn(),
    getTrashRetentionDays: vi.fn(),
    setTrashRetentionDays: vi.fn(),
  };
});

const getRetention = getTrashRetentionDays as unknown as ReturnType<typeof vi.fn>;
const setRetention = setTrashRetentionDays as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  (getPermissionMode as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('standard');
  (listApprovalRules as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (listAgentRuns as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (listTrash as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

function renderSection() {
  return render(<SecuritySettingsSection isZh={false} vaultPath="C:/vault" />);
}

describe('trash retention', () => {
  it('shows the persisted retention window', async () => {
    getRetention.mockResolvedValue(14);
    renderSection();
    await waitFor(() => expect(screen.getByTestId('trash-retention-days')).toHaveValue(14));
  });

  it('persists a new window on blur', async () => {
    getRetention.mockResolvedValue(30);
    setRetention.mockResolvedValue(undefined);
    renderSection();

    const input = await waitFor(() => screen.getByTestId('trash-retention-days'));
    await act(async () => {
      fireEvent.change(input, { target: { value: '7' } });
      fireEvent.blur(input);
    });

    expect(setRetention).toHaveBeenCalledWith(7);
  });

  it('describes 0 as disabling the sweep, never as clearing the bin', async () => {
    getRetention.mockResolvedValue(0);
    renderSection();

    await waitFor(() => expect(screen.getByTestId('trash-retention-days')).toHaveValue(0));
    expect(screen.getByText(/currently: disabled/)).toBeInTheDocument();
    expect(screen.getByText(/never auto-delete.*not "delete everything now"/)).toBeInTheDocument();
  });

  it('rolls back to the stored value when the write fails', async () => {
    getRetention.mockResolvedValue(30);
    setRetention.mockRejectedValue(new Error('db lock poisoned'));
    renderSection();

    const input = await waitFor(() => screen.getByTestId('trash-retention-days'));
    await act(async () => {
      fireEvent.change(input, { target: { value: '1' } });
      fireEvent.blur(input);
    });

    expect(screen.getByTestId('trash-retention-days')).toHaveValue(30);
    expect(screen.getByText(/db lock poisoned/)).toBeInTheDocument();
  });

  it('falls back to the documented default when the command is missing', async () => {
    getRetention.mockRejectedValue(new Error('command get_trash_retention_days not allowed'));
    renderSection();

    // 30, not an empty box — an empty box would read as "no retention at all".
    await waitFor(() => expect(screen.getByTestId('trash-retention-days')).toHaveValue(30));
  });
});
