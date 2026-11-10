//! Source reads bind locators and checksums to one exact, scoped file.
use anyhow::{anyhow, bail, ensure, Context, Result};
use rusqlite::Connection;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::tools::internal_tools::helpers::{
    is_path_in_any_vault, resolve_for_containment, snapshot_path_key,
};
mod capture;
mod quote;
mod range;
#[cfg(test)]
mod tests;
pub use capture::capture_source;
pub(crate) use capture::guarded_create;

const MAX_BYTES: usize = 32 * 1024 * 1024;

fn required<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args[key]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| anyhow!("{key} must be a nonempty string"))
}

fn validate_path(raw: &str) -> Result<&Path> {
    let path = Path::new(raw);
    ensure!(!raw.trim().is_empty(), "Empty path");
    ensure!(
        !path.components().any(|c| c == Component::ParentDir),
        "Parent traversal is not permitted"
    );
    ensure!(
        path.is_absolute()
            || path
                .components()
                .all(|c| matches!(c, Component::CurDir | Component::Normal(_))),
        "Invalid relative path"
    );
    #[cfg(windows)]
    ensure!(
        !path
            .components()
            .any(|c| matches!(c,Component::Normal(part) if part.to_string_lossy().contains(':'))),
        "Windows alternate streams are not sources"
    );
    Ok(path)
}

fn exact_file(raw: &str, vault: &str, vaults: &[String]) -> Result<PathBuf> {
    let path = validate_path(raw)?;
    let mut candidates = Vec::new();
    for root in std::iter::once(vault)
        .chain(vaults.iter().map(String::as_str))
        .filter(|s| !s.is_empty())
    {
        let root = Path::new(root).canonicalize()?;
        let joined = root.join(path);
        if !joined.is_file() {
            continue;
        }
        let canonical = joined.canonicalize()?;
        if canonical.starts_with(&root) && !candidates.contains(&canonical) {
            candidates.push(canonical);
        }
    }
    ensure!(
        candidates.len() <= 1,
        "Ambiguous source path; use an absolute path"
    );
    candidates
        .pop()
        .ok_or_else(|| anyhow!("Exact source file is missing or outside configured vaults: {raw}"))
}

fn bounded_bytes(path: &Path) -> Result<Vec<u8>> {
    let file = fs::File::open(path)?;
    ensure!(
        file.metadata()?.len() <= MAX_BYTES as u64,
        "Source exceeds 32 MiB"
    );
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= MAX_BYTES, "Source exceeds 32 MiB");
    Ok(bytes)
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn docx_text(path: &Path, bytes: &[u8]) -> Result<String> {
    // The existing importer extracts embedded images too. Bound the expanded
    // archive before invoking it and verify the file version after extraction.
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;
    let mut expanded = 0u64;
    ensure!(
        archive.by_name("word/document.xml").is_ok(),
        "Missing DOCX document"
    );
    for n in 0..archive.len() {
        expanded = expanded.saturating_add(archive.by_index(n)?.size());
        ensure!(expanded <= 64 * 1024 * 1024, "Expanded DOCX exceeds 64 MiB");
    }
    let result = crate::import::docx::extract_text_from_docx(path)?;
    ensure!(
        bounded_bytes(path)? == bytes,
        "DOCX changed during extraction"
    );
    Ok(result.text)
}

fn validate_checksum(r: &range::Range, actual: &str) -> Result<()> {
    if let Some(expected) = &r.expected_checksum {
        ensure!(
            expected.eq_ignore_ascii_case(actual),
            "Stale source checksum: expected {expected}, current {actual}"
        );
    }
    Ok(())
}

pub fn read_source_range(args: &Value, vault: &str, vaults: &[String]) -> Result<Value> {
    let path = exact_file(required(args, "path")?, vault, vaults)?;
    let bytes = bounded_bytes(&path)?;
    let checksum = digest(&bytes);
    let r = serde_json::from_value(args.clone())?;
    validate_checksum(&r, &checksum)?;
    let mut result = range::contents(&path, &bytes, &r, 12_000)?;
    let key = snapshot_path_key(&path);
    result["path"] = json!(key);
    result["source_id"] = json!(key);
    result["source_checksum"] = json!(checksum);
    Ok(result)
}

pub fn verify_quote(args: &Value, vault: &str, vaults: &[String]) -> Result<Value> {
    quote::verify(args, vault, vaults)
}
