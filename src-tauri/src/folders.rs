//! Workspace folders that get renamed or moved on disk.
//!
//! Every store keys a folder by its absolute path (conversation rows,
//! automations, the coordinator registry, the sidebar lists), so a rename in
//! Finder used to leave all of them pointing at a dead path. Worse, each turn
//! then ran `create_dir_all` on that path and handed the agent a fresh, empty
//! directory with no hint that anything was wrong.
//!
//! Each folder now also gets a macOS bookmark, stored as one JSON map in
//! `app_settings`. A bookmark follows the folder across renames and moves on
//! the same volume. When a path stops existing we resolve its bookmark and,
//! if the folder is still around, rewrite every reference to the new path
//! ([`migrate`]). A folder that can't be found is reported missing instead
//! of being recreated; the sidebar offers "Locate folder…" for that case.
//!
//! Checks are a `stat` per folder, so they run often: at startup and on main
//! window focus (driven by the frontend through [`check_workspace_folders`]),
//! and before every turn, pi spawn and automation run ([`ensure_workspace`]).

use crate::store::Store;
use crate::AppState;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

const BOOKMARKS_KEY: &str = "folder_bookmarks";

/// Serializes read-modify-write of the bookmark map and migrations, so two
/// turns noticing the same move don't both rewrite the stores.
static WRITE: Mutex<()> = Mutex::new(());

/// Emitted to the main window after a folder's references were rewritten.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderMoved {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderCheck {
    pub dir: String,
    /// "ok" | "moved" | "missing"
    pub status: &'static str,
    /// The new location, for "moved".
    pub to: Option<String>,
}

enum Located {
    Here,
    Moved(PathBuf),
    Missing,
}

fn load_bookmarks(store: &Store) -> HashMap<String, String> {
    store
        .get_setting(BOOKMARKS_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_bookmarks(store: &Store, map: &HashMap<String, String>) {
    if let Ok(raw) = serde_json::to_string(map) {
        let _ = store.set_setting(BOOKMARKS_KEY, &raw);
    }
}

#[cfg(target_os = "macos")]
fn bookmark_for(path: &Path) -> Option<Vec<u8>> {
    use objc2_foundation::{NSString, NSURLBookmarkCreationOptions, NSURL};
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    url.bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
        NSURLBookmarkCreationOptions::empty(),
        None,
        None,
    )
    .ok()
    .map(|data| data.to_vec())
}

#[cfg(not(target_os = "macos"))]
fn bookmark_for(_path: &Path) -> Option<Vec<u8>> {
    None
}

#[cfg(target_os = "macos")]
fn resolve_bookmark(bytes: &[u8]) -> Option<PathBuf> {
    use objc2::runtime::Bool;
    use objc2_foundation::{NSData, NSURLBookmarkResolutionOptions, NSURL};
    let data = NSData::with_bytes(bytes);
    let mut stale = Bool::NO;
    // No UI and no mounting: this runs on background checks, and a folder on
    // an unplugged drive should read as missing, not pop a "connect to server"
    // prompt.
    let url = unsafe {
        NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
            &data,
            NSURLBookmarkResolutionOptions::WithoutUI
                | NSURLBookmarkResolutionOptions::WithoutMounting,
            None,
            &mut stale,
        )
    }
    .ok()?;
    url.path().map(|p| PathBuf::from(p.to_string()))
}

#[cfg(not(target_os = "macos"))]
fn resolve_bookmark(_bytes: &[u8]) -> Option<PathBuf> {
    None
}

/// A folder dragged to the Trash still resolves; treat that as deleted.
fn in_trash(path: &Path) -> bool {
    path.components().any(|c| c.as_os_str() == ".Trash")
        || path.to_string_lossy().contains("/.Trashes/")
}

/// Record a bookmark for an existing folder if it has none yet. Folders added
/// before this existed get one the first time they are seen in place.
fn remember(store: &Store, dir: &str) {
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let mut map = load_bookmarks(store);
    if map.contains_key(dir) {
        return;
    }
    if let Some(bytes) = bookmark_for(Path::new(dir)) {
        map.insert(dir.to_string(), STANDARD.encode(bytes));
        save_bookmarks(store, &map);
    }
}

fn locate(store: &Store, dir: &str) -> Located {
    if Path::new(dir).is_dir() {
        remember(store, dir);
        return Located::Here;
    }
    let found = load_bookmarks(store)
        .get(dir)
        .and_then(|b64| STANDARD.decode(b64).ok())
        .and_then(|bytes| resolve_bookmark(&bytes));
    match found {
        Some(to) if to.is_dir() && !in_trash(&to) && to != Path::new(dir) => Located::Moved(to),
        _ => Located::Missing,
    }
}

/// Folders Cetus never treats as user folders: the default "Chat" workspace
/// (always recreated on demand) and remote workspaces.
fn is_managed(state: &AppState, dir: &str) -> bool {
    Path::new(dir) == state.default_workspace
        || cetus_bridge::remote::parse_remote_workspace(dir).is_some()
}

/// Resolve a conversation's or automation's folder before using it as a cwd.
///
/// Returns the folder to run in: the same path, or the new one after a
/// rename (all references are migrated on the way). Errors when the folder
/// is gone, instead of recreating an empty directory at the old path.
pub fn ensure_workspace(app: &AppHandle, dir: &str) -> Result<PathBuf, String> {
    let state = app.state::<AppState>();
    if is_managed(&state, dir) {
        if cetus_bridge::remote::parse_remote_workspace(dir).is_none() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        return Ok(PathBuf::from(dir));
    }
    match locate(&state.store, dir) {
        Located::Here => Ok(PathBuf::from(dir)),
        Located::Moved(to) => {
            let to_str = to.to_string_lossy().to_string();
            migrate(app, dir, &to_str)?;
            Ok(to)
        }
        Located::Missing => Err(missing_message(dir)),
    }
}

fn missing_message(dir: &str) -> String {
    format!(
        "Folder not found: {dir}. It was renamed, moved or deleted. \
         Use \"Locate folder…\" on the folder in the sidebar to point Cetus at its new location."
    )
}

/// Replace `from` with `to` as a path prefix (the folder itself or anything
/// inside it). `None` when `path` is outside `from`.
fn rebase(path: &str, from: &str, to: &str) -> Option<String> {
    if path == from {
        return Some(to.to_string());
    }
    path.strip_prefix(from)
        .filter(|rest| rest.starts_with('/'))
        .map(|rest| format!("{to}{rest}"))
}

/// Rewrite every reference to `from` (and paths inside it) to `to`, then tell
/// the frontend so its localStorage lists and in-memory rows follow.
pub fn migrate(app: &AppHandle, from: &str, to: &str) -> Result<(), String> {
    if from == to {
        return Ok(());
    }
    let state = app.state::<AppState>();
    let store = &state.store;
    {
        let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
        store
            .rebase_workspace_dirs(from, to)
            .map_err(|e| e.to_string())?;
        crate::coordinator::rebase_workspace(store, from, to)?;

        let mut map = load_bookmarks(store);
        let moved: Vec<String> = map
            .keys()
            .filter(|k| rebase(k, from, to).is_some())
            .cloned()
            .collect();
        for key in moved {
            map.remove(&key);
        }
        if let Some(bytes) = bookmark_for(Path::new(to)) {
            map.insert(to.to_string(), STANDARD.encode(bytes));
        }
        save_bookmarks(store, &map);
    }

    carry_claude_history(Path::new(from), Path::new(to));
    repair_worktrees(Path::new(to));

    tracing::info!("cetus: workspace folder moved: {from} -> {to}");
    let _ = app.emit_to(
        "main",
        "workspace-moved",
        FolderMoved {
            from: from.to_string(),
            to: to.to_string(),
        },
    );
    Ok(())
}

/// Claude Code files its transcripts under `~/.claude/projects/<cwd slug>`,
/// so after a move `--resume` would look in an empty directory and the
/// conversation would lose its context. Carry the folder's project directory
/// (and those of its Cetus worktrees, which run with their own cwd) over to
/// the new slug.
fn carry_claude_history(from: &Path, to: &Path) {
    let Some(projects) = claude_projects_dir() else {
        return;
    };
    let mut pairs = vec![(from.to_path_buf(), to.to_path_buf())];
    if let Ok(entries) = std::fs::read_dir(to.join(".cetus").join("worktrees")) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            pairs.push((
                from.join(".cetus").join("worktrees").join(&name),
                entry.path(),
            ));
        }
    }
    for (old, new) in pairs {
        let old_dir = projects.join(claude_slug(&old));
        let new_dir = projects.join(claude_slug(&new));
        if !old_dir.is_dir() {
            continue;
        }
        if !new_dir.exists() {
            if let Err(e) = std::fs::rename(&old_dir, &new_dir) {
                tracing::warn!("cetus: moving claude history {old_dir:?} failed: {e}");
            }
            continue;
        }
        // Claude already ran in the new location: merge, keeping its files.
        if let Ok(entries) = std::fs::read_dir(&old_dir) {
            for entry in entries.flatten() {
                let target = new_dir.join(entry.file_name());
                if !target.exists() {
                    let _ = std::fs::rename(entry.path(), target);
                }
            }
        }
    }
}

fn claude_projects_dir() -> Option<PathBuf> {
    let base = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".claude")))?;
    Some(base.join("projects"))
}

/// Claude's project directory name: every non-alphanumeric byte becomes '-'.
fn claude_slug(path: &Path) -> String {
    path.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Git records worktree locations as absolute paths in both directions, so
/// Cetus's per-chat worktrees under `.cetus/worktrees` break when the repo
/// moves. `git worktree repair` rewrites both sides.
fn repair_worktrees(repo: &Path) {
    let dir = repo.join(".cetus").join("worktrees");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    if paths.is_empty() {
        return;
    }
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["worktree", "repair"])
        .args(&paths)
        .output();
    if let Ok(out) = out {
        if !out.status.success() {
            tracing::warn!(
                "cetus: git worktree repair in {repo:?} failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
    }
}

/// Check the sidebar's folders. Moved ones are migrated right away; the
/// result tells the frontend which are missing.
#[tauri::command]
pub async fn check_workspace_folders(
    app: AppHandle,
    dirs: Vec<String>,
) -> Result<Vec<FolderCheck>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut out = Vec::with_capacity(dirs.len());
        for dir in dirs {
            if is_managed(&state, &dir) {
                continue;
            }
            let check = match locate(&state.store, &dir) {
                Located::Here => FolderCheck {
                    dir,
                    status: "ok",
                    to: None,
                },
                Located::Moved(to) => {
                    let to = to.to_string_lossy().to_string();
                    match migrate(&app, &dir, &to) {
                        Ok(()) => FolderCheck {
                            dir,
                            status: "moved",
                            to: Some(to),
                        },
                        Err(e) => {
                            tracing::warn!("cetus: migrating {dir} -> {to} failed: {e}");
                            FolderCheck {
                                dir,
                                status: "missing",
                                to: None,
                            }
                        }
                    }
                }
                Located::Missing => FolderCheck {
                    dir,
                    status: "missing",
                    to: None,
                },
            };
            out.push(check);
        }
        out
    })
    .await
    .map_err(|e| e.to_string())
}

/// "Locate folder…": the user points a missing folder at its new location.
#[tauri::command]
pub async fn relocate_workspace(app: AppHandle, from: String, to: String) -> Result<(), String> {
    if !Path::new(&to).is_dir() {
        return Err(format!("not a folder: {to}"));
    }
    tauri::async_runtime::spawn_blocking(move || migrate(&app, &from, &to))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rebase_only_matches_whole_components() {
        assert_eq!(
            rebase("/a/foo", "/a/foo", "/a/bar").as_deref(),
            Some("/a/bar")
        );
        assert_eq!(
            rebase("/a/foo/sub", "/a/foo", "/a/bar").as_deref(),
            Some("/a/bar/sub")
        );
        assert_eq!(rebase("/a/foobar", "/a/foo", "/a/bar"), None);
    }

    #[test]
    fn claude_slug_matches_cli() {
        assert_eq!(
            claude_slug(Path::new("/Users/me/Developer/my.app")),
            "-Users-me-Developer-my-app"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn bookmark_follows_a_rename() {
        let root = std::env::temp_dir().join(format!("cetus-folders-{}", std::process::id()));
        let before = root.join("before");
        let after = root.join("after");
        std::fs::create_dir_all(&before).unwrap();
        let bytes = bookmark_for(&before).expect("bookmark");
        std::fs::rename(&before, &after).unwrap();
        let resolved = resolve_bookmark(&bytes).expect("resolves");
        let _ = std::fs::remove_dir_all(&root);
        assert!(resolved.ends_with("after"), "{resolved:?}");
    }

    #[test]
    fn trash_counts_as_missing() {
        assert!(in_trash(Path::new("/Users/me/.Trash/foo")));
        assert!(!in_trash(Path::new("/Users/me/Developer/foo")));
    }
}
