import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom';

import { ContextInspector } from '../ContextInspector';
import {
  ContextInspectorItem,
  ContextPackageSummary,
  EvidenceRecord,
  getEvidenceByIds,
} from '../../../lib/tauri';
import { setLang } from '../../../lib/i18n';
import { en } from '../../../lib/i18n/en';
import { zh } from '../../../lib/i18n/zh';

vi.mock('../../../lib/tauri', () => ({
  getEvidenceByIds: vi.fn(),
}));

// i18n 不 mock：这一层要验的就是"没有原始 code 漏到界面上"。
beforeEach(() => {
  vi.clearAllMocks();
  setLang('en');
});

function item(over: Partial<ContextInspectorItem> = {}): ContextInspectorItem {
  return {
    objectId: 'obj-1',
    kind: 'note',
    section: 'fact',
    title: 'Caching decision',
    locator: 'd:/vault/notes/caching.md#chunk:3',
    score: 0.82,
    why: ['lexical'],
    warnings: [],
    evidenceIds: [],
    ...over,
  };
}

function pkg(over: Partial<ContextPackageSummary> = {}): ContextPackageSummary {
  return {
    query: 'what did I decide about caching',
    intent: 'search',
    scope: [],
    counts: { facts: 1, memories: 0, openTasks: 0, related: 0, conflicts: 0 },
    items: [item()],
    knowledgeGaps: [],
    warnings: [],
    budget: { maxTokens: 4000, usedTokens: 1200, truncatedCandidates: 0 },
    ...over,
  };
}

function evidence(over: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: 'ev-1',
    source_type: 'note',
    source_id: 'obj-1',
    locator: 'd:/vault/notes/caching.md#chunk:3',
    excerpt: 'we settled on a write-through cache',
    checksum: 'abc123',
    captured_at_ms: 1_700_000_000_000,
    author: null,
    extraction_model: 'local-mini',
    pipeline_version: 'v2',
    ...over,
  };
}

describe('分组与来源', () => {
  /** 分组标题来自后端的 `section`，不是前端按 kind 猜的。 */
  it('groups items under the bucket the backend said recalled them', () => {
    render(
      <ContextInspector
        pkg={pkg({
          items: [
            item({ section: 'current', title: 'Open note', objectId: 'o1' }),
            item({ section: 'conflict', title: 'Contradicting note', objectId: 'o2' }),
          ],
        })}
      />,
    );

    expect(screen.getByText('The note you have open')).toBeInTheDocument();
    expect(screen.getByText('Contradicting each other')).toBeInTheDocument();
  });

  /** 升级前发出的那一轮事件没有 `section`，条目要落到"来自你的笔记"而不是消失。 */
  it('keeps items visible when an older event carried no section', () => {
    render(
      <ContextInspector
        pkg={pkg({ items: [{ ...item(), section: '' as unknown as string }] })}
      />,
    );

    expect(screen.getByText('From your notes')).toBeInTheDocument();
    expect(screen.getByText('Caching decision')).toBeInTheDocument();
  });

  it('passes the locator up when the user asks to open the source', () => {
    const onOpenSource = vi.fn();
    render(<ContextInspector pkg={pkg()} onOpenSource={onOpenSource} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open source' }));
    expect(onOpenSource).toHaveBeenCalledWith('d:/vault/notes/caching.md#chunk:3');
  });

  /** 宿主没给打开能力时不显示按钮，而不是给一个点了没反应的。 */
  it('hides the open button when the host cannot open notes', () => {
    render(<ContextInspector pkg={pkg()} />);
    expect(screen.queryByRole('button', { name: 'Open source' })).not.toBeInTheDocument();
  });

  /** 绝对路径不进主文案，只在"技术详情"折叠里出现。 */
  it('keeps the absolute path inside the technical details fold', () => {
    render(<ContextInspector pkg={pkg()} />);
    const shown = screen.getByText('d:/vault/notes/caching.md#chunk:3');
    expect(shown.closest('details')).not.toBeNull();
  });
});

describe('证据抽屉', () => {
  it('only offers evidence when the item actually has some', () => {
    render(<ContextInspector pkg={pkg()} />);
    expect(screen.queryByRole('button', { name: /Evidence/ })).not.toBeInTheDocument();
  });

  it('loads the evidence by id and shows the excerpt', async () => {
    vi.mocked(getEvidenceByIds).mockResolvedValue([evidence()]);
    render(<ContextInspector pkg={pkg({ items: [item({ evidenceIds: ['ev-1'] })] })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Evidence (1)' }));

    await waitFor(() =>
      expect(screen.getByText('we settled on a write-through cache')).toBeInTheDocument(),
    );
    expect(getEvidenceByIds).toHaveBeenCalledWith(['ev-1']);
    // 文件名做标题，完整路径留在技术详情里。
    expect(screen.getByText('caching.md')).toBeInTheDocument();
  });

  /**
   * id 还在、行没了：必须说出来。
   *
   * 后端对取不到的 id 不返回占位行，所以这里靠数量差发现缺口——沉默会让用户以为
   * 这条结论的证据比实际更充分。
   */
  it('says how many evidence records have gone missing', async () => {
    vi.mocked(getEvidenceByIds).mockResolvedValue([evidence()]);
    render(<ContextInspector pkg={pkg({ items: [item({ evidenceIds: ['ev-1', 'ev-gone'] })] })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Evidence (2)' }));

    await waitFor(() =>
      expect(screen.getByText('1 evidence record(s) are no longer in the database.')).toBeInTheDocument(),
    );
  });

  it('reports a failed evidence read instead of rendering an empty drawer', async () => {
    vi.mocked(getEvidenceByIds).mockRejectedValue(new Error('db locked'));
    render(<ContextInspector pkg={pkg({ items: [item({ evidenceIds: ['ev-1'] })] })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Evidence (1)' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText('Could not load this. Nothing was changed.')).toBeInTheDocument();
  });

  /** 没存摘录的证据不能显示成一片空白。 */
  it('states when no excerpt was stored', async () => {
    vi.mocked(getEvidenceByIds).mockResolvedValue([evidence({ excerpt: null })]);
    render(<ContextInspector pkg={pkg({ items: [item({ evidenceIds: ['ev-1'] })] })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Evidence (1)' }));
    await waitFor(() => expect(screen.getByText('No excerpt was stored.')).toBeInTheDocument());
  });
});

/**
 * 每个 code 都必须两种语言都有文案。
 *
 * 这些 code 由后端产生，界面上不能出现裸 code——这个 `it.each` 是那条规则的守门人。
 */
describe('code 覆盖', () => {
  const codes = [
    'knowledge.why.lexical', 'knowledge.why.vector', 'knowledge.why.current_file',
    'knowledge.why.memory_recall', 'knowledge.why.attached', 'knowledge.why.core_memory',
    'knowledge.why.commitment', 'knowledge.why.conflict', 'knowledge.why.related_object',
    'knowledge.why.recent',
    'knowledge.warning.stale', 'knowledge.warning.conflicting',
    'knowledge.warning.no_stable_identity', 'knowledge.warning.unconfirmed',
    'knowledge.warning.low_confidence', 'knowledge.warning.out_of_scope',
    'knowledge.warning.expanded', 'knowledge.warning.overdue',
    'knowledge.warning.fts_only_no_query_embedding',
    'knowledge.context.section.current', 'knowledge.context.section.fact',
    'knowledge.context.section.memory', 'knowledge.context.section.task',
    'knowledge.context.section.related', 'knowledge.context.section.conflict',
  ] as const;

  it.each(codes)('%s has both en and zh copy', key => {
    expect(en[key]).toBeTruthy();
    expect(zh[key]).toBeTruthy();
  });
});
