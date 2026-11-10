import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WorkflowDashboard } from '../WorkflowDashboard';
import * as tauri from '../../../../lib/tauri';

vi.mock('../../../../lib/tauri', async () => {
  const actual = await vi.importActual('../../../../lib/tauri');
  return {
    ...actual,
    getWorkflowConfigs: vi.fn(),
    getWorkflowHistory: vi.fn(),
    runWorkflowNow: vi.fn(),
    updateWorkflowConfig: vi.fn(),
  };
});

describe('WorkflowDashboard', () => {
  const mockConfigs: tauri.WorkflowConfig[] = [
    {
      id: 'wf_source_ingestion',
      kind: 'source_ingestion',
      name: '新资料入库整理',
      description: '监控 _sources 目录导入，自动抽取元数据与核心主张。',
      enabled: true,
      trigger: { type: 'file_event', path_pattern: '_sources/**', debounce_ms: 2000 },
      scope: { path_patterns: ['_sources/**'], tag_filters: [], ignore_patterns: [] },
      budget: { max_api_calls: 15, max_tokens: 25000, timeout_secs: 120 },
      approval_mode: 'review_required',
      created_at: '2026-11-10T00:00:00Z',
      updated_at: '2026-11-10T00:00:00Z',
    },
    {
      id: 'wf_fact_impact_sentinel',
      kind: 'fact_impact_sentinel',
      name: '事实修改联动审查',
      description: '主张或事实笔记修改后，反向追踪下游依赖笔记。',
      enabled: true,
      trigger: { type: 'manual' },
      scope: { path_patterns: ['**/*.md'], tag_filters: ['claim'], ignore_patterns: [] },
      budget: { max_api_calls: 10, max_tokens: 20000, timeout_secs: 90 },
      approval_mode: 'review_required',
      created_at: '2026-11-10T00:00:00Z',
      updated_at: '2026-11-10T00:00:00Z',
    },
    {
      id: 'wf_weekly_review',
      kind: 'weekly_review',
      name: '每周知识回顾',
      description: '定期盘点本周笔记增量、活跃研究项目与 FSRS 到期卡片。',
      enabled: false,
      trigger: { type: 'scheduled', interval_secs: 604800 },
      scope: { path_patterns: ['**/*.md'], tag_filters: [], ignore_patterns: [] },
      budget: { max_api_calls: 20, max_tokens: 35000, timeout_secs: 240 },
      approval_mode: 'review_required',
      created_at: '2026-11-10T00:00:00Z',
      updated_at: '2026-11-10T00:00:00Z',
    },
  ];

  const mockHistory: tauri.WorkflowRunRecord[] = [
    {
      id: 'run_sample_1',
      workflow_id: 'wf_source_ingestion',
      kind: 'source_ingestion',
      status: 'completed',
      is_dry_run: true,
      started_at: '2026-11-10T12:00:00Z',
      completed_at: '2026-11-10T12:00:02Z',
      duration_ms: 2100,
      api_calls_used: 2,
      tokens_used: 1200,
      items_processed: 1,
      changeset_id: 'cs_sample_1',
      summary_json: '[]',
      error_message: undefined,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tauri.getWorkflowConfigs).mockResolvedValue(mockConfigs);
    vi.mocked(tauri.getWorkflowHistory).mockResolvedValue(mockHistory);
  });

  it('renders all three workflow cards with correct status and triggers', async () => {
    render(<WorkflowDashboard vaultPath="/test/vault" onOpenChangeReview={vi.fn()} />);

    expect(await screen.findByText('新资料入库整理')).toBeInTheDocument();
    expect(screen.getByText('事实修改联动审查')).toBeInTheDocument();
    expect(screen.getByText('每周知识回顾')).toBeInTheDocument();

    // Check status badges
    const activeBadges = screen.getAllByText('已启用');
    expect(activeBadges.length).toBe(2);
    expect(screen.getByText('已暂停')).toBeInTheDocument();

    // Check history table
    expect(screen.getByText('试运行 (Dry)')).toBeInTheDocument();
    expect(screen.getByText('待审提案')).toBeInTheDocument();
  });

  it('triggers dry run simulation and opens dry run preview modal', async () => {
    const dryRunResult: tauri.WorkflowRunResult = {
      run_id: 'dry_run_123',
      workflow_id: 'wf_source_ingestion',
      kind: 'source_ingestion',
      status: 'completed',
      is_dry_run: true,
      items_processed: 1,
      api_calls_used: 1,
      tokens_used: 450,
      changeset_id: undefined,
      summary_markdown: 'Dry run completed',
      actions: [
        {
          action_type: 'create_literature_note',
          target: 'literature/paper.md',
          description: '从新资料 paper.md 提炼文献笔记',
          diff_preview: '+ # Quantum Computing',
        },
      ],
    };
    vi.mocked(tauri.runWorkflowNow).mockResolvedValue(dryRunResult);

    render(<WorkflowDashboard vaultPath="/test/vault" onOpenChangeReview={vi.fn()} />);
    await screen.findByText('新资料入库整理');

    const dryRunButtons = screen.getAllByText('试运行预览');
    fireEvent.click(dryRunButtons[0]);

    await waitFor(() => {
      expect(tauri.runWorkflowNow).toHaveBeenCalledWith('wf_source_ingestion', true, '/test/vault');
      expect(screen.getByText('工作流试运行预览 (Dry-Run)')).toBeInTheDocument();
      expect(screen.getByText('从新资料 paper.md 提炼文献笔记')).toBeInTheDocument();
      expect(screen.getByText('+ # Quantum Computing')).toBeInTheDocument();
    });
  });

  it('navigates to changeset review when clicking pending proposal link', async () => {
    const onOpenChangeReview = vi.fn();
    render(<WorkflowDashboard vaultPath="/test/vault" onOpenChangeReview={onOpenChangeReview} />);

    const linkBtn = await screen.findByText('待审提案');
    fireEvent.click(linkBtn);

    expect(onOpenChangeReview).toHaveBeenCalledWith('cs_sample_1');
  });
});
