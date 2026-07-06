import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  label: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  isOpen: boolean;
  onClose: () => void;
  items: ContextMenuItem[];
}

const VIEWPORT_PAD = 8;

/** Keep menu fully inside the window; prefer opening above the cursor near the bottom edge. */
function clampMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxW = vw - VIEWPORT_PAD * 2;
  const maxH = vh - VIEWPORT_PAD * 2;
  const menuW = Math.min(width, maxW);
  const menuH = Math.min(height, maxH);

  let left = x;
  let top = y;

  if (top + menuH + VIEWPORT_PAD > vh) {
    top = y - menuH;
  }
  if (top + menuH + VIEWPORT_PAD > vh) {
    top = vh - menuH - VIEWPORT_PAD;
  }
  if (top < VIEWPORT_PAD) {
    top = VIEWPORT_PAD;
  }

  if (left + menuW + VIEWPORT_PAD > vw) {
    left = vw - menuW - VIEWPORT_PAD;
  }
  if (left < VIEWPORT_PAD) {
    left = VIEWPORT_PAD;
  }

  return { left, top };
}

export function ContextMenu({ x, y, isOpen, onClose, items }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useEffect(() => {
    if (!isOpen) return;

    const handleOutsideClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const menu = menuRef.current;
    if (!menu) return;

    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    const rect = menu.getBoundingClientRect();
    setPosition(clampMenuPosition(x, y, rect.width, rect.height));
  }, [isOpen, x, y, items.length]);

  if (!isOpen) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="ctx-menu"
      role="menu"
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        left: position.left,
        top: position.top,
        maxHeight: `calc(100vh - ${VIEWPORT_PAD * 2}px)`,
        overflowY: 'auto',
      }}
    >
      {items.map((item, idx) => (
        <div
          key={idx}
          className={`ctx-menu-item${item.danger ? ' ctx-menu-danger' : ''}`}
          role="menuitem"
          onClick={() => {
            item.onClick();
            onClose();
          }}
        >
          {item.label}
        </div>
      ))}
    </div>,
    document.body,
  );
}
