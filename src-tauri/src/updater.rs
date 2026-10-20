//! In-app self-update: the startup check plus the manual commands behind the
//! Settings "Check for updates" button and the passive "update available"
//! toast.
//!
//! With auto-update on, a downloaded update is applied without asking: on the
//! next quit, or by a quiet relaunch once the user has stepped away and nothing
//! is running (see [`spawn_idle_restart`]). The sidebar "Restart to update"
//! button only appears when that can't happen on its own.
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
/// Persisted by builds that swapped the bundle the moment a download finished.
/// Only read now to clear a stale value.
#[cfg(not(debug_assertions))]
const LEGACY_READY_KEY: &str = "updater_ready_version";
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
/// How often the idle restart looks for a quiet moment.
#[cfg(all(not(debug_assertions), target_os = "macos"))]
const IDLE_POLL_INTERVAL: Duration = Duration::from_secs(60);
/// No keyboard or mouse input for this long counts as "stepped away".
#[cfg(all(not(debug_assertions), target_os = "macos"))]
const IDLE_RESTART_AFTER: Duration = Duration::from_secs(10 * 60);
/// Don't restart this close to a scheduled automation; let it run first.
#[cfg(all(not(debug_assertions), target_os = "macos"))]
const AUTOMATION_GUARD: Duration = Duration::from_secs(5 * 60);
/// An auto-update still waiting after this long (the user never stepped away
/// while things were quiet) falls back to the sidebar "Restart to update".
#[cfg(not(debug_assertions))]
const PROMPT_AFTER: Duration = Duration::from_secs(24 * 60 * 60);
/// Passed to the relaunched instance so it starts with the main window hidden
/// when it was hidden before.
pub const BACKGROUND_RELAUNCH_ARG: &str = "--background-relaunch";

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
/// A verified package waiting to be installed when the app quits or restarts.
///
/// The swap must not happen while this process is running. Installing moves
/// the running bundle into a temp directory that macOS later deletes. After
/// that, TCC cannot resolve the app as the responsible process for its
/// helpers, so `screencapture` is denied Screen Recording (the screenshot
/// launcher reports a missing permission) and syspolicyd starts killing
/// helper launches. Kept in memory: if the process dies before installing,
/// the next launch simply finds the update again.
#[cfg(not(debug_assertions))]
static PENDING: Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>> = Mutex::new(None);
/// When the pending update finished downloading.
#[cfg(not(debug_assertions))]
static STAGED_AT: Mutex<Option<Instant>> = Mutex::new(None);
/// The pending update has been surfaced as a sidebar "Restart to update".
#[cfg(not(debug_assertions))]
static RESTART_PROMPTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMeta {
    /// The version offered by the release manifest.
    pub version: String,
    /// The version currently running.
    pub current_version: String,
    /// Release notes from the manifest, if any.
    pub notes: Option<String>,
    /// On `update-ready`: show the sidebar "Restart to update" button. False
    /// for a silent auto-update, which applies itself.
    pub prompt_restart: bool,
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
fn pending_version() -> Option<String> {
    PENDING
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(|(u, _)| u.version.clone()))
}

/// Install the downloaded update, if any. Called on the way out (quit or
/// "Restart to update"); a no-op when nothing is pending, so calling it twice
/// is safe.
#[cfg(not(debug_assertions))]
pub fn apply_pending_update() {
    let Some((update, bytes)) = PENDING.lock().ok().and_then(|mut slot| slot.take()) else {
        return;
    };
    match update.install(&bytes) {
        Ok(()) => tracing::info!("cetus: update {} installed", update.version),
        Err(e) => tracing::warn!("cetus: update {} install failed: {e}", update.version),
    }
}

#[cfg(debug_assertions)]
pub fn apply_pending_update() {}

/// Drop the ready marker an older build left behind.
#[cfg(not(debug_assertions))]
pub fn clear_legacy_ready_marker(app: &AppHandle) {
    let _ = app
        .state::<AppState>()
        .store
        .delete_setting(LEGACY_READY_KEY);
}

/// Download the update, verify it and hold it for [`apply_pending_update`], reporting throttled
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
    prompt_restart: bool,
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
        .download(
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

    let bytes = match outcome {
        Ok(bytes) => bytes,
        Err(e) => {
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
    };

    if let Ok(mut slot) = PENDING.lock() {
        *slot = Some((update.clone(), bytes));
    }
    if let Ok(mut at) = STAGED_AT.lock() {
        *at = Some(Instant::now());
    }
    RESTART_PROMPTED.store(prompt_restart, Ordering::SeqCst);
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
    // Settings flips to "ready" either way; the sidebar button only shows when
    // the user asked for this download (a silent one restarts by itself).
    let _ = app.emit_to(
        "main",
        "update-ready",
        UpdateMeta {
            version: update.version.clone(),
            current_version: update.current_version.clone(),
            notes: update.body.clone(),
            prompt_restart,
        },
    );
    Ok(true)
}

/// Surface the pending update as a sidebar "Restart to update", once.
#[cfg(not(debug_assertions))]
fn prompt_restart(app: &AppHandle) {
    use tauri::Emitter;

    if RESTART_PROMPTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(meta) = PENDING.lock().ok().and_then(|slot| {
        slot.as_ref().map(|(u, _)| UpdateMeta {
            version: u.version.clone(),
            current_version: u.current_version.clone(),
            notes: u.body.clone(),
            prompt_restart: true,
        })
    }) else {
        return;
    };
    let _ = app.emit_to("main", "update-ready", meta);
}

/// Background check at launch.
///
/// - auto on  → download silently; installs on the next quit or an idle
///   relaunch, no nag.
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
            return;
        }
        Err(e) => {
            tracing::warn!("cetus: update check failed: {e}");
            return;
        }
    };

    // Already downloaded and waiting for a restart: the persistent sidebar
    // affordance is the only prompt we need; re-downloading it or emitting
    // another passive toast would duplicate that state.
    if pending_version().as_deref() == Some(update.version.as_str()) {
        return;
    }

    if auto {
        let v = update.version.clone();
        tracing::info!("cetus: update {v} available — installing in background");
        match download_update(&app, &update, false).await {
            Ok(true) => {
                tracing::info!("cetus: update {v} downloaded; installs on quit or when idle");
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
                        prompt_restart: false,
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
            prompt_restart: false,
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
                prompt_restart: false,
            })),
            None => Ok(None),
        }
    }
}

/// Download the available update (installs on the next quit or restart). Re-checks
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
        download_update(&app, &update, true).await
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
        let _ = app;
        Ok(pending_version())
    }
}

/// Version of a downloaded update the sidebar should offer to restart for, if
/// any. Unlike [`pending_update_version`] this stays `None` while a silent
/// auto-update is still waiting for an idle moment.
#[tauri::command]
pub async fn pending_restart_prompt(app: AppHandle) -> Result<Option<String>, String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        Ok(None)
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = app;
        Ok(pending_version().filter(|_| RESTART_PROMPTED.load(Ordering::SeqCst)))
    }
}

/// Watch for a quiet moment to apply a silently downloaded update: the user
/// has been away from the keyboard for [`IDLE_RESTART_AFTER`] and Cetus has
/// nothing in flight that a restart would cut down. Then install and relaunch
/// in the background, keeping the main window hidden if it was.
///
/// macOS only: on Windows applying the update runs an installer the user sees.
#[cfg(all(not(debug_assertions), target_os = "macos"))]
pub fn spawn_idle_restart(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(IDLE_POLL_INTERVAL).await;
            let Some(version) = pending_version() else {
                continue;
            };
            let auto = quick::load_settings(&app.state::<AppState>().store).auto_update;
            let stale = STAGED_AT
                .lock()
                .ok()
                .and_then(|at| *at)
                .is_some_and(|at| at.elapsed() >= PROMPT_AFTER);
            if !auto || stale {
                prompt_restart(&app);
            }
            if !auto {
                continue;
            }
            if crate::ax::seconds_since_last_input() < IDLE_RESTART_AFTER.as_secs_f64() {
                continue;
            }
            if let Some(reason) = busy_reason(&app).await {
                tracing::debug!("cetus: update {version} waiting — {reason}");
                continue;
            }
            tracing::info!("cetus: user idle and nothing running — applying update {version}");
            relaunch(&app, true);
            return;
        }
    });
}

#[cfg(not(all(not(debug_assertions), target_os = "macos")))]
#[allow(dead_code)]
pub fn spawn_idle_restart(_app: AppHandle) {}

/// What a restart right now would interrupt, if anything.
#[cfg(all(not(debug_assertions), target_os = "macos"))]
async fn busy_reason(app: &AppHandle) -> Option<&'static str> {
    let state = app.state::<AppState>();
    if state.any_turn_active().await {
        return Some("an agent turn is running");
    }
    if app
        .state::<crate::meeting::MeetingRuntime>()
        .is_capturing()
        .await
    {
        return Some("a meeting is being recorded");
    }
    if state.dictation.is_active().await {
        return Some("dictation is active");
    }
    if app
        .state::<crate::terminal::TerminalRuntime>()
        .has_foreground_job()
    {
        return Some("a terminal command is running");
    }
    let horizon = crate::store::now_ms() + AUTOMATION_GUARD.as_millis() as i64;
    let automation_due = state
        .store
        .list_automations()
        .map(|autos| {
            autos
                .iter()
                .any(|a| a.enabled && a.next_run_at.is_some_and(|t| t <= horizon))
        })
        // Can't tell: wait rather than risk skipping a run.
        .unwrap_or(true);
    if automation_due {
        return Some("an automation is about to run");
    }
    None
}

/// Relaunch the app to apply a downloaded update: install it, then restart so
/// the new bundle boots. Drives the sidebar's "Restart to update" button.
///
/// On macOS this must NOT be Tauri's `app.restart()`: that is a bare
/// `Command::new(current_exe).spawn()`, so the new process is not launched by
/// LaunchServices. RunningBoard then tracks it as `anon<cetus>` instead of
/// `app<dev.cetus.app>`, and AppKit's out-of-process view services refuse to
/// attach to it (tccd: `bundleRecordForAuditToken failed -10814`). Symptoms:
/// open/save panels never appear — a crash in 2026-08 and an invisible-modal
/// freeze in 2026-09. Relaunching through `/usr/bin/open` yields a properly
/// LS-owned instance. The helper waits for this process to be gone first so
/// the new one does not race us for the control socket and remote port.
#[tauri::command]
pub fn relaunch_app(app: AppHandle) {
    relaunch(&app, false);
}

/// `background`: an unattended relaunch (the idle update restart). The new
/// instance opens without taking focus, and with its main window hidden if it
/// was hidden here.
fn relaunch(app: &AppHandle, background: bool) {
    apply_pending_update();
    #[cfg(target_os = "macos")]
    {
        if let Some(bundle) = macos_bundle_path() {
            let pid = std::process::id();
            // `-g`: don't pull focus from whatever the user comes back to.
            // `--args` reaches the new process only because we wait for this
            // one to exit first, so `open` launches rather than activates.
            let open_cmd = match (background, background && main_window_hidden(app)) {
                (false, _) => "exec /usr/bin/open \"$0\"".to_string(),
                (true, false) => "exec /usr/bin/open -g \"$0\"".to_string(),
                (true, true) => {
                    format!("exec /usr/bin/open -g \"$0\" --args {BACKGROUND_RELAUNCH_ARG}")
                }
            };
            // Poll for up to ~30 s, then open regardless (if we are somehow
            // still alive, `open` without `-n` just activates us — no second
            // instance).
            let script = format!(
                "i=0; while kill -0 {pid} 2>/dev/null && [ \"$i\" -lt 150 ]; do sleep 0.2; i=$((i+1)); done; {open_cmd}"
            );
            let spawned = std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(&script)
                .arg(&bundle)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn();
            match spawned {
                Ok(_) => {
                    tracing::info!(
                        "cetus: relaunching via LaunchServices: {}",
                        bundle.display()
                    );
                    app.exit(0);
                    return;
                }
                Err(e) => {
                    tracing::warn!("cetus: relaunch helper failed to spawn ({e}); falling back to app.restart()");
                }
            }
        }
    }
    app.restart();
}

/// The main window is parked or hidden, i.e. the user isn't looking at Cetus.
#[cfg(target_os = "macos")]
fn main_window_hidden(app: &AppHandle) -> bool {
    use tauri::Manager;
    crate::main_is_parked()
        || !app
            .get_webview_window("main")
            .and_then(|w| w.is_visible().ok())
            .unwrap_or(false)
}

/// `/path/to/Cetus.app` for a bundled build; `None` under `tauri dev` (the
/// binary lives in target/) or any other layout.
#[cfg(target_os = "macos")]
fn macos_bundle_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    // Contents/MacOS/cetus → Contents/MacOS → Contents → Cetus.app
    let bundle = exe.parent()?.parent()?.parent()?;
    (bundle.extension().and_then(|e| e.to_str()) == Some("app")).then(|| bundle.to_path_buf())
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
