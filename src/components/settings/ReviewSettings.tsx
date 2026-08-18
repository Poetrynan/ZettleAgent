/**
 * "Spaced repetition (FSRS)" settings section — the user-facing half of
 * `src-tauri/src/fsrs.rs` plus the stats view over `review_log`.
 *
 * The knobs are deliberately few. FSRS has 17 weights; exposing them would let a
 * user quietly destroy their own schedule, and this build cannot optimise them
 * anyway (no training data, no optimiser). What is exposed is the three things a
 * user genuinely needs to decide: how hard they want to work (retention), how
 * much per day (the caps), and how far out intervals may run.
 */
import { useCallback, useEffect, useState } from 'react';
import { IconBrain, IconSliders, IconChart } from '../icons';
import { sectionTitle } from './settingsStyles';
import { t, tf } from '../../lib/i18n';
import {
  getFsrsConfig, setFsrsConfig, getReviewStats,
  DEFAULT_FSRS_CONFIG,
  type FsrsConfig, type ReviewStats,
} from '../../lib/tauri';

/** Numeric knobs. The backend re-validates; these bounds only stop the UI from
 *  offering a value that would immediately be rejected. */
const KNOBS: Array<{
  key: 'maximumIntervalDays' | 'newPerDay' | 'reviewsPerDay';
  labelKey: Parameters<typeof t>[0];
  descKey: Parameters<typeof t>[0];
  min: number; max: number; step: number;
}> = [
  { key: 'newPerDay', labelKey: 'settings.review.newPerDay', descKey: 'settings.review.newPerDayDesc', min: 0, max: 9999, step: 5 },
  { key: 'reviewsPerDay', labelKey: 'settings.review.reviewsPerDay', descKey: 'settings.review.reviewsPerDayDesc', min: 0, max: 9999, step: 10 },
  { key: 'maximumIntervalDays', labelKey: 'settings.review.maximumIntervalDays', descKey: 'settings.review.maximumIntervalDaysDesc', min: 1, max: 36500, step: 30 },
];

/** Retention presets, because a raw 0.70–0.98 slider means nothing to a reader. */
const RETENTIONS = [0.8, 0.85, 0.9, 0.95];

export function ReviewSettingsSection() {
  const [config, setConfig] = useState<FsrsConfig>(DEFAULT_FSRS_CONFIG);
  const [stats, setStats] = useState<ReviewStats | null>(null);
  const [error, setError] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    let alive = true;
    getFsrsConfig()
      .then(c => { if (alive) setConfig(c); })
      .catch(e => { if (alive) setError(String(e)); });
    // Stats are best-effort: a fresh vault has no review history and that is not
    // an error worth showing.
    getReviewStats()
      .then(s => { if (alive) setStats(s); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  /**
   * Write a patch through optimistically, rolling back on failure so the card
   * never shows a setting the scheduler is not actually using.
   */
  const commit = useCallback(async (patch: Partial<FsrsConfig>) => {
    const previous = config;
    setConfig({ ...config, ...patch });
    setError('');
    try {
      // Only the patch goes out: the command is PATCH-shaped and unspecified
      // fields keep their stored value.
      const stored = await setFsrsConfig(patch);
      setConfig(stored ?? { ...previous, ...patch });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1800);
    } catch (e) {
      setConfig(previous);
      setError(String(e));
    }
  }, [config]);

  return (
    <div className="settings-section-card">
      <h2 style={sectionTitle}>
        <IconBrain size={18} /> {t('settings.review.title')}
      </h2>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-3)', lineHeight: 1.6 }}>
        {t('settings.review.desc')}
      </div>

      {/* ── Desired retention ────────────────────────────────────────── */}
      <div role="radiogroup" aria-label={t('settings.review.desiredRetention')} style={{ marginBottom: 'var(--space-3)' }}>
        <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{t('settings.review.desiredRetention')}</div>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', margin: '2px 0 8px', lineHeight: 1.5 }}>
          {t('settings.review.desiredRetentionDesc')}
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          {RETENTIONS.map(value => {
            const active = Math.abs(config.desiredRetention - value) < 1e-6;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={`fsrs-retention-${value}`}
                onClick={() => void commit({ desiredRetention: value })}
                className="btn btn-sm"
                style={{
                  fontFamily: 'var(--font-mono, monospace)',
                  borderColor: active ? 'var(--accent-primary, #10b981)' : 'var(--border)',
                  color: active ? 'var(--accent-primary, #10b981)' : 'var(--text-secondary)',
                }}
              >
                {Math.round(value * 100)}%
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Daily caps + interval ceiling ────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {KNOBS.map(k => (
          <KnobRow
            key={k.key}
            label={t(k.labelKey)}
            description={t(k.descKey)}
            value={config[k.key]}
            min={k.min}
            max={k.max}
            step={k.step}
            testId={`fsrs-knob-${k.key}`}
            onCommit={v => void commit({ [k.key]: v } as Partial<FsrsConfig>)}
          />
        ))}
      </div>

      {/* ── Fuzz toggle ──────────────────────────────────────────────── */}
      <div
        className="settings-toggle-row"
        role="switch"
        aria-checked={config.enableFuzz}
        tabIndex={0}
        data-testid="fsrs-fuzz-toggle"
        onClick={() => void commit({ enableFuzz: !config.enableFuzz })}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            void commit({ enableFuzz: !config.enableFuzz });
          }
        }}
        style={{ marginTop: 'var(--space-3)', cursor: 'pointer' }}
      >
        <span>
          <span style={{ display: 'block', fontSize: 'var(--text-sm)', fontWeight: 600 }}>
            <IconSliders size={14} /> {t('settings.review.enableFuzz')}
          </span>
          <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 2, lineHeight: 1.5 }}>
            {t('settings.review.enableFuzzDesc')}
          </span>
        </span>
        <div className={`settings-toggle-track ${config.enableFuzz ? 'active' : ''}`}>
          <div className="settings-toggle-thumb" />
        </div>
      </div>

      {savedFlash && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--success, #22c55e)', marginTop: 'var(--space-2)' }}>
          {t('settings.review.saved')}
        </div>
      )}
      {error && (
        <div data-testid="fsrs-error" style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)', marginTop: 'var(--space-2)' }}>
          {error}
        </div>
      )}

      {stats && <ReviewStatsCard stats={stats} />}
    </div>
  );
}

/**
 * One numeric knob. Commit on blur/Enter rather than per keystroke: each commit
 * is a Tauri round-trip plus a SQLite write, and typing "200" would otherwise
 * fire three of them and briefly persist "2".
 */
function KnobRow({
  label, description, value, min, max, step, testId, onCommit,
}: {
  label: string;
  description: string;
  value: number;
  min: number; max: number; step: number;
  testId: string;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);

  const flush = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.round(Math.max(min, Math.min(max, parsed)));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
      gap: 'var(--space-4)',
      padding: 'var(--space-3)',
      background: 'var(--bg-primary)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <label htmlFor={testId} style={{ display: 'block', fontSize: 'var(--text-sm)', fontWeight: 600 }}>{label}</label>
        <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 2, lineHeight: 1.5 }}>
          {description}
        </span>
        <span style={{ display: 'block', fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono, monospace)', marginTop: 4 }}>
          {min} – {max}
        </span>
      </div>
      <input
        id={testId}
        data-testid={testId}
        className="input"
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={flush}
        onKeyDown={e => { if (e.key === 'Enter') { flush(); e.currentTarget.blur(); } }}
        style={{ width: 110, flexShrink: 0, textAlign: 'right', fontFamily: 'var(--font-mono, monospace)' }}
      />
    </div>
  );
}

/** Counts, true retention, and the 7-day workload forecast. */
function ReviewStatsCard({ stats }: { stats: ReviewStats }) {
  const peak = Math.max(1, ...stats.forecast.map(d => d.count));

  const counters: Array<[string, number | string]> = [
    [t('review.stats.dueToday'), stats.dueToday],
    [t('review.stats.newCards'), stats.newCount],
    [t('review.stats.learning'), stats.learningCount],
    [t('review.stats.mature'), stats.reviewCount],
    [t('review.stats.relearning'), stats.relearningCount],
    [t('review.stats.suspended'), stats.suspendedCount],
  ];

  return (
    <div data-testid="review-stats" style={{
      marginTop: 'var(--space-4)',
      padding: 'var(--space-3)',
      background: 'var(--bg-primary)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)',
    }}>
      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
        <IconChart size={14} /> {t('review.stats.title')}
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
        gap: 'var(--space-2)', marginTop: 'var(--space-3)',
      }}>
        {counters.map(([label, value]) => (
          <div key={label}>
            <div style={{ fontSize: 'var(--text-lg)', fontWeight: 600, fontFamily: 'var(--font-mono, monospace)' }}>{value}</div>
            <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{label}</div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 'var(--space-3)', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
        <div data-testid="review-retention">
          {t('review.stats.retention')}:{' '}
          {stats.retentionRate === null
            ? t('review.stats.retentionNone')
            : `${(stats.retentionRate * 100).toFixed(1)}%`}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 2, lineHeight: 1.5 }}>
          {t('review.stats.retentionDesc')}
        </div>
        <div style={{ marginTop: 'var(--space-2)' }}>
          {tf('review.stats.streak', stats.streakDays)} · {tf('review.stats.reviewsToday', stats.reviewsToday)}
        </div>
      </div>

      {/* Forecast as bars rather than a chart library: seven numbers do not
          justify a dependency. */}
      <div style={{ marginTop: 'var(--space-3)' }}>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: 6 }}>
          {t('review.stats.forecast')}
        </div>
        <div data-testid="review-forecast" style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 72 }}>
          {stats.forecast.map(day => (
            <div key={day.dayOffset} style={{ flex: 1, textAlign: 'center' }}>
              <div
                title={String(day.count)}
                style={{
                  height: `${Math.round((day.count / peak) * 52)}px`,
                  minHeight: day.count > 0 ? 3 : 1,
                  background: day.dayOffset === 0 ? 'var(--accent-primary, #10b981)' : 'var(--bg-tertiary)',
                  borderRadius: 2,
                }}
              />
              <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 3, fontFamily: 'var(--font-mono, monospace)' }}>
                {day.count}
              </div>
              <div style={{ fontSize: 9, color: 'var(--text-tertiary)' }}>
                {day.dayOffset === 0 ? t('review.stats.forecastToday') : tf('review.stats.forecastDay', day.dayOffset)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
