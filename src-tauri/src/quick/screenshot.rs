#[cfg(target_os = "macos")]
use super::CGPreflightScreenCaptureAccess;
use super::{Deserialize, Serialize};

/// Whether cetus holds macOS Screen Recording permission. This is a *separate*
/// TCC grant from Accessibility. Without it `screencapture` still exits 0 but
/// silently produces a wallpaper-only image (every window omitted) — so we gate
/// capture on this and treat "not granted" as no screenshot. Always true off
/// macOS.
pub fn screen_recording_granted() -> bool {
    #[cfg(target_os = "macos")]
    {
        unsafe { CGPreflightScreenCaptureAccess() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Effective permission for the panels' grant hints: the preflight check keeps
/// answering true after macOS pauses a previously-approved grant (periodic
/// re-approval), so fold in whether the last actual capture failed the way a
/// revoked grant fails.
pub(super) fn screen_recording_effective() -> bool {
    screen_recording_granted() && !crate::capture::screen_capture_tcc_denied()
}

// ---- Screen capture -------------------------------------------------------

/// Everything a quick-reply turn reads, kept alive for the life of the panel so
/// the same screen can be re-sent to a different runtime.
#[derive(Clone)]
pub struct ReplyStash {
    pub open_id: i64,
    pub screenshot: Screenshot,
    pub context: Option<crate::ocr::AmbientContext>,
    pub visible_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Screenshot {
    /// Bare base64 (no `data:` prefix) — matches pi-ai's ImageContent.data.
    pub data: String,
    pub mime_type: String,
}

/// Grab the display the user is working on. macOS-only (uses the built-in
/// `screencapture`); other platforms return None and the panel degrades to a
/// text-only launcher.
///
/// Bare `screencapture` only ever shoots the *main* display, so on a multi-
/// display setup it silently captured the wrong screen — the panel presents on
/// the cursor's screen while the model was handed the primary one. Bound the
/// grab to the cursor's display instead (same `-R` path the snip overlay uses),
/// falling back to the plain grab when there's only one display or the bounded
/// one doesn't come back — a wrong-display shot beats no shot at all.
pub fn capture_screenshot() -> Option<Screenshot> {
    match cursor_display_region() {
        Some(region) => {
            capture_screenshot_region(Some(region)).or_else(|| capture_screenshot_region(None))
        }
        None => capture_screenshot_region(None),
    }
}

/// Bounds of the display holding the cursor, in CG global coordinates (points,
/// top-left origin) — what `screencapture -R` expects. None with a single
/// display (the default grab already covers it) or if the lookup fails.
///
/// Pure CoreGraphics on purpose: this runs on a blocking worker thread, where
/// the AppKit `NSScreen` lookup `panel.rs` uses would be off-main-thread.
#[cfg(target_os = "macos")]
fn cursor_display_region() -> Option<(f64, f64, f64, f64)> {
    use core_graphics::display::{CGDirectDisplayID, CGDisplay};
    use core_graphics::event::CGEvent;
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    // The *online* list rather than the active one: the active list is empty in
    // process contexts without a full window-server session, and an empty list
    // would silently degrade every multi-display capture back to the main
    // screen. Online is the superset and reports the same bounds.
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGGetOnlineDisplayList(
            max: u32,
            displays: *mut CGDirectDisplayID,
            count: *mut u32,
        ) -> i32;
    }
    let mut ids = [0 as CGDirectDisplayID; 16];
    let mut count: u32 = 0;
    if unsafe { CGGetOnlineDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count) } != 0
        || count < 2
    {
        return None;
    }
    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState).ok()?;
    let cursor = CGEvent::new(source).ok()?.location();
    let bounds = ids[..count as usize]
        .iter()
        .map(|id| CGDisplay::new(*id).bounds())
        .find(|b| {
            cursor.x >= b.origin.x
                && cursor.x < b.origin.x + b.size.width
                && cursor.y >= b.origin.y
                && cursor.y < b.origin.y + b.size.height
        })?;
    Some((
        bounds.origin.x,
        bounds.origin.y,
        bounds.size.width,
        bounds.size.height,
    ))
}

#[cfg(not(target_os = "macos"))]
fn cursor_display_region() -> Option<(f64, f64, f64, f64)> {
    None
}

/// Like [`capture_screenshot`], but bounded to `region` (CG global display
/// coordinates, top-left origin, points) when given — the snip overlay's
/// selection path.
pub fn capture_screenshot_region(region: Option<(f64, f64, f64, f64)>) -> Option<Screenshot> {
    #[cfg(target_os = "macos")]
    {
        use base64::{engine::general_purpose::STANDARD, Engine};
        // Without Screen Recording permission screencapture returns a useless
        // wallpaper-only image (exit 0). Treat that as no capture so the panel
        // shows its "grant Screen Recording" hint instead of a blank screenshot.
        if !screen_recording_granted() {
            return None;
        }
        // Grab via the native `screencapture` tool, NOT xcap: on recent macOS
        // xcap's ScreenCaptureKit path stalls ~3.5s per frame (measured), which
        // was the entire perceived "launcher is laggy" delay — it's the first
        // thing the panel waits on before presenting. `screencapture` returns in
        // ~100ms; the one subprocess + temp file is well worth it. The 1600px cap
        // keeps the IPC payload and vision input bounded.
        let bytes = crate::capture::capture_region_jpeg_native(region, 1600)?;
        if bytes.is_empty() {
            return None;
        }
        Some(Screenshot {
            data: STANDARD.encode(&bytes),
            mime_type: "image/jpeg".into(),
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = region;
        None
    }
}
