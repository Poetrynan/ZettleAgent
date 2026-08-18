use notify_debouncer_mini::{new_debouncer, DebouncedEvent, DebouncedEventKind};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

/// Events emitted by the file watcher to the application.
#[derive(Debug)]
pub enum WatcherEvent {
    /// A file was created or modified
    FileChanged(PathBuf),
    /// A file was deleted
    FileDeleted(PathBuf),
}

/// True when `path` sits inside a dot-directory *below* `root`.
///
/// The watcher is recursive and only filters on the `.md` extension, so without this
/// a note moved into `<vault>/.zettelagent/trash/...` by `delete_note` would be
/// re-indexed straight back into the DB. Only components below `root` are inspected,
/// so a vault that itself lives in a hidden folder keeps working; a file name that
/// starts with `.` is also still allowed.
fn is_in_hidden_subdir(root: &Path, path: &Path) -> bool {
    let rel = match path.strip_prefix(root) {
        Ok(r) => r,
        // Unexpected shape (different prefix form) — do not filter.
        Err(_) => return false,
    };
    let mut dirs: Vec<_> = rel.components().collect();
    dirs.pop(); // drop the file name itself
    dirs.iter().any(|c| {
        matches!(c, std::path::Component::Normal(name)
            if name.to_string_lossy().starts_with('.'))
    })
}

/// Create a debounced file watcher for the given vault directory.
/// Returns the watcher handle (must be kept alive) and a receiver for events.
pub fn create_watcher(
    vault_path: &Path,
) -> anyhow::Result<(notify_debouncer_mini::Debouncer<notify_debouncer_mini::notify::RecommendedWatcher>, mpsc::Receiver<Vec<WatcherEvent>>)> {
    let (tx, rx) = mpsc::channel();
    let root = vault_path.to_path_buf();

    let mut debouncer = new_debouncer(
        Duration::from_millis(500),
        move |events: Result<Vec<DebouncedEvent>, notify_debouncer_mini::notify::Error>| {
            match events {
                Ok(debounced_events) => {
                    let watcher_events: Vec<WatcherEvent> = debounced_events
                        .into_iter()
                        .filter_map(|e| {
                            let path = e.path.to_path_buf();
                            // Skip the recycle bin and any other dot-directory
                            if is_in_hidden_subdir(&root, &path) {
                                return None;
                            }
                            // Only process .md files
                            if path.extension().map_or(false, |ext| ext == "md") {
                                match e.kind {
                                    DebouncedEventKind::Any => {
                                        if path.exists() {
                                            Some(WatcherEvent::FileChanged(path))
                                        } else {
                                            Some(WatcherEvent::FileDeleted(path))
                                        }
                                    }
                                    _ => None,
                                }
                            } else {
                                None
                            }
                        })
                        .collect();

                    if !watcher_events.is_empty() {
                        let _ = tx.send(watcher_events);
                    }
                }
                Err(error) => {
                    log::error!("File watcher error: {:?}", error);
                }
            }
        },
    )?;

    // Start watching the vault directory recursively
    debouncer
        .watcher()
        .watch(vault_path, notify_debouncer_mini::notify::RecursiveMode::Recursive)?;

    log::info!("File watcher started for {:?}", vault_path);
    Ok((debouncer, rx))
}
