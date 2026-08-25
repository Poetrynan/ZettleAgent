import React from 'react';

export type StatusStampVariant =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'local'
  | 'source'
  | 'blocked'
  | 'warning'
  | 'ochre'
  | 'moss'
  | 'cobalt'
  | 'vermilion';

interface StatusStampProps {
  variant: StatusStampVariant;
  label?: string;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
  title?: string;
  children?: React.ReactNode;
}

const DEFAULT_LABELS: Record<string, { en: string; zh: string }> = {
  pending: { en: 'PENDING', zh: '待决' },
  approved: { en: 'APPROVED', zh: '已确认' },
  rejected: { en: 'REJECTED', zh: '已拒绝' },
  local: { en: 'LOCAL', zh: '本地' },
  source: { en: 'SOURCE', zh: '来源' },
  blocked: { en: 'BLOCKED', zh: '已阻断' },
  warning: { en: 'REVIEW', zh: '需复核' },
  ochre: { en: 'WAITING', zh: '等待' },
  moss: { en: 'CONFIRMED', zh: '就绪' },
  cobalt: { en: 'RELATION', zh: '关联' },
  vermilion: { en: 'DECISION', zh: '决策' },
};

/**
 * StatusStamp — A technical precision stamp adhering to Swiss Knowledge Atlas principles.
 * Visual words over color-only signals, uppercase mono text with subtle border framing.
 */
export function StatusStamp({
  variant,
  label,
  size = 'xs',
  className = '',
  title,
  children,
}: StatusStampProps) {
  const isZh = typeof document !== 'undefined' && document.documentElement.lang === 'zh';
  const displayLabel = label || children || (DEFAULT_LABELS[variant] ? (isZh ? DEFAULT_LABELS[variant].zh : DEFAULT_LABELS[variant].en) : variant.toUpperCase());

  return (
    <span
      className={`status-stamp status-stamp--${variant} status-stamp--${size} ${className}`}
      title={title}
      data-status={variant}
    >
      {displayLabel}
    </span>
  );
}
