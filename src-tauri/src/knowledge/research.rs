//! Research projects, claims, evidence bindings, and impact analysis.
use anyhow::{anyhow, bail, ensure, Context, Result};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use uuid::Uuid;

use super::evidence::{self, NewEvidence};
use super::object_store::{self, map_object, NewObject, ObjectPatch, OBJECT_COLUMNS};
use super::types::{ObjectKind, ObjectStatus, SourceRef};

fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args[key]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .with_context(|| format!("Missing or empty {key}"))
}

fn opt_text<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args[key].as_str().filter(|s| !s.trim().is_empty())
}

fn string_array(val: &Value) -> Vec<String> {
    val.as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

pub fn execute(conn: &Connection, vault: &str, action: &str, args: &Value) -> Result<Value> {
    match action {
        "list_projects" => list_projects(conn, vault, args),
        "create_project" => create_project(conn, vault, args),
        "get_project" => get_project(conn, vault, args),
        "update_project" => update_project(conn, vault, args),
        "list_claims" => list_claims(conn, vault, args),
        "save_claim" => save_claim(conn, vault, args),
        "trace_claim" => trace_claim(conn, vault, args),
        "preview_change_impact" => preview_change_impact(conn, vault, args),
        "generate_review_items" => generate_review_items(conn, vault, args),
        "export_bundle_data" => export_bundle_data(conn, vault, args),
        _ => bail!("Unknown research action: {action}"),
    }
}

fn map_project_json(obj: &crate::knowledge::types::KnowledgeObject) -> Value {
    let meta: Value = obj
        .metadata_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| json!({}));

    let question = meta["question"]
        .as_str()
        .or(obj.canonical_content.as_deref())
        .unwrap_or_default();

    let status = match obj.status {
        ObjectStatus::Active => meta["status"].as_str().unwrap_or("active"),
        ObjectStatus::Archived => "paused",
        ObjectStatus::Deleted => "deleted",
        _ => "active",
    };

    json!({
        "id": obj.id,
        "title": obj.title.clone().unwrap_or_default(),
        "question": question,
        "scope": obj.scope,
        "status": status,
        "version": obj.current_version,
        "source_paths": meta["source_paths"].as_array().cloned().unwrap_or_default(),
        "claim_ids": meta["claim_ids"].as_array().cloned().unwrap_or_default(),
        "unresolved_questions": meta["unresolved_questions"].as_array().cloned().unwrap_or_default(),
        "next_steps": meta["next_steps"].as_array().cloned().unwrap_or_default(),
        "artifact_paths": meta["artifact_paths"].as_array().cloned().unwrap_or_default(),
        "created_at_ms": obj.created_at_ms,
        "updated_at_ms": obj.updated_at_ms,
    })
}

fn list_projects(conn: &Connection, vault: &str, _args: &Value) -> Result<Value> {
    let sql = format!(
        "SELECT {OBJECT_COLUMNS}
         FROM knowledge_objects
         WHERE kind = 'collection' AND status != 'deleted'
           AND (scope = ?1 OR scope = '' OR ?1 = '')
         ORDER BY updated_at_ms DESC"
    );
    let mut stmt = conn.prepare(&sql)?;

    let rows = stmt.query_map(params![vault], |row| {
        map_object(row).map_err(|e| match e {
            object_store::ObjectError::Db(err) => err,
            _ => rusqlite::Error::InvalidQuery,
        })
    })?;

    let mut projects = Vec::new();
    for row in rows {
        let obj = row?;
        let meta: Value = obj
            .metadata_json
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_else(|| json!({}));

        if meta["type"].as_str() == Some("research_project") || obj.metadata_json.is_some() {
            projects.push(map_project_json(&obj));
        }
    }

    Ok(json!(projects))
}

fn create_project(conn: &Connection, vault: &str, args: &Value) -> Result<Value> {
    let title = text(args, "title")?;
    let question = text(args, "question")?;
    let source_paths = string_array(&args["source_paths"]);
    let unresolved_questions = string_array(&args["unresolved_questions"]);
    let next_steps = string_array(&args["next_steps"]);
    let artifact_paths = string_array(&args["artifact_paths"]);
    let actor = opt_text(args, "actor").unwrap_or("research_agent");

    let meta = json!({
        "type": "research_project",
        "question": question,
        "status": "active",
        "source_paths": source_paths,
        "claim_ids": [],
        "unresolved_questions": unresolved_questions,
        "next_steps": next_steps,
        "artifact_paths": artifact_paths,
    });

    let mut spec = NewObject::new(ObjectKind::Collection, vault, actor)
        .with_title(title)
        .with_content(question);
    spec.metadata_json = Some(meta.to_string());

    let obj = object_store::create_object(conn, spec)?;
    Ok(map_project_json(&obj))
}

fn get_project(conn: &Connection, vault: &str, args: &Value) -> Result<Value> {
    let id = text(args, "id")?;
    let obj = object_store::get_object(conn, id)?
        .ok_or_else(|| anyhow!("Research project not found: {id}"))?;

    let mut project_json = map_project_json(&obj);

    // Also get scoped claims
    let claims = list_claims(conn, vault, &json!({"project_id": id}))?;
    project_json["claims"] = claims;

    Ok(project_json)
}

fn update_project(conn: &Connection, _vault: &str, args: &Value) -> Result<Value> {
    let id = text(args, "id")?;
    let expected_version = args["expected_version"]
        .as_i64()
        .ok_or_else(|| anyhow!("Missing expected_version for optimistic concurrency"))?;

    let current = object_store::get_object(conn, id)?
        .ok_or_else(|| anyhow!("Research project not found: {id}"))?;

    let patch = if args.get("patch").is_some() && args["patch"].is_object() {
        &args["patch"]
    } else {
        args
    };

    let mut meta: Value = current
        .metadata_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| json!({}));

    if let Some(q) = patch["question"].as_str() {
        meta["question"] = json!(q);
    }
    if let Some(st) = patch["status"].as_str() {
        meta["status"] = json!(st);
    }
    if let Some(sp) = patch.get("source_paths").and_then(Value::as_array) {
        meta["source_paths"] = json!(sp);
    }
    if let Some(ci) = patch.get("claim_ids").and_then(Value::as_array) {
        meta["claim_ids"] = json!(ci);
    }
    if let Some(uq) = patch.get("unresolved_questions").and_then(Value::as_array) {
        meta["unresolved_questions"] = json!(uq);
    }
    if let Some(ns) = patch.get("next_steps").and_then(Value::as_array) {
        meta["next_steps"] = json!(ns);
    }
    if let Some(ap) = patch.get("artifact_paths").and_then(Value::as_array) {
        meta["artifact_paths"] = json!(ap);
    }

    let mut obj_patch = ObjectPatch {
        actor: opt_text(args, "actor").unwrap_or("research_agent").into(),
        expected_version: Some(expected_version),
        metadata_json: Some(meta.to_string()),
        ..Default::default()
    };

    if let Some(t) = patch["title"].as_str() {
        obj_patch.title = Some(t.to_string());
    }
    if let Some(q) = patch["question"].as_str() {
        obj_patch.content = Some(q.to_string());
    }

    let updated = object_store::update_object_patch(conn, id, obj_patch)?;
    Ok(map_project_json(&updated))
}

fn map_claim_json(conn: &Connection, obj: &crate::knowledge::types::KnowledgeObject) -> Result<Value> {
    let meta: Value = obj
        .metadata_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| json!({}));

    let ev_rows = evidence::evidence_for_object(conn, &obj.id)?;
    let mut evidence_list = Vec::new();
    for (e, role, confidence) in ev_rows {
        evidence_list.push(json!({
            "id": e.id,
            "role": role,
            "confidence": confidence,
            "source_type": e.source_type,
            "source_id": e.source_id,
            "locator": e.locator,
            "excerpt": e.excerpt,
            "checksum": e.checksum,
            "captured_at_ms": e.captured_at_ms,
        }));
    }

    Ok(json!({
        "id": obj.id,
        "title": obj.title.clone().unwrap_or_default(),
        "content": obj.canonical_content.clone().unwrap_or_default(),
        "conditions": meta["conditions"].as_str().unwrap_or(""),
        "status": meta["status"].as_str().unwrap_or("proposed"),
        "version": obj.current_version,
        "project_id": obj.parent_id,
        "valid_from_ms": obj.valid_from_ms,
        "valid_to_ms": obj.valid_to_ms,
        "evidence": evidence_list,
        "created_at_ms": obj.created_at_ms,
        "updated_at_ms": obj.updated_at_ms,
    }))
}

fn list_claims(conn: &Connection, vault: &str, args: &Value) -> Result<Value> {
    let project_id = opt_text(args, "project_id");

    let sql = if project_id.is_some() {
        format!(
            "SELECT {OBJECT_COLUMNS}
             FROM knowledge_objects
             WHERE kind = 'claim' AND status != 'deleted' AND parent_id = ?1
             ORDER BY updated_at_ms DESC"
        )
    } else {
        format!(
            "SELECT {OBJECT_COLUMNS}
             FROM knowledge_objects
             WHERE kind = 'claim' AND status != 'deleted'
               AND (scope = ?1 OR scope = '' OR ?1 = '')
             ORDER BY updated_at_ms DESC"
        )
    };

    let target_param = project_id.unwrap_or(vault);
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![target_param], |row| {
        map_object(row).map_err(|e| match e {
            object_store::ObjectError::Db(err) => err,
            _ => rusqlite::Error::InvalidQuery,
        })
    })?;

    let mut claims = Vec::new();
    for row in rows {
        let obj = row?;
        claims.push(map_claim_json(conn, &obj)?);
    }

    Ok(json!(claims))
}

fn save_claim(conn: &Connection, vault: &str, args: &Value) -> Result<Value> {
    let title = text(args, "title")?;
    let content = text(args, "content")?;
    let conditions = opt_text(args, "conditions").unwrap_or("");
    let status = opt_text(args, "status").unwrap_or("proposed");
    let project_id = opt_text(args, "project_id");
    let valid_from_ms = args["valid_from_ms"].as_i64();
    let valid_to_ms = args["valid_to_ms"].as_i64();
    let actor = opt_text(args, "actor").unwrap_or("research_agent");

    let meta = json!({
        "conditions": conditions,
        "status": status,
    });

    let claim_id = if let Some(existing_id) = opt_text(args, "id") {
        let expected_version = args["expected_version"]
            .as_i64()
            .ok_or_else(|| anyhow!("Missing expected_version when updating claim"))?;

        let patch = ObjectPatch {
            title: Some(title.to_string()),
            content: Some(content.to_string()),
            metadata_json: Some(meta.to_string()),
            valid_from_ms,
            valid_to_ms,
            expected_version: Some(expected_version),
            actor: actor.into(),
            ..Default::default()
        };
        let updated = object_store::update_object_patch(conn, existing_id, patch)?;
        updated.id
    } else {
        let mut spec = NewObject::new(ObjectKind::Claim, vault, actor)
            .with_title(title)
            .with_content(content);
        if let Some(pid) = project_id {
            spec = spec.with_parent(pid);
        }
        spec.valid_from_ms = valid_from_ms;
        spec.valid_to_ms = valid_to_ms;
        spec.metadata_json = Some(meta.to_string());

        let created = object_store::create_object(conn, spec)?;

        // If part of a project, append claim_id to project's claim_ids
        if let Some(pid) = project_id {
            if let Ok(Some(proj)) = object_store::get_object(conn, pid) {
                let mut proj_meta: Value = proj
                    .metadata_json
                    .as_deref()
                    .and_then(|s| serde_json::from_str(s).ok())
                    .unwrap_or_else(|| json!({}));

                let mut claim_ids = string_array(&proj_meta["claim_ids"]);
                if !claim_ids.contains(&created.id) {
                    claim_ids.push(created.id.clone());
                    proj_meta["claim_ids"] = json!(claim_ids);
                    let proj_patch = ObjectPatch {
                        actor: actor.into(),
                        metadata_json: Some(proj_meta.to_string()),
                        expected_version: Some(proj.current_version),
                        ..Default::default()
                    };
                    let _ = object_store::update_object_patch(conn, pid, proj_patch);
                }
            }
        }

        created.id
    };

    // Attach evidence inputs if provided
    if let Some(inputs) = args.get("evidence_inputs").and_then(Value::as_array) {
        for item in inputs {
            let path = match item["path"].as_str() {
                Some(p) if !p.trim().is_empty() => p,
                _ => continue,
            };
            let quote = item["quote"].as_str().unwrap_or("");
            let role = item["role"].as_str().unwrap_or("supports");
            let locator = item["locator"].as_str();

            let mut ev_spec = NewEvidence::new(SourceRef {
                source_type: "file".into(),
                source_id: path.into(),
            });
            if let Some(loc) = locator {
                ev_spec = ev_spec.with_locator(loc);
            }
            if !quote.is_empty() {
                ev_spec = ev_spec.with_excerpt(quote);
            }

            let ev_id = evidence::record_evidence(conn, ev_spec)?;
            evidence::attach_evidence(conn, &claim_id, &ev_id, role, 1.0)?;
        }
    }

    let claim_obj = object_store::get_object(conn, &claim_id)?
        .ok_or_else(|| anyhow!("Claim not found after save: {claim_id}"))?;

    map_claim_json(conn, &claim_obj)
}

fn trace_claim(conn: &Connection, _vault: &str, args: &Value) -> Result<Value> {
    let id = text(args, "id")?;
    let claim_obj = object_store::get_object(conn, id)?
        .ok_or_else(|| anyhow!("Claim not found: {id}"))?;

    let claim_json = map_claim_json(conn, &claim_obj)?;

    let ev_rows = evidence::evidence_for_object(conn, id)?;
    let mut supporting = Vec::new();
    let mut opposing = Vec::new();
    let mut general_sources = Vec::new();

    for (e, role, conf) in ev_rows {
        let entry = json!({
            "id": e.id,
            "role": role,
            "confidence": conf,
            "source_type": e.source_type,
            "source_id": e.source_id,
            "locator": e.locator,
            "excerpt": e.excerpt,
            "checksum": e.checksum,
            "captured_at_ms": e.captured_at_ms,
        });
        match role.as_str() {
            "supports" => supporting.push(entry),
            "contradicts" => opposing.push(entry),
            _ => general_sources.push(entry),
        }
    }

    // Query relations from relations_v2
    let mut stmt = conn.prepare(
        "SELECT source_object_id, target_object_id, relation_type, confidence
         FROM relations_v2
         WHERE (source_object_id = ?1 OR target_object_id = ?1) AND status != 'deleted'",
    )?;
    let rel_rows = stmt.query_map(params![id], |row| {
        Ok(json!({
            "source": row.get::<_, String>(0)?,
            "target": row.get::<_, String>(1)?,
            "relation_type": row.get::<_, String>(2)?,
            "confidence": row.get::<_, f64>(3)?,
        }))
    })?;
    let mut relations = Vec::new();
    for r in rel_rows {
        if let Ok(val) = r {
            relations.push(val);
        }
    }

    Ok(json!({
        "claim": claim_json,
        "supporting_evidence": supporting,
        "opposing_evidence": opposing,
        "source_evidence": general_sources,
        "dependencies": relations,
        "has_explicit_evidence": !supporting.is_empty() || !opposing.is_empty(),
    }))
}

fn preview_change_impact(conn: &Connection, _vault: &str, args: &Value) -> Result<Value> {
    let id = opt_text(args, "id");
    let path = opt_text(args, "path");
    let limit = args["limit"].as_u64().unwrap_or(50).clamp(1, 200) as usize;

    ensure!(
        id.is_some() || path.is_some(),
        "Must provide either id or path to preview change impact"
    );

    let target = id.or(path).unwrap_or("");
    let mut affected_claims = Vec::new();
    let mut affected_projects = Vec::new();
    let mut affected_notes = Vec::new();

    if let Some(claim_id) = id {
        // Find projects referencing this claim
        let mut stmt = conn.prepare(
            "SELECT id, title, metadata_json
             FROM knowledge_objects
             WHERE kind = 'collection' AND status != 'deleted' AND metadata_json LIKE ?1",
        )?;
        let pattern = format!("%{claim_id}%");
        let rows = stmt.query_map(params![pattern], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?;
        for r in rows {
            if let Ok((pid, title)) = r {
                affected_projects.push(json!({"id": pid, "title": title.unwrap_or_default()}));
            }
        }

        // Find relations involving this claim
        let mut rel_stmt = conn.prepare(
            "SELECT source_object_id, target_object_id, relation_type
             FROM relations_v2
             WHERE (source_object_id = ?1 OR target_object_id = ?1) AND status != 'deleted'",
        )?;
        let rel_rows = rel_stmt.query_map(params![claim_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        })?;
        for r in rel_rows {
            if let Ok((src, tgt, rtype)) = r {
                let other = if src == claim_id { tgt } else { src };
                affected_notes.push(json!({"id": other, "relation": rtype}));
            }
        }
    }

    if let Some(source_path) = path {
        // Find evidence attached to this source
        let mut ev_stmt = conn.prepare(
            "SELECT oe.object_id, oe.role, ko.title, ko.kind
             FROM evidence e
             JOIN object_evidence oe ON e.id = oe.evidence_id
             JOIN knowledge_objects ko ON ko.id = oe.object_id
             WHERE e.source_id = ?1 AND ko.status != 'deleted'",
        )?;
        let ev_rows = ev_stmt.query_map(params![source_path], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;

        for r in ev_rows {
            if let Ok((oid, role, title, kind)) = r {
                if kind == "claim" {
                    affected_claims.push(json!({
                        "id": oid,
                        "title": title.unwrap_or_default(),
                        "evidence_role": role,
                    }));
                } else if kind == "collection" {
                    affected_projects.push(json!({
                        "id": oid,
                        "title": title.unwrap_or_default(),
                    }));
                }
            }
        }
    }

    affected_claims.truncate(limit);
    affected_projects.truncate(limit);
    affected_notes.truncate(limit);

    Ok(json!({
        "target": target,
        "affected_claims": affected_claims,
        "affected_projects": affected_projects,
        "affected_notes": affected_notes,
        "total_impacted": affected_claims.len() + affected_projects.len() + affected_notes.len(),
        "requires_review": true,
    }))
}

fn generate_review_items(conn: &Connection, vault: &str, args: &Value) -> Result<Value> {
    let id = opt_text(args, "id");
    let project_id = opt_text(args, "project_id");
    let limit = args["limit"].as_u64().unwrap_or(10).clamp(1, 50) as usize;

    let mut items = Vec::new();

    if let Some(claim_id) = id {
        if let Ok(Some(claim)) = object_store::get_object(conn, claim_id) {
            let meta: Value = claim
                .metadata_json
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_else(|| json!({}));
            let conditions = meta["conditions"].as_str().unwrap_or("");
            let ev_rows = evidence::evidence_for_object(conn, claim_id)?;

            let question = format!(
                "关于【{}】，其核心主张是什么？在什么前提或适用条件下成立？",
                claim.title.as_deref().unwrap_or("未命名主张")
            );

            let excerpts = ev_rows
                .iter()
                .filter_map(|(e, _, _)| e.excerpt.as_deref())
                .take(3)
                .collect::<Vec<_>>()
                .join("\n- ");

            let answer = format!(
                "主张内容：{}\n\n适用条件：{}\n\n支持证据：\n- {}",
                claim.canonical_content.as_deref().unwrap_or(""),
                if conditions.is_empty() { "无特定条件限制" } else { conditions },
                if excerpts.is_empty() { "无直接摘录" } else { &excerpts }
            );

            items.push(json!({
                "card_id": Uuid::new_v4().to_string(),
                "claim_id": claim_id,
                "question": question,
                "answer": answer,
                "locators": ev_rows.iter().filter_map(|(e, _, _)| e.locator.clone()).collect::<Vec<_>>(),
                "status": "draft",
            }));
        }
    } else if let Some(pid) = project_id {
        let claims = list_claims(conn, vault, &json!({"project_id": pid}))?;
        if let Some(arr) = claims.as_array() {
            for c in arr.iter().take(limit) {
                let cid = c["id"].as_str().unwrap_or("");
                let title = c["title"].as_str().unwrap_or("主张");
                let content = c["content"].as_str().unwrap_or("");
                let conditions = c["conditions"].as_str().unwrap_or("");

                let question = format!("【研究课题复习】主张「{title}」的核心观点是什么？");
                let answer = format!("核心观点：{content}\n适用条件：{conditions}");

                items.push(json!({
                    "card_id": Uuid::new_v4().to_string(),
                    "claim_id": cid,
                    "project_id": pid,
                    "question": question,
                    "answer": answer,
                    "status": "draft",
                }));
            }
        }
    }

    Ok(json!({
        "items": items,
        "count": items.len(),
    }))
}

fn export_bundle_data(conn: &Connection, vault: &str, args: &Value) -> Result<Value> {
    let id = text(args, "id")?;
    let proj = get_project(conn, vault, args)?;
    let claims = list_claims(conn, vault, &json!({"project_id": id}))?;

    Ok(json!({
        "project": proj,
        "claims": claims,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_test_db() -> Connection {
        crate::db::register_sqlite_vec();
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::setup_database_schema(&conn).unwrap();
        crate::knowledge::migration::run_knowledge_migrations(&conn).unwrap();
        conn
    }

    #[test]
    fn research_projects_persist_and_reject_concurrency_conflicts() {
        let conn = setup_test_db();
        let vault = "vault_a";

        // Create project
        let created = execute(
            &conn,
            vault,
            "create_project",
            &json!({
                "title": "Quantum Foundations",
                "question": "Is wave function collapse physical?",
                "source_paths": ["notes/qm.md"],
                "next_steps": ["Read Bell's theorem"]
            }),
        )
        .unwrap();

        assert_eq!(created["title"], "Quantum Foundations");
        assert_eq!(created["version"], 1);
        let id = created["id"].as_str().unwrap();

        // List projects
        let list = execute(&conn, vault, "list_projects", &json!({})).unwrap();
        assert_eq!(list.as_array().unwrap().len(), 1);

        // Update project with matching version
        let updated = execute(
            &conn,
            vault,
            "update_project",
            &json!({
                "id": id,
                "expected_version": 1,
                "patch": {
                    "question": "Is wave function collapse deterministic or physical?"
                }
            }),
        )
        .unwrap();
        assert_eq!(updated["version"], 2);
        assert_eq!(
            updated["question"],
            "Is wave function collapse deterministic or physical?"
        );

        // Update with stale version must fail with VersionConflict
        let stale_res = execute(
            &conn,
            vault,
            "update_project",
            &json!({
                "id": id,
                "expected_version": 1,
                "patch": {
                    "question": "Stale update"
                }
            }),
        );
        assert!(stale_res.is_err());
    }

    #[test]
    fn claims_manage_evidence_roles_and_trace_contradictions() {
        let conn = setup_test_db();
        let vault = "vault_a";

        let proj = execute(
            &conn,
            vault,
            "create_project",
            &json!({
                "title": "Diet & Longevity",
                "question": "Does intermittent fasting extend lifespan?"
            }),
        )
        .unwrap();
        let pid = proj["id"].as_str().unwrap();

        // Save a claim with supporting and contradicting evidence
        let claim = execute(
            &conn,
            vault,
            "save_claim",
            &json!({
                "project_id": pid,
                "title": "Caloric restriction increases rodent lifespan",
                "content": "Caloric restriction extends median lifespan in mice by 30%.",
                "conditions": "Ad libitum control comparison in non-obese strains",
                "evidence_inputs": [
                    {
                        "path": "sources/weindruch1986.pdf",
                        "quote": "Lifespan was extended by 30% in restricted mice.",
                        "role": "supports",
                        "locator": "#page=4"
                    },
                    {
                        "path": "sources/critique2012.md",
                        "quote": "Effect is strain-dependent and not replicated in rhesus monkeys.",
                        "role": "contradicts",
                        "locator": "#L15-L18"
                    }
                ]
            }),
        )
        .unwrap();

        let cid = claim["id"].as_str().unwrap();
        assert_eq!(claim["version"], 1);
        let evs = claim["evidence"].as_array().unwrap();
        assert_eq!(evs.len(), 2);

        // Trace claim
        let trace = execute(&conn, vault, "trace_claim", &json!({"id": cid})).unwrap();
        assert_eq!(trace["supporting_evidence"].as_array().unwrap().len(), 1);
        assert_eq!(trace["opposing_evidence"].as_array().unwrap().len(), 1);
        assert_eq!(trace["has_explicit_evidence"], true);

        // Preview change impact
        let impact = execute(
            &conn,
            vault,
            "preview_change_impact",
            &json!({"path": "sources/weindruch1986.pdf"}),
        )
        .unwrap();
        assert_eq!(impact["affected_claims"].as_array().unwrap().len(), 1);

        // Review items
        let review = execute(
            &conn,
            vault,
            "generate_review_items",
            &json!({"id": cid}),
        )
        .unwrap();
        assert_eq!(review["count"], 1);
    }
}
