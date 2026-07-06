import { ReactNode, useEffect, useState } from 'react';

export interface ProgressPanelProps {
  /** Title displayed in header */
  title: ReactNode;
  /** Current progress value */
  current: number;
  /** Total progress value */
  total: number;
  /** Stage description text */
  stage: string;
  /** Extended stage description for AI context */
  stageDescription?: string;
  /** Icon element for stage description */
  stageIcon?: ReactNode;
  /** Cancel button text */
  cancelLabel?: string;
  /** Cancel callback */
  onCancel?: () => void | Promise<void>;
  /** Whether to show cancel button */
  showCancel?: boolean;
  /** Accent color variant */
  variant?: 'primary' | 'organize';
  /** Whether progress is indeterminate */
  indeterminate?: boolean;
  /** Extra content below progress bar */
  footer?: ReactNode;
  /** Whether to add extra top margin to separate from content above */
  hasSpacing?: boolean;
}

/**
 * ProgressPanel — refined progress indicator for data pipeline operations.
 *
 * Design principles (from UI/UX Pro Max):
 * - Clear hierarchy: prominent percentage, readable stage text
 * - Smooth transitions: 200ms ease-out for progress bar (150-300ms range)
 * - Accessibility: proper ARIA roles, focus states, prefers-reduced-motion
 * - Loading states: shimmer animation for active progress, checkmark for complete
 * - Interaction: disabled state during async, clear cancel action
 */
export function ProgressPanel({
  title,
  current,
  total,
  stage,
  stageDescription,
  stageIcon,
  cancelLabel = 'Cancel',
  onCancel,
  showCancel = true,
  variant = 'primary',
  indeterminate = false,
  footer,
  hasSpacing = false,
}: ProgressPanelProps) {
  const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
  const isComplete = !indeterminate && total > 0 && current === total;

  const accentColor = variant === 'organize' ? 'var(--accent-secondary)' : 'var(--accent-primary)';
  const accentBg = `color-mix(in srgb, ${accentColor} 6%, transparent)`;
  const accentBorder = `color-mix(in srgb, ${accentColor} 18%, transparent)`;
  const accentGlow = `color-mix(in srgb, ${accentColor} 35%, transparent)`;
  const accentSoft = `color-mix(in srgb, ${accentColor} 12%, transparent)`;

  // Smooth animated percentage for better perceived performance
  const [displayPercent, setDisplayPercent] = useState(0);
  useEffect(() => {
    if (indeterminate) return;
    const target = percentage;
    if (target === displayPercent) return;
    // Animate towards target over ~300ms
    const start = displayPercent;
    const diff = target - start;
    const duration = 300;
    const startTime = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / duration, 1);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplayPercent(Math.round(start + diff * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [percentage, indeterminate, displayPercent]);

  return (
    <div
      className="dash-progress-panel"
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : percentage}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={typeof title === 'string' ? title : undefined}
      aria-busy={!isComplete}
      style={{
        background: `linear-gradient(135deg, ${accentBg}, var(--bg-secondary))`,
        border: `1px solid ${accentBorder}`,
        borderRadius: 'var(--radius-xl, 16px)',
        padding: 'var(--space-6) var(--space-8)',
        marginTop: hasSpacing ? 'var(--space-5)' : 0,
        marginBottom: 'var(--space-5)',
        transition: 'all 0.2s ease-out',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Subtle top accent line */}
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: '2px',
        background: `linear-gradient(90deg, transparent, ${accentColor}, transparent)`,
        opacity: isComplete ? 0.3 : 0.6,
        transition: 'opacity 0.3s ease',
      }} />

      {/* Header: Title + Percentage */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 'var(--space-4)',
        marginBottom: 'var(--space-4)',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          fontSize: 'var(--text-xs)',
          fontWeight: 600,
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-mono, monospace)',
          letterSpacing: '0.02em',
          minWidth: 0,
          flex: 1,
        }}>
          {/* Spinner / Checkmark */}
          {isComplete ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--success)"
              strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
              style={{ flexShrink: 0, animation: 'dash-check-pop 0.3s ease-out' }}>
              <path d="M20 6L9 17l-5-5" />
            </svg>
          ) : (
            <span className="dash-progress-spinner" style={{
              width: 14,
              height: 14,
              border: `2px solid ${accentSoft}`,
              borderTopColor: accentColor,
              borderRadius: '50%',
              animation: 'dash-spin 0.8s linear infinite',
              display: 'inline-block',
              flexShrink: 0,
            }} />
          )}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title}
          </span>
        </div>

        {/* Percentage badge */}
        <div
          style={{
            fontSize: '13px',
            fontFamily: 'var(--font-mono, monospace)',
            fontWeight: 700,
            color: isComplete ? 'var(--success)' : accentColor,
            background: isComplete
              ? 'color-mix(in srgb, var(--success) 8%, transparent)'
              : accentBg,
            padding: '3px 10px',
            borderRadius: 'var(--radius-full)',
            border: `1px solid ${isComplete
              ? 'color-mix(in srgb, var(--success) 20%, transparent)'
              : accentBorder}`,
            flexShrink: 0,
            minWidth: '72px',
            textAlign: 'center',
            transition: 'all 0.2s ease',
            letterSpacing: '0.01em',
          }}
        >
          {indeterminate ? '— %' : `${displayPercent}%`}
        </div>
      </div>

      {/* Progress Track */}
      <div
        className="dash-progress-track"
        style={{
          height: 8,
          background: accentSoft,
          borderRadius: 'var(--radius-full)',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {indeterminate ? (
          <div
            className="dash-progress-fill--indeterminate"
            style={{
              position: 'absolute',
              height: '100%',
              width: '30%',
              borderRadius: 'var(--radius-full)',
              background: `linear-gradient(90deg, transparent, ${accentColor}, transparent)`,
              animation: 'dash-progress-slide 1.5s ease-in-out infinite',
            }}
          />
        ) : (
          <div
            className="dash-progress-fill"
            style={{
              width: `${displayPercent}%`,
              height: '100%',
              borderRadius: 'var(--radius-full)',
              background: isComplete
                ? 'var(--success)'
                : `linear-gradient(90deg, ${accentColor}, ${accentGlow})`,
              boxShadow: isComplete ? 'none' : `0 0 10px ${accentGlow}`,
              transition: 'width 0.3s cubic-bezier(0.16, 1, 0.3, 1), background 0.3s ease',
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            {/* Shimmer effect for active progress */}
            {!isComplete && displayPercent > 0 && (
              <div style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundImage: `linear-gradient(90deg,
                  transparent 0%,
                  color-mix(in srgb, var(--bg-primary) 25%, transparent) 50%,
                  transparent 100%)`,
                backgroundSize: '200% 100%',
                animation: 'dash-shimmer 2s ease-in-out infinite',
                borderRadius: 'var(--radius-full)',
              }} />
            )}
          </div>
        )}
      </div>

      {/* Footer: Stage info + Cancel */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 'var(--space-3)',
        marginTop: 'var(--space-4)',
      }}>
        <div
          className="dash-progress-stage"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            flex: 1,
            minWidth: 0,
          }}
        >
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: '11px',
            color: 'var(--text-tertiary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {stageIcon && (
              <span style={{ color: isComplete ? 'var(--success)' : accentColor, display: 'inline-flex', flexShrink: 0 }}>
                {stageIcon}
              </span>
            )}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }}>
              {stage}
            </span>
          </div>
          {stageDescription && (
            <div style={{
              fontSize: '10px',
              color: 'var(--text-quaternary, var(--text-tertiary))',
              lineHeight: 1.4,
              paddingLeft: stageIcon ? 17 : 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {stageDescription}
            </div>
          )}
        </div>

        {/* Count + Cancel */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexShrink: 0 }}>
          {!indeterminate && total > 0 && (
            <span style={{
              fontSize: '10px',
              fontFamily: 'var(--font-mono, monospace)',
              color: 'var(--text-quaternary, var(--text-tertiary))',
              letterSpacing: '0.02em',
            }}>
              {current}/{total}
            </span>
          )}
          {showCancel && onCancel && !isComplete && (
            <button
              className="btn btn-ghost btn-sm dash-progress-cancel"
              onClick={onCancel}
              aria-label={cancelLabel}
              style={{
                color: 'var(--danger)',
                fontSize: '11px',
                fontWeight: 500,
                padding: '3px 12px',
                height: 'auto',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid color-mix(in srgb, var(--danger) 15%, transparent)',
                background: 'color-mix(in srgb, var(--danger) 5%, transparent)',
                transition: 'all 0.15s ease',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'color-mix(in srgb, var(--danger) 12%, transparent)';
                e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--danger) 30%, transparent)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'color-mix(in srgb, var(--danger) 5%, transparent)';
                e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--danger) 15%, transparent)';
              }}
            >
              {cancelLabel}
            </button>
          )}
        </div>
      </div>

      {/* Optional extra footer content */}
      {footer && (
        <div style={{ marginTop: 'var(--space-2)' }}>
          {footer}
        </div>
      )}
    </div>
  );
}
