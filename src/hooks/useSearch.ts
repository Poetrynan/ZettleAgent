import { useState, useCallback } from 'react';
import { searchChunks, SearchResult, SearchQuery } from '../lib/tauri';
import { useApp } from '../contexts/AppContext';

export function useSearch() {
  const { state } = useApp();
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const executeSearch = useCallback(async (queryText: string, customLimit?: number) => {
    if (!queryText.trim()) {
      setResults([]);
      return;
    }

    setSearching(true);
    setError(null);

    try {
      const params: SearchQuery = {
        query: queryText,
        limit: customLimit ?? 20,
        mode: state.searchMode ?? 'hybrid',
      };

      const searchResults = await searchChunks(params);
      setResults(searchResults);
    } catch (err) {
      console.error('Search failed:', err);
      setError(String(err));
    } finally {
      setSearching(false);
    }
  }, [state.searchMode]);

  return {
    results,
    searching,
    error,
    executeSearch,
  };
}
