//! User-configured custom model providers (OpenAI-compatible endpoints).
//!
//! Settings → Models lets the user add any OpenAI-compatible provider — a base
//! URL, an API key, and one or more model ids — and pick those models per
//! conversation, exactly like the built-in DeepSeek tiers. The configuration
//! flows two ways:
//!
//!   * the **main agent**: providers are persisted here (`app_settings`, one
//!     JSON blob — endpoints and model ids, never keys) and exported to
//!     `<app_data>/custom-models.json`, whose path is published as
//!     `CETUS_MODELS_CONFIG`. The `cetus-extensions/custom-models.ts` pi
//!     extension reads that file at startup and calls `pi.registerProvider`
//!     for each provider; a config change recycles idle pis (same pattern as
//!     API-key changes) so the next turn picks it up.
//!   * **out-of-band** helper calls (auto-title, meeting minutes) resolve
//!     [`utility_target`] at call time: DeepSeek when its key is configured,
//!     else the first custom provider — so those features keep working for
//!     users who only configured a custom endpoint.
//!
//! API keys are NOT stored in the settings blob or the exported file — they
//! live in the keychain (`secrets.rs`) under `custom:<provider-id>` and reach
//! the extension as env vars (`CETUS_CUSTOM_KEY_<ID>`) at pi spawn.

use crate::model::DsModel;
use crate::secrets;
use crate::store::Store;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::State;

const SETTINGS_KEY: &str = "custom_providers";

/// pi's full thinking-level axis, in escalation order (mirrors the runtime's
/// EXTENDED_THINKING_LEVELS). Keys of `CustomModel::thinking_levels`.
pub const PI_THINKING_LEVELS: [&str; 7] =
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/// Accepted `compat.thinkingFormat` values ("" = standard reasoning_effort).
const THINKING_FORMATS: [&str; 4] = ["", "deepseek", "openrouter", "together"];

/// Prefix for every custom provider id — keeps them out of the namespace of
/// pi's built-in providers (deepseek, openai, …) and makes the persisted
/// `"<provider>/<model>"` model string unambiguous.
pub const ID_PREFIX: &str = "custom-";

/// Prefix for the keychain entry holding a custom provider's API key.
pub const SECRET_PREFIX: &str = "custom:";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CustomModel {
    /// Model id at the provider's endpoint (e.g. `gpt-4o`, `qwen3-max`).
    pub id: String,
    /// Display name; empty = show the id.
    pub name: String,
    /// Whether the model accepts image input. When true, pi passes attached
    /// images through natively and the vision-bridge transcription no-ops.
    pub vision: bool,
    /// Whether the model takes a reasoning-effort knob. When true,
    /// `thinking_levels` below selects which of pi's seven levels
    /// (off/minimal/low/medium/high/xhigh/max) the model exposes.
    pub reasoning: bool,
    /// Enabled thinking levels → endpoint token. Key present = level shown in
    /// the picker and registered with pi; value "" = send the level name
    /// itself (passthrough). Levels absent from the map register as null =
    /// unavailable.
    pub thinking_levels: BTreeMap<String, String>,
    /// How the effort reaches the request body — pi's compat.thinkingFormat:
    /// "" = standard `reasoning_effort`; "deepseek" = `thinking:{enabled|disabled}`;
    /// "openrouter" = `reasoning:{effort}`; "together" = Together's variant.
    pub thinking_format: String,
    /// Context window in tokens; 0 = extension default.
    pub context_window: u32,
    /// Max output tokens; 0 = extension default.
    pub max_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CustomProvider {
    /// Stable id (`custom-<slug>`), minted on first save.
    pub id: String,
    /// User-facing name ("OpenRouter", "My vLLM box", …).
    pub name: String,
    /// OpenAI-compatible base URL (without `/chat/completions`).
    pub base_url: String,
    pub models: Vec<CustomModel>,
}

pub fn load(store: &Store) -> Vec<CustomProvider> {
    store
        .get_setting(SETTINGS_KEY)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(store: &Store, providers: &[CustomProvider]) -> anyhow::Result<()> {
    store.set_setting(SETTINGS_KEY, &serde_json::to_string(providers)?)?;
    Ok(())
}

/// Env var name carrying `provider_id`'s API key into the pi child process.
/// Mirrored in the exported config (`keyEnv`) for the extension to read.
pub fn key_env_name(provider_id: &str) -> String {
    let sanitized: String = provider_id
        .trim_start_matches(ID_PREFIX)
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect();
    format!("CETUS_CUSTOM_KEY_{sanitized}")
}

/// Keychain entry id for `provider_id`'s API key.
pub fn secret_id(provider_id: &str) -> String {
    format!("{SECRET_PREFIX}{provider_id}")
}

/// Absolute path of the exported provider config. Mirrors `CETUS_MODELS_CONFIG`.
pub fn config_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("custom-models.json")
}

/// (Re)write `<app_data>/custom-models.json` for the custom-models pi
/// extension. Contains endpoints, model definitions, and the *name* of the
/// env var holding each key — never the key itself.
pub fn export_config(app_data_dir: &Path, store: &Store) {
    let providers = load(store);
    let exported: Vec<serde_json::Value> = providers
        .iter()
        .map(|p| {
            serde_json::json!({
                "id": p.id,
                "name": p.name,
                "baseUrl": p.base_url,
                "keyEnv": key_env_name(&p.id),
                "models": p.models.iter().map(|m| serde_json::json!({
                    "id": m.id,
                    "name": if m.name.is_empty() { &m.id } else { &m.name },
                    "vision": m.vision,
                    "reasoning": m.reasoning,
                    "thinkingLevels": m.thinking_levels,
                    "thinkingFormat": m.thinking_format,
                    "contextWindow": m.context_window,
                    "maxTokens": m.max_tokens,
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    let body = serde_json::json!({ "providers": exported });
    match serde_json::to_string_pretty(&body) {
        Ok(json) => {
            if let Err(e) = std::fs::write(config_path(app_data_dir), json) {
                tracing::warn!("custom-models: write custom-models.json failed: {e}");
            }
        }
        Err(e) => tracing::warn!("custom-models: serialize config failed: {e}"),
    }
}

/// The provider backing a persisted custom [`ModelRef`], if it still exists.
pub fn find_provider<'a>(
    providers: &'a [CustomProvider],
    provider_id: &str,
) -> Option<&'a CustomProvider> {
    providers.iter().find(|p| p.id == provider_id)
}

// ---------------------------------------------------------------------------
// Out-of-band helper target (auto-title, meeting minutes).
// ---------------------------------------------------------------------------

/// Where host-side one-shot completions (titling, meeting minutes) should go.
pub struct UtilityTarget {
    /// Full `/chat/completions` URL.
    pub url: String,
    /// Bearer key; empty = send unauthenticated (local endpoints).
    pub api_key: String,
    /// Model id to put in the request body.
    pub model: String,
    /// True when this is the built-in DeepSeek path — callers may add
    /// DeepSeek-specific request fields (`reasoning_effort`, …) only then.
    pub is_deepseek: bool,
}

/// Resolve the endpoint for out-of-band helper calls. DeepSeek (honoring the
/// custom base URL) when its key is configured — the stock setup — else the
/// first custom provider that has at least one model, so these features keep
/// working for users who only configured their own endpoint. `None` = no
/// usable target; callers should skip quietly.
pub fn utility_target(store: &Store) -> Option<UtilityTarget> {
    if let Ok(Some(key)) = secrets::get("deepseek") {
        return Some(UtilityTarget {
            url: crate::provider::deepseek_chat_url(store),
            api_key: key,
            model: DsModel::Pro.api_id().to_string(),
            is_deepseek: true,
        });
    }
    let providers = load(store);
    let p = providers.iter().find(|p| !p.models.is_empty())?;
    let base = p.base_url.trim_end_matches('/');
    let url = if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
    };
    Some(UtilityTarget {
        url,
        api_key: secrets::get(&secret_id(&p.id))
            .ok()
            .flatten()
            .unwrap_or_default(),
        model: p.models[0].id.clone(),
        is_deepseek: false,
    })
}

/// The saved config of a custom model, or `None` when the provider or model
/// was deleted from settings since a conversation picked it.
pub fn find_custom_model(store: &Store, provider: &str, model: &str) -> Option<CustomModel> {
    let providers = load(store);
    find_provider(&providers, provider)?
        .models
        .iter()
        .find(|m| m.id == model)
        .cloned()
}

// ---------------------------------------------------------------------------
// Tauri commands.
// ---------------------------------------------------------------------------

/// What the settings UI sees: the provider plus key presence/preview (the raw
/// key never crosses IPC unmasked here).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProviderView {
    #[serde(flatten)]
    pub provider: CustomProvider,
    pub has_key: bool,
    pub masked_key: String,
}

#[tauri::command]
pub async fn list_custom_providers(
    state: State<'_, AppState>,
) -> Result<Vec<CustomProviderView>, String> {
    Ok(load(&state.store)
        .into_iter()
        .map(|p| {
            let key = secrets::get(&secret_id(&p.id)).ok().flatten();
            CustomProviderView {
                has_key: key.is_some(),
                masked_key: key.as_deref().map(secrets::mask).unwrap_or_default(),
                provider: p,
            }
        })
        .collect())
}

/// Derive a `custom-<slug>` id from the display name, de-duplicated against
/// existing providers.
fn mint_id(name: &str, existing: &[CustomProvider]) -> String {
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let slug = if slug.is_empty() {
        "provider".to_string()
    } else {
        slug
    };
    let base = format!("{ID_PREFIX}{slug}");
    if !existing.iter().any(|p| p.id == base) {
        return base;
    }
    for n in 2.. {
        let candidate = format!("{base}-{n}");
        if !existing.iter().any(|p| p.id == candidate) {
            return candidate;
        }
    }
    unreachable!()
}

/// Create or update a provider. `api_key`: `None` = leave the stored key
/// untouched; `Some("")` = delete it; `Some(k)` = replace it. Recycles idle
/// pis so the next turn spawns with the new registry + env.
#[tauri::command]
pub async fn upsert_custom_provider(
    state: State<'_, AppState>,
    provider: CustomProvider,
    api_key: Option<String>,
) -> Result<CustomProvider, String> {
    let mut p = provider;
    p.name = p.name.trim().to_string();
    p.base_url = p.base_url.trim().trim_end_matches('/').to_string();
    p.models.retain_mut(|m| {
        m.id = m.id.trim().to_string();
        m.name = m.name.trim().to_string();
        m.thinking_format = m.thinking_format.trim().to_string();
        if !THINKING_FORMATS.contains(&m.thinking_format.as_str()) {
            m.thinking_format = String::new();
        }
        // Keep only valid level keys with trimmed tokens; a reasoning model
        // must expose at least one level or the picker (and pi) would have
        // nothing to select — seed the DeepSeek-like default set then.
        m.thinking_levels = std::mem::take(&mut m.thinking_levels)
            .into_iter()
            .filter(|(k, _)| PI_THINKING_LEVELS.contains(&k.as_str()))
            .map(|(k, v)| (k, v.trim().to_string()))
            .collect();
        if !m.reasoning {
            m.thinking_levels.clear();
            m.thinking_format = String::new();
        } else if m.thinking_levels.is_empty() {
            for lvl in ["off", "high", "max"] {
                m.thinking_levels.insert(lvl.to_string(), String::new());
            }
        }
        !m.id.is_empty()
    });
    if p.name.is_empty() {
        return Err("provider needs a name".into());
    }
    if p.base_url.is_empty() {
        return Err("provider needs a base URL".into());
    }
    if p.models.is_empty() {
        return Err("provider needs at least one model id".into());
    }

    let mut providers = load(&state.store);
    if p.id.is_empty() {
        p.id = mint_id(&p.name, &providers);
        providers.push(p.clone());
    } else {
        match providers.iter_mut().find(|e| e.id == p.id) {
            Some(slot) => *slot = p.clone(),
            None => return Err(format!("unknown provider: {}", p.id)),
        }
    }
    save(&state.store, &providers).map_err(|e| e.to_string())?;

    if let Some(key) = api_key {
        let result = if key.is_empty() {
            secrets::delete(&secret_id(&p.id))
        } else {
            secrets::set(&secret_id(&p.id), &key)
        };
        result.map_err(|e| e.to_string())?;
    }

    export_config(&state.app_data_dir, &state.store);
    state.kill_all().await;
    Ok(p)
}

#[tauri::command]
pub async fn delete_custom_provider(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut providers = load(&state.store);
    providers.retain(|p| p.id != id);
    save(&state.store, &providers).map_err(|e| e.to_string())?;
    let _ = secrets::delete(&secret_id(&id));
    export_config(&state.app_data_dir, &state.store);
    state.kill_all().await;
    Ok(())
}
