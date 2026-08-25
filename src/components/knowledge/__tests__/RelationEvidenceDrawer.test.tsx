import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom';

/**
 * 关系抽屉的验收线 / the one thing this drawer must never blur.
 *
 * 「我自己连的」和「Agent 提议、我批准了的」是两种完全不同的信任级别。如果抽屉把它们
 * 显示成一样，用户就没法判断这条边该不该复查——这正是这组用例盯的地方。
 */

vi.mock('../../../lib/tauri', () => ({
  knowledgeGraphRelationEvidence: vi.fn(),
  knowledgeGraphDecideRelation: vi.fn().mockResolvedValue('confirmed'),
}));

import { RelationEvidenceDrawer } from '../RelationEvidenceDrawer';
import {
  knowledgeGraphDecideRelation,
  knowledgeGraphRelationEvidence,
  type RelationDetail,
  type RelationEvidenceView,
} from '../../../lib/tauri';
import { setLang } from '../../../lib/i18n';

beforeEach(() => {
  vi.clearAllMocks();
  setLang('en');
});

function detail(over: Partial<RelationDetail> = {}): RelationDetail {
  return {
    sourcePath: 'D:\\vault\\notes\\Alpha.md',
    targetPath: 'D:\\vault\\notes\\Bravo.md',
    relationType: 'supports',
    confidence: 0.73,
    reason: 'Alpha restates the claim Bravo makes.',
    origin: 'user_link',
    confirmed: true,
    changesetId: null,
    createdAt: '2026-01-01 00:00:00',
    decision: null,
    ...over,
  };
}

function view(over: Partial<RelationEvidenceView> = {}): RelationEvidenceView {
  return {
    detail: detail(),
    semanticSimilarity: 0.81,
    evidence: [
      { path: 'D:\\vault\\notes\\Alpha.md', chunkId: 3, excerpt: 'the claim itself', kind: 'chunk_text' },
    ],
    semantics: 'The source note supports the claim the target note makes.',
    ...over,
  };
}

function open(v: RelationEvidenceView) {
  vi.mocked(knowledgeGraphRelationEvidence).mockResolvedValue(v);
  // 路径用表达式传，不用 JSX 字面量：JSX 属性里的反斜杠不会转义。
  return render(
    <RelationEvidenceDrawer
      sourcePath={'D:\\vault\\notes\\Alpha.md'}
      targetPath={'D:\\vault\\notes\\Bravo.md'}
      relationType="supports"
      onClose={() => {}}
    />,
  );
}

describe('RelationEvidenceDrawer', () => {
  it('distinguishes an Agent-proposed edge from one the user authored', async () => {
    open(view({ detail: detail({ origin: 'agent_proposed', confirmed: false }) }));

    await waitFor(() =>
      expect(
        screen.getByText('The Agent proposed it and you approved it'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText('You created it')).toBeNull();
    // 未确认必须自己说出来，不能靠用户去猜。
    expect(screen.getByText('You have not confirmed this relation')).toBeInTheDocument();
    // 原始 origin 串不许进主文案。
    expect(screen.queryByText('agent_proposed')).toBeNull();
  });

  it('says the edge is the user own work when origin is user_link', async () => {
    open(view());

    await waitFor(() => expect(screen.getByText('You created it')).toBeInTheDocument());
    expect(screen.getByText('You have confirmed this relation')).toBeInTheDocument();
    expect(screen.queryByText('The Agent proposed it and you approved it')).toBeNull();
  });

  it('explains the semantics and shows both confidence and similarity', async () => {
    open(view());

    await waitFor(() =>
      expect(
        screen.getByText('The source note supports the claim the target note makes.'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText('0.73')).toBeInTheDocument();
    expect(screen.getByText('0.81')).toBeInTheDocument();
    expect(screen.getByText('the claim itself')).toBeInTheDocument();
    // 方向用文件名表示，绝对路径留在技术详情里。
    expect(screen.getByText('Alpha.md → Bravo.md')).toBeInTheDocument();
  });

  it('records the decision through the backend rather than just closing', async () => {
    open(view({ detail: detail({ origin: 'agent_proposed', confirmed: false }) }));

    fireEvent.click(await screen.findByRole('button', { name: 'Reject relation' }));

    await waitFor(() =>
      expect(knowledgeGraphDecideRelation).toHaveBeenCalledWith(
        'D:\\vault\\notes\\Alpha.md',
        'D:\\vault\\notes\\Bravo.md',
        'supports',
        false,
      ),
    );
  });

  it('says the relation is not in the graph instead of drawing an empty shell', async () => {
    open(view({ detail: null, semanticSimilarity: null }));

    await waitFor(() =>
      expect(
        screen.getByText('This relation is not in the graph, so there is no origin to show.'),
      ).toBeInTheDocument(),
    );
    // 没有这条边就没有可判断的东西，接受/拒绝按钮不该出现。
    expect(screen.queryByRole('button', { name: 'Accept relation' })).toBeNull();
    expect(
      screen.getByText('No semantic similarity is recorded between these two notes.'),
    ).toBeInTheDocument();
  });

  it('resolves its strings in Chinese too', async () => {
    setLang('zh');
    open(view({ detail: detail({ origin: 'agent_proposed', confirmed: false }) }));

    await waitFor(() =>
      expect(screen.getByText('Agent 提议，经你批准后写入')).toBeInTheDocument(),
    );
    expect(screen.getByText('你还没确认过这条关系')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '拒绝关系' })).toBeInTheDocument();
  });
});
