import React, { useState, useCallback, useMemo, useEffect, useRef, lazy, Suspense } from 'react';
import { AppProvider, useApp } from './contexts/AppContext';
import { Sidebar } from './components/layout/Sidebar';
import { ResizablePanel } from './components/layout/ResizablePanel';
import { ActivityRail } from './components/layout/ActivityRail';
import { WorkstageHeader } from './components/layout/WorkstageHeader';
import { MarkdownViewer } from './components/editor/MarkdownViewer';
import { SmartChat } from './components/chat/SmartChat';
import { Dashboard } from './components/dashboard/Dashboard';
import { Settings } from './components/settings/Settings';
import { IconSidebar, IconChat } from './components/icons';
import type { View } from './contexts/AppContext';
import { openOrCreateDailyNote } from './lib/dailyNote';

/**
 * Views that are heavy *and* not on the launch path are split out of the startup
 * chunk.
 *
 * This is a desktop app: assets are read from local disk, so bytes on the wire
 * are not the point. What these boundaries buy is parse-and-execute time before
 * the window is usable — the graph views alone pulled in ~2.1 MB of three.js and
 * Pixi that every launch evaluated, including the many sessions that never open
 * a graph at all.
 */
const KnowledgeGraph = lazy(() =>
  import('./components/dashboard/KnowledgeGraph').then(m => ({ default: m.KnowledgeGraph })));
const InteractiveCanvas = lazy(() =>
  import('./components/canvas/InteractiveCanvas').then(m => ({ default: m.InteractiveCanvas })));
const Bases = lazy(() =>
  import('./components/dashboard/Bases').then(m => ({ default: m.Bases })));
const DailyCalendar = lazy(() => import('./components/calendar/DailyCalendar'));
const ReviewSession = lazy(() =>
  import('./components/review/ReviewSession').then(m => ({ default: m.ReviewSession })));
const KnowledgeCenter = lazy(() =>
  import('./components/knowledge/KnowledgeCenter').then(m => ({ default: m.KnowledgeCenter })));

import { Toast } from './components/common/Toast';
import { QuickSwitcher } from './components/common/QuickSwitcher';
import { SearchPanel } from './components/layout/SearchPanel';
import { ShortcutsModal } from './components/common/ShortcutsModal';
import { ModelDownloadModal } from './components/common/ModelDownloadModal';
import { SplashScreen } from './components/common/SplashScreen';
import { OnboardingWizard } from './components/onboarding/OnboardingWizard';
import { useHotkeys, HotkeyDef } from './hooks/useHotkeys';
import { t } from './lib/i18n';
import { loadOnboardingComplete } from './lib/storage';
import './styles/index.css';
import './styles/components.css';
/* 知识中心的样式在启动时就要在场：顶栏的待处理角标用的是同一套 class，而知识中心
   自己是懒加载的。 */
import './styles/knowledge-center.css';
import './styles/onboarding.css';
import './styles/splash.css';
import './styles/search-panel.css';

/**
 * Fallback shown while a split-out view's chunk loads. It fills the view host
 * exactly (height:100%, centred spinner) so swapping it for the real view does
 * not shift layout — the container's size is owned by `.view-host`, not by what
 * is inside it.
 */
function ViewLoading() {
  return (
    <div className="empty-state" style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <span className="spinner" />
    </div>
  );
}

function AppLayout() {
  const { state, setView, setPendingDeepLink, toggleChat, setCurrentFile, toggleSidebar, showToast, closeSplit } = useApp();
  const { view } = state;
  const currentView = view;

  // Command strip content: the view's name plus, when editing, the open file.
  const viewTitles: Record<View, string> = {
    dashboard: t('toolbar.dashboard'),
    note: t('toolbar.note'),
    graph: t('toolbar.graph'),
    canvas: t('toolbar.canvas'),
    bases: t('toolbar.bases'),
    calendar: t('toolbar.calendar'),
    review: t('review.navTitle'),
    knowledge: t('knowledge.navTitle'),
    settings: t('settings.title'),
  };
  const currentFileName = state.currentFile ? state.currentFile.split(/[\\/]/).pop() : null;
  const [isSearchPanelOpen, setIsSearchPanelOpen] = useState(false);

  // Which lazily-split views have ever been opened. A view drops into this set
  // the first time it becomes current and never leaves, so its chunk is fetched
  // and parsed once — on demand — and its component then stays mounted to keep
  // the "state survives a tab switch" behaviour the display:none toggles give.
  const [openedViews, setOpenedViews] = useState<Set<string>>(() => new Set([currentView]));
  useEffect(() => {
    setOpenedViews(prev => (prev.has(currentView) ? prev : new Set(prev).add(currentView)));
  }, [currentView]);

  // Split editor divider drag state
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const [splitRatio, setSplitRatio] = useState(0.5);

  useEffect(() => {
    if (!state.isSplitView) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSplit();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [state.isSplitView, closeSplit]);

  const handleSplitDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = splitContainerRef.current;
    if (!container) return;
    const onMouseMove = (ev: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const ratio = (ev.clientX - rect.left) / rect.width;
      setSplitRatio(Math.max(0.2, Math.min(0.8, ratio)));
    };
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }, []);

  // Onboarding state: null = checking, true = done, false = show wizard
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null);

  // Splash screen state
  const [splashProgress, setSplashProgress] = useState(0);
  const [splashStage, setSplashStage] = useState('Initializing...');
  const [splashMinTimeElapsed, setSplashMinTimeElapsed] = useState(false);
  const [initComplete, setInitComplete] = useState(false);

  // Listen for splash progress events from AppContext
  useEffect(() => {
    const handler = (e: Event) => {
      const { progress, stage } = (e as CustomEvent).detail;
      setSplashProgress(progress);
      setSplashStage(stage);
      if (progress >= 100) {
        setInitComplete(true);
      }
    };
    window.addEventListener('splash-progress', handler);
    return () => window.removeEventListener('splash-progress', handler);
  }, []);

  // Listen for vault lint request from AgentPanel and execute lint
  useEffect(() => {
    const handleLintRequest = async (e: Event) => {
      if (!state.vaultPath) return;
      try {
        const { runVaultLint } = await import('./lib/tauri');
        const result = await runVaultLint();
        // Dispatch result back to AgentPanel
        window.dispatchEvent(new CustomEvent('zettel:lint-result', {
          detail: { result },
        }));
      } catch (err) {
        console.warn('[App] Vault lint failed:', err);
      }
    };
    window.addEventListener('zettel:request-lint', handleLintRequest);
    return () => window.removeEventListener('zettel:request-lint', handleLintRequest);
  }, [state.vaultPath]);

  // Listen for global deep-link navigation events
  useEffect(() => {
    const handleOpenView = (e: Event) => {
      const viewName = (e as CustomEvent<View>).detail;
      if (viewName) setView(viewName);
    };
    const handleOpenNote = (e: Event) => {
      const detail = (e as CustomEvent<{ path: string }>).detail;
      if (detail?.path) {
        setPendingDeepLink({ target: 'note', path: detail.path });
        setCurrentFile(detail.path);
        setView('note');
      }
    };
    const handleOpenCanvas = (e: Event) => {
      const detail = (e as CustomEvent<{ path?: string; planId?: string }>).detail;
      setPendingDeepLink({ target: 'canvas', path: detail?.path, planId: detail?.planId });
      if (detail?.path) {
        setCurrentFile(detail.path);
      }
      setView('canvas');
    };
    const handleOpenKnowledge = (e: Event) => {
      const detail = (e as CustomEvent<{ tab?: string; planId?: string }>).detail;
      setPendingDeepLink({ target: 'knowledge', tab: detail?.tab, planId: detail?.planId });
      setView('knowledge');
    };

    window.addEventListener('zettel:open-view', handleOpenView);
    window.addEventListener('open-note', handleOpenNote);
    window.addEventListener('open-canvas', handleOpenCanvas);
    window.addEventListener('open-knowledge-center', handleOpenKnowledge);

    return () => {
      window.removeEventListener('zettel:open-view', handleOpenView);
      window.removeEventListener('open-note', handleOpenNote);
      window.removeEventListener('open-canvas', handleOpenCanvas);
      window.removeEventListener('open-knowledge-center', handleOpenKnowledge);
    };
  }, [setView, setCurrentFile, setPendingDeepLink]);

  // Minimum display: wordmark + tagline shimmer complete (~2.75s) + brief hold
  useEffect(() => {
    const timer = setTimeout(() => setSplashMinTimeElapsed(true), 3000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!state.isLoading) {
      loadOnboardingComplete().then((done) => setOnboardingDone(done));
    }
  }, [state.isLoading]);

  // Shortcuts modal state
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const toggleShortcuts = useCallback(() => setShortcutsOpen(p => !p), []);

  // Global hotkeys
  const hotkeys = useMemo<HotkeyDef[]>(() => [
    { key: '1', ctrl: true, handler: () => setView('dashboard') },
    { key: '2', ctrl: true, handler: () => setView('note') },
    { key: '3', ctrl: true, handler: () => setView('graph') },
    { key: '4', ctrl: true, handler: () => setView('canvas') },
    { key: '5', ctrl: true, handler: () => setView('bases') },
    { key: '6', ctrl: true, handler: () => setView('calendar') },
    { key: '7', ctrl: true, handler: () => setView('settings') },
    { key: '8', ctrl: true, handler: () => setView('review') },
    { key: '9', ctrl: true, handler: () => setView('knowledge') },
    { key: ',', ctrl: true, handler: () => setView('settings') },
    { key: 'l', ctrl: true, handler: () => toggleChat() },
    { key: 'k', ctrl: true, handler: () => {
      window.dispatchEvent(new CustomEvent('zettel:toggle-agent'));
    }},
    { key: 'n', ctrl: true, handler: () => {
      window.dispatchEvent(new CustomEvent('zettel:new-note'));
    }},
    { key: 's', ctrl: true, handler: () => {
      window.dispatchEvent(new CustomEvent('zettel:save-note'));
    }},
    { key: 'j', ctrl: true, handler: () => {
      window.dispatchEvent(new CustomEvent('zettel:toggle-timeline'));
    }},
    { key: 'd', ctrl: true, handler: async () => {
      try {
        const path = await openOrCreateDailyNote();
        setCurrentFile(path);
        setView('note');
      } catch (err) {
        console.error('Daily note failed:', err);
      }
    }},
    { key: 'b', ctrl: true, handler: () => toggleSidebar() },
    { key: 'f', ctrl: true, shift: true, handler: () => setIsSearchPanelOpen(true) },
    { key: '/', ctrl: true, handler: () => toggleShortcuts() },
    { key: 'Escape', handler: () => setShortcutsOpen(false), global: true },
  ], [setView, toggleChat, toggleShortcuts, state.vaultPath, setCurrentFile, toggleSidebar, setIsSearchPanelOpen]);

  useHotkeys(hotkeys);

  // Listen for SearchPanel open requests from sidebar
  useEffect(() => {
    const handler = () => setIsSearchPanelOpen(true);
    window.addEventListener('zettel:open-search-panel', handler);
    return () => window.removeEventListener('zettel:open-search-panel', handler);
  }, []);

  // Splash is ready to exit when BOTH conditions met
  const splashReady = splashMinTimeElapsed && initComplete && !state.isLoading;

  // Background update check (at most once per day)
  useEffect(() => {
    if (!splashReady || !onboardingDone) return;
    let cancelled = false;
    void (async () => {
      const { checkForUpdateNotification } = await import('./lib/updateCheck');
      const info = await checkForUpdateNotification();
      if (cancelled || !info) return;
      showToast(t('update.toastNewVersion').replace('{version}', info.latestVersion), 'info');
    })();
    return () => { cancelled = true; };
  }, [splashReady, onboardingDone, showToast]);

  // Show splash during initial load
  if (state.isLoading || onboardingDone === null) {
    return (
      <SplashScreen
        progress={splashProgress}
        stage={splashStage}
        isReady={false}
      />
    );
  }

  // Show onboarding wizard for first-time users
  if (!onboardingDone) {
    return <OnboardingWizard onComplete={() => setOnboardingDone(true)} />;
  }

  return (
    <>
      {/* Splash overlay — stays mounted until exit animation completes */}
      <SplashScreen
        progress={splashProgress}
        stage={splashStage}
        isReady={splashReady}
      />

      <div className="app-shell">
      {/* Far left: Single unified mode navigation rail */}
      <ActivityRail />

      {/* Left: Sidebar (resizable) */}
      <ResizablePanel
        defaultWidth={280}
        minWidth={180}
        maxWidth={500}
        side="left"
        storageKey="za-sidebar-width"
        style={{ display: state.isSidebarOpen ? 'flex' : 'none' }}
      >
        <Sidebar />
      </ResizablePanel>

      {/* Center: Main content */}
      <div className="app-main">
        <WorkstageHeader
          view={currentView}
          viewTitle={viewTitles[currentView]}
          currentFileName={currentFileName}
          toggleSidebar={toggleSidebar}
          toggleChat={toggleChat}
          isSidebarOpen={state.isSidebarOpen}
          isChatOpen={state.isChatOpen}
        />

        <div className="view-host">
          {/* Dashboard is the landing view, so it stays in the startup chunk and
              always mounted. The rest keep the same "mount once, then never
              unmount" contract — panning, zoom and scroll position survive a tab
              switch — but they only start existing the first time they are asked
              for, which is what lets their code stay out of the launch path. */}
          <div className="view-scroll" style={{ display: currentView === 'dashboard' ? 'block' : 'none' }}>
            <Dashboard />
          </div>
          <div className="view-scroll" style={{ display: currentView === 'graph' ? 'block' : 'none', overflow: 'hidden' }}>
            {openedViews.has('graph') && (
              <Suspense fallback={<ViewLoading />}><KnowledgeGraph /></Suspense>
            )}
          </div>
          <div className="view-scroll" style={{ display: currentView === 'canvas' ? 'block' : 'none', overflow: 'hidden' }}>
            {openedViews.has('canvas') && (
              <Suspense fallback={<ViewLoading />}><InteractiveCanvas /></Suspense>
            )}
          </div>
          <div className="view-scroll" style={{ display: currentView === 'bases' ? 'flex' : 'none', overflow: 'hidden' }}>
            {openedViews.has('bases') && (
              <Suspense fallback={<ViewLoading />}><Bases /></Suspense>
            )}
          </div>
          <div className="view-scroll" style={{ display: currentView === 'calendar' ? 'block' : 'none', overflow: 'hidden' }}>
            {openedViews.has('calendar') && (
              <Suspense fallback={<ViewLoading />}><DailyCalendar /></Suspense>
            )}
          </div>
          {currentView === 'note' && (
            state.isSplitView ? (
              <div className="split-editor-container" ref={splitContainerRef}>
                <div className="split-editor-pane split-editor-pane-primary" style={{ flex: splitRatio }}>
                  <MarkdownViewer paneId="primary" />
                </div>
                <div
                  className="split-editor-divider"
                  onMouseDown={handleSplitDividerMouseDown}
                />
                <div className="split-editor-pane split-editor-pane-secondary" style={{ flex: 1 - splitRatio }}>
                  <MarkdownViewer paneId="secondary" filePath={state.splitFile} />
                </div>
              </div>
            ) : (
              <MarkdownViewer />
            )
          )}
          {currentView === 'settings' && <Settings />}
          {/* Mounted only while active: the session snapshots the queue on mount,
              so keeping it alive in the background would serve a stale deck. */}
          {currentView === 'review' && (
            <Suspense fallback={<ViewLoading />}><ReviewSession /></Suspense>
          )}
          {/* 知识中心也只在活跃时挂载：它每次打开都该显示当下真实的待处理量，
              而不是上次离开时的快照。 */}
          {currentView === 'knowledge' && (
            <Suspense fallback={<ViewLoading />}><KnowledgeCenter /></Suspense>
          )}
        </div>
      </div>

      {/* Right: Chat (resizable) — always mounted to preserve state & background requests */}
      <div style={{
        display: state.isChatOpen ? 'flex' : 'none',
        flexShrink: 0,
      }}>
        <ResizablePanel defaultWidth={360} minWidth={250} maxWidth={700} side="right" storageKey="za-chat-width">
          <SmartChat />
        </ResizablePanel>
      </div>

      {/* Global Toast Notification */}
      <Toast />

      {/* Quick Switcher (Ctrl+P) */}
      <QuickSwitcher />

      {/* Search Panel (Ctrl+Shift+F) */}
      <SearchPanel isOpen={isSearchPanelOpen} onClose={() => setIsSearchPanelOpen(false)} />

      {/* Keyboard Shortcuts Modal (Ctrl+/) */}
      <ShortcutsModal isOpen={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      {/* Global Embedding Model Download Modal */}
      <ModelDownloadModal />
    </div>
    </>
  );
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="app-error-boundary">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <h2 className="app-error-boundary-title">Something went wrong</h2>
          <p className="app-error-boundary-message">
            {this.state.error?.message || 'An unexpected error occurred.'}
          </p>
          <button
            className="app-error-boundary-btn"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  return (
    <ErrorBoundary>
      <AppProvider>
        <AppLayout />
      </AppProvider>
    </ErrorBoundary>
  );
}

export default App;
