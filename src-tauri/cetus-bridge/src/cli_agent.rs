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
    /// Reasoning-effort level, passed through verbatim: `claude --effort
    /// <low|medium|high|xhigh|max>` / codex `-c model_reasoning_effort=
    /// <minimal|low|medium|high|xhigh>`. None → the CLI's own default.
    pub effort: Option<String>,
    /// Resume token from a previous turn (`claude --resume <id>` /
    /// `codex exec resume <id>`) so a conversation keeps context across turns.
    pub resume: Option<String>,
    /// Skip permission/approval prompts and sandboxing. Required for unattended
    /// runs; the app should gate this behind an explicit user setting.
    pub bypass_approvals: bool,
    /// Absolute paths of image attachments saved to disk for this turn. codex
    /// takes them natively via `-i`.
    pub images: Vec<String>,
    /// Image attachments as (mime_type, base64) pairs. claude receives them
    /// inline as content blocks on the stdin user message — the native path.
    pub image_blocks: Vec<(String, String)>,
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
                // Bidirectional stream-json: the prompt goes over stdin (see
                // [`claude_stdin_lines`]), partial messages give token-level
                // streaming, and `--permission-prompt-tool stdio` routes
                // permission prompts AND AskUserQuestion to us as
                // `control_request` lines we answer over stdin — the same
                // control protocol the official desktop/SDK hosts speak.
                a.push("-p".into());
                a.push("--output-format".into());
                a.push("stream-json".into());
                a.push("--input-format".into());
                a.push("stream-json".into());
                a.push("--include-partial-messages".into());
                a.push("--verbose".into()); // required for stream-json to emit all events
                a.push("--permission-prompt-tool".into());
                a.push("stdio".into());
                if let Some(m) = &opts.model {
                    a.push("--model".into());
                    a.push(m.clone());
                }
                if let Some(e) = &opts.effort {
                    a.push("--effort".into());
                    a.push(e.clone());
                }
                if let Some(r) = &opts.resume {
                    a.push("--resume".into());
                    a.push(r.clone());
                }
                // Bypass skips tool approvals only; AskUserQuestion still
                // arrives as a control_request (verified against 2.1.198).
                // Without bypass, claude's default permission mode asks us
                // per tool — rendered as approval cards in the chat.
                if opts.bypass_approvals {
                    a.push("--dangerously-skip-permissions".into());
                }
                let _ = prompt; // claude receives the prompt via stdin
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
                if let Some(e) = &opts.effort {
                    a.push("-c".into());
                    a.push(format!("model_reasoning_effort=\"{e}\""));
                }
                for img in &opts.images {
                    a.push("-i".into());
                    a.push(img.clone());
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

/// The opening lines written to claude's stdin: the control-protocol
/// `initialize` handshake (which is what makes AskUserQuestion and
/// `can_use_tool` prompts available in headless mode), then the user message
/// carrying the prompt and any inline images.
pub fn claude_stdin_lines(prompt: &str, image_blocks: &[(String, String)]) -> Vec<String> {
    let mut content = vec![json!({ "type": "text", "text": prompt })];
    for (mime, data) in image_blocks {
        content.push(json!({
            "type": "image",
            "source": { "type": "base64", "media_type": mime, "data": data },
        }));
    }
    vec![
        json!({
            "type": "control_request",
            "request_id": "init-1",
            "request": { "subtype": "initialize" },
        })
        .to_string(),
        json!({
            "type": "user",
            "message": { "role": "user", "content": content },
        })
        .to_string(),
    ]
}

/// Wrap a host answer to a `control_request` (permission decision or
/// AskUserQuestion answers) into the control_response line claude expects.
pub fn claude_control_response_line(request_id: &str, response: &Value) -> String {
    json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": response,
        },
    })
    .to_string()
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
    /// Content blocks of the assistant message currently being built. Flushed
    /// into `messages` whenever a tool result closes a segment (mirroring how a
    /// pi transcript interleaves assistant / toolResult messages) and at finish.
    assistant_blocks: Vec<Value>,
    /// Completed PiMessage values for this turn, in order — what the caller
    /// persists so the conversation replays after a restart.
    messages: Vec<Value>,
    /// tool-call id → tool name, so toolResult rows carry the name the chat UI
    /// shows on the card.
    tool_names: std::collections::HashMap<String, String>,
    /// Live content blocks of the in-flight claude API message, keyed by the
    /// API's content index. Built from `stream_event` partials; cleared on
    /// each message_start.
    live_blocks: std::collections::HashMap<u64, LiveBlock>,
    /// True once the terminal `result` event arrived (claude bidirectional
    /// mode: the process idles for more stdin after this — the runner uses
    /// this flag to close the turn).
    pub saw_result: bool,
    /// Set when the `result` event reported an error.
    pub result_error: Option<String>,
    /// codex item ids whose tool card was already emitted at `item.started`,
    /// so `item.completed` only adds the result.
    started_items: std::collections::HashSet<String>,
    /// True once the assistant `message_start` was emitted. It is deferred to
    /// the first content-bearing event (not `start()`): a CLI process takes
    /// seconds to boot, and opening the bubble at spawn time would clear the
    /// frontend's "thinking…" placeholder into a bare empty ASSISTANT header
    /// for that whole gap.
    opened: bool,
}

/// One in-flight content block streamed via claude partial events.
struct LiveBlock {
    our_index: usize,
    kind: LiveKind,
    /// Accumulated text / thinking text / tool-input JSON.
    buffer: String,
    /// tool_use only: (id, name).
    tool: Option<(String, String)>,
    closed: bool,
}

#[derive(PartialEq)]
enum LiveKind {
    Text,
    Thinking,
    ToolUse,
}

impl EventTranslator {
    pub fn new(backend: CliBackend) -> Self {
        Self {
            backend,
            next_index: 0,
            resume_id: None,
            finished: false,
            assistant_blocks: Vec::new(),
            messages: Vec::new(),
            tool_names: std::collections::HashMap::new(),
            live_blocks: std::collections::HashMap::new(),
            saw_result: false,
            result_error: None,
            started_items: std::collections::HashSet::new(),
            opened: false,
        }
    }

    /// Move the accumulated PiMessages out (call after `finish`).
    pub fn take_messages(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.messages)
    }

    /// True when no assistant content has accumulated for the open segment.
    pub fn assistant_blocks_empty(&self) -> bool {
        self.assistant_blocks.is_empty()
    }

    /// True when the `result` that just arrived closed a turn that streamed
    /// nothing at all. Resuming a claude session whose previous turn left a
    /// background task running makes the CLI flush one bare success `result`
    /// (enqueueing a task-stopped notification) BEFORE it processes the user
    /// message we queued over stdin — honoring it would swallow the prompt
    /// and leave the conversation silently unresponsive. The runner skips
    /// such results and keeps reading; the real one follows streamed content.
    pub fn result_is_spurious(&self) -> bool {
        self.backend == CliBackend::ClaudeCode
            && self.saw_result
            && self.result_error.is_none()
            && !self.opened
            && self.assistant_blocks.is_empty()
            && self.messages.is_empty()
    }

    /// Close the in-progress assistant message, if any, into `messages`.
    fn flush_assistant(&mut self) {
        if self.assistant_blocks.is_empty() {
            return;
        }
        let blocks = std::mem::take(&mut self.assistant_blocks);
        self.messages
            .push(json!({ "role": "assistant", "content": blocks }));
    }

    fn alloc_index(&mut self) -> usize {
        let i = self.next_index;
        self.next_index += 1;
        i
    }

    /// PiEvents to emit before feeding any lines. Only `agent_start` — the
    /// assistant `message_start` is deferred to the first content event (see
    /// `with_open`) so the frontend keeps its "thinking…" placeholder up while
    /// the CLI boots instead of a bare empty ASSISTANT bubble.
    pub fn start(&self) -> Vec<Value> {
        vec![json!({ "type": "agent_start" })]
    }

    /// Prepend the deferred assistant `message_start` when `events` carries the
    /// first message-level content of the turn. Non-message events (e.g.
    /// `cli_control_request` cards) don't open the bubble.
    fn with_open(&mut self, mut events: Vec<Value>) -> Vec<Value> {
        if !self.opened
            && events.iter().any(|e| {
                matches!(
                    e.get("type").and_then(|t| t.as_str()),
                    Some("message_update") | Some("tool_execution_start") | Some("tool_execution_end")
                )
            })
        {
            self.opened = true;
            events.insert(
                0,
                json!({ "type": "message_start", "message": { "role": "assistant" } }),
            );
        }
        events
    }

    /// PiEvents to emit after the process exits. `error` surfaces a failure as a
    /// visible assistant text block so a crashed turn isn't a blank bubble.
    pub fn finish(&mut self, error: Option<&str>) -> Vec<Value> {
        let mut out = Vec::new();
        if let Some(msg) = error {
            out.extend(self.emit_text(&format!("⚠️ agent error: {msg}")));
        }
        self.flush_assistant();
        let mut out = self.with_open(out);
        // message_end only makes sense for a bubble that was opened; a turn
        // that produced nothing closes with agent_end alone (the reducer
        // clears its placeholder there).
        if self.opened {
            out.push(json!({ "type": "message_end" }));
        }
        out.push(json!({ "type": "agent_end" }));
        self.finished = true;
        out
    }

    /// Emit a complete text block (start+delta+end) at a fresh index.
    fn emit_text(&mut self, text: &str) -> Vec<Value> {
        let i = self.alloc_index();
        self.assistant_blocks
            .push(json!({ "type": "text", "text": text }));
        vec![
            am(json!({ "type": "text_start", "contentIndex": i })),
            am(json!({ "type": "text_delta", "contentIndex": i, "delta": text })),
            am(json!({ "type": "text_end", "contentIndex": i, "content": text })),
        ]
    }

    fn emit_thinking(&mut self, text: &str) -> Vec<Value> {
        let i = self.alloc_index();
        self.assistant_blocks
            .push(json!({ "type": "thinking", "thinking": text }));
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
        self.tool_names.insert(id.to_string(), name.to_string());
        self.assistant_blocks.push(json!({
            "type": "toolCall", "id": id, "name": name, "arguments": arguments,
        }));
        vec![
            am(json!({ "type": "toolcall_start", "contentIndex": i })),
            am(json!({
                "type": "toolcall_end",
                "contentIndex": i,
                "toolCall": { "id": id, "name": name, "arguments": arguments },
            })),
        ]
    }

    fn emit_tool_result(&mut self, id: &str, content: &Value, is_error: bool) -> Vec<Value> {
        let mut out = vec![json!({ "type": "tool_execution_start", "toolCallId": id })];
        out.extend(self.emit_tool_result_end(id, content, is_error));
        out
    }

    /// Just the tool_execution_end (+ transcript row) — for flows that already
    /// emitted tool_execution_start when the tool began running.
    fn emit_tool_result_end(&mut self, id: &str, content: &Value, is_error: bool) -> Vec<Value> {
        let content = normalize_content(content);
        // A result closes the assistant segment that issued the call, matching
        // the assistant / toolResult interleaving of a pi transcript.
        self.flush_assistant();
        self.messages.push(json!({
            "role": "toolResult",
            "toolCallId": id,
            "toolName": self.tool_names.get(id).cloned().unwrap_or_else(|| "tool".to_string()),
            "content": content,
            "isError": is_error,
        }));
        vec![json!({
            "type": "tool_execution_end",
            "toolCallId": id,
            "result": { "content": content, "details": Value::Null },
            "isError": is_error,
        })]
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
        let events = match self.backend {
            CliBackend::ClaudeCode => self.on_claude(&v),
            CliBackend::Codex => self.on_codex(&v),
        };
        self.with_open(events)
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
            // Token-level partials (--include-partial-messages). These carry
            // the live content; the cumulative "assistant" snapshots below are
            // ignored to avoid double-rendering.
            "stream_event" => {
                let Some(event) = v.get("event") else {
                    return Vec::new();
                };
                self.on_claude_stream_event(event)
            }
            // Cumulative snapshots — normally redundant with stream_event
            // partials and ignored. The exception is synthetic messages
            // (model "<synthetic>"): output of locally-handled slash commands
            // (/usage, /context, /compact, …) and CLI-side notices, which never
            // stream partials. Emit their text so those turns aren't blank.
            "assistant" => {
                let msg = v.get("message");
                let model = msg.and_then(|m| m.get("model")).and_then(|m| m.as_str());
                if model != Some("<synthetic>") {
                    return Vec::new();
                }
                let mut out = Vec::new();
                let blocks = msg
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array());
                if let Some(blocks) = blocks {
                    for b in blocks {
                        if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                            let t = b.get("text").and_then(|t| t.as_str()).unwrap_or("");
                            if !t.is_empty() {
                                out.extend(self.emit_text(t));
                            }
                        }
                    }
                }
                out
            }
            // Permission prompt / AskUserQuestion. Forwarded to the frontend
            // as a card; the host answers over stdin via the input channel.
            "control_request" => {
                let request_id = v.get("request_id").and_then(|r| r.as_str()).unwrap_or("");
                let Some(req) = v.get("request") else {
                    return Vec::new();
                };
                if req.get("subtype").and_then(|s| s.as_str()) != Some("can_use_tool") {
                    return Vec::new();
                }
                vec![json!({
                    "type": "cli_control_request",
                    "requestId": request_id,
                    "toolName": req.get("tool_name").and_then(|t| t.as_str()).unwrap_or(""),
                    "input": req.get("input").cloned().unwrap_or(Value::Null),
                    "toolUseId": req.get("tool_use_id").and_then(|t| t.as_str()).unwrap_or(""),
                    "suggestions": req.get("permission_suggestions").cloned().unwrap_or(Value::Null),
                })]
            }
            // Ack of our initialize handshake — nothing to do.
            "control_response" => Vec::new(),
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
            // Terminal event of the turn. In bidirectional mode the process
            // then idles for more stdin — the runner watches `saw_result` to
            // close the turn instead of waiting for EOF.
            "result" => {
                self.saw_result = true;
                if v.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false) {
                    self.result_error = Some(
                        v.get("result")
                            .and_then(|r| r.as_str())
                            .unwrap_or("agent reported an error")
                            .to_string(),
                    );
                }
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    /// One Anthropic streaming event from a claude `stream_event` line →
    /// live PiEvents, mirroring how pi streams blocks.
    fn on_claude_stream_event(&mut self, event: &Value) -> Vec<Value> {
        let ty = event.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match ty {
            "message_start" => {
                // New API message: any straggler blocks are closed by their
                // own content_block_stop; just reset the index map.
                self.live_blocks.clear();
                Vec::new()
            }
            "content_block_start" => {
                let idx = event.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
                let Some(cb) = event.get("content_block") else {
                    return Vec::new();
                };
                let kind = cb.get("type").and_then(|t| t.as_str()).unwrap_or("");
                let our_index = self.alloc_index();
                match kind {
                    "text" => {
                        self.live_blocks.insert(idx, LiveBlock {
                            our_index,
                            kind: LiveKind::Text,
                            buffer: String::new(),
                            tool: None,
                            closed: false,
                        });
                        vec![am(json!({ "type": "text_start", "contentIndex": our_index }))]
                    }
                    "thinking" => {
                        self.live_blocks.insert(idx, LiveBlock {
                            our_index,
                            kind: LiveKind::Thinking,
                            buffer: String::new(),
                            tool: None,
                            closed: false,
                        });
                        vec![am(json!({ "type": "thinking_start", "contentIndex": our_index }))]
                    }
                    "tool_use" => {
                        let id = cb.get("id").and_then(|t| t.as_str()).unwrap_or("");
                        let name = cb.get("name").and_then(|t| t.as_str()).unwrap_or("tool");
                        self.tool_names.insert(id.to_string(), name.to_string());
                        self.live_blocks.insert(idx, LiveBlock {
                            our_index,
                            kind: LiveKind::ToolUse,
                            buffer: String::new(),
                            tool: Some((id.to_string(), name.to_string())),
                            closed: false,
                        });
                        vec![am(json!({ "type": "toolcall_start", "contentIndex": our_index }))]
                    }
                    _ => Vec::new(),
                }
            }
            "content_block_delta" => {
                let idx = event.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
                let Some(delta) = event.get("delta") else {
                    return Vec::new();
                };
                let dty = delta.get("type").and_then(|t| t.as_str()).unwrap_or("");
                let Some(block) = self.live_blocks.get_mut(&idx) else {
                    return Vec::new();
                };
                match dty {
                    "text_delta" => {
                        let t = delta.get("text").and_then(|t| t.as_str()).unwrap_or("");
                        if t.is_empty() {
                            return Vec::new();
                        }
                        block.buffer.push_str(t);
                        vec![am(json!({
                            "type": "text_delta",
                            "contentIndex": block.our_index,
                            "delta": t,
                        }))]
                    }
                    "thinking_delta" => {
                        let t = delta.get("thinking").and_then(|t| t.as_str()).unwrap_or("");
                        if t.is_empty() {
                            return Vec::new();
                        }
                        block.buffer.push_str(t);
                        vec![am(json!({
                            "type": "thinking_delta",
                            "contentIndex": block.our_index,
                            "delta": t,
                        }))]
                    }
                    "input_json_delta" => {
                        let t = delta
                            .get("partial_json")
                            .and_then(|t| t.as_str())
                            .unwrap_or("");
                        block.buffer.push_str(t);
                        Vec::new()
                    }
                    _ => Vec::new(),
                }
            }
            "content_block_stop" => {
                let idx = event.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
                let Some(block) = self.live_blocks.get_mut(&idx) else {
                    return Vec::new();
                };
                if block.closed {
                    return Vec::new();
                }
                block.closed = true;
                let our_index = block.our_index;
                match block.kind {
                    LiveKind::Text => {
                        let text = std::mem::take(&mut block.buffer);
                        self.assistant_blocks
                            .push(json!({ "type": "text", "text": text }));
                        vec![am(json!({
                            "type": "text_end",
                            "contentIndex": our_index,
                            "content": text,
                        }))]
                    }
                    LiveKind::Thinking => {
                        let text = std::mem::take(&mut block.buffer);
                        self.assistant_blocks
                            .push(json!({ "type": "thinking", "thinking": text }));
                        vec![am(json!({
                            "type": "thinking_end",
                            "contentIndex": our_index,
                            "content": text,
                        }))]
                    }
                    LiveKind::ToolUse => {
                        let (id, name) = block.tool.clone().unwrap_or_default();
                        let args: Value =
                            serde_json::from_str(&block.buffer).unwrap_or(json!({}));
                        self.assistant_blocks.push(json!({
                            "type": "toolCall", "id": id, "name": name, "arguments": args,
                        }));
                        vec![am(json!({
                            "type": "toolcall_end",
                            "contentIndex": our_index,
                            "toolCall": { "id": id, "name": name, "arguments": args },
                        }))]
                    }
                }
            }
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
            // A command starts executing: show its tool card immediately (with
            // a running spinner via tool_execution_start) instead of waiting
            // for completion — matches how the codex TUI surfaces commands.
            "item.started" => {
                let item = match v.get("item") {
                    Some(i) => i,
                    None => return Vec::new(),
                };
                if item.get("type").and_then(|t| t.as_str()) != Some("command_execution") {
                    return Vec::new();
                }
                let id = item.get("id").and_then(|t| t.as_str()).unwrap_or("item");
                self.started_items.insert(id.to_string());
                let cmd = item.get("command").cloned().unwrap_or(Value::Null);
                let mut out = self.emit_tool_call(id, "shell", &json!({ "command": cmd }));
                out.push(json!({ "type": "tool_execution_start", "toolCallId": id }));
                out
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
                        // Card already emitted at item.started (normal path) —
                        // just attach the result; emit the full pair otherwise.
                        if self.started_items.remove(id) {
                            return self.emit_tool_result_end(id, &output, is_err);
                        }
                        let cmd = item.get("command").cloned().unwrap_or(Value::Null);
                        let args = json!({ "command": cmd });
                        let mut out = self.emit_tool_call(id, "shell", &args);
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

/// What a completed (or aborted) CLI turn produced.
pub struct CliTurnOutcome {
    /// Resume token (session/thread id) for the next turn, when discovered.
    pub resume_id: Option<String>,
    /// PiMessage-shaped values for this turn's assistant/toolResult messages,
    /// ready to persist for history replay.
    pub messages: Vec<Value>,
    /// True when the turn was cut short by `abort` (the child was killed).
    pub aborted: bool,
}

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
/// AskUserQuestion) are forwarded to the child as they arrive. The turn closes
/// on the terminal `result` event rather than EOF, since the child then idles
/// waiting for more stdin.
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
            use tokio::io::AsyncWriteExt;
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

    let stdout = child
        .stdout
        .take()
        .context("child stdout missing")?;
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
            let _ = child.start_kill();
            break;
        }
    }
    if let Some(w) = writer {
        w.abort();
    }

    let status = child.wait().await?;
    let clean = status.success() || aborted || tr.saw_result;
    let mut err = if clean {
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
    // A clean exit can still carry an is_error result (e.g. the API refused).
    // Surface it only when nothing streamed — claude repeats the error text in
    // the result payload, and we already rendered the streamed version.
    if err.is_none() && tr.messages.is_empty() && tr.assistant_blocks_empty() {
        err = tr.result_error.take();
    }

    emit(&sink, tr.finish(err.as_deref()));
    Ok(CliTurnOutcome {
        resume_id: tr.resume_id.clone(),
        messages: tr.take_messages(),
        aborted,
    })
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

        // a tool_use block streamed via partial events (captured shapes)
        let mut ev = Vec::new();
        ev.extend(tr.on_line(r#"{"type":"stream_event","event":{"type":"message_start","message":{"role":"assistant","content":[]}}}"#));
        ev.extend(tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool-9","name":"Bash","input":{}}}}"#));
        ev.extend(tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"command\": "}}}"#));
        ev.extend(tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"ls\"}"}}}"#));
        ev.extend(tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#));
        // the first content event opens the assistant bubble (deferred
        // message_start — not emitted at spawn time)
        assert_eq!(
            types(&ev),
            vec![
                "message_start",
                "message_update:toolcall_start",
                "message_update:toolcall_end"
            ]
        );
        // the tool_use id + parsed input land on toolcall_end
        assert_eq!(ev[2]["assistantMessageEvent"]["toolCall"]["id"], json!("tool-9"));
        assert_eq!(
            ev[2]["assistantMessageEvent"]["toolCall"]["arguments"]["command"],
            json!("ls")
        );

        // cumulative assistant snapshots are ignored (partials already streamed)
        assert!(tr
            .on_line(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-9","name":"Bash","input":{"command":"ls"}}]}}"#)
            .is_empty());

        // its result comes back on a user message
        let ev = tr.on_line(
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-9","content":"file.txt","is_error":false}]}}"#,
        );
        assert_eq!(types(&ev), vec!["tool_execution_start", "tool_execution_end"]);
        assert_eq!(ev[1]["toolCallId"], json!("tool-9"));
        assert_eq!(ev[1]["result"]["content"][0]["text"], json!("file.txt"));

        // final answer text streams as deltas
        let mut ev = Vec::new();
        ev.extend(tr.on_line(r#"{"type":"stream_event","event":{"type":"message_start","message":{"role":"assistant","content":[]}}}"#));
        ev.extend(tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#));
        ev.extend(tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"do"}}}"#));
        ev.extend(tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ne"}}}"#));
        ev.extend(tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#));
        assert_eq!(
            types(&ev),
            vec![
                "message_update:text_start",
                "message_update:text_delta",
                "message_update:text_delta",
                "message_update:text_end"
            ]
        );
        assert_eq!(ev[3]["assistantMessageEvent"]["content"], json!("done"));

        // result flags the turn as complete (bidirectional close signal)
        tr.on_line(r#"{"type":"result","subtype":"success","is_error":false,"result":"done"}"#);
        assert!(tr.saw_result);
        // …and content streamed, so it's the turn's real outcome.
        assert!(!tr.result_is_spurious());
    }

    #[test]
    fn claude_bare_result_before_any_content_is_spurious() {
        // Captured from claude 2.1.201: resuming a session whose previous turn
        // left a background task running flushes a bare success `result`
        // before the stdin user message is processed. Honoring it would
        // swallow the prompt.
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        tr.on_line(r#"{"type":"system","subtype":"init","session_id":"sess-1","cwd":"/tmp"}"#);
        tr.on_line(r#"{"type":"result","subtype":"success","is_error":false}"#);
        assert!(tr.saw_result);
        assert!(tr.result_is_spurious());

        // The runner skips it; the real turn then streams and closes normally.
        tr.saw_result = false;
        tr.on_line(r#"{"type":"stream_event","event":{"type":"message_start","message":{"role":"assistant","content":[]}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"300"}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);
        tr.on_line(r#"{"type":"result","subtype":"success","is_error":false,"result":"300"}"#);
        assert!(tr.saw_result);
        assert!(!tr.result_is_spurious());
    }

    #[test]
    fn claude_error_result_with_no_content_is_not_spurious() {
        // A turn that fails before streaming anything (API refusal etc.) must
        // still close and surface the error, not spin waiting for more.
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        tr.on_line(r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom"}"#);
        assert!(tr.saw_result);
        assert!(!tr.result_is_spurious());
        assert_eq!(tr.result_error.as_deref(), Some("boom"));
    }

    #[test]
    fn claude_synthetic_snapshot_renders_slash_command_output() {
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        // Captured from claude 2.1.199: `/usage` (and /cost, /context, /compact)
        // is handled locally and arrives ONLY as a synthetic assistant snapshot
        // — no stream_event partials.
        let ev = tr.on_line(
            r#"{"type":"assistant","message":{"id":"m1","model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"Current session: 28% used"}]}}"#,
        );
        assert_eq!(
            types(&ev),
            vec![
                "message_start",
                "message_update:text_start",
                "message_update:text_delta",
                "message_update:text_end"
            ]
        );
        assert_eq!(
            ev[3]["assistantMessageEvent"]["content"],
            json!("Current session: 28% used")
        );
        // …and it persists as a normal assistant message for history replay.
        tr.finish(None);
        let msgs = tr.take_messages();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["content"][0]["text"], json!("Current session: 28% used"));

        // Real-model snapshots stay ignored (partials already streamed them).
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        assert!(tr
            .on_line(r#"{"type":"assistant","message":{"model":"claude-fable-5","content":[{"type":"text","text":"dup"}]}}"#)
            .is_empty());
    }

    #[test]
    fn claude_content_indices_are_monotonic() {
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);
        // the API reuses low indices across messages; ours must stay monotonic
        let ev = tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}}"#);
        assert_eq!(ev[0]["assistantMessageEvent"]["contentIndex"], json!(1));
    }

    #[test]
    fn claude_control_request_forwards_to_ui() {
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        // Captured from claude 2.1.198 (--permission-prompt-tool stdio).
        let ev = tr.on_line(
            r#"{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{"question":"Which color?","header":"Color","options":[{"label":"Red","description":"warm"}],"multiSelect":false}]},"tool_use_id":"toolu_1"}}"#,
        );
        assert_eq!(types(&ev), vec!["cli_control_request"]);
        assert_eq!(ev[0]["requestId"], json!("req-1"));
        assert_eq!(ev[0]["toolName"], json!("AskUserQuestion"));
        assert_eq!(ev[0]["input"]["questions"][0]["question"], json!("Which color?"));
        // the init handshake ack is swallowed
        assert!(tr
            .on_line(r#"{"type":"control_response","response":{"subtype":"success","request_id":"init-1","response":{}}}"#)
            .is_empty());
    }

    #[test]
    fn claude_stdin_lines_shape() {
        let lines = claude_stdin_lines("hi", &[("image/png".into(), "AAAA".into())]);
        assert_eq!(lines.len(), 2);
        let init: Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(init["request"]["subtype"], json!("initialize"));
        let user: Value = serde_json::from_str(&lines[1]).unwrap();
        assert_eq!(user["message"]["content"][0]["text"], json!("hi"));
        assert_eq!(
            user["message"]["content"][1]["source"]["media_type"],
            json!("image/png")
        );
        let resp: Value =
            serde_json::from_str(&claude_control_response_line("r1", &json!({"behavior":"allow"})))
                .unwrap();
        assert_eq!(resp["response"]["request_id"], json!("r1"));
        assert_eq!(resp["response"]["response"]["behavior"], json!("allow"));
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
                "message_start",
                "message_update:toolcall_start",
                "message_update:toolcall_end",
                "tool_execution_start",
                "tool_execution_end"
            ]
        );
        assert_eq!(ev[2]["assistantMessageEvent"]["toolCall"]["name"], json!("shell"));

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
    fn codex_item_started_streams_live_tool_card() {
        let mut tr = EventTranslator::new(CliBackend::Codex);
        // command surfaces the moment it starts running…
        let ev = tr.on_line(
            r#"{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"sleep 2","aggregated_output":""}}"#,
        );
        assert_eq!(
            types(&ev),
            vec![
                "message_start",
                "message_update:toolcall_start",
                "message_update:toolcall_end",
                "tool_execution_start"
            ]
        );
        // …and completion only attaches the result (no duplicate card/start)
        let ev = tr.on_line(
            r#"{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"sleep 2","aggregated_output":"done","exit_code":0}}"#,
        );
        assert_eq!(types(&ev), vec!["tool_execution_end"]);
        assert_eq!(ev[0]["result"]["content"][0]["text"], json!("done"));
    }

    #[test]
    fn turn_open_and_close_events() {
        // message_start is deferred to the first content event, so a turn that
        // never produced content opens no bubble and closes with agent_end only.
        let mut tr = EventTranslator::new(CliBackend::Codex);
        assert_eq!(types(&tr.start()), vec!["agent_start"]);
        assert_eq!(types(&tr.finish(None)), vec!["agent_end"]);

        let mut tr = EventTranslator::new(CliBackend::Codex);
        let ev = tr.finish(Some("boom"));
        // an error turns into a visible text block before close — which opens
        // the (deferred) bubble first
        assert_eq!(
            types(&ev),
            vec![
                "message_start",
                "message_update:text_start",
                "message_update:text_delta",
                "message_update:text_end",
                "message_end",
                "agent_end"
            ]
        );
    }

    /// Collects every Protocol event's inner PiEvent for assertions.
    struct TestSink(std::sync::Mutex<Vec<Value>>);
    impl EventSink for TestSink {
        fn emit(&self, event: RuntimeEvent) {
            if let RuntimeEvent::Protocol { event, .. } = event {
                self.0.lock().unwrap().push(event);
            }
        }
    }

    /// End-to-end over a fake CLI: a shell script standing in for `claude`
    /// ignores its argv and emits captured-format JSONL. Exercises the full
    /// spawn → stream → finish path including resume-token pickup and message
    /// collection.
    #[tokio::test]
    async fn run_cli_turn_streams_and_collects_end_to_end() {
        let dir = std::env::temp_dir().join(format!("cetus-cli-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-claude.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\n\
             echo '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"sess-e2e\"}'\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}}'\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}}'\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":0}}'\n\
             echo '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"hello\"}'\n\
             sleep 30\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
        let outcome = run_cli_turn(
            sink.clone() as Arc<dyn EventSink>,
            CliBackend::ClaudeCode,
            &script.to_string_lossy(),
            &dir,
            "hi",
            None,
            Vec::new(),
            CliRunOpts::default(),
            Some(Arc::new(tokio::sync::Notify::new())),
            None,
        )
        .await
        .unwrap();

        assert_eq!(outcome.resume_id.as_deref(), Some("sess-e2e"));
        assert!(!outcome.aborted);
        assert_eq!(outcome.messages.len(), 1);
        assert_eq!(outcome.messages[0]["content"][0]["text"], json!("hello"));

        let events = sink.0.lock().unwrap();
        let types = types(&events);
        assert_eq!(types.first().map(String::as_str), Some("agent_start"));
        assert_eq!(types.last().map(String::as_str), Some("agent_end"));
        assert!(types.iter().any(|t| t == "message_update:text_end"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The abort switch kills a long-running CLI mid-turn: the turn closes
    /// promptly with whatever streamed instead of waiting out the child.
    #[tokio::test]
    async fn run_cli_turn_abort_kills_child() {
        let dir =
            std::env::temp_dir().join(format!("cetus-cli-abort-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-slow.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}}'\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"partial\"}}}'\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":0}}'\n\
             sleep 30\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
        let abort = Arc::new(tokio::sync::Notify::new());
        let killer = abort.clone();
        // Fire the stop only after the first streamed text arrived, so the
        // "keeps what already streamed" assertion isn't racing the spawn.
        let watch = sink.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                let seen = watch.0.lock().unwrap().iter().any(|e| {
                    e.get("assistantMessageEvent")
                        .and_then(|a| a.get("type"))
                        .and_then(|t| t.as_str())
                        == Some("text_end")
                });
                if seen {
                    killer.notify_one();
                    return;
                }
            }
        });
        let started = std::time::Instant::now();
        let outcome = run_cli_turn(
            sink.clone() as Arc<dyn EventSink>,
            CliBackend::ClaudeCode,
            &script.to_string_lossy(),
            &dir,
            "hi",
            None,
            Vec::new(),
            CliRunOpts::default(),
            Some(abort),
            None,
        )
        .await
        .unwrap();

        assert!(outcome.aborted);
        // Well under the script's 30s sleep — the child was killed, not waited.
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        // What streamed before the stop is kept for the transcript.
        assert_eq!(outcome.messages.len(), 1);
        let events = sink.0.lock().unwrap();
        assert_eq!(
            types(&events).last().map(String::as_str),
            Some("agent_end")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A missing binary must still close the turn (message_end/agent_end) with
    /// a visible error instead of stranding the frontend in streaming state.
    #[tokio::test]
    async fn run_cli_turn_missing_binary_closes_turn() {
        let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
        let outcome = run_cli_turn(
            sink.clone() as Arc<dyn EventSink>,
            CliBackend::Codex,
            "/nonexistent/cetus-test-binary",
            Path::new("/tmp"),
            "hi",
            None,
            Vec::new(),
            CliRunOpts::default(),
            None,
            None,
        )
        .await
        .unwrap();
        assert!(outcome.resume_id.is_none());
        // The failure is surfaced as a persisted assistant message too.
        assert_eq!(outcome.messages.len(), 1);
        let events = sink.0.lock().unwrap();
        let types = types(&events);
        assert_eq!(types.last().map(String::as_str), Some("agent_end"));
        assert!(types.iter().any(|t| t == "message_update:text_end"));
    }

    /// Live smoke test against the real claude binary — run manually with
    /// `cargo test -p cetus-bridge --lib live_claude -- --ignored --nocapture`.
    /// Requires claude auth; costs a few haiku tokens.
    #[tokio::test]
    #[ignore]
    async fn live_claude_bidirectional_smoke() {
        let bin = std::env::var("HOME").unwrap() + "/.local/bin/claude";
        if !std::path::Path::new(&bin).exists() {
            eprintln!("claude not installed; skipping");
            return;
        }
        let dir = std::env::temp_dir().join("cetus-live-claude-smoke");
        std::fs::create_dir_all(&dir).unwrap();
        let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
        let env: Vec<(String, String)> = std::env::vars()
            .filter(|(k, _)| {
                !k.starts_with("CLAUDE")
                    && !k.starts_with("ANTHROPIC")
                    && !k.starts_with("SUPERSET")
            })
            .map(|(k, v)| {
                if k == "PATH" {
                    (k, "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin".to_string())
                } else {
                    (k, v)
                }
            })
            .collect();
        let outcome = run_cli_turn(
            sink.clone() as Arc<dyn EventSink>,
            CliBackend::ClaudeCode,
            &bin,
            &dir,
            "Reply with exactly the word: pong",
            None,
            env,
            CliRunOpts {
                model: Some("haiku".into()),
                bypass_approvals: true,
                ..Default::default()
            },
            Some(Arc::new(tokio::sync::Notify::new())),
            None,
        )
        .await
        .unwrap();
        let events = sink.0.lock().unwrap();
        let tys = types(&events);
        eprintln!("events: {tys:?}");
        eprintln!("messages: {:?}", outcome.messages);
        assert!(outcome.resume_id.is_some(), "session id captured");
        assert!(tys.iter().any(|t| t == "message_update:text_delta"), "streamed deltas");
        assert_eq!(tys.last().map(String::as_str), Some("agent_end"));
        assert!(outcome
            .messages
            .iter()
            .any(|m| m.to_string().to_lowercase().contains("pong")));
    }

    #[test]
    fn backend_ids_round_trip() {
        assert_eq!(CliBackend::from_id("codex"), Some(CliBackend::Codex));
        assert_eq!(CliBackend::from_id("claude-code"), Some(CliBackend::ClaudeCode));
        assert_eq!(CliBackend::from_id("pi"), None);
        assert_eq!(CliBackend::Codex.as_str(), "codex");
    }

    #[test]
    fn messages_collect_for_persistence() {
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"command\":\"ls\"}"}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":1}}"#);
        tr.on_line(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"a.txt","is_error":false}]}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"message_start","message":{}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);
        tr.finish(None);
        let msgs = tr.take_messages();
        // assistant(thinking+toolCall) / toolResult / assistant(text)
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0]["role"], json!("assistant"));
        assert_eq!(msgs[0]["content"][1]["type"], json!("toolCall"));
        assert_eq!(msgs[1]["role"], json!("toolResult"));
        assert_eq!(msgs[1]["toolName"], json!("Bash"));
        assert_eq!(msgs[2]["content"][0]["text"], json!("done"));
    }

    #[test]
    fn claude_argv_shape() {
        let args = CliBackend::ClaudeCode.turn_args(
            "hello",
            &CliRunOpts {
                model: Some("fable".into()),
                effort: Some("max".into()),
                resume: Some("sess-1".into()),
                bypass_approvals: false,
                images: Vec::new(),
                image_blocks: Vec::new(),
            },
        );
        assert!(args.contains(&"--output-format".to_string()));
        assert!(args.contains(&"--input-format".to_string()));
        assert!(args.contains(&"--include-partial-messages".to_string()));
        assert!(args.contains(&"--permission-prompt-tool".to_string()));
        assert!(args.contains(&"stdio".to_string()));
        assert!(args.contains(&"--effort".to_string()));
        assert!(args.contains(&"max".to_string()));
        assert!(args.contains(&"--resume".to_string()));
        // no bypass flag: claude's default mode asks us per tool
        assert!(!args.contains(&"--dangerously-skip-permissions".to_string()));
        // the prompt rides stdin, not argv
        assert!(!args.contains(&"hello".to_string()));
    }

    #[test]
    fn codex_argv_shape() {
        let args = CliBackend::Codex.turn_args(
            "hello",
            &CliRunOpts {
                model: None,
                effort: Some("xhigh".into()),
                resume: None,
                bypass_approvals: true,
                images: vec!["/tmp/shot.png".into()],
                image_blocks: Vec::new(),
            },
        );
        assert_eq!(args[0], "exec");
        assert!(args.contains(&"--json".to_string()));
        assert!(args.contains(&"--dangerously-bypass-approvals-and-sandbox".to_string()));
        assert!(args.contains(&"-c".to_string()));
        assert!(args.contains(&"model_reasoning_effort=\"xhigh\"".to_string()));
        assert!(args.contains(&"-i".to_string()));
        assert!(args.contains(&"/tmp/shot.png".to_string()));
        assert_eq!(args.last().unwrap(), "hello");
    }
}
