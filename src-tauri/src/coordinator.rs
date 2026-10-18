//! Coordinator registry: which conversation coordinates each folder's threads,
//! and which threads it started.
//!
//! A coordinator is an ordinary pi conversation with the coordinator-tools
//! extension switched on. The extension only registers its thread tools (and
//! the coordinator brief) when the pi was spawned with `CETUS_COORDINATOR=1`,
//! so the registry has to live where `pi_for` can read it before the spawn.
//! Sessions themselves are owned by the frontend, which answers the tools'
//! tunnel requests ([`crate::app_event::AppEvent::CoordinatorToolRequest`]).
//!
//! Stored as one JSON blob in `app_settings` — a handful of ids per folder,
//! not worth a table.
//!
//! The same thread tools are open to every runtime through `cetus thread …`
//! (control socket op `thread`): [`cli_request`] raises the same
//! `CoordinatorToolRequest` the pi extension does, and the frontend answers
//! it with [`coordinator_cli_respond`] instead of `extension_ui_respond`.

use crate::store::Store;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

const SETTING_KEY: &str = "coordinator_registry";

/// Serializes read-modify-write: a coordinator often starts several threads
/// in one turn, and their link calls arrive concurrently.
static WRITE: Mutex<()> = Mutex::new(());

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct CoordinatorRegistry {
    /// Folder (workspace dir) → coordinator conversation id.
    #[serde(default)]
    pub coordinators: HashMap<String, String>,
    /// Thread conversation id → the coordinator that started it.
    #[serde(default)]
    pub threads: HashMap<String, String>,
}

pub fn load(store: &Store) -> CoordinatorRegistry {
    store
        .get_setting(SETTING_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save(store: &Store, reg: &CoordinatorRegistry) -> Result<(), String> {
    let raw = serde_json::to_string(reg).map_err(|e| e.to_string())?;
    store
        .set_setting(SETTING_KEY, &raw)
        .map_err(|e| e.to_string())
}

/// Whether `conv_id` is some folder's coordinator (its pi gets the thread tools).
pub fn is_coordinator(store: &Store, conv_id: &str) -> bool {
    load(store).coordinators.values().any(|id| id == conv_id)
}

/// The user's standing instructions for every coordinator (e.g. which runtime
/// and model to give which kind of thread). A plain file so the
/// coordinator-tools extension can re-read it on every turn: edits apply to
/// running coordinators without a respawn.
pub fn instructions_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("coordinator-instructions.md")
}

#[tauri::command]
pub async fn coordinator_instructions(state: State<'_, AppState>) -> Result<String, String> {
    Ok(std::fs::read_to_string(instructions_path(&state.app_data_dir)).unwrap_or_default())
}

#[tauri::command]
pub async fn set_coordinator_instructions(
    state: State<'_, AppState>,
    text: String,
) -> Result<(), String> {
    let path = instructions_path(&state.app_data_dir);
    let text = text.trim();
    if text.is_empty() {
        match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    } else {
        std::fs::write(&path, format!("{text}\n")).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn coordinator_registry(
    state: State<'_, AppState>,
) -> Result<CoordinatorRegistry, String> {
    Ok(load(&state.store))
}

/// Make `conversation_id` the coordinator for `workspace_dir`, replacing any
/// earlier one (its threads stay linked to it).
#[tauri::command]
pub async fn coordinator_register(
    state: State<'_, AppState>,
    workspace_dir: String,
    conversation_id: String,
) -> Result<CoordinatorRegistry, String> {
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let mut reg = load(&state.store);
    reg.coordinators.insert(workspace_dir, conversation_id);
    save(&state.store, &reg)?;
    Ok(reg)
}

#[tauri::command]
pub async fn coordinator_link_thread(
    state: State<'_, AppState>,
    thread_id: String,
    coordinator_id: String,
) -> Result<CoordinatorRegistry, String> {
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let mut reg = load(&state.store);
    reg.threads.insert(thread_id, coordinator_id);
    save(&state.store, &reg)?;
    Ok(reg)
}

/// Request ids of CLI thread calls start with this, so the frontend knows to
/// answer through [`coordinator_cli_respond`].
pub const CLI_REQUEST_PREFIX: &str = "cli-";

/// Starting a thread can wait on a cold runtime spawn.
const CLI_TIMEOUT: Duration = Duration::from_secs(120);

type Pending = Mutex<HashMap<String, oneshot::Sender<String>>>;

fn pending() -> &'static Pending {
    static PENDING: OnceLock<Pending> = OnceLock::new();
    PENDING.get_or_init(Default::default)
}

/// One `cetus thread …` call from conversation `conv_id`: hand it to the
/// frontend (which owns sessions) and wait for its JSON reply.
pub async fn cli_request(
    app: &AppHandle,
    conv_id: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let request_id = format!("{CLI_REQUEST_PREFIX}{}", uuid::Uuid::new_v4());
    let (tx, rx) = oneshot::channel();
    pending()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(request_id.clone(), tx);
    let emitted = app.emit(
        "app-event",
        crate::app_event::AppEvent::CoordinatorToolRequest {
            conversation_id: conv_id.to_string(),
            request_id: request_id.clone(),
            params,
        },
    );
    let reply = match emitted {
        Err(e) => Err(e.to_string()),
        Ok(()) => match tokio::time::timeout(CLI_TIMEOUT, rx).await {
            Ok(Ok(raw)) => serde_json::from_str(&raw).map_err(|e| e.to_string()),
            Ok(Err(_)) => Err("Cetus dropped the request".to_string()),
            Err(_) => Err("timed out waiting for Cetus".to_string()),
        },
    };
    pending()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&request_id);
    reply
}

#[tauri::command]
pub async fn coordinator_cli_respond(request_id: String, value: String) -> Result<(), String> {
    let tx = pending()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&request_id)
        .ok_or_else(|| format!("no pending thread request {request_id}"))?;
    tx.send(value)
        .map_err(|_| "the CLI caller is gone".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_round_trips_and_tolerates_missing_fields() {
        let reg: CoordinatorRegistry = serde_json::from_str("{}").unwrap();
        assert!(reg.coordinators.is_empty() && reg.threads.is_empty());

        let mut reg = CoordinatorRegistry::default();
        reg.coordinators.insert("/w".into(), "c1".into());
        reg.threads.insert("t1".into(), "c1".into());
        let back: CoordinatorRegistry =
            serde_json::from_str(&serde_json::to_string(&reg).unwrap()).unwrap();
        assert_eq!(back.coordinators["/w"], "c1");
        assert_eq!(back.threads["t1"], "c1");
    }
}
