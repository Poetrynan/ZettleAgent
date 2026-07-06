import React, { ReactNode } from 'react';
import { IconClose } from '../icons';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  style?: React.CSSProperties;
  headerExtra?: ReactNode;
}

export function Modal({ isOpen, onClose, title, children, style, headerExtra }: ModalProps) {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div 
        className="modal-container" 
        onClick={(e) => e.stopPropagation()}
        style={style}
      >
        {/* Header */}
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            {title}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            {headerExtra}
            <button className="btn btn-ghost btn-icon-sm" onClick={onClose}>
              <IconClose size={18} />
            </button>
          </div>
        </div>

        {/* Content */}
        {children}
      </div>
    </div>
  );
}
