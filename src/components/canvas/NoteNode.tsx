import { useState, useEffect, useMemo } from 'react';
import { Handle, Position, NodeResizer, useReactFlow } from '@xyflow/react';
import { readMarkdownFile, writeMarkdownFile } from '../../lib/tauri';
import { MilkdownEditor } from '../editor/MilkdownEditor';
import { useApp } from '../../contexts/AppContext';
import { t } from '../../lib/i18n';
import { marked } from 'marked';

export function NoteNode({ id, data, selected }: any) {
  const { setView, setCurrentFile, showToast } = useApp();
  const { deleteElements } = useReactFlow();
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const file = data.file as string;
  const color = data.color as string || '#3b82f6';
  const name = file.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/, '') || file;

  // LOD zoom level from canvas parent
  const zoom: number = data._zoom ?? 1;
  const lodLevel: 'high' | 'medium' | 'low' = zoom > 0.7 ? 'high' : zoom > 0.3 ? 'medium' : 'low';

  useEffect(() => {
    let active = true;
    setLoading(true);
    readMarkdownFile(file)
      .then((text) => {
        if (active) {
          // Phase 29: Subpath rendering — extract heading section if subpath is set
          const subpath = data.subpath as string | undefined;
          if (subpath && subpath.startsWith('#')) {
            const heading = subpath.replace(/^#+\s*/, '').trim();
            const lines = text.split('\n');
            let capturing = false;
            let captureLevel = 0;
            const captured: string[] = [];
            for (const line of lines) {
              const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
              if (headingMatch) {
                const level = headingMatch[1].length;
                const title = headingMatch[2].trim();
                if (!capturing && title === heading) {
                  capturing = true;
                  captureLevel = level;
                  captured.push(line);
                  continue;
                }
                if (capturing && level <= captureLevel) break; // end of section
              }
              if (capturing) captured.push(line);
            }
            setContent(captured.length > 0 ? captured.join('\n') : text);
          } else {
            setContent(text);
          }
          setLoading(false);
        }
      })
      .catch((err) => {
        console.error('Failed to read note in NoteNode:', err);
        if (active) {
          setContent(`# Error\nCould not read ${file}: ${err}`);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [file, data.subpath]);

  const handleSave = async (newVal: string) => {
    setContent(newVal);
    try {
      await writeMarkdownFile(file, newVal);
    } catch (err) {
      console.error('Failed to save note in NoteNode:', err);
      showToast(String(err), 'error');
    }
  };

  const handleOpenNote = () => {
    setCurrentFile(file);
    setView('note');
  };

  const handleDelete = () => {
    deleteElements({ nodes: [{ id }] });
  };

  // LOD: compute a short summary for low-zoom display
  const summaryText = useMemo(() => {
    if (!content) return '';
    const lines = content.split('\n').filter(l => l.trim()).slice(0, 3);
    return lines.map(l => l.replace(/^#+\s*/, '').replace(/[*_~`]/g, '').trim()).join(' · ');
  }, [content]);

  // ── LOD: LOW zoom — ultra-lightweight placeholder ──
  if (lodLevel === 'low') {
    return (
      <div
        className={`note-node-card note-node-lod-low ${selected ? 'selected' : ''}`}
        data-highlight={data?._highlight ? "true" : undefined}
        style={{
          borderLeft: `3px solid ${color}`,
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Handle type="target" position={Position.Left} id="left" />
        <Handle type="target" position={Position.Top} id="top" />
        <Handle type="source" position={Position.Right} id="right" />
        <Handle type="source" position={Position.Bottom} id="bottom" />
        <div className="note-node-lod-title">{name}</div>
        {summaryText && <div className="note-node-lod-summary">{summaryText}</div>}
      </div>
    );
  }

  return (
    <div
      className={`note-node-card ${selected ? 'selected' : ''}`}
      data-highlight={data?._highlight ? "true" : undefined}
      style={{
        borderLeft: `3px solid ${color}`,
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={200}
        minHeight={150}
        lineStyle={{ borderColor: 'rgba(148, 163, 184, 0.2)', borderStyle: 'dashed' }}
        handleStyle={{ width: 6, height: 6, borderRadius: '50%', background: 'rgba(255,255,255,0.7)', border: '1px solid rgba(148,163,184,0.4)' }}
      />
      <Handle type="target" position={Position.Left} id="left" />
      <Handle type="target" position={Position.Top} id="top" />
      <Handle type="source" position={Position.Right} id="right" />
      <Handle type="source" position={Position.Bottom} id="bottom" />

      {/* Header */}
      <div className="note-node-header">
        <span className="note-node-title" title={data.subpath ? `${name} ${data.subpath}` : name}>
          {name}
          {data.subpath && <span className="note-node-subpath">{data.subpath}</span>}
        </span>
        <div className="note-node-actions">
          <button
            className={`note-node-btn ${isEditing ? 'active' : ''}`}
            onClick={() => setIsEditing(!isEditing)}
            title={isEditing ? t('canvas.viewMode') : t('canvas.editMode')}
          >
            {isEditing ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            )}
          </button>
          <button
            className="note-node-btn"
            onClick={handleOpenNote}
            title={t('canvas.openNote')}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>
          </button>
          <button
            className="note-node-btn"
            onClick={handleDelete}
            title={t('canvas.removeCard')}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>

      {/* Content — LOD-aware */}
      <div className="note-node-body nodrag nowheel">
        {loading ? (
          <div className="note-node-skeleton">
            <div className="note-node-skeleton-line" />
            <div className="note-node-skeleton-line" />
            <div className="note-node-skeleton-line" />
            <div className="note-node-skeleton-line" />
          </div>
        ) : lodLevel === 'medium' ? (
          /* Medium zoom: static HTML preview only, no Milkdown */
          <div
            className="note-node-preview text-node-markdown"
            dangerouslySetInnerHTML={{ __html: content ? (marked.parse(content) as string) : '' }}
          />
        ) : isEditing ? (
          <MilkdownEditor value={content} onChange={handleSave} />
        ) : (
          <div
            className="note-node-preview text-node-markdown"
            dangerouslySetInnerHTML={{ __html: content ? (marked.parse(content) as string) : '' }}
          />
        )}
      </div>
    </div>
  );
}

