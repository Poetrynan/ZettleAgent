import { renderHook, act } from '@testing-library/react';
import { useSearch } from '../useSearch';
import { searchChunks } from '../../lib/tauri';
import { useApp } from '../../contexts/AppContext';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../lib/tauri', () => ({
  searchChunks: vi.fn(),
}));

vi.mock('../../contexts/AppContext', () => ({
  useApp: vi.fn(),
}));

describe('useSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with empty results, not searching, and no error', () => {
    vi.mocked(useApp).mockReturnValue({
      state: {
        searchMode: 'fts',
        embeddingConfig: { enabled: false },
      },
    } as any);

    const { result } = renderHook(() => useSearch());

    expect(result.current.results).toEqual([]);
    expect(result.current.searching).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('should perform search and update results on executeSearch', async () => {
    const mockResults = [{ file_path: 'note1.md', chunk_id: 1, content: 'test content', score: 1 }];
    vi.mocked(searchChunks).mockResolvedValue(mockResults as any);
    vi.mocked(useApp).mockReturnValue({
      state: {
        searchMode: 'fts',
        embeddingConfig: { enabled: false },
      },
    } as any);

    const { result } = renderHook(() => useSearch());

    let searchPromise: Promise<void>;
    act(() => {
      searchPromise = result.current.executeSearch('test query');
    });

    expect(result.current.searching).toBe(true);

    await act(async () => {
      await searchPromise;
    });

    expect(result.current.searching).toBe(false);
    expect(result.current.results).toEqual(mockResults);
    expect(result.current.error).toBeNull();
    expect(searchChunks).toHaveBeenCalledWith({
      query: 'test query',
      limit: 20,
      mode: 'fts',
      embeddingApiUrl: undefined,
      embeddingModel: undefined,
      embeddingDimensions: undefined,
    });
  });

  it('should handle search errors', async () => {
    vi.mocked(searchChunks).mockRejectedValue(new Error('Search failed'));
    vi.mocked(useApp).mockReturnValue({
      state: {
        searchMode: 'fts',
        embeddingConfig: { enabled: false },
      },
    } as any);

    const { result } = renderHook(() => useSearch());

    await act(async () => {
      await result.current.executeSearch('test query');
    });

    expect(result.current.searching).toBe(false);
    expect(result.current.results).toEqual([]);
    expect(result.current.error).toBe('Error: Search failed');
  });
});
