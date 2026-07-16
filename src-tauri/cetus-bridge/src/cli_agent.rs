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
use base64::Engine as _;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
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
                        } else if matches!(
                            o.get("type").and_then(|t| t.as_str()),
                            Some("image" | "input_image" | "inputImage" | "input_file" | "inputFile" | "file")
                        ) {
                            json!({ "type": "text", "text": "[Artifact delivered to user]" })
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

static ARTIFACT_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn mime_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "heic" => "image/heic",
        "avif" => "image/avif",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        "pdf" => "application/pdf",
        "md" | "markdown" => "text/markdown",
        "html" | "htm" => "text/html",
        "txt" | "log" => "text/plain",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "json" => "application/json",
        "xml" => "application/xml",
        "yaml" | "yml" => "application/yaml",
        "js" | "mjs" | "cjs" => "text/javascript",
        "ts" | "tsx" => "text/typescript",
        "css" => "text/css",
        "rtf" => "application/rtf",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        "tar" => "application/x-tar",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
}

fn artifact_kind(mime: &str) -> &'static str {
    if mime.starts_with("image/") {
        "image"
    } else if mime.starts_with("video/") {
        "video"
    } else if mime.starts_with("audio/") {
        "audio"
    } else if mime == "application/pdf" {
        "pdf"
    } else if mime == "text/markdown" {
        "markdown"
    } else if mime == "text/html" {
        "html"
    } else if mime.starts_with("text/")
        || matches!(mime, "application/json" | "application/xml" | "application/yaml")
    {
        "text"
    } else {
        "other"
    }
}

fn artifact_details(path: &Path, mime_override: Option<&str>, caption: Option<&str>) -> Option<Value> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mime = mime_override
        .filter(|mime| !mime.trim().is_empty())
        .unwrap_or_else(|| mime_for_path(&path));
    Some(json!({
        "kind": "artifact",
        "artifactKind": artifact_kind(mime),
        "path": path.to_string_lossy(),
        "name": path.file_name().and_then(|n| n.to_str()).unwrap_or("artifact"),
        "mimeType": mime,
        "caption": caption.filter(|s| !s.trim().is_empty()),
        "sizeBytes": metadata.len(),
    }))
}

fn extension_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "application/pdf" => "pdf",
        "text/plain" => "txt",
        "text/markdown" => "md",
        "text/html" => "html",
        "application/json" => "json",
        "text/csv" => "csv",
        "audio/mpeg" => "mp3",
        "audio/wav" => "wav",
        "video/mp4" => "mp4",
        _ => "bin",
    }
}

fn persist_inline_artifact(data: &str, mime: &str, dir: &Path) -> Option<Value> {
    if data.trim().is_empty() {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
    std::fs::create_dir_all(dir).ok()?;
    let millis = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_millis();
    let sequence = ARTIFACT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let path = dir.join(format!(
        "runtime-artifact-{millis}-{sequence}.{}",
        extension_for_mime(mime)
    ));
    std::fs::write(&path, bytes).ok()?;
    artifact_details(&path, Some(mime), None)
}

fn resolve_file_path(raw: &str, cwd: Option<&Path>) -> Option<PathBuf> {
    let raw = raw.trim().trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | '<' | '>' | '(' | ')' | '[' | ']' | ',' | ';'));
    if raw.is_empty() || raw.starts_with("data:") || raw.contains("\0") {
        return None;
    }
    let path = PathBuf::from(raw);
    let path = if path.is_absolute() { path } else { cwd?.join(path) };
    path.is_file().then_some(path)
}

fn paths_from_text(text: &str, cwd: Option<&Path>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for line in text.lines() {
        if let Some(json) = line.strip_prefix("CETUS_ARTIFACT:") {
            if let Ok(value) = serde_json::from_str::<Value>(json.trim()) {
                if let Some(path) = value.get("path").and_then(Value::as_str).and_then(|p| resolve_file_path(p, cwd)) {
                    paths.push(path);
                }
            }
        }
        // Common tool wording keeps the path as the remainder, which also
        // preserves spaces in filenames ("saved to /Users/me/My File.pdf").
        for marker in [" saved to ", " written to ", " created at ", " file: ", " path: "] {
            if let Some((_, tail)) = line.to_ascii_lowercase().split_once(marker) {
                let offset = line.len().saturating_sub(tail.len());
                if let Some(path) = resolve_file_path(&line[offset..], cwd) {
                    paths.push(path);
                }
            }
        }
    }
    paths
}

fn collect_artifacts(
    value: &Value,
    artifact_dir: Option<&Path>,
    cwd: Option<&Path>,
    out: &mut Vec<Value>,
) {
    match value {
        Value::String(text) => {
            if let Some(rest) = text.strip_prefix("data:") {
                if let Some((meta, data)) = rest.split_once(',') {
                    if meta.ends_with(";base64") {
                        if let Some(dir) = artifact_dir {
                            if let Some(artifact) = persist_inline_artifact(data, meta.trim_end_matches(";base64"), dir) {
                                out.push(artifact);
                            }
                        }
                    }
                }
            } else {
                out.extend(paths_from_text(text, cwd).into_iter().filter_map(|path| artifact_details(&path, None, None)));
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_artifacts(item, artifact_dir, cwd, out);
            }
        }
        Value::Object(object) => {
            if object.get("kind").and_then(Value::as_str) == Some("artifact") {
                out.push(value.clone());
                return;
            }
            let mime = object
                .get("mimeType")
                .or_else(|| object.get("mime_type"))
                .or_else(|| object.get("media_type"))
                .and_then(Value::as_str);
            let caption = object.get("caption").and_then(Value::as_str);
            for key in ["path", "file_path", "filePath", "output_path", "outputPath", "local_path", "localPath"] {
                if let Some(path) = object.get(key).and_then(Value::as_str).and_then(|p| resolve_file_path(p, cwd)) {
                    if let Some(artifact) = artifact_details(&path, mime, caption) {
                        out.push(artifact);
                    }
                }
            }
            let block_type = object.get("type").and_then(Value::as_str).unwrap_or("");
            if matches!(block_type, "image" | "input_image" | "inputImage" | "input_file" | "inputFile" | "file") {
                if let Some(url) = object.get("image_url").or_else(|| object.get("imageUrl")).or_else(|| object.get("url")) {
                    collect_artifacts(url, artifact_dir, cwd, out);
                }
                if let (Some(data), Some(dir)) = (object.get("data").and_then(Value::as_str), artifact_dir) {
                    if let Some(artifact) = persist_inline_artifact(data, mime.unwrap_or("application/octet-stream"), dir) {
                        out.push(artifact);
                    }
                }
                if let Some(source) = object.get("source") {
                    collect_artifacts(source, artifact_dir, cwd, out);
                }
            }
            for (key, child) in object {
                if !matches!(key.as_str(), "path" | "file_path" | "filePath" | "output_path" | "outputPath" | "local_path" | "localPath" | "data" | "image_url" | "imageUrl" | "url" | "source") {
                    collect_artifacts(child, artifact_dir, cwd, out);
                }
            }
        }
        _ => {}
    }
}

fn extracted_artifact_details(value: &Value, artifact_dir: Option<&Path>, cwd: Option<&Path>) -> Option<Value> {
    let mut artifacts = Vec::new();
    collect_artifacts(value, artifact_dir, cwd, &mut artifacts);
    let mut seen = HashSet::new();
    artifacts.retain(|artifact| {
        artifact.get("path").and_then(Value::as_str).map(|path| seen.insert(path.to_string())).unwrap_or(false)
    });
    match artifacts.len() {
        0 => None,
        1 => artifacts.pop(),
        _ => Some(json!({ "kind": "artifact_collection", "artifacts": artifacts })),
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
    /// Cumulative command output, used for running tool-card updates. The
    /// frontend replaces (rather than appends) partialResult on each update.
    codex_tool_output: std::collections::HashMap<String, String>,
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
            codex_tool_output: std::collections::HashMap::new(),
            claude_streamed_content: false,
            saw_result: false,
            result_error: None,
            started_items: std::collections::HashSet::new(),
            opened: false,
            background_tasks: std::collections::HashMap::new(),
            pending_steer: Vec::new(),
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
        out.extend(self.close_all_codex_blocks());
        if let Some(msg) = error {
            out.extend(self.emit_text(&format!("⚠️ agent error: {msg}")));
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
            out.push(am(json!({ "type": start, "contentIndex": our_index })));
        }
        let block = self.codex_live_blocks.get_mut(&key).expect("block inserted");
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
            let mut block = self.codex_live_blocks.remove(&key).expect("live block exists");
            if single {
                if let Some(final_text) = authoritative.filter(|text| !text.is_empty()) {
                    block.buffer = final_text.to_string();
                }
            }
            let (end, persisted) = match block.kind {
                LiveKind::Text => (
                    "text_end",
                    json!({ "type": "text", "text": block.buffer }),
                ),
                LiveKind::Thinking => (
                    "thinking_end",
                    json!({ "type": "thinking", "thinking": block.buffer }),
                ),
                LiveKind::ToolUse => continue,
            };
            self.assistant_blocks.push(persisted);
            out.push(am(json!({
                "type": end,
                "contentIndex": block.our_index,
                "content": block.buffer,
            })));
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
        self.emit_tool_result_end_with_details(id, content, Value::Null, is_error)
    }

    fn emit_tool_result_end_with_details(
        &mut self,
        id: &str,
        content: &Value,
        details: Value,
        is_error: bool,
    ) -> Vec<Value> {
        let artifact_details = extracted_artifact_details(
            content,
            self.artifact_dir.as_deref(),
            self.cwd.as_deref(),
        );
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

    /// The CLI's own authoritative list of live session-owned background
    /// tasks (`background_tasks_changed`, fires whenever the set changes).
    /// Translated straight into the frontend snapshot — after a resume this
    /// is the only source that knows what the fresh process still owns, our
    /// registry having started empty. `statusText` merges in from the
    /// registry where the task is one we tracked from `task_started`.
    fn on_claude_background_tasks_changed(&self, v: &Value) -> Vec<Value> {
        let Some(items) = v.get("tasks").and_then(|t| t.as_array()) else {
            return Vec::new();
        };
        let tasks: Vec<Value> = items
            .iter()
            .filter_map(|item| {
                let id = item.get("task_id").and_then(|t| t.as_str())?;
                let status_text = self
                    .background_tasks
                    .get(id)
                    .map(|t| t.status_text.clone())
                    .unwrap_or_default();
                Some(json!({
                    "taskId": id,
                    "kind": task_kind(item),
                    "description": item
                        .get("description")
                        .and_then(|t| t.as_str())
                        .unwrap_or("background task"),
                    "statusText": status_text,
                }))
            })
            .collect();
        vec![json!({ "type": "cli_background_tasks", "tasks": tasks })]
    }

    /// Live (not yet settled) background tasks — Monitors, async
    /// agents/workflows, background Bash — as the frontend's task strip
    /// renders them. Sorted by task id so equal registries compare equal.
    fn background_tasks_snapshot(&self) -> Value {
        let mut live: Vec<(&String, &BackgroundTask)> = self
            .background_tasks
            .iter()
            .filter(|(_, t)| !t.done)
            .collect();
        live.sort_by(|a, b| a.0.cmp(b.0));
        Value::Array(
            live.into_iter()
                .map(|(id, t)| {
                    json!({
                        "taskId": id,
                        "kind": t.subagent_type,
                        "description": t.description,
                        "statusText": t.status_text,
                    })
                })
                .collect(),
        )
    }

    /// Background-task lifecycle system events (claude). Progress is painted
    /// onto the launching Agent/Task tool card via tool_execution_update; the
    /// notification settles the card and releases the turn (has_pending_tasks).
    /// Any change to the set of live tasks additionally emits a conversation-
    /// level `cli_background_tasks` snapshot: these tasks outlive model turns
    /// (a Monitor can wake the CLI hours later), so the frontend needs standing
    /// state, not just paint on the launching card.
    fn on_claude_task_event(&mut self, subtype: &str, v: &Value) -> Vec<Value> {
        let before = self.background_tasks_snapshot();
        let mut events = self.on_claude_task_event_inner(subtype, v);
        let after = self.background_tasks_snapshot();
        if before != after {
            events.push(json!({ "type": "cli_background_tasks", "tasks": after }));
        }
        events
    }

    fn on_claude_task_event_inner(&mut self, subtype: &str, v: &Value) -> Vec<Value> {
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
                        subagent_type: task_kind(v),
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
                    "background_tasks_changed" => self.on_claude_background_tasks_changed(v),
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
            // partials. They are also our compatibility fallback when a CLI
            // version accepts --include-partial-messages but emits no partial
            // content, plus the only output for synthetic slash commands.
            "assistant" => {
                // Sidechain snapshots (a subagent's own turns) feed the
                // launching card's step list instead of the main transcript.
                if is_sidechain(v) {
                    return self.on_claude_sidechain(v);
                }
                let msg = v.get("message");
                let model = msg.and_then(|m| m.get("model")).and_then(|m| m.as_str());
                if model != Some("<synthetic>") && self.claude_streamed_content {
                    return Vec::new();
                }
                let mut out = Vec::new();
                let blocks = msg
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array());
                if let Some(blocks) = blocks {
                    for b in blocks {
                        match b.get("type").and_then(Value::as_str).unwrap_or("") {
                            "text" => {
                                let text = b.get("text").and_then(Value::as_str).unwrap_or("");
                                if !text.is_empty() {
                                    out.extend(self.emit_text(text));
                                }
                            }
                            "thinking" => {
                                let thinking = b.get("thinking").and_then(Value::as_str).unwrap_or("");
                                if !thinking.is_empty() {
                                    out.extend(self.emit_thinking(thinking));
                                }
                            }
                            "tool_use" => {
                                let id = b.get("id").and_then(Value::as_str).unwrap_or("tool");
                                let name = b.get("name").and_then(Value::as_str).unwrap_or("tool");
                                let input = b.get("input").cloned().unwrap_or(Value::Null);
                                out.extend(self.emit_tool_call(id, name, &input));
                            }
                            _ => {}
                        }
                    }
                }
                if !out.is_empty() {
                    self.claude_streamed_content = true;
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
            // Ack of our initialize handshake. It carries the CLI's slash
            // command catalog (built-ins like /usage /compact /context plus
            // every skill) — surface it so the composer's slash menu can offer
            // the runtime's real commands instead of a hardcoded snapshot.
            // Entries suffixed "(user)" / "(project)" are skills, which the
            // menu already lists from its own skill sources — the frontend
            // filters; we forward the catalog verbatim.
            "control_response" => {
                let Some(commands) = v
                    .pointer("/response/response/commands")
                    .and_then(|c| c.as_array())
                else {
                    return Vec::new();
                };
                let commands: Vec<Value> = commands
                    .iter()
                    .filter_map(|c| {
                        let name = c.get("name").and_then(|n| n.as_str())?;
                        Some(json!({
                            "name": name,
                            "description": c
                                .get("description")
                                .and_then(|d| d.as_str())
                                .unwrap_or(""),
                            "argumentHint": c
                                .get("argumentHint")
                                .and_then(|d| d.as_str())
                                .unwrap_or(""),
                        }))
                    })
                    .collect();
                vec![json!({ "type": "cli_commands", "commands": commands })]
            }
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
                // A main-chain tool result separates Claude API messages. If
                // the next response again lacks stream_event partials, allow
                // its cumulative assistant snapshot to act as fallback.
                self.claude_streamed_content = false;
                out
            }
            // Account-level quota heartbeat: claude reports the unified
            // rate-limit status after each API call (status allowed /
            // allowed_warning / rejected, utilization near the warning
            // threshold, reset epoch). Forwarded verbatim for the runtime
            // picker's quota line — it is not turn content and opens nothing.
            "rate_limit_event" => {
                let Some(info) = v.get("rate_limit_info") else {
                    return Vec::new();
                };
                vec![json!({ "type": "cli_rate_limit", "info": info })]
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
                self.claude_streamed_content = false;
                if self.pending_steer.is_empty() {
                    return Vec::new();
                }
                // A steered user message merges into the turn on this API
                // request. Split the turn here: settle the open assistant
                // bubble, splice the user row(s) in at their real position,
                // and let the next content event open a fresh bubble (indices
                // restart with it) — so live view and reloaded transcript both
                // show the steer where it landed, not after the whole turn.
                self.flush_assistant();
                self.messages.append(&mut self.pending_steer);
                let mut out = Vec::new();
                if self.opened {
                    out.push(json!({ "type": "message_end" }));
                    self.opened = false;
                }
                self.next_index = 0;
                out
            }
            "content_block_start" => {
                let idx = event.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
                let Some(cb) = event.get("content_block") else {
                    return Vec::new();
                };
                let kind = cb.get("type").and_then(|t| t.as_str()).unwrap_or("");
                match kind {
                    "text" => {
                        let our_index = self.alloc_index();
                        let initial = cb.get("text").and_then(Value::as_str).unwrap_or("");
                        if !initial.is_empty() {
                            self.claude_streamed_content = true;
                        }
                        self.live_blocks.insert(idx, LiveBlock {
                            our_index,
                            kind: LiveKind::Text,
                            buffer: initial.to_string(),
                            tool: None,
                            closed: false,
                            started: true,
                        });
                        let mut out = vec![am(json!({ "type": "text_start", "contentIndex": our_index }))];
                        if !initial.is_empty() {
                            out.push(am(json!({
                                "type": "text_delta",
                                "contentIndex": our_index,
                                "delta": initial,
                            })));
                        }
                        out
                    }
                    "thinking" => {
                        let initial = cb.get("thinking").and_then(Value::as_str).unwrap_or("");
                        if !initial.is_empty() {
                            self.claude_streamed_content = true;
                        }
                        // thinking_start (and the index) waits for the first
                        // thinking_delta — see LiveBlock::started.
                        let started = !initial.is_empty();
                        let our_index = if started { self.alloc_index() } else { 0 };
                        self.live_blocks.insert(idx, LiveBlock {
                            our_index,
                            kind: LiveKind::Thinking,
                            buffer: initial.to_string(),
                            tool: None,
                            closed: false,
                            started,
                        });
                        if started {
                            vec![
                                am(json!({ "type": "thinking_start", "contentIndex": our_index })),
                                am(json!({ "type": "thinking_delta", "contentIndex": our_index, "delta": initial })),
                            ]
                        } else {
                            Vec::new()
                        }
                    }
                    "tool_use" => {
                        self.claude_streamed_content = true;
                        let id = cb.get("id").and_then(|t| t.as_str()).unwrap_or("");
                        let name = cb.get("name").and_then(|t| t.as_str()).unwrap_or("tool");
                        self.tool_names.insert(id.to_string(), name.to_string());
                        let our_index = self.alloc_index();
                        self.live_blocks.insert(idx, LiveBlock {
                            our_index,
                            kind: LiveKind::ToolUse,
                            buffer: String::new(),
                            tool: Some((id.to_string(), name.to_string())),
                            closed: false,
                            started: true,
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
                        self.claude_streamed_content = true;
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
                        self.claude_streamed_content = true;
                        block.buffer.push_str(t);
                        let mut out = Vec::new();
                        if !block.started {
                            block.started = true;
                            block.our_index = self.next_index;
                            self.next_index += 1;
                            out.push(am(json!({
                                "type": "thinking_start",
                                "contentIndex": block.our_index,
                            })));
                        }
                        out.push(am(json!({
                            "type": "thinking_delta",
                            "contentIndex": block.our_index,
                            "delta": t,
                        })));
                        out
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
                        // Never started: signature-only block (thinking
                        // display omitted) — nothing was opened, nothing to
                        // close or persist.
                        if !block.started {
                            return Vec::new();
                        }
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
            "item.agent_message.delta" => {
                let id = v.get("item_id").and_then(Value::as_str).unwrap_or("message");
                let delta = v.get("delta").and_then(Value::as_str).unwrap_or("");
                self.emit_codex_delta(
                    format!("message:{id}"),
                    id,
                    LiveKind::Text,
                    delta,
                )
            }
            "item.reasoning.summary_delta" => {
                let id = v.get("item_id").and_then(Value::as_str).unwrap_or("reasoning");
                let part = v.get("summary_index").and_then(Value::as_i64).unwrap_or(0);
                let delta = v.get("delta").and_then(Value::as_str).unwrap_or("");
                self.emit_codex_delta(
                    format!("reasoning-summary:{id}:{part}"),
                    id,
                    LiveKind::Thinking,
                    delta,
                )
            }
            "item.reasoning.text_delta" => {
                let id = v.get("item_id").and_then(Value::as_str).unwrap_or("reasoning");
                let part = v.get("content_index").and_then(Value::as_i64).unwrap_or(0);
                let delta = v.get("delta").and_then(Value::as_str).unwrap_or("");
                self.emit_codex_delta(
                    format!("reasoning-text:{id}:{part}"),
                    id,
                    LiveKind::Thinking,
                    delta,
                )
            }
            "item.plan.delta" => {
                let id = v.get("item_id").and_then(Value::as_str).unwrap_or("plan");
                let delta = v.get("delta").and_then(Value::as_str).unwrap_or("");
                self.emit_codex_delta(
                    format!("plan:{id}"),
                    id,
                    LiveKind::Thinking,
                    delta,
                )
            }
            "item.tool_output.delta" => {
                let id = v.get("item_id").and_then(Value::as_str).unwrap_or("item");
                let delta = v.get("delta").and_then(Value::as_str).unwrap_or("");
                if delta.is_empty() || !self.started_items.contains(id) {
                    return Vec::new();
                }
                let output = self.codex_tool_output.entry(id.to_string()).or_default();
                output.push_str(delta);
                vec![json!({
                    "type": "tool_execution_update",
                    "toolCallId": id,
                    "partialResult": {
                        "content": normalize_content(&json!(output)),
                        "details": Value::Null,
                    },
                })]
            }
            // A command starts executing: show its tool card immediately (with
            // a running spinner via tool_execution_start) instead of waiting
            // for completion — matches how the codex TUI surfaces commands.
            "item.started" => {
                let item = match v.get("item") {
                    Some(i) => i,
                    None => return Vec::new(),
                };
                let item_ty = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if item_ty == "collab_agent_tool_call" {
                    if item.get("tool").and_then(|t| t.as_str()) != Some("spawnAgent") {
                        return Vec::new();
                    }
                    let id = item.get("id").and_then(|t| t.as_str()).unwrap_or("item");
                    let Some(thread_id) = item
                        .get("receiver_thread_ids")
                        .and_then(Value::as_array)
                        .and_then(|ids| ids.first())
                        .and_then(Value::as_str)
                    else {
                        return Vec::new();
                    };
                    let description = item
                        .get("prompt")
                        .and_then(Value::as_str)
                        .unwrap_or("background task")
                        .to_string();
                    let subagent_type = item
                        .get("model")
                        .and_then(Value::as_str)
                        .unwrap_or("Codex")
                        .to_string();
                    let task = BackgroundTask {
                        tool_use_id: id.to_string(),
                        subagent_type,
                        description: description.clone(),
                        done: false,
                        steps: Vec::new(),
                        status_text: String::new(),
                    };
                    self.background_tasks.insert(thread_id.to_string(), task.clone());
                    let mut out = self.emit_tool_call(
                        id,
                        "Agent",
                        &json!({ "prompt": description, "threadId": thread_id }),
                    );
                    out.push(json!({ "type": "tool_execution_start", "toolCallId": id }));
                    out.push(json!({
                        "type": "tool_execution_update",
                        "toolCallId": id,
                        "partialResult": {
                            "content": [{ "type": "text", "text": "Agent running in background" }],
                            "details": task.details("running"),
                        },
                    }));
                    return out;
                }
                if matches!(item_ty, "dynamic_tool_call" | "image_generation" | "mcp_tool_call") {
                    let id = item.get("id").and_then(Value::as_str).unwrap_or("item");
                    let name = if item_ty == "image_generation" {
                        "image_generation"
                    } else {
                        item.get("tool").and_then(Value::as_str).unwrap_or("tool")
                    };
                    let args = item.get("arguments").cloned().unwrap_or(Value::Null);
                    self.started_items.insert(id.to_string());
                    let mut out = self.emit_tool_call(id, name, &args);
                    out.push(json!({ "type": "tool_execution_start", "toolCallId": id }));
                    return out;
                }
                if item_ty == "file_change" {
                    let id = item.get("id").and_then(Value::as_str).unwrap_or("item");
                    let changes = item.get("changes").cloned().unwrap_or(Value::Null);
                    self.started_items.insert(id.to_string());
                    let mut out = self.emit_tool_call(id, "apply_patch", &changes);
                    out.push(json!({ "type": "tool_execution_start", "toolCallId": id }));
                    return out;
                }
                if matches!(item_ty, "web_search" | "image_view" | "sleep") {
                    let id = item.get("id").and_then(Value::as_str).unwrap_or("item");
                    let (name, args) = match item_ty {
                        "web_search" => (
                            "web_search",
                            json!({ "query": item.get("query").cloned().unwrap_or(Value::Null) }),
                        ),
                        "image_view" => (
                            "view_image",
                            json!({ "path": item.get("path").cloned().unwrap_or(Value::Null) }),
                        ),
                        _ => (
                            "wait",
                            json!({ "durationMs": item.get("durationMs").or_else(|| item.get("duration_ms")).cloned().unwrap_or(Value::Null) }),
                        ),
                    };
                    self.started_items.insert(id.to_string());
                    let mut out = self.emit_tool_call(id, name, &args);
                    out.push(json!({ "type": "tool_execution_start", "toolCallId": id }));
                    return out;
                }
                if item_ty != "command_execution" {
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
                        let streamed = self.close_codex_item(id, Some(t));
                        if !streamed.is_empty() {
                            streamed
                        } else if !t.is_empty() {
                            self.emit_text(t)
                        } else {
                            Vec::new()
                        }
                    }
                    "reasoning" => {
                        let completed = item
                            .get("summary")
                            .and_then(Value::as_array)
                            .filter(|parts| !parts.is_empty())
                            .or_else(|| item.get("content").and_then(Value::as_array))
                            .map(|parts| {
                                parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("\n")
                            })
                            .or_else(|| item.get("text").and_then(Value::as_str).map(str::to_string))
                            .unwrap_or_default();
                        let streamed = self.close_codex_item(id, Some(&completed));
                        if !streamed.is_empty() {
                            streamed
                        } else if !completed.is_empty() {
                            self.emit_thinking(&completed)
                        } else {
                            Vec::new()
                        }
                    }
                    "plan" => {
                        let completed = item.get("text").and_then(Value::as_str).unwrap_or("");
                        let streamed = self.close_codex_item(id, Some(completed));
                        if !streamed.is_empty() {
                            streamed
                        } else if !completed.is_empty() {
                            self.emit_thinking(completed)
                        } else {
                            Vec::new()
                        }
                    }
                    "command_execution" => {
                        self.codex_tool_output.remove(id);
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
                        if self.started_items.remove(id) {
                            self.emit_tool_result_end(id, &json!("applied"), false)
                        } else {
                            let mut out = self.emit_tool_call(id, "apply_patch", &changes);
                            out.extend(self.emit_tool_result(id, &json!("applied"), false));
                            out
                        }
                    }
                    "mcp_tool_call" => {
                        let name = item
                            .get("tool")
                            .and_then(|t| t.as_str())
                            .unwrap_or("mcp_tool");
                        let args = item.get("arguments").cloned().unwrap_or(Value::Null);
                        let result = item.get("result").cloned().unwrap_or(Value::Null);
                        if self.started_items.remove(id) {
                            self.emit_tool_result_end(id, &result, false)
                        } else {
                            let mut out = self.emit_tool_call(id, name, &args);
                            out.extend(self.emit_tool_result(id, &result, false));
                            out
                        }
                    }
                    "dynamic_tool_call" => {
                        let name = item
                            .get("tool")
                            .and_then(Value::as_str)
                            .unwrap_or("tool");
                        let args = item.get("arguments").cloned().unwrap_or(Value::Null);
                        let result = item
                            .get("content_items")
                            .or_else(|| item.get("result"))
                            .cloned()
                            .unwrap_or(Value::Null);
                        let is_err = item.get("success").and_then(Value::as_bool) == Some(false);
                        if self.started_items.remove(id) {
                            return self.emit_tool_result_end(id, &result, is_err);
                        }
                        let mut out = self.emit_tool_call(id, name, &args);
                        out.extend(self.emit_tool_result(id, &result, is_err));
                        out
                    }
                    "image_generation" => {
                        let result = if let Some(path) = item.get("saved_path").and_then(Value::as_str) {
                            json!({ "type": "file", "path": path, "mimeType": "image/png" })
                        } else {
                            json!({
                                "type": "image",
                                "data": item.get("result").and_then(Value::as_str).unwrap_or(""),
                                "mimeType": "image/png"
                            })
                        };
                        if self.started_items.remove(id) {
                            return self.emit_tool_result_end(id, &result, false);
                        }
                        let mut out = self.emit_tool_call(id, "image_generation", &Value::Null);
                        out.extend(self.emit_tool_result(id, &result, false));
                        out
                    }
                    "web_search" | "image_view" | "sleep" => {
                        let result = match item_ty {
                            "web_search" => json!(item
                                .get("query")
                                .and_then(Value::as_str)
                                .map(|query| format!("Search completed: {query}"))
                                .unwrap_or_else(|| "Search completed".to_string())),
                            "image_view" => json!(item
                                .get("path")
                                .and_then(Value::as_str)
                                .map(|path| format!("Viewed {path}"))
                                .unwrap_or_else(|| "Image viewed".to_string())),
                            _ => json!("Wait completed"),
                        };
                        if self.started_items.remove(id) {
                            self.emit_tool_result_end(id, &result, false)
                        } else {
                            let name = match item_ty {
                                "web_search" => "web_search",
                                "image_view" => "view_image",
                                _ => "wait",
                            };
                            let mut out = self.emit_tool_call(id, name, &Value::Null);
                            out.extend(self.emit_tool_result(id, &result, false));
                            out
                        }
                    }
                    "collab_agent_tool_call" => {
                        let Some(states) = item.get("agents_states").and_then(Value::as_object)
                        else {
                            return Vec::new();
                        };
                        let mut out = Vec::new();
                        for (thread_id, state) in states {
                            let Some(task) = self.background_tasks.get_mut(thread_id) else {
                                continue;
                            };
                            if task.done {
                                continue;
                            }
                            let status = state
                                .get("status")
                                .and_then(Value::as_str)
                                .unwrap_or("running");
                            let terminal = matches!(
                                status,
                                "completed" | "interrupted" | "errored" | "shutdown" | "notFound"
                            );
                            task.done = terminal;
                            let task = task.clone();
                            let text = state
                                .get("message")
                                .and_then(Value::as_str)
                                .filter(|s| !s.trim().is_empty())
                                .map(str::to_string)
                                .unwrap_or_else(|| format!("{} agent {status}", task.subagent_type));
                            if terminal {
                                out.extend(self.emit_tool_result_end_with_details(
                                    &task.tool_use_id,
                                    &json!(text),
                                    task.details(status),
                                    status != "completed",
                                ));
                            } else {
                                out.push(json!({
                                    "type": "tool_execution_update",
                                    "toolCallId": task.tool_use_id,
                                    "partialResult": {
                                        "content": [{ "type": "text", "text": text }],
                                        "details": task.details("running"),
                                    },
                                }));
                            }
                        }
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
    /// A mid-turn user message: `line` goes to stdin like Input, and
    /// `message` (the PiMessage-shaped user row) is queued on the translator
    /// to splice into the transcript at its merge point.
    Steer { line: String, message: Value },
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
        if let Some(dir) = artifact_dir {
            tr = tr.with_artifact_storage(dir, translator_cwd);
        }
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
                        // A continuation turn may still be mid-flight (e.g.
                        // blocked on an AskUserQuestion) — begin_next_turn
                        // would wipe whatever it accumulated. Settle the
                        // completed blocks and ship them for persistence.
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
                            // A self-started continuation turn settled: its
                            // text-only reply is still sitting in the open
                            // assistant segment (only tool results flush it
                            // mid-turn) — settle and persist it now, nothing
                            // else will.
                            if let Some(orphan) = &orphan_messages {
                                tr.flush_assistant();
                                let msgs = tr.take_messages();
                                if !msgs.is_empty() {
                                    let _ = orphan.send(msgs);
                                }
                            }
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
        } else if let Some(orphan) = &orphan_messages {
            // No active turn to carry them: settle and ship whatever a
            // continuation turn accumulated before the process died.
            tr.flush_assistant();
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
                    if let Some(dir) = artifact_dir.clone() {
                        tr = tr.with_artifact_storage(dir, translator_cwd.clone());
                    }
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
        if let Some(dir) = artifact_dir {
            tr = tr.with_artifact_storage(dir, translator_cwd);
        }
        tr.resume_id = Some(thread_id.clone());
        let mut active: Option<ActiveClaudeTurn> = None;
        let mut active_turn_id: Option<String> = None;
        let mut pending_plugin_installs: HashMap<
            u64,
            (
                Value,
                Value,
                tokio::sync::oneshot::Sender<std::result::Result<(), String>>,
            ),
        > = HashMap::new();

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
                    Some(CodexSessionCommand::RespondToServerRequest { request_id, response }) => {
                        // Server requests are ordinary JSON-RPC in the reverse
                        // direction: echo the original id and place the user's
                        // answer under `result`.
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
                line = reader.next_line() => {
                    let line = match line { Ok(Some(line)) => line, _ => break };
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
                        "item/started" | "item/completed" => {
                            let ty = if method.ends_with("started") { "item.started" } else { "item.completed" };
                            let item = normalize_codex_app_item(params.get("item").cloned().unwrap_or(Value::Null));
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
                        "serverRequest/resolved" => {
                            if let Some(request_id) = params
                                .get("requestId")
                                .or_else(|| params.get("request_id"))
                                .cloned()
                            {
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
    fn claude_steer_splits_turn_at_merge_point() {
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        // Pre-steer content: one streamed text block.
        tr.on_line(r#"{"type":"stream_event","event":{"type":"message_start","message":{"role":"assistant","content":[]}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"before"}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);

        // The user steers mid-turn; claude merges it on its NEXT API request.
        let steer = json!({ "role": "user", "content": [{ "type": "text", "text": "授权了" }] });
        tr.queue_steer(steer.clone());

        // That next message_start closes the open bubble and splices the row.
        let ev = tr.on_line(r#"{"type":"stream_event","event":{"type":"message_start","message":{"role":"assistant","content":[]}}}"#);
        assert_eq!(types(&ev), vec!["message_end"]);
        assert_eq!(tr.messages.len(), 2);
        assert_eq!(tr.messages[0]["role"], json!("assistant"));
        assert_eq!(tr.messages[0]["content"][0]["text"], json!("before"));
        assert_eq!(tr.messages[1], steer);

        // Post-steer content opens a fresh bubble with indices from 0.
        let mut ev = Vec::new();
        ev.extend(tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#));
        ev.extend(tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"after"}}}"#));
        ev.extend(tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#));
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
            ev[1]["assistantMessageEvent"]["contentIndex"],
            json!(0)
        );

        tr.on_line(r#"{"type":"result","subtype":"success","is_error":false,"result":"after"}"#);
        tr.finish(None);
        // Transcript order: pre-steer segment, user row, post-steer segment.
        let msgs = tr.take_messages();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[1]["role"], json!("user"));
        assert_eq!(msgs[2]["role"], json!("assistant"));
        assert_eq!(msgs[2]["content"][0]["text"], json!("after"));
    }

    #[test]
    fn claude_steer_never_consumed_still_persists_on_finish() {
        // A steer written just as the turn's result raced it is read by claude
        // as a self-started continuation turn — the row must still land in the
        // transcript, after the turn's own content.
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"message_start","message":{"role":"assistant","content":[]}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"answer"}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);
        let steer = json!({ "role": "user", "content": [{ "type": "text", "text": "late" }] });
        tr.queue_steer(steer.clone());
        tr.on_line(r#"{"type":"result","subtype":"success","is_error":false,"result":"answer"}"#);
        tr.finish(None);
        let msgs = tr.take_messages();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], json!("assistant"));
        assert_eq!(msgs[1], steer);
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

        // A real-model snapshot is a fallback when this CLI emitted no
        // stream_event content at all.
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        let fallback = tr.on_line(r#"{"type":"assistant","message":{"model":"claude-fable-5","content":[{"type":"text","text":"fallback"}]}}"#);
        assert_eq!(fallback[2]["assistantMessageEvent"]["delta"], json!("fallback"));

        // Once partial content was observed, its cumulative snapshot remains
        // redundant and must not duplicate the visible response.
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"dup"}}}"#);
        assert!(tr
            .on_line(r#"{"type":"assistant","message":{"model":"claude-fable-5","content":[{"type":"text","text":"dup"}]}}"#)
            .is_empty());
    }

    #[test]
    fn claude_content_indices_are_monotonic() {
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hm"}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);
        // the API reuses low indices across messages; ours must stay monotonic
        let ev = tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}}"#);
        assert_eq!(ev[0]["assistantMessageEvent"]["contentIndex"], json!(1));
    }

    /// Adaptive-thinking sessions with display omitted stream signature-only
    /// thinking blocks (start + signature_delta + stop, no thinking_delta).
    /// Those must not open a block, emit events, or persist an empty
    /// `thinking` entry — the UI would show a dead "Thinking, 0 chars" step.
    #[test]
    fn claude_signature_only_thinking_is_suppressed() {
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        assert!(tr
            .on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}}"#)
            .is_empty());
        assert!(tr
            .on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}}"#)
            .is_empty());
        assert!(tr
            .on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#)
            .is_empty());
        // the next block still takes index 0 — the ghost consumed nothing
        let ev = tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}}"#);
        assert_eq!(ev.last().unwrap()["assistantMessageEvent"]["contentIndex"], json!(0));
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hi"}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":1}}"#);
        tr.finish(None);
        let msgs = tr.take_messages();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["content"], json!([{ "type": "text", "text": "hi" }]));
    }

    /// With a thinking display active the deltas carry text: thinking_start is
    /// deferred to the first delta, then streams and persists normally.
    #[test]
    fn claude_thinking_with_text_streams_and_persists() {
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        assert!(tr
            .on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}}"#)
            .is_empty());
        let ev = tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"let me see"}}}"#);
        let kinds: Vec<&str> = ev
            .iter()
            .filter_map(|e| e["assistantMessageEvent"]["type"].as_str())
            .collect();
        assert_eq!(kinds, vec!["thinking_start", "thinking_delta"]);
        let ev = tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);
        assert_eq!(ev[0]["assistantMessageEvent"]["type"], json!("thinking_end"));
        assert_eq!(ev[0]["assistantMessageEvent"]["content"], json!("let me see"));
        tr.finish(None);
        let msgs = tr.take_messages();
        assert_eq!(
            msgs[0]["content"],
            json!([{ "type": "thinking", "thinking": "let me see" }])
        );
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

    /// The quota heartbeat surfaces as a `cli_rate_limit` event carrying the
    /// CLI's rate_limit_info verbatim — and, as housekeeping, must neither
    /// open the assistant bubble nor count as turn activity.
    #[test]
    fn claude_rate_limit_event_forwards_info() {
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        // Captured from claude 2.1.208.
        let line = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1784008800,"rateLimitType":"five_hour","utilization":0.85,"overageStatus":"rejected","isUsingOverage":false}}"#;
        let ev = tr.on_line(line);
        assert_eq!(types(&ev), vec!["cli_rate_limit"]);
        assert_eq!(ev[0]["info"]["status"], json!("allowed_warning"));
        assert_eq!(ev[0]["info"]["utilization"], json!(0.85));
        assert_eq!(ev[0]["info"]["resetsAt"], json!(1784008800i64));
        assert!(!tr.opened, "quota heartbeat must not open the bubble");
        assert!(!is_turn_activity(line));
    }

    /// The initialize ack's `commands` catalog (built-ins + skills, captured
    /// from claude 2.x) surfaces as a `cli_commands` event for the slash menu.
    #[test]
    fn initialize_ack_commands_surface_for_slash_menu() {
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        let ev = tr.on_line(
            r#"{"type":"control_response","response":{"subtype":"success","request_id":"init-1","response":{"commands":[{"name":"usage","description":"Show plan usage","argumentHint":"","aliases":["cost"]},{"name":"compact","description":"Free up context","argumentHint":"<instructions>"}]}}}"#,
        );
        assert_eq!(types(&ev), vec!["cli_commands"]);
        assert_eq!(ev[0]["commands"][0]["name"], json!("usage"));
        assert_eq!(ev[0]["commands"][1]["argumentHint"], json!("<instructions>"));
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
    fn codex_app_server_deltas_stream_and_complete_without_duplicates() {
        let mut tr = EventTranslator::new(CliBackend::Codex);
        let mut ev = Vec::new();
        ev.extend(tr.on_line(
            r#"{"type":"item.reasoning.summary_delta","item_id":"r1","summary_index":0,"delta":"Checking "}"#,
        ));
        ev.extend(tr.on_line(
            r#"{"type":"item.reasoning.summary_delta","item_id":"r1","summary_index":0,"delta":"the repo"}"#,
        ));
        assert_eq!(
            types(&ev),
            vec![
                "message_start",
                "message_update:thinking_start",
                "message_update:thinking_delta",
                "message_update:thinking_delta",
            ]
        );
        let end = tr.on_line(
            r#"{"type":"item.completed","item":{"id":"r1","type":"reasoning","summary":["Checking the repo"],"content":[]}}"#,
        );
        assert_eq!(types(&end), vec!["message_update:thinking_end"]);
        assert_eq!(end[0]["assistantMessageEvent"]["content"], json!("Checking the repo"));

        let first = tr.on_line(
            r#"{"type":"item.agent_message.delta","item_id":"m1","delta":"partial"}"#,
        );
        assert_eq!(
            types(&first),
            vec!["message_update:text_start", "message_update:text_delta"]
        );
        // Completed text is authoritative and replaces a divergent partial.
        let end = tr.on_line(
            r#"{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"final answer"}}"#,
        );
        assert_eq!(types(&end), vec!["message_update:text_end"]);
        assert_eq!(end[0]["assistantMessageEvent"]["content"], json!("final answer"));

        tr.finish(None);
        let messages = tr.take_messages();
        let content = messages[0]["content"].as_array().unwrap();
        assert_eq!(content.iter().filter(|b| b["type"] == "text").count(), 1);
    }

    #[test]
    fn codex_command_output_delta_updates_running_card_cumulatively() {
        let mut tr = EventTranslator::new(CliBackend::Codex);
        tr.on_line(
            r#"{"type":"item.started","item":{"id":"cmd1","type":"command_execution","command":"build"}}"#,
        );
        let first = tr.on_line(
            r#"{"type":"item.tool_output.delta","item_id":"cmd1","delta":"line 1\n"}"#,
        );
        let second = tr.on_line(
            r#"{"type":"item.tool_output.delta","item_id":"cmd1","delta":"line 2"}"#,
        );
        assert_eq!(types(&first), vec!["tool_execution_update"]);
        assert_eq!(
            second[0]["partialResult"]["content"][0]["text"],
            json!("line 1\nline 2")
        );
    }

    #[test]
    fn codex_finish_preserves_an_interrupted_partial_message() {
        let mut tr = EventTranslator::new(CliBackend::Codex);
        tr.on_line(
            r#"{"type":"item.agent_message.delta","item_id":"m1","delta":"still working"}"#,
        );
        let end = tr.finish(None);
        assert_eq!(types(&end)[0], "message_update:text_end");
        assert_eq!(
            end[0]["assistantMessageEvent"]["content"],
            json!("still working")
        );
        let messages = tr.take_messages();
        assert_eq!(messages[0]["content"][0]["text"], json!("still working"));
    }

    #[test]
    fn codex_background_agent_stays_live_until_agent_state_settles() {
        let mut tr = EventTranslator::new(CliBackend::Codex);
        let started = normalize_codex_app_item(json!({
            "id": "spawn-1", "type": "collabAgentToolCall", "tool": "spawnAgent",
            "prompt": "inspect the parser", "model": "gpt-5", "status": "inProgress",
            "senderThreadId": "root", "receiverThreadIds": ["child-1"], "agentsStates": {},
        }));
        let ev = tr.on_line(&json!({ "type": "item.started", "item": started }).to_string());
        assert_eq!(
            types(&ev),
            vec![
                "message_start",
                "message_update:toolcall_start",
                "message_update:toolcall_end",
                "tool_execution_start",
                "tool_execution_update"
            ]
        );
        assert_eq!(
            ev[4]["partialResult"]["details"]["subagent"]["status"],
            json!("running")
        );

        // Completing the spawn call itself does not settle the card while the
        // child thread is still running.
        let running = normalize_codex_app_item(json!({
            "id": "spawn-1", "type": "collabAgentToolCall", "tool": "spawnAgent",
            "prompt": "inspect the parser", "status": "completed", "senderThreadId": "root",
            "receiverThreadIds": ["child-1"],
            "agentsStates": { "child-1": { "status": "running", "message": "reading files" } },
        }));
        let ev = tr.on_line(&json!({ "type": "item.completed", "item": running }).to_string());
        assert_eq!(types(&ev), vec!["tool_execution_update"]);

        // A later wait/collab item carries the terminal state for that same
        // child thread and settles the original spawn card.
        let completed = normalize_codex_app_item(json!({
            "id": "wait-1", "type": "collabAgentToolCall", "tool": "wait",
            "status": "completed", "senderThreadId": "root", "receiverThreadIds": ["child-1"],
            "agentsStates": { "child-1": { "status": "completed", "message": "parser is sound" } },
        }));
        let ev = tr.on_line(&json!({ "type": "item.completed", "item": completed }).to_string());
        assert_eq!(types(&ev), vec!["tool_execution_end"]);
        assert_eq!(ev[0]["result"]["content"][0]["text"], json!("parser is sound"));
        assert_eq!(
            ev[0]["result"]["details"]["subagent"]["status"],
            json!("completed")
        );
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
            None,
            Vec::new(),
            CliRunOpts::default(),
            None,
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

    /// A self-started continuation turn (Monitor/subagent wake-up) streams
    /// with no active turn registered — its messages must reach the orphan
    /// persistence channel instead of being wiped by the next StartTurn's
    /// begin_next_turn (observed data loss: the wake-up's tool calls and
    /// AskUserQuestion never hit the Cetus transcript).
    #[tokio::test]
    async fn continuation_turn_messages_reach_orphan_channel() {
        let dir = std::env::temp_dir().join(format!(
            "cetus-claude-orphan-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-continuation-claude.sh");
        // On boot: init, then a spontaneous continuation turn (text + result)
        // BEFORE any user turn. Then answer user turns normally.
        std::fs::write(
            &script,
            "#!/bin/sh\n\
             echo '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"cont-1\"}'\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}}'\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"monitor woke me\"}}}'\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":0}}'\n\
             echo '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"monitor woke me\"}'\n\
             while IFS= read -r line; do\n\
               case \"$line\" in *'\"type\":\"user\"'*)\n\
                 echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}}'\n\
                 echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"real turn\"}}}'\n\
                 echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":0}}'\n\
                 echo '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"real turn\"}'\n\
               ;; esac\n\
             done\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
        let (orphan_tx, mut orphan_rx) = tokio::sync::mpsc::unbounded_channel();
        let session = spawn_claude_session(
            sink.clone() as Arc<dyn EventSink>,
            &script.to_string_lossy(),
            &dir,
            None,
            None,
            Vec::new(),
            CliRunOpts::default(),
            Some(orphan_tx),
        )
        .unwrap();

        // The continuation turn's reply lands on the orphan channel.
        let orphaned = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            orphan_rx.recv(),
        )
        .await
        .expect("continuation message not shipped")
        .unwrap();
        assert_eq!(orphaned[0]["content"][0]["text"], json!("monitor woke me"));

        // A normal turn afterwards is unaffected and does NOT re-carry it.
        let outcome = session
            .start_turn(
                claude_user_message_line("hi", &[]),
                sink.clone() as Arc<dyn EventSink>,
            )
            .unwrap()
            .await
            .unwrap();
        assert_eq!(outcome.messages.len(), 1);
        assert_eq!(outcome.messages[0]["content"][0]["text"], json!("real turn"));

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
                   echo \"{\\\"method\\\":\\\"item/agentMessage/delta\\\",\\\"params\\\":{\\\"threadId\\\":\\\"thread-persistent\\\",\\\"turnId\\\":\\\"turn-$n\\\",\\\"itemId\\\":\\\"answer-$n\\\",\\\"delta\\\":\\\"turn-$n\\\"}}\";\n\
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
        assert!(sink.0.lock().unwrap().iter().any(|event| {
            event["assistantMessageEvent"]["type"] == json!("text_delta")
                && event["assistantMessageEvent"]["delta"] == json!("turn-1")
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

    #[tokio::test]
    async fn codex_app_server_surfaces_and_answers_reverse_rpc_requests() {
        let dir = std::env::temp_dir().join(format!(
            "cetus-codex-server-request-test-{}-{}",
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
             while IFS= read -r line; do\n\
               case \"$line\" in\n\
                 *'\"method\":\"initialize\"'*) echo '{\"id\":1,\"result\":{}}' ;;\n\
                 *'\"method\":\"thread/start\"'*) echo '{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread-rpc\"}}}' ;;\n\
                 *'\"method\":\"turn/start\"'*)\n\
                   echo '{\"id\":10,\"result\":{\"turn\":{\"id\":\"turn-rpc\"}}}';\n\
                   echo '{\"method\":\"mcpServer/elicitation/request\",\"id\":\"request-1\",\"params\":{\"threadId\":\"thread-rpc\",\"turnId\":\"turn-rpc\",\"serverName\":\"codex_apps\",\"mode\":\"form\",\"message\":\"Read repository PRs directly\",\"requestedSchema\":{\"type\":\"object\",\"properties\":{}},\"_meta\":{\"codex_approval_kind\":\"tool_suggestion\",\"tool_type\":\"plugin\",\"tool_id\":\"github@openai-curated-remote\",\"tool_name\":\"GitHub\",\"install_url\":\"https://example.test/install\"}}}' ;;\n\
                 *'\"method\":\"plugin/install\"'*) echo '{\"id\":11,\"result\":{\"authPolicy\":\"NONE\",\"appsNeedingAuth\":[]}}' ;;\n\
                 *'\"id\":\"request-1\",\"result\"'*)\n\
                   echo '{\"method\":\"serverRequest/resolved\",\"params\":{\"threadId\":\"thread-rpc\",\"requestId\":\"request-1\"}}';\n\
                   echo '{\"method\":\"item/completed\",\"params\":{\"item\":{\"type\":\"agentMessage\",\"id\":\"answer-rpc\",\"text\":\"continued\"}}}';\n\
                   echo '{\"method\":\"turn/completed\",\"params\":{\"turn\":{\"id\":\"turn-rpc\",\"status\":\"completed\",\"error\":null}}}' ;;\n\
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
            None,
            Vec::new(),
            CliRunOpts::default(),
        )
        .unwrap();
        let outcome = session
            .start_turn("suggest a plugin".into(), Vec::new(), sink.clone() as Arc<dyn EventSink>)
            .unwrap();

        let responder = session.clone();
        let observed = sink.clone();
        tokio::spawn(async move {
            loop {
                let ready = observed.0.lock().unwrap().iter().any(|event| {
                    event["type"] == json!("cli_control_request")
                        && event["requestId"] == json!("request-1")
                });
                if ready {
                    responder
                        .install_plugin_and_respond(
                            json!("request-1"),
                            json!({ "action": "accept", "content": {}, "_meta": null }),
                            "github".to_string(),
                            "openai-curated-remote".to_string(),
                        )
                        .await
                        .unwrap();
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        });

        let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), outcome)
            .await
            .expect("turn should continue after the host response")
            .unwrap();
        let events = sink.0.lock().unwrap();
        let request = events
            .iter()
            .find(|event| event["type"] == json!("cli_control_request"))
            .expect("reverse request should reach the UI");
        assert_eq!(request["requestKind"], json!("mcp_elicitation"));
        assert_eq!(request["input"]["_meta"]["tool_name"], json!("GitHub"));
        assert!(events.iter().any(|event| {
            event["type"] == json!("cli_control_resolved")
                && event["requestId"] == json!("request-1")
        }));
        assert!(outcome.messages.iter().any(|message| {
            message["content"]
                .as_array()
                .is_some_and(|content| content.iter().any(|block| block["text"] == "continued"))
        }));

        session.shutdown();
        drop(events);
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

    /// Every change to the live background-task set (start, progress text,
    /// completion) must emit a `cli_background_tasks` snapshot — the standing
    /// state behind the frontend's task strip. Tasks outlive model turns, so
    /// paint on the launching card alone isn't enough.
    #[test]
    fn background_task_changes_emit_strip_snapshots() {
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tA","name":"Agent","input":{}}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);

        let ev = tr.on_line(r#"{"type":"system","subtype":"task_started","task_id":"bg1","tool_use_id":"tA","description":"scan repo","subagent_type":"Explore"}"#);
        let snap = ev.iter().find(|e| e["type"] == "cli_background_tasks").unwrap();
        assert_eq!(snap["tasks"][0]["taskId"], json!("bg1"));
        assert_eq!(snap["tasks"][0]["kind"], json!("Explore"));
        assert_eq!(snap["tasks"][0]["description"], json!("scan repo"));

        let ev = tr.on_line(r#"{"type":"system","subtype":"task_progress","task_id":"bg1","tool_use_id":"tA","description":"Running ls","subagent_type":"Explore"}"#);
        let snap = ev.iter().find(|e| e["type"] == "cli_background_tasks").unwrap();
        assert_eq!(snap["tasks"][0]["statusText"], json!("Running ls"));

        // A sidechain step changes the card's step list but not the strip —
        // no redundant snapshot.
        let ev = tr.on_line(r#"{"type":"assistant","parent_tool_use_id":"tA","message":{"content":[{"type":"tool_use","id":"inner-1","name":"Read","input":{"file_path":"main.rs"}}]}}"#);
        assert!(!types(&ev).contains(&"cli_background_tasks".to_string()));

        let ev = tr.on_line(r#"{"type":"system","subtype":"task_notification","task_id":"bg1","tool_use_id":"tA","status":"completed","summary":"done"}"#);
        let snap = ev.iter().find(|e| e["type"] == "cli_background_tasks").unwrap();
        assert_eq!(snap["tasks"], json!([]));
    }

    /// A Monitor rides the task lifecycle as `task_type: local_bash` (real
    /// event shape captured from claude 2.x): it must show in the strip
    /// snapshot, must NOT hold the model turn open (a persistent monitor can
    /// live for hours), and a firing emits no notification — the task stays
    /// live in the strip. The CLI's own `background_tasks_changed` list is
    /// translated as the authoritative snapshot.
    #[test]
    fn monitor_stays_in_strip_without_holding_the_turn() {
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
        let ev = tr.on_line(r#"{"type":"system","subtype":"task_started","task_id":"b864cfibk","tool_use_id":"tM","description":"content change in /tmp/flag.txt","task_type":"local_bash"}"#);
        let snap = ev.iter().find(|e| e["type"] == "cli_background_tasks").unwrap();
        assert_eq!(snap["tasks"][0]["kind"], json!("Bash"));
        assert_eq!(snap["tasks"][0]["description"], json!("content change in /tmp/flag.txt"));
        // local_bash never holds the turn — the reply can settle while the
        // monitor keeps watching.
        assert!(!tr.has_pending_turn_tasks());

        // The CLI's authoritative list re-emits the same snapshot (this is
        // what a resumed process reports even when our registry is empty).
        let ev = tr.on_line(r#"{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"b864cfibk","task_type":"local_bash","description":"content change in /tmp/flag.txt"}]}"#);
        let snap = ev.iter().find(|e| e["type"] == "cli_background_tasks").unwrap();
        assert_eq!(snap["tasks"][0]["taskId"], json!("b864cfibk"));
        assert_eq!(snap["tasks"][0]["kind"], json!("Bash"));

        // Turn boundary: the live monitor survives into the next turn's
        // registry, so the strip stays truthful across replies.
        tr.begin_next_turn();
        assert_eq!(
            tr.background_tasks_snapshot()[0]["taskId"],
            json!("b864cfibk")
        );
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

    fn artifact_test_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cetus-artifact-{label}-{}",
            ARTIFACT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn unknown_local_file_type_is_promoted_to_artifact() {
        let dir = artifact_test_dir("unknown");
        let file = dir.join("scene.blend");
        std::fs::write(&file, b"blend-data").unwrap();
        let details = extracted_artifact_details(
            &json!(format!("Created file: {}", file.display())),
            Some(&dir),
            Some(&dir),
        )
        .unwrap();
        assert_eq!(details["artifactKind"], json!("other"));
        assert_eq!(details["mimeType"], json!("application/octet-stream"));
        assert_eq!(details["name"], json!("scene.blend"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn inline_file_data_is_materialized_in_managed_storage() {
        let dir = artifact_test_dir("inline");
        let details = extracted_artifact_details(
            &json!({
                "type": "input_file",
                "data": base64::engine::general_purpose::STANDARD.encode(b"hello"),
                "mimeType": "text/plain"
            }),
            Some(&dir),
            Some(&dir),
        )
        .unwrap();
        let path = PathBuf::from(details["path"].as_str().unwrap());
        assert_eq!(std::fs::read(path).unwrap(), b"hello");
        assert_eq!(details["artifactKind"], json!("text"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn codex_image_generation_becomes_answer_artifact() {
        let dir = artifact_test_dir("codex-image");
        let mut tr = EventTranslator::new(CliBackend::Codex)
            .with_artifact_storage(dir.clone(), dir.clone());
        let encoded = base64::engine::general_purpose::STANDARD.encode(b"fake-png");
        let item = normalize_codex_app_item(
            json!({ "type": "imageGeneration", "id": "img-1", "result": encoded }),
        );
        let events = tr.on_line(&json!({ "type": "item.completed", "item": item }).to_string());
        let end = events
            .iter()
            .find(|event| event["type"] == "tool_execution_end")
            .unwrap();
        assert_eq!(end["result"]["details"]["artifactKind"], json!("image"));
        assert!(Path::new(end["result"]["details"]["path"].as_str().unwrap()).is_file());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn dynamic_tool_can_deliver_multiple_file_types() {
        let dir = artifact_test_dir("collection");
        let pdf = dir.join("report.pdf");
        let archive = dir.join("bundle.xyz");
        std::fs::write(&pdf, b"pdf").unwrap();
        std::fs::write(&archive, b"other").unwrap();
        let mut tr = EventTranslator::new(CliBackend::Codex)
            .with_artifact_storage(dir.clone(), dir.clone());
        let item = normalize_codex_app_item(json!({
            "type": "dynamicToolCall",
            "id": "tool-1",
            "tool": "export",
            "arguments": {},
            "contentItems": [
                { "type": "file", "path": pdf },
                { "type": "file", "path": archive }
            ],
            "success": true
        }));
        let events = tr.on_line(&json!({ "type": "item.completed", "item": item }).to_string());
        let end = events
            .iter()
            .find(|event| event["type"] == "tool_execution_end")
            .unwrap();
        let artifacts = end["result"]["details"]["artifacts"].as_array().unwrap();
        assert_eq!(artifacts.len(), 2);
        assert_eq!(artifacts[0]["artifactKind"], json!("pdf"));
        assert_eq!(artifacts[1]["artifactKind"], json!("other"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn claude_artifact_marker_is_promoted_from_bash_result() {
        let dir = artifact_test_dir("claude-marker");
        let file = dir.join("deck.pptx");
        std::fs::write(&file, b"slides").unwrap();
        let mut tr = EventTranslator::new(CliBackend::ClaudeCode)
            .with_artifact_storage(dir.clone(), dir.clone());
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"bash-1","name":"Bash","input":{}}}}"#);
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);
        let marker = format!(
            "CETUS_ARTIFACT:{}",
            json!({ "path": file.to_string_lossy() })
        );
        let events = tr.on_line(
            &json!({
                "type": "user",
                "message": { "content": [{
                    "type": "tool_result",
                    "tool_use_id": "bash-1",
                    "content": marker,
                    "is_error": false
                }]}
            })
            .to_string(),
        );
        let end = events
            .iter()
            .find(|event| event["type"] == "tool_execution_end")
            .unwrap();
        assert_eq!(end["result"]["details"]["name"], json!("deck.pptx"));
        assert_eq!(end["result"]["details"]["artifactKind"], json!("other"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn every_preview_category_and_unknown_extension_is_supported() {
        let dir = artifact_test_dir("kinds");
        for (name, expected) in [
            ("image.png", "image"),
            ("movie.mp4", "video"),
            ("sound.wav", "audio"),
            ("paper.pdf", "pdf"),
            ("notes.md", "markdown"),
            ("page.html", "html"),
            ("data.csv", "text"),
            ("workbook.xlsx", "other"),
            ("anything.custom", "other"),
        ] {
            let path = dir.join(name);
            std::fs::write(&path, b"x").unwrap();
            assert_eq!(artifact_details(&path, None, None).unwrap()["artifactKind"], json!(expected));
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
