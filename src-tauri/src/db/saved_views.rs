//! Persistence for the Bases view's saved views (视图预设).
//!
//! ## Why one JSON blob row instead of scalar rows
//!
//! `db::search::rerank` and `db::review_store` both store their settings as
//! *scalar* `app_settings` rows, on purpose: a fixed set of independent knobs
//! degrades per field if one row is missing or unparseable. That reasoning does
//! not transfer here. A saved view is a variable-length list of variable-length
//! records (each with its own `visible_columns` array), and `app_settings` is a
//! flat `key TEXT PRIMARY KEY, value TEXT` map — there is no row shape that holds
//! an unbounded list. Encoding one would mean either synthesising keys per view
//! (`bases_view_<uuid>_name`, …), which reinvents a table inside a KV store and
//! makes an atomic multi-field update impossible, or adding a new table for a
//! feature whose entire payload is a few kilobytes of UI preference.
//!
//! So: a single `bases_saved_views` row holding a JSON array. The tradeoff is
//! accepted knowingly — one corrupt row loses all presets rather than one — which
//! is why [`list`] never propagates a parse error. Losing view presets is an
//! annoyance; a table view that refuses to open because of them is a bug.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::db::schema::{get_setting, set_setting};

/// The single `app_settings` key holding the JSON array of views.
pub const SAVED_VIEWS_KEY: &str = "bases_saved_views";

/// Upper bound on stored views, enforced on save.
///
/// A preset list is navigated by eye from a dropdown; nobody scrolls past a few
/// dozen. The cap exists so a buggy or looping caller cannot grow one
/// `app_settings` row without limit.
const MAX_SAVED_VIEWS: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedView {
    pub id: String,
    pub name: String,
    pub query: String,
    pub folder: String,
    pub note_type: String,
    pub tag: String,
    pub sort_field: String,
    pub sort_dir: String,
    pub visible_columns: Vec<String>,
    pub group_by: Option<String>,
    pub created_at_ms: i64,
}

/// Read all saved views, newest first is *not* imposed — insertion order is kept
/// so the user's own ordering survives a round trip.
///
/// Lenient on the way out (same asymmetry as `rerank::load_config`): a missing
/// row is the normal fresh-vault case, and an unparseable row is treated as
/// missing so a blob written by another build cannot break the view.
pub fn list(conn: &Connection) -> Vec<SavedView> {
    let Ok(Some(raw)) = get_setting(conn, SAVED_VIEWS_KEY) else {
        return Vec::new();
    };
    match serde_json::from_str::<Vec<SavedView>>(&raw) {
        Ok(views) => views,
        Err(e) => {
            log::warn!("[saved_views] ignoring unparseable {SAVED_VIEWS_KEY}: {e}");
            Vec::new()
        }
    }
}

/// Upsert by `id`: an existing view is replaced in place (so renaming or
/// re-saving a preset does not shuffle the dropdown), a new one is appended.
pub fn upsert(conn: &Connection, view: SavedView) -> anyhow::Result<()> {
    if view.id.trim().is_empty() {
        return Err(anyhow::anyhow!(
            "视图 id 不能为空 / Saved view id must not be empty"
        ));
    }
    let mut views = list(conn);
    match views.iter().position(|v| v.id == view.id) {
        Some(idx) => views[idx] = view,
        None => {
            if views.len() >= MAX_SAVED_VIEWS {
                return Err(anyhow::anyhow!(
                    "保存的视图已达上限 {MAX_SAVED_VIEWS} 个，请先删除一些 / \
                     Saved view limit of {MAX_SAVED_VIEWS} reached; delete some first"
                ));
            }
            views.push(view);
        }
    }
    write(conn, &views)
}

/// Delete by `id`. Deleting an id that is not there is a no-op, not an error:
/// the caller's intent ("this view should not exist") is already satisfied, and
/// two windows racing on the same delete must not surface an error dialog.
pub fn delete(conn: &Connection, id: &str) -> anyhow::Result<()> {
    let mut views = list(conn);
    let before = views.len();
    views.retain(|v| v.id != id);
    if views.len() == before {
        return Ok(());
    }
    write(conn, &views)
}

fn write(conn: &Connection, views: &[SavedView]) -> anyhow::Result<()> {
    let payload = serde_json::to_string(views)?;
    set_setting(conn, SAVED_VIEWS_KEY, &payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Repo fixture rule: BOTH schema fns. Skipping `migrate_schema_columns` has
    // already caused a real test failure once (see `db/search.rs` fixture).
    fn conn() -> Connection {
        crate::db::register_sqlite_vec();
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::setup_database_schema(&conn).unwrap();
        crate::db::schema::migrate_schema_columns(&conn).unwrap();
        conn
    }

    fn sample(id: &str, name: &str) -> SavedView {
        SavedView {
            id: id.to_string(),
            name: name.to_string(),
            query: "深度学习".to_string(), // non-ASCII round trip
            folder: "笔记/AI".to_string(),
            note_type: "permanent".to_string(),
            tag: "机器学习".to_string(),
            sort_field: "backlinkCount".to_string(),
            sort_dir: "desc".to_string(),
            visible_columns: vec!["title".to_string(), "标签".to_string()],
            group_by: Some("folder".to_string()),
            created_at_ms: 1_700_000_000_000,
        }
    }

    #[test]
    fn empty_when_never_saved() {
        let c = conn();
        assert!(list(&c).is_empty());
    }

    #[test]
    fn upsert_insert_then_replace_in_place() {
        let c = conn();
        upsert(&c, sample("a", "First")).unwrap();
        upsert(&c, sample("b", "Second")).unwrap();
        assert_eq!(list(&c).len(), 2);

        // Re-saving id "a" must replace, not append, and keep its slot (index 0).
        let mut edited = sample("a", "First (renamed)");
        edited.query = "renamed query".to_string();
        upsert(&c, edited).unwrap();

        let views = list(&c);
        assert_eq!(views.len(), 2, "upsert must not grow the list");
        assert_eq!(views[0].id, "a");
        assert_eq!(views[0].name, "First (renamed)");
        assert_eq!(views[0].query, "renamed query");
        assert_eq!(views[1].id, "b", "insertion order preserved");
    }

    #[test]
    fn json_round_trip_preserves_all_fields_including_cjk() {
        let c = conn();
        let v = sample("rt", "往返测试");
        upsert(&c, v.clone()).unwrap();
        let got = list(&c).into_iter().find(|x| x.id == "rt").unwrap();
        assert_eq!(got.name, "往返测试");
        assert_eq!(got.query, "深度学习");
        assert_eq!(got.folder, "笔记/AI");
        assert_eq!(got.tag, "机器学习");
        assert_eq!(got.visible_columns, vec!["title", "标签"]);
        assert_eq!(got.group_by.as_deref(), Some("folder"));
        assert_eq!(got.created_at_ms, 1_700_000_000_000);
    }

    #[test]
    fn delete_removes_only_the_target() {
        let c = conn();
        upsert(&c, sample("a", "A")).unwrap();
        upsert(&c, sample("b", "B")).unwrap();
        delete(&c, "a").unwrap();
        let views = list(&c);
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].id, "b");
    }

    #[test]
    fn delete_missing_id_is_ok() {
        let c = conn();
        upsert(&c, sample("a", "A")).unwrap();
        // No error, and the existing view is untouched.
        delete(&c, "does-not-exist").unwrap();
        assert_eq!(list(&c).len(), 1);
    }

    #[test]
    fn empty_id_is_rejected() {
        let c = conn();
        assert!(upsert(&c, sample("", "no id")).is_err());
    }

    #[test]
    fn corrupt_blob_degrades_to_empty_not_panic() {
        let c = conn();
        set_setting(&c, SAVED_VIEWS_KEY, "{not valid json").unwrap();
        assert!(list(&c).is_empty());
        // And a fresh save still works, overwriting the corrupt row.
        upsert(&c, sample("a", "A")).unwrap();
        assert_eq!(list(&c).len(), 1);
    }
}

