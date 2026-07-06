//! Append-only file logs for Smart Organize and Embedding Index pipelines.
//!
//! Release: `{app_data_dir}/logs/organize.log` and `embedding.log`
//! Dev build: also mirrors to `{project_root}/logs/` (gitignored)

use chrono::Local;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

struct LogPaths {
    organize: PathBuf,
    embedding: PathBuf,
    /// Dev-only mirror directory (project `logs/`)
    dev_mirror: Option<PathBuf>,
}

static PATHS: OnceLock<Mutex<LogPaths>> = OnceLock::new();

fn dev_project_logs_dir() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.join("logs"))
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
}

/// Call once at app startup with Tauri `app_data_dir`.
pub fn init(app_data_dir: &Path) {
    let app_logs = app_data_dir.join("logs");
    let _ = std::fs::create_dir_all(&app_logs);

    let dev_mirror = dev_project_logs_dir();
    if let Some(ref dev) = dev_mirror {
        let _ = std::fs::create_dir_all(dev);
    }

    let organize = app_logs.join("organize.log");
    let embedding = app_logs.join("embedding.log");

    let header = format!(
        "=== ZettelAgent pipeline log started {} ===",
        Local::now().format("%Y-%m-%d %H:%M:%S")
    );
    append_line_to(&organize, &header);
    append_line_to(&embedding, &header);

    if let Some(ref dev) = dev_mirror {
        append_line_to(&dev.join("organize.log"), &header);
        append_line_to(&dev.join("embedding.log"), &header);
        log::info!("Pipeline logs (dev mirror): {}", dev.display());
    }

    log::info!("Pipeline logs: {}", app_logs.display());

    let _ = PATHS.set(Mutex::new(LogPaths {
        organize,
        embedding,
        dev_mirror,
    }));
}

fn append_line_to(path: &Path, line: &str) {
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{}", line);
    }
}

fn write_channel(channel: &str, level: &str, message: &str) {
    let Some(paths) = PATHS.get() else {
        return;
    };
    let Ok(guard) = paths.lock() else {
        return;
    };

    let line = format!(
        "[{}] [{}] {}",
        Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
        level,
        message
    );

    let (primary, dev_name) = match channel {
        "embedding" => (&guard.embedding, "embedding.log"),
        _ => (&guard.organize, "organize.log"),
    };
    append_line_to(primary, &line);

    if let Some(ref dev) = guard.dev_mirror {
        append_line_to(&dev.join(dev_name), &line);
    }
}

/// Truncate long text for log lines (char-safe — never splits multibyte UTF-8).
pub fn trunc(s: &str, max_chars: usize) -> String {
    let char_count = s.chars().count();
    if char_count <= max_chars {
        s.to_string()
    } else {
        let head: String = s.chars().take(max_chars).collect();
        format!("{head}… ({char_count} chars)")
    }
}

// ── Smart Organize log helpers ──────────────────────────────────────

pub fn log_organize_info(message: &str) {
    write_channel("organize", "INFO", message);
    log::info!("[organize] {}", message);
}

pub fn log_organize_warn(message: &str) {
    write_channel("organize", "WARN", message);
    log::warn!("[organize] {}", message);
}

pub fn log_organize_error(message: &str) {
    write_channel("organize", "ERROR", message);
    log::error!("[organize] {}", message);
}

// ── Embedding log helpers ───────────────────────────────────────────

pub fn log_embedding_info(message: &str) {
    write_channel("embedding", "INFO", message);
    log::info!("[embedding] {}", message);
}

#[allow(dead_code)]
pub fn log_embedding_warn(message: &str) {
    write_channel("embedding", "WARN", message);
    log::warn!("[embedding] {}", message);
}

pub fn log_embedding_error(message: &str) {
    write_channel("embedding", "ERROR", message);
    log::error!("[embedding] {}", message);
}
