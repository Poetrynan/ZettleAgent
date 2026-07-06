import { useState } from 'react';
import { exportCanvas, saveCanvasToFile, type CanvasExportOptions } from '../../lib/tauri';
import { save } from '@tauri-apps/plugin-dialog';
import { IconDownload, IconClose, IconCheck } from '../icons';

interface CanvasExportProps {
  isOpen: boolean;
  onClose: () => void;
}

const LAYOUTS = [
  { id: 'force-directed', label: '力导向', desc: '物理模拟 · 推荐', icon: '⚡' },
  { id: 'hierarchical', label: '层次布局', desc: '树状结构', icon: '🌳' },
  { id: 'circular', label: '环形布局', desc: '围成圆形', icon: '⭕' },
  { id: 'grid', label: '网格布局', desc: '整齐排列', icon: '▦' },
] as const;

export function CanvasExport({ isOpen, onClose }: CanvasExportProps) {
  const [options, setOptions] = useState<CanvasExportOptions>({
    layout: 'force-directed',
    nodeWidth: 400,
    nodeHeight: 300,
    spacing: 100,
    includeOrphans: false,
    maxNodes: 100,
    colorByType: true,
  });

  const [isExporting, setIsExporting] = useState(false);
  const [exportSuccess, setExportSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  if (!isOpen) return null;

  const handleExport = async () => {
    try {
      setIsExporting(true);
      setError(null);
      setExportSuccess(false);

      const canvasJson = await exportCanvas(options);

      const outputPath = await save({
        defaultPath: 'knowledge-graph.canvas',
        filters: [{ name: 'Canvas', extensions: ['canvas', 'json'] }],
        title: 'Save Canvas File'
      });

      if (!outputPath) {
        setIsExporting(false);
        return;
      }

      await saveCanvasToFile(canvasJson, outputPath);

      setExportSuccess(true);
      setTimeout(() => {
        setExportSuccess(false);
        onClose();
      }, 2000);
    } catch (err) {
      setError(String(err));
    } finally {
      setIsExporting(false);
    }
  };

  const cardBase: React.CSSProperties = {
    padding: '12px 14px',
    borderRadius: '10px',
    cursor: 'pointer',
    transition: 'all 200ms cubic-bezier(0.16, 1, 0.3, 1)',
    border: '1.5px solid transparent',
    userSelect: 'none',
    textAlign: 'left',
  };

  const cardActive: React.CSSProperties = {
    ...cardBase,
    background: 'linear-gradient(135deg, rgba(59,130,246,0.08), rgba(99,102,241,0.06))',
    border: '1.5px solid rgba(59,130,246,0.35)',
    boxShadow: '0 2px 8px rgba(59,130,246,0.1)',
  };

  const cardInactive: React.CSSProperties = {
    ...cardBase,
    background: 'rgba(0,0,0,0.02)',
    border: '1.5px solid rgba(0,0,0,0.06)',
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-container"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 520 }}
      >
        {/* Header */}
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <IconDownload size={18} />
            <div>
              <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)' }}>
                导出知识图谱
              </h2>
              <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: 1 }}>
                Obsidian JSON Canvas 1.0
              </div>
            </div>
          </div>
          <button className="btn btn-ghost btn-icon-sm" onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="modal-content" style={{ display: 'flex', flexDirection: 'column', gap: '20px', padding: '16px 24px' }}>

          {/* Layout Algorithm — visual card selector */}
          <div>
            <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              布局算法
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px' }}>
              {LAYOUTS.map((l) => {
                const isActive = options.layout === l.id;
                return (
                  <div
                    key={l.id}
                    style={isActive ? cardActive : cardInactive}
                    onClick={() => setOptions({ ...options, layout: l.id })}
                    onMouseEnter={(e) => {
                      if (!isActive) e.currentTarget.style.borderColor = 'rgba(0,0,0,0.12)';
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive) e.currentTarget.style.borderColor = 'rgba(0,0,0,0.06)';
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '16px', lineHeight: 1 }}>{l.icon}</span>
                      <span style={{
                        fontSize: '13px',
                        fontWeight: isActive ? 700 : 500,
                        color: isActive ? '#3B82F6' : 'var(--text-primary)',
                      }}>
                        {l.label}
                      </span>
                    </div>
                    <div style={{
                      fontSize: '11px',
                      color: isActive ? 'rgba(59,130,246,0.7)' : 'var(--text-tertiary)',
                      marginTop: '3px',
                      paddingLeft: '24px',
                    }}>
                      {l.desc}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Toggle options — styled as switch cards */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {[
              { key: 'includeOrphans' as const, label: '包含孤立节点', desc: '导出无连接的笔记' },
              { key: 'colorByType' as const, label: '按类型着色', desc: '根据笔记方法论类型赋予不同颜色' },
            ].map((opt) => (
              <label
                key={opt.key}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '10px 14px', borderRadius: '10px',
                  background: 'rgba(0,0,0,0.02)', border: '1px solid rgba(0,0,0,0.06)',
                  cursor: 'pointer', transition: 'background 150ms',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(0,0,0,0.04)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(0,0,0,0.02)')}
              >
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{opt.label}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: 1 }}>{opt.desc}</div>
                </div>
                <input
                  type="checkbox"
                  checked={options[opt.key] as boolean}
                  onChange={(e) => setOptions({ ...options, [opt.key]: e.target.checked })}
                  style={{ width: 16, height: 16, accentColor: '#3B82F6', cursor: 'pointer' }}
                />
              </label>
            ))}
          </div>

          {/* Advanced Settings — collapsible */}
          <div style={{ borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: '12px' }}>
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                display: 'flex', alignItems: 'center', gap: '6px',
                fontSize: '12px', fontWeight: 600, color: 'var(--text-tertiary)',
                transition: 'color 150ms',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-secondary)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-tertiary)')}
            >
              <span style={{
                display: 'inline-block', transition: 'transform 200ms',
                transform: showAdvanced ? 'rotate(90deg)' : 'rotate(0deg)',
                fontSize: '10px',
              }}>▶</span>
              高级参数
            </button>
            {showAdvanced && (
              <div style={{
                marginTop: '12px',
                display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)',
                gap: '10px',
                animation: 'fadeIn 150ms ease-out',
              }}>
                {[
                  { label: '节点宽度', value: options.nodeWidth, key: 'nodeWidth', min: 200, max: 800, step: 50 },
                  { label: '节点高度', value: options.nodeHeight, key: 'nodeHeight', min: 150, max: 600, step: 50 },
                  { label: '节点间距', value: options.spacing, key: 'spacing', min: 50, max: 300, step: 10 },
                  { label: '最大节点', value: options.maxNodes, key: 'maxNodes', min: 10, max: 500, step: 10 },
                ].map((p) => (
                  <div key={p.key}>
                    <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-tertiary)', marginBottom: '4px', display: 'block' }}>
                      {p.label}
                    </label>
                    <input
                      type="number"
                      className="input"
                      value={p.value}
                      onChange={(e) => setOptions({ ...options, [p.key]: parseFloat(e.target.value) })}
                      min={p.min}
                      max={p.max}
                      step={p.step}
                      style={{ fontSize: '13px', padding: '6px 10px' }}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Error */}
          {error && (
            <div style={{
              padding: '10px 14px', borderRadius: '10px',
              background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)',
              fontSize: '12px', color: '#DC2626',
            }}>
              <strong>导出失败：</strong>{error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', padding: '14px 24px', borderTop: '1px solid rgba(0,0,0,0.06)' }}>
          <button className="btn btn-ghost" onClick={onClose} style={{ fontSize: '13px' }}>
            取消
          </button>
          <button
            className={`btn ${exportSuccess ? 'btn-success' : 'btn-primary'}`}
            onClick={handleExport}
            disabled={isExporting}
            style={{ fontSize: '13px', gap: '6px', padding: '8px 20px' }}
          >
            {isExporting && <span className="spinner" style={{ width: 14, height: 14 }} />}
            {exportSuccess ? (
              <><IconCheck size={14} /> 导出成功</>
            ) : (
              <><IconDownload size={14} /> {isExporting ? '生成中...' : '导出 Canvas'}</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
