//! Tauri commands invoked by the React frontend.
//!
//! Every command that talks to a pi process takes the owning conversation id
//! explicitly — the previous "active session" model is gone now that each
//! conversation has its own dedicated pi child (see AppState::pi_for).

use crate::model::ModelChoice;
use crate::secrets;
use crate::store::{now_ms, Conversation};
use crate::AppState;
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
pub async fn list_conversations(
    state: State<'_, AppState>,
    include_archived: bool,
) -> CmdResult<Vec<Conversation>> {
    state.store.list(include_archived).map_err(err)
}

#[tauri::command]
pub async fn new_conversation(
    state: State<'_, AppState>,
    workspace_dir: Option<String>,
    model: Option<ModelChoice>,
) -> CmdResult<Conversation> {
    let workspace = workspace_dir
        .map(PathBuf::from)
        .unwrap_or_else(|| state.default_workspace.clone());
    std::fs::create_dir_all(&workspace).map_err(err)?;

    // Mint the id up front; the pi is spawned lazily by `pi_for` on first use
    // (send_prompt / switch) rather than here. Spawning a pi eagerly costs a
    // subprocess launch + two RPC round-trips before this command can return,
    // which made the UI stall between Enter and the conversation appearing.
    // Deferring it lets the row land instantly so the optimistic bubble renders
    // right away; `pi_for` mints the session (empty `session_file` below) and
    // applies the model the moment the prompt actually goes out.
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    let c = Conversation {
        id: id.clone(),
        title: String::new(),
        session_file: String::new(),
        workspace_dir: workspace.to_string_lossy().to_string(),
        model: model.unwrap_or_default(),
        created_at: now,
        updated_at: now,
        archived_at: None,
        source_automation_id: None,
        parallel_group_id: None,
        solution_index: None,
        review_state: "none".to_string(),
    };
    state.store.insert(&c).map_err(err)?;
    Ok(c)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchResponse {
    pub conversation: Conversation,
    pub messages: Vec<Value>,
}

#[tauri::command]
pub async fn switch_conversation(
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<SwitchResponse> {
    let conv = state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".to_string())?;
    // pi_for lazy-spawns if this is the first time the conversation is opened
    // since the app launched. The fresh pi's switch_session + apply_choice
    // happen inside pi_for.
    let pi = state.pi_for(&id).await.map_err(err)?;
    let messages = pi.get_messages().await.map_err(err)?;
    Ok(SwitchResponse {
        conversation: conv,
        messages,
    })
}

#[tauri::command]
pub async fn archive_conversation(
    state: State<'_, AppState>,
    id: String,
    archive: bool,
) -> CmdResult<Conversation> {
    state
        .store
        .set_archived(&id, archive, now_ms())
        .map_err(err)?;
    // Archived conversations don't keep an idle pi around — reclaim the
    // process. Un-archiving just leaves it cold; next interaction lazy-spawns.
    if archive {
        state.kill_pi(&id).await;
    }
    state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".into())
}

/// Set a conversation's human-in-the-loop review state. Called by the frontend
/// when the `request_review` tool fires (→ "pending"), and by the board's
/// approve ("approved") / send-back ("none") actions. Returns the updated row so
/// the UI can re-bucket the card.
#[tauri::command]
pub async fn set_review_state(
    state: State<'_, AppState>,
    id: String,
    state_value: String,
) -> CmdResult<Conversation> {
    state
        .store
        .set_review_state(&id, &state_value, now_ms())
        .map_err(err)?;
    state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".into())
}

#[tauri::command]
pub async fn delete_conversation(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.kill_pi(&id).await;
    state.remove_conv_agent(&id);
    state.store.delete(&id).map_err(err)
}

#[tauri::command]
pub async fn rename_conversation(
    state: State<'_, AppState>,
    id: String,
    title: String,
) -> CmdResult<Conversation> {
    state.store.rename(&id, &title, now_ms()).map_err(err)?;
    state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".into())
}

/// pi-ai `ImageContent` block. Mirrors the wire shape so the frontend can
/// build them and we forward without re-serializing fields.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment {
    #[serde(rename = "type")]
    pub kind: String,
    pub data: String,
    pub mime_type: String,
}

/// Strip a leading quick-launcher `<context source="cetus-quick"> … </context>`
/// block (with its trailing blank line) so titling sees only the user's prose.
/// Returns the input unchanged when no such fence is present.
fn strip_context_fence(msg: &str) -> &str {
    const OPEN: &str = "<context source=\"cetus-quick\">";
    const CLOSE: &str = "</context>";
    if let Some(rest) = msg.strip_prefix(OPEN) {
        if let Some(idx) = rest.find(CLOSE) {
            return rest[idx + CLOSE.len()..].trim_start_matches(['\n', '\r']);
        }
    }
    msg
}

#[tauri::command]
pub async fn send_prompt(
    state: State<'_, AppState>,
    id: String,
    message: String,
    images: Option<Vec<ImageAttachment>>,
) -> CmdResult<()> {
    let pi = state.pi_for(&id).await.map_err(err)?;
    let image_values: Vec<Value> = images
        .unwrap_or_default()
        .into_iter()
        .map(|img| {
            serde_json::json!({
                "type": img.kind,
                "data": img.data,
                "mimeType": img.mime_type,
            })
        })
        .collect();
    pi.send_prompt(&message, image_values).await.map_err(err)?;
    let now = now_ms();
    state.store.touch(&id, now).ok();

    // Auto-title only on the first prompt of a fresh conversation (title still
    // empty). Paint the mechanical first-line title immediately as a
    // placeholder, then upgrade it to an AI-generated title in the background —
    // ChatGPT-style, the thread gets a real name a beat after the first send.
    let was_untitled = state
        .store
        .get(&id)
        .ok()
        .flatten()
        .map(|c| c.title.trim().is_empty())
        .unwrap_or(false);
    // Title from the user's prose, not the quick-launcher context fence that may
    // lead the message — otherwise the thread would be named "<context …>".
    let title_src = strip_context_fence(&message);
    let fallback = derive_title(title_src);
    state.store.set_title_if_empty(&id, &fallback, now).ok();
    if was_untitled && !title_src.trim().is_empty() {
        spawn_auto_title(
            state.store.clone(),
            state.handle().clone(),
            id.clone(),
            title_src.to_string(),
            fallback,
        );
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryResponse {
    /// Text of the rolled-back user message, for the caller to resubmit.
    pub text: String,
    /// The conversation's history AFTER the failed turn was forked away, so the
    /// frontend can re-render a clean state before resending.
    pub messages: Vec<Value>,
}

/// Roll back the last turn for a retry: fork the session at the most recent user
/// message (dropping it and the failed/empty assistant response that poisoned
/// the history), then return that message's text plus the truncated history.
/// The frontend resets its view to `messages` and resubmits `text` — the
/// ChatGPT "regenerate" contract: a failed turn never persists into history.
#[tauri::command]
pub async fn retry_last_turn(state: State<'_, AppState>, id: String) -> CmdResult<RetryResponse> {
    let pi = state.pi_for(&id).await.map_err(err)?;
    let forkable = pi.get_fork_messages().await.map_err(err)?;
    let last = forkable
        .last()
        .ok_or_else(|| "nothing to retry: no user message to roll back to".to_string())?;
    let entry_id = last
        .get("entryId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "fork entry missing id".to_string())?;
    let text = pi.fork(entry_id).await.map_err(err)?;
    let messages = pi.get_messages().await.map_err(err)?;
    Ok(RetryResponse { text, messages })
}

/// Fire-and-forget: ask DeepSeek V4 Pro for a concise title and, if the
/// conversation still carries our placeholder, replace it and notify the
/// frontend. Silent on any failure — the mechanical fallback already stuck.
fn spawn_auto_title(
    store: Arc<crate::store::Store>,
    handle: tauri::AppHandle,
    id: String,
    message: String,
    fallback: String,
) {
    tauri::async_runtime::spawn(async move {
        let api_key = match secrets::get("deepseek") {
            Ok(Some(k)) => k,
            _ => return, // no key → keep the mechanical fallback
        };
        let url = crate::provider::deepseek_chat_url(&store);
        let title = match crate::titling::generate_title(&api_key, &url, &message).await {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!("auto-title failed for {id}: {e}");
                return;
            }
        };
        // Don't clobber a title the user renamed during the request window.
        let still_placeholder = store
            .get(&id)
            .ok()
            .flatten()
            .map(|c| c.title == fallback || c.title.trim().is_empty())
            .unwrap_or(false);
        if !still_placeholder || store.rename(&id, &title, now_ms()).is_err() {
            return;
        }
        if let Ok(Some(conversation)) = store.get(&id) {
            use tauri::Emitter;
            let _ = handle.emit(
                "app-event",
                crate::pi_rpc::AppEvent::ConversationUpdated { conversation },
            );
        }
    });
}

#[tauri::command]
pub async fn abort(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    // Only abort if a pi exists for this conv — otherwise it's a no-op.
    if let Some(pi) = state.pi_existing(&id).await {
        pi.abort().await.map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn pi_ping(_state: State<'_, AppState>) -> CmdResult<bool> {
    // Backend is up if this command resolves at all. With per-conversation
    // lazy spawn there's nothing to ping globally.
    Ok(true)
}

#[tauri::command]
pub async fn default_workspace(state: State<'_, AppState>) -> CmdResult<String> {
    Ok(state.default_workspace.to_string_lossy().to_string())
}

/// Open a native folder picker. Returns the chosen path or None if cancelled.
#[tauri::command]
pub async fn pick_workspace_dir(app: tauri::AppHandle) -> CmdResult<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path.and_then(|p| p.into_path().ok()));
    });
    let result = rx.await.map_err(err)?;
    Ok(result.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn set_workspace(
    state: State<'_, AppState>,
    id: String,
    workspace_dir: String,
) -> CmdResult<Conversation> {
    std::fs::create_dir_all(&workspace_dir).map_err(err)?;
    state
        .store
        .set_workspace(&id, &workspace_dir, now_ms())
        .map_err(err)?;
    let conv = state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".to_string())?;
    // The pi process pinned to this conv was spawned with the *old* cwd.
    // Drop it; next interaction lazy-spawns with the new cwd.
    state.kill_pi(&id).await;
    Ok(conv)
}

#[tauri::command]
pub async fn set_model_choice(
    state: State<'_, AppState>,
    id: String,
    choice: ModelChoice,
) -> CmdResult<Conversation> {
    state.store.set_model(&id, choice, now_ms()).map_err(err)?;
    // If pi is already running for this conv, push the new choice through
    // immediately. If it's cold, the next pi_for() will pick it up from the
    // freshly persisted row.
    if let Some(pi) = state.pi_existing(&id).await {
        pi.apply_choice(choice).await.map_err(err)?;
    }
    state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".to_string())
}

#[tauri::command]
pub async fn get_model_choice(state: State<'_, AppState>, id: String) -> CmdResult<ModelChoice> {
    let conv = state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".to_string())?;
    Ok(conv.model)
}

#[tauri::command]
pub async fn extension_ui_respond(
    state: State<'_, AppState>,
    conversation_id: String,
    id: String,
    payload: Value,
) -> CmdResult<()> {
    let mut obj = match payload {
        Value::Object(m) => m,
        _ => return Err("payload must be a JSON object".into()),
    };
    obj.insert(
        "type".to_string(),
        Value::String("extension_ui_response".to_string()),
    );
    obj.insert("id".to_string(), Value::String(id));
    let pi = state
        .pi_existing(&conversation_id)
        .await
        .ok_or_else(|| format!("no pi running for conversation {conversation_id}"))?;
    pi.notify(Value::Object(obj)).await.map_err(err)
}

#[tauri::command]
pub async fn list_api_keys() -> CmdResult<Vec<String>> {
    Ok(secrets::KNOWN_PROVIDERS
        .iter()
        .filter(|(prov, _)| secrets::has(prov))
        .map(|(prov, _)| (*prov).to_string())
        .collect())
}

#[tauri::command]
pub async fn list_api_keys_masked() -> CmdResult<std::collections::HashMap<String, String>> {
    let mut out = std::collections::HashMap::new();
    for (prov, _) in secrets::KNOWN_PROVIDERS {
        if let Ok(Some(raw)) = secrets::get(prov) {
            out.insert((*prov).to_string(), secrets::mask(&raw));
        }
    }
    Ok(out)
}

/// Return the full, unmasked key for a provider so the user can copy it back
/// out. These are the user's own keys on their own machine; the masked preview
/// (list_api_keys_masked) is still the default the UI shows.
#[tauri::command]
pub async fn reveal_api_key(provider: String) -> CmdResult<Option<String>> {
    secrets::get(&provider).map_err(err)
}

#[tauri::command]
pub async fn set_api_key(
    state: State<'_, AppState>,
    provider: String,
    key: String,
) -> CmdResult<()> {
    if !secrets::KNOWN_PROVIDERS
        .iter()
        .any(|(p, _)| *p == provider)
    {
        return Err(format!("unknown provider: {provider}"));
    }
    if key.is_empty() {
        secrets::delete(&provider).map_err(err)?;
    } else {
        secrets::set(&provider, &key).map_err(err)?;
    }
    // Kill every pi so the next interaction respawns with the new env.
    state.kill_all().await;
    Ok(())
}

#[tauri::command]
pub async fn delete_api_key(state: State<'_, AppState>, provider: String) -> CmdResult<()> {
    secrets::delete(&provider).map_err(err)?;
    state.kill_all().await;
    Ok(())
}

/// Persist a composer attachment (any non-image file) to disk so the agent can
/// read it via the `read_document` extension tool. Images keep riding the
/// `send_prompt` images channel; this is for everything else.
///
/// Files land in `<app_data>/attachments/<conv id>/<uuid>-<name>` — outside the
/// workspace so we never pollute the user's project tree. Returns the absolute
/// path, which the frontend embeds in the prompt for the model to read.
#[tauri::command]
pub async fn save_attachment(
    app: tauri::AppHandle,
    id: String,
    name: String,
    data: String,
) -> CmdResult<String> {
    use base64::Engine;
    use tauri::Manager;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("invalid base64 attachment: {e}"))?;

    let conv = sanitize_segment(&id);
    let dir = app
        .path()
        .app_data_dir()
        .map_err(err)?
        .join("attachments")
        .join(conv);
    std::fs::create_dir_all(&dir).map_err(err)?;

    // Keep the original basename for readability; prefix a short unique id so
    // re-sending the same filename never overwrites an earlier attachment.
    let base = std::path::Path::new(&name)
        .file_name()
        .and_then(|s| s.to_str())
        .map(sanitize_segment)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "file".to_string());
    let prefix = Uuid::new_v4().simple().to_string();
    let dest = dir.join(format!("{}-{base}", &prefix[..8]));

    std::fs::write(&dest, &bytes).map_err(err)?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Strip path separators and control chars so a filename can't escape its dir.
fn sanitize_segment(s: &str) -> String {
    s.chars()
        .map(|c| if c == '/' || c == '\\' || c.is_control() { '_' } else { c })
        .collect::<String>()
        .trim_matches(['.', ' '])
        .to_string()
}

#[tauri::command]
pub async fn read_text_file(path: String) -> CmdResult<String> {
    const MAX_BYTES: u64 = 4 * 1024 * 1024;
    let meta = std::fs::metadata(&path).map_err(err)?;
    if meta.len() > MAX_BYTES {
        return Err(format!(
            "file too large for inline preview ({} bytes, max {} bytes)",
            meta.len(),
            MAX_BYTES
        ));
    }
    std::fs::read_to_string(&path).map_err(err)
}

#[tauri::command]
pub async fn reveal_in_finder(path: String) -> CmdResult<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(err)?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map_err(err)?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = std::path::Path::new(&path)
            .parent()
            .ok_or_else(|| "no parent dir".to_string())?;
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(err)?;
    }
    Ok(())
}

/// Open a web link in the user's default browser.
///
/// Chat links are rendered inside the WKWebView, and a bare `<a>` click lets
/// the webview resolve the navigation itself. macOS then honours Universal
/// Links, so domains an installed app has claimed (e.g. Lark/Feishu's
/// `*.larksuite.com` / `*.feishu.cn` docs) open that app instead of the page.
/// Routing the click through a separate `open` process resolves the http(s)
/// scheme to the default browser, so the page actually opens in a browser.
#[tauri::command]
pub async fn open_external(url: String) -> CmdResult<()> {
    // Only hand off web/mail links — never arbitrary schemes from model output
    // (e.g. `file://`, custom app schemes) which could launch unexpected apps.
    let allowed = ["http://", "https://", "mailto:"];
    if !allowed.iter().any(|p| url.starts_with(p)) {
        return Err(format!("refusing to open non-web url: {url}"));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(err)?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(err)?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(err)?;
    }
    Ok(())
}

/// Open a local file with the OS default application (e.g. an HTML artifact in
/// the default browser, a PDF in Preview). Unlike `open_external` this takes a
/// filesystem path rather than a URL, so it powers the artifact dialog's "Open"
/// action across every file type.
#[tauri::command]
pub async fn open_path(path: String) -> CmdResult<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(err)?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(err)?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn log_fe(level: String, msg: String) -> CmdResult<()> {
    match level.as_str() {
        "error" => tracing::error!(target: "fe", "{msg}"),
        "warn" => tracing::warn!(target: "fe", "{msg}"),
        "info" => tracing::info!(target: "fe", "{msg}"),
        _ => tracing::debug!(target: "fe", "{msg}"),
    }
    Ok(())
}

pub(crate) fn derive_title(prompt: &str) -> String {
    let first_line = prompt.lines().next().unwrap_or("").trim();
    let title: String = first_line.chars().take(60).collect();
    if first_line.chars().count() > 60 {
        format!("{title}…")
    } else {
        title
    }
}

// ---- automations ----------------------------------------------------------

use crate::automation::{Automation, AutomationInput};

#[tauri::command]
pub async fn list_automations(state: State<'_, AppState>) -> CmdResult<Vec<Automation>> {
    state.store.list_automations().map_err(err)
}

#[tauri::command]
pub async fn create_automation(
    state: State<'_, AppState>,
    input: AutomationInput,
) -> CmdResult<Automation> {
    input.schedule.validate()?;
    let now = now_ms();
    let workspace = input
        .workspace_dir
        .filter(|w| !w.trim().is_empty())
        .unwrap_or_else(|| state.default_workspace.to_string_lossy().to_string());
    let next_run = if input.enabled {
        input.schedule.initial_next_run(now)
    } else {
        None
    };
    let automation = Automation {
        id: Uuid::new_v4().to_string(),
        name: input.name.trim().to_string(),
        prompt: input.prompt,
        workspace_dir: workspace,
        model: input.model,
        schedule: input.schedule,
        enabled: input.enabled,
        created_at: now,
        updated_at: now,
        next_run_at: next_run,
        last_run_at: None,
        last_conversation_id: None,
        last_status: None,
        last_error: None,
        run_count: 0,
    };
    state.store.insert_automation(&automation).map_err(err)?;
    Ok(automation)
}

#[tauri::command]
pub async fn update_automation(
    state: State<'_, AppState>,
    id: String,
    input: AutomationInput,
) -> CmdResult<Automation> {
    input.schedule.validate()?;
    let existing = state
        .store
        .get_automation(&id)
        .map_err(err)?
        .ok_or_else(|| "automation not found".to_string())?;
    let now = now_ms();
    let workspace = input
        .workspace_dir
        .filter(|w| !w.trim().is_empty())
        .unwrap_or_else(|| state.default_workspace.to_string_lossy().to_string());
    // Recompute the next fire from the (possibly new) schedule; carry forward
    // all run-state (last run, count, …).
    let next_run = if input.enabled {
        input.schedule.initial_next_run(now)
    } else {
        None
    };
    let updated = Automation {
        id: existing.id,
        name: input.name.trim().to_string(),
        prompt: input.prompt,
        workspace_dir: workspace,
        model: input.model,
        schedule: input.schedule,
        enabled: input.enabled,
        created_at: existing.created_at,
        updated_at: now,
        next_run_at: next_run,
        last_run_at: existing.last_run_at,
        last_conversation_id: existing.last_conversation_id,
        last_status: existing.last_status,
        last_error: existing.last_error,
        run_count: existing.run_count,
    };
    state.store.update_automation(&updated).map_err(err)?;
    Ok(updated)
}

#[tauri::command]
pub async fn delete_automation(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.store.delete_automation(&id).map_err(err)
}

#[tauri::command]
pub async fn set_automation_enabled(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> CmdResult<Automation> {
    let existing = state
        .store
        .get_automation(&id)
        .map_err(err)?
        .ok_or_else(|| "automation not found".to_string())?;
    let now = now_ms();
    let next_run = if enabled {
        // Keep a still-future slot; otherwise compute a fresh one from now.
        existing
            .next_run_at
            .filter(|&t| t > now)
            .or_else(|| existing.schedule.initial_next_run(now))
    } else {
        None
    };
    state
        .store
        .set_automation_enabled(&id, enabled, next_run, now)
        .map_err(err)?;
    state
        .store
        .get_automation(&id)
        .map_err(err)?
        .ok_or_else(|| "automation not found".to_string())
}

#[tauri::command]
pub async fn run_automation_now(
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<Conversation> {
    let ctx = state.scheduler_ctx();
    crate::scheduler::run_now(&ctx, &id).await
}

// ---- screen-context collection (Rewind-like) ------------------------------

#[tauri::command]
pub async fn get_capture_settings(
    state: State<'_, AppState>,
) -> CmdResult<crate::capture::CaptureSettings> {
    Ok(crate::capture::load_settings(&state.store))
}

#[tauri::command]
pub async fn set_capture_settings(
    state: State<'_, AppState>,
    settings: crate::capture::CaptureSettings,
) -> CmdResult<()> {
    crate::capture::save_settings(&state.store, &settings).map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStats {
    pub enabled: bool,
    pub count: i64,
}

#[tauri::command]
pub async fn capture_stats(state: State<'_, AppState>) -> CmdResult<CaptureStats> {
    let enabled = crate::capture::load_settings(&state.store).enabled;
    let count = state.store.screenshots_count().map_err(err)?;
    Ok(CaptureStats { enabled, count })
}

#[tauri::command]
pub async fn recent_screenshots(
    state: State<'_, AppState>,
    limit: Option<u32>,
    before_ts: Option<i64>,
) -> CmdResult<Vec<crate::store::Screenshot>> {
    state
        .store
        .recent_screenshots(limit.unwrap_or(50), before_ts)
        .map_err(err)
}

#[tauri::command]
pub async fn search_screenshots(
    state: State<'_, AppState>,
    query: String,
    since_ts: Option<i64>,
    limit: Option<u32>,
    before_ts: Option<i64>,
) -> CmdResult<Vec<crate::store::Screenshot>> {
    state
        .store
        .search_screenshots(&query, since_ts.unwrap_or(0), limit.unwrap_or(50), before_ts)
        .map_err(err)
}

/// Sync the native window appearance to the app's color theme. On macOS/Linux
/// this is app-wide, so it fixes the frosted vibrancy behind every window (the
/// launcher's HUD glass and the main window's sidebar/margins) when the user
/// locks a theme that differs from the OS. `None` (the "system" preference)
/// lets the OS drive it, which also keeps each webview's `prefers-color-scheme`
/// tracking the system for live updates. Best-effort — a missing window or an
/// unsupported platform is a no-op.
#[tauri::command]
pub async fn set_theme_appearance(app: tauri::AppHandle, preference: String) -> CmdResult<()> {
    use tauri::Manager;
    let theme = match preference.as_str() {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None,
    };
    // App-wide on macOS, so one window is enough; fall back if main is gone.
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_theme(theme);
    } else if let Some(w) = app.get_webview_window("quick") {
        let _ = w.set_theme(theme);
    }
    Ok(())
}
