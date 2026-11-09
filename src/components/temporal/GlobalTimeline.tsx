import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../contexts/AppContext';
import { getGlobalTimeline, type TimelineEvent } from '../../lib/tauri';
import { IconTimeline, IconChevronDown } from '../icons';

/** SQLite stores UTC timestamps without an offset; explicit offsets are retained. */
function parseTimestamp(value: string): Date {
  const iso = value.replace(' ', 'T');
  return new Date(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
}

function dayNumber(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000;
}

export function GlobalTimeline({ refreshKey = 0 }: { refreshKey?: number }) {
  const { state, setCurrentFile, setView } = useApp();
  const zh = state.lang === 'zh';
  const copy = (cn: string, en: string) => zh ? cn : en;
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [filter, setFilter] = useState('all');
  const [expanded, setExpanded] = useState(() => {
    try { return localStorage.getItem('zettel:dash-timeline-expanded') === 'true'; } catch { return false; }
  });
  const [visibleCount, setVisibleCount] = useState(20);
  const generation = useRef(0);
  const pathsKey = JSON.stringify(state.vaultPaths?.length ? state.vaultPaths : state.vaultPath ? [state.vaultPath] : []);
  const paths = useMemo<string[]>(() => JSON.parse(pathsKey), [pathsKey]);
  useEffect(() => {
    const request = ++generation.current;
    if (!paths.length) { setEvents([]); setLoading(false); return; }
    setLoading(true); setError(false); setEvents([]);
    const now = new Date(Date.now());
    const start = new Date(now); start.setDate(start.getDate() - 90); start.setHours(0, 0, 0, 0);
    void getGlobalTimeline(start.toISOString(), now.toISOString()).then(data => {
      if (request !== generation.current) return;
      const normalize = (p: string) => p.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/$/, '');
      const withinScope = (path: string) => paths.some(root => {
        let candidate = normalize(path); let prefix = normalize(root);
        if (/^[a-z]:\//i.test(prefix)) { candidate = candidate.toLowerCase(); prefix = prefix.toLowerCase(); }
        return candidate.startsWith(`${prefix}/`);
      });
      setEvents(data.filter(event => withinScope(event.note_path) && Number.isFinite(parseTimestamp(event.event_timestamp).getTime())).sort((a, b) => parseTimestamp(b.event_timestamp).getTime() - parseTimestamp(a.event_timestamp).getTime()));
      setLoading(false);
    }).catch(() => { if (request === generation.current) { setError(true); setLoading(false); } });
    return () => { generation.current += 1; };
  }, [paths, refreshKey, retry]);

  if (!paths.length) return null;
  const labels: Record<string, string> = {
    created: copy('新增', 'Created'), updated: copy('更新', 'Updated'),
    contradicted: copy('矛盾', 'Conflicts'), superseded: copy('取代', 'Superseded'),
  };
  const filtered = filter === 'all' ? events : events.filter(event => event.event_type === filter);
  const shown = expanded ? filtered.slice(0, visibleCount) : events.slice(0, 5);
  const groups = new Map<string, TimelineEvent[]>();
  const today = new Date(Date.now());
  for (const event of shown) {
    const date = parseTimestamp(event.event_timestamp);
    const age = dayNumber(today) - dayNumber(date);
    const label = age === 0 ? copy('今天', 'Today') : age === 1 ? copy('昨天', 'Yesterday') : date.toLocaleDateString(zh ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric' });
    groups.set(label, [...(groups.get(label) ?? []), event]);
  }
  const openNote = (path: string) => { setCurrentFile(path); setView('note'); };

  return (
    <div className="dash-recent">
      <div className="dash-home-section-heading">
        <h2><IconTimeline size={17} />{copy('最近变化', 'Recent changes')}</h2>
        <span>{copy('最近 90 天', 'Last 90 days')}</span>
      </div>
      {loading ? <div className="dash-recent-placeholder" role="status">{copy('正在读取最近变化…', 'Loading recent changes…')}</div>
        : error ? <div className="dash-inline-notice" role="status"><span>{copy('时间线暂时无法读取。', 'The timeline could not be loaded.')}</span><button className="btn btn-sm" onClick={() => setRetry(value => value + 1)}>{copy('重试时间线', 'Retry timeline')}</button></div>
        : events.length === 0 ? <div className="dash-recent-placeholder">{copy('最近 90 天暂无记录。整理笔记后，变更会显示在这里。', 'No events in the last 90 days. Changes will appear here after notes are organized.')}</div>
        : <>
          {expanded && <div className="timeline-filter-tabs" role="group" aria-label={copy('事件类型', 'Event type')}>
            {['all', 'created', 'updated', 'contradicted', 'superseded'].map(type => <button key={type} className={`timeline-filter-btn ${type === filter ? 'active' : ''}`} aria-pressed={type === filter} onClick={() => { setFilter(type); setVisibleCount(20); }}>{type === 'all' ? copy('全部', 'All') : labels[type]} <span>{type === 'all' ? events.length : events.filter(event => event.event_type === type).length}</span></button>)}
          </div>}
          <div id="dash-timeline-events" className="dash-recent-events">
            {Array.from(groups, ([group, items]) => <div key={group} className="dash-recent-group"><h3>{group}</h3>{items.map(event => {
              const date = parseTimestamp(event.event_timestamp);
              const name = event.note_path.split(/[/\\]/).pop()?.replace(/\.md$/i, '') || event.note_path;
              return <button key={event.id} className="dash-recent-event" onClick={() => openNote(event.note_path)}>
                <span className={`dash-event-kind dash-event-kind--${event.event_type}`}>{labels[event.event_type] ?? event.event_type}</span>
                <span className="dash-recent-event-body"><strong>{name}</strong>{event.event_details && <span>{event.event_details}</span>}</span>
                <time dateTime={date.toISOString()} title={date.toLocaleString(zh ? 'zh-CN' : 'en-US')}>{date.toLocaleTimeString(zh ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' })}</time>
              </button>;
            })}</div>)}
            {expanded && filtered.length === 0 && <p className="dash-recent-placeholder">{copy('此类型暂无记录。', 'No events of this type.')}</p>}
          </div>
          <div className="dash-recent-footer">
            <button className="btn btn-ghost btn-sm" aria-expanded={expanded} aria-controls="dash-timeline-events" onClick={() => { const next = !expanded; setExpanded(next); try { localStorage.setItem('zettel:dash-timeline-expanded', String(next)); } catch { /* preference */ } }}>
              {expanded ? copy('收起为最近 5 条', 'Show latest 5') : copy(`查看全部 ${events.length} 条变化`, `View all ${events.length} changes`)}<IconChevronDown size={12} />
            </button>
            {expanded && filtered.length > visibleCount && <button className="btn btn-sm" onClick={() => setVisibleCount(count => count + 20)}>{copy('再显示 20 条', 'Show 20 more')}</button>}
          </div>
        </>}
    </div>
  );
}
