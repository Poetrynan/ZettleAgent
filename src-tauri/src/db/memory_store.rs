//! Archival memory — the unbounded, on-demand-recalled memory layer.
//!
//! Two-layer memory, following the split that Letta/MemGPT and Mem0 converged on:
//!
//! - **Core memory** (`<vault>/.zettelagent/memory.md`) — small, always in the
//!   prompt, LLM-curated. Bounded on purpose: it costs tokens every turn.
//! - **Archival memory** (this module, backed by `ai_memory`) — unbounded, out
//!   of context by default, pulled in only when relevant to the current query.
//!
//! The `ai_memory` table already had `category`, `weight`, and `expires_at`
//! columns, but nothing populated them and nothing read the contents back —
//! only a row count reached the prompt. This module makes the layer real:
//! writes carry a category and weight, expiry is honored, and `recall` scores
//! candidates so a 200-row store can contribute the 3 rows that matter.
//!
//! Scoring is deliberately lexical rather than embedding-based. Embeddings in
//! this app are computed in the frontend (transformers.js); a background Rust
//! task cannot synchronously obtain one. Keyword overlap × weight × recency is
//! a weaker signal than cosine similarity but needs no round-trip, and for
//! short single-line facts it holds up well.

use rusqlite::{params, Connection};

/// One archival memory row.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ArchivalMemory {
    pub id: i64,
    pub content: String,
    pub category: String,
    pub weight: f64,
    pub created_at: String,
    /// Composite recall score. Only meaningful on `recall` results.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
}

/// Half-life for recency decay on recall, in days. Longer than the retrieval
/// half-life used for notes (30d): a stated preference stays true much longer
/// than a note stays topical.
pub const MEMORY_HALF_LIFE_DAYS: f64 = 90.0;

/// Cap on how many archival memories may enter one prompt. The whole point of
/// the layer is that it does *not* grow the per-turn token cost.
pub const RECALL_LIMIT: usize = 5;

/// Below this composite score a candidate is noise, not recall.
const SCORE_FLOOR: f64 = 0.08;

/// Normalize for dedup comparison: lowercase, collapse whitespace, drop
/// trailing punctuation. Two facts that differ only in phrasing whitespace are
/// the same fact.
fn normalize(s: &str) -> String {
    s.to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_end_matches(['.', '。', '!', '！', ';', '；'])
        .to_string()
}

/// Split into lowercase content tokens for overlap scoring.
///
/// CJK has no spaces, so whitespace tokenization yields one giant token and
/// scores every Chinese fact at zero. Han characters are therefore emitted
/// individually, which approximates unigram matching.
fn tokenize(s: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut buf = String::new();
    for ch in s.chars() {
        let is_han = matches!(ch as u32, 0x4E00..=0x9FFF | 0x3400..=0x4DBF);
        if is_han {
            if !buf.is_empty() {
                out.push(std::mem::take(&mut buf));
            }
            out.push(ch.to_lowercase().collect());
        } else if ch.is_alphanumeric() {
            buf.extend(ch.to_lowercase());
        } else if !buf.is_empty() {
            out.push(std::mem::take(&mut buf));
        }
    }
    if !buf.is_empty() {
        out.push(buf);
    }
    // Single Latin letters carry no signal; single Han characters do.
    out.retain(|t| t.chars().count() > 1 || t.chars().next().is_some_and(|c| !c.is_ascii()));
    out
}

/// Fraction of the query's tokens present in `text`, in `[0, 1]`.
fn lexical_overlap(query_tokens: &[String], text: &str) -> f64 {
    if query_tokens.is_empty() {
        return 0.0;
    }
    let text_tokens = tokenize(text);
    if text_tokens.is_empty() {
        return 0.0;
    }
    let hits = query_tokens
        .iter()
        .filter(|qt| text_tokens.iter().any(|tt| tt == *qt))
        .count();
    hits as f64 / query_tokens.len() as f64
}

/// Age in days of an SQLite `datetime('now')` timestamp.
fn age_days(created_at: &str) -> f64 {
    let parsed = chrono::NaiveDateTime::parse_from_str(created_at, "%Y-%m-%d %H:%M:%S")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(created_at, "%Y-%m-%dT%H:%M:%S"));
    match parsed {
        Ok(dt) => {
            let now = chrono::Utc::now().naive_utc();
            (now - dt).num_seconds().max(0) as f64 / 86_400.0
        }
        Err(_) => 0.0,
    }
}

/// Insert a fact, skipping exact duplicates.
///
/// Returns `true` when a row was actually written. `weight` is clamped to
/// `[0.1, 2.0]` so one over-eager extraction can't permanently dominate
/// recall, and `ttl_days` sets `expires_at` for facts that are true only for
/// now ("currently reading X") rather than durably ("prefers Chinese").
pub fn upsert_fact(
    conn: &Connection,
    content: &str,
    category: &str,
    weight: f64,
    ttl_days: Option<u32>,
    source_session_id: Option<&str>,
) -> rusqlite::Result<bool> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }
    let norm = normalize(trimmed);

    // Dedup in Rust rather than a UNIQUE index: normalization has to match
    // `normalize` exactly, and SQLite can't express it.
    let mut stmt = conn.prepare("SELECT content FROM ai_memory")?;
    let existing: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();
    if existing.iter().any(|e| normalize(e) == norm) {
        return Ok(false);
    }

    let w = weight.clamp(0.1, 2.0);
    let expires = ttl_days.map(|d| {
        (chrono::Utc::now() + chrono::Duration::days(d as i64))
            .format("%Y-%m-%d %H:%M:%S")
            .to_string()
    });

    conn.execute(
        "INSERT INTO ai_memory (content, category, weight, source_session_id, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![trimmed, category, w, source_session_id, expires],
    )?;
    Ok(true)
}

/// Delete rows whose content contains `needle` (case-insensitive).
///
/// Backs the extractor's `replaces` field: when a new fact supersedes an old
/// one, the old row must go, or recall will surface both sides of a
/// contradiction. Returns the number of rows removed.
pub fn delete_matching(conn: &Connection, needle: &str) -> rusqlite::Result<usize> {
    let n = needle.trim();
    if n.len() < 4 {
        // Too short to match safely — would delete unrelated memories.
        return Ok(0);
    }
    let mut stmt = conn.prepare("SELECT id, content FROM ai_memory")?;
    let rows: Vec<(i64, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .filter_map(|r| r.ok())
        .collect();
    let needle_lower = n.to_lowercase();
    let mut removed = 0;
    for (id, content) in rows {
        if content.to_lowercase().contains(&needle_lower) {
            conn.execute("DELETE FROM ai_memory WHERE id = ?1", params![id])?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// Drop memories whose TTL has passed. Cheap enough to run per turn.
pub fn prune_expired(conn: &Connection) -> rusqlite::Result<usize> {
    let n = conn.execute(
        "DELETE FROM ai_memory WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')",
        [],
    )?;
    Ok(n)
}

/// Retrieve the memories worth spending prompt tokens on for `query`.
///
/// Composite score = lexical overlap × weight × recency decay. Candidates
/// below `SCORE_FLOOR` are dropped rather than padded out to `limit` — an
/// irrelevant memory in the prompt is worse than no memory, because the model
/// will try to use it.
pub fn recall(conn: &Connection, query: &str, limit: usize) -> rusqlite::Result<Vec<ArchivalMemory>> {
    let query_tokens = tokenize(query);
    if query_tokens.is_empty() {
        return Ok(Vec::new());
    }

    let mut stmt = conn.prepare(
        "SELECT id, content, category, weight, created_at
         FROM ai_memory
         WHERE expires_at IS NULL OR expires_at > datetime('now')",
    )?;
    let mut scored: Vec<ArchivalMemory> = stmt
        .query_map([], |row| {
            Ok(ArchivalMemory {
                id: row.get(0)?,
                content: row.get(1)?,
                category: row.get(2)?,
                weight: row.get(3)?,
                created_at: row.get(4)?,
                score: None,
            })
        })?
        .filter_map(|r| r.ok())
        .map(|mut m| {
            let overlap = lexical_overlap(&query_tokens, &m.content);
            let decay = crate::db::rerank::time_decay_factor(
                age_days(&m.created_at),
                MEMORY_HALF_LIFE_DAYS,
            );
            m.score = Some(overlap * m.weight * decay);
            m
        })
        .filter(|m| m.score.unwrap_or(0.0) >= SCORE_FLOOR)
        .collect();

    scored.sort_by(|a, b| {
        b.score
            .unwrap_or(0.0)
            .partial_cmp(&a.score.unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    scored.truncate(limit);
    Ok(scored)
}

/// Count of live (non-expired) archival memories.
pub fn live_count(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM ai_memory
         WHERE expires_at IS NULL OR expires_at > datetime('now')",
        [],
        |row| row.get(0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE ai_memory (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT NOT NULL,
                category TEXT DEFAULT 'general',
                weight REAL DEFAULT 1.0,
                source_session_id TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                expires_at TEXT
            );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn upsert_dedups_on_normalized_content() {
        let conn = test_db();
        assert!(upsert_fact(&conn, "Prefers Chinese responses", "preferences", 1.0, None, None).unwrap());
        // Same fact, different spacing and trailing period → not a new row.
        assert!(!upsert_fact(&conn, "prefers   chinese responses.", "preferences", 1.0, None, None).unwrap());
        assert_eq!(live_count(&conn).unwrap(), 1);
    }

    #[test]
    fn weight_is_clamped() {
        let conn = test_db();
        upsert_fact(&conn, "extreme weight fact", "decisions", 99.0, None, None).unwrap();
        let w: f64 = conn
            .query_row("SELECT weight FROM ai_memory", [], |r| r.get(0))
            .unwrap();
        assert!(w <= 2.0, "weight should be clamped, got {w}");
    }

    #[test]
    fn recall_ranks_by_overlap_and_ignores_noise() {
        let conn = test_db();
        upsert_fact(&conn, "User prefers Zettelkasten methodology", "preferences", 1.5, None, None).unwrap();
        upsert_fact(&conn, "Vault uses folders named by year", "vault", 1.0, None, None).unwrap();

        let hits = recall(&conn, "what methodology does the user prefer", 5).unwrap();
        assert!(!hits.is_empty(), "expected a methodology hit");
        assert!(hits[0].content.contains("Zettelkasten"));

        // A query sharing no vocabulary must not drag in unrelated memories.
        let none = recall(&conn, "quantum chromodynamics lagrangian", 5).unwrap();
        assert!(none.is_empty(), "unrelated query should recall nothing, got {none:?}");
    }

    #[test]
    fn recall_handles_chinese_without_spaces() {
        let conn = test_db();
        upsert_fact(&conn, "用户偏好用中文回复", "preferences", 1.0, None, None).unwrap();
        let hits = recall(&conn, "我应该用什么语言回复用户", 5).unwrap();
        assert!(!hits.is_empty(), "CJK unigram matching should find the fact");
    }

    #[test]
    fn delete_matching_honors_replaces_and_guards_short_needles() {
        let conn = test_db();
        upsert_fact(&conn, "User prefers English responses", "preferences", 1.0, None, None).unwrap();
        upsert_fact(&conn, "Vault root is D:/notes", "vault", 1.0, None, None).unwrap();

        assert_eq!(delete_matching(&conn, "prefers English").unwrap(), 1);
        assert_eq!(live_count(&conn).unwrap(), 1);

        // A 1-2 char needle would nuke everything; it must be refused.
        assert_eq!(delete_matching(&conn, "a").unwrap(), 0);
        assert_eq!(live_count(&conn).unwrap(), 1);
    }

    #[test]
    fn expired_memories_are_pruned_and_excluded() {
        let conn = test_db();
        conn.execute(
            "INSERT INTO ai_memory (content, category, weight, expires_at)
             VALUES ('temporary reading topic', 'research', 1.0, datetime('now','-1 day'))",
            [],
        )
        .unwrap();
        // Excluded from recall/count even before pruning runs.
        assert_eq!(live_count(&conn).unwrap(), 0);
        assert_eq!(prune_expired(&conn).unwrap(), 1);
    }

    #[test]
    fn ttl_sets_a_future_expiry() {
        let conn = test_db();
        upsert_fact(&conn, "currently reading a paper on rerankers", "research", 1.0, Some(30), None).unwrap();
        let expires: Option<String> = conn
            .query_row("SELECT expires_at FROM ai_memory", [], |r| r.get(0))
            .unwrap();
        assert!(expires.is_some(), "ttl_days should populate expires_at");
        assert_eq!(live_count(&conn).unwrap(), 1);
    }
}
