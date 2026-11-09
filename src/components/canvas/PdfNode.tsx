import { useState, useEffect } from 'react';
import { Handle, Position, NodeResizer, useReactFlow } from '@xyflow/react';
import { readBinaryFile } from '../../lib/tauri';
import { useApp } from '../../contexts/AppContext';

export function PdfNode({ id, data, selected }: any) {
  const { deleteElements } = useReactFlow();
  const { state } = useApp();
  const isZh = (data.lang ?? state.lang) === 'zh';
  const filePath = data.file as string;
  const [blobUrl, setBlobUrl] = useState<string>('');
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isInteracting, setIsInteracting] = useState(false);

  const name = filePath.replace(/\\/g, '/').split('/').pop() || filePath;

  useEffect(() => {
    let revoked = false;
    let url = '';

    (async () => {
      try {
        setLoading(true);
        setError(false);
        const base64 = await readBinaryFile(filePath);
        const binaryStr = atob(base64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: 'application/pdf' });
        url = URL.createObjectURL(blob);
        if (!revoked) {
          setBlobUrl(url);
          setLoading(false);
        }
      } catch (err) {
        console.error('Failed to load PDF:', err);
        if (!revoked) {
          setError(true);
          setLoading(false);
        }
      }
    })();

    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [filePath]);

  // Lock interaction again once the card is no longer selected
  useEffect(() => {
    if (!selected) setIsInteracting(false);
  }, [selected]);

  const handleDelete = () => {
    deleteElements({ nodes: [{ id }] });
  };

  return (
    <div
      className={`pdf-node-card zc-card zc-card--embed ${selected ? 'selected' : ''}`}
      style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      <NodeResizer isVisible={selected} minWidth={300} minHeight={400} />
      <Handle type="target" position={Position.Left} id="left" />
      <Handle type="target" position={Position.Top} id="top" />
      <Handle type="source" position={Position.Right} id="right" />
      <Handle type="source" position={Position.Bottom} id="bottom" />

      <div className="pdf-node-header zc-card-header">
        <span className="pdf-node-title zc-card-title" title={name}>
          <span className="zc-card-kind zc-card-kind--pdf" aria-hidden="true">PDF</span>
          <span className="zc-card-title-text">{name.replace(/\.pdf$/i, '')}</span>
        </span>
        <div className="pdf-node-actions zc-card-actions">
          <button className="note-node-btn zc-icon-btn" onClick={handleDelete} title={isZh ? '从画布移除' : 'Remove from canvas'}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </div>

      <div className="pdf-node-body zc-card-body" style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        {loading ? (
          <div className="pdf-node-loading">
            <div className="pdf-node-spinner" />
          </div>
        ) : error ? (
          <div className="pdf-node-error zc-card-empty">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="9" y1="13" x2="15" y2="13"/>
            </svg>
            <span className="zc-card-empty-title">{isZh ? '无法加载 PDF' : 'Could not load this PDF'}</span>
            <span className="zc-card-empty-detail">{name}</span>
          </div>
        ) : (
          <>
            <embed src={blobUrl} type="application/pdf" className="pdf-node-viewer" style={{ width: '100%', height: '100%', border: 'none' }} />
            {!isInteracting && (
              <div
                className="embed-interaction-overlay"
                onDoubleClick={(e) => { e.stopPropagation(); setIsInteracting(true); }}
              >
                <div className="embed-overlay-hint">
                  {isZh ? '双击以浏览 PDF' : 'Double-click to read'}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
