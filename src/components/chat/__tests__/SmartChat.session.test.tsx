/**
 * Regression test for the stale-`sessionId` closure in SmartChat.
 *
 * ## The bug
 *
 * `SmartChat.tsx` registers the `llm-stream-chunk` listener in a
 * `useEffect(..., [])`. The `sess` object it closes over is therefore the one
 * from the *first* render, so `sess.sessionId` inside the `done` branch is
 * frozen at the value the app mounted with. Once the user starts a new session
 * (or loads an existing one), the finished assistant reply was persisted under
 * that first session id — i.e. into the wrong conversation.
 *
 * ## The invariant locked down here
 *
 * A stream is owned by the session that was active when it was *sent*. Neither
 * a session created before the stream started nor one switched to afterwards may
 * receive the reply.
 */
import { render, fireEvent, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom';


// ── Event bus: capture the handlers SmartChat registers ──────────────
type Handler = (event: { payload: unknown }) => void;
const handlers = new Map<string, Handler[]>();

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, handler: Handler) => {
    const list = handlers.get(name) ?? [];
    list.push(handler);
    handlers.set(name, list);
    return Promise.resolve(() => {
      handlers.set(name, (handlers.get(name) ?? []).filter(h => h !== handler));
    });
  }),
  emit: vi.fn(),
}));

/** Fire a Tauri event at every listener currently registered for it. */
function emitEvent(name: string, payload: unknown) {
  for (const handler of handlers.get(name) ?? []) handler({ payload });
}

// ── Backend surface ─────────────────────────────────────────────────
vi.mock('../../../lib/tauri', () => ({
  ragSearchAndStream: vi.fn().mockResolvedValue(undefined),
  agentChat: vi.fn().mockResolvedValue(''),
  cancelAgentTurn: vi.fn().mockResolvedValue(undefined),
  saveChatMessage: vi.fn().mockResolvedValue(undefined),
  readMarkdownFile: vi.fn().mockResolvedValue(''),
  emitRefreshEvent: vi.fn(),
  exportChatSession: vi.fn().mockResolvedValue(''),
  resolveRagSearchMode: vi.fn().mockResolvedValue('fts'),
  ragNeedsQueryEmbedding: vi.fn().mockReturnValue(false),
  deleteChatMessagesFrom: vi.fn().mockResolvedValue(undefined),
  estimateAgentContextTokens: vi.fn().mockResolvedValue({
    total: 4200,
    messages: 200,
    system: 2800,
    tools: 1200,
  }),
  listChatSessions: vi.fn().mockResolvedValue([]),
  getChatSession: vi.fn().mockResolvedValue([]),
  createChatSession: vi.fn().mockResolvedValue(undefined),
  deleteChatSession: vi.fn().mockResolvedValue(undefined),
  renameChatSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../lib/i18n', () => ({ t: (k: string) => k }));

// ── Presentation stubs ──────────────────────────────────────────────
// The real subtrees drag in Markdown/KaTeX/Mermaid and are irrelevant here.
// The header stub exposes the two controls the scenario needs.
vi.mock('../ChatHeader', () => ({
  ChatHeader: ({ setMode, setShowSessionList, setShowKnowledgePanel }: any) => (
    <div>
      <button data-testid="use-rag" onClick={() => setMode('rag')}>rag</button>
      <button data-testid="open-sessions" onClick={() => setShowSessionList(true)}>sessions</button>
      <button data-testid="open-knowledge" onClick={() => setShowKnowledgePanel(true)}>knowledge</button>
    </div>
  ),
}));

// 面板本身另有测试；这里只要看清 SmartChat 递给它的是哪一轮的上下文。
vi.mock('../KnowledgePanel', () => ({
  KnowledgePanel: ({ contextPackage, runId }: any) => (
    <div>
      <span data-testid="ctx-query">{contextPackage?.query ?? ''}</span>
      <span data-testid="ctx-run">{runId ?? ''}</span>
    </div>
  ),
}));


vi.mock('../SessionListPanel', () => ({
  SessionListPanel: ({ sessionId, onNewSession }: any) => (
    <div>
      <span data-testid="active-session">{sessionId}</span>
      <button data-testid="new-session" onClick={() => onNewSession()}>new</button>
    </div>
  ),
}));

vi.mock('../ChatMessageList', () => ({ ChatMessageList: () => <div /> }));
vi.mock('../../common/Modal', () => ({ Modal: () => null }));

// ── App context ─────────────────────────────────────────────────────
const appState = {
  view: 'notes',
  lang: 'en',
  isChatOpen: true,
  vaultPath: '/vault',
  vaultPaths: ['/vault'],
  searchMode: 'fts',
  methodology: 'zettelkasten',
  currentFile: null,
  pendingAttachments: [],
  pendingChatPrompt: null,
  llmConfig: { apiUrl: 'https://x/v1', apiKey: '', model: 'm', providerId: 'custom', contextWindow: 200000 },

};

// `showToast` 在生产里是 `useCallback(..., [])`，身份稳定；这里也给一个稳定的
// spy，否则每次 render 都换一个函数，依赖它的 effect 会反复重注册。
const showToast = vi.fn();

vi.mock('../../../contexts/AppContext', () => ({
  useApp: () => ({
    state: appState,
    toggleChat: vi.fn(),
    clearPendingAttachments: vi.fn(),
    clearPendingChatPrompt: vi.fn(),
    showToast,
  }),
}));

import { SmartChat } from '../SmartChat';
import { saveChatMessage } from '../../../lib/tauri';

/** Session id the panel currently reports as active. */
function activeSessionId(container: HTMLElement): string {
  return container.querySelector('[data-testid="active-session"]')!.textContent!;
}

describe('SmartChat session ownership of async stream callbacks', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    // Session ids are `Date.now().toString()`. In a test the mount and the
    // subsequent "new session" can land in the same millisecond, which would
    // make the two ids identical and quietly defeat the assertion. A monotonic
    // clock guarantees they differ.
    let tick = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => (tick += 1_000));
  });


  it('persists a finished stream to the session it was sent from, not the mount-time one', async () => {
    const { container } = render(<SmartChat />);
    await waitFor(() => expect(handlers.get('llm-stream-chunk')?.length).toBe(1));

    // The id the component mounted with — the value the `[]`-deps listener
    // closed over, and the one the bug persisted everything to.
    fireEvent.click(container.querySelector('[data-testid="open-sessions"]')!);
    const mountSession = activeSessionId(container);

    // Switching Agent → RAG starts a fresh session (Cursor-style), so from here
    // on the live session id differs from what the listener captured.
    fireEvent.click(container.querySelector('[data-testid="use-rag"]')!);
    fireEvent.click(container.querySelector('[data-testid="open-sessions"]')!);
    const senderSession = activeSessionId(container);
    expect(senderSession).not.toBe(mountSession);

    // Send a question — this turn belongs to `senderSession`.
    const textarea = container.querySelector('.chat-input-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '这是一个问题' } });
    await act(async () => {
      fireEvent.click(container.querySelector('.chat-send-btn-v2')!);
    });
    // The user message goes to the sending session (this path was always right).
    expect(vi.mocked(saveChatMessage).mock.calls.map(c => c[1])).toContain(senderSession);

    // Isolate the assertion to the stream-completion persist.
    vi.mocked(saveChatMessage).mockClear();

    await act(async () => {
      emitEvent('llm-stream-chunk', { content: '答案', done: false });
      emitEvent('llm-stream-chunk', { content: '', done: true });
    });

    await waitFor(() => expect(vi.mocked(saveChatMessage)).toHaveBeenCalled());

    const persistedTo = vi.mocked(saveChatMessage).mock.calls.map(c => c[1]);
    expect(persistedTo).toContain(senderSession);
    expect(persistedTo).not.toContain(mountSession);
  });

  it('keeps the reply out of a session the user switches to mid-stream', async () => {
    const { container } = render(<SmartChat />);
    await waitFor(() => expect(handlers.get('llm-stream-chunk')?.length).toBe(1));

    fireEvent.click(container.querySelector('[data-testid="use-rag"]')!);
    fireEvent.click(container.querySelector('[data-testid="open-sessions"]')!);
    const senderSession = activeSessionId(container);

    const textarea = container.querySelector('.chat-input-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '另一个问题' } });
    await act(async () => {
      fireEvent.click(container.querySelector('.chat-send-btn-v2')!);
    });

    // Partial output arrives, then the user jumps to a brand-new conversation.
    await act(async () => {
      emitEvent('llm-stream-chunk', { content: '半个', done: false });
    });
    fireEvent.click(container.querySelector('[data-testid="open-sessions"]')!);
    fireEvent.click(container.querySelector('[data-testid="new-session"]')!);
    fireEvent.click(container.querySelector('[data-testid="open-sessions"]')!);
    const switchedSession = activeSessionId(container);
    expect(switchedSession).not.toBe(senderSession);

    vi.mocked(saveChatMessage).mockClear();
    await act(async () => {
      emitEvent('llm-stream-chunk', { content: '', done: true });
    });

    // Whether or not anything is written (starting a new session clears the
    // in-flight message), the one thing that must never happen is the reply
    // showing up in the conversation the user moved to.
    const persistedTo = vi.mocked(saveChatMessage).mock.calls.map(c => c[1]);
    expect(persistedTo).not.toContain(switchedSession);
  });
});

/**
 * `agent-event` 的世代过滤 / lifecycle generation on the agent event bus.
 *
 * 每个事件都盖着 `run_id`。上一轮的事件（崩溃重启、快速重发）不能改这一轮的界面，
 * 但旧后端不带 `run_id` 的事件必须照旧生效——否则一次升级会让界面整体失聪。
 */
describe('SmartChat agent-event generations', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    let tick = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => (tick += 1_000));
  });

  function ctxEvent(runId: string | undefined, query: string) {
    return {
      type: 'context_package_ready',
      run_id: runId,
      package: {
        query,
        intent: 'search',
        scope: [],
        counts: { facts: 0, memories: 0, openTasks: 0, related: 0, conflicts: 0 },
        items: [],
        knowledgeGaps: [],
        warnings: [],
        budget: { maxTokens: 100, usedTokens: 1, truncatedCandidates: 0 },
      },
    };
  }

  it('hands the compiled context of the live run to the knowledge panel', async () => {
    const { container } = render(<SmartChat />);
    await waitFor(() => expect(handlers.get('agent-event')?.length).toBe(1));
    fireEvent.click(container.querySelector('[data-testid="open-knowledge"]')!);

    await act(async () => {
      emitEvent('agent-event', { type: 'run_started', run_id: 'run-1' });
      emitEvent('agent-event', ctxEvent('run-1', 'live question'));
    });

    expect(container.querySelector('[data-testid="ctx-query"]')!.textContent).toBe('live question');
    expect(container.querySelector('[data-testid="ctx-run"]')!.textContent).toBe('run-1');
  });

  it('drops an event stamped with a superseded run', async () => {
    const { container } = render(<SmartChat />);
    await waitFor(() => expect(handlers.get('agent-event')?.length).toBe(1));
    fireEvent.click(container.querySelector('[data-testid="open-knowledge"]')!);

    await act(async () => {
      emitEvent('agent-event', { type: 'run_started', run_id: 'run-2' });
      emitEvent('agent-event', ctxEvent('run-2', 'the live one'));
      emitEvent('agent-event', ctxEvent('run-1', 'the abandoned one'));
    });

    expect(container.querySelector('[data-testid="ctx-query"]')!.textContent).toBe('the live one');
  });

  /** 旧后端不带 `run_id`。把它们一并丢掉等于升级即失聪。 */
  it('still accepts events from a backend that stamps no run id', async () => {
    const { container } = render(<SmartChat />);
    await waitFor(() => expect(handlers.get('agent-event')?.length).toBe(1));
    fireEvent.click(container.querySelector('[data-testid="open-knowledge"]')!);

    await act(async () => {
      emitEvent('agent-event', { type: 'run_started', run_id: 'run-3' });
      emitEvent('agent-event', ctxEvent(undefined, 'unstamped but real'));
    });

    expect(container.querySelector('[data-testid="ctx-query"]')!.textContent).toBe('unstamped but real');
  });
});

/**
 * 上下文容量指示器 / the context-capacity readout on the composer.
 *
 * Token 读数的位置本身就是语义：它回答"我还能再说多少"，所以它属于输入框，而且
 * 必须带分母和标签——一个孤零零的 `↺ 47%` 没人知道那是什么的百分比。
 */
describe('SmartChat context capacity meter', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    let tick = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => (tick += 1_000));
  });

  function usageEvent(input: number, cacheRead: number) {
    return {
      type: 'token_usage',
      run_id: 'run-1',
      input,
      output: 500,
      cache_read: cacheRead,
      cache_write: 0,
      total: input + cacheRead + 500,
      cache_hit_rate: cacheRead / (cacheRead + input),
    };
  }

  it('reports the last turn’s prompt against the model window', async () => {
    const { container } = render(<SmartChat />);
    await waitFor(() => expect(handlers.get('agent-event')?.length).toBe(1));

    // 结算之前也在场，但必须自报是估算：需要它的时刻是发送前，而不是某一轮跑完。
    expect(container.querySelector('.chat-context-meter-chip')!.textContent).toContain('~');


    await act(async () => {
      emitEvent('agent-event', { type: 'run_started', run_id: 'run-1' });
      emitEvent('agent-event', usageEvent(1000, 3000));
    });

    // prompt = 1000 + 3000 = 4000，占 200k 窗口的 2%。output 不算——它不占下一轮。
    const chip = container.querySelector('.chat-context-meter-chip')!;
    expect(chip.textContent).toContain('2%');

    fireEvent.click(chip);
    const values = Array.from(container.querySelectorAll('.chat-context-meter-value'))
      .map(el => el.textContent);
    expect(values[0]).toBe('4.0k/200.0k (2.0%)');
    expect(values[1]).toBe('75%');
  });

  /** 命中率按会话 prompt 加权，不是把每轮的百分比再平均一次。 */
  it('weights the cache hit rate by prompt tokens across the session', async () => {
    const { container } = render(<SmartChat />);
    await waitFor(() => expect(handlers.get('agent-event')?.length).toBe(1));

    await act(async () => {
      emitEvent('agent-event', { type: 'run_started', run_id: 'run-1' });
      emitEvent('agent-event', usageEvent(1000, 3000));
      emitEvent('agent-event', usageEvent(1000, 9000));
    });

    fireEvent.click(container.querySelector('.chat-context-meter-chip')!);
    const values = Array.from(container.querySelectorAll('.chat-context-meter-value'))
      .map(el => el.textContent);
    // 容量只看最近一轮：10.0k。命中率 = 12000 / 14000 ≈ 86%。
    expect(values[0]).toBe('10.0k/200.0k (5.0%)');
    expect(values[1]).toBe('86%');
  });
});

/**
 * 调度器发出的主动提醒 / the nudges the scheduler's knowledge pass emits.
 *
 * 后端已经过完四道闸门才发这个事件，所以前端的责任只有一条：**收到了就说出来**。
 * 把它悄悄丢掉，用户开了主动提醒却什么都听不到，那比不做更糟。
 */
describe('SmartChat proactive nudges', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    let tick = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => (tick += 1_000));
  });

  function commitment(id: string, title: string) {
    return { id, title, status: 'active', commitment_type: 'deadline' };
  }

  it('surfaces a nudge that reached the frontend', async () => {
    render(<SmartChat />);
    await waitFor(() => expect(handlers.get('proactive-nudge')?.length).toBe(1));

    await act(async () => {
      emitEvent('proactive-nudge', { items: [commitment('c1', 'send the quarterly numbers')] });
    });

    expect(showToast).toHaveBeenCalledWith('send the quarterly numbers', 'info');
  });

  /** 多条只说一条 + 计数：一次弹五个 toast 是骚扰，不是提醒。 */
  it('names one commitment and counts the rest', async () => {
    render(<SmartChat />);
    await waitFor(() => expect(handlers.get('proactive-nudge')?.length).toBe(1));

    await act(async () => {
      emitEvent('proactive-nudge', {
        items: [commitment('c1', 'first'), commitment('c2', 'second'), commitment('c3', 'third')],
      });
    });

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('first (+2)', 'info');
  });

  /** 空列表不该冒出一个空 toast——后端静默的时候前端也该静默。 */
  it('says nothing when the pass surfaced nothing', async () => {
    render(<SmartChat />);
    await waitFor(() => expect(handlers.get('proactive-nudge')?.length).toBe(1));

    await act(async () => {
      emitEvent('proactive-nudge', { items: [] });
    });

    expect(showToast).not.toHaveBeenCalled();
  });
});



