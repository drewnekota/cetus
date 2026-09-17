//! App-side plumbing for CLI-agent and native ACP backends: the persisted
//! settings blob, per-turn image attachments, and small transcript helpers.
//! The process orchestration itself lives in
//! [`cetus_bridge::cli_agent`]; the command wiring in [`crate::commands`].

mod history;
#[cfg(test)]
mod tests;
pub(crate) use history::*;
mod turns;
pub(crate) use turns::*;
mod catalog;
pub(crate) use catalog::*;

use crate::store::{now_ms, Conversation, Store};
use crate::AppState;
use anyhow::Context;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::BufReader;
use tokio::process::Command as TokioCommand;

/// Persisted switches, one JSON blob in `app_settings` (mirrors AgentSettings).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CliAgentSettings {
    /// Pass the CLIs' skip-approvals flags (`--dangerously-skip-permissions` /
    /// `--dangerously-bypass-approvals-and-sandbox`). Defaults ON: a headless
    /// turn has no way to answer an interactive prompt, so without it claude
    /// silently denies every command execution. The settings page exposes the
    /// switch for users who prefer the CLIs' own sandboxed modes.
    pub bypass_approvals: bool,
    /// Run each conversation in its own git worktree/branch (the
    /// Superset/Conductor pattern) instead of the workspace's working tree.
    /// Defaults OFF: most users expect the agent to edit the checkout they're
    /// looking at, like running the CLI in a terminal. A conversation that
    /// already has a worktree keeps it regardless — switching cwd mid-
    /// conversation would break the CLIs' session resume.
    pub isolate_in_worktree: bool,
    /// Expose the built-in ACP runtime descriptors in runtime pickers.
    pub claude_code_enabled: bool,
    pub codex_enabled: bool,
    pub opencode_enabled: bool,
    pub grok_enabled: bool,
    pub kimi_enabled: bool,
    pub dsh_enabled: bool,
    /// Picker order over runtime ids and preset ids, interleaved. Unknown ids
    /// are discarded; runtimes and presets missing from the list are appended.
    pub runtime_order: Vec<String>,
    /// User-defined runtime presets: a runtime pinned to one model/effort
    /// combination. Selecting a preset never mutates it.
    pub runtime_presets: Vec<RuntimePreset>,
}

/// One saved runtime + model/effort combination, shown alongside plain
/// runtimes in pickers. `id` is an opaque unique key referenced from
/// `runtime_order`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RuntimePreset {
    pub id: String,
    pub backend: String,
    pub model: String,
    pub effort: String,
}

impl Default for CliAgentSettings {
    fn default() -> Self {
        Self {
            bypass_approvals: true,
            isolate_in_worktree: false,
            claude_code_enabled: true,
            codex_enabled: true,
            opencode_enabled: true,
            grok_enabled: true,
            kimi_enabled: true,
            dsh_enabled: true,
            runtime_order: vec![
                "pi".into(),
                "claude-code".into(),
                "codex".into(),
                "opencode".into(),
                "grok".into(),
                "kimi".into(),
                "dsh".into(),
            ],
            runtime_presets: Vec::new(),
        }
    }
}

const SETTINGS_KEY: &str = "cli_agents";
const RUNTIME_IDS: [&str; 7] = [
    "pi",
    "claude-code",
    "codex",
    "opencode",
    "grok",
    "kimi",
    "dsh",
];

pub fn load_settings(store: &Store) -> CliAgentSettings {
    let mut settings = store
        .get_setting(SETTINGS_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    normalize_runtime_order(&mut settings);
    settings
}

fn normalize_runtime_order(settings: &mut CliAgentSettings) {
    // Presets must reference a real (non-pi) runtime and carry a usable id;
    // anything else is dropped before the order references it.
    settings.runtime_presets.retain(|preset| {
        !preset.id.is_empty()
            && preset.backend != "pi"
            && RUNTIME_IDS.contains(&preset.backend.as_str())
    });
    let preset_ids: Vec<&str> = settings
        .runtime_presets
        .iter()
        .map(|preset| preset.id.as_str())
        .collect();
    let mut normalized = Vec::with_capacity(RUNTIME_IDS.len() + preset_ids.len());
    for id in settings
        .runtime_order
        .iter()
        .map(String::as_str)
        .chain(RUNTIME_IDS)
        .chain(preset_ids.iter().copied())
    {
        if (RUNTIME_IDS.contains(&id) || preset_ids.contains(&id))
            && !normalized.iter().any(|saved| saved == id)
        {
            normalized.push(id.to_string());
        }
    }
    settings.runtime_order = normalized;
}

pub(crate) fn save_settings(store: &Store, s: &CliAgentSettings) -> anyhow::Result<()> {
    store.set_setting(SETTINGS_KEY, &serde_json::to_string(s)?)?;
    Ok(())
}

#[tauri::command]
pub async fn get_cli_agent_settings(
    state: State<'_, AppState>,
) -> Result<CliAgentSettings, String> {
    Ok(load_settings(&state.store))
}

#[tauri::command]
pub async fn set_cli_agent_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    mut settings: CliAgentSettings,
) -> Result<(), String> {
    normalize_runtime_order(&mut settings);
    save_settings(&state.store, &settings).map_err(|e| e.to_string())?;
    app.emit("cli-agent-settings-changed", &settings)
        .map_err(|e| e.to_string())
}

/// Answer a claude `control_request` (permission prompt / AskUserQuestion)
/// surfaced in the chat as a `cli_control_request` event. `response` is the
/// inner permission result — `{"behavior":"allow","updatedInput":{...}}` or
/// `{"behavior":"deny","message":"..."}` — written to the running turn's stdin.
///
/// A control request can arrive with NO turn registered: a Monitor/subagent
/// completion wakes the CLI into a self-started continuation turn, and from
/// Cetus's perspective the previous turn already settled. The persistent
/// session child is still alive and reading stdin, so fall back to writing
/// the response there — otherwise the answer is lost and the CLI blocks on
/// the unanswered request forever.
#[tauri::command]
pub async fn cli_control_respond(
    state: State<'_, AppState>,
    id: String,
    request_id: Value,
    response: Value,
    source: Option<String>,
    install_plugin_id: Option<String>,
) -> Result<(), String> {
    // "dsh" is the pre-0.1.2 bridge's source tag; dsh now answers through the
    // generic ACP path like every other ACP runtime.
    if matches!(source.as_deref(), Some("acp") | Some("dsh")) {
        let allow = response
            .get("behavior")
            .and_then(Value::as_str)
            .is_some_and(|behavior| behavior == "allow")
            || response
                .get("action")
                .and_then(Value::as_str)
                .is_some_and(|action| action == "accept");
        return state
            .acp_session(&id)
            .ok_or_else(|| "ACP session is no longer running".to_string())?
            .respond_permission(request_id, allow)
            .map_err(|error| error.to_string());
    }
    if source.as_deref() == Some("codex") {
        let session = state
            .codex_session(&id)
            .ok_or_else(|| "Codex app-server session is no longer running".to_string())?;
        if let Some(plugin_id) = install_plugin_id {
            let (plugin_name, marketplace_name) = plugin_id
                .rsplit_once('@')
                .filter(|(plugin, marketplace)| !plugin.is_empty() && !marketplace.is_empty())
                .ok_or_else(|| format!("invalid Codex plugin id: {plugin_id}"))?;
            return session
                .install_plugin_and_respond(
                    request_id,
                    response,
                    plugin_name.to_string(),
                    marketplace_name.to_string(),
                )
                .await
                .map_err(|e| e.to_string());
        }
        return session
            .respond_to_server_request(request_id, response)
            .map_err(|e| e.to_string());
    }

    let request_id = request_id
        .as_str()
        .ok_or_else(|| "Claude control request id must be a string".to_string())?;
    let line = cetus_bridge::cli_agent::claude_control_response_line(request_id, &response);
    let turn_err = match state.cli_send_input(&id, line.clone()) {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    match state.claude_session(&id) {
        Some(session) => session.input(line).map_err(|e| e.to_string()),
        None => Err(turn_err),
    }
}
