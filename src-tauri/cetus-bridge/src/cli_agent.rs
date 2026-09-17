//! CLI-agent backends translated into Cetus's structured event transport.
//!
//! This module owns the shared API and event-translation state. Backend event
//! handling lives in `claude_events` and `codex_events`; persistent processes
//! live in the corresponding `*_session` modules (including native ACP).
//! `runner` handles one-shot processes, `dsh` prepares its runtime, and
//! `artifacts` normalizes tool output and materializes delivered files.
//! Public re-exports preserve the host's existing `cli_agent` API.

mod artifacts;
mod claude_events;
mod codex_events;
mod dsh;
use artifacts::{
    bounded_tool_output_preview, extracted_artifact_details, normalize_content,
    persist_tool_output, utf8_suffix, TOOL_OUTPUT_FLUSH_INTERVAL, TOOL_OUTPUT_OMISSION_MARKER,
    TOOL_OUTPUT_PENDING_BYTES, TOOL_OUTPUT_PREVIEW_BYTES,
};
mod claude_session;
pub use claude_session::{spawn_claude_session, ClaudeSessionHandle};
mod acp_session;
pub use acp_session::{spawn_acp_session, AcpSessionHandle};
mod codex_session;
use codex_session::codex_text_phase;
pub use codex_session::{probe_codex_skills, spawn_codex_session, CodexSessionHandle};
mod runner;
pub use runner::run_cli_turn;
#[cfg(test)]
mod tests;

use crate::pi_rpc::EventSink;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

/// Which coding-agent CLI backs a conversation. `pi` stays the default and is
/// handled by [`crate::pi_rpc::PiRpc`]; these are the CLI-subprocess backends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliBackend {
    ClaudeCode,
    Codex,
    OpenCode,
    Grok,
    Kimi,
    Dsh,
}
impl CliBackend {
    /// Stable identifier persisted on a conversation and sent from the UI.
    pub fn as_str(self) -> &'static str {
        match self {
            CliBackend::ClaudeCode => "claude-code",
            CliBackend::Codex => "codex",
            CliBackend::OpenCode => "opencode",
            CliBackend::Grok => "grok",
            CliBackend::Kimi => "kimi",
            CliBackend::Dsh => "dsh",
        }
    }

    pub fn from_id(s: &str) -> Option<Self> {
        match s {
            "claude-code" | "claude" => Some(CliBackend::ClaudeCode),
            "codex" => Some(CliBackend::Codex),
            "opencode" => Some(CliBackend::OpenCode),
            "grok" | "grok-build" => Some(CliBackend::Grok),
            "kimi" | "kimi-cli" => Some(CliBackend::Kimi),
            "dsh" | "deepseek-harness" => Some(CliBackend::Dsh),
            _ => None,
        }
    }

    /// Default executable name resolved on `PATH` (overridable by the caller).
    pub fn default_bin(self) -> &'static str {
        match self {
            CliBackend::ClaudeCode => "claude",
            CliBackend::Codex => "codex",
            CliBackend::OpenCode => "opencode",
            CliBackend::Grok => "grok",
            CliBackend::Kimi => "kimi",
            CliBackend::Dsh => "dsh",
        }
    }

    pub fn is_acp(self) -> bool {
        matches!(self, Self::OpenCode | Self::Grok | Self::Kimi | Self::Dsh)
    }

    /// Arguments that start the vendor's native ACP stdio server.
    pub fn acp_args(self) -> &'static [&'static str] {
        match self {
            Self::OpenCode => &["acp"],
            Self::Grok => &["agent", "stdio"],
            Self::Kimi => &["acp"],
            Self::Dsh => &["--profile", "acp"],
            _ => &[],
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
    /// ACP only, and only meaningful together with `resume`: the first-turn
    /// preamble (Cetus hint + transcript handoff) to prepend if the agent turns
    /// out to be unable to `session/load` that token. An ACP session id lives in
    /// the vendor process, so a cold start after a restart otherwise resumes
    /// into an empty session with no sign that the context is gone.
    pub cold_start_preamble: Option<String>,
    /// Host version reported in the ACP `initialize` handshake. None → the
    /// bridge crate's own version.
    pub client_version: Option<String>,
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
                                            // Adaptive-thinking models (Opus 4.8 / Fable 5) omit thinking
                                            // text unless the client opts into a display mode, and
                                            // headless -p additionally forces "omitted" when unset — every
                                            // thinking block would arrive as signature-only with an empty
                                            // body. Hidden flag; accepted since at least 2.1.204.
                a.push("--thinking-display".into());
                a.push("summarized".into());
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
            CliBackend::OpenCode | CliBackend::Grok | CliBackend::Kimi | CliBackend::Dsh => {
                let _ = (prompt, opts);
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

fn claude_prompt_tokens(usage: &Value) -> u64 {
    [
        "input_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    ]
    .into_iter()
    .filter_map(|key| usage.get(key).and_then(Value::as_u64))
    .sum()
}

/// Stateful translator from a backend's raw JSONL lines to Cetus `PiEvent`
/// values. Allocates a monotonic `contentIndex` per block and remembers which
/// tool-call ids map to which block so `tool_execution_*` events line up with
/// the `tool_use` card the frontend already created.
pub struct EventTranslator {
    backend: CliBackend,
    /// Runtime-produced inline files are materialized here. Local file results
    /// stay at their original path so large media is never copied eagerly.
    artifact_dir: Option<PathBuf>,
    /// Resolves relative file paths returned by a tool.
    cwd: Option<PathBuf>,
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
    /// In-flight Codex agent-message / reasoning blocks. App-server emits
    /// these as separate delta notifications rather than `item/completed`;
    /// retaining them here lets the UI paint tokens immediately and lets an
    /// interrupted turn persist the partial text.
    codex_live_blocks: std::collections::HashMap<String, CodexLiveBlock>,
    /// Optional message semantics from app-server; absent on older Codex.
    codex_message_phases: std::collections::HashMap<String, String>,
    /// Coalesced command output waiting to be sent to the running tool card.
    /// Keeping only a bounded pending suffix prevents a noisy command from
    /// growing bridge messages quadratically.
    codex_tool_output: std::collections::HashMap<String, CodexToolOutput>,
    /// Whether the current Claude API message delivered content through
    /// stream_event partials. Older/changed CLI builds can omit partials even
    /// when requested; the cumulative assistant snapshot then becomes the
    /// lossless fallback instead of leaving the turn blank.
    claude_streamed_content: bool,
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
    /// claude only: steered user messages written to stdin mid-turn, awaiting
    /// their merge point. Claude folds a mid-turn stdin message into the NEXT
    /// API request it makes — at that `message_start` the transcript splits:
    /// the open assistant bubble closes, these rows splice in, and subsequent
    /// content opens a fresh bubble. Without this the steer would render (and
    /// persist) outside the turn it actually landed in.
    pending_steer: Vec<Value>,
    /// Latest main-chain Claude request's prompt/output occupancy. Retained
    /// across turns because the persistent session owns the context window.
    claude_context_used: u64,
    claude_context_window: Option<u64>,
    claude_model: Option<String>,
    /// Approximate raw vendor transcript bytes observed by this session.
    /// This is intentionally independent from token accounting: giant tool
    /// results and inline media can make the persisted stream unhealthy well
    /// before the model context window is full.
    protocol_bytes: usize,
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

/// Human task kind from a claude task event or `background_tasks_changed`
/// list item: the subagent type when present, else the task_type (with the
/// CLI's `local_bash` — background Bash AND Monitor scripts — shown as
/// "Bash").
fn task_kind(v: &Value) -> String {
    v.get("subagent_type")
        .and_then(|t| t.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| match v.get("task_type").and_then(|t| t.as_str()) {
            Some("local_bash") => "Bash".to_string(),
            Some(kind) if !kind.is_empty() => kind.to_string(),
            _ => "Task".to_string(),
        })
}

/// One line summarizing a subagent tool call's input — the field that carries
/// the "what" of the call, mirroring the frontend's summarizeArgs.
fn summarize_tool_input(input: &Value) -> String {
    for key in [
        "description",
        "command",
        "file_path",
        "path",
        "pattern",
        "query",
        "url",
        "prompt",
    ] {
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
    /// Whether the block's `*_start` event has been emitted (and `our_index`
    /// allocated). Thinking blocks defer this to their first delta: sessions
    /// whose thinking display is omitted stream signature-only blocks with no
    /// text, and opening those would leave empty "Thinking" steps in the UI.
    started: bool,
}

struct CodexLiveBlock {
    item_id: String,
    our_index: usize,
    kind: LiveKind,
    buffer: String,
}

struct CodexToolOutput {
    pending: String,
    total_bytes: usize,
    last_emit: Instant,
    dropped_pending: bool,
}

impl CodexToolOutput {
    fn new() -> Self {
        Self {
            pending: String::new(),
            total_bytes: 0,
            last_emit: Instant::now() - TOOL_OUTPUT_FLUSH_INTERVAL,
            dropped_pending: false,
        }
    }

    fn push(&mut self, delta: &str) {
        self.total_bytes = self.total_bytes.saturating_add(delta.len());
        self.pending.push_str(delta);
        if self.pending.len() > TOOL_OUTPUT_PENDING_BYTES {
            self.pending = utf8_suffix(&self.pending, TOOL_OUTPUT_PENDING_BYTES).to_string();
            self.dropped_pending = true;
        }
    }

    fn flush(&mut self, id: &str, force: bool) -> Option<Value> {
        if self.pending.is_empty()
            || (!force && self.last_emit.elapsed() < TOOL_OUTPUT_FLUSH_INTERVAL)
        {
            return None;
        }
        let mut delta = std::mem::take(&mut self.pending);
        let truncated = self.dropped_pending || self.total_bytes > TOOL_OUTPUT_PREVIEW_BYTES;
        if self.dropped_pending {
            delta.insert_str(0, TOOL_OUTPUT_OMISSION_MARKER);
        }
        self.dropped_pending = false;
        self.last_emit = Instant::now();
        Some(json!({
            "type": "tool_execution_delta",
            "toolCallId": id,
            "delta": delta,
            "totalBytes": self.total_bytes,
            "truncated": truncated,
        }))
    }
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
            artifact_dir: None,
            cwd: None,
            next_index: 0,
            resume_id: None,
            finished: false,
            assistant_blocks: Vec::new(),
            messages: Vec::new(),
            tool_names: std::collections::HashMap::new(),
            live_blocks: std::collections::HashMap::new(),
            codex_live_blocks: std::collections::HashMap::new(),
            codex_message_phases: std::collections::HashMap::new(),
            codex_tool_output: std::collections::HashMap::new(),
            claude_streamed_content: false,
            saw_result: false,
            result_error: None,
            started_items: std::collections::HashSet::new(),
            opened: false,
            background_tasks: std::collections::HashMap::new(),
            pending_steer: Vec::new(),
            claude_context_used: 0,
            claude_context_window: None,
            claude_model: None,
            protocol_bytes: 0,
        }
    }

    pub fn with_artifact_storage(mut self, artifact_dir: PathBuf, cwd: PathBuf) -> Self {
        self.artifact_dir = Some(artifact_dir);
        self.cwd = Some(cwd);
        self
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

    /// Queue a steered user message (already written to the child's stdin).
    /// It splices into the transcript at the next API `message_start` — see
    /// `pending_steer`.
    pub fn queue_steer(&mut self, message: Value) {
        self.pending_steer.push(message);
    }

    /// Splice Codex `turn/steer` input into the persisted transcript when the
    /// app-server announces its `userMessage` item. Waiting for that item
    /// preserves the real order relative to any assistant delta already in
    /// flight; persisting at button-click time would put the steer before the
    /// assistant work it actually redirected.
    fn splice_codex_steer(&mut self) -> Vec<Value> {
        if self.pending_steer.is_empty() {
            return Vec::new();
        }
        let mut out = self.close_all_codex_blocks();
        self.flush_assistant();
        self.messages.append(&mut self.pending_steer);
        if self.opened {
            out.push(json!({ "type": "message_end" }));
            self.opened = false;
        }
        self.next_index = 0;
        out
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
        self.codex_live_blocks.clear();
        self.codex_message_phases.clear();
        self.codex_tool_output.clear();
        self.claude_streamed_content = false;
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

    fn claude_context_event(&self) -> Option<Value> {
        let context_window = self.claude_context_window?;
        Some(json!({
            "type": "cli_context_usage",
            "usedTokens": self.claude_context_used,
            "contextWindow": context_window,
            "transcriptBytes": self.protocol_bytes,
        }))
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
                    Some("message_update")
                        | Some("tool_execution_start")
                        | Some("tool_execution_end")
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
        let mut out = self.flush_codex_tool_output(true);
        out.extend(self.close_live_blocks());
        out.extend(self.close_all_codex_blocks());
        if let Some(msg) = error {
            let text = match agent_error_hint(msg) {
                Some(hint) => format!("⚠️ agent error: {msg}\n\n💡 {hint}"),
                None => format!("⚠️ agent error: {msg}"),
            };
            out.extend(self.emit_text(&text));
        }
        self.flush_assistant();
        // A steer the model never consumed (the turn's result raced the stdin
        // write) still belongs in the transcript — claude answers it as a
        // self-started continuation turn, so the row precedes that reply.
        self.messages.append(&mut self.pending_steer);
        let mut out = self.with_open(out);
        // message_end only makes sense for a bubble that was opened; a turn
        // that produced nothing closes with agent_end alone (the reducer
        // clears its placeholder there).
        if self.opened {
            out.push(json!({ "type": "message_end" }));
        }
        out.push(json!({ "type": "agent_end" }));
        // pi (≥ 0.80.4) follows every run with `agent_settled` once it will not
        // continue on its own (auto-retry, compaction retry, queued follow-up).
        // The CLI child has already exited by the time we get here, so its run
        // is settled by definition — emit the same event so every runtime ends a
        // turn through one signal instead of the frontend special-casing pi.
        out.push(json!({ "type": "agent_settled" }));
        self.finished = true;
        out
    }

    fn flush_codex_tool_output(&mut self, force: bool) -> Vec<Value> {
        let mut ids: Vec<String> = self.codex_tool_output.keys().cloned().collect();
        ids.sort();
        ids.into_iter()
            .filter_map(|id| {
                self.codex_tool_output
                    .get_mut(&id)
                    .and_then(|output| output.flush(&id, force))
            })
            .collect()
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

    fn emit_codex_delta(
        &mut self,
        key: String,
        item_id: &str,
        kind: LiveKind,
        delta: &str,
    ) -> Vec<Value> {
        if delta.is_empty() {
            return Vec::new();
        }
        let mut out = Vec::new();
        if !self.codex_live_blocks.contains_key(&key) {
            let our_index = self.alloc_index();
            let start = match kind {
                LiveKind::Text => "text_start",
                LiveKind::Thinking => "thinking_start",
                LiveKind::ToolUse => return Vec::new(),
            };
            self.codex_live_blocks.insert(
                key.clone(),
                CodexLiveBlock {
                    item_id: item_id.to_string(),
                    our_index,
                    kind,
                    buffer: String::new(),
                },
            );
            let mut event = json!({ "type": start, "contentIndex": our_index });
            if start == "text_start" {
                if let Some(phase) = self.codex_message_phases.get(item_id) {
                    event["phase"] = json!(phase);
                }
            }
            out.push(am(event));
        }
        let block = self
            .codex_live_blocks
            .get_mut(&key)
            .expect("block inserted");
        block.buffer.push_str(delta);
        let event = match block.kind {
            LiveKind::Text => "text_delta",
            LiveKind::Thinking => "thinking_delta",
            LiveKind::ToolUse => return Vec::new(),
        };
        out.push(am(json!({
            "type": event,
            "contentIndex": block.our_index,
            "delta": delta,
        })));
        out
    }

    /// Settle all streamed blocks for one completed Codex item. For a
    /// single-block item, `authoritative` is the completed text: text_end
    /// replaces the live buffer if a proposed/experimental delta stream did
    /// not concatenate to exactly the final item.
    fn close_codex_item(&mut self, item_id: &str, authoritative: Option<&str>) -> Vec<Value> {
        let phase = self.codex_message_phases.remove(item_id);
        let mut keys: Vec<String> = self
            .codex_live_blocks
            .iter()
            .filter(|(_, block)| block.item_id == item_id)
            .map(|(key, _)| key.clone())
            .collect();
        keys.sort_by_key(|key| self.codex_live_blocks[key].our_index);
        let single = keys.len() == 1;
        let mut out = Vec::new();
        for key in keys {
            let mut block = self
                .codex_live_blocks
                .remove(&key)
                .expect("live block exists");
            if single {
                if let Some(final_text) = authoritative.filter(|text| !text.is_empty()) {
                    block.buffer = final_text.to_string();
                }
            }
            let (end, mut persisted) = match block.kind {
                LiveKind::Text => ("text_end", json!({ "type": "text", "text": block.buffer })),
                LiveKind::Thinking => (
                    "thinking_end",
                    json!({ "type": "thinking", "thinking": block.buffer }),
                ),
                LiveKind::ToolUse => continue,
            };
            let mut event = json!({
                "type": end,
                "contentIndex": block.our_index,
                "content": block.buffer,
            });
            if end == "text_end" {
                if let Some(phase) = &phase {
                    persisted["phase"] = json!(phase);
                    event["phase"] = json!(phase);
                }
            }
            self.assistant_blocks.push(persisted);
            out.push(am(event));
        }
        out
    }

    fn close_all_codex_blocks(&mut self) -> Vec<Value> {
        let mut item_ids: Vec<String> = self
            .codex_live_blocks
            .values()
            .map(|block| block.item_id.clone())
            .collect();
        item_ids.sort();
        item_ids.dedup();
        let mut out = Vec::new();
        for item_id in item_ids {
            out.extend(self.close_codex_item(&item_id, None));
        }
        out
    }

    /// Emit a complete text block (start+delta+end) at a fresh index.
    fn emit_text(&mut self, text: &str) -> Vec<Value> {
        self.emit_text_with_phase(text, None)
    }

    fn emit_text_with_phase(&mut self, text: &str, phase: Option<&str>) -> Vec<Value> {
        let i = self.alloc_index();
        let mut block = json!({ "type": "text", "text": text });
        let mut end = json!({ "type": "text_end", "contentIndex": i, "content": text });
        if let Some(phase) = phase {
            block["phase"] = json!(phase);
            end["phase"] = json!(phase);
        }
        self.assistant_blocks.push(block);
        vec![
            am(json!({ "type": "text_start", "contentIndex": i })),
            am(json!({ "type": "text_delta", "contentIndex": i, "delta": text })),
            am(end),
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
        self.emit_tool_result_end_with_details(id, content, Value::Null, is_error)
    }

    fn emit_codex_command_result_end(
        &mut self,
        id: &str,
        output: &Value,
        is_error: bool,
    ) -> Vec<Value> {
        let Some(full) = output.as_str() else {
            return self.emit_tool_result_end(id, output, is_error);
        };
        let (preview, truncated) = bounded_tool_output_preview(full);
        let path = truncated
            .then(|| persist_tool_output(self.artifact_dir.as_deref(), id, full))
            .flatten();
        self.emit_tool_result_end_with_details(
            id,
            &json!(preview),
            json!({
                "toolOutput": {
                    "truncated": truncated,
                    "totalBytes": full.len(),
                    "path": path.map(|p| p.to_string_lossy().into_owned()),
                }
            }),
            is_error,
        )
    }

    fn emit_tool_result_end_with_details(
        &mut self,
        id: &str,
        content: &Value,
        details: Value,
        is_error: bool,
    ) -> Vec<Value> {
        let artifact_details =
            extracted_artifact_details(content, self.artifact_dir.as_deref(), self.cwd.as_deref());
        let details = match artifact_details {
            Some(artifacts) if details.is_null() => artifacts,
            Some(artifacts) => json!({ "artifacts": artifacts, "runtimeDetails": details }),
            None => details,
        };
        let content = normalize_content(content);
        // A result closes the assistant segment that issued the call, matching
        // the assistant / toolResult interleaving of a pi transcript.
        self.flush_assistant();
        self.messages.push(json!({
            "role": "toolResult",
            "toolCallId": id,
            "toolName": self.tool_names.get(id).cloned().unwrap_or_else(|| "tool".to_string()),
            "content": content,
            "details": details.clone(),
            "isError": is_error,
        }));
        vec![json!({
            "type": "tool_execution_end",
            "toolCallId": id,
            "result": { "content": content, "details": details },
            "isError": is_error,
        })]
    }

    /// Translate one ACP `session/update` payload into Cetus's existing event
    /// model. All native ACP runtimes share this path; only their launch
    /// command differs.
    pub fn on_acp_update(&mut self, update: &Value) -> Vec<Value> {
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or("");
        let mut out = match kind {
            "agent_message_chunk" => {
                let text = acp_content_text(update.get("content"));
                self.emit_codex_delta(
                    "acp-message".to_string(),
                    "acp-message",
                    LiveKind::Text,
                    &text,
                )
            }
            "agent_thought_chunk" => {
                let text = acp_content_text(update.get("content"));
                self.emit_codex_delta(
                    "acp-thought".to_string(),
                    "acp-thought",
                    LiveKind::Thinking,
                    &text,
                )
            }
            "tool_call" => {
                let mut events = self.close_all_codex_blocks();
                let id = update
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or("acp-tool");
                let name = update
                    .get("kind")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty() && *value != "other")
                    .or_else(|| update.get("title").and_then(Value::as_str))
                    .unwrap_or("tool");
                let input = update
                    .get("rawInput")
                    .cloned()
                    .unwrap_or_else(|| json!({ "description": update.get("title") }));
                if self.started_items.insert(id.to_string()) {
                    events.extend(self.emit_tool_call(id, name, &input));
                    events.push(json!({ "type": "tool_execution_start", "toolCallId": id }));
                }
                if acp_tool_terminal(update) {
                    let result = acp_tool_result(update);
                    let failed = update.get("status").and_then(Value::as_str) == Some("failed");
                    events.extend(self.emit_tool_result_end(id, &result, failed));
                    self.started_items.remove(id);
                }
                events
            }
            "tool_call_update" => {
                let mut events = self.close_all_codex_blocks();
                let id = update
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or("acp-tool");
                if !self.started_items.contains(id) {
                    let name = update
                        .get("kind")
                        .and_then(Value::as_str)
                        .or_else(|| update.get("title").and_then(Value::as_str))
                        .unwrap_or("tool");
                    let input = update.get("rawInput").cloned().unwrap_or_else(|| json!({}));
                    self.started_items.insert(id.to_string());
                    events.extend(self.emit_tool_call(id, name, &input));
                    events.push(json!({ "type": "tool_execution_start", "toolCallId": id }));
                }
                if acp_tool_terminal(update) {
                    let result = acp_tool_result(update);
                    let failed = update.get("status").and_then(Value::as_str) == Some("failed");
                    events.extend(self.emit_tool_result_end(id, &result, failed));
                    self.started_items.remove(id);
                } else if let Some(content) = update.get("content") {
                    events.push(json!({
                        "type": "tool_execution_update",
                        "toolCallId": id,
                        "partialResult": { "content": normalize_content(content) },
                    }));
                }
                events
            }
            "available_commands_update" => vec![acp_commands_event(update)],
            _ => Vec::new(),
        };
        out = self.with_open(out);
        out
    }

    /// A main-chain claude tool result. Background subagent launches get
    /// special treatment: the CLI answers the Agent/Task call immediately with
    /// an internal-metadata ack (agentId, output file, "never quote this") and
    /// the agent keeps working in the background. Showing that blob — and
    /// settling the card — would read as a finished step. Instead the card
    /// gets a clean status and stays running until `task_notification`.

    /// Translate one raw JSONL line from the CLI into zero or more PiEvents.
    pub fn on_line(&mut self, line: &str) -> Vec<Value> {
        self.protocol_bytes = self.protocol_bytes.saturating_add(line.len());
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
            CliBackend::OpenCode | CliBackend::Grok | CliBackend::Kimi | CliBackend::Dsh => {
                Vec::new()
            }
        };
        self.with_open(events)
    }
}

/// Wrap an `assistantMessageEvent` payload in the `message_update` PiEvent.
fn am(event: Value) -> Value {
    json!({ "type": "message_update", "assistantMessageEvent": event })
}

/// The slash-command catalog from an `available_commands_update`. Free-standing
/// because agents announce their commands right after `session/new` — before
/// any turn owns a sink — so the session loop caches this and replays it when
/// the next turn opens.
fn acp_commands_event(update: &Value) -> Value {
    let commands = update
        .get("availableCommands")
        .and_then(Value::as_array)
        .map(|commands| {
            commands
                .iter()
                .filter_map(|command| {
                    // `input` is an object in the ACP schema (`{ hint }`), not a
                    // bare string.
                    let hint = command
                        .pointer("/input/hint")
                        .or_else(|| command.get("input"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    Some(json!({
                        "name": command.get("name")?.as_str()?,
                        "description": command.get("description").and_then(Value::as_str).unwrap_or(""),
                        "argumentHint": hint,
                        "kind": "command",
                    }))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({ "type": "cli_commands", "commands": commands })
}

fn acp_content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Object(object)) => object
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn acp_tool_terminal(update: &Value) -> bool {
    matches!(
        update.get("status").and_then(Value::as_str),
        Some("completed" | "failed")
    )
}

fn acp_tool_result(update: &Value) -> Value {
    if let Some(output) = update.get("rawOutput") {
        return output.clone();
    }
    if let Some(content) = update.get("content") {
        return content.clone();
    }
    json!(update
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("completed"))
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
    /// The turn's terminal failure, when it had one (error result, failed
    /// turn-end, dirty exit). Carried even when the error text was NOT
    /// rendered into the transcript (content had already streamed) — the
    /// caller inspects it to auto-retry transient failures (429 bursts,
    /// upstream overloads) via [`is_transient_agent_error`].
    pub error: Option<String>,
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

/// True for lines that carry actual model-turn content — the signal that the
/// CLI began a SELF-STARTED continuation turn (a background task completed and
/// re-invoked the model). Narrower than [`is_turn_activity`]: system task_*
/// events also fire while the session idles (a monitor updating, a card
/// settling) and must not open a turn in the UI.
fn is_continuation_content(line: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return false;
    };
    matches!(
        v.get("type").and_then(|t| t.as_str()).unwrap_or(""),
        "assistant" | "user" | "stream_event" | "control_request"
    )
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
        CliBackend::OpenCode => "opencode auth login",
        CliBackend::Grok => "grok login",
        // Kimi has no login subcommand — signing in happens inside the TUI.
        CliBackend::Kimi => "kimi, then /login",
        CliBackend::Dsh => "dsh web, then finish provider setup",
    };
    Some(format!(
        "{} session has expired. Run `{}` in a terminal to sign in again, then retry.",
        backend.as_str(),
        login
    ))
}

/// True when an error text reads as a usage/credit/quota limit — the runtime
/// is fine, the account just can't run more turns right now.
/// True for transient provider failures worth an automatic retry: rate-limit
/// bursts and upstream overloads recover on their own after a short wait.
/// Quota/credit exhaustion is excluded — those 429s hold until the billing
/// window resets, so retrying just burns the attempt (the usage-limit hint
/// with its runtime-switch way out is the right surface for them).
pub fn is_transient_agent_error(text: &str) -> bool {
    if is_usage_limit(text) {
        return false;
    }
    let t = text.to_lowercase();
    [
        "429",
        "too many requests",
        "exceeded retry limit",
        "rate limit",
        "rate_limit",
        "overloaded",
        "internal server error",
        "service unavailable",
        "gateway timeout",
        "529",
    ]
    .iter()
    .any(|p| t.contains(p))
}

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

/// Actionable follow-up appended to an `⚠️ agent error` bubble when the
/// message matches a known environment problem. These errors are correct but
/// useless to a non-CLI user ("Missing environment variable: `OPENAI_API_KEY`"
/// tells them nothing about running `codex login`), so translate the ones we
/// have seen in the wild into the one command that fixes them.
fn agent_error_hint(msg: &str) -> Option<&'static str> {
    let lower = msg.to_ascii_lowercase();
    if lower.contains("missing environment variable") && lower.contains("openai_api_key") {
        // Codex resolved auth to API-key mode: either the CLI was never signed
        // in (`~/.codex/auth.json` missing — the desktop app's login doesn't
        // count), or config.toml names a provider whose key wasn't in this
        // process's environment (the host adopts the login shell's env once,
        // at startup — an export added afterwards needs a relaunch).
        return Some(
            "Codex has no credentials here. Run `codex login` in a terminal to sign in. \
             If ~/.codex/config.toml points at a custom provider instead, make sure its \
             API key is exported in your shell profile (.zshrc), then restart Cetus so \
             it picks the variable up.",
        );
    }
    if lower.contains("please run /login")
        || lower.contains("oauth token has expired")
        || lower.contains("oauth token revoked")
    {
        return Some(
            "Claude Code isn't signed in. Run `claude` in a terminal and use `/login`, \
             then retry here.",
        );
    }
    None
}

struct ActiveTurn {
    sink: Arc<dyn EventSink>,
    outcome: tokio::sync::oneshot::Sender<CliTurnOutcome>,
}
