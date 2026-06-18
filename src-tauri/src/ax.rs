//! Waking up Electron apps' accessibility trees.
//!
//! Chromium-based apps (Electron: Lark/飞书, Slack, Discord, VS Code…) skip
//! building their AX tree until an assistive client announces itself, so a
//! plain `AXFocusedUIElement` read returns nothing — which blanks both the
//! focused-field dictation context and the correction-mining re-reads.
//! Electron documents `AXManualAccessibility` as the per-process attribute a
//! third-party app sets to force the tree on (it resets when the app quits).
//! Some builds hit electron#37465, where that attribute answers
//! `kAXErrorAttributeUnsupported`; those still honor the legacy Chromium flag
//! `AXEnhancedUserInterface`, so we fall back to it.
//!
//! Only apps that actually ship `Electron Framework.framework` are touched:
//! `AXEnhancedUserInterface` doubles as the "VoiceOver is running" signal and
//! flipping it on arbitrary native apps is known to change their behavior
//! (window-manager resize glitches and the like).
//!
//! The tree builds asynchronously after the flag lands, so the read issued in
//! the same instant may still miss — but dictation reads the field again at
//! finish (cleanup context) and at +1.2s/+10s (correction mining), all well
//! after the wake-up sent at session start.

/// Best-effort, blocking (one AX round-trip + a stat): poke the frontmost
/// app's accessibility tree awake if it's an Electron app. Debounced per pid —
/// the flag sticks for the app's lifetime, so once per process is enough (a
/// generous re-poke window covers pid reuse).
#[cfg(target_os = "macos")]
pub fn wake_frontmost_app() {
    use accessibility_sys::{
        kAXErrorSuccess, AXIsProcessTrusted, AXUIElementCreateApplication,
        AXUIElementSetAttributeValue,
    };
    use core_foundation::base::{CFType, CFTypeRef, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::string::CFString;
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use std::collections::HashMap;
    use std::ffi::CStr;
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    if !unsafe { AXIsProcessTrusted() } {
        return;
    }

    // Frontmost app identity via NSWorkspace (documented thread-safe).
    let (pid, bundle_path) = unsafe {
        let Some(ws_cls) = AnyClass::get(c"NSWorkspace") else {
            return;
        };
        let ws: *mut AnyObject = msg_send![ws_cls, sharedWorkspace];
        if ws.is_null() {
            return;
        }
        let front: *mut AnyObject = msg_send![ws, frontmostApplication];
        if front.is_null() {
            return;
        }
        let pid: i32 = msg_send![front, processIdentifier];
        let url: *mut AnyObject = msg_send![front, bundleURL];
        if url.is_null() {
            return;
        }
        let path_ns: *mut AnyObject = msg_send![url, path];
        if path_ns.is_null() {
            return;
        }
        let cstr: *const std::os::raw::c_char = msg_send![path_ns, UTF8String];
        if cstr.is_null() {
            return;
        }
        let path = std::path::PathBuf::from(CStr::from_ptr(cstr).to_string_lossy().into_owned());
        (pid, path)
    };

    {
        static WOKEN: OnceLock<Mutex<HashMap<i32, Instant>>> = OnceLock::new();
        let mut woken = WOKEN.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap();
        if woken.get(&pid).is_some_and(|t| t.elapsed() < Duration::from_secs(600)) {
            return;
        }
        woken.retain(|_, t| t.elapsed() < Duration::from_secs(3600));
        woken.insert(pid, Instant::now());
    }

    if !bundle_path
        .join("Contents/Frameworks/Electron Framework.framework")
        .exists()
    {
        return;
    }

    unsafe {
        let el_ref = AXUIElementCreateApplication(pid);
        if el_ref.is_null() {
            return;
        }
        // Own the element (Create Rule) so it's released on drop.
        let el_owner = CFType::wrap_under_create_rule(el_ref as CFTypeRef);
        let el = el_owner.as_CFTypeRef() as accessibility_sys::AXUIElementRef;
        let yes = CFBoolean::true_value();
        let manual = CFString::new("AXManualAccessibility");
        let err = AXUIElementSetAttributeValue(el, manual.as_concrete_TypeRef(), yes.as_CFTypeRef());
        if err == kAXErrorSuccess {
            tracing::debug!("ax: AXManualAccessibility enabled on Electron app pid {pid}");
            return;
        }
        // electron#37465 (and older Electrons): take the legacy Chromium flag.
        let legacy = CFString::new("AXEnhancedUserInterface");
        let err2 =
            AXUIElementSetAttributeValue(el, legacy.as_concrete_TypeRef(), yes.as_CFTypeRef());
        if err2 == kAXErrorSuccess {
            tracing::debug!(
                "ax: AXEnhancedUserInterface enabled on Electron app pid {pid} \
                 (AXManualAccessibility answered {err})"
            );
        } else {
            tracing::debug!("ax: could not wake Electron app pid {pid} (errors {err} / {err2})");
        }
    }
}

/// Capture the ambient context the quick launcher attaches to a prompt —
/// frontmost app, active browser tab URL/title, and the focused element's
/// selected text. Runs IN-PROCESS (not the spawned Swift helper) on purpose:
/// reading selected text needs the Accessibility grant and reading a browser URL
/// needs the Apple Events grant, and both TCC permissions are keyed to the
/// calling binary — only the main app holds them; an ad-hoc helper binary is
/// untrusted and silently reads nothing. Every field is best-effort.
#[cfg(target_os = "macos")]
pub fn gather_context() -> Option<crate::ocr::AmbientContext> {
    let (app, bundle, pid) = frontmost_identity().unwrap_or_default();
    let (url, title) = browser_url(&bundle).unwrap_or_default();
    // Nudge the frontmost app's accessibility tree awake. Electron/Chromium apps
    // keep their AX tree asleep until something pokes it, so the fast AX selection
    // read below would otherwise always miss and fall through to the ~300ms
    // synthetic-⌘C clipboard path. `wake_frontmost_app` is debounced per-pid, so
    // it's a cheap no-op on repeat opens of the same app.
    wake_frontmost_app();
    // AX first — free and side-effect-free for native text controls. Most real
    // targets (web pages, Electron, chat apps, terminals) don't expose selection
    // via AX, so fall back to the universal "synthesize ⌘C, read the pasteboard,
    // restore it" path (what PopClip / Raycast do). The fallback runs only when
    // AX came up empty, and only touches the clipboard if something was selected.
    let selection = focused_selected_text(pid)
        .or_else(crate::text_input::copy_selection_via_clipboard)
        .map(|s| s.chars().take(crate::ocr::MAX_SELECTION_CHARS).collect::<String>())
        .unwrap_or_default();
    tracing::info!(
        "gather_context: app={app:?} bundle={bundle:?} pid={pid} url_len={} title_len={} sel_len={}",
        url.len(),
        title.len(),
        selection.len()
    );
    let ctx = crate::ocr::AmbientContext {
        app,
        bundle_id: bundle,
        url,
        title,
        selection,
    };
    if ctx.is_empty() {
        None
    } else {
        Some(ctx)
    }
}

/// Frontmost application's (localized name, bundle id, pid) via NSWorkspace
/// (no special permission required).
#[cfg(target_os = "macos")]
fn frontmost_identity() -> Option<(String, String, i32)> {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    unsafe {
        let ws_cls = AnyClass::get(c"NSWorkspace")?;
        let ws: *mut AnyObject = msg_send![ws_cls, sharedWorkspace];
        if ws.is_null() {
            return None;
        }
        let front: *mut AnyObject = msg_send![ws, frontmostApplication];
        if front.is_null() {
            return None;
        }
        let pid: i32 = msg_send![front, processIdentifier];
        let name: *mut AnyObject = msg_send![front, localizedName];
        let bundle: *mut AnyObject = msg_send![front, bundleIdentifier];
        Some((
            ns_string_to_rust(name).unwrap_or_default(),
            ns_string_to_rust(bundle).unwrap_or_default(),
            pid,
        ))
    }
}

/// Selected text of the frontmost app's focused UI element. None when nothing is
/// selected, the element exposes no AX text, or Accessibility isn't granted.
/// Reads via the app element (frontmost pid) rather than the system-wide element
/// — more direct, and lets us wake an Electron app's AX tree first.
#[cfg(target_os = "macos")]
fn focused_selected_text(pid: i32) -> Option<String> {
    use accessibility_sys::{
        kAXErrorSuccess, AXIsProcessTrusted, AXUIElementCopyAttributeValue,
        AXUIElementCreateApplication, AXUIElementRef,
    };
    use core_foundation::base::{CFType, CFTypeRef, TCFType};
    use core_foundation::string::{CFString, CFStringRef};

    if !unsafe { AXIsProcessTrusted() } {
        tracing::info!("focused_selected_text: process NOT AX-trusted — grant Accessibility");
        return None;
    }
    if pid <= 0 {
        return None;
    }
    unsafe {
        let app = AXUIElementCreateApplication(pid);
        if app.is_null() {
            return None;
        }
        let app_owner = CFType::wrap_under_create_rule(app as CFTypeRef);
        let app_ref = app_owner.as_CFTypeRef() as AXUIElementRef;

        let focused_attr = CFString::new("AXFocusedUIElement");
        let mut focused_val: CFTypeRef = std::ptr::null_mut();
        let ferr = AXUIElementCopyAttributeValue(
            app_ref,
            focused_attr.as_concrete_TypeRef(),
            &mut focused_val,
        );
        if ferr != kAXErrorSuccess || focused_val.is_null() {
            // No native focused element (Electron tree not up, web area, etc.) —
            // the caller falls back to the clipboard path.
            return None;
        }
        let focused_owner = CFType::wrap_under_create_rule(focused_val);
        let focused_ref = focused_owner.as_CFTypeRef() as AXUIElementRef;

        let sel_attr = CFString::new("AXSelectedText");
        let mut sel_val: CFTypeRef = std::ptr::null_mut();
        let serr =
            AXUIElementCopyAttributeValue(focused_ref, sel_attr.as_concrete_TypeRef(), &mut sel_val);
        if serr != kAXErrorSuccess || sel_val.is_null() {
            tracing::info!("focused_selected_text: AXSelectedText err={serr}");
            return None;
        }
        let s = CFString::wrap_under_create_rule(sel_val as CFStringRef);
        let text = s.to_string();
        if text.trim().is_empty() {
            None
        } else {
            Some(text)
        }
    }
}

/// AppleScript that returns {url, title} for a known browser's active tab/doc,
/// or None for apps we don't script. Chromium family + WebKit Safari.
#[cfg(target_os = "macos")]
fn browser_script(bundle: &str) -> Option<String> {
    const CHROMIUM: &[&str] = &[
        "com.google.Chrome",
        "com.google.Chrome.canary",
        "com.google.Chrome.beta",
        "com.brave.Browser",
        "com.brave.Browser.beta",
        "com.brave.Browser.nightly",
        "com.microsoft.edgemac",
        "com.microsoft.edgemac.Beta",
        "com.vivaldi.Vivaldi",
        "com.operasoftware.Opera",
        "company.thebrowser.Browser", // Arc
        "com.thebrowser.Browser",
    ];
    // `with timeout of 2 seconds` bounds the Apple Event: NSAppleScript runs
    // synchronously in-process on the panel-open path (ahead of presenting the
    // launcher), and a busy/modal browser would otherwise block on the default
    // ~2-minute Apple Event timeout. 2s is plenty for a healthy reply; past it we
    // give up the URL rather than hang the launcher.
    if bundle == "com.apple.Safari" || bundle == "com.apple.SafariTechnologyPreview" {
        return Some(format!(
            "with timeout of 2 seconds\n\
             tell application id \"{bundle}\"\n\
             set u to URL of front document\n\
             set t to name of front document\n\
             return {{u, t}}\n\
             end tell\n\
             end timeout"
        ));
    }
    if CHROMIUM.contains(&bundle) {
        return Some(format!(
            "with timeout of 2 seconds\n\
             tell application id \"{bundle}\"\n\
             set u to URL of active tab of front window\n\
             set t to title of active tab of front window\n\
             return {{u, t}}\n\
             end tell\n\
             end timeout"
        ));
    }
    None
}

/// Active browser tab (url, title) via in-process NSAppleScript. None for
/// non-browsers, no front window, or a denied Apple Events grant. The first call
/// against a given browser raises the standard "cetus wants to control X" prompt
/// — attributed to the app because we run it in-process.
#[cfg(target_os = "macos")]
fn browser_url(bundle: &str) -> Option<(String, String)> {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    let src = browser_script(bundle)?;
    unsafe {
        let cls = AnyClass::get(c"NSAppleScript")?;
        let alloc: *mut AnyObject = msg_send![cls, alloc];
        let ns_src = ns_string_from_rust(&src)?;
        let script: *mut AnyObject = msg_send![alloc, initWithSource: ns_src];
        if script.is_null() {
            return None;
        }
        let mut err: *mut AnyObject = std::ptr::null_mut();
        let desc: *mut AnyObject = msg_send![script, executeAndReturnError: &mut err];
        if desc.is_null() || !err.is_null() {
            return None;
        }
        // The script returns a two-item AppleEvent list {url, title}; indices are
        // 1-based.
        let count: i64 = msg_send![desc, numberOfItems];
        if count >= 2 {
            let d1: *mut AnyObject = msg_send![desc, descriptorAtIndex: 1i64];
            let d2: *mut AnyObject = msg_send![desc, descriptorAtIndex: 2i64];
            let u: *mut AnyObject = msg_send![d1, stringValue];
            let t: *mut AnyObject = msg_send![d2, stringValue];
            return Some((
                ns_string_to_rust(u).unwrap_or_default(),
                ns_string_to_rust(t).unwrap_or_default(),
            ));
        }
        let sv: *mut AnyObject = msg_send![desc, stringValue];
        ns_string_to_rust(sv).map(|u| (u, String::new()))
    }
}

/// Build an NSString from a Rust &str (UTF-8). None only if NSString is missing.
#[cfg(target_os = "macos")]
unsafe fn ns_string_from_rust(s: &str) -> Option<*mut objc2::runtime::AnyObject> {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    let cls = AnyClass::get(c"NSString")?;
    // stringWithBytes:length:encoding: with NSUTF8StringEncoding (4).
    let bytes = s.as_ptr() as *const std::ffi::c_void;
    let obj: *mut AnyObject =
        msg_send![cls, stringWithBytes: bytes, length: s.len(), encoding: 4usize];
    if obj.is_null() {
        None
    } else {
        Some(obj)
    }
}

/// Copy an NSString* into a Rust String. None for a null pointer / null UTF8.
#[cfg(target_os = "macos")]
unsafe fn ns_string_to_rust(s: *mut objc2::runtime::AnyObject) -> Option<String> {
    use objc2::msg_send;
    use std::ffi::CStr;
    if s.is_null() {
        return None;
    }
    let cstr: *const std::os::raw::c_char = msg_send![s, UTF8String];
    if cstr.is_null() {
        return None;
    }
    Some(CStr::from_ptr(cstr).to_string_lossy().into_owned())
}

#[cfg(not(target_os = "macos"))]
pub fn wake_frontmost_app() {}

#[cfg(not(target_os = "macos"))]
pub fn gather_context() -> Option<crate::ocr::AmbientContext> {
    None
}
