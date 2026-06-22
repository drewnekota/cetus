//! Browser / computer "agent control" — settings, the host-tunnel handler that
//! backs the `browser-use` / `computer-use` pi extensions, and the emergency stop.
//!
//! The extensions tunnel two kinds of sentinel `ctx.ui.input` through
//! [`crate::pi_rpc`]'s `dispatch_line` (titles [`crate::bridge::AGENT_STEP_TITLE`]
//! and [`crate::bridge::CUA_REQUEST_TITLE`]), surfaced as
//! [`crate::app_event::AppEvent::AgentControlRequest`]. This module answers them:
//!
//! * `kind: "step"` — a live "watch" step. Re-emitted to the frontend as
//!   [`crate::app_event::AppEvent::AgentStep`] (the agent-control card) and acked.
//!   The model never receives this; it is for the human watcher only.
//! * `kind: "cua"` — a native macOS accessibility call. Run through
//!   [`crate::cua`] and the result (element list / action outcome) is replied to
//!   the waiting extension.
//! * `kind: "browser"` — a visible Browser surface request. Forwarded to the
//!   React main window, which opens/focuses the right-side Browser tab.
//!
//! Replies go back through the parent pi's `extension_ui_response`, the exact
//! mechanism Ultra uses (see [`crate::ultra`]).

use crate::app_event::AppEvent;
use crate::cua::CuaRuntime;
use crate::pi_rpc::PiRpc;
use crate::store::Store;
use crate::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

// =============================================================================
// Settings
// =============================================================================

/// Persisted switches, one JSON blob in `app_settings` (mirrors Ultra). The two
/// surfaces are toggled independently — browser-use and computer-use each gate
/// their own pi extension and prompt section.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettings {
    /// When on, conversations get the browser-control prompt and the `browser_*`
    /// tools register (gated via env, see [`export_enabled`]).
    pub browser: bool,
    /// When on, conversations get the computer-control prompt and the
    /// `computer_*` tools register (gated via env, see [`export_enabled`]).
    pub computer: bool,
}

const SETTINGS_KEY: &str = "agent_control";

pub fn load_settings(store: &Store) -> AgentSettings {
    let Some(raw) = store.get_setting(SETTINGS_KEY).ok().flatten() else {
        return AgentSettings::default();
    };
    // Migrate the legacy single master switch (`{"enabled": bool}`) by mirroring
    // it onto both surfaces, unless the new keys are already present.
    if let Ok(v) = serde_json::from_str::<Value>(&raw) {
        if v.get("browser").is_none() && v.get("computer").is_none() {
            if let Some(on) = v.get("enabled").and_then(|e| e.as_bool()) {
                return AgentSettings {
                    browser: on,
                    computer: on,
                };
            }
        }
    }
    serde_json::from_str(&raw).unwrap_or_default()
}

pub(crate) fn save_settings(store: &Store, s: &AgentSettings) -> anyhow::Result<()> {
    store.set_setting(SETTINGS_KEY, &serde_json::to_string(s)?)?;
    Ok(())
}

/// Publish the enable flags to the process env the pi children inherit, so each
/// extension registers its tools only when its surface is on. Call at boot and on
/// every toggle (followed by a pi recycle).
pub fn export_enabled(store: &Store) {
    let s = load_settings(store);
    std::env::set_var("CETUS_BROWSER_USE", if s.browser { "1" } else { "" });
    std::env::set_var("CETUS_COMPUTER_USE", if s.computer { "1" } else { "" });
}

// =============================================================================
// Managed Chrome (CDP) for the browser capability
// =============================================================================
//
// The browser surface is provided by `chrome-devtools-mcp` (a built-in MCP
// connector, see [`crate::mcp::export_config`]) driving a Chrome the host owns.
// We launch that Chrome with `--remote-debugging-port=9222` and a persistent
// profile under app support, so the user logs into sites once and the session
// sticks; chrome-devtools-mcp attaches to it via `--browser-url`. Idempotent: a
// no-op when a CDP endpoint is already listening.

const CHROME_DEBUG_PORT: u16 = 9222;

/// Persistent profile dir for the agent's managed Chrome (keeps logins across
/// runs). Matches the path the old native browser tool used so existing logins
/// carry over.
fn chrome_profile_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join("Library/Application Support/cetus/chrome-cdp")
}

/// True if a CDP-enabled Chrome is already answering on the debug port.
async fn chrome_cdp_alive() -> bool {
    let url = format!("http://127.0.0.1:{CHROME_DEBUG_PORT}/json/version");
    match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    {
        Ok(c) => c
            .get(url)
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false),
        Err(_) => false,
    }
}

/// Ensure a CDP-enabled Chrome is listening on `127.0.0.1:9222` with the agent's
/// persistent profile, launching one if needed. Best-effort; the caller logs.
/// macOS-only (uses `open -na`), which matches cetus's agent-control surfaces.
pub async fn ensure_chrome_running() -> anyhow::Result<()> {
    if chrome_cdp_alive().await {
        return Ok(());
    }
    let profile = chrome_profile_dir();
    // `open -na` starts a fresh instance bound to our profile + debug port,
    // without disturbing the user's everyday Chrome.
    std::process::Command::new("open")
        .args([
            "-na",
            "Google Chrome",
            "--args",
            &format!("--remote-debugging-port={CHROME_DEBUG_PORT}"),
            &format!("--user-data-dir={}", profile.display()),
            "--no-first-run",
            "--no-default-browser-check",
            "about:blank",
        ])
        .spawn()?;
    // Poll for the endpoint (cold Chrome start is ~1–2s).
    for _ in 0..24 {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        if chrome_cdp_alive().await {
            return Ok(());
        }
    }
    anyhow::bail!(
        "launched Chrome but it never exposed a CDP endpoint on :{CHROME_DEBUG_PORT} \
         — is Google Chrome installed? Try quitting all Chrome windows and retrying."
    )
}

#[tauri::command]
pub async fn get_agent_settings(state: State<'_, AppState>) -> Result<AgentSettings, String> {
    Ok(load_settings(&state.store))
}

#[tauri::command]
pub async fn set_agent_settings(
    state: State<'_, AppState>,
    settings: AgentSettings,
) -> Result<(), String> {
    save_settings(&state.store, &settings).map_err(|e| e.to_string())?;
    // Publish the env flag + refresh the GLOBAL mcp.json template so plugin MCP
    // servers are added/removed for the next conversation's freeze.
    // No pi recycle: like skills/connectors, the browser/computer capability is
    // snapshotted per conversation (see `AppState::conv_agent_env`), so a toggle
    // only reaches conversations created afterward and never disturbs an open chat.
    export_enabled(&state.store);
    crate::mcp::export_config(&state.app_data_dir, &state.store);
    // Warm up the managed Chrome now so the first browser action isn't blocked on
    // a cold launch. Fire-and-forget; idempotent.
    if settings.browser {
        tauri::async_runtime::spawn(async {
            if let Err(e) = ensure_chrome_running().await {
                tracing::warn!("chrome-devtools: warm-up launch failed: {e}");
            }
        });
    }
    Ok(())
}

/// Emergency stop: flag the conversation so the native act path bails, and abort
/// the model turn so the agentic loop stops issuing tool calls. Wired to the
/// "Stop" button in the agent-control card.
#[tauri::command]
pub async fn agent_stop(state: State<'_, AppState>, conv_id: String) -> Result<(), String> {
    state.cua.request_stop(&conv_id);
    if let Some(pi) = state.pi_existing(&conv_id).await {
        let _ = pi.abort().await;
    }
    Ok(())
}

// =============================================================================
// Host-tunnel handler
// =============================================================================

/// Clone-friendly bundle the app-event listener captures so it can answer
/// `AgentControlRequest`s without holding a borrow on managed state. Mirrors the
/// role of `run_engine::RunCtx` for the Ultra path.
#[derive(Clone)]
pub struct AgentCtx {
    /// The shared pi pool (same `Arc` as `AppState.pis`), used to reply to the
    /// requesting conversation's pi.
    pub pool: Arc<Mutex<HashMap<String, Arc<PiRpc>>>>,
    pub handle: AppHandle,
    pub app_data_dir: PathBuf,
    pub cua: CuaRuntime,
}

/// Cheap pre-filter + dispatch for the app-event listener. No-op unless `payload`
/// is an [`AppEvent::AgentControlRequest`]. Safe to call on every event.
pub fn maybe_handle_control_request(ctx: &AgentCtx, payload: &str) {
    if !payload.contains("agent_control_request") {
        return;
    }
    let v: Value = match serde_json::from_str(payload) {
        Ok(v) => v,
        Err(_) => return,
    };
    if v.get("type").and_then(|t| t.as_str()) != Some("agent_control_request") {
        return;
    }
    let (Some(conv), Some(req), Some(kind)) = (
        v.get("conversationId")
            .and_then(|x| x.as_str())
            .map(String::from),
        v.get("requestId")
            .and_then(|x| x.as_str())
            .map(String::from),
        v.get("kind").and_then(|x| x.as_str()).map(String::from),
    ) else {
        return;
    };
    let params = v.get("params").cloned().unwrap_or(Value::Null);
    let ctx = ctx.clone();
    tauri::async_runtime::spawn(async move {
        handle(ctx, conv, req, kind, params).await;
    });
}

async fn handle(ctx: AgentCtx, conv: String, req: String, kind: String, params: Value) {
    let reply: Value = match kind.as_str() {
        "step" => {
            emit_step(&ctx, &conv, &params);
            json!({"ok": true})
        }
        "cua" => run_cua(&ctx, &conv, params).await,
        "browser" => run_browser_request(&ctx, &conv, params),
        _ => json!({"ok": false, "error": "unknown agent-control kind"}),
    };
    // `ctx.ui.input` resolves to the `value` STRING of the response; the shared
    // host-tunnel reply stringifies `reply` into it (the extension parses it back).
    crate::host_tunnel::reply_to_pi(&ctx.pool, &conv, &req, reply, "agent-control").await;
}

/// Re-emit a live "watch" step to the frontend agent-control card.
fn emit_step(ctx: &AgentCtx, conv: &str, p: &Value) {
    let _ = ctx.handle.emit(
        "app-event",
        AppEvent::AgentStep {
            conversation_id: conv.to_string(),
            surface: p
                .get("surface")
                .and_then(|x| x.as_str())
                .unwrap_or("browser")
                .to_string(),
            action: p
                .get("action")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            highlighted_index: p
                .get("highlightedIndex")
                .and_then(|x| x.as_u64())
                .map(|n| n as u32),
            screenshot_jpeg: p
                .get("screenshotJpeg")
                .and_then(|x| x.as_str())
                .map(String::from),
        },
    );
}

fn run_browser_request(ctx: &AgentCtx, conv: &str, params: Value) -> Value {
    let op = params
        .get("op")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    match op.as_str() {
        "open" => {
            let Some(url) = params.get("url").and_then(|x| x.as_str()) else {
                return json!({"ok": false, "error": "missing url"});
            };
            let payload = json!({
                "conversationId": conv,
                "op": "open",
                "url": url
            });
            match ctx
                .handle
                .emit_to("main", "browser-control-request", payload)
            {
                Ok(()) => json!({"ok": true, "result": "requested visible Browser open"}),
                Err(e) => json!({"ok": false, "error": e.to_string()}),
            }
        }
        _ => json!({"ok": false, "error": "unknown browser request op"}),
    }
}

/// Run a native accessibility call (`dump` / `act` / `verify` / `ping`).
async fn run_cua(ctx: &AgentCtx, conv: &str, params: Value) -> Value {
    let op = params
        .get("op")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();

    // Emergency stop is consumed here: refuse an act if the user hit Stop.
    if op == "act" && ctx.cua.take_stop(conv) {
        return json!({"ok": false, "error": "stopped by user"});
    }

    let cua = ctx.cua.clone();
    let app_data = ctx.app_data_dir.clone();
    let p = params.clone();
    let mut reply = tokio::task::spawn_blocking(move || cua.request_blocking(&app_data, &p))
        .await
        .unwrap_or_else(|e| json!({"ok": false, "error": format!("cua task join: {e}")}));

    // AX-blind apps (Chrome / Electron / canvas) ask for an OCR fallback: surface
    // the on-screen text so the model has *some* observation. There are no
    // indexed elements in this path — the model should switch to the browser
    // tools or ask the user; clicking would need a coordinate `move_click`.
    if reply.get("fallback").and_then(|x| x.as_str()) == Some("ocr") {
        let app_data = ctx.app_data_dir.clone();
        if let Ok(Some(text)) = tokio::task::spawn_blocking(move || ocr_screen(&app_data)).await {
            reply["ocrText"] = json!(text);
        }
    }

    // For a dump with includeScreenshot, attach a screenshot to the tool result
    // so the model can inspect pixels when AX/OCR is not enough. This is opt-in:
    // screenshots can contain sensitive information, and the AX list is usually
    // more precise for routine GUI work.
    if op == "dump"
        && params.get("includeScreenshot").and_then(|x| x.as_bool()) == Some(true)
        && reply.get("ok").and_then(|x| x.as_bool()) == Some(true)
    {
        let shot = tokio::task::spawn_blocking(crate::quick::capture_screenshot)
            .await
            .ok()
            .flatten();
        if let Some(shot) = shot {
            reply["screenshotJpeg"] = json!(shot.data);
        } else {
            reply["screenshotError"] = json!("no screenshot — grant Screen Recording permission");
        }
    }

    // For a successful act, attach a fresh screenshot to the live view.
    if op == "act" && reply.get("ok").and_then(|x| x.as_bool()) == Some(true) {
        let action = reply
            .get("result")
            .and_then(|x| x.as_str())
            .unwrap_or("acted")
            .to_string();
        let shot = tokio::task::spawn_blocking(crate::quick::capture_screenshot)
            .await
            .ok()
            .flatten();
        let _ = ctx.handle.emit(
            "app-event",
            AppEvent::AgentStep {
                conversation_id: conv.to_string(),
                surface: "computer".to_string(),
                action,
                highlighted_index: None,
                screenshot_jpeg: shot.map(|s| s.data),
            },
        );
    }

    reply
}

/// Capture the screen and OCR it to plain text (AX-blind fallback). Best-effort.
fn ocr_screen(app_data: &PathBuf) -> Option<String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let shot = crate::quick::capture_screenshot()?;
    let bytes = STANDARD.decode(shot.data.as_bytes()).ok()?;
    let tmp = std::env::temp_dir().join(format!("cetus-cua-ocr-{}.jpg", crate::store::now_ms()));
    std::fs::write(&tmp, &bytes).ok()?;
    let text = crate::ocr::recognize(app_data, &tmp);
    let _ = std::fs::remove_file(&tmp);
    text.filter(|t| !t.is_empty())
}
