use super::{
    handoff_preamble, load_settings, now_ms, AppHandle, AppState, Conversation, Manager, Path,
    PathBuf, Store,
};

/// Where a conversation's CLI-turn image attachments live on disk. The CLIs
/// read images as files (codex `-i`, claude via its Read tool), so pasted
/// base64 payloads are materialized here — outside the workspace/worktree so
/// the agent never commits them.
pub fn attachments_dir(app_data_dir: &Path, conv_id: &str) -> PathBuf {
    app_data_dir.join("cli-attachments").join(conv_id)
}

/// Managed storage for inline artifacts returned by third-party runtimes.
/// Local-path artifacts remain in place; only byte/data-url results land here.
pub fn artifacts_dir(app_data_dir: &Path, conv_id: &str) -> PathBuf {
    app_data_dir.join("runtime-artifacts").join(conv_id)
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

/// Tell the model where this turn's image attachments landed on disk. The
/// inline base64 blocks are vision-only — without a path the agent can't hand
/// an attached image to file-based tools (Read, media-insert, …). Rides only
/// the outgoing prompt; the persisted transcript row stays clean, so nothing
/// needs stripping on reload.
fn image_path_refs(paths: &[String]) -> String {
    if paths.is_empty() {
        return String::new();
    }
    let lines = paths
        .iter()
        .map(|p| format!("- {p}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "\n\n<cetus-attachments>\nThe attached images are also saved on disk. \
         Use these paths whenever a tool needs the image as a file:\n{lines}\n</cetus-attachments>"
    )
}

/// The PiMessage-shaped transcript row for a user prompt (+ image blocks).
fn cli_user_message_json(
    message: &str,
    images: &[crate::commands::ImageAttachment],
) -> serde_json::Value {
    let mut content = vec![serde_json::json!({ "type": "text", "text": message })];
    for img in images {
        content.push(serde_json::json!({
            "type": "image", "data": img.data, "mimeType": img.mime_type,
        }));
    }
    serde_json::json!({ "role": "user", "content": content })
}

/// Persist the user message that opens a fresh CLI turn. A steered message
/// does NOT go through here — it rides the translator's message list so it
/// lands in the transcript at its merge point inside the turn (persisting it
/// now would order it before the whole turn's assistant rows).
fn append_cli_user_message(
    store: &Store,
    conv: &Conversation,
    message: &str,
    images: &[crate::commands::ImageAttachment],
) {
    store
        .append_cli_message(
            &conv.id,
            &cli_user_message_json(message, images),
            (!conv.session_file.is_empty()).then_some(conv.session_file.as_str()),
            now_ms(),
        )
        .ok();
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

    // Materialize this turn's images once, up front: codex ingests the paths
    // via `-i`, and every backend gets them appended to the outgoing prompt
    // (image_path_refs) so the agent can reuse the files with path-based tools.
    let image_paths = save_turn_images(&state.app_data_dir, &conv.id, &images);
    let image_refs = image_path_refs(&image_paths);

    // Claude's bidirectional stream accepts user messages while a turn is
    // running. Inject the steer instead of sending the SDK interrupt control:
    // interrupt also cancels async Agent/Workflow tasks owned by the active
    // turn. A turn already past `agent_end` can no longer read stdin, so wait
    // for it to settle and dispatch a fresh resuming turn in that narrow race.
    if backend == cetus_bridge::cli_agent::CliBackend::ClaudeCode {
        let image_blocks: Vec<(String, String)> = images
            .iter()
            .map(|img| (img.mime_type.clone(), img.data.clone()))
            .collect();
        let line = cetus_bridge::cli_agent::claude_user_message_line(
            &format!("{message}{image_refs}"),
            &image_blocks,
        );
        // The transcript row rides along and is spliced in at the steer's
        // merge point by the session's translator (persisted with the turn's
        // outcome) — appending it here would order it before the whole turn.
        match state.cli_steer(&conv.id, line, cli_user_message_json(message, &images)) {
            crate::CliSteer::Steered => {
                return Ok(());
            }
            crate::CliSteer::Closing(done) => {
                redispatch_after_settle(handle, conv.id.clone(), message.to_string(), images, done);
                return Ok(());
            }
            crate::CliSteer::Idle => {}
        }
    }

    // Codex app-server has a real same-turn steering primitive. Preserve the
    // terminal semantics: a promoted follow-up appends with `turn/steer`;
    // only the explicit Stop action calls `turn/interrupt`. Once agent_end has
    // already crossed the bridge the turn is no longer steerable, so wait for
    // persistence and dispatch a normal next turn in that narrow race.
    if backend == cetus_bridge::cli_agent::CliBackend::Codex {
        if let Some(done) = state.cli_turn_done_if_closing(&conv.id) {
            redispatch_after_settle(handle, conv.id.clone(), message.to_string(), images, done);
            return Ok(());
        }
        if state.cli_turn_active(&conv.id) {
            let Some(session) = state.codex_session(&conv.id) else {
                return Err("Codex session disappeared while its turn was running".into());
            };
            session
                .steer(
                    format!("{message}{image_refs}"),
                    image_paths,
                    cli_user_message_json(message, &images),
                )
                .map_err(|error| error.to_string())?;
            return Ok(());
        }
        // Idle: fall through to a normal turn.
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
    let mut env = crate::secrets::load_env();
    // Cetus-awareness: hand the child agent the control socket and the bundled
    // `cetus` CLI (the shim in <app_data_dir>/bin) so it manages automations
    // through the running app instead of hunting for the sqlite file. The
    // matching one-line hint rides claude's --append-system-prompt / codex's
    // first-turn preamble below.
    env.push((
        "CETUS_SOCK".to_string(),
        crate::control::socket_path(&state.app_data_dir)
            .to_string_lossy()
            .into_owned(),
    ));
    env.push((
        "PATH".to_string(),
        format!(
            "{}:{}",
            crate::control::cli_bin_dir(&state.app_data_dir).display(),
            std::env::var("PATH").unwrap_or_default()
        ),
    ));
    // Every dispatch advances the conversation's generation, standing down any
    // auto-retry scheduled against the previous turn's transient failure —
    // whatever is dispatching now (user send, steer redispatch, the retry
    // itself) supersedes it.
    state.bump_cli_dispatch(&conv.id);
    // One turn per conversation; also the abort command's kill switch and the
    // stdin channel control responses ride in on. Registered before the user
    // message persists so a rejected double-send doesn't strand a transcript
    // row that never ran.
    let (kill, input_rx, _steer_pending, closing) = state.begin_cli_turn(&conv.id)?;
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
    // (native content blocks); codex ingests file paths via `-i`. Both get the
    // on-disk paths appended to the prompt (image_refs) for file-based reuse.
    // ACP runtimes, including dsh, receive native image content blocks.
    let is_codex = backend == cetus_bridge::cli_agent::CliBackend::Codex;
    let image_blocks: Vec<(String, String)> = if is_codex {
        Vec::new()
    } else {
        images
            .iter()
            .map(|img| (img.mime_type.clone(), img.data.clone()))
            .collect()
    };
    // Context handoff: no resume token but an existing transcript means this
    // conversation's session lives in ANOTHER runtime's store (backend was
    // switched — claude can't read a codex thread and vice versa) or was lost
    // (resume rejected and reset). The CLIs can't share sessions, but our
    // cli_messages transcript is runtime-agnostic — replay it as a preamble on
    // this first turn so the new runtime continues with the old context. One-
    // time cost: this turn establishes the new runtime's own session, and
    // every later turn resumes it normally.
    let resume_before = conv.session_file.clone();
    let mut prompt = if resume_before.is_empty() {
        let history = state.store.list_cli_messages(&conv.id).unwrap_or_default();
        match handoff_preamble(&history) {
            Some(preamble) => format!("{preamble}\n\n{message}"),
            None => message.to_string(),
        }
    } else {
        message.to_string()
    };
    // codex has no --append-system-prompt equivalent, so the Cetus hint rides
    // the first turn's prompt (resumed turns already have it in context).
    // Refresh dsh's CLI guidance on cold resumes as well: older sessions may
    // still contain instructions to call the retired Cetus plugin tools.
    let refresh_dsh_hint = backend == cetus_bridge::cli_agent::CliBackend::Dsh
        && state.acp_session(&conv.id).is_none();
    if ((is_codex || backend.is_acp()) && resume_before.is_empty()) || refresh_dsh_hint {
        prompt = format!(
            "<cetus-env>\n{}\n</cetus-env>\n\n{prompt}",
            crate::control::AGENT_HINT
        );
    }
    prompt.push_str(&image_refs);
    // An ACP session id lives in the vendor process, not on disk, so a resume
    // token can outlive the process that owned it. Agents advertising
    // `loadSession` restore it; the rest silently start an empty session. Build
    // the same first-turn preamble for that case and hand it to the session,
    // which uses it only if the load really didn't happen. Cold spawn only, so
    // the transcript read stays a once-per-process cost.
    let acp_cold_start_preamble =
        (backend.is_acp() && !resume_before.is_empty() && state.acp_session(&conv.id).is_none())
            .then(|| {
                let history = state.store.list_cli_messages(&conv.id).unwrap_or_default();
                let hint = format!("<cetus-env>\n{}\n</cetus-env>", crate::control::AGENT_HINT);
                match handoff_preamble(&history) {
                    Some(handoff) => format!("{hint}\n\n{handoff}"),
                    None => hint,
                }
            });

    // Persist the user message first so the transcript replays after a
    // restart (the handoff preamble is NOT persisted — it's rebuilt from the
    // transcript if ever needed again). `resume_before` snapshots the token
    // this turn resumes from — retry/fork restore to it to roll the turn back.
    append_cli_user_message(&state.store, conv, message, &images);

    let opts = cetus_bridge::cli_agent::CliRunOpts {
        // Per-conversation model + effort overrides; empty → the CLI's own
        // defaults.
        model: (!conv.cli_model.trim().is_empty()).then(|| conv.cli_model.trim().to_string()),
        effort: (!conv.cli_effort.trim().is_empty()).then(|| conv.cli_effort.trim().to_string()),
        // Reuse session_file as the CLI resume token (claude session_id /
        // codex thread_id) so a conversation keeps context across turns.
        resume: (!resume_before.is_empty()).then(|| resume_before.clone()),
        bypass_approvals: settings.bypass_approvals,
        images: image_paths.clone(),
        image_blocks: image_blocks.clone(),
        // claude: the Cetus hint goes on the system prompt every turn (codex
        // and the ACP runtimes got it as a first-turn preamble above).
        append_system_prompt: (!is_codex && !backend.is_acp())
            .then(|| crate::control::AGENT_HINT.to_string()),
        cold_start_preamble: acp_cold_start_preamble,
        client_version: Some(handle.package_info().version.to_string()),
    };
    let bin = backend.default_bin().to_string();
    let store = state.store.clone();
    let task_handle = handle.clone();
    let conv_id = conv.id.clone();

    if backend == cetus_bridge::cli_agent::CliBackend::ClaudeCode {
        let session = match state.claude_session(&conv.id) {
            Some(session) => session,
            None => {
                let base_sink: std::sync::Arc<dyn cetus_bridge::pi_rpc::EventSink> =
                    std::sync::Arc::new(crate::tauri_bridge::TauriEventSink::new(handle.clone()));
                // Self-started continuation turns (Monitor/subagent wake-ups)
                // stream with no registered turn, so no CliTurnOutcome ever
                // carries their messages — persist them as they settle, or
                // they'd exist only in the CLI's session file and vanish from
                // the Cetus transcript on restart.
                let (orphan_tx, mut orphan_rx) =
                    tokio::sync::mpsc::unbounded_channel::<Vec<serde_json::Value>>();
                {
                    let store = state.store.clone();
                    let conv_id = conv.id.clone();
                    tauri::async_runtime::spawn(async move {
                        while let Some(messages) = orphan_rx.recv().await {
                            let ts = now_ms();
                            for message in &messages {
                                store.append_cli_message(&conv_id, message, None, ts).ok();
                            }
                        }
                    });
                }
                let session = match cetus_bridge::cli_agent::spawn_claude_session(
                    base_sink,
                    &bin,
                    &cwd,
                    Some(artifacts_dir(&state.app_data_dir, &conv.id)),
                    Some(conv.id.clone()),
                    env,
                    opts,
                    Some(orphan_tx),
                ) {
                    Ok(session) => session,
                    Err(error) => {
                        state.end_cli_turn(&conv.id);
                        return Err(error.to_string());
                    }
                };
                state.set_claude_session(conv.id.clone(), session.clone());
                session
            }
        };
        let line = cetus_bridge::cli_agent::claude_user_message_line(&prompt, &image_blocks);
        let outcome_rx = match session.start_turn(line, sink) {
            Ok(receiver) => receiver,
            Err(error) => {
                state.kill_claude_session(&conv.id);
                state.end_cli_turn(&conv.id);
                return Err(error.to_string());
            }
        };
        // Persisted AFTER start_turn succeeded so a failed spawn never leaves a
        // phantom "running" row; anything still "running" at boot was therefore
        // a real in-flight turn the app died under (see mark_running_interrupted).
        store.set_run_state(&conv_id, "running").ok();
        tokio::spawn(async move {
            let mut outcome_rx = outcome_rx;
            let mut input_rx = input_rx;
            let outcome = loop {
                tokio::select! {
                    result = &mut outcome_rx => break result.ok(),
                    line = input_rx.recv() => match line {
                        Some(crate::CliInput::Line(line)) => { let _ = session.input(line); }
                        Some(crate::CliInput::Steer { line, message }) => {
                            let _ = session.steer(line, message);
                        }
                        None => break None,
                    },
                    _ = kill.notified() => {
                        // SDK interrupt stops only the active turn; the
                        // conversation session and background Bash jobs live on.
                        session.abort();
                    }
                }
            };
            if let Some(o) = &outcome {
                persist_cli_outcome(&store, &conv_id, o);
            }
            store
                .set_run_state(&conv_id, settled_run_state(&outcome))
                .ok();
            let st = task_handle.state::<AppState>();
            st.end_cli_turn(&conv_id);
            maybe_auto_retry_cli_turn(&task_handle, &conv_id, outcome.as_ref());
        });
        return Ok(());
    }

    if backend == cetus_bridge::cli_agent::CliBackend::Codex {
        let session = match state.codex_session(&conv.id) {
            Some(session) => session,
            None => {
                let base_sink: std::sync::Arc<dyn cetus_bridge::pi_rpc::EventSink> =
                    std::sync::Arc::new(crate::tauri_bridge::TauriEventSink::new(handle.clone()));
                let session = match cetus_bridge::cli_agent::spawn_codex_session(
                    base_sink,
                    &bin,
                    &cwd,
                    Some(artifacts_dir(&state.app_data_dir, &conv.id)),
                    Some(conv.id.clone()),
                    env,
                    opts,
                ) {
                    Ok(session) => session,
                    Err(error) => {
                        state.end_cli_turn(&conv.id);
                        return Err(error.to_string());
                    }
                };
                state.set_codex_session(conv.id.clone(), session.clone());
                session
            }
        };
        let outcome_rx = match session.start_turn(prompt, image_paths, sink) {
            Ok(receiver) => receiver,
            Err(error) => {
                state.kill_codex_session(&conv.id);
                state.kill_acp_session(&conv.id);
                state.end_cli_turn(&conv.id);
                return Err(error.to_string());
            }
        };
        store.set_run_state(&conv_id, "running").ok();
        tokio::spawn(async move {
            let mut outcome_rx = outcome_rx;
            let outcome = loop {
                tokio::select! {
                    result = &mut outcome_rx => break result.ok(),
                    _ = kill.notified() => session.abort_turn(),
                }
            };
            if let Some(o) = &outcome {
                persist_cli_outcome(&store, &conv_id, o);
            }
            store
                .set_run_state(&conv_id, settled_run_state(&outcome))
                .ok();
            let st = task_handle.state::<AppState>();
            st.end_cli_turn(&conv_id);
            maybe_auto_retry_cli_turn(&task_handle, &conv_id, outcome.as_ref());
        });
        return Ok(());
    }

    if backend.is_acp() {
        let session = match state.acp_session(&conv.id) {
            Some(session) => session,
            None => {
                let spawned = cetus_bridge::cli_agent::spawn_acp_session(
                    backend,
                    &bin,
                    &cwd,
                    Some(artifacts_dir(&state.app_data_dir, &conv.id)),
                    Some(conv.id.clone()),
                    env,
                    opts,
                );
                let session = match spawned {
                    Ok(session) => session,
                    Err(error) => {
                        state.end_cli_turn(&conv.id);
                        return Err(error.to_string());
                    }
                };
                state.set_acp_session(conv.id.clone(), session.clone());
                session
            }
        };
        let outcome_rx = match session.start_turn(prompt, image_blocks, sink) {
            Ok(receiver) => receiver,
            Err(error) => {
                state.kill_acp_session(&conv.id);
                state.end_cli_turn(&conv.id);
                return Err(error.to_string());
            }
        };
        store.set_run_state(&conv_id, "running").ok();
        tokio::spawn(async move {
            let mut outcome_rx = outcome_rx;
            let outcome = loop {
                tokio::select! {
                    result = &mut outcome_rx => break result.ok(),
                    _ = kill.notified() => session.abort(),
                }
            };
            if let Some(o) = &outcome {
                persist_cli_outcome(&store, &conv_id, o);
            }
            store
                .set_run_state(&conv_id, settled_run_state(&outcome))
                .ok();
            let state = task_handle.state::<AppState>();
            state.end_cli_turn(&conv_id);
            maybe_auto_retry_cli_turn(&task_handle, &conv_id, outcome.as_ref());
        });
        return Ok(());
    }

    unreachable!("all CLI backends dispatch through a persistent session")
}

/// Run Codex's native manual compaction for a conversation. This deliberately
/// uses `thread/compact/start` rather than sending the text `/compact` as a
/// model prompt. A cold Cetus process reattaches to the saved Codex thread
/// first, so manual compact works immediately after an app restart too.
pub async fn compact_codex_conversation(
    handle: &AppHandle,
    conv: &Conversation,
) -> Result<(), String> {
    if conv.backend != "codex" {
        return Err("manual compact is only available for Codex conversations".into());
    }
    if conv.session_file.trim().is_empty() {
        return Err("this Codex conversation has no session to compact yet".into());
    }
    let state = handle.state::<AppState>();
    if state.cli_turn_active(&conv.id) {
        return Err("wait for the active Codex turn to finish before compacting".into());
    }
    let session = match state.codex_session(&conv.id) {
        Some(session) => session,
        None => {
            let ws = PathBuf::from(&conv.workspace_dir);
            std::fs::create_dir_all(&ws).ok();
            let settings = load_settings(&state.store);
            let cwd = if cetus_bridge::worktree::is_git_repo(&ws) {
                let existing = cetus_bridge::worktree::worktree_path(&ws, &conv.id);
                if existing.join(".git").exists() {
                    existing
                } else {
                    ws.clone()
                }
            } else {
                ws.clone()
            };
            let mut env = crate::secrets::load_env();
            env.push((
                "CETUS_SOCK".to_string(),
                crate::control::socket_path(&state.app_data_dir)
                    .to_string_lossy()
                    .into_owned(),
            ));
            env.push((
                "PATH".to_string(),
                format!(
                    "{}:{}",
                    crate::control::cli_bin_dir(&state.app_data_dir).display(),
                    std::env::var("PATH").unwrap_or_default()
                ),
            ));
            let opts = cetus_bridge::cli_agent::CliRunOpts {
                model: (!conv.cli_model.trim().is_empty())
                    .then(|| conv.cli_model.trim().to_string()),
                effort: (!conv.cli_effort.trim().is_empty())
                    .then(|| conv.cli_effort.trim().to_string()),
                resume: Some(conv.session_file.clone()),
                bypass_approvals: settings.bypass_approvals,
                images: Vec::new(),
                image_blocks: Vec::new(),
                append_system_prompt: None,
                cold_start_preamble: None,
                client_version: None,
            };
            let base_sink: std::sync::Arc<dyn cetus_bridge::pi_rpc::EventSink> =
                std::sync::Arc::new(crate::tauri_bridge::TauriEventSink::new(handle.clone()));
            let session = cetus_bridge::cli_agent::spawn_codex_session(
                base_sink,
                cetus_bridge::cli_agent::CliBackend::Codex.default_bin(),
                &cwd,
                Some(artifacts_dir(&state.app_data_dir, &conv.id)),
                Some(conv.id.clone()),
                env,
                opts,
            )
            .map_err(|error| error.to_string())?;
            state.set_codex_session(conv.id.clone(), session.clone());
            session
        }
    };
    session
        .compact("manual")
        .await
        .map_err(|error| error.to_string())
}

/// Final `run_state` for a turn whose runner loop exited. No outcome means the
/// session died without settling (channel dropped — app teardown or a vanished
/// child): that's an interruption, not a finish, so the restart UI offers to
/// resume it.
fn settled_run_state(outcome: &Option<cetus_bridge::cli_agent::CliTurnOutcome>) -> &'static str {
    match outcome {
        Some(o) if o.aborted => "aborted",
        Some(_) => "idle",
        None => "interrupted",
    }
}

fn persist_cli_outcome(
    store: &Store,
    conv_id: &str,
    outcome: &cetus_bridge::cli_agent::CliTurnOutcome,
) {
    let ts = now_ms();
    for message in &outcome.messages {
        store.append_cli_message(conv_id, message, None, ts).ok();
    }
    if outcome.resume_rejected {
        store.set_session_file(conv_id, "").ok();
    } else if outcome.streamed {
        if let Some(resume) = &outcome.resume_id {
            store.set_session_file(conv_id, resume).ok();
        }
    }
    // Keep the ⌘K content index current the moment a turn settles, so the
    // reply is findable before the background sweep gets to it.
    crate::search_index::reindex_cli(store, conv_id);
}

/// Consecutive automatic retries a conversation gets before the error is left
/// for the user, and the backoff before each attempt. The vendor CLI already
/// exhausted its own API-level retries by the time the turn settles, so the
/// waits start long and grow.
const CLI_AUTO_RETRY_MAX: u32 = 3;
const CLI_AUTO_RETRY_BACKOFF_SECS: [u64; 3] = [20, 60, 180];

/// The visible continuation prompt an auto-retry dispatches. Not a replay of
/// the original message: the session resumes with its full context (or the
/// transcript replays as a handoff preamble when no session was saved), so the
/// agent picks the task back up instead of redoing it.
///
/// Keep in sync with `CLI_AUTO_RETRY_PROMPT` in src/lib/continuation-prompts.ts
/// — the chat matches this exact text to render the row as a system notice
/// instead of a user bubble.
const CLI_AUTO_RETRY_PROMPT: &str = "The previous turn stopped early due to a transient provider \
     error (rate limited or overloaded). This is an automatic retry: review what has already been \
     done in this conversation, then continue the original task from where it left off. Don't \
     redo work that has already completed.";

/// Schedule an automatic continuation turn when a CLI turn settled on a
/// transient provider failure (429 burst, upstream overload — see
/// `is_transient_agent_error`; quota exhaustion and hard failures keep the
/// current behavior of surfacing the error and waiting for the user). The
/// retry sleeps out a backoff, then stands down if anything else dispatched a
/// turn on this conversation in the meantime.
fn maybe_auto_retry_cli_turn(
    handle: &AppHandle,
    conv_id: &str,
    outcome: Option<&cetus_bridge::cli_agent::CliTurnOutcome>,
) {
    let state = handle.state::<AppState>();
    let Some(outcome) = outcome else { return };
    let transient = !outcome.aborted
        && outcome
            .error
            .as_deref()
            .is_some_and(cetus_bridge::cli_agent::is_transient_agent_error);
    if !transient {
        // Includes clean settles: the next transient failure starts with a
        // fresh retry budget.
        state.reset_cli_auto_retry(conv_id);
        return;
    }
    let Some(attempt) = state.next_cli_auto_retry(conv_id, CLI_AUTO_RETRY_MAX) else {
        tracing::warn!(
            "cli auto-retry for {conv_id} gave up after {CLI_AUTO_RETRY_MAX} attempts; leaving the error to the user"
        );
        // Reset so a manual resend that fails transiently earns a new budget.
        state.reset_cli_auto_retry(conv_id);
        return;
    };
    let delay = CLI_AUTO_RETRY_BACKOFF_SECS[(attempt as usize - 1).min(2)];
    let generation = state.cli_dispatch_generation(conv_id);
    tracing::info!(
        "transient CLI error on {conv_id}; auto-retry {attempt}/{CLI_AUTO_RETRY_MAX} in {delay}s"
    );
    let handle = handle.clone();
    let conv_id = conv_id.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
        let state = handle.state::<AppState>();
        // Stand down if anything else dispatched during the backoff (the
        // generation moved), a turn is running right now, or the conversation
        // is gone / no longer idle (aborted, interrupted-by-restart…).
        if state.cli_dispatch_generation(&conv_id) != generation || state.cli_turn_active(&conv_id)
        {
            return;
        }
        let conv = match state.store.get(&conv_id) {
            Ok(Some(conv)) if conv.run_state == "idle" => conv,
            _ => return,
        };
        // Paint the continuation prompt live before the turn's stream starts —
        // dispatch_turn persists the row, but nothing else would render it
        // until a reload (backend-initiated turns have no optimistic bubble).
        {
            use cetus_bridge::pi_rpc::EventSink;
            let sink = crate::tauri_bridge::TauriEventSink::new(handle.clone());
            sink.emit(cetus_bridge::bridge::RuntimeEvent::Protocol {
                conversation_id: Some(conv_id.clone()),
                event: serde_json::json!({
                    "type": "message_start",
                    "message": cli_user_message_json(CLI_AUTO_RETRY_PROMPT, &[]),
                }),
            });
        }
        if let Err(error) = dispatch_turn(&handle, &conv, CLI_AUTO_RETRY_PROMPT, Vec::new()) {
            tracing::warn!("cli auto-retry dispatch failed for {conv_id}: {error}");
        }
    });
}

/// Event sink that trips `closing` the instant a turn's `agent_end` flows
/// through, then forwards the event unchanged. Because the flag is set before
/// `inner.emit`, the frontend can only observe `agent_end` after the flag is
/// visible — so a follow-up the frontend flushes on that event reads the turn
/// as `Closing` rather than attaching it to the turn that just ended.
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
/// resume token are on disk). Shared by the Codex/Claude follow-up that flushed
/// on `agent_end` after the turn stopped accepting steer input.
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

/// Cap on one transcript entry in the handoff preamble. Long assistant answers
/// keep their head — the part that states what was concluded/done.
pub(super) const HANDOFF_MSG_CHARS: usize = 2_000;
/// Cap on the whole preamble (~8k tokens). The most recent turns matter most,
/// so the budget is spent from the tail; older turns are dropped with a count.
pub(super) const HANDOFF_TOTAL_CHARS: usize = 24_000;
