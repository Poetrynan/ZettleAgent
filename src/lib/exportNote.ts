/**
 * Note export utilities — HTML and PDF export for rendered Markdown content.
 */
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { KATEX_CSS } from '@katex-inlined-css';

/** Fetch a local asset and return its text content (works in Tauri dev + prod). */
async function fetchLocalText(path: string): Promise<string> {
  try {
    const resp = await fetch(path);
    if (resp.ok) return await resp.text();
  } catch { /* ignore */ }
  return '';
}

/**
 * Build a standalone HTML document from rendered markdown content.
 */
function buildHtmlDocument(title: string, htmlContent: string, katexCss: string, hljsCss: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  ${katexCss ? `<style>${katexCss}</style>` : ''}
  ${hljsCss ? `<style>${hljsCss}</style>` : ''}
  <style>
    :root {
      --text-primary: #1E293B;
      --text-secondary: #475569;
      --bg-primary: #FFFFFF;
      --border-color: #E2E8F0;
      --accent: #0EA5E9;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
      line-height: 1.75;
      color: var(--text-primary);
      background: var(--bg-primary);
      max-width: 800px;
      margin: 0 auto;
      padding: 40px 32px;
    }
    h1 { font-size: 2em; font-weight: 700; margin: 1.2em 0 0.6em; border-bottom: 2px solid var(--border-color); padding-bottom: 0.3em; }
    h2 { font-size: 1.5em; font-weight: 600; margin: 1em 0 0.5em; border-bottom: 1px solid var(--border-color); padding-bottom: 0.2em; }
    h3 { font-size: 1.25em; font-weight: 600; margin: 0.8em 0 0.4em; }
    h4, h5, h6 { font-size: 1.1em; font-weight: 600; margin: 0.6em 0 0.3em; }
    p { margin: 0.6em 0; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    blockquote {
      border-left: 4px solid var(--accent);
      padding: 0.5em 1em;
      margin: 1em 0;
      background: #F8FAFC;
      color: var(--text-secondary);
    }
    pre {
      background: #F1F5F9;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 16px;
      overflow-x: auto;
      margin: 1em 0;
      font-size: 0.9em;
    }
    code {
      font-family: 'Fira Code', 'Cascadia Code', 'JetBrains Mono', Consolas, monospace;
      font-size: 0.9em;
    }
    :not(pre) > code {
      background: #F1F5F9;
      padding: 2px 6px;
      border-radius: 4px;
      border: 1px solid var(--border-color);
    }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 1em 0;
    }
    th, td {
      border: 1px solid var(--border-color);
      padding: 8px 12px;
      text-align: left;
    }
    th { background: #F8FAFC; font-weight: 600; }
    tr:nth-child(even) { background: #FAFBFC; }
    ul, ol { padding-left: 2em; margin: 0.5em 0; }
    li { margin: 0.25em 0; }
    hr { border: none; border-top: 2px solid var(--border-color); margin: 2em 0; }
    img { max-width: 100%; height: auto; border-radius: 8px; margin: 1em 0; }
    .wikilink {
      color: var(--accent);
      font-weight: 500;
      text-decoration: underline dotted;
    }
    .tag {
      display: inline-block;
      padding: 2px 8px;
      background: #EFF6FF;
      color: #2563EB;
      border-radius: 12px;
      font-size: 0.85em;
    }
    .export-footer {
      margin-top: 3em;
      padding-top: 1em;
      border-top: 1px solid var(--border-color);
      font-size: 0.8em;
      color: var(--text-secondary);
      text-align: center;
    }
    @media print {
      body { padding: 20px; }
      pre { white-space: pre-wrap; word-wrap: break-word; }
    }
  </style>
</head>
<body>
  ${htmlContent}
  <div class="export-footer">
    Exported from <strong>ZettelAgent</strong> on ${new Date().toLocaleDateString()}
  </div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Export the currently rendered note as an HTML file.
 * @param containerEl The DOM element containing the rendered markdown
 * @param title The note title (filename without extension)
 */
export async function exportAsHtml(containerEl: HTMLElement, title: string): Promise<boolean> {
  try {
    const htmlContent = containerEl.innerHTML;
    const assetBase = import.meta.env.BASE_URL;
    const hljsCss = await fetchLocalText(`${assetBase}css/github.min.css`);
    const fullHtml = buildHtmlDocument(title, htmlContent, KATEX_CSS, hljsCss);
    const outputPath = await save({
      defaultPath: `${title}.html`,
      filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
      title: 'Export Note as HTML',
    });

    if (!outputPath) return false;

    await writeTextFile(outputPath, fullHtml);
    return true;
  } catch (err) {
    console.error('HTML export failed:', err);
    throw err;
  }
}

/**
 * Export the currently rendered note as PDF via the system print dialog.
 * Opens a new window with the styled content and triggers print.
 * @param containerEl The DOM element containing the rendered markdown
 * @param title The note title
 */
export async function exportAsPdf(containerEl: HTMLElement, title: string): Promise<void> {
  const htmlContent = containerEl.innerHTML;
  const assetBase = import.meta.env.BASE_URL;
  const hljsCss = await fetchLocalText(`${assetBase}css/github.min.css`);
  const fullHtml = buildHtmlDocument(title, htmlContent, KATEX_CSS, hljsCss);

  // Create a hidden iframe for printing
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = 'none';
  iframe.style.opacity = '0';
  document.body.appendChild(iframe);

  const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!iframeDoc) {
    document.body.removeChild(iframe);
    throw new Error('Cannot create print frame');
  }

  iframeDoc.open();
  iframeDoc.write(fullHtml);
  iframeDoc.close();

  // Wait for styles/images to load, then print
  iframe.onload = () => {
    setTimeout(() => {
      iframe.contentWindow?.print();
      // Clean up after print dialog closes
      setTimeout(() => {
        document.body.removeChild(iframe);
      }, 1000);
    }, 500);
  };
}
