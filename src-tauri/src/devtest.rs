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
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter as _, Listener as _, Manager, State};
use tokio::sync::oneshot;
use uuid::Uuid;

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
pub async fn test_screenshot(
    _state: State<'_, AppState>,
) -> Result<crate::quick::Screenshot, String> {
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
        let mut map = pending()
            .lock()
            .map_err(|_| "registry poisoned".to_string())?;
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
        let mut map = pending()
            .lock()
            .map_err(|_| "registry poisoned".to_string())?;
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

async fn op_computer_observe(state: &AppState, mut request: Value) -> Result<Value, String> {
    if request.get("op").is_none() {
        request["op"] = json!("dump");
    }
    let include_screenshot = request
        .get("includeScreenshot")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let mut reply = op_ax(state, request).await?;
    if include_screenshot && reply.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        match op_screenshot() {
            Ok(shot) => reply["screenshotJpeg"] = json!(shot.data),
            Err(e) => reply["screenshotError"] = json!(e),
        }
    }
    Ok(reply)
}

fn op_chrome_host_self_test(state: &AppState) -> Result<Value, String> {
    crate::chrome_use::native_host_self_test(&state.app_data_dir)
        .and_then(|result| serde_json::to_value(result).map_err(|e| e.to_string()))
}

fn op_chrome_status(state: &AppState) -> Result<Value, String> {
    let manifest_path = chrome_native_host_manifest_path()?;
    Ok(json!({
        "installed": manifest_path.is_file(),
        "manifestPath": manifest_path,
        "messagesPath": crate::chrome_use::messages_path(&state.app_data_dir),
        "commandsPath": crate::chrome_use::commands_path(&state.app_data_dir)
    }))
}

fn chrome_native_host_manifest_path() -> Result<std::path::PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .ok_or_else(|| "HOME is not set".to_string())?;
        return Ok(home
            .join("Library/Application Support/Google/Chrome/NativeMessagingHosts")
            .join("com.cetus.chrome_use.json"));
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var_os("APPDATA")
            .map(std::path::PathBuf::from)
            .ok_or_else(|| "APPDATA is not set".to_string())?;
        return Ok(appdata.join("Google/Chrome/NativeMessagingHosts/com.cetus.chrome_use.json"));
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let home = std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .ok_or_else(|| "HOME is not set".to_string())?;
        Ok(home.join(".config/google-chrome/NativeMessagingHosts/com.cetus.chrome_use.json"))
    }
}

/// Open the Browser surface's top-level webview window through the same path the
/// frontend command uses. Dev-only, for validating the browser surface without
/// needing a manual click in the app shell.
async fn op_browser_open(app: &AppHandle, state: &AppState, url: String) -> Result<Value, String> {
    crate::commands::open_browser_window_with_app_data_dir(app, &state.app_data_dir, &url)
        .await
        .map(|_| json!({}))
}

/// Emit a Browser annotation event into the main window. The injected browser
/// script is separately unit-tested; this op verifies the runtime event bridge
/// and React-side intake in a dev app.
fn op_browser_annotate(app: &AppHandle, payload: Value) -> Result<Value, String> {
    app.emit_to("main", "browser-annotation", payload)
        .map_err(|e| e.to_string())?;
    Ok(json!({}))
}

fn op_browser_visible_open(app: &AppHandle, url: String) -> Result<Value, String> {
    app.emit_to(
        "main",
        "browser-control-request",
        json!({
            "op": "open",
            "url": url
        }),
    )
    .map_err(|e| e.to_string())?;
    Ok(json!({}))
}

fn op_webviews(app: &AppHandle) -> Value {
    let webviews = app
        .webviews()
        .into_iter()
        .map(|(label, webview)| {
            let bounds = webview.bounds().ok();
            json!({
                "label": label,
                "windowLabel": webview.window().label(),
                "bounds": bounds.map(|b| json!({
                    "x": b.position.to_logical::<f64>(1.0).x,
                    "y": b.position.to_logical::<f64>(1.0).y,
                    "width": b.size.to_logical::<f64>(1.0).width,
                    "height": b.size.to_logical::<f64>(1.0).height,
                })),
            })
        })
        .collect::<Vec<_>>();
    json!({ "webviews": webviews })
}

fn op_agent_settings(state: &AppState, settings: Option<Value>) -> Result<Value, String> {
    if let Some(settings) = settings {
        let mut current = crate::agent::load_settings(&state.store);
        if let Some(browser) = settings.get("browser").and_then(|v| v.as_bool()) {
            current.browser = browser;
        }
        if let Some(computer) = settings.get("computer").and_then(|v| v.as_bool()) {
            current.computer = computer;
        }
        crate::agent::save_settings(&state.store, &current).map_err(|e| e.to_string())?;
        crate::agent::export_enabled(&state.store);
        crate::mcp::export_config(&state.app_data_dir, &state.store);
    }
    serde_json::to_value(crate::agent::load_settings(&state.store)).map_err(|e| e.to_string())
}

async fn op_agent_prompt(
    app: &AppHandle,
    state: &AppState,
    prompt: String,
    workspace: Option<String>,
    archive: bool,
) -> Result<Value, String> {
    let workspace = workspace
        .map(PathBuf::from)
        .unwrap_or_else(|| state.default_workspace.clone());
    std::fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;

    let id = Uuid::new_v4().to_string();
    let now = crate::store::now_ms();
    let conversation = crate::store::Conversation {
        id: id.clone(),
        title: "Devtest benchmark".to_string(),
        session_file: String::new(),
        workspace_dir: workspace.to_string_lossy().to_string(),
        model: Default::default(),
        created_at: now,
        updated_at: now,
        archived_at: None,
        source_automation_id: None,
        parallel_group_id: None,
        solution_index: None,
        review_state: "none".to_string(),
    };
    state
        .store
        .insert(&conversation)
        .map_err(|e| e.to_string())?;

    let started = std::time::Instant::now();
    let (done_tx, done_rx) = oneshot::channel::<Result<(), String>>();
    let done_tx = Arc::new(Mutex::new(Some(done_tx)));
    let listen_conv_id = id.clone();
    let event_id = app.listen("app-event", move |event| {
        let Ok(value) = serde_json::from_str::<Value>(event.payload()) else {
            return;
        };
        let same_conversation = value
            .get("conversationId")
            .and_then(|v| v.as_str())
            .map(|v| v == listen_conv_id)
            .unwrap_or(false);
        if !same_conversation {
            return;
        }

        let outcome = match value.get("type").and_then(|v| v.as_str()) {
            Some("pi_event")
                if value.pointer("/event/type").and_then(|v| v.as_str()) == Some("agent_end") =>
            {
                Some(Ok(()))
            }
            Some("pi_error") => Some(Err(value
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("pi_error")
                .to_string())),
            Some("pi_exited") => Some(Err(format!(
                "pi exited with code {:?}",
                value.get("code").and_then(|v| v.as_i64())
            ))),
            _ => None,
        };

        if let Some(outcome) = outcome {
            if let Ok(mut slot) = done_tx.lock() {
                if let Some(tx) = slot.take() {
                    let _ = tx.send(outcome);
                }
            }
        }
    });

    let result = async {
        let pi = state.pi_for(&id).await.map_err(|e| e.to_string())?;
        pi.send_prompt(&prompt, Vec::new())
            .await
            .map_err(|e| e.to_string())?;
        match tokio::time::timeout(Duration::from_secs(600), done_rx).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(e))) => return Err(e),
            Ok(Err(_)) => return Err("agent completion listener closed".to_string()),
            Err(_) => return Err("agent turn timed out waiting for agent_end".to_string()),
        }
        state.store.touch(&id, crate::store::now_ms()).ok();
        let messages = pi.get_messages().await.map_err(|e| e.to_string())?;
        let conversation = state
            .store
            .get(&id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "conversation disappeared".to_string())?;
        Ok::<_, String>(json!({
            "conversation": conversation,
            "messages": messages,
            "durationMs": started.elapsed().as_millis() as u64
        }))
    }
    .await;
    app.unlisten(event_id);

    if archive {
        let _ = state.store.set_archived(&id, true, crate::store::now_ms());
        state.kill_pi(&id).await;
    }

    result
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
        let mut map = pending()
            .lock()
            .map_err(|_| "registry poisoned".to_string())?;
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
        || std::env::var("CETUS_DEVTEST")
            .map(|v| v == "1")
            .unwrap_or(false)
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
            Err(e) => {
                json!({ "id": Value::Null, "ok": false, "error": format!("invalid JSON: {e}") })
            }
        };
        if write_resp(&mut write_half, &resp).await.is_err() {
            break;
        }
    }
}

async fn write_resp(w: &mut (impl AsyncWriteExt + Unpin), resp: &Value) -> std::io::Result<()> {
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

        "computerObserve" => match req.get("request").cloned() {
            Some(request) => {
                let state = app.state::<AppState>();
                op_computer_observe(&state, request).await
            }
            None => Err("computerObserve requires `request`".to_string()),
        },

        "chromeHostSelfTest" => {
            let state = app.state::<AppState>();
            op_chrome_host_self_test(&state)
        }

        "chromeStatus" => {
            let state = app.state::<AppState>();
            op_chrome_status(&state)
        }

        "browserOpen" => match s("url") {
            Some(url) => {
                let state = app.state::<AppState>();
                op_browser_open(app, &state, url).await
            }
            None => Err("browserOpen requires `url`".to_string()),
        },

        "browserPanelOpen" => match s("url") {
            Some(url) => crate::commands::open_browser_panel(
                app.clone(),
                url,
                crate::commands::BrowserPanelBounds {
                    x: req.get("x").and_then(|v| v.as_f64()).unwrap_or(900.0),
                    y: req.get("y").and_then(|v| v.as_f64()).unwrap_or(80.0),
                    width: req.get("width").and_then(|v| v.as_f64()).unwrap_or(420.0),
                    height: req.get("height").and_then(|v| v.as_f64()).unwrap_or(720.0),
                },
                None,
            )
            .await
            .map(|_| json!({})),
            None => Err("browserPanelOpen requires `url`".to_string()),
        },

        "browserPanelClose" => crate::commands::close_browser_panel(app.clone())
            .await
            .map(|_| json!({})),

        "browserAnnotate" => match req.get("payload").cloned() {
            Some(payload) => op_browser_annotate(app, payload),
            None => Err("browserAnnotate requires `payload`".to_string()),
        },

        "browserVisibleOpen" => match s("url") {
            Some(url) => op_browser_visible_open(app, url),
            None => Err("browserVisibleOpen requires `url`".to_string()),
        },

        "webviews" => Ok(op_webviews(app)),

        "agentSettings" => {
            let state = app.state::<AppState>();
            op_agent_settings(&state, req.get("settings").cloned())
        }

        "agentPrompt" => match s("text") {
            Some(prompt) => {
                let state = app.state::<AppState>();
                op_agent_prompt(
                    app,
                    &state,
                    prompt,
                    s("workspace"),
                    req.get("archive")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                )
                .await
            }
            None => Err("agentPrompt requires `text`".to_string()),
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
