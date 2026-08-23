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
  syncMemoryFile,
} from '../../../lib/tauri';
import { setLang } from '../../../lib/i18n';

vi.mock('../../../lib/tauri', () => ({
  confirmMemory: vi.fn(),
  decideChangeSet: vi.fn().mockResolvedValue(undefined),
  decideCommitment: vi.fn(),
  forgetMemory: vi.fn(),
  getCommitmentInbox: vi.fn(),
  getEvidenceByIds: vi.fn().mockResolvedValue([]),
  getKnowledgeAuditTrail: vi.fn().mockResolvedValue([]),
  getKnowledgeIndexHealth: vi.fn(),
  getMemoryInbox: vi.fn(),
  getPendingChangeSets: vi.fn(),
  previewChangeSet: vi.fn(),
  rejectMemory: vi.fn(),
  runKnowledgeBackfill: vi.fn(),
  scanCommitments: vi.fn(),
  syncMemoryFile: vi.fn(),
}));

// i18n 不 mock：Context Inspector 的全部文案都来自字典，mock 掉等于把要验的东西
// 换成假的。只把语言钉在 en，断言用英文原文。
beforeEach(() => setLang('en'));

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
        section: 'fact',
        title: 'Caching decision',
        locator: 'notes/caching.md#chunk:3',
        score: 0.82,
        why: ['lexical'],
        warnings: [],
        evidenceIds: [],
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

  /**
   * 默认视图说人话。
   *
   * 断言里刻意没有 score、objectId、`lexical` 这些原始值：它们都在"技术详情"折叠
   * 里，主视图给的是"用到几条、为什么在这儿"。
   */
  it('leads with what was used and why, in plain language', () => {
    render(<KnowledgePanel contextPackage={pkg()} runId="run-1" vaultPath={null} onClose={() => {}} />);

    expect(screen.getByText('what did I decide about caching')).toBeInTheDocument();
    expect(screen.getByText('Used 1 item(s) from your knowledge base')).toBeInTheDocument();
    expect(screen.getByText('From your notes')).toBeInTheDocument();
    expect(screen.getByText('Caching decision')).toBeInTheDocument();
    expect(screen.getByText('Keyword match')).toBeInTheDocument();
    // 分数是排查信息，不是主文案。
    expect(screen.queryByText('0.82')).not.toBeInTheDocument();
  });

  /**
   * token 数不做成百分比。
   *
   * `usedTokens/maxTokens` 结构上永远到不了 100%（检索只拿到 3/4 预算，注入项还不
   * 计账），画成进度条就是在骗人。所以它只作为技术详情里的一行数字出现，并且必须
   * 附带"这只算召回内容"的说明。
   */
  it('does not present the token count as a fullness percentage', () => {
    render(
      <KnowledgePanel
        contextPackage={pkg({ budget: { maxTokens: 4000, usedTokens: 1200, truncatedCandidates: 0 } })}
        runId={null}
        vaultPath={null} onClose={() => {}}
      />,
    );

    expect(screen.getByText(/1200 of 4000 tokens/)).toBeInTheDocument();
    expect(screen.getByText(/counts retrieved notes only/)).toBeInTheDocument();
    expect(screen.queryByText('30%')).not.toBeInTheDocument();
  });

  /** 被裁掉的候选必须单独说。只显示"用了多少 token"会让人以为召回是完整的。 */
  it('says out loud how many candidates the budget cut', () => {
    render(
      <KnowledgePanel
        contextPackage={pkg({ budget: { maxTokens: 4000, usedTokens: 4000, truncatedCandidates: 7 } })}
        runId="run-1"
        vaultPath={null} onClose={() => {}}
      />,
    );

    expect(screen.getByText(/7 more match\(es\) did not fit/)).toBeInTheDocument();
  });

  /** 只按关键词检索过就得说出来——这是"答案可能漏了东西"最常见的原因。 */
  it('admits when the turn was keyword-only recall', () => {
    render(
      <KnowledgePanel
        contextPackage={pkg({ warnings: ['fts_only_no_query_embedding'] })}
        runId={null}
        vaultPath={null} onClose={() => {}}
      />,
    );

    expect(screen.getByText('Keywords only')).toBeInTheDocument();
    expect(screen.getByText(/notes that mean the same thing in different words may have been missed/))
      .toBeInTheDocument();
    // 原始 code 不出现在界面上。
    expect(screen.queryByText('fts_only_no_query_embedding')).not.toBeInTheDocument();
  });

  it('surfaces per-item warnings and knowledge gaps instead of hiding them', () => {
    render(
      <KnowledgePanel
        contextPackage={pkg({
          knowledgeGaps: ['no note covers the retention policy'],
          items: [
            {
              objectId: 'obj-2',
              kind: 'memory',
              section: 'memory',
              title: 'prefers dark mode',
              locator: null,
              score: 0.4,
              why: ['memory_recall'],
              warnings: ['unconfirmed'],
              evidenceIds: [],
            },
          ],
        })}
        runId={null}
        vaultPath={null} onClose={() => {}}
      />,
    );

    expect(screen.getByText('What the Agent remembers about you')).toBeInTheDocument();
    expect(screen.getByText('no note covers the retention policy')).toBeInTheDocument();
    expect(screen.getByText('Not confirmed by you')).toBeInTheDocument();
    // 没有 locator 就明说追不回原文，而不是给一个点了没反应的按钮。
    expect(screen.getByText(/cannot be traced back to a note/)).toBeInTheDocument();
  });

  /** 没编译过上下文不是"召回为空"，两句话必须不一样。 */
  it('distinguishes "nothing compiled yet" from "nothing found"', () => {
    const { unmount } = render(
      <KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />,
    );
    expect(screen.getByText('Nothing compiled for this turn yet.')).toBeInTheDocument();
    unmount();

    render(
      <KnowledgePanel contextPackage={pkg({ items: [] })} runId={null} vaultPath={null} onClose={() => {}} />,
    );
    expect(screen.getByText('Nothing in your notes matched this question.')).toBeInTheDocument();
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
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />);
    openTab(/Memory/);

    expect(await screen.findByText('writes weekly reviews on Friday')).toBeInTheDocument();
    expect(screen.getByText('msg-9')).toBeInTheDocument();
  });

  /** 失败必须长得像失败。把读取错误画成“没有候选”会让人以为提取器没工作。 */
  it('renders a read failure as a failure with a retry, not as an empty inbox', async () => {
    vi.mocked(getMemoryInbox).mockRejectedValueOnce(new Error('database is locked'));
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />);
    openTab(/Memory/);

    expect(await screen.findByText('database is locked')).toBeInTheDocument();
    expect(screen.queryByText(/No candidate memories/)).not.toBeInTheDocument();

    vi.mocked(getMemoryInbox).mockResolvedValue([memory()]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('writes weekly reviews on Friday')).toBeInTheDocument();
  });

  /** 确认是唯一写 `confirmed_by` 的路径，所以它必须由用户点出来。 */
  it('confirms only when the user asks, and hands over the vault so Core Memory gets it', async () => {
    vi.mocked(getMemoryInbox).mockResolvedValue([memory()]);
    vi.mocked(confirmMemory).mockResolvedValue(memory({ claim: 'confirmed' }));
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath="/vault" onClose={() => {}} />);
    openTab(/Memory/);
    await screen.findByText('writes weekly reviews on Friday');

    expect(confirmMemory).not.toHaveBeenCalled();
    vi.mocked(getMemoryInbox).mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(confirmMemory).toHaveBeenCalledWith('mem-1', '/vault'));
    expect(await screen.findByText(/No candidate memories/)).toBeInTheDocument();
  });


  it('marks a memory that contradicts an existing one', async () => {
    vi.mocked(getMemoryInbox).mockResolvedValue([memory({ conflicts_with_id: 'mem-0' })]);
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />);
    openTab(/Memory/);

    expect(await screen.findByText('conflicts')).toBeInTheDocument();
  });

  /** 收件箱空的时候恰恰最可能想手改文件，所以回流入口不能只在有候选时出现。 */
  it('offers the memory.md sync in an empty inbox and reports what it did', async () => {
    vi.mocked(getMemoryInbox).mockResolvedValue([]);
    vi.mocked(syncMemoryFile).mockResolvedValue({ adopted: 2, unchanged: 1, forgotten: 1 });
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath="/vault" onClose={() => {}} />);
    openTab(/Memory/);

    fireEvent.click(await screen.findByRole('button', { name: 'Absorb memory.md edits' }));

    await waitFor(() => expect(syncMemoryFile).toHaveBeenCalledWith('/vault'));
    expect(
      await screen.findByText('2 adopted, 1 already known, 1 forgotten'),
    ).toBeInTheDocument();
  });

  /** 没有 vault 就没有 memory.md，按钮不该在那里骗人。 */
  it('hides the sync entry when there is no vault', async () => {
    vi.mocked(getMemoryInbox).mockResolvedValue([]);
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />);
    openTab(/Memory/);

    await screen.findByText(/No candidate memories/);
    expect(screen.queryByRole('button', { name: /memory.md/ })).not.toBeInTheDocument();
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
        conflictMessage: null,
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
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />);
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
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />);
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
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />);
    openTab(/Changes/);

    expect(await screen.findByText('disk full')).toBeInTheDocument();
  });

  /**
   * 冲突要说人话 / a conflict has to be readable.
   *
   * 直接渲染 `kind` 等于把内部枚举名甩给用户：`stale_read` 说不出"你在 Agent 读过之后
   * 改了这篇笔记，所以它没写"。措辞由后端给一份，前端只负责显示。
   */
  it('reads out the backend explanation rather than the conflict enum name', async () => {
    vi.mocked(getPendingChangeSets).mockResolvedValue([changeSet({ state: 'conflicted' })]);
    vi.mocked(previewChangeSet).mockResolvedValue(
      dryRun({
        hasConflicts: true,
        ops: [
          {
            ...dryRun().ops[0],
            conflict: { kind: 'stale_read', readVersion: 3, actual: 4, readAtMs: 1_700_000_000_000 },
            conflictMessage: '这篇笔记在 Agent 读到 v3 之后被改到了 v4。你的编辑还在。',
          },
        ],
      }),
    );
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />);
    openTab(/Changes/);

    fireEvent.click(await screen.findByText('tidy up the caching note'));

    expect(await screen.findByText(/读到 v3 之后被改到了 v4/)).toBeInTheDocument();
    expect(screen.queryByText(/stale_read/)).not.toBeInTheDocument();
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
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />);
    openTab(/Tasks/);

    expect(await screen.findByText(/Dated, unchecked todos get harvested here/)).toBeInTheDocument();
  });

  it('surfaces a read failure with a retry', async () => {
    vi.mocked(getCommitmentInbox).mockRejectedValueOnce(new Error('no such table'));
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />);
    openTab(/Tasks/);

    expect(await screen.findByText('no such table')).toBeInTheDocument();
  });

  /** 完成必须带说明：后端要把它登记成完成证据，空的“done”是假账。 */
  it('will not submit a completion without a summary', async () => {
    vi.mocked(getCommitmentInbox).mockResolvedValue([commitment()]);
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />);
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
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />);
    openTab(/Tasks/);

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(await screen.findByText('completion requires evidence')).toBeInTheDocument();
  });

  it('only offers "accept" for a commitment that is still merely proposed', async () => {
    vi.mocked(getCommitmentInbox).mockResolvedValue([commitment({ status: 'active' })]);
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />);
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
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />);
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
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />);
    openTab(/Index/);

    expect(await screen.findByText(/9 notes have no stable identity/)).toBeInTheDocument();
  });

  /** backfill 是分批的。跑一批就说“完成”会让面板长期显示一个假的落后数。 */
  it('keeps advancing the backfill until the backend says there is nothing left', async () => {
    vi.mocked(getKnowledgeIndexHealth).mockResolvedValue(health({ totalFiles: 40, indexedDocuments: 20 }));
    vi.mocked(runKnowledgeBackfill)
      .mockResolvedValueOnce({ processed: 10, created: 10, failed: 0, remaining: 10, hasMore: true })
      .mockResolvedValueOnce({ processed: 10, created: 10, failed: 0, remaining: 0, hasMore: false });

    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />);
    openTab(/Index/);
    fireEvent.click(await screen.findByRole('button', { name: 'Advance backfill' }));

    await waitFor(() => expect(runKnowledgeBackfill).toHaveBeenCalledTimes(2));
    expect(getKnowledgeIndexHealth).toHaveBeenCalledTimes(2);
  });
});









