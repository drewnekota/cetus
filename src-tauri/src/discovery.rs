//! "Discovered" sources — opt-in loading of skills and MCP servers the user
//! manages *outside* cetus. Two distinct mechanisms, surfaced as one settings blob:
//!
//! - **Skills**: standard user/repo folders for Codex, Claude, and Agent Skills,
//!   plus one configurable extra folder. When enabled, every `SKILL.md` folder
//!   there is copied into a conversation's active skill set.
//! - **MCP**: mcporter can only import servers from *named editor configs*
//!   (`claude-code`, `cursor`, …) — not an arbitrary folder. The selected sources
//!   are written as mcporter's `imports` list in `mcp.json`.
//!
//! Both feed the per-conversation freeze (see `AppState::pi_for`), so toggling
//! them only affects conversations created afterward — never existing chats.

use crate::store::Store;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::State;

const SETTINGS_KEY: &str = "discovery";

/// The editor configs mcporter knows how to import MCP servers from (its
/// `imports` enum). Anything outside this set is dropped on save.
pub const MCP_IMPORT_SOURCES: &[&str] = &[
    "claude-code",
    "claude-desktop",
    "cursor",
    "vscode",
    "windsurf",
    "codex",
    "opencode",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverySettings {
    /// When on, load standard runtime skill roots and [`Self::skills_folder`]
    /// into each new conversation (in addition to cetus's managed library).
    #[serde(default)]
    pub skills_load_discovered: bool,
    /// Additional folder scanned for discovered skills. Defaults to
    /// `~/.agents/skills`, which is de-duplicated against the standard roots.
    #[serde(default = "default_skills_folder")]
    pub skills_folder: String,
    /// mcporter `imports` sources to pull MCP servers from. Empty = cetus's own
    /// connectors only.
    #[serde(default)]
    pub mcp_imports: Vec<String>,
}

pub fn default_skills_folder() -> String {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|h| h.join(".agents").join("skills"))
        .unwrap_or_else(|| PathBuf::from("~/.agents/skills"))
        .to_string_lossy()
        .into_owned()
}

impl Default for DiscoverySettings {
    fn default() -> Self {
        Self {
            skills_load_discovered: false,
            skills_folder: default_skills_folder(),
            mcp_imports: Vec::new(),
        }
    }
}

pub fn load_settings(store: &Store) -> DiscoverySettings {
    store
        .get_setting(SETTINGS_KEY)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings(store: &Store, s: &DiscoverySettings) -> Result<(), String> {
    store
        .set_setting(
            SETTINGS_KEY,
            &serde_json::to_string(s).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_discovery_settings(
    state: State<'_, AppState>,
) -> Result<DiscoverySettings, String> {
    Ok(load_settings(&state.store))
}

#[tauri::command]
pub async fn set_discovery_settings(
    state: State<'_, AppState>,
    settings: DiscoverySettings,
) -> Result<(), String> {
    let mut s = settings;
    // Keep only sources mcporter actually understands, de-duped + order-stable.
    s.mcp_imports
        .retain(|i| MCP_IMPORT_SOURCES.contains(&i.as_str()));
    s.mcp_imports.dedup();
    s.skills_folder = s.skills_folder.trim().to_string();
    if s.skills_folder.is_empty() {
        s.skills_folder = default_skills_folder();
    }
    save_settings(&state.store, &s)?;
    // Refresh the GLOBAL templates so legacy conversations and the next freeze pick
    // up the change. No pi recycle: the per-conversation freeze (pi_for) means a
    // change must only reach conversations created afterward (hard freeze).
    crate::skills::resync_active_dir(&state.app_data_dir, &state.store);
    crate::mcp::export_config(&state.app_data_dir, &state.store);
    Ok(())
}
