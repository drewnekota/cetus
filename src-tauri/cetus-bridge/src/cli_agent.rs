//! CLI-agent backends (Claude Code, Codex) that reuse Cetus's structured-event
//! transport instead of the `pi --mode rpc` protocol.
//!
//! Superset/Conductor-style orchestration boils down to: spawn the vendor CLI
//! as a child process, isolate it in a git worktree, and stream its output back
//! to the UI. Both `claude` and `codex` can run headless and emit a **structured
//! JSON event stream** (`claude -p --output-format stream-json`, `codex exec
//! --json`), so we don't need a PTY scraper — we parse their JSONL and translate
//! it into the exact same `PiEvent` shape the frontend `chatReducer` already
//! consumes. That means a claude/codex turn renders through the existing chat UI
//! with zero frontend changes: text, thinking, and tool cards all just work.
//!
//! The translation is a pure, stateful function (`EventTranslator`) so it is unit
//! tested against captured CLI output — matching the crate's habit of testing the
//! protocol layer rather than spawning live processes.

use crate::bridge::RuntimeEvent;
use crate::pi_rpc::EventSink;
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as TokioCommand;

/// Which coding-agent CLI backs a conversation. `pi` stays the default and is
/// handled by [`crate::pi_rpc::PiRpc`]; these are the CLI-subprocess backends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliBackend {
    ClaudeCode,
    Codex,
}

impl CliBackend {
    /// Stable identifier persisted on a conversation and sent from the UI.
    pub fn as_str(self) -> &'static str {
        match self {
            CliBackend::ClaudeCode => "claude-code",
            CliBackend::Codex => "codex",
        }
    }

    pub fn from_id(s: &str) -> Option<Self> {
        match s {
            "claude-code" | "claude" => Some(CliBackend::ClaudeCode),
            "codex" => Some(CliBackend::Codex),
            _ => None,
        }
    }

    /// Default executable name resolved on `PATH` (overridable by the caller).
    pub fn default_bin(self) -> &'static str {
        match self {
            CliBackend::ClaudeCode => "claude",
            CliBackend::Codex => "codex",
        }
    }
}

/// Per-turn knobs. Kept intentionally small; danger flags are opt-in so the
/// default is the safer permission-prompting mode.
#[derive(Debug, Clone, Default)]
pub struct CliRunOpts {
    pub model: Option<String>,
    /// Resume token from a previous turn (`claude --resume <id>` /
    /// `codex exec resume <id>`) so a conversation keeps context across turns.
    pub resume: Option<String>,
    /// Skip permission/approval prompts and sandboxing. Required for unattended
    /// runs; the app should gate this behind an explicit user setting.
    pub bypass_approvals: bool,
}

impl CliBackend {
    /// Build the argv for a single headless turn executed with cwd = worktree.
    ///
    /// The prompt is passed as the final positional argument (both CLIs accept
    /// it that way), so callers must still close stdin to stop `codex` from
    /// blocking on "additional input from stdin".
    pub fn turn_args(self, prompt: &str, opts: &CliRunOpts) -> Vec<String> {
        let mut a: Vec<String> = Vec::new();
        match self {
            CliBackend::ClaudeCode => {
                a.push("-p".into());
                a.push("--output-format".into());
                a.push("stream-json".into());
                a.push("--verbose".into()); // required for stream-json to emit all events
                if let Some(m) = &opts.model {
                    a.push("--model".into());
                    a.push(m.clone());
                }
                if let Some(r) = &opts.resume {
                    a.push("--resume".into());
                    a.push(r.clone());
                }
                if opts.bypass_approvals {
                    a.push("--dangerously-skip-permissions".into());
                } else {
                    a.push("--permission-mode".into());
                    a.push("acceptEdits".into());
                }
                a.push(prompt.into());
            }
            CliBackend::Codex => {
                a.push("exec".into());
                if let Some(r) = &opts.resume {
                    a.push("resume".into());
                    a.push(r.clone());
                }
                a.push("--json".into());
                a.push("--skip-git-repo-check".into());
                if let Some(m) = &opts.model {
                    a.push("-m".into());
                    a.push(m.clone());
                }
                if opts.bypass_approvals {
                    a.push("--dangerously-bypass-approvals-and-sandbox".into());
                } else {
                    a.push("-s".into());
                    a.push("workspace-write".into());
                }
                a.push(prompt.into());
            }
        }
        a
    }
}

/// Normalize a tool-result payload (string | array | object) into the
/// `PiContentBlock[]` array the frontend renders in a tool card.
fn normalize_content(v: &Value) -> Value {
    match v {
        Value::String(s) => json!([{ "type": "text", "text": s }]),
        Value::Array(items) => {
            let blocks: Vec<Value> = items
                .iter()
                .map(|it| match it {
                    Value::String(s) => json!({ "type": "text", "text": s }),
                    Value::Object(o) => {
                        if o.get("type").and_then(|t| t.as_str()) == Some("text") {
                            it.clone()
                        } else if let Some(t) = o.get("text").and_then(|t| t.as_str()) {
                            json!({ "type": "text", "text": t })
                        } else {
                            json!({ "type": "text", "text": it.to_string() })
                        }
                    }
                    other => json!({ "type": "text", "text": other.to_string() }),
                })
                .collect();
            Value::Array(blocks)
        }
        Value::Null => json!([]),
        other => json!([{ "type": "text", "text": other.to_string() }]),
    }
}

/// Stateful translator from a backend's raw JSONL lines to Cetus `PiEvent`
/// values. Allocates a monotonic `contentIndex` per block and remembers which
/// tool-call ids map to which block so `tool_execution_*` events line up with
/// the `tool_use` card the frontend already created.
pub struct EventTranslator {
    backend: CliBackend,
    next_index: usize,
    /// Resume token discovered from the stream (claude `session_id`, codex
    /// `thread_id`). Returned to the caller for the next turn.
    pub resume_id: Option<String>,
    finished: bool,
}

impl EventTranslator {
    pub fn new(backend: CliBackend) -> Self {
        Self {
            backend,
            next_index: 0,
            resume_id: None,
            finished: false,
        }
    }

    fn alloc_index(&mut self) -> usize {
        let i = self.next_index;
        self.next_index += 1;
        i
    }

    /// PiEvents to emit before feeding any lines: opens the assistant bubble.
    pub fn start(&self) -> Vec<Value> {
        vec![
            json!({ "type": "agent_start" }),
            json!({ "type": "message_start", "message": { "role": "assistant" } }),
        ]
    }

    /// PiEvents to emit after the process exits. `error` surfaces a failure as a
    /// visible assistant text block so a crashed turn isn't a blank bubble.
    pub fn finish(&mut self, error: Option<&str>) -> Vec<Value> {
        let mut out = Vec::new();
        if let Some(msg) = error {
            out.extend(self.emit_text(&format!("⚠️ agent error: {msg}")));
        }
        out.push(json!({ "type": "message_end" }));
        out.push(json!({ "type": "agent_end" }));
        self.finished = true;
        out
    }

    /// Emit a complete text block (start+delta+end) at a fresh index.
    fn emit_text(&mut self, text: &str) -> Vec<Value> {
        let i = self.alloc_index();
        vec![
            am(json!({ "type": "text_start", "contentIndex": i })),
            am(json!({ "type": "text_delta", "contentIndex": i, "delta": text })),
            am(json!({ "type": "text_end", "contentIndex": i, "content": text })),
        ]
    }

    fn emit_thinking(&mut self, text: &str) -> Vec<Value> {
        let i = self.alloc_index();
        vec![
            am(json!({ "type": "thinking_start", "contentIndex": i })),
            am(json!({ "type": "thinking_delta", "contentIndex": i, "delta": text })),
            am(json!({ "type": "thinking_end", "contentIndex": i, "content": text })),
        ]
    }

    /// Emit a tool_use card (toolcall_start + toolcall_end). The id is what
    /// later `tool_execution_*` events reference.
    fn emit_tool_call(&mut self, id: &str, name: &str, arguments: &Value) -> Vec<Value> {
        let i = self.alloc_index();
        vec![
            am(json!({ "type": "toolcall_start", "contentIndex": i })),
            am(json!({
                "type": "toolcall_end",
                "contentIndex": i,
                "toolCall": { "id": id, "name": name, "arguments": arguments },
            })),
        ]
    }

    fn emit_tool_result(&self, id: &str, content: &Value, is_error: bool) -> Vec<Value> {
        vec![
            json!({ "type": "tool_execution_start", "toolCallId": id }),
            json!({
                "type": "tool_execution_end",
                "toolCallId": id,
                "result": { "content": normalize_content(content), "details": Value::Null },
                "isError": is_error,
            }),
        ]
    }

    /// Translate one raw JSONL line from the CLI into zero or more PiEvents.
    pub fn on_line(&mut self, line: &str) -> Vec<Value> {
        let line = line.trim();
        if line.is_empty() {
            return Vec::new();
        }
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            // Non-JSON chatter (banners, "Reading additional input…") is ignored.
            Err(_) => return Vec::new(),
        };
        match self.backend {
            CliBackend::ClaudeCode => self.on_claude(&v),
            CliBackend::Codex => self.on_codex(&v),
        }
    }

    fn on_claude(&mut self, v: &Value) -> Vec<Value> {
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match ty {
            "system" => {
                if v.get("subtype").and_then(|s| s.as_str()) == Some("init") {
                    if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                        self.resume_id = Some(sid.to_string());
                    }
                }
                Vec::new()
            }
            "assistant" => {
                let mut out = Vec::new();
                let content = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array());
                if let Some(blocks) = content {
                    for b in blocks {
                        match b.get("type").and_then(|t| t.as_str()) {
                            Some("text") => {
                                let t = b.get("text").and_then(|t| t.as_str()).unwrap_or("");
                                if !t.is_empty() {
                                    out.extend(self.emit_text(t));
                                }
                            }
                            Some("thinking") => {
                                let t = b.get("thinking").and_then(|t| t.as_str()).unwrap_or("");
                                if !t.is_empty() {
                                    out.extend(self.emit_thinking(t));
                                }
                            }
                            Some("tool_use") => {
                                let id = b.get("id").and_then(|t| t.as_str()).unwrap_or("");
                                let name = b.get("name").and_then(|t| t.as_str()).unwrap_or("tool");
                                let args = b.get("input").cloned().unwrap_or(Value::Null);
                                out.extend(self.emit_tool_call(id, name, &args));
                            }
                            _ => {}
                        }
                    }
                }
                out
            }
            "user" => {
                let mut out = Vec::new();
                let content = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array());
                if let Some(blocks) = content {
                    for b in blocks {
                        if b.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                            let id = b
                                .get("tool_use_id")
                                .and_then(|t| t.as_str())
                                .unwrap_or("");
                            let is_err = b.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
                            let c = b.get("content").cloned().unwrap_or(Value::Null);
                            out.extend(self.emit_tool_result(id, &c, is_err));
                        }
                    }
                }
                out
            }
            // "result" is terminal; finish() handles turn close. Ignore rest.
            _ => Vec::new(),
        }
    }

    fn on_codex(&mut self, v: &Value) -> Vec<Value> {
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match ty {
            "thread.started" => {
                if let Some(tid) = v.get("thread_id").and_then(|s| s.as_str()) {
                    self.resume_id = Some(tid.to_string());
                }
                Vec::new()
            }
            "item.completed" => {
                let item = match v.get("item") {
                    Some(i) => i,
                    None => return Vec::new(),
                };
                let item_ty = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
                let id = item.get("id").and_then(|t| t.as_str()).unwrap_or("item");
                match item_ty {
                    "agent_message" => {
                        let t = item.get("text").and_then(|t| t.as_str()).unwrap_or("");
                        if t.is_empty() {
                            Vec::new()
                        } else {
                            self.emit_text(t)
                        }
                    }
                    "reasoning" => {
                        let t = item.get("text").and_then(|t| t.as_str()).unwrap_or("");
                        if t.is_empty() {
                            Vec::new()
                        } else {
                            self.emit_thinking(t)
                        }
                    }
                    "command_execution" => {
                        let cmd = item.get("command").cloned().unwrap_or(Value::Null);
                        let args = json!({ "command": cmd });
                        let mut out = self.emit_tool_call(id, "shell", &args);
                        let output = item
                            .get("aggregated_output")
                            .or_else(|| item.get("output"))
                            .cloned()
                            .unwrap_or(Value::Null);
                        let is_err = item
                            .get("exit_code")
                            .and_then(|c| c.as_i64())
                            .map(|c| c != 0)
                            .unwrap_or(false);
                        out.extend(self.emit_tool_result(id, &output, is_err));
                        out
                    }
                    "file_change" => {
                        let changes = item.get("changes").cloned().unwrap_or(Value::Null);
                        let mut out = self.emit_tool_call(id, "apply_patch", &changes);
                        out.extend(self.emit_tool_result(id, &json!("applied"), false));
                        out
                    }
                    "mcp_tool_call" => {
                        let name = item
                            .get("tool")
                            .and_then(|t| t.as_str())
                            .unwrap_or("mcp_tool");
                        let args = item.get("arguments").cloned().unwrap_or(Value::Null);
                        let mut out = self.emit_tool_call(id, name, &args);
                        let result = item.get("result").cloned().unwrap_or(Value::Null);
                        out.extend(self.emit_tool_result(id, &result, false));
                        out
                    }
                    "error" => {
                        let msg = item.get("message").and_then(|m| m.as_str()).unwrap_or("error");
                        self.emit_text(&format!("⚠️ {msg}"))
                    }
                    _ => Vec::new(),
                }
            }
            // "turn.completed" is terminal; finish() closes the turn.
            _ => Vec::new(),
        }
    }
}

/// Wrap an `assistantMessageEvent` payload in the `message_update` PiEvent.
fn am(event: Value) -> Value {
    json!({ "type": "message_update", "assistantMessageEvent": event })
}

/// Spawn a single headless turn of `backend` with cwd = `cwd`, stream its
/// output to `sink` as `RuntimeEvent::Protocol` PiEvents, and return the resume
/// token (session/thread id) for the next turn.
///
/// One process per turn (not a long-lived RPC like pi): simpler, crash-isolated,
/// and matches how `claude -p` / `codex exec` are designed to be scripted.
pub async fn run_cli_turn(
    sink: Arc<dyn EventSink>,
    backend: CliBackend,
    bin: &str,
    cwd: &Path,
    prompt: &str,
    conversation_id: Option<String>,
    extra_env: Vec<(String, String)>,
    opts: CliRunOpts,
) -> Result<Option<String>> {
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

    let args = backend.turn_args(prompt, &opts);
    let mut cmd = TokioCommand::new(bin);
    cmd.args(&args)
        .current_dir(cwd)
        .stdin(Stdio::null()) // close stdin so codex doesn't block on it
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in extra_env {
        cmd.env(k, v);
    }

    let mut child = cmd
        .spawn()
        .with_context(|| format!("failed to spawn {bin} ({})", backend.as_str()))?;

    let stdout = child
        .stdout
        .take()
        .context("child stdout missing")?;
    let stderr = child.stderr.take();

    let mut reader = BufReader::new(stdout).lines();
    while let Some(line) = reader.next_line().await? {
        let events = tr.on_line(&line);
        if !events.is_empty() {
            emit(&sink, events);
        }
    }

    let status = child.wait().await?;
    let err = if status.success() {
        None
    } else {
        // Drain stderr for a human-readable failure reason.
        let mut msg = format!("{} exited with {}", backend.as_str(), status);
        if let Some(se) = stderr {
            let mut lines = BufReader::new(se).lines();
            let mut buf = String::new();
            while let Ok(Some(l)) = lines.next_line().await {
                buf.push_str(&l);
                buf.push('\n');
                if buf.len() > 2000 {
                    break;
                }
            }
            let buf = buf.trim();
            if !buf.is_empty() {
                msg = format!("{msg}: {buf}");
            }
        }
        Some(msg)
    };

    emit(&sink, tr.finish(err.as_deref()));
    Ok(tr.resume_id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn types(events: &[Value]) -> Vec<String> {
        events
            .iter()
            .map(|e| {
                let t = e.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if t == "message_update" {
                    let sub = e
                        .get("assistantMessageEvent")
                        .and_then(|a| a.get("type"))
                        .and_then(|t| t.as_str())
                        .unwrap_or("");
                    format!("message_update:{sub}")
                } else {
                    t.to_string()
                }
            })
            .collect()
    }

    #[test]
    fn claude_text_tool_and_result_translate() {
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        // init carries the resume session id
        tr.on_line(r#"{"type":"system","subtype":"init","session_id":"sess-1","cwd":"/tmp"}"#);
        assert_eq!(tr.resume_id.as_deref(), Some("sess-1"));

        // an assistant tool_use call
        let ev = tr.on_line(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-9","name":"Bash","input":{"command":"ls"}}]}}"#,
        );
        assert_eq!(
            types(&ev),
            vec!["message_update:toolcall_start", "message_update:toolcall_end"]
        );
        // the tool_use id is threaded onto toolcall_end
        assert_eq!(
            ev[1]["assistantMessageEvent"]["toolCall"]["id"],
            json!("tool-9")
        );

        // its result comes back on a user message
        let ev = tr.on_line(
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-9","content":"file.txt","is_error":false}]}}"#,
        );
        assert_eq!(types(&ev), vec!["tool_execution_start", "tool_execution_end"]);
        assert_eq!(ev[1]["toolCallId"], json!("tool-9"));
        assert_eq!(ev[1]["result"]["content"][0]["text"], json!("file.txt"));

        // final answer text
        let ev = tr.on_line(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}"#,
        );
        assert_eq!(
            types(&ev),
            vec![
                "message_update:text_start",
                "message_update:text_delta",
                "message_update:text_end"
            ]
        );
    }

    #[test]
    fn claude_content_indices_are_monotonic() {
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        tr.on_line(r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hmm"}]}}"#);
        let ev = tr.on_line(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}"#,
        );
        // thinking took index 0, so text must be index 1
        assert_eq!(ev[0]["assistantMessageEvent"]["contentIndex"], json!(1));
    }

    #[test]
    fn codex_message_reasoning_and_command_translate() {
        let mut tr = EventTranslator::new(CliBackend::Codex);
        tr.on_line(r#"{"type":"thread.started","thread_id":"thr-7"}"#);
        assert_eq!(tr.resume_id.as_deref(), Some("thr-7"));
        assert!(tr.on_line(r#"{"type":"turn.started"}"#).is_empty());

        let ev = tr.on_line(
            r#"{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"ls","aggregated_output":"a.txt","exit_code":0}}"#,
        );
        assert_eq!(
            types(&ev),
            vec![
                "message_update:toolcall_start",
                "message_update:toolcall_end",
                "tool_execution_start",
                "tool_execution_end"
            ]
        );
        assert_eq!(ev[1]["assistantMessageEvent"]["toolCall"]["name"], json!("shell"));

        let ev = tr.on_line(
            r#"{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"OK"}}"#,
        );
        assert_eq!(
            types(&ev),
            vec![
                "message_update:text_start",
                "message_update:text_delta",
                "message_update:text_end"
            ]
        );
    }

    #[test]
    fn turn_open_and_close_events() {
        let mut tr = EventTranslator::new(CliBackend::Codex);
        assert_eq!(types(&tr.start()), vec!["agent_start", "message_start"]);
        assert_eq!(types(&tr.finish(None)), vec!["message_end", "agent_end"]);

        let mut tr = EventTranslator::new(CliBackend::Codex);
        let ev = tr.finish(Some("boom"));
        // an error turns into a visible text block before close
        assert_eq!(
            types(&ev),
            vec![
                "message_update:text_start",
                "message_update:text_delta",
                "message_update:text_end",
                "message_end",
                "agent_end"
            ]
        );
    }

    #[test]
    fn backend_ids_round_trip() {
        assert_eq!(CliBackend::from_id("codex"), Some(CliBackend::Codex));
        assert_eq!(CliBackend::from_id("claude-code"), Some(CliBackend::ClaudeCode));
        assert_eq!(CliBackend::from_id("pi"), None);
        assert_eq!(CliBackend::Codex.as_str(), "codex");
    }

    #[test]
    fn claude_argv_shape() {
        let args = CliBackend::ClaudeCode.turn_args(
            "hello",
            &CliRunOpts {
                model: Some("claude-x".into()),
                resume: Some("sess-1".into()),
                bypass_approvals: false,
            },
        );
        assert!(args.contains(&"--output-format".to_string()));
        assert!(args.contains(&"stream-json".to_string()));
        assert!(args.contains(&"--resume".to_string()));
        assert!(args.contains(&"acceptEdits".to_string()));
        assert_eq!(args.last().unwrap(), "hello");
    }

    #[test]
    fn codex_argv_shape() {
        let args = CliBackend::Codex.turn_args(
            "hello",
            &CliRunOpts {
                model: None,
                resume: None,
                bypass_approvals: true,
            },
        );
        assert_eq!(args[0], "exec");
        assert!(args.contains(&"--json".to_string()));
        assert!(args.contains(&"--dangerously-bypass-approvals-and-sandbox".to_string()));
        assert_eq!(args.last().unwrap(), "hello");
    }
}
