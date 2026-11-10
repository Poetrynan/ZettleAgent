//! Audited, portable research exports. Inputs are already scoped research state.
use anyhow::{ensure, Context, Result};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::fs;
use std::path::{Component, Path};
use std::sync::{Arc, Mutex};

use crate::knowledge::sources::guarded_create;

pub fn export(
    db: &Arc<Mutex<Connection>>,
    vault: &str,
    args: &Value,
    data: &Value,
) -> Result<Value> {
    let out_dir_raw = args["output_dir"]
        .as_str()
        .unwrap_or("_research_exports")
        .trim();
    ensure!(!out_dir_raw.is_empty(), "Output directory must not be empty");
    let out_path = Path::new(out_dir_raw);
    ensure!(
        !out_path.components().any(|c| c == Component::ParentDir),
        "Parent traversal is not permitted"
    );

    let vault_root = Path::new(vault).canonicalize().context("Invalid vault root")?;
    let project = &data["project"];
    let project_id = project["id"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("project");

    let base_export_dir = vault_root.join(out_path);
    fs::create_dir_all(&base_export_dir)?;

    let mut target_dir = base_export_dir.join(project_id);
    let mut seq = 1;
    while target_dir.exists() {
        target_dir = base_export_dir.join(format!("{}_{}", project_id, seq));
        seq += 1;
    }
    fs::create_dir_all(&target_dir)?;

    let mut changeset_ids = Vec::new();
    let tool_name = "export_research_bundle";
    let vaults = [vault.to_string()];

    // 1. research.json
    let research_bytes = serde_json::to_vec_pretty(data)?;
    let research_path = target_dir.join("research.json");
    let cs_id = guarded_create(db, vault, &vaults, tool_name, &research_path, &research_bytes)?;
    changeset_ids.push(cs_id);

    // 2. copy sources and build sources.json manifest
    let mut manifest_entries = Vec::new();
    if let Some(sources) = project["source_paths"].as_array() {
        let sources_dir = target_dir.join("sources");
        fs::create_dir_all(&sources_dir)?;

        for src in sources {
            let src_str = match src.as_str() {
                Some(s) if !s.trim().is_empty() => s,
                _ => continue,
            };
            let src_path = Path::new(src_str);
            let candidate = if src_path.is_absolute() {
                src_path.to_path_buf()
            } else {
                vault_root.join(src_path)
            };

            if candidate.is_file() {
                let file_name = candidate.file_name().unwrap_or_default();
                let export_rel = Path::new("sources").join(file_name);
                let export_dest = target_dir.join(&export_rel);

                let bytes = fs::read(&candidate)?;
                let cs = guarded_create(db, vault, &vaults, tool_name, &export_dest, &bytes)?;
                changeset_ids.push(cs);

                manifest_entries.push(json!({
                    "original_path": src_str,
                    "export_path": export_rel.to_string_lossy().replace('\\', "/"),
                    "size_bytes": bytes.len(),
                }));
            }
        }
    }

    // 3. sources.json
    let sources_bytes = serde_json::to_vec_pretty(&manifest_entries)?;
    let sources_path = target_dir.join("sources.json");
    let cs_id = guarded_create(db, vault, &vaults, tool_name, &sources_path, &sources_bytes)?;
    changeset_ids.push(cs_id);

    // 4. summary.md
    let title = project["title"].as_str().unwrap_or("Research Project");
    let question = project["question"].as_str().unwrap_or("");
    let summary_md = format!(
        "# {}\n\n**Research Question:** {}\n\n**Project ID:** {}\n\nExported {} source(s) and {} claim(s).\n",
        title,
        question,
        project_id,
        manifest_entries.len(),
        data["claims"].as_array().map_or(0, |c| c.len())
    );
    let summary_path = target_dir.join("summary.md");
    let cs_id = guarded_create(
        db,
        vault,
        &vaults,
        tool_name,
        &summary_path,
        summary_md.as_bytes(),
    )?;
    changeset_ids.push(cs_id);

    Ok(json!({
        "path": target_dir.to_string_lossy(),
        "changeset_ids": changeset_ids,
        "exported_sources_count": manifest_entries.len(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn bundle_writes_real_manifest_and_sources_without_overwriting_and_audits_every_file() {
        crate::db::register_sqlite_vec();
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::setup_database_schema(&conn).unwrap();
        crate::knowledge::migration::run_knowledge_migrations(&conn).unwrap();
        let db = Arc::new(Mutex::new(conn));
        let root = std::env::temp_dir().join(format!("zettel-bundle-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.md"), "# Original\nReliable source").unwrap();
        let data = json!({"project":{"id":"p","title":"Research","question":"Why?","source_paths":["a.md"],"artifact_paths":[],"version":1},"claims":[]});
        let args = json!({"id":"p"}); let vault = root.to_str().unwrap();
        let result = export(&db, vault, &args, &data).unwrap();
        let dir = result["path"].as_str().unwrap();
        assert!(std::path::Path::new(dir).join("research.json").exists());
        let manifest: Value = serde_json::from_str(&std::fs::read_to_string(std::path::Path::new(dir).join("sources.json")).unwrap()).unwrap();
        let copied = manifest[0]["export_path"].as_str().unwrap();
        assert_eq!(std::fs::read_to_string(std::path::Path::new(dir).join(copied)).unwrap(), "# Original\nReliable source");
        let expected = result["changeset_ids"].as_array().unwrap().len();
        assert!(expected >= 4);
        let committed: i64 = db.lock().unwrap().query_row("SELECT count(*) FROM changesets WHERE state='committed'", [], |r| r.get(0)).unwrap();
        assert_eq!(committed as usize, expected);
        let again = export(&db, vault, &args, &data).unwrap();
        assert_ne!(again["path"], result["path"]);
        assert!(export(&db, vault, &json!({"output_dir":"../escape"}), &data).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
