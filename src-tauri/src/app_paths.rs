use std::path::PathBuf;
use std::sync::OnceLock;

static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Called once from Tauri `setup` — points at the bundled resources root.
pub fn init_resource_dir(path: PathBuf) {
    let _ = RESOURCE_DIR.set(path);
}

/// Bundled resources root: `ocr_models/`, `demo-vault/` live here.
pub fn bundled_resource_dir() -> PathBuf {
    RESOURCE_DIR.get().cloned().unwrap_or_else(fallback_resource_dir)
}

fn fallback_resource_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            // Tauri installer layout: `{exe_dir}/resources/ocr_models/`
            let with_resources = parent.join("resources");
            if with_resources.join("ocr_models").is_dir() {
                return with_resources;
            }
            // Dev fallback: resources copied next to the binary
            if parent.join("ocr_models").is_dir() {
                return parent.to_path_buf();
            }
        }
    }
    PathBuf::from(".")
}
