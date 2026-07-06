import { useState, useEffect } from 'react';
import { Handle, Position, NodeResizer, useReactFlow } from '@xyflow/react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { t } from '../../lib/i18n';

export function ImageNode({ id, data, selected }: any) {
  const { deleteElements } = useReactFlow();
  const filePath = data.file as string;
  const [imageSrc, setImageSrc] = useState<string>('');
  const [error, setError] = useState(false);

  const name = filePath.replace(/\\/g, '/').split('/').pop() || filePath;

  useEffect(() => {
    try {
      const src = convertFileSrc(filePath);
      setImageSrc(src);
      setError(false);
    } catch {
      setError(true);
    }
  }, [filePath]);

  const handleDelete = () => {
    deleteElements({ nodes: [{ id }] });
  };

  return (
    <div
      className={`image-node-card ${selected ? 'selected' : ''}`}
      style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={100}
        minHeight={80}
        lineStyle={{ borderColor: 'rgba(148, 163, 184, 0.2)', borderStyle: 'dashed' }}
        handleStyle={{ width: 6, height: 6, borderRadius: '50%', background: 'rgba(255,255,255,0.7)', border: '1px solid rgba(148,163,184,0.4)' }}
      />
      <Handle type="target" position={Position.Left} id="left" />
      <Handle type="target" position={Position.Top} id="top" />
      <Handle type="source" position={Position.Right} id="right" />
      <Handle type="source" position={Position.Bottom} id="bottom" />

      {/* Header */}
      <div className="image-node-header">
        <span className="image-node-title" title={name}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <circle cx="8.5" cy="8.5" r="1.5"/>
            <polyline points="21 15 16 10 5 21"/>
          </svg>
          {name}
        </span>
        <button className="note-node-btn" onClick={handleDelete} title={t('canvas.removeCard')}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>

      {/* Image */}
      <div className="image-node-body nodrag nowheel">
        {error ? (
          <div className="image-node-error">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              <line x1="9" y1="9" x2="15" y2="15"/>
              <line x1="15" y1="9" x2="9" y2="15"/>
            </svg>
            <span>Failed to load</span>
          </div>
        ) : (
          <img
            src={imageSrc}
            alt={name}
            className="image-node-img"
            onError={() => setError(true)}
            draggable={false}
          />
        )}
      </div>
    </div>
  );
}
