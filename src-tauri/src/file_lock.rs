use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use std::thread;

/// Per-path write locks. Foreground tool calls and the background reconcile task run
/// in the same process, so serializing here is what actually prevents lost updates —
/// an OS advisory lock on the target file cannot be combined with atomic rename.
fn path_locks() -> &'static Mutex<HashMap<PathBuf, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_for(path: &Path) -> Arc<Mutex<()>> {
    let key = path.to_path_buf();
    let mut map = path_locks()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    map.entry(key).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
}

/// Write `content` to `path` atomically and durably.
///
/// Writes to a sibling temp file, fsyncs it, then renames it over the target. A crash,
/// full disk, or antivirus/cloud-sync interruption can therefore never leave a truncated
/// or zero-byte note behind: the target either holds the old content or the new content.
///
/// Rename is retried briefly because on Windows it fails while another process (Obsidian,
/// OneDrive, an indexer) holds the target open.
pub fn safe_write(path: &Path, content: &str) -> anyhow::Result<()> {
    safe_write_timeout(path, content, 5, Duration::from_millis(60))
}

/// Same as [`safe_write`] but with an explicit retry budget for the final rename.
pub fn safe_write_timeout(
    path: &Path,
    content: &str,
    retries: usize,
    delay: Duration,
) -> anyhow::Result<()> {
    let guard = lock_for(path);
    let _held = guard
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }

    // Temp file must be a sibling: rename is only atomic within the same volume.
    // The `.tmp` suffix keeps it out of the file watcher, which only reacts to `.md`.
    let mut tmp_name = path.as_os_str().to_os_string();
    tmp_name.push(format!(".{}.tmp", std::process::id()));
    let tmp_path = PathBuf::from(tmp_name);

    let staged = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&tmp_path)?;
        file.write_all(content.as_bytes())?;
        file.flush()?;
        // Durability: without this the rename can land before the data does.
        file.sync_all()?;
        Ok(())
    })();

    if let Err(e) = staged {
        let _ = fs::remove_file(&tmp_path);
        return Err(anyhow::anyhow!(
            "failed staging write for {}: {}",
            path.display(),
            e
        ));
    }

    let attempts = retries.max(1);
    let mut last_err = None;
    for attempt in 0..attempts {
        match fs::rename(&tmp_path, path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = Some(e);
                if attempt + 1 < attempts {
                    thread::sleep(delay);
                }
            }
        }
    }

    // Leave the original file untouched rather than half-written.
    let _ = fs::remove_file(&tmp_path);
    Err(anyhow::anyhow!(
        "failed to replace {} after {} attempt(s): {}",
        path.display(),
        attempts,
        last_err
            .map(|e| e.to_string())
            .unwrap_or_else(|| "unknown error".to_string())
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_then_overwrites_without_truncating() {
        let dir = std::env::temp_dir().join(format!("zettel_flock_{}", std::process::id()));
        let path = dir.join("note.md");
        safe_write(&path, "第一版内容").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "第一版内容");

        safe_write(&path, "第二版内容更长一些").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "第二版内容更长一些");

        // No temp files left behind.
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files leaked: {:?}", leftovers);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn creates_missing_parent_directories() {
        let dir = std::env::temp_dir().join(format!("zettel_flock_nested_{}", std::process::id()));
        let path = dir.join("a").join("b").join("note.md");
        safe_write(&path, "nested").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "nested");
        let _ = fs::remove_dir_all(&dir);
    }
}
