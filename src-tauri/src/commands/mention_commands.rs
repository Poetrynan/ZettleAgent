//! 未链接提及 / unlinked mentions: list them, link one, undo that.
//!
//! The matching rules live in [`crate::db::mentions`]; this file adds recall
//! from the database, the file system and the undo path.
//!
//! ## How a list is built
//! 1. The target's names: title, file name, frontmatter aliases.
//! 2. Recall: an exact-phrase query per name on the segmented FTS index (so it
//!    is case- and script-insensitive like search) yields candidate notes.
//! 3. Verification on each candidate's *file on disk*, not on chunks: line and
//!    column must be real file positions, because that is what "link it"
//!    rewrites. Notes that already link to the target are left out — they are
//!    backlinks, and one link per note is what a Zettelkasten needs.
//!
//! ## Linking is optimistic and undoable
//! The caller sends back the line, column and text it was shown. If the note
//! changed since, nothing is written and a `Conflict` says so. Before writing,
//! the old text is stored as a version-history snapshot; the returned id and
//! post-write hash let [`undo_link_mention`] restore it — but only if the file
//! is still exactly what the link wrote, so an undo never discards later edits.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;

use crate::db::mentions::{self, LinkError};
use crate::error::ZettelError;
use crate::AppState;

/// Notes recalled for verification, at most. Each is read from disk.
const MAX_CANDIDATE_NOTES: i64 = 400;
/// Mentions returned, at most; `truncated` says when there were more.
const MAX_MENTIONS: usize = 200;
/// Chars of context shown on each side of a mention.
const CONTEXT_CHARS: usize = 40;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlinkedMention {
    pub file_path: String,
    pub title: String,
    /// 1-based line in the source file.
    pub line: usize,
    /// 0-based char offset within the line.
    pub column: usize,
    pub matched: String,
    pub before: String,
    pub after: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MentionsReport {
    pub mentions: Vec<UnlinkedMention>,
    /// The names that were searched for (title, file name, aliases).
    pub terms: Vec<String>,
    pub truncated: bool,
}

#[tauri::command]
pub fn get_unlinked_mentions(state: State<'_, AppState>, file_path: String) -> Result<MentionsReport, ZettelError> {
    state.read(|conn| collect_unlinked_mentions(conn, &file_path))
}

/// `Connection`-typed core of [`get_unlinked_mentions`], testable without Tauri.
pub fn collect_unlinked_mentions(conn: &Connection, file_path: &str) -> Result<MentionsReport, ZettelError> {
    let empty = |terms| MentionsReport { mentions: Vec::new(), terms, truncated: false };
    // A path with no `files` row is not a note and has no mentions.
    let title: Option<Option<String>> = conn
        .query_row("SELECT title FROM files WHERE path = ?1", params![file_path], |r| r.get(0))
        .optional()?;
    let Some(title) = title else { return Ok(empty(Vec::new())) };
    let target_text = std::fs::read_to_string(file_path).ok();
    let terms = mentions::mention_terms(title.as_deref(), file_path, target_text.as_deref());
    if terms.is_empty() {
        return Ok(empty(terms));
    }

    let phrases: Vec<String> = terms.iter().filter_map(|t| crate::db::search::fts_phrase(t)).collect();
    if phrases.is_empty() {
        return Ok(empty(terms));
    }
    let mut stmt = conn.prepare(
        "SELECT DISTINCT c.file_path, COALESCE(f.title, '')
         FROM chunks_fts_seg s
         JOIN chunks c ON c.id = s.rowid
         LEFT JOIN files f ON f.path = c.file_path
         WHERE chunks_fts_seg MATCH ?1 AND c.file_path != ?2
         ORDER BY c.file_path
         LIMIT ?3",
    )?;
    let candidates: Vec<(String, String)> = stmt
        .query_map(params![phrases.join(" OR "), file_path, MAX_CANDIDATE_NOTES], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;

    let resolver = crate::db::wikilink::LinkResolver::from_files(conn)?;
    let mut out = Vec::new();
    let mut truncated = false;
    'notes: for (source, source_title) in candidates {
        let Ok(text) = std::fs::read_to_string(&source) else { continue };
        if resolver.content_links_to(&text, file_path) {
            continue;
        }
        for o in mentions::find_mentions(&text, &terms) {
            if out.len() >= MAX_MENTIONS {
                truncated = true;
                break 'notes;
            }
            let chars: Vec<char> = o.line_text.chars().collect();
            let before_start = o.column.saturating_sub(CONTEXT_CHARS);
            let after_end = (o.column + o.length + CONTEXT_CHARS).min(chars.len());
            out.push(UnlinkedMention {
                file_path: source.clone(),
                title: source_title.clone(),
                line: o.line,
                column: o.column,
                matched: o.matched,
                before: chars[before_start..o.column].iter().collect::<String>().trim_start().to_string(),
                after: chars[o.column + o.length..after_end].iter().collect::<String>().trim_end().to_string(),
            });
        }
    }
    Ok(MentionsReport { mentions: out, terms, truncated })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkMentionResult {
    /// Version-history snapshot holding the text before the link was added.
    pub snapshot_id: i64,
    /// Hash of the file right after the write; [`undo_link_mention`] requires it.
    pub post_hash: String,
    /// The link that was inserted, e.g. `[[知识图谱]]`.
    pub link: String,
}

#[tauri::command]
pub fn link_unlinked_mention(
    state: State<'_, AppState>,
    source_path: String,
    target_path: String,
    line: usize,
    column: usize,
    matched: String,
) -> Result<LinkMentionResult, ZettelError> {
    let conn = state.db.lock()?;
    link_mention_in_file(&conn, &source_path, &target_path, line, column, &matched)
}

/// How to write a link that the shared resolver will route to `target`, from
/// `source`: the mention itself when it already resolves there, otherwise the
/// title or file name with the mention kept as the visible alias.
fn link_form(conn: &Connection, source: &str, target: &str, matched: &str) -> Result<(String, bool), ZettelError> {
    let resolver = crate::db::wikilink::LinkResolver::from_files(conn)?;
    if resolver.resolve_near(matched, Some(source)) == Some(target) {
        return Ok((matched.to_string(), true));
    }
    let title: Option<String> = conn
        .query_row("SELECT title FROM files WHERE path = ?1", params![target], |r| r.get(0))
        .optional()?
        .flatten();
    let norm = target.replace('\\', "/");
    let base = norm.rsplit('/').next().unwrap_or(&norm);
    let stem = base.strip_suffix(".md").unwrap_or(base).to_string();
    for candidate in title.into_iter().chain(std::iter::once(stem)) {
        if !candidate.trim().is_empty() && resolver.resolve_near(&candidate, Some(source)) == Some(target) {
            return Ok((candidate, false));
        }
    }
    Err(ZettelError::Conflict(format!(
        "no link text points unambiguously at {target} (another note shares its title) / 该笔记与其他笔记重名，无法生成唯一指向它的链接"
    )))
}

/// `Connection`-typed core of [`link_unlinked_mention`].
pub fn link_mention_in_file(
    conn: &Connection,
    source_path: &str,
    target_path: &str,
    line: usize,
    column: usize,
    matched: &str,
) -> Result<LinkMentionResult, ZettelError> {
    let source = Path::new(source_path);
    let old = std::fs::read_to_string(source)?;
    let (link_target, written_form) = link_form(conn, source_path, target_path, matched)?;
    let new = mentions::link_occurrence(&old, line, column, matched, &link_target, written_form).map_err(|e| match e {
        LinkError::Stale => ZettelError::Conflict(format!(
            "{source_path}: the note changed, the mention is no longer there; refresh the list / 笔记已被修改，这处提及已不在原位置，请刷新列表"
        )),
    })?;

    let key = crate::tools::internal_tools::helpers::snapshot_path_key(source);
    let snapshot_id = crate::commands::file_commands::insert_note_snapshot_returning_id(conn, &key, &old)?;
    crate::file_lock::safe_write(source, &new)?;
    reindex(conn, source);

    let post_hash = crate::tools::internal_tools::helpers::content_hash_of_file(source)
        .ok_or_else(|| ZettelError::System(format!("cannot read {source_path} after writing it")))?;
    let link = if written_form { format!("[[{matched}]]") } else { format!("[[{link_target}|{matched}]]") };
    Ok(LinkMentionResult { snapshot_id, post_hash, link })
}

#[tauri::command]
pub fn undo_link_mention(
    state: State<'_, AppState>,
    source_path: String,
    snapshot_id: i64,
    post_hash: String,
) -> Result<(), ZettelError> {
    let conn = state.db.lock()?;
    undo_link_in_file(&conn, &source_path, snapshot_id, &post_hash)
}

/// `Connection`-typed core of [`undo_link_mention`]. Refuses when the file was
/// edited after the link was added: restoring would throw that edit away.
pub fn undo_link_in_file(conn: &Connection, source_path: &str, snapshot_id: i64, post_hash: &str) -> Result<(), ZettelError> {
    let source = Path::new(source_path);
    match crate::tools::internal_tools::helpers::content_hash_of_file(source) {
        Some(h) if h == post_hash => {}
        Some(_) => {
            return Err(ZettelError::Conflict(format!(
                "{source_path}: edited after the link was added; use version history instead / 加链接之后笔记又被修改过，请从版本历史恢复"
            )))
        }
        None => return Err(ZettelError::System(format!("cannot read {source_path}"))),
    }
    let previous: String = conn
        .query_row("SELECT content FROM note_snapshots WHERE id = ?1", params![snapshot_id], |r| r.get(0))
        .optional()?
        .ok_or_else(|| ZettelError::System(format!("snapshot #{snapshot_id} is gone")))?;
    // Keep the linked version too, so the undo itself can be undone from history.
    let current = std::fs::read_to_string(source)?;
    let key = crate::tools::internal_tools::helpers::snapshot_path_key(source);
    crate::commands::file_commands::insert_note_snapshot(conn, &key, &current)?;
    crate::file_lock::safe_write(source, &previous)?;
    reindex(conn, source);
    Ok(())
}

/// Bring the index in line with the file now, rather than waiting for the
/// watcher, so the mentions list and backlinks are right on the next query.
fn reindex(conn: &Connection, path: &Path) {
    if let Err(e) = crate::db::sync::sync_file(conn, path) {
        log::warn!("mentions: reindex of {} failed: {}", path.display(), e);
    }
    crate::db::search::invalidate_graph_cache(conn);
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Vault {
        dir: std::path::PathBuf,
        conn: Connection,
    }

    impl Vault {
        fn new(name: &str) -> Self {
            crate::db::register_sqlite_vec();
            let dir = std::env::temp_dir().join(format!("zettel-mentions-{name}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let conn = Connection::open_in_memory().unwrap();
            crate::db::schema::setup_database_schema(&conn).unwrap();
            crate::db::schema::migrate_schema_columns(&conn).unwrap();
            Vault { dir, conn }
        }

        /// Write a note to disk and index it the way the app does.
        fn note(&self, file: &str, text: &str) -> String {
            let path = self.dir.join(file);
            std::fs::write(&path, text).unwrap();
            crate::db::sync::sync_file(&self.conn, &path).unwrap();
            path.to_string_lossy().to_string()
        }
    }

    impl Drop for Vault {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn lists_mentions_across_scripts_and_skips_linked_notes() {
        let v = Vault::new("list");
        let target = v.note("知识图谱.md", "---\naliases: [Knowledge Graph]\n---\n# 知识图谱\n定义。");
        let trad = v.note("trad.md", "# 筆記\n我們在構建知識圖譜系統。");
        let eng = v.note("eng.md", "# English\nA knowledge graph links notes.");
        v.note("linked.md", "# 已链接\n见 [[知识图谱]]，知识图谱很重要。");
        v.note("none.md", "# 无关\n今天天气不错。");

        let r = collect_unlinked_mentions(&v.conn, &target).unwrap();
        let mut got: Vec<(&str, &str)> = r
            .mentions
            .iter()
            .map(|m| (m.file_path.as_str(), m.matched.as_str()))
            .collect();
        got.sort();
        let mut want = vec![(eng.as_str(), "knowledge graph"), (trad.as_str(), "知識圖譜")];
        want.sort();
        assert_eq!(got, want, "{r:?}");
        let m = r.mentions.iter().find(|m| m.file_path == trad).unwrap();
        assert_eq!((m.line, m.column), (2, 5));
        assert_eq!((m.before.as_str(), m.after.as_str()), ("我們在構建", "系統。"));
        assert!(!r.truncated);
    }

    #[test]
    fn linking_then_undoing_round_trips_and_updates_backlinks() {
        let v = Vault::new("link");
        let target = v.note("知识图谱.md", "# 知识图谱\n定义。");
        let source = v.note("src.md", "# 来源\n我們在構建知識圖譜系統。\n");
        let before = std::fs::read_to_string(&source).unwrap();

        let r = collect_unlinked_mentions(&v.conn, &target).unwrap();
        let m = &r.mentions[0];
        let res = link_mention_in_file(&v.conn, &source, &target, m.line, m.column, &m.matched).unwrap();
        // Traditional wording is kept as the alias; the target is the simplified title.
        assert_eq!(res.link, "[[知识图谱|知識圖譜]]");
        assert_eq!(std::fs::read_to_string(&source).unwrap(), "# 来源\n我們在構建[[知识图谱|知識圖譜]]系統。\n");

        // The index followed: it is a backlink now and no longer an unlinked mention.
        let backlinks = crate::commands::file_commands::collect_backlinks(&v.conn, &target).unwrap();
        assert!(backlinks.iter().any(|b| b.file_path == source));
        assert!(collect_unlinked_mentions(&v.conn, &target).unwrap().mentions.is_empty());

        undo_link_in_file(&v.conn, &source, res.snapshot_id, &res.post_hash).unwrap();
        assert_eq!(std::fs::read_to_string(&source).unwrap(), before);
        assert_eq!(collect_unlinked_mentions(&v.conn, &target).unwrap().mentions.len(), 1);
    }

    #[test]
    fn stale_position_and_later_edits_are_refused() {
        let v = Vault::new("stale");
        let target = v.note("知识图谱.md", "# 知识图谱\n");
        let source = v.note("src.md", "# 来源\n讲知识图谱。\n");
        let m = &collect_unlinked_mentions(&v.conn, &target).unwrap().mentions[0];
        let (line, column, matched) = (m.line, m.column, m.matched.clone());

        // The note changed under the list: nothing is written.
        std::fs::write(&source, "# 来源\n改成讲别的知识图谱。\n").unwrap();
        let err = link_mention_in_file(&v.conn, &source, &target, line, column, &matched).unwrap_err();
        assert!(matches!(err, ZettelError::Conflict(_)), "{err:?}");
        assert_eq!(std::fs::read_to_string(&source).unwrap(), "# 来源\n改成讲别的知识图谱。\n");

        // Link for real, then edit: undo must not discard that edit.
        let m = &collect_unlinked_mentions(&v.conn, &target).unwrap().mentions[0];
        let res = link_mention_in_file(&v.conn, &source, &target, m.line, m.column, &m.matched).unwrap();
        let edited = format!("{}再加一行。\n", std::fs::read_to_string(&source).unwrap());
        std::fs::write(&source, &edited).unwrap();
        let err = undo_link_in_file(&v.conn, &source, res.snapshot_id, &res.post_hash).unwrap_err();
        assert!(matches!(err, ZettelError::Conflict(_)));
        assert_eq!(std::fs::read_to_string(&source).unwrap(), edited);
    }

    #[test]
    fn ambiguous_title_uses_a_link_that_still_resolves_to_the_target() {
        let v = Vault::new("ambig");
        // Two notes titled 知识图谱; the target is the one in b/, so `[[知识图谱]]`
        // alone would resolve to a/ — the link must use something unique.
        std::fs::create_dir_all(v.dir.join("a")).unwrap();
        std::fs::create_dir_all(v.dir.join("b")).unwrap();
        v.note("a/知识图谱.md", "# 知识图谱\n");
        let target = v.note("b/kg-b.md", "---\ntitle: 知识图谱\n---\n# 知识图谱\n");
        let source = v.note("src.md", "# 来源\n讲知识图谱。\n");
        let m = collect_unlinked_mentions(&v.conn, &target)
            .unwrap()
            .mentions
            .into_iter()
            .find(|m| m.file_path == source)
            .expect("mention in src.md");
        let res = link_mention_in_file(&v.conn, &source, &target, m.line, m.column, &m.matched).unwrap();
        assert_eq!(res.link, "[[kg-b|知识图谱]]");
        let backlinks = crate::commands::file_commands::collect_backlinks(&v.conn, &target).unwrap();
        assert!(backlinks.iter().any(|b| b.file_path == source), "link must point at the target");
    }
}
