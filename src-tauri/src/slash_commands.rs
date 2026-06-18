//! User-defined **slash commands** — reusable prompt snippets the user triggers
//! by typing `/<name>` in the composer.
//!
//! A slash command is pure UI sugar: selecting one in the composer's slash menu
//! replaces the `/<name>` token with the command's `prompt` text. It never
//! reaches the agent as a command — the agent only ever sees the expanded text.
//! (Skills, by contrast, are real capabilities the agent loads; see `skills.rs`.
//! Both are surfaced together in the same slash menu, with distinct icons.)
//!
//! Storage is deliberately simple and local: the whole list is persisted as one
//! JSON blob in the `app_settings` table (key `slash_commands`), mirroring how
//! `skills.rs` / `ultra.rs` keep their metadata. No pi recycle is needed because
//! nothing here changes what the agent loads.

use crate::store::{now_ms, Store};
use crate::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

type CmdResult<T> = Result<T, String>;

const SETTINGS_KEY: &str = "slash_commands";
/// Cap the list so the menu + storage stay bounded.
const MAX_COMMANDS: usize = 200;
const MAX_NAME_CHARS: usize = 60;
const MAX_DESC_CHARS: usize = 200;
/// A prompt is a snippet, not a document — keep it sane.
const MAX_PROMPT_CHARS: usize = 20_000;

/// One slash command. `name` is the bare trigger (no leading `/`); `prompt` is
/// the text inserted into the composer when the command is picked.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

/// On-disk wrapper so the stored shape can grow a version/flags later without a
/// migration, exactly like `SkillState`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SlashStore {
    #[serde(default)]
    commands: Vec<SlashCommand>,
}

/// The fields the editor sends. `id` present → update that command; absent →
/// create (or overwrite a same-named one).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommandInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub prompt: String,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn load_store(store: &Store) -> SlashStore {
    store
        .get_setting(SETTINGS_KEY)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_store(store: &Store, s: &SlashStore) -> CmdResult<()> {
    store
        .set_setting(SETTINGS_KEY, &serde_json::to_string(s).map_err(err)?)
        .map_err(err)
}

/// Drop a leading `/` and surrounding whitespace — users naturally type the slash.
fn normalize_name(raw: &str) -> String {
    raw.trim().trim_start_matches('/').trim().to_string()
}

/// A trigger must start alphanumeric and otherwise hold only `[A-Za-z0-9_-]`, so
/// `/<name>` parses cleanly out of the composer text (no spaces, no surprises).
fn is_valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Truncate to a char boundary so stored strings stay bounded.
fn clamp(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.chars().count() > max {
        t.chars().take(max).collect()
    } else {
        t.to_string()
    }
}

#[tauri::command]
pub async fn list_slash_commands(state: State<'_, AppState>) -> CmdResult<Vec<SlashCommand>> {
    let mut commands = load_store(&state.store).commands;
    commands.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(commands)
}

/// Create or update a command. With `id`, edits that entry; without, creates one
/// (replacing any existing command with the same name, case-insensitively, so a
/// trigger maps to exactly one prompt).
#[tauri::command]
pub async fn upsert_slash_command(
    state: State<'_, AppState>,
    input: SlashCommandInput,
) -> CmdResult<SlashCommand> {
    let name = clamp(&normalize_name(&input.name), MAX_NAME_CHARS);
    if name.is_empty() {
        return Err("a command needs a name".into());
    }
    if !is_valid_name(&name) {
        return Err("use letters, numbers, dashes or underscores only".into());
    }
    let prompt = clamp(&input.prompt, MAX_PROMPT_CHARS);
    if prompt.is_empty() {
        return Err("a command needs a prompt".into());
    }
    let description = clamp(&input.description, MAX_DESC_CHARS);

    let mut s = load_store(&state.store);
    let now = now_ms();

    // Locate the target: by id when editing, else by matching name.
    let existing_idx = match &input.id {
        Some(id) => s.commands.iter().position(|c| &c.id == id),
        None => s
            .commands
            .iter()
            .position(|c| c.name.eq_ignore_ascii_case(&name)),
    };

    // Editing/creating must not collide with a *different* command's name.
    let clash = s.commands.iter().enumerate().any(|(i, c)| {
        Some(i) != existing_idx && c.name.eq_ignore_ascii_case(&name)
    });
    if clash {
        return Err(format!("a command named /{name} already exists"));
    }

    let result = if let Some(i) = existing_idx {
        let entry = &mut s.commands[i];
        entry.name = name;
        entry.description = description;
        entry.prompt = prompt;
        entry.updated_at = now;
        entry.clone()
    } else {
        if s.commands.len() >= MAX_COMMANDS {
            return Err(format!("command limit reached ({MAX_COMMANDS}); remove one first"));
        }
        let entry = SlashCommand {
            id: Uuid::new_v4().to_string(),
            name,
            description,
            prompt,
            created_at: now,
            updated_at: now,
        };
        s.commands.push(entry.clone());
        entry
    };

    save_store(&state.store, &s)?;
    Ok(result)
}

#[tauri::command]
pub async fn delete_slash_command(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let mut s = load_store(&state.store);
    let before = s.commands.len();
    s.commands.retain(|c| c.id != id);
    if s.commands.len() == before {
        return Ok(()); // already gone — idempotent
    }
    save_store(&state.store, &s)
}
