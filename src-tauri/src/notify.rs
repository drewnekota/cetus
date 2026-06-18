//! macOS user notifications with click-to-open routing and a fixed cetus-logo
//! badge.
//!
//! Why not the Tauri notification plugin: on desktop it fires-and-forgets — it
//! drops the `notify-rust` handle, so a click never reaches the app — and in dev
//! it borrows Terminal's bundle, which is also whose icon the banner shows.
//!
//! Instead we drive `NSUserNotificationCenter` directly with a *persistent*
//! delegate. A click is delivered back to that delegate (non-blocking, no leaked
//! waiter thread) and routed to the UI as a `notification-activate` event
//! carrying the conversation id we stashed in the notification's `userInfo`. The
//! `_identityImage` override pins the badge to the cetus logo regardless of which
//! bundle owns the notification. We still borrow `mac-notification-sys`'s bundle
//! hook (`set_application`) so delivery works from the unbundled dev binary.

use tauri::AppHandle;

#[cfg(target_os = "macos")]
use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
#[cfg(target_os = "macos")]
use objc2::{msg_send, sel};
#[cfg(target_os = "macos")]
use std::ffi::{CStr, CString};
#[cfg(target_os = "macos")]
use std::os::raw::c_char;
#[cfg(target_os = "macos")]
use std::sync::OnceLock;

#[cfg(target_os = "macos")]
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Register the persistent notification delegate. Call once from `setup`, on the
/// main thread (AppKit). On non-macOS this only stashes the handle.
pub fn init(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let _ = APP.set(app.clone());
        unsafe {
            let Some(center_cls) = AnyClass::get(c"NSUserNotificationCenter") else {
                return;
            };
            let center: *mut AnyObject = msg_send![center_cls, defaultUserNotificationCenter];
            if center.is_null() {
                return;
            }
            let cls: &AnyClass = &*delegate_class();
            // +1 retained and never released: the center holds the delegate
            // weakly, so it must outlive this call (the whole process run).
            let delegate: *mut AnyObject = msg_send![cls, new];
            let _: () = msg_send![center, setDelegate: delegate];
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
}

/// Post a notification. `conversation_id`, when present, is echoed back on click
/// so the UI can open (or unarchive) that conversation.
#[tauri::command]
pub async fn post_notification(
    app: AppHandle,
    state: tauri::State<'_, crate::AppState>,
    title: String,
    body: String,
    conversation_id: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let icon = ensure_icon(&state.app_data_dir);
        // Deliver on the main thread; AppKit (and the delegate it later calls)
        // must be touched there.
        let _ = app.run_on_main_thread(move || {
            ensure_bundle();
            unsafe { deliver(&title, &body, conversation_id.as_deref(), icon.as_deref()) };
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Other platforms: basic fire-and-forget via the plugin (no click route).
        use tauri_plugin_notification::NotificationExt;
        let _ = (&state, &conversation_id);
        let _ = app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show();
    }
    Ok(())
}

// ---- macOS implementation -------------------------------------------------

/// Install `mac-notification-sys`'s bundle hook once, so `NSUserNotificationCenter`
/// delivers even from the unbundled dev binary. In production the app's own id is
/// already its bundle id, so this is effectively a no-op there.
#[cfg(target_os = "macos")]
fn ensure_bundle() {
    static DONE: OnceLock<()> = OnceLock::new();
    DONE.get_or_init(|| {
        let bundle = if tauri::is_dev() {
            // A registered app whose id we can borrow so dev notifications deliver.
            mac_notification_sys::get_bundle_identifier_or_default("Terminal")
        } else {
            APP.get()
                .map(|a| a.config().identifier.clone())
                .unwrap_or_default()
        };
        if !bundle.is_empty() {
            let _ = mac_notification_sys::set_application(&bundle);
        }
    });
}

/// Write the bundled logo to disk once and return its path (for `_identityImage`).
#[cfg(target_os = "macos")]
fn ensure_icon(app_data_dir: &std::path::Path) -> Option<String> {
    const ICON: &[u8] = include_bytes!("../icons/128x128@2x.png");
    // Byte length in the name busts the cache when the bundled logo changes
    // (e.g. a brand refresh), without hashing on every call.
    let path = app_data_dir.join(format!("notify-icon-{}.png", ICON.len()));
    if !path.exists() {
        if let Err(e) = std::fs::write(&path, ICON) {
            tracing::warn!("notify: could not stage icon: {e}");
            return None;
        }
    }
    Some(path.to_string_lossy().into_owned())
}

/// Build and deliver one `NSUserNotification`. Main thread only.
#[cfg(target_os = "macos")]
unsafe fn deliver(title: &str, body: &str, conversation_id: Option<&str>, icon: Option<&str>) {
    let Some(center_cls) = AnyClass::get(c"NSUserNotificationCenter") else {
        return;
    };
    let center: *mut AnyObject = msg_send![center_cls, defaultUserNotificationCenter];
    if center.is_null() {
        return;
    }
    let Some(note_cls) = AnyClass::get(c"NSUserNotification") else {
        return;
    };
    let note: *mut AnyObject = msg_send![note_cls, new];
    if note.is_null() {
        return;
    }
    let _: () = msg_send![note, setTitle: nsstring(title)];
    let _: () = msg_send![note, setInformativeText: nsstring(body)];
    if let Some(cid) = conversation_id {
        if let Some(dict_cls) = AnyClass::get(c"NSDictionary") {
            let key = nsstring("conversationId");
            let val = nsstring(cid);
            let info: *mut AnyObject = msg_send![dict_cls, dictionaryWithObject: val, forKey: key];
            let _: () = msg_send![note, setUserInfo: info];
        }
    }
    if let Some(path) = icon {
        if let Some(img_cls) = AnyClass::get(c"NSImage") {
            let alloc: *mut AnyObject = msg_send![img_cls, alloc];
            let img: *mut AnyObject = msg_send![alloc, initWithContentsOfFile: nsstring(path)];
            if !img.is_null() {
                // Private keys (same ones mac-notification-sys uses) that swap the
                // app badge for our own image and drop its rounded border.
                let _: () = msg_send![note, setValue: img, forKey: nsstring("_identityImage")];
                if let Some(num_cls) = AnyClass::get(c"NSNumber") {
                    let no: *mut AnyObject = msg_send![num_cls, numberWithBool: Bool::NO];
                    let _: () =
                        msg_send![note, setValue: no, forKey: nsstring("_identityImageHasBorder")];
                }
            }
        }
    }
    let _: () = msg_send![center, deliverNotification: note];
}

/// Register (once) the delegate class that routes a clicked notification back to
/// the UI. Stored as a pointer-sized int so it's `Send`/`Sync` in the `OnceLock`.
#[cfg(target_os = "macos")]
fn delegate_class() -> *const AnyClass {
    static CLASS: OnceLock<usize> = OnceLock::new();
    *CLASS.get_or_init(|| {
        let superclass = AnyClass::get(c"NSObject").expect("NSObject runtime class");
        let mut builder = ClassBuilder::new(c"CetusNotificationDelegate", superclass)
            .expect("register CetusNotificationDelegate class");
        unsafe {
            builder.add_method(
                sel!(userNotificationCenter:didActivateNotification:),
                did_activate as extern "C" fn(_, _, _, _),
            );
            // Force banners to show even when cetus is frontmost; the JS layer
            // already decides whether to post at all (mute-when-focused).
            builder.add_method(
                sel!(userNotificationCenter:shouldPresentNotification:),
                should_present as extern "C" fn(_, _, _, _) -> _,
            );
        }
        builder.register() as *const AnyClass as usize
    }) as *const AnyClass
}

#[cfg(target_os = "macos")]
extern "C" fn should_present(
    _this: &AnyObject,
    _cmd: Sel,
    _center: *mut AnyObject,
    _notification: *mut AnyObject,
) -> Bool {
    Bool::YES
}

#[cfg(target_os = "macos")]
extern "C" fn did_activate(
    _this: &AnyObject,
    _cmd: Sel,
    _center: *mut AnyObject,
    notification: *mut AnyObject,
) {
    unsafe {
        if notification.is_null() {
            return;
        }
        let user_info: *mut AnyObject = msg_send![notification, userInfo];
        let cid = if user_info.is_null() {
            String::new()
        } else {
            let key = nsstring("conversationId");
            let val: *mut AnyObject = msg_send![user_info, objectForKey: key];
            from_nsstring(val)
        };
        let Some(app) = APP.get() else {
            return;
        };
        // Bring cetus forward (restores a parked main window), then hand the id to
        // the UI to open / unarchive.
        crate::focus_main(app);
        use tauri::Emitter;
        let payload = serde_json::json!({
            "conversationId": if cid.is_empty() {
                serde_json::Value::Null
            } else {
                serde_json::Value::String(cid)
            }
        });
        let _ = app.emit_to("main", "notification-activate", payload);
    }
}

// ---- NSString helpers -----------------------------------------------------

#[cfg(target_os = "macos")]
unsafe fn nsstring(s: &str) -> *mut AnyObject {
    let cls = AnyClass::get(c"NSString").expect("NSString runtime class");
    let c = CString::new(s).unwrap_or_default();
    msg_send![cls, stringWithUTF8String: c.as_ptr()]
}

#[cfg(target_os = "macos")]
unsafe fn from_nsstring(s: *mut AnyObject) -> String {
    if s.is_null() {
        return String::new();
    }
    let ptr: *const c_char = msg_send![s, UTF8String];
    if ptr.is_null() {
        return String::new();
    }
    CStr::from_ptr(ptr).to_string_lossy().into_owned()
}
