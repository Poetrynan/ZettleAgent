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
  ChatHeader: ({ setMode, setShowSessionList }: any) => (
    <div>
      <button data-testid="use-rag" onClick={() => setMode('rag')}>rag</button>
      <button data-testid="open-sessions" onClick={() => setShowSessionList(true)}>sessions</button>
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
  llmConfig: { apiUrl: 'https://x/v1', apiKey: '', model: 'm', providerId: 'custom' },
};

vi.mock('../../../contexts/AppContext', () => ({
  useApp: () => ({
    state: appState,
    toggleChat: vi.fn(),
    clearPendingAttachments: vi.fn(),
    clearPendingChatPrompt: vi.fn(),
    showToast: vi.fn(),
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

