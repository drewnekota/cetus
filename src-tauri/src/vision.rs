//! User-selected **vision (VLM) provider** for the pi extensions.
//!
//! The vision-bridge / document-bridge pi extensions transcribe attached
//! images through an OpenAI-compatible VLM endpoint (see
//! `cetus-extensions/bridge/vision-core.ts`). Which endpoint to try first is a
//! user choice, persisted here (one JSON blob in `app_settings`) and exported
//! to `<app_data>/vision.json`, whose path is published as
//! `CETUS_VISION_CONFIG`. The extensions re-read the file on every call, so a
//! settings change takes effect on the next turn without recycling pi — same
//! pattern as `mcp.rs` / `CETUS_MCP_CONFIG`.
//!
//! API keys are NOT stored here — they stay in the keychain (`secrets.rs`) and
//! reach the extension as env vars at pi spawn.

use crate::store::Store;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::State;

const SETTINGS_KEY: &str = "vision_config";

/// Provider ids the frontend may select. `""` (auto) means "first preset whose
/// API key is configured, in this order". `custom` requires `base_url`.
/// Keep in sync with `VISION_PRESETS` in `cetus-extensions/bridge/vision-core.ts`
/// consumers and the Settings dropdown.
pub const SELECTABLE_PROVIDERS: &[&str] = &[
    "", // auto
    "gemini",
    "volc_ark",
    "zhipu",
    "dashscope",
    "moonshot",
    "ollama",
    "custom",
];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct VisionConfig {
    /// One of [`SELECTABLE_PROVIDERS`]; empty = auto (key-based order).
    pub provider: String,
    /// Model id at the chosen endpoint; empty = the provider's default.
    pub model: String,
    /// OpenAI-compatible base URL — used only when `provider` is `custom`
    /// (and as an override for `ollama`, whose default is localhost:11434).
    pub base_url: String,
}

fn load(store: &Store) -> VisionConfig {
    store
        .get_setting(SETTINGS_KEY)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Absolute path of the exported vision config. Mirrors `CETUS_VISION_CONFIG`.
pub fn config_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("vision.json")
}

/// (Re)write `<app_data>/vision.json` for the pi extensions to pick up.
pub fn export_config(app_data_dir: &Path, store: &Store) {
    let cfg = load(store);
    match serde_json::to_string_pretty(&cfg) {
        Ok(json) => {
            if let Err(e) = std::fs::write(config_path(app_data_dir), json) {
                tracing::warn!("vision: write vision.json failed: {e}");
            }
        }
        Err(e) => tracing::warn!("vision: serialize config failed: {e}"),
    }
}

#[tauri::command]
pub async fn vision_get_config(state: State<'_, AppState>) -> Result<VisionConfig, String> {
    Ok(load(&state.store))
}

#[tauri::command]
pub async fn vision_set_config(
    state: State<'_, AppState>,
    config: VisionConfig,
) -> Result<(), String> {
    let mut cfg = config;
    cfg.provider = cfg.provider.trim().to_string();
    cfg.model = cfg.model.trim().to_string();
    cfg.base_url = cfg.base_url.trim().to_string();
    if !SELECTABLE_PROVIDERS.contains(&cfg.provider.as_str()) {
        return Err(format!("unknown vision provider: {}", cfg.provider));
    }
    if cfg.provider == "custom" && cfg.base_url.is_empty() {
        return Err("custom vision provider needs a base URL".into());
    }
    state
        .store
        .set_setting(SETTINGS_KEY, &serde_json::to_string(&cfg).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    export_config(&state.app_data_dir, &state.store);
    Ok(())
}
