import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom';

/**
 * 修复闭环的验收线 / what the fix loop is not allowed to do.
 *
 * 这些用例全部针对同一类谎：「Agent 回了一段文字」被说成「修复完成」。所以它们检查的
 * 都是负面性质——预览之前不许写、被拒绝时不许有成功样式、部分成功不许读成完成、
 * 提议不许默认全选。
 */

// ── Backend surface ─────────────────────────────────────────────────
vi.mock('../../../lib/tauri', () => ({
  getKnowledgeGraph: vi.fn(),
  chatWithLlm: vi.fn().mockResolvedValue({ content: '' }),
  agentChat: vi.fn().mockResolvedValue('diagnosis report'),
  knowledgeGraphCreatePlan: vi.fn(),
  knowledgeGraphStagePlan: vi.fn(),
  knowledgeGraphCommitPlan: vi.fn(),
  knowledgeGraphRollbackPlan: vi.fn(),
  knowledgeGraphVerifyPlan: vi.fn(),
  knowledgeGraphRelationEvidence: vi.fn(),
  knowledgeGraphDecideRelation: vi.fn().mockResolvedValue('confirmed'),
  emitRefreshEvent: vi.fn().mockResolvedValue(undefined),
}));

// MarkdownRenderer drags in KaTeX/Mermaid — stub it to the raw content.
vi.mock('../../editor/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('../../../contexts/AppContext', () => ({
  useApp: () => ({
    state: {
      vaultPath: '/vault', vaultPaths: ['/vault'], lang: 'en', methodology: 'zettelkasten',
      llmConfig: { apiUrl: '', apiKey: '', model: 'm', providerId: 'custom' },
    },
    setCurrentFile: vi.fn(),
    setView: vi.fn(),
    showToast,
  }),
}));

import { KnowledgeGapAnalysis } from '../KnowledgeGapAnalysis';
import {
  getKnowledgeGraph,
  knowledgeGraphCreatePlan,
  knowledgeGraphStagePlan,
  knowledgeGraphCommitPlan,
  knowledgeGraphVerifyPlan,
  type GraphPlan,
  type PlanOutcome,
} from '../../../lib/tauri';
import { setLang } from '../../../lib/i18n';
import { en } from '../../../lib/i18n/en';
import { zh } from '../../../lib/i18n/zh';

beforeEach(() => {
  vi.clearAllMocks();
  setLang('en');
  // jsdom 没有 scrollIntoView，而日志面板挂载时就会调它。
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(getKnowledgeGraph).mockResolvedValue({ nodes: [], edges: [], clusters: [] } as never);
});

function plan(over: Partial<GraphPlan> = {}): GraphPlan {
  return {
    id: 'plan-1',
    goal: {
      goalType: 'diagnose',
      scope: { paths: [], cluster: null },
      anchorPaths: [],
      question: 'q',
      constraints: [],
      maxProposals: null,
    },
    observations: [
      {
        id: 'obs-1',
        kind: 'orphan',
        title: 'Two notes link to nothing',
        summary: 'They are not reachable from anywhere.',
        paths: ['notes/a.md'],
        // chunkId 为 null ⇒ 只到文件级，界面必须说出来
        evidence: [{ path: 'notes/a.md', chunkId: null, excerpt: null, kind: 'file_level' }],
        confidence: 0.9,
        warnings: [],
      },
    ],
    proposals: [
      {
        id: 'p-high',
        operation: 'add_relation',
        sourcePath: 'notes/a.md',
        targetPath: 'notes/b.md',
        relationType: 'supports',
        reason: 'Both argue the same claim.',
        evidence: [{ path: 'notes/a.md', chunkId: 7, excerpt: 'the claim', kind: 'chunk_text' }],
        confidence: 0.91,
        risk: 'low',
        affectedPaths: ['notes/a.md', 'notes/b.md'],
        alreadyExists: false,
      },
      {
        id: 'p-low',
        operation: 'add_relation',
        sourcePath: 'notes/c.md',
        targetPath: 'notes/d.md',
        relationType: 'references',
        reason: 'They share vocabulary.',
        evidence: [],
        confidence: 0.42,
        risk: 'medium',
        affectedPaths: [],
        alreadyExists: false,
      },
    ],
    validationSteps: ['Re-read the relation table'],
    unresolvedQuestions: [],
    generatedBy: 'query',
    generatedAtMs: 1,
    changesetId: null,
    state: 'draft',
    ...over,
  };
}

function outcome(over: Partial<PlanOutcome> = {}): PlanOutcome {
  return {
    planId: 'plan-1',
    changesetId: 'cs-1',
    state: 'awaiting_approval',
    selected: 1,
    applied: 0,
    alreadyExisted: 0,
    rejectedByUser: 0,
    missing: 0,
    failed: 0,
    conflicts: [],
    refusal: null,
    message: '',
    details: [],
    ...over,
  };
}

/** 跑一轮诊断（Agent 路径没有定时器），然后切到修复页。 */
async function openFixTab() {
  render(<KnowledgeGapAnalysis />);
  fireEvent.click(screen.getByRole('button', { name: /AI Agent Deep Diagnosis/ }));
  fireEvent.click(await screen.findByRole('tab', { name: 'Fix' }));
}

describe('KnowledgeGapAnalysis — the fix loop', () => {
  it('shows a plan and a preview before anything is applied', async () => {
    vi.mocked(knowledgeGraphCreatePlan).mockResolvedValue(plan());
    vi.mocked(knowledgeGraphStagePlan).mockResolvedValue(outcome());

    await openFixTab();
    fireEvent.click(screen.getByRole('button', { name: /Build a fix plan/ }));

    // 计划出来了，但「应用」还不该存在：没预览过就没有可批准的批次。
    await waitFor(() => expect(screen.getByText(/Both argue the same claim\./)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
    expect(knowledgeGraphCommitPlan).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    await waitFor(() =>
      expect(screen.getByText('Preview only — nothing has been written yet')).toBeInTheDocument(),
    );
    // 预览只勾了高置信度那一条，且到这一步为止图谱依然没被写过。
    expect(knowledgeGraphStagePlan).toHaveBeenCalledWith('plan-1', ['p-high'], '/vault', ['/vault']);
    expect(knowledgeGraphCommitPlan).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument();
  });

  it('does not pre-select every proposal', async () => {
    vi.mocked(knowledgeGraphCreatePlan).mockResolvedValue(plan());

    await openFixTab();
    fireEvent.click(screen.getByRole('button', { name: /Build a fix plan/ }));

    await waitFor(() => expect(screen.getByText('1 of 2 selected')).toBeInTheDocument());
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    expect(boxes.filter(b => b.checked)).toHaveLength(1);
    // 0.42 的那条必须是用户自己去勾的。
    expect(screen.getByText('Confidence: 0.42')).toBeInTheDocument();
  });

  it('says 未执行 and shows no success styling when the guard refuses', async () => {
    vi.mocked(knowledgeGraphCreatePlan).mockResolvedValue(plan());
    vi.mocked(knowledgeGraphStagePlan).mockResolvedValue(outcome());
    vi.mocked(knowledgeGraphCommitPlan).mockResolvedValue(
      outcome({
        state: 'rejected',
        applied: 0,
        refusal: 'notes/b.md is outside the vault scope.',
      }),
    );
    vi.mocked(knowledgeGraphVerifyPlan).mockResolvedValue({
      planId: 'plan-1', relationTotal: 3, proposalsPresent: 0, proposalsAbsent: 1,
      danglingEndpoints: [], steps: [], message: '',
    });

    await openFixTab();
    fireEvent.click(screen.getByRole('button', { name: /Build a fix plan/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(screen.getByText('notes/b.md is outside the vault scope.')).toBeInTheDocument(),
    );
    expect(screen.getByText(/Not executed/)).toBeInTheDocument();
    // 预览块与结果块都会报「0 已写入」，两处都必须是 0。
    expect(screen.getAllByText('0 written').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Not one relation was written this time.').length).toBeGreaterThan(0);
    // 没写进去就不许有成功描边，也不许出现撤销（没东西可撤）。
    expect(document.querySelector('.gap-plan-block-ok')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('reads partial_success as partial, with the real numbers', async () => {
    vi.mocked(knowledgeGraphCreatePlan).mockResolvedValue(plan());
    vi.mocked(knowledgeGraphStagePlan).mockResolvedValue(outcome({ selected: 2 }));
    vi.mocked(knowledgeGraphCommitPlan).mockResolvedValue(
      outcome({
        state: 'partial_success',
        selected: 4, applied: 1, alreadyExisted: 1, rejectedByUser: 1, failed: 1,
        conflicts: ['notes/b.md changed after the plan was built'],
      }),
    );
    vi.mocked(knowledgeGraphVerifyPlan).mockResolvedValue({
      planId: 'plan-1', relationTotal: 12, proposalsPresent: 1, proposalsAbsent: 3,
      danglingEndpoints: [], steps: [], message: '',
    });

    await openFixTab();
    fireEvent.click(screen.getByRole('button', { name: /Build a fix plan/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(screen.getByText('1 written')).toBeInTheDocument());
    expect(screen.getByText('1 already existed')).toBeInTheDocument();
    expect(screen.getByText('1 you rejected before')).toBeInTheDocument();
    expect(screen.getByText('1 failed')).toBeInTheDocument();
    expect(screen.getAllByText('Partly done').length).toBeGreaterThan(0);
    expect(screen.queryByText('All of it went through')).toBeNull();
    // 冲突串原样出现，不被概括掉。
    expect(screen.getByText('notes/b.md changed after the plan was built')).toBeInTheDocument();
    // 回查只报后端数字。
    expect(
      screen.getByText('12 relations in the graph now; 1 of the proposals are present, 3 are absent.'),
    ).toBeInTheDocument();
    // 写进去了东西，所以撤销必须在。
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('marks file-level evidence as file-level instead of implying a passage', async () => {
    vi.mocked(knowledgeGraphCreatePlan).mockResolvedValue(plan());

    await openFixTab();
    fireEvent.click(screen.getByRole('button', { name: /Build a fix plan/ }));

    await waitFor(() =>
      expect(screen.getByText('File-level evidence')).toBeInTheDocument(),
    );
    expect(
      screen.getByText('File-level evidence: it points at the note, not at any passage inside it.'),
    ).toBeInTheDocument();
    expect(screen.getByText('This evidence has no quotable text.')).toBeInTheDocument();
  });

  it('groups findings under a named kind instead of printing the backend code', async () => {
    vi.mocked(knowledgeGraphCreatePlan).mockResolvedValue(plan());

    await openFixTab();
    fireEvent.click(screen.getByRole('button', { name: /Build a fix plan/ }));

    await waitFor(() => expect(screen.getByText('Orphan notes')).toBeInTheDocument());
    expect(screen.queryByText('hub_overload')).toBeNull();
  });

  it('has both languages for every plan status, risk and finding kind', () => {
    const prefixes = ['gap.plan.status.', 'gap.plan.risk.', 'gap.plan.obsKind.', 'graph.relation.'];
    const keys = Object.keys(en).filter(k => prefixes.some(p => k.startsWith(p)));
    expect(keys.length).toBeGreaterThan(30);
    for (const key of keys) {
      expect(zh[key as keyof typeof zh], `zh is missing ${key}`).toBeTruthy();
    }
    // 反向也要成立：中文多出来的键在英文里必须有，否则切到 en 就会漏字。
    const zhKeys = Object.keys(zh).filter(k => prefixes.some(p => k.startsWith(p)));
    for (const key of zhKeys) {
      expect(en[key as keyof typeof en], `en is missing ${key}`).toBeTruthy();
    }
  });
});
