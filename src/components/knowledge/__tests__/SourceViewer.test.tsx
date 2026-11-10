import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom';

import { SourceViewer } from '../SourceViewer';
import * as researchLib from '../../../lib/research';

vi.mock('../../../lib/research', () => ({
  researchAction: vi.fn(),
  researchReadSource: vi.fn(),
  researchVerifyQuote: vi.fn(),
  researchCaptureSource: vi.fn(),
}));

describe('SourceViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders exact quote verification and line segments', async () => {
    vi.mocked(researchLib.researchReadSource).mockResolvedValue({
      path: 'notes/test.md',
      source_id: 'notes/test.md',
      source_checksum: 'abc123sha256',
      kind: 'markdown',
      locator: '#L10-L11',
      segments: [
        {
          content: 'Line 10: Original passage with undeniable proof.',
          locator: '#L10-L10',
          start_line: 10,
          end_line: 10,
        },
      ],
      truncated: false,
      total_lines: 50,
    });

    vi.mocked(researchLib.researchVerifyQuote).mockResolvedValue({
      path: 'notes/test.md',
      source_checksum: 'abc123sha256',
      status: 'exact',
      verified: true,
      quote_kind: 'original',
      matches: [
        {
          excerpt: 'Original passage with undeniable proof.',
          locator: '#L10-L10',
          start_line: 10,
          end_line: 10,
        },
      ],
      truncated: false,
    });

    render(
      <SourceViewer
        vaultPath="/test/vault"
        path="notes/test.md#L10-L11"
        quote="Original passage with undeniable proof."
        quoteKind="original"
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/原文精确匹配/)).toBeInTheDocument();
      expect(screen.getByText('notes/test.md')).toBeInTheDocument();
      expect(screen.getByText('#L10-L11')).toBeInTheDocument();
    });

    expect(
      screen.getByText('Line 10: Original passage with undeniable proof.')
    ).toBeInTheDocument();
  });

  it('warns when quote is marked as translation and does not pretend it is original', async () => {
    vi.mocked(researchLib.researchReadSource).mockResolvedValue({
      path: 'sources/german.txt',
      source_id: 'sources/german.txt',
      source_checksum: 'sha999',
      kind: 'text',
      locator: '#L1-L2',
      segments: [{ content: 'Originaler deutscher Text.', locator: '#L1-L1', start_line: 1 }],
      truncated: false,
    });

    vi.mocked(researchLib.researchVerifyQuote).mockResolvedValue({
      path: 'sources/german.txt',
      source_checksum: 'sha999',
      status: 'not_found',
      verified: false,
      quote_kind: 'translation',
      matches: [],
      truncated: false,
    });

    render(
      <SourceViewer
        vaultPath="/test/vault"
        path="sources/german.txt"
        quote="Chinese translation of text"
        quoteKind="translation"
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/此引文为译文（Translation）/)).toBeInTheDocument();
      expect(screen.getByText(/未在指定范围内找到原句/)).toBeInTheDocument();
    });
  });
});
