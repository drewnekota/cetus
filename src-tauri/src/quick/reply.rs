#[cfg(not(target_os = "macos"))]
use super::center_on_cursor_monitor;
use super::{
    capture_screenshot, load_settings, park_quick, save_settings, scaled_size,
    screen_recording_effective, AppHandle, AppState, Emitter, Manager, Ordering, ReplyStash,
    REPLY_BASE,
};

/// Open the system-wide visual reply surface. Capture happens before the panel
/// is presented so the screenshot contains the user's app, not Cetus. The panel
/// appears immediately in a loading state; the one-shot vision turn streams
/// text deltas into the draft and settles with one result event. `open_id`
/// makes late deltas and results harmless after a dismiss/reopen race.
pub async fn open_reply(app: &AppHandle) {
    let settings = {
        let state = app.state::<AppState>();
        load_settings(&state.store)
    };
    let (recapturing, shown, last_open_ms) = {
        let state = app.state::<AppState>();
        (
            state.quick.recapturing.clone(),
            state.quick.shown.clone(),
            state.quick.last_open_ms.clone(),
        )
    };
    if recapturing.load(Ordering::Relaxed) {
        return;
    }
    if app
        .state::<AppState>()
        .quick
        .snip_active
        .load(Ordering::Relaxed)
    {
        crate::snip::cancel(app);
    }
    if shown.load(Ordering::Relaxed) {
        park_quick(app);
        return;
    }
    let Some(win) = app.get_webview_window("quick") else {
        return;
    };

    let open_id = crate::store::now_ms();
    last_open_ms.store(open_id, Ordering::Relaxed);
    shown.store(true, Ordering::Relaxed);

    // Only the identity half runs before the panel presents — it's the half that
    // stops being true the moment the panel takes focus. The AX walk and the
    // browser probe are pid-keyed and follow after presenting, so their latency
    // (including waiting on a cold Electron tree) never delays first paint.
    let identity_task = tauri::async_runtime::spawn_blocking(crate::ax::gather_reply_identity);
    let screenshot_task = tauri::async_runtime::spawn_blocking(capture_screenshot);
    let (mut context, pid) = identity_task.await.ok().unwrap_or((None, 0));
    let screenshot = screenshot_task.await.ok().flatten();

    // The reply surface is a single editable draft that streams in live, with
    // a captured-input band (screenshot thumbnail + context chips) beneath it.
    let reply_box = scaled_size(app, REPLY_BASE);
    #[cfg(not(target_os = "macos"))]
    let _ = win.set_size(reply_box);
    #[cfg(target_os = "macos")]
    {
        let app_for_main = app.clone();
        let _ = app.run_on_main_thread(move || {
            let main = app_for_main.get_webview_window("main");
            let main_was_visible = main
                .as_ref()
                .and_then(|m| m.is_visible().ok())
                .unwrap_or(false);
            if let Some(w) = app_for_main.get_webview_window("quick") {
                if let Ok(ptr) = w.ns_window() {
                    crate::panel::place_on_mouse_screen(ptr, reply_box.width, reply_box.height);
                    crate::panel::present(ptr);
                }
            }
            if !main_was_visible {
                if let Some(ptr) = main.as_ref().and_then(|m| m.ns_window().ok()) {
                    crate::panel::order_out(ptr);
                }
            }
            let monitor_app = app_for_main.clone();
            crate::panel::install_outside_click_monitor(move || park_quick(&monitor_app));
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        center_on_cursor_monitor(&win);
        let _ = win.show();
        let _ = win.set_focus();
    }

    // The capture rides along so the panel can show the user exactly what the
    // model receives: the screenshot (already JPEG, ≤1600px — same payload the
    // launcher ships), the ambient context, and the runtime that will answer.
    // The AX volume isn't known yet; `quick-reply-context` fills it in below.
    let backend = crate::quick_reply::resolve_backend(
        &app.state::<AppState>().store,
        &settings.reply_backend,
    );
    let _ = win.emit(
        "quick-reply-open",
        serde_json::json!({
            "openId": open_id,
            "app": context.as_ref().map(|c| c.app.as_str()).unwrap_or(""),
            "screenshotPermission": screen_recording_effective(),
            "screenshot": &screenshot,
            "context": &context,
            "axChars": 0,
            "backend": &backend,
        }),
    );

    // Now that the panel is up, read the app being replied to: window title,
    // browser URL, and the bounded AX walk (which may wait on a cold Electron
    // tree). All pid-keyed, so the panel holding focus doesn't affect them.
    let bundle = context
        .as_ref()
        .map(|c| c.bundle_id.clone())
        .unwrap_or_default();
    let details =
        tauri::async_runtime::spawn_blocking(move || crate::ax::gather_reply_details(pid, &bundle))
            .await
            .ok()
            .unwrap_or_default();
    if last_open_ms.load(Ordering::Relaxed) != open_id {
        return;
    }
    if let Some(ctx) = context.as_mut() {
        ctx.title = details.title;
        ctx.url = details.url;
    }
    let _ = win.emit(
        "quick-reply-context",
        serde_json::json!({
            "openId": open_id,
            "context": &context,
            "axChars": details.visible_text.chars().count(),
        }),
    );

    let run = {
        let state = app.state::<AppState>();
        // Keep the capture for the panel's runtime picker to re-send.
        *state.quick.reply_stash.lock().unwrap() = screenshot.clone().map(|shot| ReplyStash {
            open_id,
            screenshot: shot,
            context: context.clone(),
            visible_text: details.visible_text.clone(),
        });
        state.quick.reply_run.fetch_add(1, Ordering::Relaxed) + 1
    };
    let result = match screenshot {
        Some(ref shot) => {
            crate::quick_reply::generate(
                app,
                open_id,
                run,
                shot,
                context.as_ref(),
                &details.visible_text,
                &settings.reply_backend,
            )
            .await
        }
        None if !screen_recording_effective() => Err(anyhow::anyhow!(
            "Screen Recording permission is required for visual quick reply. macOS may have paused a previous grant — re-enable Cetus in System Settings → Privacy & Security → Screen Recording."
        )),
        None => Err(anyhow::anyhow!("Could not capture the current screen.")),
    };
    // Do not resurrect or overwrite a newer panel open with this late result.
    if last_open_ms.load(Ordering::Relaxed) != open_id {
        return;
    }
    emit_reply_result(app, open_id, run, result);
}

/// Publish a settled quick-reply turn, unless a newer run (a runtime switch)
/// has already taken over the panel.
fn emit_reply_result(
    app: &AppHandle,
    open_id: i64,
    run: u32,
    result: anyhow::Result<crate::quick_reply::QuickReplyOutput>,
) {
    if app
        .state::<AppState>()
        .quick
        .reply_run
        .load(Ordering::Relaxed)
        != run
    {
        return;
    }
    let Some(win) = app.get_webview_window("quick") else {
        return;
    };
    let payload = match result {
        Ok(output) => serde_json::json!({ "openId": open_id, "output": output, "error": null }),
        Err(error) => serde_json::json!({
            "openId": open_id,
            "output": null,
            "error": error.to_string(),
        }),
    };
    let _ = win.emit("quick-reply-result", payload);
}

/// Accept a visual reply candidate and type it into the app that owned focus
/// before the non-activating panel appeared. Parking first lets AppKit restore
/// that app's key window; the short delay avoids racing the window-order pass.
#[tauri::command]
pub async fn quick_reply_insert(app: AppHandle, text: String) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("Reply is empty.".into());
    }
    if text.chars().count() > 4000 {
        return Err("Reply is too long to insert.".into());
    }
    park_quick(&app);
    tokio::time::sleep(std::time::Duration::from_millis(90)).await;
    tauri::async_runtime::spawn_blocking(move || {
        // Paste is the compatibility path for arbitrary targets (Electron,
        // terminals, browser editors). text_input preserves and restores the
        // user's previous clipboard around the synthetic Cmd+V.
        crate::text_input::insert_text(&text, crate::text_input::InsertMode::Paste)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Re-run the quick-reply turn against the *same* capture with a different
/// runtime. The turn replays the screenshot and AX text stashed when the panel
/// opened — the panel is frontmost by now, so a naive re-capture would shoot
/// the panel itself. When the open-time capture failed (no stash), briefly hide
/// the panel and retry the whole capture instead, so "try another runtime"
/// after a capture failure is a real retry rather than a guaranteed error.
/// The choice is persisted, matching how the launcher's runtime picker sticks.
#[tauri::command]
pub async fn quick_reply_regenerate(app: AppHandle, backend: String) -> Result<(), String> {
    let stash = {
        let state = app.state::<AppState>();
        // Persist the runtime choice before anything can fail — the reply
        // surface must remember the pick even when this turn errors out.
        let mut settings = load_settings(&state.store);
        if settings.reply_backend != backend {
            settings.reply_backend = backend.clone();
            save_settings(&state.store, &settings).map_err(|e| e.to_string())?;
        }
        let stash = state.quick.reply_stash.lock().unwrap().clone();
        stash
    };
    let stash = match stash {
        Some(stash) => stash,
        None => recapture_reply_stash(&app, &backend)
            .await
            .map_err(|e| e.to_string())?,
    };
    let run = app
        .state::<AppState>()
        .quick
        .reply_run
        .fetch_add(1, Ordering::Relaxed)
        + 1;
    let result = crate::quick_reply::generate(
        &app,
        stash.open_id,
        run,
        &stash.screenshot,
        stash.context.as_ref(),
        &stash.visible_text,
        &backend,
    )
    .await;
    emit_reply_result(&app, stash.open_id, run, result);
    Ok(())
}

/// Retry the reply capture after the open-time one failed: hide the panel so it
/// isn't baked into its own screenshot, re-run the identity + screenshot + AX
/// probes, re-present, and hand the panel a fresh `quick-reply-open` so the
/// upcoming turn's open-id matches what it renders. The `recapturing` flag
/// keeps the gesture listener and the blur-dismiss path from treating the
/// intentionally-hidden panel as closed.
async fn recapture_reply_stash(app: &AppHandle, backend: &str) -> anyhow::Result<ReplyStash> {
    let (recapturing, last_open_ms) = {
        let state = app.state::<AppState>();
        (
            state.quick.recapturing.clone(),
            state.quick.last_open_ms.clone(),
        )
    };
    recapturing.store(true, Ordering::Relaxed);
    let win = app.get_webview_window("quick");
    if let Some(w) = &win {
        let _ = w.hide();
    }
    // Window order-out is async; give the compositor room to actually drop the
    // panel before shooting (same settle the launcher's re-capture uses).
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    let identity_task = tauri::async_runtime::spawn_blocking(crate::ax::gather_reply_identity);
    let screenshot_task = tauri::async_runtime::spawn_blocking(capture_screenshot);
    let (mut context, pid) = identity_task.await.ok().unwrap_or((None, 0));
    let screenshot = screenshot_task.await.ok().flatten();
    // Bring the panel back before the (possibly slow) AX walk. Tauri's `show()`
    // would activate the app; re-present the non-activating panel instead.
    #[cfg(target_os = "macos")]
    {
        let app_for_main = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(w) = app_for_main.get_webview_window("quick") {
                if let Ok(ptr) = w.ns_window() {
                    crate::panel::present(ptr);
                }
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(w) = &win {
        let _ = w.show();
        let _ = w.set_focus();
    }
    recapturing.store(false, Ordering::Relaxed);
    let Some(screenshot) = screenshot else {
        if !screen_recording_effective() {
            anyhow::bail!("Screen Recording permission is required for visual quick reply. macOS may have paused a previous grant — re-enable Cetus in System Settings → Privacy & Security → Screen Recording.");
        }
        anyhow::bail!("Could not capture the current screen.");
    };
    let bundle = context
        .as_ref()
        .map(|c| c.bundle_id.clone())
        .unwrap_or_default();
    let details =
        tauri::async_runtime::spawn_blocking(move || crate::ax::gather_reply_details(pid, &bundle))
            .await
            .ok()
            .unwrap_or_default();
    if let Some(ctx) = context.as_mut() {
        ctx.title = details.title;
        ctx.url = details.url;
    }
    let open_id = crate::store::now_ms();
    last_open_ms.store(open_id, Ordering::Relaxed);
    let stash = ReplyStash {
        open_id,
        screenshot,
        context,
        visible_text: details.visible_text,
    };
    {
        let state = app.state::<AppState>();
        *state.quick.reply_stash.lock().unwrap() = Some(stash.clone());
    }
    if let Some(w) = &win {
        let _ = w.emit(
            "quick-reply-open",
            serde_json::json!({
                "openId": open_id,
                "app": stash.context.as_ref().map(|c| c.app.as_str()).unwrap_or(""),
                "screenshotPermission": screen_recording_effective(),
                "screenshot": &stash.screenshot,
                "context": &stash.context,
                "axChars": stash.visible_text.chars().count(),
                "backend": backend,
            }),
        );
    }
    Ok(stash)
}
