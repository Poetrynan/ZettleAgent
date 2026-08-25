import { useState, useEffect, useRef } from 'react';
import { onEmbeddingProgress, type EmbeddingProgress } from '../../lib/embeddings';
import { useApp } from '../../contexts/AppContext';

/**
 * Global modal that shows embedding model download progress.
 *
 * Automatically appears when transformers.js starts downloading model files
 * (i.e. the model is not cached locally), and disappears when download completes.
 * Rendered at the App root level so it's visible regardless of the active view.
 */
export function ModelDownloadModal() {
  const { state } = useApp();
  const isZh = state.lang === 'zh';
  const [progress, setProgress] = useState<EmbeddingProgress | null>(null);
  const [visible, setVisible] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    onEmbeddingProgress((p) => {
      setProgress(p);

      // Show modal when a download starts (progress > 0 and < 100)
      if (p.progress > 0 && p.progress < 100) {
        if (hideTimerRef.current) {
          clearTimeout(hideTimerRef.current);
          hideTimerRef.current = null;
        }
        setVisible(true);
      }

      // Auto-hide shortly after reaching 100%
      if (p.progress >= 100) {
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
        hideTimerRef.current = setTimeout(() => {
          setVisible(false);
          setProgress(null);
        }, 800);
      }
    });

    return () => {
      onEmbeddingProgress(null);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  if (!visible || !progress) return null;

  const loadedMB = (progress.loaded / 1048576).toFixed(1);
  const totalMB = (progress.total / 1048576).toFixed(1);
  const pct = Math.round(progress.progress);
  const fileName = progress.file.split('/').pop() || progress.file;

  return (
    <div
      className="modal-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.45)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'fadeIn 0.15s ease-out',
      }}
      role="dialog"
      aria-modal="true"
      aria-label={isZh ? '下载嵌入模型' : 'Downloading Embedding Model'}
    >
      <div
        className="model-download-modal"
        style={{
          background: 'var(--bg-elevated, #FFFFFF)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm, 2px)',
          padding: 'var(--space-6)',
          minWidth: 400,
          maxWidth: 460,
          boxShadow: 'var(--shadow-lg)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <div style={{
            width: 36, height: 36,
            borderRadius: 'var(--radius-sm, 2px)',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            color: 'var(--accent, #3B82F6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)',
              lineHeight: 1.3,
            }}>
              {isZh ? '下载嵌入模型' : 'Downloading Embedding Model'}
            </div>
            <div style={{
              fontSize: '11px', color: 'var(--text-secondary)', marginTop: 2,
            }}>
              {isZh
                ? '首次使用需下载模型（约 131MB），完成后永久离线可用'
                : 'First-time download required. Will work offline afterwards.'}
            </div>
          </div>
        </div>

        {/* File name */}
        <div style={{
          fontSize: '10.5px',
          fontFamily: 'var(--font-mono, monospace)',
          color: 'var(--text-secondary)',
          background: 'var(--bg-secondary)',
          padding: '5px 8px',
          borderRadius: 'var(--radius-sm, 2px)',
          border: '1px solid var(--border)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {fileName}
        </div>

        {/* Progress bar */}
        <div>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
            marginBottom: 'var(--space-2)',
          }}>
            <span style={{
              fontSize: '11px', color: 'var(--text-tertiary)',
            }}>
              {loadedMB} / {totalMB} MB
            </span>
            <span style={{
              fontSize: '16px', fontWeight: 700,
              fontFamily: 'var(--font-mono, monospace)',
              color: 'var(--accent, #3B82F6)',
            }}>
              {pct}%
            </span>
          </div>
          <div style={{
            height: 6,
            background: 'var(--bg-secondary)',
            borderRadius: 'var(--radius-sm, 2px)',
            border: '1px solid var(--border)',
            overflow: 'hidden',
            position: 'relative',
          }}>
            <div style={{
              width: `${pct}%`,
              height: '100%',
              borderRadius: 'var(--radius-sm, 2px)',
              background: 'var(--accent, #3B82F6)',
              transition: 'width 0.2s ease',
            }} />
          </div>
        </div>

        {/* Footer hint */}
        <div style={{
          fontSize: '11px', color: 'var(--text-tertiary)',
          textAlign: 'center', lineHeight: 1.5,
        }}>
          {isZh
            ? '模型仅在首次加载时下载一次，后续对话秒级响应'
            : 'Downloaded once on initial run. Subsequent turns respond instantly.'}
        </div>
      </div>

      <style>{`
        @keyframes dash-bounce {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(3px); }
        }
      `}</style>
    </div>
  );
}
