import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom';

import { ResearchWorkspace } from '../ResearchWorkspace';
import * as researchLib from '../../../lib/research';

vi.mock('../../../lib/research', () => ({
  researchAction: vi.fn(),
  researchReadSource: vi.fn(),
  researchVerifyQuote: vi.fn(),
  researchCaptureSource: vi.fn(),
}));

const mockProjects: researchLib.ResearchProject[] = [
  {
    id: 'proj-1',
    title: 'Luhmann Note Method Validation',
    question: 'Did Luhmann really write about non-linear thought?',
    scope: 'vault-1',
    status: 'active',
    version: 1,
    source_paths: ['sources/luhmann1981.pdf'],
    claim_ids: ['claim-1'],
    unresolved_questions: ['Where is the German original?'],
    next_steps: ['Check page 15'],
    artifact_paths: [],
    created_at_ms: 1000,
    updated_at_ms: 2000,
  },
  {
    id: 'proj-2',
    title: 'Caloric Restriction Lifespan',
    question: 'Does CR work in primates?',
    scope: 'vault-1',
    status: 'paused',
    version: 2,
    source_paths: ['sources/weindruch.pdf'],
    claim_ids: [],
    unresolved_questions: [],
    next_steps: [],
    artifact_paths: [],
    created_at_ms: 1000,
    updated_at_ms: 3000,
  },
];

describe('ResearchWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders project list and question details when loaded', async () => {
    vi.mocked(researchLib.researchAction).mockImplementation(async (_vault, action, args: any) => {
      if (action === 'list_projects') {
        return mockProjects;
      }
      if (action === 'get_project') {
        return mockProjects.find(p => p.id === args.id) || mockProjects[0];
      }
      return {};
    });

    render(<ResearchWorkspace vaultPath="/test/vault" />);

    await waitFor(() => {
      expect(screen.getAllByText('Luhmann Note Method Validation').length).toBeGreaterThan(0);
      expect(screen.getByText('Caloric Restriction Lifespan')).toBeInTheDocument();
      expect(screen.getByText('Where is the German original?')).toBeInTheDocument();
    });

    expect(
      screen.getAllByText('Did Luhmann really write about non-linear thought?').length
    ).toBeGreaterThan(0);
    expect(screen.getByText('sources/luhmann1981.pdf')).toBeInTheDocument();
  });

  it('filters projects by search input', async () => {
    vi.mocked(researchLib.researchAction).mockImplementation(async (_vault, action) => {
      if (action === 'list_projects') return mockProjects;
      if (action === 'get_project') return mockProjects[0];
      return {};
    });

    render(<ResearchWorkspace vaultPath="/test/vault" />);

    await waitFor(() => {
      expect(screen.getAllByText('Luhmann Note Method Validation').length).toBeGreaterThan(0);
    });

    const searchInput = screen.getByPlaceholderText('搜索研究项目…');
    fireEvent.change(searchInput, { target: { value: 'Caloric' } });

    const sidebar = document.querySelector('.research-projects-list');
    expect(sidebar).not.toHaveTextContent('Luhmann Note Method Validation');
    expect(sidebar).toHaveTextContent('Caloric Restriction Lifespan');
  });

  it('dispatches custom event to resume research in chat when button clicked', async () => {
    vi.mocked(researchLib.researchAction).mockImplementation(async (_vault, action) => {
      if (action === 'list_projects') return mockProjects;
      if (action === 'get_project') return mockProjects[0];
      return {};
    });

    const onOpenChat = vi.fn();
    const eventSpy = vi.fn();
    window.addEventListener('zettel:chat-send-prompt', eventSpy);

    render(<ResearchWorkspace vaultPath="/test/vault" onOpenChat={onOpenChat} />);

    await waitFor(() => {
      expect(screen.getByText('在对话中继续研究')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('在对话中继续研究'));

    expect(eventSpy).toHaveBeenCalled();
    expect(onOpenChat).toHaveBeenCalled();

    window.removeEventListener('zettel:chat-send-prompt', eventSpy);
  });

  it('exports research bundle and displays confirmation banner', async () => {
    vi.mocked(researchLib.researchAction).mockImplementation(async (_vault, action) => {
      if (action === 'list_projects') return mockProjects;
      if (action === 'get_project') return mockProjects[0];
      if (action === 'export_bundle_data') {
        return {
          path: '/test/vault/_research_exports/proj-1',
          changeset_ids: ['cs-1', 'cs-2', 'cs-3', 'cs-4'],
          exported_sources_count: 1,
        };
      }
      return {};
    });

    render(<ResearchWorkspace vaultPath="/test/vault" />);

    await waitFor(() => {
      expect(screen.getByText('导出归档')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('导出归档'));

    await waitFor(() => {
      expect(screen.getByText(/已成功生成研究数据包/)).toBeInTheDocument();
    });
  });
});
