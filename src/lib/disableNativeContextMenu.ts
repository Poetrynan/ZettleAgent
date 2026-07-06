const IS_TAURI =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Areas that still need the native copy/paste/spellcheck menu. */
function allowNativeContextMenu(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest(
    '.ProseMirror, [contenteditable="true"], input, textarea, select',
  );
}

/**
 * Block the WebView2/Chromium default context menu in the Tauri desktop app.
 * Custom menus (sidebar, canvas, graph, etc.) are unaffected — they listen on
 * the same event in bubble phase after we call preventDefault in capture.
 */
export function initDisableNativeContextMenu() {
  if (!IS_TAURI) return;
  // Keep Inspect available during dev; disable in packaged exe.
  if (import.meta.env.DEV) return;

  document.addEventListener(
    'contextmenu',
    (e) => {
      if (allowNativeContextMenu(e.target)) return;
      e.preventDefault();
    },
    { capture: true },
  );
}
