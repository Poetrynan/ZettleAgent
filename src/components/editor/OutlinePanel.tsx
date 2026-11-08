import { useMemo, useCallback, useState } from 'react';

interface HeadingItem {
  level: number;     // 1-6
  text: string;
  line: number;      // approximate line number
}

interface OutlinePanelProps {
  content: string;
  lang: string;
}

function extractHeadings(markdown: string): HeadingItem[] {
  const lines = markdown.split('\n');
  const headings: HeadingItem[] = [];
  // Also parse headings from YAML content after frontmatter
  let inFrontmatter = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Track frontmatter for line offset
    if (line.trim() === '---' && (i === 0 || inFrontmatter)) {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter) continue;

    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      headings.push({
        level: match[1].length,
        text: match[2].trim(),
        line: i + 1,
      });
    }
  }

  return headings;
}

export function OutlinePanel({ content, lang }: OutlinePanelProps) {
  const headings = useMemo(() => extractHeadings(content), [content]);
  // Collapsed by default so the note body starts near the top (VS Code keeps
  // the outline out of the editor; here it folds down to a single line).
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('zettel:outline-collapsed') !== 'false'; } catch { return true; }
  });
  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem('zettel:outline-collapsed', String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const handleClick = useCallback((index: number, text: string) => {
    // Try to find the heading element inside the editor container
    const editor = document.querySelector('.milkdown-editor-container');
    if (editor) {
      const headingsInDom = Array.from(
        editor.querySelectorAll('h1, h2, h3, h4, h5, h6')
      );
      
      let targetEl = headingsInDom[index] as HTMLElement | undefined;
      
      // Fallback: match by text content if indices shifted due to editor state lag
      if (!targetEl || targetEl.textContent?.trim() !== text.trim()) {
        targetEl = headingsInDom.find(
          el => el.textContent?.trim() === text.trim()
        ) as HTMLElement | undefined;
      }
      
      if (targetEl) {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        
        // Pulse glow highlight animation for modern UX
        const originalBg = targetEl.style.background;
        targetEl.style.transition = 'background 0.3s ease';
        targetEl.style.background = 'var(--success-bg, rgba(22, 163, 74, 0.15))';
        setTimeout(() => {
          if (targetEl) {
            targetEl.style.background = originalBg;
          }
        }, 1200);
        return;
      }
    }
  }, []);

  // A note without headings has no outline: render nothing rather than an
  // empty placeholder sitting above the document.
  if (headings.length === 0) return null;

  return (
    <div className={`outline-panel ${collapsed ? 'is-collapsed' : ''}`}>
      <div
        className="outline-panel-header"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={toggleCollapsed}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCollapsed(); } }}
      >
        <div className="outline-header-left">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="outline-header-icon">
            <line x1="21" y1="10" x2="7" y2="10"></line>
            <line x1="21" y1="6" x2="3" y2="6"></line>
            <line x1="21" y1="14" x2="3" y2="14"></line>
            <line x1="21" y1="18" x2="7" y2="18"></line>
          </svg>
          <span>{lang === 'zh' ? '文档大纲' : 'Outline'}</span>
        </div>
        <span className="outline-count-badge">{headings.length}</span>
      </div>
      {!collapsed && (<div className="outline-list">
        {headings.map((h, i) => (
          <div
            key={i}
            className={`outline-item outline-level-${h.level}`}
            onClick={() => handleClick(i, h.text)}
            title={`${'#'.repeat(h.level)} ${h.text}`}
          >
            <span className="outline-bullet" />
            <span className="outline-text">{h.text}</span>
          </div>
        ))}
      </div>)}
    </div>
  );
}