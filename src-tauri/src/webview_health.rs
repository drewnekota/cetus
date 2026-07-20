//! Main-WKWebView wake-up and health monitoring.
//!
//! A frontend heartbeat lets the native focus path distinguish "the window is
//! visible" from "the web content event loop actually resumed". A missed beat
//! after focus gets one bounded UI reload; the WebContent termination callback
//! in `lib.rs` covers the harder process-crash case.

use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, WebviewWindow};

static LAST_HEARTBEAT_MS: AtomicI64 = AtomicI64::new(0);
static FOCUS_WATCHDOG_EPOCH: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[tauri::command]
pub fn webview_heartbeat(window: WebviewWindow, sequence: u64) -> u64 {
    if window.label() == "main" {
        LAST_HEARTBEAT_MS.store(now_ms(), Ordering::Release);
    }
    sequence
}

/// Idempotent wake repair used on both DOM and native focus transitions.
#[tauri::command]
pub fn wake_main_webview(window: WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    if let Ok(ptr) = window.ns_window() {
        crate::panel::enable_mouse_events(ptr);
        crate::panel::rearm_web_input(ptr);
        crate::panel::refresh_webview_tracking(ptr);
    }
    // Create a fresh compositing property for two frames without a visible
    // flash. This wakes a resumed WebKit layer that has not submitted a frame.
    window
        .eval(
            "document.documentElement.classList.add('webview-repaint');\
             requestAnimationFrame(() => requestAnimationFrame(() => {\
               document.documentElement.classList.remove('webview-repaint');\
             }));",
        )
        .map_err(|e| e.to_string())
}

/// Require a new frontend heartbeat after native focus gain. If WebKit never
/// resumes, reload the persisted UI once. A later focus supersedes this probe.
pub fn arm_focus_watchdog(app: AppHandle) {
    let epoch = FOCUS_WATCHDOG_EPOCH.fetch_add(1, Ordering::AcqRel) + 1;
    let baseline = LAST_HEARTBEAT_MS.load(Ordering::Acquire);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(6)).await;
        if !missed_post_focus_heartbeat(
            epoch,
            FOCUS_WATCHDOG_EPOCH.load(Ordering::Acquire),
            baseline,
            LAST_HEARTBEAT_MS.load(Ordering::Acquire),
        ) {
            return;
        }
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        if !window.is_visible().unwrap_or(false) || !window.is_focused().unwrap_or(false) {
            return;
        }
        tracing::warn!("main WKWebView missed post-focus heartbeat; reloading UI");
        #[cfg(target_os = "macos")]
        {
            let app_for_reset = app.clone();
            let _ = app.run_on_main_thread(move || {
                let Some(window) = app_for_reset.get_webview_window("main") else {
                    return;
                };
                if let Ok(ptr) = window.ns_window() {
                    let reset = crate::panel::reset_web_content_process(ptr);
                    tracing::warn!(
                        reset,
                        "resetting main WebContent process after missed heartbeat"
                    );
                }
                // Reload is intentionally issued even after a process reset;
                // the reset clears state, and this navigation starts the fresh
                // renderer. The termination callback is an idempotent backup.
                let _ = window.reload();
            });
        }
        #[cfg(not(target_os = "macos"))]
        let _ = window.reload();
    });
}

fn missed_post_focus_heartbeat(
    expected_epoch: u64,
    current_epoch: u64,
    baseline_ms: i64,
    latest_ms: i64,
) -> bool {
    expected_epoch == current_epoch && latest_ms <= baseline_ms
}

#[cfg(test)]
mod tests {
    use super::missed_post_focus_heartbeat;

    #[test]
    fn heartbeat_after_focus_cancels_reload() {
        assert!(!missed_post_focus_heartbeat(4, 4, 100, 101));
    }

    #[test]
    fn newer_focus_supersedes_older_watchdog() {
        assert!(!missed_post_focus_heartbeat(4, 5, 100, 100));
        assert!(missed_post_focus_heartbeat(5, 5, 100, 100));
    }
}
