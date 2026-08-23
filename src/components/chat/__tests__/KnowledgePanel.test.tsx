import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom';

import { KnowledgePanel } from '../KnowledgePanel';
import {
  ChangeSetDryRun,
  ContextPackageSummary,
  KnowledgeIndexHealth,
  MemoryItem,
  PendingChangeSet,
  TaskCommitment,
  confirmMemory,
  decideCommitment,
  getCommitmentInbox,
  getKnowledgeIndexHealth,
  getMemoryInbox,
  getPendingChangeSets,
  previewChangeSet,
  runKnowledgeBackfill,
} from '../../../lib/tauri';

vi.mock('../../../lib/tauri', () => ({
  confirmMemory: vi.fn(),
  decideChangeSet: vi.fn().mockResolvedValue(undefined),
  decideCommitment: vi.fn(),
  forgetMemory: vi.fn(),
  getCommitmentInbox: vi.fn(),
  getKnowledgeAuditTrail: vi.fn().mockResolvedValue([]),
  getKnowledgeIndexHealth: vi.fn(),
  getMemoryInbox: vi.fn(),
  getPendingChangeSets: vi.fn(),
  previewChangeSet: vi.fn(),
  rejectMemory: vi.fn(),
  runKnowledgeBackfill: vi.fn(),
  scanCommitments: vi.fn(),
}));

vi.mock('../../../lib/i18n', () => ({ getLang: () => 'en' }));

/** 面板每个 tab 都自己拉数据，所以默认让每个命令都有一个“空但成功”的回答。 */
function quietBackend() {
  vi.mocked(getMemoryInbox).mockResolvedValue([]);
  vi.mocked(getPendingChangeSets).mockResolvedValue([]);
  vi.mocked(getCommitmentInbox).mockResolvedValue([]);
  vi.mocked(getKnowledgeIndexHealth).mockResolvedValue(health());
}

function health(over: Partial<KnowledgeIndexHealth> = {}): KnowledgeIndexHealth {
  return {
    schemaVersion: 1,
    totalFiles: 10,
    indexedDocuments: 10,
    blockObjects: 4,
    pendingJobs: 0,
    failedJobs: 0,
    lastError: null,
    lastRunAtMs: null,
    memoryItems: 2,
    memoryInbox: 0,
    openChangesets: 0,
    openCommitments: 0,
    ...over,
  };
}

function pkg(over: Partial<ContextPackageSummary> = {}): ContextPackageSummary {
  return {
    query: 'what did I decide about caching',
    intent: 'search',
    scope: ['vault'],
    counts: { facts: 1, memories: 0, openTasks: 0, related: 0, conflicts: 0 },
    items: [
      {
        objectId: 'obj-1',
        kind: 'note',
        title: 'Caching decision',
        locator: 'notes/caching.md#L3',
        score: 0.82,
        why: ['fts', 'backlink'],
        warnings: [],
      },
    ],
    knowledgeGaps: [],
    warnings: [],
    budget: { maxTokens: 4000, usedTokens: 1200, truncatedCandidates: 0 },
    ...over,
  };
}

function openTab(name: RegExp) {
  fireEvent.click(screen.getByRole('tab', { name }));
}

describe('Context Inspector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    quietBackend();
  });

  it('shows the query, the budget and every reason an item was recalled', async () => {
    render(<KnowledgePanel contextPackage={pkg()} runId="run-1" onClose={() => {}} />);

    expect(screen.getByText('what did I decide about caching')).toBeInTheDocument();
    expect(screen.getByText('Caching decision')).toBeInTheDocument();
    expect(screen.getByText('notes/caching.md#L3')).toBeInTheDocument();
    expect(screen.getByText('fts')).toBeInTheDocument();
    expect(screen.getByText('backlink')).toBeInTheDocument();
    expect(screen.getByText(/1200 \/ 4000/)).toBeInTheDocument();
  });

  /** 被裁掉的候选必须单独说。只显示“用了多少 token”会让人以为召回是完整的。 */
  it('says out loud how many candidates the budget cut', () => {
    render(
      <KnowledgePanel
        contextPackage={pkg({ budget: { maxTokens: 4000, usedTokens: 4000, truncatedCandidates: 7 } })}
        runId="run-1"
        onClose={() => {}}
      />,
    );

    expect(screen.getByText(/7 candidates dropped/)).toBeInTheDocument();
  });

  it('surfaces per-item warnings and knowledge gaps instead of hiding them', () => {
    render(
      <KnowledgePanel
        contextPackage={pkg({
          warnings: ['untrusted source in context'],
          knowledgeGaps: ['no note covers the retention policy'],
          items: [
            {
              objectId: 'obj-2',
              kind: 'memory',
              title: 'prefers dark mode',
              locator: null,
              score: 0.4,
              why: ['memory'],
              warnings: ['unconfirmed'],
            },
          ],
        })}
        runId={null}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText('untrusted source in context')).toBeInTheDocument();
    expect(screen.getByText('no note covers the retention policy')).toBeInTheDocument();
    expect(screen.getByText('unconfirmed')).toBeInTheDocument();
  });

  /** 没编译过上下文不是错误，也不能渲染成“召回为空”。 */
  it('distinguishes "nothing compiled yet" from "nothing found"', () => {
    render(<KnowledgePanel contextPackage={null} runId={null} onClose={() => {}} />);
    expect(screen.getByText(/No context compiled yet/)).toBeInTheDocument();
  });
});

function memory(over: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'mem-1',
    kind: 'preference',
    claim: 'writes weekly reviews on Friday',
    scope: 'global',
    confidence: 0.71,
    conflicts_with_id: null,
    expires_at_ms: null,
    source: { source_type: 'message', source_id: 'msg-9' },
    ...over,
  } as MemoryItem;
}

describe('Memory Inbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    quietBackend();
  });

  it('shows the claim with the evidence it came from', async () => {
    vi.mocked(getMemoryInbox).mockResolvedValue([memory()]);
    render(<KnowledgePanel contextPackage={null} runId={null} onClose={() => {}} />);
    openTab(/Memory/);

    expect(await screen.findByText('writes weekly reviews on Friday')).toBeInTheDocument();
    expect(screen.getByText('msg-9')).toBeInTheDocument();
  });

  /** 失败必须长得像失败。把读取错误画成“没有候选”会让人以为提取器没工作。 */
  it('renders a read failure as a failure with a retry, not as an empty inbox', async () => {
    vi.mocked(getMemoryInbox).mockRejectedValueOnce(new Error('database is locked'));
    render(<KnowledgePanel contextPackage={null} runId={null} onClose={() => {}} />);
    openTab(/Memory/);

    expect(await screen.findByText('database is locked')).toBeInTheDocument();
    expect(screen.queryByText(/No candidate memories/)).not.toBeInTheDocument();

    vi.mocked(getMemoryInbox).mockResolvedValue([memory()]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('writes weekly reviews on Friday')).toBeInTheDocument();
  });

  /** 确认是唯一写 `confirmed_by` 的路径，所以它必须由用户点出来。 */
  it('confirms only when the user asks, then re-reads the inbox', async () => {
    vi.mocked(getMemoryInbox).mockResolvedValue([memory()]);
    vi.mocked(confirmMemory).mockResolvedValue(memory({ claim: 'confirmed' }));
    render(<KnowledgePanel contextPackage={null} runId={null} onClose={() => {}} />);
    openTab(/Memory/);
    await screen.findByText('writes weekly reviews on Friday');

    expect(confirmMemory).not.toHaveBeenCalled();
    vi.mocked(getMemoryInbox).mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(confirmMemory).toHaveBeenCalledWith('mem-1'));
    expect(await screen.findByText(/No candidate memories/)).toBeInTheDocument();
  });

  it('marks a memory that contradicts an existing one', async () => {
    vi.mocked(getMemoryInbox).mockResolvedValue([memory({ conflicts_with_id: 'mem-0' })]);
    render(<KnowledgePanel contextPackage={null} runId={null} onClose={() => {}} />);
    openTab(/Memory/);

    expect(await screen.findByText('conflicts')).toBeInTheDocument();
  });
});

function changeSet(over: Partial<PendingChangeSet> = {}): PendingChangeSet {
  return {
    id: 'cs-1',
    actor: 'agent',
    runId: 'run-1',
    intent: 'tidy up the caching note',
    state: 'proposed',
    opCount: 1,
    createdAtMs: 1,
    updatedAtMs: 2,
    commitError: null,
    ...over,
  };
}

function dryRun(over: Partial<ChangeSetDryRun> = {}): ChangeSetDryRun {
  return {
    changesetId: 'cs-1',
    hasConflicts: false,
    touchedPaths: ['notes/caching.md'],
    ops: [
      {
        opId: 'op-1',
        seq: 1,
        opKind: 'edit',
        targetObjectId: 'obj-1',
        path: 'notes/caching.md',
        before: 'old body',
        after: 'new body',
        reason: 'merge duplicate section',
        evidenceIds: ['ev-1'],
        affectedObjects: [],
        conflict: null,
      },
    ],
    ...over,
  } as ChangeSetDryRun;
}

describe('Change Preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    quietBackend();
  });

  it('runs the dry run on expand and shows both sides of the edit', async () => {
    vi.mocked(getPendingChangeSets).mockResolvedValue([changeSet()]);
    vi.mocked(previewChangeSet).mockResolvedValue(dryRun());
    render(<KnowledgePanel contextPackage={null} runId={null} onClose={() => {}} />);
    openTab(/Changes/);

    fireEvent.click(await screen.findByText('tidy up the caching note'));

    await waitFor(() => expect(previewChangeSet).toHaveBeenCalledWith('cs-1'));
    expect(await screen.findByText('old body')).toBeInTheDocument();
    expect(screen.getByText('new body')).toBeInTheDocument();
    expect(screen.getByText('merge duplicate section')).toBeInTheDocument();
    expect(screen.getByText('ev-1')).toBeInTheDocument();
  });

  /** 有冲突就不能签。这份 diff 是照旧版本算的，批准等于盲签。 */
  it('refuses to offer approval while a conflict stands', async () => {
    vi.mocked(getPendingChangeSets).mockResolvedValue([changeSet({ state: 'conflicted' })]);
    vi.mocked(previewChangeSet).mockResolvedValue(
      dryRun({
        hasConflicts: true,
        ops: [
          {
            ...dryRun().ops[0],
            conflict: { kind: 'version', expected: 3, actual: 5 },
          },
        ],
      }),
    );
    render(<KnowledgePanel contextPackage={null} runId={null} onClose={() => {}} />);
    openTab(/Changes/);

    fireEvent.click(await screen.findByText('tidy up the caching note'));

    expect(await screen.findByText(/Conflict/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled();
  });

  it('shows the commit error instead of pretending the batch is still fine', async () => {
    vi.mocked(getPendingChangeSets).mockResolvedValue([
      changeSet({ state: 'failed', commitError: 'disk full' }),
    ]);
    render(<KnowledgePanel contextPackage={null} runId={null} onClose={() => {}} />);
    openTab(/Changes/);

    expect(await screen.findByText('disk full')).toBeInTheDocument();
  });
});

function commitment(over: Partial<TaskCommitment> = {}): TaskCommitment {
  return {
    id: 'task-1',
    status: 'proposed',
    commitment_type: 'todo',
    title: 'send the retro notes',
    notify_count: 0,
    due_at_ms: null,
    return_target: null,
    ...over,
  } as TaskCommitment;
}

describe('Commitment Inbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    quietBackend();
    vi.mocked(decideCommitment).mockResolvedValue(commitment({ status: 'active' }));
  });

  it('says what an empty inbox means rather than showing a bare zero', async () => {
    render(<KnowledgePanel contextPackage={null} runId={null} onClose={() => {}} />);
    openTab(/Tasks/);

    expect(await screen.findByText(/Dated, unchecked todos get harvested here/)).toBeInTheDocument();
  });

  it('surfaces a read failure with a retry', async () => {
    vi.mocked(getCommitmentInbox).mockRejectedValueOnce(new Error('no such table'));
    render(<KnowledgePanel contextPackage={null} runId={null} onClose={() => {}} />);
    openTab(/Tasks/);

    expect(await screen.findByText('no such table')).toBeInTheDocument();
  });

  /** 完成必须带说明：后端要把它登记成完成证据，空的“done”是假账。 */
  it('will not submit a completion without a summary', async () => {
    vi.mocked(getCommitmentInbox).mockResolvedValue([commitment()]);
    render(<KnowledgePanel contextPackage={null} runId={null} onClose={() => {}} />);
    openTab(/Tasks/);

    fireEvent.click(await screen.findByRole('button', { name: 'Complete' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'sent, 12 people replied' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(decideCommitment).toHaveBeenCalledWith({
        commitmentId: 'task-1',
        action: 'complete',
        resultSummary: 'sent, 12 people replied',
      }),
    );
  });

  /** 后端拒绝时不能悄悄吞掉：用户以为存下了，其实没有。 */
  it('shows the backend refusal instead of closing the form silently', async () => {
    vi.mocked(getCommitmentInbox).mockResolvedValue([commitment()]);
    vi.mocked(decideCommitment).mockRejectedValueOnce(new Error('completion requires evidence'));
    render(<KnowledgePanel contextPackage={null} runId={null} onClose={() => {}} />);
    openTab(/Tasks/);

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(await screen.findByText('completion requires evidence')).toBeInTheDocument();
  });

  it('only offers "accept" for a commitment that is still merely proposed', async () => {
    vi.mocked(getCommitmentInbox).mockResolvedValue([commitment({ status: 'active' })]);
    render(<KnowledgePanel contextPackage={null} runId={null} onClose={() => {}} />);
    openTab(/Tasks/);

    await screen.findByText('send the retro notes');
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
  });
});

describe('Index Health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    quietBackend();
  });

  it('reports the real pending and failed job counts', async () => {
    vi.mocked(getKnowledgeIndexHealth).mockResolvedValue(
      health({ pendingJobs: 12, failedJobs: 3, lastError: 'embedding timed out' }),
    );
    render(<KnowledgePanel contextPackage={null} runId={null} onClose={() => {}} />);
    openTab(/Index/);

    expect(await screen.findByText('12')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText(/embedding timed out/)).toBeInTheDocument();
  });

  /** 没有稳定身份的笔记进不了证据和关系，这是缺陷，不是进度条。 */
  it('warns when notes still have no stable identity', async () => {
    vi.mocked(getKnowledgeIndexHealth).mockResolvedValue(
      health({ totalFiles: 40, indexedDocuments: 31 }),
    );
    render(<KnowledgePanel contextPackage={null} runId={null} onClose={() => {}} />);
    openTab(/Index/);

    expect(await screen.findByText(/9 notes have no stable identity/)).toBeInTheDocument();
  });

  /** backfill 是分批的。跑一批就说“完成”会让面板长期显示一个假的落后数。 */
  it('keeps advancing the backfill until the backend says there is nothing left', async () => {
    vi.mocked(getKnowledgeIndexHealth).mockResolvedValue(health({ totalFiles: 40, indexedDocuments: 20 }));
    vi.mocked(runKnowledgeBackfill)
      .mockResolvedValueOnce({ processed: 10, created: 10, failed: 0, remaining: 10, hasMore: true })
      .mockResolvedValueOnce({ processed: 10, created: 10, failed: 0, remaining: 0, hasMore: false });

    render(<KnowledgePanel contextPackage={null} runId={null} onClose={() => {}} />);
    openTab(/Index/);
    fireEvent.click(await screen.findByRole('button', { name: 'Advance backfill' }));

    await waitFor(() => expect(runKnowledgeBackfill).toHaveBeenCalledTimes(2));
    expect(getKnowledgeIndexHealth).toHaveBeenCalledTimes(2);
  });
});









