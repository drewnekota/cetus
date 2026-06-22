//! Skill review: background self-improvement that turns experience into skills.
//!
//! The companion to "dreaming" ([`crate::dream`], which consolidates MEMORY).
//! When cetus has been *quiet* for a while and there are conversations it hasn't
//! reviewed yet, it reads the recent transcripts and asks the model whether any
//! reusable SKILL is worth saving — a repeatable workflow, a project/tooling
//! convention, a non-obvious technique the user will need again. Anything it
//! finds is written into the skills library as a PROPOSAL: `source:"agent"`,
//! `enabled:false`. It never auto-activates — the user reviews proposals in
//! Settings → Skills and turns on the good ones. That's the learning loop:
//! experience → proposed skill → user approves → active skill the agent pulls in.
//!
//! Design mirrors the dreaming pass deliberately (same proven shape):
//! - **Trigger** is cetus-quiet (a lull in chatting), not system idle / a cron.
//! - **Distillation** reuses the out-of-band DeepSeek pattern from
//!   [`crate::titling`]/[`crate::dream`] — a one-shot call that never touches a
//!   pi session.
//! - **Incremental + self-throttling** via its own watermark + attempt cooldown
//!   (separate from dreaming's, so the two features are independent). The cooldown
//!   is long: skill-worthy patterns emerge slowly, and we never want to flood the
//!   list.
//! - **Bounded**: a few proposals per pass, and we stop proposing once a backlog
//!   of un-reviewed proposals piles up (the user has to triage before more land).
//! - **Safety**: proposals land DISABLED. The pass only ever *adds* `agent`
//!   skills; it never edits or enables the user's own skills.

use crate::store::{now_ms, Store};
use crate::{dream, secrets, skills, AppState};
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

/// `app_settings` keys (distinct from dreaming's, so the features are independent).
const SETTINGS_KEY: &str = "skill_review";
const WATERMARK_KEY: &str = "skill_review.high_water_ms";
const LAST_ATTEMPT_KEY: &str = "skill_review.last_attempt_ms";

const TICK: Duration = Duration::from_secs(120);
/// Skip the first ticks (and offset from the dreamer) so the two passes rarely
/// run on the same instant and we never fire during startup churn.
const STARTUP_GRACE: Duration = Duration::from_secs(90);
/// First-run lookback cap so a fresh install with months of history doesn't try
/// to mine everything at once.
const LOOKBACK_MS: i64 = 48 * 60 * 60 * 1000;
/// Minimum gap between *real* review attempts (ones that reach the model). Long:
/// skills accrue slowly and proposing is weighty. The watermark already prevents
/// reprocessing; this throttles error-retries and bursty work.
const ATTEMPT_COOLDOWN_MS: i64 = 4 * 60 * 60 * 1000;
/// Cap conversations per pass — bounds transcript fetch + token cost.
const MAX_CONVERSATIONS: usize = 20;
const PER_CONV_CHARS: usize = 4_000;
const TOTAL_CHARS: usize = 24_000;
/// Most proposals we accept from one pass (skills are weighty — don't flood).
const MAX_PROPOSALS_PER_PASS: usize = 2;
/// Stop proposing once this many proposals await review, so the list can't fill
/// up with un-triaged suggestions. We retry (cheaply) once the user clears some.
const MAX_PENDING_PROPOSALS: usize = 8;

const REVIEW_MODEL: &str = "deepseek-v4-pro";

const REVIEW_SYSTEM_PROMPT: &str = "\
You are the background skill-learning process of cetus, a desktop AI assistant. \
While the user is away, you review their recent conversations and propose \
reusable SKILLS — self-contained instruction docs (a SKILL.md) the assistant can \
pull in later when a similar task recurs.\n\n\
A good skill is a GENERALIZABLE, repeatable procedure or body of knowledge the \
user will plausibly need AGAIN: a multi-step workflow they walked you through, a \
project or tooling convention specific to how THEY work, a non-obvious technique \
that worked, or domain knowledge particular to their recurring tasks.\n\n\
Your DEFAULT is to propose NOTHING. Most conversations yield no durable skill — \
that is normal and expected. Only propose one when you are confident it will save \
real work in a future, unrelated session.\n\n\
DO NOT propose (these are the common mistakes — be strict):\n\
- One-off tasks or a play-by-play of what happened this session (\"fixed bug X\", \
\"answered question Y\"). A skill is reusable know-how, not a task log.\n\
- Environment-specific failures or transient state (\"the browser was broken\", \
\"the build failed because a key was missing\"). NEVER encode a temporary problem \
as a standing instruction — the assistant would wrongly follow it for months.\n\
- Anything re-derivable from the user's code, git history, or files.\n\
- A skill that duplicates or barely differs from an EXISTING skill (listed below).\n\
- Generic programming knowledge any assistant already has.\n\n\
Each proposed skill has:\n\
- name: 2-5 words, a topic/imperative label (e.g. \"Deploy to staging\").\n\
- description: ONE sentence stating WHEN to use it (the trigger the assistant \
matches against), in the user's language.\n\
- body: concise markdown — the actual reusable steps/commands/conventions. No \
preamble, do not restate the description.\n\n\
Respond with STRICT JSON only — no prose, no code fences:\n\
{\"skills\":[{\"name\":\"...\",\"description\":\"...\",\"body\":\"...\"}]}\n\
Propose at most 2. If nothing clears the bar, respond {\"skills\":[]}.";

// =============================================================================
// Settings
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillReviewSettings {
    /// Master switch. Default ON — cetus proposes skills (disabled, for review)
    /// while you're idle. Proposals never activate without your approval.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Minutes of no input before the app is "idle enough" to start a review.
    #[serde(default = "default_idle_minutes")]
    pub idle_minutes: u32,
}

fn default_true() -> bool {
    true
}
fn default_idle_minutes() -> u32 {
    20
}

impl Default for SkillReviewSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            idle_minutes: default_idle_minutes(),
        }
    }
}

pub fn load_settings(store: &Store) -> SkillReviewSettings {
    store
        .get_setting(SETTINGS_KEY)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings(store: &Store, s: &SkillReviewSettings) -> Result<()> {
    store.set_setting(SETTINGS_KEY, &serde_json::to_string(s)?)?;
    Ok(())
}

#[tauri::command]
pub async fn get_skill_review_settings(
    state: State<'_, AppState>,
) -> Result<SkillReviewSettings, String> {
    Ok(load_settings(&state.store))
}

#[tauri::command]
pub async fn set_skill_review_settings(
    state: State<'_, AppState>,
    settings: SkillReviewSettings,
) -> Result<(), String> {
    save_settings(&state.store, &settings).map_err(|e| e.to_string())
}

// =============================================================================
// Background loop
// =============================================================================

/// Launch the background skill reviewer. One long-lived task; spawned from
/// `lib.rs` setup after `AppState` is managed.
pub fn spawn_skill_reviewer(handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_GRACE).await;
        loop {
            if let Err(e) = tick(&handle).await {
                tracing::warn!("skill-review tick failed: {e}");
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
    run_review(&state, handle, settings.idle_minutes).await
}

/// One review: gather new conversations → propose skills → write them disabled.
async fn run_review(state: &AppState, handle: &AppHandle, quiet_minutes: u32) -> Result<()> {
    let api_key = match secrets::get("deepseek") {
        Ok(Some(k)) => k,
        _ => return Ok(()),
    };

    let now = now_ms();
    let all = state
        .store
        .list(false)
        .map_err(|e| anyhow!("list conversations: {e}"))?;

    // cetus-quiet gate: only run once chatting with cetus has lulled (mirrors dream).
    let last_activity = all.iter().map(|c| c.updated_at).max().unwrap_or(0);
    let quiet_ms = quiet_minutes.max(1) as i64 * 60_000;
    if last_activity != 0 && now - last_activity < quiet_ms {
        return Ok(());
    }

    // New, user-driven conversations since our watermark (within first-run lookback),
    // excluding automation-fired board cards. Oldest-first.
    let watermark = dream::read_i64(&state.store, WATERMARK_KEY).unwrap_or(0);
    let floor = now - LOOKBACK_MS;
    let mut convs: Vec<_> = all
        .into_iter()
        .filter(|c| c.source_automation_id.is_none())
        .filter(|c| c.updated_at > watermark && c.updated_at >= floor)
        .collect();
    if convs.is_empty() {
        return Ok(()); // nothing new — the common case; no API call, no cost.
    }

    // Don't pile up un-reviewed proposals. If the user has a backlog to triage,
    // hold off WITHOUT advancing the watermark or claiming the cooldown, so these
    // conversations get reviewed once they clear some. (Cheap re-check each tick.)
    let pending = skills::pending_proposal_count(&state.store);
    if pending >= MAX_PENDING_PROPOSALS {
        return Ok(());
    }

    // Real work pending — respect the attempt cooldown and claim the slot.
    if now - dream::read_i64(&state.store, LAST_ATTEMPT_KEY).unwrap_or(0) < ATTEMPT_COOLDOWN_MS {
        return Ok(());
    }
    let _ = state.store.set_setting(LAST_ATTEMPT_KEY, &now.to_string());

    convs.sort_by_key(|c| c.updated_at);
    let high_water = convs.iter().map(|c| c.updated_at).max().unwrap_or(now);
    if convs.len() > MAX_CONVERSATIONS {
        let drop = convs.len() - MAX_CONVERSATIONS;
        convs.drain(0..drop); // keep the most recent N
    }

    // Pull each transcript via pi (reusing an open pi, else a cold spawn we reap).
    let mut transcript = String::new();
    for c in &convs {
        if transcript.chars().count() >= TOTAL_CHARS {
            break;
        }
        let was_open = state.pi_existing(&c.id).await.is_some();
        let text = match dream::fetch_transcript(state, &c.id).await {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!("skill-review: transcript for {} failed: {e}", c.id);
                String::new()
            }
        };
        if !was_open {
            state.kill_pi(&c.id).await; // reap the cold pi we spawned
        }
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
        transcript.push_str(&dream::truncate_chars(text, budget));
        transcript.push('\n');
    }

    if transcript.trim().is_empty() {
        // Nothing usable — advance the watermark so we don't keep retrying these.
        let _ = state
            .store
            .set_setting(WATERMARK_KEY, &high_water.to_string());
        return Ok(());
    }

    let existing = render_existing_skills(&state.store);
    let user_msg = format!(
        "EXISTING SKILLS (do not duplicate or near-duplicate):\n{existing}\n\
         RECENT CONVERSATIONS TO LEARN FROM:\n{transcript}"
    );

    let budget = MAX_PROPOSALS_PER_PASS.min(MAX_PENDING_PROPOSALS.saturating_sub(pending));
    let raw = distill(
        &api_key,
        &crate::provider::deepseek_chat_url(&state.store),
        &user_msg,
    )
    .await?;
    let proposals: Vec<Proposal> = parse_proposals(&raw).into_iter().take(budget).collect();

    let mut created = 0usize;
    for p in proposals {
        match skills::propose_skill(
            &state.app_data_dir,
            &state.store,
            &p.name,
            &p.description,
            &p.body,
        ) {
            Ok(_) => created += 1,
            Err(e) => tracing::warn!("skill-review: propose failed: {e}"),
        }
    }
    if created > 0 {
        tracing::info!("skill-review: proposed {created} skill(s) for review");
        let _ = handle.emit("app-event", crate::app_event::AppEvent::SkillsUpdated);
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

/// Existing skills (name + description) for the prompt, so the model won't
/// re-propose what's already installed.
fn render_existing_skills(store: &Store) -> String {
    let digest = skills::existing_skill_digest(store);
    if digest.is_empty() {
        return "(none yet)\n".to_string();
    }
    let mut out = String::new();
    for (name, desc) in digest {
        if desc.trim().is_empty() {
            out.push_str(&format!("- {name}\n"));
        } else {
            out.push_str(&format!("- {name}: {desc}\n"));
        }
    }
    out
}

struct Proposal {
    name: String,
    description: String,
    body: String,
}

/// Parse the model's `{"skills":[…]}` JSON. Tolerant: entries missing a name or
/// body are dropped.
fn parse_proposals(raw: &str) -> Vec<Proposal> {
    let v: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let arr = match v.get("skills").and_then(|s| s.as_array()) {
        Some(a) => a,
        None => return Vec::new(),
    };
    let mut out = Vec::new();
    for s in arr {
        let field = |k: &str| {
            s.get(k)
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .trim()
                .to_string()
        };
        let name = field("name");
        let body = field("body");
        if name.is_empty() || body.is_empty() {
            continue;
        }
        out.push(Proposal {
            name,
            description: field("description"),
            body,
        });
    }
    out
}

/// One-shot, out-of-band proposal call (mirrors `dream::distill`).
async fn distill(api_key: &str, url: &str, user_msg: &str) -> Result<String> {
    let body = json!({
        "model": REVIEW_MODEL,
        "messages": [
            { "role": "system", "content": REVIEW_SYSTEM_PROMPT },
            { "role": "user", "content": user_msg },
        ],
        "stream": false,
        "temperature": 0.3,
        "max_tokens": 2048,
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
        bail!("skill-review failed: {status} {text}");
    }

    let value: Value = resp.json().await?;
    let content = value
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("skill-review response missing content: {value}"))?;
    Ok(content.to_string())
}
