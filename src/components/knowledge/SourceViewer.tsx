import React, { useEffect, useState } from 'react';
import {
  researchReadSource,
  researchVerifyQuote,
  type SourceReadResult,
  type QuoteVerifyResult,
} from '../../lib/research';
import { IconFile, IconCheck, IconWarning, IconClose, IconExternalLink, IconLoader } from '../icons';

interface SourceViewerProps {
  vaultPath: string | null;
  path: string;
  quote?: string;
  quoteKind?: 'original' | 'translation' | 'paraphrase';
  onClose?: () => void;
  onOpenFile?: (path: string) => void;
}

export function SourceViewer({
  vaultPath,
  path,
  quote,
  quoteKind = 'original',
  onClose,
  onOpenFile,
}: SourceViewerProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sourceData, setSourceData] = useState<SourceReadResult | null>(null);
  const [verifyData, setVerifyData] = useState<QuoteVerifyResult | null>(null);

  // Parse path and hash locator (e.g., path.md#L10-L20 or file.pdf#page=3)
  const [cleanPath, locator] = path.split('#');

  useEffect(() => {
    if (!vaultPath || !cleanPath) return;

    let isMounted = true;
    setLoading(true);
    setError(null);

    const loadData = async () => {
      try {
        const req: Record<string, unknown> = { path: cleanPath };
        if (locator) {
          const lineMatch = locator.match(/^L(\d+)(?:-L(\d+))?$/i);
          if (lineMatch) {
            req.start_line = parseInt(lineMatch[1], 10);
            if (lineMatch[2]) {
              req.end_line = parseInt(lineMatch[2], 10);
            }
          }
          const pageMatch = locator.match(/^page=(\d+)(?:-(\d+))?$/i);
          if (pageMatch) {
            req.start_page = parseInt(pageMatch[1], 10);
            if (pageMatch[2]) {
              req.end_page = parseInt(pageMatch[2], 10);
            }
          }
        }

        const readPromise = researchReadSource(vaultPath, req);
        const verifyPromise = quote?.trim()
          ? researchVerifyQuote(vaultPath, {
              path: cleanPath,
              quote: quote.trim(),
              quote_kind: quoteKind,
              ...(req.start_line ? { start_line: req.start_line } : {}),
              ...(req.end_line ? { end_line: req.end_line } : {}),
              ...(req.start_page ? { start_page: req.start_page } : {}),
              ...(req.end_page ? { end_page: req.end_page } : {}),
            })
          : Promise.resolve(null);

        const [readRes, verifyRes] = await Promise.all([readPromise, verifyPromise]);

        if (isMounted) {
          setSourceData(readRes);
          setVerifyData(verifyRes);
          setLoading(false);
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    };

    void loadData();

    return () => {
      isMounted = false;
    };
  }, [vaultPath, cleanPath, locator, quote, quoteKind]);

  return (
    <div className="source-viewer-modal" role="dialog" aria-label="来源核验查看器">
      <div className="source-viewer-panel">
        <header className="source-viewer-head">
          <div className="source-viewer-title-group">
            <IconFile size={16} />
            <span className="source-viewer-filename">{cleanPath}</span>
            {locator && <span className="source-viewer-locator-pill">#{locator}</span>}
          </div>
          <div className="source-viewer-actions">
            {onOpenFile && (
              <button
                type="button"
                className="kc-btn kc-btn-ghost kc-btn-sm"
                onClick={() => onOpenFile(cleanPath)}
                title="在编辑器中打开完整笔记"
              >
                <IconExternalLink size={14} />
                <span>打开笔记</span>
              </button>
            )}
            {onClose && (
              <button
                type="button"
                className="kc-btn kc-btn-icon"
                onClick={onClose}
                aria-label="关闭查看器"
              >
                <IconClose size={16} />
              </button>
            )}
          </div>
        </header>

        {verifyData && (
          <div className={`source-verify-banner status-${verifyData.status}`}>
            <div className="source-verify-badge">
              {verifyData.status === 'exact' && <IconCheck size={14} />}
              {verifyData.status === 'normalized' && <IconCheck size={14} />}
              {verifyData.status === 'approximate' && <IconWarning size={14} />}
              {verifyData.status === 'not_found' && <IconClose size={14} />}
              {verifyData.status === 'unavailable' && <IconWarning size={14} />}
              <span className="source-verify-status-text">
                {verifyData.status === 'exact' && '原文精确匹配 (Exact Match)'}
                {verifyData.status === 'normalized' && '跨行/空白规范化匹配 (Normalized Match)'}
                {verifyData.status === 'approximate' && '近似匹配 (Approximate Match)'}
                {verifyData.status === 'not_found' && '未在指定范围内找到原句 (Not Found)'}
                {verifyData.status === 'unavailable' && '文本不可读或需要 OCR (Unavailable)'}
              </span>
            </div>

            {quoteKind === 'translation' && (
              <div className="source-verify-warning-kind">
                ⚠️ 声明：此引文为译文（Translation），不代表原文逐字表达，已禁止冒充原文核验。
              </div>
            )}
            {quoteKind === 'paraphrase' && (
              <div className="source-verify-warning-kind">
                ℹ️ 声明：此引文为转述（Paraphrase），非逐字原句。
              </div>
            )}

            {verifyData.matches && verifyData.matches.length > 0 && (
              <div className="source-verify-matches">
                <span className="source-verify-matches-title">命中位置：</span>
                {verifyData.matches.map((m, idx) => (
                  <span key={idx} className="source-match-tag">
                    {m.locator} ({m.excerpt.slice(0, 30)}…)
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="source-viewer-body">
          {loading && (
            <div className="kc-loading-box">
              <IconLoader size={20} />
              <span>正在读取来源片段与校验和…</span>
            </div>
          )}

          {error && (
            <div className="kc-error-box">
              <IconWarning size={16} />
              <span>读取失败：{error}</span>
            </div>
          )}

          {!loading && !error && sourceData && (
            <div className="source-viewer-content">
              <div className="source-metadata-strip">
                <span>类型: {sourceData.kind}</span>
                <span>SHA-256: {sourceData.source_checksum.slice(0, 12)}…</span>
                {sourceData.total_lines && <span>总行数: {sourceData.total_lines}</span>}
                {sourceData.total_pages && <span>总物理页: {sourceData.total_pages}</span>}
              </div>

              <div className="source-segments-list">
                {sourceData.segments.map((seg, idx) => (
                  <div key={idx} className="source-segment-row">
                    <div className="source-segment-gutter">
                      {seg.page !== undefined
                        ? `P.${seg.page}`
                        : seg.start_line !== undefined
                        ? `${seg.start_line}`
                        : `#${idx + 1}`}
                    </div>
                    <pre className="source-segment-text">
                      <code>{seg.content}</code>
                    </pre>
                  </div>
                ))}
              </div>

              {sourceData.truncated && (
                <div className="source-truncated-notice">
                  ⚠️ 片段已被预算截断。下一起始位置：
                  {sourceData.next_start_line
                    ? ` 行 ${sourceData.next_start_line}`
                    : sourceData.next_start_page
                    ? ` 页 ${sourceData.next_start_page}`
                    : '更多内容未展示'}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
