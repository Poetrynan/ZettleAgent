//! Relevance rerank stage for the retrieval chain: **recall wide, rerank narrow**.
//!
//! `hybrid_search` fuses FTS5 and sqlite-vec with RRF, which is a *rank* fusion:
//! it only knows "position 3 in list A, position 7 in list B". It is blind to
//! *why* a chunk matched — it cannot tell a chunk that contains every query term
//! in one sentence from a chunk that happens to contain one of them 4000 chars
//! down the page. That is exactly what a rerank stage is for.
//!
//! Three pluggable tiers, because this is a local-first app and we refuse to make
//! a few hundred MB of model download the price of decent search:
//!
//! - [`RerankMode::Lexical`] — **the default**. Zero download, zero extra latency,
//!   pure feature scoring over the RRF candidates. Fully implemented here.
//! - [`RerankMode::CrossEncoder`] — optional, opt-in download. The model runs in
//!   the frontend (same ONNX/transformers.js path as `src/lib/embeddings.ts`);
//!   Rust only hands out the candidate window and applies the returned order.
//! - [`RerankMode::Llm`] — optional, reuses the LLM the user already configured.
//!   Listwise prompt + parser live here (pure, testable); the transport lives in
//!   the command layer.
//!
//! Tier 2 and 3 both funnel through [`ExternalReranker`], whose contract is
//! `Option<Vec<usize>>`: `None` means "unavailable / timed out / garbage reply"
//! and **silently degrades to Tier 1**. A rerank must never be able to fail a
//! search — reranking is a quality nicety, retrieval is the actual feature.
//!
//! Note this is a *relevance* reranker and is deliberately separate from
//! [`crate::db::rerank`], which is a *diversity/recency* reranker (time decay +
//! MMR). They compose: relevance first (is this chunk about the query?), then
//! MMR (have I already shown the user this?).

use serde::{Deserialize, Serialize};

use super::SearchResult;

// ── Tunables ────────────────────────────────────────────────────────────────

/// How many of the fused candidates actually get reranked.
///
/// Every production retrieval chain caps this: reranking is superlinear in cost
/// per candidate (a cross-encoder is a full forward pass *per pair*, an LLM
/// listwise call pays tokens per candidate), while the marginal chance that the
/// best answer is sitting at fused rank 40 is tiny. 32 is chosen inside the
/// 20–50 band because our default `limit` is 5–10, so 32 gives 3–6x headroom
/// for the rerank to promote something the fusion under-ranked, while keeping a
/// Tier-3 listwise prompt to roughly 32 × 400 chars ≈ 13k chars — one cheap
/// call, not a context blowout.
pub const RERANK_TOP_K: usize = 32;

/// Weight kept on the original fused position. The RRF order already encodes the
/// dense-vector evidence, which a lexical reranker cannot see at all; throwing it
/// away entirely would make semantic-only matches (paraphrases, synonyms — the
/// whole point of having embeddings) collapse to the bottom. 0.30 lets the
/// lexical features lead while keeping the fusion as a prior.
const PRIOR_WEIGHT: f64 = 0.30;

/// Decay constant for the positional prior: `PRIOR_K / (PRIOR_K + i)`.
/// Deliberately gentle (rank 0 → 1.00, rank 1 → 0.91, rank 10 → 0.50) so that
/// adjacent fused ranks are nearly tied and the lexical signal can break them.
/// A steep prior (`1/(1+i)`) would freeze the top 2 in place.
const PRIOR_K: f64 = 10.0;

// Feature weights. They sum to 1.0 so the lexical score stays in [0, 1] and is
// directly comparable to the prior.
const W_COVERAGE: f64 = 0.40;
const W_TF: f64 = 0.10;
const W_PROXIMITY: f64 = 0.15;
const W_HEADING: f64 = 0.20;
const W_PHRASE: f64 = 0.10;
const W_EARLY: f64 = 0.05;

/// Term-frequency saturation pivot. `tf/(tf+pivot)` shape: the 2nd occurrence of
/// a term is worth much less than the 1st, so keyword stuffing cannot win.
const TF_PIVOT: f64 = 3.0;

/// Character span at which proximity is worth half. ~40 chars is roughly one
/// clause in English and one sentence in Chinese: terms inside that window are
/// plausibly part of the same statement.
const PROX_HALF_SPAN: f64 = 40.0;

/// Chunk length (in chars) treated as "normal". Longer chunks get discounted on
/// the bulk (coverage/tf) signals only.
const LEN_PIVOT: f64 = 400.0;

/// Window counted as the chunk's opening. Markdown chunks lead with the topic
/// sentence or definition, so an early hit is stronger evidence of aboutness.
const EARLY_WINDOW: f64 = 120.0;

/// Safety cap on occurrences counted per term. Guards against a pathological
/// chunk (a generated table, a minified blob) making scoring O(huge).
const MAX_OCCURRENCES_PER_TERM: usize = 64;

/// Hard cap on the text we scan per candidate, in **chars** (never bytes — see
/// the UTF-8 note on [`truncate_chars`]). Chunks are ~400–2000 chars; anything
/// past 20k contributes nothing but CPU.
const MAX_SCAN_CHARS: usize = 20_000;

// ── Configuration ───────────────────────────────────────────────────────────

/// Which reranker to run. `Off` is a genuine no-op: the fused order is returned
/// untouched, byte for byte.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RerankMode {
    Off,
    Lexical,
    CrossEncoder,
    Llm,
}

impl Default for RerankMode {
    /// Tier 1. Costs nothing, downloads nothing, so it is safe to have on for
    /// every user out of the box.
    fn default() -> Self {
        RerankMode::Lexical
    }
}

impl RerankMode {
    /// Parse the string that crosses the Tauri/settings boundary. Unknown values
    /// fall back to the default rather than erroring: a stale settings file must
    /// not be able to break search.
    pub fn from_str_lenient(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "off" | "none" | "false" => RerankMode::Off,
            "crossencoder" | "cross_encoder" | "cross-encoder" => RerankMode::CrossEncoder,
            "llm" => RerankMode::Llm,
            _ => RerankMode::Lexical,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            RerankMode::Off => "off",
            RerankMode::Lexical => "lexical",
            RerankMode::CrossEncoder => "crossEncoder",
            RerankMode::Llm => "llm",
        }
    }
}

/// Rerank settings. Every field has a defensible default so callers that do not
/// care can pass `RerankConfig::default()`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RerankConfig {
    pub mode: RerankMode,
    /// Size of the rerank window. See [`RERANK_TOP_K`].
    pub top_k: usize,
    /// Tier 3 cost guard: never send more than this many candidates to the LLM.
    /// Lower than `top_k` on purpose — a listwise call is the most expensive tier
    /// and accuracy plateaus well before 32 items.
    pub llm_max_candidates: usize,
    /// Tier 3 cost guard: chars (not bytes) of each snippet handed to the LLM.
    pub llm_max_snippet_chars: usize,
    /// Tier 3 cost guard: give up and fall back to Tier 1 after this long.
    pub llm_timeout_ms: u64,
}

impl Default for RerankConfig {
    fn default() -> Self {
        Self {
            mode: RerankMode::default(),
            top_k: RERANK_TOP_K,
            // 12 candidates × 320 chars ≈ 4k chars ≈ 1–2k tokens: one cheap call
            // even on a small local model.
            llm_max_candidates: 12,
            llm_max_snippet_chars: 320,
            llm_timeout_ms: 8_000,
        }
    }
}

impl RerankConfig {
    /// Tier 1 with default tunables.
    pub fn lexical() -> Self {
        Self { mode: RerankMode::Lexical, ..Self::default() }
    }

    /// Explicitly disabled. Retrieval behaves exactly as it did before this
    /// module existed.
    pub fn off() -> Self {
        Self { mode: RerankMode::Off, ..Self::default() }
    }

    /// Effective window, clamped so a bad setting (0, or 100000) cannot turn the
    /// rerank into a no-op or a full-table scan.
    pub fn effective_top_k(&self) -> usize {
        self.top_k.clamp(2, 200)
    }
}

// ── External tiers (2 & 3) ──────────────────────────────────────────────────

/// One candidate as handed to an external reranker (frontend cross-encoder, or
/// an LLM). `index` is the candidate's position in the window, and it — not
/// `chunk_id` — is the identity used to apply the returned order: the regex
/// branch of `search_notes` emits `chunk_id: 0` for every row, so chunk ids are
/// not guaranteed unique inside a result set.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RerankCandidate {
    pub index: usize,
    pub chunk_id: i64,
    pub file_path: String,
    /// Heading path, useful to the model as a cheap topic label.
    pub heading: String,
    /// Length-capped snippet. Truncated on char boundaries.
    pub snippet: String,
}

/// A reranker that lives outside Rust: the ONNX cross-encoder in the webview, or
/// the user's configured LLM.
///
/// Returning `None` is the *expected* path whenever the model is not downloaded,
/// the request timed out, or the reply could not be parsed. Callers treat `None`
/// as "use Tier 1" and never surface an error, because a search that fails
/// because its optional rerank failed is strictly worse than an unreranked
/// search.
pub trait ExternalReranker {
    /// Candidate indices in their new best-first order. May be shorter than the
    /// input (missing indices are appended in their original order) but must not
    /// invent indices — [`apply_index_order`] ignores anything out of range.
    fn rerank(&self, query: &str, candidates: &[RerankCandidate]) -> Option<Vec<usize>>;
}

// ── Query tokenization (CJK-aware) ──────────────────────────────────────────

/// English function words. Without this, "what is a knowledge graph" would let a
/// chunk stuffed with "is"/"a" score full coverage while saying nothing about
/// knowledge graphs.
const ASCII_STOPWORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "by", "do", "does", "for", "from", "how", "in",
    "is", "it", "of", "on", "or", "that", "the", "to", "was", "what", "when", "where", "which",
    "who", "why", "with",
];

/// Same list `build_fts_query` uses: single CJK chars that carry no topic signal.
const CJK_STOP_CHARS: &[char] = &[
    '是', '的', '了', '吗', '呢', '吧', '啊', '在', '有', '和', '与', '或', '不', '也', '都',
    '就', '把', '被', '给', '让', '对', '从', '到', '为', '着', '过', '得', '地', '么',
];

/// The query, decomposed into the units we score against.
#[derive(Debug, Clone)]
pub struct QueryTerms {
    /// Whole cleaned+lowercased query, for the exact-phrase signal.
    pub phrase: Vec<char>,
    /// Distinct scoring units, lowercased. ASCII words stay whole; CJK runs become
    /// character bigrams.
    pub terms: Vec<Vec<char>>,
}

impl QueryTerms {
    pub fn is_empty(&self) -> bool {
        self.terms.is_empty()
    }
}

/// Split a query into scoring units, mirroring `build_fts_query`'s segmentation so
/// the reranker scores the same units FTS5 actually matched on.
///
/// Sanitization is deliberately identical to `full_text_search`: strip only
/// `is_control()` chars. Dropping `.` or `-` here would make "nomic-embed-v1.5"
/// unscoreable in exactly the same way it used to make it unsearchable.
///
/// Chinese gets **character bigrams**, not `split_whitespace()` — Chinese has no
/// word delimiters, so whitespace splitting would yield a single opaque blob that
/// only ever matches verbatim. Bigrams are the standard cheap stand-in for word
/// segmentation (same idea as FTS5's trigram tokenizer): "知识图谱" → 知识 / 识图
/// / 图谱, which still matches "知识的图谱" partially instead of not at all.
/// Single characters alone would be too ambiguous (one CJK char is a
/// false-positive magnet), so a lone CJK char is only used as a term when the
/// whole run is 1 char long.

pub fn tokenize_query(query: &str) -> QueryTerms {
    let cleaned: String = query
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .to_lowercase();

    let mut terms: Vec<Vec<char>> = Vec::new();
    let mut ascii = String::new();
    let mut cjk: Vec<char> = Vec::new();

    // Local closures keep the two flush points from drifting apart.
    fn flush_ascii(buf: &mut String, out: &mut Vec<Vec<char>>) {
        let word = buf.trim().to_string();
        buf.clear();
        if word.is_empty() {
            return;
        }
        if !word.chars().any(|c| c.is_alphanumeric()) {
            return; // bare "-" / "..." — nothing indexable, nothing to score
        }
        if ASCII_STOPWORDS.contains(&word.as_str()) {
            return;
        }
        out.push(word.chars().collect());
    }

    fn flush_cjk(buf: &mut Vec<char>, out: &mut Vec<Vec<char>>) {
        if buf.is_empty() {
            return;
        }
        if buf.len() == 1 {
            // A one-char run is all we have; keep it unless it is a stop char.
            if !CJK_STOP_CHARS.contains(&buf[0]) {
                out.push(buf.clone());
            }
        } else {
            for w in buf.windows(2) {
                // A bigram of two stop chars ("的了") is noise; one content char
                // is enough to make the pair informative.
                if w.iter().all(|c| CJK_STOP_CHARS.contains(c)) {
                    continue;
                }
                out.push(w.to_vec());
            }
        }
        buf.clear();
    }

    for c in cleaned.chars() {
        if super::is_cjk_char(c) {
            flush_ascii(&mut ascii, &mut terms);
            cjk.push(c);
        } else {
            flush_cjk(&mut cjk, &mut terms);
            if c.is_whitespace() {
                flush_ascii(&mut ascii, &mut terms);
            } else {
                ascii.push(c);
            }
        }
    }
    flush_ascii(&mut ascii, &mut terms);
    flush_cjk(&mut cjk, &mut terms);

    // Distinct units only: coverage is "how much of the query is present", so a
    // term repeated in the query must not inflate the denominator.
    terms.sort();
    terms.dedup();

    QueryTerms { phrase: cleaned.chars().collect(), terms }
}

/// Truncate on a **char** boundary. Byte slicing (`&s[..n]`) panics mid-codepoint
/// on Chinese text; this repo has already been bitten by that repeatedly.
pub fn truncate_chars(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

// ── Tier 1: lexical feature scoring ─────────────────────────────────────────

/// Per-candidate feature breakdown. Public so the settings/debug UI can show
/// *why* a chunk was promoted — an opaque reranker is impossible to tune.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LexicalFeatures {
    /// Fraction of distinct query terms present anywhere in the candidate.
    pub coverage: f64,
    /// Saturating term frequency in [0, 1).
    pub tf: f64,
    /// How tightly the matched terms cluster, in [0, 1].
    pub proximity: f64,
    /// Fraction of distinct query terms present in the heading path.
    pub heading: f64,
    /// Verbatim query occurrence: 1.0 in the heading, 0.7 in the body, else 0.
    pub phrase: f64,
    /// Hit near the start of the chunk, in [0, 1].
    pub early: f64,
    /// Pivoted length discount applied to `coverage`/`tf`, in (0, 1].
    pub length_norm: f64,
    /// Weighted total in [0, 1].
    pub score: f64,
}

/// All start offsets of `needle` in `hay`, as char indices. Naive scan: chunks are
/// ~400–2000 chars and the window is ≤ 32 candidates, so an index would cost more
/// than it saves.
fn find_all(hay: &[char], needle: &[char], cap: usize) -> Vec<usize> {
    let mut out = Vec::new();
    if needle.is_empty() || hay.len() < needle.len() {
        return out;
    }
    let last = hay.len() - needle.len();
    let mut i = 0usize;
    while i <= last {
        if hay[i..i + needle.len()] == needle[..] {
            out.push(i);
            if out.len() >= cap {
                break;
            }
            // Overlapping matches are allowed: CJK bigrams in "图谱谱系" must both
            // count, and stepping by needle.len() would miss one.
            i += 1;
        } else {
            i += 1;
        }
    }
    out
}

fn contains_seq(hay: &[char], needle: &[char]) -> bool {
    !needle.is_empty() && !find_all(hay, needle, 1).is_empty()
}

/// Smallest char span that contains at least one occurrence of every matched term.
/// `None` when fewer than 2 distinct terms matched — a single term has no
/// proximity, and pretending otherwise would reward one-word chunks.
fn min_covering_span(hits: &[(usize, usize)], distinct_terms: usize) -> Option<usize> {
    if distinct_terms < 2 || hits.len() < 2 {
        return None;
    }
    let mut sorted: Vec<(usize, usize)> = hits.to_vec();
    sorted.sort_unstable();

    // Classic minimum-window sweep over (position, term_id) pairs.
    let mut counts = std::collections::HashMap::<usize, usize>::new();
    let mut have = 0usize;
    let mut best = usize::MAX;
    let mut left = 0usize;

    for right in 0..sorted.len() {
        let e = counts.entry(sorted[right].1).or_insert(0);
        *e += 1;
        if *e == 1 {
            have += 1;
        }
        while have == distinct_terms && left <= right {
            best = best.min(sorted[right].0 - sorted[left].0);
            let lt = sorted[left].1;
            if let Some(c) = counts.get_mut(&lt) {
                *c -= 1;
                if *c == 0 {
                    have -= 1;
                }
            }
            left += 1;
        }
    }
    if best == usize::MAX { None } else { Some(best) }
}

/// Pivoted length normalization. Flat at 1.0 up to [`LEN_PIVOT`], then decays
/// logarithmically. This is the fix for the classic long-document bias: a 4000-char
/// chunk trivially contains every query term *somewhere*, which says nothing about
/// whether the chunk is about the query. Log (not linear) decay so a genuinely long
/// but on-topic chunk is discounted, not eliminated.
fn length_norm(char_len: usize) -> f64 {
    let len = char_len.max(1) as f64;
    let excess = (len / LEN_PIVOT).ln().max(0.0);
    1.0 / (1.0 + excess)
}

/// Score one candidate against the query terms.
///
/// Every signal here answers a question RRF cannot:
///
/// - **coverage** — FTS5 joins terms with `OR` (see `build_fts_query`), so a chunk
///   matching 1 of 4 terms and a chunk matching 4 of 4 can land at adjacent fused
///   ranks. Coverage is the single most discriminative cheap signal.
/// - **tf** — a term appearing repeatedly is weak extra evidence; saturated so a
///   keyword-stuffed chunk cannot outrank a well-written one.
/// - **proximity** — "机器学习" and "应用" in the same clause means the chunk talks
///   about *applications of machine learning*; 2000 chars apart means it mentions
///   both topics incidentally. Bag-of-words scoring is blind to this.
/// - **heading** — `heading_hierarchy` is the author's own topic label. A hit there
///   is curated evidence of aboutness, unlike a hit in a passing sentence.
/// - **phrase** — a verbatim occurrence of the whole query is the strongest signal
///   available without a model, and it is the one users expect to dominate.
/// - **early** — Markdown chunks open with the definition or topic sentence.
/// - **length_norm** — see [`length_norm`]; applied only to coverage/tf, because
///   those are the signals that inflate with document size. Penalizing a heading
///   or phrase hit for being in a long note would be wrong.
pub fn score_lexical(q: &QueryTerms, content: &str, heading: Option<&str>) -> LexicalFeatures {
    let mut f = LexicalFeatures { length_norm: 1.0, ..Default::default() };
    if q.is_empty() {
        return f;
    }

    // Lowercase + char-vector once. `MAX_SCAN_CHARS` caps pathological chunks, and
    // `chars().take()` keeps the cut on a codepoint boundary.
    let body: Vec<char> = content
        .to_lowercase()
        .chars()
        .take(MAX_SCAN_CHARS)
        .collect();
    let head: Vec<char> = heading
        .unwrap_or("")
        .to_lowercase()
        .chars()
        .take(MAX_SCAN_CHARS)
        .collect();

    let n_terms = q.terms.len() as f64;
    let mut matched = 0usize;
    let mut heading_matched = 0usize;
    let mut log_tf_sum = 0.0f64;
    let mut hits: Vec<(usize, usize)> = Vec::new();
    let mut distinct_body_terms = 0usize;
    let mut first_hit: Option<usize> = None;

    for (ti, term) in q.terms.iter().enumerate() {
        let positions = find_all(&body, term, MAX_OCCURRENCES_PER_TERM);
        let in_body = !positions.is_empty();
        let in_head = contains_seq(&head, term);

        if in_body {
            distinct_body_terms += 1;
            log_tf_sum += (1.0 + positions.len() as f64).ln();
            let earliest = positions[0];
            first_hit = Some(first_hit.map_or(earliest, |p: usize| p.min(earliest)));
            for p in positions {
                hits.push((p, ti));
            }
        }
        if in_head {
            heading_matched += 1;
        }
        // A term counts as covered if it appears anywhere in the candidate, body
        // or heading — the heading is part of what the user is matching against.
        if in_body || in_head {
            matched += 1;
        }
    }


    f.coverage = matched as f64 / n_terms;
    f.heading = heading_matched as f64 / n_terms;
    // Saturating: 1 hit → 0.19, 3 hits → 0.32, 20 hits → 0.50 for a single term.
    f.tf = log_tf_sum / (log_tf_sum + TF_PIVOT);

    f.proximity = match min_covering_span(&hits, distinct_body_terms) {
        // span 0 → 1.0, span == PROX_HALF_SPAN → 0.5, decaying smoothly after.
        Some(span) => PROX_HALF_SPAN / (PROX_HALF_SPAN + span as f64),
        None => 0.0,
    };

    f.phrase = if contains_seq(&head, &q.phrase) {
        1.0
    } else if contains_seq(&body, &q.phrase) {
        0.7
    } else {
        0.0
    };

    f.early = match first_hit {
        Some(p) if (p as f64) < EARLY_WINDOW => 1.0 - (p as f64 / EARLY_WINDOW),
        _ => 0.0,
    };

    f.length_norm = length_norm(body.len());

    let bulk = (W_COVERAGE * f.coverage + W_TF * f.tf) * f.length_norm;
    f.score = bulk
        + W_PROXIMITY * f.proximity
        + W_HEADING * f.heading
        + W_PHRASE * f.phrase
        + W_EARLY * f.early;
    f
}

// ── Orchestration ───────────────────────────────────────────────────────────

/// Positional prior derived from the fused rank. See [`PRIOR_K`].
fn rank_prior(i: usize) -> f64 {
    PRIOR_K / (PRIOR_K + i as f64)
}

/// Build the payload handed to an external reranker (Tier 2/3) from a candidate
/// window. Snippets are char-truncated.
pub fn build_candidates(
    window: &[SearchResult],
    max_snippet_chars: usize,
) -> Vec<RerankCandidate> {
    window
        .iter()
        .enumerate()
        .map(|(index, r)| RerankCandidate {
            index,
            chunk_id: r.chunk_id,
            file_path: r.file_path.clone(),
            heading: r.heading_hierarchy.clone().unwrap_or_default(),
            snippet: truncate_chars(&r.content, max_snippet_chars),
        })
        .collect()
}

/// Reorder `window` by an externally supplied index order.
///
/// Defensive on purpose, because the input may come from an LLM: out-of-range and
/// duplicate indices are dropped, and any candidate the model forgot is appended
/// in its original relative order. The output is therefore always a permutation of
/// the input — a sloppy model reply can reorder results but can never lose them.
pub fn apply_index_order(window: Vec<SearchResult>, order: &[usize]) -> Vec<SearchResult> {
    let n = window.len();
    let mut taken = vec![false; n];
    let mut out: Vec<SearchResult> = Vec::with_capacity(n);
    let mut slots: Vec<Option<SearchResult>> = window.into_iter().map(Some).collect();

    for &i in order {
        if i < n && !taken[i] {
            taken[i] = true;
            if let Some(r) = slots[i].take() {
                out.push(r);
            }
        }
    }
    for slot in slots.iter_mut() {
        if let Some(r) = slot.take() {
            out.push(r);
        }
    }
    out
}

/// Rerank an already-fused, best-first result list.
///
/// Contract:
/// - `RerankMode::Off`, an empty query, or ≤1 result → the input is returned
///   **untouched**, including every `score`. Callers get literally the old
///   behaviour, which is what makes this stage safe to ship on by default.
/// - Only the first `top_k` entries are reranked. The tail keeps its fused order
///   and is appended unchanged (recall wide, rerank narrow).
/// - When reranking does happen, `score` is overwritten with the blended rerank
///   score. This is deliberate: several call sites and the UI treat `score` as
///   "sort key, higher is better", so leaving the old RRF score behind would let
///   a downstream re-sort silently undo the rerank.
pub fn rerank_results(
    query: &str,
    results: Vec<SearchResult>,
    config: &RerankConfig,
    external: Option<&dyn ExternalReranker>,
) -> Vec<SearchResult> {
    if config.mode == RerankMode::Off || results.len() <= 1 {
        return results;
    }
    let terms = tokenize_query(query);
    if terms.is_empty() {
        // Nothing to score against (empty query, or all stop words). Reranking on
        // no evidence would just shuffle results.
        return results;
    }

    let k = config.effective_top_k().min(results.len());
    let mut window = results;
    let tail = window.split_off(k);

    let reranked = match config.mode {
        RerankMode::Off => window,
        RerankMode::Lexical => rerank_lexical(&terms, window),
        // Tiers 2 and 3 share the same fallback shape: ask the external reranker,
        // and if it cannot answer, run Tier 1. No error path, no stalled search.
        RerankMode::CrossEncoder | RerankMode::Llm => {
            // Tier 3 cost guard: the LLM only ever sees `llm_max_candidates` of the
            // window. Anything past that keeps its fused position (it is appended
            // by `apply_index_order` as a "missing" index), so the guard costs
            // recall depth, never results.
            let sent = match config.mode {
                RerankMode::Llm => config.llm_max_candidates.clamp(2, window.len()),
                _ => window.len(),
            };
            let order = external.and_then(|r| {
                let cands = build_candidates(&window[..sent], external_snippet_chars(config));
                r.rerank(query, &cands)
            });
            match order {
                Some(order) if !order.is_empty() => {
                    log::debug!("[rerank] {} applied external order", config.mode.as_str());
                    apply_index_order(window, &order)
                }
                _ => {
                    log::debug!(
                        "[rerank] {} unavailable — falling back to lexical",
                        config.mode.as_str()
                    );
                    rerank_lexical(&terms, window)
                }
            }
        }

    };

    let mut out = reranked;
    out.extend(tail);
    out
}

/// Snippet budget for whichever external tier is active. The LLM tier is the one
/// that pays per character, so it gets the tighter cap.
fn external_snippet_chars(config: &RerankConfig) -> usize {
    match config.mode {
        RerankMode::Llm => config.llm_max_snippet_chars,
        // A cross-encoder truncates at its own 512-token limit anyway; ~1000 chars
        // is comfortably past that for both English and Chinese.
        _ => 1_000,
    }
}

/// Tier 1 core: score every candidate, blend with the positional prior, sort.
fn rerank_lexical(terms: &QueryTerms, window: Vec<SearchResult>) -> Vec<SearchResult> {
    let mut scored: Vec<(f64, SearchResult)> = window
        .into_iter()
        .enumerate()
        .map(|(i, mut r)| {
            let f = score_lexical(terms, &r.content, r.heading_hierarchy.as_deref());
            let blended = PRIOR_WEIGHT * rank_prior(i) + (1.0 - PRIOR_WEIGHT) * f.score;
            r.score = blended;
            (blended, r)
        })
        .collect();

    // `sort_by` is stable, so equal scores keep the fused order. That makes the
    // reranker deterministic and makes "no usable signal" degrade to a no-op
    // rather than to an arbitrary shuffle.
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.into_iter().map(|(_, r)| r).collect()
}

// ── Tier 3: LLM listwise helpers (pure; transport lives in the command layer) ─

/// Build the listwise-rerank prompt. Pure string work so it is unit-testable
/// without an LLM. The candidate count and snippet length are already capped by
/// the caller via [`RerankConfig`]; this only formats.
///
/// The prompt asks for a bare comma-separated index list and nothing else,
/// because the reply is parsed by [`parse_llm_order`] with a strict, forgiving
/// fallback — the less prose the model emits, the more reliably it parses.
pub fn build_llm_prompt(query: &str, cands: &[RerankCandidate]) -> String {
    let mut s = String::new();
    s.push_str(
        "You are a search result reranker. Given a query and a numbered list of \
candidate passages, return the candidate numbers reordered from most to least \
relevant to the query. Reply with ONLY a comma-separated list of numbers, e.g. \
\"3,1,2,0\". Do not explain.\n\n",
    );
    s.push_str("Query: ");
    s.push_str(query.trim());
    s.push_str("\n\nCandidates:\n");
    for c in cands {
        // Index is the stable identity (chunk_id may be 0 for regex rows).
        s.push_str(&format!("[{}] ", c.index));
        if !c.heading.is_empty() {
            s.push_str(&truncate_chars(&c.heading, 120));
            s.push_str(" — ");
        }
        s.push_str(&c.snippet.replace('\n', " "));
        s.push('\n');
    }
    s.push_str("\nRanked order (numbers only):");
    s
}

/// Parse an LLM reply into an index order. Tolerant by design: models wrap the
/// list in prose, code fences, or brackets. We simply extract every integer in
/// order, dedupe, and drop out-of-range values. Returns `None` if nothing usable
/// was found, which routes the caller back to Tier 1.
pub fn parse_llm_order(reply: &str, n: usize) -> Option<Vec<usize>> {
    let mut order = Vec::new();
    let mut seen = vec![false; n];
    let mut cur = String::new();

    // Flush accumulated digits as one index.
    let flush = |cur: &mut String, order: &mut Vec<usize>, seen: &mut Vec<bool>| {

        if cur.is_empty() {
            return;
        }
        if let Ok(v) = cur.parse::<usize>() {
            if v < n && !seen[v] {
                seen[v] = true;
                order.push(v);
            }
        }
        cur.clear();
    };

    for ch in reply.chars() {
        if ch.is_ascii_digit() {
            cur.push(ch);
        } else {
            flush(&mut cur, &mut order, &mut seen);
        }
    }
    flush(&mut cur, &mut order, &mut seen);

    if order.is_empty() {
        None
    } else {
        Some(order)
    }
}

// ── Persistence + process-global active config ──────────────────────────────
//
// Same shape as `llm::approval`'s permission mode: a `OnceLock<Mutex<_>>` cache
// read on the hot path, `app_settings` as the durable store, and a `restore_*`
// called once at startup. The cache exists because every search reads this
// config; hitting `app_settings` per query would add a DB round-trip to the
// retrieval path to answer a question whose answer changes maybe twice a year.
//
// Strict on the way in, lenient on the way out — deliberately asymmetric:
// `parse_mode_strict` rejects a typo from the UI so a bad setting cannot be
// saved silently, while `restore_config` clamps/ignores garbage so a settings
// row written by an older or newer build can never break search.

/// `app_settings` keys. Prefixed `rerank_` and kept as five scalar rows rather
/// than one JSON blob so that a partially-written or partially-understood config
/// degrades per field instead of wholesale.
pub const RERANK_MODE_KEY: &str = "rerank_mode";
pub const RERANK_TOP_K_KEY: &str = "rerank_top_k";
pub const RERANK_LLM_MAX_CANDIDATES_KEY: &str = "rerank_llm_max_candidates";
pub const RERANK_LLM_MAX_SNIPPET_CHARS_KEY: &str = "rerank_llm_max_snippet_chars";
pub const RERANK_LLM_TIMEOUT_MS_KEY: &str = "rerank_llm_timeout_ms";

/// Accepted ranges for the user-settable knobs. Exposed so the command layer can
/// quote the exact bounds back in its error message instead of duplicating them.
pub const TOP_K_RANGE: (usize, usize) = (2, 200);
pub const LLM_MAX_CANDIDATES_RANGE: (usize, usize) = (2, 64);
pub const LLM_MAX_SNIPPET_CHARS_RANGE: (usize, usize) = (80, 4_000);
pub const LLM_TIMEOUT_MS_RANGE: (u64, u64) = (500, 120_000);

/// Strict wire-format parse, for values coming from the UI. Unlike
/// [`RerankMode::from_str_lenient`] an unknown string is an error, so a typo in a
/// settings payload surfaces instead of silently resetting the user to Tier 1.
pub fn parse_mode_strict(s: &str) -> Option<RerankMode> {
    match s {
        "off" => Some(RerankMode::Off),
        "lexical" => Some(RerankMode::Lexical),
        "crossEncoder" => Some(RerankMode::CrossEncoder),
        "llm" => Some(RerankMode::Llm),
        _ => None,
    }
}

fn config_slot() -> &'static std::sync::Mutex<RerankConfig> {
    static SLOT: std::sync::OnceLock<std::sync::Mutex<RerankConfig>> = std::sync::OnceLock::new();
    // Default is Tier 1, not `Off`: it costs nothing and downloads nothing, so
    // there is no reason to make the user opt in to better ordering.
    SLOT.get_or_init(|| std::sync::Mutex::new(RerankConfig::default()))
}

/// The rerank config in force for this process. This is what every wired call
/// site reads. A poisoned lock degrades to the default rather than panicking —
/// search must survive a panic elsewhere.
pub fn active_config() -> RerankConfig {
    config_slot()
        .lock()
        .map(|g| g.clone())
        .unwrap_or_else(|_| RerankConfig::default())
}

/// Overwrite the in-memory config. Persistence is the caller's job (the Tauri
/// command does both); this is the raw process-state write, also used by the
/// startup restore path and by tests.
pub fn store_config(config: RerankConfig) {
    if let Ok(mut g) = config_slot().lock() {
        *g = config;
    }
}

/// Clamp every field into its accepted range. Used on the *restore* path, where
/// erroring out is not an option: whatever is in the DB, search has to run.
pub fn clamp_config(mut config: RerankConfig) -> RerankConfig {
    config.top_k = config.top_k.clamp(TOP_K_RANGE.0, TOP_K_RANGE.1);
    config.llm_max_candidates = config
        .llm_max_candidates
        .clamp(LLM_MAX_CANDIDATES_RANGE.0, LLM_MAX_CANDIDATES_RANGE.1);
    config.llm_max_snippet_chars = config
        .llm_max_snippet_chars
        .clamp(LLM_MAX_SNIPPET_CHARS_RANGE.0, LLM_MAX_SNIPPET_CHARS_RANGE.1);
    config.llm_timeout_ms = config
        .llm_timeout_ms
        .clamp(LLM_TIMEOUT_MS_RANGE.0, LLM_TIMEOUT_MS_RANGE.1);
    config
}

/// Read the persisted config from `app_settings`, falling back per field to the
/// default. Missing rows are the normal case (fresh vault); unparseable rows are
/// treated as missing.
pub fn load_config(conn: &rusqlite::Connection) -> RerankConfig {
    let get = |key: &str| crate::db::schema::get_setting(conn, key).ok().flatten();
    let mut config = RerankConfig::default();
    if let Some(v) = get(RERANK_MODE_KEY) {
        // Lenient here on purpose: see the module note above.
        config.mode = RerankMode::from_str_lenient(&v);
    }
    if let Some(v) = get(RERANK_TOP_K_KEY).and_then(|v| v.trim().parse::<usize>().ok()) {
        config.top_k = v;
    }
    if let Some(v) = get(RERANK_LLM_MAX_CANDIDATES_KEY).and_then(|v| v.trim().parse::<usize>().ok())
    {
        config.llm_max_candidates = v;
    }
    if let Some(v) =
        get(RERANK_LLM_MAX_SNIPPET_CHARS_KEY).and_then(|v| v.trim().parse::<usize>().ok())
    {
        config.llm_max_snippet_chars = v;
    }
    if let Some(v) = get(RERANK_LLM_TIMEOUT_MS_KEY).and_then(|v| v.trim().parse::<u64>().ok()) {
        config.llm_timeout_ms = v;
    }
    clamp_config(config)
}

/// Write the config to `app_settings`. All five rows, so a later `load_config`
/// never mixes a new mode with a stale knob.
pub fn save_config(conn: &rusqlite::Connection, config: &RerankConfig) -> anyhow::Result<()> {
    let set = |key: &str, value: String| crate::db::schema::set_setting(conn, key, &value);
    set(RERANK_MODE_KEY, config.mode.as_str().to_string())?;
    set(RERANK_TOP_K_KEY, config.top_k.to_string())?;
    set(
        RERANK_LLM_MAX_CANDIDATES_KEY,
        config.llm_max_candidates.to_string(),
    )?;
    set(
        RERANK_LLM_MAX_SNIPPET_CHARS_KEY,
        config.llm_max_snippet_chars.to_string(),
    )?;
    set(RERANK_LLM_TIMEOUT_MS_KEY, config.llm_timeout_ms.to_string())?;
    Ok(())
}

/// Restore the persisted config into process state at startup. Called from
/// `run()` once the schema is ready. Never fails: worst case the default stays.
pub fn restore_config(conn: &rusqlite::Connection) {
    let config = load_config(conn);
    log::info!(
        "[rerank] mode={} top_k={}",
        config.mode.as_str(),
        config.effective_top_k()
    );
    store_config(config);
}

/// Serializing lock for tests that touch the process-global active config.
/// `cargo test` runs the whole crate in one multi-threaded process, so any test
/// that calls [`store_config`] would otherwise race every other test that reads
/// it through a wired call site. Same idiom as `tool_hooks::taint_test_lock`.
#[cfg(test)]
pub fn config_test_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

/// Take the lock and reset the config to the shipped default, so each test starts
/// from a known state regardless of what ran before it.
#[cfg(test)]
pub fn config_guard() -> std::sync::MutexGuard<'static, ()> {
    let guard = config_test_lock().lock().unwrap_or_else(|e| e.into_inner());
    store_config(RerankConfig::default());
    guard
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal fused result. `score` mimics an RRF value (~0.016) so the
    /// "disabled path is untouched" assertions are checking realistic data.
    fn sr(chunk_id: i64, heading: Option<&str>, content: &str) -> SearchResult {
        SearchResult {
            file_path: format!("note{}.md", chunk_id),
            chunk_id,
            content: content.to_string(),
            heading_hierarchy: heading.map(|h| h.to_string()),
            score: 1.0 / (60.0 + chunk_id as f64),
        }
    }

    fn ids(v: &[SearchResult]) -> Vec<i64> {
        v.iter().map(|r| r.chunk_id).collect()
    }

    // ── Tokenization ────────────────────────────────────────────────────────

    #[test]
    fn ascii_stopwords_are_not_scoring_units() {
        let q = tokenize_query("what is a knowledge graph");
        let terms: Vec<String> = q.terms.iter().map(|t| t.iter().collect()).collect();
        assert!(terms.contains(&"knowledge".to_string()));
        assert!(terms.contains(&"graph".to_string()));
        assert!(!terms.contains(&"is".to_string()));
        assert!(!terms.contains(&"a".to_string()));
    }

    #[test]
    fn cjk_is_segmented_into_bigrams_not_whitespace() {
        // `split_whitespace()` would yield one opaque 4-char blob here.
        let q = tokenize_query("知识图谱");
        let terms: Vec<String> = q.terms.iter().map(|t| t.iter().collect()).collect();
        assert_eq!(terms.len(), 3);
        for bg in ["知识", "识图", "图谱"] {
            assert!(terms.contains(&bg.to_string()), "missing bigram {}", bg);
        }
    }

    #[test]
    fn mixed_query_keeps_ascii_words_whole() {
        let q = tokenize_query("BERT是什么 embedding");
        let terms: Vec<String> = q.terms.iter().map(|t| t.iter().collect()).collect();
        assert!(terms.contains(&"bert".to_string()));
        assert!(terms.contains(&"embedding".to_string()));
    }

    #[test]
    fn punctuation_bearing_terms_survive_sanitization() {
        // Same regression `full_text_search` guards: dropping '.'/'-' turned
        // "nomic-embed-v1.5" into an unmatchable token.
        let q = tokenize_query("nomic-embed-v1.5");
        let terms: Vec<String> = q.terms.iter().map(|t| t.iter().collect()).collect();
        assert_eq!(terms, vec!["nomic-embed-v1.5".to_string()]);
    }

    // ── Individual feature signals ───────────────────────────────────────────

    #[test]
    fn coverage_rewards_more_matched_terms() {
        let q = tokenize_query("machine learning models");
        let all = score_lexical(&q, "machine learning models are trained", None);
        let some = score_lexical(&q, "machine parts and gears", None);
        assert!(all.coverage > some.coverage);
        assert!((all.coverage - 1.0).abs() < 1e-9);
    }

    #[test]
    fn proximity_prefers_terms_close_together() {
        let q = tokenize_query("neural network");
        let near = score_lexical(&q, "a neural network layer", None);
        let filler = "lorem ipsum ".repeat(50);
        let far = score_lexical(&q, &format!("neural {} network", filler), None);
        assert!(
            near.proximity > far.proximity,
            "near={} far={}",
            near.proximity,
            far.proximity
        );
    }

    #[test]
    fn heading_hit_outweighs_body_hit() {
        let q = tokenize_query("transformers");
        let in_heading = score_lexical(&q, "generic body text mentioning it once: transformers", Some("Transformers"));
        let in_body = score_lexical(&q, "generic body text mentioning it once: transformers", Some("Unrelated"));
        assert!(in_heading.heading > 0.0);
        assert_eq!(in_body.heading, 0.0);
        assert!(in_heading.score > in_body.score);
    }

    #[test]
    fn exact_phrase_gets_a_bonus() {
        let q = tokenize_query("knowledge graph");
        let phrase = score_lexical(&q, "a knowledge graph connects notes", None);
        let split = score_lexical(&q, "knowledge about the citation graph", None);
        assert!(phrase.phrase > split.phrase);
    }

    #[test]
    fn length_normalization_discounts_bloated_chunks() {
        let q = tokenize_query("alpha beta");
        let tight = score_lexical(&q, "alpha beta", None);
        let padding = "padding word ".repeat(400);
        let bloated = score_lexical(&q, &format!("alpha beta {}", padding), None);
        // Same terms present, but the bloated chunk is discounted on the bulk signal.
        assert!(tight.length_norm > bloated.length_norm);
        assert!(tight.score > bloated.score);
    }

    #[test]
    fn tf_saturates() {
        let q = tokenize_query("cat");
        let once = score_lexical(&q, "cat", None);
        let many = score_lexical(&q, &"cat ".repeat(50), None);
        // More occurrences raise tf, but sublinearly — never approaching a 50x gap.
        assert!(many.tf > once.tf);
        assert!(many.tf < 1.0);
    }

    // ── Chinese reranking actually reorders (not a no-op) ─────────────────────

    #[test]
    fn chinese_query_promotes_the_relevant_candidate() {
        let q = "知识图谱的应用";
        // Fused order is deliberately WRONG: the on-topic chunk sits last.
        let fused = vec![
            sr(1, Some("烹饪"), "今天我们来聊聊美食和烹饪的乐趣，与图谱无关。"),
            sr(2, Some("天气"), "明天的天气预报显示有雨，记得带伞出门。"),
            sr(3, Some("知识图谱"), "知识图谱的应用非常广泛，可以用于搜索和推荐系统。"),
        ];
        let out = rerank_results(q, fused, &RerankConfig::lexical(), None);
        assert_eq!(out[0].chunk_id, 3, "the on-topic Chinese chunk must rank first");
    }

    #[test]
    fn chinese_reranking_is_not_identity() {
        let q = "机器学习";
        let fused = vec![
            sr(1, None, "这是一段完全无关的文字，讲述历史故事。"),
            sr(2, None, "机器学习是人工智能的核心领域之一。"),
        ];
        let before = ids(&fused);
        let out = rerank_results(q, fused, &RerankConfig::lexical(), None);
        assert_ne!(ids(&out), before, "rerank must change the order here");
        assert_eq!(out[0].chunk_id, 2);
    }

    // ── Disabled path is byte-for-byte identical ─────────────────────────────

    #[test]
    fn off_mode_returns_input_untouched() {
        let fused = vec![
            sr(1, Some("H1"), "alpha content"),
            sr(2, Some("H2"), "beta content"),
            sr(3, None, "gamma content"),
        ];
        let clone = fused.clone();
        let out = rerank_results("alpha", fused, &RerankConfig::off(), None);
        assert_eq!(ids(&out), ids(&clone));
        // Scores must be preserved exactly — a downstream re-sort must see the
        // original RRF values.
        for (a, b) in out.iter().zip(clone.iter()) {
            assert_eq!(a.score, b.score);
        }
    }

    #[test]
    fn empty_query_is_a_noop() {
        let fused = vec![sr(1, None, "alpha"), sr(2, None, "beta")];
        let clone = fused.clone();
        let out = rerank_results("   ", fused, &RerankConfig::lexical(), None);
        assert_eq!(ids(&out), ids(&clone));
        for (a, b) in out.iter().zip(clone.iter()) {
            assert_eq!(a.score, b.score);
        }
    }

    // ── top-K truncation ─────────────────────────────────────────────────────

    #[test]
    fn only_top_k_is_reranked_tail_keeps_fused_order() {
        // Window = 2. The relevant chunk (id 5) is in the tail and must NOT be
        // pulled forward — recall wide, rerank narrow.
        let mut cfg = RerankConfig::lexical();
        cfg.top_k = 2;
        let fused = vec![
            sr(1, None, "unrelated one"),
            sr(2, None, "unrelated two"),
            sr(3, None, "unrelated three"),
            sr(4, None, "unrelated four"),
            sr(5, Some("target"), "target target target relevant"),
        ];
        let out = rerank_results("target", fused, &cfg, None);
        // Tail (ids 3,4,5) stays in fused order after the 2 reranked heads.
        assert_eq!(out.len(), 5);
        assert_eq!(ids(&out[2..]), vec![3, 4, 5]);
    }

    // ── Robustness ────────────────────────────────────────────────────────────

    #[test]
    fn empty_and_single_and_empty_content_do_not_panic() {
        assert!(rerank_results("q", vec![], &RerankConfig::lexical(), None).is_empty());
        let one = vec![sr(1, None, "only")];
        assert_eq!(rerank_results("q", one, &RerankConfig::lexical(), None).len(), 1);
        // Empty query terms AND empty candidate content.
        let q = tokenize_query("");
        let f = score_lexical(&q, "", None);
        assert_eq!(f.score, 0.0);
    }

    #[test]
    fn very_long_chinese_content_does_not_panic_on_utf8_boundary() {
        // 30k CJK chars — past MAX_SCAN_CHARS, so truncation happens mid-run and
        // must land on a codepoint boundary. Byte slicing would panic here.
        let long: String = "知识图谱".chars().cycle().take(30_000).collect();
        let q = tokenize_query("图谱");
        let f = score_lexical(&q, &long, Some("知识"));
        assert!(f.coverage > 0.0);
        // truncate_chars is the public UTF-8-safe helper the snippet path uses.
        let snip = truncate_chars(&long, 100);
        assert_eq!(snip.chars().count(), 100);
    }

    // ── Tier 2 / Tier 3: injection point + silent fallback ───────────────────

    /// Stands in for "cross-encoder model was never downloaded".
    struct Unavailable;
    impl ExternalReranker for Unavailable {
        fn rerank(&self, _q: &str, _c: &[RerankCandidate]) -> Option<Vec<usize>> {
            None
        }
    }

    /// Stands in for a model (or LLM) that answered with a concrete order.
    struct FixedOrder(Vec<usize>);
    impl ExternalReranker for FixedOrder {
        fn rerank(&self, _q: &str, _c: &[RerankCandidate]) -> Option<Vec<usize>> {
            Some(self.0.clone())
        }
    }

    /// Records how many candidates it was handed, to assert the Tier 3 cost guard.
    struct CountingReranker(std::sync::Mutex<usize>);
    impl ExternalReranker for CountingReranker {
        fn rerank(&self, _q: &str, c: &[RerankCandidate]) -> Option<Vec<usize>> {
            *self.0.lock().unwrap() = c.len();
            None
        }
    }

    fn chinese_fixture() -> Vec<SearchResult> {
        vec![
            sr(1, None, "这是一段完全无关的文字，讲述历史故事。"),
            sr(2, None, "机器学习是人工智能的核心领域之一。"),
            sr(3, None, "另一段无关的内容，关于园艺和植物。"),
        ]
    }

    #[test]
    fn cross_encoder_without_model_falls_back_to_lexical() {
        let q = "机器学习";
        let lexical = rerank_results(q, chinese_fixture(), &RerankConfig::lexical(), None);

        let mut cfg = RerankConfig::default();
        cfg.mode = RerankMode::CrossEncoder;
        // Both "no reranker injected at all" and "reranker present but says None"
        // must degrade to exactly the Tier 1 result — no error, no reordering loss.
        let no_injection = rerank_results(q, chinese_fixture(), &cfg, None);
        let model_missing = rerank_results(q, chinese_fixture(), &cfg, Some(&Unavailable));

        assert_eq!(ids(&no_injection), ids(&lexical));
        assert_eq!(ids(&model_missing), ids(&lexical));
    }

    #[test]
    fn llm_tier_falls_back_to_lexical_on_failure() {
        let q = "机器学习";
        let lexical = rerank_results(q, chinese_fixture(), &RerankConfig::lexical(), None);
        let mut cfg = RerankConfig::default();
        cfg.mode = RerankMode::Llm;
        let timed_out = rerank_results(q, chinese_fixture(), &cfg, Some(&Unavailable));
        assert_eq!(ids(&timed_out), ids(&lexical));
    }

    #[test]
    fn external_order_is_applied_and_omissions_are_appended() {
        let mut cfg = RerankConfig::default();
        cfg.mode = RerankMode::CrossEncoder;
        // Model returns only candidate 2, and one bogus index.
        let out = rerank_results(
            "机器学习",
            chinese_fixture(),
            &cfg,
            Some(&FixedOrder(vec![2, 99])),
        );
        // 99 is ignored; 0 and 1 are appended in their original relative order.
        assert_eq!(ids(&out), vec![3, 1, 2]);
    }

    #[test]
    fn llm_candidate_cap_is_enforced() {
        let mut cfg = RerankConfig::default();
        cfg.mode = RerankMode::Llm;
        cfg.llm_max_candidates = 2;
        let counter = CountingReranker(std::sync::Mutex::new(0));
        let _ = rerank_results("机器学习", chinese_fixture(), &cfg, Some(&counter));
        assert_eq!(*counter.0.lock().unwrap(), 2);
    }

    #[test]
    fn snippets_are_char_truncated_for_the_prompt() {
        let long: String = "知识图谱".chars().cycle().take(5_000).collect();
        let window = vec![sr(1, Some("标题"), &long)];
        let cands = build_candidates(&window, 40);
        assert_eq!(cands[0].snippet.chars().count(), 40);
        assert_eq!(cands[0].index, 0);
    }

    #[test]
    fn llm_prompt_contains_query_and_indices() {
        let window = chinese_fixture();
        let cands = build_candidates(&window, 100);
        let prompt = build_llm_prompt("机器学习", &cands);
        assert!(prompt.contains("机器学习"));
        assert!(prompt.contains("[0]") && prompt.contains("[2]"));
        // No newlines inside a candidate line, so the model sees one item per line.
        assert!(!prompt.contains("\n\n[",));
    }

    #[test]
    fn llm_order_parsing_is_tolerant_but_bounded() {
        assert_eq!(parse_llm_order("3,1,2,0", 4), Some(vec![3, 1, 2, 0]));
        assert_eq!(parse_llm_order("Sure! Order: [2, 0, 1].", 3), Some(vec![2, 0, 1]));
        // Out-of-range and duplicates are dropped rather than trusted.
        assert_eq!(parse_llm_order("7, 7, 1", 3), Some(vec![1]));
        // Nothing parseable → None → caller uses Tier 1.
        assert_eq!(parse_llm_order("I cannot help with that.", 3), None);
        assert_eq!(parse_llm_order("", 3), None);
    }

    #[test]
    fn reranked_scores_stay_descending() {
        // Several call sites and the UI treat `score` as a sort key. If the rerank
        // reordered rows but left RRF scores behind, a re-sort would undo it.
        let out = rerank_results("机器学习", chinese_fixture(), &RerankConfig::lexical(), None);
        for w in out.windows(2) {
            assert!(w[0].score >= w[1].score, "{} < {}", w[0].score, w[1].score);
        }
    }

    #[test]
    fn mode_parsing_is_lenient() {
        assert_eq!(RerankMode::from_str_lenient("off"), RerankMode::Off);
        assert_eq!(RerankMode::from_str_lenient("cross-encoder"), RerankMode::CrossEncoder);
        assert_eq!(RerankMode::from_str_lenient("LLM"), RerankMode::Llm);
        // A stale/unknown settings value must not break search.
        assert_eq!(RerankMode::from_str_lenient("nonsense"), RerankMode::Lexical);
        assert_eq!(RerankMode::default(), RerankMode::Lexical);
    }

    #[test]
    fn top_k_is_clamped_against_bad_settings() {
        let mut cfg = RerankConfig::lexical();
        cfg.top_k = 0;
        assert_eq!(cfg.effective_top_k(), 2);
        cfg.top_k = 100_000;
        assert_eq!(cfg.effective_top_k(), 200);
    }

    // ── Persistence ─────────────────────────────────────────────────────────

    fn settings_db() -> rusqlite::Connection {
        crate::db::register_sqlite_vec();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::setup_database_schema(&conn).unwrap();
        // The live app follows setup with the column migrations (db/mod.rs:35).
        crate::db::schema::migrate_schema_columns(&conn).unwrap();
        conn
    }

    /// The shipped default must be Tier 1, not `Off`: a zero-download reranker
    /// that users have to discover in a settings pane is a reranker nobody uses.
    #[test]
    fn default_mode_is_lexical_not_off() {
        assert_eq!(RerankConfig::default().mode, RerankMode::Lexical);
        let _g = config_guard();
        assert_eq!(active_config().mode, RerankMode::Lexical);
    }

    /// A fresh vault has no `rerank_*` rows at all; that must read as the default
    /// rather than as "everything zero".
    #[test]
    fn load_config_on_empty_settings_is_the_default() {
        let conn = settings_db();
        let loaded = load_config(&conn);
        assert_eq!(loaded.mode, RerankMode::Lexical);
        assert_eq!(loaded.top_k, RERANK_TOP_K);
    }

    #[test]
    fn save_then_load_round_trips_every_field() {
        let conn = settings_db();
        let want = RerankConfig {
            mode: RerankMode::Llm,
            top_k: 48,
            llm_max_candidates: 20,
            llm_max_snippet_chars: 500,
            llm_timeout_ms: 12_000,
        };
        save_config(&conn, &want).unwrap();

        let got = load_config(&conn);
        assert_eq!(got.mode, RerankMode::Llm);
        assert_eq!(got.top_k, 48);
        assert_eq!(got.llm_max_candidates, 20);
        assert_eq!(got.llm_max_snippet_chars, 500);
        assert_eq!(got.llm_timeout_ms, 12_000);
    }

    /// "Survives a restart" is the actual requirement, and a restart means a new
    /// `Connection` over the same file plus a `restore_config` into fresh process
    /// state — not just a second read on the same handle.
    #[test]
    fn config_survives_a_restart() {
        let _g = config_guard();
        let dir = std::env::temp_dir().join(format!("zettel_rerank_cfg_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.db");
        let _ = std::fs::remove_file(&path);

        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            crate::db::schema::setup_database_schema(&conn).unwrap();
            crate::db::schema::migrate_schema_columns(&conn).unwrap();
            let cfg = RerankConfig { mode: RerankMode::Off, top_k: 64, ..Default::default() };
            save_config(&conn, &cfg).unwrap();
        }

        // Simulate the next launch: default process state, then restore from disk.
        store_config(RerankConfig::default());
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            restore_config(&conn);
        }
        let after = active_config();
        assert_eq!(after.mode, RerankMode::Off);
        assert_eq!(after.top_k, 64);

        let _ = std::fs::remove_file(&path);
    }

    /// A settings row written by another build must never be able to break search,
    /// so the restore path clamps instead of erroring.
    #[test]
    fn load_config_clamps_garbage_instead_of_failing() {
        let conn = settings_db();
        crate::db::schema::set_setting(&conn, RERANK_MODE_KEY, "wat").unwrap();
        crate::db::schema::set_setting(&conn, RERANK_TOP_K_KEY, "0").unwrap();
        crate::db::schema::set_setting(&conn, RERANK_LLM_TIMEOUT_MS_KEY, "999999999").unwrap();
        crate::db::schema::set_setting(&conn, RERANK_LLM_MAX_SNIPPET_CHARS_KEY, "not a number")
            .unwrap();

        let got = load_config(&conn);
        // Unknown mode → lenient fallback to the default tier.
        assert_eq!(got.mode, RerankMode::Lexical);
        assert_eq!(got.top_k, TOP_K_RANGE.0);
        assert_eq!(got.llm_timeout_ms, LLM_TIMEOUT_MS_RANGE.1);
        // Unparseable → treated as absent, so the default survives.
        assert_eq!(
            got.llm_max_snippet_chars,
            RerankConfig::default().llm_max_snippet_chars
        );
    }

    /// The command layer parses strictly so a UI typo surfaces as an error rather
    /// than as a silent reset. Note `from_str_lenient` accepts these same inputs.
    #[test]
    fn parse_mode_strict_rejects_what_lenient_accepts() {
        assert_eq!(parse_mode_strict("lexical"), Some(RerankMode::Lexical));
        assert_eq!(parse_mode_strict("crossEncoder"), Some(RerankMode::CrossEncoder));
        assert_eq!(parse_mode_strict("off"), Some(RerankMode::Off));
        assert_eq!(parse_mode_strict("llm"), Some(RerankMode::Llm));
        // Rejected here, accepted by the lenient parser used on the restore path.
        for bad in ["cross_encoder", "LEXICAL", "none", "", " off"] {
            assert!(parse_mode_strict(bad).is_none(), "{} should be rejected", bad);
            let _ = RerankMode::from_str_lenient(bad);
        }
    }

    /// Every mode string must survive a save → load round trip, or a user could
    /// pick a tier and silently get a different one after restarting.
    #[test]
    fn every_mode_round_trips_through_settings() {
        let conn = settings_db();
        for mode in [
            RerankMode::Off,
            RerankMode::Lexical,
            RerankMode::CrossEncoder,
            RerankMode::Llm,
        ] {
            save_config(&conn, &RerankConfig { mode, ..Default::default() }).unwrap();
            assert_eq!(load_config(&conn).mode, mode, "round trip for {:?}", mode);
        }
    }
}











