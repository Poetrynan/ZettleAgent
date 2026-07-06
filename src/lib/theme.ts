/**
 * Theme mode switching — UI chrome in theme-tokens.css; viz surfaces in viz-tokens.css / vizPalette.ts.
 * Tauri: sync native window theme so WebView2 prefers-color-scheme matches OS.
 */
import { applyVizCssVars } from './vizPalette';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'zettelagent-theme';

let mediaQuery: MediaQueryList | null = null;
let mediaListener: ((e: MediaQueryListEvent) => void) | null = null;
let tauriThemeUnlisten: (() => void) | null = null;

function prefersDarkFromMedia(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Resolve effective light/dark — prefers Tauri native theme when available. */
async function resolveThemeAsync(mode: ThemeMode): Promise<ResolvedTheme> {
  if (mode === 'light') return 'light';
  if (mode === 'dark') return 'dark';

  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const native = await getCurrentWindow().theme();
    if (native === 'dark' || native === 'light') return native;
  } catch {
    /* browser dev or non-Tauri */
  }

  return prefersDarkFromMedia() ? 'dark' : 'light';
}

function applyResolvedTheme(resolved: ResolvedTheme) {
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  root.classList.toggle('dark-theme', resolved === 'dark');
  root.style.colorScheme = resolved;
  applyVizCssVars(resolved);
}

/** Push theme to Tauri window chrome + WebView color scheme (Windows WebView2). */
async function syncNativeWindowTheme(mode: ThemeMode, resolved: ResolvedTheme) {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    if (mode === 'system') {
      await win.setTheme(null);
    } else {
      await win.setTheme(resolved);
    }
  } catch {
    /* browser dev — CSS data-theme only */
  }
}

async function unbindSystemListeners() {
  if (mediaQuery && mediaListener) {
    mediaQuery.removeEventListener('change', mediaListener);
    mediaListener = null;
  }
  if (tauriThemeUnlisten) {
    tauriThemeUnlisten();
    tauriThemeUnlisten = null;
  }
}

async function bindSystemListeners(mode: ThemeMode) {
  await unbindSystemListeners();
  if (mode !== 'system') return;

  if (!mediaQuery) {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  }

  const onSystemChange = () => {
    void applyThemeMode('system', false);
  };

  mediaListener = onSystemChange;
  mediaQuery.addEventListener('change', mediaListener);

  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    tauriThemeUnlisten = await getCurrentWindow().onThemeChanged(onSystemChange);
  } catch {
    /* browser dev */
  }
}

async function applyThemeMode(mode: ThemeMode, persist = false) {
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* ignore */
    }
  }

  const resolved = await resolveThemeAsync(mode);
  await syncNativeWindowTheme(mode, resolved);
  applyResolvedTheme(resolved);
  await bindSystemListeners(mode);

  window.dispatchEvent(
    new CustomEvent('zettel:theme-changed', { detail: { mode, resolved } })
  );
}

export function getThemeMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') {
      return saved;
    }
  } catch {
    /* ignore */
  }
  return 'system';
}

export function getResolvedTheme(): ResolvedTheme {
  const mode = getThemeMode();
  if (mode === 'light' || mode === 'dark') return mode;
  return prefersDarkFromMedia() ? 'dark' : 'light';
}

export function setThemeMode(mode: ThemeMode) {
  void applyThemeMode(mode, true);
}

/** Apply saved preference (call once at app boot). */
export function initTheme() {
  void applyThemeMode(getThemeMode(), false);
}
