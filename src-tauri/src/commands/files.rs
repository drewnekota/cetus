use super::{err, CmdResult, Uuid};

/// Persist a composer attachment (any non-image file) to disk so the agent can
/// read it using local tools. Images keep riding the
/// `send_prompt` images channel; this is for everything else.
///
/// Files land in `<app_data>/attachments/<conv id>/<uuid>-<name>` — outside the
/// workspace so we never pollute the user's project tree. Returns the absolute
/// path, which the frontend embeds in the prompt for the model to read.
#[tauri::command]
pub async fn save_attachment(
    app: tauri::AppHandle,
    id: String,
    name: String,
    data: String,
) -> CmdResult<String> {
    use base64::Engine;
    use tauri::Manager;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("invalid base64 attachment: {e}"))?;

    let conv = sanitize_segment(&id);
    let dir = app
        .path()
        .app_data_dir()
        .map_err(err)?
        .join("attachments")
        .join(conv);
    std::fs::create_dir_all(&dir).map_err(err)?;

    // Keep the original basename for readability; prefix a short unique id so
    // re-sending the same filename never overwrites an earlier attachment.
    let base = std::path::Path::new(&name)
        .file_name()
        .and_then(|s| s.to_str())
        .map(sanitize_segment)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "file".to_string());
    let prefix = Uuid::new_v4().simple().to_string();
    let dest = dir.join(format!("{}-{base}", &prefix[..8]));

    std::fs::write(&dest, &bytes).map_err(err)?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Absolute paths of any file URLs currently on the general pasteboard. When the
/// user copies a file in Finder, its real path lands here — the composer uses it
/// to reference a too-large paste by path instead of inlining its bytes. Returns
/// an empty list on non-file clipboards (raw image/text) and off macOS.
#[tauri::command]
pub async fn read_clipboard_file_paths() -> CmdResult<Vec<String>> {
    #[cfg(target_os = "macos")]
    {
        Ok(crate::text_input::clipboard_file_paths())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(Vec::new())
    }
}

/// Strip path separators and control chars so a filename can't escape its dir.
pub(super) fn sanitize_segment(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c == '/' || c == '\\' || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect::<String>()
        .trim_matches(['.', ' '])
        .to_string()
}

/// A file the user dropped on a cetus window, ready for the composer to turn
/// into an attachment. `data` is base64 file bytes, or `None` when the path is
/// a directory or larger than the caller's budget — the frontend then references
/// the path in the prompt instead of inlining megabytes the agent can read off
/// disk itself.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFile {
    name: String,
    size_bytes: u64,
    is_dir: bool,
    data: Option<String>,
}

/// Read a dropped path. Drops arrive from the OS as paths (not web `File`s), so
/// the bytes have to come from here rather than from a `DataTransfer`.
#[tauri::command]
pub async fn read_dropped_file(path: String, max_bytes: u64) -> CmdResult<DroppedFile> {
    use base64::Engine;
    let meta = std::fs::metadata(&path).map_err(err)?;
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    let is_dir = meta.is_dir();
    let size_bytes = if is_dir { 0 } else { meta.len() };
    if is_dir || size_bytes > max_bytes {
        return Ok(DroppedFile {
            name,
            size_bytes,
            is_dir,
            data: None,
        });
    }
    let bytes = std::fs::read(&path).map_err(err)?;
    Ok(DroppedFile {
        name,
        size_bytes,
        is_dir,
        data: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
    })
}

#[tauri::command]
pub async fn read_text_file(path: String) -> CmdResult<String> {
    // Allow self-contained HTML with embedded images/fonts while bounding IPC payloads.
    const MAX_BYTES: u64 = 32 * 1024 * 1024;
    let meta = std::fs::metadata(&path).map_err(err)?;
    if meta.len() > MAX_BYTES {
        return Err(format!(
            "file too large for inline preview ({} bytes, max {} bytes)",
            meta.len(),
            MAX_BYTES
        ));
    }
    std::fs::read_to_string(&path).map_err(err)
}

#[tauri::command]
pub async fn reveal_in_finder(path: String) -> CmdResult<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(err)?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map_err(err)?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = std::path::Path::new(&path)
            .parent()
            .ok_or_else(|| "no parent dir".to_string())?;
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(err)?;
    }
    Ok(())
}

/// Open a web link in the user's default browser.
///
/// Chat links are rendered inside the WKWebView, and a bare `<a>` click lets
/// the webview resolve the navigation itself. macOS then honours Universal
/// Links, so domains an installed app has claimed (e.g. Lark/Feishu's
/// `*.larksuite.com` / `*.feishu.cn` docs) open that app instead of the page.
/// Routing the click through a separate `open` process resolves the http(s)
/// scheme to the default browser, so the page actually opens in a browser.
#[tauri::command]
pub async fn open_external(url: String) -> CmdResult<()> {
    // Only hand off web/mail links — never arbitrary schemes from model output
    // (e.g. `file://`, custom app schemes) which could launch unexpected apps.
    let allowed = ["http://", "https://", "mailto:"];
    if !allowed.iter().any(|p| url.starts_with(p)) {
        return Err(format!("refusing to open non-web url: {url}"));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(err)?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(err)?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(err)?;
    }
    Ok(())
}

/// Open a local file with the OS default application (e.g. an HTML artifact in
/// the default browser, a PDF in Preview). Unlike `open_external` this takes a
/// filesystem path rather than a URL, so it powers the artifact dialog's "Open"
/// action across every file type.
#[tauri::command]
pub async fn open_path(path: String) -> CmdResult<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(err)?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(err)?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn log_fe(level: String, msg: String) -> CmdResult<()> {
    match level.as_str() {
        "error" => tracing::error!(target: "fe", "{msg}"),
        "warn" => tracing::warn!(target: "fe", "{msg}"),
        "info" => tracing::info!(target: "fe", "{msg}"),
        _ => tracing::debug!(target: "fe", "{msg}"),
    }
    Ok(())
}
