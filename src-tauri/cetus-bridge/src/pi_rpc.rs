//! Long-lived `pi --mode rpc` subprocess wrapped in an async request/response client.
//!
//! pi is shipped as a full install tree under `<app_data>/pi-install/`, copied
//! from the Tauri resource bundle on first launch. We spawn the binary there
//! with cwd set to that directory so pi's binary-dir-relative resource loads
//! (package.json, theme/*.json, ...) resolve to files we control.
//!
//! Framing: pi uses JSONL with strict LF as the only record delimiter. We
//! split on `\n` and strip a trailing `\r` if present.
//!
//! Conversation tagging: each PiRpc instance carries an optional conversation
//! id that gets stamped onto every emitted RuntimeEvent. With the multi-process
//! pool model (one pi per conversation), this lets the frontend demux events
//! cleanly without the protocol itself having to grow a sessionId.

use crate::bridge::RuntimeEvent;
use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command as TokioCommand;
use tokio::sync::{mpsc, oneshot};

/// Host-side timeout for a single pi RPC (the prompt ack, state polls, etc.).
/// Defaults to 30s; override via `CETUS_PI_REQUEST_TIMEOUT_SECS` (e.g. for eval
/// runs where a cold session or a slow first tool call pushes the prompt ack
/// past 30s). The default is unchanged for normal use.
fn request_timeout() -> Duration {
    match std::env::var("CETUS_PI_REQUEST_TIMEOUT_SECS") {
        Ok(s) => match s.trim().parse::<u64>() {
            Ok(secs) if secs > 0 => Duration::from_secs(secs),
            _ => Duration::from_secs(30),
        },
        Err(_) => Duration::from_secs(30),
    }
}

/// Stall window for a streaming prompt turn (see [`PiRpc::request_streaming`]).
/// The turn fails only after pi emits NOTHING on stdout for this long — so a
/// long-but-healthy turn that keeps streaming never dies, while a truly hung pi
/// still surfaces. Bound by progress, not total elapsed. Default 120s; override
/// via `CETUS_PI_STALL_TIMEOUT_SECS`.
fn stall_timeout() -> Duration {
    match std::env::var("CETUS_PI_STALL_TIMEOUT_SECS") {
        Ok(s) => match s.trim().parse::<u64>() {
            Ok(secs) if secs > 0 => Duration::from_secs(secs),
            _ => Duration::from_secs(120),
        },
        Err(_) => Duration::from_secs(120),
    }
}

pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: RuntimeEvent);
}

pub trait TaskSpawner: Send + Sync + 'static {
    fn spawn(&self, fut: Pin<Box<dyn Future<Output = ()> + Send + 'static>>);
}

type PendingResponse = std::result::Result<Value, String>;
type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<PendingResponse>>>>;
/// Wall-clock of the last stdout line received from pi — bumped by
/// `stdout_reader` on every line, read by [`PiRpc::request_streaming`] to drive
/// the stall-based turn timeout.
type LastActivity = Arc<Mutex<std::time::Instant>>;

pub struct PiRpc {
    cmd_tx: mpsc::Sender<Value>,
    next_id: AtomicU64,
    pending: Pending,
    last_activity: LastActivity,
    /// Flipped to false the instant the child process exits (clean or crashed).
    /// `pi_for` checks this before reusing a cached pi so a process that died
    /// while the conversation sat idle is transparently respawned on next use,
    /// rather than silently swallowing sends into a dead stdin.
    alive: Arc<AtomicBool>,
    /// Conversation this pi instance serves. None during the brief window
    /// where new_conversation has spawned pi but not yet persisted the row.
    pub conversation_id: Option<String>,
    remote: Option<Arc<crate::remote::RemoteRuntime>>,
    // FnOnce that kills the underlying child. Fired exactly once on Drop so
    // dropping the Arc replaces the live process instead of leaking it.
    shutdown: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl Drop for PiRpc {
    fn drop(&mut self) {
        if let Some(f) = self.shutdown.lock().unwrap().take() {
            f();
        }
    }
}

impl PiRpc {
    /// Spawn `pi --mode rpc` from `bin` with cwd = `cwd`. `conversation_id`
    /// (when known) gets stamped onto every event this pi emits.
    pub fn spawn(
        sink: Arc<dyn EventSink>,
        spawner: Arc<dyn TaskSpawner>,
        bin: &Path,
        sessions_dir: &Path,
        cwd: &Path,
        extra_env: Vec<(String, String)>,
        conversation_id: Option<String>,
        config: crate::bridge::RuntimeConfig,
    ) -> Result<Self> {
        let (cmd_tx, cmd_rx) = mpsc::channel::<Value>(32);
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let last_activity: LastActivity = Arc::new(Mutex::new(std::time::Instant::now()));
        let alive = Arc::new(AtomicBool::new(true));
        let mut extra_env = extra_env;

        tracing::info!(
            "spawning pi bin={} cwd={} conv={:?}",
            bin.display(),
            cwd.display(),
            conversation_id
        );
        let remote = match crate::remote::parse_remote_workspace(&cwd.to_string_lossy()) {
            Some(workspace) => Some(Arc::new(crate::remote::prepare_remote_runtime(
                workspace,
                bin,
                sessions_dir,
                conversation_id.as_deref(),
                &mut extra_env,
            )?)),
            None => None,
        };
        let shutdown = spawn_process(
            bin,
            sessions_dir,
            cwd,
            sink.clone(),
            spawner,
            cmd_rx,
            pending.clone(),
            last_activity.clone(),
            alive.clone(),
            extra_env,
            conversation_id.clone(),
            config,
            remote.clone(),
        )?;

        Ok(Self {
            cmd_tx,
            next_id: AtomicU64::new(1),
            pending,
            last_activity,
            alive,
            conversation_id,
            remote,
            shutdown: Mutex::new(Some(shutdown)),
        })
    }

    /// False once the underlying child process has exited (clean or crashed).
    /// Checked by `pi_for` before reusing a cached instance.
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    /// True while a request/streaming turn is in flight (an entry sits in
    /// `pending` between send and its response). A warm-but-idle pi reports
    /// false — so callers can distinguish "currently running" from merely
    /// "cached in the pool". Used by auto-archive to avoid yanking a chat
    /// mid-turn without also blocking on chats whose pi is just kept warm.
    pub fn is_busy(&self) -> bool {
        !self.pending.lock().unwrap().is_empty()
    }

    /// Send a command and await its `response`.
    pub async fn request(&self, payload: Value) -> Result<Value> {
        self.request_with_timeout(payload, request_timeout()).await
    }

    async fn request_with_timeout(&self, mut payload: Value, timeout: Duration) -> Result<Value> {
        let id = format!("r{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        if let Value::Object(map) = &mut payload {
            map.insert("id".to_string(), Value::String(id.clone()));
        } else {
            bail!("request payload must be a JSON object");
        }
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);

        self.cmd_tx
            .send(payload)
            .await
            .map_err(|e| anyhow!("pi writer closed: {e}"))?;

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(e))) => bail!(e),
            Ok(Err(_)) => {
                self.pending.lock().unwrap().remove(&id);
                bail!("pi response channel dropped")
            }
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                bail!("pi request timed out after {:?}", timeout)
            }
        }
    }

    /// Time since pi last wrote anything to stdout. A warm-but-idle pi only
    /// speaks when spoken to, so a large value is a staleness HINT — pair it
    /// with [`ping`](Self::ping) before declaring the process wedged.
    pub fn idle_for(&self) -> Duration {
        self.last_activity.lock().unwrap().elapsed()
    }

    /// Cheap liveness probe: one `get_state` round-trip bounded by `timeout`
    /// (milliseconds against a healthy pi). A sleep/wake cycle can leave the
    /// child alive as a process but wedged — `is_alive()` stays true while
    /// every real RPC would eat the full request timeout. `AppState::pi_for`
    /// probes long-idle cached instances with this and respawns on failure.
    pub async fn ping(&self, timeout: Duration) -> bool {
        self.request_with_timeout(json!({"type": "get_state"}), timeout)
            .await
            .is_ok()
    }

    /// Like [`request`], but for the prompt turn — whose `response` only arrives
    /// when the whole agent turn completes (events stream meanwhile). A fixed
    /// wall-clock deadline is wrong here: it would kill a long-but-healthy turn.
    /// Instead this is STALL-based — it fails only after pi has emitted nothing
    /// on stdout for [`stall_timeout`]. A turn that keeps streaming never times
    /// out; a genuinely hung pi still surfaces. Individual stuck tools are bound
    /// by their own timeouts (web-search, CDP, …), not by this.
    pub async fn request_streaming(&self, mut payload: Value) -> Result<Value> {
        let id = format!("r{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        if let Value::Object(map) = &mut payload {
            map.insert("id".to_string(), Value::String(id.clone()));
        } else {
            bail!("request payload must be a JSON object");
        }
        let (tx, mut rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        // Measure silence from the moment we send, not from some stale prior line.
        *self.last_activity.lock().unwrap() = std::time::Instant::now();

        self.cmd_tx
            .send(payload)
            .await
            .map_err(|e| anyhow!("pi writer closed: {e}"))?;

        let stall = stall_timeout();
        let tick = Duration::from_secs(3);
        loop {
            match tokio::time::timeout(tick, &mut rx).await {
                Ok(Ok(Ok(v))) => return Ok(v),
                Ok(Ok(Err(e))) => bail!(e),
                Ok(Err(_)) => {
                    self.pending.lock().unwrap().remove(&id);
                    bail!("pi response channel dropped")
                }
                // No response yet this tick: keep waiting as long as pi is still
                // emitting; give up only once it has gone silent past the window.
                Err(_) => {
                    let idle = self.last_activity.lock().unwrap().elapsed();
                    if idle >= stall {
                        self.pending.lock().unwrap().remove(&id);
                        bail!("pi stalled: no output for {:?}", idle)
                    }
                }
            }
        }
    }

    /// Send a raw payload without auto-assigning an `id`. Used for messages
    /// that are themselves *responses* (e.g. `extension_ui_response`) where pi
    /// dictates the id we must echo back.
    pub async fn notify(&self, payload: Value) -> Result<()> {
        self.cmd_tx
            .send(payload)
            .await
            .map_err(|e| anyhow!("pi writer closed: {e}"))?;
        Ok(())
    }

    // ---- High-level helpers ------------------------------------------------

    pub async fn new_session(&self) -> Result<String> {
        let _ = self.request(json!({"type": "new_session"})).await?;
        let state = self.request(json!({"type": "get_state"})).await?;
        let session_file = state
            .pointer("/data/sessionFile")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("get_state missing sessionFile"))?
            .to_string();
        if let Some(remote) = &self.remote {
            let local = sync_remote_session(remote.clone(), session_file.clone()).await?;
            return Ok(local.to_string_lossy().to_string());
        }
        Ok(session_file)
    }

    pub async fn switch_session(&self, path: &str) -> Result<()> {
        let session_path = if let Some(remote) = &self.remote {
            let local = PathBuf::from(path);
            let remote = remote.clone();
            tokio::task::spawn_blocking(move || crate::remote::upload_session(&remote, &local))
                .await
                .map_err(|e| anyhow!("session upload task failed: {e}"))??
        } else {
            path.to_string()
        };
        let _ = self
            .request(json!({"type": "switch_session", "sessionPath": session_path}))
            .await?;
        Ok(())
    }

    pub async fn get_messages(&self) -> Result<Vec<Value>> {
        let resp = self.request(json!({"type": "get_messages"})).await?;
        self.sync_current_remote_session().await;
        let messages = resp
            .pointer("/data/messages")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(messages)
    }

    pub async fn get_state(&self) -> Result<Value> {
        let resp = self.request(json!({"type": "get_state"})).await?;
        let mut data = resp.get("data").cloned().unwrap_or(Value::Null);
        if let (Some(remote), Some(path)) = (
            &self.remote,
            data.get("sessionFile").and_then(|v| v.as_str()).map(String::from),
        ) {
            let local = crate::remote::local_session_path(remote, &path);
            if let Some(obj) = data.as_object_mut() {
                obj.insert(
                    "sessionFile".to_string(),
                    Value::String(local.to_string_lossy().to_string()),
                );
            }
        }
        Ok(data)
    }

    /// User messages that can be forked from, oldest→newest: `[{entryId, text}]`.
    /// Used to find the rewind point for a "retry" (the last user message).
    pub async fn get_fork_messages(&self) -> Result<Vec<Value>> {
        let resp = self.request(json!({"type": "get_fork_messages"})).await?;
        self.sync_current_remote_session().await;
        let messages = resp
            .pointer("/data/messages")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(messages)
    }

    /// Fork (rewind) the session at `entry_id`: drops that entry and everything
    /// after it, branching the session in place (same session file). Returns the
    /// forked-from message's text so the caller can resubmit it. This is how a
    /// failed/poisoned turn is rolled back before a retry.
    pub async fn fork(&self, entry_id: &str) -> Result<String> {
        let resp = self
            .request(json!({"type": "fork", "entryId": entry_id}))
            .await?;
        check_success(&resp, "fork")?;
        self.sync_current_remote_session().await;
        Ok(resp
            .pointer("/data/text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string())
    }

    /// Send a user prompt to pi, optionally with attached images. Each image
    /// is a pi-ai `ImageContent` block — pi forwards them verbatim into the
    /// agent's input event so an extension (vision-bridge) can rewrite them
    /// before they hit the model.
    pub async fn send_prompt(&self, message: &str, images: Vec<Value>) -> Result<()> {
        // Always declare a streaming behavior. pi only consults it when the agent
        // is mid-run; otherwise it's ignored and the prompt starts a fresh turn.
        // "steer" delivers the message at the next tool-call boundary (before the
        // next LLM call), so a message sent while the agent works course-corrects
        // the in-flight task instead of being rejected ("Agent is already
        // processing") — matching Claude Code's steering. Without this, concurrent
        // sends throw. ("followUp" — queue strictly until the run ends — would be
        // a separate modifier binding.)
        let mut payload = json!({
            "type": "prompt",
            "message": message,
            "streamingBehavior": "steer",
        });
        if !images.is_empty() {
            payload["images"] = Value::Array(images);
        }
        // The prompt turn can legitimately run for minutes; use the stall-based
        // wait so a healthy long turn isn't killed by a fixed wall-clock.
        let resp = self.request_streaming(payload).await?;
        let ok = resp
            .get("success")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if !ok {
            let err = resp
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown error");
            bail!("pi rejected prompt: {err}");
        }
        self.sync_current_remote_session().await;
        Ok(())
    }

    pub async fn abort(&self) -> Result<()> {
        let _ = self.request(json!({"type": "abort"})).await?;
        Ok(())
    }

    pub async fn set_model(&self, provider: &str, model_id: &str) -> Result<()> {
        let resp = self
            .request(json!({
                "type": "set_model",
                "provider": provider,
                "modelId": model_id,
            }))
            .await?;
        check_success(&resp, "set_model")?;
        tracing::info!("pi set_model → {provider}/{model_id}");
        Ok(())
    }

    pub async fn set_thinking_level(&self, level: &str) -> Result<()> {
        let resp = self
            .request(json!({
                "type": "set_thinking_level",
                "level": level,
            }))
            .await?;
        check_success(&resp, "set_thinking_level")?;
        tracing::info!("pi set_thinking_level → {level}");
        Ok(())
    }

    async fn sync_current_remote_session(&self) {
        let Some(remote) = self.remote.clone() else {
            return;
        };
        match self.request(json!({"type": "get_state"})).await {
            Ok(state) => {
                if let Some(path) = state.pointer("/data/sessionFile").and_then(|v| v.as_str()) {
                    if let Err(e) = sync_remote_session(remote, path.to_string()).await {
                        tracing::warn!("remote session sync failed: {e}");
                    }
                }
            }
            Err(e) => tracing::warn!("remote session state lookup failed: {e}"),
        }
    }
}

async fn sync_remote_session(
    remote: Arc<crate::remote::RemoteRuntime>,
    remote_path: String,
) -> Result<PathBuf> {
    tokio::task::spawn_blocking(move || crate::remote::download_session(&remote, &remote_path))
        .await
        .map_err(|e| anyhow!("session download task failed: {e}"))?
}

fn check_success(resp: &Value, op: &str) -> Result<()> {
    let ok = resp
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if ok {
        return Ok(());
    }
    let msg = resp
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown error");
    tracing::warn!("pi {op} failed: {msg} (raw: {resp})");
    bail!("pi {op} failed: {msg}");
}

// =============================================================================
// Process management
// =============================================================================

#[allow(clippy::too_many_arguments)]
fn spawn_process(
    bin: &Path,
    sessions_dir: &Path,
    cwd: &Path,
    sink: Arc<dyn EventSink>,
    spawner: Arc<dyn TaskSpawner>,
    cmd_rx: mpsc::Receiver<Value>,
    pending: Pending,
    last_activity: LastActivity,
    alive: Arc<AtomicBool>,
    extra_env: Vec<(String, String)>,
    conversation_id: Option<String>,
    config: crate::bridge::RuntimeConfig,
    remote: Option<Arc<crate::remote::RemoteRuntime>>,
) -> Result<Box<dyn FnOnce() + Send>> {
    let mut remote_args = Vec::<String>::new();
    let mut remote_script_parts = Vec::<String>::new();
    let (mut command, pi_dir_for_extensions): (TokioCommand, Option<PathBuf>) =
        if let Some(remote) = &remote {
            let cmd = TokioCommand::new("ssh");
            let runtime = remote.as_ref();
            let mut args = vec![
                runtime.pi_bin.clone(),
                "--mode".to_string(),
                "rpc".to_string(),
                "--session-dir".to_string(),
                runtime.sessions_dir.clone(),
                "--append-system-prompt".to_string(),
                config.append_system_prompt.clone(),
            ];
            remote_args.append(&mut args);
            (cmd, Some(PathBuf::from(&runtime.pi_dir)))
        } else {
            let mut cmd = TokioCommand::new(bin);
            cmd.arg("--mode")
                .arg("rpc")
                .arg("--session-dir")
                .arg(sessions_dir)
                .arg("--append-system-prompt")
                .arg(&config.append_system_prompt);
            (cmd, bin.parent().map(Path::to_path_buf))
        };

    if let Some(pi_dir) = pi_dir_for_extensions.as_deref() {
        append_owned_extensions(
            &mut command,
            &mut remote_args,
            pi_dir,
            bin.parent(),
            &config.extensions,
            &config.plugin_extensions.owned_extension_names,
            remote.is_some(),
        );
        for p in &config.plugin_extensions.extension_paths {
            if remote.is_some() {
                tracing::warn!(
                    "skipping plugin pi extension {} for remote SSH runtime; plugin extensions must be installed in the remote pi tree",
                    p.display()
                );
            } else if p.is_file() {
                tracing::info!("loading plugin pi extension {}", p.display());
                command.arg("--extension").arg(p);
            } else {
                tracing::warn!("plugin pi extension {} missing", p.display());
            }
        }
        if !config.plugin_extensions.extension_paths.is_empty() {
            let from = config
                .plugin_extensions
                .runtime_dir
                .as_ref()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "(runtime dir unavailable)".to_string());
            tracing::info!(
                "loaded {} enabled plugin extension(s) from {}",
                config.plugin_extensions.extension_paths.len(),
                from
            );
        }
        if !config.plugin_extensions.enabled_summaries.is_empty() {
            tracing::info!(
                "enabled plugins: {:?}",
                config.plugin_extensions.enabled_summaries
            );
        }
    }

    if let Some(remote) = &remote {
        for (k, v) in &extra_env {
            remote_script_parts.push(format!("{k}={}", crate::remote::shell_word(v)));
        }
        remote_script_parts.push("exec".to_string());
        remote_script_parts.extend(remote_args.iter().map(|a| crate::remote::shell_word(a)));
        let script = format!(
            "mkdir -p {} && cd {} && {}",
            crate::remote::shell_word(&remote.workspace.path),
            crate::remote::shell_word(&remote.workspace.path),
            remote_script_parts.join(" ")
        );
        command.args(crate::remote::remote_command_args(&remote.workspace, &script));
    } else {
        command.current_dir(cwd);
        for (k, v) in extra_env {
            command.env(k, v);
        }
    }

    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .with_context(|| match &remote {
            Some(remote) => format!("failed to spawn remote pi via ssh {}", remote.workspace.target),
            None => format!("failed to spawn pi at {}", bin.display()),
        })?;

    let stdin = child.stdin.take().context("pi stdin missing")?;
    let stdout = child.stdout.take().context("pi stdout missing")?;
    let stderr = child.stderr.take().context("pi stderr missing")?;

    spawner.spawn(Box::pin(stdin_writer(
        stdin,
        cmd_rx,
        sink.clone(),
        conversation_id.clone(),
    )));
    spawner.spawn(Box::pin(stdout_reader(
        stdout,
        pending.clone(),
        last_activity,
        sink.clone(),
        conversation_id.clone(),
    )));
    spawner.spawn(Box::pin(stderr_reader(
        stderr,
        sink.clone(),
        conversation_id.clone(),
    )));

    let exit_sink = sink.clone();
    let exit_conv = conversation_id;
    let exit_pending = pending.clone();
    let (kill_tx, kill_rx) = oneshot::channel::<()>();
    spawner.spawn(Box::pin(async move {
        tokio::select! {
            res = child.wait() => {
                // Process is gone — mark dead so the next `pi_for` respawns
                // instead of writing sends into a closed stdin.
                alive.store(false, Ordering::Relaxed);
                match res {
                    Ok(status) => {
                        fail_pending_requests(
                            &exit_pending,
                            format!("pi process exited with status {status}"),
                        );
                        emit_runtime_event(&exit_sink, RuntimeEvent::Exited {
                            conversation_id: exit_conv,
                            code: status.code(),
                        });
                    }
                    Err(e) => {
                        fail_pending_requests(&exit_pending, format!("pi wait error: {e}"));
                        emit_runtime_event(&exit_sink, RuntimeEvent::Error {
                            conversation_id: exit_conv,
                            message: format!("pi wait error: {e}"),
                        });
                    }
                }
            },
            _ = kill_rx => {
                alive.store(false, Ordering::Relaxed);
                let _ = child.start_kill();
                let _ = child.wait().await;
                fail_pending_requests(&exit_pending, "pi process stopped".to_string());
            }
        }
    }));

    Ok(Box::new(move || {
        let _ = kill_tx.send(());
    }))
}

fn fail_pending_requests(pending: &Pending, message: String) {
    let requests = {
        let mut guard = pending.lock().unwrap();
        guard.drain().map(|(_, tx)| tx).collect::<Vec<_>>()
    };
    for tx in requests {
        let _ = tx.send(Err(message.clone()));
    }
}

fn append_owned_extensions(
    command: &mut TokioCommand,
    remote_args: &mut Vec<String>,
    pi_dir: &Path,
    local_pi_dir: Option<&Path>,
    config: &crate::bridge::ExtensionLoadConfig,
    plugin_owned: &std::collections::BTreeSet<String>,
    is_remote: bool,
) {
    let ext_dir = pi_dir.join(config.directory_name);
    let read_dir = local_pi_dir
        .map(|p| p.join(config.directory_name))
        .unwrap_or_else(|| ext_dir.clone());
    match std::fs::read_dir(&read_dir) {
        Ok(entries) => {
            // Sort the .ts extension paths before handing them to pi. pi preserves
            // --extension order into its tool registry, and many providers benefit
            // from a byte-stable prompt/tool prefix across spawns/restarts/machines.
            // Raw read_dir order is filesystem/inode-dependent and can shuffle when
            // the pi-install/cetus-extensions tree is rebuilt by the deploy chain.
            let mut paths: Vec<_> = entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("ts"))
                .filter(|p| match p.file_name().and_then(|s| s.to_str()) {
                    Some(name) => !plugin_owned.contains(name),
                    None => true,
                })
                .collect();
            paths.sort();
            let names: std::collections::HashSet<&str> = paths
                .iter()
                .filter_map(|p| p.file_name().and_then(|s| s.to_str()))
                .collect();
            for p in &paths {
                tracing::info!("loading pi extension {}", p.display());
                if is_remote {
                    let arg_path = match local_pi_dir.and_then(|local| p.strip_prefix(local).ok()) {
                        Some(rel) => pi_dir.join(rel),
                        None => p.clone(),
                    };
                    remote_args.push("--extension".to_string());
                    remote_args.push(arg_path.to_string_lossy().to_string());
                } else {
                    command.arg("--extension").arg(p);
                }
            }
            // Self-check: an install/sync that produces zero or partial
            // extensions must scream, not silently strand the agent's tools.
            // The agent's product guide promises these capabilities, so a
            // missing core extension means it will claim tools it can't call.
            if paths.is_empty() {
                tracing::error!(
                    "no pi extensions loaded from {} — cetus's own tools \
                     (automations, memory, skills, MCP connectors) are ALL \
                     missing; the agent will silently degrade. Rebuild with \
                     scripts/build-pi-sidecar.sh and restart.",
                    ext_dir.display()
                );
            } else {
                let missing: Vec<&str> = config
                    .required_extensions
                    .iter()
                    .copied()
                    .filter(|core| !names.contains(core))
                    .collect();
                if missing.is_empty() {
                    tracing::info!(
                        "loaded {} pi extensions from {}",
                        paths.len(),
                        ext_dir.display()
                    );
                } else {
                    tracing::error!(
                        "loaded {} pi extensions from {} but core extensions are \
                         MISSING: {:?} — the agent will be promised tools it \
                         cannot call. Rebuild with scripts/build-pi-sidecar.sh.",
                        paths.len(),
                        ext_dir.display(),
                        missing
                    );
                }
            }
        }
        Err(e) => {
            // The dir is absent (e.g. a stale install left behind by an
            // extensions-dir rename) — read_dir errored, so without this the
            // whole block would no-op and the agent would launch with ZERO of
            // its own tools, masking the misconfiguration as "the feature
            // doesn't exist". Fail loud instead.
            tracing::error!(
                "pi extensions dir {} unreadable ({e}) — cetus's own tools will \
                 NOT load and the agent will silently degrade. Rebuild with \
                 scripts/build-pi-sidecar.sh and restart the app.",
                ext_dir.display()
            );
        }
    }
}

fn emit_runtime_event(sink: &Arc<dyn EventSink>, event: RuntimeEvent) {
    sink.emit(event);
}

async fn stdin_writer(
    mut stdin: tokio::process::ChildStdin,
    mut rx: mpsc::Receiver<Value>,
    sink: Arc<dyn EventSink>,
    conversation_id: Option<String>,
) {
    while let Some(v) = rx.recv().await {
        let mut line = match serde_json::to_string(&v) {
            Ok(s) => s,
            Err(e) => {
                emit_runtime_event(
                    &sink,
                    RuntimeEvent::Error {
                        conversation_id: conversation_id.clone(),
                        message: format!("serialize: {e}"),
                    },
                );
                continue;
            }
        };
        line.push('\n');
        if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
            break;
        }
    }
}

async fn stdout_reader(
    stdout: tokio::process::ChildStdout,
    pending: Pending,
    last_activity: LastActivity,
    sink: Arc<dyn EventSink>,
    conversation_id: Option<String>,
) {
    let mut reader = BufReader::new(stdout);
    let mut buf = Vec::<u8>::new();
    loop {
        buf.clear();
        let n = match reader.read_until(b'\n', &mut buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                emit_runtime_event(
                    &sink,
                    RuntimeEvent::Error {
                        conversation_id: conversation_id.clone(),
                        message: format!("read: {e}"),
                    },
                );
                break;
            }
        };
        // Any byte from pi counts as liveness for the stall-based turn timeout.
        *last_activity.lock().unwrap() = std::time::Instant::now();
        let mut end = n;
        if end > 0 && buf[end - 1] == b'\n' {
            end -= 1;
        }
        if end > 0 && buf[end - 1] == b'\r' {
            end -= 1;
        }
        if end == 0 {
            continue;
        }
        dispatch_line(&buf[..end], &sink, &pending, &conversation_id);
    }
}

async fn stderr_reader(
    stderr: tokio::process::ChildStderr,
    sink: Arc<dyn EventSink>,
    conversation_id: Option<String>,
) {
    let mut reader = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        tracing::debug!(target = "pi.stderr", "{}", trimmed);
        // Promote stderr lines that look like errors into a UI-visible pi_error
        // (the frontend paints these as a failed turn). pi multiplexes real
        // errors, warnings, recovery notes and even startup timings onto one
        // unprefixed stderr stream, so we can't key off a level token — instead
        // we promote on the word "error" but suppress known-benign phrasings that
        // are NOT turn failures. This is a denylist: it only ever removes false
        // promotions, never hides a genuine error.
        //  - the mcp-bridge logs DELIBERATELY non-fatal connector diagnostics
        //    ("server X unavailable: …", "tool Y skipped: …") under a stable
        //    marker — a down/expired/slow optional connector must not red-bubble
        //    an unrelated turn;
        //  - warnings, zero-counts ("0 errors") and recovery notes mention
        //    "error" without being one.
        let lower = trimmed.to_lowercase();
        let benign = trimmed.contains("[cetus mcp-bridge]")
            || lower.starts_with("warning")
            || lower.contains("0 errors")
            || lower.contains("no errors")
            || lower.contains("error recovery")
            || lower.contains("recovered");
        if !benign && lower.contains("error") {
            emit_runtime_event(
                &sink,
                RuntimeEvent::Error {
                    conversation_id: conversation_id.clone(),
                    message: trimmed.to_string(),
                },
            );
        }
    }
}

fn dispatch_line(
    line: &[u8],
    sink: &Arc<dyn EventSink>,
    pending: &Pending,
    conversation_id: &Option<String>,
) {
    let value: Value = match serde_json::from_slice(line) {
        Ok(v) => v,
        Err(e) => {
            emit_runtime_event(
                sink,
                RuntimeEvent::Error {
                    conversation_id: conversation_id.clone(),
                    message: format!("parse error: {e} on: {}", String::from_utf8_lossy(line)),
                },
            );
            return;
        }
    };

    // Inspect the framing fields (`type`/`id`) by reference. `dispatch_line` runs
    // on the streaming-token firehose, so deserializing a full clone of the
    // parsed value into a struct just to read two fields was pure per-line waste.
    let msg_type = value.get("type").and_then(|t| t.as_str());

    // Surface provider prompt-cache usage from pi's assistant `message_end` events,
    // so prefix-cache behavior is observable in dev logs. Non-destructive — the
    // event still flows to the host as a RuntimeEvent::Protocol below.
    log_cache_usage(&value, conversation_id);

    if msg_type == Some("response") {
        if let Some(id) = value.get("id").and_then(|v| v.as_str()) {
            if let Some(tx) = pending.lock().unwrap().remove(id) {
                let _ = tx.send(Ok(value));
                return;
            }
        }
        emit_runtime_event(
            sink,
            RuntimeEvent::Error {
                conversation_id: conversation_id.clone(),
                message: format!("orphan response: {value}"),
            },
        );
    } else if let Some(kind) = crate::bridge::host_tunnel_kind(&value) {
        route_host_tunnel(kind, value, sink, conversation_id);
    } else {
        emit_runtime_event(
            sink,
            RuntimeEvent::Protocol {
                conversation_id: conversation_id.clone(),
                event: value,
            },
        );
    }
}

fn route_host_tunnel(
    kind: crate::bridge::HostTunnelKind,
    value: Value,
    sink: &Arc<dyn EventSink>,
    conversation_id: &Option<String>,
) {
    match kind {
        crate::bridge::HostTunnelKind::UltraAgent => {
            // The Ultra runtime's agent() tunnels a sub-agent request through a
            // sentinel ctx.ui.input. Route it to the Rust handler (not the frontend
            // dialog host) so it works headless and reuses the node machinery.
            if let (Some(conv), Some(id)) = (
                conversation_id.clone(),
                value.get("id").and_then(|v| v.as_str()).map(String::from),
            ) {
                let params = crate::bridge::tunnel_params(&value);
                emit_runtime_event(
                    sink,
                    RuntimeEvent::HostTunnelRequest {
                        conversation_id: conv,
                        request_id: id,
                        kind,
                        params,
                    },
                );
            } else {
                // No conversation id to reply through — surface as a normal event.
                emit_runtime_event(
                    sink,
                    RuntimeEvent::Protocol {
                        conversation_id: conversation_id.clone(),
                        event: value,
                    },
                );
            }
        }
        crate::bridge::HostTunnelKind::Automation => {
            // The automation-tools extension tunnels a create/list/update request
            // through a sentinel ctx.ui.input. Route it to the Rust handler so it
            // mutates the store and replies, never reaching the dialog host.
            if let (Some(conv), Some(id)) = (
                conversation_id.clone(),
                value.get("id").and_then(|v| v.as_str()).map(String::from),
            ) {
                let params = crate::bridge::tunnel_params(&value);
                emit_runtime_event(
                    sink,
                    RuntimeEvent::HostTunnelRequest {
                        conversation_id: conv,
                        request_id: id,
                        kind,
                        params,
                    },
                );
            } else {
                emit_runtime_event(
                    sink,
                    RuntimeEvent::Protocol {
                        conversation_id: conversation_id.clone(),
                        event: value,
                    },
                );
            }
        }
        crate::bridge::HostTunnelKind::Mcp | crate::bridge::HostTunnelKind::Skill => {
            // The MCP/skill tools tunnel store mutations through sentinel
            // ctx.ui.input calls. Route them to the Rust handlers so they mutate
            // host state and reply, never reaching the dialog host.
            if let (Some(conv), Some(id)) = (
                conversation_id.clone(),
                value.get("id").and_then(|v| v.as_str()).map(String::from),
            ) {
                let params = crate::bridge::tunnel_params(&value);
                emit_runtime_event(
                    sink,
                    RuntimeEvent::HostTunnelRequest {
                        conversation_id: conv,
                        request_id: id,
                        kind,
                        params,
                    },
                );
            } else {
                emit_runtime_event(
                    sink,
                    RuntimeEvent::Protocol {
                        conversation_id: conversation_id.clone(),
                        event: value,
                    },
                );
            }
        }
        crate::bridge::HostTunnelKind::AgentStep
        | crate::bridge::HostTunnelKind::Cua
        | crate::bridge::HostTunnelKind::Browser => {
            // A cetus agent-control extension (browser-use / computer-use) tunnels a
            // live step or a native accessibility call through a sentinel
            // ctx.ui.input. Route it to the agent module instead of the dialog host.
            if let (Some(conv), Some(id)) = (
                conversation_id.clone(),
                value.get("id").and_then(|v| v.as_str()).map(String::from),
            ) {
                let params = crate::bridge::tunnel_params(&value);
                emit_runtime_event(
                    sink,
                    RuntimeEvent::HostTunnelRequest {
                        conversation_id: conv,
                        request_id: id,
                        kind,
                        params,
                    },
                );
            } else {
                emit_runtime_event(
                    sink,
                    RuntimeEvent::Protocol {
                        conversation_id: conversation_id.clone(),
                        event: value,
                    },
                );
            }
        }
    }
}

/// Log provider prompt-cache usage from a pi assistant `message_end` event.
///
/// pi normalizes provider-specific usage fields into `input`, `output`,
/// `cacheRead`, and `cacheWrite`; a high cached fraction means the byte-stable
/// prefix is paying off. Fires once per assistant message, tagged by conversation
/// when the host supplied one.
fn log_cache_usage(value: &Value, conversation_id: &Option<String>) {
    if value.get("type").and_then(|t| t.as_str()) != Some("message_end") {
        return;
    }
    let Some(message) = value.get("message") else {
        return;
    };
    if message.get("role").and_then(|r| r.as_str()) != Some("assistant") {
        return;
    }
    let Some(usage) = message.get("usage") else {
        return;
    };
    let num = |key: &str| -> u64 {
        usage
            .get(key)
            .and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|f| f as u64)))
            .unwrap_or(0)
    };
    let input = num("input");
    let output = num("output");
    let cache_read = num("cacheRead");
    let cache_write = num("cacheWrite");
    let prompt = input + cache_read + cache_write;
    // Skip sub-turn / accounting-free events (no prompt tokens to report).
    if prompt == 0 {
        return;
    }
    let hit_pct = (cache_read as f64) * 100.0 / (prompt as f64);
    tracing::info!(
        conversation = conversation_id.as_deref().unwrap_or("-"),
        prompt,
        cache_read,
        cache_write,
        input,
        output,
        "deepseek prompt-cache hit {hit_pct:.0}% ({cache_read}/{prompt} prompt tokens cached, output {output})"
    );
}
