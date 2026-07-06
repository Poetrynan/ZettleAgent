import React from 'react';
import { IconChevronRight } from '../../icons';

export function TreeChevron({ expanded }: { expanded: boolean }) {
  return (
    <span
      className="tree-folder-toggle"
      style={{ transform: expanded ? 'rotate(90deg)' : 'none' }}
      aria-hidden="true"
    >
      <IconChevronRight size={14} />
    </span>
  );
}

export function TreeIndentSpacer() {
  return <span className="tree-indent-spacer" aria-hidden="true" />;
}

export function TreeCountBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return <span className="tree-count-badge">{count}</span>;
}

export function TreeBookmarkPin() {
  return (
    <span className="tree-bookmark-pin" aria-hidden="true">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1">
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
      </svg>
    </span>
  );
}
