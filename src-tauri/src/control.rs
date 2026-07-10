//! Always-on control socket: a Unix-domain-socket API into the running app for
//! third-party CLI runtimes (claude-code / codex) spawned by Cetus.
//!
//! Those runtimes don't know Cetus's mechanics — asked to "change a cron job"
//! they go hunting for a `.db` file and edit it raw, which bypasses schedule
//! validation, `next_run_at` recomputation, the scheduler, and the UI. This
//! socket gives them a supported path THROUGH the running app instead: every op
//! is a thin call into `automation_api`, so all of that happens for free.
//!
//! The transport is the same newline-delimited JSON protocol as the dev-only
//! eval bridge (`devtest.rs`), but this socket is compiled into every build,
//! always on, and exposes only a safe allowlist of ops — none of devtest's
//! eval/DOM/AX surface.
//!
//! Discoverability is the other half (see `cli_backend::dispatch_turn`): child
//! CLIs get `CETUS_SOCK` in their env, the `cetus` shim dir prepended to their
//! `PATH`, and a one-line system-prompt hint that both exist.
//!
//! SECURITY: filesystem socket only (no TCP), created `0600` so only the local
//! user can connect — the same trust boundary as the sqlite file itself.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;

use crate::AppState;

/// One-liner injected into every CLI-backend turn (claude: system prompt;
/// codex: first-turn prompt preamble). Deliberately terse — it rides on every
/// session, so it only announces the door; `cetus cron help` is the real docs.
pub const AGENT_HINT: &str = "You are running inside Cetus, a desktop agent app. \
To read or change Cetus scheduled automations (cron jobs), use the bundled `cetus` CLI \
— start with `cetus cron help`. Never edit Cetus's sqlite database directly.";

/// Socket path: `$CETUS_SOCK` override, else `<app_data_dir>/cetus.sock`.
pub fn socket_path(app_data_dir: &Path) -> PathBuf {
    match std::env::var("CETUS_SOCK") {
        Ok(p) if !p.is_empty() => PathBuf::from(p),
        _ => app_data_dir.join("cetus.sock"),
    }
}

/// Directory holding the `cetus` shim, prepended to child CLIs' `PATH`.
pub fn cli_bin_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("bin")
}

/// Install `<app_data_dir>/bin/cetus`: a two-line shim that execs the running
/// app binary in CLI mode (`Cetus cli …` — see `main.rs`). A shim instead of a
/// symlink because the CLI entry is an argv branch in the main binary, and
/// rewriting it every launch keeps the exec path fresh across app updates.
pub fn install_cli_shim(app_data_dir: &Path) {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let dir = cli_bin_dir(app_data_dir);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        tracing::warn!("control: could not create {}: {e}", dir.display());
        return;
    }
    let shim = dir.join("cetus");
    let body = format!("#!/bin/sh\nexec \"{}\" cli \"$@\"\n", exe.display());
    if std::fs::read_to_string(&shim).ok().as_deref() == Some(body.as_str()) {
        return; // already current
    }
    if let Err(e) = std::fs::write(&shim, body) {
        tracing::warn!("control: could not write {}: {e}", shim.display());
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755));
    }
}

/// Bind the control socket and serve forever. Called once from app setup.
pub fn start(app: AppHandle) {
    let path = socket_path(&app.state::<AppState>().app_data_dir);
    tauri::async_runtime::spawn(async move {
        if let Some(parent) = path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        // Remove a stale socket file (previous run) before binding.
        let _ = tokio::fs::remove_file(&path).await;

        let listener = match UnixListener::bind(&path) {
            Ok(l) => l,
            Err(e) => {
                tracing::warn!("control: failed to bind {}: {e}", path.display());
                return;
            }
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        tracing::info!("control socket listening on {}", path.display());

        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(handle_conn(app, stream));
                }
                Err(e) => {
                    tracing::warn!("control: accept error: {e}");
                    break;
                }
            }
        }
    });
}

/// Per-connection loop: newline-delimited JSON request → one response per line.
async fn handle_conn(app: AppHandle, stream: tokio::net::UnixStream) {
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    let mut line = String::new();

    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break, // client disconnected
            Ok(_) => {}
            Err(_) => break,
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
        let mut bytes = serde_json::to_vec(&resp).unwrap_or_else(|_| b"{}".to_vec());
        bytes.push(b'\n');
        if write_half.write_all(&bytes).await.is_err() || write_half.flush().await.is_err() {
            break;
        }
    }
}

/// Route one request. Ops are a deliberate allowlist — everything goes through
/// `automation_api` / the scheduler, never straight to the store.
async fn dispatch(app: &AppHandle, req: &Value) -> Value {
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let op = req.get("op").and_then(|v| v.as_str()).unwrap_or("");
    let arg_id = || {
        req.get("automationId")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| "missing `automationId`".to_string())
    };
    let arg_input = || {
        req.get("input")
            .cloned()
            .ok_or_else(|| "missing `input`".to_string())
            .and_then(|v| {
                serde_json::from_value::<crate::automation::AutomationInput>(v)
                    .map_err(|e| format!("bad `input`: {e}"))
            })
    };

    let result: Result<Value, String> = match op {
        "ping" => Ok(json!({})),
        "version" => Ok(json!({ "version": app.package_info().version.to_string() })),

        "automation.list" => {
            crate::automation_api::list(&app.state::<AppState>()).and_then(to_value)
        }
        "automation.get" => arg_id()
            .and_then(|aid| crate::automation_api::get(&app.state::<AppState>(), &aid))
            .and_then(to_value),
        "automation.create" => arg_input()
            .and_then(|input| crate::automation_api::create(app, input))
            .and_then(to_value),
        "automation.update" => arg_id()
            .and_then(|aid| arg_input().map(|input| (aid, input)))
            .and_then(|(aid, input)| crate::automation_api::update(app, &aid, input))
            .and_then(to_value),
        "automation.delete" => arg_id()
            .and_then(|aid| crate::automation_api::delete(app, &aid))
            .map(|()| json!({})),
        "automation.enable" => {
            let enabled = req
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            arg_id()
                .and_then(|aid| crate::automation_api::set_enabled(app, &aid, enabled))
                .and_then(to_value)
        }
        "automation.runNow" => match arg_id() {
            Ok(aid) => {
                let ctx = app.state::<AppState>().scheduler_ctx();
                crate::scheduler::run_now(&ctx, &aid)
                    .await
                    .and_then(|conv| to_value(conv))
            }
            Err(e) => Err(e),
        },

        other => Err(format!("unknown op: {other}")),
    };

    match result {
        Ok(v) => json!({ "id": id, "ok": true, "result": v }),
        Err(e) => json!({ "id": id, "ok": false, "error": e }),
    }
}

fn to_value<T: serde::Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}
