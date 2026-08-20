import { render, fireEvent, waitFor, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import '@testing-library/jest-dom';
import type { NotesOverview, NoteRow, BatchAgentReport } from '../../../lib/tauri';
import { tableMinWidth, defaultVisibleColumns, getColumn } from '../../../lib/notesHealth';


// ── Event bus: capture `agent-event` listeners so tests can drive progress ──
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
function emitEvent(name: string, payload: unknown) {
  for (const handler of handlers.get(name) ?? []) handler({ payload });
}

// ── Backend surface ─────────────────────────────────────────────────
// `vi.hoisted` so the fixture exists before the hoisted `vi.mock` factory runs.
const { mockReport } = vi.hoisted(() => ({
  mockReport: {
    runId: 'run-xyz', total: 2, succeeded: 2, failed: 0, cancelled: false,
    items: [
      { filePath: 'notes/a.md', status: 'ok' as const, summary: 'done', error: null },
      { filePath: 'notes/b.md', status: 'ok' as const, summary: 'done', error: null },
    ],
  } satisfies BatchAgentReport,
}));

vi.mock('../../../lib/tauri', () => ({
  getNotesOverview: vi.fn(),
  listSavedViews: vi.fn().mockResolvedValue([]),
  saveView: vi.fn().mockResolvedValue(undefined),
  deleteSavedView: vi.fn().mockResolvedValue(undefined),
  addCardsToReview: vi.fn().mockResolvedValue(2),
  chatWithLlm: vi.fn().mockResolvedValue({ content: 'backlinks=0' }),
  runBatchAgent: vi.fn().mockResolvedValue(mockReport),
  cancelAgentTurn: vi.fn().mockResolvedValue(true),
  undoAgentRun: vi.fn().mockResolvedValue({ warnings: [] }),
  readMarkdownFile: vi.fn().mockResolvedValue('# Alpha body\n\ncontent here'),
}));

// MarkdownRenderer drags in KaTeX/Mermaid — stub it to the raw content.
vi.mock('../../editor/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="rendered-md">{content}</div>,
}));

// ── App context ─────────────────────────────────────────────────────
const { setCurrentFile, setView, showToast } = vi.hoisted(() => ({
  setCurrentFile: vi.fn(),
  setView: vi.fn(),
  showToast: vi.fn(),
}));
vi.mock('../../../contexts/AppContext', () => ({
  useApp: () => ({
    state: {
      vaultPath: '/vault', lang: 'en', methodology: 'zettelkasten',
      llmConfig: { apiUrl: 'https://x/v1', apiKey: '', model: 'm', providerId: 'custom' },
    },
    setCurrentFile, setView, showToast,
  }),
}));

import { Bases } from '../Bases';
import {
  getNotesOverview, listSavedViews, saveView, runBatchAgent,
  addCardsToReview, undoAgentRun, chatWithLlm,
} from '../../../lib/tauri';

function noteRow(over: Partial<NoteRow> = {}): NoteRow {
  return {
    path: 'notes/a.md', title: 'Alpha', folder: 'notes', noteType: 'permanent', tags: ['ai'],
    outboundLinks: 2, backlinkCount: 1, semanticDegree: 2,
    indexStatus: 'indexed', chunkTotal: 3, chunkEmbedded: 3,
    reconciledAt: '2026-01-01 00:00:00', hasContradictions: false, contradictionCount: 0,
    reviewState: 'review', reviewDueAtMs: null, reviewIsDue: false,
    reviewSuspended: false, reviewLapses: 0, pagerank: null, isHub: null,
    createdAt: '2026-01-01 00:00:00', lastSynced: '2026-02-01 00:00:00',
    ...over,
  };
}

function overview(over: Partial<NotesOverview> = {}): NotesOverview {
  const rows = over.rows ?? [
    noteRow({ path: 'notes/a.md', title: 'Alpha' }),
    noteRow({ path: 'notes/b.md', title: 'Bravo', backlinkCount: 0, outboundLinks: 0 }),
    noteRow({ path: 'ideas/c.md', title: 'Charlie', folder: 'ideas', reconciledAt: null, indexStatus: 'notIndexed' }),
    noteRow({ path: 'ideas/d.md', title: 'Delta', folder: 'ideas', reviewIsDue: true, hasContradictions: true, contradictionCount: 2 }),
  ];
  return {
    rows,
    folders: ['notes', 'ideas'],
    allTags: ['ai'],
    allTypes: ['permanent'],
    semanticIndexReady: true,
    graphSignalsIncluded: false,
    total: rows.length,
    truncated: false,
    ...over,
  };
}

/** Mount and wait for the first `get_notes_overview` to land. */
async function mount(data: NotesOverview = overview()) {
  vi.mocked(getNotesOverview).mockResolvedValue(data);
  const utils = render(<Bases />);
  await waitFor(() => expect(utils.queryByTestId('overview-loading')).not.toBeInTheDocument());
  return utils;
}

function titles(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-testid="note-row"] .overview-title-text')]
    .map(el => el.textContent ?? '');
}

/**
 * Grouping, columns, saved-view creation and the graph recompute all live behind
 * the single "view settings" disclosure now — occasional controls no longer sit
 * permanently in the toolbar.
 */
function openSettings(getByTestId: (id: string) => HTMLElement) {
  fireEvent.click(getByTestId('view-settings'));
}


describe('Notes Overview — data contract', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    vi.mocked(listSavedViews).mockResolvedValue([]);
    localStorage.clear();
  });

  it('loads WITHOUT graph signals — PageRank is opt-in', async () => {
    await mount();
    expect(getNotesOverview).toHaveBeenCalledWith('/vault', false);
    expect(getNotesOverview).not.toHaveBeenCalledWith('/vault', true);
  });

  it('recomputes with graph signals only when the user asks', async () => {
    const { getByTestId } = await mount();
    vi.mocked(getNotesOverview).mockResolvedValue(overview({ graphSignalsIncluded: true }));
    openSettings(getByTestId);
    fireEvent.click(getByTestId('compute-graph'));
    await waitFor(() => expect(getNotesOverview).toHaveBeenCalledWith('/vault', true));
  });

  it('spells out what the graph recompute costs before you press it', async () => {
    // A whole-graph PageRank pass is seconds on a big vault; the button used to
    // say nothing about that.
    const { getByTestId } = await mount();
    openSettings(getByTestId);
    expect(getByTestId('view-settings-menu').textContent).toContain('PageRank');
  });


  it('has no confidence column anywhere in the header', async () => {
    const { container } = await mount();
    const header = container.querySelector('thead')!.textContent!.toLowerCase();
    expect(header).not.toContain('confidence');
    expect(header).not.toContain('置信');
    // The replacement signals are there instead.
    expect(container.querySelector('.overview-th-backlinkCount')).toBeInTheDocument();
    expect(container.querySelector('.overview-th-semanticDegree')).toBeInTheDocument();
    expect(container.querySelector('.overview-th-indexStatus')).toBeInTheDocument();
    expect(container.querySelector('.overview-th-reviewState')).toBeInTheDocument();
  });

  it('warns when the row cap was hit', async () => {
    const { getByTestId } = await mount(overview({ truncated: true, total: 20000 }));
    expect(getByTestId('truncated-banner')).toBeInTheDocument();
  });
});

describe('Notes Overview — health lenses', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    vi.mocked(listSavedViews).mockResolvedValue([]);
  });

  it('shows a hit count per lens', async () => {
    const { getByTestId } = await mount();
    expect(getByTestId('lens-orphan').querySelector('.overview-lens-badge')).toHaveTextContent('1');
    expect(getByTestId('lens-neverReconciled').querySelector('.overview-lens-badge')).toHaveTextContent('1');
    expect(getByTestId('lens-notIndexed').querySelector('.overview-lens-badge')).toHaveTextContent('1');
    expect(getByTestId('lens-dueToday').querySelector('.overview-lens-badge')).toHaveTextContent('1');
  });

  it('filters the table down to the lens hits, and back out again', async () => {
    const { getByTestId, container } = await mount();
    expect(titles(container)).toHaveLength(4);

    fireEvent.click(getByTestId('lens-orphan'));
    expect(titles(container)).toEqual(['Bravo']);

    fireEvent.click(getByTestId('lens-orphan'));
    expect(titles(container)).toHaveLength(4);
  });

  it('combines two lenses as AND, producing an empty state when nothing matches', async () => {
    const { getByTestId, container } = await mount();
    fireEvent.click(getByTestId('lens-orphan'));
    fireEvent.click(getByTestId('lens-dueToday'));
    expect(titles(container)).toHaveLength(0);
    expect(getByTestId('overview-empty-filtered')).toBeInTheDocument();
  });

  it('surfaces the active lens as a removable pill', async () => {
    const { getByTestId, getByLabelText, container } = await mount();
    fireEvent.click(getByTestId('lens-neverReconciled'));
    expect(getByTestId('query-pills')).toBeInTheDocument();
    fireEvent.click(getByLabelText('remove lens:neverReconciled'));
    expect(titles(container)).toHaveLength(4);
  });

  it('disables the semantic lens when the semantic index is cold', async () => {
    const { getByTestId } = await mount(overview({ semanticIndexReady: false }));
    const chip = getByTestId('lens-semanticIsland') as HTMLButtonElement;
    expect(chip).toBeDisabled();
    expect(chip.querySelector('.overview-lens-badge')).toHaveTextContent('—');
  });
});

describe('Notes Overview — peek instead of navigation', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    vi.mocked(listSavedViews).mockResolvedValue([]);
  });

  it('opens the preview pane on row click and does NOT leave the list', async () => {
    const { container, getByTestId, findByTestId } = await mount();
    const firstRow = container.querySelectorAll('[data-testid="note-row"]')[0];
    fireEvent.click(firstRow);

    expect(await findByTestId('peek-panel')).toBeInTheDocument();
    expect(getByTestId('rendered-md')).toHaveTextContent('Alpha body');
    // The whole point: scanning is not interrupted.
    expect(setView).not.toHaveBeenCalled();
    expect(setCurrentFile).not.toHaveBeenCalled();
    // The list is still there behind the pane.
    expect(titles(container)).toHaveLength(4);
  });

  it('escalates to the full note only via the explicit button', async () => {
    const { container, findByTestId } = await mount();
    fireEvent.click(container.querySelectorAll('[data-testid="note-row"]')[0]);
    fireEvent.click(await findByTestId('peek-open-full'));
    expect(setCurrentFile).toHaveBeenCalledWith('notes/a.md');
    expect(setView).toHaveBeenCalledWith('note');
  });

  it('ticking a checkbox selects without opening the preview', async () => {
    const { container, queryByTestId } = await mount();
    const firstCheck = container.querySelectorAll('[data-testid="row-check"]')[0];
    fireEvent.click(firstCheck);
    expect(queryByTestId('peek-panel')).not.toBeInTheDocument();
    expect(queryByTestId('batch-bar')).toBeInTheDocument();
  });
});

describe('Notes Overview — batch selection', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    vi.mocked(listSavedViews).mockResolvedValue([]);
  });

  it('shows the batch bar with a live count and selects all filtered rows', async () => {
    const { container, getByTestId, queryByTestId } = await mount();
    expect(queryByTestId('batch-bar')).not.toBeInTheDocument();

    fireEvent.click(getByTestId('select-all'));
    expect(getByTestId('batch-bar')).toBeInTheDocument();
    expect(getByTestId('batch-bar').textContent).toContain('4');

    fireEvent.click(container.querySelectorAll('[data-testid="row-check"]')[0]);
    expect(getByTestId('batch-bar').textContent).toContain('3');
  });

  it('select-all only ever covers the CURRENT filter, not the whole vault', async () => {
    const { getByTestId } = await mount();
    fireEvent.click(getByTestId('lens-orphan'));
    fireEvent.click(getByTestId('select-all'));
    expect(getByTestId('batch-bar').textContent).toContain('1');
  });

  it('adds the selection to review with no AI in the loop', async () => {
    const { container, getByTestId } = await mount();
    fireEvent.click(container.querySelectorAll('[data-testid="row-check"]')[0]);
    fireEvent.click(container.querySelectorAll('[data-testid="row-check"]')[1]);
    fireEvent.click(getByTestId('batch-review'));
    await waitFor(() => expect(addCardsToReview).toHaveBeenCalledWith(['notes/a.md', 'notes/b.md']));
  });
});

describe('Notes Overview — batch AI', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    vi.mocked(listSavedViews).mockResolvedValue([]);
    vi.mocked(runBatchAgent).mockResolvedValue(mockReport);
  });

  /** Select the first two rows and open the batch dialog. */
  async function openDialog() {
    const utils = await mount();
    fireEvent.click(utils.container.querySelectorAll('[data-testid="row-check"]')[0]);
    fireEvent.click(utils.container.querySelectorAll('[data-testid="row-check"]')[1]);
    fireEvent.click(utils.getByTestId('batch-ai'));
    return utils;
  }

  it('warns up front that every write will be approved one by one', async () => {
    const { getByTestId } = await openDialog();
    expect(getByTestId('batch-approval-warning')).toBeInTheDocument();
  });

  it('refuses to run without an instruction', async () => {
    const { getByTestId } = await openDialog();
    fireEvent.click(getByTestId('batch-run'));
    expect(runBatchAgent).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalled();
  });

  it('calls run_batch_agent with the selection, instruction and llm config', async () => {
    const { getByTestId, container } = await openDialog();
    fireEvent.change(container.querySelector('#batch-instruction')!, { target: { value: '整理这些笔记' } });
    fireEvent.click(getByTestId('batch-run'));

    await waitFor(() => expect(runBatchAgent).toHaveBeenCalledTimes(1));
    expect(runBatchAgent).toHaveBeenCalledWith({
      filePaths: ['notes/a.md', 'notes/b.md'],
      instruction: '整理这些笔记',
      vaultPath: '/vault',
      model: 'm',
      apiUrl: 'https://x/v1',
      apiKey: undefined,
      providerId: 'custom',
      methodology: 'zettelkasten',
      continueOnError: true,
    });
  });

  it('a preset fills the instruction box', async () => {
    const { container } = await openDialog();
    const preset = container.querySelectorAll('.overview-preset-chip')[0];
    fireEvent.click(preset);
    expect((container.querySelector('#batch-instruction') as HTMLTextAreaElement).value).not.toBe('');
  });

  it('drives the progress line from batch_progress events', async () => {
    // Hold the run open so the progress phase is observable.
    let release: (r: BatchAgentReport) => void = () => {};
    vi.mocked(runBatchAgent).mockReturnValue(new Promise<BatchAgentReport>(res => { release = res; }));

    const { getByTestId, container } = await openDialog();
    fireEvent.change(container.querySelector('#batch-instruction')!, { target: { value: 'go' } });
    fireEvent.click(getByTestId('batch-run'));

    await waitFor(() => expect(getByTestId('batch-progress')).toBeInTheDocument());

    act(() => {
      emitEvent('agent-event', {
        type: 'batch_progress', run_id: 'run-xyz', index: 0, total: 2, file_path: 'notes/a.md', status: 'ok',
      });
    });
    expect(getByTestId('batch-progress').textContent).toContain('1/2');
    expect(getByTestId('batch-progress').textContent).toContain('notes/a.md');

    act(() => {
      emitEvent('agent-event', {
        type: 'batch_progress', run_id: 'run-xyz', index: 1, total: 2, file_path: 'notes/b.md', status: 'ok',
      });
    });
    expect(getByTestId('batch-progress').textContent).toContain('2/2');

    await act(async () => { release(mockReport); });
    await waitFor(() => expect(getByTestId('batch-report')).toBeInTheDocument());
  });

  it('ignores progress from a different run', async () => {
    let release: (r: BatchAgentReport) => void = () => {};
    vi.mocked(runBatchAgent).mockReturnValue(new Promise<BatchAgentReport>(res => { release = res; }));

    const { getByTestId, container } = await openDialog();
    fireEvent.change(container.querySelector('#batch-instruction')!, { target: { value: 'go' } });
    fireEvent.click(getByTestId('batch-run'));
    await waitFor(() => expect(getByTestId('batch-progress')).toBeInTheDocument());

    act(() => {
      emitEvent('agent-event', {
        type: 'batch_progress', run_id: 'run-A', index: 0, total: 9, file_path: 'notes/a.md', status: 'ok',
      });
    });
    act(() => {
      emitEvent('agent-event', {
        type: 'batch_progress', run_id: 'run-B', index: 7, total: 9, file_path: 'other.md', status: 'ok',
      });
    });
    expect(getByTestId('batch-progress').textContent).not.toContain('other.md');
    await act(async () => { release(mockReport); });
  });

  it('offers a one-click undo of the whole run', async () => {
    const { getByTestId, container } = await openDialog();
    fireEvent.change(container.querySelector('#batch-instruction')!, { target: { value: 'go' } });
    fireEvent.click(getByTestId('batch-run'));

    await waitFor(() => expect(getByTestId('batch-report')).toBeInTheDocument());
    fireEvent.click(getByTestId('batch-undo'));
    await waitFor(() => expect(undoAgentRun).toHaveBeenCalledWith('run-xyz'));
  });
});

describe('Notes Overview — saved views', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    vi.mocked(listSavedViews).mockResolvedValue([]);
  });

  it('saves the current filter, sort, columns and grouping under a name', async () => {
    const { getByTestId, container } = await mount();
    fireEvent.click(getByTestId('lens-orphan'));
    openSettings(getByTestId);
    fireEvent.change(getByTestId('group-select'), { target: { value: 'folder' } });

    fireEvent.click(getByTestId('save-view'));
    fireEvent.change(container.querySelector('[data-testid="name-view-form"] input')!, {
      target: { value: 'Orphans by folder' },
    });
    fireEvent.click(getByTestId('confirm-save-view'));

    await waitFor(() => expect(saveView).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(saveView).mock.calls[0][0];
    expect(saved.name).toBe('Orphans by folder');
    // The lens lives in the query string, which is what makes it round-trip.
    expect(saved.query).toContain('lens:orphan');
    expect(saved.groupBy).toBe('folder');
    expect(saved.sortField).toBe('lastSynced');
    expect(saved.visibleColumns).toContain('backlinkCount');
  });

  it('re-applies a stored view, lens chip and all', async () => {
    vi.mocked(listSavedViews).mockResolvedValue([{
      id: 'v1', name: 'Never organized', query: 'lens:neverReconciled',
      folder: '', noteType: '', tag: '', sortField: 'title', sortDir: 'asc',
      visibleColumns: ['title', 'noteType', 'backlinkCount'], groupBy: null, createdAtMs: 1,
    }]);
    const { getByTestId, container } = await mount();
    await waitFor(() => expect(getByTestId('view-select').querySelectorAll('option')).toHaveLength(2));

    fireEvent.change(getByTestId('view-select'), { target: { value: 'v1' } });

    expect(titles(container)).toEqual(['Charlie']);
    expect(getByTestId('lens-neverReconciled')).toHaveAttribute('aria-pressed', 'true');
    // Column visibility came from the view too.
    expect(container.querySelector('.overview-th-semanticDegree')).not.toBeInTheDocument();
  });

  it('folds a legacy view\'s folder/type/tag into the query so the filter is visible', async () => {
    // Those three dropdowns are gone — the DSL says the same thing. A view saved
    // before the change must still filter, and must show up as removable pills
    // rather than as state nobody can see.
    vi.mocked(listSavedViews).mockResolvedValue([{
      id: 'v2', name: 'Ideas', query: '', folder: 'ideas', noteType: '', tag: '',
      sortField: 'title', sortDir: 'asc', visibleColumns: [], groupBy: null, createdAtMs: 1,
    }]);
    const { getByTestId, container } = await mount();
    await waitFor(() => expect(getByTestId('view-select').querySelectorAll('option')).toHaveLength(2));

    fireEvent.change(getByTestId('view-select'), { target: { value: 'v2' } });

    expect(titles(container).sort()).toEqual(['Charlie', 'Delta']);
    expect(getByTestId('query-pills').textContent).toContain('ideas');
  });

  it('refuses to save a view with a blank name', async () => {
    const { getByTestId } = await mount();
    openSettings(getByTestId);
    fireEvent.click(getByTestId('save-view'));
    fireEvent.click(getByTestId('confirm-save-view'));
    expect(saveView).not.toHaveBeenCalled();
  });
});


describe('Notes Overview — columns and grouping', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    vi.mocked(listSavedViews).mockResolvedValue([]);
  });

  it('hides a column when the user unticks it, and never offers to hide the title', async () => {
    const { getByTestId, container } = await mount();
    openSettings(getByTestId);
    const menu = getByTestId('columns-menu');
    const boxes = [...menu.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    expect(boxes[0]).toBeDisabled(); // title is locked

    expect(container.querySelector('.overview-th-tags')).toBeInTheDocument();
    fireEvent.click(menu.querySelectorAll('input[type="checkbox"]')[2]); // tags
    expect(container.querySelector('.overview-th-tags')).not.toBeInTheDocument();
  });

  it('keeps graph-only columns out of the menu until signals are computed', async () => {
    const { getByTestId } = await mount();
    openSettings(getByTestId);
    expect(getByTestId('columns-menu').textContent).not.toContain('PageRank');
  });

  it('groups rows under collapsible headers', async () => {
    const { getByTestId, container } = await mount();
    openSettings(getByTestId);
    fireEvent.change(getByTestId('group-select'), { target: { value: 'folder' } });

    const groups = container.querySelectorAll('[data-testid="group-row"]');
    expect(groups).toHaveLength(2);
    expect(titles(container)).toHaveLength(4);

    fireEvent.click(groups[0]);
    expect(titles(container)).toHaveLength(2); // one folder collapsed
  });
});


describe('Notes Overview — one input, DSL and NL', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    vi.mocked(listSavedViews).mockResolvedValue([]);
    vi.mocked(chatWithLlm).mockResolvedValue({ content: 'backlinks=0' } as any);
  });

  it('offers exactly one text input in the toolbar', async () => {
    // Two side-by-side boxes (DSL + prose) left the user guessing which one to
    // type in. There is now one field, and it takes either.
    const { container } = await mount();
    const inputs = container.querySelectorAll('.overview-toolbar input[type="text"]');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toHaveClass('overview-search');
  });

  it('applies a DSL query typed into the search box', async () => {
    const { container } = await mount();
    const box = container.querySelector('.overview-search') as HTMLInputElement;
    fireEvent.change(box, { target: { value: 'folder:ideas' } });
    expect(titles(container).sort()).toEqual(['Charlie', 'Delta']);
  });

  it('reads back which grammar it understood the input as', async () => {
    const { container, getByTestId, queryByTestId } = await mount();
    expect(queryByTestId('search-mode')).not.toBeInTheDocument();

    const box = container.querySelector('.overview-search') as HTMLInputElement;
    fireEvent.change(box, { target: { value: 'folder:ideas' } });
    expect(getByTestId('search-mode').textContent).toBe('筛选语法');

    fireEvent.change(box, { target: { value: 'notes with no backlinks' } });
    expect(getByTestId('search-mode').textContent).toBe('关键词');
  });

  it('translates a natural-language request into DSL pills the user can edit', async () => {
    const { getByTestId, container } = await mount();
    const input = container.querySelector('.overview-search') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'notes with no backlinks' } });
    fireEvent.click(getByTestId('nl-translate'));

    await waitFor(() => expect(chatWithLlm).toHaveBeenCalledTimes(1));
    // The model's answer became the query, shown as a removable pill.
    await waitFor(() => expect(getByTestId('query-pills')).toBeInTheDocument());
    expect(titles(container)).toEqual(['Bravo']);
    // The prose was replaced in place by the DSL it was understood as.
    expect((container.querySelector('.overview-search') as HTMLInputElement).value).toBe('backlinks=0');
  });

  it('falls back gracefully when the model returns an unparseable line', async () => {
    vi.mocked(chatWithLlm).mockResolvedValue({ content: 'sorry I cannot help' } as any);
    const { getByTestId, container, queryByTestId } = await mount();
    fireEvent.change(container.querySelector('.overview-search')!, { target: { value: 'gibberish' } });
    fireEvent.click(getByTestId('nl-translate'));
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    // No rules, so no pills appear and the keyword fallback is all that filtered.
    expect(queryByTestId('query-pills')).not.toBeInTheDocument();
  });

  it('cannot ask the AI about an empty box', async () => {
    const { getByTestId } = await mount();
    expect(getByTestId('nl-translate')).toBeDisabled();
  });
});


describe('Notes Overview — virtual scrolling', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    vi.mocked(listSavedViews).mockResolvedValue([]);
  });

  it('renders only a windowed slice of a few-thousand-row vault', async () => {
    const rows = Array.from({ length: 3000 }, (_, i) =>
      noteRow({ path: `notes/n${i}.md`, title: `Note ${i}` }));
    const { container, getByTestId } = await mount(overview({ rows, total: 3000 }));

    const rendered = container.querySelectorAll('[data-testid="note-row"]').length;
    // Bounded by the fallback viewport, nowhere near the full 3000.
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(120);

    // A spacer stands in for the un-rendered rows so the scrollbar is honest.
    const bottom = getByTestId('spacer-bottom') as HTMLElement;
    expect(bottom).toBeInTheDocument();
    expect(bottom.offsetHeight >= 0 || bottom.style.height !== '').toBe(true);
  });

  it('advances the window as the container scrolls', async () => {
    const rows = Array.from({ length: 3000 }, (_, i) =>
      noteRow({ path: `notes/n${i}.md`, title: `Note ${i}` }));
    const { getByTestId, container } = await mount(overview({ rows, total: 3000 }));

    const first = () => (container.querySelector('[data-testid="note-row"]') as HTMLElement)?.dataset.index;
    expect(Number(first())).toBe(0);

    const scroller = getByTestId('overview-scroll');
    act(() => {
      scroller.scrollTop = 4000;
      fireEvent.scroll(scroller);
    });
    expect(Number(first())).toBeGreaterThan(0);
  });
});

describe('Notes Overview — the table can actually scroll sideways', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    vi.mocked(listSavedViews).mockResolvedValue([]);
  });

  it('gives the table a min-width wider than a narrow pane, so overflow exists', async () => {
    // The old `width: 100%` + `table-layout: fixed` pair could never overflow,
    // so `overflow: auto` had nothing to scroll and Shift+wheel did nothing.
    const { getByTestId } = await mount();
    const table = getByTestId('overview-table') as HTMLTableElement;
    const min = parseInt(table.style.minWidth, 10);

    expect(min).toBe(tableMinWidth(defaultVisibleColumns()));
    // Wider than the content pane you get with the peek panel open on a laptop.
    expect(min).toBeGreaterThan(1000);
  });

  it('recomputes that min-width when the user toggles a column', async () => {
    const { getByTestId } = await mount();
    const table = () => getByTestId('overview-table') as HTMLTableElement;
    const before = parseInt(table().style.minWidth, 10);

    openSettings(getByTestId);
    fireEvent.click(getByTestId('columns-menu').querySelectorAll('input[type="checkbox"]')[2]); // tags

    const after = parseInt(table().style.minWidth, 10);
    expect(after).toBe(before - getColumn('tags')!.width);
    expect(after).toBeLessThan(before);
  });

  it('declares every column width once, in a colgroup, with title left elastic', async () => {
    const { container } = await mount();
    const cols = [...container.querySelectorAll('colgroup col')] as HTMLTableColElement[];
    // checkbox column + one per visible column
    expect(cols).toHaveLength(defaultVisibleColumns().length + 1);
    // `title` absorbs the slack past the min-width, so it declares no width.
    expect(container.querySelector('[data-testid="col-title"]')!.getAttribute('style')).toBeNull();
    // Everything else is pinned in px — mixing % with px is what made
    // `table-layout: fixed` squeeze the columns instead of overflowing.
    for (const col of cols) {
      const w = col.style.width;
      if (w) expect(w.endsWith('px')).toBe(true);
    }
  });

  it('exposes the scroller as a focusable, labelled region', async () => {
    const { getByTestId } = await mount();
    const scroller = getByTestId('overview-scroll');
    expect(scroller).toHaveAttribute('role', 'region');
    expect(scroller).toHaveAttribute('tabindex', '0');
    expect(scroller.getAttribute('aria-label')).toBeTruthy();
  });
});

describe('Notes Overview — cells that used to lie', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    vi.mocked(listSavedViews).mockResolvedValue([]);
  });

  it('puts nothing but the checkbox in the checkbox cell', async () => {
    // A `…` was appearing in front of every title: the shared `.overview-td`
    // ellipsis applied to a 34px cell that could not hold box + padding. The
    // cell must carry no text of its own for the CSS fix to be sufficient.
    const { container } = await mount();
    const cells = [...container.querySelectorAll('.overview-td-check')];
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.textContent).toBe('');
      expect(cell.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    }
    expect(container.querySelector('.overview-th-check')!.textContent).toBe('');
  });

  it('never renders half a tag — overflow goes into +N, complete tags stay whole', async () => {
    const tags = ['transformer', 'embedding', 'knowledge-management'];
    const { container } = await mount(overview({
      rows: [noteRow({ path: 'notes/a.md', title: 'Alpha', tags })],
    }));

    const cell = container.querySelector('.overview-td-tags')!;
    const shown = [...cell.querySelectorAll('.overview-tag:not(.overview-tag-more)')]
      .map(el => el.textContent ?? '');

    // Every visible pill is a whole tag, not a prefix of one.
    for (const text of shown) expect(tags).toContain(text);
    expect(shown.some(text => text.endsWith('…'))).toBe(false);

    // And the rest are accounted for rather than dropped.
    const more = cell.querySelector('[data-testid="tag-more"]');
    const hidden = more ? Number(more.textContent!.replace('+', '')) : 0;
    expect(shown.length + hidden).toBe(tags.length);
    expect(hidden).toBeGreaterThan(0); // three long tags cannot fit 220px
    expect(more!.getAttribute('title')).toContain('knowledge-management');
  });

  it('leaves the review column blank instead of shouting "not added" on every row', async () => {
    const { container } = await mount(overview({
      rows: [
        noteRow({ path: 'a.md', title: 'A', reviewState: null }),
        noteRow({ path: 'b.md', title: 'B', reviewIsDue: true }),
      ],
    }));
    const cells = [...container.querySelectorAll('.overview-td-reviewState')];
    expect(cells[0].textContent).toBe('—');
    // The state that needs action keeps its full weight.
    expect(cells[1].querySelector('[data-testid="review-due"]')).toBeInTheDocument();
  });

  it('says "indexed" with a dot only, and spells out every unhealthy state', async () => {
    const { container } = await mount(overview({
      rows: [
        noteRow({ path: 'a.md', title: 'A', indexStatus: 'indexed' }),
        noteRow({ path: 'b.md', title: 'B', indexStatus: 'notIndexed' }),
      ],
    }));
    const cells = [...container.querySelectorAll('.overview-td-indexStatus')];
    expect(cells[0].textContent).toBe('');
    expect(cells[0].querySelector('.overview-index')!.getAttribute('aria-label')).toBe('已索引');
    // Colour is never the only carrier for a problem.
    expect(cells[1].textContent).toContain('未索引');
  });

  it('shortens the three link-count headers but keeps the full name reachable', async () => {
    const { container } = await mount();
    const th = container.querySelector('.overview-th-backlinkCount')!;
    expect(th.querySelector('.overview-th-label')!.textContent).toBe('入');
    expect(th.getAttribute('title')).toBe('入链');
  });
});

/**
 * Two of the three bugs were pure CSS, invisible to a DOM assertion: jsdom does
 * not lay out or apply the stylesheet. These read the stylesheet as the contract
 * it is, so a regression to the old rules fails here rather than in a screenshot.
 */
describe('Notes Overview — stylesheet contract', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles/bases.css'), 'utf-8')
    // Comments would otherwise get swept into the selector of the rule below them.
    .replace(/\/\*[\s\S]*?\*\//g, '');



  /** The declarations of the first rule whose selector list contains `selector`. */
  function block(selector: string): string {
    for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (rule[1].split(',').map(s => s.trim()).includes(selector)) return rule[2];
    }
    return '';
  }


  it('keeps the scroll container scrollable on both axes', () => {
    expect(block('.overview-table-wrap')).toContain('overflow: auto');
  });

  it('declares no column width in CSS — COLUMN_DEFS is the only source', () => {
    // A `%` width mixed with px widths under `table-layout: fixed` is what made
    // every column shrink to fit instead of the table overflowing.
    const columnRules = css.match(/\.overview-(th|td)-[A-Za-z]+[^{]*\{[^}]*\}/g) ?? [];
    expect(columnRules.length).toBeGreaterThan(0);
    for (const rule of columnRules) expect(rule).not.toMatch(/[^-]width:/);
  });

  it('turns the ellipsis off for the checkbox cell', () => {
    expect(block('.overview-td-check')).toContain('text-overflow: clip');
  });

  it('does not clip the tags cell — fitTags decides what fits', () => {
    expect(block('.overview-tags')).not.toContain('overflow: hidden');
  });

  it('still honours prefers-reduced-motion', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('.overview-spinner { animation: none; }');
  });
});







