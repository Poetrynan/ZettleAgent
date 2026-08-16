//! Retrieval reranking: time-decay + Maximal Marginal Relevance (MMR).
//!
//! Two independent knobs applied after the base similarity search:
//!
//! - **Time decay** — multiply each candidate's relevance by an exponential
//!   decay on its age, so a stale note loses ground to a fresh one of equal
//!   textual similarity. Half-life is configurable (default 30 days).
//! - **MMR** — greedy diversification (Carbonell & Goldstein '98). Instead of
//!   returning five near-duplicate chunks, it trades a little relevance for
//!   coverage: `score = λ·rel − (1−λ)·max_sim_to_already_selected`. λ=0.7
//!   keeps relevance dominant while still breaking up redundancy.
//!
//! Both operate on a *relevance* value where higher = better, so callers must
//! convert cosine distance to similarity before handing results in.

use rusqlite::{params, Connection};

/// Default recency half-life. A note this many days old keeps half its weight.
pub const DEFAULT_HALF_LIFE_DAYS: f64 = 30.0;

/// Default MMR trade-off. 1.0 = pure relevance (no diversification);
/// 0.0 = pure diversity. 0.7 keeps relevance in charge.
pub const DEFAULT_MMR_LAMBDA: f64 = 0.7;

/// One rerankable candidate.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub chunk_id: i64,
    pub file_path: String,
    /// Higher = more relevant. Callers convert distance→similarity first.
    pub relevance: f64,
    /// Age in days since the note was last modified. `None` → treated as fresh.
    pub age_days: Option<f64>,
    /// Chunk embedding, used for MMR redundancy. `None` disables MMR for this item.
    pub embedding: Option<Vec<f32>>,
}

/// Exponential decay multiplier in (0, 1]. `age=0 → 1.0`, `age=half_life → 0.5`.
pub fn time_decay_factor(age_days: f64, half_life_days: f64) -> f64 {
    if half_life_days <= 0.0 || age_days <= 0.0 {
        return 1.0;
    }
    0.5_f64.powf(age_days / half_life_days)
}

/// Apply time decay in place: `relevance *= decay(age)`.
pub fn apply_time_decay(cands: &mut [Candidate], half_life_days: f64) {
    for c in cands.iter_mut() {
        if let Some(age) = c.age_days {
            c.relevance *= time_decay_factor(age, half_life_days);
        }
    }
}

/// Cosine similarity of two equal-length vectors. Returns 0 on degenerate input.
fn cosine(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f64;
    let mut na = 0.0f64;
    let mut nb = 0.0f64;
    for i in 0..a.len() {
        dot += a[i] as f64 * b[i] as f64;
        na += (a[i] as f64).powi(2);
        nb += (b[i] as f64).powi(2);
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

/// Greedy MMR selection. Returns indices into `cands` in selection order,
/// at most `top_k`. Candidates without an embedding still get selected on
/// pure relevance (they simply contribute no redundancy penalty).
pub fn mmr_select(cands: &[Candidate], lambda: f64, top_k: usize) -> Vec<usize> {
    let n = cands.len();
    let k = top_k.min(n);
    if k == 0 {
        return Vec::new();
    }
    let lambda = lambda.clamp(0.0, 1.0);

    let mut selected: Vec<usize> = Vec::with_capacity(k);
    let mut remaining: Vec<usize> = (0..n).collect();

    // First pick: highest relevance.
    remaining.sort_by(|&a, &b| {
        cands[b].relevance
            .partial_cmp(&cands[a].relevance)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    selected.push(remaining.remove(0));

    while selected.len() < k && !remaining.is_empty() {
        let mut best_pos = 0usize;
        let mut best_score = f64::NEG_INFINITY;

        for (pos, &cand_idx) in remaining.iter().enumerate() {
            // Redundancy = max similarity to anything already chosen.
            let mut max_sim = 0.0f64;
            if let Some(ref emb) = cands[cand_idx].embedding {
                for &sel_idx in &selected {
                    if let Some(ref sel_emb) = cands[sel_idx].embedding {
                        let sim = cosine(emb, sel_emb);
                        if sim > max_sim {
                            max_sim = sim;
                        }
                    }
                }
            }
            let mmr = lambda * cands[cand_idx].relevance - (1.0 - lambda) * max_sim;
            if mmr > best_score {
                best_score = mmr;
                best_pos = pos;
            }
        }
        selected.push(remaining.remove(best_pos));
    }

    selected
}

/// Parse a SQLite `datetime('now')` string ("YYYY-MM-DD HH:MM:SS", UTC) into
/// age-in-days relative to `now`. Returns `None` on unparseable input.
fn age_days_from_sqlite(ts: &str, now: chrono::DateTime<chrono::Utc>) -> Option<f64> {
    let naive = chrono::NaiveDateTime::parse_from_str(ts.trim(), "%Y-%m-%d %H:%M:%S")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(ts.trim(), "%Y-%m-%dT%H:%M:%S"))
        .ok()?;
    let then = naive.and_utc();
    let delta = now.signed_duration_since(then);
    let days = delta.num_seconds() as f64 / 86_400.0;
    Some(days.max(0.0))
}

/// Load `age_days` (from `files.last_synced`) and chunk embeddings for a set
/// of candidates. Missing rows leave the corresponding fields as `None`, so a
/// partial DB never poisons the whole rerank.
pub fn hydrate_candidates(conn: &Connection, cands: &mut [Candidate]) {
    let now = chrono::Utc::now();
    for c in cands.iter_mut() {
        // Recency proxy: when the note was last synced (i.e. last content change).
        if let Ok(ts) = conn.query_row(
            "SELECT last_synced FROM files WHERE path = ?1",
            params![c.file_path],
            |row| row.get::<_, String>(0),
        ) {
            c.age_days = age_days_from_sqlite(&ts, now);
        }
        // Embedding for MMR redundancy.
        if let Ok(blob) = conn.query_row(
            "SELECT embedding FROM chunks_vec WHERE id = ?1",
            params![c.chunk_id],
            |row| row.get::<_, Vec<u8>>(0),
        ) {
            c.embedding = crate::db::embedding_cache::blob_to_vec(&blob);
        }
    }
}

/// Build candidates from an already-sorted (best-first) result list, deriving
/// relevance from *rank position* rather than the raw score.
///
/// This matters because `score` is not comparable across search modes: FTS5
/// `rank` is a negative number where lower is better, `vector_search` returns
/// cosine distance (lower is better), and `hybrid_search` returns a fused RRF
/// score (higher is better). Position is the one signal every mode agrees on,
/// so reranking on `1/(1+i)` is correct regardless of which branch produced
/// the list.
pub fn from_ranked<'a, I>(items: I) -> Vec<Candidate>
where
    I: IntoIterator<Item = (i64, &'a str)>,
{
    items
        .into_iter()
        .enumerate()
        .map(|(i, (chunk_id, file_path))| Candidate {
            chunk_id,
            file_path: file_path.to_string(),
            relevance: 1.0 / (1.0 + i as f64),
            age_days: None,
            embedding: None,
        })
        .collect()
}

/// Full rerank pipeline: hydrate → time decay → MMR. Returns candidates in
/// final display order. `half_life_days`/`lambda` fall back to the module
/// defaults when `None`.
pub fn rerank(
    conn: &Connection,
    mut cands: Vec<Candidate>,
    top_k: usize,
    half_life_days: Option<f64>,
    lambda: Option<f64>,
) -> Vec<Candidate> {
    if cands.len() <= 1 {
        return cands;
    }
    hydrate_candidates(conn, &mut cands);
    apply_time_decay(&mut cands, half_life_days.unwrap_or(DEFAULT_HALF_LIFE_DAYS));
    let order = mmr_select(&cands, lambda.unwrap_or(DEFAULT_MMR_LAMBDA), top_k);
    order.into_iter().map(|i| cands[i].clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decay_halves_at_half_life() {
        assert!((time_decay_factor(0.0, 30.0) - 1.0).abs() < 1e-9);
        assert!((time_decay_factor(30.0, 30.0) - 0.5).abs() < 1e-9);
        assert!((time_decay_factor(60.0, 30.0) - 0.25).abs() < 1e-9);
    }

    #[test]
    fn decay_disabled_when_no_half_life() {
        assert_eq!(time_decay_factor(100.0, 0.0), 1.0);
    }

    #[test]
    fn fresh_note_outranks_stale_when_similar() {
        let mut cands = vec![
            Candidate { chunk_id: 1, file_path: "old.md".into(), relevance: 0.90, age_days: Some(120.0), embedding: None },
            Candidate { chunk_id: 2, file_path: "new.md".into(), relevance: 0.85, age_days: Some(1.0), embedding: None },
        ];
        apply_time_decay(&mut cands, 30.0);
        // old: 0.90 * 0.5^4 = 0.05625 ; new: ~0.85 * ~0.977 ≈ 0.83
        assert!(cands[1].relevance > cands[0].relevance);
    }

    #[test]
    fn mmr_breaks_up_near_duplicates() {
        // Two near-identical vectors + one distinct. With λ=0.7 the distinct
        // one should be picked 2nd over the redundant near-duplicate, even
        // though the near-duplicate has marginally higher base relevance.
        let dup_a = vec![1.0f32, 0.0, 0.0];
        let dup_b = vec![0.99f32, 0.01, 0.0];
        let distinct = vec![0.0f32, 1.0, 0.0];
        let cands = vec![
            Candidate { chunk_id: 1, file_path: "a".into(), relevance: 1.00, age_days: None, embedding: Some(dup_a) },
            Candidate { chunk_id: 2, file_path: "b".into(), relevance: 0.98, age_days: None, embedding: Some(dup_b) },
            Candidate { chunk_id: 3, file_path: "c".into(), relevance: 0.90, age_days: None, embedding: Some(distinct) },
        ];
        let order = mmr_select(&cands, 0.7, 3);
        assert_eq!(order[0], 0); // highest relevance first
        assert_eq!(order[1], 2); // distinct beats the near-duplicate
    }

    #[test]
    fn mmr_respects_top_k() {
        let cands: Vec<Candidate> = (0..5)
            .map(|i| Candidate {
                chunk_id: i,
                file_path: format!("f{}", i),
                relevance: 1.0 - i as f64 * 0.1,
                age_days: None,
                embedding: None,
            })
            .collect();
        assert_eq!(mmr_select(&cands, 0.7, 3).len(), 3);
        assert_eq!(mmr_select(&cands, 0.7, 99).len(), 5);
    }

    #[test]
    fn age_parsing_handles_both_formats() {
        let now = chrono::Utc::now();
        assert!(age_days_from_sqlite("2020-01-01 00:00:00", now).unwrap() > 1000.0);
        assert!(age_days_from_sqlite("2020-01-01T00:00:00", now).unwrap() > 1000.0);
        assert!(age_days_from_sqlite("garbage", now).is_none());
    }
}
