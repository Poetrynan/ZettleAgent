import { useState, useEffect, useCallback } from 'react';
import { getSnapshots, FileSnapshot } from '../../lib/snapshots';
import { getNoteSnapshots, NoteSnapshot } from '../../lib/tauri';

interface TimelinePanelProps {
  filePath: string;
  currentContent: string;
  /** Called when user clicks a snapshot to open inline diff */
  onSelectSnapshot: (snapshot: FileSnapshot) => void;
  /** Currently selected snapshot id (for highlight) */
  selectedSnapshotId?: number | undefined;
  lang: 'zh' | 'en' | 'ja' | 'ko';
}

interface TimelineEntry {
  id: number;
  timestamp: number;
  contentLength: number;
  contentPreview: string;
  source: 'sqlite' | 'indexeddb';
}

function getRelativeTime(timestamp: number, lang: 'zh' | 'en' | 'ja' | 'ko'): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const isZh = lang === 'zh';
  if (seconds < 60) return isZh ? '刚刚' : 'just now';
  if (minutes < 60) return isZh ? `${minutes}分钟前` : `${minutes}m ago`;
  if (hours < 24) return isZh ? `${hours}小时前` : `${hours}h ago`;
  if (days < 7) return isZh ? `${days}天前` : `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function TimelinePanel({ filePath, currentContent, onSelectSnapshot, selectedSnapshotId, lang }: TimelinePanelProps) {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const loadTimeline = useCallback(async () => {
    setLoading(true);
    try {
      // Get from SQLite (authoritative)
      const dbSnapshots: NoteSnapshot[] = await getNoteSnapshots(filePath).catch(() => []);
      const sqliteEntries: TimelineEntry[] = dbSnapshots.map(s => ({
        id: s.id,
        timestamp: s.created_at_ms,
        contentLength: s.content_length,
        contentPreview: s.content.substring(0, 100),
        source: 'sqlite' as const,
      }));
      setEntries(sqliteEntries);
    } catch (err) {
      console.error('Failed to load timeline:', err);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [filePath]);

  useEffect(() => {
    loadTimeline();
  }, [loadTimeline]);

  // Group entries by date
  const groupedByDate: { date: string; items: TimelineEntry[] }[] = [];
  const dateMap = new Map<string, TimelineEntry[]>();
  for (const entry of entries) {
    const dateKey = new Date(entry.timestamp).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    });
    if (!dateMap.has(dateKey)) dateMap.set(dateKey, []);
    dateMap.get(dateKey)!.push(entry);
  }
  for (const [date, items] of dateMap) {
    groupedByDate.push({ date, items });
  }

  return (
    <div className="timeline-panel">
      <div className="timeline-panel-header">
        <span className="timeline-panel-title">
          {lang === 'zh' ? '时间线' : 'Timeline'}
        </span>
        <span className="timeline-panel-count">
          {entries.length} {lang === 'zh' ? '个版本' : 'versions'}
        </span>
        <button
          className="timeline-panel-refresh"
          onClick={loadTimeline}
          title={lang === 'zh' ? '刷新' : 'Refresh'}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
      </div>

      <div className="timeline-panel-body">
        {loading ? (
          <div className="timeline-panel-empty">
            <span className="diff-approval-spinner" style={{ width: '14px', height: '14px' }} />
            <span>{lang === 'zh' ? '加载中...' : 'Loading...'}</span>
          </div>
        ) : entries.length === 0 ? (
          <div className="timeline-panel-empty">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <span>{lang === 'zh' ? '暂无历史记录' : 'No history yet'}</span>
            <span style={{ fontSize: '10px', opacity: 0.6 }}>
              {lang === 'zh' ? '编辑笔记后会自动保存版本' : 'Versions are saved automatically as you edit'}
            </span>
          </div>
        ) : (
          groupedByDate.map(group => (
            <div key={group.date} className="timeline-group">
              <div className="timeline-group-header">{group.date}</div>
              {group.items.map((entry, idx) => {
                const isSelected = selectedSnapshotId === entry.id;
                const isLatest = group === groupedByDate[0] && idx === 0;
                return (
                  <button
                    key={entry.id}
                    className={`timeline-entry ${isSelected ? 'selected' : ''}`}
                    onClick={() => onSelectSnapshot({
                      id: entry.id,
                      filePath,
                      content: '', // Will be loaded on demand
                      timestamp: entry.timestamp,
                      source: entry.source,
                    })}
                  >
                    <div className="timeline-entry-dot" />
                    <div className="timeline-entry-content">
                      <div className="timeline-entry-time">
                        {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                      <div className="timeline-entry-relative">
                        {getRelativeTime(entry.timestamp, lang)}
                      </div>
                      {isLatest && (
                        <span className="timeline-entry-badge">
                          {lang === 'zh' ? '最新' : 'Latest'}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
