use std::path::{Path, PathBuf};
use tauri::{State, Manager, Emitter};
use crate::AppState;
use crate::error::ZettelError;
use crate::import::{ImportResult, import_pdf, import_docx, import_image};
use crate::llm::LlmConfig;

#[derive(serde::Serialize, Clone)]
pub struct ImportProgress {
    pub stage: String,
    pub file: String,
    pub progress: f32,
    pub message: String,
}

#[tauri::command]
pub async fn import_attachments(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    vault_path: String,
    file_paths: Vec<String>,
    llm_config: Option<LlmConfig>,
) -> Result<Vec<ImportResult>, ZettelError> {
    let resource_dir = app.path().resource_dir()?;
    let vault = PathBuf::from(&vault_path);
    if !vault.is_dir() {
        return Err(ZettelError::System(format!("Vault path is not a directory: {}", vault_path)));
    }
    
    let mut results = Vec::new();
    let total_files = file_paths.len();
    
    for (idx, path_str) in file_paths.iter().enumerate() {
        let source = PathBuf::from(path_str);
        let name = source.file_name().unwrap_or_default().to_string_lossy().to_string();
        
        let ext = source.extension().unwrap_or_default().to_string_lossy().to_lowercase();
        
        let file_progress = (idx as f32) / (total_files as f32);
        let _ = app.emit("import-progress", ImportProgress {
            stage: "parsing".to_string(),
            file: name.clone(),
            progress: file_progress,
            message: format!("Processing file {} of {}...", idx + 1, total_files),
        });
        
        let import_res = match ext.as_str() {
            "pdf" => {
                import_pdf(&vault, &source, &name, &resource_dir, llm_config.as_ref()).await
            }
            "docx" => {
                import_docx(&vault, &source, &name, &resource_dir, llm_config.as_ref()).await
            }
            "png" | "jpg" | "jpeg" | "webp" => {
                import_image(&vault, &source, &name, &resource_dir, llm_config.as_ref()).await
            }
            _ => ImportResult {
                source_name: name.clone(),
                import_type: "unsupported".to_string(),
                companion_path: None,
                success: false,
                error: Some(format!("Unsupported attachment file type: .{}", ext)),
            }
        };
        
        if import_res.success {
            if let Some(ref companion_path) = import_res.companion_path {
                let conn = state.db.lock()?;
                match crate::db::sync::sync_file(&conn, Path::new(companion_path)) {
                    Ok(_) => log::info!("Indexed companion markdown: {}", companion_path),
                    Err(e) => log::error!("Failed to index companion markdown {}: {}", companion_path, e),
                }
            }
        }
        
        results.push(import_res);
    }
    
    let _ = app.emit("import-progress", ImportProgress {
        stage: "done".to_string(),
        file: "".to_string(),
        progress: 1.0,
        message: "All imports completed!".to_string(),
    });
    
    Ok(results)
}
