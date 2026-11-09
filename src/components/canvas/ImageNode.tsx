import { useState, useEffect } from 'react';
import { Handle, Position, NodeResizer, useReactFlow } from '@xyflow/react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { t } from '../../lib/i18n';
import { useApp } from '../../contexts/AppContext';

/** Image card: the picture is the card; the file name shows as a caption on hover. */
export function ImageNode({ id, data, selected }: any) {
  const { deleteElements } = useReactFlow();
  const { state } = useApp();
  const isZh = state.lang === 'zh';
  const filePath = data.file as string;
  const [imageSrc, setImageSrc] = useState<string>('');
  const [error, setError] = useState(false);

  const name = filePath.replace(/\\/g, '/').split('/').pop() || filePath;

  useEffect(() => {
    try {
      setImageSrc(convertFileSrc(filePath));
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
      className={`image-node-card zc-card zc-card--image ${selected ? 'selected' : ''}`}
      style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      <NodeResizer isVisible={selected} minWidth={100} minHeight={80} keepAspectRatio />
      <Handle type="target" position={Position.Left} id="left" />
      <Handle type="target" position={Position.Top} id="top" />
      <Handle type="source" position={Position.Right} id="right" />
      <Handle type="source" position={Position.Bottom} id="bottom" />

      <div className="image-node-body zc-card-body nodrag nowheel">
        {error ? (
          <div className="image-node-error zc-card-empty">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              <circle cx="8.5" cy="8.5" r="1.5"/>
              <polyline points="21 15 16 10 5 21"/>
            </svg>
            <span className="zc-card-empty-title">{isZh ? '无法加载图片' : 'Could not load this image'}</span>
            <span className="zc-card-empty-detail">{name}</span>
          </div>
        ) : (
          <img src={imageSrc} alt={name} className="image-node-img" onError={() => setError(true)} draggable={false} />
        )}
      </div>

      <div className="image-node-header zc-image-caption">
        <span className="image-node-title zc-card-title" title={name}>
          <span className="zc-card-title-text">{name}</span>
        </span>
        <button className="note-node-btn zc-icon-btn" onClick={handleDelete} title={t('canvas.removeCard')}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
    </div>
  );
}
