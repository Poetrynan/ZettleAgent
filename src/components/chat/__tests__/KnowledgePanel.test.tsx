import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom';

import { KnowledgePanel } from '../KnowledgePanel';
import {
  ContextPackageSummary,
  getCommitmentList,
  getKnowledgeIndexHealth,
  getPendingChangeSets,
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

// i18n �?mock：Context Inspector 的全部文案都来自字典，mock 掉等于把要验的东�?
// 换成假的。只把语言钉在 en，断言用英文原文�?
beforeEach(() => setLang('en'));

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

describe('Context Inspector', () => {
  beforeEach(() => {
    vi.clearAllMocks();

  });

  /**
   * 默认视图说人话�?
   *
   * 断言里刻意没�?score、objectId、`lexical` 这些原始值：它们都在"技术详�?折叠
   * 里，主视图给的是"用到几条、为什么在这儿"�?
   */
  it('leads with what was used and why, in plain language', () => {
    render(<KnowledgePanel contextPackage={pkg()} runId="run-1" onClose={() => {}} />);

    expect(screen.getByText('what did I decide about caching')).toBeInTheDocument();
    expect(screen.getByText('Used 1 item(s) from your knowledge base')).toBeInTheDocument();
    expect(screen.getByText('From your notes')).toBeInTheDocument();
    expect(screen.getByText('Caching decision')).toBeInTheDocument();
    expect(screen.getByText('Keyword match')).toBeInTheDocument();
    // 分数是排查信息，不是主文案�?
    expect(screen.queryByText('0.82')).not.toBeInTheDocument();
  });

  /**
   * token 数不做成百分比�?
   *
   * `usedTokens/maxTokens` 结构上永远到不了 100%（检索只拿到 3/4 预算，注入项还不
   * 计账），画成进度条就是在骗人。所以它只作为技术详情里的一行数字出现，并且必须
   * 附带"这只算召回内�?的说明�?
   */
  it('does not present the token count as a fullness percentage', () => {
    render(
      <KnowledgePanel
        contextPackage={pkg({ budget: { maxTokens: 4000, usedTokens: 1200, truncatedCandidates: 0 } })}
        runId={null}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText(/1200 of 4000 tokens/)).toBeInTheDocument();
    expect(screen.getByText(/counts retrieved notes only/)).toBeInTheDocument();
    expect(screen.queryByText('30%')).not.toBeInTheDocument();
  });

  /** 被裁掉的候选必须单独说。只显示"用了多少 token"会让人以为召回是完整的�?*/
  it('says out loud how many candidates the budget cut', () => {
    render(
      <KnowledgePanel
        contextPackage={pkg({ budget: { maxTokens: 4000, usedTokens: 4000, truncatedCandidates: 7 } })}
        runId="run-1"
        onClose={() => {}}
      />,
    );

    expect(screen.getByText(/7 more match\(es\) did not fit/)).toBeInTheDocument();
  });

  /** 只按关键词检索过就得说出来——这�?答案可能漏了东西"最常见的原因�?*/
  it('admits when the turn was keyword-only recall', () => {
    render(
      <KnowledgePanel
        contextPackage={pkg({ warnings: ['fts_only_no_query_embedding'] })}
        runId={null}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText('Keywords only')).toBeInTheDocument();
    expect(screen.getByText(/notes that mean the same thing in different words may have been missed/))
      .toBeInTheDocument();
    // 原始 code 不出现在界面上�?
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
        onClose={() => {}}
      />,
    );

    expect(screen.getByText('What the Agent remembers about you')).toBeInTheDocument();
    expect(screen.getByText('no note covers the retention policy')).toBeInTheDocument();
    expect(screen.getByText('Not confirmed by you')).toBeInTheDocument();
    // 没有 locator 就明说追不回原文，而不是给一个点了没反应的按钮�?
    expect(screen.getByText(/cannot be traced back to a note/)).toBeInTheDocument();
  });

  /** 没编译过上下文不�?召回为空"，两句话必须不一样�?*/
  it('distinguishes "nothing compiled yet" from "nothing found"', () => {
    const { unmount } = render(
      <KnowledgePanel contextPackage={null} runId={null} onClose={() => {}} />,
    );
    expect(screen.getByText('Nothing compiled for this turn yet.')).toBeInTheDocument();
    unmount();

    render(
      <KnowledgePanel contextPackage={pkg({ items: [] })} runId={null} onClose={() => {}} />,
    );
    expect(screen.getByText('Nothing in your notes matched this question.')).toBeInTheDocument();
  });
});

/**

 * 侧栏不再托管长期状态�?
 *
 * 记忆 / 变更 / 任务 / 健康 这四�?tab 已经从这块面板移走：它们�?vault 的长期状态，
 * 需要筛选、批量和历史，而这条侧栏放不下工作台。它们各自的行为�?
 * `knowledge/__tests__/MemoryCenter.test.tsx`、`ChangeReview.test.tsx`�?
 * `TaskCenter.test.tsx`、`KnowledgeHealth.test.tsx` 里验——原来这里那四组只断言
 * "侧栏用的是同一个组�?，tab 没了之后这个断言自然也没有了对象�?
 */
describe('panel scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hosts only this turn, with a way out to the Knowledge Centre', () => {
    const onOpenCenter = vi.fn();
    render(
      <KnowledgePanel
        contextPackage={pkg()}
        runId="run-1"
        onOpenCenter={onOpenCenter}
        onClose={() => {}}
      />,
    );

    // 长期状态的入口不在这里�?
    expect(screen.queryByRole('tab', { name: /Memory/ })).toBeNull();
    expect(screen.queryByRole('tab', { name: /Changes/ })).toBeNull();
    expect(screen.queryByRole('tab', { name: /Tasks/ })).toBeNull();
    expect(screen.queryByRole('tab', { name: /Health/ })).toBeNull();

    // 但知识中心必须一键可达，否则这些页面就成了只能从 Activity Rail 找的孤岛�?
    fireEvent.click(screen.getByRole('button', { name: 'Knowledge' }));
    expect(onOpenCenter).toHaveBeenCalledTimes(1);
  });

  /** 长期状态的读取命令不该因为打开这块面板而被调用�?*/
  it('does not poll the long-lived stores', async () => {
    render(<KnowledgePanel contextPackage={pkg()} runId={null} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText('Caching decision')).toBeInTheDocument());
    expect(listMemories).not.toHaveBeenCalled();
    expect(getPendingChangeSets).not.toHaveBeenCalled();
    expect(getCommitmentList).not.toHaveBeenCalled();
    expect(getKnowledgeIndexHealth).not.toHaveBeenCalled();
  });
});












