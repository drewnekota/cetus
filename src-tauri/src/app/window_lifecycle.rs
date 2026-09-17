use super::{meeting, quick, window_geom, AppHandle, AppState, Manager};

/// Where the main window sat before [`park_main`] tucked it warm off-screen
/// (origin x, y + the style mask the park stripped to borderless); `None` when
/// it's showing normally. macOS-only.
#[cfg(target_os = "macos")]
static MAIN_PARKED_ORIGIN: std::sync::Mutex<Option<(f64, f64, usize)>> =
    std::sync::Mutex::new(None);

/// Whether the main window is currently parked (closed → tucked away warm and
/// ordered out). Read by the Dock-reopen handler to decide whether a Dock click
/// needs to summon the window back, and by `toggle_main` to choose
/// summon-vs-hide.
#[cfg(target_os = "macos")]
pub(super) fn main_is_parked() -> bool {
    MAIN_PARKED_ORIGIN.lock().unwrap().is_some()
}

/// Hide the main window to the background on close while keeping its WKWebView
/// warm, so reopening after a long idle doesn't flash an empty (transparent)
/// window before WebKit restores the backing store (the same idle-discard
/// issue [`crate::panel::park`] fixes for the launcher). Off macOS there is no
/// warm-park trick, so just hide it.
pub(crate) fn park_main(app: &AppHandle) {
    // Persist the last on-screen geometry (the close handler recorded it just
    // before this call), then freeze recording so the off-screen park move
    // can't overwrite it.
    window_geom::flush(&app.state::<AppState>().store);
    window_geom::suspend();
    #[cfg(target_os = "macos")]
    {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            // Take the lock for the whole park so a concurrent focus_main
            // can't interleave, and skip if already parked — a second close
            // would otherwise overwrite the saved real origin with the
            // off-screen sliver position and the next restore would "show"
            // the window off-screen.
            let mut slot = MAIN_PARKED_ORIGIN.lock().unwrap();
            if slot.is_some() {
                return;
            }
            if let Some(w) = app2.get_webview_window("main") {
                // A native-fullscreen window can't be parked in place: hiding
                // it orders it out but leaves its (now empty) fullscreen Space
                // behind, so the red-dot close dumps the user onto a black
                // screen — and the app stays active with no window and no
                // parked/hidden flag, unreachable until the next activation.
                // Do what macOS itself does for a fullscreen close: exit
                // fullscreen first, then park once the exit animation lands.
                if w.is_fullscreen().unwrap_or(false) {
                    drop(slot);
                    let _ = w.set_fullscreen(false);
                    let app3 = app2.clone();
                    tauri::async_runtime::spawn(async move {
                        // The exit animation takes ~0.5s; poll until the
                        // fullscreen bit clears, bounded so a wedged exit
                        // can't loop park_main forever.
                        let mut exited = false;
                        for _ in 0..60 {
                            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                            let still_fs = app3
                                .get_webview_window("main")
                                .map(|w| w.is_fullscreen().unwrap_or(false))
                                .unwrap_or(false);
                            if !still_fs {
                                exited = true;
                                break;
                            }
                        }
                        if exited {
                            // Let AppKit settle the restored frame, then take
                            // the normal warm-park path.
                            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                            park_main(&app3);
                        } else if let Some(w) = app3.get_webview_window("main") {
                            tracing::warn!("park_main: fullscreen exit never landed; hiding");
                            let _ = w.hide();
                        }
                    });
                    return;
                }
                if let Ok(ptr) = w.ns_window() {
                    *slot = crate::panel::park_main_window(ptr);
                }
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.hide();
        }
    }
}

/// Quit the app, asking first when the "confirm before quitting" setting is
/// on (default). Shared by the menu-bar Quit (Cmd+Q) and the tray Quit. The
/// dialog is app-modal so it shows even when the main window is parked.
pub(crate) fn request_quit(app: &AppHandle) {
    let confirm = quick::load_settings(&app.state::<AppState>().store).confirm_quit;
    if !confirm {
        app.exit(0);
        return;
    }
    let name = app.package_info().name.clone();
    let title = format!("Quit {name}?");
    let body = "Running agent sessions and meeting captures will be interrupted.";
    #[cfg(target_os = "macos")]
    {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            if confirm_quit_native(&title, body) {
                app2.exit(0);
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        let app2 = app.clone();
        app.dialog()
            .message(body)
            .title(title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Quit".into(),
                "Cancel".into(),
            ))
            .show(move |ok| {
                if ok {
                    app2.exit(0);
                }
            });
    }
}

/// App-modal NSAlert "Quit?" prompt. Must run on the main thread. `runModal`
/// (not a sheet) so it works with the main window parked off-screen and from
/// the tray with no key window. Returns true when the user picked Quit; any
/// exception is swallowed as "cancel" so the prompt can never crash the app.
#[cfg(target_os = "macos")]
pub(super) fn confirm_quit_native(title: &str, body: &str) -> bool {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2_foundation::NSString;
    let caught = objc2::exception::catch(core::panic::AssertUnwindSafe(|| unsafe {
        // Make sure the alert lands in front: a tray-initiated quit can arrive
        // with another app active.
        if let Some(ns_app) = AnyClass::get(c"NSApplication") {
            let shared: *mut AnyObject = msg_send![ns_app, sharedApplication];
            if !shared.is_null() {
                let _: () = msg_send![shared, activateIgnoringOtherApps: Bool::YES];
            }
        }
        let cls = AnyClass::get(c"NSAlert")?;
        let alert: objc2::rc::Retained<AnyObject> = msg_send![cls, new];
        let alert = &*alert;
        let title = NSString::from_str(title);
        let body = NSString::from_str(body);
        let quit = NSString::from_str("Quit");
        let cancel = NSString::from_str("Cancel");
        let _: () = msg_send![alert, setMessageText: &*title];
        let _: () = msg_send![alert, setInformativeText: &*body];
        // NSAlertStyleWarning == 0.
        let _: () = msg_send![alert, setAlertStyle: 0usize];
        // First button is the default (Return); a button titled "Cancel"
        // automatically gets Escape.
        let _: *mut AnyObject = msg_send![alert, addButtonWithTitle: &*quit];
        let _: *mut AnyObject = msg_send![alert, addButtonWithTitle: &*cancel];
        // NSAlertFirstButtonReturn == 1000.
        let response: isize = msg_send![alert, runModal];
        Some(response == 1000)
    }));
    match caught {
        Ok(Some(ok)) => ok,
        Ok(None) => false,
        Err(e) => {
            tracing::warn!("confirm_quit_native: alert raised an exception: {e:?}");
            false
        }
    }
}

/// Bring the main window to the foreground (shared by the tray menu, the macOS
/// dock-reopen handler, the launcher submit, and the global summon hotkey).
/// `set_focus` activates the app on macOS, so the OS switches to whichever
/// Space/desktop holds the window — the cross-desktop "jump to cetus" the summon
/// hotkey wants. If the window was parked warm off-screen, restore its real
/// position and chrome first.
pub(crate) fn focus_main(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            // Read-and-clear the parked origin HERE, on the main thread, not
            // on the caller's thread: park_main writes it from the main
            // thread, so taking it early from a worker (tray / launcher
            // submit) could interleave with a close and leave a fully-shown
            // window still ignoring the mouse (see panel::enable_mouse_events).
            let parked = MAIN_PARKED_ORIGIN.lock().unwrap().take();
            let was_parked = parked.is_some();
            tracing::debug!("focus_main: was_parked={was_parked}");
            if let Some(w) = app2.get_webview_window("main") {
                if let Ok(ptr) = w.ns_window() {
                    match parked {
                        Some((x, y, mask)) => crate::panel::unpark_main_window(ptr, x, y, mask),
                        // Not parked — but a close→reopen race may still have
                        // leaked the park's mouse-ignore flag onto a window
                        // we're about to show. Healing is idempotent, so a
                        // summoned window is always clickable (red dot
                        // included) even before it ever becomes key.
                        None => crate::panel::enable_mouse_events(ptr),
                    }
                    // Paint-synced reveal for a window coming back from a park:
                    // a long ordered-out idle can discard its WKWebView backing
                    // store, so showing it opaque flashes the bare vibrancy
                    // before the DOM repaints. Go invisible BEFORE ordering it
                    // front (below), then reveal once the next frame presents.
                    // A warm (never-parked) window is already painted, so skip
                    // the extra hop and its latency.
                    if was_parked {
                        crate::panel::hide_alpha(ptr);
                    }
                }
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
                // Now that it's ordered front + activated (so WebKit repaints),
                // flip it visible after the webview presents its first frame.
                if was_parked {
                    if let Ok(ptr) = w.ns_window() {
                        crate::panel::reveal_after_paint(ptr);
                    }
                }
            }
            // Back on-screen at its real position — track moves again.
            window_geom::resume();
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
        window_geom::resume();
    }
}

/// Summon-hotkey behavior: bring cetus forward, or — if it's already the
/// frontmost app — hide it (⌘H-style), so the same key toggles the app in and
/// out. AppKit calls must run on the main thread.
pub(super) fn toggle_main(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        let _ = app.clone().run_on_main_thread(move || {
            // "Active" alone is not enough to decide to hide: closing the main
            // window parks it off-screen WITHOUT deactivating the app, so
            // right after a ⌘W cetus is often still the active app with nothing
            // on screen — the is-active check alone would hide_app and the
            // summon press would look eaten. And "visible" alone is not enough
            // either: a window on ANOTHER Space is still `isVisible`, so the
            // press meant to jump to it would hide the app instead. Only hide
            // when the user can actually see the window (not parked, visible,
            // on the active Space); otherwise summon.
            let showing = !main_is_parked()
                && app
                    .get_webview_window("main")
                    .map(|w| {
                        w.is_visible().unwrap_or(false)
                            && w.ns_window()
                                .map(crate::panel::is_on_active_space)
                                .unwrap_or(true)
                    })
                    .unwrap_or(false);
            if crate::panel::app_is_active() && showing {
                crate::panel::hide_app();
            } else {
                focus_main(&app);
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        focus_main(app);
    }
}

/// (Re)register the app's global shortcuts: the summon hotkey passed in plus
/// the meeting-capture toggle from its settings. Clears all previous bindings
/// first so a changed accelerator never leaves a stale registration behind. A
/// malformed accelerator is logged and skipped rather than failing the whole
/// settings save.
pub(crate) fn apply_summon_hotkey(app: &AppHandle, hotkey: &str) {
    #[cfg(desktop)]
    {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let gs = app.global_shortcut();
        let _ = gs.unregister_all();

        let hk = hotkey.trim();
        if !hk.is_empty() {
            match hk.parse::<tauri_plugin_global_shortcut::Shortcut>() {
                Ok(sc) => {
                    if let Err(e) = gs.register(sc) {
                        tracing::warn!("cetus: failed to register summon hotkey {hk:?}: {e}");
                    }
                }
                Err(e) => tracing::warn!("cetus: invalid summon hotkey {hk:?}: {e}"),
            }
        }

        // Meeting-capture toggle. sync_toggle_hotkey also stashes the parsed
        // shortcut so the plugin handler can route presses to the right action.
        // Gated on the feature's master switch: the binding ships with a
        // default, and an unregistered-but-bound hotkey must never be able to
        // start the mic for a user who hasn't opted in.
        let meeting_settings = meeting::load_settings(&app.state::<AppState>().store);
        let meeting_hk = if meeting_settings.enabled {
            meeting_settings.toggle_hotkey
        } else {
            String::new()
        };
        if let Some(sc) = meeting::sync_toggle_hotkey(&meeting_hk) {
            if let Err(e) = gs.register(sc) {
                tracing::warn!("cetus: failed to register meeting hotkey {meeting_hk:?}: {e}");
            }
        }
    }
}

/// Sync the OS login item with the "launch on startup" toggle. Enabling
/// registers cetus as a macOS login item (launches into the tray); disabling
/// removes it. Errors are logged and swallowed so a flaky login-item API never
/// fails the whole settings save.
pub(crate) fn apply_launch_on_startup(app: &AppHandle, enabled: bool) {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        let mgr = app.autolaunch();
        let res = if enabled { mgr.enable() } else { mgr.disable() };
        if let Err(e) = res {
            tracing::warn!("cetus: failed to set launch-on-startup={enabled}: {e}");
        }
    }
}
