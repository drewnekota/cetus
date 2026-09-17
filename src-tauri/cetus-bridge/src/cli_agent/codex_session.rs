use super::{ActiveTurn, CliBackend, CliRunOpts, CliTurnOutcome, EventTranslator};
use crate::bridge::RuntimeEvent;
use crate::pi_rpc::EventSink;
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command as TokioCommand;

/// Handle to a conversation-scoped Codex app-server and thread.
#[derive(Clone)]
pub struct CodexSessionHandle {
    tx: tokio::sync::mpsc::UnboundedSender<CodexSessionCommand>,
}

enum CodexSessionCommand {
    StartTurn {
        prompt: String,
        images: Vec<String>,
        sink: Arc<dyn EventSink>,
        outcome: tokio::sync::oneshot::Sender<CliTurnOutcome>,
    },
    Steer {
        prompt: String,
        images: Vec<String>,
        message: Value,
    },
    Compact {
        reason: String,
        outcome: tokio::sync::oneshot::Sender<std::result::Result<(), String>>,
    },
    RespondToServerRequest {
        request_id: Value,
        response: Value,
    },
    InstallPluginAndRespond {
        request_id: Value,
        response: Value,
        plugin_name: String,
        remote_marketplace_name: String,
        outcome: tokio::sync::oneshot::Sender<std::result::Result<(), String>>,
    },
    AbortTurn,
    Shutdown,
}

impl CodexSessionHandle {
    pub fn start_turn(
        &self,
        prompt: String,
        images: Vec<String>,
        sink: Arc<dyn EventSink>,
    ) -> Result<tokio::sync::oneshot::Receiver<CliTurnOutcome>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.tx
            .send(CodexSessionCommand::StartTurn {
                prompt,
                images,
                sink,
                outcome: tx,
            })
            .map_err(|_| anyhow::anyhow!("Codex app-server has exited"))?;
        Ok(rx)
    }

    pub fn abort_turn(&self) {
        let _ = self.tx.send(CodexSessionCommand::AbortTurn);
    }

    pub fn steer(&self, prompt: String, images: Vec<String>, message: Value) -> Result<()> {
        self.tx
            .send(CodexSessionCommand::Steer {
                prompt,
                images,
                message,
            })
            .map_err(|_| anyhow::anyhow!("Codex app-server has exited"))
    }

    pub async fn compact(&self, reason: impl Into<String>) -> Result<()> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.tx
            .send(CodexSessionCommand::Compact {
                reason: reason.into(),
                outcome: tx,
            })
            .map_err(|_| anyhow::anyhow!("Codex app-server has exited"))?;
        rx.await
            .map_err(|_| anyhow::anyhow!("Codex app-server exited during compaction"))?
            .map_err(anyhow::Error::msg)
    }

    /// Answer a JSON-RPC request initiated by Codex app-server. Unlike normal
    /// item notifications these requests block the active turn until the host
    /// sends a response with the same (string or numeric) id.
    pub fn respond_to_server_request(&self, request_id: Value, response: Value) -> Result<()> {
        self.tx
            .send(CodexSessionCommand::RespondToServerRequest {
                request_id,
                response,
            })
            .map_err(|_| anyhow::anyhow!("Codex app-server has exited"))
    }

    /// Install a remote Codex plugin, then accept the elicitation that asked
    /// for it. Keeping both operations on this session preserves JSON-RPC
    /// ordering and prevents the model from verifying before installation has
    /// actually completed.
    pub async fn install_plugin_and_respond(
        &self,
        request_id: Value,
        response: Value,
        plugin_name: String,
        remote_marketplace_name: String,
    ) -> Result<()> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.tx
            .send(CodexSessionCommand::InstallPluginAndRespond {
                request_id,
                response,
                plugin_name,
                remote_marketplace_name,
                outcome: tx,
            })
            .map_err(|_| anyhow::anyhow!("Codex app-server has exited"))?;
        rx.await
            .map_err(|_| anyhow::anyhow!("Codex app-server exited during plugin installation"))?
            .map_err(anyhow::Error::msg)
    }

    pub fn shutdown(&self) {
        let _ = self.tx.send(CodexSessionCommand::Shutdown);
    }

    pub fn is_alive(&self) -> bool {
        !self.tx.is_closed()
    }
}

async fn write_json_line(stdin: &mut tokio::process::ChildStdin, value: &Value) -> Result<()> {
    stdin.write_all(value.to_string().as_bytes()).await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await?;
    Ok(())
}

async fn read_rpc_response(
    reader: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    id: u64,
) -> Result<Value> {
    while let Some(line) = reader.next_line().await? {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("id").and_then(Value::as_u64) == Some(id) {
            if let Some(error) = value.get("error") {
                anyhow::bail!("Codex app-server request failed: {error}");
            }
            return Ok(value.get("result").cloned().unwrap_or(Value::Null));
        }
    }
    anyhow::bail!("Codex app-server closed before replying")
}

pub(super) fn codex_skill_commands(result: &Value) -> Vec<Value> {
    let mut seen = HashSet::new();
    result
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|entry| {
            entry
                .get("skills")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter(|skill| {
            skill
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true)
        })
        .filter_map(|skill| {
            let name = skill.get("name").and_then(Value::as_str)?;
            if !seen.insert(name.to_lowercase()) {
                return None;
            }
            Some(json!({
                "name": name,
                "description": skill
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                "argumentHint": "",
                "kind": "skill",
            }))
        })
        .collect()
}

/// Read Codex's workspace-aware skill catalog without creating a thread.
///
/// `skills/list` is available immediately after the app-server initialize
/// handshake, so new-chat surfaces can prewarm their slash menu without
/// polluting Codex's saved thread inventory.
pub async fn probe_codex_skills(bin: &str, cwd: &Path, force_reload: bool) -> Result<Vec<Value>> {
    let mut cmd = TokioCommand::new(bin);
    cmd.args(["app-server", "--listen", "stdio://"])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .with_context(|| format!("failed to launch `{bin} app-server` for skill discovery"))?;
    let mut stdin = child
        .stdin
        .take()
        .context("Codex app-server stdin missing")?;
    let stdout = child
        .stdout
        .take()
        .context("Codex app-server stdout missing")?;
    let mut reader = BufReader::new(stdout).lines();
    let cwd_string = cwd.to_string_lossy().into_owned();

    let result = tokio::time::timeout(Duration::from_secs(10), async {
        write_json_line(
            &mut stdin,
            &json!({
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": {
                        "name": "cetus",
                        "title": "Cetus",
                        "version": "0.1.0"
                    },
                    "capabilities": {
                        "experimentalApi": true,
                        "requestAttestation": false
                    }
                }
            }),
        )
        .await?;
        read_rpc_response(&mut reader, 1).await?;
        write_json_line(&mut stdin, &json!({ "method": "initialized" })).await?;
        write_json_line(
            &mut stdin,
            &json!({
                "id": 2,
                "method": "skills/list",
                "params": {
                    "cwds": [cwd_string],
                    "forceReload": force_reload,
                }
            }),
        )
        .await?;
        let skills = read_rpc_response(&mut reader, 2).await?;
        Ok::<_, anyhow::Error>(codex_skill_commands(&skills))
    })
    .await
    .context("Codex skills/list probe timed out")?;

    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}

pub(super) fn codex_text_phase(item: &Value) -> Option<&str> {
    item.get("phase")
        .and_then(Value::as_str)
        .filter(|phase| matches!(*phase, "commentary" | "final_answer"))
}

pub(super) fn normalize_codex_app_item(mut item: Value) -> Value {
    let Some(object) = item.as_object_mut() else {
        return item;
    };
    if let Some(kind) = object.get("type").and_then(Value::as_str) {
        let normalized = match kind {
            "userMessage" => "user_message",
            "commandExecution" => "command_execution",
            "agentMessage" => "agent_message",
            "fileChange" => "file_change",
            "mcpToolCall" => "mcp_tool_call",
            "dynamicToolCall" => "dynamic_tool_call",
            "imageGeneration" => "image_generation",
            "collabAgentToolCall" => "collab_agent_tool_call",
            "webSearch" => "web_search",
            "imageView" => "image_view",
            "subAgentActivity" => "subagent_activity",
            "enteredReviewMode" => "entered_review_mode",
            "exitedReviewMode" => "exited_review_mode",
            "contextCompaction" => "context_compaction",
            other => other,
        };
        if normalized != kind {
            object.insert("type".to_string(), json!(normalized));
        }
    }
    for (camel, snake) in [
        ("aggregatedOutput", "aggregated_output"),
        ("exitCode", "exit_code"),
        ("agentsStates", "agents_states"),
        ("receiverThreadIds", "receiver_thread_ids"),
        ("senderThreadId", "sender_thread_id"),
        ("contentItems", "content_items"),
        ("savedPath", "saved_path"),
    ] {
        if let Some(value) = object.remove(camel) {
            object.insert(snake.to_string(), value);
        }
    }
    item
}

fn normalize_codex_app_delta(method: &str, params: &Value) -> Option<Value> {
    let item_id = params
        .get("itemId")
        .or_else(|| params.get("item_id"))
        .and_then(Value::as_str)?;
    let delta = params.get("delta").and_then(Value::as_str).unwrap_or("");
    let ty = match method {
        "item/agentMessage/delta" => "item.agent_message.delta",
        "item/reasoning/summaryTextDelta" => "item.reasoning.summary_delta",
        "item/reasoning/textDelta" => "item.reasoning.text_delta",
        "item/plan/delta" => "item.plan.delta",
        "item/commandExecution/outputDelta" | "item/fileChange/outputDelta" => {
            "item.tool_output.delta"
        }
        _ => return None,
    };
    Some(json!({
        "type": ty,
        "item_id": item_id,
        "delta": delta,
        "summary_index": params.get("summaryIndex").or_else(|| params.get("summary_index")),
        "content_index": params.get("contentIndex").or_else(|| params.get("content_index")),
    }))
}

pub(super) fn codex_context_event(params: &Value, transcript_bytes: usize) -> Option<Value> {
    let usage = params
        .get("tokenUsage")
        .or_else(|| params.get("token_usage"))?;
    let used_tokens = usage
        .pointer("/last/totalTokens")
        .or_else(|| usage.pointer("/last/total_tokens"))
        .and_then(Value::as_u64)?;
    let context_window = usage
        .get("modelContextWindow")
        .or_else(|| usage.get("model_context_window"))
        .and_then(Value::as_u64)?;
    Some(json!({
        "type": "cli_context_usage",
        "usedTokens": used_tokens,
        "contextWindow": context_window,
        "transcriptBytes": transcript_bytes,
    }))
}

/// Adapt app-server's account quota snapshot to the small cross-runtime shape
/// consumed by Cetus. Codex reports integer percentages while Claude reports a
/// 0..1 utilization fraction.
pub(super) fn codex_rate_limit_event(params: &Value, cached: &mut Value) -> Option<Value> {
    let snapshot = params
        .get("rateLimits")
        .or_else(|| params.get("rate_limits"))?;
    // The runtime-wide quota represents the standard Codex pool. Separate
    // model pools must not overwrite it just because their update arrived last.
    if snapshot
        .get("limitId")
        .or_else(|| snapshot.get("limit_id"))
        .and_then(Value::as_str)
        .is_some_and(|id| id != "codex")
    {
        return None;
    }
    if !cached.is_object() {
        *cached = json!({});
    }
    // Rolling notifications are sparse: an unavailable window does not clear
    // the last observation of it.
    for key in ["primary", "secondary"] {
        if let Some(window) = snapshot.get(key).filter(|w| w.is_object()) {
            cached[key] = window.clone();
        }
    }
    let (window, used_percent) = ["primary", "secondary"]
        .iter()
        .filter_map(|key| {
            let window = cached.get(*key)?;
            let used = window
                .get("usedPercent")
                .or_else(|| window.get("used_percent"))?
                .as_f64()?;
            Some((window, used))
        })
        .max_by(|a, b| a.1.total_cmp(&b.1))?;
    let duration = window
        .get("windowDurationMins")
        .or_else(|| window.get("window_duration_mins"))
        .and_then(Value::as_i64);
    let window_label = match duration {
        Some(300) => Some("five_hour".to_owned()),
        Some(10080) => Some("seven_day".to_owned()),
        Some(mins) if mins > 0 && mins % 1440 == 0 => Some(format!("{}d", mins / 1440)),
        Some(mins) if mins > 0 && mins % 60 == 0 => Some(format!("{}h", mins / 60)),
        Some(mins) if mins > 0 => Some(format!("{mins}m")),
        _ => None,
    };
    let status = if used_percent >= 100.0 {
        "rejected"
    } else if used_percent >= 80.0 {
        "allowed_warning"
    } else {
        "allowed"
    };
    Some(json!({
        "type": "cli_rate_limit",
        "backend": "codex",
        "info": {
            "status": status,
            "utilization": used_percent / 100.0,
            "resetsAt": window
                .get("resetsAt")
                .or_else(|| window.get("resets_at")),
            "rateLimitType": window_label,
        }
    }))
}

const CODEX_PROACTIVE_COMPACT_RATIO: f64 = 0.82;
const CODEX_TRANSCRIPT_COMPACT_BYTES: usize = 64 * 1024 * 1024;

fn codex_user_input(prompt: String, images: Vec<String>) -> Vec<Value> {
    let mut input = vec![json!({ "type": "text", "text": prompt, "text_elements": [] })];
    input.extend(
        images
            .into_iter()
            .map(|path| json!({ "type": "localImage", "path": path })),
    );
    input
}

async fn start_codex_turn_request(
    stdin: &mut tokio::process::ChildStdin,
    next_id: &mut u64,
    thread_id: &str,
    prompt: String,
    images: Vec<String>,
    effort: Option<&str>,
) -> Result<()> {
    let id = *next_id;
    *next_id += 1;
    let mut params = json!({
        "threadId": thread_id,
        "input": codex_user_input(prompt, images),
    });
    if let Some(effort) = effort {
        params["effort"] = json!(effort);
    }
    write_json_line(
        stdin,
        &json!({ "id": id, "method": "turn/start", "params": params }),
    )
    .await
}

async fn start_codex_compaction_request(
    stdin: &mut tokio::process::ChildStdin,
    next_id: &mut u64,
    thread_id: &str,
) -> Result<u64> {
    let id = *next_id;
    *next_id += 1;
    write_json_line(
        stdin,
        &json!({
            "id": id,
            "method": "thread/compact/start",
            "params": { "threadId": thread_id },
        }),
    )
    .await?;
    Ok(id)
}

/// How long a Codex tool-suggestion elicitation (an optional plugin-install
/// prompt) may hold a turn open before Cetus declines it on the user's behalf.
/// Substantive requests (`request_user_input`, form elicitations) are never
/// auto-answered — only suggestions Codex can proceed without.
#[cfg(not(test))]
const TOOL_SUGGESTION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
#[cfg(test)]
const TOOL_SUGGESTION_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(300);

/// Spawn Codex's persistent app-server embedding surface and create or resume
/// one thread. Unlike `codex exec`, app-server owns background terminals after
/// `turn/completed`, which is the lifecycle the Codex desktop app uses.
pub fn spawn_codex_session(
    base_sink: Arc<dyn EventSink>,
    bin: &str,
    cwd: &Path,
    artifact_dir: Option<PathBuf>,
    conversation_id: Option<String>,
    extra_env: Vec<(String, String)>,
    opts: CliRunOpts,
) -> Result<CodexSessionHandle> {
    let translator_cwd = cwd.to_path_buf();
    let mut cmd = TokioCommand::new(bin);
    cmd.args(["app-server", "--listen", "stdio://"])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let mut child = cmd
        .spawn()
        .with_context(|| format!("failed to launch `{bin} app-server`"))?;
    let mut stdin = child
        .stdin
        .take()
        .context("Codex app-server stdin missing")?;
    let stdout = child
        .stdout
        .take()
        .context("Codex app-server stdout missing")?;
    let stderr = child.stderr.take();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let handle = CodexSessionHandle { tx };
    let cwd_string = cwd.to_string_lossy().into_owned();

    tokio::spawn(async move {
        let emit = |sink: &Arc<dyn EventSink>, events: Vec<Value>| {
            for event in events {
                sink.emit(RuntimeEvent::Protocol {
                    conversation_id: conversation_id.clone(),
                    event,
                });
            }
        };
        // Keep the tail of app-server's stderr around: when startup fails the
        // JSON-RPC error is often generic ("stream closed") while the real
        // cause (auth, config parse, panic) only ever hit stderr — which
        // `tracing::debug!` used to drop on packaged builds.
        let stderr_tail: Arc<std::sync::Mutex<std::collections::VecDeque<String>>> =
            Arc::new(std::sync::Mutex::new(std::collections::VecDeque::new()));
        if let Some(stderr) = stderr {
            let tail = stderr_tail.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!("codex app-server: {line}");
                    let mut tail = tail.lock().unwrap();
                    if tail.len() >= 100 {
                        tail.pop_front();
                    }
                    tail.push_back(line);
                }
            });
        }
        let mut reader = BufReader::new(stdout).lines();
        let initialized = async {
            write_json_line(
                &mut stdin,
                &json!({
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "clientInfo": { "name": "cetus", "title": "Cetus", "version": "0.1.0" },
                        "capabilities": { "experimentalApi": true, "requestAttestation": false }
                    }
                }),
            )
            .await?;
            read_rpc_response(&mut reader, 1).await?;
            write_json_line(&mut stdin, &json!({ "method": "initialized" })).await?;

            let policy = if opts.bypass_approvals {
                "danger-full-access"
            } else {
                "workspace-write"
            };
            let method = if opts.resume.is_some() {
                "thread/resume"
            } else {
                "thread/start"
            };
            let mut params = json!({
                "cwd": cwd_string.clone(),
                "approvalPolicy": "never",
                "sandbox": policy,
                "threadSource": "appServer",
            });
            if let Some(resume) = &opts.resume {
                params["threadId"] = json!(resume);
                params["excludeTurns"] = json!(true);
            }
            if let Some(model) = &opts.model {
                params["model"] = json!(model);
            }
            write_json_line(
                &mut stdin,
                &json!({ "id": 2, "method": method, "params": params }),
            )
            .await?;
            let result = read_rpc_response(&mut reader, 2).await?;
            let thread_id = result
                .pointer("/thread/id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| anyhow::anyhow!("Codex app-server returned no thread id"))?;

            write_json_line(
                &mut stdin,
                &json!({
                    "id": 3,
                    "method": "skills/list",
                    "params": { "cwds": [cwd_string.clone()], "forceReload": false },
                }),
            )
            .await?;
            let skill_commands = match tokio::time::timeout(
                Duration::from_secs(5),
                read_rpc_response(&mut reader, 3),
            )
            .await
            {
                Ok(Ok(result)) => codex_skill_commands(&result),
                Ok(Err(error)) => {
                    tracing::warn!("Codex skills/list failed during startup: {error}");
                    Vec::new()
                }
                Err(_) => {
                    tracing::warn!("Codex skills/list timed out during startup");
                    Vec::new()
                }
            };
            Ok::<_, anyhow::Error>((thread_id, skill_commands))
        }
        .await;

        let (thread_id, skill_commands) = match initialized {
            Ok(initialized) => initialized,
            Err(error) => {
                // Give stderr a beat to drain, then fold its tail into the
                // error so the UI (and the log file) carry the real cause,
                // not just the broken-pipe symptom.
                tokio::time::sleep(Duration::from_millis(200)).await;
                let tail: Vec<String> = {
                    let tail = stderr_tail.lock().unwrap();
                    tail.iter().rev().take(12).rev().cloned().collect()
                };
                let error = if tail.is_empty() {
                    error.to_string()
                } else {
                    format!("{error}\n[codex stderr]\n{}", tail.join("\n"))
                };
                tracing::warn!("codex app-server startup failed: {error}");
                match rx.recv().await {
                    Some(CodexSessionCommand::StartTurn { sink, outcome, .. }) => {
                        let mut tr = EventTranslator::new(CliBackend::Codex);
                        if let Some(dir) = artifact_dir.clone() {
                            tr = tr.with_artifact_storage(dir, translator_cwd.clone());
                        }
                        emit(&sink, tr.start());
                        emit(&sink, tr.finish(Some(&error)));
                        let _ = outcome.send(CliTurnOutcome {
                            resume_id: None,
                            messages: tr.take_messages(),
                            aborted: false,
                            streamed: tr.opened,
                            resume_rejected: opts.resume.is_some(),
                            error: Some(error.clone()),
                        });
                    }
                    Some(CodexSessionCommand::Compact { outcome, .. }) => {
                        let _ = outcome.send(Err(error.to_string()));
                    }
                    _ => {}
                }
                let _ = child.start_kill();
                let _ = child.wait().await;
                return;
            }
        };

        let mut next_id = 10u64;
        let mut tr = EventTranslator::new(CliBackend::Codex);
        if let Some(dir) = artifact_dir {
            tr = tr.with_artifact_storage(dir, translator_cwd);
        }
        tr.resume_id = Some(thread_id.clone());
        emit(
            &base_sink,
            vec![json!({ "type": "cli_commands", "commands": skill_commands })],
        );
        let mut active: Option<ActiveTurn> = None;
        let mut active_turn_id: Option<String> = None;
        let mut pending_turn: Option<(
            String,
            Vec<String>,
            Arc<dyn EventSink>,
            tokio::sync::oneshot::Sender<CliTurnOutcome>,
        )> = None;
        let mut compacting = false;
        let mut compaction_announced = false;
        let mut compact_reason = String::new();
        let mut pending_compact_requests: HashMap<
            u64,
            tokio::sync::oneshot::Sender<std::result::Result<(), String>>,
        > = HashMap::new();
        let mut pending_auto_compact_requests = HashSet::new();
        let mut transcript_bytes = 0usize;
        let mut codex_quota = json!({});
        let mut transcript_bytes_at_compaction = 0usize;
        let mut context_used = 0u64;
        let mut context_window = 0u64;
        let mut proactive_compact_due = false;
        let mut pending_plugin_installs: HashMap<
            u64,
            (
                Value,
                Value,
                tokio::sync::oneshot::Sender<std::result::Result<(), String>>,
            ),
        > = HashMap::new();
        // Optional tool-suggestion elicitations (plugin-install prompts) block
        // the whole turn until answered, but nobody may ever answer one: a
        // scheduled run has no user watching, and an interactive card lives
        // only in the webview's memory, so a reload loses it while Codex keeps
        // waiting. Track each suggestion and auto-decline past its deadline —
        // Codex then continues with its non-plugin fallback instead of wedging.
        let mut pending_tool_suggestions: Vec<(Value, tokio::time::Instant)> = Vec::new();
        let mut pending_skills_request: Option<u64> = None;

        loop {
            let suggestion_deadline = pending_tool_suggestions.iter().map(|(_, at)| *at).min();
            tokio::select! {
                command = rx.recv() => match command {
                    Some(CodexSessionCommand::StartTurn { prompt, images, sink, outcome }) => {
                        if active.is_some() || pending_turn.is_some() {
                            let _ = outcome.send(CliTurnOutcome {
                                resume_id: Some(thread_id.clone()), messages: Vec::new(),
                                aborted: false, streamed: false, resume_rejected: false,
                                error: None,
                            });
                            continue;
                        }
                        if compacting {
                            pending_turn = Some((prompt, images, sink, outcome));
                            continue;
                        }
                        tr.begin_next_turn();
                        emit(&sink, tr.start());
                        if let Err(error) = start_codex_turn_request(
                            &mut stdin,
                            &mut next_id,
                            &thread_id,
                            prompt,
                            images,
                            opts.effort.as_deref(),
                        ).await {
                            emit(&sink, tr.finish(Some(&error.to_string())));
                            let _ = outcome.send(CliTurnOutcome {
                                resume_id: Some(thread_id.clone()), messages: tr.take_messages(),
                                aborted: false, streamed: tr.opened, resume_rejected: false,
                                error: Some(error.to_string()),
                            });
                            break;
                        }
                        active = Some(ActiveTurn { sink, outcome });
                    }
                    Some(CodexSessionCommand::Steer { prompt, images, message }) => {
                        let Some(turn_id) = active_turn_id.as_deref() else {
                            emit(&base_sink, vec![json!({
                                "type": "error",
                                "message": "Codex turn is no longer steerable; queue the message for the next turn",
                            })]);
                            continue;
                        };
                        if active.is_none() || compacting {
                            emit(&base_sink, vec![json!({
                                "type": "error",
                                "message": "Codex is compacting or settling; queue the message for the next turn",
                            })]);
                            continue;
                        }
                        let id = next_id;
                        next_id += 1;
                        let request = json!({
                            "id": id,
                            "method": "turn/steer",
                            "params": {
                                "threadId": thread_id,
                                "expectedTurnId": turn_id,
                                "clientUserMessageId": format!("cetus-steer-{id}"),
                                "input": codex_user_input(prompt, images),
                            },
                        });
                        match write_json_line(&mut stdin, &request).await {
                            Ok(()) => tr.queue_steer(message),
                            Err(error) => emit(&base_sink, vec![json!({
                                "type": "error",
                                "message": format!("Codex steer failed: {error}"),
                            })]),
                        }
                    }
                    Some(CodexSessionCommand::Compact { reason, outcome }) => {
                        if active.is_some() || pending_turn.is_some() {
                            let _ = outcome.send(Err(
                                "wait for the active Codex turn to finish before compacting".into(),
                            ));
                            continue;
                        }
                        if compacting {
                            let _ = outcome.send(Ok(()));
                            continue;
                        }
                        match start_codex_compaction_request(
                            &mut stdin,
                            &mut next_id,
                            &thread_id,
                        ).await {
                            Ok(id) => {
                                compacting = true;
                                compact_reason = reason;
                                compaction_announced = true;
                                pending_compact_requests.insert(id, outcome);
                                emit(&base_sink, vec![json!({
                                    "type": "compaction_start",
                                    "reason": compact_reason,
                                })]);
                            }
                            Err(error) => {
                                let _ = outcome.send(Err(error.to_string()));
                            }
                        }
                    }
                    Some(CodexSessionCommand::RespondToServerRequest { request_id, response }) => {
                        // Server requests are ordinary JSON-RPC in the reverse
                        // direction: echo the original id and place the user's
                        // answer under `result`.
                        pending_tool_suggestions.retain(|(id, _)| id != &request_id);
                        if let Err(error) = write_json_line(
                            &mut stdin,
                            &json!({ "id": request_id, "result": response }),
                        ).await {
                            tracing::warn!("failed to answer Codex server request: {error}");
                        }
                    }
                    Some(CodexSessionCommand::InstallPluginAndRespond {
                        request_id,
                        response,
                        plugin_name,
                        remote_marketplace_name,
                        outcome,
                    }) => {
                        pending_tool_suggestions.retain(|(id, _)| id != &request_id);
                        let id = next_id;
                        next_id += 1;
                        let request = json!({
                            "id": id,
                            "method": "plugin/install",
                            "params": {
                                "pluginName": plugin_name,
                                "remoteMarketplaceName": remote_marketplace_name,
                            },
                        });
                        match write_json_line(&mut stdin, &request).await {
                            Ok(()) => {
                                pending_plugin_installs.insert(
                                    id,
                                    (request_id, response, outcome),
                                );
                            }
                            Err(error) => {
                                let _ = outcome.send(Err(error.to_string()));
                            }
                        }
                    }
                    Some(CodexSessionCommand::AbortTurn) => {
                        if let Some(turn_id) = &active_turn_id {
                            let id = next_id; next_id += 1;
                            let _ = write_json_line(&mut stdin, &json!({
                                "id": id, "method": "turn/interrupt",
                                "params": { "threadId": thread_id, "turnId": turn_id }
                            })).await;
                        }
                    }
                    Some(CodexSessionCommand::Shutdown) | None => {
                        let _ = child.start_kill();
                        break;
                    }
                },
                // A tool suggestion went unanswered for its whole grace period:
                // decline it so the turn resumes, and clear any visible card.
                _ = async {
                    match suggestion_deadline {
                        Some(at) => tokio::time::sleep_until(at).await,
                        None => std::future::pending().await,
                    }
                } => {
                    let now = tokio::time::Instant::now();
                    let mut expired = Vec::new();
                    pending_tool_suggestions.retain(|(request_id, at)| {
                        if *at <= now {
                            expired.push(request_id.clone());
                            false
                        } else {
                            true
                        }
                    });
                    for request_id in expired {
                        tracing::info!(
                            "auto-declining unanswered Codex tool suggestion {request_id}"
                        );
                        let _ = write_json_line(&mut stdin, &json!({
                            "id": request_id,
                            "result": { "action": "decline", "content": null, "_meta": null },
                        })).await;
                        let sink = active.as_ref().map(|a| &a.sink).unwrap_or(&base_sink);
                        emit(sink, vec![json!({
                            "type": "cli_control_resolved",
                            "requestId": request_id,
                            "source": "codex",
                        })]);
                    }
                }
                line = reader.next_line() => {
                    let line = match line { Ok(Some(line)) => line, _ => break };
                    transcript_bytes = transcript_bytes.saturating_add(line.len());
                    if transcript_bytes.saturating_sub(transcript_bytes_at_compaction)
                        >= CODEX_TRANSCRIPT_COMPACT_BYTES
                    {
                        proactive_compact_due = true;
                    }
                    let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
                    // app-server can initiate JSON-RPC requests that require a
                    // client response. Dropping one silently wedges the turn:
                    // request_plugin_install, for example, arrives as an MCP
                    // elicitation and waits indefinitely for accept/decline.
                    if let (Some(request_id), Some(method)) = (
                        value.get("id").cloned(),
                        value.get("method").and_then(Value::as_str),
                    ) {
                        let params = value.get("params").cloned().unwrap_or(Value::Null);
                        let sink = active.as_ref().map(|a| &a.sink).unwrap_or(&base_sink);
                        match method {
                            "item/tool/requestUserInput" => {
                                let tool_use_id = params
                                    .get("itemId")
                                    .cloned()
                                    .unwrap_or(Value::Null);
                                emit(sink, vec![json!({
                                    "type": "cli_control_request",
                                    "requestId": request_id,
                                    "source": "codex",
                                    "requestKind": "request_user_input",
                                    "toolName": "request_user_input",
                                    "input": params,
                                    "toolUseId": tool_use_id,
                                })]);
                            }
                            "mcpServer/elicitation/request" => {
                                let tool_name = params
                                    .pointer("/_meta/tool_name")
                                    .or_else(|| params.pointer("/_meta/toolName"))
                                    .or_else(|| params.get("serverName"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("Codex")
                                    .to_string();
                                // Optional suggestion (Codex proceeds fine when
                                // declined) → eligible for auto-decline if no
                                // one answers the card in time.
                                if params.pointer("/_meta/codex_approval_kind")
                                    .and_then(Value::as_str)
                                    == Some("tool_suggestion")
                                {
                                    pending_tool_suggestions.push((
                                        request_id.clone(),
                                        tokio::time::Instant::now() + TOOL_SUGGESTION_TIMEOUT,
                                    ));
                                }
                                emit(sink, vec![json!({
                                    "type": "cli_control_request",
                                    "requestId": request_id,
                                    "source": "codex",
                                    "requestKind": "mcp_elicitation",
                                    "toolName": tool_name,
                                    "input": params,
                                    "toolUseId": Value::Null,
                                })]);
                            }
                            "currentTime/read" => {
                                let now = std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .map(|duration| duration.as_secs())
                                    .unwrap_or_default();
                                let _ = write_json_line(
                                    &mut stdin,
                                    &json!({ "id": request_id, "result": { "currentTimeAt": now } }),
                                ).await;
                            }
                            _ => {
                                // Never leave a new protocol request pending
                                // forever. A JSON-RPC error lets Codex fail the
                                // tool cleanly and finish the turn.
                                let _ = write_json_line(
                                    &mut stdin,
                                    &json!({
                                        "id": request_id,
                                        "error": {
                                            "code": -32601,
                                            "message": format!("Cetus does not support Codex server request `{method}`"),
                                        },
                                    }),
                                ).await;
                            }
                        }
                        continue;
                    }
                    if let Some(response_id) = value.get("id").and_then(Value::as_u64) {
                        if pending_auto_compact_requests.remove(&response_id) {
                            if value.get("error").is_some() {
                                compacting = false;
                                proactive_compact_due = false;
                                compaction_announced = false;
                                emit(&base_sink, vec![json!({
                                    "type": "compaction_end",
                                    "reason": compact_reason,
                                    "aborted": true,
                                })]);
                            }
                            continue;
                        }
                        if let Some(outcome) = pending_compact_requests.remove(&response_id) {
                            if let Some(error) = value.get("error") {
                                compacting = false;
                                proactive_compact_due = false;
                                compaction_announced = false;
                                let message = error
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("Codex compaction failed")
                                    .to_string();
                                emit(&base_sink, vec![json!({
                                    "type": "compaction_end",
                                    "reason": compact_reason,
                                    "aborted": true,
                                })]);
                                let _ = outcome.send(Err(message));
                            } else {
                                let _ = outcome.send(Ok(()));
                            }
                            continue;
                        }
                        if pending_skills_request == Some(response_id) {
                            pending_skills_request = None;
                            if let Some(result) = value.get("result") {
                                let sink =
                                    active.as_ref().map(|turn| &turn.sink).unwrap_or(&base_sink);
                                emit(
                                    sink,
                                    vec![json!({
                                        "type": "cli_commands",
                                        "commands": codex_skill_commands(result),
                                    })],
                                );
                            }
                            continue;
                        }
                        if let Some((request_id, response, outcome)) =
                            pending_plugin_installs.remove(&response_id)
                        {
                            if let Some(error) = value.get("error") {
                                let _ = outcome.send(Err(format!(
                                    "Codex plugin installation failed: {error}"
                                )));
                            } else {
                                match write_json_line(
                                    &mut stdin,
                                    &json!({ "id": request_id, "result": response }),
                                ).await {
                                    Ok(()) => {
                                        let _ = outcome.send(Ok(()));
                                    }
                                    Err(error) => {
                                        let _ = outcome.send(Err(error.to_string()));
                                    }
                                }
                            }
                            continue;
                        }
                    }
                    if let Some(result) = value.get("result") {
                        if let Some(id) = result.pointer("/turn/id").and_then(Value::as_str) {
                            active_turn_id = Some(id.to_string());
                        }
                        continue;
                    }
                    let method = value.get("method").and_then(Value::as_str).unwrap_or("");
                    let params = value.get("params").cloned().unwrap_or(Value::Null);
                    let sink = active.as_ref().map(|a| &a.sink).unwrap_or(&base_sink);
                    match method {
                        "skills/changed" => {
                            if pending_skills_request.is_none() {
                                let id = next_id;
                                next_id += 1;
                                if write_json_line(
                                    &mut stdin,
                                    &json!({
                                        "id": id,
                                        "method": "skills/list",
                                        "params": {
                                            "cwds": [cwd_string.clone()],
                                            "forceReload": true,
                                        },
                                    }),
                                )
                                .await
                                .is_ok()
                                {
                                    pending_skills_request = Some(id);
                                }
                            }
                        }
                        "item/started" | "item/completed" => {
                            let completed = method.ends_with("completed");
                            let ty = if completed { "item.completed" } else { "item.started" };
                            let item = normalize_codex_app_item(
                                params.get("item").cloned().unwrap_or(Value::Null),
                            );
                            if item.get("type").and_then(Value::as_str)
                                == Some("context_compaction")
                            {
                                if !compaction_announced {
                                    compact_reason = if proactive_compact_due {
                                        "automatic safeguard".into()
                                    } else {
                                        "Codex auto-compact".into()
                                    };
                                    compaction_announced = true;
                                    emit(&base_sink, vec![json!({
                                        "type": "compaction_start",
                                        "reason": compact_reason,
                                    })]);
                                }
                                compacting = true;
                                if completed {
                                    compacting = false;
                                    compaction_announced = false;
                                    proactive_compact_due = false;
                                    transcript_bytes_at_compaction = transcript_bytes;
                                    emit(&base_sink, vec![json!({
                                        "type": "compaction_end",
                                        "reason": compact_reason,
                                        "aborted": false,
                                    })]);
                                    if let Some((prompt, images, sink, outcome)) = pending_turn.take() {
                                        tr.begin_next_turn();
                                        emit(&sink, tr.start());
                                        if let Err(error) = start_codex_turn_request(
                                            &mut stdin,
                                            &mut next_id,
                                            &thread_id,
                                            prompt,
                                            images,
                                            opts.effort.as_deref(),
                                        ).await {
                                            emit(&sink, tr.finish(Some(&error.to_string())));
                                            let _ = outcome.send(CliTurnOutcome {
                                                resume_id: Some(thread_id.clone()),
                                                messages: tr.take_messages(),
                                                aborted: false,
                                                streamed: tr.opened,
                                                resume_rejected: false,
                                                error: Some(error.to_string()),
                                            });
                                        } else {
                                            active = Some(ActiveTurn { sink, outcome });
                                        }
                                    }
                                }
                                continue;
                            }
                            let events = tr.on_line(&json!({ "type": ty, "item": item }).to_string());
                            if !events.is_empty() { emit(sink, events); }
                        }
                        "item/agentMessage/delta"
                        | "item/reasoning/summaryTextDelta"
                        | "item/reasoning/textDelta"
                        | "item/plan/delta"
                        | "item/commandExecution/outputDelta"
                        | "item/fileChange/outputDelta" => {
                            if let Some(delta) = normalize_codex_app_delta(method, &params) {
                                let events = tr.on_line(&delta.to_string());
                                if !events.is_empty() { emit(sink, events); }
                            }
                        }
                        "thread/tokenUsage/updated" => {
                            if let Some(usage) =
                                params.get("tokenUsage").or_else(|| params.get("token_usage"))
                            {
                                context_used = usage
                                    .pointer("/last/totalTokens")
                                    .or_else(|| usage.pointer("/last/total_tokens"))
                                    .and_then(Value::as_u64)
                                    .unwrap_or(context_used);
                                context_window = usage
                                    .get("modelContextWindow")
                                    .or_else(|| usage.get("model_context_window"))
                                    .and_then(Value::as_u64)
                                    .unwrap_or(context_window);
                                if context_window > 0
                                    && (context_used as f64 / context_window as f64)
                                        >= CODEX_PROACTIVE_COMPACT_RATIO
                                {
                                    proactive_compact_due = true;
                                }
                            }
                            if let Some(event) = codex_context_event(&params, transcript_bytes) {
                                emit(sink, vec![event]);
                            }
                        }
                        "account/rateLimits/updated" => {
                            if let Some(event) = codex_rate_limit_event(&params, &mut codex_quota) {
                                emit(sink, vec![event]);
                            }
                        }
                        "turn/completed" => {
                            // Whatever suggestions the turn left open died with
                            // it — Codex resolves them on interrupt, but don't
                            // depend on that ordering.
                            pending_tool_suggestions.clear();
                            let Some(turn) = active.take() else { continue };
                            let status = params.pointer("/turn/status").and_then(Value::as_str).unwrap_or("completed");
                            let error = params.pointer("/turn/error/message").and_then(Value::as_str)
                                .map(str::to_string)
                                .or_else(|| (status == "failed").then(|| "Codex turn failed".to_string()));
                            if let Some(error) = &error {
                                tracing::warn!("codex turn failed: {error}");
                            }
                            emit(&turn.sink, tr.finish(error.as_deref()));
                            let streamed = tr.opened;
                            let _ = turn.outcome.send(CliTurnOutcome {
                                resume_id: Some(thread_id.clone()), messages: tr.take_messages(),
                                aborted: status == "interrupted", streamed, resume_rejected: false,
                                error,
                            });
                            active_turn_id = None;
                            if proactive_compact_due && !compacting {
                                compact_reason = if context_window > 0
                                    && (context_used as f64 / context_window as f64)
                                        >= CODEX_PROACTIVE_COMPACT_RATIO
                                {
                                    "context above 82%".into()
                                } else {
                                    "transcript grew by 64 MB".into()
                                };
                                match start_codex_compaction_request(
                                    &mut stdin,
                                    &mut next_id,
                                    &thread_id,
                                ).await {
                                    Ok(id) => {
                                        pending_auto_compact_requests.insert(id);
                                        compacting = true;
                                        compaction_announced = true;
                                        emit(&base_sink, vec![json!({
                                            "type": "compaction_start",
                                            "reason": compact_reason,
                                        })]);
                                    }
                                    Err(error) => {
                                        proactive_compact_due = false;
                                        tracing::warn!("proactive Codex compaction failed: {error}");
                                    }
                                }
                            }
                        }
                        "serverRequest/resolved" => {
                            if let Some(request_id) = params
                                .get("requestId")
                                .or_else(|| params.get("request_id"))
                                .cloned()
                            {
                                pending_tool_suggestions.retain(|(id, _)| id != &request_id);
                                emit(sink, vec![json!({
                                    "type": "cli_control_resolved",
                                    "requestId": request_id,
                                    "source": "codex",
                                })]);
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        if let Some(turn) = active.take() {
            emit(
                &turn.sink,
                tr.finish(Some("Codex app-server exited unexpectedly")),
            );
            let streamed = tr.opened;
            let _ = turn.outcome.send(CliTurnOutcome {
                resume_id: Some(thread_id.clone()),
                messages: tr.take_messages(),
                aborted: false,
                streamed,
                resume_rejected: false,
                error: Some("Codex app-server exited unexpectedly".to_string()),
            });
        }
        if let Some((_prompt, _images, sink, outcome)) = pending_turn.take() {
            tr.begin_next_turn();
            emit(&sink, tr.start());
            emit(
                &sink,
                tr.finish(Some(
                    "Codex app-server exited before the queued turn started",
                )),
            );
            let streamed = tr.opened;
            let _ = outcome.send(CliTurnOutcome {
                resume_id: Some(thread_id.clone()),
                messages: tr.take_messages(),
                aborted: false,
                streamed,
                resume_rejected: false,
                error: Some("Codex app-server exited before the queued turn started".to_string()),
            });
        }
        for (_, outcome) in pending_compact_requests.drain() {
            let _ = outcome.send(Err("Codex app-server exited during compaction".into()));
        }
        for (_, (_, _, outcome)) in pending_plugin_installs.drain() {
            let _ = outcome.send(Err(
                "Codex app-server exited during plugin installation".into()
            ));
        }
        if compacting {
            emit(
                &base_sink,
                vec![json!({
                    "type": "compaction_end",
                    "reason": compact_reason,
                    "aborted": true,
                })],
            );
        }
        let _ = child.wait().await;
    });

    Ok(handle)
}
