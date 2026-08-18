import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ breaks: true, gfm: true, async: false });

/**
 * Render untrusted Markdown to HTML that is safe to hand to `dangerouslySetInnerHTML`.
 *
 * Every Markdown string in the app is attacker-influenced: note bodies come from the
 * user's vault (which may be synced, shared, or written by the Agent), canvas sticky
 * notes are stored in `.canvas` files, and web clippings come straight off the network.
 * `marked` passes raw HTML through untouched, so `<img src=x onerror=...>` in a note
 * would otherwise execute inside the Tauri webview — where it can reach the IPC bridge.
 */
export function renderMarkdownSafe(markdown: string | null | undefined): string {
  if (!markdown) return '';
  try {
    const html = marked.parse(markdown) as string;
    return DOMPurify.sanitize(html);
  } catch {
    return '';
  }
}
