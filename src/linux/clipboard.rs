use serde::Deserialize;
use std::io::{Read, Write};
use wl_clipboard_rs::copy::{MimeSource, MimeType, Options, Source};

#[derive(Deserialize)]
struct Content {
    text: Option<String>,
    html: Option<String>,
    file: Option<String>,
    #[serde(default)]
    concealed: bool,
}

pub fn serve() -> Result<(), String> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("Clipboard content exceeds 16 MiB".into());
    }
    let content: Content = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let mut sources = Vec::new();
    let mut add = |text: String, mime_type| {
        sources.push(MimeSource {
            source: Source::Bytes(text.into_bytes().into_boxed_slice()),
            mime_type,
        })
    };
    if let Some(text) = content.text {
        add(text, MimeType::Text);
    }
    if let Some(html) = content.html {
        add(html, MimeType::Specific("text/html".into()));
    }
    if let Some(file) = content.file {
        let url = url::Url::from_file_path(&file)
            .map_err(|_| "Clipboard file must be an absolute path")?;
        if !std::path::Path::new(&file).exists() {
            return Err("Clipboard file does not exist".into());
        }
        add(
            format!("{url}\r\n"),
            MimeType::Specific("text/uri-list".into()),
        );
    }
    if sources.is_empty() {
        return Err("Clipboard content must include text, HTML, or a file".into());
    }
    if content.concealed {
        sources.push(MimeSource {
            source: Source::Bytes(Box::from(b"secret".as_slice())),
            mime_type: MimeType::Specific("x-kde-passwordManagerHint".into()),
        });
    }
    let mut options = Options::new();
    options.foreground(true);
    let prepared = options
        .prepare_copy_multi(sources)
        .map_err(|e| e.to_string())?;
    println!("ready");
    std::io::stdout().flush().map_err(|e| e.to_string())?;
    prepared.serve().map_err(|e| e.to_string())
}
