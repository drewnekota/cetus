//! Persistent agent memory.
//!
//! A small set of durable notes — user identity, preferences, ongoing projects,
//! decisions — that the agent should carry across conversations. Both sides edit
//! the same store: the **user** through the Memory settings page (the commands
//! below) and the **agent** through the `manage_memory` tool shipped by the
//! `memory` pi extension. The `before_agent_start` hook in that extension reads
//! the store fresh each turn and appends the enabled entries to the system
//! prompt, so an edit from either side shows up on the very next turn.
//!
//! Storage is a single JSON file at `<app_data>/memory.json`, not the SQLite
//! store, because it has to be reachable from *two* processes: cetus (Rust) and
//! the pi sidecar (a Bun child). A plain file is the only medium both can touch
//! without coupling the extension to cetus's DB schema. The path is exported to
//! pi as `CETUS_MEMORY_PATH` at startup (see `lib.rs`, next to `CETUS_SCREEN_LOG`).
//!
//! Writes are atomic (write a sibling temp file, then rename) so a crashed or
//! interleaved write never leaves a half-written *file*, and a process-wide mutex
//! serialises cetus's own read-modify-write cycles. What the mutex does NOT cover
//! is the cross-process case: the pi side (possibly several concurrent children
//! during a parallel-solutions fan-out) is a different process, so two writers
//! that read → mutate → write around each other can drop one writer's entry
//! (last-writer-wins on the whole file). We accept that lost-update window here
//! rather than take a cross-process file lock: memory edits are human-paced and
//! infrequent, the data is non-critical and trivially re-added, and the atomic
//! rename still guarantees the file is never *corrupt*. Reads are defensive — a
//! single malformed entry is dropped (not fatal), and a wholly unparseable file
//! is preserved as a `.corrupt` sibling before we fall back to empty, so a stray
//! edit can never silently and irrecoverably erase the store.

use crate::AppState;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::State;
use uuid::Uuid;

use crate::store::now_ms;

type CmdResult<T> = Result<T, String>;

const CURRENT_VERSION: u32 = 1;
/// Hard ceiling on stored entries so the store (and the injected prompt block)
/// can't grow without bound. New entries past this are rejected with an error.
const MAX_ENTRIES: usize = 200;
/// Per-entry content cap. Keeps a single note from dominating the prompt.
const MAX_CONTENT_CHARS: usize = 2000;

fn default_true() -> bool {
    true
}
fn default_version() -> u32 {
    CURRENT_VERSION
}
/// Source for an entry that somehow lost its `source` field (hand edit, schema
/// drift). Mirrors the pi extension's normalisation so the two layers agree.
fn default_source() -> String {
    "user".to_string()
}

/// One durable note. `source` records who authored it ("user" | "agent") so the
/// UI can badge agent-written memories; `enabled` lets either side mute an entry
/// without deleting it (muted entries are not injected into context).
// Every field carries a serde default so a single entry missing a key (a hand
// edit, an entry written by an older/newer schema) deserializes with sane
// fallbacks instead of failing the whole document. Entries missing the
// essentials (id/content) are dropped in `read_state`, matching the pi side.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub content: String,
    /// Optional free-text grouping label (e.g. "Preferences", "Project: cetus").
    #[serde(default)]
    pub category: Option<String>,
    /// "user" or "agent".
    #[serde(default = "default_source")]
    pub source: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

/// The whole on-disk store. `enabled` is the master switch for memory injection;
/// when false the extension skips the whole block even if entries exist.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryState {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub entries: Vec<MemoryEntry>,
}

impl Default for MemoryState {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            enabled: true,
            entries: Vec::new(),
        }
    }
}

/// Absolute path of the memory store. Mirrors the value exported as
/// `CETUS_MEMORY_PATH` so cetus and the extension agree on one file.
pub fn memory_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("memory.json")
}

/// Serialises cetus-side read-modify-write so two concurrent commands can't
/// clobber each other. (The pi extension is a separate process and isn't covered
/// by this lock; the atomic rename below is what keeps *that* race safe.)
fn file_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Read the store, tolerating a missing or corrupt file by returning the default
/// (empty, enabled) state — memory should never be the reason a command fails.
///
/// Resilience matches the pi extension: missing per-entry fields fall back to
/// defaults (serde) and entries without the essentials are dropped, so one bad
/// entry can't sink the whole store. A file that won't parse *at all* is copied
/// to a `.corrupt` sibling first, so the subsequent write that overwrites it
/// can't silently and irrecoverably erase recoverable data.
fn read_state(path: &Path) -> MemoryState {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return MemoryState::default(),
        Err(e) => {
            tracing::warn!("memory.json read failed ({e}); starting fresh");
            return MemoryState::default();
        }
    };
    if raw.trim().is_empty() {
        return MemoryState::default();
    }
    match serde_json::from_str::<MemoryState>(&raw) {
        Ok(mut s) => {
            s.entries
                .retain(|e| !e.id.is_empty() && !e.content.trim().is_empty());
            s
        }
        Err(e) => {
            tracing::warn!(
                "memory.json unparseable ({e}); backing up to .corrupt and starting fresh"
            );
            let _ = std::fs::copy(path, path.with_extension("json.corrupt"));
            MemoryState::default()
        }
    }
}

/// Atomic write: pretty JSON to a sibling temp file, then rename over the target.
fn write_state(path: &Path, state: &MemoryState) -> CmdResult<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Normalise an optional, possibly-blank category to `Some(trimmed)` / `None`.
fn norm_category(c: Option<String>) -> Option<String> {
    c.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

// ---- Commands --------------------------------------------------------------

#[tauri::command]
pub async fn list_memories(state: State<'_, AppState>) -> CmdResult<MemoryState> {
    let path = memory_path(&state.app_data_dir);
    let _guard = file_lock().lock().unwrap();
    Ok(read_state(&path))
}

#[tauri::command]
pub async fn create_memory(
    state: State<'_, AppState>,
    content: String,
    category: Option<String>,
) -> CmdResult<MemoryEntry> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("memory content is empty".into());
    }
    if content.chars().count() > MAX_CONTENT_CHARS {
        return Err(format!(
            "memory content exceeds {MAX_CONTENT_CHARS} characters"
        ));
    }
    let path = memory_path(&state.app_data_dir);
    let _guard = file_lock().lock().unwrap();
    let mut s = read_state(&path);
    if s.entries.len() >= MAX_ENTRIES {
        return Err(format!(
            "memory is full ({MAX_ENTRIES} entries); delete some first"
        ));
    }
    let now = now_ms();
    let entry = MemoryEntry {
        id: Uuid::new_v4().to_string(),
        content,
        category: norm_category(category),
        source: "user".to_string(),
        enabled: true,
        created_at: now,
        updated_at: now,
    };
    s.entries.push(entry.clone());
    write_state(&path, &s)?;
    Ok(entry)
}

#[tauri::command]
pub async fn update_memory(
    state: State<'_, AppState>,
    id: String,
    content: Option<String>,
    category: Option<String>,
    enabled: Option<bool>,
) -> CmdResult<MemoryEntry> {
    let path = memory_path(&state.app_data_dir);
    let _guard = file_lock().lock().unwrap();
    let mut s = read_state(&path);
    let entry = s
        .entries
        .iter_mut()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("memory entry not found: {id}"))?;
    if let Some(c) = content {
        let c = c.trim().to_string();
        if c.is_empty() {
            return Err("memory content is empty".into());
        }
        if c.chars().count() > MAX_CONTENT_CHARS {
            return Err(format!(
                "memory content exceeds {MAX_CONTENT_CHARS} characters"
            ));
        }
        entry.content = c;
    }
    // `category` is passed only when the user touched the field; an empty string
    // clears it, a non-empty string sets it. (Not-passed keeps the old value.)
    if let Some(cat) = category {
        entry.category = norm_category(Some(cat));
    }
    if let Some(en) = enabled {
        entry.enabled = en;
    }
    entry.updated_at = now_ms();
    let updated = entry.clone();
    write_state(&path, &s)?;
    Ok(updated)
}

#[tauri::command]
pub async fn delete_memory(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let path = memory_path(&state.app_data_dir);
    let _guard = file_lock().lock().unwrap();
    let mut s = read_state(&path);
    let before = s.entries.len();
    s.entries.retain(|e| e.id != id);
    if s.entries.len() == before {
        return Ok(()); // already gone — idempotent
    }
    write_state(&path, &s)
}

#[tauri::command]
pub async fn set_memory_enabled(state: State<'_, AppState>, enabled: bool) -> CmdResult<()> {
    let path = memory_path(&state.app_data_dir);
    let _guard = file_lock().lock().unwrap();
    let mut s = read_state(&path);
    s.enabled = enabled;
    write_state(&path, &s)
}

#[tauri::command]
pub async fn clear_memories(state: State<'_, AppState>) -> CmdResult<()> {
    let path = memory_path(&state.app_data_dir);
    let _guard = file_lock().lock().unwrap();
    let mut s = read_state(&path);
    s.entries.clear();
    write_state(&path, &s)
}

// ---- Non-command access (used by the dreaming pass) ------------------------

/// Read-only snapshot of the store for callers without a Tauri `State` — the
/// dreaming pass ([`crate::dream`]) needs to see existing notes so it doesn't
/// re-derive duplicates, and the ids of agent notes it may refine.
pub fn snapshot(app_data_dir: &Path) -> MemoryState {
    let path = memory_path(app_data_dir);
    let _guard = file_lock().lock().unwrap();
    read_state(&path)
}

/// One memory mutation produced by the dreaming consolidation pass.
pub enum Consolidation {
    /// A fresh durable note (lands as an `agent`-sourced entry).
    Add {
        content: String,
        category: Option<String>,
    },
    /// Refine an existing **agent**-written note in place (user notes are never
    /// rewritten by the agent). No-op if the id is missing or not agent-sourced.
    Update { id: String, content: String },
}

/// Apply a batch of dreaming ops in a single read-modify-write under the file
/// lock — one atomic write minimizes the documented cross-process lost-update
/// window with the pi side. Honors the same `MAX_ENTRIES` / `MAX_CONTENT_CHARS`
/// caps as the user-facing commands. Returns how many ops actually applied.
pub fn consolidate(app_data_dir: &Path, ops: Vec<Consolidation>) -> CmdResult<usize> {
    let path = memory_path(app_data_dir);
    let _guard = file_lock().lock().unwrap();
    let mut s = read_state(&path);
    let now = now_ms();
    let mut applied = 0usize;
    for op in ops {
        match op {
            Consolidation::Add { content, category } => {
                let content = clamp_content(&content);
                if content.is_empty() {
                    continue;
                }
                if s.entries.len() >= MAX_ENTRIES {
                    continue; // full — drop overflow rather than evict
                }
                s.entries.push(MemoryEntry {
                    id: Uuid::new_v4().to_string(),
                    content,
                    category: norm_category(category),
                    source: "agent".to_string(),
                    enabled: true,
                    created_at: now,
                    updated_at: now,
                });
                applied += 1;
            }
            Consolidation::Update { id, content } => {
                let content = clamp_content(&content);
                if content.is_empty() {
                    continue;
                }
                // Only refine agent-authored notes; the user's own are off-limits.
                if let Some(e) = s
                    .entries
                    .iter_mut()
                    .find(|e| e.id == id && e.source == "agent")
                {
                    e.content = content;
                    e.updated_at = now;
                    applied += 1;
                }
            }
        }
    }
    if applied > 0 {
        write_state(&path, &s)?;
    }
    Ok(applied)
}

/// Trim and cap a candidate note to the per-entry content limit.
fn clamp_content(s: &str) -> String {
    let t = s.trim();
    if t.chars().count() > MAX_CONTENT_CHARS {
        t.chars().take(MAX_CONTENT_CHARS).collect()
    } else {
        t.to_string()
    }
}
