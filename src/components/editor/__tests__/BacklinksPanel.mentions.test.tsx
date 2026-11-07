import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom';

import { BacklinksPanel } from '../BacklinksPanel';
import {
  getBacklinks,
  getUnlinkedMentions,
  linkUnlinkedMention,
  undoLinkMention,
} from '../../../lib/tauri';

const showToast = vi.fn();
vi.mock('../../../contexts/AppContext', () => ({
  useApp: () => ({ setCurrentFile: vi.fn(), setView: vi.fn(), showToast }),
}));

vi.mock('../../../lib/tauri', () => ({
  getBacklinks: vi.fn(),
  getUnlinkedMentions: vi.fn(),
  linkUnlinkedMention: vi.fn(),
  undoLinkMention: vi.fn(),
}));

const mention = {
  filePath: '/v/src.md',
  title: '来源',
  line: 2,
  column: 5,
  matched: '知識圖譜',
  before: '我們在構建',
  after: '系統。',
};
const linkResult = { snapshotId: 7, postHash: 'h', link: '[[知识图谱|知識圖譜]]' };

describe('BacklinksPanel unlinked mentions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getBacklinks).mockResolvedValue([]);
    vi.mocked(getUnlinkedMentions).mockResolvedValue({ mentions: [mention], terms: ['知识图谱'], truncated: false });
    vi.mocked(linkUnlinkedMention).mockResolvedValue(linkResult);
    vi.mocked(undoLinkMention).mockResolvedValue(undefined);
  });

  async function openMentions() {
    render(<BacklinksPanel filePath="/v/知识图谱.md" />);
    const header = await screen.findByText(/^(未链接提及|Unlinked mentions)$/);
    // Loaded lazily: nothing is read from disk until the section is opened.
    expect(getUnlinkedMentions).not.toHaveBeenCalled();
    fireEvent.click(header);
    await screen.findByText('知識圖譜');
  }

  it('loads on demand and shows the mention in context', async () => {
    await openMentions();
    expect(getUnlinkedMentions).toHaveBeenCalledWith('/v/知识图谱.md');
    expect(screen.getByText('知識圖譜').tagName).toBe('MARK');
    expect(screen.getByText(/我們在構建/)).toBeInTheDocument();
  });

  it('links in place, refreshes backlinks, and can undo', async () => {
    await openMentions();
    fireEvent.click(screen.getByRole('button', { name: /^(链接|Link)$/ }));
    await waitFor(() => expect(linkUnlinkedMention).toHaveBeenCalledWith('/v/src.md', '/v/知识图谱.md', mention));
    expect(getBacklinks).toHaveBeenCalledTimes(2);

    fireEvent.click(await screen.findByRole('button', { name: /^(撤销|Undo)$/ }));
    await waitFor(() => expect(undoLinkMention).toHaveBeenCalledWith('/v/src.md', linkResult));
    expect(await screen.findByRole('button', { name: /^(链接|Link)$/ })).toBeInTheDocument();
  });

  it('a conflict is reported and the list reloaded', async () => {
    vi.mocked(linkUnlinkedMention).mockRejectedValueOnce('Conflict: note changed');
    await openMentions();
    fireEvent.click(screen.getByRole('button', { name: /^(链接|Link)$/ }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining('note changed'), 'error'));
    await waitFor(() => expect(getUnlinkedMentions).toHaveBeenCalledTimes(2));
  });
});
