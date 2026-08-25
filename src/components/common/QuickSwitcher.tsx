import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useApp } from '../../contexts/AppContext';
import { listMarkdownFiles } from '../../lib/tauri';
import { t, tf } from '../../lib/i18n';
import type { TranslationKey } from '../../lib/i18n';
import type { View } from '../../contexts/BaseContext';
import type { KnowledgePage } from '../knowledge/KnowledgeCenter';
import { IconFile } from '../icons';

/**
 * 跳转面板 / one modal, two modes.
 *
 * `Ctrl+P` 找笔记，`Ctrl+Shift+P` 执行命令，在命令模式下输入的第一个字符是 `>` 也会
 * 切过去（和多数编辑器一致）。
 *
 * **为什么是同一个组件**：这两件事在交互上是同一件事——打一段字、上下选、回车执行。
 * 分成两个弹窗就要把遮罩、键盘导航、滚动跟随、焦点管理各写两遍，然后其中一份会慢慢
 * 长歪。数据源不同，壳子相同。
 *
 * 命令表里**只放导航和显示切换**。写入类动作（推进索引、扫描待办、修断链）留在它们
 * 各自的页面上：那些地方能显示进度、能报失败、能解释后果，而一个搜索框里的一行不能。
 */

export type PaletteMode = 'notes' | 'commands';

export interface PaletteCommand {
  id: string;
  label: string;
  /** 参与匹配的额外词，中英文都放，这样两种输入法下都搜得到。 */
  keywords: string;
  run: () => void;
}

/**
 * 知识中心页面切换用事件传 / the palette asks, the page decides.
 *
 * 当前页面是 `KnowledgeCenter` 的本地状态。为了一个命令面板把它提到全局 store，会让
 * 两处都要维护同一份状态。项目里已有 `zettel:open-search-panel` / `zettel:new-note`
 * 这套做法，沿用它。
 */
export const KNOWLEDGE_PAGE_EVENT = 'zettel:knowledge-page';

const KNOWLEDGE_PAGES: KnowledgePage[] = [
  'inbox',
  'memory',
  'changes',
  'tasks',
  'health',
  'activity',
];

const VIEWS: { view: View; keywords: string }[] = [
  { view: 'note', keywords: 'editor note 编辑 笔记' },
  { view: 'dashboard', keywords: 'dashboard overview 仪表盘 概览' },
  { view: 'graph', keywords: 'graph links 关系图 图谱' },
  { view: 'canvas', keywords: 'canvas board 画布' },
  { view: 'bases', keywords: 'bases table database 数据库 表格' },
  { view: 'calendar', keywords: 'calendar dates 日历 日程' },
  { view: 'review', keywords: 'review spaced repetition 复习 回顾' },
  { view: 'settings', keywords: 'settings preferences 设置 偏好' },
];

/**
 * 命令表 / the commands, built from what the app can already do.
 *
 * 单独导出是为了能不渲染就测：命令表长歪（少了一页、跳错视图）比样式问题更难发现。
 */
export function buildCommands(actions: {
  setView: (view: View) => void;
  openKnowledgePage: (page: KnowledgePage) => void;
  toggleChat: () => void;
  toggleSidebar: () => void;
  findNote: () => void;
  setAppLang?: (lang: 'zh' | 'en') => void;
}): PaletteCommand[] {
  const commands: PaletteCommand[] = [];

  for (const page of KNOWLEDGE_PAGES) {
    commands.push({
      id: `knowledge:${page}`,
      label: tf('palette.cmd.knowledgePage', t(`knowledge.tab.${page}` as TranslationKey)),
      keywords: `knowledge ${page} 知识`,
      run: () => actions.openKnowledgePage(page),
    });
  }

  for (const item of VIEWS) {
    commands.push({
      id: `view:${item.view}`,
      label: t(`palette.cmd.view.${item.view}` as TranslationKey),
      keywords: item.keywords,
      run: () => actions.setView(item.view),
    });
  }

  commands.push(
    {
      id: 'toggle:chat',
      label: t('palette.cmd.toggleChat'),
      keywords: 'agent chat panel 助手 对话',
      run: actions.toggleChat,
    },
    {
      id: 'toggle:sidebar',
      label: t('palette.cmd.toggleSidebar'),
      keywords: 'sidebar files 侧边栏 文件',
      run: actions.toggleSidebar,
    },
    {
      id: 'search:content',
      label: t('palette.cmd.searchContent'),
      keywords: 'search find text 搜索 全文',
      run: () => window.dispatchEvent(new CustomEvent('zettel:open-search-panel')),
    },
    {
      id: 'note:new',
      label: t('palette.cmd.newNote'),
      keywords: 'new note create 新建 笔记',
      run: () => window.dispatchEvent(new CustomEvent('zettel:new-note')),
    },
    {
      id: 'note:find',
      label: t('palette.cmd.findNote'),
      keywords: 'open file name 打开 文件 名字',
      run: actions.findNote,
    },
  );

  if (actions.setAppLang) {
    commands.push(
      {
        id: 'lang:zh',
        label: '界面语言：简体中文 (Switch to Chinese)',
        keywords: 'language lang 语言 中文 简体 chinese',
        run: () => actions.setAppLang!('zh'),
      },
      {
        id: 'lang:en',
        label: 'Interface Language: English (切换为英文)',
        keywords: 'language lang 语言 英文 english',
        run: () => actions.setAppLang!('en'),
      },
    );
  }

  return commands;
}

/**
 * 打分 / how well one candidate matches.
 *
 * 开头命中 > 包含 > 顺序模糊命中。0 表示不匹配。
 */
export function scoreMatch(text: string, query: string): number {
  const haystack = text.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 1;
  if (haystack.startsWith(q)) return 3;
  if (haystack.includes(q)) return 2;
  let qi = 0;
  for (const c of haystack) {
    if (qi < q.length && c === q[qi]) qi++;
  }
  return qi === q.length ? 1 : 0;
}

interface PaletteItem {
  key: string;
  primary: string;
  secondary?: string;
  isNote: boolean;
  select: () => void;
}

/** 选项的 DOM id。`aria-activedescendant` 只能指 id，所以它必须是稳定可算的。 */
function optionId(index: number): string {
  return `quick-switcher-option-${index}`;
}

export function QuickSwitcher() {
  const { state, setCurrentFile, setView, toggleChat, toggleSidebar, setAppLang } = useApp();
  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<PaletteMode>('notes');
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!state.vaultPath) return;
    listMarkdownFiles(state.vaultPath).then(setFiles).catch(console.error);
  }, [state.vaultPath]);

  const open = useCallback((next: PaletteMode) => {
    setMode(next);
    setQuery('');
    setSelectedIndex(0);
    setIsOpen(true);
  }, []);

  // Ctrl+P 找笔记，Ctrl+Shift+P 执行命令。已经开着时同一个键关掉它。
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        const next: PaletteMode = e.shiftKey ? 'commands' : 'notes';
        if (isOpen && mode === next) setIsOpen(false);
        else open(next);
      }
      if (e.key === 'Escape' && isOpen) setIsOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, mode, open]);

  useEffect(() => {
    if (isOpen) setTimeout(() => inputRef.current?.focus(), 50);
  }, [isOpen]);

  const commands = useMemo(
    () =>
      buildCommands({
        setView,
        openKnowledgePage: page => {
          setView('knowledge');
          window.dispatchEvent(new CustomEvent(KNOWLEDGE_PAGE_EVENT, { detail: page }));
        },
        toggleChat,
        toggleSidebar,
        findNote: () => open('notes'),
        setAppLang,
      }),
    [setView, toggleChat, toggleSidebar, open, setAppLang],
  );

  const fileName = (path: string) =>
    path.replace(/\\/g, '/').split('/').pop()?.replace('.md', '') || path;

  const relDir = (path: string) => {
    if (!state.vaultPath) return '';
    const rel = path
      .replace(/\\/g, '/')
      .replace(state.vaultPath.replace(/\\/g, '/'), '')
      .replace(/^\//, '');
    const parts = rel.split('/');
    return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
  };

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim();
    if (mode === 'commands') {
      return commands
        .map(cmd => ({
          cmd,
          score: Math.max(scoreMatch(cmd.label, q), scoreMatch(cmd.keywords, q)),
        }))
        .filter(m => m.score > 0)
        .sort((a, b) => b.score - a.score)
        .map(m => ({
          key: m.cmd.id,
          primary: m.cmd.label,
          isNote: false,
          select: () => {
            setIsOpen(false);
            m.cmd.run();
          },
        }));
    }
    return files
      .map(file => ({ file, name: fileName(file), score: scoreMatch(fileName(file), q) }))
      .filter(m => m.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, 20)
      .map(m => ({
        key: m.file,
        primary: m.name,
        secondary: relDir(m.file) || undefined,
        isNote: true,
        select: () => {
          setIsOpen(false);
          setCurrentFile(m.file);
          setView('note');
        },
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fileName/relDir are pure helpers
  }, [mode, query, files, commands, state.vaultPath, setCurrentFile, setView]);

  // 选中项滚进视野：列表比可视区长的时候，键盘导航到看不见的行等于没有导航。
  useEffect(() => {
    const container = listRef.current;
    if (!container || items.length === 0) return;
    const item = container.children[selectedIndex] as HTMLElement | undefined;
    if (!item) return;
    if (item.offsetTop < container.scrollTop) {
      container.scrollTop = item.offsetTop;
    } else if (item.offsetTop + item.clientHeight > container.scrollTop + container.clientHeight) {
      container.scrollTop = item.offsetTop + item.clientHeight - container.clientHeight;
    }
  }, [selectedIndex, items.length]);

  const onQueryChange = (value: string) => {
    // 命令模式的老习惯：`>` 开头就是命令。切过去时把这个字符吃掉。
    if (mode === 'notes' && value.startsWith('>')) {
      setMode('commands');
      setQuery(value.slice(1));
    } else {
      setQuery(value);
    }
    setSelectedIndex(0);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => Math.min(prev + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      items[selectedIndex]?.select();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setIsOpen(false);
    }
  };

  if (!isOpen) return null;

  const isCommands = mode === 'commands';

  return (
    <div className="quick-switcher-overlay" onClick={() => setIsOpen(false)}>
      <div
        className="quick-switcher-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t(isCommands ? 'palette.modeCommands' : 'palette.modeNotes')}
        onClick={e => e.stopPropagation()}
      >
        <div className="quick-switcher-field">
          <span className="quick-switcher-mode">
            {t(isCommands ? 'palette.modeCommands' : 'palette.modeNotes')}
          </span>
          {/*
            输入框保持焦点、用 `aria-activedescendant` 指向当前那一行，这是 combobox
            的标准做法。少了它，读屏用户按上下键不会听到任何变化——`aria-selected`
            只在焦点真的落在选项上时才会被读出来。
          */}
          <input
            ref={inputRef}
            className="quick-switcher-input"
            type="text"
            role="combobox"
            aria-expanded
            aria-controls="quick-switcher-list"
            aria-activedescendant={items[selectedIndex] ? optionId(selectedIndex) : undefined}
            aria-label={t(isCommands ? 'palette.commandsPlaceholder' : 'palette.notesPlaceholder')}
            placeholder={t(
              isCommands ? 'palette.commandsPlaceholder' : 'palette.notesPlaceholder',
            )}
            value={query}
            onChange={e => onQueryChange(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>

        <div
          ref={listRef}
          id="quick-switcher-list"
          className="quick-switcher-list"
          role="listbox"
          aria-label={t(isCommands ? 'palette.modeCommands' : 'palette.modeNotes')}
        >
          {items.length === 0 ? (
            <div className="quick-switcher-empty">
              {t(isCommands ? 'palette.noCommands' : 'palette.noNotes')}
            </div>
          ) : (
            items.map((item, i) => (
              <button
                key={item.key}
                id={optionId(i)}
                role="option"
                tabIndex={-1}
                aria-selected={i === selectedIndex}
                className={`quick-switcher-item ${i === selectedIndex ? 'selected' : ''}`}
                onClick={item.select}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                {item.isNote && <IconFile size={14} />}
                <span className="quick-switcher-item-name">{item.primary}</span>
                {item.secondary && (
                  <span className="quick-switcher-item-path">{item.secondary}</span>
                )}
              </button>
            ))
          )}
        </div>

        <div className="quick-switcher-hint">
          <span>
            <kbd>↑↓</kbd> {t('palette.hintNavigate')}
          </span>
          <span>
            <kbd>↵</kbd> {t(isCommands ? 'palette.hintRun' : 'palette.hintOpen')}
          </span>
          <span>
            <kbd>esc</kbd> {t('palette.hintClose')}
          </span>
          {!isCommands && <span>{t('palette.hintCommands')}</span>}
        </div>
      </div>
    </div>
  );
}
