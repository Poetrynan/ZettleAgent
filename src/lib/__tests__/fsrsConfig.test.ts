import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  getFsrsConfig, setFsrsConfig, getReviewQueue, gradeCard,
  addCardsToReview, getReviewCard,
  DEFAULT_FSRS_CONFIG,
} from '../tauri';

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

describe('FSRS config bindings', () => {
  beforeEach(() => invokeMock.mockReset());

  it('fills missing fields from the defaults (serde(default) on the Rust side)', async () => {
    // A stored value written before a field existed.
    invokeMock.mockResolvedValueOnce({ desiredRetention: 0.85, newPerDay: 5 });
    const cfg = await getFsrsConfig();
    expect(cfg.desiredRetention).toBe(0.85);
    expect(cfg.newPerDay).toBe(5);
    expect(cfg.reviewsPerDay).toBe(DEFAULT_FSRS_CONFIG.reviewsPerDay);
    expect(cfg.learningSteps).toEqual(DEFAULT_FSRS_CONFIG.learningSteps);
    expect(cfg.enableFuzz).toBe(DEFAULT_FSRS_CONFIG.enableFuzz);
  });

  it('spreads the knobs as individual args, matching the PATCH-shaped command', async () => {
    // `set_fsrs_config` takes six independent `Option<_>` params, not a `config`
    // struct. Nesting them would make every param arrive as `None` and the
    // command would silently save nothing — the exact bug `set_rerank_config`
    // was fixed for.
    invokeMock.mockResolvedValueOnce(DEFAULT_FSRS_CONFIG);
    await setFsrsConfig(DEFAULT_FSRS_CONFIG);
    expect(invokeMock).toHaveBeenCalledWith('set_fsrs_config', {
      desiredRetention: DEFAULT_FSRS_CONFIG.desiredRetention,
      maximumIntervalDays: DEFAULT_FSRS_CONFIG.maximumIntervalDays,
      learningSteps: DEFAULT_FSRS_CONFIG.learningSteps,
      enableFuzz: DEFAULT_FSRS_CONFIG.enableFuzz,
      newPerDay: DEFAULT_FSRS_CONFIG.newPerDay,
      reviewsPerDay: DEFAULT_FSRS_CONFIG.reviewsPerDay,
    });
    // And nothing is nested: a `config` key here would be the bug.
    const [, args] = invokeMock.mock.calls[0];
    expect(args).not.toHaveProperty('config');
  });

  it('sends a partial patch with the untouched knobs left undefined', async () => {
    invokeMock.mockResolvedValueOnce({ ...DEFAULT_FSRS_CONFIG, newPerDay: 40 });
    await setFsrsConfig({ newPerDay: 40 });
    expect(invokeMock).toHaveBeenCalledWith('set_fsrs_config', {
      desiredRetention: undefined,
      maximumIntervalDays: undefined,
      learningSteps: undefined,
      enableFuzz: undefined,
      newPerDay: 40,
      reviewsPerDay: undefined,
    });
  });

  it('adopts the config the backend echoed back, not the value that was sent', async () => {
    // The setter rejects out-of-range values, but the restore path clamps, so
    // the echo is authoritative.
    invokeMock.mockResolvedValueOnce({ maximumIntervalDays: 36500 });
    const cfg = await setFsrsConfig({ maximumIntervalDays: 99999 });
    expect(cfg.maximumIntervalDays).toBe(36500);
    expect(cfg.desiredRetention).toBe(DEFAULT_FSRS_CONFIG.desiredRetention);
  });

  it('a false boolean survives the patch instead of being dropped', async () => {
    // Guards against an `if (patch.enableFuzz)` style regression: `false` is a
    // meaningful value here, not "unset".
    invokeMock.mockResolvedValueOnce({ ...DEFAULT_FSRS_CONFIG, enableFuzz: false });
    await setFsrsConfig({ enableFuzz: false });
    const [, args] = invokeMock.mock.calls[0];
    expect(args.enableFuzz).toBe(false);
  });
});

describe('review command bindings', () => {
  beforeEach(() => invokeMock.mockReset());

  it('passes camelCase arg names that Tauri maps onto the snake_case params', async () => {
    invokeMock.mockResolvedValue(null);

    await getReviewQueue(25);
    expect(invokeMock).toHaveBeenCalledWith('get_review_queue', { limit: 25 });

    await gradeCard('v/中文笔记.md', 3);
    expect(invokeMock).toHaveBeenCalledWith('grade_card', { filePath: 'v/中文笔记.md', grade: 3 });

    await addCardsToReview(['v/a.md', 'v/b.md']);
    expect(invokeMock).toHaveBeenCalledWith('add_cards_to_review', { filePaths: ['v/a.md', 'v/b.md'] });

    await getReviewCard('v/a.md');
    expect(invokeMock).toHaveBeenCalledWith('get_review_card', { filePath: 'v/a.md' });
  });

  it('omitting the limit lets the backend pick its own default', async () => {
    invokeMock.mockResolvedValue(null);
    await getReviewQueue();
    expect(invokeMock).toHaveBeenCalledWith('get_review_queue', { limit: undefined });
  });
});
