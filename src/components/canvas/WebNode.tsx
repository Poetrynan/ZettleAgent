import { useState, useRef, useEffect, useCallback } from 'react';
import { Handle, Position, NodeResizer, useReactFlow } from '@xyflow/react';
import { t } from '../../lib/i18n';

export function WebNode({ id, data, selected }: any) {
  const { deleteElements, setNodes } = useReactFlow();
  const [url, setUrl] = useState<string>(data.url || '');
  const [isEditing, setIsEditing] = useState(!data.url);
  const [inputValue, setInputValue] = useState(data.url || '');
  const [loadError, setLoadError] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [showFallbackHint, setShowFallbackHint] = useState(false);
  const [isInteracting, setIsInteracting] = useState(false);
  const [isRenamingTitle, setIsRenamingTitle] = useState(false);
  const [customTitle, setCustomTitle] = useState<string>(data.title || '');
  const inputRef = useRef<HTMLInputElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const displayUrl = url || '';
  const hostname = (() => {
    try { return new URL(displayUrl).hostname; } catch { return displayUrl; }
  })();

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isEditing]);

  useEffect(() => {
    if (!selected) setIsInteracting(false);
  }, [selected]);

  // After iframe loads or after timeout, show a subtle "can't see content?" hint
  useEffect(() => {
    if (!url || isEditing || loadError) return;
    setShowFallbackHint(false);
    const timer = setTimeout(() => {
      setShowFallbackHint(true);
    }, 4000);
    return () => clearTimeout(timer);
  }, [url, isEditing, loadError]);

  const handleSubmit = useCallback(() => {
    let finalUrl = inputValue.trim();
    if (!finalUrl) return;
    if (!/^https?:\/\//i.test(finalUrl)) {
      finalUrl = 'https://' + finalUrl;
    }
    setUrl(finalUrl);
    setLoadError(false);
    setIsLoading(true);
    setIsEditing(false);
    setIsInteracting(false);
    setShowFallbackHint(false);
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, url: finalUrl } } : n
      )
    );
  }, [inputValue, id, setNodes]);

  const handleDelete = useCallback(() => {
    deleteElements({ nodes: [{ id }] });
  }, [deleteElements, id]);

  const handleOpenExternal = useCallback(() => {
    if (url) window.open(url, '_blank');
  }, [url]);

  const isZh = data.lang === 'zh';

  return (
    <div
      className={`web-node-card ${selected ? 'selected' : ''}`}
      style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={250}
        minHeight={200}
        lineStyle={{ borderColor: 'rgba(148, 163, 184, 0.2)', borderStyle: 'dashed' }}
        handleStyle={{ width: 8, height: 8, borderRadius: '50%', background: 'rgba(255,255,255,0.85)', border: '1.5px solid rgba(100,116,139,0.4)', zIndex: 10 }}
      />
      <Handle type="target" position={Position.Left} id="left" />
      <Handle type="target" position={Position.Top} id="top" />
      <Handle type="source" position={Position.Right} id="right" />
      <Handle type="source" position={Position.Bottom} id="bottom" />

      {/* Header */}
      <div className="web-node-header">
        {isRenamingTitle ? (
          <input
            ref={titleInputRef}
            className="web-node-title-input nodrag"
            value={customTitle}
            onChange={(e) => setCustomTitle(e.target.value)}
            onBlur={() => {
              setIsRenamingTitle(false);
              setNodes((nds) => nds.map((n) => n.id === id ? { ...n, data: { ...n.data, title: customTitle } } : n));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') { setCustomTitle(data.title || ''); setIsRenamingTitle(false); }
            }}
            autoFocus
            placeholder={hostname || 'Title'}
          />
        ) : (
          <span
            className="web-node-title web-node-title-editable nodrag"
            title={displayUrl}
            onClick={(e) => { e.stopPropagation(); setIsRenamingTitle(true); }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="2" y1="12" x2="22" y2="12"/>
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
            </svg>
            {customTitle || hostname || (isZh ? '网页嵌入' : 'Web Embed')}
          </span>
        )}
        <div className="web-node-actions">
          {url && (
            <button className="note-node-btn" onClick={() => { setIsEditing(true); setIsInteracting(false); }} title={isZh ? '编辑链接' : 'Edit URL'}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>
          )}
          {url && (
            <button className="note-node-btn" onClick={handleOpenExternal} title={isZh ? '在浏览器中打开' : 'Open in browser'}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/>
                <line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
            </button>
          )}
          <button className="note-node-btn" onClick={handleDelete} title={t('canvas.removeCard')}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="web-node-body" style={{ position: 'relative' }}>
        {isEditing ? (
          <div className="web-node-url-form nodrag">
            <div className="web-node-url-icon">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                <circle cx="12" cy="12" r="10"/>
                <line x1="2" y1="12" x2="22" y2="12"/>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
              </svg>
            </div>
            <div className="web-node-url-row">
              <div className="web-node-url-row-icon">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                </svg>
              </div>
              <input
                ref={inputRef}
                type="text"
                className="input web-node-url-input"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSubmit();
                  if (e.key === 'Escape') { setIsEditing(false); setInputValue(url); }
                }}
                placeholder={isZh ? '输入网址…' : 'Enter URL…'}
              />
              <button className="web-node-url-btn" onClick={handleSubmit}>
                {isZh ? '嵌入' : 'Go'}
              </button>
            </div>
            <div className="web-node-url-hint">
              {isZh
                ? '部分网站可能禁止嵌入（如 Google、GitHub）'
                : 'Some sites may block embedding (Google, GitHub, etc.)'}
            </div>
          </div>
        ) : loadError ? (
          /* ── Load Error Fallback ── */
          <div className="web-node-fallback nodrag">
            <div className="web-node-fallback-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="12" r="10"/>
                <line x1="2" y1="12" x2="22" y2="12"/>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
              </svg>
            </div>
            <div className="web-node-fallback-domain">{hostname}</div>
            <div className="web-node-fallback-msg">
              {isZh ? '无法在此处显示该页面' : 'This page cannot be displayed here'}
            </div>
            <div className="web-node-fallback-reason">
              {isZh ? '可能需要登录、或该网站禁止嵌入' : 'May require login or the site blocks embedding'}
            </div>
            <button className="web-node-fallback-btn" onClick={handleOpenExternal}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/>
                <line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
              {isZh ? '在浏览器中打开' : 'Open in Browser'}
            </button>
            <button className="web-node-fallback-edit" onClick={() => setIsEditing(true)}>
              {isZh ? '更换链接' : 'Change URL'}
            </button>
          </div>
        ) : (
          <>
            {isLoading && (
              <div className="web-node-loading">
                <div className="web-node-spinner" />
              </div>
            )}
            <iframe
              src={url}
              title={hostname}
              className="web-node-iframe"
              style={{ opacity: isLoading ? 0 : 1 }}
              onLoad={() => setIsLoading(false)}
              onError={() => { setLoadError(true); setIsLoading(false); }}
            />
            {/* Interaction overlay */}
            {!isInteracting && !isLoading && (
              <div
                className="embed-interaction-overlay"
                onDoubleClick={(e) => { e.stopPropagation(); setIsInteracting(true); }}
              >
                <div className="embed-overlay-hint">
                  {isZh ? '双击以浏览网页' : 'Double-click to interact'}
                </div>
              </div>
            )}
            {/* Floating fallback hint — appears after 4s */}
            {showFallbackHint && !isInteracting && (
              <div className="web-node-fallback-strip">
                <span>{isZh ? '页面空白？' : "Can't see content?"}</span>
                <button onClick={handleOpenExternal}>
                  {isZh ? '在浏览器中打开' : 'Open in browser'}
                </button>
                <button onClick={() => { setLoadError(true); setShowFallbackHint(false); }}>
                  {isZh ? '显示为链接卡片' : 'Show as link card'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
