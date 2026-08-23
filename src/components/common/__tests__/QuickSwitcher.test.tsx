import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom';

import {
  KNOWLEDGE_PAGE_EVENT,
  QuickSwitcher,
  buildCommands,
  scoreMatch,
} from '../QuickSwitcher';
import { listMarkdownFiles } from '../../../lib/tauri';
import { setLang } from '../../../lib/i18n';
import { en } from '../../../lib/i18n/en';
import { zh } from '../../../lib/i18n/zh';

const setView = vi.fn();
const setCurrentFile = vi.fn();
const toggleChat = vi.fn();
const toggleSidebar = vi.fn();

vi.mock('../../../contexts/AppContext', () => ({
  useApp: () => ({
    state: { vaultPath: 'D:/vault', lang: 'en' },
    setView,
    setCurrentFile,
    toggleChat,
    toggleSidebar,
  }),
}));

vi.mock('../../../lib/tauri', () => ({
  listMarkdownFiles: vi.fn(),
}));

vi.mock('../../icons', () => ({
  IconFile: () => null,
}));

beforeEach(() => {
  vi.clearAllMocks();
  setLang('en');
  vi.mocked(listMarkdownFiles).mockResolvedValue([
    'D:/vault/notes/Retro 2024.md',
    'D:/vault/Inbox.md',
  ]);
});

function openPalette(withShift: boolean) {
  fireEvent.keyDown(window, { key: 'p', ctrlKey: true, shiftKey: withShift });
}

describe('scoreMatch', () => {
  it('prefers a prefix over a substring over a fuzzy hit', () => {
    expect(scoreMatch('Retro 2024', 'ret')).toBe(3);
    expect(scoreMatch('The Retro', 'ret')).toBe(2);
    expect(scoreMatch('Recent tasks', 'ret')).toBe(1);
    expect(scoreMatch('Nothing', 'zzz')).toBe(0);
  });

  it('matches everything on an empty query, so an unfiltered list still shows', () => {
    expect(scoreMatch('anything', '')).toBe(1);
  });
});

describe('buildCommands', () => {
  it('covers every Knowledge Center page, so no surface is unreachable', () => {
    const openKnowledgePage = vi.fn();
    const commands = buildCommands({
      setView,
      openKnowledgePage,
      toggleChat,
      toggleSidebar,
      findNote: vi.fn(),
    });
    const pages = commands.filter(c => c.id.startsWith('knowledge:')).map(c => c.id);
    expect(pages).toEqual([
      'knowledge:inbox',
      'knowledge:memory',
      'knowledge:changes',
      'knowledge:tasks',
      'knowledge:health',
      'knowledge:activity',
    ]);
  });

  it('labels commands in words, never with a view id', () => {
    const commands = buildCommands({
      setView,
      openKnowledgePage: vi.fn(),
      toggleChat,
      toggleSidebar,
      findNote: vi.fn(),
    });
    for (const command of commands) {
      expect(command.label).not.toMatch(/^(note|dashboard|graph|canvas|bases|calendar|review|settings)$/);
      expect(command.label).not.toContain('palette.');
    }
    expect(commands.find(c => c.id === 'view:settings')?.label).toBe('Open settings');
  });

  it('offers no write action — those live on the page that can show progress', () => {
    const commands = buildCommands({
      setView,
      openKnowledgePage: vi.fn(),
      toggleChat,
      toggleSidebar,
      findNote: vi.fn(),
    });
    const ids = commands.map(c => c.id);
    expect(ids.some(id => /backfill|index|scan|fix|undo|approve/i.test(id))).toBe(false);
  });
});

describe('QuickSwitcher', () => {
  it('opens on notes with Ctrl+P and on commands with Ctrl+Shift+P', async () => {
    render(<QuickSwitcher />);

    openPalette(false);
    expect(await screen.findByLabelText('Type to search notes…')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    openPalette(true);
    expect(await screen.findByLabelText('Type a command…')).toBeInTheDocument();
  });

  it('switches to commands when the query starts with >, and eats the character', async () => {
    render(<QuickSwitcher />);
    openPalette(false);

    const input = await screen.findByLabelText('Type to search notes…');
    fireEvent.change(input, { target: { value: '>' } });

    const commandInput = await screen.findByLabelText('Type a command…');
    expect(commandInput).toHaveValue('');
  });

  it('runs a command and closes, rather than leaving the modal open', async () => {
    render(<QuickSwitcher />);
    openPalette(true);

    fireEvent.click(await screen.findByText('Open settings'));
    expect(setView).toHaveBeenCalledWith('settings');
    expect(screen.queryByLabelText('Type a command…')).toBeNull();
  });

  it('asks the Knowledge Center for a page instead of guessing its state', async () => {
    const seen: unknown[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(KNOWLEDGE_PAGE_EVENT, listener);

    render(<QuickSwitcher />);
    openPalette(true);
    fireEvent.click(await screen.findByText('Knowledge: Changes'));

    expect(setView).toHaveBeenCalledWith('knowledge');
    expect(seen).toEqual(['changes']);
    window.removeEventListener(KNOWLEDGE_PAGE_EVENT, listener);
  });

  it('opens a note by name in the notes mode', async () => {
    render(<QuickSwitcher />);
    openPalette(false);

    const input = await screen.findByLabelText('Type to search notes…');
    fireEvent.change(input, { target: { value: 'retro' } });

    fireEvent.click(await screen.findByText('Retro 2024'));
    await waitFor(() => expect(setCurrentFile).toHaveBeenCalledWith('D:/vault/notes/Retro 2024.md'));
    expect(setView).toHaveBeenCalledWith('note');
  });

  it('says nothing matched instead of showing an empty box', async () => {
    render(<QuickSwitcher />);
    openPalette(true);

    fireEvent.change(await screen.findByLabelText('Type a command…'), {
      target: { value: 'zzzzz' },
    });
    expect(await screen.findByText('No matching command')).toBeInTheDocument();
  });

  /**
   * 键盘选中要能被读出来。
   *
   * 焦点一直在输入框里，所以选项上的 `aria-selected` 本身不会被朗读；必须由
   * `aria-activedescendant` 指过去。少了这一条，读屏用户按上下键听不到任何变化。
   */
  it('points aria-activedescendant at the row Enter would run', async () => {
    render(<QuickSwitcher />);
    openPalette(true);

    const input = await screen.findByLabelText('Type a command…');
    const first = (await screen.findAllByRole('option'))[0];
    expect(input).toHaveAttribute('aria-activedescendant', first.id);

    fireEvent.keyDown(input, { key: 'ArrowDown' });

    const second = (await screen.findAllByRole('option'))[1];
    await waitFor(() =>
      expect(input).toHaveAttribute('aria-activedescendant', second.id),
    );
    expect(second).toHaveAttribute('aria-selected', 'true');
  });
});


describe('copy', () => {
  it('has both languages for every palette string', () => {
    const keys = Object.keys(en).filter(k => k.startsWith('palette.'));
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) {
      expect(zh[key as keyof typeof zh], `zh is missing ${key}`).toBeTruthy();
    }
  });
});

