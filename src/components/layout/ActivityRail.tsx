import React from 'react';
import { useApp } from '../../contexts/AppContext';
import type { View } from '../../contexts/AppContext';
import { t } from '../../lib/i18n';
import {
  IconChart, IconFile, IconNetwork, IconCanvas, IconStack,
  IconCalendar, IconBrain, IconDatabase, IconSettings,
} from '../icons';
import { useInboxCounts } from '../knowledge/useInboxCounts';

/**
 * Activity Rail — mode navigation on its own vertical axis.
 *
 * This used to be a stacked label list at the top of the sidebar, which cost
 * ~350px of the sidebar's height and pushed the file tree into the bottom half.
 * Navigation and document browsing are different questions ("which room" vs
 * "which document"), so they get perpendicular axes instead of competing for
 * the same column: a fixed 44px icon rail here, the tree owning the sidebar
 * top-to-bottom. Same pattern as VS Code's activity bar and Obsidian's ribbon.
 *
 * The known cost of an icon-only rail is recall ("which glyph was 复习?"), so
 * every button carries an instant hover/focus flyout label on top of its
 * aria-label — not just a native title tooltip, which waits ~1s.
 *
 * The rail is independent of the sidebar toggle: Ctrl+B hides the tree and
 * navigation survives.
 */

interface RailItem {
  view: View;
  icon: React.ReactNode;
  label: string;
}

export function ActivityRail() {
  const { state, setView } = useApp();
  const { counts: inboxCounts } = useInboxCounts();

  const primary: RailItem[] = [
    { view: 'dashboard', icon: <IconChart size={18} />, label: `01 · ${t('toolbar.dashboard')}` },
    { view: 'note', icon: <IconFile size={18} />, label: `02 · ${t('toolbar.note')}` },
    { view: 'graph', icon: <IconNetwork size={18} />, label: `03 · ${t('toolbar.graph')}` },
    { view: 'canvas', icon: <IconCanvas size={18} />, label: `04 · ${t('toolbar.canvas')}` },
    { view: 'bases', icon: <IconStack size={18} />, label: `05 · ${t('toolbar.bases')}` },
    { view: 'calendar', icon: <IconCalendar size={18} />, label: `06 · ${t('toolbar.calendar')}` },
    { view: 'review', icon: <IconBrain size={18} />, label: `07 · ${t('review.navTitle')}` },
    { view: 'knowledge', icon: <IconDatabase size={18} />, label: `08 · ${t('knowledge.navTitle')}` },
  ];

  const settings: RailItem = {
    view: 'settings', icon: <IconSettings size={18} />, label: `09 · ${t('settings.title')}`,
  };

  const inboxTotal = inboxCounts?.total ?? 0;

  const renderItem = (item: RailItem) => (
    <button
      key={item.view}
      type="button"
      className={`activity-rail-item ${state.view === item.view ? 'active' : ''}`}
      onClick={() => setView(item.view)}
      aria-label={item.label}
      aria-current={state.view === item.view ? 'page' : undefined}
    >
      {item.icon}
      {item.view === 'knowledge' && inboxTotal > 0 && (
        <span className="activity-rail-dot" aria-hidden="true" />
      )}
      <span className="activity-rail-tip" role="tooltip">{item.label}</span>
    </button>
  );

  return (
    <nav
      className="activity-rail"
      aria-label={state.lang === 'zh' ? '工作台' : 'Workspace'}
    >
      <div className="activity-rail-group">{primary.map(renderItem)}</div>
      {/* Settings is the one destination you leave rather than work in, so it
          sits apart at the bottom — same convention as VS Code's manage gear. */}
      <div className="activity-rail-group activity-rail-group-end">
        {renderItem(settings)}
      </div>
    </nav>
  );
}
