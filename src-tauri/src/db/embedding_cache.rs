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

/// Vector dimension produced by `nomic-embed-text-v1.5`. A cached vector with
/// a different dim is treated as a miss so a model swap can't corrupt results.
pub const EMBEDDING_DIM: usize = 768;

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

/// Outcome of a backfill pass.
#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
pub struct BackfillStats {
    /// Chunks that had no embedding before the pass.
    pub scanned: usize,
    /// Chunks filled from cache (no model inference needed).
    pub filled: usize,
}

/// Fill `embedding IS NULL` chunks from the cache.
///
/// Called before handing work to the frontend, so the embedding pipeline only
/// ever sees true cache misses. Returns how many chunks were satisfied locally.
pub fn backfill_null_embeddings(
    conn: &mut Connection,
    limit: usize,
) -> rusqlite::Result<BackfillStats> {
    let mut stats = BackfillStats::default();

    // Collect candidates first — we cannot hold a read statement open while
    // writing to the same table inside a transaction.
    let candidates: Vec<(i64, String)> = {
        let mut stmt =
            conn.prepare("SELECT id, content FROM chunks WHERE embedding IS NULL LIMIT ?1")?;
        let rows = stmt.query_map(params![limit as i64], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    stats.scanned = candidates.len();
    if candidates.is_empty() {
        return Ok(stats);
    }

    // Resolve hits before opening the write transaction.
    let mut hits: Vec<(i64, Vec<u8>)> = Vec::new();
    for (id, content) in &candidates {
        if let Some(blob) = get_blob(conn, content) {
            hits.push((*id, blob));
        }
    }
    if hits.is_empty() {
        return Ok(stats);
    }

    let tx = conn.transaction()?;
    {
        let mut upd = tx.prepare("UPDATE chunks SET embedding = ?1 WHERE id = ?2")?;
        let mut ins =
            tx.prepare("INSERT OR REPLACE INTO chunks_vec (id, embedding) VALUES (?1, ?2)")?;
        for (id, blob) in &hits {
            upd.execute(params![blob, id])?;
            ins.execute(params![id, blob])?;
            stats.filled += 1;
        }
    }
    tx.commit()?;

    Ok(stats)
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
}
