import React from 'react';
import { IconFile, IconGlobe, IconLink, IconCanvas } from '../icons';

interface ProvenanceLineProps {
  sourceType?: 'file' | 'web' | 'link' | 'canvas' | 'model';
  label: string;
  subpath?: string;
  meta?: string;
  onClick?: () => void;
  className?: string;
}

/**
 * ProvenanceLine — An auditable provenance marker showing where an object or knowledge snippet originates.
 */
export function ProvenanceLine({
  sourceType = 'file',
  label,
  subpath,
  meta,
  onClick,
  className = '',
}: ProvenanceLineProps) {
  const renderIcon = () => {
    switch (sourceType) {
      case 'web':
        return <IconGlobe size={12} />;
      case 'canvas':
        return <IconCanvas size={12} />;
      case 'link':
        return <IconLink size={12} />;
      case 'file':
      default:
        return <IconFile size={12} />;
    }
  };

  const isClickable = !!onClick;

  return (
    <div
      className={`provenance-line ${isClickable ? 'provenance-line--clickable' : ''} ${className}`}
      onClick={onClick}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onKeyDown={isClickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      title={label}
    >
      <span className="provenance-line__icon" aria-hidden="true">
        {renderIcon()}
      </span>
      <span className="provenance-line__label">{label}</span>
      {subpath && <span className="provenance-line__subpath">#{subpath}</span>}
      {meta && <span className="provenance-line__meta">{meta}</span>}
    </div>
  );
}
