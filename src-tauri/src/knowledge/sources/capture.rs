use super::*;
use crate::knowledge::types::{ChangeOpKind, ObjectKind};
use crate::knowledge::write_guard::{self, Guarded, Intent, WriteContext};
use crate::tools::internal_tools::helpers::journal_write;
use base64::Engine;
use rusqlite::OptionalExtension;
use std::io::Write;

fn absolute_output(path: &Path, vault: &str, vaults: &[String]) -> Result<PathBuf> {
    let raw = path.to_str().context("Invalid output path")?;
    validate_path(raw)?;
    ensure!(
        path.is_absolute() || !vault.is_empty(),
        "Missing primary vault"
    );
    let path = resolve_for_containment(&Path::new(vault).join(path));
    ensure!(
        is_path_in_any_vault(&path, vault, vaults),
        "Output is outside configured vaults"
    );
    Ok(path)
}

/// Publish complete bytes without replacing an existing file. Linking a synced
/// sibling gives concurrent writers a single create-new decision at the OS.
fn publish_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("Missing output directory")?;
    fs::create_dir_all(parent)?;
    let temp = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)?;
    let outcome = (|| -> Result<()> {
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::hard_link(&temp, path)
            .with_context(|| format!("Cannot create {} without replacing it", path.display()))?;
        Ok(())
    })();
    let _ = fs::remove_file(temp);
    outcome
}

/// Stage each actual file, preserve binary payloads losslessly, and journal
/// the create operation so a run undo checks the hash before trashing it.
pub(crate) fn guarded_create(
    db: &Arc<Mutex<Connection>>,
    vault: &str,
    vaults: &[String],
    tool: &str,
    path: &Path,
    bytes: &[u8],
) -> Result<String> {
    let path = absolute_output(path, vault, vaults)?;
    ensure!(
        !path.exists(),
        "Destination already exists: {}",
        path.display()
    );
    let key = snapshot_path_key(&path);
    let payload = match std::str::from_utf8(bytes) {
        Ok(text) if !text.is_empty() && !text.contains('\0') => text.to_owned(),
        _ => json!({"encoding":"base64","size_bytes":bytes.len(),"sha256":digest(bytes),
            "data":base64::engine::general_purpose::STANDARD.encode(bytes)})
        .to_string(),
    };
    let intent = Intent {
        kind: ChangeOpKind::Create,
        raw_path: key.clone(),
        content: Some(payload),
        dest: None,
        target_kind: ObjectKind::Document,
        relation: None,
    };
    let mut scopes: Vec<_> = std::iter::once(vault)
        .chain(vaults.iter().map(String::as_str))
        .filter(|s| !s.is_empty())
        .map(|s| snapshot_path_key(Path::new(s)))
        .collect();
    scopes.sort();
    scopes.dedup();
    let ctx = WriteContext {
        actor: "agent".into(),
        run_id: crate::llm::tool_hooks::current_run_id(),
        primary_vault: vault.to_owned(),
        vaults: scopes,
        ..Default::default()
    };
    let conn = db.lock().map_err(|_| anyhow!("Database lock error"))?;
    let ready = match write_guard::open_intents(&conn, &ctx, tool, &[intent])? {
        Guarded::Ready(r) => r,
        Guarded::Refused { refusal, .. } => bail!("{}", refusal.message()),
        Guarded::Conflicted { changeset_id, .. } => bail!("Conflicted ChangeSet {changeset_id}"),
        Guarded::Unguarded => bail!("Missing file write guard"),
    };
    let outcome = publish_new(&path, bytes);
    let error = outcome.as_ref().err().map(ToString::to_string);
    let settlement = write_guard::settle(&conn, &ready, error.as_deref().map_or(Ok(()), Err));
    drop(conn);
    if outcome.is_ok() {
        journal_write(db, tool, "create", &key, None, None, None);
    }
    settlement?;
    outcome?;
    Ok(ready.changeset_id)
}

struct Original {
    bytes: Vec<u8>,
    origin: String,
    url: Option<String>,
    resolved_url: Option<String>,
    ext: String,
    name: String,
    local: Option<PathBuf>,
}

async fn fetch(raw: &str) -> Result<Original> {
    let mut url = url::Url::parse(raw)?;
    ensure!(
        matches!(url.scheme(), "http" | "https"),
        "Only HTTP(S) sources are supported"
    );
    url.set_fragment(None);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let mut response = client.get(url.clone()).send().await?.error_for_status()?;
    ensure!(
        response.content_length().unwrap_or(0) <= MAX_BYTES as u64,
        "Remote source exceeds 32 MiB"
    );
    let resolved = response.url().clone();
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            bytes.len().saturating_add(chunk.len()) <= MAX_BYTES,
            "Remote source exceeds 32 MiB"
        );
        bytes.extend_from_slice(&chunk);
    }
    let name = resolved
        .path_segments()
        .and_then(|mut s| s.next_back())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| resolved.host_str().unwrap_or("source"))
        .to_owned();
    let ext = if bytes.starts_with(b"%PDF-") {
        "pdf"
    } else {
        match mime.as_str() {
            "text/html" | "application/xhtml+xml" => "html",
            "text/plain" => "txt",
            "text/markdown" => "md",
            "text/csv" => "csv",
            "" | "application/octet-stream" => match extension(Path::new(&name)).as_str() {
                "htm" | "html" => "html",
                "md" => "md",
                "txt" => "txt",
                "csv" => "csv",
                _ => bail!("Remote source type is unavailable"),
            },
            _ => bail!("Unsupported remote source type: {mime}"),
        }
    };
    Ok(Original {
        bytes,
        origin: url.to_string(),
        url: Some(url.to_string()),
        resolved_url: Some(resolved.to_string()),
        name,
        ext: ext.to_owned(),
        local: None,
    })
}

fn convert(source: &Original) -> Result<(String, String)> {
    let text = || std::str::from_utf8(&source.bytes).context("Source text must be UTF-8");
    let mut title = String::new();
    let body = match source.ext.as_str() {
        "txt" | "text" | "md" | "markdown" => text()?.to_owned(),
        "html" | "htm" => {
            let (detected, body) = crate::import::html::html_to_markdown(text()?);
            title = detected;
            body
        }
        "csv" => crate::import::csv::csv_to_markdown(text()?),
        "docx" => docx_text(
            source.local.as_deref().context("Local DOCX required")?,
            &source.bytes,
        )?,
        "pdf" => {
            let pdf = range::pdf_document(&source.bytes)?;
            let pages = pdf.page_count()?;
            ensure!(pages <= 5_000, "PDF capture exceeds 5000 physical pages");
            let mut out = String::new();
            for i in 0..pages {
                let text = pdf.extract_text_from_page(i)?.text;
                out.push_str(&format!("\n## Page {}\n\n", i + 1));
                if text.trim().is_empty() {
                    out.push_str("[No extractable text; OCR required.]\n");
                } else {
                    out.push_str(&text);
                    out.push('\n');
                }
                ensure!(out.len() <= MAX_BYTES, "Extracted PDF text exceeds 32 MiB");
            }
            out
        }
        ext => bail!("Unsupported local source type: {ext}"),
    };
    Ok((title, body))
}

fn recorded_metadata(db: &Arc<Mutex<Connection>>, note: &Path) -> Result<Option<Value>> {
    let conn = db.lock().map_err(|_| anyhow!("Database lock error"))?;
    let content: Option<String> = conn
        .query_row(
            "SELECT o.new_content FROM changeset_ops o JOIN changesets c ON c.id=o.changeset_id
         WHERE o.legacy_path=?1 AND c.state='committed' AND c.intent='capture_source'
           AND o.op_kind='create' ORDER BY c.created_at_ms DESC LIMIT 1",
            [snapshot_path_key(note)],
            |r| r.get(0),
        )
        .optional()?;
    content
        .map(|c| {
            let metadata = c
                .lines()
                .find_map(|s| s.strip_prefix("source_metadata: "))
                .context("Missing metadata in capture record")?;
            Ok(serde_json::from_str(metadata)?)
        })
        .transpose()
}

pub async fn capture_source(
    args: &Value,
    db: &Arc<Mutex<Connection>>,
    vault: &str,
    vaults: &[String],
) -> Result<Value> {
    ensure!(
        args.get("url").is_some() ^ args.get("path").is_some(),
        "Provide exactly one url or path"
    );
    let dir = match args.get("output_dir") {
        Some(_) => required(args, "output_dir")?,
        None => "_sources",
    };
    let dir = absolute_output(Path::new(dir), vault, vaults)?;
    let source = if args.get("url").is_some() {
        fetch(required(args, "url")?).await?
    } else {
        let path = exact_file(required(args, "path")?, vault, vaults)?;
        Original {
            bytes: bounded_bytes(&path)?,
            origin: snapshot_path_key(&path),
            url: None,
            resolved_url: None,
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            ext: extension(&path),
            local: Some(path),
        }
    };
    let checksum = digest(&source.bytes);
    let origin_hash = digest(source.origin.as_bytes());
    // Title changes do not alter identity. A changed source version gets its own note.
    let stem: String = Path::new(&source.name)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_'))
        .take(32)
        .collect();
    let key = format!("source-{stem}-{}-{}", &origin_hash[..16], &checksum[..20]);
    let note = absolute_output(&dir.join(format!("{key}.md")), vault, vaults)?;
    let original = absolute_output(
        &dir.join(format!("{key}.original.{}", source.ext)),
        vault,
        vaults,
    )?;
    ensure!(note != original, "Invalid capture destination");
    // Serialize publication and dedupe after fetching so overlapping downloads
    // share a version while disk and audit records cross their commit boundary.
    static PUBLICATION: Mutex<()> = Mutex::new(());
    let _publication = PUBLICATION
        .lock()
        .map_err(|_| anyhow!("Capture publication lock error"))?;
    let existing = recorded_metadata(db, &note)?;
    ensure!(
        !note.exists() || existing.is_some(),
        "Unrelated file at capture note path"
    );
    if let Some(meta) = &existing {
        ensure!(
            meta["origin"] == source.origin && meta["source_checksum"] == checksum,
            "Capture identity conflict"
        );
    }
    if original.exists() {
        ensure!(
            bounded_bytes(&original)? == source.bytes,
            "Preserved original has been edited; capture stopped"
        );
    }
    let note_key = snapshot_path_key(&note);
    let original_key = snapshot_path_key(&original);
    let mut ids = Vec::new();
    let (metadata, body) = if note.exists() {
        (existing.context("Missing capture metadata")?, None)
    } else {
        let (detected, body) = convert(&source)?;
        let title = match args.get("title") {
            Some(_) => required(args, "title")?,
            None if !detected.is_empty() => &detected,
            None => &source.name,
        };
        let metadata = json!({"title":title,"origin":source.origin,"source_url":source.url,
            "resolved_url":source.resolved_url,"captured_at":chrono::Utc::now().to_rfc3339(),
            "source_checksum":checksum,"source_version":checksum,"original_path":original_key,
            "author":null,"published_at":null,"doi":null});
        let content = format!(
            "---\ntitle: {}\nsource_metadata: {}\n---\n\n{}\n",
            json!(title),
            metadata,
            body
        );
        (metadata, Some(content))
    };
    if !original.exists() {
        ids.push(guarded_create(
            db,
            vault,
            vaults,
            "capture_source",
            &original,
            &source.bytes,
        )?);
    }
    if let Some(content) = body {
        ids.push(guarded_create(
            db,
            vault,
            vaults,
            "capture_source",
            &note,
            content.as_bytes(),
        )?);
    }
    Ok(
        json!({"source_id":original_key,"path":note_key,"original_path":original_key,
        "source_checksum":checksum,"reused":ids.is_empty(),"title":metadata["title"],
        "metadata":metadata,"changeset_ids":ids}),
    )
}
