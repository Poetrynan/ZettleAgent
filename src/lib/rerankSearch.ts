/**
 * The Tier-2 bridge: the piece that makes choosing "CrossEncoder" in Settings
 * actually change the order of search results.
 *
 * ## Why this module exists at all
 *
 * `search_chunks` is a synchronous Rust command that holds the DB mutex, and the
 * cross-encoder is an ONNX model living in the webview. Rust cannot await the
 * webview mid-query without deadlocking, which is why every in-Rust call site
 * passes `external: None` and degrades to Tier 1. The escape hatch is
 * `rerank_search_window`: Rust hands out the recall window *and* the candidate
 * snippets in one call, and the webview — which owns the model — finishes the job.
 *
 * ## Who owns the final ordering: this module
 *
 * The window comes back with the rows already in it, so shipping the model's
 * index order back to Rust to be applied would cost a second round trip and buy
 * nothing. Worse, it would need Rust to park the window between the two calls —
 * a keyed cache, an eviction policy, and a fresh race as soon as the user types
 * again. Applying `applyIndexOrder` here (the exact mirror of Rust's
 * `apply_index_order`) is one function call over data already in hand, and it
 * puts the cancellation check in the same place as the state update, which is the
 * only place it can be correct.
 *
 * ## Degrade silently in behaviour, visibly in the UI
 *
 * Every return carries the `tier` that *actually* ran, never the tier that was
 * configured. Reporting `crossEncoder` while Tier 1 quietly did the work is the
 * exact bug this module exists to fix; reproducing it one level up would be
 * worse, not better.
 */
import {
  searchChunks,
  rerankSearchWindow,
  getRerankConfig,
  RerankBackendUnavailable,
  type RerankMode,
  type SearchQuery,
  type SearchResult,
} from './tauri';
import {
  rerank as crossEncoderRerank,
  applyIndexOrder,
  DEFAULT_RERANK_TIMEOUT_MS,
  DEFAULT_MAX_SNIPPET_CHARS,
} from './reranker';

// ── "Is the model actually here?" ───────────────────────────────────────────
//
// The 288 MB download must happen ONLY on explicit user action. That rules out
// simply calling the cross-encoder whenever the mode is selected:
// `reranker.worker.ts` runs with `env.allowRemoteModels = true`, so the first
// search would silently start a 288 MB fetch — the opposite of opt-in.
//
// `isCrossEncoderLoaded()` cannot be the gate either: the Settings download card
// warms the model through its own short-lived worker and terminates it, so the
// scoring singleton in `reranker.ts` is still null afterwards. The gate therefore
// has to be a persisted record of the user's explicit "download" click.

const MODEL_READY_KEY = 'zettelagent:rerank_model_ready';

/** Record that the user downloaded the cross-encoder and it ran a forward pass.
 *  Called from the Settings download card, which is the only explicit consent. */
export function markCrossEncoderInstalled(): void {
  try {
    localStorage.setItem(MODEL_READY_KEY, '1');
  } catch {
    // Private-mode / quota. Worst case Tier 2 stays off, which is the safe way
    // for this particular flag to fail.
  }
}

/** True only if the user has downloaded the model at some point on this machine. */
export function isCrossEncoderInstalled(): boolean {
  try {
    return localStorage.getItem(MODEL_READY_KEY) === '1';
  } catch {
    return false;
  }
}

/** Test seam: forget the consent flag. */
export function forgetCrossEncoderInstalled(): void {
  try {
    localStorage.removeItem(MODEL_READY_KEY);
  } catch {
    /* nothing to forget */
  }
}

// ── Result shape ────────────────────────────────────────────────────────────

/** The tier that actually produced an ordering. Never the configured tier. */
export type RerankTier = 'off' | 'lexical' | 'crossEncoder';

/** Why the configured tier did not run. `undefined` when nothing was degraded. */
export type RerankDegradeReason =
  /** Mode is `crossEncoder` but the user never downloaded the model. */
  | 'modelMissing'
  /** The model was asked and declined: timeout, load failure, bad score vector. */
  | 'modelUnavailable'
  /** Mode is `llm`; Tier 3 is a by-contract Tier-1 fallback in this build. */
  | 'tierNotBridged';

export interface RerankedSearch {
  results: SearchResult[];
  /** What really ordered `results`. This is what the UI must display. */
  tier: RerankTier;
  /** Set when `tier` is not the configured mode. */
  degradedFrom?: RerankMode;
  reason?: RerankDegradeReason;
}

export interface RerankedSearchOptions {
  /**
   * Cross-encoder budget. On expiry the Tier-1 window is returned rather than
   * the UI being blocked.
   *
   * Deliberately **not** `RerankConfig.llmTimeoutMs`: that knob is labelled "LLM
   * timeout" in Settings and documented in Rust as a Tier-3 cost guard, so
   * overloading it would make a user tuning their LLM silently retune their local
   * model. `RerankConfig.topK` *does* generalise and is reused — it is the window
   * width `rerank_search_window` already applies via `effective_top_k()`.
   */
  timeoutMs?: number;
  maxSnippetChars?: number;
}

// ── Ordering ────────────────────────────────────────────────────────────────

/**
 * Re-stamp `score` so it agrees with the position each row now holds.
 *
 * Rust's `rerank_results` does the same thing for the same reason: `score` is
 * treated as "sort key, higher is better" by several consumers, so leaving the
 * Tier-1 scores attached to a cross-encoder ordering would let any downstream
 * `sort((a, b) => b.score - a.score)` silently undo the rerank. The values are
 * ranks, not calibrated relevances — a cross-encoder logit is not comparable
 * across queries anyway.
 */
function restampScores(rows: SearchResult[]): SearchResult[] {
  const n = rows.length;
  return rows.map((r, i) => ({ ...r, score: n > 0 ? (n - i) / n : 0 }));
}

/**
 * Run a search and let the configured rerank tier actually order it.
 *
 * Tier 1 / `off` / `llm` take the plain `search_chunks` path — Rust has already
 * applied whatever ordering those modes mean. Only `crossEncoder` takes the
 * window path, and only when the user has downloaded the model.
 *
 * Never throws for rerank reasons. A failure anywhere in the Tier-2 path falls
 * back to the ordering Rust already produced, because a search that breaks
 * because its optional rerank broke is strictly worse than an unreranked search.
 */
export async function searchChunksReranked(
  query: SearchQuery,
  opts: RerankedSearchOptions = {},
): Promise<RerankedSearch> {
  const mode = await readRerankMode();

  if (mode !== 'crossEncoder') {
    return {
      results: await searchChunks(query),
      // `off` returns the fused order untouched; `lexical` is Tier 1; `llm` is a
      // by-contract Tier-1 fallback in this build (an awaited LLM call inside the
      // command would hold the DB mutex), so it reports `lexical`, not `llm`.
      tier: mode === 'off' ? 'off' : 'lexical',
      ...(mode === 'llm'
        ? { degradedFrom: 'llm' as RerankMode, reason: 'tierNotBridged' as RerankDegradeReason }
        : {}),
    };
  }

  if (!isCrossEncoderInstalled()) {
    // Do not touch the network. The user picked the mode but never paid the
    // 288 MB, so Rust's silent degrade stands — and we say so out loud.
    return {
      results: await searchChunks(query),
      tier: 'lexical',
      degradedFrom: 'crossEncoder',
      reason: 'modelMissing',
    };
  }

  return runCrossEncoder(query, opts);
}

/**
 * Read the mode that is actually in force. A backend without the rerank commands
 * still searches fine, it just cannot be anything but Tier 1.
 */
async function readRerankMode(): Promise<RerankMode> {
  try {
    return (await getRerankConfig()).mode;
  } catch (e) {
    if (e instanceof RerankBackendUnavailable) return 'lexical';
    console.warn('[rerankSearch] rerank config unreadable, assuming lexical:', e);
    return 'lexical';
  }
}

/** The Tier-2 path proper: window → score → reorder → truncate. */
async function runCrossEncoder(
  query: SearchQuery,
  opts: RerankedSearchOptions,
): Promise<RerankedSearch> {
  let window;
  try {
    window = await rerankSearchWindow(query);
  } catch (e) {
    // The window command failed (not registered, bad embedding, DB error). Fall
    // back to the plain search rather than surfacing a rerank problem as a search
    // failure. If that fails too it is a genuine search error and must propagate.
    console.warn('[rerankSearch] rerank window unavailable, using plain search:', e);
    return {
      results: await searchChunks(query),
      tier: 'lexical',
      degradedFrom: 'crossEncoder',
      reason: 'modelUnavailable',
    };
  }

  const limit = window.limit > 0 ? window.limit : window.results.length;

  // Nothing to reorder. Reporting `modelUnavailable` here would be a lie (the
  // model was never asked) and reporting `crossEncoder` would be a different lie
  // (it never ran). A 0- or 1-row list has no meaningful tier, so say the plain
  // thing and attach no failure reason.
  if (window.candidates.length <= 1) {
    return { results: window.results.slice(0, limit), tier: 'lexical' };
  }

  const fallback: RerankedSearch = {
    results: window.results.slice(0, limit),
    tier: 'lexical',
    degradedFrom: 'crossEncoder',
    reason: 'modelUnavailable',
  };

  // `rerank` resolves `null` — never rejects — for a missing model, a timeout, or
  // a malformed score vector. That single contract is what makes the fallback a
  // one-liner here.
  const order = await crossEncoderRerank(query.query, window.candidates, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_RERANK_TIMEOUT_MS,
    maxSnippetChars: opts.maxSnippetChars ?? DEFAULT_MAX_SNIPPET_CHARS,
  });
  if (!order || order.length === 0) return fallback;

  // `applyIndexOrder` is total: garbage indices reorder but can never lose or
  // duplicate a row, so the truncation below is always over the full window.
  const ordered = applyIndexOrder(window.results, order);
  return { results: restampScores(ordered).slice(0, limit), tier: 'crossEncoder' };
}

// ── Cancellation ────────────────────────────────────────────────────────────

/** A search whose answer may already be obsolete by the time it arrives. */
export type SupersedableSearch = RerankedSearch & {
  /** True when a newer search started before this one resolved. Callers MUST
   *  check this before touching state. */
  stale: boolean;
};

/**
 * Wrap `searchChunksReranked` in a request token so a slow cross-encoder can
 * never overwrite a newer result set.
 *
 * Same idiom as `streamSessionIdRef` in `SmartChat` and `loadTokenRef` in
 * `MarkdownViewer`: stamp the owner of the request when it is *issued*, compare on
 * completion, drop the answer if it is no longer the owner. Searches supersede
 * each other as the user types, and Tier 2 makes each one much slower — a 32-pair
 * cross-encoder pass easily outlives two more keystrokes — so without this the
 * results panel would flicker back to an older query's answer.
 *
 * Aborting the model run itself is not on the table: `reranker.worker.ts` has no
 * cancel message and a forward pass in WASM is not interruptible. Dropping the
 * answer is the achievable guarantee, and it is the one that matters — the
 * failure mode being prevented is a wrong *render*, not wasted CPU.
 *
 * One searcher per UI surface (create it in a `useRef`), because the token is what
 * defines "newer" and two unrelated panels must not cancel each other.
 */
export function createRerankedSearcher() {
  let issued = 0;
  return async function search(
    query: SearchQuery,
    opts?: RerankedSearchOptions,
  ): Promise<SupersedableSearch> {
    const token = ++issued;
    try {
      const out = await searchChunksReranked(query, opts);
      return { ...out, stale: token !== issued };
    } catch (e) {
      // A genuine search failure. Still tagged, so a stale error cannot blank a
      // fresh result set either.
      if (token !== issued) {
        return { results: [], tier: 'lexical', stale: true };
      }
      throw e;
    }
  };
}





