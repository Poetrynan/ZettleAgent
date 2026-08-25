import React, { useState } from 'react';
import { exportCanvas, saveCanvasToFile, type CanvasExportOptions } from '../../lib/tauri';
import { save } from '@tauri-apps/plugin-dialog';
import { getLang } from '../../lib/i18n';
import {
  IconDownload,
  IconClose,
  IconCheck,
  IconCanvas,
  IconSparkle,
  IconSliders,
} from '../icons';

interface CanvasExportProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CanvasExport({ isOpen, onClose }: CanvasExportProps) {
  const isZh = getLang() === 'zh';

  const LAYOUTS = [
    {
      id: 'force-directed' as const,
      label: isZh ? '力导向布局' : 'Force-Directed',
      desc: isZh ? '物理引力模拟 · 推荐' : 'Physics simulation · Recommended',
      badge: 'FORCE',
      icon: (
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <circle cx="4" cy="6" r="2" />
          <circle cx="20" cy="6" r="2" />
          <circle cx="4" cy="18" r="2" />
          <circle cx="20" cy="18" r="2" />
          <line x1="6" y1="7" x2="10" y2="10" />
          <line x1="18" y1="7" x2="14" y2="10" />
          <line x1="6" y1="17" x2="10" y2="14" />
          <line x1="18" y1="17" x2="14" y2="14" />
        </svg>
      ),
    },
    {
      id: 'hierarchical' as const,
      label: isZh ? '层次结构布局' : 'Hierarchical Tree',
      desc: isZh ? '有向树状层级' : 'Directed DAG tree structure',
      badge: 'TREE-DAG',
      icon: (
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="3" width="6" height="4" rx="1" />
          <rect x="3" y="17" width="6" height="4" rx="1" />
          <rect x="15" y="17" width="6" height="4" rx="1" />
          <path d="M12 7v5M6 17v-3a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v3" />
        </svg>
      ),
    },
    {
      id: 'circular' as const,
      label: isZh ? '同心环形布局' : 'Circular Ring',
      desc: isZh ? '同心圆环围绕排列' : 'Concentric circular cluster',
      badge: 'CIRCULAR',
      icon: (
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="3" />
          <circle cx="12" cy="3" r="1.5" />
          <circle cx="21" cy="12" r="1.5" />
          <circle cx="12" cy="21" r="1.5" />
          <circle cx="3" cy="12" r="1.5" />
        </svg>
      ),
    },
    {
      id: 'grid' as const,
      label: isZh ? '正交网格布局' : 'Compact Grid',
      desc: isZh ? '紧凑等距矩阵阵列' : 'Equidistant matrix array',
      badge: 'GRID-ARRAY',
      icon: (
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      ),
    },
  ];

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
        title: isZh ? '保存 Obsidian Canvas 文件' : 'Save Obsidian Canvas File',
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
      }, 1500);
    } catch (err) {
      setError(String(err));
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-container"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '560px',
          background: 'var(--bg-primary)',
          borderRadius: 'var(--radius-lg, 8px)',
          border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-xl, 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1))',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div style={{
          padding: 'var(--space-4) var(--space-5)',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'var(--bg-secondary)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <div style={{
              width: 32,
              height: 32,
              borderRadius: 'var(--radius-sm, 4px)',
              background: 'var(--bg-primary)',
              border: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--accent-primary)',
            }}>
              <IconCanvas size={18} />
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: 'var(--text-md, 15px)', fontWeight: 600, color: 'var(--text-primary)' }}>
                {isZh ? '导出知识图谱画布' : 'Export Knowledge Canvas'}
              </h2>
              <div style={{ fontSize: 'var(--text-xs, 12px)', color: 'var(--text-tertiary)', marginTop: 2, fontFamily: 'var(--font-mono, monospace)' }}>
                Obsidian JSON Canvas 1.0
              </div>
            </div>
          </div>
          <button
            className="btn btn-ghost btn-icon-sm"
            onClick={onClose}
            style={{ borderRadius: 'var(--radius-sm, 4px)' }}
          >
            <IconClose size={16} />
          </button>
        </div>

        {/* Content */}
        <div style={{
          padding: 'var(--space-5)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
          overflowY: 'auto',
          maxHeight: '72vh',
        }}>
          {/* Layout Selector */}
          <div>
            <div style={{
              fontSize: 'var(--text-xs, 12px)',
              fontWeight: 600,
              color: 'var(--text-secondary)',
              marginBottom: 'var(--space-3)',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}>
              {isZh ? '拓扑布局算法' : 'Layout Algorithm'}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 'var(--space-3)' }}>
              {LAYOUTS.map((l) => {
                const isActive = options.layout === l.id;
                return (
                  <div
                    key={l.id}
                    onClick={() => setOptions({ ...options, layout: l.id })}
                    style={{
                      padding: 'var(--space-3) var(--space-4)',
                      borderRadius: 'var(--radius-md, 6px)',
                      border: isActive
                        ? '1px solid var(--accent-primary)'
                        : '1px solid var(--border)',
                      background: isActive
                        ? 'color-mix(in srgb, var(--accent-primary) 8%, transparent)'
                        : 'var(--bg-secondary)',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                      transition: 'all 0.15s ease',
                      userSelect: 'none',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: isActive ? 'var(--accent-primary)' : 'var(--text-primary)' }}>
                        <span style={{ display: 'flex' }}>{l.icon}</span>
                        <span style={{ fontSize: 'var(--text-sm, 13px)', fontWeight: 600 }}>{l.label}</span>
                      </div>
                      <span style={{
                        fontSize: '9px',
                        fontFamily: 'var(--font-mono, monospace)',
                        color: 'var(--text-tertiary)',
                        background: 'var(--bg-primary)',
                        padding: '1px 5px',
                        borderRadius: 'var(--radius-sm, 3px)',
                        border: '1px solid var(--border-subtle, var(--border))',
                      }}>
                        {l.badge}
                      </span>
                    </div>
                    <div style={{
                      fontSize: '11px',
                      color: 'var(--text-tertiary)',
                      lineHeight: 1.4,
                      paddingLeft: '24px',
                    }}>
                      {l.desc}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Toggle Options */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {[
              {
                key: 'includeOrphans' as const,
                label: isZh ? '包含孤立节点' : 'Include Orphan Notes',
                desc: isZh ? '同时导出无双向链接连接的独立笔记卡片' : 'Export isolated notes without incoming or outgoing links',
              },
              {
                key: 'colorByType' as const,
                label: isZh ? '按方法论类型着色' : 'Color Code by Note Type',
                desc: isZh ? '根据卡片盒分类（概念、实体、文献、事实）赋予规范视觉色彩' : 'Assign visual color accents based on Zettelkasten note types',
              },
            ].map((opt) => (
              <label
                key={opt.key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: 'var(--space-3) var(--space-4)',
                  borderRadius: 'var(--radius-md, 6px)',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border)',
                  cursor: 'pointer',
                  transition: 'background 0.15s ease',
                  userSelect: 'none',
                }}
              >
                <div>
                  <div style={{ fontSize: 'var(--text-sm, 13px)', fontWeight: 600, color: 'var(--text-primary)' }}>
                    {opt.label}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: 2 }}>
                    {opt.desc}
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={options[opt.key] as boolean}
                  onChange={(e) => setOptions({ ...options, [opt.key]: e.target.checked })}
                  style={{ width: 16, height: 16, accentColor: 'var(--accent-primary)', cursor: 'pointer' }}
                />
              </label>
            ))}
          </div>

          {/* Advanced Parameters */}
          <div style={{
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md, 6px)',
            background: 'var(--bg-secondary)',
            overflow: 'hidden',
          }}>
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              style={{
                width: '100%',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 'var(--space-3) var(--space-4)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: 'var(--text-xs, 12px)',
                fontWeight: 600,
                color: 'var(--text-secondary)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <IconSliders size={14} />
                <span>{isZh ? '高级排版与节点参数' : 'Advanced Typography & Spacing'}</span>
              </div>
              <span style={{
                display: 'inline-block',
                transition: 'transform 0.2s ease',
                transform: showAdvanced ? 'rotate(90deg)' : 'rotate(0deg)',
                fontSize: '10px',
                color: 'var(--text-tertiary)',
              }}>
                ▶
              </span>
            </button>

            {showAdvanced && (
              <div style={{
                padding: 'var(--space-4)',
                borderTop: '1px solid var(--border)',
                background: 'var(--bg-primary)',
                display: 'grid',
                gridTemplateColumns: 'repeat(2, 1fr)',
                gap: 'var(--space-3)',
              }}>
                {[
                  { label: isZh ? '节点宽度 (px)' : 'Node Width (px)', value: options.nodeWidth, key: 'nodeWidth' as const, min: 200, max: 800, step: 50 },
                  { label: isZh ? '节点高度 (px)' : 'Node Height (px)', value: options.nodeHeight, key: 'nodeHeight' as const, min: 150, max: 600, step: 50 },
                  { label: isZh ? '节点间距 (px)' : 'Spacing (px)', value: options.spacing, key: 'spacing' as const, min: 50, max: 300, step: 10 },
                  { label: isZh ? '最大导出节点数' : 'Max Nodes', value: options.maxNodes, key: 'maxNodes' as const, min: 10, max: 500, step: 10 },
                ].map((p) => (
                  <div key={p.key}>
                    <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-tertiary)', marginBottom: 4, display: 'block' }}>
                      {p.label}
                    </label>
                    <input
                      type="number"
                      className="input"
                      value={p.value}
                      onChange={(e) => setOptions({ ...options, [p.key]: parseFloat(e.target.value) || 0 })}
                      min={p.min}
                      max={p.max}
                      step={p.step}
                      style={{
                        width: '100%',
                        fontSize: '12px',
                        fontFamily: 'var(--font-mono, monospace)',
                        padding: '6px 10px',
                        borderRadius: 'var(--radius-sm, 4px)',
                        border: '1px solid var(--border)',
                        background: 'var(--bg-secondary)',
                      }}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Error Message */}
          {error && (
            <div style={{
              padding: 'var(--space-3) var(--space-4)',
              borderRadius: 'var(--radius-md, 6px)',
              background: 'rgba(239, 68, 68, 0.08)',
              border: '1px solid rgba(239, 68, 68, 0.2)',
              fontSize: '12px',
              color: 'var(--danger, #EF4444)',
            }}>
              <strong>{isZh ? '导出失败：' : 'Export failed: '}</strong>{error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: 'var(--space-3) var(--space-5)',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: 'var(--space-2)',
          background: 'var(--bg-secondary)',
        }}>
          <button
            className="btn btn-sm btn-ghost"
            onClick={onClose}
            style={{ borderRadius: 'var(--radius-sm, 4px)', fontSize: '13px' }}
          >
            {isZh ? '取消' : 'Cancel'}
          </button>
          <button
            className={`btn btn-sm ${exportSuccess ? 'btn-success' : 'btn-primary'}`}
            onClick={handleExport}
            disabled={isExporting}
            style={{
              borderRadius: 'var(--radius-sm, 4px)',
              fontSize: '13px',
              gap: 6,
              padding: '6px 18px',
            }}
          >
            {isExporting && <span className="spinner" style={{ width: 14, height: 14 }} />}
            {exportSuccess ? (
              <><IconCheck size={14} /> {isZh ? '导出成功' : 'Exported'}</>
            ) : (
              <><IconDownload size={14} /> {isExporting ? (isZh ? '生成中…' : 'Generating…') : (isZh ? '导出 Canvas' : 'Export Canvas')}</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
