import { t, getLang } from '../../lib/i18n';

interface ShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ShortcutItem {
  keys: string[];
  label: string;
}

interface ShortcutGroup {
  title: string;
  items: ShortcutItem[];
}

export function ShortcutsModal({ isOpen, onClose }: ShortcutsModalProps) {
  if (!isOpen) return null;
  const isZh = getLang() === 'zh';

  const groups: ShortcutGroup[] = [
    {
      title: t('shortcuts.navigation'),
      items: [
        { keys: ['Ctrl', '1'], label: t('shortcuts.dashboard') },
        { keys: ['Ctrl', '2'], label: isZh ? '笔记' : 'Note' },
        { keys: ['Ctrl', '3'], label: t('shortcuts.graph') },
        { keys: ['Ctrl', '4'], label: t('shortcuts.canvas') },
        { keys: ['Ctrl', '5'], label: t('shortcuts.bases') },
        { keys: ['Ctrl', '6'], label: t('shortcuts.calendar') },
        { keys: ['Ctrl', '7'], label: isZh ? '设置' : 'Settings' },
        { keys: ['Ctrl', ','], label: isZh ? '打开设置' : 'Open Settings' },
        { keys: ['Ctrl', 'P'], label: t('shortcuts.quickSwitcher') },
        { keys: ['Ctrl', 'Shift', 'F'], label: isZh ? '全文内容检索' : 'Global Search' },
      ],
    },
    {
      title: t('shortcuts.editing'),
      items: [
        { keys: ['Ctrl', 'N'], label: t('shortcuts.newNote') },
        { keys: ['Ctrl', 'S'], label: t('shortcuts.saveNote') },
        { keys: ['Ctrl', 'D'], label: isZh ? '打开每日工作笔记' : 'Open Daily Note' },
        { keys: ['Ctrl', 'J'], label: t('shortcuts.timeline') },
        { keys: ['Ctrl', 'V'], label: isZh ? '智能粘贴' : 'Smart Paste' },
      ],
    },
    {
      title: t('shortcuts.tools'),
      items: [
        { keys: ['Ctrl', 'L'], label: t('shortcuts.toggleChat') },
        { keys: ['Ctrl', 'K'], label: isZh ? 'AI 建议面板' : 'AI Agent Panel' },
        { keys: ['Ctrl', 'B'], label: isZh ? '切换侧边栏' : 'Toggle Sidebar' },
        { keys: ['Ctrl', '/'], label: t('shortcuts.showShortcuts') },
      ],
    },
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-container shortcuts-modal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '520px' }}
      >
        <div className="modal-header">
          <h2 className="shortcuts-guide-title" style={{ margin: 0 }}>
            {t('shortcuts.title')}
          </h2>
          <button
            onClick={onClose}
            className="btn btn-sm"
            style={{ padding: '4px 8px', lineHeight: 1 }}
          >
            Esc
          </button>
        </div>

        <div className="modal-content shortcuts-guide-groups">
          {groups.map((group) => (
            <div key={group.title}>
              <div className="shortcuts-category-title">{group.title}</div>
              <div className="shortcuts-list">
                {group.items.map((item) => (
                  <div key={item.keys.join('+')} className="shortcut-row">
                    <span className="shortcut-desc">{item.label}</span>
                    <div className="shortcut-keys">
                      {item.keys.map((key) => (
                        <kbd key={key} className="shortcut-kbd">
                          {key}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
