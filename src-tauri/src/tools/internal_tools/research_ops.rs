//! Agent schemas and dispatch adapters for the knowledge research workbench.
use crate::llm::{ToolDef, ToolFunction};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use rusqlite::Connection;

pub async fn try_execute(name: &str, arguments: &str, db: &Arc<Mutex<Connection>>, vault: &str, vaults: &[String]) -> Option<anyhow::Result<String>> {
    use crate::knowledge::{bundle, maintenance, research, sources};
    if !matches!(
        name,
        "read_source_range"
            | "verify_quote"
            | "capture_source"
            | "find_duplicate_groups"
            | "resolve_entity_aliases"
            | "calculate"
            | "resolve_reference"
            | "create_research_project"
            | "get_research_state"
            | "update_research_state"
            | "trace_claim"
            | "preview_change_impact"
            | "generate_review_items"
            | "export_research_bundle"
    ) {
        return None;
    }
    let args: Value = match serde_json::from_str(arguments) { Ok(args) => args, Err(e) => return Some(Err(e.into())) };
    let with_conn = |f: &dyn Fn(&Connection) -> anyhow::Result<Value>| -> anyhow::Result<Value> {
        let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;
        f(&conn)
    };
    let result = match name {
        "read_source_range" => sources::read_source_range(&args, vault, vaults),
        "verify_quote" => sources::verify_quote(&args, vault, vaults),
        "capture_source" => sources::capture_source(&args, db, vault, vaults).await,
        "find_duplicate_groups" => maintenance::duplicate_groups(&args, vault),
        "resolve_entity_aliases" => maintenance::entity_aliases(&args, vault),
        "calculate" => maintenance::calculate(&args),
        "resolve_reference" => maintenance::resolve_reference(&args).await,
        "create_research_project" => with_conn(&|conn| research::execute(conn, vault, "create_project", &args)),
        "get_research_state" => with_conn(&|conn| {
            if args.get("id").and_then(Value::as_str).is_some() {
                research::execute(conn, vault, "get_project", &args)
            } else {
                research::execute(conn, vault, "list_projects", &args)
            }
        }),
        "update_research_state" => with_conn(&|conn| {
            let op = args.get("operation").and_then(Value::as_str).unwrap_or("update_project");
            if op == "save_claim" {
                research::execute(conn, vault, "save_claim", &args)
            } else {
                research::execute(conn, vault, "update_project", &args)
            }
        }),
        "trace_claim" => with_conn(&|conn| research::execute(conn, vault, "trace_claim", &args)),
        "preview_change_impact" => with_conn(&|conn| research::execute(conn, vault, "preview_change_impact", &args)),
        "generate_review_items" => with_conn(&|conn| research::execute(conn, vault, "generate_review_items", &args)),
        "export_research_bundle" => (|| -> anyhow::Result<Value> {
            let data = {
                let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;
                research::execute(&conn, vault, "export_bundle_data", &args)?
            };
            bundle::export(db, vault, &args, &data)
        })(),
        _ => unreachable!(),
    };
    Some(result.and_then(|v| serde_json::to_string(&v).map_err(Into::into)))
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> ToolDef {
    ToolDef { tool_type: "function".into(), function: ToolFunction { name: name.into(), description: description.into(),
        parameters: json!({"type":"object","properties":properties,"required":required}) } }
}

pub fn defs() -> Vec<ToolDef> {
    let range = json!({"path":{"type":"string"},"start_line":{"type":"integer","minimum":1},"end_line":{"type":"integer","minimum":1},
        "heading":{"type":"string"},"start_page":{"type":"integer","minimum":1},"end_page":{"type":"integer","minimum":1},
        "start_char":{"type":"integer","minimum":0},"max_chars":{"type":"integer","minimum":1},"expected_checksum":{"type":"string"}});
    let mut quote = range.clone();
    quote["quote"] = json!({"type":"string"}); quote["quote_kind"] = json!({"type":"string","enum":["original","translation","paraphrase"],"default":"original"});
    vec![
        tool("read_source_range", "Read exact Markdown/text lines or physical PDF pages with source checksum and locators. Scanned pages are marked unavailable for text; follow continuation fields for truncated ranges.", range, &["path"]),
        tool("verify_quote", "Check a quote against actual source bytes/text. Returns exact/normalized/not_found/unavailable and located excerpts. Translation/paraphrase is never verified as original; a match establishes neither truth nor author attribution.", quote, &["path","quote"]),
        tool("capture_source", "Capture one URL or local file into a deduplicated citable source note, retaining original version and known metadata. Real writes are audited; repeated captures preserve user edits.",
            json!({"url":{"type":"string"},"path":{"type":"string"},"output_dir":{"type":"string","default":"_sources"},"title":{"type":"string"}}), &[]),
        tool("create_research_project", "Persist a scoped research question, source paths, claims, unresolved questions, next steps and artifacts with stable identity.",
            json!({"title":{"type":"string"},"question":{"type":"string"},"source_paths":{"type":"array","items":{"type":"string"}},"next_steps":{"type":"array","items":{"type":"string"}}}), &["title","question"]),
        tool("get_research_state", "Resume durable research state. With id, returns the project and its scoped claims; without id, lists projects. No writes.",
            json!({"id":{"type":"string"}}), &[]),
        tool("update_research_state", "Update a research project using expected_version, or save a claim with evidence using operation=save_claim. No silent overwrites. Claim evidence_inputs require real path, quote, quote_kind and supports/contradicts/source role.",
            json!({"operation":{"type":"string","enum":["update_project","save_claim"],"default":"update_project"},"id":{"type":"string"},"expected_version":{"type":"integer"},
                "patch":{"type":"object","description":"Project fields: title,question,status,source_paths,claim_ids,unresolved_questions,next_steps,artifact_paths."},
                "title":{"type":"string"},"content":{"type":"string"},"conditions":{"type":"string"},"status":{"type":"string"},"project_id":{"type":"string"},
                "valid_from_ms":{"type":["integer","null"]},"valid_to_ms":{"type":["integer","null"]},
                "evidence_inputs":{"type":"array","items":{"type":"object","properties":{"path":{"type":"string"},"quote":{"type":"string"},"quote_kind":{"type":"string","enum":["original","translation","paraphrase"]},"role":{"type":"string","enum":["supports","contradicts","source"]},"expected_checksum":{"type":"string"}},"required":["path","quote","role"]}}}), &[]),
        tool("trace_claim", "Read a claim, conditions, validity period, supporting/opposing evidence and dependency trace. Missing evidence remains explicit.", json!({"id":{"type":"string"}}), &["id"]),
        tool("preview_change_impact", "Preview knowledge objects, notes and research artifacts depending on a claim or source before changing it. Read-only, no propagation is applied.",
            json!({"id":{"type":"string"},"path":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":200}}), &[]),
        tool("find_duplicate_groups", "Find bounded exact/normalized duplicate candidates in the selected vault. Reports source fingerprints and scan coverage; never merges automatically.",
            json!({"folder":{"type":"string"},"max_files":{"type":"integer","minimum":1,"maximum":500},"limit":{"type":"integer","minimum":1,"maximum":100}}), &[]),
        tool("generate_review_items", "Draft evidence-backed review questions from a selected research project or claim. Drafts can be reviewed and published into the existing FSRS deck; this call does not publish them.",
            json!({"id":{"type":"string"},"project_id":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":50}}), &[]),
        tool("resolve_reference", "Resolve DOI, valid ISBN or arXiv identifiers using Crossref/Open Library/arXiv. Reports provider and unresolved states; fetch_metadata=false only validates identifiers offline.",
            json!({"reference":{"type":"string"},"fetch_metadata":{"type":"boolean","default":true}}), &["reference"]),
        tool("export_research_bundle", "Export a project, claims, citations, source manifest and selected notes into a new audited vault folder. Existing files are never overwritten.",
            json!({"id":{"type":"string"},"output_dir":{"type":"string","default":"_research_exports"},"include_attachments":{"type":"boolean","default":false}}), &["id"]),
        tool("resolve_entity_aliases", "List explicit note aliases and candidate concept identities with source fingerprints. Ambiguous same-name notes require human confirmation; never auto-merge.",
            json!({"query":{"type":"string"},"folder":{"type":"string"},"max_files":{"type":"integer","minimum":1,"maximum":500}}), &[]),
        tool("calculate", "Deterministic bounded arithmetic (+ - * / % ^ parentheses), compatible-unit conversion or ISO date difference. No code or shell execution.",
            json!({"operation":{"type":"string","enum":["expression","convert","date_difference"],"default":"expression"},"expression":{"type":"string","maxLength":512},"value":{"type":"number"},"from":{"type":"string"},"to":{"type":"string"}}), &[]),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn workbench_catalogue_is_unique_complete_and_has_object_schemas() {
        let defs = defs();
        let expected = ["read_source_range", "verify_quote", "capture_source",
            "create_research_project", "get_research_state", "update_research_state",
            "trace_claim", "preview_change_impact", "find_duplicate_groups",
            "generate_review_items", "resolve_reference", "export_research_bundle",
            "resolve_entity_aliases", "calculate"];
        assert_eq!(defs.len(), expected.len());
        for name in expected {
            let matching: Vec<_> = defs.iter().filter(|d| d.function.name == name).collect();
            assert_eq!(matching.len(), 1, "{name}");
            assert_eq!(matching[0].function.parameters["type"], "object");
            assert!(matching[0].function.parameters["properties"].is_object());
        }
    }
}
