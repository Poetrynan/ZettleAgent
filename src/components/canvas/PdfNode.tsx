import { useState, useEffect } from 'react';
import { Handle, Position, NodeResizer, useReactFlow } from '@xyflow/react';
import { readBinaryFile } from '../../lib/tauri';

export function PdfNode({ id, data, selected }: any) {
  const { deleteElements } = useReactFlow();
  const filePath = data.file as string;
  const [blobUrl, setBlobUrl] = useState<string>('');
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isInteracting, setIsInteracting] = useState(false);

  const name = filePath.replace(/\\/g, '/').split('/').pop() || filePath;

  // 加载高质量PDF
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

  // 自动锁定交互当节点未选中
  useEffect(() => {
    if (!selected) {
      setIsInteracting(false);
    }
  }, [selected]);

  const handleDelete = () => {
    deleteElements({ nodes: [{ id }] });
  };

  return (
    <div
      className={`pdf-node-card ${selected ? 'selected' : ''}`}
      style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={300}
        minHeight={400}
        lineStyle={{ borderColor: 'rgba(148, 163, 184, 0.2)', borderStyle: 'dashed' }}
        handleStyle={{ width: 8, height: 8, borderRadius: '50%', background: 'rgba(255,255,255,0.85)', border: '1.5px solid rgba(100,116,139,0.4)', zIndex: 10 }}
      />
      <Handle type="target" position={Position.Left} id="left" />
      <Handle type="target" position={Position.Top} id="top" />
      <Handle type="source" position={Position.Right} id="right" />
      <Handle type="source" position={Position.Bottom} id="bottom" />

      {/* 头部标题栏 */}
      <div className="pdf-node-header">
        <span className="pdf-node-title" title={name}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
          {name}
        </span>
        <div className="pdf-node-actions">
          <button className="note-node-btn" onClick={handleDelete} title="删除">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      </div>

      {/* 内容区域 */}
      <div className="pdf-node-body" style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        {loading ? (
          <div className="pdf-node-loading">
            <div className="pdf-node-spinner" />
          </div>
        ) : error ? (
          <div className="pdf-node-error">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="9" y1="13" x2="15" y2="13"/>
            </svg>
            <span>无法加载 PDF</span>
            <span style={{ fontSize: 10, opacity: 0.6, wordBreak: 'break-all', textAlign: 'center', maxWidth: '90%' }}>{name}</span>
          </div>
        ) : (
          <>
            {/* 高质量PDF查看器 */}
            <embed
              src={blobUrl}
              type="application/pdf"
              className="pdf-node-viewer"
              style={{ 
                width: '100%', 
                height: '100%', 
                border: 'none',
                filter: 'drop-shadow(0 0 0 transparent)' // 优化渲染
              }}
            />
            {/* 交互覆盖层 */}
            {!isInteracting && (
              <div
                className="embed-interaction-overlay"
                onDoubleClick={(e) => { e.stopPropagation(); setIsInteracting(true); }}
              >
                <div className="embed-overlay-hint">
                  双击以浏览 PDF
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
