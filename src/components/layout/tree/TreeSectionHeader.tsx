import React from 'react';
import { IconChevronRight } from '../../icons';

interface TreeSectionHeaderProps {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  count?: number;
  icon?: React.ReactNode;
  trailing?: React.ReactNode;
  className?: string;
  isDropTarget?: boolean;
  onContextMenu?: (e: React.MouseEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
}

export function TreeSectionHeader({
  label,
  expanded,
  onToggle,
  count,
  icon,
  trailing,
  className = '',
  isDropTarget = false,
  onContextMenu,
  onDragOver,
  onDragLeave,
  onDrop,
}: TreeSectionHeaderProps) {
  return (
    <div
      className={`tree-section-header${isDropTarget ? ' tree-drop-target' : ''}${className ? ` ${className}` : ''}`}
      onClick={onToggle}
      onContextMenu={onContextMenu}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <span
        className="tree-section-chevron"
        style={{ transform: expanded ? 'rotate(90deg)' : 'none' }}
        aria-hidden="true"
      >
        <IconChevronRight size={12} />
      </span>
      {icon && <span className="tree-section-icon">{icon}</span>}
      <span className="tree-section-label">{label}</span>
      {trailing}
      {count != null && count > 0 && (
        <span className="tree-count-badge">{count}</span>
      )}
    </div>
  );
}
