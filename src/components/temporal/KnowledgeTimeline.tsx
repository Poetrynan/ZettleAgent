import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  IconTimeline,
  IconCreated,
  IconContradicted,
  IconSuperseded,
  IconCheck,
} from '../icons';

interface TimelineEvent {
  id: number;
  note_path: string;
  event_type: string;
  event_timestamp: string;
  event_details: string | null;
  old_fact_id: number | null;
  new_fact_id: number | null;
}

interface TemporalFact {
  id: number;
  note_path: string;
  fact_content: string;
  valid_from: string;
  valid_to: string | null;
  superseded_by: number | null;
  created_by: string;
}

interface TimelineProps {
  notePath?: string;
  startDate?: string;
  endDate?: string;
}

const EVENT_TYPE_CONFIG: Record<string, { label: string; labelEn: string; icon: React.ReactNode; color: string; bg: string }> = {
  created: {
    label: '创建',
    labelEn: 'Created',
    icon: <IconCreated size={12} />,
    color: '#10b981',
    bg: 'rgba(16, 185, 129, 0.1)',
  },
  updated: {
    label: '更新',
    labelEn: 'Updated',
    icon: <IconTimeline size={12} />,
    color: '#3b82f6',
    bg: 'rgba(59, 130, 246, 0.1)',
  },
  contradicted: {
    label: '矛盾',
    labelEn: 'Contradicted',
    icon: <IconContradicted size={12} />,
    color: '#ef4444',
    bg: 'rgba(239, 68, 68, 0.1)',
  },
  superseded: {
    label: '取代',
    labelEn: 'Superseded',
    icon: <IconSuperseded size={12} />,
    color: '#f59e0b',
    bg: 'rgba(245, 158, 11, 0.1)',
  },
};

export const KnowledgeTimeline: React.FC<TimelineProps> = ({ notePath, startDate, endDate }) => {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [facts, setFacts] = useState<TemporalFact[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'timeline' | 'facts'>('timeline');

  useEffect(() => {
    loadData();
  }, [notePath, startDate, endDate]);

  const loadData = async () => {
    setLoading(true);
    try {
      if (notePath) {
        const timelineEvents = await invoke<TimelineEvent[]>('get_note_timeline', { notePath });
        setEvents(timelineEvents);
        const noteFacts = await invoke<TemporalFact[]>('get_note_facts', { notePath, includeHistory: true });
        setFacts(noteFacts);
      } else {
        const globalEvents = await invoke<TimelineEvent[]>('get_global_timeline', { startDate, endDate });
        setEvents(globalEvents);
      }
    } catch (error) {
      console.error('Failed to load timeline:', error);
    } finally {
      setLoading(false);
    }
  };

  const getNoteName = (path: string) => {
    return path.split(/[/\\]/).pop()?.replace('.md', '') || path;
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getEventTypeConfig = (eventType: string) => {
    return EVENT_TYPE_CONFIG[eventType] || EVENT_TYPE_CONFIG.updated;
  };

  if (loading) {
    return (
      <div className="timeline-loading">
        <div className="diff-approval-spinner" />
        <span>加载中...</span>
      </div>
    );
  }

  return (
    <div className="knowledge-timeline">
      {/* Tab Header */}
      <div className="knowledge-timeline-tabs">
        <button
          className={`knowledge-timeline-tab ${activeTab === 'timeline' ? 'active' : ''}`}
          onClick={() => setActiveTab('timeline')}
        >
          <IconTimeline size={14} />
          <span>时间线</span>
        </button>
        <button
          className={`knowledge-timeline-tab ${activeTab === 'facts' ? 'active' : ''}`}
          onClick={() => setActiveTab('facts')}
        >
          <IconCheck size={14} />
          <span>事实追踪</span>
        </button>
      </div>

      {/* Timeline Tab */}
      {activeTab === 'timeline' && (
        <div className="knowledge-timeline-content">
          {events.length === 0 ? (
            <div className="knowledge-timeline-empty">
              <IconTimeline size={32} />
              <span>暂无时间线记录</span>
            </div>
          ) : (
            <div className="knowledge-timeline-list">
              {events.map((event) => {
                const config = getEventTypeConfig(event.event_type);
                return (
                  <div key={event.id} className="timeline-event-item">
                    {/* Dot */}
                    <div
                      className="timeline-event-dot"
                      style={{ background: config.color }}
                    />

                    {/* Content */}
                    <div className="timeline-event-card">
                      <div className="timeline-event-header">
                        <span
                          className="timeline-event-badge"
                          style={{ color: config.color, background: config.bg }}
                        >
                          {config.icon}
                          <span>{config.label}</span>
                        </span>
                        <span className="timeline-event-time">
                          {formatDate(event.event_timestamp)}
                        </span>
                      </div>
                      {!notePath && (
                        <div className="timeline-event-note">
                          {getNoteName(event.note_path)}
                        </div>
                      )}
                      {event.event_details && (
                        <div className="timeline-event-details">
                          {event.event_details}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Facts Tab */}
      {activeTab === 'facts' && (
        <div className="knowledge-timeline-content">
          {facts.length === 0 ? (
            <div className="knowledge-timeline-empty">
              <IconCheck size={32} />
              <span>暂无事实记录</span>
            </div>
          ) : (
            <div className="knowledge-facts-list">
              {facts.map((fact) => (
                <div
                  key={fact.id}
                  className={`knowledge-fact-card ${fact.valid_to ? 'expired' : 'active'}`}
                >
                  <div className="knowledge-fact-content">
                    {fact.fact_content}
                  </div>
                  <div className="knowledge-fact-meta">
                    <span>创建: {formatDate(fact.valid_from)}</span>
                    {fact.valid_to && <span>失效: {formatDate(fact.valid_to)}</span>}
                    <span className={`knowledge-fact-status ${fact.valid_to ? 'expired' : 'active'}`}>
                      {fact.valid_to ? '已失效' : '有效'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default KnowledgeTimeline;
