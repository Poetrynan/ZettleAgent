use super::*;
use serde_json::json;
use std::{fs, path::PathBuf};

struct Vault(PathBuf);
impl Vault {
    fn new() -> Self {
        let path = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn path(&self) -> &str {
        self.0.to_str().unwrap()
    }
    fn read(&self, args: Value) -> Result<Value> {
        read_source_range(&args, self.path(), &[self.path().into()])
    }
    fn verify(&self, args: Value) -> Result<Value> {
        verify_quote(&args, self.path(), &[self.path().into()])
    }
}
impl Drop for Vault {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn exact_paths_do_not_recover_a_wrong_source_by_basename() {
    let v = Vault::new();
    fs::write(v.0.join("paper.md"), "secret").unwrap();
    assert!(v.read(json!({"path":"missing/paper.md"})).is_err());
    assert!(v.read(json!({"path":"../paper.md"})).is_err());
}

#[test]
fn heading_intersects_line_range_and_budget_at_character_boundaries() {
    let v = Vault::new();
    fs::write(
        v.0.join("paper.md"),
        "# A\n## Methods\n中文\n第三行\n## Results\nelse",
    )
    .unwrap();
    let r = v
        .read(json!({"path":"paper.md","heading":"Methods","start_line":3,"max_chars":2}))
        .unwrap();
    assert_eq!(r["segments"][0]["content"], "中文");
    assert_eq!(r["segments"][0]["locator"], "#L3-L3");
    assert_eq!(r["next_start_line"], 4);
    assert_eq!(r["total_lines"], 6);
    let r = v
        .read(json!({"path":"paper.md","heading":"Methods","start_line":4}))
        .unwrap();
    assert_eq!(r["segments"][0]["content"], "第三行");
    assert!(v.read(json!({"path":"paper.md","start_line":7})).is_err());
}

#[test]
fn normalized_cross_line_quotes_point_to_original_characters() {
    let v = Vault::new();
    fs::write(v.0.join("q.txt"), "preface\n证据来\n自原文。\nnext").unwrap();
    let r = v
        .verify(json!({"path":"q.txt","quote":"证据来自原文"}))
        .unwrap();
    assert_eq!(r["status"], "normalized");
    assert_eq!(r["verified"], true);
    assert_eq!(r["matches"][0]["excerpt"], "证据来\n自原文");
    assert_eq!(r["matches"][0]["locator"], "#L2-L3");
    let q = v
        .verify(json!({"path":"q.txt","quote":"原文","quote_kind":"translation"}))
        .unwrap();
    assert_eq!(q["verified"], false);
    let q = v
        .verify(json!({"path":"q.txt","quote":"原文","end_line":2}))
        .unwrap();
    assert_eq!(q["status"], "not_found");
}

#[test]
fn quote_precision_and_partial_search_are_explicit() {
    let v = Vault::new();
    fs::write(v.0.join("q.md"), "intro\nThe Evidence is mixed.\nextra").unwrap();
    let q = v
        .verify(json!({"path":"q.md","quote":"Evidence is mixed"}))
        .unwrap();
    assert_eq!(q["status"], "exact");
    assert_eq!(q["matches"][0]["locator"], "#L2-L2");
    let q = v
        .verify(json!({"path":"q.md","quote":"evidence is mixed"}))
        .unwrap();
    assert_eq!(q["status"], "approximate");
    assert_eq!(q["verified"], false);
    let q = v
        .verify(json!({"path":"q.md","quote":"extra","max_chars":5}))
        .unwrap();
    assert_eq!(q["truncated"], true);
    assert_eq!(q["verified"], false);
    assert_eq!(q["next_start_line"], 2);
}

#[test]
fn a_long_line_has_a_usable_continuation() {
    let v = Vault::new();
    fs::write(v.0.join("q.md"), "一二三四五").unwrap();
    let r = v.read(json!({"path":"q.md","max_chars":3})).unwrap();
    assert_eq!(r["segments"][0]["content"], "一二三");
    assert_eq!(r["next_start_line"], 1);
    let r = v
        .read(json!({"path":"q.md","start_line":1,"start_char":r["next_start_char"]}))
        .unwrap();
    assert_eq!(r["segments"][0]["content"], "四五");
}

#[test]
fn verification_distinguishes_changed_and_unreadable_sources() {
    let v = Vault::new();
    fs::write(v.0.join("q.md"), "initial").unwrap();
    let previous = v.read(json!({"path":"q.md"})).unwrap();
    fs::write(v.0.join("q.md"), "changed").unwrap();
    let args =
        json!({"path":"q.md","quote":"changed","expected_checksum":previous["source_checksum"]});
    assert!(v.read(args.clone()).is_err());
    assert_eq!(v.verify(args).unwrap()["status"], "unavailable");
    fs::write(v.0.join("bad.pdf"), "broken pdf").unwrap();
    let r = v
        .verify(json!({"path":"bad.pdf","quote":"broken"}))
        .unwrap();
    assert_eq!(r["status"], "unavailable");
    assert_eq!(r["matches"], json!([]));
}

#[test]
fn pdf_reports_physical_pages_and_absent_text_honestly() {
    let v = Vault::new();
    let mut pdf = oxidize_pdf::Document::new();
    pdf.add_page(oxidize_pdf::Page::a4());
    pdf.add_page(oxidize_pdf::Page::a4());
    pdf.save(v.0.join("blank.pdf")).unwrap();
    let r = v.read(json!({"path":"blank.pdf","start_page":2})).unwrap();
    assert_eq!(r["total_pages"], 2);
    assert_eq!(r["segments"][0]["page"], 2);
    assert_eq!(r["segments"][0]["page_label"], Value::Null);
    assert_eq!(r["segments"][0]["needs_ocr"], true);
    assert!(v.read(json!({"path":"blank.pdf","start_page":3})).is_err());
    assert_eq!(
        v.verify(json!({"path":"blank.pdf","quote":"text"}))
            .unwrap()["status"],
        "unavailable"
    );
}

#[tokio::test]
async fn capture_preserves_versioned_originals_user_edits_and_real_create_audit() {
    let v = Vault::new();
    crate::db::register_sqlite_vec();
    let conn = Connection::open_in_memory().unwrap();
    crate::db::schema::setup_database_schema(&conn).unwrap();
    crate::db::schema::migrate_schema_columns(&conn).unwrap();
    crate::knowledge::migration::run_knowledge_migrations(&conn).unwrap();
    let db = Arc::new(Mutex::new(conn));
    let vaults = vec![v.path().to_owned()];
    let args = json!({"path":"data.csv","title":"Research"});
    fs::write(v.0.join("data.csv"), "a,b\n1,2").unwrap();
    let first = capture_source(&args, &db, v.path(), &vaults).await.unwrap();
    assert_eq!(first["reused"], false);
    let note = first["path"].as_str().unwrap();
    let original = first["original_path"].as_str().unwrap();
    assert!(fs::read_to_string(note).unwrap().contains("| 1 | 2 |"));
    assert_eq!(fs::read(original).unwrap(), b"a,b\n1,2");
    let count_audit = || {
        db.lock().unwrap().query_row(
        "SELECT count(*) FROM changeset_ops o JOIN changesets c ON c.id=o.changeset_id WHERE c.state='committed' AND o.op_kind='create' AND o.legacy_path IN (?1,?2)",
        [note, original], |row| row.get::<_, i64>(0)).unwrap()
    };
    assert_eq!(count_audit(), 2);
    fs::write(note, "personal edit").unwrap();
    let again = capture_source(&args, &db, v.path(), &vaults).await.unwrap();
    assert_eq!(again["reused"], true);
    assert_eq!(again["changeset_ids"], json!([]));
    assert_eq!(fs::read_to_string(note).unwrap(), "personal edit");
    fs::write(v.0.join("data.csv"), "a,b\n2,3").unwrap();
    let newer = capture_source(&args, &db, v.path(), &vaults).await.unwrap();
    assert_ne!(newer["path"], first["path"]);
    assert_eq!(fs::read(original).unwrap(), b"a,b\n1,2");
}
