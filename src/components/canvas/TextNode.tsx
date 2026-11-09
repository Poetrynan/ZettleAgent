import { useState, useRef, useCallback, useMemo, useEffect, memo } from 'react';
import { Handle, Position, NodeResizer, useReactFlow } from '@xyflow/react';
import { t } from '../../lib/i18n';
import { renderMarkdownSafe } from '../../lib/sanitizeHtml';
import { CARD_HUES, cardHue, linkifyWikilinks } from './cardContent';

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

/**
 * Sticky note. One surface: rendered Markdown while you look at it, plain text
 * while you edit it (click into the note, Esc or click away to finish). The
 * stored colour is a hue that CSS mixes into the theme's card background.
 */
export const TextNode = memo(function TextNode({ id, data, selected }: any) {
  const { deleteElements } = useReactFlow();
  const [text, setText] = useState<string>(data.text || '');
  const [hue, setHue] = useState<string>(cardHue(data.color));
  const [editing, setEditing] = useState<boolean>(!data.text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }
  }, [editing]);

  const renderedHtml = useMemo(() => (text ? renderMarkdownSafe(linkifyWikilinks(text)) : ''), [text]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    data.text = e.target.value;
    if (data.onChange) data.onChange(id, e.target.value);
  }, [id, data]);

  const handleColorChange = useCallback((newColor: string) => {
    setHue(newColor);
    data.color = newColor;
  }, [data]);

  const handleDelete = useCallback(() => {
    deleteElements({ nodes: [{ id }] });
  }, [deleteElements, id]);

  return (
    <div
      className={`text-node-sticky zc-sticky ${selected ? 'selected' : ''} ${editing ? 'is-editing' : ''}`}
      style={{ width: '100%', height: '100%', '--sticky-hue': hue } as React.CSSProperties}
    >
      <NodeResizer isVisible={selected} minWidth={140} minHeight={100} />
      <Handle type="target" position={Position.Left} id="left" />
      <Handle type="target" position={Position.Top} id="top" />
      <Handle type="source" position={Position.Right} id="right" />
      <Handle type="source" position={Position.Bottom} id="bottom" />

      {/* Colour + remove, floating above the note while it is hovered or selected */}
      <div className="sticky-color-palette zc-sticky-palette nodrag">
        {CARD_HUES.map((c) => (
          <button
            key={c.value}
            type="button"
            className={`sticky-color-dot ${hue.toLowerCase() === c.value.toLowerCase() ? 'active' : ''}`}
            style={{ '--dot-hue': c.value } as React.CSSProperties}
            title={c.name}
            aria-label={c.name}
            onClick={() => handleColorChange(c.value)}
          />
        ))}
        <span className="zc-sticky-palette-sep" />
        <button type="button" className="zc-sticky-remove" title={t('canvas.removeCard')} onClick={handleDelete}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>

      {editing || !text ? (
        <textarea
          ref={textareaRef}
          className="text-node-textarea nodrag nowheel"
          value={text}
          onChange={handleChange}
          onBlur={() => { if (text) setEditing(false); }}
          onKeyDown={(e) => { if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur(); }}
          placeholder={t('canvas.stickyPlaceholder')}
        />
      ) : (
        <div
          className="zc-sticky-content text-node-markdown nodrag nowheel"
          onDoubleClick={() => setEditing(true)}
          onClick={(e) => { if (selected && !(e.target as HTMLElement).closest('a')) setEditing(true); }}
          dangerouslySetInnerHTML={{ __html: renderedHtml }}
        />
      )}
    </div>
  );
}, arePropsEqual);
