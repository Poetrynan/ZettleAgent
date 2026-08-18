/**
 * Tier 2 of the retrieval rerank chain: an optional local cross-encoder.
 *
 * Rust (`src-tauri/src/db/search/rerank.rs`) owns Tiers 1 and 3 and always has a
 * zero-dependency lexical reranker to fall back on. This module's only job is:
 * hand it a better order when — and only when — a cross-encoder model is
 * actually present on this machine.
 *
 * Everything here therefore returns `null` rather than throwing. A missing model,
 * a cold start that takes too long, an unsupported backend: all of them mean
 * "Rust, use Tier 1", never "search failed". Reranking is a quality nicety;
 * retrieval is the feature.
 *
 * Model plumbing mirrors `embeddings.ts` exactly (lazy Web Worker +
 * transformers.js ONNX, WASM first with a WebGPU retry) so there is one pattern
 * to understand for both models rather than two.
 */

/** One candidate as produced by `rerank::build_candidates` on the Rust side. */
export interface RerankCandidate {
  /** Position in the candidate window. This — not chunkId — is the identity used
   *  to express the new order, because the regex branch of `search_notes` emits
   *  chunkId 0 for every row. */
  index: number;
  chunkId: number;
  filePath: string;
  heading: string;
  snippet: string;
}

export interface RerankOptions {
  /** Give up and let Rust use Tier 1 after this long. A rerank that takes longer
   *  than the search it is improving is a regression, not a feature. */
  timeoutMs?: number;
  /** Chars of snippet actually fed to the model. The recommended rerankers use a
   *  512-token window; ~1000 chars is past that for both English and Chinese, so
   *  anything more is paid for and then discarded by the tokenizer. */
  maxSnippetChars?: number;
}

export const DEFAULT_RERANK_TIMEOUT_MS = 6000;
export const DEFAULT_MAX_SNIPPET_CHARS = 1000;

/**
 * Recommended model: `Xenova/bge-reranker-base` (ONNX export of
 * `BAAI/bge-reranker-base`).
 *
 * Why this one:
 * - **Chinese is first-class.** XLM-RoBERTa-base backbone with the 250k-token
 *   multilingual vocabulary, and BAAI trained it on Chinese *and* English ranking
 *   data. English-only rerankers (ms-marco-MiniLM et al.) are ~23 MB and very
 *   tempting, but this project's primary users write Chinese notes, so they are
 *   deliberately NOT offered.
 * - **Permissive licence.** MIT, unlike `jina-reranker-v2-base-multilingual`
 *   (CC-BY-NC), which an open-source app cannot ship as a default.
 * - **Cheapest multilingual option.** `bge-reranker-v2-m3` is stronger but ~2x the
 *   parameters; at 568M it is not a reasonable download for a note-taking app.
 *
 * Download cost, measured from the repo (not estimated):
 * - `model_quantized.onnx` (q8/int8) — 266 MB
 * - `tokenizer.json` + `sentencepiece.bpe.model` — 22 MB
 * - **≈ 288 MB total**, vs 1.04 GB for fp32 and 531 MB for fp16.
 *
 * Quantization choice: **q8**. Note that `model_q4.onnx` in this repo is *826 MB*
 * — larger than q8 — because only the matmuls are 4-bit while the 250k × 768
 * embedding table stays fp32, and that table is most of the model. q8 quantizes
 * the embeddings too, which is where the win is. Ranking also tolerates
 * quantization unusually well: only the *relative* order of scores matters, not
 * the absolute logits.
 *
 * ~288 MB is precisely why Tier 1 is the default and this tier is opt-in.
 */
export const CROSS_ENCODER_MODEL = 'Xenova/bge-reranker-base';


// ── Pure helpers (unit-tested; no model, no worker) ─────────────────────────

/**
 * Truncate by code point, never by UTF-16 code unit.
 * `s.slice(0, n)` can cut a surrogate pair in half and produce a lone surrogate,
 * which then round-trips through IPC as U+FFFD. `Array.from` iterates code points.
 */
export function truncateChars(s: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  const chars = Array.from(s);
  return chars.length <= maxChars ? s : chars.slice(0, maxChars).join('');
}

/**
 * Stable descending argsort: candidate indices ordered best score first, ties
 * keeping their original (fused) relative order.
 *
 * Stability matters — it is what makes "the model had no opinion" degrade into a
 * no-op instead of an arbitrary shuffle.
 */
export function orderFromScores(scores: number[]): number[] {
  return scores
    .map((score, index) => ({ score, index }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .map((e) => e.index);
}

/**
 * Apply an index order to a list, mirroring `rerank::apply_index_order` in Rust:
 * out-of-range and duplicate indices are dropped, and anything the order omitted
 * is appended in its original relative position. The result is always a
 * permutation of the input — a sloppy order can reorder, never lose.
 */
export function applyIndexOrder<T>(items: T[], order: number[]): T[] {
  const taken = new Array<boolean>(items.length).fill(false);
  const out: T[] = [];
  for (const i of order) {
    if (Number.isInteger(i) && i >= 0 && i < items.length && !taken[i]) {
      taken[i] = true;
      out.push(items[i]);
    }
  }
  for (let i = 0; i < items.length; i++) {
    if (!taken[i]) out.push(items[i]);
  }
  return out;
}

/**
 * Build the (query, passage) text pairs a cross-encoder scores. Heading is
 * prepended because it is the author's own topic label and the single cheapest
 * piece of context the model can get.
 */
export function buildPairTexts(
  candidates: RerankCandidate[],
  maxSnippetChars = DEFAULT_MAX_SNIPPET_CHARS,
): string[] {
  return candidates.map((c) => {
    const head = c.heading ? `${truncateChars(c.heading, 120)}\n` : '';
    return `${head}${truncateChars(c.snippet, maxSnippetChars)}`;
  });
}

// ── Runtime: scoring via a lazy ONNX cross-encoder worker ────────────────────

/** Resolve with the promise's value, or reject once `ms` elapses. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// Lazy singleton worker, same lifecycle shape as embeddings.ts. Kept null until
// the user actually turns Tier 2 on, so a user who never enables it pays nothing.
let workerInstance: Worker | null = null;
let msgIdCounter = 0;
const pending = new Map<number, { resolve: (v: number[]) => void; reject: (e: Error) => void }>();

/** True only if a cross-encoder worker has been created. Lets callers cheaply
 *  decide whether Tier 2 is even a possibility before assembling candidates. */
export function isCrossEncoderLoaded(): boolean {
  return workerInstance !== null;
}

function getWorker(): Worker {
  if (!workerInstance) {
    workerInstance = new Worker(new URL('./reranker.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerInstance.onmessage = (e: MessageEvent) => {
      const { type, payload } = e.data ?? {};
      if (type === 'scores-ok') {
        const p = pending.get(payload.id);
        if (p) { p.resolve(payload.scores); pending.delete(payload.id); }
      } else if (type === 'error') {
        const p = pending.get(payload.id);
        if (p) { p.reject(new Error(payload.error || 'reranker worker error')); pending.delete(payload.id); }
      }
    };
  }
  return workerInstance;
}

/**
 * Score every (query, passage) pair with the cross-encoder. Rejects on any
 * failure so the public `rerank` wrapper can turn it into `null`.
 */
async function scorePairs(query: string, pairs: string[], timeoutMs: number): Promise<number[]> {
  const worker = getWorker();
  const id = ++msgIdCounter;
  return withTimeout(
    new Promise<number[]>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ type: 'score', payload: { id, query, pairs, model: CROSS_ENCODER_MODEL } });
    }),
    timeoutMs,
    'cross-encoder rerank',
  );
}

/**
 * Tier 2 entry point. Returns the reranked index order, or `null` to signal
 * "fall back to Tier 1" — which is the ONLY failure contract callers should rely
 * on. It never throws and never rejects: the whole point is that an optional
 * rerank can never break a search.
 *
 * The returned array is the candidates' `index` values in best-first order,
 * exactly the shape `rerank::apply_index_order` (and `applyIndexOrder` here)
 * consume.
 */
export async function rerank(
  query: string,
  candidates: RerankCandidate[],
  opts: RerankOptions = {},
): Promise<number[] | null> {
  // Nothing to reorder: let Rust keep the fused order.
  if (!query.trim() || candidates.length <= 1) return null;

  const timeoutMs = opts.timeoutMs ?? DEFAULT_RERANK_TIMEOUT_MS;
  const maxSnippetChars = opts.maxSnippetChars ?? DEFAULT_MAX_SNIPPET_CHARS;

  try {
    const pairs = buildPairTexts(candidates, maxSnippetChars);
    const scores = await scorePairs(query, pairs, timeoutMs);
    // A short or malformed score vector is not trustworthy — bail to Tier 1
    // rather than reorder on partial data.
    if (!Array.isArray(scores) || scores.length !== candidates.length) return null;
    const localOrder = orderFromScores(scores);
    // Map window positions back to the candidates' own `index` field.
    return localOrder.map((pos) => candidates[pos].index);
  } catch (err) {
    console.warn('[reranker] cross-encoder unavailable, falling back to lexical:', err);
    return null;
  }
}

