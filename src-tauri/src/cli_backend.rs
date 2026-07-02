//! App-side plumbing for the CLI-agent backends (claude-code / codex): the
//! persisted settings blob, per-turn image attachments, and small transcript
//! helpers. The process orchestration itself lives in
//! [`cetus_bridge::cli_agent`]; the command wiring in [`crate::commands`].

use crate::store::{now_ms, Conversation, Store};
use crate::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

/// Persisted switches, one JSON blob in `app_settings` (mirrors AgentSettings).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CliAgentSettings {
    /// Pass the CLIs' skip-approvals flags (`--dangerously-skip-permissions` /
    /// `--dangerously-bypass-approvals-and-sandbox`). Defaults ON: a headless
    /// turn has no way to answer an interactive prompt, so without it claude
    /// silently denies every command execution — and turns are already isolated
    /// in per-conversation git worktrees. The settings page exposes the switch
    /// for users who prefer the CLIs' own sandboxed modes.
    pub bypass_approvals: bool,
}

impl Default for CliAgentSettings {
    fn default() -> Self {
        Self {
            bypass_approvals: true,
        }
    }
}

const SETTINGS_KEY: &str = "cli_agents";

pub fn load_settings(store: &Store) -> CliAgentSettings {
    store
        .get_setting(SETTINGS_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
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
    state: State<'_, AppState>,
    settings: CliAgentSettings,
) -> Result<(), String> {
    save_settings(&state.store, &settings).map_err(|e| e.to_string())
}

/// Answer a claude `control_request` (permission prompt / AskUserQuestion)
/// surfaced in the chat as a `cli_control_request` event. `response` is the
/// inner permission result — `{"behavior":"allow","updatedInput":{...}}` or
/// `{"behavior":"deny","message":"..."}` — written to the running turn's stdin.
#[tauri::command]
pub async fn cli_control_respond(
    state: State<'_, AppState>,
    id: String,
    request_id: String,
    response: Value,
) -> Result<(), String> {
    let line = cetus_bridge::cli_agent::claude_control_response_line(&request_id, &response);
    state.cli_send_input(&id, line)
}

/// Where a conversation's CLI-turn image attachments live on disk. The CLIs
/// read images as files (codex `-i`, claude via its Read tool), so pasted
/// base64 payloads are materialized here — outside the workspace/worktree so
/// the agent never commits them.
pub fn attachments_dir(app_data_dir: &Path, conv_id: &str) -> PathBuf {
    app_data_dir.join("cli-attachments").join(conv_id)
}

/// Persist one turn's base64 image attachments as files; returns their
/// absolute paths. Best-effort: an unwritable image is skipped.
pub fn save_turn_images(
    app_data_dir: &Path,
    conv_id: &str,
    images: &[crate::commands::ImageAttachment],
) -> Vec<String> {
    if images.is_empty() {
        return Vec::new();
    }
    let dir = attachments_dir(app_data_dir, conv_id);
    if std::fs::create_dir_all(&dir).is_err() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for img in images {
        let ext = match img.mime_type.as_str() {
            "image/png" => "png",
            "image/gif" => "gif",
            "image/webp" => "webp",
            _ => "jpg",
        };
        use base64::Engine;
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&img.data) else {
            continue;
        };
        let path = dir.join(format!("{}.{ext}", uuid::Uuid::new_v4()));
        if std::fs::write(&path, bytes).is_ok() {
            out.push(path.to_string_lossy().to_string());
        }
    }
    out
}

/// Run one turn of a CLI-backend conversation: isolate in a worktree (git
/// repos), persist the user message, spawn the vendor CLI, stream its events
/// over the `app-event` channel, and persist the outcome + resume token when it
/// finishes. Fire-and-stream: returns right after the child is dispatched.
///
/// Shared by `send_prompt` (chat) and the scheduler (automations firing on
/// claude-code / codex). The caller owns anything conversational — titling,
/// touch, run-outcome records.
pub fn dispatch_turn(
    handle: &AppHandle,
    conv: &Conversation,
    message: &str,
    images: Vec<crate::commands::ImageAttachment>,
) -> Result<(), String> {
    let backend = cetus_bridge::cli_agent::CliBackend::from_id(&conv.backend)
        .ok_or_else(|| format!("not a CLI backend: {}", conv.backend))?;
    let state = handle.state::<AppState>();
    let sink: std::sync::Arc<dyn cetus_bridge::pi_rpc::EventSink> =
        std::sync::Arc::new(crate::tauri_bridge::TauriEventSink::new(handle.clone()));

    let ws = PathBuf::from(&conv.workspace_dir);
    std::fs::create_dir_all(&ws).ok();
    // Isolate in a per-conversation worktree when the workspace is a git repo
    // (the Superset/Conductor pattern); otherwise run in the workspace itself.
    let cwd = if cetus_bridge::worktree::is_git_repo(&ws) {
        cetus_bridge::worktree::ensure_worktree(&ws, &conv.id, None).unwrap_or_else(|_| ws.clone())
    } else {
        ws.clone()
    };
    let env = crate::secrets::load_env();
    // One turn per conversation; also the abort command's kill switch and the
    // stdin channel control responses ride in on. Registered before the user
    // message persists so a rejected double-send doesn't strand a transcript
    // row that never ran.
    let (kill, input_rx) = state.begin_cli_turn(&conv.id)?;

    // Image attachments: claude takes them inline on the stdin user message
    // (native content blocks); codex ingests file paths via `-i`.
    let is_codex = backend == cetus_bridge::cli_agent::CliBackend::Codex;
    let image_paths = if is_codex {
        save_turn_images(&state.app_data_dir, &conv.id, &images)
    } else {
        Vec::new()
    };
    let image_blocks: Vec<(String, String)> = if is_codex {
        Vec::new()
    } else {
        images
            .iter()
            .map(|img| (img.mime_type.clone(), img.data.clone()))
            .collect()
    };
    let prompt = message.to_string();

    // Persist the user message first so the transcript replays after a
    // restart. `resume_before` snapshots the token this turn resumes from —
    // retry/fork restore to it to roll the turn back.
    let resume_before = conv.session_file.clone();
    let mut content = vec![serde_json::json!({ "type": "text", "text": message })];
    for img in &images {
        content.push(serde_json::json!({
            "type": "image", "data": img.data, "mimeType": img.mime_type,
        }));
    }
    state
        .store
        .append_cli_message(
            &conv.id,
            &serde_json::json!({ "role": "user", "content": content }),
            (!resume_before.is_empty()).then_some(resume_before.as_str()),
            now_ms(),
        )
        .ok();

    let opts = cetus_bridge::cli_agent::CliRunOpts {
        // Per-conversation model + effort overrides; empty → the CLI's own
        // defaults.
        model: (!conv.cli_model.trim().is_empty()).then(|| conv.cli_model.trim().to_string()),
        effort: (!conv.cli_effort.trim().is_empty()).then(|| conv.cli_effort.trim().to_string()),
        // Reuse session_file as the CLI resume token (claude session_id /
        // codex thread_id) so a conversation keeps context across turns.
        resume: (!resume_before.is_empty()).then(|| resume_before.clone()),
        bypass_approvals: load_settings(&state.store).bypass_approvals,
        images: image_paths,
        image_blocks,
    };
    let bin = backend.default_bin().to_string();
    let store = state.store.clone();
    let task_handle = handle.clone();
    let conv_id = conv.id.clone();
    // Fire-and-stream: return promptly; events arrive over the sink like pi.
    tokio::spawn(async move {
        let outcome = cetus_bridge::cli_agent::run_cli_turn(
            sink,
            backend,
            &bin,
            &cwd,
            &prompt,
            Some(conv_id.clone()),
            env,
            opts,
            Some(kill),
            Some(input_rx),
        )
        .await;
        match outcome {
            Ok(o) => {
                // Persist the turn's assistant/toolResult messages and the
                // next-turn resume token.
                let ts = now_ms();
                for m in &o.messages {
                    store.append_cli_message(&conv_id, m, None, ts).ok();
                }
                if let Some(resume) = &o.resume_id {
                    store.set_session_file(&conv_id, resume).ok();
                }
            }
            Err(e) => {
                tracing::error!("cli backend {} turn failed: {e:#}", backend.as_str());
            }
        }
        let st = task_handle.state::<AppState>();
        st.end_cli_turn(&conv_id);
    });
    Ok(())
}

/// Concatenated text of a PiMessage's content — the retry path returns this as
/// the text to resubmit. Handles both string and block-array content.
pub fn message_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| {
                (b.get("type").and_then(|t| t.as_str()) == Some("text"))
                    .then(|| b.get("text").and_then(|t| t.as_str()).unwrap_or(""))
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}
