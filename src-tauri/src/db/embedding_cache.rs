//! Content-addressed embedding cache.
//!
//! Embeddings are computed in the frontend (transformers.js / ONNX) and pushed
//! into Rust via `save_chunk_embeddings`. The problem this module solves is on
//! the *invalidation* side: `sync_file` deletes and re-inserts every chunk of a
//! touched file, so editing one line resets `embedding` to NULL for the whole
//! file and forces a full re-embed of text that never changed.
//!
//! Keying vectors by SHA-256 of the chunk text turns that into a free lookup.
//! It also deduplicates byte-identical chunks across different notes (shared
//! boilerplate, templates, repeated definitions).

use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

/// Vector dimension of the bundled local model (`jina-embeddings-v2-base-zh`,
/// and `nomic-embed-text-v1.5` before it). A cached vector with a different dim
/// is treated as a miss so a model swap can't corrupt results.
pub const EMBEDDING_DIM: usize = 768;

/// `app_settings` key recording which model produced the stored vectors.
///
/// The value is chosen by the frontend, which owns the embedding config:
/// `local:<hf model id>` for the bundled model, `custom:<url>|<model>` for an
/// API endpoint. Vectors from two different models live in unrelated spaces, so
/// mixing them silently ruins vector search. That is why a changed key wipes
/// every derived vector (see [`sync_model_key`]).
pub const MODEL_KEY_SETTING: &str = "embedding_model_key";

/// Result of [`sync_model_key`], returned to the frontend.
#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
pub struct ModelSyncOutcome {
    /// Old vectors were discarded and must be rebuilt.
    pub invalidated: bool,
    /// Chunks whose embedding was cleared.
    pub cleared_chunks: usize,
}

/// Make sure every stored vector belongs to the model identified by `key`.
///
/// - Same key as recorded: nothing happens.
/// - No key recorded yet (a database from before this setting existed):
///   if `adopt_if_unset` is true, or there are no vectors at all, the key is
///   just recorded. Otherwise the existing vectors are from an unknown model and
///   are discarded. The frontend passes `adopt_if_unset = true` for a custom API
///   endpoint, so upgrading never forces a paid re-embed; for the local model it
///   passes `false`, because pre-upgrade local vectors came from nomic.
/// - Different key: all derived vectors are discarded.
///
/// "Discarded" means chunk embeddings, `chunks_vec`, `files_vec`, the content
/// cache (keyed by text only, so it would hand old vectors back) and the
/// semantic edges computed from them. Notes and FTS are untouched.
pub fn sync_model_key(
    conn: &mut Connection,
    key: &str,
    adopt_if_unset: bool,
) -> rusqlite::Result<ModelSyncOutcome> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            params![MODEL_KEY_SETTING],
            |r| r.get(0),
        )
        .ok();
    if stored.as_deref() == Some(key) {
        return Ok(ModelSyncOutcome::default());
    }

    let has_vectors: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM chunks WHERE embedding IS NOT NULL)
             OR EXISTS(SELECT 1 FROM embedding_cache)",
        [],
        |r| r.get(0),
    )?;
    let keep_existing = stored.is_none() && (adopt_if_unset || !has_vectors);

    let tx = conn.transaction()?;
    // Failures are about one model; another model gets a clean slate even when
    // the vectors are adopted.
    tx.execute("DELETE FROM embedding_failures", [])?;
    let mut outcome = ModelSyncOutcome::default();
    if !keep_existing {
        outcome.cleared_chunks =
            tx.execute("UPDATE chunks SET embedding = NULL WHERE embedding IS NOT NULL", [])?;
        tx.execute_batch(
            "DELETE FROM chunks_vec;
             DELETE FROM files_vec;
             DELETE FROM embedding_cache;
             DELETE FROM semantic_edges;",
        )?;
        outcome.invalidated = true;
    }
    tx.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = datetime('now')",
        params![MODEL_KEY_SETTING, key],
    )?;
    tx.commit()?;

    if outcome.invalidated {
        crate::db::search::invalidate_graph_cache(conn);
        log::info!(
            "Embedding model changed ({:?} -> {}): cleared {} chunk vectors for rebuild",
            stored, key, outcome.cleared_chunks
        );
    }
    Ok(outcome)
}

/// Stable cache key for a chunk's text.
///
/// Whitespace is NOT normalized: the embedding model is sensitive to it, so two
/// texts differing only in whitespace are genuinely different inputs.
pub fn content_hash(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Encode `f32` vector to the little-endian blob layout used by both
/// `chunks.embedding` and the `chunks_vec` virtual table.
pub fn vec_to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

/// Decode a little-endian `f32` blob. Returns `None` on a truncated or
/// wrong-dimension payload rather than producing a silently bogus vector.
pub fn blob_to_vec(blob: &[u8]) -> Option<Vec<f32>> {
    if blob.len() % 4 != 0 {
        return None;
    }
    let v: Vec<f32> = blob
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    if v.len() != EMBEDDING_DIM {
        return None;
    }
    Some(v)
}

/// Record a computed vector in the cache. Idempotent.
pub fn put(conn: &Connection, text: &str, embedding: &[f32]) -> rusqlite::Result<()> {
    if embedding.len() != EMBEDDING_DIM {
        return Ok(()); // never cache an off-dimension vector
    }
    let hash = content_hash(text);
    let blob = vec_to_blob(embedding);
    conn.execute(
        "INSERT INTO embedding_cache (content_hash, embedding, dim, hits, last_used_at)
         VALUES (?1, ?2, ?3, 0, datetime('now'))
         ON CONFLICT(content_hash) DO UPDATE SET
           embedding = excluded.embedding,
           dim = excluded.dim,
           last_used_at = datetime('now')",
        params![hash, blob, EMBEDDING_DIM as i64],
    )?;
    Ok(())
}

/// Look up a cached vector blob by text. Bumps the hit counter on success so
/// cache effectiveness is measurable rather than assumed.
pub fn get_blob(conn: &Connection, text: &str) -> Option<Vec<u8>> {
    let hash = content_hash(text);
    let blob: Option<Vec<u8>> = conn
        .query_row(
            "SELECT embedding FROM embedding_cache WHERE content_hash = ?1 AND dim = ?2",
            params![hash, EMBEDDING_DIM as i64],
            |row| row.get(0),
        )
        .ok();
    if blob.is_some() {
        let _ = conn.execute(
            "UPDATE embedding_cache
             SET hits = hits + 1, last_used_at = datetime('now')
             WHERE content_hash = ?1",
            params![hash],
        );
    }
    blob
}


/// Cache size / effectiveness counters for the settings UI.
#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
pub struct CacheStats {
    pub entries: usize,
    pub total_hits: i64,
}

pub fn stats(conn: &Connection) -> CacheStats {
    let entries: usize = conn
        .query_row("SELECT COUNT(*) FROM embedding_cache", [], |r| r.get(0))
        .unwrap_or(0);
    let total_hits: i64 = conn
        .query_row("SELECT COALESCE(SUM(hits), 0) FROM embedding_cache", [], |r| r.get(0))
        .unwrap_or(0);
    CacheStats { entries, total_hits }
}

/// Drop the least-recently-used entries, keeping at most `keep` rows.
///
/// The cache is pure derived data, so eviction is always safe — a dropped entry
/// just means the next encounter of that text pays for inference again.
pub fn prune(conn: &Connection, keep: usize) -> rusqlite::Result<usize> {
    let total: usize = conn
        .query_row("SELECT COUNT(*) FROM embedding_cache", [], |r| r.get(0))
        .unwrap_or(0);
    if total <= keep {
        return Ok(0);
    }
    let excess = total - keep;
    let removed = conn.execute(
        "DELETE FROM embedding_cache WHERE content_hash IN (
            SELECT content_hash FROM embedding_cache
            ORDER BY last_used_at ASC, hits ASC
            LIMIT ?1
         )",
        params![excess as i64],
    )?;
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE embedding_cache (
                content_hash TEXT PRIMARY KEY,
                embedding BLOB NOT NULL,
                dim INTEGER NOT NULL,
                hits INTEGER NOT NULL DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now')),
                last_used_at TEXT DEFAULT (datetime('now'))
            );",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn hash_is_stable_and_distinguishes_whitespace() {
        assert_eq!(content_hash("hello"), content_hash("hello"));
        assert_ne!(content_hash("hello"), content_hash("hello "));
    }

    #[test]
    fn blob_roundtrip_preserves_values() {
        let v: Vec<f32> = (0..EMBEDDING_DIM).map(|i| i as f32 * 0.001).collect();
        let blob = vec_to_blob(&v);
        let back = blob_to_vec(&blob).expect("valid");
        assert_eq!(v, back);
    }

    #[test]
    fn blob_rejects_wrong_dimension() {
        assert!(blob_to_vec(&vec_to_blob(&[1.0, 2.0, 3.0])).is_none());
        assert!(blob_to_vec(&[0u8, 1, 2]).is_none()); // not a multiple of 4
    }

    #[test]
    fn put_then_get_hits_and_counts() {
        let conn = mem_db();
        let v: Vec<f32> = vec![0.5; EMBEDDING_DIM];
        put(&conn, "some chunk text", &v).unwrap();

        let blob = get_blob(&conn, "some chunk text").expect("cache hit");
        assert_eq!(blob_to_vec(&blob).unwrap(), v);
        assert!(get_blob(&conn, "different text").is_none());

        let s = stats(&conn);
        assert_eq!(s.entries, 1);
        assert_eq!(s.total_hits, 1); // exactly one successful lookup above
    }

    #[test]
    fn off_dimension_vectors_are_not_cached() {
        let conn = mem_db();
        put(&conn, "text", &[1.0, 2.0]).unwrap();
        assert_eq!(stats(&conn).entries, 0);
    }

    #[test]
    fn prune_keeps_requested_count() {
        let conn = mem_db();
        let v: Vec<f32> = vec![0.1; EMBEDDING_DIM];
        for i in 0..5 {
            put(&conn, &format!("chunk {}", i), &v).unwrap();
        }
        assert_eq!(stats(&conn).entries, 5);
        let removed = prune(&conn, 2).unwrap();
        assert_eq!(removed, 3);
        assert_eq!(stats(&conn).entries, 2);
    }

    // ── model-key sync ──────────────────────────────────────────────

    /// Full schema with one embedded chunk + a cache row, as an upgraded user has.
    fn db_with_vectors() -> Connection {
        crate::db::register_sqlite_vec();
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::setup_database_schema(&conn).unwrap();
        conn.execute("INSERT INTO files (path, hash) VALUES ('a.md', 'h')", []).unwrap();
        conn.execute(
            "INSERT INTO chunks (file_path, chunk_index, content) VALUES ('a.md', 0, 'text')",
            [],
        )
        .unwrap();
        let blob = vec_to_blob(&vec![0.1; EMBEDDING_DIM]);
        conn.execute("UPDATE chunks SET embedding = ?1", params![blob]).unwrap();
        conn.execute("INSERT INTO chunks_vec (id, embedding) VALUES (1, ?1)", params![blob]).unwrap();
        put(&conn, "text", &vec![0.1; EMBEDDING_DIM]).unwrap();
        conn
    }

    fn embedded(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn upgrade_on_local_model_discards_legacy_vectors() {
        let mut conn = db_with_vectors();
        let out = sync_model_key(&mut conn, "local:new", false).unwrap();
        assert!(out.invalidated);
        assert_eq!(out.cleared_chunks, 1);
        assert_eq!(embedded(&conn), 0);
        assert_eq!(stats(&conn).entries, 0, "text-keyed cache would hand old vectors back");
        let vec_rows: i64 = conn.query_row("SELECT COUNT(*) FROM chunks_vec", [], |r| r.get(0)).unwrap();
        assert_eq!(vec_rows, 0);
    }

    #[test]
    fn upgrade_on_custom_endpoint_keeps_vectors() {
        let mut conn = db_with_vectors();
        let out = sync_model_key(&mut conn, "custom:https://x|m", true).unwrap();
        assert!(!out.invalidated);
        assert_eq!(embedded(&conn), 1);
    }

    #[test]
    fn same_key_is_a_no_op_and_changed_key_clears() {
        let mut conn = db_with_vectors();
        sync_model_key(&mut conn, "custom:https://x|m", true).unwrap();
        assert!(!sync_model_key(&mut conn, "custom:https://x|m", true).unwrap().invalidated);
        assert_eq!(embedded(&conn), 1);

        // Switching model, even with adopt_if_unset, must clear: a key is recorded.
        let out = sync_model_key(&mut conn, "local:new", true).unwrap();
        assert!(out.invalidated);
        assert_eq!(embedded(&conn), 0);
    }

    #[test]
    fn fresh_install_just_records_the_key() {
        crate::db::register_sqlite_vec();
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::schema::setup_database_schema(&conn).unwrap();
        assert!(!sync_model_key(&mut conn, "local:new", false).unwrap().invalidated);
        let v = crate::db::schema::get_setting(&conn, MODEL_KEY_SETTING).unwrap();
        assert_eq!(v.as_deref(), Some("local:new"));
    }
}
