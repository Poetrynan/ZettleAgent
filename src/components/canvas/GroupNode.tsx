import { useState, memo, useCallback } from 'react';
import { NodeResizer, useReactFlow } from '@xyflow/react';
import { t } from '../../lib/i18n';

// 性能优化: 自定义比较函数，只在关键 props 变化时重渲染
const arePropsEqual = (prev: any, next: any) => {
  return (
    prev.id === next.id &&
    prev.selected === next.selected &&
    prev.data.label === next.data.label &&
    prev.data.color === next.data.color &&
    prev.resizing === next.resizing &&
    prev.dragging === next.dragging
  );
};

export const GroupNode = memo(function GroupNode({ id, data, selected }: any) {
  const { deleteElements } = useReactFlow();
  const [label, setLabel] = useState<string>(data.label || '');
  // Older groups stored 'var(--border-color)'; treat that (and no colour) as neutral graphite.
  const hue = typeof data.color === 'string' && data.color && !data.color.includes('border-color')
    ? data.color
    : 'var(--text-tertiary)';

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setLabel(e.target.value);
    data.label = e.target.value;
    if (data.onChange) {
      data.onChange(id, e.target.value);
    }
  }, [id, data]);

  const handleDelete = useCallback(() => {
    deleteElements({ nodes: [{ id }] });
  }, [deleteElements, id]);

  return (
    <div
      className={`group-node-frame zc-group ${selected ? 'selected' : ''}`}
      style={{ width: '100%', height: '100%', '--group-hue': hue } as React.CSSProperties}
    >
      <NodeResizer isVisible={selected} minWidth={200} minHeight={150} />
      <input
        type="text"
        className="group-node-label-input zc-group-label nodrag nowheel"
        value={label}
        onChange={handleChange}
        placeholder={t('canvas.groupPlaceholder')}
        size={Math.max(6, Math.min(40, (label || t('canvas.groupPlaceholder')).length + 2))}
      />
      {/* Remove — visible while selected */}
      {selected && (
        <button
          className="note-node-btn zc-icon-btn group-node-delete-btn zc-group-remove nodrag"
          onClick={handleDelete}
          title={t('canvas.removeGroup')}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      )}
    </div>
  );
}, arePropsEqual);
