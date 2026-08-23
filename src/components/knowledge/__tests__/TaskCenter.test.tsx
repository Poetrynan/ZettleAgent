import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom';

import { TaskCenter, queryFor } from '../TaskCenter';
import {
  TaskCommitment,
  decideCommitment,
  getCommitmentList,
  getProactiveDigest,
  getSetting,
  markCommitmentNotified,
  scanCommitments,
  setSetting,
} from '../../../lib/tauri';
import { setLang } from '../../../lib/i18n';
import { en } from '../../../lib/i18n/en';
import { zh } from '../../../lib/i18n/zh';

vi.mock('../../../lib/tauri', () => ({
  decideCommitment: vi.fn().mockResolvedValue({}),
  getCommitmentList: vi.fn(),
  getProactiveDigest: vi.fn(),
  getSetting: vi.fn().mockResolvedValue(null),
  markCommitmentNotified: vi.fn().mockResolvedValue(undefined),
  scanCommitments: vi.fn().mockResolvedValue({ found: 0, created: 0 }),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

// i18n 不 mock：界面上不许出现 `awaiting_approval`/`too_soon` 这类后端串，那正是要验的。
beforeEach(() => {
  vi.clearAllMocks();
  setLang('en');
  vi.mocked(getProactiveDigest).mockResolvedValue({ items: [], silenced: null, expired: 0 });
  vi.mocked(getCommitmentList).mockResolvedValue([]);
  vi.mocked(getSetting).mockResolvedValue(null);
});

function task(over: Partial<TaskCommitment> = {}): TaskCommitment {
  return {
    id: 'c1',
    object_id: null,
    commitment_type: 'commitment',
    title: 'Send the draft to Wei',
    source: { source_type: 'file', source_id: 'D:\\vault\\notes\\meeting.md' },
    evidence_ids: [],
    owner: null,
    status: 'proposed',
    priority: 0,
    due_at_ms: null,
    remind_at_ms: null,
    dedupe_key: 'commitment::x',
    proactive_enabled: true,
    last_notified_at_ms: null,
    notify_count: 0,
    completion_evidence_id: null,
    return_target: 'notes/meeting.md',
    created_at_ms: 1,
    updated_at_ms: 2,
    ...over,
  };
}

describe('queryFor', () => {
  it('asks the backend for each view instead of filtering a single list in the UI', () => {
    expect(queryFor('needs', '', 1000).statuses).toEqual(['proposed']);
    expect(queryFor('done', '', 1000).statuses).toEqual(['done']);
    expect(queryFor('undated', '', 1000)).toMatchObject({
      statuses: ['proposed', 'active'],
      undatedOnly: true,
    });
  });

  it('counts an unaccepted task whose date already passed as overdue', () => {
    const q = queryFor('overdue', '', 1000);
    expect(q.dueBeforeMs).toBe(1000);
    expect(q.statuses).toContain('proposed');
  });

  it('passes the search term through rather than matching in the browser', () => {
    expect(queryFor('active', '周报', 1).search).toBe('周报');
    expect(queryFor('active', '', 1).search).toBeUndefined();
  });
});

describe('TaskCenter', () => {
  it('refuses to close a task without a line of evidence', async () => {
    vi.mocked(getCommitmentList).mockResolvedValue([task({ status: 'active' })]);
    render(<TaskCenter />);

    fireEvent.click(await screen.findByRole('button', { name: 'Mark done' }));
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    expect(
      screen.getByText(
        'A task cannot be closed without this: a done flag nobody can check is worse than an open task.',
      ),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('What actually got done?'), {
      target: { value: 'Sent it Friday' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(decideCommitment).toHaveBeenCalledWith({
        commitmentId: 'c1',
        action: 'complete',
        resultSummary: 'Sent it Friday',
      }),
    );
  });

  it('snoozes to an arbitrary moment, and rejects one that already passed', async () => {
    vi.mocked(getCommitmentList).mockResolvedValue([task({ status: 'active' })]);
    render(<TaskCenter />);

    fireEvent.click(await screen.findByRole('button', { name: 'Later' }));
    const field = screen.getByLabelText('Bring it back at');

    fireEvent.change(field, { target: { value: '2020-01-01T09:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Snooze' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Pick a time in the future.');
    expect(decideCommitment).not.toHaveBeenCalled();

    const future = new Date(Date.now() + 3 * 86_400_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const local = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T08:30`;
    fireEvent.change(field, { target: { value: local } });
    fireEvent.click(screen.getByRole('button', { name: 'Snooze' }));

    await waitFor(() => expect(decideCommitment).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(decideCommitment).mock.calls[0][0];
    expect(payload.action).toBe('snooze');
    expect(payload.untilMs).toBe(new Date(local).getTime());
  });

  it('does not offer actions a closed task cannot take', async () => {
    vi.mocked(getCommitmentList).mockResolvedValue([
      task({ status: 'done', completion_evidence_id: 'ev1' }),
    ]);
    render(<TaskCenter />);

    expect(await screen.findByText('Completion evidence recorded')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark done' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop reminding' })).toBeNull();
  });

  it('shows past-due work as overdue rather than just "accepted"', async () => {
    vi.mocked(getCommitmentList).mockResolvedValue([
      task({ status: 'active', due_at_ms: Date.now() - 86_400_000 }),
    ]);
    render(<TaskCenter />);

    expect(await screen.findByText(/^Was due /)).toBeInTheDocument();
  });

  it('switches the query when the view changes', async () => {
    render(<TaskCenter />);
    await waitFor(() => expect(getCommitmentList).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('tab', { name: 'Done' }));
    await waitFor(() =>
      expect(vi.mocked(getCommitmentList).mock.calls.at(-1)?.[0]?.statuses).toEqual(['done']),
    );
  });

  it('scans notes on demand and reports what it found', async () => {
    vi.mocked(scanCommitments).mockResolvedValue({ found: 4, created: 1 });
    render(<TaskCenter />);

    fireEvent.click(await screen.findByRole('button', { name: 'Scan notes for todos' }));
    expect(
      await screen.findByText('4 dated todo(s) found in your notes, 1 added here'),
    ).toBeInTheDocument();
  });
});

describe('proactive reminders', () => {
  it('says which gate silenced it instead of pretending there is nothing to do', async () => {
    vi.mocked(getProactiveDigest).mockResolvedValue({
      items: [],
      silenced: 'quiet_hours',
      expired: 2,
    });
    render(<TaskCenter />);

    expect(
      await screen.findByText('It is quiet hours, so nothing was surfaced.'),
    ).toBeInTheDocument();
    expect(screen.getByText('2 reminder(s) stopped because their date passed.')).toBeInTheDocument();
    // 后端串不许出现在界面上。
    expect(screen.queryByText(/quiet_hours/)).toBeNull();
  });

  it('records a nudge as shown, once, so the daily cap actually advances', async () => {
    vi.mocked(getProactiveDigest).mockResolvedValue({
      items: [task({ id: 'n1', status: 'active' })],
      silenced: null,
      expired: 0,
    });
    render(<TaskCenter />);

    await waitFor(() => expect(markCommitmentNotified).toHaveBeenCalledWith('n1'));
    expect(markCommitmentNotified).toHaveBeenCalledTimes(1);
  });

  it('does not mark anything when the gate held everything back', async () => {
    vi.mocked(getProactiveDigest).mockResolvedValue({
      items: [],
      silenced: 'daily_cap',
      expired: 0,
    });
    render(<TaskCenter />);

    expect(await screen.findByText("Today's reminder limit is used up.")).toBeInTheDocument();
    expect(markCommitmentNotified).not.toHaveBeenCalled();
  });

  it('keeps the switch off when nothing was ever configured', async () => {
    render(<TaskCenter />);

    const toggle = await screen.findByLabelText('Let the Agent remind me');
    expect(toggle).not.toBeChecked();
  });

  it('refuses a quiet-hours value it cannot parse, and saves a good one', async () => {
    render(<TaskCenter />);

    const quiet = await screen.findByLabelText('Quiet hours');
    fireEvent.change(quiet, { target: { value: 'evening' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    expect(await screen.findByText('Use two hours like 22-8.')).toBeInTheDocument();
    expect(setSetting).not.toHaveBeenCalled();

    fireEvent.change(quiet, { target: { value: '23-7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() =>
      expect(setSetting).toHaveBeenCalledWith('proactive_quiet_hours', '23-7'),
    );
  });
});

describe('copy', () => {
  it('has both languages for every task status, type, view and silencing reason', () => {
    const prefixes = [
      'knowledge.task.status.',
      'knowledge.task.type.',
      'knowledge.task.view.',
      'knowledge.proactive.silenced.',
    ];
    const keys = Object.keys(en).filter(k => prefixes.some(p => k.startsWith(p)));
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) {
      expect(zh[key as keyof typeof zh], `zh is missing ${key}`).toBeTruthy();
    }
  });
});


