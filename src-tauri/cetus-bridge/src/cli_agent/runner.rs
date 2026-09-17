use super::{
    auth_expired_hint, claude_stdin_lines, is_turn_activity, is_usage_limit, usage_limit_hint,
    CliBackend, CliRunOpts, CliTurnOutcome, EventTranslator,
};
use crate::bridge::RuntimeEvent;
use crate::pi_rpc::EventSink;
use anyhow::{Context, Result};
use serde_json::Value;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command as TokioCommand;

/// Spawn a single headless turn of `backend` with cwd = `cwd`, stream its
/// output to `sink` as `RuntimeEvent::Protocol` PiEvents, and return the resume
/// token plus the turn's persistable messages.
///
/// One process per turn (not a long-lived RPC like pi): simpler, crash-isolated,
/// and matches how `claude -p` / `codex exec` are designed to be scripted.
/// `abort` (when provided) kills the child mid-turn on `notify_waiters`; the
/// turn still closes cleanly (message_end/agent_end) with whatever streamed.
///
/// claude runs in bidirectional stream-json mode: the prompt goes over stdin,
/// and `input_rx` lines (control responses answering permission prompts /
/// AskUserQuestion, plus steer user messages) are forwarded to the child as
/// they arrive. The turn closes on the terminal `result` event rather than
/// EOF, since the child then idles waiting for more stdin.
///
/// `steer_pending` counts steer messages injected via `input_rx` and not yet
/// settled. claude normally folds a mid-turn user message into the running
/// turn (one `result` covers both), but one that lands after the model already
/// finished starts a NEW turn after the `result` we're about to close on —
/// killing there would silently swallow the steer. With a pending steer the
/// runner holds the close for a short quiet window instead: fresh turn
/// activity keeps the loop streaming; silence means the steer merged and the
/// child is just idling.
#[allow(clippy::too_many_arguments)]
pub async fn run_cli_turn(
    sink: Arc<dyn EventSink>,
    backend: CliBackend,
    bin: &str,
    cwd: &Path,
    prompt: &str,
    conversation_id: Option<String>,
    extra_env: Vec<(String, String)>,
    opts: CliRunOpts,
    abort: Option<Arc<tokio::sync::Notify>>,
    input_rx: Option<tokio::sync::mpsc::UnboundedReceiver<String>>,
    steer_pending: Option<Arc<std::sync::atomic::AtomicUsize>>,
) -> Result<CliTurnOutcome> {
    let mut tr = EventTranslator::new(backend);
    let emit = |sink: &Arc<dyn EventSink>, events: Vec<Value>| {
        for event in events {
            sink.emit(RuntimeEvent::Protocol {
                conversation_id: conversation_id.clone(),
                event,
            });
        }
    };

    emit(&sink, tr.start());

    let interactive = backend == CliBackend::ClaudeCode;
    let args = backend.turn_args(prompt, &opts);
    let mut cmd = TokioCommand::new(bin);
    cmd.args(&args)
        .current_dir(cwd)
        // claude: stdin carries the prompt + control responses. codex: closed
        // so it doesn't block waiting for extra input.
        .stdin(if interactive {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in extra_env {
        cmd.env(k, v);
    }

    // A failed spawn (binary not installed / not on PATH) must still close the
    // turn — the frontend already saw agent_start, and an open bubble with no
    // agent_end leaves the conversation stuck "streaming" forever.
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!(
                "failed to launch `{bin}` — is {} installed and on PATH? ({e})",
                backend.as_str()
            );
            emit(&sink, tr.finish(Some(&msg)));
            return Ok(CliTurnOutcome {
                resume_id: None,
                messages: tr.take_messages(),
                aborted: false,
                streamed: false,
                resume_rejected: false,
                error: Some(msg),
            });
        }
    };

    // Writer task owning the child's stdin (claude only): handshake + prompt
    // first, then any lines arriving on input_rx (control responses). Dropping
    // the receiver end (task aborts when the turn closes) closes stdin.
    let writer = if interactive {
        let mut stdin = child.stdin.take().context("child stdin missing")?;
        let mut rx = input_rx.unwrap_or_else(|| {
            // No channel provided (e.g. tests): opening lines still go out.
            tokio::sync::mpsc::unbounded_channel().1
        });
        let opening = claude_stdin_lines(prompt, &opts.image_blocks);
        Some(tokio::spawn(async move {
            for line in opening {
                if stdin.write_all(line.as_bytes()).await.is_err() {
                    return;
                }
                let _ = stdin.write_all(b"\n").await;
            }
            let _ = stdin.flush().await;
            while let Some(line) = rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() {
                    return;
                }
                let _ = stdin.write_all(b"\n").await;
                let _ = stdin.flush().await;
            }
            // rx closed → drop stdin → child sees EOF and exits.
        }))
    } else {
        None
    };

    let stdout = child.stdout.take().context("child stdout missing")?;
    let stderr = child.stderr.take();

    let mut reader = BufReader::new(stdout).lines();
    let mut aborted = false;
    let mut spurious_results = 0;
    loop {
        // A read error is treated as end-of-stream rather than bubbled: the
        // turn must always close with message_end/agent_end.
        let line = match &abort {
            Some(n) => tokio::select! {
                line = reader.next_line() => line.unwrap_or(None),
                _ = n.notified() => {
                    // Stop button: kill the child and close the turn with
                    // whatever already streamed.
                    let _ = child.start_kill();
                    aborted = true;
                    None
                }
            },
            None => reader.next_line().await.unwrap_or(None),
        };
        let Some(line) = line else { break };
        let events = tr.on_line(&line);
        if !events.is_empty() {
            emit(&sink, events);
        }
        // Bidirectional mode: `result` ends the turn; the child would idle
        // for more stdin otherwise. Kill it — everything of interest arrived.
        // Exception: a success result with zero streamed content is claude's
        // stale-background-task flush on resume, not our turn's outcome (see
        // `result_is_spurious`). Capped so a genuinely silent turn still
        // closes instead of spinning on an idle child.
        if tr.saw_result {
            if spurious_results < 3 && tr.result_is_spurious() {
                spurious_results += 1;
                tr.saw_result = false;
                continue;
            }
            // Background subagents (async Task/Agent tool) outlive the turn
            // that launched them: the CLI emits an intermediate `result`,
            // then starts a continuation turn once the task completes.
            // Killing here would orphan those agents mid-flight — keep
            // reading until they settle (Stop still aborts via `abort`).
            if tr.result_error.is_none() && tr.has_pending_tasks() {
                tr.saw_result = false;
                continue;
            }
            // A steer is unsettled (see `steer_pending` in the doc comment):
            // hold the close for a short quiet window. Fresh turn activity
            // means the steer landed as a new turn — resume the main loop and
            // close on ITS result; silence means it merged into the turn that
            // just ended and the child is idling for stdin.
            let steered = steer_pending
                .as_ref()
                .map(|s| s.swap(0, std::sync::atomic::Ordering::SeqCst) > 0)
                .unwrap_or(false);
            if steered {
                // Cleared so a second `result` inside the grace window is
                // detectable; restored below when the quiet close stands — a
                // result DID end this turn, and losing the flag would misread
                // the kill as a dirty exit and stall on the stderr drain
                // (which only EOFs once orphaned grandchildren exit).
                tr.saw_result = false;
                // The child reads queued stdin right after `result`; the
                // steered turn's first status line lands well within 2s.
                let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(2000);
                let mut resumed = false;
                loop {
                    let line = tokio::select! {
                        r = tokio::time::timeout_at(deadline, reader.next_line()) => match r {
                            Ok(l) => l.unwrap_or(None), // Err/None: read error or EOF
                            Err(_) => None,             // quiet — the steer merged
                        },
                        _ = async {
                            match &abort {
                                Some(n) => n.notified().await,
                                None => std::future::pending::<()>().await,
                            }
                        } => {
                            aborted = true;
                            None
                        }
                    };
                    let Some(line) = line else { break };
                    let events = tr.on_line(&line);
                    if !events.is_empty() {
                        emit(&sink, events);
                    }
                    if tr.saw_result {
                        break; // the steered turn already closed
                    }
                    if is_turn_activity(&line) {
                        resumed = true;
                        break;
                    }
                    // Idle housekeeping (rate-limit pings, hook bookkeeping):
                    // keep draining until the deadline.
                }
                if resumed {
                    continue;
                }
                tr.saw_result = true;
            }
            // A background subagent ran this turn. Its completion notification
            // and the CLI's continuation turn (where the main agent digests
            // the subagent's report) can arrive AFTER the `result` — observed
            // in both orders on 2.1.201. Hold the close until the stream has
            // been quiet for 2s; any turn activity resumes the main loop.
            if !aborted && tr.result_error.is_none() && tr.saw_background_tasks() {
                let mut resumed = false;
                loop {
                    let deadline =
                        tokio::time::Instant::now() + std::time::Duration::from_millis(2000);
                    let line = tokio::select! {
                        r = tokio::time::timeout_at(deadline, reader.next_line()) => match r {
                            Ok(l) => l.unwrap_or(None), // Err/None: read error or EOF
                            Err(_) => None,             // quiet — the turn really is over
                        },
                        _ = async {
                            match &abort {
                                Some(n) => n.notified().await,
                                None => std::future::pending::<()>().await,
                            }
                        } => {
                            aborted = true;
                            None
                        }
                    };
                    let Some(line) = line else { break };
                    let events = tr.on_line(&line);
                    if !events.is_empty() {
                        emit(&sink, events);
                    }
                    if tr.has_pending_tasks() || is_turn_activity(&line) {
                        resumed = true;
                        break;
                    }
                    // Housekeeping (rate-limit pings, hook bookkeeping) and
                    // stray bare results: keep draining toward the quiet window.
                }
                if resumed && !aborted {
                    tr.saw_result = false;
                    continue;
                }
            }
            let _ = child.start_kill();
            break;
        }
    }
    if let Some(w) = writer {
        w.abort();
    }

    // `agent_start` has already reached the frontend, so a wait failure must
    // still close the protocol turn. This is especially important for Codex
    // steering: interrupting the one-shot child can make process reaping fail
    // on some platforms. Propagating the error here used to leave the chat in
    // `awaitingAssistant` forever because the caller only had an anyhow error,
    // not the translator needed to emit `agent_end`.
    let status = match child.wait().await {
        Ok(status) => status,
        Err(e) => {
            let msg = format!("failed to wait for {} process: {e}", backend.as_str());
            emit(&sink, tr.finish(Some(&msg)));
            return Ok(CliTurnOutcome {
                resume_id: tr.resume_id.clone(),
                messages: tr.take_messages(),
                aborted,
                streamed: tr.opened,
                resume_rejected: false,
                error: Some(msg),
            });
        }
    };
    let clean = status.success() || aborted || tr.saw_result;
    // Stderr carries the failure reason for a dirty exit, but also for a clean
    // exit whose `result` reported an error — a rejected `--resume` logs its
    // "No conversation found" reason only there. Drain it (bounded) whenever
    // either might need it.
    let mut stderr_buf = String::new();
    if !clean || tr.result_error.is_some() {
        if let Some(se) = stderr {
            let mut lines = BufReader::new(se).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                stderr_buf.push_str(&l);
                stderr_buf.push('\n');
                if stderr_buf.len() > 2000 {
                    break;
                }
            }
        }
    }
    let stderr_buf = stderr_buf.trim();
    // Our --resume token pointed at a session the CLI never wrote to disk (its
    // turn was stopped/crashed before content streamed). It can never resume.
    let resume_rejected =
        opts.resume.is_some() && stderr_buf.contains("No conversation found with session ID");
    let mut err = if clean {
        None
    } else {
        let mut msg = format!("{} exited with {}", backend.as_str(), status);
        if !stderr_buf.is_empty() {
            msg = match auth_expired_hint(backend, stderr_buf) {
                Some(hint) => hint,
                None if is_usage_limit(stderr_buf) => usage_limit_hint(backend),
                None => format!("{msg}: {stderr_buf}"),
            };
        }
        Some(msg)
    };
    // A clean exit can still carry an is_error result (e.g. the API refused).
    // Surface it only when nothing streamed — claude repeats the error text in
    // the result payload, and we already rendered the streamed version.
    if err.is_none() && tr.messages.is_empty() && tr.assistant_blocks_empty() {
        err = tr.result_error.take().map(|e| {
            // Quota/credit refusals arrive here as a clean-exit result error
            // (the CLI itself is healthy). Keep the vendor's reason, add the
            // way out — switching runtime keeps this conversation going.
            if is_usage_limit(&e) {
                format!("{e}\n\n{}", usage_limit_hint(backend))
            } else {
                e
            }
        });
    }
    if resume_rejected {
        // Replace the bare "agent reported an error" with what happened and
        // what to do; the caller resets the token, so a resend just works.
        err = Some(format!(
            "{} couldn't resume this conversation's session — it was interrupted \
             before the CLI saved it. The stored session was reset; send your \
             message again to continue.",
            backend.as_str()
        ));
    }

    // The outcome carries the failure even when it wasn't rendered (content
    // streamed, so the error text is already on screen via the stream) — the
    // caller needs it for the transient-error auto-retry decision.
    let outcome_error = err.clone().or_else(|| tr.result_error.take());
    // Captured before finish(): an error emitted there opens the bubble too,
    // but only pre-existing streamed content means the CLI saved the session.
    let streamed = tr.opened;
    emit(&sink, tr.finish(err.as_deref()));
    Ok(CliTurnOutcome {
        resume_id: tr.resume_id.clone(),
        messages: tr.take_messages(),
        aborted,
        streamed,
        resume_rejected,
        error: outcome_error,
    })
}
