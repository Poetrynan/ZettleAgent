import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom';

import { KnowledgePanel } from '../KnowledgePanel';
import {
  ContextPackageSummary,
  KnowledgeIndexHealth,
  MemoryItem,
  PendingChangeSet,
  TaskCommitment,
  confirmMemory,
  getChangeSetDetail,
  getCommitmentList,
  getEmbeddingStats,
  getKnowledgeIndexHealth,
  getMemoryInbox,
  getPendingChangeSets,
  getProactiveDigest,
  syncMemoryFile,
} from '../../../lib/tauri';
import { setLang } from '../../../lib/i18n';

vi.mock('../../../lib/tauri', () => ({
  confirmMemory: vi.fn(),
  createNoteForLink: vi.fn(),
  decideChangeSet: vi.fn().mockResolvedValue(undefined),
  decideCommitment: vi.fn(),
  finalizeEmbeddingIndex: vi.fn().mockResolvedValue(undefined),
  fixBrokenLink: vi.fn().mockResolvedValue(undefined),
  forgetMemory: vi.fn(),
  getCommitmentList: vi.fn(),
  getChangeSetDetail: vi.fn().mockResolvedValue(null),
  getChangeSetHistory: vi.fn().mockResolvedValue([]),
  getEmbeddingStats: vi.fn(),
  getEvidenceByIds: vi.fn().mockResolvedValue([]),
  getKnowledgeAuditTrail: vi.fn().mockResolvedValue([]),
  getKnowledgeIndexHealth: vi.fn(),
  getMemoryInbox: vi.fn(),
  getPendingChangeSets: vi.fn(),
  getProactiveDigest: vi.fn(),
  getSetting: vi.fn().mockResolvedValue(null),
  markCommitmentNotified: vi.fn().mockResolvedValue(undefined),
  previewChangeSet: vi.fn(),
  rejectMemory: vi.fn(),
  runKnowledgeBackfill: vi.fn(),
  runVaultLint: vi.fn(),
  scanCommitments: vi.fn(),
  setSetting: vi.fn().mockResolvedValue(undefined),
  syncMemoryFile: vi.fn(),
  syncVault: vi.fn(),
  undoAgentRun: vi.fn(),
}));

// i18n 不 mock：Context Inspector 的全部文案都来自字典，mock 掉等于把要验的东西
// 换成假的。只把语言钉在 en，断言用英文原文。
beforeEach(() => setLang('en'));

/** 面板每个 tab 都自己拉数据，所以默认让每个命令都有一个“空但成功”的回答。 */
function quietBackend() {
  vi.mocked(getMemoryInbox).mockResolvedValue([]);
  vi.mocked(getPendingChangeSets).mockResolvedValue([]);
  vi.mocked(getCommitmentList).mockResolvedValue([]);
  vi.mocked(getProactiveDigest).mockResolvedValue({ items: [], silenced: null, expired: 0 });
  vi.mocked(getKnowledgeIndexHealth).mockResolvedValue(health());
  vi.mocked(getEmbeddingStats).mockResolvedValue({
    total_chunks: 100,
    indexed_chunks: 100,
    has_index: true,
  });
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

/**
 * 侧栏的变更页 / the sidebar's Changes tab.
 *
 * 这里曾经是第二套实现，有自己的 diff（before/after 两坨原文）和自己的状态显示（直接
 * 印后端串）。现在它就是知识中心那一份 `ChangeReview`，所以这一组只验"侧栏没有回到老
 * 路"：状态说人话、展开走的是同一个明细接口。diff 本身的行为在
 * `knowledge/__tests__/ChangeReview.test.tsx` 里验。
 */
describe('Change Preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    quietBackend();
  });

  it('names the state in plain language instead of printing the backend string', async () => {
    vi.mocked(getPendingChangeSets).mockResolvedValue([changeSet({ state: 'awaiting_approval' })]);
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />);
    openTab(/Changes/);

    expect(await screen.findByText('Waiting on you')).toBeInTheDocument();
    expect(screen.queryByText('awaiting_approval')).toBeNull();
  });

  it('loads the diff from the shared detail command, not a second dry-run path', async () => {
    vi.mocked(getPendingChangeSets).mockResolvedValue([changeSet()]);
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />);
    openTab(/Changes/);

    fireEvent.click(await screen.findByText('Review diff'));

    await waitFor(() => expect(getChangeSetDetail).toHaveBeenCalledWith('cs-1'));
  });

  it('says a write failed in a sentence, keeping the raw error out of the headline', async () => {
    vi.mocked(getPendingChangeSets).mockResolvedValue([
      changeSet({ state: 'failed', commitError: 'disk full' }),
    ]);
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />);
    openTab(/Changes/);

    expect(
      await screen.findByText('The write failed. Your content was not overwritten.'),
    ).toBeInTheDocument();
    // 原始错误还在 DOM 里给排查用，但不是主文案。
    expect(screen.getByText('disk full')).toHaveClass('kc-sr-only');
  });
});


function commitment(over: Partial<TaskCommitment> = {}): TaskCommitment {
  return {
    id: 'task-1',
    status: 'proposed',
    commitment_type: 'commitment',
    title: 'send the retro notes',
    source: null,
    notify_count: 0,
    due_at_ms: null,
    remind_at_ms: null,
    completion_evidence_id: null,
    return_target: null,
    ...over,
  } as TaskCommitment;
}

/**
 * 侧栏的任务 tab 现在就是任务台本身。
 *
 * 这里只验"确实是同一个东西"：读的是任务台的查询、用的是任务台的状态词、六个视图都在。
 * 具体行为（完成必须带证据、任意时刻推迟、闸门理由）在 `TaskCenter.test.tsx` 里验，
 * 不在两处各写一遍——那正是这次合并要消掉的重复。
 */
describe('Tasks tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    quietBackend();
  });

  it('renders the task workbench, not a second inbox of its own', async () => {
    vi.mocked(getCommitmentList).mockResolvedValue([commitment({ status: 'active' })]);
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />);
    openTab(/Tasks/);

    expect(await screen.findByText('send the retro notes')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Past their date' })).toBeInTheDocument();
    // 后端状态串不许直接印出来。
    expect(screen.queryByText('active')).toBeNull();
  });

  it('asks the same filtered query the Knowledge Center asks', async () => {
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />);
    openTab(/Tasks/);

    await waitFor(() =>
      expect(getCommitmentList).toHaveBeenCalledWith(
        expect.objectContaining({ statuses: ['proposed'] }),
      ),
    );
  });

  it('surfaces a read failure with a retry instead of an empty list', async () => {
    vi.mocked(getCommitmentList).mockRejectedValueOnce(new Error('no such table'));
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />);
    openTab(/Tasks/);

    expect(await screen.findByText('no such table')).toBeInTheDocument();
  });
});


/**
 * 侧栏的健康 tab 现在就是知识健康页本身。
 *
 * 行为在 `KnowledgeHealth.test.tsx` 里验；这里只验"是同一页"，以及旧版那个错值没了：
 * 后端的 `lastRunAtMs` 其实是查询时间，不该被当成索引时间显示。
 */
describe('Health tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    quietBackend();
  });

  it('renders the layered health page, not a grid of raw counts', async () => {
    vi.mocked(getKnowledgeIndexHealth).mockResolvedValue(
      health({ totalFiles: 40, indexedDocuments: 31 }),
    );
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />);
    openTab(/Index/);

    expect(
      await screen.findByText(
        '9 note(s) have no stable identity, so nothing can cite or undo them',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Identity and indexing')).toBeInTheDocument();
  });

  it('does not present the query time as an index time', async () => {
    vi.mocked(getKnowledgeIndexHealth).mockResolvedValue(health({ lastRunAtMs: 1_700_000_000_000 }));
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />);
    openTab(/Index/);

    await screen.findByText('Identity and indexing');
    expect(screen.queryByText(/Last run/)).toBeNull();
  });
});










