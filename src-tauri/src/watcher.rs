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

/// Create a debounced file watcher for the given vault directory.
/// Returns the watcher handle (must be kept alive) and a receiver for events.
pub fn create_watcher(
    vault_path: &Path,
) -> anyhow::Result<(notify_debouncer_mini::Debouncer<notify_debouncer_mini::notify::RecommendedWatcher>, mpsc::Receiver<Vec<WatcherEvent>>)> {
    let (tx, rx) = mpsc::channel();

    let mut debouncer = new_debouncer(
        Duration::from_millis(500),
        move |events: Result<Vec<DebouncedEvent>, notify_debouncer_mini::notify::Error>| {
            match events {
                Ok(debounced_events) => {
                    let watcher_events: Vec<WatcherEvent> = debounced_events
                        .into_iter()
                        .filter_map(|e| {
                            let path = e.path.to_path_buf();
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
