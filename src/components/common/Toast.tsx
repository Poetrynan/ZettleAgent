import { useApp } from '../../contexts/AppContext';

export function Toast() {
  const { state, hideToast } = useApp();

  if (!state.toast) return null;

  const { message, type } = state.toast;

  const background = type === 'error' ? 'var(--danger-bg)' : type === 'success' ? 'var(--success-bg)' : 'var(--info-bg)';
  const border = `1px solid ${type === 'error' ? 'rgba(239,68,68,0.2)' : type === 'success' ? 'rgba(34,197,94,0.2)' : 'rgba(59,130,246,0.2)'}`;
  const color = type === 'error' ? 'var(--danger)' : type === 'success' ? 'var(--success)' : 'var(--info)';

  return (
    <div
      className="animate-slide-down"
      role="alert"
      style={{
        position: 'fixed',
        top: 20,
        right: 20,
        zIndex: 9999,
        padding: 'var(--space-3) var(--space-4)',
        borderRadius: 'var(--radius-md)',
        background,
        border,
        color,
        fontSize: 'var(--text-sm)',
        boxShadow: 'var(--shadow-md)',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
      }}
    >
      <span>{message}</span>
      <button
        className="btn btn-ghost btn-icon-sm"
        onClick={hideToast}
        style={{ color: 'inherit', padding: 0, minWidth: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        ×
      </button>
    </div>
  );
}
