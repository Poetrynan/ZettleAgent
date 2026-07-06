use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

/// Bootstrap config stored at `{app_data_dir}/db_config.json`.
/// Read before the database is opened, so it CANNOT live inside the DB.
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct DbConfig {
    /// Custom database file path. If None or empty, use default.
    pub custom_db_path: Option<String>,
}

/// Config file name (always at a fixed, known location).
const CONFIG_FILE: &str = "db_config.json";

/// Read the bootstrap config from `{app_data_dir}/db_config.json`.
pub fn read_config(app_data_dir: &Path) -> DbConfig {
    let path = app_data_dir.join(CONFIG_FILE);
    if path.exists() {
        match std::fs::read_to_string(&path) {
            Ok(json) => serde_json::from_str(&json).unwrap_or_default(),
            Err(_) => DbConfig::default(),
        }
    } else {
        DbConfig::default()
    }
}

/// Write the bootstrap config to `{app_data_dir}/db_config.json`.
pub fn write_config(app_data_dir: &Path, config: &DbConfig) -> anyhow::Result<()> {
    let path = app_data_dir.join(CONFIG_FILE);
    let json = serde_json::to_string_pretty(config)?;
    std::fs::write(&path, json)?;
    Ok(())
}

/// Resolve the actual database path:
/// - If custom path is set and non-empty, use it
/// - Otherwise, use default `{app_data_dir}/zettelagent.db`
pub fn resolve_db_path(app_data_dir: &Path) -> PathBuf {
    let config = read_config(app_data_dir);
    if let Some(ref custom) = config.custom_db_path {
        let custom = custom.trim();
        if !custom.is_empty() {
            let p = PathBuf::from(custom);
            // Ensure parent directory exists
            if let Some(parent) = p.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            return p;
        }
    }
    app_data_dir.join("zettelagent.db")
}
