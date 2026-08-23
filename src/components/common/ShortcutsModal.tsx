import { t } from '../../lib/i18n';

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

/**
 * 快捷键一览 / the shortcut sheet.
 *
 * 文案一律走字典。这里曾经有八行 `isZh ? … : …`，其中五行的字典键已经存在
 * （`shortcuts.settings` / `shortcuts.dailyNote` / `shortcuts.smartPaste` /
 * `shortcuts.toggleAgent` / `shortcuts.toggleSidebar`）——组件自己写一遍的结果是同一
 * 个功能在设置页和这里可以叫两个名字。
 */
export function ShortcutsModal({ isOpen, onClose }: ShortcutsModalProps) {
  if (!isOpen) return null;

  const groups: ShortcutGroup[] = [
    {
      title: t('shortcuts.navigation'),
      items: [
        { keys: ['Ctrl', '1'], label: t('shortcuts.dashboard') },
        { keys: ['Ctrl', '2'], label: t('shortcuts.note') },
        { keys: ['Ctrl', '3'], label: t('shortcuts.graph') },
        { keys: ['Ctrl', '4'], label: t('shortcuts.canvas') },
        { keys: ['Ctrl', '5'], label: t('shortcuts.bases') },
        { keys: ['Ctrl', '6'], label: t('shortcuts.calendar') },
        { keys: ['Ctrl', '7'], label: t('shortcuts.settings') },
        { keys: ['Ctrl', '9'], label: t('knowledge.navTitle') },
        { keys: ['Ctrl', ','], label: t('shortcuts.openSettings') },
        { keys: ['Ctrl', 'P'], label: t('shortcuts.quickSwitcher') },
        { keys: ['Ctrl', 'Shift', 'P'], label: t('palette.modeCommands') },
        { keys: ['Ctrl', 'Shift', 'F'], label: t('shortcuts.globalSearch') },
      ],
    },
    {
      title: t('shortcuts.editing'),
      items: [
        { keys: ['Ctrl', 'N'], label: t('shortcuts.newNote') },
        { keys: ['Ctrl', 'S'], label: t('shortcuts.saveNote') },
        { keys: ['Ctrl', 'D'], label: t('shortcuts.dailyNote') },
        { keys: ['Ctrl', 'J'], label: t('shortcuts.timeline') },
        { keys: ['Ctrl', 'V'], label: t('shortcuts.smartPaste') },
      ],
    },
    {
      title: t('shortcuts.tools'),
      items: [
        { keys: ['Ctrl', 'L'], label: t('shortcuts.toggleChat') },
        { keys: ['Ctrl', 'K'], label: t('shortcuts.toggleAgent') },
        { keys: ['Ctrl', 'B'], label: t('shortcuts.toggleSidebar') },
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
