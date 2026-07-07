import { useState, useRef, useCallback, useMemo, memo } from 'react';
import { Handle, Position, NodeResizer, useReactFlow } from '@xyflow/react';
import { t } from '../../lib/i18n';
import { marked } from 'marked';

marked.setOptions({ breaks: true, gfm: true, async: false });

// 亮柔色牌 — 两种模式下统一使用。
// Obsidian 风格：便利签始终为亮色背景 + 深色文字，
// 在暗色画布上作为亮色斑点存在，辨识度高且不脏。
const STICKY_COLORS = [
  { name: 'Cream', value: '#fef9c3' },
  { name: 'Mint', value: '#d1fae5' },
  { name: 'Sky', value: '#dbeafe' },
  { name: 'Rose', value: '#ffe4e6' },
  { name: 'Lavender', value: '#ede9fe' },
  { name: 'Peach', value: '#ffedd5' },
];

// 性能优化: 自定义比较函数
const arePropsEqual = (prev: any, next: any) => {
  return (
    prev.id === next.id &&
    prev.selected === next.selected &&
    prev.data.text === next.data.text &&
    prev.data.color === next.data.color &&
    prev.resizing === next.resizing &&
    prev.dragging === next.dragging
  );
};

export const TextNode = memo(function TextNode({ id, data, selected }: any) {
  const { deleteElements } = useReactFlow();
  const [text, setText] = useState<string>(data.text || '');
  const [color, setColor] = useState<string>(data.color || '#fef08a');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const hasMarkdown = useMemo(() => {
    if (!text) return false;
    return /(\*\*|__|~~|#{1,6}\s|`|^\s*[-*+]\s|^\s*\d+\.\s|^\s*>\s|\[.*\]\(.*\)|!\[|\|.*\|)/m.test(text);
  }, [text]);

  const renderedHtml = useMemo(() => {
    if (!text || !hasMarkdown) return '';
    try { return marked.parse(text) as string; } catch { return ''; }
  }, [text, hasMarkdown]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    data.text = e.target.value;
    if (data.onChange) data.onChange(id, e.target.value);
  }, [id, data]);

  const handleColorChange = useCallback((newColor: string) => {
    setColor(newColor);
    data.color = newColor;
  }, [data]);

  const handleDelete = useCallback(() => {
    deleteElements({ nodes: [{ id }] });
  }, [deleteElements, id]);

  return (
    <div
      className={`text-node-wrapper ${hasMarkdown ? 'text-node-dual' : ''}`}
      style={{ width: '100%', height: '100%' }}
    >
      {/* Editor Card */}
      <div
        className={`text-node-sticky ${selected ? 'selected' : ''}`}
        style={{
          backgroundColor: color,
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
        }}
      >
        <NodeResizer
          isVisible={selected}
          minWidth={hasMarkdown ? 240 : 120}
          minHeight={120}
          lineStyle={{ borderColor: 'rgba(148, 163, 184, 0.2)', borderStyle: 'dashed' }}
          handleStyle={{ width: 6, height: 6, borderRadius: '50%', background: 'rgba(255,255,255,0.7)', border: '1px solid rgba(148,163,184,0.4)' }}
        />
        <Handle type="target" position={Position.Left} id="left" />
        <Handle type="target" position={Position.Top} id="top" />
        <Handle type="source" position={Position.Right} id="right" />
        <Handle type="source" position={Position.Bottom} id="bottom" />

        {/* Color palette + delete */}
        <div className="sticky-color-palette nodrag">
          {STICKY_COLORS.map((c) => (
            <div
              key={c.value}
              className={`sticky-color-dot ${color === c.value ? 'active' : ''}`}
              style={{ backgroundColor: c.value }}
              title={c.name}
              onClick={() => handleColorChange(c.value)}
            />
          ))}
          <div className="canvas-toolbar-divider" style={{ height: 12, margin: '0 2px' }} />
          <div
            className="sticky-color-dot"
            style={{ backgroundColor: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            title={t('canvas.removeCard')}
            onClick={handleDelete}
          >
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </div>
        </div>

        <textarea
          ref={textareaRef}
          className="text-node-textarea nodrag nowheel"
          value={text}
          onChange={handleChange}
          placeholder={t('canvas.stickyPlaceholder')}
        />
      </div>

      {/* Preview Card — slides in when markdown detected */}
      {hasMarkdown && renderedHtml && (
        <div className="text-node-preview-card">
          <div className="text-node-preview-label">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
            Preview
          </div>
          <div
            className="text-node-markdown nodrag nowheel"
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
        </div>
      )}
    </div>
  );
}, arePropsEqual);
