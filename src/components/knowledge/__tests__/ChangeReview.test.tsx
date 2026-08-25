import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom';

import { ChangeReview } from '../ChangeReview';
import {
  ChangeSetDetail,
  PendingChangeSet,
  decideChangeSet,
  getChangeSetDetail,
  getChangeSetHistory,
  getPendingChangeSets,
  previewChangeSet,
  undoAgentRun,
} from '../../../lib/tauri';
import { setLang } from '../../../lib/i18n';
import { en } from '../../../lib/i18n/en';
import { zh } from '../../../lib/i18n/zh';

vi.mock('../../../lib/tauri', () => ({
  decideChangeSet: vi.fn().mockResolvedValue({}),
  getChangeSetDetail: vi.fn(),
  getChangeSetHistory: vi.fn(),
  getPendingChangeSets: vi.fn(),
  previewChangeSet: vi.fn().mockResolvedValue({ hasConflicts: false, ops: [] }),
  undoAgentRun: vi.fn().mockResolvedValue({ restored: 2, trashed: [], failed: [], warnings: [] }),
}));

// i18n 不 mock：界面上不许出现 `awaiting_approval` 这种后端状态串，这正是要验的东西。
beforeEach(() => {
  vi.clearAllMocks();
  setLang('en');
});

function summary(over: Partial<PendingChangeSet> = {}): PendingChangeSet {
  return {
    id: 'cs1',
    actor: 'agent',
    runId: 'run-1',
    intent: 'edit_note',
    state: 'awaiting_approval',
    opCount: 1,
    createdAtMs: 1,
    updatedAtMs: 2,
    commitError: null,
    ...over,
  };
}

function detail(over: Partial<ChangeSetDetail> = {}): ChangeSetDetail {
  return {
    changeset: {
      id: 'cs1',
      actor: 'agent',
      session_id: null,
      run_id: 'run-1',
      intent: 'edit_note',
      state: 'awaiting_approval',
      risk: 'medium',
      requires_approval: true,
      dry_run: true,
      evidence_ids: [],
      created_at_ms: 1,
      updated_at_ms: 2,
      commit_error: null,
    },
    ops: [
      {
        opId: 'op1',
        seq: 0,
        opKind: 'edit',
        targetObjectId: 'o1',
        path: 'D:\\vault\\notes\\Zettelkasten.md',
        newPath: null,
        before: 'first line\nsecond line',
        after: 'first line\nsecond line changed',
        beforeSource: 'recorded_version',
        reason: 'The note contradicted the source.',
        evidenceIds: [],
        affectedObjects: [],
        conflict: null,
        conflictMessage: null,
        relation: null,
      },
    ],
    undoableEntries: 0,
    journalEntries: 0,
    ...over,
  };
}

describe('ChangeReview', () => {
  it('names the state in plain language instead of printing the backend string', async () => {
    vi.mocked(getPendingChangeSets).mockResolvedValue([summary()]);

    render(<ChangeReview />);

    await waitFor(() => expect(screen.getByText('Waiting on you')).toBeInTheDocument());
    expect(screen.queryByText('awaiting_approval')).toBeNull();
  });

  it('shows a real line diff, not two blobs of text', async () => {
    vi.mocked(getPendingChangeSets).mockResolvedValue([summary()]);
    vi.mocked(getChangeSetDetail).mockResolvedValue(detail());

    render(<ChangeReview />);
    fireEvent.click(await screen.findByText('Review diff'));

    await waitFor(() => expect(screen.getByText(/line\(s\) added/)).toBeInTheDocument());
    // 未改动的行留在原样，改动的那一行分成一删一增。
    expect(screen.getByText('first line')).toBeInTheDocument();
    expect(screen.getByText('second line')).toBeInTheDocument();
    expect(screen.getByText('second line changed')).toBeInTheDocument();
  });

  it('keeps the absolute path out of the heading but still available', async () => {
    vi.mocked(getPendingChangeSets).mockResolvedValue([summary()]);
    vi.mocked(getChangeSetDetail).mockResolvedValue(detail());

    render(<ChangeReview />);
    fireEvent.click(await screen.findByText('Review diff'));

    await waitFor(() => expect(screen.getByText('Zettelkasten.md')).toBeInTheDocument());
    const full = screen.getByText('D:\\vault\\notes\\Zettelkasten.md');
    expect(full.closest('details')).not.toBeNull();
  });

  it('refuses to offer approval while a step is out of date', async () => {
    vi.mocked(getPendingChangeSets).mockResolvedValue([summary({ state: 'conflicted' })]);
    vi.mocked(getChangeSetDetail).mockResolvedValue(
      detail({
        changeset: { ...detail().changeset, state: 'conflicted' },
        ops: [
          {
            ...detail().ops[0],
            conflict: { kind: 'version', expected: 3, actual: 4 },
            conflictMessage: 'Someone changed this note after the Agent read it.',
          },
        ],
      }),
    );

    render(<ChangeReview />);
    fireEvent.click(await screen.findByText('Review diff'));

    await waitFor(() =>
      expect(
        screen.getByText('Someone changed this note after the Agent read it.'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(decideChangeSet).not.toHaveBeenCalled();
  });

  it('previews before approving so the decision is recorded against a checked batch', async () => {
    vi.mocked(getPendingChangeSets).mockResolvedValue([summary()]);
    vi.mocked(getChangeSetDetail).mockResolvedValue(detail());

    render(<ChangeReview />);
    fireEvent.click(await screen.findByText('Review diff'));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(decideChangeSet).toHaveBeenCalledWith('cs1', true));
    expect(previewChangeSet).toHaveBeenCalledWith('cs1');
  });

  it('hides undo when the journal has nothing to restore', async () => {
    vi.mocked(getPendingChangeSets).mockResolvedValue([]);
    vi.mocked(getChangeSetHistory).mockResolvedValue([summary({ state: 'committed' })]);
    vi.mocked(getChangeSetDetail).mockResolvedValue(
      detail({ changeset: { ...detail().changeset, state: 'committed' } }),
    );

    render(<ChangeReview />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Already happened' }));
    fireEvent.click(await screen.findByText('Review diff'));

    // 按下去什么也不发生的撤销按钮比没有按钮更伤：用户会以为已经撤销了。
    await waitFor(() =>
      expect(
        screen.getByText(
          'No restore points were recorded for this turn, so it cannot be undone here.',
        ),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'Undo this turn' })).toBeNull();
  });

  it('undoes the whole turn, and says that is what it does', async () => {
    vi.mocked(getPendingChangeSets).mockResolvedValue([]);
    vi.mocked(getChangeSetHistory).mockResolvedValue([summary({ state: 'committed' })]);
    vi.mocked(getChangeSetDetail).mockResolvedValue(
      detail({
        changeset: { ...detail().changeset, state: 'committed' },
        undoableEntries: 2,
        journalEntries: 2,
      }),
    );

    render(<ChangeReview />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Already happened' }));
    fireEvent.click(await screen.findByText('Review diff'));

    expect(
      await screen.findByText('Undo restores every file this turn wrote, not just this batch.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo this turn' }));
    fireEvent.click(screen.getByRole('button', { name: /Undo — restore 2 file/ }));

    await waitFor(() => expect(undoAgentRun).toHaveBeenCalledWith('run-1'));
  });

  it('explains a rename instead of drawing it as a rewrite', async () => {
    vi.mocked(getPendingChangeSets).mockResolvedValue([summary()]);
    vi.mocked(getChangeSetDetail).mockResolvedValue(
      detail({
        ops: [
          {
            ...detail().ops[0],
            opKind: 'rename',
            path: 'D:\\vault\\old.md',
            newPath: 'D:\\vault\\new.md',
            before: null,
            after: null,
            beforeSource: 'none',
          },
        ],
      }),
    );

    render(<ChangeReview />);
    fireEvent.click(await screen.findByText('Review diff'));

    await waitFor(() =>
      expect(
        screen.getByText('The text is unchanged — only its location moves.'),
      ).toBeInTheDocument(),
    );
    // 原位置/新位置各自一行，两侧都写清楚，而不是画一个假的整篇重写。
    const rows = document.querySelectorAll('.kc-diff-move .kc-kv-val');
    expect(Array.from(rows).map(r => r.textContent)).toEqual(['old.md', 'new.md']);
  });

  it('shows a relation change as an edge, not as a text rewrite', async () => {
    vi.mocked(getPendingChangeSets).mockResolvedValue([
      summary({ intent: 'knowledge_graph_plan' }),
    ]);
    vi.mocked(getChangeSetDetail).mockResolvedValue(
      detail({
        ops: [
          {
            ...detail().ops[0],
            opKind: 'add_relation',
            path: 'D:\\vault\\a.md',
            before: null,
            after: 'a.md --[supports]--> b.md (confidence 0.60)',
            beforeSource: 'none',
            relation: {
              sourcePath: 'D:\\vault\\a.md',
              targetPath: 'D:\\vault\\b.md',
              relationType: 'supports',
              confidence: 0.6,
              reason: 'Both notes argue the same point.',
              origin: 'agent_proposed',
              oldConfidence: null,
              oldReason: null,
            },
          },
        ],
      }),
    );

    render(<ChangeReview />);
    // 批次意图不是给用户读的内部工具名。
    expect(await screen.findByText('Graph relation proposals')).toBeInTheDocument();
    fireEvent.click(await screen.findByText('Review diff'));

    // 方向、类型、来源都摊开：一条边不能只显示一行摘要，也不能画成整篇重写。
    await waitFor(() => expect(document.querySelector('.kc-diff-move')).not.toBeNull());
    const rows = document.querySelectorAll('.kc-diff-move .kc-kv-val');
    expect(Array.from(rows).map(r => r.textContent)).toEqual([
      'a.md',
      'supports',
      'b.md',
      'inferred by the Agent · confidence 0.60',
    ]);
    expect(
      screen.getByText(
        'Approving adds this directed edge to the graph. Neither note’s text changes.',
      ),
    ).toBeInTheDocument();
    // 关系操作没有正文，所以不该出现任何 diff 行。
    expect(document.querySelectorAll('.kc-diff-line').length).toBe(0);
  });

  it('has both languages for every state, step and operation kind', () => {
    const prefixes = ['knowledge.change.state.', 'knowledge.change.step.', 'knowledge.change.opKind.'];
    const keys = Object.keys(en).filter(k => prefixes.some(p => k.startsWith(p)));
    expect(keys.length).toBeGreaterThan(15);
    for (const key of keys) {
      expect(zh[key as keyof typeof zh], `zh is missing ${key}`).toBeTruthy();
    }
  });
});
