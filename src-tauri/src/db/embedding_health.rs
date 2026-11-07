//! Which chunks the embedding build should (not) send to the model.
//!
//! ## The problem
//! The build loop asked for "chunks without a vector", embedded them in batches
//! and aborted the whole build on the first error. Pending chunks always come
//! back in the same order, so one chunk an API rejects (too long for its token
//! limit, a content filter, a malformed character) failed every later build at
//! the same spot: the index could never complete, and a flaky endpoint was
//! hammered again on every retry.
//!
//! ## What this module adds
//! - **Failures are remembered** per chunk *text* (`content_hash`, the same key
//!   as the embedding cache), so they survive the delete+insert a resync does
//!   and reset by themselves when the text is edited. Each failure pushes the
//!   next attempt out (30 s, doubling, at most 30 min); after
//!   [`MAX_FAILURES`] in a row the chunk is skipped until the user asks for a
//!   retry. A model change clears them (`embedding_cache::sync_model_key`).
//! - **Ignored chunks** are never embedded and not counted as missing:
//!   - files matched by a `.zettelignore` (gitignore syntax) in their folder or
//!     any parent folder, layered like `.gitignore` (deeper files decide
//!     first and can re-include with `!`). Typical use:
//!     keep private notes out of a cloud embedding API. Vectors such files
//!     already have are removed;
//!   - chunks with no letters, digits or CJK at all (separators, stray markup),
//!     which carry nothing to embed.
//!   Ignore rules are re-evaluated at the start of every build
//!   ([`apply_ignore_rules`]), so editing `.zettelignore` takes effect next time.
//! - [`pending_chunks`] applies all of this and also fills chunks from the
//!   embedding cache as it goes, so a cache hit is never re-embedded and an
//!   ignored chunk is never refilled from the cache.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::{params, Connection, OptionalExtension};

use crate::db::embedding_cache::content_hash;

pub const BACKOFF_BASE_MS: i64 = 30_000;
pub const BACKOFF_MAX_MS: i64 = 30 * 60_000;
/// Consecutive failures after which a chunk is skipped until a manual retry.
pub const MAX_FAILURES: i64 = 8;
pub const IGNORE_FILE: &str = ".zettelignore";

pub const REASON_IGNORE_FILE: &str = "zettelignore";
pub const REASON_NO_TEXT: &str = "no_text";

/// Tables this module owns. Called from `setup_database_schema`.
pub fn setup(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS embedding_failures (
            content_hash TEXT PRIMARY KEY,
            fail_count INTEGER NOT NULL,
            last_error TEXT NOT NULL,
            next_retry_ms INTEGER NOT NULL,
            permanent INTEGER NOT NULL DEFAULT 0,
            updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS embedding_ignored (
            chunk_id INTEGER PRIMARY KEY,
            reason TEXT NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS embedding_ignored_ad AFTER DELETE ON chunks BEGIN
            DELETE FROM embedding_ignored WHERE chunk_id = old.id;
        END;",
    )
}

/// Delay before the next attempt after `fail_count` failures in a row.
pub fn backoff_ms(fail_count: i64) -> i64 {
    let shift = (fail_count.max(1) - 1).min(20) as u32;
    (BACKOFF_BASE_MS << shift).min(BACKOFF_MAX_MS)
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Is there anything to embed? Letters, digits or CJK, in any script.
pub fn has_text(content: &str) -> bool {
    content.chars().any(|c| c.is_alphanumeric())
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailureOutcome {
    pub chunk_id: i64,
    pub fail_count: i64,
    /// True when the chunk will not be tried again without a manual retry.
    pub permanent: bool,
}

/// Record that embedding these chunks failed with `error`.
pub fn record_failures(conn: &Connection, chunk_ids: &[i64], error: &str, now: i64) -> rusqlite::Result<Vec<FailureOutcome>> {
    // Keep the stored message bounded: some providers return whole HTML pages.
    let error: String = error.chars().take(500).collect();
    let mut out = Vec::new();
    for &id in chunk_ids {
        let Some(content): Option<String> =
            conn.query_row("SELECT content FROM chunks WHERE id = ?1", params![id], |r| r.get(0)).optional()?
        else {
            continue;
        };
        let hash = content_hash(&content);
        let previous: i64 = conn
            .query_row("SELECT fail_count FROM embedding_failures WHERE content_hash = ?1", params![hash], |r| r.get(0))
            .optional()?
            .unwrap_or(0);
        let count = previous + 1;
        let permanent = count >= MAX_FAILURES;
        conn.execute(
            "INSERT INTO embedding_failures (content_hash, fail_count, last_error, next_retry_ms, permanent, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(content_hash) DO UPDATE SET
               fail_count = excluded.fail_count, last_error = excluded.last_error,
               next_retry_ms = excluded.next_retry_ms, permanent = excluded.permanent,
               updated_at_ms = excluded.updated_at_ms",
            params![hash, count, error, now + backoff_ms(count), permanent as i64, now],
        )?;
        out.push(FailureOutcome { chunk_id: id, fail_count: count, permanent });
    }
    Ok(out)
}

/// Forget failures for texts that have now been embedded.
pub fn clear_failures_for_texts<'a>(conn: &Connection, texts: impl IntoIterator<Item = &'a str>) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare("DELETE FROM embedding_failures WHERE content_hash = ?1")?;
    for t in texts {
        stmt.execute(params![content_hash(t)])?;
    }
    Ok(())
}

/// Manual "retry failed chunks": every remembered failure is dropped.
pub fn clear_all_failures(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM embedding_failures", [])
}

/// The next `limit` chunks to embed, oldest first.
///
/// Walks unembedded, non-ignored chunks by id and, for each: fills it from the
/// embedding cache if the text was embedded before; marks it ignored if it has
/// no text; skips it while its failure backoff runs (or for good once
/// permanent); otherwise returns it.
pub fn pending_chunks(conn: &Connection, limit: usize, now: i64) -> rusqlite::Result<Vec<(i64, String)>> {
    const PAGE: i64 = 256;
    let mut out = Vec::new();
    let mut cursor = 0i64;
    while out.len() < limit {
        let page: Vec<(i64, String)> = {
            let mut stmt = conn.prepare(
                "SELECT c.id, c.content FROM chunks c
                 WHERE c.embedding IS NULL AND c.id > ?1
                   AND NOT EXISTS (SELECT 1 FROM embedding_ignored i WHERE i.chunk_id = c.id)
                 ORDER BY c.id LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![cursor, PAGE], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<Result<_, _>>()?
        };
        let Some(&(last, _)) = page.last() else { break };
        cursor = last;

        for (id, content) in page {
            if out.len() >= limit {
                break;
            }
            if !has_text(&content) {
                conn.execute(
                    "INSERT OR REPLACE INTO embedding_ignored (chunk_id, reason) VALUES (?1, ?2)",
                    params![id, REASON_NO_TEXT],
                )?;
                continue;
            }
            if let Some(blob) = crate::db::embedding_cache::get_blob(conn, &content) {
                conn.execute("UPDATE chunks SET embedding = ?1 WHERE id = ?2", params![blob, id])?;
                conn.execute("INSERT OR REPLACE INTO chunks_vec (id, embedding) VALUES (?1, ?2)", params![id, blob])?;
                continue;
            }
            let blocked: bool = conn
                .query_row(
                    "SELECT permanent = 1 OR next_retry_ms > ?2 FROM embedding_failures WHERE content_hash = ?1",
                    params![content_hash(&content), now],
                    |r| r.get(0),
                )
                .optional()?
                .unwrap_or(false);
            if !blocked {
                out.push((id, content));
            }
        }
    }
    Ok(out)
}

// ── .zettelignore ─────────────────────────────────────────────────────────

/// `.zettelignore` files layered like `.gitignore`: every ancestor folder may
/// have one; the deepest file with a matching rule decides (so a nested file
/// can re-include with `!` what an outer one excludes), and a path no file
/// matches is not ignored. Each folder's file is parsed once per evaluation.
struct IgnoreRules {
    by_dir: HashMap<PathBuf, Option<Arc<ignore::gitignore::Gitignore>>>,
}

impl IgnoreRules {
    fn new() -> Self {
        Self { by_dir: HashMap::new() }
    }

    /// The rules of `dir`'s own `.zettelignore`, if it has one.
    fn own_rules(&mut self, dir: &Path) -> Option<Arc<ignore::gitignore::Gitignore>> {
        if let Some(hit) = self.by_dir.get(dir) {
            return hit.clone();
        }
        let file = dir.join(IGNORE_FILE);
        let found = if file.is_file() {
            let mut b = ignore::gitignore::GitignoreBuilder::new(dir);
            if let Some(e) = b.add(&file) {
                log::warn!("{}: {}", file.display(), e);
            }
            match b.build() {
                Ok(g) => Some(Arc::new(g)),
                Err(e) => {
                    log::warn!("{}: {}", file.display(), e);
                    None
                }
            }
        } else {
            None
        };
        self.by_dir.insert(dir.to_path_buf(), found.clone());
        found
    }

    fn is_ignored(&mut self, file: &Path) -> bool {
        let mut dir = file.parent();
        while let Some(d) = dir {
            if let Some(g) = self.own_rules(d) {
                let m = g.matched_path_or_any_parents(file, false);
                if m.is_ignore() {
                    return true;
                }
                if m.is_whitelist() {
                    return false;
                }
            }
            dir = d.parent();
        }
        false
    }
}

#[derive(Debug, Default, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoreSummary {
    /// Notes matched by a `.zettelignore`.
    pub ignored_files: usize,
    /// Their chunks, now excluded from embedding.
    pub ignored_chunks: usize,
    /// Vectors removed because their note became ignored.
    pub removed_vectors: usize,
}

/// Re-evaluate `.zettelignore` for every note. Notes no longer matched become
/// embeddable again; newly matched ones lose their vectors.
pub fn apply_ignore_rules(conn: &Connection) -> rusqlite::Result<IgnoreSummary> {
    let paths: Vec<String> = {
        let mut stmt = conn.prepare("SELECT path FROM files")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    let mut rules = IgnoreRules::new();
    let ignored: Vec<String> = paths.into_iter().filter(|p| rules.is_ignored(Path::new(p))).collect();

    let mut summary = IgnoreSummary { ignored_files: ignored.len(), ..Default::default() };
    conn.execute_batch("SAVEPOINT apply_ignore_rules")?;
    let result = (|| -> rusqlite::Result<()> {
        conn.execute("DELETE FROM embedding_ignored WHERE reason = ?1", params![REASON_IGNORE_FILE])?;
        for path in &ignored {
            summary.ignored_chunks += conn.execute(
                "INSERT OR REPLACE INTO embedding_ignored (chunk_id, reason)
                 SELECT id, ?2 FROM chunks WHERE file_path = ?1",
                params![path, REASON_IGNORE_FILE],
            )?;
            conn.execute(
                "DELETE FROM chunks_vec WHERE id IN (SELECT id FROM chunks WHERE file_path = ?1 AND embedding IS NOT NULL)",
                params![path],
            )?;
            summary.removed_vectors +=
                conn.execute("UPDATE chunks SET embedding = NULL WHERE file_path = ?1 AND embedding IS NOT NULL", params![path])?;
            conn.execute("DELETE FROM files_vec WHERE file_path = ?1", params![path])?;
            conn.execute("DELETE FROM semantic_edges WHERE source_path = ?1 OR target_path = ?1", params![path])?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => conn.execute_batch("RELEASE apply_ignore_rules")?,
        Err(e) => {
            conn.execute_batch("ROLLBACK TO apply_ignore_rules; RELEASE apply_ignore_rules")?;
            return Err(e);
        }
    }
    if summary.removed_vectors > 0 {
        crate::db::search::invalidate_graph_cache(conn);
        log::info!(
            "{}: removed {} vectors from {} newly ignored notes",
            IGNORE_FILE,
            summary.removed_vectors,
            summary.ignored_files
        );
    }
    Ok(summary)
}

#[derive(Debug, Default, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthCounts {
    pub ignored_chunks: usize,
    /// Texts waiting out a backoff.
    pub retrying: usize,
    /// Texts skipped until a manual retry.
    pub failed: usize,
    /// Most recent failure message, if any.
    pub last_error: Option<String>,
}

pub fn counts(conn: &Connection) -> rusqlite::Result<HealthCounts> {
    Ok(HealthCounts {
        ignored_chunks: conn.query_row("SELECT COUNT(*) FROM embedding_ignored", [], |r| r.get(0))?,
        retrying: conn.query_row("SELECT COUNT(*) FROM embedding_failures WHERE permanent = 0", [], |r| r.get(0))?,
        failed: conn.query_row("SELECT COUNT(*) FROM embedding_failures WHERE permanent = 1", [], |r| r.get(0))?,
        last_error: conn
            .query_row("SELECT last_error FROM embedding_failures ORDER BY updated_at_ms DESC LIMIT 1", [], |r| r.get(0))
            .optional()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::embedding_cache::EMBEDDING_DIM;

    fn db() -> Connection {
        crate::db::register_sqlite_vec();
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::setup_database_schema(&conn).unwrap();
        conn
    }

    fn chunk(conn: &Connection, path: &str, idx: i64, content: &str) -> i64 {
        conn.execute("INSERT OR IGNORE INTO files (path, hash) VALUES (?1, 'h')", params![path]).unwrap();
        conn.execute(
            "INSERT INTO chunks (file_path, chunk_index, content) VALUES (?1, ?2, ?3)",
            params![path, idx, content],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn ids(v: &[(i64, String)]) -> Vec<i64> {
        v.iter().map(|(id, _)| *id).collect()
    }

    #[test]
    fn backoff_doubles_and_caps() {
        assert_eq!(backoff_ms(1), 30_000);
        assert_eq!(backoff_ms(2), 60_000);
        assert_eq!(backoff_ms(4), 240_000);
        assert_eq!(backoff_ms(7), BACKOFF_MAX_MS);
        assert_eq!(backoff_ms(100), BACKOFF_MAX_MS);
    }

    #[test]
    fn a_failing_chunk_no_longer_blocks_the_rest() {
        let conn = db();
        let bad = chunk(&conn, "a.md", 0, "这一段会被接口拒绝");
        let good = chunk(&conn, "a.md", 1, "这一段正常");
        let t0 = 1_000_000;
        assert_eq!(ids(&pending_chunks(&conn, 10, t0).unwrap()), vec![bad, good]);

        let out = record_failures(&conn, &[bad], "400 input too long", t0).unwrap();
        assert_eq!(out, vec![FailureOutcome { chunk_id: bad, fail_count: 1, permanent: false }]);
        // During the backoff only the good chunk is pending…
        assert_eq!(ids(&pending_chunks(&conn, 10, t0 + 1).unwrap()), vec![good]);
        // …and after it the bad one is tried again.
        assert_eq!(ids(&pending_chunks(&conn, 10, t0 + backoff_ms(1) + 1).unwrap()), vec![bad, good]);
    }

    #[test]
    fn permanent_after_max_failures_until_manual_retry() {
        let conn = db();
        let bad = chunk(&conn, "a.md", 0, "坏段落");
        let mut t = 0;
        for n in 1..=MAX_FAILURES {
            let o = record_failures(&conn, &[bad], "boom", t).unwrap();
            assert_eq!(o[0].permanent, n == MAX_FAILURES);
            t += BACKOFF_MAX_MS + 1;
        }
        assert!(pending_chunks(&conn, 10, t + 10 * BACKOFF_MAX_MS).unwrap().is_empty());
        assert_eq!(counts(&conn).unwrap().failed, 1);

        assert_eq!(clear_all_failures(&conn).unwrap(), 1);
        assert_eq!(ids(&pending_chunks(&conn, 10, t).unwrap()), vec![bad]);
    }

    #[test]
    fn failure_follows_the_text_across_resync_and_resets_on_edit() {
        let conn = db();
        let bad = chunk(&conn, "a.md", 0, "同一段文字");
        record_failures(&conn, &[bad], "boom", 0).unwrap();
        // A resync deletes and re-inserts the chunk: new id, same text, still backing off.
        conn.execute("DELETE FROM chunks", []).unwrap();
        chunk(&conn, "a.md", 0, "同一段文字");
        assert!(pending_chunks(&conn, 10, 1).unwrap().is_empty());
        // Edited text is a new chunk as far as failures go.
        conn.execute("UPDATE chunks SET content = '改过的文字'", []).unwrap();
        assert_eq!(pending_chunks(&conn, 10, 1).unwrap().len(), 1);
    }

    #[test]
    fn textless_chunks_are_ignored_and_cache_hits_are_filled() {
        let conn = db();
        let sep = chunk(&conn, "a.md", 0, "---\n* * *\n");
        let cached = chunk(&conn, "a.md", 1, "缓存里有它");
        let blob: Vec<u8> = vec![0.25f32; EMBEDDING_DIM].iter().flat_map(|f| f.to_le_bytes()).collect();
        conn.execute(
            "INSERT INTO embedding_cache (content_hash, embedding, dim, last_used_at) VALUES (?1, ?2, ?3, datetime('now'))",
            params![content_hash("缓存里有它"), blob, EMBEDDING_DIM as i64],
        )
        .unwrap();
        assert!(pending_chunks(&conn, 10, 0).unwrap().is_empty());
        let reason: String =
            conn.query_row("SELECT reason FROM embedding_ignored WHERE chunk_id = ?1", params![sep], |r| r.get(0)).unwrap();
        assert_eq!(reason, REASON_NO_TEXT);
        let filled: bool =
            conn.query_row("SELECT embedding IS NOT NULL FROM chunks WHERE id = ?1", params![cached], |r| r.get(0)).unwrap();
        assert!(filled);
    }

    #[test]
    fn pending_walks_past_a_page_of_blocked_chunks() {
        let conn = db();
        let mut blocked = Vec::new();
        for i in 0..300 {
            blocked.push(chunk(&conn, "a.md", i, &format!("坏段落{i}")));
        }
        let good = chunk(&conn, "a.md", 300, "最后一段是好的");
        record_failures(&conn, &blocked, "boom", 0).unwrap();
        assert_eq!(ids(&pending_chunks(&conn, 16, 1).unwrap()), vec![good]);
    }

    #[test]
    fn zettelignore_excludes_notes_and_removes_their_vectors() {
        let dir = std::env::temp_dir().join(format!("zettel-ignore-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("private/deep")).unwrap();
        std::fs::create_dir_all(dir.join("public")).unwrap();
        std::fs::write(dir.join(IGNORE_FILE), "private/\n*.secret.md\n").unwrap();
        let p = |rel: &str| dir.join(rel).to_string_lossy().to_string();

        let conn = db();
        let private = chunk(&conn, &p("private/deep/diary.md"), 0, "日记内容");
        let secret = chunk(&conn, &p("public/key.secret.md"), 0, "密钥");
        let open = chunk(&conn, &p("public/note.md"), 0, "公开笔记");
        // The private note already had a vector before the rule existed.
        let blob: Vec<u8> = vec![0.1f32; EMBEDDING_DIM].iter().flat_map(|f| f.to_le_bytes()).collect();
        conn.execute("UPDATE chunks SET embedding = ?1 WHERE id = ?2", params![blob, private]).unwrap();
        conn.execute("INSERT INTO chunks_vec (id, embedding) VALUES (?1, ?2)", params![private, blob]).unwrap();

        let s = apply_ignore_rules(&conn).unwrap();
        assert_eq!(s, IgnoreSummary { ignored_files: 2, ignored_chunks: 2, removed_vectors: 1 });
        assert_eq!(ids(&pending_chunks(&conn, 10, 0).unwrap()), vec![open]);
        let vecs: i64 = conn.query_row("SELECT COUNT(*) FROM chunks_vec WHERE id = ?1", params![private], |r| r.get(0)).unwrap();
        assert_eq!(vecs, 0);
        assert!(secret > 0);

        // Removing the rule makes them embeddable again on the next build.
        std::fs::remove_file(dir.join(IGNORE_FILE)).unwrap();
        assert_eq!(apply_ignore_rules(&conn).unwrap().ignored_files, 0);
        assert_eq!(pending_chunks(&conn, 10, 0).unwrap().len(), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nested_ignore_files_layer_like_gitignore() {
        let dir = std::env::temp_dir().join(format!("zettel-ignore2-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("notes/drafts")).unwrap();
        std::fs::write(dir.join(IGNORE_FILE), "*.secret.md\narchive/\n").unwrap();
        std::fs::write(dir.join("notes").join(IGNORE_FILE), "drafts/\n!keep.secret.md\n").unwrap();
        let mut rules = IgnoreRules::new();
        assert!(rules.is_ignored(&dir.join("top.secret.md")));
        assert!(rules.is_ignored(&dir.join("archive/old.md")));
        // The inner file adds its own rules…
        assert!(rules.is_ignored(&dir.join("notes/drafts/x.md")));
        // …outer rules still apply below it…
        assert!(rules.is_ignored(&dir.join("notes/other.secret.md")));
        // …and the deeper file can re-include.
        assert!(!rules.is_ignored(&dir.join("notes/keep.secret.md")));
        assert!(!rules.is_ignored(&dir.join("notes/plain.md")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
