//! Custom model-endpoint configuration.
//!
//! cetus ships against DeepSeek, but users behind a proxy, a self-host, or a
//! region-restricted network need to point all DeepSeek traffic at a different
//! OpenAI-compatible base URL. The override is a single persisted setting
//! (`app_settings`, plaintext — it's an endpoint, not a secret) that flows two
//! ways:
//!
//!   * the **main agent** (the `pi` sidecar) reads `DEEPSEEK_BASE_URL` from its
//!     spawn env and a tiny extension (`cetus-extensions/deepseek-endpoint.ts`)
//!     calls `pi.registerProvider("deepseek", { baseUrl })` to override it;
//!   * the **out-of-band** helper calls (auto-title, dream, skill review,
//!     meeting minutes) resolve [`deepseek_chat_url`] at call time.
//!
//! Leaving it blank restores the stock `https://api.deepseek.com` endpoint.

use crate::store::Store;
use crate::AppState;
use tauri::State;

/// Stock DeepSeek OpenAI-compatible base. pi's built-in `deepseek` provider and
/// every out-of-band caller fall back to this when no override is set.
pub const DEEPSEEK_DEFAULT_BASE: &str = "https://api.deepseek.com";

const SETTING_KEY: &str = "deepseek_base_url";

/// The user's custom DeepSeek base URL — trimmed, trailing slash removed, and
/// `None` when unset/blank. This is the value handed to pi as `DEEPSEEK_BASE_URL`
/// and the base for [`deepseek_chat_url`].
pub fn deepseek_base_url(store: &Store) -> Option<String> {
    store
        .get_setting(SETTING_KEY)
        .ok()
        .flatten()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
}

/// The full chat-completions endpoint for out-of-band OpenAI-style POSTs. Uses
/// the override when set, else the stock base; tolerant of a base that already
/// includes the `/chat/completions` suffix.
pub fn deepseek_chat_url(store: &Store) -> String {
    let base = deepseek_base_url(store).unwrap_or_else(|| DEEPSEEK_DEFAULT_BASE.to_string());
    if base.ends_with("/chat/completions") {
        base
    } else {
        format!("{base}/chat/completions")
    }
}

/// Persist the override. An empty/whitespace value clears it (back to stock).
pub fn set_deepseek_base_url(store: &Store, url: &str) -> anyhow::Result<()> {
    store.set_setting(SETTING_KEY, url.trim())?;
    Ok(())
}

#[tauri::command]
pub async fn get_deepseek_base_url(state: State<'_, AppState>) -> Result<String, String> {
    Ok(deepseek_base_url(&state.store).unwrap_or_default())
}

#[tauri::command]
pub async fn set_deepseek_base_url_cmd(
    state: State<'_, AppState>,
    url: String,
) -> Result<(), String> {
    set_deepseek_base_url(&state.store, &url).map_err(|e| e.to_string())?;
    // The base URL reaches the main agent through pi's spawn env, so recycle
    // idle pis to pick up the change now (they respawn lazily, restoring their
    // session). Out-of-band callers read the store live and need no recycle.
    state.kill_all().await;
    Ok(())
}
