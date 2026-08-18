/**
 * Cross-encoder rerank worker. Deliberately a near-copy of
 * `embeddings.worker.ts`: same transformers.js/ONNX plumbing, same WASM-first
 * with WebGPU retry, same "one lazy singleton pipeline" shape. Two models, one
 * pattern to maintain.
 *
 * Runs off the UI thread because a cross-encoder is a full forward pass *per
 * candidate* — 32 passes on the main thread would visibly freeze the editor,
 * unlike the single pass an embedding needs.
 */
import { pipeline, env } from '@huggingface/transformers';

// Reranking is strictly opt-in, so unlike the bundled embedding model this one is
// allowed to be fetched on demand — but only when the user asked for it.
env.allowLocalModels = true;
env.allowRemoteModels = true;

let rankerPromise: Promise<any> | null = null;
let rankerFailed = false;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function progressCallback(data: any) {
  if (data.status === 'progress' || data.status === 'download') {
    self.postMessage({
      type: 'progress',
      payload: {
        file: data.file || data.name || 'reranker',
        progress: data.progress ?? 0,
        loaded: data.loaded ?? 0,
        total: data.total ?? 0,
      },
    });
  }
}

/**
 * Lazily build the sequence-classification pipeline. A cross-encoder is a
 * text-classification head over the (query, passage) pair, which is why this is
 * `text-classification` and not `feature-extraction`.
 */
async function getRanker(model: string) {
  if (rankerFailed) {
    rankerPromise = null;
    rankerFailed = false;
  }
  if (!rankerPromise) {
    rankerPromise = withTimeout(
      pipeline('text-classification', model, {
        device: 'wasm',
        // q8: ~4x smaller than fp32 with negligible ranking-quality loss. Ranking
        // only needs the *relative* order of scores, which is far more robust to
        // quantization noise than absolute regression targets.
        dtype: 'q8',
        progress_callback: progressCallback,
      }),
      300000,
      'reranker WASM model loading',
    ).catch((err) => {
      console.warn('WASM reranker failed, trying WebGPU:', err);
      return withTimeout(
        pipeline('text-classification', model, {
          device: 'webgpu',
          dtype: 'q8',
          progress_callback: progressCallback,
        }),
        300000,
        'reranker WebGPU model loading',
      );
    }).catch((err) => {
      console.error('All reranker backends failed:', err);
      rankerFailed = true;
      throw err;
    });
  }
  return rankerPromise;
}

/**
 * Score every pair. `text_pair` is the cross-encoder input convention: the model
 * attends over query and passage jointly, which is exactly what makes it more
 * accurate than the bi-encoder used for recall — and also why it cannot be
 * precomputed and must run at query time on a small candidate window.
 */
async function scorePairs(model: string, query: string, pairs: string[]): Promise<number[]> {
  const ranker = await getRanker(model);
  const out = await ranker(
    pairs.map(() => query),
    { text_pair: pairs, topk: 1 },
  );
  const rows = Array.isArray(out) ? out : [out];
  return rows.map((r: any) => {
    const first = Array.isArray(r) ? r[0] : r;
    // bge-reranker emits a single logit; `score` is the value we rank on. Absolute
    // magnitude is meaningless, ordering is not.
    return typeof first?.score === 'number' ? first.score : 0;
  });
}

self.onmessage = async (e: MessageEvent) => {
  const { type, payload } = e.data ?? {};

  if (type === 'score') {
    const { id, query, pairs, model } = payload;
    try {
      const scores = await scorePairs(model, query, pairs);
      self.postMessage({ type: 'scores-ok', payload: { id, scores } });
    } catch (err: any) {
      // Reported as an error message, not a throw: the main thread turns this
      // into `null` and Rust silently uses the lexical tier.
      self.postMessage({ type: 'error', payload: { id, error: err?.message || String(err) } });
    }
  }
};
