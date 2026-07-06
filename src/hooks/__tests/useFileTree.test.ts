import { renderHook, act } from '@testing-library/react';
import { useFileTree } from '../useFileTree';
import { listDirectoryTree } from '../../lib/tauri';
import { useApp } from '../../contexts/AppContext';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../lib/tauri', () => ({
  listDirectoryTree: vi.fn(),
}));

vi.mock('../../contexts/AppContext', () => ({
  useApp: vi.fn(),
}));

const mockTree = {
  name: 'vault',
  path: '/vault',
  is_dir: true,
  file_count: 2,
  children: [
    {
      name: 'folder1',
      path: '/vault/folder1',
      is_dir: true,
      file_count: 1,
      children: [
        {
          name: 'note1.md',
          path: '/vault/folder1/note1.md',
          is_dir: false,
          file_count: 0,
          children: [],
        }
      ],
    },
    {
      name: 'note2.md',
      path: '/vault/note2.md',
      is_dir: false,
      file_count: 0,
      children: [],
    }
  ],
};

describe('useFileTree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('should initialize with null tree, loading false, and default empty Set for expanded folders', () => {
    vi.mocked(useApp).mockReturnValue({
      state: {
        vaultPath: null,
        searchQuery: '',
      },
    } as any);

    const { result } = renderHook(() => useFileTree());

    expect(result.current.tree).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.expandedFolders).toBeInstanceOf(Set);
    expect(result.current.expandedFolders.size).toBe(0);
  });

  it('should load directory tree when vaultPath is provided', async () => {
    vi.mocked(listDirectoryTree).mockResolvedValue(mockTree as any);
    vi.mocked(useApp).mockReturnValue({
      state: {
        vaultPath: '/vault',
        vaultPaths: ['/vault'],
        searchQuery: '',
      },
    } as any);

    const { result } = renderHook(() => useFileTree());

    expect(result.current.loading).toBe(true);

    // Wait for the useEffect to fetch and complete
    await act(async () => {
      // Allow promise to resolve
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.tree).toEqual(mockTree);
    expect(result.current.error).toBeNull();
    expect(listDirectoryTree).toHaveBeenCalledWith('/vault');
  });

  it('should toggle, expand and collapse folders, and persist to localStorage', () => {
    vi.mocked(useApp).mockReturnValue({
      state: {
        vaultPath: null,
        searchQuery: '',
      },
    } as any);

    const { result } = renderHook(() => useFileTree());

    act(() => {
      result.current.toggleFolder('/vault/folder1');
    });

    expect(result.current.expandedFolders.has('/vault/folder1')).toBe(true);
    expect(JSON.parse(localStorage.getItem('zettelagent:expanded_folders') || '[]')).toEqual(['/vault/folder1']);

    act(() => {
      result.current.collapseFolder('/vault/folder1');
    });

    expect(result.current.expandedFolders.has('/vault/folder1')).toBe(false);

    act(() => {
      result.current.expandFolder('/vault/folder1');
    });

    expect(result.current.expandedFolders.has('/vault/folder1')).toBe(true);
  });

  it('should filter tree recursively and return searchExpandedFolders with parent paths when searchQuery is active', async () => {
    vi.mocked(listDirectoryTree).mockResolvedValue(mockTree as any);
    
    // Set searchQuery to search for 'note1'
    vi.mocked(useApp).mockReturnValue({
      state: {
        vaultPath: '/vault',
        vaultPaths: ['/vault'],
        searchQuery: 'note1',
      },
    } as any);

    const { result } = renderHook(() => useFileTree());

    await act(async () => {
      // Allow listDirectoryTree to resolve
    });

    // The filtered tree should only contain note1.md and its ancestors
    expect(result.current.tree).not.toBeNull();
    expect(result.current.tree?.children.length).toBe(1);
    expect(result.current.tree?.children[0].name).toBe('folder1');
    expect(result.current.tree?.children[0].children[0].name).toBe('note1.md');

    // It should have auto-expanded '/vault/folder1' and '/vault' (since folder1 contains the match)
    expect(result.current.searchExpandedFolders.has('/vault/folder1')).toBe(true);
    expect(result.current.searchExpandedFolders.has('/vault')).toBe(true);
  });
});
