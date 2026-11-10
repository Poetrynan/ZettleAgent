import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom';

import { ClaimsWorkspace } from '../ClaimsWorkspace';
import * as researchLib from '../../../lib/research';

vi.mock('../../../lib/research', () => ({
  researchAction: vi.fn(),
  researchReadSource: vi.fn(),
  researchVerifyQuote: vi.fn(),
  researchCaptureSource: vi.fn(),
}));

const mockClaims: researchLib.Claim[] = [
  {
    id: 'claim-1',
    title: 'Caloric Restriction Extends Primate Healthspan',
    content: 'Caloric restriction delays age-associated disease onset in rhesus monkeys.',
    conditions: 'Only with nutritionally complete diet without malnutrition',
    status: 'confirmed',
    version: 1,
    project_id: 'proj-1',
    evidence: [
      {
        id: 'ev-1',
        role: 'supports',
        confidence: 1.0,
        source_type: 'file',
        source_id: 'sources/colman2009.pdf',
        locator: '#page=3',
        excerpt: 'Caloric restriction delays disease onset and mortality in rhesus monkeys.',
        checksum: 'abc1',
        captured_at_ms: 1000,
      },
      {
        id: 'ev-2',
        role: 'contradicts',
        confidence: 1.0,
        source_type: 'file',
        source_id: 'sources/mattison2012.pdf',
        locator: '#page=5',
        excerpt: 'Caloric restriction does not improve survival in NIA study.',
        checksum: 'abc2',
        captured_at_ms: 2000,
      },
    ],
    created_at_ms: 1000,
    updated_at_ms: 2000,
  },
  {
    id: 'claim-2',
    title: 'Secondary Claim on Insulin Sensitivity',
    content: 'Insulin sensitivity is improved across both primate cohorts.',
    conditions: '',
    status: 'proposed',
    version: 1,
    project_id: 'proj-1',
    evidence: [],
    created_at_ms: 1000,
    updated_at_ms: 1500,
  },
];

const mockProjects: researchLib.ResearchProject[] = [
  {
    id: 'proj-1',
    title: 'Caloric Restriction Lifespan',
    question: 'Does CR work in primates?',
    scope: 'vault-1',
    status: 'active',
    version: 1,
    source_paths: [],
    claim_ids: ['claim-1'],
    unresolved_questions: [],
    next_steps: [],
    artifact_paths: [],
    created_at_ms: 1000,
    updated_at_ms: 1000,
  },
];

describe('ClaimsWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders claims list and displays supporting and contradicting evidence columns', async () => {
    vi.mocked(researchLib.researchAction).mockImplementation(async (_vault, action) => {
      if (action === 'list_claims') return mockClaims;
      if (action === 'list_projects') return mockProjects;
      return {};
    });

    render(<ClaimsWorkspace vaultPath="/test-vault" />);

    await waitFor(() => {
      expect(
        screen.getAllByText('Caloric Restriction Extends Primate Healthspan').length
      ).toBeGreaterThan(0);
      expect(screen.getByText('Secondary Claim on Insulin Sensitivity')).toBeInTheDocument();
    });

    // Content and conditions
    expect(
      screen.getAllByText('Caloric restriction delays age-associated disease onset in rhesus monkeys.').length
    ).toBeGreaterThan(0);
    expect(
      screen.getByText('Only with nutritionally complete diet without malnutrition')
    ).toBeInTheDocument();

    // Evidence columns
    expect(screen.getByText(/支持证据/)).toBeInTheDocument();
    expect(screen.getByText(/反驳 \/ 限制证据/)).toBeInTheDocument();

    // Evidence excerpts
    expect(
      screen.getByText(/Caloric restriction delays disease onset and mortality in rhesus monkeys./)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Caloric restriction does not improve survival in NIA study./)
    ).toBeInTheDocument();
  });

  it('filters claims by search query', async () => {
    vi.mocked(researchLib.researchAction).mockImplementation(async (_vault, action) => {
      if (action === 'list_claims') return mockClaims;
      if (action === 'list_projects') return mockProjects;
      return {};
    });

    render(<ClaimsWorkspace vaultPath="/test-vault" />);

    await waitFor(() => {
      expect(
        screen.getAllByText('Caloric Restriction Extends Primate Healthspan').length
      ).toBeGreaterThan(0);
    });

    const searchInput = screen.getByPlaceholderText('搜索主张与适用条件…');
    fireEvent.change(searchInput, { target: { value: 'Insulin' } });

    const sidebar = document.querySelector('.claims-list');
    expect(sidebar).not.toHaveTextContent('Caloric Restriction Extends Primate Healthspan');
    expect(sidebar).toHaveTextContent('Secondary Claim on Insulin Sensitivity');
  });

  it('invokes and renders trace dependency modal', async () => {
    const mockTrace: researchLib.ClaimTraceResult = {
      claim: mockClaims[0],
      supporting_evidence: [mockClaims[0].evidence[0]],
      opposing_evidence: [mockClaims[0].evidence[1]],
      source_evidence: [],
      dependencies: [
        {
          relation_type: 'supports',
          source: 'sources/colman2009.pdf',
          target: 'claim-1',
          confidence: 0.95,
        },
      ],
      has_explicit_evidence: true,
    };

    vi.mocked(researchLib.researchAction).mockImplementation(async (_vault, action) => {
      if (action === 'list_claims') return mockClaims;
      if (action === 'list_projects') return mockProjects;
      if (action === 'trace_claim') return mockTrace;
      return {};
    });

    render(<ClaimsWorkspace vaultPath="/test-vault" />);

    await waitFor(() => {
      expect(screen.getByText('追踪依赖')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('追踪依赖'));

    await waitFor(() => {
      expect(screen.getByText(/主张依赖网络与来源追踪/)).toBeInTheDocument();
      expect(screen.getByText(/置信度 0.95/)).toBeInTheDocument();
    });
  });

  it('invokes and renders preview change impact modal', async () => {
    const mockImpact: researchLib.ImpactPreviewResult = {
      target: 'claim-1',
      total_impacted: 2,
      affected_claims: [{ id: 'claim-2', title: 'Secondary Claim on Insulin Sensitivity' }],
      affected_projects: [{ id: 'proj-1', title: 'Caloric Restriction Lifespan' }],
      affected_notes: [],
      requires_review: true,
    };

    vi.mocked(researchLib.researchAction).mockImplementation(async (_vault, action) => {
      if (action === 'list_claims') return mockClaims;
      if (action === 'list_projects') return mockProjects;
      if (action === 'preview_change_impact') return mockImpact;
      return {};
    });

    render(<ClaimsWorkspace vaultPath="/test-vault" />);

    await waitFor(() => {
      expect(screen.getByText('影响预览')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('影响预览'));

    await waitFor(() => {
      expect(screen.getByText(/修改影响预估/)).toBeInTheDocument();
      expect(screen.getByText(/若修改或撤回此事实，将影响/)).toBeInTheDocument();
      expect(screen.getByText(/研究项目: Caloric Restriction Lifespan/)).toBeInTheDocument();
    });
  });

  it('invokes and renders FSRS review items draft generation', async () => {
    const mockReviews: { count: number; items: researchLib.ReviewDraftItem[] } = {
      count: 1,
      items: [
        {
          card_id: 'card-1',
          question: 'What did the Colman 2009 study show regarding caloric restriction in primates?',
          answer: 'It demonstrated delayed disease onset and reduced mortality.',
          claim_id: 'claim-1',
          status: 'draft',
        },
      ],
    };

    vi.mocked(researchLib.researchAction).mockImplementation(async (_vault, action) => {
      if (action === 'list_claims') return mockClaims;
      if (action === 'list_projects') return mockProjects;
      if (action === 'generate_review_items') return mockReviews;
      return {};
    });

    render(<ClaimsWorkspace vaultPath="/test-vault" />);

    await waitFor(() => {
      expect(screen.getByText('生成复习题')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('生成复习题'));

    await waitFor(() => {
      expect(screen.getByText(/自动生成的 FSRS 间隔复习题草稿/)).toBeInTheDocument();
      expect(
        screen.getByText(/What did the Colman 2009 study show regarding caloric restriction in primates?/)
      ).toBeInTheDocument();
    });
  });
});
