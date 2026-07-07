//! In-app self-update: the startup check plus the manual commands behind the
//! Settings "Check for updates" button and the passive "update available"
//! toast.
//!
//! Real behavior is **release-only**: the updater plugin is registered only in
//! release builds (see `lib.rs`), and `app.updater()` needs that registration.
//! In debug everything no-ops / errors politely so `tauri dev` is never touched.

use crate::AppState;
use serde::Serialize;
use tauri::AppHandle;

/// Store key holding the one update version the user dismissed from the passive
/// toast. We re-prompt only once a *newer* version than this ships.
const IGNORED_KEY: &str = "updater_ignored_version";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMeta {
    /// The version offered by the release manifest.
    pub version: String,
    /// The version currently running.
    pub current_version: String,
    /// Release notes from the manifest, if any.
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDownloadProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
    pub finished: bool,
}

/// Background check at launch.
///
/// - auto on  → download + swap silently (applies on next launch, no nag).
/// - auto off → only emit a non-intrusive `update-available` event to the main
///   window, and only for a version the user hasn't already dismissed.
///
/// All failures (offline, no release, bad signature) are logged and swallowed.
#[cfg(not(debug_assertions))]
pub async fn startup_check(app: AppHandle, auto: bool) {
    use tauri::{Emitter, Manager};
    use tauri_plugin_updater::UpdaterExt;

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            tracing::warn!("cetus: updater unavailable: {e}");
            return;
        }
    };
    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => {
            tracing::debug!("cetus: already up to date");
            return;
        }
        Err(e) => {
            tracing::warn!("cetus: update check failed: {e}");
            return;
        }
    };

    if auto {
        let v = update.version.clone();
        tracing::info!("cetus: update {v} available — installing in background");
        match update.download_and_install(|_, _| {}, || {}).await {
            Ok(_) => tracing::info!("cetus: update {v} installed; applies on next launch"),
            Err(e) => tracing::warn!("cetus: update install failed: {e}"),
        }
        return;
    }

    // Auto off: passive notify, unless this exact version was dismissed before.
    let ignored = app
        .state::<AppState>()
        .store
        .get_setting(IGNORED_KEY)
        .ok()
        .flatten();
    if ignored.as_deref() == Some(update.version.as_str()) {
        return;
    }
    let _ = app.emit_to(
        "main",
        "update-available",
        UpdateMeta {
            version: update.version.clone(),
            current_version: update.current_version.clone(),
            notes: update.body.clone(),
        },
    );
}

#[cfg(debug_assertions)]
pub async fn startup_check(_app: AppHandle, _auto: bool) {}

/// Manual check, for the Settings button. Returns the available update's
/// metadata, or `None` if already up to date (or in a dev build).
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<UpdateMeta>, String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        return Ok(None);
    }
    #[cfg(not(debug_assertions))]
    {
        use tauri_plugin_updater::UpdaterExt;
        let updater = app.updater().map_err(|e| e.to_string())?;
        match updater.check().await.map_err(|e| e.to_string())? {
            Some(u) => Ok(Some(UpdateMeta {
                version: u.version.clone(),
                current_version: u.current_version.clone(),
                notes: u.body.clone(),
            })),
            None => Ok(None),
        }
    }
}

/// Download + install the available update (applies on next launch). Re-checks
/// internally so it's safe to call from either the toast or the button.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        return Err("updates are disabled in development builds".into());
    }
    #[cfg(not(debug_assertions))]
    {
        use std::sync::{
            atomic::{AtomicU64, Ordering},
            Arc,
        };
        use tauri::Emitter;
        use tauri_plugin_updater::UpdaterExt;

        let updater = app.updater().map_err(|e| e.to_string())?;
        let update = updater
            .check()
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "no update available".to_string())?;
        let downloaded = Arc::new(AtomicU64::new(0));
        let total = Arc::new(AtomicU64::new(0));
        let progress_app = app.clone();
        let progress_downloaded = Arc::clone(&downloaded);
        let progress_total = Arc::clone(&total);
        let _ = app.emit_to(
            "main",
            "update-download-progress",
            UpdateDownloadProgress {
                downloaded: 0,
                total: None,
                finished: false,
            },
        );
        update
            .download_and_install(
                move |chunk_len, content_len| {
                    let next = progress_downloaded
                        .fetch_add(chunk_len as u64, Ordering::Relaxed)
                        + chunk_len as u64;
                    if let Some(content_len) = content_len {
                        progress_total.store(content_len, Ordering::Relaxed);
                    }
                    let known_total = progress_total.load(Ordering::Relaxed);
                    let _ = progress_app.emit_to(
                        "main",
                        "update-download-progress",
                        UpdateDownloadProgress {
                            downloaded: next,
                            total: (known_total > 0).then_some(known_total),
                            finished: false,
                        },
                    );
                },
                || {},
            )
            .await
            .map_err(|e| e.to_string())?;
        let total_value = total.load(Ordering::Relaxed);
        let _ = app.emit_to(
            "main",
            "update-download-progress",
            UpdateDownloadProgress {
                downloaded: downloaded.load(Ordering::Relaxed),
                total: (total_value > 0).then_some(total_value),
                finished: true,
            },
        );
        Ok(())
    }
}

/// Remember a version the user dismissed so the passive toast won't nag again
/// until a newer one ships.
#[tauri::command]
pub async fn ignore_update_version(
    state: tauri::State<'_, AppState>,
    version: String,
) -> Result<(), String> {
    state
        .store
        .set_setting(IGNORED_KEY, &version)
        .map_err(|e| e.to_string())
}
