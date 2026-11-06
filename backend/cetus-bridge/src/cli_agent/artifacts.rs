use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Normalize a tool-result payload (string | array | object) into the
/// `PiContentBlock[]` array the frontend renders in a tool card.
pub(super) fn normalize_content(v: &Value) -> Value {
    match v {
        Value::String(s) => json!([{ "type": "text", "text": s }]),
        Value::Array(items) => {
            let blocks: Vec<Value> = items
                .iter()
                .map(|it| match it {
                    Value::String(s) => json!({ "type": "text", "text": s }),
                    Value::Object(o) => {
                        if o.get("type").and_then(|t| t.as_str()) == Some("text") {
                            it.clone()
                        } else if matches!(
                            o.get("type").and_then(|t| t.as_str()),
                            Some(
                                "image"
                                    | "input_image"
                                    | "inputImage"
                                    | "input_file"
                                    | "inputFile"
                                    | "file"
                            )
                        ) {
                            json!({ "type": "text", "text": "[Media returned to agent]" })
                        } else if let Some(t) = o.get("text").and_then(|t| t.as_str()) {
                            json!({ "type": "text", "text": t })
                        } else {
                            json!({ "type": "text", "text": it.to_string() })
                        }
                    }
                    other => json!({ "type": "text", "text": other.to_string() }),
                })
                .collect();
            Value::Array(blocks)
        }
        Value::Object(object)
            if matches!(
                object.get("type").and_then(Value::as_str),
                Some("image" | "input_image" | "inputImage" | "input_file" | "inputFile" | "file")
            ) =>
        {
            // Keep binary tool observations out of the transcript. Receiving
            // media is not an instruction to deliver it to the user.
            json!([{ "type": "text", "text": "[Media returned to agent]" }])
        }
        Value::Null => json!([]),
        other => json!([{ "type": "text", "text": other.to_string() }]),
    }
}

pub(super) const TOOL_OUTPUT_FLUSH_INTERVAL: Duration = Duration::from_millis(50);
pub(super) const TOOL_OUTPUT_PREVIEW_BYTES: usize = 64 * 1024;
pub(super) const TOOL_OUTPUT_PENDING_BYTES: usize = 32 * 1024;
pub(super) const TOOL_OUTPUT_OMISSION_MARKER: &str = "\n… output omitted …\n";

fn utf8_prefix(value: &str, max_bytes: usize) -> &str {
    let mut end = value.len().min(max_bytes);
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

pub(super) fn utf8_suffix(value: &str, max_bytes: usize) -> &str {
    let mut start = value.len().saturating_sub(max_bytes);
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    &value[start..]
}

pub(super) fn bounded_tool_output_preview(value: &str) -> (String, bool) {
    if value.len() <= TOOL_OUTPUT_PREVIEW_BYTES {
        return (value.to_string(), false);
    }
    let available = TOOL_OUTPUT_PREVIEW_BYTES.saturating_sub(TOOL_OUTPUT_OMISSION_MARKER.len());
    let head = available / 2;
    let tail = available - head;
    (
        format!(
            "{}{}{}",
            utf8_prefix(value, head),
            TOOL_OUTPUT_OMISSION_MARKER,
            utf8_suffix(value, tail)
        ),
        true,
    )
}

pub(super) fn persist_tool_output(dir: Option<&Path>, id: &str, output: &str) -> Option<PathBuf> {
    let dir = dir?;
    std::fs::create_dir_all(dir).ok()?;
    let safe_id: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .take(80)
        .collect();
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis();
    let sequence = ARTIFACT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let path = dir.join(format!("tool-output-{safe_id}-{millis}-{sequence}.log"));
    std::fs::write(&path, output).ok()?;
    Some(path)
}

pub(super) static ARTIFACT_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn mime_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "heic" => "image/heic",
        "avif" => "image/avif",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        "pdf" => "application/pdf",
        "md" | "markdown" => "text/markdown",
        "html" | "htm" => "text/html",
        "txt" | "log" => "text/plain",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "json" => "application/json",
        "xml" => "application/xml",
        "yaml" | "yml" => "application/yaml",
        "js" | "mjs" | "cjs" => "text/javascript",
        "ts" | "tsx" => "text/typescript",
        "css" => "text/css",
        "rtf" => "application/rtf",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        "tar" => "application/x-tar",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
}

fn artifact_kind(mime: &str) -> &'static str {
    if mime.starts_with("image/") {
        "image"
    } else if mime.starts_with("video/") {
        "video"
    } else if mime.starts_with("audio/") {
        "audio"
    } else if mime == "application/pdf" {
        "pdf"
    } else if mime == "text/markdown" {
        "markdown"
    } else if mime == "text/html" {
        "html"
    } else if mime.starts_with("text/")
        || matches!(
            mime,
            "application/json" | "application/xml" | "application/yaml"
        )
    {
        "text"
    } else {
        "other"
    }
}

pub(super) fn artifact_details(
    path: &Path,
    mime_override: Option<&str>,
    caption: Option<&str>,
) -> Option<Value> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mime = mime_override
        .filter(|mime| !mime.trim().is_empty())
        .unwrap_or_else(|| mime_for_path(&path));
    Some(json!({
        "kind": "artifact",
        "artifactKind": artifact_kind(mime),
        "path": path.to_string_lossy(),
        "name": path.file_name().and_then(|n| n.to_str()).unwrap_or("artifact"),
        "mimeType": mime,
        "caption": caption.filter(|s| !s.trim().is_empty()),
        "sizeBytes": metadata.len(),
    }))
}

fn resolve_file_path(raw: &str, cwd: Option<&Path>) -> Option<PathBuf> {
    let raw = raw.trim().trim_matches(|c: char| {
        matches!(
            c,
            '"' | '\'' | '`' | '<' | '>' | '(' | ')' | '[' | ']' | ',' | ';'
        )
    });
    if raw.is_empty() || raw.starts_with("data:") || raw.contains("\0") {
        return None;
    }
    let path = PathBuf::from(raw);
    let path = if path.is_absolute() {
        path
    } else {
        cwd?.join(path)
    };
    path.is_file().then_some(path)
}

/// Extract only Cetus's explicit CLI delivery markers from unstructured text.
///
/// Tool output often reports unrelated existing files (for example, `simctl`
/// prints `Image Path: /.../runtime.dmg`). Treating generic `path:` / `file:` /
/// `saved to` prose as delivery intent makes those files appear in chat even
/// though the agent never sent them. Delivery requires `cetus artifact <path>`
/// or explicit structured artifact details from `send_artifact`.
fn paths_from_text(text: &str, cwd: Option<&Path>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for line in text.lines() {
        if let Some(json) = line.strip_prefix("CETUS_ARTIFACT:") {
            if let Ok(value) = serde_json::from_str::<Value>(json.trim()) {
                if let Some(path) = value
                    .get("path")
                    .and_then(Value::as_str)
                    .and_then(|p| resolve_file_path(p, cwd))
                {
                    paths.push(path);
                }
            }
        }
    }
    paths
}

/// Ordinary runtime images, files and paths are observations, not deliveries.
fn collect_artifacts(value: &Value, cwd: Option<&Path>, out: &mut Vec<Value>) {
    match value {
        Value::String(text) => out.extend(
            paths_from_text(text, cwd)
                .into_iter()
                .filter_map(|path| artifact_details(&path, None, None)),
        ),
        Value::Array(items) => {
            for item in items {
                collect_artifacts(item, cwd, out);
            }
        }
        Value::Object(object) => {
            if object.get("kind").and_then(Value::as_str) == Some("artifact") {
                out.push(value.clone());
                return;
            }
            for (key, child) in object {
                if !matches!(
                    key.as_str(),
                    "path"
                        | "file_path"
                        | "filePath"
                        | "output_path"
                        | "outputPath"
                        | "local_path"
                        | "localPath"
                        | "data"
                        | "image_url"
                        | "imageUrl"
                        | "url"
                        | "source"
                ) {
                    collect_artifacts(child, cwd, out);
                }
            }
        }
        _ => {}
    }
}

pub(super) fn extracted_artifact_details(
    value: &Value,
    _artifact_dir: Option<&Path>,
    cwd: Option<&Path>,
) -> Option<Value> {
    let mut artifacts = Vec::new();
    collect_artifacts(value, cwd, &mut artifacts);
    let mut seen = HashSet::new();
    artifacts.retain(|artifact| {
        artifact
            .get("path")
            .and_then(Value::as_str)
            .map(|path| seen.insert(path.to_string()))
            .unwrap_or(false)
    });
    match artifacts.len() {
        0 => None,
        1 => artifacts.pop(),
        _ => Some(json!({ "kind": "artifact_collection", "artifacts": artifacts })),
    }
}
