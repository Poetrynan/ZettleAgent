import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom';

import { DiffApprovalCard, splitTaintPrefix } from '../DiffApprovalCard';
import { approveToolCall, addApprovalRule } from '../../../lib/tauri';

vi.mock('../../../lib/tauri', () => ({
  approveToolCall: vi.fn().mockResolvedValue(true),
  rejectToolCall: vi.fn().mockResolvedValue(true),
  addApprovalRule: vi.fn().mockResolvedValue(1),
}));

/** Minimal `ApprovalDiffData` JSON, shaped like `build_approval_diff_data` output. */
function diffJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    tool_name: 'edit_note',
    file_path: 'notes/a.md',
    diff_type: 'edit',
    tool_args_json: '{"content":"hello"}',
    title: 'Rewrite note',
    risk_level: 'medium',
    ...over,
  });
}

describe('DiffApprovalCard risk surface', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the risk badge for the level the backend computed', () => {
    render(
      <DiffApprovalCard
        approvalId="a1"
        actionDescription=""
        diffJson={diffJson({ risk_level: 'high' })}
        onResolved={() => {}}
        lang="en"
      />,
    );
    expect(screen.getByText('High')).toBeInTheDocument();
  });

  it('renders the escalation reason when the backend supplies one', () => {
    render(
      <DiffApprovalCard
        approvalId="a1"
        actionDescription=""
        diffJson={diffJson({ risk_reason: 'hub note · batch mutation' })}
        onResolved={() => {}}
        lang="en"
      />,
    );
    expect(screen.getByText('hub note · batch mutation')).toBeInTheDocument();
  });

  /** The hard invariant: deletion can never be pre-authorized, so the button must not exist. */
  it('never offers "always allow" for critical risk', () => {
    render(
      <DiffApprovalCard
        approvalId="a1"
        actionDescription=""
        diffJson={diffJson({ tool_name: 'delete_note', diff_type: 'delete', risk_level: 'critical' })}
        onResolved={() => {}}
        lang="en"
      />,
    );
    expect(screen.getByText('Critical')).toBeInTheDocument();
    expect(screen.queryByText('Always allow this kind')).not.toBeInTheDocument();
  });

  it('writes a persistent rule at the card risk level, then approves', async () => {
    const onResolved = vi.fn();
    render(
      <DiffApprovalCard
        approvalId="a1"
        actionDescription=""
        diffJson={diffJson({ tool_name: 'append_to_note', risk_level: 'low' })}
        onResolved={onResolved}
        lang="en"
      />,
    );

    fireEvent.click(screen.getByText('Always allow this kind'));

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith(true));
    expect(addApprovalRule).toHaveBeenCalledWith(
      'append_to_note', '', 'low', 'persistent', expect.any(String),
    );
    expect(approveToolCall).toHaveBeenCalledWith('a1');
  });

  it('does not describe a delete as permanent — it goes to the recycle bin', () => {
    render(
      <DiffApprovalCard
        approvalId="a1"
        actionDescription=""
        diffJson={diffJson({ tool_name: 'delete_note', diff_type: 'delete', risk_level: 'critical' })}
        onResolved={() => {}}
        lang="en"
      />,
    );
    expect(screen.getByText(/recycle bin/i)).toBeInTheDocument();
  });
});

describe('splitTaintPrefix', () => {
  it('leaves an undecorated title alone', () => {
    expect(splitTaintPrefix('Rewrite note')).toEqual({ taint: null, title: 'Rewrite note' });
  });

  it('separates the external-read warning from the action title', () => {
    const raw = '⚠ 本轮曾读取外部内容（web:https://evil.example/post） — Rewrite note';
    expect(splitTaintPrefix(raw)).toEqual({
      taint: { kind: 'external', source: 'web:https://evil.example/post' },
      title: 'Rewrite note',
    });
  });

  it('distinguishes an injection hit from a plain external read', () => {
    const raw = '⚠ 本轮检测到疑似注入内容（injection:ignore_previous_zh via read_note） — Update agent memory';
    const { taint, title } = splitTaintPrefix(raw);
    expect(taint?.kind).toBe('injection');
    expect(title).toBe('Update agent memory');
  });
});
