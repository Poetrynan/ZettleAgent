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
  getChangeSetDetail,
  getCommitmentList,
  getEmbeddingStats,
  getKnowledgeIndexHealth,
  getPendingChangeSets,
  getProactiveDigest,
  listMemories,
} from '../../../lib/tauri';
import { setLang } from '../../../lib/i18n';

vi.mock('../../../lib/tauri', () => ({
  confirmMemory: vi.fn(),
  createNoteForLink: vi.fn(),
  decideChangeSet: vi.fn().mockResolvedValue(undefined),
  decideCommitment: vi.fn(),
  editMemory: vi.fn(),
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
  getMemoryDetail: vi.fn().mockResolvedValue(null),
  getPendingChangeSets: vi.fn(),
  getProactiveDigest: vi.fn(),
  getSetting: vi.fn().mockResolvedValue(null),
  listMemories: vi.fn(),
  markCommitmentNotified: vi.fn().mockResolvedValue(undefined),
  previewChangeSet: vi.fn(),
  rejectMemory: vi.fn(),
  restoreMemory: vi.fn(),
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
  vi.mocked(listMemories).mockResolvedValue([]);
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
    lifecycle: 'candidate',
    claim: 'writes weekly reviews on Friday',
    scope: 'global',
    confidence: 0.71,
    conflicts_with_id: null,
    expires_at_ms: null,
    source: { source_type: 'message', source_id: 'msg-9' },
    ...over,
  } as MemoryItem;
}

/**
 * 侧栏的记忆 tab 现在就是记忆中心本身。
 *
 * 这里只验"确实是同一个东西"，以及旧版那两个毛病没了：`kind` / `scope` 这类后端枚举名
 * 和 `0.71` 这种置信度分数不再当主文案印出来。记忆本身的行为（确认是唯一写
 * `confirmed_by` 的路径、改写不是覆盖、`memory.md` 回流）在 `MemoryCenter.test.tsx`
 * 里验，不在两处各写一遍。
 */
describe('Memory tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    quietBackend();
  });

  it('renders the memory center, not a second inbox of its own', async () => {
    vi.mocked(listMemories).mockResolvedValue([memory()]);
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />);
    openTab(/Memory/);

    expect(await screen.findByText('writes weekly reviews on Friday')).toBeInTheDocument();
    // 记忆中心的筛选是它的标志：旧版侧栏只有一条收件箱列表。
    expect(screen.getByText('State')).toBeInTheDocument();
    // 置信度分数和 Rust 枚举名都不是主文案。
    expect(screen.queryByText('0.71')).toBeNull();
    expect(screen.queryByText('global')).toBeNull();
  });

  it('asks the same query the Knowledge Center asks', async () => {
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />);
    openTab(/Memory/);

    await waitFor(() => expect(listMemories).toHaveBeenCalled());
  });

  /** 失败必须长得像失败。把读取错误画成“没有记忆”会让人以为提取器没工作。 */
  it('renders a read failure as a failure, not as an empty memory', async () => {
    vi.mocked(listMemories).mockRejectedValueOnce(new Error('database is locked'));
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />);
    openTab(/Memory/);

    expect(await screen.findByText('database is locked')).toBeInTheDocument();
    expect(screen.queryByText(/Nothing is remembered/)).toBeNull();
  });

  /** 没有 vault 就没有 memory.md，按钮不该在那里骗人。 */
  it('hides the memory.md sync entry when there is no vault', async () => {
    vi.mocked(listMemories).mockResolvedValue([]);
    render(<KnowledgePanel contextPackage={null} runId={null} vaultPath={null} onClose={() => {}} />);
    openTab(/Memory/);

    await screen.findByText(/Nothing is remembered/);
    expect(screen.queryByRole('button', { name: /memory.md/ })).toBeNull();
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
    openTab(/Health/);

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
    openTab(/Health/);


    await screen.findByText('Identity and indexing');
    expect(screen.queryByText(/Last run/)).toBeNull();
  });
});










