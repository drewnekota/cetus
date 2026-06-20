//! Host-tunnel handler backing the `automation-tools` pi extension: it lets the
//! agent create / list / update scheduled automations from inside a normal
//! conversation ("every weekday at 9am summarize my unread mail"), instead of the
//! user filling the Automations dialog by hand.
//!
//! The extension tunnels a request through a sentinel `ctx.ui.input`
//! ([`crate::pi_rpc::AUTOMATION_TOOL_TITLE`]); `dispatch_line` surfaces it as
//! [`AppEvent::AutomationToolRequest`]; we answer here and reply via the parent
//! pi's `extension_ui_response` — the same round-trip the agent-control and Ultra
//! paths use.
//!
//! ## Enabling
//!
//! The agent may arm automations directly: **create** defaults to `enabled =
//! true` (pass `enabled: false` for a draft) and **update** can flip the flag.
//! `next_run_at` is (re)computed from the schedule whenever an automation is
//! enabled, and cleared when it's disabled. There is still no delete tool.

use crate::automation::{Automation, AutomationSchedule};
use crate::host_tunnel::{self, str_field};
use crate::model::{ModelChoice, ReasoningLevel};
use crate::pi_rpc::{AppEvent, PiRpc};
use crate::store::{now_ms, Store};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use uuid::Uuid;

/// Clone-friendly bundle the app-event listener captures so it can service
/// automation-tool requests without borrowing managed state. Mirrors
/// [`crate::agent::AgentCtx`].
#[derive(Clone)]
pub struct AutomationToolCtx {
    pub store: Arc<Store>,
    /// Shared pi pool (same `Arc` as `AppState.pis`), used to reply to the
    /// requesting conversation's pi.
    pub pool: Arc<Mutex<HashMap<String, Arc<PiRpc>>>>,
    pub handle: AppHandle,
    /// Fallback cwd when the agent doesn't pin a workspace.
    pub default_workspace: PathBuf,
}

/// Cheap pre-filter + dispatch for the app-event listener. No-op unless `payload`
/// is an [`AppEvent::AutomationToolRequest`]. Safe to call on every event.
pub fn maybe_handle_automation_request(ctx: &AutomationToolCtx, payload: &str) {
    if !payload.contains("automation_tool_request") {
        return;
    }
    let v: Value = match serde_json::from_str(payload) {
        Ok(v) => v,
        Err(_) => return,
    };
    if v.get("type").and_then(|t| t.as_str()) != Some("automation_tool_request") {
        return;
    }
    let (Some(conv), Some(req)) = (
        v.get("conversationId")
            .and_then(|x| x.as_str())
            .map(String::from),
        v.get("requestId")
            .and_then(|x| x.as_str())
            .map(String::from),
    ) else {
        return;
    };
    let params = v.get("params").cloned().unwrap_or(Value::Null);
    let ctx = ctx.clone();
    tauri::async_runtime::spawn(async move {
        let reply = handle(&ctx, params);
        host_tunnel::reply_to_pi(&ctx.pool, &conv, &req, reply, "automation-tool").await;
    });
}

/// Run one create/list/update op against the store and produce the JSON the
/// extension parses back. Never panics: every failure becomes `{ ok: false, error }`.
fn handle(ctx: &AutomationToolCtx, params: Value) -> Value {
    let op = params.get("op").and_then(|x| x.as_str()).unwrap_or("");
    match op {
        "list" => op_list(ctx),
        "create" => op_create(ctx, &params),
        "update" => op_update(ctx, &params),
        other => json!({ "ok": false, "error": format!("unknown op '{other}'") }),
    }
}

fn op_list(ctx: &AutomationToolCtx) -> Value {
    match ctx.store.list_automations() {
        Ok(list) => json!({
            "ok": true,
            "automations": list.iter().map(summarize).collect::<Vec<_>>(),
        }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

fn op_create(ctx: &AutomationToolCtx, p: &Value) -> Value {
    let name = match str_field(p, "name") {
        Some(s) => s,
        None => return json!({ "ok": false, "error": "missing 'name'" }),
    };
    let prompt = match str_field(p, "prompt") {
        Some(s) => s,
        None => return json!({ "ok": false, "error": "missing 'prompt'" }),
    };
    let schedule = match build_schedule(p) {
        Ok(s) => s,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    if let Err(e) = schedule.validate() {
        return json!({ "ok": false, "error": format!("invalid schedule: {e}") });
    }
    let workspace = str_field(p, "workspaceDir")
        .unwrap_or_else(|| ctx.default_workspace.to_string_lossy().to_string());
    let now = now_ms();
    // The agent arms automations directly now. Default to enabled; honor an
    // explicit `enabled: false` for a draft the user reviews first.
    let enabled = p.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
    let next_run_at = if enabled {
        schedule.initial_next_run(now)
    } else {
        None
    };
    let automation = Automation {
        id: Uuid::new_v4().to_string(),
        name,
        prompt,
        workspace_dir: workspace,
        model: build_model(p),
        schedule,
        enabled,
        created_at: now,
        updated_at: now,
        next_run_at,
        last_run_at: None,
        last_conversation_id: None,
        last_status: None,
        last_error: None,
        run_count: 0,
    };
    if let Err(e) = ctx.store.insert_automation(&automation) {
        return json!({ "ok": false, "error": e.to_string() });
    }
    // Refresh any open Automations view (same event the scheduler uses).
    let _ = ctx.handle.emit(
        "app-event",
        AppEvent::AutomationUpdated {
            automation: automation.clone(),
        },
    );
    let note = if enabled {
        "Saved and ENABLED — it will run on its schedule. Tell the user it's active; \
they can review or pause it in Automations (⌘3)."
    } else {
        "Saved as a DISABLED draft — it won't run until enabled. Tell the user where to \
find it (Automations, ⌘3)."
    };
    json!({
        "ok": true,
        "automation": summarize(&automation),
        "note": note,
    })
}

fn op_update(ctx: &AutomationToolCtx, p: &Value) -> Value {
    let id = match str_field(p, "id") {
        Some(s) => s,
        None => return json!({ "ok": false, "error": "missing 'id'" }),
    };
    let existing = match ctx.store.get_automation(&id) {
        Ok(Some(a)) => a,
        Ok(None) => return json!({ "ok": false, "error": "automation not found" }),
        Err(e) => return json!({ "ok": false, "error": e.to_string() }),
    };
    // Each field is optional — only override what the agent supplied.
    let name = str_field(p, "name").unwrap_or(existing.name);
    let prompt = str_field(p, "prompt").unwrap_or(existing.prompt);
    let workspace = str_field(p, "workspaceDir").unwrap_or(existing.workspace_dir);
    let model = if p.get("model").is_some() || p.get("reasoning").is_some() {
        build_model(p)
    } else {
        existing.model
    };
    // A schedule is only rebuilt when the agent named a kind; otherwise keep the
    // stored one verbatim.
    let schedule = if p.get("scheduleKind").is_some() {
        match build_schedule(p) {
            Ok(s) => s,
            Err(e) => return json!({ "ok": false, "error": e }),
        }
    } else {
        existing.schedule
    };
    if let Err(e) = schedule.validate() {
        return json!({ "ok": false, "error": format!("invalid schedule: {e}") });
    }
    let now = now_ms();
    // The agent may flip `enabled` now; carry the existing flag forward when it
    // doesn't. Recompute next_run when the (possibly new) state is enabled.
    let enabled = p
        .get("enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(existing.enabled);
    let next_run = if enabled {
        schedule.initial_next_run(now)
    } else {
        None
    };
    let updated = Automation {
        id: existing.id,
        name,
        prompt,
        workspace_dir: workspace,
        model,
        schedule,
        enabled,
        created_at: existing.created_at,
        updated_at: now,
        next_run_at: next_run,
        last_run_at: existing.last_run_at,
        last_conversation_id: existing.last_conversation_id,
        last_status: existing.last_status,
        last_error: existing.last_error,
        run_count: existing.run_count,
    };
    if let Err(e) = ctx.store.update_automation(&updated) {
        return json!({ "ok": false, "error": e.to_string() });
    }
    let _ = ctx.handle.emit(
        "app-event",
        AppEvent::AutomationUpdated {
            automation: updated.clone(),
        },
    );
    json!({ "ok": true, "automation": summarize(&updated) })
}

/// A compact, model-friendly view of an automation (no internal run bookkeeping).
fn summarize(a: &Automation) -> Value {
    json!({
        "id": a.id,
        "name": a.name,
        "prompt": a.prompt,
        "schedule": describe_schedule(&a.schedule),
        "enabled": a.enabled,
        "workspaceDir": a.workspace_dir,
        "nextRunAt": a.next_run_at,
    })
}

fn describe_schedule(s: &AutomationSchedule) -> String {
    match s {
        AutomationSchedule::Once { at_ms } => format!("once at epoch-ms {at_ms}"),
        AutomationSchedule::Interval { every_minutes } => format!("every {every_minutes} min"),
        AutomationSchedule::Daily { time, weekdays } => {
            if weekdays.is_empty() {
                format!("daily at {time}")
            } else {
                format!("at {time} on weekdays {weekdays:?} (0=Sun)")
            }
        }
        AutomationSchedule::Cron { expr } => format!("cron '{expr}'"),
    }
}

// ---- request → domain mapping ---------------------------------------------

/// Build a [`ModelChoice`] from an optional `reasoning`
/// ("non_think"|"think_high"|"think_max") field, defaulting to the Pro default.
/// A legacy `model` field is accepted but ignored — cetus ships only DeepSeek V4
/// Pro now.
fn build_model(p: &Value) -> ModelChoice {
    let mut m = ModelChoice::default();
    if let Some(r) = p.get("reasoning").and_then(|v| v.as_str()) {
        if let Some(level) = ReasoningLevel::parse(r) {
            m.reasoning = level;
        }
    }
    m
}

/// Translate the extension's friendly schedule fields into an
/// [`AutomationSchedule`]. The agent supplies `scheduleKind` plus the fields that
/// kind needs; we avoid making it compute epoch-ms or the tagged-union shape.
fn build_schedule(p: &Value) -> Result<AutomationSchedule, String> {
    let kind = p
        .get("scheduleKind")
        .and_then(|v| v.as_str())
        .ok_or("missing 'scheduleKind' (one of: daily, interval, cron, once)")?;
    match kind {
        "daily" => {
            let time = str_field(p, "time").ok_or("'daily' needs 'time' as HH:MM (24h, local)")?;
            let weekdays = p
                .get("weekdays")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_u64().map(|n| n as u32))
                        .collect()
                })
                .unwrap_or_default();
            Ok(AutomationSchedule::Daily { time, weekdays })
        }
        "interval" => {
            let every = p
                .get("everyMinutes")
                .and_then(|v| v.as_i64())
                .ok_or("'interval' needs 'everyMinutes' (integer ≥ 1)")?;
            Ok(AutomationSchedule::Interval {
                every_minutes: every,
            })
        }
        "cron" => {
            let expr = str_field(p, "cron")
                .ok_or("'cron' needs 'cron' as a standard 5-field expression")?;
            Ok(AutomationSchedule::Cron { expr })
        }
        "once" => {
            let at_ms = parse_once_at(p)?;
            Ok(AutomationSchedule::Once { at_ms })
        }
        other => Err(format!("unknown scheduleKind '{other}'")),
    }
}

/// Resolve the `once` instant: accept either `atMs` (epoch-ms) or `at` as a local
/// "YYYY-MM-DD HH:MM" / RFC3339 string.
fn parse_once_at(p: &Value) -> Result<i64, String> {
    if let Some(ms) = p.get("atMs").and_then(|v| v.as_i64()) {
        return Ok(ms);
    }
    let at = str_field(p, "at")
        .ok_or("'once' needs 'at' (local 'YYYY-MM-DD HH:MM') or 'atMs' (epoch-ms)")?;
    use chrono::{Local, NaiveDateTime, TimeZone};
    // Try a few human formats, all interpreted in local time.
    let naive = NaiveDateTime::parse_from_str(&at, "%Y-%m-%d %H:%M")
        .or_else(|_| NaiveDateTime::parse_from_str(&at, "%Y-%m-%dT%H:%M"))
        .or_else(|_| NaiveDateTime::parse_from_str(&at, "%Y-%m-%d %H:%M:%S"))
        .map_err(|_| format!("could not parse 'at' = '{at}'; use 'YYYY-MM-DD HH:MM'"))?;
    match Local.from_local_datetime(&naive) {
        chrono::LocalResult::Single(dt) | chrono::LocalResult::Ambiguous(dt, _) => {
            Ok(dt.timestamp_millis())
        }
        chrono::LocalResult::None => Err(format!("'{at}' falls in a DST gap; pick another time")),
    }
}
