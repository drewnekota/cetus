//! In-app self-update: the startup check plus the manual commands behind the
//! Settings "Check for updates" button and the passive "update available"
//! toast.
//!
//! Real behavior is **release-only**: the updater plugin is registered only in
//! release builds (see `lib.rs`), and `app.updater()` needs that registration.
//! In debug everything no-ops / errors politely so `tauri dev` is never touched.

#[cfg(not(debug_assertions))]
use crate::quick;
use crate::AppState;
use serde::Serialize;
#[cfg(not(debug_assertions))]
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
#[cfg(not(debug_assertions))]
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
#[cfg(not(debug_assertions))]
use tauri::Manager;

/// Store key holding the one update version the user dismissed from the passive
/// toast. We re-prompt only once a *newer* version than this ships.
const IGNORED_KEY: &str = "updater_ignored_version";
#[cfg(not(debug_assertions))]
const READY_KEY: &str = "updater_ready_version";
#[cfg(not(debug_assertions))]
const LAST_CHECK_KEY: &str = "updater_last_check_secs";
#[cfg(not(debug_assertions))]
const FOCUS_CHECK_MIN_INTERVAL: Duration = Duration::from_secs(15 * 60);
#[cfg(not(debug_assertions))]
const PERIODIC_CHECK_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// Progress is forwarded to the webview at most this often. The package is ~60 MB
/// and arrives in thousands of chunks; emitting one IPC message per chunk floods
/// the main thread badly enough that the percentage the user sees lags minutes
/// behind the socket — which reads as "stuck".
#[cfg(not(debug_assertions))]
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(200);

/// One download at a time, process-wide.
///
/// The startup check, the on-focus check, the hourly check and the Settings
/// button all funnel through `download_update`. On a slow link a download takes
/// longer than those intervals, so without this guard the next check restarts it
/// from zero while the first is still running: N downloads then split the same
/// bandwidth and none of them ever finishes.
#[cfg(not(debug_assertions))]
static DOWNLOADING: AtomicBool = AtomicBool::new(false);
/// Last progress reported by the in-flight download, so a UI that mounts (or
/// remounts) mid-download can pick it up instead of showing a fresh idle state.
#[cfg(not(debug_assertions))]
static PROGRESS: Mutex<Option<UpdateDownloadProgress>> = Mutex::new(None);

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
#[cfg_attr(debug_assertions, allow(dead_code))]
#[serde(rename_all = "camelCase")]
pub struct UpdateDownloadProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
    /// The download completed and the swap is staged.
    pub finished: bool,
    /// The download ended without staging anything (network, signature, install).
    pub failed: bool,
    /// Version being fetched, for UI that outlives the surface that started it.
    pub version: Option<String>,
}

/// Held for the lifetime of a download; releases `DOWNLOADING` on every exit
/// path, including the error and cancellation ones.
#[cfg(not(debug_assertions))]
struct DownloadGuard;

#[cfg(not(debug_assertions))]
impl DownloadGuard {
    /// `None` when another download already holds the slot.
    fn acquire() -> Option<Self> {
        (!DOWNLOADING.swap(true, Ordering::SeqCst)).then_some(Self)
    }
}

#[cfg(not(debug_assertions))]
impl Drop for DownloadGuard {
    fn drop(&mut self) {
        store_progress(None);
        DOWNLOADING.store(false, Ordering::SeqCst);
    }
}

#[cfg(not(debug_assertions))]
fn store_progress(progress: Option<UpdateDownloadProgress>) {
    if let Ok(mut slot) = PROGRESS.lock() {
        *slot = progress;
    }
}

#[cfg(not(debug_assertions))]
fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(not(debug_assertions))]
fn current_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

#[cfg(not(debug_assertions))]
fn mark_check_started(app: &AppHandle) {
    let _ = app
        .state::<AppState>()
        .store
        .set_setting(LAST_CHECK_KEY, &now_secs().to_string());
}

#[cfg(not(debug_assertions))]
fn recently_checked(app: &AppHandle, min_interval: Duration) -> bool {
    let last = app
        .state::<AppState>()
        .store
        .get_setting(LAST_CHECK_KEY)
        .ok()
        .flatten()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    now_secs().saturating_sub(last) < min_interval.as_secs()
}

#[cfg(not(debug_assertions))]
fn remember_ready(app: &AppHandle, version: &str) {
    let _ = app
        .state::<AppState>()
        .store
        .set_setting(READY_KEY, version);
}

#[cfg(not(debug_assertions))]
fn clear_ready_if_applied(app: &AppHandle) {
    let current = current_version(app);
    let ready = app
        .state::<AppState>()
        .store
        .get_setting(READY_KEY)
        .ok()
        .flatten();
    if ready.as_deref() == Some(current.as_str()) {
        let _ = app.state::<AppState>().store.delete_setting(READY_KEY);
    }
}

/// Download the update, verify it and stage the swap, reporting throttled
/// progress to the main window the whole way.
///
/// `Ok(false)` means another download is already in flight and this call was a
/// no-op — the running one emits progress and `update-ready` for every caller,
/// so a second click (or a background check landing mid-download) just attaches
/// to it instead of starting a competing transfer.
#[cfg(not(debug_assertions))]
async fn download_update(
    app: &AppHandle,
    update: &tauri_plugin_updater::Update,
) -> Result<bool, String> {
    use tauri::Emitter;

    let Some(_guard) = DownloadGuard::acquire() else {
        tracing::info!(
            "cetus: update download already running — attaching instead of restarting it"
        );
        return Ok(false);
    };

    let version = update.version.clone();
    let started = UpdateDownloadProgress {
        downloaded: 0,
        total: None,
        finished: false,
        failed: false,
        version: Some(version.clone()),
    };
    store_progress(Some(started.clone()));
    let _ = app.emit_to("main", "update-download-progress", started);

    let mut downloaded: u64 = 0;
    let mut total: Option<u64> = None;
    let mut last_emit: Option<Instant> = None;
    let outcome = update
        .download_and_install(
            |chunk_len, content_len| {
                downloaded += chunk_len as u64;
                if content_len.is_some() {
                    total = content_len;
                }
                let snapshot = UpdateDownloadProgress {
                    downloaded,
                    total,
                    finished: false,
                    failed: false,
                    version: Some(version.clone()),
                };
                // Always record — a Settings panel that mounts between emits
                // still reads a current number.
                store_progress(Some(snapshot.clone()));
                if last_emit.is_none_or(|at| at.elapsed() >= PROGRESS_EMIT_INTERVAL) {
                    last_emit = Some(Instant::now());
                    let _ = app.emit_to("main", "update-download-progress", snapshot);
                }
            },
            || {},
        )
        .await;

    if let Err(e) = outcome {
        let _ = app.emit_to(
            "main",
            "update-download-progress",
            UpdateDownloadProgress {
                downloaded,
                total,
                finished: false,
                failed: true,
                version: Some(version.clone()),
            },
        );
        return Err(e.to_string());
    }

    remember_ready(app, &version);
    let _ = app.emit_to(
        "main",
        "update-download-progress",
        UpdateDownloadProgress {
            downloaded,
            total,
            finished: true,
            failed: false,
            version: Some(version.clone()),
        },
    );
    // Surface a persistent "Restart to update" affordance in the sidebar so the
    // user can apply it now instead of waiting for a stray relaunch.
    let _ = app.emit_to(
        "main",
        "update-ready",
        UpdateMeta {
            version: update.version.clone(),
            current_version: update.current_version.clone(),
            notes: update.body.clone(),
        },
    );
    Ok(true)
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
    check_once(app, auto).await;
}

#[cfg(not(debug_assertions))]
async fn check_once(app: AppHandle, auto: bool) {
    use tauri::{Emitter, Manager};
    use tauri_plugin_updater::UpdaterExt;

    mark_check_started(&app);
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
            clear_ready_if_applied(&app);
            return;
        }
        Err(e) => {
            tracing::warn!("cetus: update check failed: {e}");
            return;
        }
    };

    // The updater still reports this version as available until the process
    // relaunches into the swapped bundle. If it is already on disk, the
    // persistent sidebar affordance is the only prompt we need; re-downloading
    // it or emitting another passive toast would duplicate that state.
    let ready = app
        .state::<AppState>()
        .store
        .get_setting(READY_KEY)
        .ok()
        .flatten();
    if ready.as_deref() == Some(update.version.as_str()) {
        return;
    }

    if auto {
        let v = update.version.clone();
        tracing::info!("cetus: update {v} available — installing in background");
        match download_update(&app, &update).await {
            Ok(true) => {
                tracing::info!("cetus: update {v} installed; applies on next launch");
            }
            Ok(false) => {
                tracing::debug!("cetus: update {v} already downloading");
            }
            Err(e) => {
                tracing::warn!("cetus: update install failed: {e}");
                // Do not fail silently. A network/signature/transient install
                // error should still leave the user with a visible manual path.
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
#[allow(dead_code)]
pub async fn startup_check(_app: AppHandle, _auto: bool) {}

#[cfg(not(debug_assertions))]
pub fn spawn_periodic_checks(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(PERIODIC_CHECK_INTERVAL).await;
            let auto = quick::load_settings(&app.state::<AppState>().store).auto_update;
            check_once(app.clone(), auto).await;
        }
    });
}

#[cfg(debug_assertions)]
#[allow(dead_code)]
pub fn spawn_periodic_checks(_app: AppHandle) {}

#[cfg(not(debug_assertions))]
pub fn check_after_focus(app: AppHandle) {
    if recently_checked(&app, FOCUS_CHECK_MIN_INTERVAL) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let auto = quick::load_settings(&app.state::<AppState>().store).auto_update;
        check_once(app, auto).await;
    });
}

#[cfg(debug_assertions)]
pub fn check_after_focus(_app: AppHandle) {}

/// Manual check, for the Settings button. Returns the available update's
/// metadata, or `None` if already up to date (or in a dev build).
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<UpdateMeta>, String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        Ok(None)
    }
    #[cfg(not(debug_assertions))]
    {
        use tauri_plugin_updater::UpdaterExt;
        mark_check_started(&app);
        let updater = app.updater().map_err(|e| e.to_string())?;
        match updater.check().await.map_err(|e| e.to_string())? {
            Some(u) => Ok(Some(UpdateMeta {
                version: u.version.clone(),
                current_version: u.current_version.clone(),
                notes: u.body.clone(),
            })),
            None => {
                clear_ready_if_applied(&app);
                Ok(None)
            }
        }
    }
}

/// Download + install the available update (applies on next launch). Re-checks
/// internally so it's safe to call from either the toast or the button.
///
/// Resolves to `false` when a download (a background one, or one started from
/// another surface) was already running: nothing new was started and the caller
/// should keep showing progress until `update-ready` arrives.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<bool, String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        Err("updates are disabled in development builds".into())
    }
    #[cfg(not(debug_assertions))]
    {
        use tauri_plugin_updater::UpdaterExt;

        // A download already in flight has the package (and its version) in
        // hand; re-checking first would just add a network round trip before
        // discovering that.
        if DOWNLOADING.load(Ordering::SeqCst) {
            return Ok(false);
        }
        let updater = app.updater().map_err(|e| e.to_string())?;
        let update = updater
            .check()
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "no update available".to_string())?;
        download_update(&app, &update).await
    }
}

/// Progress of the download currently in flight, if any. Lets a surface that
/// mounts mid-download (the Settings panel is unmounted whenever another section
/// is open) pick the transfer back up instead of showing an idle state.
#[tauri::command]
pub async fn update_download_progress(
    app: AppHandle,
) -> Result<Option<UpdateDownloadProgress>, String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        Ok(None)
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = app;
        Ok(PROGRESS.lock().ok().and_then(|slot| slot.clone()))
    }
}

/// Version of an update already downloaded and waiting for relaunch, if any.
#[tauri::command]
pub async fn pending_update_version(app: AppHandle) -> Result<Option<String>, String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        Ok(None)
    }
    #[cfg(not(debug_assertions))]
    {
        let store = &app.state::<AppState>().store;
        let ready = store.get_setting(READY_KEY).map_err(|e| e.to_string())?;
        if ready.as_deref() == Some(current_version(&app).as_str()) {
            store.delete_setting(READY_KEY).map_err(|e| e.to_string())?;
            return Ok(None);
        }
        Ok(ready)
    }
}

/// Relaunch the app to apply a downloaded update. The updater swaps the bundle
/// in place, so a plain restart boots the new version. Drives the sidebar's
/// "Restart to update" button.
#[tauri::command]
pub fn relaunch_app(app: AppHandle) {
    app.restart();
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
