import React from 'react';

export const sectionTitle: React.CSSProperties = {
  fontSize: 'var(--text-lg)',
  fontWeight: 600,
  marginBottom: 'var(--space-4)',
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
};

export const rowBetween: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

export const rowLabel: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
};

export const labelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-1)',
  fontSize: 'var(--text-sm)',
  color: 'var(--text-secondary)',
  marginBottom: 'var(--space-1)',
};

export const codeBlock: React.CSSProperties = {
  display: 'block',
  padding: 'var(--space-2)',
  background: 'var(--bg-primary)',
  borderRadius: 'var(--radius-sm)',
  fontSize: 'var(--text-sm)',
  wordBreak: 'break-all',
};
