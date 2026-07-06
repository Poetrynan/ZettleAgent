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
        backdropFilter: 'blur(4px)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'fadeIn 0.2s ease-out',
      }}
      role="dialog"
      aria-modal="true"
      aria-label={isZh ? '下载嵌入模型' : 'Downloading Embedding Model'}
    >
      <div
        className="model-download-modal"
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-xl, 16px)',
          padding: 'var(--space-8) var(--space-10)',
          minWidth: 420,
          maxWidth: 480,
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-5)',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          {/* Animated download icon */}
          <div style={{
            width: 40, height: 40,
            borderRadius: 'var(--radius-full)',
            background: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)',
            border: '1px solid color-mix(in srgb, var(--accent-primary) 20%, transparent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="var(--accent-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              style={{ animation: 'dash-bounce 1.2s ease-in-out infinite' }}>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)',
              lineHeight: 1.3,
            }}>
              {isZh ? '下载嵌入模型' : 'Downloading Embedding Model'}
            </div>
            <div style={{
              fontSize: '12px', color: 'var(--text-tertiary)', marginTop: 2,
            }}>
              {isZh
                ? '首次使用需要下载模型，完成后即可离线使用'
                : 'First-time download required. Will work offline afterwards.'}
            </div>
          </div>
        </div>

        {/* File name */}
        <div style={{
          fontSize: '11px',
          fontFamily: 'var(--font-mono, monospace)',
          color: 'var(--text-tertiary)',
          background: 'var(--bg-primary)',
          padding: '6px 10px',
          borderRadius: 'var(--radius-sm, 6px)',
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
              fontSize: '18px', fontWeight: 700,
              fontFamily: 'var(--font-mono, monospace)',
              color: 'var(--accent-primary)',
            }}>
              {pct}%
            </span>
          </div>
          <div style={{
            height: 8,
            background: 'var(--bg-tertiary)',
            borderRadius: 'var(--radius-full)',
            overflow: 'hidden',
            position: 'relative',
          }}>
            <div style={{
              width: `${pct}%`,
              height: '100%',
              borderRadius: 'var(--radius-full)',
              background: 'linear-gradient(90deg, var(--accent-primary), color-mix(in srgb, var(--accent-primary) 60%, transparent))',
              boxShadow: '0 0 12px color-mix(in srgb, var(--accent-primary) 40%, transparent)',
              transition: 'width 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
              position: 'relative',
              overflow: 'hidden',
            }}>
              {/* Shimmer */}
              <div style={{
                position: 'absolute', inset: 0,
                backgroundImage: `linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--bg-primary) 30%, transparent) 50%, transparent 100%)`,
                backgroundSize: '200% 100%',
                animation: 'dash-shimmer 1.5s ease-in-out infinite',
              }} />
            </div>
          </div>
        </div>

        {/* Footer hint */}
        <div style={{
          fontSize: '11px', color: 'var(--text-quaternary, var(--text-tertiary))',
          textAlign: 'center', lineHeight: 1.5,
        }}>
          {isZh
            ? '模型约 131 MB，下载后自动缓存，后续无需重复下载'
            : 'Model is ~131 MB. Auto-cached after download — no repeat needed.'}
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
