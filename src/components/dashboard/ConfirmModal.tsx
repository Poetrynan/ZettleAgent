import { useEffect, useRef, useCallback } from 'react';

export interface ConfirmModalProps {
  /** Whether modal is visible */
  isOpen: boolean;
  /** Modal title */
  title: string;
  /** Modal message body */
  message: string;
  /** Confirm button text */
  confirmLabel?: string;
  /** Cancel button text */
  cancelLabel?: string;
  /** Confirm callback */
  onConfirm: () => void;
  /** Cancel/dismiss callback */
  onCancel: () => void;
  /** Visual variant */
  variant?: 'warning' | 'danger' | 'info';
}

/**
 * ConfirmModal — accessible, animated confirmation dialog.
 * 
 * UX Principles (from UI/UX Pro Max):
 * - Focus trap: focus returns to trigger on close
 * - Keyboard: Escape to cancel, Enter to confirm
 * - Animation: 200ms ease-out enter/exit (transform + opacity)
 * - Reduced motion: respects prefers-reduced-motion
 * - Backdrop: click to dismiss
 * - Focus ring: visible focus states for keyboard nav
 */
export function ConfirmModal({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  variant = 'warning',
}: ConfirmModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Store previously focused element when opening
  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement;
      // Focus confirm button after mount
      setTimeout(() => confirmBtnRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Handle Escape key
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCancel();
    }
    // Trap focus within modal
    if (e.key === 'Tab') {
      const focusable = modalRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable && focusable.length > 0) {
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  }, [onCancel]);

  // Restore focus on close
  useEffect(() => {
    if (!isOpen && previousFocusRef.current) {
      previousFocusRef.current.focus();
      previousFocusRef.current = null;
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const iconColor = {
    warning: 'var(--warning)',
    danger: 'var(--danger)',
    info: 'var(--accent-primary)',
  }[variant];

  return (
    <div className="confirm-modal-overlay mac-alert-overlay" onClick={onCancel}>
      <div
        ref={modalRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        aria-describedby="confirm-modal-message"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        className="confirm-modal-card mac-alert"
      >
        <div className="mac-alert-icon" aria-hidden="true">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke={iconColor} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>

        <h3 id="confirm-modal-title" className="mac-alert-title">
          {title}
        </h3>

        <p id="confirm-modal-message" className="mac-alert-message">
          {message}
        </p>

        <div className="mac-alert-actions">
          <button className="btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            ref={confirmBtnRef}
            className={`btn ${variant === 'danger' ? 'btn-danger' : 'btn-primary'}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );}
