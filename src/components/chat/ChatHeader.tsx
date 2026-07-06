import { useRef, useState, useEffect, useCallback, CSSProperties } from 'react';
import { SearchMode } from '../../lib/tauri';
import { IconRobot, IconSearch, IconClose, IconChat } from '../icons';
import { t, getLang } from '../../lib/i18n';

interface ChatHeaderProps {
  mode: 'agent' | 'rag';
  setMode: (mode: 'agent' | 'rag') => void;
  searchMode: SearchMode;
  setSearchMode: (searchMode: SearchMode) => void;
  isLoading: boolean;
  showSessionList: boolean;
  setShowSessionList: (show: boolean | ((p: boolean) => boolean)) => void;
  toggleChat: () => void;
}

const SEARCH_MODES: { key: SearchMode; label: string; labelZh: string }[] = [
  { key: 'hybrid', label: 'Hybrid', labelZh: '混合' },
  { key: 'vector', label: 'Vector', labelZh: '向量' },
  { key: 'fts', label: 'FTS', labelZh: '全文' },
];

export function ChatHeader({
  mode,
  setMode,
  searchMode,
  setSearchMode,
  isLoading,
  showSessionList,
  setShowSessionList,
  toggleChat,
}: ChatHeaderProps) {
  const isZh = getLang() === 'zh';
  const modeGroupRef = useRef<HTMLDivElement>(null);
  const modeBtnRefs = useRef<(HTMLButtonElement | null)[]>([null, null]);
  const [pillStyle, setPillStyle] = useState<CSSProperties>({ opacity: 0 });
  const [pillSwitching, setPillSwitching] = useState(false);
  const switchingRef = useRef(false);
  const isFirstModeMount = useRef(true);

  const modeIndex = mode === 'agent' ? 0 : 1;

  const syncPillPosition = useCallback(() => {
    const group = modeGroupRef.current;
    const btn = modeBtnRefs.current[modeIndex];
    if (!group || !btn || btn.offsetWidth === 0) return;
    setPillStyle({
      left: btn.offsetLeft,
      width: btn.offsetWidth,
      height: btn.offsetHeight,
      opacity: 1,
    });
  }, [modeIndex]);

  // Click switch only — Bezier slide + squish
  useEffect(() => {
    if (isFirstModeMount.current) {
      isFirstModeMount.current = false;
      syncPillPosition();
      return;
    }
    switchingRef.current = true;
    setPillSwitching(true);
    // Enable transition first, then move — so left/width animate from old → new
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        syncPillPosition();
      });
    });
    const timer = window.setTimeout(() => {
      switchingRef.current = false;
      setPillSwitching(false);
    }, 420);
    return () => window.clearTimeout(timer);
  }, [modeIndex]); // eslint-disable-line react-hooks/exhaustive-deps -- animate only on tab switch

  // Resize / layout — snap instantly, no animation
  useEffect(() => {
    const group = modeGroupRef.current;
    if (!group) return;

    const onResize = () => {
      if (switchingRef.current) return;
      syncPillPosition();
    };

    const ro = new ResizeObserver(onResize);
    ro.observe(group);

    const raf = requestAnimationFrame(() => {
      syncPillPosition();
      requestAnimationFrame(syncPillPosition);
    });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [syncPillPosition]);

  return (
    <div className="chat-header-v2">
      {/* Row 1: Mode tabs + actions */}
      <div className="chat-header-row-main">
        <div className="chat-mode-tabs" ref={modeGroupRef} role="tablist" aria-label={isZh ? '对话模式' : 'Chat mode'}>
          <div
            className={`chat-mode-pill-v2${pillSwitching ? ' is-switching' : ''}`}
            style={pillStyle}
            aria-hidden
          />
          <button
            ref={el => { modeBtnRefs.current[0] = el; }}
            role="tab"
            aria-selected={mode === 'agent'}
            className={`chat-mode-tab ${mode === 'agent' ? 'active' : ''} ${isLoading && mode !== 'agent' ? 'locked' : ''}`}
            onClick={() => !isLoading && setMode('agent')}
            disabled={isLoading && mode !== 'agent'}
            title={isLoading && mode !== 'agent' ? t('chat.modeLockedTip' as any) : t('chat.agentModeTip' as any)}
          >
            <span className="chat-mode-tab-icon">
              <IconRobot size={14} />
            </span>
            <span className="chat-mode-tab-label">{t('chat.agentMode' as any)}</span>
          </button>
          <button
            ref={el => { modeBtnRefs.current[1] = el; }}
            role="tab"
            aria-selected={mode === 'rag'}
            className={`chat-mode-tab ${mode === 'rag' ? 'active' : ''} ${isLoading && mode !== 'rag' ? 'locked' : ''}`}
            onClick={() => !isLoading && setMode('rag')}
            disabled={isLoading && mode !== 'rag'}
            title={isLoading && mode !== 'rag' ? t('chat.modeLockedTip' as any) : t('chat.ragModeTip' as any)}
          >
            <span className="chat-mode-tab-icon">
              <IconSearch size={14} />
            </span>
            <span className="chat-mode-tab-label">{t('chat.ragMode' as any)}</span>
          </button>
        </div>

        <div className="chat-header-actions">
          <button
            className={`chat-header-icon-btn ${showSessionList ? 'active' : ''}`}
            onClick={() => setShowSessionList(p => !p)}
            title={t('chat.sessionHistory' as any)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="8" y1="6" x2="21" y2="6"/>
              <line x1="8" y1="12" x2="21" y2="12"/>
              <line x1="8" y1="18" x2="21" y2="18"/>
              <line x1="3" y1="6" x2="3.01" y2="6"/>
              <line x1="3" y1="12" x2="3.01" y2="12"/>
              <line x1="3" y1="18" x2="3.01" y2="18"/>
            </svg>
          </button>
          <button
            className="chat-header-icon-btn"
            onClick={toggleChat}
            title={t('common.close' as any) || 'Close'}
          >
            <IconClose size={16} />
          </button>
        </div>
      </div>

      {/* Row 2: Contextual sub-toolbar */}
      <div className="chat-header-row-sub">
        {mode === 'rag' ? (
          <div className="chat-search-modes">
            <span className="chat-search-modes-label">
              {isZh ? '检索' : 'Search'}
            </span>
            <div className="chat-search-modes-group">
              {SEARCH_MODES.map(m => (
                <button
                  key={m.key}
                  className={`chat-search-mode-chip ${searchMode === m.key ? 'active' : ''}`}
                  onClick={() => setSearchMode(m.key)}
                  title={t(`search.${m.key}Desc` as any)}
                >
                  {isZh ? m.labelZh : m.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="chat-agent-hint">
            <IconChat size={12} />
            <span>{isZh ? 'Agent 可自主调用工具、读写笔记' : 'Agent autonomously uses tools'}</span>
          </div>
        )}
      </div>
    </div>
  );
}
