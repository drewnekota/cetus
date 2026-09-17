use super::{
    capture_screenshot, load_settings, park_quick, screen_recording_effective, AppHandle, AppState,
    Emitter, Manager, Ordering, Screenshot,
};

// ---- Panel orchestration --------------------------------------------------

/// Center the quick panel on the monitor that currently holds the mouse cursor,
/// not the primary display. Tauri's `center()` centers on the window's current
/// monitor, so on a multi-display setup the launcher would keep popping up on
/// whatever screen it last lived on instead of the one the user is working on.
/// Falls back to `center()` if the cursor or its monitor can't be resolved.
///
/// macOS does this natively in `panel::place_on_mouse_screen` (AppKit cursor
/// tracking, no coordinate-space surprises); this is the cross-platform path.
#[cfg(not(target_os = "macos"))]
pub(super) fn center_on_cursor_monitor(win: &tauri::WebviewWindow) {
    let pos = match win.app_handle().cursor_position() {
        Ok(p) => p,
        Err(_) => {
            let _ = win.center();
            return;
        }
    };
    let monitor = match win.monitor_from_point(pos.x, pos.y) {
        Ok(Some(m)) => m,
        _ => {
            let _ = win.center();
            return;
        }
    };
    let size = match win.outer_size() {
        Ok(s) => s,
        Err(_) => {
            let _ = win.center();
            return;
        }
    };
    let mp = monitor.position();
    let ms = monitor.size();
    let x = mp.x + (ms.width as i32 - size.width as i32) / 2;
    let y = mp.y + (ms.height as i32 - size.height as i32) / 2;
    let _ = win.set_position(tauri::PhysicalPosition::new(x.max(mp.x), y.max(mp.y)));
}

/// Show (or toggle off) the quick panel. Invoked by the native gesture listener.
/// Captures the screen *before* showing so the panel never appears in its own
/// screenshot. `capture` is decided by which gesture fired — the "with
/// screenshot" function passes `true`, the plain one `false`.
pub async fn open_panel(app: &AppHandle, capture: bool) {
    let recapturing = {
        let state = app.state::<AppState>();
        state.quick.recapturing.load(Ordering::Relaxed)
    };
    // Mid re-capture the panel is intentionally hidden — don't treat that as
    // "closed" and pop a fresh panel that would clobber the user's typed text.
    if recapturing {
        return;
    }
    // A stray snip overlay (e.g. plain gesture fired while region-select was
    // up) must come down before the launcher presents over it.
    if app
        .state::<AppState>()
        .quick
        .snip_active
        .load(Ordering::Relaxed)
    {
        crate::snip::cancel(app);
    }
    // A second gesture while the panel is up dismisses it. The window is parked
    // (kept warm, still ordered-in) rather than hidden, so consult the explicit
    // `shown` flag instead of `is_visible()`, which would always read true.
    if app.state::<AppState>().quick.shown.load(Ordering::Relaxed) {
        park_quick(app);
        return;
    }
    // Mark shown before the capture below so a second gesture during the
    // capture's ~300ms dismisses instead of double-opening.
    app.state::<AppState>()
        .quick
        .shown
        .store(true, Ordering::Relaxed);
    // Capture the screenshot AND the *pre-focus* ambient context (frontmost app +
    // selected text) before the panel presents and steals focus — afterwards the
    // frontmost app is cetus itself. Both run concurrently so the context probe
    // hides behind the screenshot's latency. The browser URL is deliberately NOT
    // gathered here: it scripts the browser by bundle id and survives cetus taking
    // focus, so we fetch it asynchronously *after* presenting (below) to keep its
    // AppleScript latency off the panel's first-paint critical path. Context rides
    // only with the screenshot gesture (the "contextful" mode).
    // TEMP timing instrumentation (remove after diagnosis): each probe measures
    // its own wall time so we can see whether the screenshot, the context probe,
    // or neither is what stalls the panel's first paint.
    let cap_started = std::time::Instant::now();
    let (shot, context) = if capture {
        let ctx_task = tauri::async_runtime::spawn_blocking(|| {
            let s = std::time::Instant::now();
            let r = crate::ax::gather_pre_focus_context();
            (r, s.elapsed().as_millis())
        });
        let shot_task = tauri::async_runtime::spawn_blocking(|| {
            let s = std::time::Instant::now();
            let r = capture_screenshot();
            (r, s.elapsed().as_millis())
        });
        let (shot, shot_ms) = shot_task.await.ok().unwrap_or((None, 0));
        let (context, ctx_ms) = ctx_task.await.ok().unwrap_or((None, 0));
        tracing::info!(
            "quick open_panel capture: screenshot={shot_ms}ms context={ctx_ms}ms wall={}ms",
            cap_started.elapsed().as_millis()
        );
        (shot, context)
    } else {
        (None, None)
    };
    present_launcher(app, shot, context, capture).await;
}

/// Launcher geometry at 100% zoom (logical px): a Raycast-proportioned
/// 760×240 box (narrower and taller than a chat composer) whose input region
/// fills the space above the bottom action strip. The height is a floor — the
/// panel reports its real content height (the same 240 floor is baked into its
/// layout) and the window grows downward past it when the draft or attachments
/// need more room. Reply mode is a fixed taller box for the streamed draft plus
/// the captured-input band.
const LAUNCHER_BASE: (f64, f64) = (760.0, 240.0);
pub(super) const REPLY_BASE: (f64, f64) = (760.0, 400.0);
/// Cap so a huge paste can't push the launcher off the screen.
const LAUNCHER_MAX_H: f64 = 640.0;

/// Launcher box: base width × max(base height, reported content height).
fn launcher_size(app: &AppHandle) -> tauri::LogicalSize<f64> {
    let h = app
        .state::<AppState>()
        .quick
        .content_height
        .load(Ordering::Relaxed) as f64;
    let h = h.max(LAUNCHER_BASE.1).min(LAUNCHER_MAX_H);
    scaled_size(app, (LAUNCHER_BASE.0, h))
}

/// Resize in place keeping the top-left corner fixed, so the launcher grows
/// downward like Raycast instead of re-centering (or, on AppKit, growing up).
fn resize_anchored_top(win: &tauri::WebviewWindow, size: tauri::LogicalSize<f64>) {
    let pos = win.outer_position().ok();
    let _ = win.set_size(size);
    if let Some(pos) = pos {
        let _ = win.set_position(pos);
    }
}

/// Scale a base size by the main window's zoom so the panel grows with ⌘+.
pub(super) fn scaled_size(app: &AppHandle, base: (f64, f64)) -> tauri::LogicalSize<f64> {
    let pct = app
        .state::<AppState>()
        .quick
        .scale_pct
        .load(Ordering::Relaxed);
    let f = (pct.clamp(50, 200) as f64) / 100.0;
    tauri::LogicalSize::new((base.0 * f).round(), (base.1 * f).round())
}

/// The panel reports the shared ⌘+/⌘− zoom level here (it mirrors the main
/// window's `cetus:zoom` localStorage key). If the launcher is up, resize in
/// place so the change is visible immediately.
#[tauri::command]
pub async fn quick_set_scale(app: AppHandle, scale: f64) -> Result<(), String> {
    let pct = ((scale * 100.0).round() as u32).clamp(50, 200);
    let state = app.state::<AppState>();
    state.quick.scale_pct.store(pct, Ordering::Relaxed);
    if state.quick.shown.load(Ordering::Relaxed) {
        // A live reply stash means the taller reply surface is what's up.
        let size = if state.quick.reply_stash.lock().unwrap().is_some() {
            scaled_size(&app, REPLY_BASE)
        } else {
            launcher_size(&app)
        };
        if let Some(win) = app.get_webview_window("quick") {
            #[cfg(target_os = "macos")]
            {
                let _ = app.run_on_main_thread(move || {
                    if let Ok(ptr) = win.ns_window() {
                        crate::panel::resize_keep_top_centered(ptr, size.width, size.height);
                    }
                });
            }
            #[cfg(not(target_os = "macos"))]
            resize_anchored_top(&win, size);
        }
    }
    Ok(())
}

/// The launcher reports its natural content height (CSS px, pre-zoom) whenever
/// it changes — more lines typed, an attachment chip added. The window hugs
/// that height, anchored at its top edge. Ignored while the reply surface is
/// up (it has its own fixed geometry).
#[tauri::command]
pub async fn quick_set_content_height(app: AppHandle, height: f64) -> Result<(), String> {
    let h = height.max(0.0).round() as u32;
    let state = app.state::<AppState>();
    if state.quick.content_height.swap(h, Ordering::Relaxed) == h {
        return Ok(());
    }
    if state.quick.shown.load(Ordering::Relaxed)
        && state.quick.reply_stash.lock().unwrap().is_none()
    {
        if let Some(win) = app.get_webview_window("quick") {
            resize_anchored_top(&win, launcher_size(&app));
        }
    }
    Ok(())
}

/// Present the launcher with an already-captured screenshot + pre-focus
/// context. Shared tail of [`open_panel`] (which captures the full screen
/// inline) and the snip overlay's finish path (which captured a user-selected
/// region first). `screenshot_default` mirrors `open_panel`'s `capture` flag in
/// the `quick-open` payload.
pub async fn present_launcher(
    app: &AppHandle,
    shot: Option<Screenshot>,
    context: Option<crate::ocr::AmbientContext>,
    screenshot_default: bool,
) {
    let settings = {
        let state = app.state::<AppState>();
        load_settings(&state.store)
    };
    let win = match app.get_webview_window("quick") {
        Some(w) => w,
        None => return,
    };
    // Reply mode grows this same warm window to fit its candidates. Restore the
    // launcher's compact geometry on every normal open before centering it; the
    // panel clears its draft on open and re-reports its height from there.
    app.state::<AppState>()
        .quick
        .content_height
        .store(0, Ordering::Relaxed);
    let launcher_box = scaled_size(app, LAUNCHER_BASE);
    #[cfg(not(target_os = "macos"))]
    let _ = win.set_size(launcher_box);
    // Stamp the open so the reopen handler can ignore the activation this show
    // may cause (see the macOS Reopen branch in lib.rs). The same stamp doubles
    // as this open's token, threaded through both the `quick-open` event and the
    // deferred `quick-open-url` follow-up so a late URL from a prior open can't
    // bleed into a newer one.
    let open_id = crate::store::now_ms();
    app.state::<AppState>()
        .quick
        .last_open_ms
        .store(open_id, Ordering::Relaxed);
    app.state::<AppState>()
        .quick
        .shown
        .store(true, Ordering::Relaxed);
    // On macOS, present as a non-activating panel: it surfaces on the current
    // Space and takes key focus WITHOUT activating cetus (no menu-bar switch, and
    // crucially no app activation that would yank the hidden main window up).
    // We deliberately DON'T call Tauri's `show()` here — that maps to
    // `makeKeyAndOrderFront:`, which activates the app for a key-capable panel.
    // `panel::present` orders it up + makes it key without activating. AppKit
    // must be touched on the main thread, in order: center → present.
    #[cfg(target_os = "macos")]
    {
        let present_started = std::time::Instant::now(); // TEMP timing
        let app_for_main = app.clone();
        let _ = app.run_on_main_thread(move || {
            // Snapshot the main window's on-screen state first. Presenting the
            // panel un-hides a Cmd+H-hidden app and would drag the main window
            // back; if it wasn't showing before, we push it straight out again
            // in this same pass so only the launcher appears.
            let main = app_for_main.get_webview_window("main");
            let main_was_visible = main
                .as_ref()
                .and_then(|m| m.is_visible().ok())
                .unwrap_or(false);
            if let Some(w) = app_for_main.get_webview_window("quick") {
                if let Ok(ptr) = w.ns_window() {
                    crate::panel::place_on_mouse_screen(
                        ptr,
                        launcher_box.width,
                        launcher_box.height,
                    );
                    crate::panel::present(ptr);
                }
            }
            if !main_was_visible {
                if let Some(ptr) = main.as_ref().and_then(|m| m.ns_window().ok()) {
                    crate::panel::order_out(ptr);
                }
            }
            // Raycast-style dismiss: a click anywhere outside the panel closes
            // it. A global mouse monitor (vs. relying on focus loss) is the only
            // reliable signal for this non-activating floating panel.
            let app_for_monitor = app_for_main.clone();
            crate::panel::install_outside_click_monitor(move || {
                park_quick(&app_for_monitor);
            });
        });
        tracing::info!(
            "quick present_launcher present: {}ms",
            present_started.elapsed().as_millis()
        );
    }
    #[cfg(not(target_os = "macos"))]
    {
        center_on_cursor_monitor(&win);
        let _ = win.show();
        let _ = win.set_focus();
    }
    let _ = win.emit(
        "quick-open",
        serde_json::json!({
            "screenshot": shot,
            // The effective capture decision for *this* open (⌘ vs ⌥⌥), so the
            // panel's "include screenshot" state and the grant-permission hint
            // match the trigger that actually fired.
            "screenshotDefault": screenshot_default,
            // Lets the panel tell "permission denied" apart from "shot not loaded
            // yet" — so it only shows the grant-permission hint when truly denied,
            // never as a flash on the first open before the capture lands.
            "screenshotPermission": screen_recording_effective(),
            // Ambient context captured pre-focus (may be null). The panel shows
            // it as removable chips and forwards whatever survives on submit. The
            // browser URL arrives later via `quick-open-url`.
            "context": context,
            "sessionMode": settings.session_mode,
            // This open's token; the panel pins it so a stale `quick-open-url`
            // from an earlier open is ignored.
            "openId": open_id,
        }),
    );
    // Now that the panel is up, fetch the browser URL off the critical path and
    // stream it in as a follow-up. The AppleScript probe (bounded to 2s) would
    // otherwise have delayed the panel's first paint by that much. Only the
    // contextful gesture carries context, and only browsers yield a URL.
    if screenshot_default {
        if let Some(bundle) = context.as_ref().map(|c| c.bundle_id.clone()) {
            if !bundle.is_empty() {
                let app_for_url = app.clone();
                tauri::async_runtime::spawn(async move {
                    let fetched = tauri::async_runtime::spawn_blocking(move || {
                        crate::ax::fetch_browser_url(&bundle)
                    })
                    .await
                    .ok()
                    .flatten();
                    if let Some((url, title)) = fetched {
                        if url.is_empty() {
                            return;
                        }
                        if let Some(w) = app_for_url.get_webview_window("quick") {
                            let _ = w.emit(
                                "quick-open-url",
                                serde_json::json!({ "url": url, "title": title, "openId": open_id }),
                            );
                        }
                    }
                });
            }
        }
    }
}
