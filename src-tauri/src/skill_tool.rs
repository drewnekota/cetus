//! Host-tunnel handler backing the `skill-tools` pi extension: it lets the agent
//! create / list / update / delete the user's skills from inside a normal
//! conversation ("create a skill that does X", "update the deploy skill"),
//! instead of the user writing one by hand in Settings → Skills.
//!
//! The extension tunnels a request through a sentinel `ctx.ui.input`
//! ([`crate::bridge::SKILL_TOOL_TITLE`]); `dispatch_line` surfaces it as
//! [`AppEvent::SkillToolRequest`]; we answer here, mutate the skills store via
//! [`crate::skills`], re-materialise the active set, and reply via the parent
//! pi's `extension_ui_response` — the same round-trip the automation-tools path
//! uses.
//!
//! ## Behaviour vs. the background review pass
//!
//! A skill the user explicitly asks for is created ENABLED and managed (it shows
//! in Settings → Skills with a "By agent" badge, toggleable/deletable like any
//! other). That's distinct from the background review pass ([`crate::skill_review`]),
//! which proposes DISABLED suggestions. We deliberately do NOT recycle the
//! requesting conversation's pi (that would abort its in-flight turn); skills are
//! read at session start, so a new/updated skill loads in the next conversation —
//! the reply tells the agent to say so.

use crate::app_event::AppEvent;
use crate::host_tunnel::{self, str_field};
use crate::pi_rpc::PiRpc;
use crate::skills::{self, SkillEntry};
use crate::store::Store;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

/// Clone-friendly bundle the app-event listener captures so it can service
/// skill-tool requests without borrowing managed state. Mirrors
/// [`crate::automation_tool::AutomationToolCtx`].
#[derive(Clone)]
pub struct SkillToolCtx {
    pub store: Arc<Store>,
    pub pool: Arc<Mutex<HashMap<String, Arc<PiRpc>>>>,
    pub handle: AppHandle,
    pub app_data_dir: PathBuf,
}

/// Cheap pre-filter + dispatch for the app-event listener. No-op unless `payload`
/// is an [`AppEvent::SkillToolRequest`]. Safe to call on every event.
pub fn maybe_handle_skill_request(ctx: &SkillToolCtx, payload: &str) {
    if !payload.contains("skill_tool_request") {
        return;
    }
    let v: Value = match serde_json::from_str(payload) {
        Ok(v) => v,
        Err(_) => return,
    };
    if v.get("type").and_then(|t| t.as_str()) != Some("skill_tool_request") {
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
        let (reply, changed) = handle(&ctx, params);
        if changed {
            // Re-materialise the active set so a new/updated skill loads on the
            // next session start, and refresh any open Skills settings page.
            skills::resync_active_dir(&ctx.app_data_dir, &ctx.store);
            let _ = ctx.handle.emit("app-event", AppEvent::SkillsUpdated);
        }
        host_tunnel::reply_to_pi(&ctx.pool, &conv, &req, reply, "skill-tool").await;
    });
}

/// Run one op against the skills store. Returns `(reply, store_changed)` — the
/// bool drives the resync/event emit. Never panics: failures become
/// `{ ok: false, error }`.
fn handle(ctx: &SkillToolCtx, params: Value) -> (Value, bool) {
    match params.get("op").and_then(|x| x.as_str()).unwrap_or("") {
        "list" => (op_list(ctx), false),
        "create" => op_create(ctx, &params),
        "update" => op_update(ctx, &params),
        "delete" => op_delete(ctx, &params),
        other => (
            json!({ "ok": false, "error": format!("unknown op '{other}'") }),
            false,
        ),
    }
}

fn op_list(ctx: &SkillToolCtx) -> Value {
    let state = skills::load_state(&ctx.store);
    json!({
        "ok": true,
        "masterEnabled": state.enabled,
        "skills": state.entries.iter().map(summarize).collect::<Vec<_>>(),
    })
}

fn op_create(ctx: &SkillToolCtx, p: &Value) -> (Value, bool) {
    let (Some(name), Some(body)) = (str_field(p, "name"), str_field(p, "body")) else {
        return (
            json!({ "ok": false, "error": "create needs 'name' and 'body'" }),
            false,
        );
    };
    let description = str_field(p, "description").unwrap_or_default();
    match skills::agent_create_skill(&ctx.app_data_dir, &ctx.store, &name, &description, &body) {
        Ok(e) => (
            json!({
                "ok": true,
                "skill": summarize(&e),
                "note": "Created and ENABLED. It's in Settings → Skills (tagged 'By agent'), and \
            loads automatically in your next conversation. Tell the user it's saved.",
            }),
            true,
        ),
        Err(e) => (json!({ "ok": false, "error": e }), false),
    }
}

fn op_update(ctx: &SkillToolCtx, p: &Value) -> (Value, bool) {
    let Some(id) = str_field(p, "id") else {
        return (
            json!({ "ok": false, "error": "update needs 'id' (from op 'list')" }),
            false,
        );
    };
    let name = str_field(p, "name");
    let description = str_field(p, "description");
    let body = str_field(p, "body");
    match skills::agent_update_skill(
        &ctx.app_data_dir,
        &ctx.store,
        &id,
        name.as_deref(),
        description.as_deref(),
        body.as_deref(),
    ) {
        Ok(e) => (json!({ "ok": true, "skill": summarize(&e) }), true),
        Err(e) => (json!({ "ok": false, "error": e }), false),
    }
}

fn op_delete(ctx: &SkillToolCtx, p: &Value) -> (Value, bool) {
    let Some(id) = str_field(p, "id") else {
        return (
            json!({ "ok": false, "error": "delete needs 'id' (from op 'list')" }),
            false,
        );
    };
    match skills::agent_delete_skill(&ctx.app_data_dir, &ctx.store, &id) {
        Ok(true) => (json!({ "ok": true, "deleted": id }), true),
        Ok(false) => (json!({ "ok": false, "error": "skill not found" }), false),
        Err(e) => (json!({ "ok": false, "error": e }), false),
    }
}

/// A compact, model-friendly view of a skill.
fn summarize(e: &SkillEntry) -> Value {
    json!({
        "id": e.id,
        "name": e.name,
        "description": e.description,
        "enabled": e.enabled,
        "source": e.source,
    })
}
