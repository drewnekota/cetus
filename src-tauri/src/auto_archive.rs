//! Auto-archive: quietly archive conversations you haven't touched in a while,
//! and (separately opt-in) permanently delete chats that have sat in the
//! archive long enough.
//!
//! Opt-in (default OFF). When enabled, one long-lived background task sweeps
//! every [`TICK`] and archives any active conversation whose `updated_at` is
//! older than the user's idle threshold (a value + unit of hours/days). It
//! reuses the exact archive path the sidebar uses ([`Store::set_archived`] +
//! `kill_pi`), so an auto-archived chat behaves identically to a hand-archived
//! one: it leaves the active list, frees its pi process, and shows up under
//! Settings → Archived chats where it can be restored.
//!
//! Design notes:
//! - **Conservative trigger**: archiving is irreversible-feeling (it pulls a
//!   chat out of the sidebar), so the sweep is gated on the master switch and a
//!   generous, user-chosen idle window. It never touches a chat that's still
//!   visible in the chat pane, nor automation-generated conversations, whose
//!   results the user may not have seen yet.
//! - **Cheap when idle**: each tick is a settings read; it only lists/archives
//!   when the feature is on, and only writes for rows that actually crossed the
//!   threshold.
//! - **Self-notifying**: each archived row is emitted as `ConversationUpdated`
//!   (now carrying a non-null `archivedAt`), which the frontend drops from the
//!   active sidebar list.
//!
//! Auto-delete is a second, independent switch (default OFF) on the same
//! settings row. When on, the same sweeper permanently deletes any *archived*
//! conversation whose `archived_at` is older than its own threshold, through
//! the exact path the "Delete" button uses ([`crate::commands::purge_conversation`]),
//! and emits `ConversationDeleted` so the Archived chats page drops the row.
//! It only ever looks at archived rows, so an active chat can never be deleted
//! without first passing through the archive (manually or via auto-archive).

use crate::store::now_ms;
use crate::AppState;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::store::Store;

/// `app_settings` key.
const SETTINGS_KEY: &str = "auto_archive";

/// How often the sweeper wakes. Days/hours granularity doesn't need a tight
/// loop; a settings read every few minutes is plenty and effectively free.
const TICK: Duration = Duration::from_secs(5 * 60);
/// Skip the first ticks so a sweep never fires during startup churn.
const STARTUP_GRACE: Duration = Duration::from_secs(60);

const MS_PER_HOUR: i64 = 60 * 60 * 1000;
const MS_PER_DAY: i64 = 24 * MS_PER_HOUR;

// =============================================================================
// Settings (persisted in app_settings)
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoArchiveSettings {
    /// Master switch. Default OFF — the user opts in.
    #[serde(default)]
    pub enabled: bool,
    /// How much idle time before a conversation is archived, in [`Self::unit`].
    #[serde(default = "default_value")]
    pub value: u32,
    /// Unit for [`Self::value`]: `"hours"` or `"days"`.
    #[serde(default = "default_unit")]
    pub unit: String,
    /// Auto-delete switch. Default OFF — independent of [`Self::enabled`], so
    /// you can prune hand-archived chats without auto-archiving anything.
    #[serde(default)]
    pub delete_enabled: bool,
    /// How long a chat may sit in the archive before it's deleted, in
    /// [`Self::delete_unit`].
    #[serde(default = "default_delete_value")]
    pub delete_value: u32,
    /// Unit for [`Self::delete_value`]: `"hours"` or `"days"`.
    #[serde(default = "default_unit")]
    pub delete_unit: String,
}

fn default_value() -> u32 {
    30
}
fn default_delete_value() -> u32 {
    7
}
fn default_unit() -> String {
    "days".to_string()
}

impl Default for AutoArchiveSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            value: default_value(),
            unit: default_unit(),
            delete_enabled: false,
            delete_value: default_delete_value(),
            delete_unit: default_unit(),
        }
    }
}

/// `value` in `unit` as milliseconds. A value of 0 is clamped to 1 so neither
/// sweep can fire against everything the instant it's turned on.
fn threshold_ms(value: u32, unit: &str) -> i64 {
    let per_unit = if unit == "hours" {
        MS_PER_HOUR
    } else {
        MS_PER_DAY
    };
    value.max(1) as i64 * per_unit
}

impl AutoArchiveSettings {
    /// Idle threshold before an active chat is archived.
    fn idle_ms(&self) -> i64 {
        threshold_ms(self.value, &self.unit)
    }
    /// Age-in-archive threshold before an archived chat is deleted.
    fn delete_after_ms(&self) -> i64 {
        threshold_ms(self.delete_value, &self.delete_unit)
    }
}

pub fn load_settings(store: &Store) -> AutoArchiveSettings {
    store
        .get_setting(SETTINGS_KEY)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings(store: &Store, s: &AutoArchiveSettings) -> Result<()> {
    store.set_setting(SETTINGS_KEY, &serde_json::to_string(s)?)?;
    Ok(())
}

#[tauri::command]
pub async fn get_auto_archive_settings(
    state: State<'_, AppState>,
) -> Result<AutoArchiveSettings, String> {
    Ok(load_settings(&state.store))
}

#[tauri::command]
pub async fn set_auto_archive_settings(
    state: State<'_, AppState>,
    app: AppHandle,
    settings: AutoArchiveSettings,
) -> Result<(), String> {
    save_settings(&state.store, &settings).map_err(|e| e.to_string())?;
    // Apply right away so turning it on (or lowering the threshold) takes effect
    // immediately instead of waiting for the next background tick.
    if settings.enabled {
        if let Err(e) = sweep(&state, &app, &settings).await {
            tracing::warn!("auto-archive: immediate sweep failed: {e}");
        }
    }
    if settings.delete_enabled {
        if let Err(e) = sweep_delete(&state, &app, &settings).await {
            tracing::warn!("auto-delete: immediate sweep failed: {e}");
        }
    }
    Ok(())
}

// =============================================================================
// Background loop
// =============================================================================

/// Launch the background auto-archiver. One long-lived task; safe to leave
/// running forever. Spawned from `lib.rs` setup after `AppState` is managed.
pub fn spawn_auto_archiver(handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_GRACE).await;
        loop {
            if let Err(e) = tick(&handle).await {
                tracing::warn!("auto-archive tick failed: {e}");
            }
            tokio::time::sleep(TICK).await;
        }
    });
}

async fn tick(handle: &AppHandle) -> Result<()> {
    let state = handle.state::<AppState>();
    let settings = load_settings(&state.store);
    if settings.enabled {
        sweep(&state, handle, &settings).await?;
    }
    if settings.delete_enabled {
        sweep_delete(&state, handle, &settings).await?;
    }
    Ok(())
}

/// One pass: archive every active conversation idle past the threshold. Shared
/// by the background tick and the settings-save path (so a config change applies
/// immediately). Assumes the caller already checked `settings.enabled`.
async fn sweep(state: &AppState, handle: &AppHandle, settings: &AutoArchiveSettings) -> Result<()> {
    let now = now_ms();
    let cutoff = now - settings.idle_ms();
    let active = state
        .store
        .list(false)
        .map_err(|e| anyhow!("list conversations: {e}"))?;
    let visible_conversation_id = state.active_conversation().await;

    for c in active {
        // Already-old-enough rows only.
        if c.updated_at >= cutoff {
            continue;
        }
        // The visible chat is not idle from the user's perspective. Keep it in
        // place until they navigate away, even if its last persisted activity is
        // older than the auto-archive threshold.
        if visible_conversation_id.as_deref() == Some(c.id.as_str()) {
            continue;
        }
        // Leave automation-generated conversations alone — the user may not have
        // seen the result yet, and auto-archiving would hide unread output.
        if c.source_automation_id.is_some() {
            continue;
        }
        // Same reason, for hand-started chats: a run finished and the user never
        // came back to read it. Archiving would file away output they've never
        // seen. The marker clears the moment they open the chat.
        if c.unread_at.is_some() {
            continue;
        }
        // Don't yank a chat mid-turn. We gate on an *in-flight turn*, not on
        // merely having a pi in the pool: in a long-running app session every
        // chat you've opened keeps a warm pi around indefinitely, and treating
        // "has a warm pi" as "running" meant idle chats never got archived
        // while the app stayed open. A chat past the idle threshold with no
        // streaming turn is genuinely idle, warm pi or not.
        if let Some(pi) = state.pi_existing(&c.id).await {
            if pi.is_alive() && pi.is_busy() {
                continue;
            }
        }
        if state.cli_turn_active(&c.id) {
            continue;
        }

        if let Err(e) = state.store.set_archived(&c.id, true, now) {
            tracing::warn!("auto-archive: failed to archive {}: {e}", c.id);
            continue;
        }
        // Free any idle runtime we may still hold for it, matching the manual
        // archive lifecycle rather than leaving third-party sessions warm.
        state.kill_pi(&c.id).await;
        state.abort_cli_turn(&c.id);
        state.kill_claude_session(&c.id);
        state.kill_codex_session(&c.id);
        state.kill_acp_session(&c.id);
        if let Err(e) = crate::cli_backend::sync_codex_archive_state(&c, true).await {
            tracing::warn!(
                "auto-archive: failed to sync Codex archive state for {}: {e}",
                c.id
            );
        }

        // Tell the frontend so the sidebar drops it. Re-read the row so the
        // emitted conversation carries the fresh `archived_at`/`updated_at`.
        if let Ok(Some(updated)) = state.store.get(&c.id) {
            let _ = handle.emit(
                "app-event",
                crate::app_event::AppEvent::ConversationUpdated {
                    conversation: updated,
                },
            );
        }
        tracing::info!("auto-archived idle conversation {}", c.id);
    }

    Ok(())
}

/// One pass: permanently delete every archived conversation whose
/// `archived_at` is older than the delete threshold. Only archived rows are
/// considered, so nothing active can be deleted here. Assumes the caller
/// already checked `settings.delete_enabled`.
async fn sweep_delete(
    state: &AppState,
    handle: &AppHandle,
    settings: &AutoArchiveSettings,
) -> Result<()> {
    let now = now_ms();
    let cutoff = now - settings.delete_after_ms();
    let archived = state
        .store
        .list(true)
        .map_err(|e| anyhow!("list archived conversations: {e}"))?;
    let visible_conversation_id = state.active_conversation().await;

    for c in archived {
        // `list(true)` is archived-only, but be explicit: never delete a row
        // without an archive timestamp to age against.
        let Some(archived_at) = c.archived_at else {
            continue;
        };
        if archived_at >= cutoff {
            continue;
        }
        // An archived chat can still be open in the pane (opened from the
        // Archived page, or archived while being viewed). Don't pull the floor
        // out from under it; it'll go on the next tick once they navigate away.
        if visible_conversation_id.as_deref() == Some(c.id.as_str()) {
            continue;
        }
        if let Err(e) = crate::commands::purge_conversation(state, &c.id).await {
            tracing::warn!("auto-delete: failed to delete {}: {e}", c.id);
            continue;
        }
        let _ = handle.emit(
            "app-event",
            crate::app_event::AppEvent::ConversationDeleted { id: c.id.clone() },
        );
        tracing::info!(
            "auto-deleted archived conversation {} (archived {}ms ago)",
            c.id,
            now - archived_at
        );
    }

    Ok(())
}
