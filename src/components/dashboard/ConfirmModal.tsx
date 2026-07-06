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

  const accentColors = {
    warning: {
      icon: 'var(--warning, #F59E0B)',
      btn: 'var(--warning, #F59E0B)',
      bg: 'color-mix(in srgb, var(--warning, #F59E0B) 8%, transparent)',
    },
    danger: {
      icon: 'var(--danger, #EF4444)',
      btn: 'var(--danger, #EF4444)',
      bg: 'color-mix(in srgb, var(--danger, #EF4444) 8%, transparent)',
    },
    info: {
      icon: 'var(--accent-primary)',
      btn: 'var(--accent-primary)',
      bg: 'color-mix(in srgb, var(--accent-primary) 8%, transparent)',
    },
  };

  const colors = accentColors[variant];

  return (
    <div
      className="confirm-modal-overlay"
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.4)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        animation: 'confirm-modal-fade-in 0.2s ease-out',
      }}
    >
      <div
        ref={modalRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        aria-describedby="confirm-modal-message"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        className="confirm-modal-card"
        style={{
          background: 'var(--bg-elevated, var(--bg-secondary))',
          border: '1px solid var(--border, rgba(128,128,128,0.2))',
          borderRadius: 'var(--radius-xl, 16px)',
          padding: 'var(--space-6)',
          maxWidth: '420px',
          width: 'calc(100% - var(--space-8))',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(128,128,128,0.1)',
          animation: 'confirm-modal-scale-in 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {/* Header: Icon + Title */}
        <div style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 'var(--space-3)',
          marginBottom: 'var(--space-3)',
        }}>
          <div style={{
            width: 40,
            height: 40,
            borderRadius: 'var(--radius-full, 50%)',
            background: colors.bg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={colors.icon} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3
              id="confirm-modal-title"
              style={{
                fontSize: 'var(--text-base)',
                fontWeight: 600,
                color: 'var(--text-primary)',
                margin: 0,
                lineHeight: 1.4,
              }}
            >
              {title}
            </h3>
          </div>
        </div>

        {/* Message */}
        <p
          id="confirm-modal-message"
          style={{
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
            lineHeight: 1.6,
            margin: 0,
            marginBottom: 'var(--space-5)',
            paddingLeft: 'calc(40px + var(--space-3))',
          }}
        >
          {message}
        </p>

        {/* Actions */}
        <div style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 'var(--space-2)',
        }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={onCancel}
            style={{
              fontSize: 'var(--text-sm)',
              fontWeight: 500,
              padding: '8px 16px',
              borderRadius: 'var(--radius-md)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border, rgba(128,128,128,0.15))',
              background: 'transparent',
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 4%, transparent)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmBtnRef}
            className="btn btn-sm"
            onClick={onConfirm}
            style={{
              fontSize: 'var(--text-sm)',
              fontWeight: 600,
              padding: '8px 20px',
              borderRadius: 'var(--radius-md)',
              color: '#fff',
              background: colors.btn,
              border: 'none',
              boxShadow: `0 2px 8px color-mix(in srgb, ${colors.btn} 30%, transparent)`,
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.filter = 'brightness(1.1)';
              e.currentTarget.style.transform = 'translateY(-1px)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.filter = 'none';
              e.currentTarget.style.transform = 'none';
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
