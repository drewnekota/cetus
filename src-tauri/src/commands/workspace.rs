use super::{
    err, sanitize_segment, AppState, CmdResult, DialogExt, Emitter, Path, PathBuf, Read, State,
    WorkspaceDirectoryListing, WorkspaceFileEntry, WorkspaceTextPreview, UNIX_EPOCH,
};

#[tauri::command]
pub async fn default_workspace(state: State<'_, AppState>) -> CmdResult<String> {
    Ok(state.default_workspace.to_string_lossy().to_string())
}

/// Open a native folder picker. Returns the chosen path or None if cancelled.
///
/// On macOS this deliberately bypasses tauri-plugin-dialog/rfd: the open panel
/// is out-of-process (openAndSavePanelService), and when that service fails to
/// launch — seen on updater-relaunched "anon" instances, where AppKit logs
/// "Unable to display open panel: Connection interrupted" — rfd's completion
/// path unwraps a nil URL and the panic takes down the whole app (2026-08-31,
/// "click Add folder → app quits"). Here every failure, nil, or Obj-C
/// exception is just a cancel.
#[tauri::command]
pub async fn pick_workspace_dir(app: tauri::AppHandle) -> CmdResult<Option<String>> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(pick_folder_native());
        })
        .map_err(err)?;
        let result = rx.await.map_err(err)?;
        Ok(result.map(|p| p.to_string_lossy().to_string()))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.dialog().file().pick_folder(move |path| {
            let _ = tx.send(path.and_then(|p| p.into_path().ok()));
        });
        let result = rx.await.map_err(err)?;
        Ok(result.map(|p| p.to_string_lossy().to_string()))
    }
}

/// NSOpenPanel folder picker that cannot crash the process. Must run on the
/// main thread. `runModal` (app-modal, not a sheet) keeps the flow synchronous:
/// no completion-handler race with a dying panel service, and it works the same
/// from the quick panel where there is no key window to sheet onto.
#[cfg(target_os = "macos")]
fn pick_folder_native() -> Option<PathBuf> {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    let caught = objc2::exception::catch(core::panic::AssertUnwindSafe(|| unsafe {
        let cls = AnyClass::get(c"NSOpenPanel")?;
        let panel: *mut AnyObject = msg_send![cls, openPanel];
        if panel.is_null() {
            return None;
        }
        let _: () = msg_send![panel, setCanChooseDirectories: Bool::YES];
        let _: () = msg_send![panel, setCanChooseFiles: Bool::NO];
        let _: () = msg_send![panel, setAllowsMultipleSelection: Bool::NO];
        let _: () = msg_send![panel, setCanCreateDirectories: Bool::YES];
        // NSModalResponseOK == 1; anything else (cancel, abort, or the panel
        // service never coming up) means "no folder".
        let response: isize = msg_send![panel, runModal];
        if response != 1 {
            return None;
        }
        let url: *mut AnyObject = msg_send![panel, URL];
        if url.is_null() {
            return None;
        }
        let path_ns: *mut AnyObject = msg_send![url, path];
        if path_ns.is_null() {
            return None;
        }
        let cstr: *const std::os::raw::c_char = msg_send![path_ns, UTF8String];
        if cstr.is_null() {
            return None;
        }
        Some(PathBuf::from(
            std::ffi::CStr::from_ptr(cstr).to_string_lossy().to_string(),
        ))
    }));
    match caught {
        Ok(path) => path,
        Err(e) => {
            tracing::warn!("pick_folder_native: open panel raised an exception: {e:?}");
            None
        }
    }
}

/// Save a copy of an artifact somewhere the user picks.
///
/// Artifacts already live on disk, so "download" is really "copy to a chosen
/// location". It has to run through a native save panel rather than an
/// `<a href="asset://…" download>`: WKWebView does not honour the download
/// attribute for a custom scheme, so that anchor *navigates* — replacing the
/// whole cetus UI with the raw file, which no in-page code can undo.
/// Returns the destination, or `None` if the user cancelled.
#[tauri::command]
pub async fn save_artifact_copy(app: tauri::AppHandle, path: String) -> CmdResult<Option<String>> {
    let source = PathBuf::from(&path);
    if !source.is_file() {
        return Err(format!("artifact is missing: {path}"));
    }
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "artifact".to_string());
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&name)
        .save_file(move |path| {
            let _ = tx.send(path.and_then(|p| p.into_path().ok()));
        });
    let Some(target) = rx.await.map_err(err)? else {
        return Ok(None);
    };
    // Outcome is ALSO emitted as an event: the invoke callback dies with a
    // webview reload, and the copy happens after the panel closes — possibly
    // long after — so the return value alone can be undeliverable.
    match std::fs::copy(&source, &target) {
        Ok(_) => {
            let dest = target.to_string_lossy().to_string();
            let _ = app.emit_to(
                "main",
                "artifact-saved",
                serde_json::json!({ "path": dest, "name": name }),
            );
            Ok(Some(dest))
        }
        Err(e) => {
            let _ = app.emit_to(
                "main",
                "artifact-save-failed",
                serde_json::json!({ "name": name, "error": e.to_string() }),
            );
            Err(err(e))
        }
    }
}

#[tauri::command]
pub async fn list_workspace_files(
    state: State<'_, AppState>,
    workspace_dir: Option<String>,
) -> CmdResult<Vec<WorkspaceFileEntry>> {
    const MAX_ENTRIES: usize = 800;
    const MAX_DEPTH: usize = 8;
    let dir = workspace_dir
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| state.default_workspace.clone());
    if cetus_bridge::remote::parse_remote_workspace(&dir.to_string_lossy()).is_some() {
        return Ok(Vec::new());
    }
    let entries = collect_workspace_files(&dir, MAX_DEPTH, MAX_ENTRIES)?;
    Ok(entries)
}

#[tauri::command]
pub async fn list_workspace_directory(
    state: State<'_, AppState>,
    workspace_dir: Option<String>,
    directory_path: Option<String>,
) -> CmdResult<WorkspaceDirectoryListing> {
    const MAX_CHILDREN: usize = 500;
    let workspace = workspace_dir
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| state.default_workspace.to_string_lossy().to_string());
    let requested = directory_path;
    if let Some(remote) = cetus_bridge::remote::parse_remote_workspace(&workspace) {
        return tokio::task::spawn_blocking(move || {
            list_remote_workspace_directory(&remote, requested.as_deref(), MAX_CHILDREN)
        })
        .await
        .map_err(err)?;
    }
    tokio::task::spawn_blocking(move || {
        list_local_workspace_directory(Path::new(&workspace), requested.as_deref(), MAX_CHILDREN)
    })
    .await
    .map_err(err)?
}

pub(super) fn list_local_workspace_directory(
    workspace: &Path,
    directory_path: Option<&str>,
    max_children: usize,
) -> CmdResult<WorkspaceDirectoryListing> {
    let root = workspace.canonicalize().map_err(err)?;
    let requested = directory_path
        .map(PathBuf::from)
        .unwrap_or_else(|| root.clone());
    let dir = requested.canonicalize().map_err(err)?;
    if !dir.starts_with(&root) || !dir.is_dir() {
        return Err("directory is outside the workspace".to_string());
    }

    let git_records = workspace_git_status(&root, &dir);
    let mut children = std::fs::read_dir(&dir)
        .map_err(err)?
        .filter_map(Result::ok)
        .filter(|entry| !should_hide_workspace_entry(&entry.file_name().to_string_lossy()))
        .collect::<Vec<_>>();
    children.sort_by(|a, b| {
        let a_dir = a.metadata().map(|meta| meta.is_dir()).unwrap_or(false);
        let b_dir = b.metadata().map(|meta| meta.is_dir()).unwrap_or(false);
        b_dir.cmp(&a_dir).then_with(|| {
            a.file_name()
                .to_string_lossy()
                .to_lowercase()
                .cmp(&b.file_name().to_string_lossy().to_lowercase())
        })
    });
    let truncated = children.len() > max_children;
    children.truncate(max_children);

    let mut entries = children
        .into_iter()
        .map(|entry| {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let link_meta = std::fs::symlink_metadata(&path).ok();
            let meta = entry.metadata().ok();
            let is_symlink = link_meta
                .as_ref()
                .map(|value| value.file_type().is_symlink())
                .unwrap_or(false);
            let is_dir = meta.as_ref().map(|value| value.is_dir()).unwrap_or(false);
            let git_status = git_status_for_path(&path, &git_records);
            let is_ignored = git_status.as_deref() == Some("ignored");
            WorkspaceFileEntry {
                name,
                path: path.to_string_lossy().to_string(),
                relative_path: path
                    .strip_prefix(&root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .to_string(),
                is_dir,
                is_ignored,
                git_status,
                is_symlink,
                symlink_target: is_symlink
                    .then(|| std::fs::read_link(&path).ok())
                    .flatten()
                    .map(|target| target.to_string_lossy().to_string()),
                size_bytes: meta
                    .as_ref()
                    .filter(|value| value.is_file())
                    .map(|value| value.len()),
                modified_ms: meta
                    .as_ref()
                    .and_then(|value| value.modified().ok())
                    .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                    .map(|value| value.as_millis().min(u128::from(u64::MAX)) as u64),
            }
        })
        .collect::<Vec<_>>();
    for (path, status) in &git_records {
        if status != "deleted" || path.parent() != Some(dir.as_path()) {
            continue;
        }
        if entries.iter().any(|entry| Path::new(&entry.path) == path) {
            continue;
        }
        entries.push(WorkspaceFileEntry {
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
            path: path.to_string_lossy().to_string(),
            relative_path: path
                .strip_prefix(&root)
                .unwrap_or(path)
                .to_string_lossy()
                .to_string(),
            is_dir: false,
            is_ignored: false,
            git_status: Some("deleted".to_string()),
            is_symlink: false,
            symlink_target: None,
            size_bytes: None,
            modified_ms: None,
        });
    }
    Ok(WorkspaceDirectoryListing {
        entries,
        truncated,
        is_remote: false,
    })
}

fn workspace_git_status(root: &Path, scope: &Path) -> Vec<(PathBuf, String)> {
    let repo = std::process::Command::new("git")
        .args([
            "-C",
            &root.to_string_lossy(),
            "rev-parse",
            "--show-toplevel",
        ])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| PathBuf::from(value.trim()))
        .and_then(|path| path.canonicalize().ok());
    let Some(repo) = repo else { return Vec::new() };
    let scope_relative = scope.strip_prefix(&repo).unwrap_or(scope);
    let scope_arg = if scope_relative.as_os_str().is_empty() {
        Path::new(".")
    } else {
        scope_relative
    };
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "status",
            "--porcelain=v1",
            "-z",
            "--ignored=matching",
            "--untracked-files=all",
            "--",
        ])
        .arg(scope_arg)
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }

    let chunks = output.stdout.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut records = Vec::new();
    let mut index = 0;
    while index < chunks.len() {
        let chunk = chunks[index];
        if chunk.len() < 4 {
            index += 1;
            continue;
        }
        let xy = &chunk[..2];
        let path = String::from_utf8_lossy(&chunk[3..]).to_string();
        records.push((repo.join(path), porcelain_status(xy).to_string()));
        if matches!(xy.first(), Some(b'R' | b'C')) {
            index += 1;
        }
        index += 1;
    }
    records
}

pub(super) fn porcelain_status(xy: &[u8]) -> &'static str {
    if xy == b"!!" {
        "ignored"
    } else if xy == b"??" {
        "untracked"
    } else if xy.contains(&b'U') || xy == b"AA" || xy == b"DD" {
        "conflict"
    } else if xy.contains(&b'D') {
        "deleted"
    } else if xy.contains(&b'R') {
        "renamed"
    } else if xy.contains(&b'A') {
        "added"
    } else {
        "modified"
    }
}

fn git_status_for_path(path: &Path, records: &[(PathBuf, String)]) -> Option<String> {
    records
        .iter()
        .filter(|(record, status)| {
            record == path || (status != "ignored" && record.starts_with(path))
        })
        .map(|(_, status)| status.clone())
        .min_by_key(|status| match status.as_str() {
            "conflict" => 0,
            "deleted" => 1,
            "modified" => 2,
            "renamed" => 3,
            "added" => 4,
            "untracked" => 5,
            "ignored" => 6,
            _ => 7,
        })
}

fn list_remote_workspace_directory(
    remote: &cetus_bridge::remote::RemoteWorkspace,
    directory_path: Option<&str>,
    max_children: usize,
) -> CmdResult<WorkspaceDirectoryListing> {
    let root = normalize_remote_path(&remote.path)?;
    let dir = normalize_remote_path(directory_path.unwrap_or(&root))?;
    if dir != root && !dir.starts_with(&format!("{}/", root.trim_end_matches('/'))) {
        return Err("directory is outside the remote workspace".to_string());
    }
    let script = format!(
        "root={root}; dir={dir}; for p in \"$dir\"/* \"$dir\"/.[!.]* \"$dir\"/..?*; do \
         [ -e \"$p\" ] || [ -L \"$p\" ] || continue; name=${{p##*/}}; \
         [ \"$name\" = .git ] && continue; \
         kind=f; [ -d \"$p\" ] && kind=d; link=0; target=; \
         if [ -L \"$p\" ]; then link=1; target=$(readlink \"$p\" 2>/dev/null || true); fi; \
         ignored=0; git -C \"$root\" check-ignore -q -- \"$p\" 2>/dev/null && ignored=1; \
         size=0; [ \"$kind\" = f ] && size=$(wc -c < \"$p\" 2>/dev/null | tr -d ' ' || printf 0); \
         mtime=$(stat -c %Y \"$p\" 2>/dev/null || stat -f %m \"$p\" 2>/dev/null || printf 0); \
         printf '%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0' \"$kind\" \"$ignored\" \"$link\" \"$target\" \"$size\" \"$mtime\" \"$name\"; done",
        root = cetus_bridge::remote::shell_word(&root),
        dir = cetus_bridge::remote::shell_word(&dir),
    );
    let output = std::process::Command::new("ssh")
        .args(cetus_bridge::remote::remote_command_args(remote, &script))
        .output()
        .map_err(err)?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let fields = output.stdout.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut entries = Vec::new();
    for record in fields.chunks(7) {
        if record.len() < 7 || record[6].is_empty() {
            continue;
        }
        let text = |bytes: &[u8]| String::from_utf8_lossy(bytes).to_string();
        let name = text(record[6]);
        let path = cetus_bridge::remote::join_remote(&dir, &name);
        let is_ignored = record[1] == b"1";
        entries.push(WorkspaceFileEntry {
            name,
            relative_path: path
                .strip_prefix(root.trim_end_matches('/'))
                .unwrap_or(&path)
                .trim_start_matches('/')
                .to_string(),
            path,
            is_dir: record[0] == b"d",
            is_ignored,
            git_status: is_ignored.then(|| "ignored".to_string()),
            is_symlink: record[2] == b"1",
            symlink_target: (!record[3].is_empty()).then(|| text(record[3])),
            size_bytes: text(record[4]).trim().parse().ok(),
            modified_ms: text(record[5])
                .trim()
                .parse::<u64>()
                .ok()
                .map(|value| value * 1000),
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    let truncated = entries.len() > max_children;
    entries.truncate(max_children);
    Ok(WorkspaceDirectoryListing {
        entries,
        truncated,
        is_remote: true,
    })
}

pub(super) fn normalize_remote_path(raw: &str) -> CmdResult<String> {
    if !raw.starts_with('/') {
        return Err("remote workspace path must be absolute".to_string());
    }
    let mut parts = Vec::new();
    for part in raw.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            value => parts.push(value),
        }
    }
    Ok(format!("/{}", parts.join("/")))
}

#[tauri::command]
pub async fn search_workspace_files(
    state: State<'_, AppState>,
    workspace_dir: Option<String>,
    query: String,
    include_dirs: Option<bool>,
) -> CmdResult<WorkspaceDirectoryListing> {
    const MAX_RESULTS: usize = 100;
    let include_dirs = include_dirs.unwrap_or(false);
    let workspace = workspace_dir
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| state.default_workspace.to_string_lossy().to_string());
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(WorkspaceDirectoryListing {
            entries: Vec::new(),
            truncated: false,
            is_remote: cetus_bridge::remote::parse_remote_workspace(&workspace).is_some(),
        });
    }
    if let Some(remote) = cetus_bridge::remote::parse_remote_workspace(&workspace) {
        return tokio::task::spawn_blocking(move || {
            search_remote_workspace_files(&remote, &query, MAX_RESULTS, include_dirs)
        })
        .await
        .map_err(err)?;
    }
    tokio::task::spawn_blocking(move || {
        search_local_workspace_files(&workspace, &query, MAX_RESULTS, include_dirs)
    })
    .await
    .map_err(err)?
}

fn search_local_workspace_files(
    workspace: &str,
    query: &str,
    max_results: usize,
    include_dirs: bool,
) -> CmdResult<WorkspaceDirectoryListing> {
    let root = PathBuf::from(workspace).canonicalize().map_err(err)?;
    let git_records = workspace_git_status(&root, &root);
    let mut entries = Vec::new();
    for result in ignore::WalkBuilder::new(&root)
        .hidden(false)
        .follow_links(false)
        .build()
    {
        let Ok(entry) = result else { continue };
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        if entry.path() == root || (is_dir && !include_dirs) {
            continue;
        }
        let relative_path = entry
            .path()
            .strip_prefix(&root)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .to_string();
        if !relative_path.to_lowercase().contains(query) {
            continue;
        }
        let meta = entry.metadata().ok();
        let is_symlink = entry
            .file_type()
            .map(|kind| kind.is_symlink())
            .unwrap_or(false);
        entries.push(WorkspaceFileEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            relative_path,
            is_dir,
            is_ignored: false,
            git_status: git_status_for_path(entry.path(), &git_records),
            is_symlink,
            symlink_target: is_symlink
                .then(|| std::fs::read_link(entry.path()).ok())
                .flatten()
                .map(|target| target.to_string_lossy().to_string()),
            size_bytes: meta.as_ref().map(|value| value.len()),
            modified_ms: meta
                .as_ref()
                .and_then(|value| value.modified().ok())
                .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                .map(|value| value.as_millis().min(u128::from(u64::MAX)) as u64),
        });
        if entries.len() > max_results {
            break;
        }
    }
    entries.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .find(query)
            .unwrap_or(usize::MAX)
            .cmp(&b.name.to_lowercase().find(query).unwrap_or(usize::MAX))
            .then_with(|| a.relative_path.len().cmp(&b.relative_path.len()))
    });
    let truncated = entries.len() > max_results;
    entries.truncate(max_results);
    Ok(WorkspaceDirectoryListing {
        entries,
        truncated,
        is_remote: false,
    })
}

fn search_remote_workspace_files(
    remote: &cetus_bridge::remote::RemoteWorkspace,
    query: &str,
    max_results: usize,
    include_dirs: bool,
) -> CmdResult<WorkspaceDirectoryListing> {
    let root = normalize_remote_path(&remote.path)?;
    let pattern = format!("*{query}*");
    let script = format!(
        "find {root} {kind} -not -path '*/.git/*' -not -path '*/node_modules/*' -iname {pattern} -print | head -n {limit}",
        kind = if include_dirs { "" } else { "-type f" },
        root = cetus_bridge::remote::shell_word(&root),
        pattern = cetus_bridge::remote::shell_word(&pattern),
        limit = max_results + 1,
    );
    let output = std::process::Command::new("ssh")
        .args(cetus_bridge::remote::remote_command_args(remote, &script))
        .output()
        .map_err(err)?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let mut entries = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|path| !path.is_empty())
        .map(|path| WorkspaceFileEntry {
            name: path.rsplit('/').next().unwrap_or(path).to_string(),
            path: path.to_string(),
            relative_path: path
                .strip_prefix(root.trim_end_matches('/'))
                .unwrap_or(path)
                .trim_start_matches('/')
                .to_string(),
            is_dir: false,
            is_ignored: false,
            git_status: None,
            is_symlink: false,
            symlink_target: None,
            size_bytes: None,
            modified_ms: None,
        })
        .collect::<Vec<_>>();
    let truncated = entries.len() > max_results;
    entries.truncate(max_results);
    Ok(WorkspaceDirectoryListing {
        entries,
        truncated,
        is_remote: true,
    })
}

fn checked_local_workspace_entry(workspace_dir: &str, path: &str) -> CmdResult<(PathBuf, PathBuf)> {
    let root = PathBuf::from(workspace_dir).canonicalize().map_err(err)?;
    let target = PathBuf::from(path);
    let parent = target
        .parent()
        .ok_or_else(|| "workspace entry has no parent".to_string())?
        .canonicalize()
        .map_err(err)?;
    if !parent.starts_with(&root) || target == root {
        return Err("path is outside the workspace".to_string());
    }
    Ok((root, target))
}

#[tauri::command]
pub async fn create_workspace_entry(
    workspace_dir: String,
    parent_path: String,
    name: String,
    is_dir: bool,
) -> CmdResult<String> {
    if cetus_bridge::remote::parse_remote_workspace(&workspace_dir).is_some() {
        return Err("creating remote files from Files is not supported yet".to_string());
    }
    let root = PathBuf::from(&workspace_dir).canonicalize().map_err(err)?;
    let parent = PathBuf::from(&parent_path).canonicalize().map_err(err)?;
    if !parent.starts_with(&root) || !parent.is_dir() {
        return Err("parent is outside the workspace".to_string());
    }
    let safe_name = sanitize_segment(&name);
    if safe_name.is_empty() || safe_name != name {
        return Err("invalid file name".to_string());
    }
    let target = parent.join(safe_name);
    if is_dir {
        std::fs::create_dir(&target).map_err(err)?;
    } else {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(err)?;
    }
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn rename_workspace_entry(
    workspace_dir: String,
    path: String,
    new_name: String,
) -> CmdResult<String> {
    if cetus_bridge::remote::parse_remote_workspace(&workspace_dir).is_some() {
        return Err("renaming remote files from Files is not supported yet".to_string());
    }
    let (_, target) = checked_local_workspace_entry(&workspace_dir, &path)?;
    let safe_name = sanitize_segment(&new_name);
    if safe_name.is_empty() || safe_name != new_name {
        return Err("invalid file name".to_string());
    }
    let renamed = target.parent().unwrap().join(safe_name);
    std::fs::rename(&target, &renamed).map_err(err)?;
    Ok(renamed.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn trash_workspace_entry(workspace_dir: String, path: String) -> CmdResult<()> {
    if cetus_bridge::remote::parse_remote_workspace(&workspace_dir).is_some() {
        return Err("trashing remote files from Files is not supported yet".to_string());
    }
    let (_, target) = checked_local_workspace_entry(&workspace_dir, &path)?;
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("osascript")
        .args([
            "-e",
            "on run argv",
            "-e",
            "tell application \"Finder\" to delete POSIX file (item 1 of argv)",
            "-e",
            "end run",
            "--",
        ])
        .arg(&target)
        .status()
        .map_err(err)?;
    #[cfg(target_os = "windows")]
    let status = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($args[0], 'OnlyErrorDialogs', 'SendToRecycleBin')",
            "--",
        ])
        .arg(&target)
        .status()
        .map_err(err)?;
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = std::process::Command::new("gio")
        .arg("trash")
        .arg(&target)
        .status()
        .map_err(err)?;
    if status.success() {
        Ok(())
    } else {
        Err("the operating system could not move the entry to Trash".to_string())
    }
}

pub(super) fn collect_workspace_files(
    root: &Path,
    max_depth: usize,
    max_entries: usize,
) -> CmdResult<Vec<WorkspaceFileEntry>> {
    // Build the set Git considers visible, then enumerate the workspace
    // breadth-first. Ignored entries remain in the result (the UI dims them),
    // but ignored directories are not eagerly crawled so caches cannot consume
    // the entire bounded result before normal project files are reached.
    let visible_paths = ignore::WalkBuilder::new(root)
        .hidden(false)
        .follow_links(false)
        .max_depth(Some(max_depth + 1))
        .build()
        .filter_map(Result::ok)
        .map(|entry| entry.into_path())
        .collect::<std::collections::HashSet<_>>();

    let mut entries = Vec::new();
    let mut pending = std::collections::VecDeque::from([(root.to_path_buf(), 0usize)]);
    while let Some((dir, depth)) = pending.pop_front() {
        let mut children = std::fs::read_dir(&dir)
            .map_err(err)?
            .filter_map(Result::ok)
            .filter(|entry| !should_hide_workspace_entry(&entry.file_name().to_string_lossy()))
            .collect::<Vec<_>>();
        children.sort_by_key(|entry| entry.file_name().to_string_lossy().to_lowercase());

        for entry in children {
            if entries.len() >= max_entries {
                break;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let meta = entry.metadata().ok();
            let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
            let is_ignored = !visible_paths.contains(&path);
            let size_bytes = meta.as_ref().filter(|m| m.is_file()).map(|m| m.len());
            let modified_ms = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64);
            let relative_path = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();

            entries.push(WorkspaceFileEntry {
                name,
                path: path.to_string_lossy().to_string(),
                relative_path,
                is_dir,
                is_ignored,
                git_status: None,
                is_symlink: entry
                    .file_type()
                    .map(|kind| kind.is_symlink())
                    .unwrap_or(false),
                symlink_target: std::fs::read_link(&path)
                    .ok()
                    .map(|target| target.to_string_lossy().to_string()),
                size_bytes,
                modified_ms,
            });
            if is_dir && !is_ignored && depth < max_depth {
                pending.push_back((path, depth + 1));
            }
        }
        if entries.len() >= max_entries {
            break;
        }
    }

    // A depth-first cap lets one alphabetically early cache consume the whole
    // result. Keep shallow entries first so the root and main project folders
    // remain visible even when a large workspace exceeds the cap.
    entries.sort_by(|a, b| {
        workspace_entry_depth(&a.relative_path)
            .cmp(&workspace_entry_depth(&b.relative_path))
            .then_with(|| b.is_dir.cmp(&a.is_dir))
            .then_with(|| {
                a.relative_path
                    .to_lowercase()
                    .cmp(&b.relative_path.to_lowercase())
            })
    });
    entries.truncate(max_entries);
    Ok(entries)
}

fn workspace_entry_depth(path: &str) -> usize {
    path.split(['/', '\\']).count()
}

fn should_hide_workspace_entry(name: &str) -> bool {
    name == ".git"
}

#[tauri::command]
pub async fn read_workspace_text_file(
    workspace_dir: String,
    path: String,
) -> CmdResult<WorkspaceTextPreview> {
    const MAX_BYTES: u64 = 1024 * 1024;
    if let Some(remote) = cetus_bridge::remote::parse_remote_workspace(&workspace_dir) {
        let root = normalize_remote_path(&remote.path)?;
        let target = normalize_remote_path(&path)?;
        if target != root && !target.starts_with(&format!("{}/", root.trim_end_matches('/'))) {
            return Err("file is outside the remote workspace".to_string());
        }
        let script = format!(
            "size=$(wc -c < {path} 2>/dev/null) || exit 2; printf '%s\\0' \"$size\"; head -c {max} {path}",
            path = cetus_bridge::remote::shell_word(&target),
            max = MAX_BYTES,
        );
        let output = std::process::Command::new("ssh")
            .args(cetus_bridge::remote::remote_command_args(&remote, &script))
            .output()
            .map_err(err)?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        let split = output
            .stdout
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(0);
        let total_bytes = String::from_utf8_lossy(&output.stdout[..split])
            .trim()
            .parse::<u64>()
            .map_err(err)?;
        let bytes = output.stdout.get(split + 1..).unwrap_or_default();
        return Ok(WorkspaceTextPreview {
            text: decode_workspace_text(bytes, total_bytes > MAX_BYTES)?,
            truncated: total_bytes > MAX_BYTES,
            total_bytes,
        });
    }
    let (root, target) = checked_local_workspace_entry(&workspace_dir, &path)?;
    let readable = target.canonicalize().map_err(err)?;
    if !readable.starts_with(&root) {
        return Err("file symlink points outside the workspace".to_string());
    }
    let meta = std::fs::metadata(&readable).map_err(err)?;
    let mut file = std::fs::File::open(readable).map_err(err)?;
    let mut bytes = Vec::with_capacity(meta.len().min(MAX_BYTES) as usize);
    std::io::Read::take(&mut file, MAX_BYTES)
        .read_to_end(&mut bytes)
        .map_err(err)?;
    Ok(WorkspaceTextPreview {
        text: decode_workspace_text(&bytes, meta.len() > MAX_BYTES)?,
        truncated: meta.len() > MAX_BYTES,
        total_bytes: meta.len(),
    })
}

// Never expose lossy-decoded binary data as editable text. A bounded preview
// may end in the middle of an otherwise valid UTF-8 character.
pub(super) fn decode_workspace_text(bytes: &[u8], truncated: bool) -> CmdResult<String> {
    if bytes
        .iter()
        .any(|byte| *byte < 32 && !matches!(*byte, 9 | 10 | 12 | 13))
    {
        return Err("This file contains binary data and cannot be edited as text.".into());
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => Ok(text.to_string()),
        Err(error) if truncated && error.error_len().is_none() => {
            Ok(std::str::from_utf8(&bytes[..error.valid_up_to()])
                .unwrap()
                .to_string())
        }
        Err(_) => Err("This file is not UTF-8 text and cannot be edited as text.".into()),
    }
}

#[tauri::command]
pub async fn write_workspace_text_file(
    workspace_dir: String,
    path: String,
    text: String,
    expected_text: String,
) -> CmdResult<()> {
    if cetus_bridge::remote::parse_remote_workspace(&workspace_dir).is_some() {
        return Err("Editing remote files is not supported yet.".into());
    }
    const MAX_BYTES: u64 = 1024 * 1024;
    if text.len() as u64 > MAX_BYTES {
        return Err("File exceeds the 1 MB editing limit.".into());
    }
    decode_workspace_text(text.as_bytes(), false)?;
    let (root, target) = checked_local_workspace_entry(&workspace_dir, &path)?;
    let target = target.canonicalize().map_err(err)?;
    if !target.starts_with(&root) {
        return Err("file symlink points outside the workspace".into());
    }
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&target)
        .map_err(err)?;
    if !file.metadata().map_err(err)?.is_file() || file.metadata().map_err(err)?.len() > MAX_BYTES {
        return Err("File is not a complete editable text file.".into());
    }
    let mut current = Vec::new();
    (&mut file)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut current)
        .map_err(err)?;
    let current = decode_workspace_text(&current, false)?;
    if current != expected_text {
        return Err(
            "File changed on disk. Reopen it and reconcile your edits before saving.".into(),
        );
    }
    use std::io::{Seek, Write};
    file.rewind().map_err(err)?;
    file.write_all(text.as_bytes()).map_err(err)?;
    file.set_len(text.len() as u64).map_err(err)?;
    file.sync_all().map_err(err)?;
    Ok(())
}
