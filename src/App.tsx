import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { AppProvider, useApp } from './contexts/AppContext';
import { Sidebar } from './components/layout/Sidebar';
import { ResizablePanel } from './components/layout/ResizablePanel';
import { MarkdownViewer } from './components/editor/MarkdownViewer';
import { SmartChat } from './components/chat/SmartChat';
import { Dashboard } from './components/dashboard/Dashboard';
import { Settings } from './components/settings/Settings';
import { Bases } from './components/dashboard/Bases';
import { IconDashboard, IconSettings, IconChat, IconLink, IconFile, IconCanvas, IconCalendar, IconSidebar, IconNetwork, IconChart, IconStack } from './components/icons';
import { KnowledgeGraph } from './components/dashboard/KnowledgeGraph';
import DailyCalendar from './components/calendar/DailyCalendar';
import { InteractiveCanvas } from './components/canvas/InteractiveCanvas';
import { openOrCreateDailyNote } from './lib/dailyNote';

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
import './styles/onboarding.css';
import './styles/splash.css';
import './styles/search-panel.css';

function AppLayout() {
  const { state, setView, toggleChat, setCurrentFile, toggleSidebar, showToast, closeSplit } = useApp();
  const { view } = state;
  const currentView = view;
  const [isSearchPanelOpen, setIsSearchPanelOpen] = useState(false);

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
        {/* Toolbar */}
        <div className="app-toolbar">
          <div className="app-toolbar-left">
            <button
              className={`btn btn-icon-sm app-toolbar-sidebar-btn ${state.isSidebarOpen ? 'active' : ''}`}
              onClick={toggleSidebar}
              title={state.lang === 'zh' ? '切换侧边栏 (Ctrl+B)' : 'Toggle Sidebar (Ctrl+B)'}
            >
              <IconSidebar size={16} />
            </button>
            <div className="toolbar-nav-group">
              <button
                className={`toolbar-nav-btn ${currentView === 'dashboard' ? 'active' : ''}`}
                onClick={() => setView('dashboard')}
                title={t('toolbar.dashboard')}
              >
                <IconChart size={14} /> <span>{t('toolbar.dashboard')}</span>
              </button>
              <button
                className={`toolbar-nav-btn ${currentView === 'note' ? 'active' : ''}`}
                onClick={() => setView('note')}
                title={t('toolbar.note')}
              >
                <IconFile size={14} /> <span>{t('toolbar.note')}</span>
              </button>
              <button
                className={`toolbar-nav-btn ${currentView === 'graph' ? 'active' : ''}`}
                onClick={() => setView('graph')}
                title={t('toolbar.graph')}
              >
                <IconNetwork size={14} /> <span>{t('toolbar.graph')}</span>
              </button>
              <button
                className={`toolbar-nav-btn ${currentView === 'canvas' ? 'active' : ''}`}
                onClick={() => setView('canvas')}
                title={t('toolbar.canvas')}
              >
                <IconCanvas size={14} /> <span>{t('toolbar.canvas')}</span>
              </button>
              <button
                className={`toolbar-nav-btn ${currentView === 'bases' ? 'active' : ''}`}
                onClick={() => setView('bases')}
                title={t('toolbar.bases')}
              >
                <IconStack size={14} /> <span>{t('toolbar.bases')}</span>
              </button>
              <button
                className={`toolbar-nav-btn ${currentView === 'calendar' ? 'active' : ''}`}
                onClick={() => setView('calendar')}
                title={t('toolbar.calendar')}
              >
                <IconCalendar size={14} /> <span>{t('toolbar.calendar')}</span>
              </button>
              <button
                className={`toolbar-nav-btn ${currentView === 'settings' ? 'active' : ''}`}
                onClick={() => setView('settings')}
                title={t('settings.title')}
              >
                <IconSettings size={14} /> <span>{t('settings.title')}</span>
              </button>
            </div>
          </div>
          <div className="app-toolbar-actions">
            <button
              className={`btn btn-icon-sm chat-toggle-btn ${state.isChatOpen ? 'active' : ''}`}
              onClick={toggleChat}
              title={t('toolbar.chat')}
            >
              <IconChat size={16} />
            </button>
          </div>
        </div>

        <div className="view-host">
          {/* Always mount Dashboard + Graph so their state persists across tab switches */}
          <div className="view-scroll" style={{ display: currentView === 'dashboard' ? 'block' : 'none' }}>
            <Dashboard />
          </div>
          <div className="view-scroll" style={{ display: currentView === 'graph' ? 'block' : 'none', overflow: 'hidden' }}>
            <KnowledgeGraph />
          </div>
          <div className="view-scroll" style={{ display: currentView === 'canvas' ? 'block' : 'none', overflow: 'hidden' }}>
            <InteractiveCanvas />
          </div>
          <div className="view-scroll" style={{ display: currentView === 'bases' ? 'flex' : 'none', overflow: 'hidden' }}>
            <Bases />
          </div>
          <div className="view-scroll" style={{ display: currentView === 'calendar' ? 'block' : 'none', overflow: 'hidden' }}>
            <DailyCalendar />
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
