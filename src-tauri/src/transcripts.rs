//! Dictation history — voice transcripts saved as durable context.
//!
//! When enabled, every finalized dictation transcript (what the user spoke into
//! the mic, via any surface) is appended here, so BOTH sides can read it back:
//! the **user** through the Voice settings page (the commands below + the
//! history list), and the **agent** through the `recall_dictation` tool shipped
//! by the `dictation-recall` pi extension.
//!
//! Same medium + rationale as [`crate::memory`]: a single JSON file at
//! `<app_data>/dictations.json`, because it must be reachable from two processes
//! — cetus (Rust) and the pi sidecar (a Bun child). The path is exported to pi as
//! `CETUS_DICTATION_PATH` at startup (see `lib.rs`, next to `CETUS_MEMORY_PATH`).
//! Writes are atomic (temp + rename); a process mutex serialises cetus's own
//! read-modify-write. Off by default — recording everything you say is sensitive.

use crate::AppState;
use crate::store::now_ms;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::State;
use uuid::Uuid;

type CmdResult<T> = Result<T, String>;

/// Hard ceiling; oldest entries are dropped past this so the file can't grow
/// without bound.
const MAX_ENTRIES: usize = 1000;
/// Per-entry text cap.
const MAX_TEXT_CHARS: usize = 4000;

/// One saved dictation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptEntry {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub text: String,
    /// Which surface produced it: "composer" | "quick" | "global".
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub created_at: i64,
}

/// The whole on-disk store. `enabled` is the master switch: when false we neither
/// record new transcripts nor let the agent recall them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptState {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub entries: Vec<TranscriptEntry>,
}

impl Default for TranscriptState {
    fn default() -> Self {
        // Off by default — dictation content is sensitive; opt-in only.
        Self {
            enabled: false,
            entries: Vec::new(),
        }
    }
}

/// Absolute path of the store. Mirrors the value exported as `CETUS_DICTATION_PATH`
/// so cetus and the extension agree on one file.
pub fn transcripts_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("dictations.json")
}

fn file_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Read the store, tolerating a missing / corrupt file by returning the default
/// (empty, disabled) state — history should never be the reason a command fails.
fn read_state(path: &Path) -> TranscriptState {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return TranscriptState::default(),
        Err(e) => {
            tracing::warn!("dictations.json read failed ({e}); starting fresh");
            return TranscriptState::default();
        }
    };
    if raw.trim().is_empty() {
        return TranscriptState::default();
    }
    match serde_json::from_str::<TranscriptState>(&raw) {
        Ok(mut s) => {
            s.entries.retain(|e| !e.text.trim().is_empty());
            s
        }
        Err(e) => {
            tracing::warn!("dictations.json unparseable ({e}); backing up to .corrupt, starting fresh");
            let _ = std::fs::copy(path, path.with_extension("json.corrupt"));
            TranscriptState::default()
        }
    }
}

/// Atomic write: JSON to a sibling temp file, then rename over the target.
fn write_state(path: &Path, state: &TranscriptState) -> CmdResult<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

fn clamp_text(s: &str) -> String {
    let t = s.trim();
    if t.chars().count() > MAX_TEXT_CHARS {
        t.chars().take(MAX_TEXT_CHARS).collect()
    } else {
        t.to_string()
    }
}

// ---- Non-command access (called from the dictation pipeline) ---------------

/// Append a finalized transcript — a no-op unless history is enabled. Caps the
/// store to [`MAX_ENTRIES`] (drops oldest). Best-effort; never fails the caller.
/// File IO, so run this off the async runtime (e.g. `spawn_blocking`).
pub fn record(app_data_dir: &Path, text: &str, target: &str) {
    let text = clamp_text(text);
    if text.is_empty() {
        return;
    }
    let path = transcripts_path(app_data_dir);
    let _guard = file_lock().lock().unwrap();
    let mut s = read_state(&path);
    if !s.enabled {
        return;
    }
    s.entries.push(TranscriptEntry {
        id: Uuid::new_v4().to_string(),
        text,
        target: target.to_string(),
        created_at: now_ms(),
    });
    if s.entries.len() > MAX_ENTRIES {
        let drop = s.entries.len() - MAX_ENTRIES;
        s.entries.drain(0..drop);
    }
    if let Err(e) = write_state(&path, &s) {
        tracing::warn!("dictation history write failed: {e}");
    }
}

/// Replace the most recent entry matching `original` with the user's edited
/// version — called by the corrections watcher when re-reading the target
/// field shows the user reworked the dictation by hand. History exists to be
/// context ("what the user said and kept"), so the edited rendering is the one
/// worth keeping. No-op when history is off or the entry has already rolled
/// out. Best-effort; file IO, so run off the async runtime.
pub fn amend(app_data_dir: &Path, original: &str, edited: &str) {
    let original = clamp_text(original);
    let edited = clamp_text(edited);
    if original.is_empty() || edited.is_empty() || original == edited {
        return;
    }
    let path = transcripts_path(app_data_dir);
    let _guard = file_lock().lock().unwrap();
    let mut s = read_state(&path);
    if !s.enabled {
        return;
    }
    let Some(entry) = s.entries.iter_mut().rev().find(|e| e.text == original) else {
        return;
    };
    entry.text = edited;
    if let Err(e) = write_state(&path, &s) {
        tracing::warn!("dictation history amend failed: {e}");
    }
}

/// The most recent transcript texts (oldest→newest), for use as dictation
/// dialog context — "what the user just said". Empty unless history is enabled,
/// so this inherits the same opt-in as recording. Best-effort; never fails.
pub fn recent(app_data_dir: &Path, n: usize) -> Vec<String> {
    if n == 0 {
        return Vec::new();
    }
    let path = transcripts_path(app_data_dir);
    let _guard = file_lock().lock().unwrap();
    let s = read_state(&path);
    if !s.enabled {
        return Vec::new();
    }
    let start = s.entries.len().saturating_sub(n);
    s.entries[start..].iter().map(|e| e.text.clone()).collect()
}

// ---- Commands --------------------------------------------------------------

#[tauri::command]
pub async fn list_transcripts(state: State<'_, AppState>) -> CmdResult<TranscriptState> {
    let path = transcripts_path(&state.app_data_dir);
    let _guard = file_lock().lock().unwrap();
    Ok(read_state(&path))
}

#[tauri::command]
pub async fn set_transcripts_enabled(state: State<'_, AppState>, enabled: bool) -> CmdResult<()> {
    let path = transcripts_path(&state.app_data_dir);
    let _guard = file_lock().lock().unwrap();
    let mut s = read_state(&path);
    s.enabled = enabled;
    write_state(&path, &s)
}

#[tauri::command]
pub async fn clear_transcripts(state: State<'_, AppState>) -> CmdResult<()> {
    let path = transcripts_path(&state.app_data_dir);
    let _guard = file_lock().lock().unwrap();
    let mut s = read_state(&path);
    s.entries.clear();
    write_state(&path, &s)
}
