use tauri::State;
use crate::AppState;
use crate::chunker::{ChunkerConfig, chunk_markdown};
use crate::db::search;
use crate::error::ZettelError;
use crate::pipeline_log;
use super::{ChunkResult, ChunkInfo, SearchQuery, EmbeddingStats};
use crate::db::search::SearchResult;

#[tauri::command]
pub fn chunk_document(content: String, max_chunk_size: Option<usize>) -> ChunkResult {
    let config = ChunkerConfig {
        max_chunk_size: max_chunk_size.unwrap_or(2000),
        ..Default::default()
    };

    let chunks = chunk_markdown(&content, &config);
    let total = chunks.len();

    ChunkResult {
        chunks: chunks
            .into_iter()
            .map(|c| ChunkInfo {
                content: c.content,
                heading_hierarchy: c.heading_hierarchy,
                marker_type: c.marker_type,
                chunk_index: c.chunk_index,
            })
            .collect(),
        total,
    }
}

#[tauri::command]
pub async fn search_chunks(
    state: State<'_, AppState>,
    query: SearchQuery,
) -> Result<Vec<SearchResult>, ZettelError> {
    let mode = query.mode.as_deref().unwrap_or("fts");
    let limit = query.limit.unwrap_or(20);

    match mode {
        "hybrid" | "vector" => {
            let query_embedding = query.query_embedding.ok_or_else(|| ZettelError::Llm(
                "Missing pre-computed query embedding for hybrid/vector search".to_string()
            ))?;

            let conn = state.db.lock()?;
            match mode {
                "hybrid" => Ok(search::hybrid_search(&conn, &query.query, &query_embedding, limit)?),
                _ => Ok(search::vector_search(&conn, &query_embedding, limit)?),
            }
        }
        _ => {
            let conn = state.db.lock()?;
            Ok(search::full_text_search(&conn, &query.query, limit)?)
        }
    }
}

#[tauri::command]
pub fn get_unindexed_chunks(
    state: State<'_, AppState>,
    limit: usize,
) -> Result<Vec<(i64, String)>, ZettelError> {
    let conn = state.db.lock()?;
    let mut stmt = conn.prepare("SELECT id, content FROM chunks WHERE embedding IS NULL LIMIT ?1")?;
    let rows = stmt.query_map([limit], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))?;
    let chunks = rows.collect::<Result<Vec<_>, _>>()?;
    pipeline_log::log_embedding_info(&format!("get_unindexed_chunks: requested={}, returned={}", limit, chunks.len()));
    Ok(chunks)
}

#[tauri::command]
pub fn save_chunk_embeddings(
    state: State<'_, AppState>,
    embeddings: Vec<(i64, Vec<f32>)>,
) -> Result<(), ZettelError> {
    let count = embeddings.len();
    let mut conn = state.db.lock()?;
    let tx = conn.transaction().map_err(|e| ZettelError::System(format!("Failed to start transaction: {}", e)))?;
    {
        let mut update_chunk_stmt = tx.prepare("UPDATE chunks SET embedding = ?1 WHERE id = ?2")?;
        let mut insert_vec_stmt = tx.prepare("INSERT OR REPLACE INTO chunks_vec (id, embedding) VALUES (?1, ?2)")?;

        for (id, emb_vec) in embeddings {
            let emb_blob: Vec<u8> = emb_vec.iter().flat_map(|f| f.to_le_bytes()).collect();
            update_chunk_stmt.execute(rusqlite::params![emb_blob, id])?;
            insert_vec_stmt.execute(rusqlite::params![id, emb_blob])?;
        }
    }
    tx.commit().map_err(|e| ZettelError::System(format!("Failed to commit transaction: {}", e)))?;
    pipeline_log::log_embedding_info(&format!("save_chunk_embeddings: saved {} chunk embeddings", count));
    Ok(())
}

#[tauri::command]
pub async fn finalize_embedding_index(
    state: State<'_, AppState>,
) -> Result<(), ZettelError> {
    pipeline_log::log_embedding_info("finalize_embedding_index: computing semantic edges...");
    let conn = state.db.lock()?;
    search::compute_and_store_semantic_edges(&conn, None)
        .map_err(|e| {
            pipeline_log::log_embedding_error(&format!("finalize_embedding_index failed: {}", e));
            ZettelError::System(format!("Rebuilding semantic edges failed: {}", e))
        })?;
    search::invalidate_graph_cache(&conn);
    pipeline_log::log_embedding_info("finalize_embedding_index: done, graph cache invalidated");
    Ok(())
}

#[tauri::command]
pub fn get_embedding_stats(state: State<'_, AppState>) -> Result<EmbeddingStats, ZettelError> {
    let conn = state.db.lock()?;
    let total_chunks: usize = conn.query_row("SELECT COUNT(*) FROM chunks", [], |row| row.get(0))?;
    let indexed_chunks: usize = conn.query_row("SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL", [], |row| row.get(0))?;

    Ok(EmbeddingStats {
        total_chunks,
        indexed_chunks,
        has_index: indexed_chunks > 0,
    })
}
