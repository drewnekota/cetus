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
}

impl Default for CliAgentSettings {
    fn default() -> Self {
        Self {
            bypass_approvals: true,
            isolate_in_worktree: false,
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

/// What a CLI backend actually runs when no per-conversation override is set,
/// resolved from the vendor's own config on disk — so the tuning menu can echo
/// "Default (Fable)" instead of a bare "Default". For codex it also carries the
/// live model catalog from `models_cache.json` (the CLI's own fetched list),
/// which replaces the static fallback catalog in the UI. Everything is
/// best-effort: unreadable config → None → the UI shows a plain "Default".
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CliDefaults {
    /// Raw configured model id (e.g. "claude-fable-5[1m]" / "gpt-5.5").
    pub model: Option<String>,
    /// Raw configured reasoning effort (e.g. "high" / "medium").
    pub effort: Option<String>,
    /// Codex only: the models the CLI itself lists (slug + display name).
    pub models: Option<Vec<CliModelEntry>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliModelEntry {
    pub id: String,
    pub label: String,
}

#[tauri::command]
pub async fn get_cli_defaults(backend: String) -> Result<CliDefaults, String> {
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .map_err(|e| e.to_string())?;
    Ok(match backend.as_str() {
        "claude-code" => claude_defaults(&home),
        "codex" => codex_defaults(&home),
        _ => CliDefaults::default(),
    })
}

fn claude_defaults(home: &Path) -> CliDefaults {
    let raw =
        std::fs::read_to_string(home.join(".claude/settings.json")).unwrap_or_default();
    let v: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let s = |key: &str| v.get(key).and_then(|x| x.as_str()).map(str::to_string);
    CliDefaults {
        model: s("model"),
        effort: s("effortLevel"),
        models: None,
    }
}

fn codex_defaults(home: &Path) -> CliDefaults {
    // config.toml: `model` / `model_reasoning_effort` are top-level keys (they
    // sit above the first [section]), so a line scan beats pulling in a full
    // TOML parser as a dependency.
    let cfg = std::fs::read_to_string(home.join(".codex/config.toml")).unwrap_or_default();
    let mut model = None;
    let mut effort = None;
    for line in cfg.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            break;
        }
        if let Some(v) = toml_str_value(line, "model") {
            model = Some(v);
        }
        if let Some(v) = toml_str_value(line, "model_reasoning_effort") {
            effort = Some(v);
        }
    }
    // models_cache.json is the catalog codex itself fetched; "hide" entries are
    // internal (auto-review etc.).
    let cache =
        std::fs::read_to_string(home.join(".codex/models_cache.json")).unwrap_or_default();
    let cache: Value = serde_json::from_str(&cache).unwrap_or(Value::Null);
    let entries = cache.get("models").and_then(|m| m.as_array());
    let models: Vec<CliModelEntry> = entries
        .map(|arr| {
            arr.iter()
                .filter(|m| m.get("visibility").and_then(|v| v.as_str()) != Some("hide"))
                .filter_map(|m| {
                    let id = m.get("slug")?.as_str()?.to_string();
                    let label = m
                        .get("display_name")
                        .and_then(|d| d.as_str())
                        .unwrap_or(&id)
                        .to_string();
                    Some(CliModelEntry { id, label })
                })
                .collect()
        })
        .unwrap_or_default();
    // No explicit effort in config → the default model's own default level.
    if effort.is_none() {
        effort = entries.and_then(|arr| {
            arr.iter()
                .find(|m| m.get("slug").and_then(|s| s.as_str()) == model.as_deref())
                .and_then(|m| m.get("default_reasoning_level"))
                .and_then(|d| d.as_str())
                .map(str::to_string)
        });
    }
    CliDefaults {
        model,
        effort,
        models: (!models.is_empty()).then_some(models),
    }
}

/// `key = "value"` on a single TOML line → value. Rejects longer keys sharing
/// the prefix (`model` won't match `model_reasoning_effort` — the remainder
/// must start with `=`).
fn toml_str_value(line: &str, key: &str) -> Option<String> {
    let rest = line.strip_prefix(key)?.trim_start();
    let rest = rest.strip_prefix('=')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    rest.split('"').next().map(str::to_string)
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

    // Steer: a prompt sent while a claude turn is mid-run is injected into
    // that turn over stdin (a bidirectional stream-json user message — the
    // same steering the interactive CLI does on mid-run input) instead of
    // failing "already running". The runner keeps the turn open through the
    // injection (see run_cli_turn's steer grace). codex has no live stdin —
    // its steer below interrupts the turn and resumes the thread instead.
    if backend == cetus_bridge::cli_agent::CliBackend::ClaudeCode {
        let blocks: Vec<(String, String)> = images
            .iter()
            .map(|img| (img.mime_type.clone(), img.data.clone()))
            .collect();
        let line = cetus_bridge::cli_agent::claude_user_message_line(message, &blocks);
        match state.cli_steer(&conv.id, line) {
            crate::CliSteer::Steered => {
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
                        None,
                        now_ms(),
                    )
                    .ok();
                return Ok(());
            }
            // The turn already closed (its stdin is dead) — the follow-up queue
            // flushed on `agent_end` before the turn unregistered. Resume it as
            // a fresh turn once it settles, so the prompt isn't lost to a dead
            // pipe.
            crate::CliSteer::Closing(done) => {
                redispatch_after_settle(handle, conv.id.clone(), message.to_string(), images, done);
                return Ok(());
            }
            // No running turn: fall through to a normal dispatch.
            crate::CliSteer::Idle => {}
        }
    }

    // Steer, codex flavor: `codex exec` is one-shot (no live stdin to inject
    // into), so a prompt sent mid-run interrupts the turn — the same move as
    // Esc + a new message in the codex TUI. The kill makes the runner close
    // the turn with whatever streamed (persisted as partial messages, kept on
    // screen); once it settles we redispatch this prompt as a fresh turn that
    // resumes the same thread, so the model sees its interrupted work.
    if backend == cetus_bridge::cli_agent::CliBackend::Codex {
        if let Some(done) = state.cli_interrupt_turn(&conv.id) {
            redispatch_after_settle(handle, conv.id.clone(), message.to_string(), images, done);
            return Ok(());
        }
        // Idle: fall through to a normal dispatch.
    }

    let ws = PathBuf::from(&conv.workspace_dir);
    std::fs::create_dir_all(&ws).ok();
    let settings = load_settings(&state.store);
    // Run in the workspace itself by default; opt-in setting isolates each
    // conversation in its own git worktree (the Superset/Conductor pattern).
    // A worktree that already exists keeps being used either way — moving cwd
    // mid-conversation would orphan the CLI's resume session.
    let cwd = if cetus_bridge::worktree::is_git_repo(&ws) {
        let existing = cetus_bridge::worktree::worktree_path(&ws, &conv.id);
        if existing.join(".git").exists() {
            existing
        } else if settings.isolate_in_worktree {
            cetus_bridge::worktree::ensure_worktree(&ws, &conv.id, None)
                .unwrap_or_else(|_| ws.clone())
        } else {
            ws.clone()
        }
    } else {
        ws.clone()
    };
    let env = crate::secrets::load_env();
    // One turn per conversation; also the abort command's kill switch and the
    // stdin channel control responses ride in on. Registered before the user
    // message persists so a rejected double-send doesn't strand a transcript
    // row that never ran.
    let (kill, input_rx, steer_pending, closing) = state.begin_cli_turn(&conv.id)?;
    // Wrap the event sink so it flips `closing` true the instant this turn's
    // `agent_end` passes through — BEFORE that event reaches the frontend, so a
    // follow-up flushed on `agent_end` (see cli_steer) never races ahead of the
    // flag and lands in the dead-turn steer path.
    let sink: std::sync::Arc<dyn cetus_bridge::pi_rpc::EventSink> =
        std::sync::Arc::new(ClosingSink {
            inner: std::sync::Arc::new(crate::tauri_bridge::TauriEventSink::new(handle.clone())),
            closing,
        });

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
        bypass_approvals: settings.bypass_approvals,
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
            Some(steer_pending),
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
                if o.resume_rejected {
                    // The stored token points at a session that isn't on disk
                    // (its turn was killed before the CLI saved it) — reset it
                    // so the next send starts fresh instead of failing forever.
                    store.set_session_file(&conv_id, "").ok();
                } else if o.streamed {
                    // Only a turn that streamed content has certainly been
                    // written to the CLI's session store; persisting the id of
                    // one stopped earlier (Stop during boot) would poison
                    // every later turn with an unresumable session.
                    if let Some(resume) = &o.resume_id {
                        store.set_session_file(&conv_id, resume).ok();
                    }
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

/// Event sink that trips `closing` the instant a turn's `agent_end` flows
/// through, then forwards the event unchanged. Because the flag is set before
/// `inner.emit`, the frontend can only observe `agent_end` after the flag is
/// visible — so a follow-up the frontend flushes on that event reads the turn
/// as `Closing` (dead stdin) rather than steering into it.
struct ClosingSink {
    inner: std::sync::Arc<dyn cetus_bridge::pi_rpc::EventSink>,
    closing: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl cetus_bridge::pi_rpc::EventSink for ClosingSink {
    fn emit(&self, event: cetus_bridge::bridge::RuntimeEvent) {
        if let cetus_bridge::bridge::RuntimeEvent::Protocol { event: ev, .. } = &event {
            if ev.get("type").and_then(|t| t.as_str()) == Some("agent_end") {
                self.closing
                    .store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        self.inner.emit(event);
    }
}

/// Redispatch `message` as a fresh turn once the currently-closing turn has
/// fully settled (`done` fired by `end_cli_turn`, so its partial messages and
/// resume token are on disk). Shared by the codex steer (interrupt + resume)
/// and the claude follow-up that flushed on `agent_end` after the turn stopped
/// reading stdin — both need a settled session to resume from.
fn redispatch_after_settle(
    handle: &AppHandle,
    conv_id: String,
    message: String,
    images: Vec<crate::commands::ImageAttachment>,
    done: std::sync::Arc<tokio::sync::Notify>,
) {
    let handle = handle.clone();
    tokio::spawn(async move {
        use cetus_bridge::pi_rpc::EventSink;
        let fail = |handle: &AppHandle, conv_id: String, msg: String| {
            tracing::error!("cli steer redispatch failed: {msg}");
            let sink = crate::tauri_bridge::TauriEventSink::new(handle.clone());
            sink.emit(cetus_bridge::bridge::RuntimeEvent::Error {
                conversation_id: Some(conv_id),
                message: msg,
            });
        };
        // Bounded wait: a wedged child that never settles must not re-enter
        // dispatch (which would interrupt/redispatch again — a loop).
        let settled = tokio::time::timeout(std::time::Duration::from_secs(15), done.notified())
            .await
            .is_ok();
        if !settled {
            fail(
                &handle,
                conv_id,
                "the running turn didn't stop; message not delivered — try again".into(),
            );
            return;
        }
        let state = handle.state::<AppState>();
        // Re-read the row: the settled turn persisted its resume token
        // (session_file) on the way out, and the redispatch must resume from it.
        let conv = match state.store.get(&conv_id) {
            Ok(Some(c)) => c,
            _ => return,
        };
        if let Err(e) = dispatch_turn(&handle, &conv, &message, images) {
            fail(&handle, conv_id, format!("steer redispatch failed: {e}"));
        }
    });
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
