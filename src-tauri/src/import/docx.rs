use std::fs::File;
use std::io::Read;
use std::path::Path;
use anyhow::Result;
use quick_xml::events::Event;
use quick_xml::Reader;

pub struct DocxContent {
    pub text: String,
    pub images: Vec<(String, Vec<u8>)>,
}

fn parse_docx_xml(xml: &str) -> Result<String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    
    let mut result = String::new();
    let mut buf = Vec::new();
    
    let mut in_t = false;
    
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                match e.name().as_ref() {
                    b"w:p" => {
                        if !result.is_empty() && !result.ends_with('\n') {
                            result.push('\n');
                        }
                    }
                    b"w:t" => {
                        in_t = true;
                    }
                    _ => {}
                }
            }
            Ok(Event::End(ref e)) => {
                match e.name().as_ref() {
                    b"w:p" => {
                        if !result.ends_with('\n') {
                            result.push('\n');
                        }
                    }
                    b"w:t" => {
                        in_t = false;
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(e)) => {
                if in_t {
                    let t = e.unescape()?;
                    result.push_str(&t);
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(anyhow::anyhow!("XML parse error: {}", e)),
            _ => {}
        }
        buf.clear();
    }
    
    Ok(result)
}

pub fn extract_text_from_docx(docx_path: &Path) -> Result<DocxContent> {
    let file = File::open(docx_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    
    let mut text = String::new();
    let mut images = Vec::new();
    
    if let Ok(mut doc_file) = archive.by_name("word/document.xml") {
        let mut doc_xml = String::new();
        doc_file.read_to_string(&mut doc_xml)?;
        text = parse_docx_xml(&doc_xml)?;
    }
    
    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let name = file.name().to_string();
        if name.starts_with("word/media/") {
            let mut buf = Vec::new();
            file.read_to_end(&mut buf)?;
            images.push((name, buf));
        }
    }
    
    Ok(DocxContent { text, images })
}
