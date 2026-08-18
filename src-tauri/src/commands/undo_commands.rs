//! Whole-turn undo (Checkpoint / Rewind) + recycle-bin management.
//!
//! `note_snapshots` gives per-note version history; `agent_run_journal` groups every
//! file mutation of one agent turn so the turn can be rolled back as a unit.
//!
//! Scope is deliberately files-only: chat history is untouched and no LLM request is
//! replayed. Undoing a turn rewrites notes back, it does not rewind the conversation.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection};
use tauri::State;

use crate::error::ZettelError;
use crate::tools::internal_tools::helpers::{resolve_for_containment, strip_verbatim_prefix};
use crate::tools::internal_tools::note_ops::move_to_trash;
use crate::AppState;



/// The shape `AppState.db` has. Every piece of rollback logic below takes this rather
/// than `State<AppState>` so it stays unit-testable against an in-memory database.
type Db = Arc<Mutex<Connection>>;


/// The mechanical `[[wikilink]]` rewrites that `rename_note` / `merge_notes` fan out
/// across the whole vault are intentionally not journaled — one call can touch
/// hundreds of files and would swamp both the journal and the snapshot table.
const WIKILINK_WARNING: &str = "Mechanical [[wikilink]] replacements performed by rename_note / merge_notes were NOT rolled back — please check backlinks manually.\nrename_note / merge_notes 对全库 [[wikilink]] 的机械替换未回滚，可能需要手工检查反链。";

// ── Recycle-bin retention ───────────────────────────────────────────

/// `app_settings` key holding the user's retention window, in whole days.
const TRASH_RETENTION_SETTING_KEY: &str = "trash_retention_days";

/// Days a trashed batch survives before the automatic sweep may purge it.
///
/// 30 days is chosen to match what the OS recycle bins the user already has a
/// mental model for do (Windows Storage Sense and macOS "Erase items in Bin
/// after 30 days" both default to 30). It is also comfortably longer than the
/// "oh no, I deleted that last week" window that undo/rewind is meant to
/// cover, so the sweep can never race a plausible restore.
const DEFAULT_TRASH_RETENTION_DAYS: u32 = 30;

/// A retention value of `0` means *disabled*, not *purge everything*.
///
/// The literal reading ("older than 0 days") would wipe the entire recycle bin
/// on the next sweep, which is a catastrophic interpretation of a config value
/// a user could plausibly type by accident. A full wipe stays an explicit,
/// user-initiated `empty_trash(None)`.
const RETENTION_DISABLED: u32 = 0;

/// Upper bound on batch directories removed by one automatic sweep.
///
/// The sweep runs inline on the first `list_trash` of a vault, so it sits in
/// front of a UI interaction. A recycle bin that accumulated thousands of
/// batches must not turn that into a multi-second `remove_dir_all` storm —
/// whatever is left over is simply purged by the next sweep.
const MAX_BATCHES_PER_SWEEP: usize = 64;


// ── Response types ──────────────────────────────────────────────────

/// One agent turn that touched files, newest first.
#[derive(serde::Serialize)]
pub struct AgentRunSummary {
    pub run_id: String,
    pub started_at_ms: i64,
    pub change_count: u32,
    /// True only when *every* journal entry of the run is already rolled back.
    pub undone: bool,
    /// Distinct paths this run changed, capped at 10 for display.
    pub affected_paths: Vec<String>,
}

/// Outcome of a rollback attempt. Partial success is normal and reported, not hidden:
/// a single unrecoverable entry never aborts the rest of the batch.
#[derive(serde::Serialize)]
pub struct UndoReport {
    pub run_id: String,
    /// Entries rolled back successfully during this call.
    pub restored: u32,
    /// Human-readable reason per entry that could not be rolled back.
    pub failed: Vec<String>,
    /// Files moved into the recycle bin (undo of a `create`).
    pub trashed: Vec<String>,
    /// Entries skipped because a previous call already undid them.
    pub skipped_already_undone: u32,
    /// Paths re-synced into the DB index after the rollback.
    pub reindexed: u32,
    /// Caveats the user should read — always carries the wikilink note.
    pub warnings: Vec<String>,
}

/// One file sitting in `<vault>/.zettelagent/trash/`.
#[derive(serde::Serialize)]
pub struct TrashEntry {
    /// Vault-relative location inside the recycle bin, forward slashes.
    pub trash_path: String,
    /// Where it came from, relative to the vault root.
    pub original_relative_path: String,
    /// The `YYYYMMDD-HHMMSS` batch stamp it was deleted in.
    pub deleted_at: String,
    pub size: u64,
}

// ── Journal row (internal) ──────────────────────────────────────────

struct JournalEntry {
    id: i64,
    seq: i64,
    tool_name: String,
    op: String,
    file_path: String,
    new_path: Option<String>,
    snapshot_id: Option<i64>,
    trash_path: Option<String>,
    undone: bool,
}

/// What one rolled-back entry did, for the report and the re-index pass.
#[derive(Default)]
struct UndoOutcome {
    trashed: Option<String>,
    touched: Vec<PathBuf>,
}

// ── A5: list_agent_runs ─────────────────────────────────────────────

/// List agent turns that changed files, newest first. `limit` defaults to 20.
#[tauri::command]
pub fn list_agent_runs(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<AgentRunSummary>, ZettelError> {
    list_agent_runs_impl(&state.db, limit)
}

fn list_agent_runs_impl(db: &Db, limit: Option<u32>) -> Result<Vec<AgentRunSummary>, ZettelError> {
    let cap = limit.unwrap_or(20).clamp(1, 500);
    let conn = db.lock()?;

    let mut stmt = conn.prepare(
        "SELECT run_id, MIN(created_at_ms) AS started, COUNT(*) AS n, MIN(undone) AS all_undone
         FROM agent_run_journal
         GROUP BY run_id
         ORDER BY started DESC
         LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![cap], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
        ))
    })?;

    let mut runs: Vec<(String, i64, i64, i64)> = Vec::new();
    for row in rows {
        runs.push(row?);
    }
    drop(stmt);

    let mut out = Vec::with_capacity(runs.len());
    for (run_id, started_at_ms, change_count, all_undone) in runs {
        let mut path_stmt = conn.prepare(
            "SELECT DISTINCT file_path FROM agent_run_journal WHERE run_id = ?1 ORDER BY seq LIMIT 10",
        )?;
        let paths = path_stmt
            .query_map(params![&run_id], |row| row.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();

        out.push(AgentRunSummary {
            run_id,
            started_at_ms,
            change_count: change_count as u32,
            // MIN(undone) == 1 means no entry is left to roll back.
            undone: all_undone == 1,
            affected_paths: paths,
        });
    }

    Ok(out)
}

// ── A5: undo_agent_run ──────────────────────────────────────────────

/// Roll back every file change of `run_id`, newest change first.
///
/// Reverse `seq` order matters: a turn that edited then renamed a note must undo the
/// rename before the content write, otherwise the write would land on a path that no
/// longer exists.
///
/// Idempotent — entries already marked `undone` are counted and skipped, so calling
/// this twice is safe and the second call reports zero restores rather than failing.
#[tauri::command]
pub fn undo_agent_run(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<UndoReport, ZettelError> {
    undo_agent_run_impl(&state.db, &run_id)
}

fn undo_agent_run_impl(db: &Db, run_id: &str) -> Result<UndoReport, ZettelError> {
    let entries = load_journal_entries(db, run_id)?;

    if entries.is_empty() {
        return Err(ZettelError::System(format!(
            "No recorded changes for run {}",
            run_id
        )));
    }

    let mut report = UndoReport {
        run_id: run_id.to_string(),
        restored: 0,
        failed: Vec::new(),
        trashed: Vec::new(),
        skipped_already_undone: 0,
        reindexed: 0,
        warnings: vec![WIKILINK_WARNING.to_string()],
    };

    // Paths whose on-disk state changed and therefore need re-indexing afterwards.
    let mut touched: Vec<PathBuf> = Vec::new();

    for entry in &entries {
        if entry.undone {
            report.skipped_already_undone += 1;
            continue;
        }

        match undo_one(db, entry) {
            Ok(outcome) => {
                report.restored += 1;
                if let Some(trashed) = outcome.trashed {
                    report.trashed.push(trashed);
                }
                touched.extend(outcome.touched);
                mark_undone(db, entry.id);
            }
            // A single unrecoverable entry must not strand the rest: partial recovery
            // is worth more than none, and the user gets told exactly what to fix.
            Err(e) => report.failed.push(format!(
                "seq {} ({} {} on {}): {}",
                entry.seq, entry.tool_name, entry.op, entry.file_path, e
            )),
        }
    }

    report.reindexed = reindex_paths(db, &touched);

    log::info!(
        "undo_agent_run {}: restored={} failed={} skipped={} reindexed={}",
        run_id,
        report.restored,
        report.failed.len(),
        report.skipped_already_undone,
        report.reindexed
    );

    Ok(report)
}

// ── Rollback internals ──────────────────────────────────────────────

/// Load all journal rows for a run in reverse `seq` order (newest change first).
fn load_journal_entries(
    db: &Db,
    run_id: &str,
) -> Result<Vec<JournalEntry>, ZettelError> {
    let conn = db.lock()?;
    let mut stmt = conn.prepare(
        "SELECT id, seq, tool_name, op, file_path, new_path, snapshot_id, trash_path, undone
         FROM agent_run_journal
         WHERE run_id = ?1
         ORDER BY seq DESC",
    )?;
    let rows = stmt.query_map(params![run_id], |row| {
        Ok(JournalEntry {
            id: row.get(0)?,
            seq: row.get(1)?,
            tool_name: row.get(2)?,
            op: row.get(3)?,
            file_path: row.get(4)?,
            new_path: row.get(5)?,
            snapshot_id: row.get(6)?,
            trash_path: row.get(7)?,
            undone: row.get::<_, i64>(8)? != 0,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Roll back a single journal entry. Never touches the `undone` flag — the caller
/// only flips it after this returns `Ok`, so a mid-way failure leaves the row
/// replayable.
fn undo_one(
    db: &Db,
    entry: &JournalEntry,
) -> Result<UndoOutcome, ZettelError> {
    let mut outcome = UndoOutcome::default();
    let target = PathBuf::from(&entry.file_path);

    match entry.op.as_str() {
        "write" => {
            let snapshot_id = entry.snapshot_id.ok_or_else(|| {
                ZettelError::System("write entry has no snapshot to restore".to_string())
            })?;
            let content = snapshot_content(db, snapshot_id)?;
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            crate::file_lock::safe_write(&target, &content)
                .map_err(|e| ZettelError::System(e.to_string()))?;
            outcome.touched.push(target);
        }
        "create" => {
            // Undo a create by trashing the file — never a hard delete, so a mis-fired
            // undo is itself recoverable from the recycle bin.
            if target.exists() {
                let vault =
                    crate::tools::internal_tools::helpers::infer_vault_root(&target);
                let trashed = move_to_trash(&vault, &target)
                    .map_err(|e| ZettelError::System(e.to_string()))?;
                outcome.trashed = Some(trashed.to_string_lossy().to_string());
            }
            outcome.touched.push(target);
        }
        "delete" => {
            let trash_path = entry.trash_path.as_ref().ok_or_else(|| {
                ZettelError::System("delete entry has no trash_path".to_string())
            })?;
            let from = PathBuf::from(trash_path);
            if !from.exists() {
                return Err(ZettelError::System(format!(
                    "trashed file no longer exists: {}",
                    trash_path
                )));
            }
            // The original parent directory may have been removed since deletion.
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            move_file(&from, &target)?;
            outcome.touched.push(target);
        }
        "rename" => {
            let new_path = entry.new_path.as_ref().ok_or_else(|| {
                ZettelError::System("rename entry has no new_path".to_string())
            })?;
            let current = PathBuf::from(new_path);
            if !current.exists() {
                return Err(ZettelError::System(format!(
                    "renamed file no longer at {}",
                    new_path
                )));
            }
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            move_file(&current, &target)?;
            // Both endpoints changed on disk.
            outcome.touched.push(current);
            outcome.touched.push(target);
        }
        other => {
            return Err(ZettelError::System(format!("unknown op '{}'", other)));
        }
    }

    // `seq` is only read for the failure message in `undo_agent_run`.
    Ok(outcome)
}

/// Fetch the stored pre-image body for a snapshot id.
fn snapshot_content(db: &Db, snapshot_id: i64) -> Result<String, ZettelError> {
    let conn = db.lock()?;
    conn.query_row(
        "SELECT content FROM note_snapshots WHERE id = ?1",
        params![snapshot_id],
        |row| row.get::<_, String>(0),
    )
    .map_err(|_| ZettelError::System(format!("snapshot #{} is gone", snapshot_id)))
}

/// Move a file, falling back to copy+delete across volume boundaries (same tactic as
/// `move_to_trash`). Refuses to clobber an existing destination.
fn move_file(from: &Path, to: &Path) -> Result<(), ZettelError> {
    if to.exists() {
        return Err(ZettelError::System(format!(
            "destination already exists: {}",
            to.display()
        )));
    }
    if std::fs::rename(from, to).is_err() {
        std::fs::copy(from, to)?;
        std::fs::remove_file(from)?;
    }
    Ok(())
}

/// Flip a single journal row to `undone = 1`. Best-effort: a failure here only means
/// the same entry may be replayed on a later undo (which is itself idempotent).
fn mark_undone(db: &Db, id: i64) {
    if let Ok(conn) = db.lock() {
        let _ = conn.execute(
            "UPDATE agent_run_journal SET undone = 1 WHERE id = ?1",
            params![id],
        );
    }
}

/// Re-sync the DB index to match disk for every path the rollback touched.
///
/// Reuses `db::sync::sync_file` (the same path the scheduler/watcher use) rather than
/// re-implementing chunking. A path that no longer exists on disk (undo of a create)
/// gets its stale rows pruned instead.
fn reindex_paths(db: &Db, paths: &[PathBuf]) -> u32 {
    let mut seen = std::collections::HashSet::new();
    let mut count = 0u32;
    let conn = match db.lock() {
        Ok(c) => c,
        Err(_) => return 0,
    };
    for path in paths {
        if !seen.insert(path.clone()) {
            continue;
        }
        if path.exists() {
            match crate::db::sync::sync_file(&conn, path) {
                Ok(_) => count += 1,
                Err(e) => log::warn!("undo reindex: sync_file {} failed: {}", path.display(), e),
            }
        } else {
            // File is gone (create was undone): drop its index rows.
            let key = strip_verbatim_prefix(&path.to_string_lossy());
            let _ = conn.execute("DELETE FROM files WHERE path = ?1", params![key]);
            let _ = conn.execute("DELETE FROM chunks WHERE file_path = ?1", params![key]);
            let _ = conn.execute(
                "DELETE FROM files WHERE path = ?1",
                params![path.to_string_lossy()],
            );
        }
    }
    crate::db::search::invalidate_graph_cache(&conn);
    count
}

// ── B2: recycle-bin management ──────────────────────────────────────

/// `<vault>/.zettelagent/trash`
fn trash_root(vault: &Path) -> PathBuf {
    vault.join(".zettelagent").join("trash")
}

/// Resolve a caller-supplied trash path and prove it really lives under the vault's
/// recycle bin.
///
/// Without this check `restore_from_trash` / `empty_trash` would be a generic
/// "move or delete any file on disk" endpoint: both take a path straight from the
/// frontend. `resolve_for_containment` is required rather than bare `starts_with`
/// because the latter compares components and would happily accept `trash/../../..`.
fn resolve_inside_trash(vault: &Path, candidate: &str) -> Result<PathBuf, ZettelError> {
    let raw = Path::new(candidate);
    let joined = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        vault.join(raw)
    };

    let root = resolve_for_containment(&trash_root(vault));
    let resolved = resolve_for_containment(&joined);

    if !resolved.starts_with(&root) || resolved == root {
        return Err(ZettelError::System(format!(
            "Access denied: '{}' is not inside the vault recycle bin",
            candidate
        )));
    }
    Ok(joined)
}

/// List everything currently in the vault's recycle bin, newest batch first.
///
/// This is also the hook point for the automatic retention sweep: the first
/// time a given vault's trash is listed in this process, batches older than the
/// configured window are purged inline (bounded by `MAX_BATCHES_PER_SWEEP`).
/// Piggy-backing on an action the user already triggers avoids introducing a
/// second scheduler — the app already has one and running two would be a
/// maintenance trap.
#[tauri::command]
pub fn list_trash(
    state: State<'_, AppState>,
    vault_path: String,
) -> Result<Vec<TrashEntry>, ZettelError> {
    maybe_sweep_trash(&state.db, &vault_path);
    list_trash_impl(&vault_path)
}

/// Run the retention sweep at most once per vault per process launch.
///
/// The guard is a process-global set so opening the trash panel repeatedly in
/// one session doesn't re-scan the directory each time; the next app launch
/// gets a fresh sweep. Failures here are deliberately swallowed — an
/// unreachable settings row or a locked file must never block listing the bin.
fn maybe_sweep_trash(db: &Db, vault_path: &str) {
    use std::collections::HashSet;
    use std::sync::OnceLock;
    static SWEPT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let swept = SWEPT.get_or_init(|| Mutex::new(HashSet::new()));

    {
        let mut set = match swept.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if !set.insert(vault_path.to_string()) {
            return; // already swept this vault in this session
        }
    }

    let retention = read_retention_days(db);
    if retention == RETENTION_DISABLED {
        return;
    }
    match sweep_expired_trash_impl(vault_path, retention, MAX_BATCHES_PER_SWEEP) {
        Ok(n) if n > 0 => log::info!("trash sweep purged {} expired file(s)", n),
        Ok(_) => {}
        Err(e) => log::warn!("trash sweep skipped: {}", e),
    }
}

/// Read the retention window from `app_settings`, falling back to the default.
/// A malformed or absent value is treated as the default, never as `0`
/// (disabled) — a corrupt row must not silently switch retention off.
fn read_retention_days(db: &Db) -> u32 {
    let conn = match db.lock() {
        Ok(c) => c,
        Err(p) => p.into_inner(),
    };
    match crate::db::schema::get_setting(&conn, TRASH_RETENTION_SETTING_KEY) {
        Ok(Some(raw)) => raw.trim().parse::<u32>().unwrap_or(DEFAULT_TRASH_RETENTION_DAYS),
        _ => DEFAULT_TRASH_RETENTION_DAYS,
    }
}

/// The user-configurable retention window. `0` disables the automatic sweep.
#[tauri::command]
pub fn get_trash_retention_days(state: State<'_, AppState>) -> Result<u32, ZettelError> {
    Ok(read_retention_days(&state.db))
}

/// Persist the retention window (whole days; `0` disables the sweep).
#[tauri::command]
pub fn set_trash_retention_days(
    state: State<'_, AppState>,
    days: u32,
) -> Result<(), ZettelError> {
    let conn = state
        .db
        .lock()
        .map_err(|_| ZettelError::System("db lock poisoned".to_string()))?;
    crate::db::schema::set_setting(&conn, TRASH_RETENTION_SETTING_KEY, &days.to_string())
        .map_err(|e| ZettelError::System(e.to_string()))?;
    Ok(())
}

/// Purge trash batches strictly older than `retention_days`, newest-first, up to
/// `max_batches` directories.
///
/// Conservative by construction:
/// * A batch whose stamp is unparseable is **kept**, never guessed at.
/// * Only whole batch directories are removed; a partially-expired batch does
///   not exist because every file in a batch shares one deletion timestamp.
/// * `retention_days == 0` is rejected as a guard against an accidental
///   "purge everything" — the caller (`maybe_sweep_trash`) already screens it,
///   this is defence in depth.
fn sweep_expired_trash_impl(
    vault_path: &str,
    retention_days: u32,
    max_batches: usize,
) -> Result<u32, ZettelError> {
    if retention_days == RETENTION_DISABLED {
        return Ok(0);
    }
    let vault = PathBuf::from(vault_path);
    let root = trash_root(&vault);
    if !root.is_dir() {
        return Ok(0);
    }

    let cutoff_ms =
        chrono::Utc::now().timestamp_millis() - (retention_days as i64) * 24 * 60 * 60 * 1000;

    // Oldest batches first so a bounded sweep always attacks the most-expired
    // directories rather than an arbitrary slice.
    let mut batches: Vec<PathBuf> = std::fs::read_dir(&root)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    batches.sort();

    let mut removed = 0u32;
    let mut swept = 0usize;
    for batch in batches {
        if swept >= max_batches {
            break;
        }
        let name = match batch.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        // Unparseable stamp ⇒ keep. We never delete a batch we can't date.
        let batch_ms = match parse_stamp_ms(name) {
            Some(ms) => ms,
            None => continue,
        };
        if batch_ms >= cutoff_ms {
            continue; // not yet expired
        }

        let mut files = Vec::new();
        collect_files(&batch, &mut files);
        let file_count = files.len() as u32;
        if std::fs::remove_dir_all(&batch).is_ok() {
            removed += file_count;
            swept += 1;
        }
    }

    Ok(removed)
}

/// Empty the recycle bin, or just the batches older than `older_than_days`.

fn list_trash_impl(vault_path: &str) -> Result<Vec<TrashEntry>, ZettelError> {
    let vault = PathBuf::from(&vault_path);
    let root = trash_root(&vault);
    if !root.is_dir() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    let mut batches: Vec<PathBuf> = std::fs::read_dir(&root)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    // Directory names are `YYYYMMDD-HHMMSS`, so lexical order is chronological.
    batches.sort();
    batches.reverse();

    for batch in batches {
        let stamp = batch
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let mut files = Vec::new();
        collect_files(&batch, &mut files);
        for file in files {
            let size = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
            let trash_rel = file
                .strip_prefix(&vault)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| file.to_string_lossy().replace('\\', "/"));
            let original_rel = file
                .strip_prefix(&batch)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            entries.push(TrashEntry {
                trash_path: trash_rel,
                original_relative_path: original_rel,
                deleted_at: stamp.clone(),
                size,
            });
        }
    }

    Ok(entries)
}

/// Recursively gather every regular file below `dir`.
fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) {
    if let Ok(read) = std::fs::read_dir(dir) {
        for entry in read.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_files(&path, out);
            } else if path.is_file() {
                out.push(path);
            }
        }
    }
}

/// Restore one trashed file back to its original location within the vault.
///
/// Returns the restored absolute path. Refuses to overwrite: if a file already sits
/// at the original location the caller gets an explicit error rather than a silent
/// clobber.
#[tauri::command]
pub fn restore_from_trash(
    state: State<'_, AppState>,
    vault_path: String,
    trash_path: String,
) -> Result<String, ZettelError> {
    restore_from_trash_impl(Some(&state.db), &vault_path, &trash_path)
}

fn restore_from_trash_impl(
    db: Option<&Db>,
    vault_path: &str,
    trash_path: &str,
) -> Result<String, ZettelError> {
    let vault = PathBuf::from(&vault_path);
    let source = resolve_inside_trash(&vault, &trash_path)?;

    if !source.is_file() {
        return Err(ZettelError::System(format!(
            "Trashed file not found: {}",
            trash_path
        )));
    }

    // Reconstruct the original location: strip the `.zettelagent/trash/<stamp>/` prefix
    // and re-root the remainder at the vault. That relative tail is exactly what
    // `move_to_trash` preserved.
    let root = resolve_for_containment(&trash_root(&vault));
    let resolved = resolve_for_containment(&source);
    let after_root = resolved
        .strip_prefix(&root)
        .map_err(|_| ZettelError::System("Path escaped the recycle bin".to_string()))?;

    // Drop the leading `<stamp>` batch component.
    let mut comps = after_root.components();
    comps.next();
    let original_rel: PathBuf = comps.as_path().to_path_buf();
    if original_rel.as_os_str().is_empty() {
        return Err(ZettelError::System(
            "Could not determine original path for the trashed file".to_string(),
        ));
    }

    let destination = vault.join(&original_rel);
    if destination.exists() {
        return Err(ZettelError::System(format!(
            "A file already exists at the original location: {}. Restore aborted to avoid overwriting.",
            original_rel.to_string_lossy()
        )));
    }

    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)?;
    }
    move_file(&source, &destination)?;

    // Bring the DB index back in step with disk.
    if let Some(db) = db {
        if let Ok(conn) = db.lock() {
            if let Err(e) = crate::db::sync::sync_file(&conn, &destination) {
                log::warn!("restore_from_trash: reindex failed: {}", e);
            }
            crate::db::search::invalidate_graph_cache(&conn);
        }
    }

    Ok(destination.to_string_lossy().to_string())
}

/// Empty the recycle bin, or just the batches older than `older_than_days`.
///
/// Returns the number of files removed. `older_than_days = None` clears everything.
#[tauri::command]
pub fn empty_trash(
    _state: State<'_, AppState>,
    vault_path: String,
    older_than_days: Option<u32>,
) -> Result<u32, ZettelError> {
    empty_trash_impl(&vault_path, older_than_days)
}

fn empty_trash_impl(vault_path: &str, older_than_days: Option<u32>) -> Result<u32, ZettelError> {
    let vault = PathBuf::from(&vault_path);
    let root = trash_root(&vault);
    if !root.is_dir() {
        return Ok(0);
    }

    let cutoff_ms = older_than_days.map(|days| {
        chrono::Utc::now().timestamp_millis() - (days as i64) * 24 * 60 * 60 * 1000
    });

    let mut removed = 0u32;
    for entry in std::fs::read_dir(&root)?.filter_map(|e| e.ok()) {
        let batch = entry.path();
        if !batch.is_dir() {
            continue;
        }

        // A batch's age comes from its `YYYYMMDD-HHMMSS` name, not fs mtime (which a
        // cloud-sync client can rewrite).
        if let Some(cutoff) = cutoff_ms {
            if let Some(name) = batch.file_name().and_then(|n| n.to_str()) {
                if let Some(batch_ms) = parse_stamp_ms(name) {
                    if batch_ms >= cutoff {
                        continue; // too recent to purge
                    }
                }
            }
        }

        let mut files = Vec::new();
        collect_files(&batch, &mut files);
        let file_count = files.len() as u32;
        if std::fs::remove_dir_all(&batch).is_ok() {
            removed += file_count;
        }
    }

    Ok(removed)
}

/// Parse a `YYYYMMDD-HHMMSS` trash-batch stamp into epoch millis (local time).
/// Parse a `YYYYMMDD-HHMMSS` trash-batch stamp into epoch millis (local time).
fn parse_stamp_ms(stamp: &str) -> Option<i64> {
    use chrono::TimeZone;
    let naive = chrono::NaiveDateTime::parse_from_str(stamp, "%Y%m%d-%H%M%S").ok()?;
    match chrono::Local.from_local_datetime(&naive) {
        chrono::LocalResult::Single(dt) => Some(dt.timestamp_millis()),
        chrono::LocalResult::Ambiguous(dt, _) => Some(dt.timestamp_millis()),
        chrono::LocalResult::None => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::internal_tools::helpers::{
        journal_write, snapshot_before_write, snapshot_path_key,
    };

    /// `setup_database_schema` builds `vec0` virtual tables, so the extension has to be
    /// registered before the connection is opened (repo-wide convention).
    fn mem_db() -> Db {
        crate::db::register_sqlite_vec();
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::setup_database_schema(&conn).unwrap();
        Arc::new(Mutex::new(conn))
    }

    /// The ambient run id is process-global, so tests that touch it must not overlap.
    fn run_id_guard() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|p| p.into_inner())
    }

    /// Unique scratch vault — tests run in parallel in the same process. The
    /// `.zettelagent` marker makes `infer_vault_root` resolve to this directory.
    fn temp_vault(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "zettel_undo_{}_{}_{}",
            tag,
            std::process::id(),
            nanos
        ));
        std::fs::create_dir_all(dir.join(".zettelagent")).unwrap();
        std::fs::create_dir_all(dir.join("notes")).unwrap();
        dir
    }

    /// Insert a journal row directly, bypassing the ambient run id. Keeps most tests
    /// free of the process-global slot.
    #[allow(clippy::too_many_arguments)]
    fn add_row(
        db: &Db,
        run_id: &str,
        seq: i64,
        tool: &str,
        op: &str,
        file_path: &str,
        new_path: Option<&str>,
        snapshot_id: Option<i64>,
        trash_path: Option<&str>,
    ) {
        let conn = db.lock().unwrap();
        conn.execute(
            "INSERT INTO agent_run_journal
                (run_id, seq, tool_name, op, file_path, new_path, snapshot_id, trash_path, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![run_id, seq, tool, op, file_path, new_path, snapshot_id, trash_path, 1_700_000_000_000i64],
        )
        .unwrap();
    }

    // ── Test 1: snapshot id round-trip incl. de-dup ────────────────
    #[test]
    fn snapshot_before_write_returns_id_and_reuses_it_on_dedup() {
        let db = mem_db();
        let vault = temp_vault("snapid");
        let note = vault.join("notes").join("a.md");
        std::fs::write(&note, "第一版内容").unwrap();

        let first = snapshot_before_write(&db, &note).unwrap();
        assert!(first.is_some(), "an existing file must yield a snapshot id");

        // Same on-disk content ⇒ de-duplicated, but the SAME id must come back so the
        // journal still has a valid restore point (not None).
        let second = snapshot_before_write(&db, &note).unwrap();
        assert_eq!(second, first, "de-dup must reuse the existing snapshot id");

        let _ = std::fs::remove_dir_all(&vault);
    }

    // ── Test 2: journaling honours the ambient run id ──────────────
    #[test]
    fn journal_write_skips_without_run_id_then_increments_seq() {
        let _guard = run_id_guard();
        let db = mem_db();

        // No active run: nothing is recorded.
        crate::llm::tool_hooks::clear_current_run_id();
        journal_write(&db, "edit_note", "write", "K", None, None, None);
        let n0: i64 = db
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM agent_run_journal", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n0, 0, "writes outside a run must not be journaled");

        // With a run set: rows land and seq increments.
        crate::llm::tool_hooks::set_current_run_id("run-xyz");
        journal_write(&db, "edit_note", "write", "K", None, None, None);
        journal_write(&db, "edit_note", "write", "K", None, None, None);
        crate::llm::tool_hooks::clear_current_run_id();

        let seqs: Vec<i64> = {
            let conn = db.lock().unwrap();
            let mut stmt = conn
                .prepare("SELECT seq FROM agent_run_journal WHERE run_id='run-xyz' ORDER BY seq")
                .unwrap();
            let rows = stmt.query_map([], |r| r.get(0)).unwrap();
            rows.filter_map(|r| r.ok()).collect()
        };
        assert_eq!(seqs, vec![1, 2], "seq must increment per run");
    }

    // ── Test 3: undo a content write ───────────────────────────────
    #[test]
    fn undo_write_restores_the_previous_body() {
        let db = mem_db();
        let vault = temp_vault("undowrite");
        let note = vault.join("notes").join("笔记.md");
        let before = "# 标题\n\n原始的中文正文。\n";
        std::fs::write(&note, before).unwrap();

        let snapshot_id = snapshot_before_write(&db, &note).unwrap().unwrap();
        std::fs::write(&note, "被 Agent 改写的内容").unwrap();

        add_row(
            &db,
            "r-write",
            1,
            "edit_note",
            "write",
            &snapshot_path_key(&note),
            None,
            Some(snapshot_id),
            None,
        );

        let report = undo_agent_run_impl(&db, "r-write").unwrap();
        assert_eq!(report.restored, 1);
        assert!(report.failed.is_empty(), "unexpected failures: {:?}", report.failed);
        assert_eq!(std::fs::read_to_string(&note).unwrap(), before);

        let _ = std::fs::remove_dir_all(&vault);
    }

    // ── Test 4: undo a create ──────────────────────────────────────
    #[test]
    fn undo_create_trashes_the_new_file() {
        let db = mem_db();
        let vault = temp_vault("undocreate");
        let note = vault.join("notes").join("新建.md");
        std::fs::write(&note, "Agent 新建的内容").unwrap();
        let key = snapshot_path_key(&note);

        add_row(&db, "r-create", 1, "create_note", "create", &key, None, None, None);

        let report = undo_agent_run_impl(&db, "r-create").unwrap();
        assert_eq!(report.restored, 1);
        assert!(!note.exists(), "the created note must be gone from its path");
        assert_eq!(report.trashed.len(), 1, "and must be recoverable from the trash");

        let trashed = PathBuf::from(&report.trashed[0]);
        assert!(trashed.exists());
        let rel = trashed.strip_prefix(&vault).unwrap().to_string_lossy().replace('\\', "/");
        assert!(rel.starts_with(".zettelagent/trash/"), "unexpected trash path: {}", rel);

        let _ = std::fs::remove_dir_all(&vault);
    }

    // ── Test 5: undo a delete ──────────────────────────────────────
    #[test]
    fn undo_delete_moves_the_note_back_from_the_trash() {
        let db = mem_db();
        let vault = temp_vault("undodelete");
        let note = vault.join("notes").join("待删除.md");
        let body = "# 待删除\n\n中文正文内容。\n";
        std::fs::write(&note, body).unwrap();

        let key = snapshot_path_key(&note);
        let snapshot_id = snapshot_before_write(&db, &note).unwrap().unwrap();
        let trashed = move_to_trash(&vault, &note).unwrap();
        assert!(!note.exists());

        add_row(
            &db,
            "r-delete",
            1,
            "delete_note",
            "delete",
            &key,
            None,
            Some(snapshot_id),
            Some(&trashed.to_string_lossy()),
        );

        let report = undo_agent_run_impl(&db, "r-delete").unwrap();
        assert_eq!(report.restored, 1, "failures: {:?}", report.failed);
        assert!(note.exists(), "the note must be back at its original path");
        assert_eq!(std::fs::read_to_string(&note).unwrap(), body);
        assert!(!trashed.exists(), "and must no longer sit in the trash");

        let _ = std::fs::remove_dir_all(&vault);
    }

    // ── Test 6: undo a rename ──────────────────────────────────────
    #[test]
    fn undo_rename_restores_the_old_name() {
        let db = mem_db();
        let vault = temp_vault("undorename");
        let old = vault.join("notes").join("旧名.md");
        let new = vault.join("notes").join("新名.md");
        std::fs::write(&old, "内容不变").unwrap();

        let old_key = snapshot_path_key(&old);
        std::fs::rename(&old, &new).unwrap();
        let new_key = snapshot_path_key(&new);

        add_row(
            &db,
            "r-rename",
            1,
            "rename_note",
            "rename",
            &old_key,
            Some(&new_key),
            None,
            None,
        );

        let report = undo_agent_run_impl(&db, "r-rename").unwrap();
        assert_eq!(report.restored, 1, "failures: {:?}", report.failed);
        assert!(old.exists(), "the old name must be back");
        assert!(!new.exists(), "the new name must be gone");
        assert_eq!(std::fs::read_to_string(&old).unwrap(), "内容不变");

        let _ = std::fs::remove_dir_all(&vault);
    }

    // ── Test 7: undo is idempotent ─────────────────────────────────
    #[test]
    fn undoing_the_same_run_twice_is_a_no_op_the_second_time() {
        let db = mem_db();
        let vault = temp_vault("idempotent");
        let note = vault.join("notes").join("幂等.md");
        let before = "原始内容";
        std::fs::write(&note, before).unwrap();

        let snapshot_id = snapshot_before_write(&db, &note).unwrap().unwrap();
        std::fs::write(&note, "改写后的内容").unwrap();
        add_row(
            &db,
            "r-idem",
            1,
            "edit_note",
            "write",
            &snapshot_path_key(&note),
            None,
            Some(snapshot_id),
            None,
        );

        let first = undo_agent_run_impl(&db, "r-idem").unwrap();
        assert_eq!(first.restored, 1);
        assert_eq!(first.skipped_already_undone, 0);

        let second = undo_agent_run_impl(&db, "r-idem").unwrap();
        assert_eq!(second.restored, 0, "nothing left to restore");
        assert_eq!(second.skipped_already_undone, 1, "and the report says so");
        assert!(second.failed.is_empty());
        assert_eq!(std::fs::read_to_string(&note).unwrap(), before);

        // The run also reads back as fully undone.
        let runs = list_agent_runs_impl(&db, Some(10)).unwrap();
        let run = runs.iter().find(|r| r.run_id == "r-idem").unwrap();
        assert!(run.undone);
        assert_eq!(run.change_count, 1);

        let _ = std::fs::remove_dir_all(&vault);
    }

    // ── Test 8: one bad entry must not strand the batch ────────────
    #[test]
    fn a_failing_entry_does_not_abort_the_rest_of_the_batch() {
        let db = mem_db();
        let vault = temp_vault("partial");
        let note = vault.join("notes").join("正常.md");
        let before = "可恢复的原始内容";
        std::fs::write(&note, before).unwrap();
        let snapshot_id = snapshot_before_write(&db, &note).unwrap().unwrap();
        std::fs::write(&note, "被改坏了").unwrap();

        // seq 1 = recoverable write, seq 2 = rename whose new_path never existed.
        add_row(
            &db,
            "r-partial",
            1,
            "edit_note",
            "write",
            &snapshot_path_key(&note),
            None,
            Some(snapshot_id),
            None,
        );
        let ghost = vault.join("notes").join("不存在.md");
        add_row(
            &db,
            "r-partial",
            2,
            "rename_note",
            "rename",
            &vault.join("notes").join("原名.md").to_string_lossy(),
            Some(&ghost.to_string_lossy()),
            None,
            None,
        );

        let report = undo_agent_run_impl(&db, "r-partial").unwrap();
        assert_eq!(report.failed.len(), 1, "the broken rename must be reported");
        assert_eq!(report.restored, 1, "the healthy write must still be rolled back");
        assert_eq!(std::fs::read_to_string(&note).unwrap(), before);

        let _ = std::fs::remove_dir_all(&vault);
    }

    // ── Test 9: trash management happy paths ───────────────────────
    #[test]
    fn list_restore_and_empty_trash_happy_paths() {
        let vault = temp_vault("trashmgmt");
        let note = vault.join("notes").join("回收.md");
        let body = "# 回收\n\n要进回收站的中文内容。\n";
        std::fs::write(&note, body).unwrap();

        let trashed = move_to_trash(&vault, &note).unwrap();
        assert!(!note.exists());

        // list_trash sees exactly the one file, with its original relative path.
        let entries = list_trash_impl(&vault.to_string_lossy()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].original_relative_path, "notes/回收.md");
        assert!(entries[0].trash_path.starts_with(".zettelagent/trash/"));
        assert_eq!(entries[0].size as usize, body.len());

        // restore_from_trash puts it back byte-for-byte.
        let restored = restore_from_trash_impl(None, &vault.to_string_lossy(), &entries[0].trash_path)
            .unwrap();
        assert_eq!(PathBuf::from(&restored), note);
        assert_eq!(std::fs::read_to_string(&note).unwrap(), body);
        assert!(!trashed.exists());

        // empty_trash(None) clears everything left behind.
        let again = move_to_trash(&vault, &note).unwrap();
        assert!(again.exists());
        let removed = empty_trash_impl(&vault.to_string_lossy(), None).unwrap();
        assert_eq!(removed, 1, "one file purged");
        assert!(list_trash_impl(&vault.to_string_lossy()).unwrap().is_empty());

        // A freshly deleted batch survives an age-filtered purge.
        std::fs::write(&note, body).unwrap();
        let _ = move_to_trash(&vault, &note).unwrap();
        assert_eq!(empty_trash_impl(&vault.to_string_lossy(), Some(30)).unwrap(), 0);
        assert_eq!(list_trash_impl(&vault.to_string_lossy()).unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn restore_refuses_to_overwrite_an_existing_note() {
        let vault = temp_vault("nooverwrite");
        let note = vault.join("notes").join("冲突.md");
        std::fs::write(&note, "旧的").unwrap();
        move_to_trash(&vault, &note).unwrap();

        // A new note has taken the original name in the meantime.
        std::fs::write(&note, "新的").unwrap();

        let entries = list_trash_impl(&vault.to_string_lossy()).unwrap();
        let err = restore_from_trash_impl(None, &vault.to_string_lossy(), &entries[0].trash_path)
            .unwrap_err();
        assert!(
            err.to_string().contains("already exists"),
            "expected a refusal, got: {}",
            err
        );
        assert_eq!(std::fs::read_to_string(&note).unwrap(), "新的");

        let _ = std::fs::remove_dir_all(&vault);
    }

    // ── Test 10: path traversal must be rejected ───────────────────
    #[test]
    fn restore_rejects_paths_outside_the_recycle_bin() {
        let vault = temp_vault("escape");
        let outside = vault.join("notes").join("私密.md");
        std::fs::write(&outside, "不该被移动").unwrap();

        // Plain relative path outside the trash.
        assert!(restore_from_trash_impl(None, &vault.to_string_lossy(), "notes/私密.md").is_err());
        // Traversal that starts inside the trash and climbs out — this is why the guard
        // resolves both sides instead of using component-wise `starts_with`.
        assert!(restore_from_trash_impl(
            None,
            &vault.to_string_lossy(),
            ".zettelagent/trash/../../notes/私密.md"
        )
        .is_err());
        // Absolute path elsewhere on disk.
        let elsewhere = std::env::temp_dir().join("definitely-not-in-the-vault.md");
        assert!(restore_from_trash_impl(None, &vault.to_string_lossy(), &elsewhere.to_string_lossy())
            .is_err());

        assert!(outside.exists(), "the rejected file must be untouched");
        let _ = std::fs::remove_dir_all(&vault);
    }

    // ── Recycle-bin retention sweep ────────────────────────────────

    /// Fabricate a trash batch dated `days_ago`, containing one file.
    /// The stamp is formatted in local time because that is what
    /// `move_to_trash` writes and what `parse_stamp_ms` reads back.
    fn seed_batch(vault: &Path, days_ago: i64, file: &str) -> PathBuf {
        let when = chrono::Local::now() - chrono::Duration::days(days_ago);
        let stamp = when.format("%Y%m%d-%H%M%S").to_string();
        let batch = trash_root(vault).join(&stamp);
        std::fs::create_dir_all(batch.join("notes")).unwrap();
        std::fs::write(batch.join("notes").join(file), "过期内容").unwrap();
        batch
    }

    #[test]
    fn sweep_purges_expired_batches_and_keeps_fresh_ones() {
        let vault = temp_vault("sweepmix");
        let old = seed_batch(&vault, 45, "旧.md");
        let fresh = seed_batch(&vault, 2, "新.md");

        let removed =
            sweep_expired_trash_impl(&vault.to_string_lossy(), DEFAULT_TRASH_RETENTION_DAYS, 64)
                .unwrap();

        assert_eq!(removed, 1, "only the 45-day-old batch may be purged");
        assert!(!old.exists(), "expired batch must be gone");
        assert!(fresh.exists(), "a 2-day-old batch is inside the window");

        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn sweep_on_missing_or_empty_trash_is_a_noop() {
        // No `.zettelagent/trash` directory at all.
        let vault = temp_vault("sweepnone");
        assert_eq!(
            sweep_expired_trash_impl(&vault.to_string_lossy(), 30, 64).unwrap(),
            0
        );

        // Directory exists but holds no batches.
        std::fs::create_dir_all(trash_root(&vault)).unwrap();
        assert_eq!(
            sweep_expired_trash_impl(&vault.to_string_lossy(), 30, 64).unwrap(),
            0
        );

        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn sweep_with_retention_zero_deletes_nothing() {
        // Boundary: `0` means "auto-cleanup off", NOT "older than 0 days".
        // A literal reading would empty the whole bin here.
        let vault = temp_vault("sweepzero");
        let ancient = seed_batch(&vault, 900, "远古.md");

        assert_eq!(
            sweep_expired_trash_impl(&vault.to_string_lossy(), RETENTION_DISABLED, 64).unwrap(),
            0
        );
        assert!(ancient.exists(), "retention 0 must not purge anything");

        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn sweep_is_capped_and_attacks_the_oldest_batches_first() {
        let vault = temp_vault("sweepcap");
        // Three expired batches, but the cap allows only two per sweep.
        let b100 = seed_batch(&vault, 100, "a.md");
        let b90 = seed_batch(&vault, 90, "b.md");
        let b80 = seed_batch(&vault, 80, "c.md");

        let removed = sweep_expired_trash_impl(&vault.to_string_lossy(), 30, 2).unwrap();
        assert_eq!(removed, 2, "the cap bounds one sweep to two batches");
        assert!(!b100.exists(), "oldest goes first");
        assert!(!b90.exists(), "second-oldest goes next");
        assert!(b80.exists(), "the remainder waits for the next sweep");

        // A follow-up sweep finishes the job — the cap only defers work.
        assert_eq!(
            sweep_expired_trash_impl(&vault.to_string_lossy(), 30, 2).unwrap(),
            1
        );
        assert!(!b80.exists());

        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn sweep_keeps_batches_it_cannot_date() {
        // A stray directory (manual copy, sync-client artefact) has no
        // `YYYYMMDD-HHMMSS` name. Its age is unknown, so it must survive.
        let vault = temp_vault("sweepundated");
        let stray = trash_root(&vault).join("not-a-timestamp");
        std::fs::create_dir_all(&stray).unwrap();
        std::fs::write(stray.join("x.md"), "来历不明").unwrap();

        assert_eq!(
            sweep_expired_trash_impl(&vault.to_string_lossy(), 1, 64).unwrap(),
            0
        );
        assert!(stray.exists(), "an undatable batch must never be purged");

        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn retention_setting_round_trips_and_defaults_safely() {
        let db = mem_db();

        // Nothing stored yet ⇒ the 30-day default.
        assert_eq!(read_retention_days(&db), DEFAULT_TRASH_RETENTION_DAYS);

        {
            let conn = db.lock().unwrap();
            crate::db::schema::set_setting(&conn, TRASH_RETENTION_SETTING_KEY, "7").unwrap();
        }
        assert_eq!(read_retention_days(&db), 7);

        // A corrupt row falls back to the default rather than to 0 (which
        // would silently switch retention off).
        {
            let conn = db.lock().unwrap();
            crate::db::schema::set_setting(&conn, TRASH_RETENTION_SETTING_KEY, "不是数字").unwrap();
        }
        assert_eq!(read_retention_days(&db), DEFAULT_TRASH_RETENTION_DAYS);

        // An explicit 0 is honoured — that is the user turning the sweep off.
        {
            let conn = db.lock().unwrap();
            crate::db::schema::set_setting(&conn, TRASH_RETENTION_SETTING_KEY, "0").unwrap();
        }
        assert_eq!(read_retention_days(&db), RETENTION_DISABLED);
    }
}



