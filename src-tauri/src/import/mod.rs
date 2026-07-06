pub mod html;
pub mod csv;
pub mod pdf;
pub mod docx;
pub mod ocr;

use crate::error::ZettelError;
use std::path::{Path, PathBuf};

/// Result of importing a single file.
#[derive(serde::Serialize, Clone, Debug)]
pub struct ImportResult {
    /// Original file name
    pub source_name: String,
    /// Type of import performed
    pub import_type: String,
    /// Path of the companion .md file (or copied .md)
    pub companion_path: Option<String>,
    /// Whether the import succeeded
    pub success: bool,
    /// Error message if failed
    pub error: Option<String>,
}

/// Ensure the `_imports/` subfolder exists in the vault.
pub fn ensure_imports_dir(vault_path: &Path) -> Result<PathBuf, ZettelError> {
    let imports_dir = vault_path.join("_imports");
    if !imports_dir.exists() {
        std::fs::create_dir_all(&imports_dir)?;
    }
    Ok(imports_dir)
}

/// Generate a unique filename to avoid collisions.
/// If `target.md` exists, tries `target_1.md`, `target_2.md`, etc.
pub fn unique_path(base: &Path) -> PathBuf {
    if !base.exists() {
        return base.to_path_buf();
    }
    let stem = base.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let ext = base.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
    let parent = base.parent().unwrap_or(Path::new("."));
    for i in 1..1000 {
        let candidate = parent.join(format!("{}_{}.{}", stem, i, ext));
        if !candidate.exists() {
            return candidate;
        }
    }
    base.to_path_buf()
}

/// Import a single file into the vault.
/// - `.md` files are copied directly.
/// - `.html`/`.htm` files: original → `_imports/`, companion `.md` created.
/// - `.csv` files: original → `_imports/`, companion `.md` created.
pub fn import_file(vault_path: &Path, source_path: &Path) -> ImportResult {
    let source_name = source_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let ext = source_path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();

    match ext.as_str() {
        "md" => import_md(vault_path, source_path, &source_name),
        "html" | "htm" => import_html(vault_path, source_path, &source_name),
        "csv" => import_csv(vault_path, source_path, &source_name),
        "pdf" => {
            let resource_dir = crate::app_paths::bundled_resource_dir();
            tokio::task::block_in_place(|| {
                tokio::runtime::Handle::current()
                    .block_on(import_pdf(vault_path, source_path, &source_name, &resource_dir, None))
            })
        }
        "docx" => {
            let resource_dir = crate::app_paths::bundled_resource_dir();
            tokio::task::block_in_place(|| {
                tokio::runtime::Handle::current()
                    .block_on(import_docx(vault_path, source_path, &source_name, &resource_dir, None))
            })
        }
        "png" | "jpg" | "jpeg" | "webp" => {
            let resource_dir = crate::app_paths::bundled_resource_dir();
            tokio::task::block_in_place(|| {
                tokio::runtime::Handle::current()
                    .block_on(import_image(vault_path, source_path, &source_name, &resource_dir, None))
            })
        }
        _ => ImportResult {
            source_name,
            import_type: "unsupported".to_string(),
            companion_path: None,
            success: false,
            error: Some(format!("Unsupported file type: .{}", ext)),
        },
    }
}

fn import_md(vault_path: &Path, source: &Path, name: &str) -> ImportResult {
    let target = unique_path(&vault_path.join(name));
    match std::fs::copy(source, &target) {
        Ok(_) => ImportResult {
            source_name: name.to_string(),
            import_type: "markdown".to_string(),
            companion_path: Some(target.to_string_lossy().to_string()),
            success: true,
            error: None,
        },
        Err(e) => ImportResult {
            source_name: name.to_string(),
            import_type: "markdown".to_string(),
            companion_path: None,
            success: false,
            error: Some(format!("Failed to copy: {}", e)),
        },
    }
}

fn import_html(vault_path: &Path, source: &Path, name: &str) -> ImportResult {
    // 1. Copy original to _imports/
    let imports_dir = match ensure_imports_dir(vault_path) {
        Ok(d) => d,
        Err(e) => return ImportResult {
            source_name: name.to_string(),
            import_type: "html".to_string(),
            companion_path: None,
            success: false,
            error: Some(format!("Failed to create _imports dir: {}", e)),
        },
    };
    let import_target = unique_path(&imports_dir.join(name));
    if let Err(e) = std::fs::copy(source, &import_target) {
        return ImportResult {
            source_name: name.to_string(),
            import_type: "html".to_string(),
            companion_path: None,
            success: false,
            error: Some(format!("Failed to copy to _imports: {}", e)),
        };
    }

    // 2. Parse HTML and generate companion .md
    let raw_html = match std::fs::read_to_string(source) {
        Ok(s) => s,
        Err(e) => return ImportResult {
            source_name: name.to_string(),
            import_type: "html".to_string(),
            companion_path: None,
            success: false,
            error: Some(format!("Failed to read HTML: {}", e)),
        },
    };

    let (title, markdown) = html::html_to_markdown(&raw_html);
    let title = if title.is_empty() {
        Path::new(name).file_stem().unwrap_or_default().to_string_lossy().to_string()
    } else {
        title
    };

    let relative_import = format!("_imports/{}", import_target.file_name().unwrap_or_default().to_string_lossy());
    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();

    let companion_content = format!(
        "---\ntype: import\nsource: \"{}\"\nsource_type: html\nimported: \"{}\"\ntitle: \"{}\"\n---\n\n# {}\n\n> 📎 源文件: `{}` — 在侧边栏 _imports 文件夹中点击可打开\n\n{}\n\n<!-- @user -->\n\n<!-- @generated -->\n",
        relative_import,
        now,
        title.replace('"', "'"),
        title,
        relative_import,
        markdown,
    );

    let md_name = format!("{}.md", Path::new(name).file_stem().unwrap_or_default().to_string_lossy());
    let companion_path = unique_path(&vault_path.join(&md_name));
    match std::fs::write(&companion_path, companion_content) {
        Ok(_) => ImportResult {
            source_name: name.to_string(),
            import_type: "html".to_string(),
            companion_path: Some(companion_path.to_string_lossy().to_string()),
            success: true,
            error: None,
        },
        Err(e) => ImportResult {
            source_name: name.to_string(),
            import_type: "html".to_string(),
            companion_path: None,
            success: false,
            error: Some(format!("Failed to write companion .md: {}", e)),
        },
    }
}

fn import_csv(vault_path: &Path, source: &Path, name: &str) -> ImportResult {
    // 1. Copy original to _imports/
    let imports_dir = match ensure_imports_dir(vault_path) {
        Ok(d) => d,
        Err(e) => return ImportResult {
            source_name: name.to_string(),
            import_type: "csv".to_string(),
            companion_path: None,
            success: false,
            error: Some(format!("Failed to create _imports dir: {}", e)),
        },
    };
    let import_target = unique_path(&imports_dir.join(name));
    if let Err(e) = std::fs::copy(source, &import_target) {
        return ImportResult {
            source_name: name.to_string(),
            import_type: "csv".to_string(),
            companion_path: None,
            success: false,
            error: Some(format!("Failed to copy to _imports: {}", e)),
        };
    }

    // 2. Parse CSV and generate companion .md
    let raw_csv = match std::fs::read_to_string(source) {
        Ok(s) => s,
        Err(e) => return ImportResult {
            source_name: name.to_string(),
            import_type: "csv".to_string(),
            companion_path: None,
            success: false,
            error: Some(format!("Failed to read CSV: {}", e)),
        },
    };

    let markdown = csv::csv_to_markdown(&raw_csv);
    let file_stem = Path::new(name).file_stem().unwrap_or_default().to_string_lossy().to_string();
    let relative_import = format!("_imports/{}", import_target.file_name().unwrap_or_default().to_string_lossy());
    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();

    // Count rows
    let row_count = raw_csv.lines().count().saturating_sub(1); // minus header

    let companion_content = format!(
        "---\ntype: import\nsource: \"{}\"\nsource_type: csv\nimported: \"{}\"\nrows: {}\n---\n\n# {}\n\n> 📎 源文件: `{}` ({} rows) — 在侧边栏 _imports 文件夹中点击可打开\n\n{}\n\n<!-- @user -->\n\n<!-- @generated -->\n",
        relative_import,
        now,
        row_count,
        file_stem,
        relative_import,
        row_count,
        markdown,
    );

    let md_name = format!("{}.md", file_stem);
    let companion_path = unique_path(&vault_path.join(&md_name));
    match std::fs::write(&companion_path, companion_content) {
        Ok(_) => ImportResult {
            source_name: name.to_string(),
            import_type: "csv".to_string(),
            companion_path: Some(companion_path.to_string_lossy().to_string()),
            success: true,
            error: None,
        },
        Err(e) => ImportResult {
            source_name: name.to_string(),
            import_type: "csv".to_string(),
            companion_path: None,
            success: false,
            error: Some(format!("Failed to write companion .md: {}", e)),
        },
    }
}

pub async fn import_pdf(
    vault_path: &Path,
    source: &Path,
    name: &str,
    app_data_dir: &Path,
    llm_config: Option<&crate::llm::LlmConfig>,
) -> ImportResult {
    let imports_dir = match ensure_imports_dir(vault_path) {
        Ok(d) => d,
        Err(e) => return ImportResult {
            source_name: name.to_string(),
            import_type: "pdf".to_string(),
            companion_path: None,
            success: false,
            error: Some(format!("Failed to create _imports dir: {}", e)),
        },
    };
    
    let import_target = unique_path(&imports_dir.join(name));
    if let Err(e) = std::fs::copy(source, &import_target) {
        return ImportResult {
            source_name: name.to_string(),
            import_type: "pdf".to_string(),
            companion_path: None,
            success: false,
            error: Some(format!("Failed to copy to _imports: {}", e)),
        };
    }
    
    let mut pages = match pdf::extract_text_from_pdf(source) {
        Ok(p) => p,
        Err(e) => return ImportResult {
            source_name: name.to_string(),
            import_type: "pdf".to_string(),
            companion_path: None,
            success: false,
            error: Some(format!("Failed to extract PDF text: {}", e)),
        },
    };
    
    let temp_img_dir = imports_dir.join(format!(".tmp_{}", uuid::Uuid::new_v4()));
    let _ = std::fs::create_dir_all(&temp_img_dir);
    
    let mut ocr_success = true;
    if let Ok(images) = pdf::extract_pdf_images(source, &temp_img_dir) {
        for (page_num, img_path) in images {
            if let Some(ref mut page) = pages.iter_mut().find(|p| p.page == page_num) {
                if page.needs_ocr {
                    if let Ok(bytes) = std::fs::read(&img_path) {
                        let ocr_text = ocr::extract_text_from_image(&bytes, llm_config, app_data_dir).await;
                        
                        match ocr_text {
                            Ok(text) => {
                                if !text.trim().is_empty() {
                                    if page.text.trim().is_empty() {
                                        page.text = text;
                                    } else {
                                        page.text.push_str("\n\n");
                                        page.text.push_str(&text);
                                    }
                                }
                            }
                            Err(e) => {
                                log::warn!("OCR failed for page {}: {}", page_num, e);
                                ocr_success = false;
                            }
                        }
                    }
                }
            }
        }
    }
    
    let _ = std::fs::remove_dir_all(&temp_img_dir);
    
    let mut md_content = String::new();
    for page in &pages {
        md_content.push_str(&format!("## Page {}\n\n{}\n\n", page.page, page.text));
    }
    
    let relative_import = format!("_imports/{}", import_target.file_name().unwrap_or_default().to_string_lossy());
    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    let file_stem = Path::new(name).file_stem().unwrap_or_default().to_string_lossy().to_string();
    
    let companion_content = format!(
        "---\ntype: import\nsource: \"{}\"\nsource_type: pdf\nimported: \"{}\"\ntitle: \"{}\"\n---\n\n# {}\n\n> 📎 源文件: `{}` — 在侧边栏 _imports 文件夹中点击可打开\n\n{}\n\n<!-- @user -->\n\n<!-- @generated -->\n",
        relative_import,
        now,
        file_stem.replace('"', "'"),
        file_stem,
        relative_import,
        md_content,
    );
    
    let md_name = format!("{}.md", Path::new(name).file_stem().unwrap_or_default().to_string_lossy());
    let companion_path = unique_path(&vault_path.join(&md_name));
    match std::fs::write(&companion_path, companion_content) {
        Ok(_) => ImportResult {
            source_name: name.to_string(),
            import_type: "pdf".to_string(),
            companion_path: Some(companion_path.to_string_lossy().to_string()),
            success: true,
            error: if ocr_success { None } else { Some("Some pages failed OCR extraction".to_string()) },
        },
        Err(e) => ImportResult {
            source_name: name.to_string(),
            import_type: "pdf".to_string(),
            companion_path: None,
            success: false,
            error: Some(format!("Failed to write companion .md: {}", e)),
        },
    }
}

pub async fn import_docx(
    vault_path: &Path,
    source: &Path,
    name: &str,
    app_data_dir: &Path,
    llm_config: Option<&crate::llm::LlmConfig>,
) -> ImportResult {
    let imports_dir = match ensure_imports_dir(vault_path) {
        Ok(d) => d,
        Err(e) => return ImportResult {
            source_name: name.to_string(),
            import_type: "docx".to_string(),
            companion_path: None,
            success: false,
            error: Some(format!("Failed to create _imports dir: {}", e)),
        },
    };
    
    let import_target = unique_path(&imports_dir.join(name));
    if let Err(e) = std::fs::copy(source, &import_target) {
        return ImportResult {
            source_name: name.to_string(),
            import_type: "docx".to_string(),
            companion_path: None,
            success: false,
            error: Some(format!("Failed to copy to _imports: {}", e)),
        };
    }
    
    let doc_content = match docx::extract_text_from_docx(source) {
        Ok(c) => c,
        Err(e) => return ImportResult {
            source_name: name.to_string(),
            import_type: "docx".to_string(),
            companion_path: None,
            success: false,
            error: Some(format!("Failed to extract Docx content: {}", e)),
        },
    };
    
    let mut ocr_texts = Vec::new();
    
    for (img_name, img_bytes) in &doc_content.images {
        let ocr_res = ocr::extract_text_from_image(img_bytes, llm_config, app_data_dir).await;
        
        match ocr_res {
            Ok(text) => {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    ocr_texts.push(format!("### [Embedded Image: {}]\n\n{}", img_name, trimmed));
                }
            }
            Err(e) => {
                log::warn!("OCR failed for docx image {}: {}", img_name, e);
            }
        }
    }
    
    let mut full_text = doc_content.text;
    if !ocr_texts.is_empty() {
        full_text.push_str("\n\n---\n\n## 📷 Extracted Image Text (OCR)\n\n");
        full_text.push_str(&ocr_texts.join("\n\n"));
    }
    
    let relative_import = format!("_imports/{}", import_target.file_name().unwrap_or_default().to_string_lossy());
    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    let file_stem = Path::new(name).file_stem().unwrap_or_default().to_string_lossy().to_string();
    
    let companion_content = format!(
        "---\ntype: import\nsource: \"{}\"\nsource_type: docx\nimported: \"{}\"\ntitle: \"{}\"\n---\n\n# {}\n\n> 📎 源文件: `{}` — 在侧边栏 _imports 文件夹中点击可打开\n\n{}\n\n<!-- @user -->\n\n<!-- @generated -->\n",
        relative_import,
        now,
        file_stem.replace('"', "'"),
        file_stem,
        relative_import,
        full_text,
    );
    
    let md_name = format!("{}.md", Path::new(name).file_stem().unwrap_or_default().to_string_lossy());
    let companion_path = unique_path(&vault_path.join(&md_name));
    match std::fs::write(&companion_path, companion_content) {
        Ok(_) => ImportResult {
            source_name: name.to_string(),
            import_type: "docx".to_string(),
            companion_path: Some(companion_path.to_string_lossy().to_string()),
            success: true,
            error: None,
        },
        Err(e) => ImportResult {
            source_name: name.to_string(),
            import_type: "docx".to_string(),
            companion_path: None,
            success: false,
            error: Some(format!("Failed to write companion .md: {}", e)),
        },
    }
}

pub async fn import_image(
    vault_path: &Path,
    source: &Path,
    name: &str,
    app_data_dir: &Path,
    llm_config: Option<&crate::llm::LlmConfig>,
) -> ImportResult {
    let imports_dir = match ensure_imports_dir(vault_path) {
        Ok(d) => d,
        Err(e) => return ImportResult {
            source_name: name.to_string(),
            import_type: "image".to_string(),
            companion_path: None,
            success: false,
            error: Some(format!("Failed to create _imports dir: {}", e)),
        },
    };
    
    let import_target = unique_path(&imports_dir.join(name));
    if let Err(e) = std::fs::copy(source, &import_target) {
        return ImportResult {
            source_name: name.to_string(),
            import_type: "image".to_string(),
            companion_path: None,
            success: false,
            error: Some(format!("Failed to copy to _imports: {}", e)),
        };
    }
    
    let bytes = match std::fs::read(source) {
        Ok(b) => b,
        Err(e) => return ImportResult {
            source_name: name.to_string(),
            import_type: "image".to_string(),
            companion_path: None,
            success: false,
            error: Some(format!("Failed to read image: {}", e)),
        },
    };
    
    let ocr_res = ocr::extract_text_from_image(&bytes, llm_config, app_data_dir).await;
    
    let ocr_text = match ocr_res {
        Ok(t) => t,
        Err(e) => {
            log::warn!("OCR failed for image: {}", e);
            format!("OCR Extraction failed: {}", e)
        }
    };
    
    let relative_import = format!("_imports/{}", import_target.file_name().unwrap_or_default().to_string_lossy());
    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    let ext = source.extension().unwrap_or_default().to_string_lossy().to_string();
    
    let companion_content = format!(
        "---\ntype: import\nsource: \"{}\"\nsource_type: {}\nimported: \"{}\"\ntitle: \"{}\"\n---\n\n# {}\n\n> 📎 源文件: `{}` — 在侧边栏 _imports 文件夹中点击可打开\n\n![Original Image]({})\n\n## 📝 OCR Extracted Text\n\n{}\n\n<!-- @user -->\n\n<!-- @generated -->\n",
        relative_import,
        ext,
        now,
        name,
        name,
        relative_import,
        relative_import,
        ocr_text,
    );
    
    let md_name = format!("{}.md", Path::new(name).file_stem().unwrap_or_default().to_string_lossy());
    let companion_path = unique_path(&vault_path.join(&md_name));
    match std::fs::write(&companion_path, companion_content) {
        Ok(_) => ImportResult {
            source_name: name.to_string(),
            import_type: "image".to_string(),
            companion_path: Some(companion_path.to_string_lossy().to_string()),
            success: true,
            error: None,
        },
        Err(e) => ImportResult {
            source_name: name.to_string(),
            import_type: "image".to_string(),
            companion_path: None,
            success: false,
            error: Some(format!("Failed to write companion .md: {}", e)),
        },
    }
}

