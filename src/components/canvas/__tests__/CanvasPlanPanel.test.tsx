import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom';

import { CanvasPlanPanel } from '../CanvasPlanPanel';
import {
  type CanvasPlan,
  type CanvasPlanOutcome,
  createCanvasPlan,
  stageCanvasPlan,
} from '../../../lib/canvasPlan';

// 只 mock 六个 invoke 包装；`defaultSelection` / `outcomeHeadline` / `outcomeTone`
// 保持真实实现——它们就是这三条测试要验的规则，mock 掉等于什么都没测。
vi.mock('../../../lib/canvasPlan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/canvasPlan')>();
  return {
    ...actual,
    createCanvasPlan: vi.fn(),
    getCanvasPlan: vi.fn(),
    stageCanvasPlan: vi.fn(),
    commitCanvasPlan: vi.fn(),
    rollbackCanvasPlan: vi.fn(),
    verifyCanvasPlan: vi.fn(),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

function plan(over: Partial<CanvasPlan> = {}): CanvasPlan {
  return {
    id: 'plan-1',
    goal: {
      goalType: 'explain',
      scope: { paths: [], cluster: null },
      anchorPaths: ['v/a.md'],
      question: '',
      constraints: [],
      maxNodes: null,
    },
    observations: [],
    proposals: [
      {
        id: 'p-high',
        operation: 'add_node',
        nodePaths: ['v/high.md'],
        groupTitle: null,
        reason: '语义相似度 0.92。',
        evidence: [{ path: 'v/high.md', chunkId: 7, excerpt: '摘录', kind: 'chunk_text' }],
        confidence: 0.92,
        risk: 'low',
        affectedPaths: ['v/high.md'],
      },
      {
        id: 'p-low',
        operation: 'add_node',
        nodePaths: ['v/low.md'],
        groupTitle: null,
        reason: '语义相似度 0.55。',
        evidence: [{ path: 'v/low.md', chunkId: null, excerpt: null, kind: 'file_level' }],
        confidence: 0.55,
        risk: 'low',
        affectedPaths: ['v/low.md'],
      },
    ],
    layout: 'grid',
    layoutFallbackReason: null,
    validationSteps: ['重新读取画布文件'],
    unresolvedQuestions: [],
    generatedBy: 'deterministic',
    generatedAtMs: 1,
    changesetId: null,
    state: 'preview_ready',
    canvasPath: 'v/board.canvas',
    ...over,
  };
}

function outcome(over: Partial<CanvasPlanOutcome> = {}): CanvasPlanOutcome {
  return {
    planId: 'plan-1',
    changesetId: 'cs-1',
    state: 'awaiting_approval',
    selected: 1,
    applied: 0,
    skipped: 0,
    failed: 0,
    conflicts: [],
    refusal: null,
    message: '后端原话',
    details: [],
    ...over,
  };
}

function renderPanel() {
  return render(
    <CanvasPlanPanel
      isOpen
      onClose={() => {}}
      lang="zh"
      canvasPath="v/board.canvas"
      vaultPath="v"
      vaultPaths={['v']}
      canvasNodePaths={['v/a.md']}
      onCommitted={() => {}}
    />,
  );
}

/** 点「生成计划」。面板里只有这一个搜索按钮。 */
async function buildPlan(container: HTMLElement) {
  fireEvent.click(container.querySelector('.smart-canvas-search-btn')!);
  await waitFor(() => expect(screen.getByText(/提议 2/)).toBeInTheDocument());
}

describe('CanvasPlanPanel', () => {
  it('默认只勾选高置信度提议，低置信度那条保持未勾选', async () => {
    vi.mocked(createCanvasPlan).mockResolvedValue(plan());
    const { container } = renderPanel();
    await buildPlan(container);

    // 两条提议，只有 0.92 那条被默认勾中。
    expect(screen.getByText(/提议 2 · 已选 1/)).toBeInTheDocument();

    const high = screen.getByText(/加节点 · high/).closest('.smart-canvas-result-card');
    const low = screen.getByText(/加节点 · low/).closest('.smart-canvas-result-card');
    expect(high).toHaveClass('selected');
    expect(low).not.toHaveClass('selected');
  });

  it('预览只算勾中的那几条，不是整份计划', async () => {
    vi.mocked(createCanvasPlan).mockResolvedValue(plan());
    const { container } = renderPanel();
    await buildPlan(container);

    expect(screen.getByText(/预览将加入: 1 个节点/)).toBeInTheDocument();
  });

  it('state 为 conflict 时不渲染成成功，并说清什么都没写入', async () => {
    vi.mocked(createCanvasPlan).mockResolvedValue(plan());
    vi.mocked(stageCanvasPlan).mockResolvedValue(
      outcome({ state: 'conflict', selected: 1, conflicts: ['画布已被别处修改'] }),
    );
    const { container } = renderPanel();
    await buildPlan(container);

    fireEvent.click(screen.getByText('生成预览（不写入）'));
    await waitFor(() =>
      expect(screen.getByText('画布已被改过，1 条改动一条都没有写入。')).toBeInTheDocument(),
    );

    // 没有任何"已写入"的说法，冲突原文也要露出来。
    expect(screen.queryByText(/已写入/)).not.toBeInTheDocument();
    expect(screen.getByText('画布已被别处修改')).toBeInTheDocument();
    // 冲突之后不允许直接提交。
    expect(screen.getByText('写入画布')).toBeDisabled();
  });

  it('预览成功时说的是"还没有写入"，而不是提前宣布成功', async () => {
    vi.mocked(createCanvasPlan).mockResolvedValue(plan());
    vi.mocked(stageCanvasPlan).mockResolvedValue(outcome({ selected: 1 }));
    const { container } = renderPanel();
    await buildPlan(container);

    fireEvent.click(screen.getByText('生成预览（不写入）'));
    await waitFor(() =>
      expect(
        screen.getByText('1 条改动已生成预览，还没有写入画布。'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText('写入画布')).not.toBeDisabled();
  });

  it('请求的布局做不到时把降级原因显示出来', async () => {
    const reason = '请求的是依赖层级布局，但计划里一条依赖边都没有。';
    vi.mocked(createCanvasPlan).mockResolvedValue(
      plan({ layout: 'grid', layoutFallbackReason: reason }),
    );
    const { container } = renderPanel();
    await buildPlan(container);

    expect(screen.getByText('布局降级说明')).toBeInTheDocument();
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(screen.getByText(/实际布局: grid/)).toBeInTheDocument();
  });

  it('文件级证据标明它是文件级，而不是编一段摘录', async () => {
    vi.mocked(createCanvasPlan).mockResolvedValue(plan());
    const { container } = renderPanel();
    await buildPlan(container);

    expect(
      screen.getByText(/依据: low — 文件级依据（没有精确到片段）/),
    ).toBeInTheDocument();
  });
});

