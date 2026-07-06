/**
 * useEditorSuggestions — Non-invasive fact-checking suggestion layer for the Markdown editor.
 *
 * Scans the current document text for claims that might conflict with existing vault knowledge.
 * Uses debounced, paragraph-level analysis to detect temporal contradictions and outdated facts.
 * Also listens for backend reconciliation conflict events (semantic conflict resolution).
 * Renders suggestion decorations as React overlays — never modifies the underlying markdown file.
 *
 * Key design decisions:
 * - Uses paragraph-level chunking (not line-level) to provide contextual fact comparisons
 * - Debounce at 3000ms after typing stops to avoid performance impact
 * - Max 3 concurrent suggestions to avoid cognitive overload
 * - Dismissed suggestions are tracked in a session set to avoid re-suggestion
 * - Reconciliation conflicts from backend are merged into the same suggestion list
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { searchChunks, chatWithLlm, resolveConflict as resolveFileConflict } from '../../lib/tauri';
import { listen } from '@tauri-apps/api/event';

export interface EditorSuggestion {
  id: string;
  /** The paragraph text in the editor that triggered this suggestion */
  triggerText: string;
  /** The start offset in the markdown string */
  startOffset: number;
  /** The end offset in the markdown string */
  endOffset: number;
  /** The conflicting claim found in the vault */
  conflictingClaim: string;
  /** Source note path that conflicts */
  sourcePath: string;
  /** Source note title */
  sourceTitle: string;
  /** Human-readable explanation of the conflict */
  explanation: string;
  /** Suggested replacement text (optional) */
  suggestedFix?: string;
  /** Type of suggestion */
  type: 'temporal_conflict' | 'factual_conflict' | 'outdated_claim' | 'reconciliation_conflict';
  /** Confidence score 0-1 */
  confidence: number;
  /** For reconciliation_conflict: user's version of the section */
  userVersion?: string;
  /** For reconciliation_conflict: AI's version of the section */
  aiVersion?: string;
  /** For reconciliation_conflict: the section heading */
  sectionHeading?: string;
}

interface UseEditorSuggestionsParams {
  markdown: string;
  filePath: string | null;
  vaultPath: string | null;
  lang: string;
  llmConfig: any;
  enabled?: boolean;
}

export function useEditorSuggestions({
  markdown,
  filePath,
  vaultPath,
  lang,
  llmConfig,
  enabled = true,
}: UseEditorSuggestionsParams) {
  const [suggestions, setSuggestions] = useState<EditorSuggestion[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const dismissedRef = useRef<Set<string>>(new Set());
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScanHashRef = useRef<string>('');
  const isZh = lang === 'zh';

  // Extract meaningful paragraphs from markdown (skip frontmatter, code blocks, headings)
  const extractParagraphs = useCallback((md: string): { text: string; start: number; end: number }[] => {
    const paragraphs: { text: string; start: number; end: number }[] = [];
    const lines = md.split('\n');
    let inFrontmatter = false;
    let inCodeBlock = false;
    let currentPara = '';
    let paraStart = 0;
    let offset = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineStart = offset;
      offset += line.length + 1; // +1 for newline

      // Track frontmatter
      if (i === 0 && line.trim() === '---') { inFrontmatter = true; continue; }
      if (inFrontmatter) {
        if (line.trim() === '---') inFrontmatter = false;
        continue;
      }

      // Track code blocks
      if (line.trim().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock) continue;

      // Skip headings, links-only lines, empty lines
      if (line.trim().startsWith('#')) continue;
      if (line.trim().startsWith('!')) continue; // images
      if (/^\s*[-*]\s*$/.test(line)) continue; // empty list items

      const trimmed = line.trim();
      if (trimmed.length === 0) {
        // End of paragraph
        if (currentPara.trim().length > 30) {
          paragraphs.push({
            text: currentPara.trim(),
            start: paraStart,
            end: lineStart - 1,
          });
        }
        currentPara = '';
        continue;
      }

      if (currentPara.length === 0) paraStart = lineStart;
      currentPara += (currentPara ? ' ' : '') + trimmed;
    }

    // Flush final paragraph
    if (currentPara.trim().length > 30) {
      paragraphs.push({
        text: currentPara.trim(),
        start: paraStart,
        end: offset - 1,
      });
    }

    return paragraphs;
  }, []);

  // Core scanning function
  const runScan = useCallback(async () => {
    if (!vaultPath || !filePath || !enabled) return;

    // Simple content hash to avoid re-scanning identical content
    const contentHash = markdown.length + ':' + markdown.slice(0, 200) + ':' + markdown.slice(-200);
    if (contentHash === lastScanHashRef.current) return;
    lastScanHashRef.current = contentHash;

    setIsScanning(true);
    try {
      const paragraphs = extractParagraphs(markdown);
      if (paragraphs.length === 0) { setIsScanning(false); return; }

      // Take top 5 longest paragraphs (most likely to contain claims)
      const candidates = [...paragraphs]
        .sort((a, b) => b.text.length - a.text.length)
        .slice(0, 5);

      const newSuggestions: EditorSuggestion[] = [];

      for (const para of candidates) {
        if (newSuggestions.length >= 3) break; // Cap at 3 suggestions

        // Search for related chunks in the vault
        try {
          const chunks = await searchChunks({
            query: para.text.slice(0, 200),
            limit: 3
          });
          // Filter out chunks from the same file and low scores
          const relevantChunks = chunks.filter((c: any) => {
            const chunkPath = (c.file_path || '').replace(/\\/g, '/');
            const currentPath = filePath.replace(/\\/g, '/');
            return chunkPath !== currentPath && c.content && c.content.length > 20 && (c.score ?? 0) >= 0.75;
          });

          if (relevantChunks.length === 0) continue;

          // Use LLM to check for factual conflicts between current text and related chunks
          const chunkTexts = relevantChunks.map((c: any) =>
            `[来源: ${(c.file_path || '').split('/').pop()?.replace('.md', '')}]\n${c.content?.slice(0, 300) || ''}`
          ).join('\n\n');

          const prompt = isZh
            ? `你是一个事实核查助手。分析以下当前段落和已有笔记片段之间是否存在事实性矛盾或过时信息。

当前段落:
"${para.text.slice(0, 400)}"

已有笔记片段:
${chunkTexts}

如果存在矛盾或过时信息，请以以下JSON格式回复（只输出JSON，不要其他内容）：
{"conflict": true, "type": "temporal_conflict|factual_conflict|outdated_claim", "explanation": "简短解释", "source": "来源笔记标题", "confidence": 0.0-1.0, "suggested_fix": "修正后的段落文本"}

如果没有冲突，回复：
{"conflict": false}`
            : `You are a fact-checking assistant. Analyze if there are factual contradictions or outdated information between the current paragraph and existing note fragments.

Current paragraph:
"${para.text.slice(0, 400)}"

Existing note fragments:
${chunkTexts}

If a conflict exists, reply with ONLY this JSON (no other text):
{"conflict": true, "type": "temporal_conflict|factual_conflict|outdated_claim", "explanation": "brief explanation", "source": "source note title", "confidence": 0.0-1.0, "suggested_fix": "the corrected version of the paragraph"}

If no conflict, reply:
{"conflict": false}`;

          const response = await chatWithLlm({
            messages: [{ role: 'user', content: prompt }],
            apiUrl: llmConfig?.apiUrl,
            model: llmConfig?.model,
            apiKey: llmConfig?.apiKey || undefined,
            providerId: llmConfig?.providerId,
          });
          
          // Parse LLM response
          try {
            const responseText = response.content || '';
            // Extract JSON from response (handle possible markdown wrapping)
            const jsonMatch = responseText.match(/\{[\s\S]*?\}/);
            if (!jsonMatch) continue;
            
            const result = JSON.parse(jsonMatch[0]);
            if (!result.conflict) continue;
            if (result.confidence < 0.6) continue;

            const suggestionId = `suggestion-${para.start}-${para.end}`;
            if (dismissedRef.current.has(suggestionId)) continue;

            const sourceChunk = relevantChunks[0];
            newSuggestions.push({
              id: suggestionId,
              triggerText: para.text,
              startOffset: para.start,
              endOffset: para.end,
              conflictingClaim: sourceChunk.content?.slice(0, 200) || '',
              sourcePath: sourceChunk.file_path || '',
              sourceTitle: result.source || (sourceChunk.file_path || '').split('/').pop()?.replace('.md', '') || 'Unknown',
              explanation: result.explanation || '',
              type: result.type || 'factual_conflict',
              confidence: result.confidence || 0.7,
              suggestedFix: result.suggested_fix || undefined,
            });
          } catch {
            // JSON parse failed, skip this paragraph
            continue;
          }
        } catch {
          // searchChunks or chatWithLlm failed, skip
          continue;
        }
      }

      setSuggestions(newSuggestions);
    } catch (err) {
      console.warn('EditorSuggestions scan failed:', err);
    } finally {
      setIsScanning(false);
    }
  }, [markdown, filePath, vaultPath, enabled, extractParagraphs, isZh]);

  // Debounced trigger on markdown changes
  useEffect(() => {
    if (!enabled || !vaultPath || !filePath) return;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      runScan();
    }, 3000); // 3s debounce to avoid scanning while typing
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [markdown, enabled, vaultPath, filePath]); // intentionally not including runScan to avoid re-triggering

  // Listen for backend reconciliation conflict events
  useEffect(() => {
    if (!enabled || !filePath) return;

    const unlisten = listen<{ file_path: string; conflicts: Array<{
      section_heading: string;
      user_content: string;
      ai_content: string;
      explanation: string;
      confidence: number;
    }> }>('reconciliation-conflicts', (event) => {
      const { file_path: conflictPath, conflicts } = event.payload;
      // Only apply to the currently open file
      const normalizedCurrent = filePath.replace(/\\/g, '/');
      const normalizedConflict = conflictPath.replace(/\\/g, '/');
      if (normalizedCurrent !== normalizedConflict) return;

      const newSuggestions: EditorSuggestion[] = conflicts.map((c, i) => {
        // Try to find the section heading offset in the markdown
        const headingIndex = markdown.indexOf(c.section_heading);
        const startOffset = headingIndex >= 0 ? headingIndex : 0;
        const endOffset = startOffset + (c.user_content?.length || 100);

        return {
          id: `recon-${c.section_heading}-${i}`,
          triggerText: c.user_content?.slice(0, 200) || c.section_heading,
          startOffset,
          endOffset,
          conflictingClaim: c.ai_content?.slice(0, 200) || '',
          sourcePath: conflictPath,
          sourceTitle: c.section_heading.replace(/^#+\s*/, ''),
          explanation: c.explanation,
          type: 'reconciliation_conflict',
          confidence: c.confidence,
          userVersion: c.user_content,
          aiVersion: c.ai_content,
          sectionHeading: c.section_heading,
        };
      });

      // Merge with existing suggestions (reconciliation conflicts take priority)
      setSuggestions(prev => {
        const filtered = prev.filter(s => s.type !== 'reconciliation_conflict');
        return [...newSuggestions, ...filtered].slice(0, 5); // Cap at 5 total
      });
    });

    return () => {
      unlisten.then(fn => fn());
    };
  }, [filePath, enabled, markdown]);

  // Dismiss a suggestion
  const dismissSuggestion = useCallback((suggestionId: string) => {
    dismissedRef.current.add(suggestionId);
    setSuggestions(prev => prev.filter(s => s.id !== suggestionId));
  }, []);

  // Accept a suggestion (replace the text)
  const acceptSuggestion = useCallback((suggestionId: string): { start: number; end: number; replacement: string } | null => {
    const sug = suggestions.find(s => s.id === suggestionId);
    if (!sug || !sug.suggestedFix) return null;
    dismissedRef.current.add(suggestionId);
    setSuggestions(prev => prev.filter(s => s.id !== suggestionId));
    return { start: sug.startOffset, end: sug.endOffset, replacement: sug.suggestedFix };
  }, [suggestions]);

  // Resolve a reconciliation conflict via backend
  const resolveReconciliationConflict = useCallback(async (
    suggestionId: string,
    resolution: 'keep_user' | 'keep_ai',
  ): Promise<boolean> => {
    const sug = suggestions.find(s => s.id === suggestionId);
    if (!sug || sug.type !== 'reconciliation_conflict' || !filePath) return false;

    try {
      const result = await resolveFileConflict(
        filePath,
        sug.sectionHeading || sug.sourceTitle,
        resolution,
      );
      if (result) {
        dismissedRef.current.add(suggestionId);
        setSuggestions(prev => prev.filter(s => s.id !== suggestionId));
      }
      return result;
    } catch (e) {
      console.warn('Failed to resolve reconciliation conflict:', e);
      return false;
    }
  }, [suggestions, filePath]);

  // Manual trigger
  const triggerScan = useCallback(() => {
    lastScanHashRef.current = ''; // Force rescan
    runScan();
  }, [runScan]);

  // Clear all suggestions
  const clearSuggestions = useCallback(() => {
    setSuggestions([]);
  }, []);

  return {
    suggestions,
    isScanning,
    dismissSuggestion,
    acceptSuggestion,
    resolveReconciliationConflict,
    triggerScan,
    clearSuggestions,
  };
}
