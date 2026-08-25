import React from 'react';

interface InspectorSlotProps {
  title?: string;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  onClose?: () => void;
}

/**
 * InspectorSlot — Standard container for inspector panels (Evidence, Metadata, Graph/Canvas node info, Tasks).
 */
export function InspectorSlot({
  title,
  badge,
  actions,
  children,
  className = '',
  onClose,
}: InspectorSlotProps) {
  return (
    <aside className={`inspector-slot ${className}`}>
      {(title || actions || onClose) && (
        <div className="inspector-slot__header">
          <div className="inspector-slot__title-group">
            {title && <h3 className="inspector-slot__title">{title}</h3>}
            {badge && <span className="inspector-slot__badge">{badge}</span>}
          </div>
          <div className="inspector-slot__actions">
            {actions}
            {onClose && (
              <button
                type="button"
                className="btn btn-icon-sm inspector-slot__close"
                onClick={onClose}
                aria-label="Close Inspector"
                title="Close"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      )}
      <div className="inspector-slot__body">{children}</div>
    </aside>
  );
}
