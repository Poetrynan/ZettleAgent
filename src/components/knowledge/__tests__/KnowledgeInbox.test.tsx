import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom';

import { KnowledgeInbox } from '../KnowledgeInbox';
import {
  KnowledgeInboxItem,
  confirmMemory,
  decideCommitment,
  getKnowledgeInbox,
} from '../../../lib/tauri';
import { setLang } from '../../../lib/i18n';
import { en } from '../../../lib/i18n/en';
import { zh } from '../../../lib/i18n/zh';

vi.mock('../../../lib/tauri', () => ({
  confirmMemory: vi.fn().mockResolvedValue({}),
  decideCommitment: vi.fn().mockResolvedValue({}),
  forgetMemory: vi.fn().mockResolvedValue({}),
  getKnowledgeInbox: vi.fn(),
  rejectMemory: vi.fn().mockResolvedValue({}),
}));

// i18n 不 mock：文案本身就是这一层要验的东西之一。
beforeEach(() => {
  vi.clearAllMocks();
  setLang('en');
});

function item(over: Partial<KnowledgeInboxItem> = {}): KnowledgeInboxItem {
  return {
    id: 'm1',
    kind: 'memory',
    title: 'prefers conclusions before details',
    summary: '',
    status: 'candidate',
    risk: null,
    sourceType: 'agent_run',
    sourceId: 'run-1',
    reason: 'memory_unconfirmed',
    actions: ['confirm', 'reject', 'forget'],
    createdAtMs: 1,
    updatedAtMs: 2,
    ...over,
  };
}

describe('KnowledgeInbox 的四种状态', () => {
  it('在读的时候给骨架屏，而不是一片空白', () => {
    vi.mocked(getKnowledgeInbox).mockReturnValue(new Promise(() => {}));
    render(<KnowledgeInbox vaultPath={null} onOpenPage={vi.fn()} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  /** 读失败不能长得像"没有待办"——那是这类界面最常见的谎。 */
  it('读失败时说清没读到、也没改坏东西，并能重试', async () => {
    vi.mocked(getKnowledgeInbox).mockRejectedValueOnce(new Error('db locked'));
    render(<KnowledgeInbox vaultPath={null} onOpenPage={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(en['knowledge.loadFailed'])).toBeInTheDocument();
    // 原始错误留在技术详情里，不占主文案。
    expect(screen.getByText('db locked')).toBeInTheDocument();

    vi.mocked(getKnowledgeInbox).mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole('button', { name: en['knowledge.retry'] }));
    await waitFor(() => expect(getKnowledgeInbox).toHaveBeenCalledTimes(2));
  });

  it('空状态说明为什么空，并给下一步', async () => {
    vi.mocked(getKnowledgeInbox).mockResolvedValue([]);
    const onOpenChat = vi.fn();
    render(<KnowledgeInbox vaultPath={null} onOpenPage={vi.fn()} onOpenChat={onOpenChat} />);

    await waitFor(() =>
      expect(screen.getByText(en['knowledge.inbox.empty'])).toBeInTheDocument(),
    );
    expect(screen.getByText(en['knowledge.inbox.emptyHint'])).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: en['knowledge.inbox.goChat'] }));
    expect(onOpenChat).toHaveBeenCalled();
  });
});

describe('收件箱卡片', () => {
  it('把 reason 代码翻译成人话，代码本身不出现在正文里', async () => {
    vi.mocked(getKnowledgeInbox).mockResolvedValue([item()]);
    render(<KnowledgeInbox vaultPath={null} onOpenPage={vi.fn()} />);

    await waitFor(() =>
      expect(
        screen.getByText(en['knowledge.reason.memory_unconfirmed']),
      ).toBeInTheDocument(),
    );
    // 代码只在折叠的技术详情里出现一次。
    expect(screen.getAllByText('memory_unconfirmed')).toHaveLength(1);
  });

  it('确认一条候选记忆时把 vault 一起传下去（memory.md 投影要它）', async () => {
    vi.mocked(getKnowledgeInbox).mockResolvedValue([item()]);
    const onChanged = vi.fn();
    render(
      <KnowledgeInbox vaultPath="D:/vault" onOpenPage={vi.fn()} onChanged={onChanged} />,
    );

    await waitFor(() => screen.getByRole('button', { name: en['knowledge.action.confirm'] }));
    fireEvent.click(screen.getByRole('button', { name: en['knowledge.action.confirm'] }));

    await waitFor(() => expect(confirmMemory).toHaveBeenCalledWith('m1', 'D:/vault'));
    // 处理完要重读列表并让外面的角标跟着变。
    await waitFor(() => expect(getKnowledgeInbox).toHaveBeenCalledTimes(2));
    expect(onChanged).toHaveBeenCalled();
  });

  /**
   * 这一条锁的是产品规则，不是实现：收件箱里不能有"批准"。
   *
   * 批准的前置条件是看过逐行 diff，那是变更页的事。一个不看 diff 就能点的批准按钮，
   * 等于把审批降级成走过场。
   */
  it('变更只给"查看改动"，不给就地批准', async () => {
    vi.mocked(getKnowledgeInbox).mockResolvedValue([
      item({
        id: 'cs1',
        kind: 'change',
        title: 'tidy up the meeting note',
        summary: '3',
        status: 'awaiting_approval',
        reason: 'change_awaiting_approval',
        actions: ['preview'],
      }),
    ]);
    const onOpenPage = vi.fn();
    render(<KnowledgeInbox vaultPath={null} onOpenPage={onOpenPage} />);

    await waitFor(() => screen.getByRole('button', { name: en['knowledge.action.preview'] }));
    expect(
      screen.queryByRole('button', { name: en['knowledge.action.approve'] }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('3 operation(s)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: en['knowledge.action.preview'] }));
    expect(onOpenPage).toHaveBeenCalledWith('changes');
  });

  it('索引故障把失败原因直接摆在卡片上', async () => {
    vi.mocked(getKnowledgeInbox).mockResolvedValue([
      item({
        id: 'job1',
        kind: 'health',
        title: 'objectify',
        summary: 'embedding model unavailable',
        status: 'failed',
        reason: 'health_job_failed',
        actions: ['open_health'],
      }),
    ]);
    render(<KnowledgeInbox vaultPath={null} onOpenPage={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByText('embedding model unavailable')).toBeInTheDocument(),
    );
  });

  it('承诺可以就地接受，因为那不需要额外信息', async () => {
    vi.mocked(getKnowledgeInbox).mockResolvedValue([
      item({
        id: 't1',
        kind: 'task',
        title: 'send the draft on Friday',
        status: 'proposed',
        reason: 'task_proposed',
        actions: ['activate', 'snooze', 'complete', 'dismiss'],
      }),
    ]);
    const onOpenPage = vi.fn();
    render(<KnowledgeInbox vaultPath={null} onOpenPage={onOpenPage} />);

    await waitFor(() => screen.getByRole('button', { name: en['knowledge.action.activate'] }));
    fireEvent.click(screen.getByRole('button', { name: en['knowledge.action.activate'] }));
    await waitFor(() =>
      expect(decideCommitment).toHaveBeenCalledWith({
        commitmentId: 't1',
        action: 'activate',
      }),
    );

    // "完成"需要一句说明才算闭环，所以它跳到任务页，不在卡片上假装完成。
    fireEvent.click(screen.getByRole('button', { name: en['knowledge.action.complete'] }));
    expect(onOpenPage).toHaveBeenCalledWith('tasks');
  });
});

/**
 * 中英文必须同时完整 / neither language may be half-translated.
 *
 * 后端返回的是稳定代码，界面文案全靠这两张表。缺一条 key 的后果是用户看到
 * `memory_supersedes` 这种东西，而那正是这套设计想避免的。
 */
describe('reason / action 代码的双语覆盖', () => {
  const codes = [
    'knowledge.reason.memory_unconfirmed',
    'knowledge.reason.memory_low_confidence',
    'knowledge.reason.memory_conflicts',
    'knowledge.reason.memory_supersedes',
    'knowledge.reason.memory_external_source',
    'knowledge.reason.change_awaiting_approval',
    'knowledge.reason.change_approved_pending_write',
    'knowledge.reason.change_failed',
    'knowledge.reason.task_proposed',
    'knowledge.reason.task_due_soon',
    'knowledge.reason.task_overdue',
    'knowledge.reason.health_job_failed',
    'knowledge.action.confirm',
    'knowledge.action.reject',
    'knowledge.action.forget',
    'knowledge.action.preview',
    'knowledge.action.activate',
    'knowledge.action.snooze',
    'knowledge.action.complete',
    'knowledge.action.dismiss',
    'knowledge.action.open_health',
    'knowledge.inbox.kind.memory',
    'knowledge.inbox.kind.change',
    'knowledge.inbox.kind.task',
    'knowledge.inbox.kind.health',
  ] as const;

  it.each(codes)('%s 两种语言都有', key => {
    expect(en[key]).toBeTruthy();
    expect(zh[key as keyof typeof zh]).toBeTruthy();
  });
});
