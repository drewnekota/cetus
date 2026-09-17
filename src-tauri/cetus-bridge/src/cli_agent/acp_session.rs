use super::dsh::{
    dsh_config_updates, dsh_dotenv, dsh_home, dsh_prepare_runtime, dsh_require_supported_version,
};
use super::{acp_commands_event, CliBackend, CliRunOpts, CliTurnOutcome, EventTranslator};
use crate::bridge::RuntimeEvent;
use crate::pi_rpc::EventSink;
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command as TokioCommand;

/// One persistent native-ACP process and session. OpenCode, Grok Build and
/// Kimi differ only in argv; their wire behavior is handled here.
#[derive(Clone)]
pub struct AcpSessionHandle {
    tx: tokio::sync::mpsc::UnboundedSender<AcpSessionCommand>,
}

enum AcpSessionCommand {
    StartTurn {
        prompt: String,
        images: Vec<(String, String)>,
        sink: Arc<dyn EventSink>,
        outcome: tokio::sync::oneshot::Sender<CliTurnOutcome>,
    },
    RespondPermission {
        request_id: Value,
        allow: bool,
    },
    Abort,
    Shutdown,
}

impl AcpSessionHandle {
    pub fn start_turn(
        &self,
        prompt: String,
        images: Vec<(String, String)>,
        sink: Arc<dyn EventSink>,
    ) -> Result<tokio::sync::oneshot::Receiver<CliTurnOutcome>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.tx
            .send(AcpSessionCommand::StartTurn {
                prompt,
                images,
                sink,
                outcome: tx,
            })
            .map_err(|_| anyhow::anyhow!("ACP session has exited"))?;
        Ok(rx)
    }

    pub fn respond_permission(&self, request_id: Value, allow: bool) -> Result<()> {
        self.tx
            .send(AcpSessionCommand::RespondPermission { request_id, allow })
            .map_err(|_| anyhow::anyhow!("ACP session has exited"))
    }

    pub fn abort(&self) {
        let _ = self.tx.send(AcpSessionCommand::Abort);
    }

    pub fn shutdown(&self) {
        let _ = self.tx.send(AcpSessionCommand::Shutdown);
    }

    pub fn is_alive(&self) -> bool {
        !self.tx.is_closed()
    }
}

struct ActiveAcpTurn {
    request_id: Value,
    sink: Arc<dyn EventSink>,
    outcome: tokio::sync::oneshot::Sender<CliTurnOutcome>,
    translator: EventTranslator,
}

fn emit_protocol(sink: &Arc<dyn EventSink>, conversation_id: &Option<String>, events: Vec<Value>) {
    for event in events {
        sink.emit(RuntimeEvent::Protocol {
            conversation_id: conversation_id.clone(),
            event,
        });
    }
}

async fn acp_write(stdin: &mut tokio::process::ChildStdin, value: &Value) -> std::io::Result<()> {
    stdin.write_all(value.to_string().as_bytes()).await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await
}

/// Answer a reverse request we can't route — one arriving mid-handshake, or a
/// permission prompt with no turn to show it on. Silence would block the agent
/// forever, so permission prompts get a protocol-level `cancelled` and anything
/// else (we advertise no filesystem/terminal capabilities) a "method not
/// found".
async fn acp_decline_request(stdin: &mut tokio::process::ChildStdin, request: &Value) {
    let Some(id) = request.get("id") else { return };
    let response =
        if request.get("method").and_then(Value::as_str) == Some("session/request_permission") {
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "outcome": { "outcome": "cancelled" } }
            })
        } else {
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": "Unsupported ACP client method" }
            })
        };
    let _ = acp_write(stdin, &response).await;
}

async fn acp_handshake_request(
    stdin: &mut tokio::process::ChildStdin,
    reader: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value> {
    acp_write(
        stdin,
        &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
    )
    .await
    .with_context(|| format!("failed to write ACP {method} request"))?;
    loop {
        let line = tokio::time::timeout(Duration::from_secs(30), reader.next_line())
            .await
            .with_context(|| format!("ACP {method} timed out"))??
            .ok_or_else(|| anyhow::anyhow!("ACP process exited during {method}"))?;
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("id").and_then(Value::as_u64) != Some(id) {
            // Notifications (session/load replays its history through them) are
            // ignored, but a *request* must be answered or the agent stalls
            // before it ever reaches its first turn.
            if value.get("method").is_some() && value.get("id").is_some() {
                acp_decline_request(stdin, &value).await;
            }
            continue;
        }
        if let Some(error) = value.get("error") {
            anyhow::bail!("ACP {method} failed: {error}");
        }
        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
    }
}

/// The option id matching the user's answer. Once-scoped kinds win over
/// always-scoped ones so a single Allow can never silently become a standing
/// grant. There is deliberately NO "just take the first option" fallback: an
/// agent that offers nothing matching the answer must get `cancelled`, because
/// guessing here would turn a Deny into an Allow.
fn acp_allow_option(params: &Value, allow: bool) -> Option<Value> {
    let options = params.get("options")?.as_array()?;
    let wanted: [&str; 2] = if allow {
        ["allow_once", "allow"]
    } else {
        ["reject_once", "reject"]
    };
    wanted
        .iter()
        .find_map(|prefix| {
            options.iter().find(|option| {
                option
                    .get("kind")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| kind.starts_with(prefix))
            })
        })
        .and_then(|option| option.get("optionId").cloned())
}

/// A `session/prompt` reply carries why the agent stopped. `end_turn` and
/// `cancelled` are normal; the rest end the turn with nothing rendered, so
/// surface them instead of showing an empty answer.
pub(super) fn acp_stop_reason_error(response: &Value) -> Option<String> {
    match response
        .pointer("/result/stopReason")
        .and_then(Value::as_str)?
    {
        "end_turn" | "cancelled" => None,
        "refusal" => Some("The agent declined to continue this turn.".to_string()),
        "max_tokens" => Some("The agent stopped: token limit reached.".to_string()),
        "max_turn_requests" => {
            Some("The agent stopped: too many requests in one turn.".to_string())
        }
        other => Some(format!("The agent stopped early ({other}).")),
    }
}

pub(super) fn acp_permission_response(params: &Value, allow: bool) -> Value {
    match acp_allow_option(params, allow) {
        Some(option_id) => json!({
            "outcome": { "outcome": "selected", "optionId": option_id }
        }),
        None => json!({ "outcome": { "outcome": "cancelled" } }),
    }
}

fn fail_queued_acp_turns(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<AcpSessionCommand>,
    backend: CliBackend,
    artifact_dir: Option<&Path>,
    cwd: &Path,
    conversation_id: &Option<String>,
    error: &str,
) {
    while let Ok(command) = rx.try_recv() {
        if let AcpSessionCommand::StartTurn { sink, outcome, .. } = command {
            let mut translator = EventTranslator::new(backend);
            if let Some(dir) = artifact_dir {
                translator = translator.with_artifact_storage(dir.to_path_buf(), cwd.to_path_buf());
            }
            emit_protocol(&sink, conversation_id, translator.start());
            emit_protocol(&sink, conversation_id, translator.finish(Some(error)));
            let _ = outcome.send(CliTurnOutcome {
                resume_id: None,
                messages: translator.take_messages(),
                aborted: false,
                streamed: false,
                resume_rejected: false,
                error: Some(error.to_string()),
            });
        }
    }
}

/// Spawn a vendor-native ACP stdio server, initialize it, and keep one session
/// alive across turns. A cold app process loads the saved ACP session id when
/// the agent advertises `loadSession`; when it can't, the session starts empty
/// and `opts.cold_start_preamble` (the Cetus hint plus a transcript handoff,
/// built by the host) rides the first prompt so the context isn't silently
/// lost.
pub fn spawn_acp_session(
    backend: CliBackend,
    bin: &str,
    cwd: &Path,
    artifact_dir: Option<PathBuf>,
    conversation_id: Option<String>,
    extra_env: Vec<(String, String)>,
    opts: CliRunOpts,
) -> Result<AcpSessionHandle> {
    anyhow::ensure!(
        backend.is_acp(),
        "{} is not an ACP backend",
        backend.as_str()
    );
    let mut command = TokioCommand::new(bin);
    command
        .args(backend.acp_args())
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if backend == CliBackend::Dsh {
        let runtime = dsh_prepare_runtime(&dsh_home())?;
        command.arg("--patch").arg(runtime.join("flash.patch.yml"));
        for (key, value) in dsh_dotenv() {
            command.env(key, value);
        }
    }
    for (key, value) in extra_env {
        command.env(key, value);
    }
    let mut child = command
        .spawn()
        .with_context(|| format!("failed to launch `{bin} {}`", backend.acp_args().join(" ")))?;
    let mut stdin = child.stdin.take().context("ACP child stdin missing")?;
    let stdout = child.stdout.take().context("ACP child stdout missing")?;
    let stderr = child.stderr.take();
    let translator_cwd = cwd.to_path_buf();
    let cwd_string = cwd.to_string_lossy().into_owned();
    let bin_name = bin.to_string();
    let client_version = opts
        .client_version
        .clone()
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let handle = AcpSessionHandle { tx };

    tokio::spawn(async move {
        // Bounded stderr head: a handshake failure's JSON-RPC error is usually
        // opaque ("bridge disposed"), while the agent already explained itself
        // on stderr (missing package, bad plugin, no credentials). Boot
        // diagnostics come first, so keep the head and drop stack frames.
        let stderr_head = Arc::new(std::sync::Mutex::new(String::new()));
        if let Some(stderr) = stderr {
            let head = stderr_head.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!("{} ACP stderr: {line}", backend.as_str());
                    let mut text = head.lock().unwrap();
                    if text.len() < 8 * 1024 && !line.trim_start().starts_with("at ") {
                        text.push_str(&line);
                        text.push('\n');
                    }
                }
            });
        }
        let with_stderr = |error: String| {
            // Give the agent a beat to finish writing its boot diagnostics.
            let head = stderr_head.clone();
            async move {
                tokio::time::sleep(Duration::from_millis(300)).await;
                let head = head.lock().unwrap().trim().to_string();
                if head.is_empty() {
                    error
                } else {
                    format!("{error}\n\n{} stderr:\n{head}", backend.as_str())
                }
            }
        };
        let mut reader = BufReader::new(stdout).lines();
        if backend == CliBackend::Dsh {
            if let Err(error) = dsh_require_supported_version(&bin_name).await {
                tracing::warn!("dsh version gate: {error:#}");
                fail_queued_acp_turns(
                    &mut rx,
                    backend,
                    artifact_dir.as_deref(),
                    &translator_cwd,
                    &conversation_id,
                    &format!("{error:#}"),
                );
                let _ = child.start_kill();
                return;
            }
        }
        let init = acp_handshake_request(
            &mut stdin,
            &mut reader,
            1,
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false
                },
                "clientInfo": { "name": "cetus", "version": client_version }
            }),
        )
        .await;
        let init = match init {
            Ok(value) => value,
            Err(error) => {
                tracing::warn!("{} ACP initialize failed: {error}", backend.as_str());
                let error = with_stderr(error.to_string()).await;
                fail_queued_acp_turns(
                    &mut rx,
                    backend,
                    artifact_dir.as_deref(),
                    &translator_cwd,
                    &conversation_id,
                    &error,
                );
                let _ = child.start_kill();
                return;
            }
        };
        let can_load = init
            .pointer("/agentCapabilities/loadSession")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        // dsh persists sessions itself and restores one through the ACP
        // `session/resume` extension (advertised under sessionCapabilities)
        // instead of `session/load`; its log comes back without replaying old
        // updates, which is exactly what Cetus wants — the transcript is
        // already on screen.
        let can_resume = init
            .pointer("/agentCapabilities/sessionCapabilities/resume")
            .is_some();
        let grok_default_model = (backend == CliBackend::Grok)
            .then(|| {
                init.pointer("/_meta/modelState/currentModelId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .flatten();
        let mut session_params = json!({ "cwd": cwd_string, "mcpServers": [] });
        // Grok accepts the initial model on session/new. Reasoning effort is
        // applied below through session/set_model, which is also the only path
        // that updates an existing loaded session.
        if backend == CliBackend::Grok {
            if let Some(model) = opts.model.as_ref() {
                session_params["modelId"] = json!(model);
            }
        }
        let resume_requested = opts.resume.is_some();
        let resume_method = if can_load {
            Some("session/load")
        } else if can_resume {
            Some("session/resume")
        } else {
            None
        };
        let loaded = match (resume_method, opts.resume.as_ref()) {
            (Some(method), Some(resume)) => acp_handshake_request(
                &mut stdin,
                &mut reader,
                2,
                method,
                json!({
                    "sessionId": resume,
                    "cwd": cwd_string,
                    "mcpServers": []
                }),
            )
            .await
            .map_err(|error| {
                tracing::warn!("{} ACP {method} failed: {error}", backend.as_str());
                error
            })
            .ok(),
            _ => None,
        };
        let loaded_existing = loaded.is_some();
        let session_result = match loaded {
            Some(value) => value,
            None => match acp_handshake_request(
                &mut stdin,
                &mut reader,
                3,
                "session/new",
                session_params,
            )
            .await
            {
                Ok(value) => value,
                Err(error) => {
                    tracing::warn!("{} ACP session/new failed: {error}", backend.as_str());
                    let error = with_stderr(error.to_string()).await;
                    fail_queued_acp_turns(
                        &mut rx,
                        backend,
                        artifact_dir.as_deref(),
                        &translator_cwd,
                        &conversation_id,
                        &error,
                    );
                    let _ = child.start_kill();
                    return;
                }
            },
        };
        let Some(session_id) = session_result
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| opts.resume.filter(|_| loaded_existing))
        else {
            tracing::warn!("{} ACP returned no session id", backend.as_str());
            fail_queued_acp_turns(
                &mut rx,
                backend,
                artifact_dir.as_deref(),
                &translator_cwd,
                &conversation_id,
                "ACP returned no session id",
            );
            let _ = child.start_kill();
            return;
        };

        if backend == CliBackend::Grok && (opts.model.is_some() || opts.effort.is_some()) {
            let model_id = opts
                .model
                .clone()
                .or_else(|| {
                    session_result
                        .pointer("/models/currentModelId")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .or(grok_default_model);
            if let Some(model_id) = model_id {
                let mut params = json!({ "sessionId": session_id, "modelId": model_id });
                if let Some(effort) = opts.effort.as_ref() {
                    params["reasoningEffort"] = json!(effort);
                }
                if let Err(error) =
                    acp_handshake_request(&mut stdin, &mut reader, 4, "session/set_model", params)
                        .await
                {
                    tracing::warn!("Grok ACP session/set_model failed: {error}");
                }
            }
        }

        if backend == CliBackend::Dsh {
            let catalog = session_result
                .get("configOptions")
                .cloned()
                .unwrap_or(Value::Null);
            let updates =
                dsh_config_updates(&catalog, Some("deepseek-flash"), opts.effort.as_deref());
            if !updates.iter().any(|(id, _)| id == "model") {
                fail_queued_acp_turns(
                    &mut rx,
                    backend,
                    artifact_dir.as_deref(),
                    &translator_cwd,
                    &conversation_id,
                    "dsh does not expose deepseek-flash; check its model settings or update dsh.",
                );
                let _ = child.start_kill();
                return;
            }
            for (index, (config_id, value)) in updates.into_iter().enumerate() {
                let params = json!({
                    "sessionId": session_id,
                    "configId": config_id,
                    "value": value,
                });
                if let Err(error) = acp_handshake_request(
                    &mut stdin,
                    &mut reader,
                    5 + index as u64,
                    "session/set_config_option",
                    params,
                )
                .await
                {
                    tracing::warn!("dsh ACP session/set_config_option {config_id} failed: {error}");
                    if config_id == "model" {
                        fail_queued_acp_turns(
                            &mut rx,
                            backend,
                            artifact_dir.as_deref(),
                            &translator_cwd,
                            &conversation_id,
                            &format!("Could not select DeepSeek Flash: {error}"),
                        );
                        let _ = child.start_kill();
                        return;
                    }
                }
            }
        }

        let mut next_id = 10u64;
        let mut active: Option<ActiveAcpTurn> = None;
        let mut permission_params: HashMap<String, Value> = HashMap::new();
        // Announced right after session/new, i.e. before any turn owns a sink.
        // Cached here and replayed on every turn so the composer's slash menu
        // hydrates instead of staying empty.
        let mut commands_event: Option<Value> = None;
        // Only set when a resume token existed but the agent could not load it,
        // so this session really did start from nothing.
        let mut cold_start_preamble = match (loaded_existing, resume_requested) {
            (false, true) => opts.cold_start_preamble.clone(),
            _ => None,
        };
        loop {
            tokio::select! {
                command = rx.recv() => match command {
                    Some(AcpSessionCommand::StartTurn { prompt, images, sink, outcome }) => {
                        if active.is_some() {
                            // begin_cli_turn is supposed to make this
                            // unreachable; report it instead of eating the
                            // prompt if it ever isn't.
                            let mut translator = EventTranslator::new(backend);
                            emit_protocol(&sink, &conversation_id, translator.start());
                            emit_protocol(
                                &sink,
                                &conversation_id,
                                translator.finish(Some("A turn is already running on this ACP session")),
                            );
                            let _ = outcome.send(CliTurnOutcome {
                                resume_id: Some(session_id.clone()),
                                messages: translator.take_messages(),
                                aborted: false,
                                streamed: false,
                                resume_rejected: false,
                                error: None,
                            });
                            continue;
                        }
                        let mut translator = EventTranslator::new(backend);
                        if let Some(dir) = artifact_dir.clone() {
                            translator = translator.with_artifact_storage(dir, translator_cwd.clone());
                        }
                        emit_protocol(&sink, &conversation_id, translator.start());
                        if let Some(event) = commands_event.clone() {
                            emit_protocol(&sink, &conversation_id, vec![event]);
                        }
                        let prompt = match cold_start_preamble.take() {
                            Some(preamble) => format!("{preamble}\n\n{prompt}"),
                            None => prompt,
                        };
                        let mut blocks = vec![json!({ "type": "text", "text": prompt })];
                        blocks.extend(images.into_iter().map(|(mime_type, data)| {
                            json!({ "type": "image", "mimeType": mime_type, "data": data })
                        }));
                        let request_id = json!(next_id);
                        next_id += 1;
                        let request = json!({
                            "jsonrpc": "2.0",
                            "id": request_id,
                            "method": "session/prompt",
                            "params": { "sessionId": session_id, "prompt": blocks }
                        });
                        if let Err(error) = acp_write(&mut stdin, &request).await {
                            let msg = format!("ACP stdin closed: {error}");
                            emit_protocol(
                                &sink,
                                &conversation_id,
                                translator.finish(Some(&msg)),
                            );
                            let streamed = translator.opened;
                            let _ = outcome.send(CliTurnOutcome {
                                resume_id: Some(session_id.clone()),
                                messages: translator.take_messages(),
                                aborted: false,
                                streamed,
                                resume_rejected: false,
                                error: Some(msg),
                            });
                            break;
                        }
                        active = Some(ActiveAcpTurn { request_id, sink, outcome, translator });
                    }
                    Some(AcpSessionCommand::RespondPermission { request_id, allow }) => {
                        let key = request_id.to_string();
                        if let Some(params) = permission_params.remove(&key) {
                            let result = acp_permission_response(&params, allow);
                            let _ = acp_write(
                                &mut stdin,
                                &json!({ "jsonrpc": "2.0", "id": request_id, "result": result }),
                            ).await;
                        }
                    }
                    Some(AcpSessionCommand::Abort) => {
                        let _ = acp_write(
                            &mut stdin,
                            &json!({
                                "jsonrpc": "2.0",
                                "method": "session/cancel",
                                "params": { "sessionId": session_id }
                            }),
                        ).await;
                        permission_params.clear();
                        if let Some(mut turn) = active.take() {
                            emit_protocol(&turn.sink, &conversation_id, turn.translator.finish(None));
                            let streamed = turn.translator.opened;
                            let _ = turn.outcome.send(CliTurnOutcome {
                                resume_id: Some(session_id.clone()),
                                messages: turn.translator.take_messages(),
                                aborted: true,
                                streamed,
                                resume_rejected: false,
                                error: None,
                            });
                        }
                    }
                    Some(AcpSessionCommand::Shutdown) | None => {
                        let _ = child.start_kill();
                        break;
                    }
                },
                line = reader.next_line() => {
                    let line = match line {
                        Ok(Some(line)) => line,
                        Ok(None) => break,
                        Err(error) => {
                            tracing::warn!("{} ACP stdout failed: {error}", backend.as_str());
                            break;
                        }
                    };
                    let Ok(value) = serde_json::from_str::<Value>(&line) else {
                        tracing::debug!("{} ACP non-JSON stdout: {line}", backend.as_str());
                        continue;
                    };
                    if value.get("method").and_then(Value::as_str) == Some("session/update") {
                        let Some(update) = value.pointer("/params/update") else { continue };
                        // Session-scoped, not turn-scoped: agents announce their
                        // slash commands right after session/new, when no turn
                        // is active yet.
                        if update.get("sessionUpdate").and_then(Value::as_str)
                            == Some("available_commands_update")
                        {
                            commands_event = Some(acp_commands_event(update));
                        }
                        if let Some(turn) = active.as_mut() {
                            let events = turn.translator.on_acp_update(update);
                            emit_protocol(&turn.sink, &conversation_id, events);
                        }
                        continue;
                    }
                    if value.get("method").and_then(Value::as_str)
                        == Some("session/request_permission")
                    {
                        let request_id = value.get("id").cloned().unwrap_or(Value::Null);
                        let params = value.get("params").cloned().unwrap_or(Value::Null);
                        if opts.bypass_approvals {
                            let result = acp_permission_response(&params, true);
                            let _ = acp_write(
                                &mut stdin,
                                &json!({ "jsonrpc": "2.0", "id": request_id, "result": result }),
                            ).await;
                        } else if let Some(turn) = active.as_ref() {
                            permission_params.insert(request_id.to_string(), params.clone());
                            // `{}` rather than null: the card renders the tool
                            // call straight from `input`.
                            let tool_call = params
                                .get("toolCall")
                                .filter(|value| value.is_object())
                                .cloned()
                                .unwrap_or_else(|| json!({}));
                            emit_protocol(
                                &turn.sink,
                                &conversation_id,
                                vec![json!({
                                    "type": "cli_control_request",
                                    "requestId": request_id,
                                    "source": "acp",
                                    "toolName": tool_call.get("title").and_then(Value::as_str).unwrap_or("tool"),
                                    "input": tool_call,
                                    "toolUseId": tool_call.get("toolCallId"),
                                    "suggestions": params.get("options"),
                                })],
                            );
                        } else {
                            // No turn owns this request, so nothing can ever
                            // answer it — cancel instead of blocking the agent.
                            acp_decline_request(&mut stdin, &value).await;
                        }
                        continue;
                    }
                    let response_id = value.get("id");
                    let is_prompt_response = active
                        .as_ref()
                        .is_some_and(|turn| response_id == Some(&turn.request_id));
                    if is_prompt_response {
                        let mut turn = active.take().expect("active turn exists");
                        // Requests the agent gave up on when the turn ended;
                        // their cards are already cleared by `agent_end`.
                        permission_params.clear();
                        let error = value
                            .get("error")
                            .map(Value::to_string)
                            .or_else(|| acp_stop_reason_error(&value));
                        emit_protocol(
                            &turn.sink,
                            &conversation_id,
                            turn.translator.finish(error.as_deref()),
                        );
                        let streamed = turn.translator.opened;
                        let _ = turn.outcome.send(CliTurnOutcome {
                            resume_id: Some(session_id.clone()),
                            messages: turn.translator.take_messages(),
                            aborted: false,
                            streamed,
                            resume_rejected: false,
                            error,
                        });
                        continue;
                    }
                    // We deliberately advertise no client filesystem/terminal
                    // capabilities. Reject unexpected reverse requests rather
                    // than leaving the agent waiting forever.
                    if value.get("method").is_some() && value.get("id").is_some() {
                        acp_decline_request(&mut stdin, &value).await;
                    }
                }
            }
        }
        if let Some(mut turn) = active {
            emit_protocol(
                &turn.sink,
                &conversation_id,
                turn.translator
                    .finish(Some("ACP process exited unexpectedly")),
            );
            let streamed = turn.translator.opened;
            let _ = turn.outcome.send(CliTurnOutcome {
                resume_id: Some(session_id),
                messages: turn.translator.take_messages(),
                aborted: false,
                streamed,
                resume_rejected: false,
                error: Some("ACP process exited unexpectedly".to_string()),
            });
        }
        let _ = child.wait().await;
    });

    Ok(handle)
}
