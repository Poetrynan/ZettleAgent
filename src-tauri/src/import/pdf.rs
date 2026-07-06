use std::path::{Path, PathBuf};
use anyhow::Result;

pub struct PageContent {
    pub page: usize,
    pub text: String,
    pub needs_ocr: bool,
}

pub fn extract_text_from_pdf(pdf_path: &Path) -> Result<Vec<PageContent>> {
    use oxidize_pdf::parser::{PdfDocument, PdfReader};
    
    let reader = PdfReader::open(pdf_path)?;
    let doc = PdfDocument::new(reader);
    
    let extracted = doc.extract_text()?;
    let mut pages = Vec::new();
    
    for (i, page_text) in extracted.iter().enumerate() {
        let text = page_text.text.clone();
        let needs_ocr = text.trim().len() < 20;
        pages.push(PageContent {
            page: i + 1,
            text,
            needs_ocr,
        });
    }
    
    Ok(pages)
}

pub fn extract_pdf_images(pdf_path: &Path, temp_dir: &Path) -> Result<Vec<(usize, PathBuf)>> {
    use oxidize_pdf::operations::extract_images::{extract_images_from_pdf, ExtractImagesOptions};
    
    let options = ExtractImagesOptions {
        output_dir: temp_dir.to_path_buf(),
        name_pattern: "page_{page}_image_{index}.{format}".to_string(),
        extract_inline: true,
        min_size: Some(10),
        create_dir: true,
    };
    
    let images = extract_images_from_pdf(pdf_path, options)?;
    
    let mut result = Vec::new();
    for img in images {
        result.push((img.page_number + 1, img.file_path));
    }
    Ok(result)
}
