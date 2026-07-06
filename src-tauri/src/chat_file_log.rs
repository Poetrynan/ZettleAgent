//! Append-only file logs for Agent / RAG troubleshooting.
//!
//! Release: `{app_data_dir}/logs/agent.log` and `rag.log`
//! Dev build: also mirrors to `{project_root}/logs/` (gitignored)

use chrono::Local;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

struct LogPaths {
    agent: PathBuf,
    rag: PathBuf,
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

    let agent = app_logs.join("agent.log");
    let rag = app_logs.join("rag.log");

    let header = format!(
        "=== ZettelAgent log started {} ===",
        Local::now().format("%Y-%m-%d %H:%M:%S")
    );
    append_line_to(&agent, &header);
    append_line_to(&rag, &header);

    if let Some(ref dev) = dev_mirror {
        append_line_to(&dev.join("agent.log"), &header);
        append_line_to(&dev.join("rag.log"), &header);
        log::info!("Chat file logs (dev mirror): {}", dev.display());
    }

    log::info!("Chat file logs: {}", app_logs.display());

    let _ = PATHS.set(Mutex::new(LogPaths {
        agent,
        rag,
        dev_mirror,
    }));
}

fn append_line_to(path: &Path, line: &str) {
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{}", line);
    }
}

fn write_channel(channel: &str, message: &str) {
    let Some(paths) = PATHS.get() else {
        return;
    };
    let Ok(guard) = paths.lock() else {
        return;
    };

    let line = format!(
        "[{}] {}",
        Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
        message
    );

    let primary = match channel {
        "rag" => &guard.rag,
        _ => &guard.agent,
    };
    append_line_to(primary, &line);

    if let Some(ref dev) = guard.dev_mirror {
        let name = if channel == "rag" { "rag.log" } else { "agent.log" };
        append_line_to(&dev.join(name), &line);
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

pub fn log_agent(message: &str) {
    write_channel("agent", message);
}

pub fn log_rag(message: &str) {
    write_channel("rag", message);
}

#[cfg(test)]
mod tests {
    use super::trunc;

    #[test]
    fn trunc_is_char_safe_for_cjk() {
        let s = "运行知识库健康检查识别孤立卡片和结构问题".repeat(20);
        let out = trunc(&s, 30);
        assert!(out.contains('…'));
        assert!(std::panic::catch_unwind(|| trunc(&s, 30)).is_ok());
    }
}
