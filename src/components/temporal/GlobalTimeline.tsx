import { useState, useEffect, useCallback } from 'react';
import { useApp } from '../../contexts/AppContext';
import { getGlobalTimeline, TimelineEvent } from '../../lib/tauri';
import { IconCreated, IconContradicted, IconSuperseded, IconTimeline, IconChevronDown, IconChevronUp } from '../icons';

const LABELS = {
  zh: {
    title: '知识演化',
    total: '总事件',
    created: '新增',
    conflicts: '矛盾',
    superseded: '取代',
    all: '全部',
    today: '今天',
    yesterday: '昨天',
    thisWeek: '本周',
    thisMonth: '本月',
    earlier: '更早',
    loading: '加载中...',
    empty: '暂无时间线记录',
    more: '个事件...',
    createdLabel: '新增',
    updatedLabel: '更新',
    contradictedLabel: '矛盾',
    supersededLabel: '取代',
  },
  en: {
    title: 'Knowledge Evolution',
    total: 'Total',
    created: 'Created',
    conflicts: 'Conflicts',
    superseded: 'Superseded',
    all: 'All',
    today: 'Today',
    yesterday: 'Yesterday',
    thisWeek: 'This Week',
    thisMonth: 'This Month',
    earlier: 'Earlier',
    loading: 'Loading...',
    empty: 'No timeline events yet',
    more: 'more events...',
    createdLabel: 'Created',
    updatedLabel: 'Updated',
    contradictedLabel: 'Contradicted',
    supersededLabel: 'Superseded',
  },
};

const EVENT_COLORS: Record<string, { color: string; bg: string }> = {
  created: { color: '#10b981', bg: 'rgba(16, 185, 129, 0.1)' },
  updated: { color: '#3b82f6', bg: 'rgba(59, 130, 246, 0.1)' },
  contradicted: { color: '#ef4444', bg: 'rgba(239, 68, 68, 0.1)' },
  superseded: { color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.1)' },
};

function getEventStyle(type: string) {
  return EVENT_COLORS[type] || { color: 'var(--text-tertiary)', bg: 'var(--bg-tertiary)' };
}

function getEventIcon(type: string, size: number = 14) {
  switch (type) {
    case 'created': return <IconCreated size={size} />;
    case 'updated': return <IconTimeline size={size} />;
    case 'contradicted': return <IconContradicted size={size} />;
    case 'superseded': return <IconSuperseded size={size} />;
    default: return <IconTimeline size={size} />;
  }
}

export function GlobalTimeline() {
  const { state, setCurrentFile } = useApp();
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [stats, setStats] = useState({ total: 0, active: 0, contradicted: 0, superseded: 0 });
  const [loading, setLoading] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);
  const [filter, setFilter] = useState('all');
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const L = state.lang === 'zh' ? LABELS.zh : LABELS.en;

  const loadData = useCallback(async () => {
    if (!state.vaultPath) return;
    setLoading(true);
    try {
      const now = new Date();
      const start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const end = now.toISOString().split('T')[0];
      const timelineEvents = await getGlobalTimeline(start, end);
      setEvents(timelineEvents);
      const created = timelineEvents.filter(e => e.event_type === 'created').length;
      const contradicted = timelineEvents.filter(e => e.event_type === 'contradicted').length;
      const superseded = timelineEvents.filter(e => e.event_type === 'superseded').length;
      setStats({ total: timelineEvents.length, active: created, contradicted, superseded });
    } catch (err) {
      console.error('Failed to load global timeline:', err);
    } finally {
      setLoading(false);
    }
  }, [state.vaultPath]);

  useEffect(() => { loadData(); }, [loadData]);

  const getNoteName = (path: string) => path.split(/[/\\]/).pop()?.replace('.md', '') || path;

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return L.today;
    if (diffDays === 1) return L.yesterday;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString(state.lang === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric' });
  };

  const getEventLabel = (type: string) => {
    if (type === 'created') return L.createdLabel;
    if (type === 'updated') return L.updatedLabel;
    if (type === 'contradicted') return L.contradictedLabel;
    if (type === 'superseded') return L.supersededLabel;
    return type;
  };

  const filteredEvents = filter === 'all' ? events : events.filter(e => e.event_type === filter);

  const getGroup = (dateStr: string) => {
    const diffDays = Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return L.today;
    if (diffDays === 1) return L.yesterday;
    if (diffDays < 7) return L.thisWeek;
    if (diffDays < 30) return L.thisMonth;
    return L.earlier;
  };

  const grouped: Record<string, TimelineEvent[]> = {};
  filteredEvents.forEach(ev => {
    const g = getGroup(ev.event_timestamp);
    if (!grouped[g]) grouped[g] = [];
    grouped[g].push(ev);
  });

  if (!state.vaultPath) return null;

  return (
    <div className="animate-enter animate-enter-delay-3" style={{ marginBottom: 'var(--space-6)' }}>
      <div
        className="dash-section-header"
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
        onClick={() => setIsExpanded(!isExpanded)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setIsExpanded(!isExpanded); }}
      >
        <h2 className="dash-section-title" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <IconTimeline size={18} />
          {L.title}
        </h2>
        <span style={{ color: 'var(--text-tertiary)', transition: 'transform 0.2s ease', transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}>
          <IconChevronDown size={16} />
        </span>
      </div>

      {isExpanded && (
        <>
          <div className="timeline-stats-grid">
            <div className="stat-card timeline-stat-card">
              <div className="timeline-stat-value">
                <span className="timeline-stat-icon"><IconTimeline size={16} /></span>
                <span>{stats.total}</span>
              </div>
              <div className="timeline-stat-label">{L.total}</div>
            </div>
            <div className="stat-card timeline-stat-card">
              <div className="timeline-stat-value timeline-color-created">
                <span className="timeline-stat-icon"><IconCreated size={16} /></span>
                <span>{stats.active}</span>
              </div>
              <div className="timeline-stat-label">{L.created}</div>
            </div>
            <div className="stat-card timeline-stat-card">
              <div className="timeline-stat-value timeline-color-conflicted">
                <span className="timeline-stat-icon"><IconContradicted size={16} /></span>
                <span>{stats.contradicted}</span>
              </div>
              <div className="timeline-stat-label">{L.conflicts}</div>
            </div>
            <div className="stat-card timeline-stat-card">
              <div className="timeline-stat-value timeline-color-superseded">
                <span className="timeline-stat-icon"><IconSuperseded size={16} /></span>
                <span>{stats.superseded}</span>
              </div>
              <div className="timeline-stat-label">{L.superseded}</div>
            </div>
          </div>

          <div className="timeline-filter-tabs">
            {['all', 'created', 'contradicted', 'superseded'].map(tab => (
              <button
                key={tab}
                className={`timeline-filter-btn ${filter === tab ? 'active' : ''}`}
                onClick={() => setFilter(tab)}
              >
                {tab === 'all' ? L.all : tab === 'created' ? L.created : tab === 'contradicted' ? L.conflicts : L.superseded}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="timeline-loading">
              <div className="timeline-skeleton" />
              <div className="timeline-skeleton" />
              <div className="timeline-skeleton" />
            </div>
          ) : filteredEvents.length === 0 ? (
            <div className="timeline-empty">
              <IconTimeline size={32} />
              <span>{L.empty}</span>
            </div>
          ) : (
            <div className="timeline-scroll-container">
              {Object.entries(grouped).map(([group, groupEvents]) => {
                const isGroupExpanded = !!expandedGroups[group];
                const visibleEvents = isGroupExpanded ? groupEvents : groupEvents.slice(0, 10);
                return (
                  <div key={group} className="timeline-group">
                    <div className="timeline-group-header">
                      <span className="timeline-group-line" />
                      {group}
                      <span className="timeline-group-line timeline-group-line-flex" />
                    </div>
                    <div className="timeline-events-list">
                      {visibleEvents.map(event => {
                        const eventStyle = getEventStyle(event.event_type);
                        return (
                          <div
                            key={event.id}
                            className="timeline-event-card"
                            onClick={() => setCurrentFile(event.note_path)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => { if (e.key === 'Enter') setCurrentFile(event.note_path); }}
                          >
                            <span className="timeline-event-icon" style={{ color: eventStyle.color, background: eventStyle.bg }}>
                              {getEventIcon(event.event_type)}
                            </span>
                            <div className="timeline-event-content">
                              <div className="timeline-event-header">
                                <span className="timeline-event-badge" style={{ color: eventStyle.color, background: eventStyle.bg }}>
                                  {getEventLabel(event.event_type)}
                                </span>
                                <span className="timeline-event-note">{getNoteName(event.note_path)}</span>
                              </div>
                              {event.event_details && (
                                <div className="timeline-event-details">{event.event_details.slice(0, 80)}</div>
                              )}
                            </div>
                            <span className="timeline-event-time">{formatDate(event.event_timestamp)}</span>
                          </div>
                        );
                      })}
                    </div>
                    {groupEvents.length > 10 && (
                      <button
                        className="btn btn-ghost timeline-more-btn"
                        onClick={() => setExpandedGroups(prev => ({ ...prev, [group]: !prev[group] }))}
                      >
                        <span>
                          {isGroupExpanded
                            ? (state.lang === 'zh' ? '收起事件' : 'Collapse events')
                            : (state.lang === 'zh'
                              ? `查看更多 (${groupEvents.length - 10} 个事件)`
                              : `View more (${groupEvents.length - 10} events)`)}
                        </span>
                        {isGroupExpanded ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
