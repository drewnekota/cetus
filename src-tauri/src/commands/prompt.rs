use super::{derive_title, err, now_ms, AppState, Arc, CmdResult, Serialize, State, Value};

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

/// Strip a leading `<context source="cetus-…"> … </context>` block (with its
/// trailing blank line) so titling sees only the user's prose. Covers every
/// composer-injected fence — quick launcher AND ambient — since either can
/// lead the first message of a conversation. Returns the input unchanged when
/// no such fence is present.
fn strip_context_fence(msg: &str) -> &str {
    const OPEN: &str = "<context source=\"cetus-";
    const CLOSE: &str = "</context>";
    if msg.starts_with(OPEN) {
        if let Some(idx) = msg.find(CLOSE) {
            return msg[idx + CLOSE.len()..].trim_start_matches(['\n', '\r']);
        }
    }
    msg
}

/// Return only human-readable content for conversation naming. File prompts
/// carry a private path block for the agent; feeding that block to the title
/// model can make its protocol (or even a tool-call sentinel) become the
/// sidebar title. When there is no accompanying prose, use the attached file
/// names instead.
pub(super) fn title_source(msg: &str) -> String {
    const OPEN: &str = "<cetus-attachments>";
    const CLOSE: &str = "</cetus-attachments>";

    let msg = strip_context_fence(msg);
    let Some(open) = msg.find(OPEN) else {
        return msg.trim().to_string();
    };

    let prose = msg[..open].trim();
    if !prose.is_empty() {
        return prose.to_string();
    }

    let block_start = open + OPEN.len();
    let block_end = msg[block_start..]
        .find(CLOSE)
        .map(|offset| block_start + offset)
        .unwrap_or(msg.len());
    msg[block_start..block_end]
        .lines()
        .filter_map(|line| {
            let item = line.trim().strip_prefix("- ")?;
            item.split_once(" → ").map(|(name, _)| name.trim())
        })
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>()
        .join("、")
}

#[tauri::command]
pub async fn send_prompt(
    state: State<'_, AppState>,
    id: String,
    message: String,
    images: Option<Vec<ImageAttachment>>,
) -> CmdResult<()> {
    // Route CLI-agent backends (claude-code / codex) to the headless-CLI runner
    // instead of the long-lived pi RPC. Each turn spawns the vendor CLI in the
    // conversation's workspace (isolated in a git worktree when it's a repo) and
    // streams its events into the same `app-event` channel the pi path uses, so
    // the chat UI renders a claude/codex turn with no frontend changes.
    let conv = state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".to_string())?;
    if cetus_bridge::cli_agent::CliBackend::from_id(&conv.backend).is_some() {
        crate::cli_backend::dispatch_turn(
            state.handle(),
            &conv,
            &message,
            images.unwrap_or_default(),
        )?;
        let now = now_ms();
        state.store.touch(&id, now).ok();
        // Same title contract as the pi path: paint the mechanical fallback
        // immediately, upgrade to an AI title in the background on first send.
        let was_untitled = conv.title.trim().is_empty();
        let title_src = title_source(&message);
        let fallback = derive_title(&title_src);
        state.store.set_title_if_empty(&id, &fallback, now).ok();
        if was_untitled && !title_src.trim().is_empty() {
            spawn_auto_title(
                state.store.clone(),
                state.handle().clone(),
                id.clone(),
                title_src,
                fallback,
            );
        }
        return Ok(());
    }

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
    let title_src = title_source(&message);
    let fallback = derive_title(&title_src);
    state.store.set_title_if_empty(&id, &fallback, now).ok();
    if was_untitled && !title_src.trim().is_empty() {
        spawn_auto_title(
            state.store.clone(),
            state.handle().clone(),
            id.clone(),
            title_src,
            fallback,
        );
    }
    Ok(())
}

/// Fetch a single conversation row (read-only). Used by the backend picker to
/// show the conversation's current backend without a full list scan.
#[tauri::command]
pub async fn get_conversation(
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<Option<crate::store::Conversation>> {
    state.store.get(&id).map_err(err)
}

/// Switch which coding-agent backend serves a conversation:
/// "pi" (built-in), a native CLI adapter, or a native ACP runtime. The next
/// `send_prompt` routes accordingly. Idempotent.
///
/// Swaps the per-runtime resume tokens (see [`crate::store::Store::switch_backend`])
/// and drops an audit marker into the CLI transcript so the switch is visible
/// in history. Refused while a CLI turn is mid-run — the running turn belongs
/// to the old runtime, and rebinding under it would steer the next prompt into
/// the wrong CLI's stdin.
#[tauri::command]
pub async fn set_conversation_backend(
    state: State<'_, AppState>,
    id: String,
    backend: String,
) -> CmdResult<()> {
    if backend != "pi" && cetus_bridge::cli_agent::CliBackend::from_id(&backend).is_none() {
        return Err(format!("unknown runtime: {backend}"));
    }
    let cli_settings = crate::cli_backend::load_settings(&state.store);
    let enabled = match backend.as_str() {
        "claude-code" => cli_settings.claude_code_enabled,
        "codex" => cli_settings.codex_enabled,
        "opencode" => cli_settings.opencode_enabled,
        "grok" => cli_settings.grok_enabled,
        "kimi" => cli_settings.kimi_enabled,
        "dsh" => cli_settings.dsh_enabled,
        _ => true,
    };
    if !enabled {
        return Err(format!("{backend} is disabled in Settings"));
    }
    if state.cli_turn_active(&id) {
        return Err(
            "A turn is still running — stop it or let it finish before switching runtime."
                .to_string(),
        );
    }
    let now = now_ms();
    let Some(old) = state
        .store
        .switch_backend(&id, &backend, now)
        .map_err(err)?
    else {
        return Ok(()); // missing conversation or same backend — nothing to do
    };
    // An idle vendor process owns background terminals and configuration for
    // the old runtime. Switching runtime is an explicit lifecycle boundary.
    state.kill_claude_session(&id);
    state.kill_codex_session(&id);
    state.kill_acp_session(&id);
    // Audit marker, but only when there's already a transcript: fresh
    // conversations get their backend set at creation (pending picker choice)
    // and must not open with a stray "Cetus → Codex" divider.
    let has_transcript = !state.store.list_cli_messages(&id).map_err(err)?.is_empty();
    if has_transcript {
        let marker = serde_json::json!({
            "role": "custom",
            "customType": "runtime_switch",
            "content": [{ "type": "text",
                          "text": format!("{} → {}", backend_label(&old), backend_label(&backend)) }],
            "details": { "from": old, "to": backend },
        });
        state.store.append_cli_message(&id, &marker, None, now).ok();
    }
    Ok(())
}

/// Display name for a backend id, matching the frontend's picker labels.
fn backend_label(id: &str) -> &str {
    match id {
        "pi" => "Cetus",
        "claude-code" => "Claude Code",
        "codex" => "Codex",
        "opencode" => "OpenCode",
        "grok" => "Grok Build",
        "kimi" => "Kimi CLI",
        "dsh" => "Dsh",
        other => other,
    }
}

/// Set a CLI-backend conversation's model override (`claude --model` /
/// `codex -m`); empty string clears it back to the CLI's own default. Applies
/// from the next turn.
#[tauri::command]
pub async fn set_conversation_cli_model(
    state: State<'_, AppState>,
    id: String,
    model: String,
    effort: String,
) -> CmdResult<()> {
    state
        .store
        .set_cli_model(&id, model.trim(), effort.trim(), now_ms())
        .map_err(err)?;
    // Model/effort are sticky app-server/session configuration; recreate the
    // idle process so the new choice applies on the next turn.
    state.kill_claude_session(&id);
    state.kill_codex_session(&id);
    state.kill_acp_session(&id);
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
    let conv = state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".to_string())?;
    // CLI backends: drop the last user turn (and everything after it) from the
    // persisted transcript and rewind session_file to the resume token that was
    // in effect before that turn, so the resend replays from the same context.
    if cetus_bridge::cli_agent::CliBackend::from_id(&conv.backend).is_some() {
        state.kill_claude_session(&id);
        state.kill_codex_session(&id);
        state.kill_acp_session(&id);
        let (row_id, message, resume_before) = state
            .store
            .last_cli_user_message(&id)
            .map_err(err)?
            .ok_or_else(|| "nothing to retry: no user message to roll back to".to_string())?;
        let text = crate::cli_backend::message_text(&message);
        state
            .store
            .delete_cli_messages_from(&id, row_id)
            .map_err(err)?;
        state
            .store
            .set_session_file(&id, resume_before.as_deref().unwrap_or(""))
            .map_err(err)?;
        let messages = state.store.list_cli_messages(&id).map_err(err)?;
        return Ok(RetryResponse { text, messages });
    }
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

/// Fire-and-forget: ask the utility model (DeepSeek, or the user's first
/// custom provider — see `custom_models::utility_target`) for a concise title
/// and, if the conversation still carries our placeholder, replace it and
/// notify the frontend. Silent on any failure — the mechanical fallback
/// already stuck.
fn spawn_auto_title(
    store: Arc<crate::store::Store>,
    handle: tauri::AppHandle,
    id: String,
    message: String,
    fallback: String,
) {
    tauri::async_runtime::spawn(async move {
        let target = match crate::custom_models::utility_target(&store) {
            Some(t) => t,
            None => return, // no usable endpoint → keep the mechanical fallback
        };
        let title = match crate::titling::generate_title(&target, &message).await {
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
                crate::app_event::AppEvent::ConversationUpdated { conversation },
            );
        }
    });
}

#[tauri::command]
pub async fn abort(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    // A running CLI turn (claude-code / codex) has a kill switch; firing it is
    // a no-op when idle, as is the pi abort below when no pi exists.
    state.abort_cli_turn(&id);
    if let Some(pi) = state.pi_existing(&id).await {
        pi.abort().await.map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn compact_conversation(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let conversation = state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".to_string())?;
    crate::cli_backend::compact_codex_conversation(state.handle(), &conversation).await
}
