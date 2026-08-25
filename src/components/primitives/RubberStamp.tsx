import React from 'react';

interface RubberStampProps {
  label?: string;
  variant?: 'pending' | 'approved';
  className?: string;
}

/**
 * RubberStamp — Physical-feeling circular red/moss rubber audit stamp.
 * As seen in the Swiss Knowledge Atlas reference specification.
 */
export function RubberStamp({
  label = 'PENDING',
  variant = 'pending',
  className = '',
}: RubberStampProps) {
  return (
    <div
      className={`rubber-stamp rubber-stamp--${variant} ${className}`}
      aria-label={`Audit Stamp: ${label}`}
    >
      <span>{label}</span>
    </div>
  );
}
