import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { useApp } from '../../contexts/AppContext';
import { listMarkdownFiles, resolveWikilink } from '../../lib/tauri';
import { convertFileSrc } from '@tauri-apps/api/core';
import mermaid from 'mermaid';
import { useHoverPreview, HoverPreviewCard } from './HoverPreview';

// Detect dark mode
const isDarkMode = () => {
  return document.documentElement.getAttribute('data-theme') === 'dark' ||
         document.body.classList.contains('dark-theme') ||
         window.matchMedia('(prefers-color-scheme: dark)').matches;
};

mermaid.initialize({
  startOnLoad: false,
  theme: isDarkMode() ? 'dark' : 'default',
  securityLevel: 'loose',
});


interface MarkdownRendererProps {
  content: string;
  className?: string;
}

function getFileName(path: string) {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1].replace(/\.md$/, '');
}

function normalizeTitle(title: string): string {
  let clean = title.toLowerCase();
  
  // Remove parenthetical suffix
  const pIndex1 = clean.indexOf('(');
  if (pIndex1 !== -1) {
    clean = clean.substring(0, pIndex1);
  }
  const pIndex2 = clean.indexOf('（');
  if (pIndex2 !== -1) {
    clean = clean.substring(0, pIndex2);
  }
  
  clean = clean.trim();
  
  // Strip numeric prefix at the start, e.g. "02-", "03 ", "1. "
  const numPrefixMatch = clean.match(/^\d+[\s.\-_]*/);
  if (numPrefixMatch) {
    clean = clean.substring(numPrefixMatch[0].length);
  }
  
  // Keep only alphanumeric characters and Chinese characters.
  let result = '';
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    const code = char.charCodeAt(0);
    const isAlphanumeric = (code >= 48 && code <= 57) || // 0-9
                          (code >= 65 && code <= 90) || // A-Z
                          (code >= 97 && code <= 122);  // a-z
    const isChinese = code >= 0x4e00 && code <= 0x9fa5;
    if (isAlphanumeric || isChinese) {
      result += char;
    }
  }
  return result;
}

function getTextFromChildren(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (!children) return '';
  return React.Children.toArray(children)
    .map((child) => {
      if (React.isValidElement(child)) {
        return getTextFromChildren((child as React.ReactElement<any>).props.children);
      }
      if (typeof child === 'string' || typeof child === 'number') {
        return String(child);
      }
      return '';
    })
    .join('');
}

interface MermaidRendererProps {
  content: string;
}

export function MermaidRenderer({ content }: MermaidRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    
    const id = `mermaid-view-${Math.random().toString(36).substring(2, 9)}`;
    containerRef.current.innerHTML = '<div style="color: var(--text-secondary, #666); font-size: 14px;">Rendering diagram...</div>';
    setError(null);

    mermaid.render(id, content)
      .then(({ svg }) => {
        if (containerRef.current) {
          containerRef.current.innerHTML = svg;
        }
      })
      .catch((err) => {
        console.error('Mermaid view render error:', err);
        setError(err.message || String(err));
      });
  }, [content]);

  if (error) {
    return (
      <div style={{
        color: 'var(--danger, #dc2626)',
        fontSize: '14px',
        padding: '0.5rem',
        background: 'var(--danger-bg, rgba(220,38,38,0.1))',
        borderRadius: '4px',
        fontFamily: 'monospace',
        whiteSpace: 'pre-wrap',
        border: '1px solid var(--danger, #dc2626)',
        margin: '0.5rem 0'
      }}>
        Mermaid Error: {error}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="mermaid-render-container"
      style={{
        display: 'flex',
        justifyContent: 'center',
        padding: '1rem',
        background: 'var(--bg-secondary, #f8fafc)',
        borderRadius: '8px',
        border: '1px solid var(--border, #e2e8f0)',
        overflowX: 'auto',
        margin: '0.5rem 0'
      }}
    />
  );
}


/**
 * Shared Markdown renderer using react-markdown + remark-gfm + rehype-highlight.
 * Renders: headings, bold, italic, code blocks (syntax highlighted), tables,
 * blockquotes, links, images, lists, wikilinks [[...]], tags #..., horizontal rules.
 */
export function MarkdownRenderer({ content, className = 'markdown-content' }: MarkdownRendererProps) {
  const { state, setCurrentFile, setView } = useApp();
  const [hoverState, onHoverStart, onHoverEnd] = useHoverPreview();

  const handleWikilinkClick = async (targetTitle: string) => {
    if (!state.vaultPath) return;
    try {
      // First try to resolve using SQLite backend command
      const resolvedPath = await resolveWikilink(targetTitle);
      if (resolvedPath) {
        setCurrentFile(resolvedPath);
        setView('note');
        return;
      }

      // Fallback to local filename check
      const files = await listMarkdownFiles(state.vaultPath);
      const cleanTarget = normalizeTitle(targetTitle);
      
      const matchedFile = files.find(file => {
        const fileName = getFileName(file);
        return normalizeTitle(fileName) === cleanTarget;
      });
      
      if (matchedFile) {
        setCurrentFile(matchedFile);
        setView('note');
      } else {
        console.warn(`No matching file found for wikilink: ${targetTitle}`);
      }
    } catch (err) {
      console.error('Failed to resolve wikilink:', err);
    }
  };

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeHighlight, rehypeKatex]}
        components={{
          // Render wikilinks [[Note Name]] as styled spans
          p: ({ children }) => {
            const processed = processInlineNodes(children, handleWikilinkClick, state.vaultPath ?? undefined, onHoverStart, onHoverEnd);
            return <p>{processed}</p>;
          },
          li: ({ children }) => {
            const processed = processInlineNodes(children, handleWikilinkClick, state.vaultPath ?? undefined, onHoverStart, onHoverEnd);
            return <li>{processed}</li>;
          },
          h1: ({ children }) => {
            const processed = processInlineNodes(children, handleWikilinkClick, state.vaultPath ?? undefined, onHoverStart, onHoverEnd);
            return <h1>{processed}</h1>;
          },
          h2: ({ children }) => {
            const processed = processInlineNodes(children, handleWikilinkClick, state.vaultPath ?? undefined, onHoverStart, onHoverEnd);
            return <h2>{processed}</h2>;
          },
          h3: ({ children }) => {
            const processed = processInlineNodes(children, handleWikilinkClick, state.vaultPath ?? undefined, onHoverStart, onHoverEnd);
            return <h3>{processed}</h3>;
          },
          h4: ({ children }) => {
            const processed = processInlineNodes(children, handleWikilinkClick, state.vaultPath ?? undefined, onHoverStart, onHoverEnd);
            return <h4>{processed}</h4>;
          },
          h5: ({ children }) => {
            const processed = processInlineNodes(children, handleWikilinkClick, state.vaultPath ?? undefined, onHoverStart, onHoverEnd);
            return <h5>{processed}</h5>;
          },
          h6: ({ children }) => {
            const processed = processInlineNodes(children, handleWikilinkClick, state.vaultPath ?? undefined, onHoverStart, onHoverEnd);
            return <h6>{processed}</h6>;
          },
          // Style links
          a: ({ href, children }) => {
            const isExternal = href && (href.startsWith('http://') || href.startsWith('https://'));
            return (
              <a
                href={isExternal ? href : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  if (isExternal && href) {
                    window.open(href, '_blank');
                  }
                }}
                target="_blank"
                rel="noopener noreferrer"
                className="md-link"
                style={isExternal ? undefined : { cursor: 'default', opacity: 0.6 }}
              >
                {children}
              </a>
            );
          },
          // Style blockquotes — detect Obsidian callouts [!type]
          blockquote: ({ children }) => {
            // Extract the text content of the first <p> to check for callout syntax
            const childArr = React.Children.toArray(children);
            const firstP = childArr.find(
              (c) => React.isValidElement(c) && (c as React.ReactElement<any>).type === 'p'
            ) as React.ReactElement<any> | undefined;

            if (firstP) {
              const firstText = getTextFromChildren(firstP.props.children);
              const calloutMatch = firstText.match(/^\s*\[!(NOTE|TIP|WARNING|CAUTION|IMPORTANT|INFO|EXAMPLE|QUOTE|BUG|SUCCESS|FAILURE|QUESTION|ABSTRACT|TODO|DANGER|ERROR)\]([+-])?\s*(.*)/i);
              if (calloutMatch) {
                const calloutType = calloutMatch[1].toLowerCase();
                const titleOverride = calloutMatch[3]?.trim();
                const calloutTitle = titleOverride || calloutType.charAt(0).toUpperCase() + calloutType.slice(1);

                // Map types to icon + color
                const typeMap: Record<string, { icon: string; color: string }> = {
                  note:      { icon: '📝', color: 'var(--accent, #3b82f6)' },
                  info:      { icon: 'ℹ️', color: 'var(--accent, #3b82f6)' },
                  tip:       { icon: '💡', color: '#10b981' },
                  success:   { icon: '✅', color: '#10b981' },
                  warning:   { icon: '⚠️', color: '#f59e0b' },
                  caution:   { icon: '🔥', color: '#ef4444' },
                  danger:    { icon: '⚡', color: '#ef4444' },
                  error:     { icon: '❌', color: '#ef4444' },
                  important: { icon: '❗', color: '#a855f7' },
                  example:   { icon: '📋', color: '#8b5cf6' },
                  quote:     { icon: '💬', color: '#6b7280' },
                  bug:       { icon: '🐛', color: '#ef4444' },
                  failure:   { icon: '❌', color: '#ef4444' },
                  question:  { icon: '❓', color: '#f59e0b' },
                  abstract:  { icon: '📄', color: '#06b6d4' },
                  todo:      { icon: '☑️', color: '#3b82f6' },
                };
                const { icon, color } = typeMap[calloutType] || typeMap.note;

                // Remaining children after the first line
                const restChildren = childArr.filter((c) => c !== firstP);
                // Also strip the [!TYPE] line from the first <p> body
                const firstPText = firstText.replace(/^\s*\[!(NOTE|TIP|WARNING|CAUTION|IMPORTANT|INFO|EXAMPLE|QUOTE|BUG|SUCCESS|FAILURE|QUESTION|ABSTRACT|TODO|DANGER|ERROR)\]([+-])?\s*/i, '');

                return (
                  <div className="md-callout" style={{
                    borderLeft: `4px solid ${color}`,
                    background: `${color}10`,
                    borderRadius: '0 var(--radius-sm) var(--radius-sm) 0',
                    padding: 'var(--space-2) var(--space-3)',
                    margin: 'var(--space-3) 0',
                  }}>
                    <div className="md-callout-title" style={{
                      display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
                      fontWeight: 600, fontSize: 'var(--text-sm)', color,
                      marginBottom: (firstPText || restChildren.length > 0) ? 'var(--space-1)' : 0,
                    }}>
                      <span>{icon}</span> {calloutTitle}
                    </div>
                    {firstPText && <p style={{ margin: 0 }}>{firstPText}</p>}
                    {restChildren}
                  </div>
                );
              }
            }

            return <blockquote className="md-blockquote">{children}</blockquote>;
          },
          // Style tables
          table: ({ children }) => (
            <div className="md-table-wrapper">
              <table className="md-table">{children}</table>
            </div>
          ),
          // Style code blocks
          pre: ({ children }) => {
            const childArray = React.Children.toArray(children);
            if (childArray.length === 1 && React.isValidElement(childArray[0])) {
              const child = childArray[0];
              const codeProps = child.props as any;
              if (codeProps && typeof codeProps.className === 'string' && codeProps.className.includes('language-mermaid')) {
                const content = getTextFromChildren(codeProps.children).trim();
                return <MermaidRenderer content={content} />;
              }
            }
            return <pre className="md-code-block">{children}</pre>;
          },
          code: ({ className: codeClass, children }) => {
            if (codeClass && codeClass.includes('language-mermaid')) {
              return <MermaidRenderer content={getTextFromChildren(children).trim()} />;
            }
            return <code className={codeClass || 'md-inline-code'}>{children}</code>;
          },
          // Style horizontal rule
          hr: () => <hr className="md-hr" />,
          // Style images
          img: ({ src, alt }) => {
            if (!src) return null;
            const isRelative = !src.startsWith('http://') && !src.startsWith('https://') && !src.startsWith('data:') && !src.startsWith('tauri://');
            let resolvedSrc = src;
            if (isRelative && state.vaultPath) {
              const cleanVault = state.vaultPath.replace(/\\/g, '/');
              const cleanSrc = src.replace(/\\/g, '/');
              const separator = cleanVault.endsWith('/') || cleanSrc.startsWith('/') ? '' : '/';
              const fullPath = `${cleanVault}${separator}${cleanSrc}`;
              resolvedSrc = convertFileSrc(fullPath);
            }
            return (
              <img src={resolvedSrc} alt={alt || ''} className="md-image" loading="lazy" />
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
      <HoverPreviewCard state={hoverState} onClose={onHoverEnd} />
    </div>
  );
}

/**
 * Process inline nodes to detect [[wikilinks]], ![[embeds]], and #tags in text content.
 */
function processInlineNodes(
  children: React.ReactNode,
  onWikilinkClick: (title: string) => void,
  vaultPath?: string,
  onHoverStart?: (title: string, el: HTMLElement) => void,
  onHoverEnd?: () => void,
): React.ReactNode {
  return React.Children.map(children, (child) => {
    if (typeof child === 'string') {
      return processText(child, onWikilinkClick, vaultPath, onHoverStart, onHoverEnd);
    }
    return child;
  });
}

/**
 * Convert [[wikilinks]], ![[embeds]], and #tags in plain text to styled spans.
 */
function processText(
  text: string,
  onWikilinkClick: (title: string) => void,
  vaultPath?: string,
  onHoverStart?: (title: string, el: HTMLElement) => void,
  onHoverEnd?: () => void,
): React.ReactNode {
  // Split by embeds ![[...]], wikilinks [[...]], and tags #...
  const parts = text.split(/(!\[\[[^\]]+\]\]|\[\[[^\]]+\]\]|(?<=\s|^)#[\w\u4e00-\u9fff-]+)/g);

  if (parts.length === 1) return text;

  return parts.map((part, i) => {
    // Embed ![[filename]] — images and notes
    const embedMatch = part.match(/^!\[\[([^\]]+)\]\]$/);
    if (embedMatch) {
      const target = embedMatch[1];
      const isImage = /\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i.test(target);
      if (isImage && vaultPath) {
        const cleanVault = vaultPath.replace(/\\/g, '/');
        const cleanTarget = target.replace(/\\/g, '/');
        const sep = cleanVault.endsWith('/') || cleanTarget.startsWith('/') ? '' : '/';
        const resolvedSrc = convertFileSrc(`${cleanVault}${sep}${cleanTarget}`);
        return (
          <img
            key={i}
            src={resolvedSrc}
            alt={target}
            className="md-image"
            loading="lazy"
            style={{ maxWidth: '100%', borderRadius: 'var(--radius-sm)' }}
          />
        );
      }
      // Non-image embed: render as a styled embed link
      const displayName = target.replace(/\.md$/i, '').split('/').pop() || target;
      return (
        <span
          key={i}
          className="wikilink embed-link"
          title={`Embedded: ${target}`}
          onClick={() => onWikilinkClick(target.replace(/\.md$/i, ''))}
          style={{ borderBottom: '2px dashed var(--accent)' }}
        >
          📎 {displayName}
        </span>
      );
    }
    // Wikilink [[Note Name]]
    const wikilinkMatch = part.match(/^\[\[([^\]]+)\]\]$/);
    if (wikilinkMatch) {
      return (
        <span
          key={i}
          className="wikilink"
          title={wikilinkMatch[1]}
          onClick={() => onWikilinkClick(wikilinkMatch[1])}
          onMouseEnter={(e) => onHoverStart?.(wikilinkMatch[1], e.currentTarget)}
          onMouseLeave={() => onHoverEnd?.()}
        >
          {wikilinkMatch[1]}
        </span>
      );
    }
    // Tag #tag-name
    const tagMatch = part.match(/^#([\w\u4e00-\u9fff-]+)$/);
    if (tagMatch) {
      return (
        <span key={i} className="tag">
          #{tagMatch[1]}
        </span>
      );
    }
    return part;
  });
}
