import React from 'react';
import { StatusStamp } from './StatusStamp';

interface DecisionGateProps {
  title: string;
  scope?: string;
  impact?: string;
  status?: 'pending' | 'blocked' | 'warning' | 'approved' | 'rejected';
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

/**
 * DecisionGate — A dedicated visual enclosure for items that require human review or approval.
 * Connected with the application's vermilion Decision Line motif.
 */
export function DecisionGate({
  title,
  scope,
  impact,
  status = 'pending',
  actions,
  children,
  className = '',
}: DecisionGateProps) {
  return (
    <div className={`decision-gate decision-gate--${status} ${className}`}>
      <div className="decision-gate__header">
        <div className="decision-gate__title-wrap">
          <StatusStamp variant={status} size="xs" />
          <h4 className="decision-gate__title">{title}</h4>
        </div>
        {scope && <span className="decision-gate__scope">{scope}</span>}
      </div>

      {impact && (
        <div className="decision-gate__impact">
          <span className="decision-gate__impact-label">IMPACT:</span> {impact}
        </div>
      )}

      {children && <div className="decision-gate__body">{children}</div>}

      {actions && <div className="decision-gate__actions">{actions}</div>}
    </div>
  );
}
