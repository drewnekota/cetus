//! DEV-ONLY in-app test/debug bridge ("eval bridge") for cetus.
//!
//! This module is gated behind the `devtest` Cargo feature (see `Cargo.toml`)
//! and is wired into `lib.rs` via `#[cfg(feature = "devtest")] mod devtest;`.
//! It is therefore compiled OUT of release/default builds entirely — there is
//! ZERO presence in production.
//!
//! It opens NO network port. Everything here is reachable only through Tauri's
//! in-process `invoke` IPC from cetus's own webview/frontend. The intent is that
//! an automation/eval agent can later drive these commands to:
//!   - eval arbitrary JS in the webview (`test_eval`),
//!   - round-trip read/operate on the DOM via a frontend TestHook (`test_dom`
//!     + the internal `test_dom_result` reply command),
//!   - capture a screenshot through cetus's own pipeline (`test_screenshot`),
//!   - drive the native AX/automation helper (`test_ax`).
//!
//! To actually invoke these from OUTSIDE the app, a future M4 (a UDS+CLI or an
//! MCP server) is still required — that is intentionally NOT built here.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter as _, Manager, State};
use tokio::sync::oneshot;

use crate::AppState;

/// Module-level registry of pending DOM round-trips. Keyed by request id.
///
/// We deliberately keep this as a module-level `static` (instead of adding a
/// field to `AppState`) so the dev bridge does not have to touch the shared
/// `AppState` struct while the rest of the codebase is under heavy concurrent
/// modification.
fn pending() -> &'static Mutex<HashMap<String, oneshot::Sender<Value>>> {
    static PENDING: OnceLock<Mutex<HashMap<String, oneshot::Sender<Value>>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Capture a screenshot through cetus's own pipeline (gated on Screen-Recording
/// TCC). Returns the base64 `Screenshot` or an error if permission is missing.
#[tauri::command]
pub async fn test_screenshot(_state: State<'_, AppState>) -> Result<crate::quick::Screenshot, String> {
    crate::quick::capture_screenshot()
        .ok_or_else(|| "no screenshot — grant Screen Recording permission".to_string())
}

/// Drive cetus's own native AX/automation helper. The `request` JSON is passed
/// straight through to the helper (see `cua::CuaRuntime::request_blocking`),
/// letting the bridge exercise the native AX tree / automation pipeline.
#[tauri::command]
pub async fn test_ax(state: State<'_, AppState>, request: Value) -> Result<Value, String> {
    let cua = state.cua.clone();
    let app_data_dir = state.app_data_dir.clone();
    // request_blocking shells out to the helper synchronously, so run it off the
    // async runtime's worker threads.
    tokio::task::spawn_blocking(move || cua.request_blocking(&app_data_dir, &request))
        .await
        .map_err(|e| format!("ax task failed: {e}"))
}

/// Eval arbitrary JS in the webview. Fire-and-forget: Tauri v2 `eval` returns
/// no value, so this resolves as soon as the JS is dispatched. Use `test_dom`
/// with the `eval` op if you need a value back.
#[tauri::command]
pub async fn test_eval(app: AppHandle, label: Option<String>, js: String) -> Result<(), String> {
    let label = label.unwrap_or_else(|| "main".to_string());
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("no webview window with label {label:?}"))?;
    window.eval(&js).map_err(|e| e.to_string())
}

/// DOM round-trip that RETURNS a value. Emits a `devtest-command` event that the
/// frontend `TestHook` handles; the hook replies via `test_dom_result`.
///
/// `op` is one of: `find`, `click`, `type`, `getText`, `eval`, `dump`.
#[tauri::command]
pub async fn test_dom(
    app: AppHandle,
    op: String,
    selector: Option<String>,
    text: Option<String>,
    js: Option<String>,
) -> Result<Value, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel::<Value>();

    {
        let mut map = pending().lock().map_err(|_| "registry poisoned".to_string())?;
        map.insert(id.clone(), tx);
    }

    app.emit(
        "devtest-command",
        json!({
            "id": id,
            "op": op,
            "selector": selector,
            "text": text,
            "js": js,
        }),
    )
    .map_err(|e| {
        // Drop the orphaned sender on emit failure so we don't leak.
        pending().lock().ok().and_then(|mut m| m.remove(&id));
        e.to_string()
    })?;

    match tokio::time::timeout(Duration::from_secs(5), rx).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) => {
            pending().lock().ok().and_then(|mut m| m.remove(&id));
            Err("devtest reply channel closed".to_string())
        }
        Err(_) => {
            pending().lock().ok().and_then(|mut m| m.remove(&id));
            Err("devtest dom round-trip timed out".to_string())
        }
    }
}

/// Internal reply command used by the frontend `TestHook` to resolve a pending
/// `test_dom` round-trip. Not meant to be called directly by the bridge user.
#[tauri::command]
pub async fn test_dom_result(id: String, value: Value) -> Result<(), String> {
    let tx = {
        let mut map = pending().lock().map_err(|_| "registry poisoned".to_string())?;
        map.remove(&id)
    };
    match tx {
        Some(tx) => {
            let _ = tx.send(value);
            Ok(())
        }
        None => Err(format!("no pending devtest request for id {id}")),
    }
}

// =============================================================================
// M4 — external (out-of-app) bridge: a Unix-domain-socket server + protocol.
// =============================================================================
//
// This lets an EXTERNAL agent (e.g. Claude Code) drive the same dev-only eval
// bridge from outside the running app, via a local FILESYSTEM socket. There is
// NO TCP port and nothing listens on the network.
//
// The op handlers below share the exact logic of the `test_*` #[tauri::command]
// wrappers above: those wrappers and the UDS dispatcher both call the plain
// `op_*` async fns, so there is a single implementation per op.
//
// SECURITY:
//   * Compiled only under the `devtest` feature (this whole module is).
//   * Filesystem socket only — no TCP, no network exposure.
//   * Opt-in even in a devtest build: `start_uds_server` early-returns unless
//     `CETUS_DEVTEST=1` OR `CETUS_DEVTEST_SOCK` is set. So a plain devtest build
//     does NOT open the socket unless explicitly asked.

use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;

/// `screenshot` op — capture via cetus's own pipeline (shared by `test_screenshot`).
fn op_screenshot() -> Result<crate::quick::Screenshot, String> {
    crate::quick::capture_screenshot()
        .ok_or_else(|| "no screenshot — grant Screen Recording permission".to_string())
}

/// `ax` op — drive the native AX/automation helper (shared by `test_ax`).
/// `request_blocking` shells out synchronously, so run it off the worker threads.
async fn op_ax(state: &AppState, request: Value) -> Result<Value, String> {
    let cua = state.cua.clone();
    let app_data_dir = state.app_data_dir.clone();
    tokio::task::spawn_blocking(move || cua.request_blocking(&app_data_dir, &request))
        .await
        .map_err(|e| format!("ax task failed: {e}"))
}

/// DOM round-trip — emits `devtest-command`, awaits the frontend `TestHook`
/// reply via the oneshot registry (shared by `test_dom`). ~5s timeout.
async fn op_dom(
    app: &AppHandle,
    op: String,
    selector: Option<String>,
    text: Option<String>,
    js: Option<String>,
) -> Result<Value, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel::<Value>();

    {
        let mut map = pending().lock().map_err(|_| "registry poisoned".to_string())?;
        map.insert(id.clone(), tx);
    }

    app.emit(
        "devtest-command",
        json!({ "id": id, "op": op, "selector": selector, "text": text, "js": js }),
    )
    .map_err(|e| {
        pending().lock().ok().and_then(|mut m| m.remove(&id));
        e.to_string()
    })?;

    match tokio::time::timeout(Duration::from_secs(5), rx).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) => {
            pending().lock().ok().and_then(|mut m| m.remove(&id));
            Err("devtest reply channel closed".to_string())
        }
        Err(_) => {
            pending().lock().ok().and_then(|mut m| m.remove(&id));
            Err("devtest dom round-trip timed out".to_string())
        }
    }
}

/// True if the operator explicitly opted into the external bridge.
fn uds_opted_in() -> bool {
    std::env::var("CETUS_DEVTEST_SOCK")
        .map(|v| !v.is_empty())
        .unwrap_or(false)
        || std::env::var("CETUS_DEVTEST").map(|v| v == "1").unwrap_or(false)
}

/// Resolve the socket path: `$CETUS_DEVTEST_SOCK`, else
/// `<app_data_dir>/cetus-devtest.sock`.
fn socket_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    if let Ok(p) = std::env::var("CETUS_DEVTEST_SOCK") {
        if !p.is_empty() {
            return Ok(std::path::PathBuf::from(p));
        }
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))?;
    Ok(dir.join("cetus-devtest.sock"))
}

/// Start the DEV-ONLY UDS bridge. Safe to call unconditionally from a devtest
/// build: it early-returns unless `CETUS_DEVTEST=1` / `CETUS_DEVTEST_SOCK` is set.
pub fn start_uds_server(app: AppHandle) {
    if !uds_opted_in() {
        return;
    }
    let path = match socket_path(&app) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[devtest] could not resolve socket path: {e}");
            return;
        }
    };

    tauri::async_runtime::spawn(async move {
        if let Some(parent) = path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        // Remove a stale socket file before binding.
        let _ = tokio::fs::remove_file(&path).await;

        let listener = match UnixListener::bind(&path) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[devtest] failed to bind {}: {e}", path.display());
                return;
            }
        };
        eprintln!("[devtest] UDS bridge listening on {}", path.display());

        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(handle_conn(app, stream));
                }
                Err(e) => {
                    eprintln!("[devtest] accept error: {e}");
                    break;
                }
            }
        }
    });
}

/// Per-connection loop: newline-delimited JSON request -> one response per line.
async fn handle_conn(app: AppHandle, stream: tokio::net::UnixStream) {
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    let mut line = String::new();

    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break, // client disconnected
            Ok(_) => {}
            Err(e) => {
                eprintln!("[devtest] read error: {e}");
                break;
            }
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let resp = match serde_json::from_str::<Value>(trimmed) {
            Ok(req) => dispatch(&app, &req).await,
            Err(e) => json!({ "id": Value::Null, "ok": false, "error": format!("invalid JSON: {e}") }),
        };
        if write_resp(&mut write_half, &resp).await.is_err() {
            break;
        }
    }
}

async fn write_resp(
    w: &mut (impl AsyncWriteExt + Unpin),
    resp: &Value,
) -> std::io::Result<()> {
    let mut bytes = serde_json::to_vec(resp).unwrap_or_else(|_| b"{}".to_vec());
    bytes.push(b'\n');
    w.write_all(&bytes).await?;
    w.flush().await
}

/// Route one request to the matching shared op fn.
async fn dispatch(app: &AppHandle, req: &Value) -> Value {
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let op = req.get("op").and_then(|v| v.as_str()).unwrap_or("");
    let s = |k: &str| req.get(k).and_then(|x| x.as_str()).map(|x| x.to_string());

    let result: Result<Value, String> = match op {
        "ping" => Ok(json!({})),

        "screenshot" => {
            op_screenshot().and_then(|shot| serde_json::to_value(shot).map_err(|e| e.to_string()))
        }

        "ax" => match req.get("request").cloned() {
            Some(request) => {
                let state = app.state::<AppState>();
                op_ax(&state, request).await
            }
            None => Err("ax requires `request`".to_string()),
        },

        // `dom` passthrough uses an inner `op` field; the aliases below map
        // straight onto the corresponding DOM op the frontend TestHook handles.
        "dom" => match s("op") {
            Some(dom_op) => op_dom(app, dom_op, s("selector"), s("text"), s("js")).await,
            None => Err("dom requires `op`".to_string()),
        },
        // All round-trip ops handled by the frontend TestHook — every one RETURNS
        // a value. `eval` lives here (not a fire-and-forget path): the CLI's
        // `dom --op eval` collapses to a top-level `op:"eval"`, so routing it
        // through `op_dom` is what makes it return the JS result instead of null.
        "find" | "click" | "type" | "getText" | "dump" | "eval" => {
            op_dom(app, op.to_string(), s("selector"), s("text"), s("js")).await
        }

        other => Err(format!("unknown op: {other}")),
    };

    match result {
        Ok(v) => json!({ "id": id, "ok": true, "result": v }),
        Err(e) => json!({ "id": id, "ok": false, "error": e }),
    }
}
