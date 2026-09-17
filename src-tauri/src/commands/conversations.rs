use super::{
    err, now_ms, AppState, CmdResult, Conversation, ModelChoice, Path, PathBuf, Serialize, State,
    Uuid, Value,
};

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
    if cetus_bridge::remote::parse_remote_workspace(&workspace.to_string_lossy()).is_none() {
        std::fs::create_dir_all(&workspace).map_err(err)?;
    }

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
        unread_at: None,
        source_automation_id: None,
        parallel_group_id: None,
        solution_index: None,
        review_state: "none".to_string(),
        backend: crate::store::default_backend(),
        cli_model: String::new(),
        cli_effort: String::new(),
        run_state: "idle".to_string(),
        pinned_at: None,
    };
    state.store.insert(&c).map_err(err)?;
    Ok(c)
}

#[tauri::command]
pub async fn fork_conversation(
    state: State<'_, AppState>,
    id: String,
    message_id: Option<String>,
    message_index: Option<usize>,
) -> CmdResult<SwitchResponse> {
    let source = state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".to_string())?;

    // CLI-backend conversations fork by cloning the persisted transcript.
    if cetus_bridge::cli_agent::CliBackend::from_id(&source.backend).is_some() {
        return fork_cli_conversation(&state, &source, message_id, message_index).await;
    }

    // Ensure a lazily-created conversation has a concrete session file before
    // cloning it. For normal chats this is already populated.
    let source_session = if source.session_file.is_empty() {
        let _ = state.pi_for(&id).await.map_err(err)?;
        state
            .store
            .get(&id)
            .map_err(err)?
            .ok_or_else(|| "conversation not found".to_string())?
            .session_file
    } else {
        source.session_file.clone()
    };
    if source_session.is_empty() {
        return Err("conversation has no session to fork".to_string());
    }

    let new_id = Uuid::new_v4().to_string();
    let ext = Path::new(&source_session)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("jsonl");
    let fork_session = state
        .sessions_dir()
        .join(format!("{new_id}.{ext}"))
        .to_string_lossy()
        .to_string();
    std::fs::copy(&source_session, &fork_session).map_err(err)?;

    let now = now_ms();
    let c = Conversation {
        id: new_id.clone(),
        title: if source.title.trim().is_empty() {
            String::new()
        } else {
            format!("{} (fork)", source.title)
        },
        session_file: fork_session,
        workspace_dir: source.workspace_dir.clone(),
        model: source.model.clone(),
        created_at: now,
        updated_at: now,
        archived_at: None,
        unread_at: None,
        source_automation_id: None,
        parallel_group_id: None,
        solution_index: None,
        review_state: "none".to_string(),
        backend: crate::store::default_backend(),
        cli_model: String::new(),
        cli_effort: String::new(),
        run_state: "idle".to_string(),
        pinned_at: None,
    };
    state.store.insert(&c).map_err(err)?;

    let pi = state.pi_for(&new_id).await.map_err(err)?;
    let mut messages = pi.get_messages().await.map_err(err)?;
    if message_id.as_deref().is_some() || message_index.is_some() {
        let target_idx = find_fork_target_index(&messages, message_id.as_deref(), message_index)
            .ok_or_else(|| "fork target message not found".to_string())?;
        let forkable = pi.get_fork_messages().await.map_err(err)?;
        if let Some(entry_id) = next_user_entry_after(&messages, &forkable, target_idx)? {
            let _ = pi.fork(entry_id).await.map_err(err)?;
            messages = pi.get_messages().await.map_err(err)?;
        }
    }
    Ok(SwitchResponse {
        conversation: c,
        messages,
    })
}

/// Fork a claude-code/codex conversation: mint a sibling row (same backend and
/// workspace), copy the transcript — truncated at the next user turn after the
/// fork target, mirroring the pi fork contract — and pick the resume token the
/// fork continues from. claude's `--resume` forks server-side sessions cheaply,
/// so any row's `resume_before` token is a valid branch point; codex threads
/// are single-lined, so a codex fork keeps the visual history but starts its
/// context fresh (empty token) rather than cross-contaminating the source
/// conversation's thread.
async fn fork_cli_conversation(
    state: &State<'_, AppState>,
    source: &Conversation,
    message_id: Option<String>,
    message_index: Option<usize>,
) -> CmdResult<SwitchResponse> {
    let rows = state.store.list_cli_rows(&source.id).map_err(err)?;
    let messages: Vec<Value> = rows.iter().map(|(_, m, _)| m.clone()).collect();

    // Where to cut: the first user row after the target message (its turn and
    // everything later stay out of the fork). No target → full copy.
    let mut copy_limit: Option<usize> = None;
    let mut fork_resume = source.session_file.clone();
    if message_id.is_some() || message_index.is_some() {
        let target_idx = find_fork_target_index(&messages, message_id.as_deref(), message_index)
            .ok_or_else(|| "fork target message not found".to_string())?;
        let cut = messages
            .iter()
            .enumerate()
            .skip(target_idx + 1)
            .find(|(_, m)| m.get("role").and_then(|r| r.as_str()) == Some("user"))
            .map(|(i, _)| i);
        if let Some(cut_idx) = cut {
            copy_limit = Some(cut_idx);
            // The cut user row's resume_before is the token in effect at the
            // cut point — exactly what the fork should resume from.
            fork_resume = rows[cut_idx].2.clone().unwrap_or_default();
        }
    }
    if source.backend == "codex" {
        fork_resume = String::new();
    }

    let new_id = Uuid::new_v4().to_string();
    let now = now_ms();
    let c = Conversation {
        id: new_id.clone(),
        title: if source.title.trim().is_empty() {
            String::new()
        } else {
            format!("{} (fork)", source.title)
        },
        session_file: fork_resume,
        workspace_dir: source.workspace_dir.clone(),
        model: source.model.clone(),
        created_at: now,
        updated_at: now,
        archived_at: None,
        unread_at: None,
        source_automation_id: None,
        parallel_group_id: None,
        solution_index: None,
        review_state: "none".to_string(),
        backend: source.backend.clone(),
        cli_model: source.cli_model.clone(),
        cli_effort: source.cli_effort.clone(),
        run_state: "idle".to_string(),
        pinned_at: None,
    };
    state.store.insert(&c).map_err(err)?;
    state
        .store
        .copy_cli_messages(&source.id, &new_id, copy_limit)
        .map_err(err)?;

    // Seed the fork's worktree from the source's branch when the source runs
    // isolated, so the fork continues from the source's file state instead of
    // repo HEAD. A source running directly in the workspace forks a workspace
    // run — no worktree. Best-effort either way.
    let ws = std::path::PathBuf::from(&source.workspace_dir);
    if cetus_bridge::worktree::is_git_repo(&ws)
        && cetus_bridge::worktree::worktree_path(&ws, &source.id)
            .join(".git")
            .exists()
    {
        let src_branch = cetus_bridge::worktree::branch_name(&source.id);
        let _ = cetus_bridge::worktree::ensure_worktree(&ws, &new_id, Some(&src_branch));
    }

    let messages = state.store.list_cli_messages(&new_id).map_err(err)?;
    Ok(SwitchResponse {
        conversation: c,
        messages,
    })
}

fn find_fork_target_index(
    messages: &[Value],
    message_id: Option<&str>,
    message_index: Option<usize>,
) -> Option<usize> {
    if let Some(id) = message_id {
        if let Some(idx) = messages
            .iter()
            .position(|m| m.get("id").and_then(|v| v.as_str()) == Some(id))
        {
            return Some(idx);
        }
    }

    let target_display_idx = message_index?;
    let mut display_idx = 0usize;
    for (raw_idx, msg) in messages.iter().enumerate() {
        if msg.get("role").and_then(|v| v.as_str()) == Some("toolResult") {
            continue;
        }
        if display_idx == target_display_idx {
            return Some(raw_idx);
        }
        display_idx += 1;
    }
    None
}

fn next_user_entry_after<'a>(
    messages: &[Value],
    forkable: &'a [Value],
    target_idx: usize,
) -> CmdResult<Option<&'a str>> {
    let mut user_ordinal = 0usize;
    for (idx, msg) in messages.iter().enumerate() {
        if msg.get("role").and_then(|v| v.as_str()) != Some("user") {
            continue;
        }
        if idx > target_idx {
            return forkable
                .get(user_ordinal)
                .and_then(|v| v.get("entryId"))
                .and_then(|v| v.as_str())
                .map(Some)
                .ok_or_else(|| "fork entry missing id".to_string());
        }
        user_ordinal += 1;
    }
    Ok(None)
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
    // CLI-backend conversations replay from the persisted transcript — their
    // session_file is a resume token, not a pi session, so a pi must never be
    // spawned against it.
    if cetus_bridge::cli_agent::CliBackend::from_id(&conv.backend).is_some() {
        let messages = state.store.list_cli_messages(&id).map_err(err)?;
        return Ok(SwitchResponse {
            conversation: conv,
            messages,
        });
    }
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
pub async fn set_active_conversation(
    state: State<'_, AppState>,
    id: Option<String>,
) -> CmdResult<()> {
    state.set_active_conversation(id).await;
    Ok(())
}

/// Persist the sidebar's unread dot. The renderer owns *when* a chat becomes
/// unread (it sees agent_end, retries, and whether the chat was on screen); this
/// only stores the answer, so the dot survives a restart and the auto-archive
/// sweep can see it. Unknown ids are a no-op — the row may have been deleted.
#[tauri::command]
pub async fn set_conversation_unread(
    state: State<'_, AppState>,
    id: String,
    unread: bool,
) -> CmdResult<()> {
    state
        .store
        .set_unread(&id, if unread { Some(now_ms()) } else { None })
        .map_err(err)
}

/// Persist a chat's project-scoped pin (the sidebar sorts pinned chats first
/// within their workspace group). Storage-only, mirroring
/// `set_conversation_unread`; unknown ids are a no-op.
#[tauri::command]
pub async fn set_conversation_pinned(
    state: State<'_, AppState>,
    id: String,
    pinned: bool,
) -> CmdResult<()> {
    state
        .store
        .set_pinned(&id, if pinned { Some(now_ms()) } else { None })
        .map_err(err)
}

/// Dismiss a conversation's interrupted-run banner without resuming the turn.
/// Guarded on the current state (see `Store::clear_interrupted`) so it can't
/// stomp a turn that started in the meantime.
#[tauri::command]
pub async fn clear_interrupted(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.store.clear_interrupted(&id).map_err(err)
}

/// Claim the one-shot auto-resume for an interrupted conversation (see
/// `Store::claim_auto_resume`). The frontend's boot sweep calls this per
/// interrupted row; `true` means "go ahead and send the continuation",
/// `false` means this interruption already used its automatic retry and the
/// manual Resume banner stays.
#[tauri::command]
pub async fn claim_auto_resume(state: State<'_, AppState>, id: String) -> CmdResult<bool> {
    state.store.claim_auto_resume(&id).map_err(err)
}

#[tauri::command]
pub async fn archive_conversation(
    state: State<'_, AppState>,
    id: String,
    archive: bool,
) -> CmdResult<Conversation> {
    let conversation = state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".to_string())?;
    state
        .store
        .set_archived(&id, archive, now_ms())
        .map_err(err)?;
    // Archived conversations don't keep an idle pi around — reclaim the
    // process. Un-archiving just leaves it cold; next interaction lazy-spawns.
    if archive {
        state.kill_pi(&id).await;
        state.abort_cli_turn(&id);
        state.kill_claude_session(&id);
        state.kill_codex_session(&id);
        state.kill_acp_session(&id);
    }
    // Codex persists app-server threads in its own session inventory. Mirror
    // Cetus's state after stopping the live session so Codex App/CLI sees the
    // same archive bucket. Keep this best-effort for older/missing Codex CLIs.
    if let Err(error) = crate::cli_backend::sync_codex_archive_state(&conversation, archive).await {
        tracing::warn!("failed to sync Codex archive state for {id}: {error}");
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
    purge_conversation(&state, &id).await
}

/// Permanently delete a conversation and everything hanging off it: live
/// runtimes, the CLI worktree, transcript, attachments, artifacts, and the
/// search index. Shared by the `delete_conversation` command and the
/// auto-delete sweep in `auto_archive.rs` so both paths clean up identically.
pub async fn purge_conversation(state: &AppState, id: &str) -> CmdResult<()> {
    let id = id.to_string();
    state.kill_pi(&id).await;
    state.abort_cli_turn(&id);
    state.kill_claude_session(&id);
    state.kill_codex_session(&id);
    state.kill_acp_session(&id);
    state.remove_conv_agent(&id);
    // CLI-backend leftovers: the git worktree (its branch survives so finished
    // work isn't lost), the persisted transcript, and on-disk attachments.
    // All no-ops for pi conversations.
    if let Ok(Some(conv)) = state.store.get(&id) {
        if cetus_bridge::cli_agent::CliBackend::from_id(&conv.backend).is_some() {
            let ws = std::path::PathBuf::from(&conv.workspace_dir);
            if cetus_bridge::worktree::is_git_repo(&ws) {
                if let Err(e) = cetus_bridge::worktree::remove_worktree(&ws, &id) {
                    tracing::warn!("worktree cleanup for {id} failed: {e:#}");
                }
            }
        }
    }
    state.store.delete_cli_messages(&id).ok();
    state.store.delete_conversation_index(&id).ok();
    let _ = std::fs::remove_dir_all(crate::cli_backend::attachments_dir(
        &state.app_data_dir,
        &id,
    ));
    let _ = std::fs::remove_dir_all(crate::cli_backend::artifacts_dir(&state.app_data_dir, &id));
    state.store.delete(&id).map_err(err)
}

/// Where a CLI-backend conversation's isolated changes live: the worktree path
/// and branch, when the workspace is a git repo. None for pi conversations and
/// non-repo workspaces — the UI hides the affordance.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    /// False until the first turn actually created the worktree.
    pub exists: bool,
}

#[tauri::command]
pub async fn conversation_worktree(
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<Option<WorktreeInfo>> {
    let conv = state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".to_string())?;
    if cetus_bridge::cli_agent::CliBackend::from_id(&conv.backend).is_none() {
        return Ok(None);
    }
    let ws = std::path::PathBuf::from(&conv.workspace_dir);
    if !cetus_bridge::worktree::is_git_repo(&ws) {
        return Ok(None);
    }
    let path = cetus_bridge::worktree::worktree_path(&ws, &id);
    Ok(Some(WorktreeInfo {
        exists: path.join(".git").exists(),
        path: path.to_string_lossy().to_string(),
        branch: cetus_bridge::worktree::branch_name(&id),
    }))
}

/// Branch checked out in a local workspace. Non-git and remote workspaces do
/// not render a branch indicator.
#[tauri::command]
pub async fn workspace_git_branch(workspace_dir: String) -> CmdResult<Option<String>> {
    if cetus_bridge::remote::parse_remote_workspace(&workspace_dir).is_some() {
        return Ok(None);
    }
    Ok(cetus_bridge::worktree::current_branch(Path::new(
        &workspace_dir,
    )))
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
