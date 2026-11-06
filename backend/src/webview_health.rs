//! Frontend heartbeat + wake hooks.
//!
//! These existed to nurse WKWebView back to life after long idles (stale
//! first responder, discarded backing stores, a WebContent process that never
//! resumed). Chromium under Electron doesn't have those failure modes, so the
//! commands are kept for the frontend's sake but only do the cheap,
//! engine-agnostic part. Renderer crashes are handled by the Electron main
//! process (`render-process-gone` → reload).

use host::WebviewWindow;

#[host::command]
pub fn webview_heartbeat(window: WebviewWindow, sequence: u64) -> u64 {
    let _ = window;
    sequence
}

/// Idempotent wake repair used on both DOM and native focus transitions.
#[host::command]
pub fn wake_main_webview(window: WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    if let Ok(ptr) = window.ns_window() {
        crate::panel::enable_mouse_events(ptr);
    }
    Ok(())
}
