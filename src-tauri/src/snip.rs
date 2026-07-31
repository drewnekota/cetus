//! Region-select ("snip") capture for the contextful quick launcher.
//!
//! The contextful gesture no longer shoots the full screen immediately: it
//! presents a transparent overlay covering the cursor's screen where the user
//! drags out the region to capture. A plain click falls back to the full
//! screen, Esc cancels. macOS `screencapture -i` can't express "click = full
//! screen", hence the custom overlay; the actual pixels still come from
//! `screencapture -R` after the overlay is hidden, so the capture pipeline
//! (native grab → sips → base64 → `quick-open`) is unchanged.

use crate::quick;
use crate::AppState;
use serde::Deserialize;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, State};
#[cfg(target_os = "macos")]
use tauri::Emitter;

/// Selection reported by the overlay webview: CSS pixels (== AppKit points),
/// top-left origin, relative to the overlay window (which covers one screen).
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct SnipRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Carried from [`begin`] to [`snip_finish`] across the overlay interaction.
pub struct SnipStash {
    /// Overlay frame in CG global display coordinates (top-left origin,
    /// points) — the space `screencapture -R` expects. Selection offsets from
    /// the webview add directly onto this origin.
    pub frame_cg: (f64, f64, f64, f64),
    /// Pre-focus ambient context gathered before the overlay took key focus.
    pub context: Option<crate::ocr::AmbientContext>,
}

/// Enter region-select mode: gather pre-focus context, cover the mouse screen
/// with the overlay, and wait for the webview to report a selection (or a
/// cancel). Invoked by the contextful gesture instead of an immediate
/// full-screen `open_panel`.
pub async fn begin(app: &AppHandle) {
    #[cfg(not(target_os = "macos"))]
    {
        // No overlay machinery off macOS — degrade to the old contextful open.
        quick::open_panel(app, true).await;
    }
    #[cfg(target_os = "macos")]
    {
        {
            let state = app.state::<AppState>();
            if state.quick.recapturing.load(Ordering::Relaxed) {
                return;
            }
            // Second gesture while the overlay is up cancels the snip; while
            // the panel is up it dismisses the panel — both are the same
            // "toggle off" the plain gesture has.
            if state.quick.snip_active.load(Ordering::Relaxed) {
                cancel(app);
                return;
            }
            if state.quick.shown.load(Ordering::Relaxed) {
                quick::park_quick(app);
                return;
            }
        }
        // Without Screen Recording there is nothing to select; the plain
        // contextful open shows the grant-permission hint.
        if !quick::screen_recording_granted() {
            quick::open_panel(app, true).await;
            return;
        }
        let Some(win) = app.get_webview_window("snip") else {
            return;
        };
        // Pre-focus ambient context, same contract as `open_panel`: gathered
        // before our overlay takes key so it reflects the app the user was in.
        let context = tauri::async_runtime::spawn_blocking(crate::ax::gather_pre_focus_context)
            .await
            .ok()
            .flatten();
        app.state::<AppState>()
            .quick
            .snip_active
            .store(true, Ordering::Relaxed);
        let app_for_main = app.clone();
        let _ = app.run_on_main_thread(move || {
            let state = app_for_main.state::<AppState>();
            // Same dance as `open_panel`: presenting un-hides a Cmd+H-hidden
            // app; push the main window back out if it wasn't showing.
            let main = app_for_main.get_webview_window("main");
            let main_was_visible = main
                .as_ref()
                .and_then(|m| m.is_visible().ok())
                .unwrap_or(false);
            let Some(w) = app_for_main.get_webview_window("snip") else {
                state.quick.snip_active.store(false, Ordering::Relaxed);
                return;
            };
            let Ok(ptr) = w.ns_window() else {
                state.quick.snip_active.store(false, Ordering::Relaxed);
                return;
            };
            let Some(frame_cg) = crate::panel::cover_mouse_screen(ptr) else {
                state.quick.snip_active.store(false, Ordering::Relaxed);
                return;
            };
            if let Ok(mut stash) = state.quick.snip_stash.lock() {
                *stash = Some(SnipStash { frame_cg, context });
            }
            crate::panel::present(ptr);
            if !main_was_visible {
                if let Some(p) = main.as_ref().and_then(|m| m.ns_window().ok()) {
                    crate::panel::order_out(p);
                }
            }
            // The overlay covers only the cursor's screen and is key, so its
            // own clicks never reach this global monitor — but a click on
            // another display (delivered to another app) cancels the snip,
            // matching the launcher's click-outside dismiss.
            let app_for_monitor = app_for_main.clone();
            crate::panel::install_outside_click_monitor(move || {
                cancel(&app_for_monitor);
            });
        });
        let _ = win.emit("snip-open", serde_json::json!({}));
    }
}

/// Tear the overlay down without capturing (Esc, outside click, or a
/// conflicting gesture).
pub(crate) fn cancel(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.quick.snip_active.store(false, Ordering::Relaxed);
    if let Ok(mut stash) = state.quick.snip_stash.lock() {
        stash.take();
    }
    hide_overlay(app);
}

fn hide_overlay(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            crate::panel::remove_outside_click_monitor();
            if let Some(w) = app2.get_webview_window("snip") {
                if let Ok(ptr) = w.ns_window() {
                    crate::panel::order_out(ptr);
                }
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(w) = app.get_webview_window("snip") {
            let _ = w.hide();
        }
    }
}

/// The overlay reports its selection: `rect` bounds the capture, `None` (a
/// plain click) means the full screen. Hides the overlay, captures via
/// `screencapture -R`, then opens the launcher with the shot attached.
#[tauri::command]
pub async fn snip_finish(
    app: AppHandle,
    state: State<'_, AppState>,
    rect: Option<SnipRect>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // `swap` makes a double-fire (e.g. pointer-up racing Esc) a no-op.
        if !state.quick.snip_active.swap(false, Ordering::Relaxed) {
            return Ok(());
        }
        let stash = state
            .quick
            .snip_stash
            .lock()
            .ok()
            .and_then(|mut s| s.take());
        hide_overlay(&app);
        let Some(stash) = stash else {
            return Ok(());
        };
        // Blocks the gesture listener from popping a launcher over the
        // capture gap, exactly like `quick_recapture_screenshot`.
        let recapturing = state.quick.recapturing.clone();
        recapturing.store(true, Ordering::Relaxed);
        // Window order-out is async; give the compositor room to drop the dim
        // overlay before shooting so it isn't baked into the capture.
        tokio::time::sleep(std::time::Duration::from_millis(220)).await;
        let (fx, fy, fw, fh) = stash.frame_cg;
        let region = match rect {
            Some(r) => {
                // Clamp the selection into the overlay's frame; a degenerate
                // rect still captures at least one point.
                let x = r.x.max(0.0).min(fw - 1.0);
                let y = r.y.max(0.0).min(fh - 1.0);
                let w = r.w.clamp(1.0, fw - x);
                let h = r.h.clamp(1.0, fh - y);
                (fx + x, fy + y, w, h)
            }
            None => (fx, fy, fw, fh),
        };
        let shot = tauri::async_runtime::spawn_blocking(move || {
            quick::capture_screenshot_region(Some(region))
        })
        .await
        .ok()
        .flatten();
        recapturing.store(false, Ordering::Relaxed);
        quick::present_launcher(&app, shot, stash.context, true).await;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state, rect);
        Ok(())
    }
}

/// Esc pressed in the overlay.
#[tauri::command]
pub async fn snip_cancel(app: AppHandle) -> Result<(), String> {
    cancel(&app);
    Ok(())
}
