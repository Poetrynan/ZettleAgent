import { useEffect, useRef } from 'react';

export interface HotkeyDef {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  handler: (e: KeyboardEvent) => void;
  /** If true, the hotkey fires even inside input/textarea. Default: false */
  global?: boolean;
}

/**
 * Register global keyboard shortcuts.
 * Automatically ignores keystrokes inside <input>, <textarea>, and
 * contenteditable elements unless `global` is set on the hotkey definition.
 * Escape always fires regardless.
 */
export function useHotkeys(hotkeys: HotkeyDef[]) {
  const hotkeyRef = useRef(hotkeys);
  hotkeyRef.current = hotkeys;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const isEditable =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable;

      for (const hk of hotkeyRef.current) {
        const keyMatch = e.key.toLowerCase() === hk.key.toLowerCase();
        const ctrlMatch = !!hk.ctrl === (e.ctrlKey || e.metaKey);
        const shiftMatch = !!hk.shift === e.shiftKey;
        const altMatch = !!hk.alt === e.altKey;

        if (keyMatch && ctrlMatch && shiftMatch && altMatch) {
          // Skip if inside editable unless global or Escape
          if (isEditable && !hk.global && e.key !== 'Escape') {
            continue;
          }
          e.preventDefault();
          e.stopPropagation();
          hk.handler(e);
          return;
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);
}
