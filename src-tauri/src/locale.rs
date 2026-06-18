//! UI-language anchor for the conversation system prompt.
//!
//! The frontend language preference lives in localStorage (`cetus.locale`, see
//! `src/lib/i18n/config.ts`); the model never saw it. With only "speak in the
//! user's language" to go on, it would drift to whatever language recent context
//! (history, memory notes) happened to be in. We mirror the *resolved* UI locale
//! into the `app_settings` store and append a concrete "reply in <language>"
//! anchor to every conversation's system prompt at spawn time. Mirrors the
//! persisted-toggle pattern in [`crate::ultra`].

use crate::store::Store;
use crate::AppState;
use tauri::State;

/// One JSON-less string blob in `app_settings`: the resolved locale code.
const SETTINGS_KEY: &str = "ui_locale";

/// Map a cetus locale code to its English language name (the system prompt is
/// kept entirely in English). Unknown / unset codes fall back to English. Keep
/// in sync with `src/lib/i18n/config.ts` (`Locale`).
fn language_name(code: &str) -> &'static str {
    match code {
        "zh" => "Simplified Chinese",
        "ja" => "Japanese",
        "ko" => "Korean",
        "es" => "Spanish",
        "pt" => "Portuguese",
        "fr" => "French",
        "de" => "German",
        "it" => "Italian",
        "ru" => "Russian",
        _ => "English",
    }
}

/// The persisted UI locale code (e.g. "en", "zh"), defaulting to English.
pub fn load_locale(store: &Store) -> String {
    store
        .get_setting(SETTINGS_KEY)
        .ok()
        .flatten()
        .unwrap_or_else(|| "en".to_string())
}

/// A concrete "reply in <language>" instruction appended to every
/// conversation's system prompt so the model has a firm language anchor instead
/// of inferring one from recent context. The user can still pull the reply to
/// another language just by writing their message in that language.
pub fn locale_system_prompt(store: &Store) -> String {
    let lang = language_name(&load_locale(store));
    format!(
        "\n\nThe user's cetus interface language is {lang}. Reply in {lang} by \
         default. If the user writes their latest message in a different \
         language, reply in that language instead."
    )
}

#[tauri::command]
pub async fn get_ui_locale(state: State<'_, AppState>) -> Result<String, String> {
    Ok(load_locale(&state.store))
}

#[tauri::command]
pub async fn set_ui_locale(state: State<'_, AppState>, locale: String) -> Result<(), String> {
    // No-op if unchanged so a redundant sync (every window mounts the provider)
    // doesn't needlessly recycle live conversations.
    if load_locale(&state.store) == locale {
        return Ok(());
    }
    state
        .store
        .set_setting(SETTINGS_KEY, &locale)
        .map_err(|e| e.to_string())?;
    // The anchor is applied at pi spawn time, so recycle idle pis to pick up the
    // change now (they respawn lazily, restoring their session).
    state.kill_all().await;
    Ok(())
}
