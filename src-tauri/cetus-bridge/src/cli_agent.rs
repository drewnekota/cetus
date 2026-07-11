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
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
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
    /// Extra system-prompt text appended to the CLI's own (claude
    /// `--append-system-prompt`). The host uses this to tell the agent it runs
    /// inside Cetus. codex has no equivalent flag — the host prepends the hint
    /// to the first turn's prompt instead.
    pub append_system_prompt: Option<String>,
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
                if let Some(sp) = &opts.append_system_prompt {
                    a.push("--append-system-prompt".into());
                    a.push(sp.clone());
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

/// One stream-json user message line for claude's stdin: the prompt plus any
/// inline images. Sent as the opening message of a turn, and again mid-turn to
/// steer — claude in bidirectional mode folds a user message injected while a
/// turn runs into that turn (same as typing during a run in the interactive
/// CLI).
pub fn claude_user_message_line(prompt: &str, image_blocks: &[(String, String)]) -> String {
    let mut content = vec![json!({ "type": "text", "text": prompt })];
    for (mime, data) in image_blocks {
        content.push(json!({
            "type": "image",
            "source": { "type": "base64", "media_type": mime, "data": data },
        }));
    }
    json!({
        "type": "user",
        "message": { "role": "user", "content": content },
    })
    .to_string()
}

/// The opening lines written to claude's stdin: the control-protocol
/// `initialize` handshake (which is what makes AskUserQuestion and
/// `can_use_tool` prompts available in headless mode), then the user message
/// carrying the prompt and any inline images.
pub fn claude_stdin_lines(prompt: &str, image_blocks: &[(String, String)]) -> Vec<String> {
    vec![
        json!({
            "type": "control_request",
            "request_id": "init-1",
            "request": { "subtype": "initialize" },
        })
        .to_string(),
        claude_user_message_line(prompt, image_blocks),
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

/// True for claude JSONL lines that belong to a subagent's sidechain rather
/// than the main conversation (the CLI stamps them with the launching Task
/// call's `parent_tool_use_id`).
fn is_sidechain(v: &Value) -> bool {
    v.get("parent_tool_use_id")
        .map(|p| !p.is_null())
        .unwrap_or(false)
}

/// Does a main-chain tool_result look like the CLI's immediate "task launched"
/// ack rather than a real report? Agent, Workflow, and background Bash commands
/// each use different wording. Missing one makes its still-running tool card
/// look settled and drops it from `has_pending_tasks`, so the runner can kill
/// Claude Code (and the background work) at the turn's intermediate `result`.
fn is_background_launch_ack(content: &Value) -> bool {
    let s = content.to_string();
    s.contains("Async agent launched successfully")
        || s.contains("launched in background")
        || s.contains("Command running in background with ID:")
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
    /// claude only: background subagents (Task/Agent tool) launched this turn,
    /// keyed by the CLI's task_id. The CLI runs subagents async — the tool
    /// result is just a launch ack and the real work streams later as task_*
    /// system events. The runner must not close the turn on a `result` while
    /// any of these are still pending (see `has_pending_tasks`).
    background_tasks: std::collections::HashMap<String, BackgroundTask>,
}

/// One background subagent tracked from `task_started` to its
/// `task_updated`/`task_notification` completion.
#[derive(Clone)]
struct BackgroundTask {
    /// The Agent/Task tool_use id — the card the frontend shows for it.
    tool_use_id: String,
    subagent_type: String,
    description: String,
    done: bool,
    /// The subagent's own tool calls, observed on its sidechain lines. Painted
    /// onto the Agent card as a nested step list (`details.subagent.steps`).
    /// Each step: { id, tool, detail, done }.
    steps: Vec<Value>,
    /// Latest `task_progress` description — the card's one-line status.
    status_text: String,
}

impl BackgroundTask {
    /// The `details` payload every update/end event on the Agent card carries.
    /// The frontend replaces `result` wholesale per event, so steps must ride
    /// along on all of them or they'd flash away mid-run.
    fn details(&self, status: &str) -> Value {
        json!({
            "subagent": {
                "type": self.subagent_type,
                "description": self.description,
                "status": status,
                "steps": self.steps,
            }
        })
    }
}

/// One line summarizing a subagent tool call's input — the field that carries
/// the "what" of the call, mirroring the frontend's summarizeArgs.
fn summarize_tool_input(input: &Value) -> String {
    for key in ["description", "command", "file_path", "path", "pattern", "query", "url", "prompt"] {
        if let Some(s) = input.get(key).and_then(|v| v.as_str()) {
            let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
            let mut out: String = s.chars().take(120).collect();
            if out.len() < s.len() {
                out.push('…');
            }
            return out;
        }
    }
    String::new()
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
            background_tasks: std::collections::HashMap::new(),
        }
    }

    /// True while any background subagent launched this turn is still running.
    /// The runner keeps reading past a `result` in that case: the CLI starts a
    /// continuation turn on its own once the task completes, and killing the
    /// child at the first `result` would orphan the subagent mid-flight.
    pub fn has_pending_tasks(&self) -> bool {
        self.background_tasks.values().any(|t| !t.done)
    }

    /// Background Bash commands (dev servers, watchers, log tails) deliberately
    /// outlive the model turn. Async agents/workflows are different: Claude
    /// starts a continuation turn when they finish, so the current turn must
    /// keep reading until that continuation settles.
    pub fn has_pending_turn_tasks(&self) -> bool {
        self.background_tasks
            .values()
            .any(|t| !t.done && t.subagent_type != "Bash")
    }

    /// True if any background subagent ran during this turn (pending or done).
    /// The runner uses this to hold the close briefly after a `result`: a
    /// task's completion notification and the CLI's continuation turn can
    /// race the result in either order, and killing on the result alone can
    /// abandon the continuation that carries the subagent's report.
    pub fn saw_background_tasks(&self) -> bool {
        !self.background_tasks.is_empty()
    }

    /// Move the accumulated PiMessages out (call after `finish`).
    pub fn take_messages(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.messages)
    }

    /// Re-arm the per-turn portions of a translator while retaining Claude's
    /// conversation-scoped background-task registry. A persistent stream-json
    /// child uses one translator across many turns so task notifications can
    /// still settle cards after the launching turn has ended.
    pub fn begin_next_turn(&mut self) {
        self.next_index = 0;
        self.finished = false;
        self.assistant_blocks.clear();
        self.messages.clear();
        self.live_blocks.clear();
        self.saw_result = false;
        self.result_error = None;
        self.opened = false;
        // Tool names for still-running background cards must survive. Prune
        // names that no live task references so this map remains bounded.
        let mut live_ids: std::collections::HashSet<String> = self
            .background_tasks
            .values()
            .filter(|t| !t.done)
            .map(|t| t.tool_use_id.clone())
            .collect();
        live_ids.extend(self.started_items.iter().cloned());
        self.tool_names.retain(|id, _| live_ids.contains(id));
        self.background_tasks.retain(|_, t| !t.done);
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
        let mut out = self.close_live_blocks();
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

    /// Close any content blocks still streaming (their `content_block_stop`
    /// never arrived — the turn was killed mid-delta). On a normal turn end
    /// every block is already closed and this is a no-op; on an abort it
    /// settles each open block with whatever accumulated, so the partial
    /// text/thinking survives in the UI and the persisted transcript instead
    /// of vanishing with the live buffers.
    fn close_live_blocks(&mut self) -> Vec<Value> {
        let mut open: Vec<u64> = self
            .live_blocks
            .iter()
            .filter(|(_, b)| !b.closed)
            .map(|(k, _)| *k)
            .collect();
        open.sort_by_key(|k| self.live_blocks[k].our_index);
        let mut out = Vec::new();
        for k in open {
            let b = self.live_blocks.get_mut(&k).expect("open block exists");
            b.closed = true;
            let our_index = b.our_index;
            let buffer = std::mem::take(&mut b.buffer);
            match b.kind {
                LiveKind::Text => {
                    if buffer.is_empty() {
                        continue;
                    }
                    self.assistant_blocks
                        .push(json!({ "type": "text", "text": buffer }));
                    out.push(am(json!({
                        "type": "text_end",
                        "contentIndex": our_index,
                        "content": buffer,
                    })));
                }
                LiveKind::Thinking => {
                    if buffer.is_empty() {
                        continue;
                    }
                    self.assistant_blocks
                        .push(json!({ "type": "thinking", "thinking": buffer }));
                    out.push(am(json!({
                        "type": "thinking_end",
                        "contentIndex": our_index,
                        "content": buffer,
                    })));
                }
                LiveKind::ToolUse => {
                    let (id, name) = b.tool.clone().unwrap_or_default();
                    let args: Value = serde_json::from_str(&buffer).unwrap_or(json!({}));
                    self.assistant_blocks.push(json!({
                        "type": "toolCall", "id": id, "name": name, "arguments": args,
                    }));
                    out.push(am(json!({
                        "type": "toolcall_end",
                        "contentIndex": our_index,
                        "toolCall": { "id": id, "name": name, "arguments": args },
                    })));
                }
            }
        }
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

    /// A main-chain claude tool result. Background subagent launches get
    /// special treatment: the CLI answers the Agent/Task call immediately with
    /// an internal-metadata ack (agentId, output file, "never quote this") and
    /// the agent keeps working in the background. Showing that blob — and
    /// settling the card — would read as a finished step. Instead the card
    /// gets a clean status and stays running until `task_notification`.
    fn emit_claude_tool_result(&mut self, id: &str, content: &Value, is_error: bool) -> Vec<Value> {
        let task_id = self
            .background_tasks
            .iter()
            .find(|(_, t)| t.tool_use_id == id)
            .map(|(k, _)| k.clone());
        if let Some(task_id) = task_id {
            let task = self.background_tasks[&task_id].clone();
            if !task.done && is_background_launch_ack(content) {
                let tool_name = self.tool_names.get(id).map(String::as_str).unwrap_or("");
                let label = if tool_name == "Workflow" {
                    // Workflow tasks register with a generic subagent_type
                    // ("Task"); the tool name reads better than "Task agent".
                    format!("Workflow running in background — {}", task.description)
                } else if tool_name == "Bash" {
                    format!("Background command running — {}", task.description)
                } else {
                    format!(
                        "{} agent running in background — {}",
                        task.subagent_type, task.description
                    )
                };
                let status = json!([{ "type": "text", "text": label }]);
                let details = task.details("running");
                self.flush_assistant();
                self.messages.push(json!({
                    "role": "toolResult",
                    "toolCallId": id,
                    "toolName": self.tool_names.get(id).cloned().unwrap_or_else(|| "tool".to_string()),
                    "content": status,
                    "isError": false,
                    "details": details,
                }));
                return vec![
                    json!({ "type": "tool_execution_start", "toolCallId": id }),
                    json!({
                        "type": "tool_execution_update",
                        "toolCallId": id,
                        "partialResult": { "content": status, "details": details },
                    }),
                ];
            }
            // Synchronous subagent: the result is the real report and also
            // ends the task — don't hold the turn open for it. Keep the step
            // trace on the settled card (and the persisted row).
            let details = {
                let t = self.background_tasks.get_mut(&task_id).expect("task exists");
                t.done = true;
                t.details(if is_error { "failed" } else { "completed" })
            };
            let content = normalize_content(content);
            self.flush_assistant();
            self.messages.push(json!({
                "role": "toolResult",
                "toolCallId": id,
                "toolName": self.tool_names.get(id).cloned().unwrap_or_else(|| "tool".to_string()),
                "content": content,
                "isError": is_error,
                "details": details,
            }));
            return vec![
                json!({ "type": "tool_execution_start", "toolCallId": id }),
                json!({
                    "type": "tool_execution_end",
                    "toolCallId": id,
                    "result": { "content": content, "details": details },
                    "isError": is_error,
                }),
            ];
        }
        self.emit_tool_result(id, content, is_error)
    }

    /// A sidechain snapshot line (`parent_tool_use_id` set): the subagent's own
    /// tool calls and results. They must not splice into the main transcript —
    /// instead they accumulate as steps on the launching Agent/Task card so
    /// the user can watch the subagent work.
    fn on_claude_sidechain(&mut self, v: &Value) -> Vec<Value> {
        let parent = v
            .get("parent_tool_use_id")
            .and_then(|p| p.as_str())
            .unwrap_or("");
        let Some(task) = self
            .background_tasks
            .values_mut()
            .find(|t| t.tool_use_id == parent)
        else {
            return Vec::new();
        };
        let blocks = v
            .pointer("/message/content")
            .and_then(|c| c.as_array())
            .cloned()
            .unwrap_or_default();
        let mut changed = false;
        for b in &blocks {
            match b.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                "tool_use" => {
                    let id = b.get("id").and_then(|i| i.as_str()).unwrap_or("");
                    // Snapshots could repeat a block; a step per tool call.
                    if task.steps.iter().any(|s| s["id"] == json!(id)) {
                        continue;
                    }
                    task.steps.push(json!({
                        "id": id,
                        "tool": b.get("name").and_then(|n| n.as_str()).unwrap_or("tool"),
                        "detail": summarize_tool_input(b.get("input").unwrap_or(&Value::Null)),
                        "done": false,
                    }));
                    changed = true;
                }
                "tool_result" => {
                    let id = b.get("tool_use_id").and_then(|i| i.as_str()).unwrap_or("");
                    if let Some(s) = task.steps.iter_mut().find(|s| s["id"] == json!(id)) {
                        s["done"] = json!(true);
                        changed = true;
                    }
                }
                _ => {}
            }
        }
        if !changed || task.done {
            return Vec::new();
        }
        let text = if task.status_text.is_empty() {
            format!("{} agent running — {}", task.subagent_type, task.description)
        } else {
            task.status_text.clone()
        };
        vec![json!({
            "type": "tool_execution_update",
            "toolCallId": task.tool_use_id,
            "partialResult": {
                "content": [{ "type": "text", "text": text }],
                "details": task.details("running"),
            },
        })]
    }

    /// Background-task lifecycle system events (claude). Progress is painted
    /// onto the launching Agent/Task tool card via tool_execution_update; the
    /// notification settles the card and releases the turn (has_pending_tasks).
    fn on_claude_task_event(&mut self, subtype: &str, v: &Value) -> Vec<Value> {
        let task_id = v.get("task_id").and_then(|t| t.as_str()).unwrap_or("");
        if task_id.is_empty() {
            return Vec::new();
        }
        match subtype {
            "task_started" => {
                let tool_use_id = v.get("tool_use_id").and_then(|t| t.as_str()).unwrap_or("");
                if !tool_use_id.is_empty() {
                    self.background_tasks.insert(task_id.to_string(), BackgroundTask {
                        tool_use_id: tool_use_id.to_string(),
                        subagent_type: v
                            .get("subagent_type")
                            .and_then(|t| t.as_str())
                            .map(str::to_string)
                            .unwrap_or_else(|| match v.get("task_type").and_then(|t| t.as_str()) {
                                Some("local_bash") => "Bash".to_string(),
                                Some(kind) if !kind.is_empty() => kind.to_string(),
                                _ => "Task".to_string(),
                            }),
                        description: v
                            .get("description")
                            .and_then(|t| t.as_str())
                            .unwrap_or("background task")
                            .to_string(),
                        done: false,
                        steps: Vec::new(),
                        status_text: String::new(),
                    });
                }
                // No event yet: the tool card may not exist until toolcall_end,
                // and the launch ack result paints the initial status anyway.
                Vec::new()
            }
            "task_progress" => {
                let Some(task) = self.background_tasks.get_mut(task_id) else {
                    return Vec::new();
                };
                let desc = v
                    .get("description")
                    .and_then(|t| t.as_str())
                    .unwrap_or("working…");
                task.status_text = desc.to_string();
                vec![json!({
                    "type": "tool_execution_update",
                    "toolCallId": task.tool_use_id,
                    "partialResult": {
                        "content": [{ "type": "text", "text": desc }],
                        "details": task.details("running"),
                    },
                })]
            }
            "task_updated" => {
                // Terminal status patch; the notification (which may race
                // this) does the card settling.
                if matches!(
                    v.pointer("/patch/status").and_then(|s| s.as_str()),
                    Some("completed") | Some("failed") | Some("stopped") | Some("killed")
                ) {
                    if let Some(t) = self.background_tasks.get_mut(task_id) {
                        t.done = true;
                    }
                }
                Vec::new()
            }
            "task_notification" => {
                let Some(task) = self.background_tasks.get_mut(task_id) else {
                    return Vec::new();
                };
                task.done = true;
                let task = task.clone();
                let status = v.get("status").and_then(|s| s.as_str()).unwrap_or("completed");
                let is_err = status != "completed";
                // The notification carries the subagent's actual report in
                // `summary` — for an async task this is the only place it
                // surfaces (no main-chain tool_result follows).
                let text = match v.get("summary").and_then(|s| s.as_str()) {
                    Some(s) if !s.trim().is_empty() => s.to_string(),
                    _ => format!("{} agent {} — {}", task.subagent_type, status, task.description),
                };
                let content = json!([{ "type": "text", "text": text }]);
                let details = task.details(status);
                // Keep the persisted transcript in sync with what the card
                // now shows (the launch-ack row was already pushed).
                for m in self.messages.iter_mut().rev() {
                    if m.get("toolCallId").and_then(|i| i.as_str())
                        == Some(task.tool_use_id.as_str())
                    {
                        m["content"] = content.clone();
                        m["isError"] = json!(is_err);
                        m["details"] = details.clone();
                        break;
                    }
                }
                vec![json!({
                    "type": "tool_execution_end",
                    "toolCallId": task.tool_use_id,
                    "result": { "content": content, "details": details },
                    "isError": is_err,
                })]
            }
            _ => Vec::new(),
        }
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
                match v.get("subtype").and_then(|s| s.as_str()).unwrap_or("") {
                    "init" => {
                        if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                            self.resume_id = Some(sid.to_string());
                        }
                        Vec::new()
                    }
                    sub @ ("task_started" | "task_progress" | "task_updated"
                    | "task_notification") => self.on_claude_task_event(sub, v),
                    _ => Vec::new(),
                }
            }
            // Token-level partials (--include-partial-messages). These carry
            // the live content; the cumulative "assistant" snapshots below are
            // ignored to avoid double-rendering.
            "stream_event" => {
                // Sidechain partials (a subagent's own stream) would collide
                // with the parent's live_blocks — both count indexes from 0.
                if is_sidechain(v) {
                    return Vec::new();
                }
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
                // Sidechain snapshots (a subagent's own turns) feed the
                // launching card's step list instead of the main transcript.
                if is_sidechain(v) {
                    return self.on_claude_sidechain(v);
                }
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
                // Sidechain traffic: a subagent's internal tool results. They
                // reference tool ids the frontend never saw, and emitting them
                // would splice foreign results into the parent transcript —
                // they settle the matching step on the launching card instead.
                if is_sidechain(v) {
                    return self.on_claude_sidechain(v);
                }
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
                            out.extend(self.emit_claude_tool_result(id, &c, is_err));
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
    /// True when message-level content streamed before the turn closed. Gates
    /// persisting `resume_id`: the session id arrives in the CLI's very first
    /// event, but the CLI only writes the session to disk once content flows —
    /// a turn stopped/crashed before that emits an id that can never resume
    /// ("No conversation found"), and storing it would fail every later turn.
    pub streamed: bool,
    /// True when the CLI rejected the `--resume` token (session not on disk —
    /// see `streamed`). The caller should clear the stored token so the next
    /// turn starts a fresh session instead of failing the same way forever.
    pub resume_rejected: bool,
}

/// True for stdout lines showing claude actually started processing more work
/// after a `result` (a steered turn beginning), as opposed to housekeeping it
/// can flush while idling — rate-limit pings, hook bookkeeping, control acks.
fn is_turn_activity(line: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return false;
    };
    match v.get("type").and_then(|t| t.as_str()).unwrap_or("") {
        "assistant" | "user" | "stream_event" | "control_request" => true,
        // status ("requesting" — the first sign of a new API call) and task_*
        // events are turn work; hook_started/hook_response fire while idle.
        "system" => !matches!(
            v.get("subtype").and_then(|s| s.as_str()).unwrap_or(""),
            "hook_started" | "hook_response"
        ),
        _ => false,
    }
}

/// Condense an auth-expiry stderr dump into one actionable line. codex logs
/// every 401 retry (`token_invalidated`, `refresh_token_invalidated`) before
/// exiting; none of that wall helps the user beyond "sign in again".
fn auth_expired_hint(backend: CliBackend, stderr: &str) -> Option<String> {
    let expired = [
        "token_invalidated",
        "refresh_token_invalidated",
        "authentication token has been invalidated",
        "401 Unauthorized",
        "OAuth token has expired",
    ]
    .iter()
    .any(|p| stderr.contains(p));
    if !expired {
        return None;
    }
    let login = match backend {
        CliBackend::ClaudeCode => "claude, then /login",
        CliBackend::Codex => "codex login",
    };
    Some(format!(
        "{} session has expired. Run `{}` in a terminal to sign in again, then retry.",
        backend.as_str(),
        login
    ))
}

/// True when an error text reads as a usage/credit/quota limit — the runtime
/// is fine, the account just can't run more turns right now.
fn is_usage_limit(text: &str) -> bool {
    let t = text.to_lowercase();
    [
        "credit balance is too low",
        "usage limit reached",
        "you've hit your usage limit",
        "you have hit your usage limit",
        "usage_limit_reached",
        "insufficient_quota",
        "quota exceeded",
        "out of credits",
    ]
    .iter()
    .any(|p| t.contains(p))
}

/// Actionable line for a usage/credit-limit failure. Cetus can continue the
/// SAME conversation on another runtime (the transcript replays as context on
/// the first turn there), so point the user at the switch instead of leaving
/// them stuck on a dead quota.
fn usage_limit_hint(backend: CliBackend) -> String {
    format!(
        "{} has hit its usage/credit limit. Switch this conversation to another \
         runtime from the composer's runtime picker to continue with the same \
         context, or retry later.",
        backend.as_str()
    )
}

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

struct ActiveClaudeTurn {
    sink: Arc<dyn EventSink>,
    outcome: tokio::sync::oneshot::Sender<CliTurnOutcome>,
}

/// Spawn a persistent Claude Code session. `opts.resume` is used only when the
/// process is first created; subsequent turns are sent over the same stdin.
pub fn spawn_claude_session(
    base_sink: Arc<dyn EventSink>,
    bin: &str,
    cwd: &Path,
    conversation_id: Option<String>,
    extra_env: Vec<(String, String)>,
    opts: CliRunOpts,
) -> Result<ClaudeSessionHandle> {
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
    let mut child = cmd.spawn().with_context(|| format!("failed to launch `{bin}`"))?;
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
        let mut active: Option<ActiveClaudeTurn> = None;
        let mut killed = false;
        let mut interrupted = false;
        let mut control_id = 2u64;

        loop {
            tokio::select! {
                cmd = rx.recv() => match cmd {
                    Some(ClaudeSessionCommand::StartTurn { line, sink, outcome }) => {
                        if active.is_some() {
                            let _ = outcome.send(CliTurnOutcome {
                                resume_id: tr.resume_id.clone(), messages: Vec::new(),
                                aborted: false, streamed: false, resume_rejected: false,
                            });
                            continue;
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
                            });
                            break;
                        }
                        active = Some(ActiveClaudeTurn { sink, outcome });
                    }
                    Some(ClaudeSessionCommand::Input(line)) => {
                        let _ = stdin.write_all(line.as_bytes()).await;
                        let _ = stdin.write_all(b"\n").await;
                        let _ = stdin.flush().await;
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
                    let sink = active.as_ref().map(|a| &a.sink).unwrap_or(&base_sink);
                    let events = tr.on_line(&line);
                    if !events.is_empty() { emit(sink, events); }
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
                            tr.saw_result = false;
                            continue;
                        };
                        let err = if tr.messages.is_empty() && tr.assistant_blocks_empty() {
                            tr.result_error.take()
                        } else { None };
                        emit(&turn.sink, tr.finish(err.as_deref()));
                        let streamed = tr.opened;
                        let _ = turn.outcome.send(CliTurnOutcome {
                            resume_id: tr.resume_id.clone(),
                            messages: tr.take_messages(),
                            aborted: interrupted,
                            streamed,
                            resume_rejected: false,
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
            });
        }
        let _ = child.wait().await;
    });

    Ok(handle)
}

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

fn normalize_codex_app_item(mut item: Value) -> Value {
    let Some(object) = item.as_object_mut() else {
        return item;
    };
    if let Some(kind) = object.get("type").and_then(Value::as_str) {
        let normalized = match kind {
            "commandExecution" => "command_execution",
            "agentMessage" => "agent_message",
            "fileChange" => "file_change",
            "mcpToolCall" => "mcp_tool_call",
            other => other,
        };
        if normalized != kind {
            object.insert("type".to_string(), json!(normalized));
        }
    }
    for (camel, snake) in [
        ("aggregatedOutput", "aggregated_output"),
        ("exitCode", "exit_code"),
    ] {
        if let Some(value) = object.remove(camel) {
            object.insert(snake.to_string(), value);
        }
    }
    item
}

/// Spawn Codex's persistent app-server embedding surface and create or resume
/// one thread. Unlike `codex exec`, app-server owns background terminals after
/// `turn/completed`, which is the lifecycle the Codex desktop app uses.
pub fn spawn_codex_session(
    base_sink: Arc<dyn EventSink>,
    bin: &str,
    cwd: &Path,
    conversation_id: Option<String>,
    extra_env: Vec<(String, String)>,
    opts: CliRunOpts,
) -> Result<CodexSessionHandle> {
    let mut cmd = TokioCommand::new(bin);
    cmd.args(["app-server", "--listen", "stdio://"])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().with_context(|| format!("failed to launch `{bin} app-server`"))?;
    let mut stdin = child.stdin.take().context("Codex app-server stdin missing")?;
    let stdout = child.stdout.take().context("Codex app-server stdout missing")?;
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
        if let Some(stderr) = stderr {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!("codex app-server: {line}");
                }
            });
        }
        let mut reader = BufReader::new(stdout).lines();
        let initialized = async {
            write_json_line(&mut stdin, &json!({
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": { "name": "cetus", "title": "Cetus", "version": "0.1.0" },
                    "capabilities": { "experimentalApi": true, "requestAttestation": false }
                }
            })).await?;
            read_rpc_response(&mut reader, 1).await?;
            write_json_line(&mut stdin, &json!({ "method": "initialized" })).await?;

            let policy = if opts.bypass_approvals { "danger-full-access" } else { "workspace-write" };
            let method = if opts.resume.is_some() { "thread/resume" } else { "thread/start" };
            let mut params = json!({
                "cwd": cwd_string,
                "approvalPolicy": "never",
                "sandbox": policy,
                "threadSource": "appServer",
            });
            if let Some(resume) = &opts.resume {
                params["threadId"] = json!(resume);
                params["excludeTurns"] = json!(true);
            }
            if let Some(model) = &opts.model { params["model"] = json!(model); }
            write_json_line(&mut stdin, &json!({ "id": 2, "method": method, "params": params })).await?;
            let result = read_rpc_response(&mut reader, 2).await?;
            result.pointer("/thread/id").and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| anyhow::anyhow!("Codex app-server returned no thread id"))
        }.await;

        let thread_id = match initialized {
            Ok(id) => id,
            Err(error) => {
                if let Some(CodexSessionCommand::StartTurn { sink, outcome, .. }) = rx.recv().await {
                    let mut tr = EventTranslator::new(CliBackend::Codex);
                    emit(&sink, tr.start());
                    emit(&sink, tr.finish(Some(&error.to_string())));
                    let _ = outcome.send(CliTurnOutcome {
                        resume_id: None, messages: tr.take_messages(), aborted: false,
                        streamed: tr.opened, resume_rejected: opts.resume.is_some(),
                    });
                }
                let _ = child.start_kill();
                let _ = child.wait().await;
                return;
            }
        };

        let mut next_id = 10u64;
        let mut tr = EventTranslator::new(CliBackend::Codex);
        tr.resume_id = Some(thread_id.clone());
        let mut active: Option<ActiveClaudeTurn> = None;
        let mut active_turn_id: Option<String> = None;

        loop {
            tokio::select! {
                command = rx.recv() => match command {
                    Some(CodexSessionCommand::StartTurn { prompt, images, sink, outcome }) => {
                        if active.is_some() {
                            let _ = outcome.send(CliTurnOutcome {
                                resume_id: Some(thread_id.clone()), messages: Vec::new(),
                                aborted: false, streamed: false, resume_rejected: false,
                            });
                            continue;
                        }
                        tr.begin_next_turn();
                        emit(&sink, tr.start());
                        let mut input = vec![json!({ "type": "text", "text": prompt, "text_elements": [] })];
                        input.extend(images.into_iter().map(|path| json!({ "type": "localImage", "path": path })));
                        let id = next_id; next_id += 1;
                        let mut params = json!({ "threadId": thread_id, "input": input });
                        if let Some(effort) = &opts.effort { params["effort"] = json!(effort); }
                        if let Err(error) = write_json_line(&mut stdin, &json!({ "id": id, "method": "turn/start", "params": params })).await {
                            emit(&sink, tr.finish(Some(&error.to_string())));
                            let _ = outcome.send(CliTurnOutcome {
                                resume_id: Some(thread_id.clone()), messages: tr.take_messages(),
                                aborted: false, streamed: tr.opened, resume_rejected: false,
                            });
                            break;
                        }
                        active = Some(ActiveClaudeTurn { sink, outcome });
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
                line = reader.next_line() => {
                    let line = match line { Ok(Some(line)) => line, _ => break };
                    let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
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
                        "item/started" | "item/completed" => {
                            let ty = if method.ends_with("started") { "item.started" } else { "item.completed" };
                            let item = normalize_codex_app_item(params.get("item").cloned().unwrap_or(Value::Null));
                            let events = tr.on_line(&json!({ "type": ty, "item": item }).to_string());
                            if !events.is_empty() { emit(sink, events); }
                        }
                        "turn/completed" => {
                            let Some(turn) = active.take() else { continue };
                            let status = params.pointer("/turn/status").and_then(Value::as_str).unwrap_or("completed");
                            let error = params.pointer("/turn/error/message").and_then(Value::as_str)
                                .map(str::to_string)
                                .or_else(|| (status == "failed").then(|| "Codex turn failed".to_string()));
                            emit(&turn.sink, tr.finish(error.as_deref()));
                            let streamed = tr.opened;
                            let _ = turn.outcome.send(CliTurnOutcome {
                                resume_id: Some(thread_id.clone()), messages: tr.take_messages(),
                                aborted: status == "interrupted", streamed, resume_rejected: false,
                            });
                            active_turn_id = None;
                        }
                        _ => {}
                    }
                }
            }
        }
        if let Some(turn) = active.take() {
            emit(&turn.sink, tr.finish(Some("Codex app-server exited unexpectedly")));
            let streamed = tr.opened;
            let _ = turn.outcome.send(CliTurnOutcome {
                resume_id: Some(thread_id), messages: tr.take_messages(), aborted: false,
                streamed, resume_rejected: false,
            });
        }
        let _ = child.wait().await;
    });

    Ok(handle)
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
                let deadline =
                    tokio::time::Instant::now() + std::time::Duration::from_millis(2000);
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
    fn finish_flushes_blocks_still_streaming_on_abort() {
        // A turn killed mid-delta (Stop / codex-style steer interrupt) never
        // sees the open block's content_block_stop — finish() must settle it
        // so the partial text survives on screen and in the transcript.
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"message_start","message":{"role":"assistant","content":[]}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial answ"}}}"#);

        let ev = tr.finish(None);
        assert_eq!(
            types(&ev),
            vec!["message_update:text_end", "message_end", "agent_end"]
        );
        assert_eq!(ev[0]["assistantMessageEvent"]["content"], json!("partial answ"));
        let messages = tr.take_messages();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["content"][0]["text"], json!("partial answ"));
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

    #[tokio::test]
    async fn persistent_claude_session_reuses_one_process_across_turns() {
        let dir = std::env::temp_dir().join(format!(
            "cetus-claude-session-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-persistent-claude.sh");
        let pid_file = dir.join("pid");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\n\
                 echo $$ > '{}'\n\
                 echo '{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"persistent-1\"}}'\n\
                 n=0\n\
                 while IFS= read -r line; do\n\
                   case \"$line\" in *'\"type\":\"user\"'*)\n\
                     n=$((n + 1))\n\
                     echo \"{{\\\"type\\\":\\\"item-ignored\\\"}}\"\n\
                     echo \"{{\\\"type\\\":\\\"stream_event\\\",\\\"event\\\":{{\\\"type\\\":\\\"content_block_start\\\",\\\"index\\\":0,\\\"content_block\\\":{{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"\\\"}}}}}}\"\n\
                     echo \"{{\\\"type\\\":\\\"stream_event\\\",\\\"event\\\":{{\\\"type\\\":\\\"content_block_delta\\\",\\\"index\\\":0,\\\"delta\\\":{{\\\"type\\\":\\\"text_delta\\\",\\\"text\\\":\\\"turn-$n\\\"}}}}}}\"\n\
                     echo \"{{\\\"type\\\":\\\"stream_event\\\",\\\"event\\\":{{\\\"type\\\":\\\"content_block_stop\\\",\\\"index\\\":0}}}}\"\n\
                     echo \"{{\\\"type\\\":\\\"result\\\",\\\"subtype\\\":\\\"success\\\",\\\"is_error\\\":false,\\\"result\\\":\\\"turn-$n\\\"}}\"\n\
                   ;; esac\n\
                 done\n",
                pid_file.display()
            ),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
        let session = spawn_claude_session(
            sink.clone() as Arc<dyn EventSink>,
            &script.to_string_lossy(),
            &dir,
            None,
            Vec::new(),
            CliRunOpts::default(),
        )
        .unwrap();

        let first = session
            .start_turn(
                claude_user_message_line("one", &[]),
                sink.clone() as Arc<dyn EventSink>,
            )
            .unwrap()
            .await
            .unwrap();
        let pid = std::fs::read_to_string(&pid_file).unwrap();
        assert_eq!(first.messages[0]["content"][0]["text"], json!("turn-1"));
        assert!(session.is_alive(), "result must not tear down the CLI session");

        let second = session
            .start_turn(
                claude_user_message_line("two", &[]),
                sink.clone() as Arc<dyn EventSink>,
            )
            .unwrap()
            .await
            .unwrap();
        assert_eq!(second.messages[0]["content"][0]["text"], json!("turn-2"));
        assert_eq!(std::fs::read_to_string(&pid_file).unwrap(), pid);

        session.shutdown();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn codex_app_server_keeps_thread_alive_after_turn_completed() {
        let dir = std::env::temp_dir().join(format!(
            "cetus-codex-app-server-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-codex.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\n\
             n=0\n\
             while IFS= read -r line; do\n\
               case \"$line\" in\n\
                 *'\"method\":\"initialize\"'*) echo '{\"id\":1,\"result\":{\"userAgent\":\"fake\",\"codexHome\":\"/tmp\",\"platformFamily\":\"unix\",\"platformOs\":\"macos\"}}' ;;\n\
                 *'\"method\":\"thread/start\"'*) echo '{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread-persistent\"}}}' ;;\n\
                 *'\"method\":\"turn/start\"'*)\n\
                   n=$((n + 1)); id=$((9 + n));\n\
                   echo \"{\\\"id\\\":$id,\\\"result\\\":{\\\"turn\\\":{\\\"id\\\":\\\"turn-$n\\\"}}}\";\n\
                   if [ \"$n\" -eq 1 ]; then\n\
                     echo '{\"method\":\"item/started\",\"params\":{\"threadId\":\"thread-persistent\",\"turnId\":\"turn-1\",\"item\":{\"type\":\"commandExecution\",\"id\":\"server-1\",\"command\":\"pnpm dev\",\"processId\":\"process-1\",\"status\":\"inProgress\",\"aggregatedOutput\":\"\",\"exitCode\":null}}}' ;\n\
                   fi;\n\
                   echo \"{\\\"method\\\":\\\"item/completed\\\",\\\"params\\\":{\\\"threadId\\\":\\\"thread-persistent\\\",\\\"turnId\\\":\\\"turn-$n\\\",\\\"item\\\":{\\\"type\\\":\\\"agentMessage\\\",\\\"id\\\":\\\"answer-$n\\\",\\\"text\\\":\\\"turn-$n\\\"}}}\";\n\
                   echo \"{\\\"method\\\":\\\"turn/completed\\\",\\\"params\\\":{\\\"threadId\\\":\\\"thread-persistent\\\",\\\"turn\\\":{\\\"id\\\":\\\"turn-$n\\\",\\\"status\\\":\\\"completed\\\",\\\"error\\\":null}}}\" ;;\n\
               esac\n\
             done\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
        let session = spawn_codex_session(
            sink.clone() as Arc<dyn EventSink>,
            &script.to_string_lossy(),
            &dir,
            None,
            Vec::new(),
            CliRunOpts::default(),
        )
        .unwrap();
        let first = session
            .start_turn("one".into(), Vec::new(), sink.clone() as Arc<dyn EventSink>)
            .unwrap()
            .await
            .unwrap();
        assert_eq!(first.resume_id.as_deref(), Some("thread-persistent"));
        assert!(first.messages.iter().any(|message| {
            message["content"]
                .as_array()
                .is_some_and(|content| content.iter().any(|block| block["text"] == json!("turn-1")))
        }));
        assert!(session.is_alive(), "turn/completed must not stop app-server");

        let second = session
            .start_turn("two".into(), Vec::new(), sink.clone() as Arc<dyn EventSink>)
            .unwrap()
            .await
            .unwrap();
        assert!(second.messages.iter().any(|message| {
            message["content"]
                .as_array()
                .is_some_and(|content| content.iter().any(|block| block["text"] == json!("turn-2")))
        }));
        assert!(session.is_alive());

        session.shutdown();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
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
            None,
        )
        .await
        .unwrap();

        assert!(outcome.aborted);
        // Well under the script's 30s sleep — the child was killed, not waited.
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        // What streamed before the stop is kept for the transcript.
        assert_eq!(outcome.messages.len(), 1);
        // Content streamed → the CLI saved the session; resume id is safe.
        assert!(outcome.streamed);
        let events = sink.0.lock().unwrap();
        assert_eq!(
            types(&events).last().map(String::as_str),
            Some("agent_end")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Stop before any content streamed: the init event already carried a
    /// session id, but claude hasn't written the session to disk yet, so the
    /// outcome must flag the turn as not-streamed — persisting that id would
    /// make every later `--resume` fail with "No conversation found".
    #[tokio::test]
    async fn run_cli_turn_abort_before_content_marks_unstreamed() {
        let dir = std::env::temp_dir().join(format!(
            "cetus-cli-abort-early-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-boot.sh");
        // The marker file signals "init is in the pipe" so the stop below can't
        // fire before the child even booted (parallel test runs load the box
        // enough for a fixed sleep to lose that race).
        std::fs::write(
            &script,
            "#!/bin/sh\n\
             echo '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"ghost-session\"}'\n\
             touch \"$0.ready\"\n\
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
        let ready = script.with_extension("sh.ready");
        tokio::spawn(async move {
            while !ready.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            // One beat for the reader to consume the buffered init line, so the
            // select can't randomly pick the abort branch and drop it.
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            killer.notify_one();
        });
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
            None,
        )
        .await
        .unwrap();

        assert!(outcome.aborted);
        // The ghost session id was captured but flagged unsafe to persist.
        assert_eq!(outcome.resume_id.as_deref(), Some("ghost-session"));
        assert!(!outcome.streamed);
        assert!(!outcome.resume_rejected);
        // No error bubble — a user stop is not a failure.
        let events = sink.0.lock().unwrap();
        assert!(!types(&events).iter().any(|t| t == "message_update:text_end"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A `--resume` token the CLI can't find (its turn was killed before the
    /// session hit disk) must be flagged so the caller resets it, and the bare
    /// "agent reported an error" replaced with an actionable message.
    #[tokio::test]
    async fn run_cli_turn_dead_resume_token_flags_rejection() {
        let dir = std::env::temp_dir().join(format!(
            "cetus-cli-dead-resume-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-dead-resume.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\n\
             echo 'No conversation found with session ID: ghost-session' >&2\n\
             echo '{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"is_error\":true,\"result\":null}'\n\
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
            CliRunOpts {
                resume: Some("ghost-session".into()),
                ..CliRunOpts::default()
            },
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert!(outcome.resume_rejected);
        // The surfaced error tells the user what happened and what to do.
        let text = outcome.messages[0]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("couldn't resume"), "got: {text}");
        assert!(text.contains("send your message again"), "got: {text}");

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

    /// A steer that merged into the running turn: its `result` already covers
    /// the injected message, so after the quiet grace window the turn closes —
    /// well before the idling child's sleep runs out.
    #[tokio::test]
    async fn run_cli_turn_steer_merged_closes_after_grace() {
        let dir =
            std::env::temp_dir().join(format!("cetus-cli-steer-merge-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-merged.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}}'\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"merged\"}}}'\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":0}}'\n\
             echo '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"merged\"}'\n\
             sleep 30\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
        let steer = Arc::new(std::sync::atomic::AtomicUsize::new(1));
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
            None,
            None,
            Some(steer),
        )
        .await
        .unwrap();

        assert!(!outcome.aborted);
        assert_eq!(outcome.messages[0]["content"][0]["text"], json!("merged"));
        let elapsed = started.elapsed();
        // Held open through the grace window, but nowhere near the child's
        // 30s idle sleep.
        assert!(elapsed >= std::time::Duration::from_millis(1900), "{elapsed:?}");
        assert!(elapsed < std::time::Duration::from_secs(10), "{elapsed:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A fast subagent: its completion notification lands BEFORE the turn's
    /// `result` (observed on 2.1.201), so `has_pending_tasks` is already false
    /// when the result arrives. The runner must still hold the close through
    /// the quiet window — the CLI's continuation turn (the main agent
    /// digesting the subagent's report) arrives after that result, and killing
    /// on it would silently discard the subagent's work.
    #[tokio::test]
    async fn run_cli_turn_holds_close_for_subagent_continuation() {
        let dir =
            std::env::temp_dir().join(format!("cetus-cli-subagent-cont-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-subagent.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tA\",\"name\":\"Agent\",\"input\":{}}}}'\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":0}}'\n\
             echo '{\"type\":\"system\",\"subtype\":\"task_started\",\"task_id\":\"bg1\",\"tool_use_id\":\"tA\",\"description\":\"scan\",\"subagent_type\":\"Explore\"}'\n\
             echo '{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"tA\",\"content\":[{\"type\":\"text\",\"text\":\"Async agent launched successfully\"}],\"is_error\":false}]}}'\n\
             echo '{\"type\":\"system\",\"subtype\":\"task_notification\",\"task_id\":\"bg1\",\"tool_use_id\":\"tA\",\"status\":\"completed\",\"summary\":\"found it\"}'\n\
             echo '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"launched\"}'\n\
             sleep 1\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}}'\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"the subagent found it\"}}}'\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":0}}'\n\
             echo '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"done\"}'\n\
             sleep 30\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
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
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert!(!outcome.aborted);
        // The continuation turn's text made it into the transcript — the
        // runner did not kill the child at the first result.
        let all = serde_json::to_string(&outcome.messages).unwrap();
        assert!(all.contains("the subagent found it"), "{all}");
        assert!(all.contains("found it"), "notification summary persisted: {all}");
        let elapsed = started.elapsed();
        // Closed after the continuation + one quiet window, not the 30s idle.
        assert!(elapsed < std::time::Duration::from_secs(10), "{elapsed:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A steer that landed after the model finished: claude starts a NEW turn
    /// after the first `result`. The pending steer keeps the runner reading —
    /// the steered turn streams fully and its own `result` closes the run.
    #[tokio::test]
    async fn run_cli_turn_steer_new_turn_keeps_streaming() {
        let dir =
            std::env::temp_dir().join(format!("cetus-cli-steer-turn-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-steered.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}}'\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"first\"}}}'\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":0}}'\n\
             echo '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"first\"}'\n\
             sleep 1\n\
             echo '{\"type\":\"system\",\"subtype\":\"status\",\"status\":\"requesting\"}'\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}}'\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"steered\"}}}'\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":0}}'\n\
             echo '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"steered\"}'\n\
             sleep 30\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
        let steer = Arc::new(std::sync::atomic::AtomicUsize::new(1));
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
            None,
            None,
            Some(steer),
        )
        .await
        .unwrap();

        assert!(!outcome.aborted);
        // Both the pre-steer and the steered turn's text made it out.
        let all = serde_json::to_string(&outcome.messages).unwrap();
        assert!(all.contains("first") && all.contains("steered"), "{all}");
        // Closed on the steered turn's result, not the 30s idle sleep.
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "{:?}",
            started.elapsed()
        );
        let _ = std::fs::remove_dir_all(&dir);
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
    fn auth_expiry_stderr_condenses_to_hint() {
        let codex_dump = r#"2026-07-06T09:00:11Z ERROR codex_models_manager::manager: failed to refresh available models: unexpected status 401 Unauthorized: Your authentication token has been invalidated. Please try signing in again., auth error code: token_invalidated
2026-07-06T09:00:15Z ERROR codex_login::auth::manager: Failed to refresh token: 401 Unauthorized: { "code": "refresh_token_invalidated" }"#;
        let hint = auth_expired_hint(CliBackend::Codex, codex_dump).unwrap();
        assert!(hint.contains("codex login"), "actionable: {hint}");
        assert!(hint.len() < 200, "short, not a log wall");
        assert_eq!(auth_expired_hint(CliBackend::Codex, "some unrelated panic"), None);
        let claude_hint =
            auth_expired_hint(CliBackend::ClaudeCode, "OAuth token has expired").unwrap();
        assert!(claude_hint.contains("/login"));
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
    fn sidechain_lines_are_dropped() {
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        // A subagent's own lines carry parent_tool_use_id and must never leak
        // into the main transcript. With no registered task to attach them to
        // (defensive: task_started missed), snapshots are dropped outright;
        // sidechain stream_events are always dropped (their block indexes
        // would collide with the parent's).
        assert!(tr.on_line(r#"{"type":"stream_event","parent_tool_use_id":"tp","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#).is_empty());
        assert!(tr.on_line(r#"{"type":"assistant","parent_tool_use_id":"tp","message":{"model":"claude-fable-5","content":[{"type":"text","text":"sub says hi"}]}}"#).is_empty());
        assert!(tr.on_line(r#"{"type":"user","parent_tool_use_id":"tp","message":{"content":[{"type":"tool_result","tool_use_id":"inner-1","content":"ls output","is_error":false}]}}"#).is_empty());
        assert!(tr.take_messages().is_empty());
        assert!(tr.assistant_blocks_empty());
    }

    #[test]
    fn sidechain_activity_paints_steps_on_agent_card() {
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tA","name":"Agent","input":{}}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);
        tr.on_line(r#"{"type":"system","subtype":"task_started","task_id":"bg1","tool_use_id":"tA","description":"scan repo","subagent_type":"Explore"}"#);
        // The subagent calls a tool → a running step appears on the Agent card.
        let ev = tr.on_line(r#"{"type":"assistant","parent_tool_use_id":"tA","message":{"content":[{"type":"tool_use","id":"inner-1","name":"Bash","input":{"command":"ls -la","description":"List files"}}]}}"#);
        let update = ev.iter().find(|e| e["type"] == "tool_execution_update").unwrap();
        assert_eq!(update["toolCallId"], json!("tA"));
        let steps = &update["partialResult"]["details"]["subagent"]["steps"];
        assert_eq!(steps[0]["tool"], json!("Bash"));
        assert_eq!(steps[0]["detail"], json!("List files"));
        assert_eq!(steps[0]["done"], json!(false));
        // Its tool_result settles that step.
        let ev = tr.on_line(r#"{"type":"user","parent_tool_use_id":"tA","message":{"content":[{"type":"tool_result","tool_use_id":"inner-1","content":"ls output","is_error":false}]}}"#);
        let update = ev.iter().find(|e| e["type"] == "tool_execution_update").unwrap();
        assert_eq!(update["partialResult"]["details"]["subagent"]["steps"][0]["done"], json!(true));
        // task_progress keeps carrying the accumulated steps.
        let ev = tr.on_line(r#"{"type":"system","subtype":"task_progress","task_id":"bg1","tool_use_id":"tA","description":"Reading main.rs"}"#);
        assert_eq!(ev[0]["partialResult"]["details"]["subagent"]["steps"][0]["tool"], json!("Bash"));
        // Nothing leaked into the main transcript.
        tr.finish(None);
        assert!(tr.take_messages().iter().all(|m| m["role"] != json!("toolResult")));
    }

    #[test]
    fn task_notification_summary_is_the_report() {
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tA","name":"Agent","input":{}}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);
        tr.on_line(r#"{"type":"system","subtype":"task_started","task_id":"bg1","tool_use_id":"tA","description":"scan repo","subagent_type":"Explore"}"#);
        tr.on_line(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tA","content":[{"type":"text","text":"Async agent launched successfully. agentId: abc"}],"is_error":false}]}}"#);
        tr.on_line(r#"{"type":"assistant","parent_tool_use_id":"tA","message":{"content":[{"type":"tool_use","id":"inner-1","name":"Read","input":{"file_path":"main.rs"}}]}}"#);
        let ev = tr.on_line(r#"{"type":"system","subtype":"task_notification","task_id":"bg1","tool_use_id":"tA","status":"completed","summary":"Found 3 files: main.rs, a.txt, b.txt"}"#);
        let end = ev.iter().find(|e| e["type"] == "tool_execution_end").unwrap();
        assert_eq!(end["result"]["content"][0]["text"], json!("Found 3 files: main.rs, a.txt, b.txt"));
        assert_eq!(end["result"]["details"]["subagent"]["steps"][0]["tool"], json!("Read"));
        // The persisted row was rewritten with the report + step trace, so a
        // reloaded conversation replays the same card.
        tr.finish(None);
        let msgs = tr.take_messages();
        let row = msgs.iter().find(|m| m["role"] == json!("toolResult")).unwrap();
        assert_eq!(row["content"][0]["text"], json!("Found 3 files: main.rs, a.txt, b.txt"));
        assert_eq!(row["details"]["subagent"]["type"], json!("Explore"));
    }

    #[test]
    fn background_subagent_lifecycle() {
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        // Main agent calls the Agent tool.
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tA","name":"Agent","input":{}}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);
        // CLI reports the background task started…
        tr.on_line(r#"{"type":"system","subtype":"task_started","task_id":"bg1","tool_use_id":"tA","description":"scan repo","subagent_type":"Explore"}"#);
        assert!(tr.has_pending_tasks());
        // …and immediately answers the tool call with the internal launch ack.
        let ev = tr.on_line(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tA","content":[{"type":"text","text":"Async agent launched successfully. agentId: abc (internal ID - do not mention)"}],"is_error":false}]}}"#);
        let tys = types(&ev);
        assert!(tys.contains(&"tool_execution_update".to_string()), "{tys:?}");
        assert!(!tys.contains(&"tool_execution_end".to_string()), "card must stay running: {tys:?}");
        let update = ev.iter().find(|e| e["type"] == "tool_execution_update").unwrap();
        let shown = update["partialResult"]["content"][0]["text"].as_str().unwrap();
        assert!(shown.contains("Explore"), "clean status, not the ack blob: {shown}");
        assert!(!shown.contains("agentId"), "internal metadata hidden: {shown}");
        // Progress paints onto the same card.
        let ev = tr.on_line(r#"{"type":"system","subtype":"task_progress","task_id":"bg1","tool_use_id":"tA","description":"Running ls","subagent_type":"Explore"}"#);
        assert_eq!(ev[0]["type"], json!("tool_execution_update"));
        assert_eq!(ev[0]["toolCallId"], json!("tA"));
        // Intermediate result: the turn must NOT close while bg1 runs.
        tr.on_line(r#"{"type":"result","subtype":"success","is_error":false}"#);
        assert!(tr.saw_result && tr.has_pending_tasks());
        tr.saw_result = false; // what the runner does in this case
        // Completion settles the card and releases the turn.
        let ev = tr.on_line(r#"{"type":"system","subtype":"task_notification","task_id":"bg1","tool_use_id":"tA","status":"completed"}"#);
        let end = ev.iter().find(|e| e["type"] == "tool_execution_end").unwrap();
        assert_eq!(end["toolCallId"], json!("tA"));
        assert_eq!(end["isError"], json!(false));
        assert!(!tr.has_pending_tasks());
        // The persisted toolResult row carries the final status, not the ack.
        tr.finish(None);
        let msgs = tr.take_messages();
        let row = msgs.iter().find(|m| m["role"] == json!("toolResult")).unwrap();
        assert_eq!(row["toolName"], json!("Agent"));
        let text = row["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("completed"), "{text}");
    }

    /// The Workflow tool's launch ack has its own wording — it must keep the
    /// card running and the task pending like the Agent tool's ack does.
    /// (Matching only the Agent string settled the card "completed" and let
    /// the runner kill the CLI while the workflow was still running.)
    #[test]
    fn workflow_launch_ack_keeps_task_pending() {
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tW","name":"Workflow","input":{}}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);
        tr.on_line(r#"{"type":"system","subtype":"task_started","task_id":"wf1","tool_use_id":"tW","description":"Deep research harness"}"#);
        let ev = tr.on_line(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tW","content":"Workflow launched in background. Task ID: wabc123\nSummary: Deep research harness\nTranscript dir: /tmp/x","is_error":false}]}}"#);
        let tys = types(&ev);
        assert!(tys.contains(&"tool_execution_update".to_string()), "{tys:?}");
        assert!(!tys.contains(&"tool_execution_end".to_string()), "card must stay running: {tys:?}");
        assert!(tr.has_pending_tasks(), "the runner must hold the turn open");
        let update = ev.iter().find(|e| e["type"] == "tool_execution_update").unwrap();
        let shown = update["partialResult"]["content"][0]["text"].as_str().unwrap();
        assert!(shown.starts_with("Workflow running in background"), "{shown}");
        assert!(!shown.contains("Task ID"), "internal metadata hidden: {shown}");
        // Completion notification carries the report and releases the turn.
        let ev = tr.on_line(r#"{"type":"system","subtype":"task_notification","task_id":"wf1","tool_use_id":"tW","status":"completed","summary":"the findings"}"#);
        let end = ev.iter().find(|e| e["type"] == "tool_execution_end").unwrap();
        assert_eq!(end["result"]["content"][0]["text"], json!("the findings"));
        assert!(!tr.has_pending_tasks());
    }

    /// Claude Code reports `Bash(run_in_background=true)` through the same
    /// task lifecycle as agents, but its launch result has command-specific
    /// wording and `task_type: local_bash` instead of `subagent_type`.
    #[test]
    fn background_bash_stays_running_until_notification() {
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tBash","name":"Bash","input":{}}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"command\":\"sleep 30\",\"description\":\"Monitor CI\",\"run_in_background\":true}"}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);
        tr.on_line(r#"{"type":"system","subtype":"task_started","task_id":"shell1","tool_use_id":"tBash","description":"Monitor CI","task_type":"local_bash"}"#);
        assert!(tr.has_pending_tasks());

        let ev = tr.on_line(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tBash","content":"Command running in background with ID: shell1. Output is being written to: /tmp/shell1.output. You will be notified when it completes.","is_error":false}]}}"#);
        let tys = types(&ev);
        assert!(tys.contains(&"tool_execution_update".to_string()), "{tys:?}");
        assert!(!tys.contains(&"tool_execution_end".to_string()), "card must stay running: {tys:?}");
        assert!(tr.has_pending_tasks(), "the runner must keep reading the monitor stream");
        assert!(!tr.has_pending_turn_tasks(), "background Bash must not keep the model turn open");
        let update = ev.iter().find(|e| e["type"] == "tool_execution_update").unwrap();
        assert_eq!(update["partialResult"]["details"]["subagent"]["type"], json!("Bash"));
        let shown = update["partialResult"]["content"][0]["text"].as_str().unwrap();
        assert!(shown.starts_with("Background command running"), "{shown}");
        assert!(!shown.contains("/tmp/shell1.output"), "internal output path hidden: {shown}");

        let ev = tr.on_line(r#"{"type":"system","subtype":"task_notification","task_id":"shell1","tool_use_id":"tBash","status":"completed","summary":"Background command completed (exit code 0)"}"#);
        let end = ev.iter().find(|e| e["type"] == "tool_execution_end").unwrap();
        assert_eq!(end["toolCallId"], json!("tBash"));
        assert_eq!(end["result"]["details"]["subagent"]["status"], json!("completed"));
        assert!(!tr.has_pending_tasks());
    }

    #[test]
    fn sync_subagent_result_ends_task() {
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tB","name":"Task","input":{}}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);
        tr.on_line(r#"{"type":"system","subtype":"task_started","task_id":"bg2","tool_use_id":"tB","description":"quick check","subagent_type":"Explore"}"#);
        // A real report (no async-launch ack) settles the card and the task.
        let ev = tr.on_line(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tB","content":"the answer is 42","is_error":false}]}}"#);
        assert!(types(&ev).contains(&"tool_execution_end".to_string()));
        assert!(!tr.has_pending_tasks());
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
                append_system_prompt: Some("host hint".into()),
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
        assert!(args.contains(&"--append-system-prompt".to_string()));
        assert!(args.contains(&"host hint".to_string()));
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
                append_system_prompt: None,
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
