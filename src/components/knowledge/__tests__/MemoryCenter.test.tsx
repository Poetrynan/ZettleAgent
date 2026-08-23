import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom';

import { MemoryCenter } from '../MemoryCenter';
import {
  MemoryDetail,
  MemoryItem,
  confirmMemory,
  editMemory,
  forgetMemory,
  getMemoryDetail,
  listMemories,
  restoreMemory,
  syncMemoryFile,
} from '../../../lib/tauri';
import { setLang } from '../../../lib/i18n';
import { en } from '../../../lib/i18n/en';
import { zh } from '../../../lib/i18n/zh';

vi.mock('../../../lib/tauri', () => ({
  confirmMemory: vi.fn().mockResolvedValue({}),
  editMemory: vi.fn().mockResolvedValue({}),
  forgetMemory: vi.fn().mockResolvedValue({}),
  getMemoryDetail: vi.fn(),
  listMemories: vi.fn(),
  rejectMemory: vi.fn().mockResolvedValue({}),
  restoreMemory: vi.fn().mockResolvedValue({}),
  syncMemoryFile: vi.fn().mockResolvedValue({ adopted: 1, unchanged: 2, forgotten: 0 }),
}));

// i18n 不 mock：界面上不许出现 Rust 枚举名，这正是要验的东西。
beforeEach(() => {
  vi.clearAllMocks();
  setLang('en');
});

function memory(over: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'm1',
    object_id: 'o1',
    kind: 'profile',
    lifecycle: 'active',
    claim: 'prefers conclusions before details',
    scope: 'global',
    confidence: 0.82,
    importance: 1,
    source: null,
    valid_from_ms: null,
    valid_to_ms: null,
    supersedes_id: null,
    conflicts_with_id: null,
    confirmed_by: 'user',
    confirmed_at_ms: 2,
    requires_user_confirmation: false,
    last_accessed_ms: null,
    expires_at_ms: null,
    section: 'User Preferences',
    created_at_ms: 1,
    updated_at_ms: 2,
    ...over,
  };
}

function detail(over: Partial<MemoryDetail> = {}): MemoryDetail {
  return {
    item: memory(),
    supersedes: null,
    supersededBy: null,
    conflictsWith: null,
    evidence: [],
    ...over,
  };
}

describe('MemoryCenter 的四种状态', () => {
  it('读的时候给骨架屏', () => {
    vi.mocked(listMemories).mockReturnValue(new Promise(() => {}));
    render(<MemoryCenter vaultPath={null} />);
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
  });

  it('读失败时说清没读到，并能重试', async () => {
    vi.mocked(listMemories).mockRejectedValueOnce(new Error('db locked'));
    render(<MemoryCenter vaultPath={null} />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText('Could not load this. Nothing was changed.')).toBeInTheDocument();
    expect(screen.getByText('db locked')).toBeInTheDocument();
  });

  /** "什么都没记住"和"筛选之后没有"是两件事，文案必须不同。 */
  it('区分"还没记住任何事"和"筛选之后没有"', async () => {
    vi.mocked(listMemories).mockResolvedValue([]);
    render(<MemoryCenter vaultPath={null} />);

    await waitFor(() =>
      expect(screen.getByText('Nothing is remembered about you yet.')).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByLabelText('Search remembered claims'), {
      target: { value: 'caching' },
    });

    await waitFor(() =>
      expect(screen.getByText('No memory matches these filters.')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
  });
});

describe('全量视图', () => {
  /** 默认不带生命周期筛选：Center 的默认答案是"全部"。 */
  it('默认列出全部生命周期，而不只是收件箱', async () => {
    vi.mocked(listMemories).mockResolvedValue([
      memory({ id: 'a', lifecycle: 'active' }),
      memory({ id: 'b', lifecycle: 'archived', claim: 'dislikes dark mode', confirmed_by: null }),
      memory({ id: 'c', lifecycle: 'superseded', claim: 'lives in Beijing' }),
    ]);
    render(<MemoryCenter vaultPath={null} />);

    await waitFor(() => expect(screen.getByText('3 memory item(s)')).toBeInTheDocument());
    expect(vi.mocked(listMemories).mock.calls[0][0]).toMatchObject({ lifecycles: undefined });

    // 状态说人话，不出现 Rust 枚举名。筛选 chip 用的是同一批文案，所以这里只看每张
    // 卡片上的状态标（`.kc-pill`），避免把 chip 当成卡片状态。
    const pills = Array.from(document.querySelectorAll('.kc-pill')).map(el => el.textContent);
    expect(pills).toEqual(['In use', 'Rejected by you', 'Replaced']);
    expect(screen.queryByText('superseded')).not.toBeInTheDocument();
    expect(screen.queryByText('archived')).not.toBeInTheDocument();
  });

  it('勾选状态后按那个状态查询', async () => {
    vi.mocked(listMemories).mockResolvedValue([memory()]);
    render(<MemoryCenter vaultPath={null} />);
    await waitFor(() => expect(listMemories).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText('Waiting for you'));

    await waitFor(() =>
      expect(vi.mocked(listMemories).mock.calls.at(-1)?.[0]).toMatchObject({
        lifecycles: ['candidate'],
      }),
    );
  });

  /** 置信度是模型自评分，不该以主文案的身份出现。 */
  it('把置信度收进技术详情，不放在主文案里', async () => {
    vi.mocked(listMemories).mockResolvedValue([memory()]);
    vi.mocked(getMemoryDetail).mockResolvedValue(detail());
    render(<MemoryCenter vaultPath={null} />);

    await waitFor(() => expect(screen.getByText('prefers conclusions before details')).toBeInTheDocument());
    expect(screen.queryByText('0.82')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Where this came from' }));
    await waitFor(() => expect(screen.getByText('0.82')).toBeInTheDocument());
    expect(screen.getByText('0.82').closest('details')).not.toBeNull();
  });
});

describe('动作接的是真命令', () => {
  it('候选给确认/否掉，并把 vault 传下去', async () => {
    vi.mocked(listMemories).mockResolvedValue([
      memory({ lifecycle: 'candidate', confirmed_by: null, requires_user_confirmation: true }),
    ]);
    render(<MemoryCenter vaultPath="d:/vault" onChanged={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(confirmMemory).toHaveBeenCalledWith('m1', 'd:/vault'));
  });

  /** 生效中的记忆不该有"确认"按钮——它已经确认过了。 */
  it('生效中的记忆给改写/遗忘，不给确认', async () => {
    vi.mocked(listMemories).mockResolvedValue([memory()]);
    render(<MemoryCenter vaultPath={null} />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
    await waitFor(() => expect(forgetMemory).toHaveBeenCalledWith('m1'));
  });

  /**
   * 改写先讲清后果再保存。
   *
   * 后端是"新提一条取代旧的"，所以界面必须说旧说法留在历史里，并且保存后重新拉列表
   * ——新条目的 id 不同，原地改会显示成一条不存在的记忆。
   */
  it('改写会说清旧说法留在历史里，保存后重新拉列表', async () => {
    vi.mocked(listMemories).mockResolvedValue([memory()]);
    const onChanged = vi.fn();
    render(<MemoryCenter vaultPath={null} onChanged={onChanged} />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.getByText(/keeps the old wording in the history/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Edit'), { target: { value: 'prefers details first' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(editMemory).toHaveBeenCalledWith('m1', 'prefers details first'));
    await waitFor(() => expect(listMemories).toHaveBeenCalledTimes(2));
    expect(onChanged).toHaveBeenCalled();
  });

  it('空内容不给保存', async () => {
    vi.mocked(listMemories).mockResolvedValue([memory()]);
    render(<MemoryCenter vaultPath={null} />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Edit'), { target: { value: '   ' } });

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(editMemory).not.toHaveBeenCalled();
  });

  it('被否掉的记忆可以撤回', async () => {
    vi.mocked(listMemories).mockResolvedValue([
      memory({ lifecycle: 'archived', confirmed_by: null }),
    ]);
    render(<MemoryCenter vaultPath={null} />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Undo this decision' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Undo this decision' }));
    await waitFor(() => expect(restoreMemory).toHaveBeenCalledWith('m1'));
  });

  it('动作失败时保留原样并说出错在哪', async () => {
    vi.mocked(listMemories).mockResolvedValue([memory()]);
    vi.mocked(forgetMemory).mockRejectedValueOnce(new Error('db is locked'));
    render(<MemoryCenter vaultPath={null} />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Forget' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText('db is locked')).toBeInTheDocument();
    expect(screen.getByText('prefers conclusions before details')).toBeInTheDocument();
  });
});

describe('来历', () => {
  it('取代链两头都读得到', async () => {
    vi.mocked(listMemories).mockResolvedValue([memory({ lifecycle: 'superseded' })]);
    vi.mocked(getMemoryDetail).mockResolvedValue(
      detail({ supersededBy: memory({ id: 'm2', claim: 'prefers details first' }) }),
    );
    render(<MemoryCenter vaultPath={null} />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Where this came from' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Where this came from' }));

    await waitFor(() => expect(screen.getByText('Replaced by')).toBeInTheDocument());
    expect(screen.getByText('prefers details first')).toBeInTheDocument();
  });

  /** 没有证据就明说不可核对——留白会让人以为它有依据。 */
  it('没有证据时说清这条无法核对', async () => {
    vi.mocked(listMemories).mockResolvedValue([memory()]);
    vi.mocked(getMemoryDetail).mockResolvedValue(detail({ evidence: [] }));
    render(<MemoryCenter vaultPath={null} />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Where this came from' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Where this came from' }));

    await waitFor(() =>
      expect(screen.getByText(/cannot be checked against a source/)).toBeInTheDocument(),
    );
  });

  it('带证据时给出原文片段', async () => {
    vi.mocked(listMemories).mockResolvedValue([memory()]);
    vi.mocked(getMemoryDetail).mockResolvedValue(
      detail({
        evidence: [
          {
            id: 'ev-1',
            source_type: 'agent_run',
            source_id: 'run-1',
            locator: 'chat:run/run-1',
            excerpt: 'just give me the conclusion first',
            checksum: null,
            captured_at_ms: 1_700_000_000_000,
            author: null,
            extraction_model: 'local-mini',
            pipeline_version: 'v2',
          },
        ],
      }),
    );
    render(<MemoryCenter vaultPath={null} />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Where this came from' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Where this came from' }));

    await waitFor(() =>
      expect(screen.getByText('just give me the conclusion first')).toBeInTheDocument(),
    );
  });
});

describe('memory.md 回流', () => {
  it('有 vault 时给回流入口，并报出真实结果', async () => {
    vi.mocked(listMemories).mockResolvedValue([]);
    render(<MemoryCenter vaultPath="d:/vault" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Absorb memory.md edits' }));

    await waitFor(() => expect(syncMemoryFile).toHaveBeenCalledWith('d:/vault'));
    expect(await screen.findByText('1 adopted, 2 already known, 0 forgotten')).toBeInTheDocument();
  });

  it('没有 vault 就说明为什么不能同步', async () => {
    vi.mocked(listMemories).mockResolvedValue([]);
    render(<MemoryCenter vaultPath={null} />);

    expect(screen.getByText('Open a vault to sync memory.md.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Absorb memory.md edits' })).not.toBeInTheDocument();
  });
});

/** 生命周期和类型的每个值都必须两种语言都有文案。 */
describe('code 覆盖', () => {
  const codes = [
    'knowledge.lifecycle.candidate', 'knowledge.lifecycle.verified', 'knowledge.lifecycle.active',
    'knowledge.lifecycle.superseded', 'knowledge.lifecycle.expired', 'knowledge.lifecycle.archived',
    'knowledge.lifecycle.forgotten',
    'knowledge.kind.episodic', 'knowledge.kind.semantic', 'knowledge.kind.profile',
    'knowledge.kind.procedural', 'knowledge.kind.resource', 'knowledge.kind.error',
    'knowledge.kind.task',
  ] as const;

  it.each(codes)('%s has both en and zh copy', key => {
    expect(en[key]).toBeTruthy();
    expect(zh[key]).toBeTruthy();
  });
});
