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
  const color = data.color || 'var(--border-color)';

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
      className={`group-node-frame ${selected ? 'selected' : ''}`}
      style={{
        borderColor: color,
        width: '100%',
        height: '100%',
      }}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={200}
        minHeight={150}
        lineStyle={{ borderColor: 'rgba(148, 163, 184, 0.2)', borderStyle: 'dashed' }}
        handleStyle={{ width: 6, height: 6, borderRadius: '50%', background: 'rgba(255,255,255,0.7)', border: '1px solid rgba(148,163,184,0.4)' }}
      />
      <input
        type="text"
        className="group-node-label-input nodrag nowheel"
        value={label}
        onChange={handleChange}
        placeholder={t('canvas.groupPlaceholder')}
      />
      {/* Delete button — visible on select */}
      {selected && (
        <button
          className="note-node-btn group-node-delete-btn nodrag"
          onClick={handleDelete}
          title={t('canvas.removeGroup')}
          style={{
            position: 'absolute',
            top: -12,
            right: 8,
            pointerEvents: 'auto',
          }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      )}
    </div>
  );
}, arePropsEqual);
