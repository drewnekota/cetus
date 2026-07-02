//! "Dreaming": background memory consolidation while you're not using cetus.
//!
//! When cetus has been *quiet* for a while (no chat sent/received for the quiet
//! window — you may be busy in other apps, that's fine) and there are sessions
//! we haven't reflected on yet, cetus quietly reads the day's new conversations,
//! asks the model to distill any *durable, generalizable* knowledge (stable
//! preferences, ongoing projects, recurring workflows, decisions), and folds it
//! into agent MEMORY:
//! adding new notes and refining existing agent-written ones. On the next turn
//! anywhere, the `memory` pi extension injects them into context, so the agent
//! starts each day already knowing what it learned the day before.
//!
//! Design notes:
//! - **Trigger** is cetus-quiet, not system idle and not a wall-clock cron: it
//!   runs once you've stopped chatting with cetus for the quiet window, even if
//!   you're actively working in another app. One long-lived task on the Tauri
//!   runtime polls every [`TICK`]; it's a no-op whenever dreaming is off, a chat
//!   is still active, or there's nothing new to consolidate.
//! - **Distillation** reuses the out-of-band DeepSeek pattern from
//!   [`crate::titling`] — a one-shot chat-completions call that never touches a
//!   pi session, so the summarization can't leak into any conversation history.
//! - **Incremental + self-throttling**: a per-store watermark
//!   (`dream.high_water_ms`) records the newest conversation already folded in,
//!   so each dream only ingests genuinely new content and never re-summarizes a
//!   session twice. Once the backlog is drained, nothing fires again until the
//!   user does more work — no rigid daily timer needed. A short attempt cooldown
//!   (`dream.last_attempt_ms`) keeps a transient model error from retrying in a
//!   tight loop.
//! - **Safety**: the model may only *add* notes or *refine agent-written* ones
//!   (see [`crate::memory::consolidate`]); the user's own memories are never
//!   rewritten. Output is hard-capped to a handful of notes per dream.

use crate::store::{now_ms, Conversation, Store};
use crate::{memory, secrets, AppState};
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

/// `app_settings` keys.
const SETTINGS_KEY: &str = "dreaming";
const WATERMARK_KEY: &str = "dream.high_water_ms";
const LAST_ATTEMPT_KEY: &str = "dream.last_attempt_ms";

/// How often the dreamer wakes to check idle + backlog. Cheap (a settings read
/// + an idle-clock query) unless it actually decides to dream.
const TICK: Duration = Duration::from_secs(60);
/// Skip the very first ticks so a dream never fires during startup churn.
const STARTUP_GRACE: Duration = Duration::from_secs(45);
/// Don't reach back further than this on the first ever dream, so a fresh
/// install with months of history doesn't try to summarize everything at once.
const LOOKBACK_MS: i64 = 48 * 60 * 60 * 1000;
/// Minimum gap between *real* dream attempts (ones that reach the model). The
/// watermark already prevents reprocessing; this just throttles error-retries
/// and avoids back-to-back dreams when work arrives in bursts.
const ATTEMPT_COOLDOWN_MS: i64 = 30 * 60 * 1000;
/// Cap conversations per dream — bounds the 1+N transcript fetch and token cost.
const MAX_CONVERSATIONS: usize = 20;
/// Per-conversation transcript budget (chars) before truncation.
const PER_CONV_CHARS: usize = 4_000;
/// Total transcript budget (chars) sent to the model in one dream.
const TOTAL_CHARS: usize = 24_000;
/// Most consolidation ops we accept from one dream.
const MAX_OPS: usize = 5;

/// cetus ships only DeepSeek V4 Pro; consolidation runs against it without
/// `reasoning_effort` to keep the pass fast. Matches `titling.rs`'s model choice.
const DREAM_MODEL: &str = "deepseek-v4-pro";

const DREAM_SYSTEM_PROMPT: &str = "\
You are the background \"dreaming\" process of cetus, a desktop AI assistant. While \
the user is away, you reflect on their recent conversations and consolidate \
durable knowledge into the assistant's long-term MEMORY.\n\n\
Your DEFAULT is to save NOTHING. Most conversations contain nothing durable — \
that is normal and expected. Only save a fact if you are confident the user would \
still want the assistant to know it weeks from now, in a completely unrelated \
conversation.\n\n\
SAVE only: the user's stable preferences (tools, languages, style), how they \
expect you to behave and communicate, their ongoing projects and goals, recurring \
workflows and conventions, and important decisions they expect to be honored \
later. A correction or frustration the user voices about HOW you work — \"stop \
doing X\", \"you're too verbose\", \"always use Y\", \"don't explain, just answer\", \
or an explicit \"remember that …\" — is a FIRST-CLASS durable preference: save it \
so the next conversation starts already knowing.\n\n\
DO NOT save (these are the common mistakes — be strict):\n\
- One-off tasks or how they were done (\"helped delete a launchd job\", \"fixed a \
bug in X\", \"answered a question about Y\"). The fact that a task happened is NOT durable.\n\
- Transient state, troubleshooting steps, or anything tied to a single session.\n\
- Anything re-derivable from the code, git history, or files (project structure, \
what a function does, past fixes).\n\
- Restating something already present in existing memory.\n\
- Generic facts not specific to THIS user.\n\n\
When unsure whether something clears this bar, DO NOT save it. A near-empty memory \
is far better than one cluttered with task trivia.\n\n\
Prefer REFINING an existing agent-written note (reference it by its id) over \
adding a near-duplicate. NEVER restate or edit the user's own notes.\n\n\
Respond with STRICT JSON only — no prose, no code fences:\n\
{\"ops\":[{\"action\":\"add\",\"content\":\"...\",\"category\":\"...\"},\
{\"action\":\"update\",\"id\":\"<existing agent id>\",\"content\":\"...\"}]}\n\
Each `content` must be one concise, self-contained sentence in the user's \
language. `category` is optional. Emit at most 5 ops. If nothing is durable \
enough, respond {\"ops\":[]}.";

// =============================================================================
// Settings (persisted in app_settings, mirrors UltraSettings)
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DreamSettings {
    /// Master switch. Default ON — cetus consolidates memory while you're idle.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Minutes of no input before the app is "idle enough" to start a dream.
    #[serde(default = "default_idle_minutes")]
    pub idle_minutes: u32,
}

fn default_true() -> bool {
    true
}
fn default_idle_minutes() -> u32 {
    15
}

impl Default for DreamSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            idle_minutes: default_idle_minutes(),
        }
    }
}

pub fn load_settings(store: &Store) -> DreamSettings {
    store
        .get_setting(SETTINGS_KEY)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings(store: &Store, s: &DreamSettings) -> Result<()> {
    store.set_setting(SETTINGS_KEY, &serde_json::to_string(s)?)?;
    Ok(())
}

#[tauri::command]
pub async fn get_dream_settings(state: State<'_, AppState>) -> Result<DreamSettings, String> {
    Ok(load_settings(&state.store))
}

#[tauri::command]
pub async fn set_dream_settings(
    state: State<'_, AppState>,
    settings: DreamSettings,
) -> Result<(), String> {
    save_settings(&state.store, &settings).map_err(|e| e.to_string())
}

// =============================================================================
// Background loop
// =============================================================================

/// Launch the background dreamer. One long-lived task; safe to leave running
/// forever. Spawned from `lib.rs` setup after `AppState` is managed (the tick
/// resolves it from the handle).
pub fn spawn_dreamer(handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_GRACE).await;
        loop {
            if let Err(e) = tick(&handle).await {
                tracing::warn!("dream tick failed: {e}");
            }
            tokio::time::sleep(TICK).await;
        }
    });
}

async fn tick(handle: &AppHandle) -> Result<()> {
    let state = handle.state::<AppState>();
    let settings = load_settings(&state.store);
    if !settings.enabled {
        return Ok(());
    }
    run_dream(&state, handle, settings.idle_minutes).await
}

/// One dream: gather new conversations → distill insights → consolidate memory.
async fn run_dream(state: &AppState, handle: &AppHandle, quiet_minutes: u32) -> Result<()> {
    // Need a key to call the model; absent → do nothing (so it just starts
    // working the moment the user adds a DeepSeek key).
    let api_key = match secrets::get("deepseek") {
        Ok(Some(k)) => k,
        _ => return Ok(()),
    };

    let now = now_ms();

    // "Not using cetus" gate: wait until cetus itself has been quiet for the quiet
    // window (no chat sent/received). This fires while you work in OTHER apps
    // too — it only waits for a lull in cetus, so it never summarizes a thread
    // you're still in the middle of. No dependency on system-wide idle or any OS
    // permission; `updated_at` is bumped on every prompt (see store::touch).
    //
    // Check this *before* materializing the conversation list — the common case
    // every 60s tick is "still active / nothing new", and a single indexed MAX is
    // far cheaper than mapping every row under the shared connection mutex.
    let last_activity = state
        .store
        .latest_activity_ms()
        .map_err(|e| anyhow!("latest activity: {e}"))?;
    let quiet_ms = quiet_minutes.max(1) as i64 * 60_000;
    if last_activity != 0 && now - last_activity < quiet_ms {
        return Ok(());
    }

    // Quiet long enough — now pull the list to find new work.
    let all = state
        .store
        .list(false)
        .map_err(|e| anyhow!("list conversations: {e}"))?;

    // The day's new, user-driven conversations: non-archived, touched since the
    // watermark (and within the lookback on a first run), excluding automation-
    // fired board cards. Oldest-first; capped to bound cost.
    let watermark = read_i64(&state.store, WATERMARK_KEY).unwrap_or(0);
    let floor = now - LOOKBACK_MS;
    let mut convs: Vec<_> = all
        .into_iter()
        .filter(|c| c.source_automation_id.is_none())
        .filter(|c| c.updated_at > watermark && c.updated_at >= floor)
        .collect();
    if convs.is_empty() {
        return Ok(()); // nothing new — the common case; no API call, no cost.
    }

    // Real work pending — respect the attempt cooldown (throttles error-retries
    // and bursty work) and claim the slot before doing anything expensive.
    if now - read_i64(&state.store, LAST_ATTEMPT_KEY).unwrap_or(0) < ATTEMPT_COOLDOWN_MS {
        return Ok(());
    }
    let _ = state.store.set_setting(LAST_ATTEMPT_KEY, &now.to_string());

    convs.sort_by_key(|c| c.updated_at);
    // Advance past EVERYTHING gathered (even any we drop below) so dropped old
    // conversations aren't reprocessed next time.
    let high_water = convs.iter().map(|c| c.updated_at).max().unwrap_or(now);
    if convs.len() > MAX_CONVERSATIONS {
        let drop = convs.len() - MAX_CONVERSATIONS;
        convs.drain(0..drop); // keep the most recent N
    }

    // Pull each transcript via pi (reusing an open pi, else a cold spawn we reap
    // right after). Bounded per-conversation and overall.
    let mut transcript = String::new();
    for c in &convs {
        if transcript.chars().count() >= TOTAL_CHARS {
            break;
        }
        let text = dream_transcript(state, c).await;
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let title = {
            let t = c.title.trim();
            if t.is_empty() {
                "Untitled"
            } else {
                t
            }
        };
        let budget = PER_CONV_CHARS.min(TOTAL_CHARS.saturating_sub(transcript.chars().count()));
        transcript.push_str(&format!("\n## Conversation: {title}\n"));
        transcript.push_str(&truncate_chars(text, budget));
        transcript.push('\n');
    }

    if transcript.trim().is_empty() {
        // Nothing usable (e.g. tool-only sessions) — advance the watermark so we
        // don't keep retrying these, and stop.
        let _ = state
            .store
            .set_setting(WATERMARK_KEY, &high_water.to_string());
        return Ok(());
    }

    // Show the model what's already known (so it won't duplicate) and the ids of
    // agent notes it may refine.
    let existing = render_existing_memory(state);
    let user_msg = format!(
        "EXISTING MEMORY (do not duplicate; agent notes carry an id you may update):\n{existing}\n\
         RECENT CONVERSATIONS TO CONSOLIDATE:\n{transcript}"
    );

    let ops = distill(
        &api_key,
        &crate::provider::deepseek_chat_url(&state.store),
        &user_msg,
    )
    .await?;
    let ops = parse_ops(&ops);
    if !ops.is_empty() {
        match memory::consolidate(&state.app_data_dir, ops) {
            Ok(n) if n > 0 => {
                tracing::info!("dream: consolidated {n} memory note(s)");
                let _ = handle.emit("app-event", crate::app_event::AppEvent::MemoryUpdated);
            }
            Ok(_) => {}
            Err(e) => tracing::warn!("dream: memory write failed: {e}"),
        }
    }

    // Success: advance the watermark so this batch is never reconsidered.
    let _ = state
        .store
        .set_setting(WATERMARK_KEY, &high_water.to_string());
    Ok(())
}

// =============================================================================
// Helpers
// =============================================================================

/// Pull one conversation's transcript via pi. `pub(crate)` so the skill-review
/// pass ([`crate::skill_review`]) reuses the exact same fetch.
pub(crate) async fn fetch_transcript(state: &AppState, conv_id: &str) -> Result<String> {
    let pi = state.pi_for(conv_id).await?;
    let msgs = pi.get_messages().await?;
    Ok(flatten_messages(&msgs))
}

/// Read one conversation's transcript for the dreamer WITHOUT cold-spawning a pi.
/// If its pi is already warm, flatten the in-memory messages; otherwise parse the
/// session jsonl straight off disk. The dreamer scans up to `MAX_CONVERSATIONS`
/// idle conversations per run, and spawning then instantly reaping a Bun sidecar
/// for each was the dominant cost of a dream — far more than the model call. The
/// disk read runs on a blocking thread so a large session file can't stall the
/// async runtime.
async fn dream_transcript(state: &AppState, conv: &Conversation) -> String {
    if let Some(pi) = state.pi_existing(&conv.id).await {
        return match pi.get_messages().await {
            Ok(msgs) => flatten_messages(&msgs),
            Err(e) => {
                tracing::warn!("dream: get_messages for {} failed: {e}", conv.id);
                String::new()
            }
        };
    }
    let session_file = conv.session_file.clone();
    if session_file.is_empty() {
        return String::new(); // no pi session ever minted → nothing to read
    }
    tokio::task::spawn_blocking(move || read_transcript_file(&session_file))
        .await
        .unwrap_or_default()
}

/// Flatten a session jsonl file into the same "User: …/Assistant: …" transcript
/// `flatten_messages` produces from pi's live message array. Best-effort: a
/// malformed line is skipped and an unreadable file yields an empty string.
fn read_transcript_file(session_file: &str) -> String {
    let content = match std::fs::read_to_string(session_file) {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    let mut out = String::new();
    for line in content.lines() {
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("message") {
            continue;
        }
        let Some(msg) = v.get("message") else {
            continue;
        };
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");
        if role != "user" && role != "assistant" {
            continue;
        }
        let text = extract_text(msg.get("content"));
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        out.push_str(if role == "user" {
            "User: "
        } else {
            "Assistant: "
        });
        out.push_str(text);
        out.push_str("\n\n");
    }
    out
}

/// Flatten pi's message array into a plain "User: … / Assistant: …" transcript,
/// skipping tool / system turns and any message with no text.
fn flatten_messages(msgs: &[Value]) -> String {
    let mut out = String::new();
    for m in msgs {
        let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("");
        if role != "user" && role != "assistant" {
            continue;
        }
        let text = extract_text(m.get("content"));
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        out.push_str(if role == "user" {
            "User: "
        } else {
            "Assistant: "
        });
        out.push_str(text);
        out.push_str("\n\n");
    }
    out
}

/// Pull the text out of a pi message `content`, which is either a plain string
/// or an array of typed parts (we keep only `text` parts).
fn extract_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => {
            let mut buf = String::new();
            for p in parts {
                if p.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(t) = p.get("text").and_then(|t| t.as_str()) {
                        if !buf.is_empty() {
                            buf.push('\n');
                        }
                        buf.push_str(t);
                    }
                }
            }
            buf
        }
        _ => String::new(),
    }
}

/// Render the current enabled notes for the prompt: agent notes carry their id
/// (so the model can refine them), user notes are shown id-less and read-only.
fn render_existing_memory(state: &AppState) -> String {
    let snap = memory::snapshot(&state.app_data_dir);
    let mut out = String::new();
    for e in snap.entries.iter().filter(|e| e.enabled) {
        if e.source == "agent" {
            out.push_str(&format!("- [id:{}] {}\n", e.id, e.content));
        } else {
            out.push_str(&format!("- {}\n", e.content));
        }
    }
    if out.is_empty() {
        out.push_str("(none yet)\n");
    }
    out
}

pub(crate) fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() > max {
        let mut out: String = s.chars().take(max).collect();
        out.push('…');
        out
    } else {
        s.to_string()
    }
}

pub(crate) fn read_i64(store: &Store, key: &str) -> Option<i64> {
    store
        .get_setting(key)
        .ok()
        .flatten()
        .and_then(|s| s.parse().ok())
}

/// One-shot, out-of-band consolidation call (mirrors `titling::generate_title`,
/// with JSON mode on). Returns the raw model content (expected to be JSON).
async fn distill(api_key: &str, url: &str, user_msg: &str) -> Result<String> {
    let body = json!({
        "model": DREAM_MODEL,
        "messages": [
            { "role": "system", "content": DREAM_SYSTEM_PROMPT },
            { "role": "user", "content": user_msg },
        ],
        "stream": false,
        "temperature": 0.3,
        "max_tokens": 1024,
        "response_format": { "type": "json_object" },
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(url)
        .bearer_auth(api_key)
        .json(&body)
        .timeout(Duration::from_secs(60))
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        bail!("dream consolidation failed: {status} {text}");
    }

    let value: Value = resp.json().await?;
    let content = value
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("dream response missing content: {value}"))?;
    Ok(content.to_string())
}

/// Parse the model's `{"ops":[…]}` JSON into validated consolidation ops.
/// Tolerant: bad/empty entries are dropped, an `update` missing an id falls back
/// to an `add`, and the whole thing is capped at [`MAX_OPS`].
fn parse_ops(raw: &str) -> Vec<memory::Consolidation> {
    let v: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let arr = match v.get("ops").and_then(|o| o.as_array()) {
        Some(a) => a,
        None => return Vec::new(),
    };
    let mut out = Vec::new();
    for op in arr.iter().take(MAX_OPS) {
        let content = op
            .get("content")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if content.is_empty() {
            continue;
        }
        let category = op
            .get("category")
            .and_then(|c| c.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(String::from);
        let is_update = op.get("action").and_then(|a| a.as_str()) == Some("update");
        let id = op
            .get("id")
            .and_then(|i| i.as_str())
            .filter(|s| !s.is_empty());
        match (is_update, id) {
            (true, Some(id)) => out.push(memory::Consolidation::Update {
                id: id.to_string(),
                content,
            }),
            // An update with no usable id, or a plain add → add a new note.
            _ => out.push(memory::Consolidation::Add { content, category }),
        }
    }
    out
}
