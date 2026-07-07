import { useEffect, useRef, useCallback, useState } from 'react';
import { Crepe, CrepeFeature } from '@milkdown/crepe';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { replaceAll, getMarkdown } from '@milkdown/kit/utils';
import { editorViewCtx } from '@milkdown/kit/core';
import { useApp } from '../../contexts/AppContext';
import { saveImageToVault, listMarkdownFiles, chatWithLlm } from '../../lib/tauri';
import { getWikilinkPlugins } from './milkdown-wikilink';
import { generatedBlockPlugin } from './generatedBlockDecorations';
import mermaid from 'mermaid';
import { codeBlockConfig } from '@milkdown/kit/component/code-block';
import { useHoverPreview, HoverPreviewCard } from './HoverPreview';
import { useEditorSuggestions } from './useEditorSuggestions';
import { EditorSuggestionOverlay } from './EditorSuggestionOverlay';
import { suggestionPlugin, updateSuggestionDecorations, clearSuggestionDecorations } from './suggestionDecorations';

// ── Wikilink Autocomplete ────────────────────────────────────────

interface AutocompleteState {
  visible: boolean;
  query: string;          // Text typed after [[
  from: number;           // Doc position of the opening [[
  to: number;             // Doc position of cursor
  top: number;            // Pixel position relative to container
  left: number;           // Pixel position
  filteredTitles: string[];
  selectedIndex: number;
}

/** Case-insensitive fuzzy filter for note titles */
function filterTitles(titles: string[], query: string): string[] {
  if (!query) return titles.slice(0, 30);
  const q = query.toLowerCase();
  return titles
    .filter(t => t.toLowerCase().includes(q))
    .slice(0, 30);
}

// Detect dark mode for mermaid theme
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


// Crepe theme styles — light base theme only; dark mode overrides live in
// src/styles/theme-dark.css so the editor follows the app theme reliably.
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';

interface MilkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
}

/** Inner editor component using Milkdown's useEditor hook */
function MilkdownInner({ value, onChange }: MilkdownEditorProps) {
  const { state, showToast, setCurrentFile, setView } = useApp();
  const valueRef = useRef(value);
  const isInternalChange = useRef(false);
  const noteTitlesRef = useRef<string[]>([]);
  
  // AI selection toolbar state
  const [selectionToolbar, setSelectionToolbar] = useState<{
    visible: boolean;
    top: number;
    left: number;
    text: string;
  }>({ visible: false, top: 0, left: 0, text: '' });
  const [aiProcessing, setAiProcessing] = useState<string | null>(null);

  // Wikilink autocomplete state
  const [wlAutocomplete, setWlAutocomplete] = useState<AutocompleteState>({
    visible: false, query: '', from: 0, to: 0, top: 0, left: 0,
    filteredTitles: [], selectedIndex: 0,
  });

  // Ref mirror to avoid keydown effect re-registering on every state change
  const wlAutocompleteRef = useRef(wlAutocomplete);
  wlAutocompleteRef.current = wlAutocomplete;

  // Hover preview for [[wikilinks]]
  const [hoverState, onHoverStart, onHoverEnd] = useHoverPreview();

  // AI Fact-Check Suggestion Layer (Phase 3)
  const {
    suggestions: editorSuggestions,
    isScanning: isSuggestionScanning,
    dismissSuggestion: dismissEditorSuggestion,
    acceptSuggestion,
    resolveReconciliationConflict,
  } = useEditorSuggestions({
    markdown: value,
    filePath: state.currentFile || null,
    vaultPath: state.vaultPath || null,
    lang: state.lang,
    llmConfig: state.llmConfig,
    enabled: true,
  });

  // Load note titles for [[ autocomplete
  useEffect(() => {
    if (!state.vaultPath) return;
    listMarkdownFiles(state.vaultPath).then(files => {
      noteTitlesRef.current = files.map(f =>
        f.replace(/\\/g, '/').split('/').pop()?.replace('.md', '') || f
      );
    }).catch(console.error);
  }, [state.vaultPath]);

  // Image upload handler
  const handleUpload = useCallback(async (file: File): Promise<string> => {
    if (!state.vaultPath) {
      showToast('Please select a vault folder first', 'error');
      return URL.createObjectURL(file);
    }
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64Data = reader.result as string;
        const fileExt = file.name.split('.').pop() || 'png';
        const randomId = Math.random().toString(36).substring(2, 7);
        const relativePath = `assets/${Date.now()}-${randomId}.${fileExt}`;
        try {
          await saveImageToVault(state.vaultPath!, relativePath, base64Data);
          resolve(relativePath);
        } catch (err) {
          console.error('Image upload failed:', err);
          showToast(String(err), 'error');
          resolve(URL.createObjectURL(file));
        }
      };
      reader.readAsDataURL(file);
    });
  }, [state.vaultPath, showToast]);

  // Wikilink click handler
  const handleWikilinkClick = useCallback(async (title: string) => {
    if (!state.vaultPath) return;

    // Check if it's a PDF link
    if (title.toLowerCase().includes('.pdf')) {
      window.dispatchEvent(new CustomEvent('zettel:jump-to-pdf', { detail: title }));
      return;
    }

    try {
      const files = await listMarkdownFiles(state.vaultPath);
      const cleanTarget = title.toLowerCase().trim();
      const matchedFile = files.find(file => {
        const parts = file.replace(/\\/g, '/').split('/');
        const fileName = parts[parts.length - 1].replace(/\.md$/, '').toLowerCase().trim();
        return fileName === cleanTarget;
      });
      if (matchedFile) {
        setCurrentFile(matchedFile);
        setView('note');
      } else {
        console.warn(`No matching file found for wikilink: ${title}`);
      }
    } catch (err) {
      console.error('Failed to resolve wikilink:', err);
    }
  }, [state.vaultPath, setCurrentFile, setView]);


  const { get } = useEditor((root) => {
    const crepe = new Crepe({
      root,
      defaultValue: value,
      features: {
        [CrepeFeature.CodeMirror]: true,
        [CrepeFeature.ListItem]: true,
        [CrepeFeature.LinkTooltip]: true,
        [CrepeFeature.ImageBlock]: true,
        [CrepeFeature.BlockEdit]: true,
        [CrepeFeature.Placeholder]: true,
        [CrepeFeature.Toolbar]: false,
        [CrepeFeature.Table]: true,
        [CrepeFeature.Latex]: true,
        [CrepeFeature.Cursor]: true,
      },
      featureConfigs: {
        [CrepeFeature.ImageBlock]: {
          onUpload: handleUpload,
        },
        [CrepeFeature.Placeholder]: {
          text: 'Start writing...',
        },
        [CrepeFeature.BlockEdit]: {
          blockHandle: {
            getOffset: () => 8,
            getPlacement: () => 'right' as const,
          },
        },
      },
    });

    // Configure Crepe code blocks to render Mermaid diagrams
    crepe.editor.config((ctx) => {
      ctx.update(codeBlockConfig.key, (defaultConfig) => ({
        ...defaultConfig,
        renderPreview: (language, content, applyPreview) => {
          if (language === 'mermaid') {
            const container = document.createElement('div');
            container.className = 'mermaid-preview-container';
            container.style.display = 'flex';
            container.style.justifyContent = 'center';
            container.style.padding = '1rem';
            container.style.background = 'var(--bg-secondary, #f8fafc)';
            container.style.borderRadius = '8px';
            container.style.border = '1px solid var(--border, #e2e8f0)';
            container.style.overflowX = 'auto';
            container.innerHTML = '<div class="mermaid-loading" style="color: var(--text-secondary, #475569); font-size: 14px;">Rendering diagram...</div>';
            
            const id = `mermaid-crepe-${Math.random().toString(36).substring(2, 9)}`;
            mermaid.render(id, content)
              .then(({ svg }) => {
                container.innerHTML = svg;
                applyPreview(container);
              })
              .catch((err) => {
                console.error('Mermaid crepe render error:', err);
                container.innerHTML = `<div class="mermaid-error" style="color: var(--danger, #dc2626); font-size: 14px; padding: 0.5rem; background: var(--danger-bg, rgba(220,38,38,0.1)); border-radius: 4px; font-family: monospace; white-space: pre-wrap;">Syntax Error: ${err.message || String(err)}</div>`;
                applyPreview(container);
              });
            
            return container;
          }
          return defaultConfig.renderPreview?.(language, content, applyPreview);
        }
      }));
    });

    // Register wikilink plugins
    const wikilinkPlugins = getWikilinkPlugins();
    for (const plugin of wikilinkPlugins) {
      crepe.editor.use(plugin);
    }

    // Hide @generated / @user HTML comment markers from the WYSIWYG view
    crepe.editor.use(generatedBlockPlugin);

    // Register suggestion decorations plugin (ProseMirror wave underline + badge)
    crepe.editor.use(suggestionPlugin);

    // Listen for content changes
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown, prevMarkdown) => {
        if (markdown !== prevMarkdown) {
          isInternalChange.current = true;
          valueRef.current = markdown;
          onChange(markdown);
        }
      });
    });

    return crepe;
  }, []);

  // ── Suggestion Decoration Layer (ProseMirror wave underline + anchored card) ──
  const [activeSuggestionId, setActiveSuggestionId] = useState<string | null>(null);
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(null);
  const suggestionRangesRef = useRef<Map<string, { from: number; to: number }>>(new Map());

  // Update ProseMirror decorations whenever suggestions change
  useEffect(() => {
    const editor = get();
    if (!editor) return;

    const newRanges = new Map<string, { from: number; to: number }>();
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (editorSuggestions.length > 0) {
        const ranges = updateSuggestionDecorations(view, editorSuggestions);
        for (const [k, v] of ranges) newRanges.set(k, v);
      } else {
        clearSuggestionDecorations(view);
      }
    });
    suggestionRangesRef.current = newRanges;

    // If the active suggestion was dismissed/removed, clear it
    if (activeSuggestionId && !newRanges.has(activeSuggestionId)) {
      setActiveSuggestionId(null);
    }
  }, [editorSuggestions, get, activeSuggestionId]);

  // Listen for badge-click events (from ProseMirror widget decorations)
  useEffect(() => {
    const handler = (e: Event) => {
      const { suggestionId } = (e as CustomEvent).detail;
      setActiveSuggestionId(prevId => prevId === suggestionId ? null : suggestionId);
    };
    window.addEventListener('suggestion-badge-click', handler);
    return () => window.removeEventListener('suggestion-badge-click', handler);
  }, []);

  // Position the anchored card when a suggestion becomes active
  useEffect(() => {
    if (!activeSuggestionId) { setCardPos(null); return; }
    const editor = get();
    if (!editor) return;

    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const range = suggestionRangesRef.current.get(activeSuggestionId);
      if (!range) { setCardPos(null); return; }

      try {
        const coords = view.coordsAtPos(range.to);
        const container = document.querySelector('.milkdown-editor-container') as HTMLElement;
        if (!container) return;
        const containerRect = container.getBoundingClientRect();
        setCardPos({
          top: coords.bottom - containerRect.top + 6,
          left: Math.max(8, Math.min(
            coords.left - containerRect.left,
            containerRect.width - 360,
          )),
        });
      } catch {
        setCardPos(null);
      }
    });
  }, [activeSuggestionId, get]);

  // Accept a suggestion fix — replaces the conflicting text in the doc
  const handleAcceptSuggestion = useCallback((suggestionId: string) => {
    const result = acceptSuggestion(suggestionId);
    if (!result) {
      setActiveSuggestionId(null);
      return;
    }

    const editor = get();
    if (!editor) { setActiveSuggestionId(null); return; }

    const range = suggestionRangesRef.current.get(suggestionId);
    if (range) {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        try {
          const tr = view.state.tr.replaceWith(
            range.from, range.to,
            view.state.schema.text(result.replacement),
          );
          view.dispatch(tr);
        } catch (e) {
          console.warn('Failed to apply suggestion fix:', e);
        }
      });

      // Sync markdown content
      const newMarkdown = editor.action(getMarkdown());
      isInternalChange.current = true;
      valueRef.current = newMarkdown;
      onChange(newMarkdown);

      showToast(state.lang === 'zh' ? '建议修正已应用' : 'Suggestion fix applied', 'success');
    }
    setActiveSuggestionId(null);
  }, [acceptSuggestion, get, onChange, showToast, state.lang]);

  // Clear decorations on unmount
  useEffect(() => {
    return () => {
      const editor = get();
      if (!editor) return;
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        clearSuggestionDecorations(view);
      });
    };
  }, [get]);

  // Selection change detection for AI toolbar
  useEffect(() => {
    const handleSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        setSelectionToolbar(prev => prev.visible ? { ...prev, visible: false } : prev);
        return;
      }

      const text = selection.toString().trim();
      if (text.length < 5) {
        setSelectionToolbar(prev => prev.visible ? { ...prev, visible: false } : prev);
        return;
      }

      // Check if selection is within our editor
      const range = selection.getRangeAt(0);
      const editorContainer = document.querySelector('.milkdown-editor-container');
      if (!editorContainer || !editorContainer.contains(range.commonAncestorContainer)) {
        return;
      }

      const rect = range.getBoundingClientRect();
      const containerRect = editorContainer.getBoundingClientRect();
      
      setSelectionToolbar({
        visible: true,
        top: rect.top - containerRect.top - 44,
        left: Math.min(
          Math.max(rect.left - containerRect.left, 0),
          containerRect.width - 340
        ),
        text,
      });
    };

    document.addEventListener('selectionchange', handleSelectionChange);
    return () => document.removeEventListener('selectionchange', handleSelectionChange);
  }, []);

  // Wikilink click + hover delegation
  useEffect(() => {
    const handleClick = (e: Event) => {
      const target = (e as MouseEvent).target as HTMLElement;
      const wikilink = target.closest('.milkdown-wikilink');
      if (wikilink) {
        e.preventDefault();
        e.stopPropagation();
        const title = wikilink.getAttribute('data-title') || wikilink.textContent || '';
        if (title) handleWikilinkClick(title);
      }
    };

    let hoverTarget: HTMLElement | null = null;

    const handleMouseOver = (e: Event) => {
      const target = (e as MouseEvent).target as HTMLElement;
      const wikilink = target.closest('.milkdown-wikilink') as HTMLElement | null;
      if (wikilink && wikilink !== hoverTarget) {
        hoverTarget = wikilink;
        const title = wikilink.getAttribute('data-title') || wikilink.textContent || '';
        if (title) onHoverStart(title, wikilink);
      }
    };

    const handleMouseOut = (e: Event) => {
      const target = (e as MouseEvent).target as HTMLElement;
      const wikilink = target.closest('.milkdown-wikilink') as HTMLElement | null;
      if (wikilink === hoverTarget) {
        hoverTarget = null;
        onHoverEnd();
      }
    };

    const container = document.querySelector('.milkdown-editor-container');
    container?.addEventListener('click', handleClick);
    container?.addEventListener('mouseover', handleMouseOver);
    container?.addEventListener('mouseout', handleMouseOut, true);
    return () => {
      container?.removeEventListener('click', handleClick);
      container?.removeEventListener('mouseover', handleMouseOver);
      container?.removeEventListener('mouseout', handleMouseOut, true);
    };
  }, [handleWikilinkClick, onHoverStart, onHoverEnd]);

  // ── Apply a wikilink autocomplete selection ──
  // (Must be declared before effects that reference it)

  const applyWikilinkAutocomplete = useCallback((title: string) => {
    const editor = get();
    if (!editor) return;
    // Use a state updater function to read current from/to without stale closure
    setWlAutocomplete(prev => {
      if (!prev.visible) return prev;
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const tr = view.state.tr.replaceWith(
          prev.from, prev.to,
          view.state.schema.text(title)
        );
        view.dispatch(tr);
      });

      // Push updated content
      const newMarkdown = editor.action(getMarkdown());
      isInternalChange.current = true;
      valueRef.current = newMarkdown;
      onChange(newMarkdown);

      return { ...prev, visible: false };
    });
  }, [get, onChange]);

  // ── Wikilink Autocomplete: detect [[... pattern ──

  useEffect(() => {
    const editorEl = document.querySelector('.milkdown-editor-container');
    if (!editorEl) return;

    const scanForWikilink = () => {
      const editor = get();
      if (!editor) return;
      // Don't open a new popup if one is already open
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const sel = view.state.selection;
        if (!(sel as any).$cursor) return;
        const cursorPos = (sel as any).from;

        // Look backwards from cursor for [[text (no closing ]] before cursor)
        const searchStart = Math.max(0, cursorPos - 100);
        const beforeText = view.state.doc.textBetween(searchStart, cursorPos);

        const match = beforeText.match(/\[\[([^\]]*)$/);
        if (!match) return;

        const query = match[1] || '';
        const fromPos = searchStart + (match.index as number);

        // Don't trigger for already-complete wikilinks (]] right after cursor)
        const afterText = view.state.doc.textBetween(cursorPos, Math.min(cursorPos + 3, view.state.doc.content.size));
        if (afterText.startsWith(']]')) return;

        const titles = noteTitlesRef.current;
        const filtered = filterTitles(titles, query);

        const coords = view.coordsAtPos(cursorPos);
        const containerRect = (editorEl as HTMLElement).getBoundingClientRect();

        setWlAutocomplete(prev => {
          // If already visible and the fromPos hasn't changed, skip re-open
          if (prev.visible && prev.from === fromPos) {
            // Just update filter based on latest query
            return {
              ...prev,
              query,
              to: cursorPos,
              filteredTitles: filtered,
              selectedIndex: Math.min(prev.selectedIndex, Math.max(0, filtered.length - 1)),
              top: (coords?.bottom ?? prev.top) - containerRect.top + 4,
              left: (coords?.left ?? prev.left) - containerRect.left,
            };
          }
          return {
            visible: true,
            query,
            from: fromPos,
            to: cursorPos,
            top: (coords?.bottom ?? 0) - containerRect.top + 4,
            left: (coords?.left ?? 0) - containerRect.left,
            filteredTitles: filtered,
            selectedIndex: 0,
          };
        });
      });
    };

    editorEl.addEventListener('keyup', scanForWikilink);
    editorEl.addEventListener('mouseup', scanForWikilink);
    return () => {
      editorEl.removeEventListener('keyup', scanForWikilink);
      editorEl.removeEventListener('mouseup', scanForWikilink);
    };
  }, [get]);

  // ── Wikilink Autocomplete: keyboard navigation ──

  useEffect(() => {
    const handleKeyDown = (e: Event) => {
      // Use ref to read latest autocomplete state without causing re-registration
      const cur = wlAutocompleteRef.current;
      if (!cur.visible) return;

      const ke = e as KeyboardEvent;
      if (ke.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setWlAutocomplete(prev => ({ ...prev, visible: false }));
        return;
      }

      if (ke.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setWlAutocomplete(prev => ({
          ...prev,
          selectedIndex: Math.min(prev.selectedIndex + 1, prev.filteredTitles.length - 1),
        }));
        return;
      }

      if (ke.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setWlAutocomplete(prev => ({
          ...prev,
          selectedIndex: Math.max(prev.selectedIndex - 1, 0),
        }));
        return;
      }

      if (ke.key === 'Enter' || ke.key === 'Tab') {
        const selected = cur.filteredTitles[cur.selectedIndex];
        if (selected) {
          e.preventDefault();
          e.stopPropagation();
          applyWikilinkAutocomplete(selected);
        }
        return;
      }

      // Any other key typed while autocomplete is open: rescan to update filter
      // (deferred so the key is processed by ProseMirror first)
      setTimeout(() => {
        const editor = get();
        if (!editor) return;
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const sel = view.state.selection;
          if (!(sel as any).$cursor) { setWlAutocomplete(prev => ({ ...prev, visible: false })); return; }
          const cursorPos = (sel as any).from;
          const searchStart = Math.max(0, cursorPos - 100);
          const beforeText = view.state.doc.textBetween(searchStart, cursorPos);
          const match = beforeText.match(/\[\[([^\]]*)$/);
          if (!match) {
            setWlAutocomplete(prev => ({ ...prev, visible: false }));
            return;
          }
          const query = match[1] || '';
          const fromPos = searchStart + (match.index as number);
          const titles = noteTitlesRef.current;
          const filtered = filterTitles(titles, query);
          const editorEl = document.querySelector('.milkdown-editor-container');
          const coords = view.coordsAtPos(cursorPos);
          const containerRect = editorEl?.getBoundingClientRect();

          setWlAutocomplete(prev => ({
            ...prev,
            query,
            from: fromPos,
            to: cursorPos,
            top: (coords?.bottom ?? prev.top) - (containerRect?.top ?? 0) + 4,
            left: (coords?.left ?? prev.left) - (containerRect?.left ?? 0),
            filteredTitles: filtered,
            selectedIndex: Math.min(prev.selectedIndex, Math.max(0, filtered.length - 1)),
          }));
        });
      }, 10);
    };

    const editorEl = document.querySelector('.milkdown-editor-container');
    editorEl?.addEventListener('keydown', handleKeyDown, true);
    return () => editorEl?.removeEventListener('keydown', handleKeyDown, true);
  }, [get, applyWikilinkAutocomplete]); // No wlAutocomplete dep — use ref instead

  // Listen for external insert text events (from side-by-side PDF annotation viewer)
  useEffect(() => {
    const handleInsert = (e: Event) => {
      const text = (e as CustomEvent).detail;
      const editor = get();
      if (editor && text) {
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const { state, dispatch } = view;
          const { tr } = state;
          // Insert text at cursor selection position
          const insertTr = tr.replaceSelectionWith(
            state.schema.text(text)
          );
          dispatch(insertTr);
        });

        // Sync local ref and invoke onChange
        const newMarkdown = editor.action(getMarkdown());
        isInternalChange.current = true;
        valueRef.current = newMarkdown;
        onChange(newMarkdown);
      }
    };
    window.addEventListener('zettel:insert-text', handleInsert);
    return () => window.removeEventListener('zettel:insert-text', handleInsert);
  }, [get, onChange]);

  // Sync external value changes
  useEffect(() => {
    if (isInternalChange.current) {
      isInternalChange.current = false;
      return;
    }

    const editor = get();
    if (editor && value !== valueRef.current) {
      valueRef.current = value;
      try {
        editor.action(replaceAll(value));
      } catch {
        // Editor might not be ready yet
      }
    }
  }, [value, get]);

  // AI action handler
  const handleAiAction = useCallback(async (action: string) => {
    if (!selectionToolbar.text) return;
    setAiProcessing(action);

    const prompts: Record<string, string> = {
      rewrite: `Rewrite the following text to be clearer and more concise. Keep the same language. Return ONLY the rewritten text, nothing else:\n\n${selectionToolbar.text}`,
      summarize: `Summarize the following text into 1-2 sentences. Keep the same language. Return ONLY the summary, nothing else:\n\n${selectionToolbar.text}`,
      translate: `If the following text is in Chinese, translate to English. If it's in English, translate to Chinese. Return ONLY the translation, nothing else:\n\n${selectionToolbar.text}`,
      expand: `Expand the following text with more detail and examples. Keep the same language and style. Return ONLY the expanded text, nothing else:\n\n${selectionToolbar.text}`,
    };

    try {
      const result = await chatWithLlm({
        messages: [{ role: 'user', content: prompts[action] }],
        apiUrl: state.llmConfig.apiUrl,
        model: state.llmConfig.model,
        apiKey: state.llmConfig.apiKey || undefined,
        providerId: state.llmConfig.providerId,
      });

      const editor = get();
      if (editor) {
        // Replace the selected text in ProseMirror
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const { from, to } = view.state.selection;
          if (from !== to) {
            const tr = view.state.tr.replaceWith(
              from, to,
              view.state.schema.text(result.content.trim())
            );
            view.dispatch(tr);
          }
        });

        // Re-get the full markdown and push to onChange
        const newMarkdown = editor.action(getMarkdown());
        isInternalChange.current = true;
        valueRef.current = newMarkdown;
        onChange(newMarkdown);

        showToast(`AI ${action} applied`, 'success');
      }
    } catch (e) {
      showToast(`AI ${action} failed: ${e}`, 'error');
    } finally {
      setAiProcessing(null);
      setSelectionToolbar(prev => ({ ...prev, visible: false }));
    }
  }, [selectionToolbar.text, state.llmConfig, get, onChange, showToast]);

  return (
    <>
      <Milkdown />

      {/* Selection AI Toolbar */}
      {selectionToolbar.visible && (
        <div
          className="selection-ai-toolbar"
          style={{
            top: selectionToolbar.top,
            left: selectionToolbar.left,
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button
            className="selection-ai-btn"
            disabled={!!aiProcessing}
            onClick={() => handleAiAction('rewrite')}
            title="Rewrite"
          >
            <IconRewrite size={14} />
            <span>{aiProcessing === 'rewrite' ? '...' : 'Rewrite'}</span>
          </button>
          <button
            className="selection-ai-btn"
            disabled={!!aiProcessing}
            onClick={() => handleAiAction('summarize')}
            title="Summarize"
          >
            <IconSummarize size={14} />
            <span>{aiProcessing === 'summarize' ? '...' : 'Summarize'}</span>
          </button>
          <button
            className="selection-ai-btn"
            disabled={!!aiProcessing}
            onClick={() => handleAiAction('translate')}
            title="Translate"
          >
            <IconTranslate size={14} />
            <span>{aiProcessing === 'translate' ? '...' : 'Translate'}</span>
          </button>
          <button
            className="selection-ai-btn"
            disabled={!!aiProcessing}
            onClick={() => handleAiAction('expand')}
            title="Expand"
          >
            <IconExpand size={14} />
            <span>{aiProcessing === 'expand' ? '...' : 'Expand'}</span>
          </button>
        </div>
      )}

      {/* Wikilink Autocomplete Dropdown */}
      {wlAutocomplete.visible && wlAutocomplete.filteredTitles.length > 0 && (
        <div
          className="wl-autocomplete-dropdown"
          style={{
            position: 'absolute',
            top: wlAutocomplete.top,
            left: wlAutocomplete.left,
            maxHeight: 220,
            overflowY: 'auto',
            zIndex: 2000,
            background: 'var(--bg-primary, #fff)',
            border: '1px solid var(--border, #e2e8f0)',
            borderRadius: 8,
            boxShadow: '0 8px 30px rgba(0,0,0,0.12)',
            minWidth: 200,
            padding: '4px 0',
            fontFamily: 'var(--font-ui, sans-serif)',
            fontSize: 13,
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {wlAutocomplete.filteredTitles.map((title, i) => (
            <div
              key={title}
              className="wl-autocomplete-item"
              data-selected={i === wlAutocomplete.selectedIndex ? 'true' : undefined}
              style={{
                padding: '6px 12px',
                cursor: 'pointer',
                background: i === wlAutocomplete.selectedIndex
                  ? 'var(--accent-bg, rgba(59,130,246,0.1))'
                  : 'transparent',
                color: i === wlAutocomplete.selectedIndex
                  ? 'var(--accent, #3b82f6)'
                  : 'var(--text-primary, #1e293b)',
                transition: 'background 80ms',
              }}
              onMouseEnter={() => setWlAutocomplete(prev => ({ ...prev, selectedIndex: i }))}
              onClick={() => applyWikilinkAutocomplete(title)}
            >
              {title}
            </div>
          ))}
        </div>
      )}

      {/* Hover preview for wikilinks */}
      <HoverPreviewCard state={hoverState} onClose={onHoverEnd} />

      {/* AI Fact-Check Suggestion Overlay — ProseMirror wave underline + anchored card */}
      <EditorSuggestionOverlay
        suggestions={editorSuggestions}
        isScanning={isSuggestionScanning}
        onDismiss={dismissEditorSuggestion}
        onAccept={handleAcceptSuggestion}
        onNavigateToSource={(path) => {
          if (path) {
            setCurrentFile(path);
          }
        }}
        onResolveReconciliation={resolveReconciliationConflict}
        lang={state.lang}
        activeSuggestionId={activeSuggestionId}
        cardPos={cardPos}
        onCloseActive={() => setActiveSuggestionId(null)}
      />
    </>
  );
}

/** Milkdown WYSIWYG Markdown Editor wrapper */
export function MilkdownEditor(props: MilkdownEditorProps) {
  return (
    <MilkdownProvider>
      <div className="milkdown-editor-container" style={{ position: 'relative' }}>
        <MilkdownInner {...props} />
      </div>
    </MilkdownProvider>
  );
}

// ── Selection AI Action Icons ────────────────────────────────────

function IconRewrite({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>
  );
}

function IconSummarize({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="12" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/>
    </svg>
  );
}

function IconTranslate({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
    </svg>
  );
}

function IconExpand({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
    </svg>
  );
}
