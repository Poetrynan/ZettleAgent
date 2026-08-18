/**
 * The MCP server card's load-bearing claim: read-only.
 *
 * The backend exposes no writer (`EXPOSED_TOOLS` has none, and the connection is
 * opened `SQLITE_OPEN_READ_ONLY`), so the UI must say so and must not grow any
 * control that implies otherwise — no enable switch, no port, no token.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom';

import { McpServerExposeSection } from '../McpServerExposeSection';
import { getDbPath, parseMcpServerCapabilities } from '../../../lib/tauri';
import { setLang } from '../../../lib/i18n';

vi.mock('../../../lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/tauri')>('../../../lib/tauri');
  return {
    ...actual,
    getDbPath: vi.fn(),
    mcpServerClientConfig: vi.fn(),
    parseMcpServerCapabilities: vi.fn(),
  };
});

const dbPathMock = getDbPath as unknown as ReturnType<typeof vi.fn>;
const capsMock = parseMcpServerCapabilities as unknown as ReturnType<typeof vi.fn>;

const CAPS = {
  protocolVersion: '2024-11-05',
  readOnly: true,
  tools: ['search_notes', 'read_note'],
  resources: { scheme: 'zettel://', mimeType: 'text/markdown' },
  prompts: ['summarize_vault'],
};

beforeEach(() => {
  setLang('en');
  dbPathMock.mockReset();
  capsMock.mockReset();
});

describe('McpServerExposeSection', () => {
  it('labels the exposure read-only and spells out what is not possible', async () => {
    dbPathMock.mockResolvedValue('C:/vault/.zettelagent/index.db');
    capsMock.mockResolvedValue(CAPS);

    render(<McpServerExposeSection />);

    await waitFor(() => expect(screen.getByTestId('mcp-readonly-note')).toBeInTheDocument());
    expect(screen.getByText('Read-only')).toBeInTheDocument();
    expect(screen.getByText(/cannot create, edit, move or delete/)).toBeInTheDocument();
  });

  it('offers no listener, port or token control — stdio has none of those', async () => {
    dbPathMock.mockResolvedValue('C:/vault/.zettelagent/index.db');
    capsMock.mockResolvedValue(CAPS);

    const { container } = render(<McpServerExposeSection />);
    await waitFor(() => expect(screen.getByTestId('mcp-readonly-note')).toBeInTheDocument());

    // The only interactive element is the copy button.
    expect(container.querySelectorAll('input')).toHaveLength(0);
    expect(container.querySelectorAll('[role="switch"]')).toHaveLength(0);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('renders the capability list the backend reports, not a hard-coded one', async () => {
    dbPathMock.mockResolvedValue('C:/vault/.zettelagent/index.db');
    capsMock.mockResolvedValue(CAPS);

    render(<McpServerExposeSection />);

    await waitFor(() => expect(screen.getByText('search_notes')).toBeInTheDocument());
    expect(screen.getByText('read_note')).toBeInTheDocument();
    expect(screen.getByText('summarize_vault')).toBeInTheDocument();
    expect(screen.getByText(/2024-11-05/)).toBeInTheDocument();
  });

  it('says so plainly when the build has no MCP server', async () => {
    dbPathMock.mockResolvedValue('C:/vault/.zettelagent/index.db');
    capsMock.mockResolvedValue(null);

    render(<McpServerExposeSection />);

    await waitFor(() => {
      expect(screen.getByText(/not available in this build/)).toBeInTheDocument();
    });
    // No copy button to click into a failure.
    expect(screen.queryByTestId('mcp-readonly-note')).not.toBeInTheDocument();
  });

  it('disables the copy button until the db path resolves', async () => {
    dbPathMock.mockRejectedValue(new Error('no vault'));
    capsMock.mockResolvedValue(CAPS);

    render(<McpServerExposeSection />);

    await waitFor(() => expect(screen.getByTestId('mcp-readonly-note')).toBeInTheDocument());
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
