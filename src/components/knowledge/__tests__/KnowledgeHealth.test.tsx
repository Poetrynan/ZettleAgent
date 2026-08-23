import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom';

import { KnowledgeHealth, verdictOf } from '../KnowledgeHealth';
import {
  EmbeddingStats,
  KnowledgeIndexHealth,
  LintReport,
  createNoteForLink,
  finalizeEmbeddingIndex,
  fixBrokenLink,
  getEmbeddingStats,
  getKnowledgeIndexHealth,
  runKnowledgeBackfill,
  runVaultLint,
  syncVault,
} from '../../../lib/tauri';
import { setLang } from '../../../lib/i18n';
import { en } from '../../../lib/i18n/en';
import { zh } from '../../../lib/i18n/zh';

vi.mock('../../../lib/tauri', () => ({
  createNoteForLink: vi.fn(),
  finalizeEmbeddingIndex: vi.fn().mockResolvedValue(undefined),
  fixBrokenLink: vi.fn().mockResolvedValue(undefined),
  getEmbeddingStats: vi.fn(),
  getKnowledgeIndexHealth: vi.fn(),
  runKnowledgeBackfill: vi.fn(),
  runVaultLint: vi.fn(),
  syncVault: vi.fn(),
}));

function health(over: Partial<KnowledgeIndexHealth> = {}): KnowledgeIndexHealth {
  return {
    schemaVersion: 7,
    totalFiles: 40,
    indexedDocuments: 40,
    blockObjects: 120,
    pendingJobs: 0,
    failedJobs: 0,
    lastError: null,
    lastRunAtMs: 1_700_000_000_000,
    memoryItems: 5,
    memoryInbox: 0,
    openChangesets: 0,
    openCommitments: 0,
    ...over,
  };
}

function embedding(over: Partial<EmbeddingStats> = {}): EmbeddingStats {
  return { total_chunks: 100, indexed_chunks: 100, has_index: true, ...over };
}

function lint(over: Partial<LintReport> = {}): LintReport {
  return {
    orphans: [],
    broken_links: [],
    missing_metadata: [],
    graph_health: {
      connected_components: 1,
      largest_component_size: 40,
      total_nodes: 40,
      total_edges: 60,
      hub_overload: [],
      unidirectional_relations: [],
      missing_embeddings: 0,
    },
    semantic_duplicates: [],
    hidden_connections: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setLang('en');
  vi.mocked(getKnowledgeIndexHealth).mockResolvedValue(health());
  vi.mocked(getEmbeddingStats).mockResolvedValue(embedding());
  vi.mocked(runVaultLint).mockResolvedValue(lint());
});

describe('verdictOf', () => {
  it('says the Agent can work only when nothing is missing', () => {
    const { verdict, reasons } = verdictOf(health(), embedding());
    expect(verdict).toBe('ok');
    expect(reasons).toEqual([]);
  });

  it('treats an empty object layer as blocking, not merely degraded', () => {
    const { verdict } = verdictOf(health({ totalFiles: 40, indexedDocuments: 0 }), embedding());
    expect(verdict).toBe('blocked');
  });

  it('names every reason it found, not just the first', () => {
    const { verdict, reasons } = verdictOf(
      health({ totalFiles: 40, indexedDocuments: 30, failedJobs: 2, lastError: 'timeout' }),
      embedding({ indexed_chunks: 0 }),
    );
    expect(verdict).toBe('degraded');
    expect(reasons.map(r => r.code)).toEqual([
      'identityGap',
      'failedJobs',
      'lastError',
      'noEmbeddings',
    ]);
  });

  it('distinguishes "no embeddings at all" from "some missing"', () => {
    const partial = verdictOf(health(), embedding({ indexed_chunks: 60 }));
    expect(partial.reasons.map(r => r.code)).toEqual(['someEmbeddings']);
    expect(partial.reasons[0].text).toContain('40');
  });

  it('does not invent an embedding problem before the stats arrive', () => {
    expect(verdictOf(health(), null).verdict).toBe('ok');
  });
});

describe('KnowledgeHealth', () => {
  it('leads with a verdict in plain words, not a score', async () => {
    render(<KnowledgeHealth />);
    expect(await screen.findByText('The Agent can work from your notes.')).toBeInTheDocument();
  });

  it('keeps indexing until the backend says there is nothing left', async () => {
    vi.mocked(getKnowledgeIndexHealth).mockResolvedValue(
      health({ totalFiles: 40, indexedDocuments: 20 }),
    );
    vi.mocked(runKnowledgeBackfill)
      .mockResolvedValueOnce({ processed: 10, created: 10, failed: 0, remaining: 10, hasMore: true })
      .mockResolvedValueOnce({ processed: 10, created: 10, failed: 0, remaining: 0, hasMore: false });

    render(<KnowledgeHealth />);
    fireEvent.click(await screen.findByRole('button', { name: 'Index the rest' }));

    await waitFor(() => expect(runKnowledgeBackfill).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('20 handled, 20 given an identity, 0 failed, 0 left')).toBeInTheDocument();
  });

  it('offers nothing to index when there is nothing to index', async () => {
    render(<KnowledgeHealth />);
    expect(await screen.findByRole('button', { name: 'Index the rest' })).toBeDisabled();
  });

  it('only offers a rescan when it knows which vault', async () => {
    const { unmount } = render(<KnowledgeHealth />);
    await screen.findByText('Identity and indexing');
    expect(screen.queryByRole('button', { name: 'Rescan the vault' })).toBeNull();
    unmount();

    render(<KnowledgeHealth vaultPath={'D:\\vault'} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rescan the vault' }));
    await waitFor(() => expect(syncVault).toHaveBeenCalledWith('D:\\vault'));
  });

  it('says meaning-based recall is off rather than showing a bare zero', async () => {
    vi.mocked(getEmbeddingStats).mockResolvedValue(embedding({ indexed_chunks: 0 }));
    render(<KnowledgeHealth />);

    expect(
      await screen.findByText('Meaning-based recall is off. Search falls back to keywords.'),
    ).toBeInTheDocument();
  });

  it('recomputes related-note links without claiming to rebuild the index', async () => {
    render(<KnowledgeHealth />);
    fireEvent.click(await screen.findByRole('button', { name: 'Recompute related-note links' }));

    await waitFor(() => expect(finalizeEmbeddingIndex).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Related-note links recomputed.')).toBeInTheDocument();
    expect(
      screen.getByText(/no safe rebuild for the keyword or vector index/),
    ).toBeInTheDocument();
  });

  it('reads every note only when asked', async () => {
    render(<KnowledgeHealth />);
    await screen.findByText('Problems in the notes themselves');
    expect(runVaultLint).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Check the notes' }));
    await waitFor(() => expect(runVaultLint).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText('No broken links, and every note is reachable.'),
    ).toBeInTheDocument();
  });

  it('fixes one broken link at a time, and never guesses a target', async () => {
    vi.mocked(runVaultLint).mockResolvedValue(
      lint({
        broken_links: [
          {
            file_path: 'D:\\vault\\a.md',
            target_title: 'Retro 2024',
            line_number: 12,
            context: 'see [[Retro 2024]]',
            suggested_fix: 'Retro 2024-06',
          },
          {
            file_path: 'D:\\vault\\b.md',
            target_title: 'Nowhere',
            line_number: 3,
            context: 'see [[Nowhere]]',
          },
        ],
      }),
    );
    render(<KnowledgeHealth />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check the notes' }));

    // 有相近目标的给"改指向"，没有的只说"自己改"，不替用户猜一个。
    expect(await screen.findByRole('button', { name: 'Point it at "Retro 2024-06"' })).toBeInTheDocument();
    expect(
      screen.getByText('No close match. Create the note, or fix the link in the editor.'),
    ).toBeInTheDocument();
    expect(screen.getByText('a.md, line 12')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Point it at "Retro 2024-06"' }));
    await waitFor(() =>
      expect(fixBrokenLink).toHaveBeenCalledWith(
        'D:\\vault\\a.md',
        'Retro 2024',
        12,
        'replace',
        'Retro 2024-06',
      ),
    );
    // 修完必须重新扫一遍，否则列表会一直显示已经修好的那条。
    expect(runVaultLint).toHaveBeenCalledTimes(2);
  });

  it('can create the missing target instead', async () => {
    vi.mocked(createNoteForLink).mockResolvedValue('D:\\vault\\Nowhere.md');
    vi.mocked(runVaultLint).mockResolvedValue(
      lint({
        broken_links: [
          {
            file_path: 'D:\\vault\\b.md',
            target_title: 'Nowhere',
            line_number: 3,
            context: 'see [[Nowhere]]',
          },
        ],
      }),
    );
    render(<KnowledgeHealth />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check the notes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create "Nowhere"' }));

    await waitFor(() => expect(createNoteForLink).toHaveBeenCalledWith('Nowhere'));
    expect(await screen.findByText('Created Nowhere.md')).toBeInTheDocument();
  });

  it('sends the queues to the page that can act on them', async () => {
    const onOpenPage = vi.fn();
    vi.mocked(getKnowledgeIndexHealth).mockResolvedValue(health({ openChangesets: 2 }));
    render(<KnowledgeHealth onOpenPage={onOpenPage} />);

    await screen.findByText('Waiting on you');
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onOpenPage).toHaveBeenCalledWith('changes');
  });

  it('keeps the page usable when the embedding stats fail', async () => {
    vi.mocked(getEmbeddingStats).mockRejectedValue(new Error('no vector table'));
    render(<KnowledgeHealth />);

    expect(await screen.findByText('Identity and indexing')).toBeInTheDocument();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  });
});

describe('copy', () => {
  it('has both languages for every health string', () => {
    const keys = Object.keys(en).filter(k => k.startsWith('knowledge.health.'));
    expect(keys.length).toBeGreaterThan(50);
    for (const key of keys) {
      expect(zh[key as keyof typeof zh], `zh is missing ${key}`).toBeTruthy();
    }
  });
});



