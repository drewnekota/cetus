//! Ultra Code mode — Claude-Code-style autonomous orchestration.
//!
//! A single persisted toggle. When on, every conversation's pi is spawned with
//! [`crate::prompts::ULTRA_SYSTEM_PROMPT`] appended, instructing the model to
//! orchestrate substantial tasks by AUTHORING a JS workflow script and calling
//! the `run_workflow` tool (see `pi-install/cetus-extensions/ultra-runtime.ts`).
//! That script runs in pi's own Bun runtime; its `agent()` primitive tunnels a
//! sub-agent request back to the host through a sentinel `ctx.ui.input`
//! (recognized in `pi_rpc::dispatch_line`, surfaced as
//! [`crate::app_event::AppEvent::UltraAgentRequest`]). This module answers that
//! request: it runs a real cetus sub-agent via [`crate::run_engine::run_agent_node`]
//! (reusing the shared pool + registry + semaphore) and replies to the waiting
//! script via the parent pi's `extension_ui_response`.

use crate::model::ModelChoice;
use crate::run_engine::{run_agent_node, RunCtx};
use crate::store::Store;
use crate::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::State;

/// Persisted master switch, one JSON blob in `app_settings`. Mirrors
/// `ParallelSettings`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UltraSettings {
    /// When on, conversations get the Ultra authoring prompt and may orchestrate.
    pub enabled: bool,
}

const SETTINGS_KEY: &str = "ultra_code";

pub fn load_settings(store: &Store) -> UltraSettings {
    store
        .get_setting(SETTINGS_KEY)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings(store: &Store, s: &UltraSettings) -> anyhow::Result<()> {
    store.set_setting(SETTINGS_KEY, &serde_json::to_string(s)?)?;
    Ok(())
}

#[tauri::command]
pub async fn get_ultra_settings(state: State<'_, AppState>) -> Result<UltraSettings, String> {
    Ok(load_settings(&state.store))
}

#[tauri::command]
pub async fn set_ultra_settings(
    state: State<'_, AppState>,
    settings: UltraSettings,
) -> Result<(), String> {
    save_settings(&state.store, &settings).map_err(|e| e.to_string())?;
    // The Ultra system prompt is applied at pi spawn time, so recycle idle pis
    // to pick up the change now (they respawn lazily, restoring their session).
    state.kill_all().await;
    Ok(())
}

// =============================================================================
// agent() round-trip
// =============================================================================

/// Cheap pre-filter + dispatch for the app-event listener. If `payload` is an
/// [`AppEvent::UltraAgentRequest`], spawn the async handler (which runs a
/// sub-agent and replies to the waiting script). Non-blocking; safe to call on
/// every event.
pub fn maybe_handle_agent_request(ctx: &RunCtx, payload: &str) {
    if !payload.contains("ultra_agent_request") {
        return;
    }
    let v: Value = match serde_json::from_str(payload) {
        Ok(v) => v,
        Err(_) => return,
    };
    if v.get("type").and_then(|t| t.as_str()) != Some("ultra_agent_request") {
        return;
    }
    let (Some(conv), Some(request_id)) = (
        v.get("conversationId")
            .and_then(|c| c.as_str())
            .map(String::from),
        v.get("requestId")
            .and_then(|r| r.as_str())
            .map(String::from),
    ) else {
        return;
    };
    let params = v.get("params").cloned().unwrap_or(Value::Null);
    let ctx = ctx.clone();
    tauri::async_runtime::spawn(async move {
        handle_agent_request(ctx, conv, request_id, params).await;
    });
}

/// Run one sub-agent for a script's `agent()` call and reply to the waiting pi.
async fn handle_agent_request(ctx: RunCtx, conv: String, request_id: String, params: Value) {
    let reply_value = match run_one(&ctx, &conv, &params).await {
        Ok(details) => json!({
            "ok": true,
            // `text` is the sub-agent's final message — the default return value.
            // `summary`/`result` are the emit_node_result fields (fallbacks / the
            // explicit structured override).
            "text": details.get("text").cloned().unwrap_or(Value::Null),
            "summary": details.get("summary").cloned().unwrap_or(Value::Null),
            "result": details.get("result").cloned().unwrap_or(Value::Null),
        }),
        Err(e) => json!({ "ok": false, "error": e }),
    };
    // `ctx.ui.input` resolves to the `value` STRING of the response, so the
    // script receives the envelope as JSON text and parses it.
    let payload = json!({
        "type": "extension_ui_response",
        "id": request_id,
        "value": reply_value.to_string(),
    });
    let pi = ctx.sched.pool.lock().await.get(&conv).cloned();
    if let Some(pi) = pi {
        if let Err(e) = pi.notify(payload).await {
            tracing::warn!("ultra: reply to {conv} failed: {e}");
        }
    } else {
        tracing::warn!("ultra: no pi for {conv} to reply to");
    }
}

async fn run_one(ctx: &RunCtx, conv: &str, params: &Value) -> Result<Value, String> {
    let prompt = params
        .get("prompt")
        .and_then(|p| p.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "agent() called without a prompt".to_string())?;
    let opts = params.get("opts");
    let label = opts
        .and_then(|o| o.get("label"))
        .and_then(|l| l.as_str())
        .unwrap_or("agent")
        .to_string();
    let subdir = opts
        .and_then(|o| o.get("subdir"))
        .and_then(|s| s.as_str())
        .map(String::from);
    // A JSON Schema the caller passed via `agent(prompt, { schema })`. When set,
    // the sub-agent is told to emit conforming JSON as its final message.
    let schema = opts
        .and_then(|o| o.get("schema"))
        .filter(|s| !s.is_null())
        .cloned();

    // Parent conversation supplies the workspace + the default model.
    let parent = ctx
        .sched
        .store
        .get(conv)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "parent conversation not found".to_string())?;
    let workspace = PathBuf::from(&parent.workspace_dir);
    // Per-agent model override, else inherit the parent's choice.
    let model: ModelChoice = opts
        .and_then(|o| o.get("model"))
        .and_then(|m| serde_json::from_value(m.clone()).ok())
        .unwrap_or(parent.model);

    run_agent_node(
        ctx,
        &workspace,
        prompt,
        &label,
        model,
        subdir.as_deref(),
        schema.as_ref(),
    )
    .await
}
