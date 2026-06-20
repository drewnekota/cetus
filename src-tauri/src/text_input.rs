//! macOS keyboard synthesis: insert text into whatever app currently has focus.
//!
//! Used by global dictation to "type" the finished transcript into the
//! foreground app (the HUD never takes key focus, so focus is still wherever the
//! user was). Two strategies:
//!
//! * [`InsertMode::Type`] (default) — synthesize key events carrying the Unicode
//!   string via `CGEventKeyboardSetUnicodeString`. Never touches the clipboard.
//! * [`InsertMode::Paste`] — stash the text on the pasteboard (`pbcopy`),
//!   synthesize ⌘V, then restore the previous clipboard text (`pbpaste`).
//!   More robust in apps that ignore synthetic Unicode keystrokes (terminals,
//!   some Electron apps), at the cost of briefly clobbering the clipboard.
//!
//! Both require the Accessibility trust the launcher gesture already needs.

use std::ffi::c_void;
use std::io::Write;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InsertMode {
    Type,
    Paste,
}

impl InsertMode {
    pub fn from_str(s: &str) -> Self {
        match s {
            "paste" => InsertMode::Paste,
            _ => InsertMode::Type,
        }
    }
}

// Post synthetic events at the *session* level (kCGSessionEventTap), not the HID
// level (kCGHIDEventTap = 0). The HID level is where a `hidutil` UserKeyMapping
// lives — and when Caps Lock is the voice trigger we install exactly such a remap
// (Caps Lock → F18, see `caps_remap.rs`). Injecting our Unicode keystrokes at the
// HID level then runs them through that active remapper, which silently drops
// them, so the transcript reaches history (a separate path) but never lands in
// any focused app. The session tap sits *above* the HID remap layer, so it's
// immune to it and still delivers to the foreground app for every gesture.
const SESSION_EVENT_TAP: u32 = 1;
// kCGEventFlagMaskCommand.
const FLAG_COMMAND: u64 = 0x0010_0000;
// Virtual keycode for 'v' (ANSI keyboard).
const KEYCODE_V: u16 = 0x09;
// kCGEventSourceStatePrivate: a source whose modifier state is independent of the
// hardware. We synthesize from this (rather than a NULL source) so that a *stuck*
// modifier — notably AlphaShift / Caps Lock, which a Caps Lock→F18 `hidutil` remap
// (see `caps_remap.rs`) can leave asserted because the key that would clear it is
// gone — can't bleed into our keystrokes. A NULL source merges the live hardware
// flags at post time; under that remap the type path was emitting keycode-0 events
// carrying a stray AlphaShift, which the focused app drops instead of inserting.
const EVENT_SOURCE_PRIVATE: i32 = -1;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceCreate(state_id: i32) -> *const c_void;
    fn CGEventCreateKeyboardEvent(
        source: *const c_void,
        keycode: u16,
        keydown: bool,
    ) -> *const c_void;
    fn CGEventKeyboardSetUnicodeString(event: *const c_void, length: usize, string: *const u16);
    fn CGEventSetFlags(event: *const c_void, flags: u64);
    fn CGEventPost(tap: u32, event: *const c_void);
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const c_void);
}

/// Insert `text` into the focused app using the given strategy.
pub fn insert_text(text: &str, mode: InsertMode) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }
    match mode {
        InsertMode::Type => {
            type_unicode(text);
            Ok(())
        }
        InsertMode::Paste => paste_via_clipboard(text),
    }
}

/// Type a Unicode string by posting key events that carry it directly. Chunked
/// because a single event's Unicode payload is only reliable for short strings.
fn type_unicode(text: &str) {
    let utf16: Vec<u16> = text.encode_utf16().collect();
    // Synthesize from a private source so a stuck hardware modifier (see
    // EVENT_SOURCE_PRIVATE) can't ride along. Falls back to a NULL source if the
    // source can't be created — still better than before thanks to the explicit
    // flag clear in post_unicode_chunk.
    let source = unsafe { CGEventSourceCreate(EVENT_SOURCE_PRIVATE) };
    for chunk in utf16.chunks(16) {
        post_unicode_chunk(source, chunk);
        // A hair of pacing so fast apps don't drop events.
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    if !source.is_null() {
        unsafe { CFRelease(source) };
    }
}

fn post_unicode_chunk(source: *const c_void, chunk: &[u16]) {
    unsafe {
        for down in [true, false] {
            let event = CGEventCreateKeyboardEvent(source, 0, down);
            if event.is_null() {
                continue;
            }
            // Force flags to zero: strip any ambient/stuck modifier (notably the
            // AlphaShift left asserted by a Caps Lock→F18 remap) so the app sees
            // plain text rather than a modified keycode-0 chord it would drop.
            CGEventSetFlags(event, 0);
            CGEventKeyboardSetUnicodeString(event, chunk.len(), chunk.as_ptr());
            CGEventPost(SESSION_EVENT_TAP, event);
            CFRelease(event);
        }
    }
}

/// Put `text` on the clipboard, paste it with ⌘V, then restore the prior
/// clipboard text. Best-effort restore — only plain text is preserved.
fn paste_via_clipboard(text: &str) -> Result<(), String> {
    let saved = pbpaste();
    pbcopy(text)?;
    synth_cmd_v();
    // Let the target app actually perform the paste before we put the old
    // clipboard back.
    std::thread::sleep(std::time::Duration::from_millis(120));
    if let Some(prev) = saved {
        let _ = pbcopy(&prev);
    }
    Ok(())
}

fn synth_cmd_v() {
    unsafe {
        for down in [true, false] {
            let event = CGEventCreateKeyboardEvent(std::ptr::null(), KEYCODE_V, down);
            if event.is_null() {
                continue;
            }
            CGEventSetFlags(event, FLAG_COMMAND);
            CGEventPost(SESSION_EVENT_TAP, event);
            CFRelease(event);
        }
    }
}

// Virtual keycode for 'c' (ANSI keyboard).
#[cfg(target_os = "macos")]
const KEYCODE_C: u16 = 0x08;

/// Synthesize a ⌘C to the focused app.
#[cfg(target_os = "macos")]
fn synth_cmd_c() {
    unsafe {
        for down in [true, false] {
            let event = CGEventCreateKeyboardEvent(std::ptr::null(), KEYCODE_C, down);
            if event.is_null() {
                continue;
            }
            CGEventSetFlags(event, FLAG_COMMAND);
            CGEventPost(SESSION_EVENT_TAP, event);
            CFRelease(event);
        }
    }
}

/// Grab the focused app's current selection by synthesizing ⌘C, reading the
/// pasteboard, then restoring it. Returns None when nothing was selected —
/// detected via the pasteboard's `changeCount`, so an unchanged clipboard is
/// never mistaken for the selection. The original clipboard (every type) is saved
/// and restored, so the user's clipboard survives. This is the universal
/// selection-capture path (web pages, Electron, chat apps, terminals) used when
/// the non-invasive AX read comes up empty — the same approach PopClip/Raycast
/// fall back to. macOS only.
#[cfg(target_os = "macos")]
pub(crate) fn copy_selection_via_clipboard() -> Option<String> {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use std::ffi::CStr;
    use std::os::raw::c_char;

    unsafe {
        let pb_cls = AnyClass::get(c"NSPasteboard")?;
        let pb: *mut AnyObject = msg_send![pb_cls, generalPasteboard];
        if pb.is_null() {
            return None;
        }
        let before: isize = msg_send![pb, changeCount];
        let saved = snapshot_pasteboard(pb);

        synth_cmd_c();

        // Wait (bounded) for the app to service the copy; break the instant the
        // pasteboard changes. Most apps respond in tens of ms.
        let mut text: Option<String> = None;
        let mut copied = false;
        for _ in 0..30 {
            std::thread::sleep(std::time::Duration::from_millis(10));
            let now: isize = msg_send![pb, changeCount];
            if now == before {
                continue;
            }
            copied = true;
            let ty = ns_string("public.utf8-plain-text");
            let s: *mut AnyObject = msg_send![pb, stringForType: ty];
            if !s.is_null() {
                let c: *const c_char = msg_send![s, UTF8String];
                if !c.is_null() {
                    text = Some(CStr::from_ptr(c).to_string_lossy().into_owned());
                }
            }
            break;
        }
        // Only disturbed the clipboard if a copy actually landed — restore then.
        if copied {
            restore_pasteboard(pb, &saved);
        }
        release_snapshot(saved);
        text.filter(|t| !t.trim().is_empty())
    }
}

#[cfg(target_os = "macos")]
unsafe fn ns_string(s: &str) -> *mut objc2::runtime::AnyObject {
    use objc2::msg_send;
    use objc2::runtime::AnyClass;
    let cls = AnyClass::get(c"NSString").expect("NSString class");
    let bytes = s.as_ptr() as *const c_void;
    msg_send![cls, stringWithBytes: bytes, length: s.len(), encoding: 4usize]
}

/// Retain and return every (type, data) pair currently on the pasteboard so it
/// can be written back verbatim after we clobber it with the selection.
#[cfg(target_os = "macos")]
unsafe fn snapshot_pasteboard(
    pb: *mut objc2::runtime::AnyObject,
) -> Vec<(
    *mut objc2::runtime::AnyObject,
    *mut objc2::runtime::AnyObject,
)> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    let mut out: Vec<(*mut AnyObject, *mut AnyObject)> = Vec::new();
    let items: *mut AnyObject = msg_send![pb, pasteboardItems];
    if items.is_null() {
        return out;
    }
    let count: isize = msg_send![items, count];
    for i in 0..count {
        let item: *mut AnyObject = msg_send![items, objectAtIndex: i];
        if item.is_null() {
            continue;
        }
        let types: *mut AnyObject = msg_send![item, types];
        if types.is_null() {
            continue;
        }
        let tcount: isize = msg_send![types, count];
        for j in 0..tcount {
            let ty: *mut AnyObject = msg_send![types, objectAtIndex: j];
            if ty.is_null() {
                continue;
            }
            let data: *mut AnyObject = msg_send![item, dataForType: ty];
            if data.is_null() {
                continue;
            }
            // Retain so they outlive clearContents / the autorelease pool.
            let _: *mut AnyObject = msg_send![ty, retain];
            let _: *mut AnyObject = msg_send![data, retain];
            out.push((ty, data));
        }
    }
    out
}

/// Write the saved (type, data) pairs back onto the pasteboard.
#[cfg(target_os = "macos")]
unsafe fn restore_pasteboard(
    pb: *mut objc2::runtime::AnyObject,
    saved: &[(
        *mut objc2::runtime::AnyObject,
        *mut objc2::runtime::AnyObject,
    )],
) {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    let _: isize = msg_send![pb, clearContents];
    if saved.is_empty() {
        return;
    }
    let Some(item_cls) = AnyClass::get(c"NSPasteboardItem") else {
        return;
    };
    let item: *mut AnyObject = msg_send![item_cls, alloc];
    let item: *mut AnyObject = msg_send![item, init];
    if item.is_null() {
        return;
    }
    for (ty, data) in saved {
        let _: bool = msg_send![item, setData: *data, forType: *ty];
    }
    let Some(arr_cls) = AnyClass::get(c"NSArray") else {
        let _: () = msg_send![item, release];
        return;
    };
    let arr: *mut AnyObject = msg_send![arr_cls, arrayWithObject: item];
    let _: bool = msg_send![pb, writeObjects: arr];
    let _: () = msg_send![item, release];
}

#[cfg(target_os = "macos")]
unsafe fn release_snapshot(
    saved: Vec<(
        *mut objc2::runtime::AnyObject,
        *mut objc2::runtime::AnyObject,
    )>,
) {
    use objc2::msg_send;
    for (ty, data) in saved {
        let _: () = msg_send![ty, release];
        let _: () = msg_send![data, release];
    }
}

fn pbpaste() -> Option<String> {
    let out = std::process::Command::new("/usr/bin/pbpaste")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

fn pbcopy(text: &str) -> Result<(), String> {
    let mut child = std::process::Command::new("/usr/bin/pbcopy")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(text.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    child.wait().map_err(|e| e.to_string())?;
    Ok(())
}
