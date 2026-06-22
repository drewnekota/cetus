//! Host-tunnel handler backing the `mcp-tools` pi extension: it lets the agent
//! create, list, update, enable/disable, and delete the user's MCP servers from
//! inside a normal conversation. The settings UI and this handler both call the
//! same functions in `mcp.rs`, so changes write the source store, export
//! `mcp.json`, and show up in Settings → MCP.

use crate::app_event::AppEvent;
use crate::host_tunnel::{self, str_field};
use crate::mcp::{self, McpConnector, McpConnectorInput};
use crate::pi_rpc::PiRpc;
use crate::store::Store;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct McpToolCtx {
    pub store: Arc<Store>,
    pub pool: Arc<Mutex<HashMap<String, Arc<PiRpc>>>>,
    pub handle: AppHandle,
    pub app_data_dir: PathBuf,
}

pub fn maybe_handle_mcp_request(ctx: &McpToolCtx, payload: &str) {
    if !payload.contains("mcp_tool_request") {
        return;
    }
    let v: Value = match serde_json::from_str(payload) {
        Ok(v) => v,
        Err(_) => return,
    };
    if v.get("type").and_then(|t| t.as_str()) != Some("mcp_tool_request") {
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
            let _ = ctx.handle.emit("app-event", AppEvent::McpUpdated);
        }
        host_tunnel::reply_to_pi(&ctx.pool, &conv, &req, reply, "mcp-tool").await;
    });
}

fn handle(ctx: &McpToolCtx, params: Value) -> (Value, bool) {
    match params.get("op").and_then(|x| x.as_str()).unwrap_or("") {
        "list" => (op_list(ctx), false),
        "create" => op_create(ctx, &params),
        "update" => op_update(ctx, &params),
        "set_enabled" => op_set_enabled(ctx, &params),
        "delete" => op_delete(ctx, &params),
        other => (
            json!({ "ok": false, "error": format!("unknown op '{other}'") }),
            false,
        ),
    }
}

fn op_list(ctx: &McpToolCtx) -> Value {
    json!({
        "ok": true,
        "mcpServers": mcp::agent_list(&ctx.store).iter().map(summarize).collect::<Vec<_>>(),
    })
}

fn op_create(ctx: &McpToolCtx, p: &Value) -> (Value, bool) {
    let input = match input_from_value(p, None) {
        Ok(input) => input,
        Err(e) => return (json!({ "ok": false, "error": e }), false),
    };
    match mcp::agent_add(&ctx.app_data_dir, &ctx.store, input) {
        Ok(server) => (
            json!({
                "ok": true,
                "mcpServer": summarize(&server),
                "note": "Saved and ENABLED in Settings → MCP. It is exported to mcp.json now; existing conversations keep their frozen MCP set, so use a new conversation for the newly added tools.",
            }),
            true,
        ),
        Err(e) => (json!({ "ok": false, "error": e }), false),
    }
}

fn op_update(ctx: &McpToolCtx, p: &Value) -> (Value, bool) {
    let Some(id) = str_field(p, "id") else {
        return (
            json!({ "ok": false, "error": "update needs 'id' (from op 'list')" }),
            false,
        );
    };
    let existing = match mcp::agent_list(&ctx.store).into_iter().find(|c| c.id == id) {
        Some(c) => c,
        None => {
            return (
                json!({ "ok": false, "error": "MCP server not found" }),
                false,
            )
        }
    };
    let input = match input_from_value(p, Some(&existing)) {
        Ok(input) => input,
        Err(e) => return (json!({ "ok": false, "error": e }), false),
    };
    match mcp::agent_update(&ctx.app_data_dir, &ctx.store, &id, input) {
        Ok(server) => (json!({ "ok": true, "mcpServer": summarize(&server) }), true),
        Err(e) => (json!({ "ok": false, "error": e }), false),
    }
}

fn op_set_enabled(ctx: &McpToolCtx, p: &Value) -> (Value, bool) {
    let Some(id) = str_field(p, "id") else {
        return (
            json!({ "ok": false, "error": "set_enabled needs 'id' (from op 'list')" }),
            false,
        );
    };
    let Some(enabled) = p.get("enabled").and_then(|v| v.as_bool()) else {
        return (
            json!({ "ok": false, "error": "set_enabled needs boolean 'enabled'" }),
            false,
        );
    };
    match mcp::agent_set_enabled(&ctx.app_data_dir, &ctx.store, &id, enabled) {
        Ok(server) => (json!({ "ok": true, "mcpServer": summarize(&server) }), true),
        Err(e) => (json!({ "ok": false, "error": e }), false),
    }
}

fn op_delete(ctx: &McpToolCtx, p: &Value) -> (Value, bool) {
    let Some(id) = str_field(p, "id") else {
        return (
            json!({ "ok": false, "error": "delete needs 'id' (from op 'list')" }),
            false,
        );
    };
    match mcp::agent_remove(&ctx.app_data_dir, &ctx.store, &id) {
        Ok(true) => (json!({ "ok": true, "deleted": id }), true),
        Ok(false) => (
            json!({ "ok": false, "error": "MCP server not found" }),
            false,
        ),
        Err(e) => (json!({ "ok": false, "error": e }), false),
    }
}

fn input_from_value(
    p: &Value,
    existing: Option<&McpConnector>,
) -> Result<McpConnectorInput, String> {
    let transport = str_field(p, "transport")
        .or_else(|| existing.map(|c| c.transport.clone()))
        .unwrap_or_else(|| "stdio".to_string());
    Ok(McpConnectorInput {
        name: str_field(p, "name")
            .or_else(|| existing.map(|c| c.name.clone()))
            .ok_or_else(|| "missing 'name'".to_string())?,
        transport,
        command: str_field(p, "command")
            .or_else(|| existing.map(|c| c.command.clone()))
            .unwrap_or_default(),
        args: string_array_field(p, "args")
            .or_else(|| existing.map(|c| c.args.clone()))
            .unwrap_or_default(),
        env: string_map_field(p, "env")
            .or_else(|| existing.map(|c| c.env.clone()))
            .unwrap_or_default(),
        url: str_field(p, "url")
            .or_else(|| existing.map(|c| c.url.clone()))
            .unwrap_or_default(),
        headers: string_map_field(p, "headers")
            .or_else(|| existing.map(|c| c.headers.clone()))
            .unwrap_or_default(),
        auth: str_field(p, "auth")
            .or_else(|| existing.map(|c| c.auth.clone()))
            .unwrap_or_default(),
        oauth_client_id: str_field(p, "oauthClientId")
            .or_else(|| existing.map(|c| c.oauth_client_id.clone()))
            .unwrap_or_default(),
        oauth_scope: str_field(p, "oauthScope")
            .or_else(|| existing.map(|c| c.oauth_scope.clone()))
            .unwrap_or_default(),
        enabled: p
            .get("enabled")
            .and_then(|v| v.as_bool())
            .or_else(|| existing.map(|c| c.enabled))
            .unwrap_or(true),
    })
}

fn string_array_field(p: &Value, key: &str) -> Option<Vec<String>> {
    let v = p.get(key)?;
    if let Some(s) = v.as_str() {
        return Some(
            s.lines()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect(),
        );
    }
    Some(
        v.as_array()?
            .iter()
            .filter_map(|v| v.as_str().map(str::trim))
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect(),
    )
}

fn string_map_field(p: &Value, key: &str) -> Option<BTreeMap<String, String>> {
    let obj: &Map<String, Value> = p.get(key)?.as_object()?;
    Some(
        obj.iter()
            .filter_map(|(k, v)| {
                let key = k.trim();
                if key.is_empty() {
                    None
                } else {
                    Some((key.to_string(), v.as_str().unwrap_or("").trim().to_string()))
                }
            })
            .collect(),
    )
}

fn summarize(c: &McpConnector) -> Value {
    json!({
        "id": c.id,
        "name": c.name,
        "transport": c.transport,
        "command": c.command,
        "args": c.args,
        "env": c.env,
        "url": c.url,
        "headers": c.headers,
        "auth": c.auth,
        "oauthClientId": c.oauth_client_id,
        "oauthScope": c.oauth_scope,
        "enabled": c.enabled,
        "createdAt": c.created_at,
        "updatedAt": c.updated_at,
    })
}
