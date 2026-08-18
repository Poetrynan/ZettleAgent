import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  getRerankConfig, setRerankConfig,
  RerankBackendUnavailable,
  DEFAULT_RERANK_CONFIG,
} from '../tauri';

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

describe('rerank config bindings', () => {
  beforeEach(() => invokeMock.mockReset());

  it('fills missing fields from the defaults (serde(default) on the Rust side)', async () => {
    // A stored value that predates a field: only `mode` and `topK` present.
    invokeMock.mockResolvedValueOnce({ mode: 'crossEncoder', topK: 40 });
    const cfg = await getRerankConfig();
    expect(cfg.mode).toBe('crossEncoder');
    expect(cfg.topK).toBe(40);
    // The rest come from the shared defaults, not `undefined`.
    expect(cfg.llmMaxCandidates).toBe(DEFAULT_RERANK_CONFIG.llmMaxCandidates);
    expect(cfg.llmMaxSnippetChars).toBe(DEFAULT_RERANK_CONFIG.llmMaxSnippetChars);
    expect(cfg.llmTimeoutMs).toBe(DEFAULT_RERANK_CONFIG.llmTimeoutMs);
  });

  it('maps an unregistered command to RerankBackendUnavailable, not a raw error', async () => {
    // The shape Tauri returns when a command is not in the allow-list yet.
    invokeMock.mockRejectedValueOnce('command set_rerank_config not allowed');
    await expect(getRerankConfig()).rejects.toBeInstanceOf(RerankBackendUnavailable);

    invokeMock.mockRejectedValueOnce('command set_rerank_config not allowed');
    await expect(setRerankConfig(DEFAULT_RERANK_CONFIG)).rejects.toBeInstanceOf(RerankBackendUnavailable);
  });

  it('rethrows a genuine backend error verbatim rather than masking it', async () => {
    invokeMock.mockRejectedValueOnce(new Error('db lock poisoned'));
    // A real failure must NOT be swallowed as "unavailable" — the user needs to
    // see it.
    await expect(getRerankConfig()).rejects.not.toBeInstanceOf(RerankBackendUnavailable);
  });

  it('spreads the knobs as individual args, matching the PATCH-shaped command', async () => {
    // `set_rerank_config` takes five independent `Option<_>` params, not a
    // `config` struct — a nested object would arrive as five `None`s and
    // silently save nothing.
    invokeMock.mockResolvedValueOnce(DEFAULT_RERANK_CONFIG);
    await setRerankConfig(DEFAULT_RERANK_CONFIG);
    expect(invokeMock).toHaveBeenCalledWith('set_rerank_config', {
      mode: DEFAULT_RERANK_CONFIG.mode,
      topK: DEFAULT_RERANK_CONFIG.topK,
      llmMaxCandidates: DEFAULT_RERANK_CONFIG.llmMaxCandidates,
      llmMaxSnippetChars: DEFAULT_RERANK_CONFIG.llmMaxSnippetChars,
      llmTimeoutMs: DEFAULT_RERANK_CONFIG.llmTimeoutMs,
    });
  });

  it('accepts a partial patch and leaves the other knobs unsent', async () => {
    invokeMock.mockResolvedValueOnce({ ...DEFAULT_RERANK_CONFIG, mode: 'off' });
    await setRerankConfig({ mode: 'off' });
    expect(invokeMock).toHaveBeenCalledWith('set_rerank_config', {
      mode: 'off',
      topK: undefined,
      llmMaxCandidates: undefined,
      llmMaxSnippetChars: undefined,
      llmTimeoutMs: undefined,
    });
  });

  it('returns the config the backend stored, since it clamps rather than only rejecting', async () => {
    // Sent topK 999; the backend clamped it on the restore path.
    invokeMock.mockResolvedValueOnce({ topK: 200 });
    const cfg = await setRerankConfig({ topK: 999 });
    expect(cfg.topK).toBe(200);
    expect(cfg.mode).toBe(DEFAULT_RERANK_CONFIG.mode);
  });
});
