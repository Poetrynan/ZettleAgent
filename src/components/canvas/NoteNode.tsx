import { useState, useEffect, useMemo, useCallback } from 'react';
import { Handle, Position, NodeResizer, useReactFlow } from '@xyflow/react';
import { readMarkdownFile, writeMarkdownFile, resolveWikilink } from '../../lib/tauri';
import { MilkdownEditor } from '../editor/MilkdownEditor';
import { useApp } from '../../contexts/AppContext';
import { t } from '../../lib/i18n';
import { renderMarkdownSafe } from '../../lib/sanitizeHtml';
import { prepareNoteMarkdown } from './cardContent';

const baseName = (p: string) => p.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/i, '') || p;

export function NoteNode({ id, data, selected }: any) {
  const { setView, setCurrentFile, showToast, state } = useApp();
  const { deleteElements, getNodes, getInternalNode, setNodes, setCenter, getZoom } = useReactFlow();
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const file = data.file as string;
  const color = typeof data.color === 'string' ? data.color : undefined;
  const name = baseName(file);
  const isZh = state.lang === 'zh';

  // LOD zoom level from canvas parent
  const zoom: number = data._zoom ?? 1;
  const lodLevel: 'high' | 'medium' | 'low' = zoom > 0.7 ? 'high' : zoom > 0.3 ? 'medium' : 'low';

  useEffect(() => {
    let active = true;
    setLoading(true);
    readMarkdownFile(file)
      .then((text) => {
        if (!active) return;
        // Subpath rendering — show only the heading section when a subpath is set
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
              if (capturing && level <= captureLevel) break;
            }
            if (capturing) captured.push(line);
          }
          setContent(captured.length > 0 ? captured.join('\n') : text);
        } else {
          setContent(text);
        }
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to read note in NoteNode:', err);
        if (active) {
          setContent(`> ${isZh ? '无法读取' : 'Could not read'} ${file}: ${err}`);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [file, data.subpath, isZh]);

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

  const prepared = useMemo(() => prepareNoteMarkdown(content, name), [content, name]);
  const html = useMemo(() => renderMarkdownSafe(prepared.body), [prepared.body]);

  // LOD: a short summary for low-zoom display
  const summaryText = useMemo(() => {
    if (!prepared.body) return '';
    const lines = prepared.body.split('\n').filter(l => l.trim()).slice(0, 3);
    return lines.map(l => l.replace(/<[^>]+>/g, '').replace(/^#+\s*/, '').replace(/[*_~`]/g, '').trim()).join(' · ');
  }, [prepared.body]);

  /**
   * [[Wikilink]] on a card: if that note is already on this canvas, move there and
   * select it (stay in the canvas). Otherwise — or with Cmd/Ctrl — open the note.
   */
  const handleBodyClick = useCallback(async (e: React.MouseEvent) => {
    const link = (e.target as HTMLElement).closest('a.wikilink') as HTMLElement | null;
    if (!link) return;
    e.preventDefault();
    e.stopPropagation();
    const target = link.dataset.target || '';
    const key = target.toLowerCase().replace(/\.md$/i, '');

    if (!(e.metaKey || e.ctrlKey)) {
      const match = getNodes().find(n => n.type === 'file' && typeof n.data?.file === 'string'
        && baseName(n.data.file as string).toLowerCase() === key);
      if (match) {
        const internal = getInternalNode(match.id);
        const pos = internal?.internals.positionAbsolute ?? match.position;
        const w = match.measured?.width ?? match.width ?? 400;
        const h = match.measured?.height ?? match.height ?? 300;
        setNodes(nds => nds.map(n => (n.selected === (n.id === match.id) ? n : { ...n, selected: n.id === match.id })));
        setCenter(pos.x + w / 2, pos.y + h / 2, { zoom: Math.max(getZoom(), 0.8), duration: 420 });
        return;
      }
    }

    const path = await resolveWikilink(target).catch(() => null);
    if (path) {
      setCurrentFile(path);
      setView('note');
    } else {
      showToast(isZh ? `找不到笔记「${target}」` : `Note not found: ${target}`, 'info');
    }
  }, [getNodes, getInternalNode, setNodes, setCenter, getZoom, setCurrentFile, setView, showToast, isZh]);

  const cardStyle = { width: '100%', height: '100%', '--card-color': color ?? 'transparent' } as React.CSSProperties;
  const tags = prepared.tags.slice(0, 4);

  const handles = (
    <>
      <Handle type="target" position={Position.Left} id="left" />
      <Handle type="target" position={Position.Top} id="top" />
      <Handle type="source" position={Position.Right} id="right" />
      <Handle type="source" position={Position.Bottom} id="bottom" />
    </>
  );

  // ── LOD: LOW zoom — title + one-line summary ──
  if (lodLevel === 'low') {
    return (
      <div
        className={`note-node-card zc-card zc-card--note note-node-lod-low ${color ? 'has-color' : ''} ${selected ? 'selected' : ''}`}
        data-highlight={data?._highlight ? 'true' : undefined}
        style={cardStyle}
      >
        {handles}
        <div className="note-node-lod-title">{name}</div>
        {summaryText && <div className="note-node-lod-summary">{summaryText}</div>}
      </div>
    );
  }

  return (
    <div
      className={`note-node-card zc-card zc-card--note ${color ? 'has-color' : ''} ${selected ? 'selected' : ''} ${isEditing ? 'is-editing' : ''}`}
      data-highlight={data?._highlight ? 'true' : undefined}
      style={cardStyle}
    >
      <NodeResizer isVisible={selected} minWidth={200} minHeight={150} />
      {handles}

      <div className="note-node-header zc-card-header">
        <span className="note-node-title zc-card-title" title={data.subpath ? `${name} ${data.subpath}` : name}>
          <span className="zc-card-title-text">{name}</span>
          {data.subpath && <span className="note-node-subpath">{data.subpath}</span>}
        </span>
        <div className="note-node-actions zc-card-actions">
          <button
            className={`note-node-btn zc-icon-btn ${isEditing ? 'active' : ''}`}
            onClick={() => setIsEditing(!isEditing)}
            title={isEditing ? t('canvas.viewMode') : t('canvas.editMode')}
          >
            {isEditing ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            )}
          </button>
          <button className="note-node-btn zc-icon-btn" onClick={handleOpenNote} title={t('canvas.openNote')}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17 17 7M8 7h9v9"/></svg>
          </button>
          <button className="note-node-btn zc-icon-btn" onClick={handleDelete} title={t('canvas.removeCard')}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </div>

      {(tags.length > 0 || prepared.type) && !isEditing && (
        <div className="zc-card-tags">
          {prepared.type && <span className="zc-chip zc-chip--type">{prepared.type}</span>}
          {tags.map(tag => <span key={tag} className="zc-chip">#{tag}</span>)}
        </div>
      )}

      <div className="note-node-body zc-card-body nodrag nowheel" onClick={handleBodyClick}>
        {loading ? (
          <div className="note-node-skeleton">
            <div className="note-node-skeleton-line" />
            <div className="note-node-skeleton-line" />
            <div className="note-node-skeleton-line" />
          </div>
        ) : isEditing && lodLevel === 'high' ? (
          <MilkdownEditor value={content} onChange={handleSave} />
        ) : (
          <div className="note-node-preview text-node-markdown" dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </div>
    </div>
  );
}
