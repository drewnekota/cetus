use super::{
    auth_expired_hint, claude_stdin_lines, is_continuation_content, ActiveTurn, CliBackend,
    CliRunOpts, CliTurnOutcome, EventTranslator,
};
use crate::bridge::RuntimeEvent;
use crate::pi_rpc::EventSink;
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command as TokioCommand;

/// Handle to one conversation-scoped Claude Code stream-json process.
///
/// Claude's background Bash jobs are owned by the CLI session, not by an
/// individual model turn. Keeping this handle alive therefore gives dev
/// servers the same lifetime they have in Claude Code's interactive UI.
#[derive(Clone)]
pub struct ClaudeSessionHandle {
    tx: tokio::sync::mpsc::UnboundedSender<ClaudeSessionCommand>,
}

enum ClaudeSessionCommand {
    StartTurn {
        line: String,
        sink: Arc<dyn EventSink>,
        outcome: tokio::sync::oneshot::Sender<CliTurnOutcome>,
    },
    Input(String),
    /// A mid-turn user message: `line` goes to stdin like Input, and
    /// `message` (the PiMessage-shaped user row) is queued on the translator
    /// to splice into the transcript at its merge point.
    Steer {
        line: String,
        message: Value,
    },
    Abort,
    Shutdown,
}

impl ClaudeSessionHandle {
    pub fn start_turn(
        &self,
        line: String,
        sink: Arc<dyn EventSink>,
    ) -> Result<tokio::sync::oneshot::Receiver<CliTurnOutcome>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.tx
            .send(ClaudeSessionCommand::StartTurn {
                line,
                sink,
                outcome: tx,
            })
            .map_err(|_| anyhow::anyhow!("Claude Code session has exited"))?;
        Ok(rx)
    }

    pub fn input(&self, line: String) -> Result<()> {
        self.tx
            .send(ClaudeSessionCommand::Input(line))
            .map_err(|_| anyhow::anyhow!("Claude Code session has exited"))
    }

    /// Inject a mid-turn user message: writes `line` to stdin and queues
    /// `message` for transcript splicing at the steer's merge point.
    pub fn steer(&self, line: String, message: Value) -> Result<()> {
        self.tx
            .send(ClaudeSessionCommand::Steer { line, message })
            .map_err(|_| anyhow::anyhow!("Claude Code session has exited"))
    }

    pub fn abort(&self) {
        let _ = self.tx.send(ClaudeSessionCommand::Abort);
    }

    pub fn shutdown(&self) {
        let _ = self.tx.send(ClaudeSessionCommand::Shutdown);
    }

    pub fn is_alive(&self) -> bool {
        !self.tx.is_closed()
    }
}

/// Spawn a persistent Claude Code session. `opts.resume` is used only when the
/// process is first created; subsequent turns are sent over the same stdin.
pub fn spawn_claude_session(
    base_sink: Arc<dyn EventSink>,
    bin: &str,
    cwd: &Path,
    artifact_dir: Option<PathBuf>,
    conversation_id: Option<String>,
    extra_env: Vec<(String, String)>,
    opts: CliRunOpts,
    // Persistence channel for messages of SELF-STARTED continuation turns
    // (a Monitor/subagent wake-up streams with no registered turn, so no
    // CliTurnOutcome ever carries them; without this they exist only in the
    // CLI's own session file and vanish from Cetus on restart).
    orphan_messages: Option<tokio::sync::mpsc::UnboundedSender<Vec<Value>>>,
) -> Result<ClaudeSessionHandle> {
    let translator_cwd = cwd.to_path_buf();
    let args = CliBackend::ClaudeCode.turn_args("", &opts);
    let mut cmd = TokioCommand::new(bin);
    cmd.args(&args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let mut child = cmd
        .spawn()
        .with_context(|| format!("failed to launch `{bin}`"))?;
    let mut stdin = child.stdin.take().context("Claude Code stdin missing")?;
    let stdout = child.stdout.take().context("Claude Code stdout missing")?;
    let stderr = child.stderr.take();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let handle = ClaudeSessionHandle { tx };

    tokio::spawn(async move {
        let emit = |sink: &Arc<dyn EventSink>, events: Vec<Value>| {
            for event in events {
                sink.emit(RuntimeEvent::Protocol {
                    conversation_id: conversation_id.clone(),
                    event,
                });
            }
        };
        // Initialize the bidirectional control protocol once for the whole
        // process. User messages follow as StartTurn commands.
        if let Some(init) = claude_stdin_lines("", &[]).into_iter().next() {
            if stdin.write_all(init.as_bytes()).await.is_err()
                || stdin.write_all(b"\n").await.is_err()
                || stdin.flush().await.is_err()
            {
                return;
            }
        }

        let stderr_buf = Arc::new(tokio::sync::Mutex::new(String::new()));
        if let Some(stderr) = stderr {
            let buf = stderr_buf.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut out = buf.lock().await;
                    if out.len() < 4000 {
                        out.push_str(&line);
                        out.push('\n');
                    }
                }
            });
        }

        let mut reader = BufReader::new(stdout).lines();
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        if let Some(dir) = artifact_dir {
            tr = tr.with_artifact_storage(dir, translator_cwd);
        }
        let mut active: Option<ActiveTurn> = None;
        let mut killed = false;
        let mut interrupted = false;
        let mut control_id = 2u64;
        // True while a SELF-STARTED continuation turn we announced with
        // agent_start is streaming (no registered turn owns it). Its close —
        // on its result, on a user StartTurn arriving mid-flight, or on
        // process exit — must emit the matching message_end/agent_end.
        let mut continuation = false;

        loop {
            tokio::select! {
                cmd = rx.recv() => match cmd {
                    Some(ClaudeSessionCommand::StartTurn { line, sink, outcome }) => {
                        if active.is_some() {
                            let _ = outcome.send(CliTurnOutcome {
                                resume_id: tr.resume_id.clone(), messages: Vec::new(),
                                aborted: false, streamed: false, resume_rejected: false,
                                error: None,
                            });
                            continue;
                        }
                        // A continuation turn may still be mid-flight (e.g.
                        // blocked on an AskUserQuestion) — begin_next_turn
                        // would wipe whatever it accumulated. Close its stream
                        // if we opened one, settle the completed blocks, and
                        // ship them for persistence.
                        if continuation {
                            emit(&base_sink, tr.finish(None));
                            continuation = false;
                        }
                        if let Some(orphan) = &orphan_messages {
                            tr.flush_assistant();
                            let msgs = tr.take_messages();
                            if !msgs.is_empty() {
                                let _ = orphan.send(msgs);
                            }
                        }
                        tr.begin_next_turn();
                        interrupted = false;
                        emit(&sink, tr.start());
                        if stdin.write_all(line.as_bytes()).await.is_err()
                            || stdin.write_all(b"\n").await.is_err()
                            || stdin.flush().await.is_err()
                        {
                            emit(&sink, tr.finish(Some("Claude Code stdin closed")));
                            let _ = outcome.send(CliTurnOutcome {
                                resume_id: tr.resume_id.clone(), messages: tr.take_messages(),
                                aborted: false, streamed: tr.opened,
                                resume_rejected: false,
                                error: Some("Claude Code stdin closed".to_string()),
                            });
                            break;
                        }
                        active = Some(ActiveTurn { sink, outcome });
                    }
                    Some(ClaudeSessionCommand::Input(line)) => {
                        let _ = stdin.write_all(line.as_bytes()).await;
                        let _ = stdin.write_all(b"\n").await;
                        let _ = stdin.flush().await;
                    }
                    Some(ClaudeSessionCommand::Steer { line, message }) => {
                        let _ = stdin.write_all(line.as_bytes()).await;
                        let _ = stdin.write_all(b"\n").await;
                        let _ = stdin.flush().await;
                        tr.queue_steer(message);
                    }
                    Some(ClaudeSessionCommand::Abort) => {
                        // Agent SDK streaming mode supports an out-of-band
                        // interrupt control request. This stops only the active
                        // model turn; session-owned background Bash jobs stay
                        // alive, matching native Claude Code.
                        let line = json!({
                            "type": "control_request",
                            "request_id": format!("cetus-interrupt-{control_id}"),
                            "request": { "subtype": "interrupt" },
                        }).to_string();
                        control_id += 1;
                        let _ = stdin.write_all(line.as_bytes()).await;
                        let _ = stdin.write_all(b"\n").await;
                        let _ = stdin.flush().await;
                        interrupted = true;
                    }
                    Some(ClaudeSessionCommand::Shutdown) | None => {
                        killed = true;
                        let _ = child.start_kill();
                        break;
                    }
                },
                line = reader.next_line() => {
                    let line = match line { Ok(Some(line)) => line, _ => break };
                    // A completed background task re-invokes the model: the CLI
                    // starts a continuation turn no StartTurn ever announced.
                    // Without re-arming here, the previous turn's `opened` flag
                    // suppresses the fresh message_start and the frontend
                    // reducer drops every delta (no assistant slot) — the reply
                    // would persist via the orphan channel yet never render
                    // live. Re-open the stream on the turn's first content line.
                    if active.is_none() && tr.finished && is_continuation_content(&line) {
                        if let Some(orphan) = &orphan_messages {
                            tr.flush_assistant();
                            let msgs = tr.take_messages();
                            if !msgs.is_empty() {
                                let _ = orphan.send(msgs);
                            }
                        }
                        tr.begin_next_turn();
                        continuation = true;
                        emit(&base_sink, tr.start());
                    }
                    let sink = active.as_ref().map(|a| &a.sink).unwrap_or(&base_sink);
                    let events = tr.on_line(&line);
                    if !events.is_empty() { emit(sink, events); }
                    // Continuation-turn content settles with no registered
                    // turn to carry it into a CliTurnOutcome — persist each
                    // message as it completes, in stream order (so it lands
                    // BEFORE any later user message row, matching when it
                    // actually happened).
                    if active.is_none() && !tr.messages.is_empty() {
                        if let Some(orphan) = &orphan_messages {
                            let _ = orphan.send(tr.take_messages());
                        }
                    }
                    if tr.saw_result && tr.result_is_spurious() {
                        tr.saw_result = false;
                        continue;
                    }
                    if tr.saw_result && tr.has_pending_turn_tasks() {
                        // Claude will emit a continuation turn when an async
                        // agent/workflow settles. A background Bash task is not
                        // included here and may outlive the completed turn.
                        tr.saw_result = false;
                        continue;
                    }
                    if tr.saw_result {
                        let Some(turn) = active.take() else {
                            // A self-started continuation turn settled: close
                            // its stream the way a registered turn closes
                            // (message_end/agent_end — only if we opened it
                            // with agent_start above) and persist what it
                            // produced, nothing else will.
                            if continuation {
                                emit(&base_sink, tr.finish(None));
                                continuation = false;
                            } else {
                                tr.flush_assistant();
                            }
                            if let Some(orphan) = &orphan_messages {
                                let msgs = tr.take_messages();
                                if !msgs.is_empty() {
                                    let _ = orphan.send(msgs);
                                }
                            }
                            tr.saw_result = false;
                            continue;
                        };
                        // Take the error unconditionally for the outcome (the
                        // auto-retry decision needs it either way) but render
                        // it only when nothing streamed — claude repeats the
                        // error text in the result payload, and the streamed
                        // version is already on screen.
                        let result_error = tr.result_error.take();
                        let err = if tr.messages.is_empty() && tr.assistant_blocks_empty() {
                            result_error.clone()
                        } else { None };
                        emit(&turn.sink, tr.finish(err.as_deref()));
                        let streamed = tr.opened;
                        let _ = turn.outcome.send(CliTurnOutcome {
                            resume_id: tr.resume_id.clone(),
                            messages: tr.take_messages(),
                            aborted: interrupted,
                            streamed,
                            resume_rejected: false,
                            error: result_error,
                        });
                    }
                }
            }
        }

        if let Some(turn) = active.take() {
            let stderr = stderr_buf.lock().await.trim().to_string();
            let err = if killed {
                None
            } else if stderr.is_empty() {
                Some("Claude Code session exited unexpectedly".to_string())
            } else {
                Some(auth_expired_hint(CliBackend::ClaudeCode, &stderr).unwrap_or(stderr))
            };
            emit(&turn.sink, tr.finish(err.as_deref()));
            let streamed = tr.opened;
            let _ = turn.outcome.send(CliTurnOutcome {
                resume_id: tr.resume_id.clone(),
                messages: tr.take_messages(),
                aborted: killed,
                streamed,
                resume_rejected: false,
                error: err,
            });
        } else if let Some(orphan) = &orphan_messages {
            // No active turn to carry them: settle and ship whatever a
            // continuation turn accumulated before the process died — closing
            // its stream if we announced one, so the frontend isn't left on a
            // forever-streaming bubble.
            if continuation {
                emit(&base_sink, tr.finish(None));
            } else {
                tr.flush_assistant();
            }
            let msgs = tr.take_messages();
            if !msgs.is_empty() {
                let _ = orphan.send(msgs);
            }
        }
        // The child owned every live background task (Monitors, async agents,
        // background Bash) — it's gone, so clear the frontend's task strip.
        emit(
            &base_sink,
            vec![json!({ "type": "cli_background_tasks", "tasks": [] })],
        );
        let _ = child.wait().await;
    });

    Ok(handle)
}
