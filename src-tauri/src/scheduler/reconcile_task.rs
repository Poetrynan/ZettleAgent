use std::sync::{Arc, Mutex};
use std::sync::atomic::Ordering;
use std::sync::atomic::AtomicBool;
use rusqlite::Connection;
use tauri::Emitter;
use sha2::{Sha256, Digest};
use futures_util::stream::{FuturesUnordered, StreamExt};

use crate::llm::{self, ChatMessage};
use crate::db::{search, schema};
use crate::scheduler::SchedulerConfig;
use crate::pipeline_log;
use super::task::SchedulerTask;

pub struct ReconcileTask;

impl SchedulerTask for ReconcileTask {
    fn name(&self) -> &str {
        "reconcile"
    }

    async fn run(
        &self,
        db: &Arc<Mutex<Connection>>,
        config: &SchedulerConfig,
        running: Arc<AtomicBool>,
        app: Option<tauri::AppHandle>,
        force: bool,
        methodology: String,
        path_prefix: Option<String>,
    ) -> anyhow::Result<(usize, usize, usize)> {
        // Step 1: Find notes that need reconciliation
        let notes: Vec<(String, String, String, String)> = {
            let conn = db.lock().map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
            let mut notes = Vec::new();
            {
                // Build SQL with optional path_prefix filter
                let path_filter = path_prefix.as_ref().map(|p| {
                    let normalized = p.replace('\\', "/");
                    format!(" AND f.path LIKE '{}%'", normalized.replace('\'', "''"))
                }).unwrap_or_default();

                let mut stmt = if force {
                    conn.prepare(&format!(
                        "SELECT f.path, COALESCE(f.title, ''), COALESCE(cm.note_type, 'permanent'), f.hash
                         FROM files f
                         LEFT JOIN card_meta cm ON f.path = cm.file_path
                         WHERE 1=1{}
                         ORDER BY f.last_synced DESC",
                        path_filter
                    ))?
                } else {
                    conn.prepare(&format!(
                        "SELECT f.path, COALESCE(f.title, ''), COALESCE(cm.note_type, 'permanent'), f.hash
                         FROM files f
                         LEFT JOIN card_meta cm ON f.path = cm.file_path
                         WHERE (cm.last_reconciled_hash IS NULL
                            OR cm.last_reconciled_hash != f.hash
                            OR cm.last_reconciled_methodology IS NULL
                            OR cm.last_reconciled_methodology != ?1){}
                         ORDER BY f.last_synced DESC
                         LIMIT ?2",
                        path_filter
                    ))?
                };
                
                let param = if force {
                    rusqlite::params![]
                } else {
                    rusqlite::params![&methodology, config.batch_size as i64]
                };

                let rows = stmt.query_map(param, |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })?;
                for row in rows {
                    notes.push(row?);
                }
            }
            notes
        };

        pipeline_log::log_organize_info(&format!(
            "Reconciliation starting: mode={}, methodology={}, notes_selected={}, batch_size={}, path_prefix={:?}",
            if force { "force" } else { "incremental" },
            methodology,
            notes.len(),
            config.batch_size,
            path_prefix,
        ));
        for (i, (p, t, nt, h)) in notes.iter().enumerate() {
            pipeline_log::log_organize_info(&format!(
                "  [{}/{}] path={}, title={}, note_type={}, hash={}",
                i + 1, notes.len(), p, pipeline_log::trunc(t, 40), nt, &h[..8.min(h.len())],
            ));
        }

        struct PreparedTask {
            path: String,
            content: String,
            file_hash: String,
            filename: String,
            messages: Vec<ChatMessage>,
        }

        let mut prepared_tasks = Vec::new();
        let mut skipped_count = 0;

        for (_idx, (path, title, _note_type, hash)) in notes.iter().enumerate() {
            if !running.load(Ordering::SeqCst) {
                break;
            }

            // Skip journal/diary notes if user opted out
            if !config.include_journals {
                // Signal 1: note_type already classified by AI (most reliable)
                let is_journal_type = matches!(_note_type.as_str(), "journal" | "fleeting" | "inbox" | "capture" | "seed");
                // Signal 2: file is under the configured daily notes directory
                let in_daily_dir = config.daily_note_path.as_ref().map_or(false, |daily_path| {
                    let norm_path = path.replace('\\', "/").to_lowercase();
                    let norm_daily = daily_path.replace('\\', "/").to_lowercase();
                    norm_path.starts_with(&norm_daily)
                });
                if is_journal_type || in_daily_dir {
                    pipeline_log::log_organize_info(&format!("Skipping journal note: {}", path));
                    let _ = update_card_meta_skipped(db, path, hash, &methodology);
                    skipped_count += 1;
                    continue;
                }
            }

            let filename = std::path::Path::new(path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());

            // Read file
            let content = match std::fs::read_to_string(path) {
                Ok(c) => c,
                Err(e) => {
                    log::warn!("Failed to read {}: {}", path, e);
                    continue;
                }
            };

            // Skip very short files based on min_note_length setting
            if content.chars().count() < config.min_note_length {
                pipeline_log::log_organize_info(&format!(
                    "Skipping short note ({} chars < {}): {}", content.chars().count(), config.min_note_length, path,
                ));
                let _ = update_card_meta_skipped(db, path, hash, &methodology);
                skipped_count += 1;
                continue;
            }

            // Step 2: Search for related notes (hybrid if embedding available, FTS otherwise)
            // Improved: combine title with first part of body content for richer semantic matching.
            // Previously used only title or first 200 chars, which missed key concepts in long notes.
            let search_query = if title.is_empty() {
                // Skip YAML frontmatter to get actual content for search
                let body = if content.starts_with("---\n") {
                    content.find("\n---\n")
                        .map(|i| &content[i + 5..])
                        .unwrap_or(content.as_str())
                } else {
                    content.as_str()
                };
                body.chars().take(300).collect::<String>()
            } else {
                // Combine title with first 150 chars of body for better search coverage
                let body = if content.starts_with("---\n") {
                    content.find("\n---\n")
                        .map(|i| &content[i + 5..])
                        .unwrap_or(content.as_str())
                } else {
                    content.as_str()
                };
                let first_part: String = body.chars().take(150).collect();
                format!("{} {}", title, first_part)
            };

            // Try to load existing file-level embedding from DB for hybrid search
            let query_embedding: Option<Vec<f32>> = {
                let conn = db.lock().map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
                conn.query_row(
                    "SELECT embedding FROM files_vec WHERE file_path = ?1",
                    rusqlite::params![path],
                    |row| row.get::<_, Vec<u8>>(0),
                )
                .ok()
                .map(|blob| {
                    blob.chunks_exact(4)
                        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                        .collect::<Vec<f32>>()
                })
                .filter(|v| !v.is_empty())
            };

            // Search and keep both content snippets AND source file paths for candidate alignment
            // Also collect brief summaries (first ~120 chars of content) for each candidate file,
            // so the LLM can assess relevance without cross-referencing separate snippet blocks.
            let (related_chunks, search_file_paths, file_summaries) = {
                let conn = db.lock().map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
                let search_limit = config.search_result_count;
                let (results, search_mode): (Vec<_>, &str) = if let Some(ref emb) = query_embedding {
                    (search::hybrid_search(&conn, &search_query, emb, search_limit)
                        .unwrap_or_default(), "hybrid")
                } else {
                    (search::full_text_search(&conn, &search_query, search_limit)
                        .unwrap_or_default(), "keyword")
                };
                let results: Vec<_> = results.into_iter()
                    .filter(|r| r.file_path != *path)
                    .collect();

                let mut chunks = Vec::new();
                let mut seen_paths: Vec<String> = Vec::new();
                let mut summaries: std::collections::HashMap<String, String> = std::collections::HashMap::new();
                for r in &results {
                    let fp = r.file_path.clone();
                    let source_name = std::path::Path::new(&fp)
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| fp.clone());
                    chunks.push(format!(
                        "[Source: {}][search: {}][{}]: {}",
                        source_name,
                        search_mode,
                        r.heading_hierarchy.as_deref().unwrap_or(""),
                        r.content
                    ));
                    if !seen_paths.contains(&fp) {
                        seen_paths.push(fp.clone());
                        // Capture first ~120 chars as brief summary for candidate enrichment
                        let summary: String = r.content.chars().take(120).collect();
                        summaries.insert(fp, summary);
                    }
                }

                // Add existing relations context so LLM avoids duplicating them.
                // This is critical for incremental organize: when a note is re-processed,
                // the LLM should know what relations already exist and either skip them
                // or suggest different relation types.
                if let Ok(mut rel_stmt) = conn.prepare(
                    "SELECT nr.relation_type, COALESCE(f.title, nr.target_path)
                     FROM note_relations nr
                     LEFT JOIN files f ON f.path = nr.target_path
                     WHERE nr.source_path = ?1
                     ORDER BY nr.confidence DESC
                     LIMIT 20"
                ) {
                    if let Ok(rel_rows) = rel_stmt.query_map(rusqlite::params![path], |row| {
                        Ok(format!("  - {} → [[{}]]", row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    }) {
                        let existing: Vec<String> = rel_rows.filter_map(|r| r.ok()).collect();
                        if !existing.is_empty() {
                            chunks.push(format!(
                                "[Existing Relations for this note]\n{}",
                                existing.join("\n")
                            ));
                        }
                    }
                }

                (chunks, seen_paths, summaries)
            };

            // Step 3: Build candidate notes from search results + graph neighbors + tag sharing
            let related_titles: Vec<String> = {
                let conn = db.lock().map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
                let mut titles = Vec::new();
                let max_candidates = 25;

                // Source A: titles of notes found via semantic search, enriched with metadata
                // Enrichment: include note_type and tags from card_meta so the LLM has
                // more context about each candidate without needing to read full content.
                for fp in &search_file_paths {
                    if let Ok(row) = conn.query_row(
                        "SELECT COALESCE(f.title, f.path), COALESCE(cm.note_type, ''), COALESCE(cm.tags, '[]')
                         FROM files f LEFT JOIN card_meta cm ON f.path = cm.file_path
                         WHERE f.path = ?1",
                        rusqlite::params![fp],
                        |row| Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        )),
                    ) {
                        let (t, note_type, tags_json) = row;
                        let enriched = if note_type.is_empty() {
                            t
                        } else {
                            let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
                            if tags.is_empty() {
                                format!("{} [type: {}]", t, note_type)
                            } else {
                                format!("{} [type: {}, tags: {}]", t, note_type, tags.join(", "))
                            }
                        };
                        // Append brief content summary so the LLM can assess relevance
                        // directly from the candidate list without cross-referencing the
                        // separate Related Content Snippets block — reduces hallucinated links.
                        let enriched = if let Some(summary) = file_summaries.get(fp) {
                            if !summary.trim().is_empty() {
                                format!("{} — {}", enriched, summary)
                            } else {
                                enriched
                            }
                        } else {
                            enriched
                        };
                        if !titles.contains(&enriched) {
                            titles.push(enriched);
                        }
                    }
                }

                // Source B: 1-hop graph neighbors from existing note_relations
                if titles.len() < max_candidates {
                    if let Ok(mut stmt) = conn.prepare(
                        "SELECT DISTINCT COALESCE(f.title, f.path) FROM (
                             SELECT target_path AS neighbor FROM note_relations WHERE source_path = ?1
                             UNION
                             SELECT source_path AS neighbor FROM note_relations WHERE target_path = ?1
                         ) nbrs
                         LEFT JOIN files f ON f.path = nbrs.neighbor
                         WHERE nbrs.neighbor != ?1
                         LIMIT ?2",
                    ) {
                        let limit = (max_candidates - titles.len()) as i64;
                        if let Ok(rows) = stmt.query_map(rusqlite::params![path, limit], |row| row.get::<_, String>(0)) {
                            for row in rows.flatten() {
                                if !titles.contains(&row) {
                                    titles.push(row);
                                }
                            }
                        }
                    }
                }

                // Source C: notes sharing the same tags
                if titles.len() < max_candidates {
                    if let Ok(tags_json) = conn.query_row(
                        "SELECT tags FROM card_meta WHERE file_path = ?1",
                        rusqlite::params![path],
                        |row| row.get::<_, String>(0),
                    ) {
                        if let Ok(tags) = serde_json::from_str::<Vec<String>>(&tags_json) {
                            for tag in tags.iter().take(3) {
                                if titles.len() >= max_candidates { break; }
                                let pattern = format!("%\"{}\"% ", tag);
                                if let Ok(mut stmt) = conn.prepare(
                                    "SELECT COALESCE(f.title, f.path) FROM card_meta cm
                                     JOIN files f ON f.path = cm.file_path
                                     WHERE cm.tags LIKE ?1 AND cm.file_path != ?2
                                     LIMIT ?3",
                                ) {
                                    let limit = (max_candidates - titles.len()) as i64;
                                    if let Ok(rows) = stmt.query_map(rusqlite::params![pattern, path, limit], |row| row.get::<_, String>(0)) {
                                        for row in rows.flatten() {
                                            if !titles.contains(&row) {
                                                titles.push(row);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // Source D: supplement with recent notes if still under limit
                if titles.len() < max_candidates {
                    let limit = (max_candidates - titles.len()) as i64;
                    if let Ok(mut stmt) = conn.prepare(
                        "SELECT COALESCE(f.title, f.path) FROM files f WHERE f.path != ?1 ORDER BY f.last_synced DESC LIMIT ?2",
                    ) {
                        if let Ok(rows) = stmt.query_map(rusqlite::params![path, limit], |row| row.get::<_, String>(0)) {
                            for row in rows.flatten() {
                                if !titles.contains(&row) {
                                    titles.push(row);
                                }
                            }
                        }
                    }
                }

                titles
            };

            // Truncate long content for LLM efficiency
            let truncation_limit = config.content_truncation_limit;
            let char_count = content.chars().count();
            let content_for_prompt = if char_count > truncation_limit {
                let truncated: String = content.chars().take(truncation_limit).collect();
                format!("{}\n\n[... content truncated, {} total characters ...]", truncated, char_count)
            } else {
                content.clone()
            };

            let organize_prompt = llm::prompts::unified_organize_prompt(
                &title,
                &content_for_prompt,
                &related_titles,
                &related_chunks.join("\n\n---\n\n"),
                &methodology,
            );
            
            let messages = vec![
                ChatMessage { role: "system".to_string(), content: llm::prompts::system_prompt(&methodology), ..Default::default() },
                ChatMessage { role: "user".to_string(), content: organize_prompt, ..Default::default() },
            ];

            prepared_tasks.push(PreparedTask {
                path: path.clone(),
                content,
                file_hash: hash.clone(),
                filename,
                messages,
            });
        }

        let mut processed = skipped_count;
        let mut reconciled = 0;
        let mut api_calls = 0;

        if !prepared_tasks.is_empty() {
            let llm_config = config.llm_config.clone();
            
            // Process all prepared tasks (no limit — let user control via settings)
            let total_to_run = prepared_tasks.len();
            let tasks_to_run: Vec<PreparedTask> = prepared_tasks;
            
            // Emit starting status
            if let Some(ref app_handle) = app {
                let _ = app_handle.emit("scheduler-progress", serde_json::json!({
                    "stage": "processing",
                    "current": 0,
                    "total": total_to_run,
                    "message": format!("Starting note reconciliation (0/{})", total_to_run),
                }));
            }

            // Limit concurrent LLM calls to prevent API rate-limiting.
            // Tasks are all spawned immediately (tokio tasks are cheap), but each
            // waits for a semaphore permit before issuing the actual HTTP request.
            let max_concurrent_llm = 5;
            let semaphore = Arc::new(tokio::sync::Semaphore::new(max_concurrent_llm));

            let mut futures = FuturesUnordered::new();
            for task in tasks_to_run {
                let llm_config = llm_config.clone();
                let running_ref = running.clone();
                let sem = semaphore.clone();

                futures.push(tokio::spawn(async move {
                    // Check if already cancelled before waiting for permit
                    if !running_ref.load(Ordering::SeqCst) {
                        return (task, None);
                    }

                    // Acquire permit — limits concurrent LLM API calls.
                    // Also allow cancellation while waiting for a permit.
                    let _permit = tokio::select! {
                        permit = sem.acquire_owned() => {
                            match permit {
                                Ok(p) => p,
                                Err(_) => {
                                    log::error!("Semaphore closed unexpectedly for {}", task.path);
                                    return (task, None);
                                }
                            }
                        }
                        _ = async {
                            loop {
                                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                                if !running_ref.load(Ordering::SeqCst) {
                                    break;
                                }
                            }
                        } => {
                            log::info!("Task cancelled while waiting for permit: {}", task.path);
                            return (task, None);
                        }
                    };

                    // Re-check after acquiring permit (may have waited)
                    if !running_ref.load(Ordering::SeqCst) {
                        return (task, None);
                    }

                    // Use lower temperature (0.3) for organize tasks — produces more
                    // consistent JSON output and reduces hallucinated link suggestions.
                    let organize_config = crate::llm::LlmConfig {
                        temperature: 0.3,
                        ..llm_config
                    };
                    let llm_future = llm::chat_completion(&organize_config, &task.messages);
                    let result = tokio::select! {
                        res = llm_future => Some(res),
                        _ = async {
                            loop {
                                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                                if !running_ref.load(Ordering::SeqCst) {
                                    break;
                                }
                            }
                        } => {
                            log::info!("LLM call cancelled by user for {}", task.path);
                            pipeline_log::log_organize_info(&format!("LLM call cancelled by user for {}", task.path));
                            None
                        }
                    };
                    (task, result)
                }));
            }

            // Stream results as they complete!
            let mut completed_count = 0;
            while let Some(join_res) = futures.next().await {
                if !running.load(Ordering::SeqCst) {
                    break;
                }

                if let Ok((task, Some(llm_res))) = join_res {
                    let path = &task.path;
                    let content = &task.content;
                    let filename = &task.filename;
                    
                    completed_count += 1;
                    
                    if let Some(ref app_handle) = app {
                        let _ = app_handle.emit("scheduler-progress", serde_json::json!({
                            "stage": "processing",
                            "current": completed_count,
                            "total": total_to_run,
                            "filename": filename.clone(),
                            "message": format!("Analyzing note: {} ({}/{})", filename, completed_count, total_to_run),
                        }));
                    }

                    match llm_res {
                        Ok(response) => {
                            api_calls += 1;
                            let mut all_generated_blocks = Vec::new();
                            
                            if let Some(json_str) = extract_json(&response) {
                                if let Ok(meta) = serde_json::from_str::<serde_json::Value>(json_str) {
                                    // 1. Save to SQLite database using compatible format
                                    let mut meta_compat = meta.clone();
                                    if let Some(suggested) = meta.get("suggested_links") {
                                        meta_compat["links"] = suggested.clone();
                                    }
                                    let compat_json_str = serde_json::to_string(&meta_compat).unwrap_or_default();
                                    if let Err(e) = update_card_meta_from_response(db, path, &compat_json_str, &task.file_hash, &methodology) {
                                        pipeline_log::log_organize_warn(&format!("Failed to update card meta for {}: {}", path, e));
                                    }

                                    // 2. Generate Suggested Connections block
                                    if let Some(suggested_links_val) = meta.get("suggested_links") {
                                        if let Ok(parsed_links) = serde_json::from_value::<Vec<search::SuggestedLink>>(suggested_links_val.clone()) {
                                            if !parsed_links.is_empty() {
                                                let mut links_block = "<!-- @generated -->\n## Suggested Connections\n\n".to_string();
                                                for l in &parsed_links {
                                                    let target = l.target();
                                                    let target_wrapped = if target.starts_with("[[") { target.to_string() } else { format!("[[{}]]", target) };
                                                    if let Some(rel) = l.relation() {
                                                        links_block.push_str(&format!("- {} ({})\n", target_wrapped, rel));
                                                    } else {
                                                        links_block.push_str(&format!("- {}\n", target_wrapped));
                                                    }
                                                }
                                                links_block.push_str("<!-- /@generated -->");
                                                all_generated_blocks.push(links_block);
                                            }
                                        }
                                    }

                                    // 3. Generate Note Type Badge (ALWAYS generate this)
                                    let note_type_str = meta.get("note_type")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("permanent");
                                    let badge_block = format!(
                                        "<!-- @generated -->\n**Note Type**: `{}`\n<!-- /@generated -->",
                                        note_type_str
                                    );
                                    all_generated_blocks.push(badge_block);

                                    // 4. Generate Reconciliation block if any contradictions exist
                                    if let Some(recon_text) = meta.get("reconciliation_content").and_then(|v| v.as_str()) {
                                        if !recon_text.trim().is_empty() {
                                            let recon_block = format!(
                                                "<!-- @generated -->\n## Conflict & Reconciliation Notes\n\n{}\n<!-- /@generated -->",
                                                recon_text.trim()
                                            );
                                            all_generated_blocks.push(recon_block);
                                        }
                                    }

                                    // 5. Record temporal facts and timeline events
                                    if let Some(facts) = meta.get("facts_extracted").and_then(|v| v.as_array()) {
                                        for fact in facts {
                                            if let Some(fact_str) = fact.as_str() {
                                                if !fact_str.is_empty() {
                                                    if let Ok(conn) = db.lock() {
                                                        if let Ok(fact_id) = crate::temporal::insert_fact(&conn, path, fact_str, "ai") {
                                                            let _ = crate::temporal::record_event(&conn, path, "created", Some(fact_str), None, Some(fact_id));
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }

                                    // Record contradiction events if any
                                    if let Some(contradictions) = meta.get("contradictions").and_then(|v| v.as_array()) {
                                        if !contradictions.is_empty() {
                                            if let Ok(conn) = db.lock() {
                                                let details = contradictions.iter()
                                                    .filter_map(|c| {
                                                        if let Some(obj) = c.as_object() {
                                                            let with_note = obj.get("with_note").and_then(|v| v.as_str()).unwrap_or("unknown");
                                                            let severity = obj.get("severity").and_then(|v| v.as_str()).unwrap_or("medium");
                                                            let desc = obj.get("description").and_then(|v| v.as_str()).unwrap_or("");
                                                            if desc.is_empty() { None } else {
                                                                Some(format!("[{}] {} — {}", severity, with_note, desc))
                                                            }
                                                        } else {
                                                            c.as_str().map(|s| s.to_string())
                                                        }
                                                    })
                                                    .collect::<Vec<_>>()
                                                    .join("; ");
                                                if !details.is_empty() {
                                                    let _ = crate::temporal::record_event(&conn, path, "contradicted", Some(&details), None, None);
                                                }
                                            }
                                        }
                                    }
                                }
                            }

                            if all_generated_blocks.is_empty() {
                                let fallback_block = "<!-- @generated -->\n**Note Type**: `permanent`\n<!-- /@generated -->";
                                all_generated_blocks.push(fallback_block.to_string());
                                pipeline_log::log_organize_warn(&format!(
                                    "No JSON parsed from LLM response for {} (response length: {} chars). Using fallback block.",
                                    path, response.len(),
                                ));
                            }

                            let merged = merge_generated_content(content, &all_generated_blocks);
                            let conflicts = crate::reconciler::detect_conflicts(path, content, &merged);

                            let final_content = if conflicts.is_empty() {
                                merged
                            } else {
                                let conflict_summary = conflicts.iter()
                                    .map(|c| format!("Section '{}' conflict between user and AI", c.section_heading))
                                    .collect::<Vec<_>>()
                                    .join("; ");
                                let _ = update_reconciliation_log(db, path, "conflict", &conflict_summary);
                                log::info!("Reconciliation conflict in {}: {}", path, conflict_summary);

                                if let Some(ref app_handle) = app {
                                    let _ = app_handle.emit("reconciliation-conflicts", serde_json::json!({
                                        "file_path": path,
                                        "conflicts": conflicts.iter().map(|c| serde_json::json!({
                                            "section_heading": c.section_heading,
                                            "user_content": c.user_content,
                                            "ai_content": c.ai_content,
                                        })).collect::<Vec<_>>(),
                                    }));
                                }

                                crate::reconciler::simple_merge(content, &merged, &conflicts)
                            };

                            if let Err(e) = crate::file_lock::safe_write(
                                &std::path::PathBuf::from(path),
                                &final_content,
                            ) {
                                pipeline_log::log_organize_error(&format!("Failed to write {}: {}", path, e));
                                let _ = update_reconciliation_log(db, path, "write_error", &e.to_string());
                            } else {
                                // BUG FIX (v2): After writing AI-modified content, the file's hash changes.
                                // We must update both files.hash and card_meta.last_reconciled_hash
                                // to the NEW hash. Use UPSERT (not UPDATE) because update_card_meta_from_response
                                // may not have been called if JSON parsing failed — in that case no card_meta
                                // row exists, and a plain UPDATE would silently affect 0 rows, leaving the
                                // note to be re-selected on every subsequent incremental run.
                                let mut hasher = Sha256::new();
                                hasher.update(final_content.as_bytes());
                                let new_hash = format!("{:x}", hasher.finalize());

                                if let Ok(conn) = db.lock() {
                                    // Update files.hash so syncVault won't re-chunk this file
                                    let _ = conn.execute(
                                        "UPDATE files SET hash = ?1 WHERE path = ?2",
                                        rusqlite::params![&new_hash, path],
                                    );
                                    // UPSERT card_meta: always create/update the row with new hash + methodology
                                    let _ = conn.execute(
                                        "INSERT INTO card_meta (file_path, last_reconciled, last_reconciled_hash, last_reconciled_methodology)
                                         VALUES (?1, datetime('now'), ?2, ?3)
                                         ON CONFLICT(file_path) DO UPDATE SET
                                            last_reconciled = datetime('now'),
                                            last_reconciled_hash = ?2,
                                            last_reconciled_methodology = ?3",
                                        rusqlite::params![path, &new_hash, &methodology],
                                    );
                                }

                                pipeline_log::log_organize_info(&format!(
                                    "Reconciled: {} ({} blocks, old_hash={}... new_hash={}...)",
                                    path, all_generated_blocks.len(),
                                    &task.file_hash[..8.min(task.file_hash.len())],
                                    &new_hash[..8.min(new_hash.len())],
                                ));
                                let _ = update_reconciliation_log(db, path, "reconciled", &format!("{} generated blocks written", all_generated_blocks.len()));
                                reconciled += 1;
                            }
                        }
                        Err(e) => {
                            pipeline_log::log_organize_warn(&format!("Unified organize failed for {}: {}", path, e));
                            let _ = update_reconciliation_log(db, path, "llm_error", &e.to_string());
                        }
                    }
                    processed += 1;
                }
            }
        }

        // Step 10: Precompute semantic edges for knowledge graph (KG-1)
        // Runs after note reconciliation so embeddings are up-to-date
        if processed > 0 {
            if let Ok(conn) = db.lock() {
                let changed_paths: Vec<String> = notes.iter().map(|(p, _, _, _)| p.clone()).collect();
                match search::compute_and_store_semantic_edges(&conn, Some(&changed_paths)) {
                    Ok(edge_count) => {
                        log::info!("KG-1: Precomputed {} semantic edges for {} changed notes", edge_count, changed_paths.len());
                        if let Some(ref app_handle) = app {
                            let _ = app_handle.emit("scheduler-progress", serde_json::json!({
                                "stage": "semantic_edges",
                                "message": format!("Updated {} semantic edges", edge_count),
                            }));
                        }
                    }
                    Err(e) => {
                        log::warn!("KG-1: Semantic edge precomputation failed: {}", e);
                    }
                }
                // Invalidate graph cache so next render picks up new edges/clusters
                search::invalidate_graph_cache(&conn);
            }
        }

        pipeline_log::log_organize_info(&format!(
            "Reconciliation finished: processed={}, reconciled={}, api_calls={}, skipped={}",
            processed, reconciled, api_calls, skipped_count,
        ));

        Ok((processed, reconciled, api_calls))
    }
}

/// Merge AI-generated blocks into original content.
fn merge_generated_content(original: &str, new_blocks: &[String]) -> String {
    let has_existing_generated = original.contains("<!-- @generated -->");

    if !has_existing_generated {
        let mut result = crate::frontmatter::sanitize_frontmatter(original);
        if !result.ends_with('\n') {
            result.push('\n');
        }
        result.push('\n');
        for block in new_blocks {
            result.push_str(block);
            result.push('\n');
        }
        return result;
    }

    let mut result = String::new();
    let mut in_user_block = false;
    let mut in_generated_block = false;
    let mut inserted_new = false;

    for line in original.lines() {
        if line.contains("<!-- @user -->") {
            in_user_block = true;
            result.push_str(line);
            result.push('\n');
            continue;
        }
        if line.contains("<!-- /@user -->") {
            in_user_block = false;
            result.push_str(line);
            result.push('\n');
            continue;
        }
        if in_user_block {
            result.push_str(line);
            result.push('\n');
            continue;
        }

        if line.contains("<!-- @generated -->") {
            in_generated_block = true;
            if !inserted_new {
                for block in new_blocks {
                    result.push_str(block);
                    result.push('\n');
                }
                inserted_new = true;
            }
            continue;
        }
        if line.contains("<!-- /@generated -->") {
            in_generated_block = false;
            continue;
        }
        if in_generated_block {
            continue;
        }

        result.push_str(line);
        result.push('\n');
    }

    crate::frontmatter::sanitize_frontmatter(&result)
}

/// Update reconciliation log.
fn update_reconciliation_log(
    db: &Arc<Mutex<Connection>>,
    path: &str,
    action: &str,
    summary: &str,
) -> anyhow::Result<()> {
    let conn = db.lock().map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
    conn.execute(
        "INSERT INTO reconciliation_log (file_path, action, diff_summary) VALUES (?1, ?2, ?3)",
        rusqlite::params![path, action, summary],
    )?;
    conn.execute(
        "INSERT INTO card_meta (file_path, last_reconciled)
         VALUES (?1, datetime('now'))
         ON CONFLICT(file_path) DO UPDATE SET last_reconciled = datetime('now')",
         rusqlite::params![path],
    )?;
    Ok(())
}

fn update_card_meta_skipped(
    db: &Arc<Mutex<Connection>>,
    path: &str,
    file_hash: &str,
    methodology: &str,
) -> anyhow::Result<()> {
    let conn = db.lock().map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
    conn.execute(
        "INSERT INTO card_meta (file_path, last_reconciled, last_reconciled_hash, last_reconciled_methodology)
         VALUES (?1, datetime('now'), ?2, ?3)
         ON CONFLICT(file_path) DO UPDATE SET
            last_reconciled = datetime('now'),
            last_reconciled_hash = ?2,
            last_reconciled_methodology = ?3",
        rusqlite::params![path, file_hash, methodology],
    )?;
    Ok(())
}

/// Map a relation type to its complementary reverse relation.
/// Used to automatically create bidirectional edges when the LLM suggests A → B.
/// This ensures both directions are explicitly in the database, improving
/// graph connectivity and local graph completeness.
fn reverse_relation(relation: &str) -> &str {
    match relation {
        "supports" => "supplementary",
        "contradicts" => "contradicts",
        "refines" => "supplementary",
        "supplementary" => "supplementary",
        "exemplifies" => "supports",
        "depends_on" => "supplementary",
        "supersedes" => "supplementary",
        _ => "supplementary",
    }
}

fn update_card_meta_from_response(
    db: &Arc<Mutex<Connection>>,
    path: &str,
    response: &str,
    file_hash: &str,
    methodology: &str,
) -> anyhow::Result<()> {
    if let Some(json_str) = extract_json(response) {
        if let Ok(meta) = serde_json::from_str::<serde_json::Value>(json_str) {
            let conn = db.lock().map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;

            let tags = meta.get("tags").and_then(|v| serde_json::to_string(v).ok());
            let links = meta.get("links").and_then(|v| serde_json::to_string(v).ok());
            let note_type = meta.get("note_type").and_then(|v| v.as_str()).map(|s| s.to_string());
            let contradictions = meta.get("contradictions").and_then(|v| serde_json::to_string(v).ok());

            conn.execute(
                "INSERT INTO card_meta (file_path, tags, links, contradictions, note_type, last_reconciled, last_reconciled_hash, last_reconciled_methodology)
                 VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'), ?6, ?7)
                 ON CONFLICT(file_path) DO UPDATE SET
                    tags = COALESCE(?2, tags),
                    links = COALESCE(?3, links),
                    contradictions = COALESCE(?4, contradictions),
                    note_type = COALESCE(?5, note_type),
                    last_reconciled = datetime('now'),
                    last_reconciled_hash = ?6,
                    last_reconciled_methodology = ?7",
                rusqlite::params![path, tags, links, contradictions, note_type, file_hash, methodology],
            )?;

            // Phase 4: Sync links to note_relations table
            if let Some(links_val) = meta.get("links") {
                if let Ok(parsed_links) = serde_json::from_value::<Vec<search::SuggestedLink>>(links_val.clone()) {
                    for link in &parsed_links {
                        let target = link.target();
                        let relation = link.relation().unwrap_or("related");
                        let reason = match link {
                            search::SuggestedLink::Detailed { reason, .. } => reason.as_deref().unwrap_or(""),
                            _ => "",
                        };
                        let conf = link.confidence();

                        let target_clean = target
                            .trim_start_matches("[[")
                            .trim_end_matches("]]")
                            .trim();
                        // Resolve title to actual file path (fixes note_relations JOIN accuracy), prioritizing the same vault
                        let target_path = schema::find_file_path_for_title_prioritized(&conn, target_clean, Some(path))
                            .unwrap_or_else(|| target_clean.to_string());
                        
                        let _ = conn.execute(
                            "INSERT OR IGNORE INTO note_relations (source_path, target_path, relation_type, confidence, reason)
                             VALUES (?1, ?2, ?3, ?4, ?5)",
                            rusqlite::params![
                                path,
                                target_path,
                                relation,
                                conf,
                                reason
                            ],
                        );

                        // Create bidirectional relation: also insert the reverse B → A.
                        // This ensures both directions are in the database, so when
                        // viewing note B's local graph, the connection to A is visible.
                        // The reverse relation type is derived from the forward relation.
                        let reverse_rel = reverse_relation(relation);
                        let _ = conn.execute(
                            "INSERT OR IGNORE INTO note_relations (source_path, target_path, relation_type, confidence, reason)
                             VALUES (?1, ?2, ?3, ?4, ?5)",
                            rusqlite::params![
                                target_path,
                                path,
                                reverse_rel,
                                conf,
                                format!("Auto-reverse of {}", relation),
                            ],
                        );
                    }
                }
            }
        }
    }

    Ok(())
}

/// Helper to extract JSON from AI response, supporting <json> tags first and falling back to brute force braces search.
fn extract_json(response: &str) -> Option<&str> {
    if let (Some(start), Some(end)) = (response.find("<json>"), response.rfind("</json>")) {
        Some(response[start + 6..end].trim())
    } else if let (Some(start), Some(end)) = (response.find('{'), response.rfind('}')) {
        Some(response[start..=end].trim())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[tokio::test]
    async fn print_reconciliation_log() {
        let app_data = std::env::var("APPDATA").unwrap();
        let db_path = std::path::PathBuf::from(app_data)
            .join("com.zettelagent.app")
            .join("zettelagent.db");
        println!("Opening DB at: {:?}", db_path);
        
        let conn = Connection::open(&db_path).unwrap();
        let mut stmt = conn.prepare("SELECT file_path, action, diff_summary, created_at FROM reconciliation_log ORDER BY id DESC LIMIT 20").unwrap();
        let mut rows = stmt.query([]).unwrap();
        while let Some(row) = rows.next().unwrap() {
            let path: String = row.get(0).unwrap();
            let action: String = row.get(1).unwrap();
            let summary: String = row.get(2).unwrap();
            let created_at: String = row.get(3).unwrap();
            println!("[{}] Path: {}, Action: {}, Summary: {}", created_at, path, action, summary);
        }
    }
}

