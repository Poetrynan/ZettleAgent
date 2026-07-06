import { useState, useEffect } from 'react';
import { useApp } from '../../contexts/AppContext';
import { getBacklinks, BacklinkEntry } from '../../lib/tauri';
import { IconLink } from '../icons';

/**
 * Backlinks Panel — shows notes that link to the current note.
 * Displayed at the bottom of MarkdownViewer in read mode.
 */
export function BacklinksPanel({ filePath }: { filePath: string }) {
  const { setCurrentFile, setView } = useApp();
  const [backlinks, setBacklinks] = useState<BacklinkEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isExpanded, setIsExpanded] = useState(true);

  useEffect(() => {
    if (!filePath) return;
    setIsLoading(true);
    getBacklinks(filePath)
      .then(setBacklinks)
      .catch(err => console.error('Failed to load backlinks:', err))
      .finally(() => setIsLoading(false));
  }, [filePath]);

  const handleClick = (path: string) => {
    setCurrentFile(path);
    setView('note');
  };

  const getFileName = (path: string) =>
    path.replace(/\\/g, '/').split('/').pop()?.replace('.md', '') || path;

  if (isLoading) return null;

  return (
    <div className="backlinks-panel">
      <button
        className="backlinks-header"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <IconLink size={14} />
        <span>Backlinks</span>
        <span className="backlinks-count">{backlinks.length}</span>
        <span className="backlinks-chevron">{isExpanded ? '▼' : '▶'}</span>
      </button>

      {isExpanded && (
        <div className="backlinks-list">
          {backlinks.length === 0 ? (
            <div className="backlinks-empty">No other notes link here yet.</div>
          ) : (
            backlinks.map((bl) => (
              <button
                key={bl.file_path}
                className="backlinks-item"
                onClick={() => handleClick(bl.file_path)}
              >
                <span className="backlinks-item-title">{bl.title || getFileName(bl.file_path)}</span>
                {bl.context && (
                  <span className="backlinks-item-context">{bl.context}</span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
