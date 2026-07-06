import type { ReactNode } from 'react';
import { IconRobot } from '../icons';
import { t } from '../../lib/i18n';
import type { SchedulerStatus } from '../../lib/tauri';

interface AgentAutoOrganizeCardProps {
  status: SchedulerStatus | null;
  starting: boolean;
  vaultReady: boolean;
  intervalSecs: number;
  isZh: boolean;
  onStart: () => void | Promise<void>;
  onStop: () => void | Promise<void>;
}

function formatInterval(secs: number, isZh: boolean): string {
  if (secs >= 3600 && secs % 3600 === 0) {
    const h = secs / 3600;
    return isZh ? `每 ${h} 小时` : `every ${h}h`;
  }
  if (secs >= 60) {
    const m = Math.round(secs / 60);
    return isZh ? `每 ${m} 分钟` : `every ${m}m`;
  }
  return isZh ? `每 ${secs} 秒` : `every ${secs}s`;
}

function StatTile({
  icon,
  value,
  label,
  accent,
  hero = false,
}: {
  icon: ReactNode;
  value: number;
  label: string;
  accent: 'blue' | 'green' | 'amber';
  hero?: boolean;
}) {
  return (
    <div
      className={`agent-auto-stat agent-auto-stat--${accent}${hero ? ' agent-auto-stat--hero' : ''}`}
      aria-label={`${label}: ${value.toLocaleString()}`}
    >
      <div className="agent-auto-stat-icon" aria-hidden="true">{icon}</div>
      <div className="agent-auto-stat-body">
        <div className="agent-auto-stat-value">{value.toLocaleString()}</div>
        <div className="agent-auto-stat-label">{label}</div>
      </div>
    </div>
  );
}

export function AgentAutoOrganizeCard({
  status,
  starting,
  vaultReady,
  intervalSecs,
  isZh,
  onStart,
  onStop,
}: AgentAutoOrganizeCardProps) {
  const running = !!status?.running;
  const processed = status?.notes_processed ?? 0;
  const reconciled = status?.notes_reconciled ?? 0;
  const apiCalls = status?.api_calls_used ?? 0;
  const hasActivity = processed > 0 || reconciled > 0 || apiCalls > 0;
  const intervalLabel = formatInterval(intervalSecs, isZh);
  const toggleDisabled = (!vaultReady && !running) || starting;

  const lastRunLabel = status?.last_run
    ? new Date(status.last_run).toLocaleString(isZh ? 'zh-CN' : undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : t('dashboard.agentNeverRun' as any);

  const handleToggle = () => {
    if (toggleDisabled) return;
    if (running) void onStop();
    else void onStart();
  };

  const toggleLabel = running
    ? t('dashboard.agentToggleOff' as any)
    : t('dashboard.agentToggleOn' as any);

  return (
    <section
      className={`agent-auto-card animate-enter animate-enter-delay-3${running ? ' agent-auto-card--running' : ''}`}
      aria-labelledby="agent-auto-title"
      aria-describedby="agent-auto-desc"
    >
      <div className="agent-auto-glow" aria-hidden="true" />

      <header className="agent-auto-header">
        <div className="agent-auto-brand">
          <div className="agent-auto-icon-wrap" aria-hidden="true">
            <IconRobot size={22} />
          </div>
          <div className="agent-auto-brand-text">
            <h3 id="agent-auto-title" className="agent-auto-title">
              {t('dashboard.agentTitle')}
            </h3>
            <p id="agent-auto-desc" className="agent-auto-desc">
              {t('dashboard.agentDesc' as any)}
            </p>
          </div>
        </div>

        <div className="agent-auto-control">
          <button
            type="button"
            role="switch"
            aria-checked={running}
            aria-label={toggleLabel}
            aria-busy={starting}
            disabled={toggleDisabled}
            className={`agent-auto-toggle${running ? ' agent-auto-toggle--on' : ''}${starting ? ' agent-auto-toggle--busy' : ''}`}
            onClick={handleToggle}
          >
            <span className="agent-auto-toggle-track" aria-hidden="true">
              <span className="agent-auto-toggle-thumb">
                {starting ? <span className="spinner agent-auto-toggle-spinner" /> : null}
              </span>
            </span>
            <span className="agent-auto-toggle-copy">
              <span className="agent-auto-toggle-status" aria-live="polite">
                {running ? t('dashboard.running') : t('dashboard.stopped')}
              </span>
              <span className="agent-auto-toggle-hint">
                {running
                  ? t('dashboard.agentRunningHint' as any).replace('{interval}', intervalLabel)
                  : t('dashboard.agentIdleHint' as any).replace('{interval}', intervalLabel)}
              </span>
            </span>
          </button>
        </div>
      </header>

      <div className="agent-auto-bento" role="group" aria-label={t('dashboard.agentMetrics' as any)}>
        <StatTile
          hero
          accent="green"
          value={reconciled}
          label={t('dashboard.reconciled')}
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          }
        />
        <StatTile
          accent="blue"
          value={processed}
          label={t('dashboard.processed')}
          icon={
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          }
        />
        <StatTile
          accent="amber"
          value={apiCalls}
          label={t('dashboard.apiCalls')}
          icon={
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          }
        />
      </div>

      <footer className="agent-auto-footer">
        <div className="agent-auto-meta">
          <span className="agent-auto-meta-item">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
            </svg>
            <span>{t('dashboard.lastRun')}: <time>{lastRunLabel}</time></span>
          </span>
        </div>

        {!running && !hasActivity && (
          <p className="agent-auto-idle-note">{t('dashboard.agentIdleNote' as any)}</p>
        )}
      </footer>

      {status?.errors && status.errors.length > 0 && (
        <div className="agent-auto-errors" role="alert">
          {status.errors.map((e, i) => (
            <div key={i} className="agent-auto-error-line">{e}</div>
          ))}
        </div>
      )}
    </section>
  );
}
