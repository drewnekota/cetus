//! macOS: make the launcher a true Spotlight/Raycast-style overlay — it appears
//! on the user's current Space and takes keyboard focus WITHOUT activating cetus
//! (the menu bar / foreground app never change).
//!
//! The trick is a non-activating `NSPanel`. A plain `NSWindow` can only be key
//! while its app is active, and a *plain* `NSPanel` returns `canBecomeKeyWindow
//! = NO` for a borderless window — which is why an earlier naive reclass left
//! the panel completely inert. So we register an `NSPanel` SUBCLASS at runtime
//! that overrides `canBecomeKeyWindow → YES` (same approach as tauri-nspanel),
//! reclass the window to it, and give it the non-activating style mask +
//! all-Spaces collection behavior.
//!
//! Every call here touches AppKit and MUST run on the main thread.

use block2::RcBlock;
use objc2::encode::{Encode, Encoding};
use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
use objc2::{msg_send, sel};
use std::ffi::c_void;
use std::sync::{Mutex, OnceLock};

// Minimal AppKit geometry types (NSPoint/NSSize/NSRect are CGPoint/CGSize/CGRect
// on 64-bit macOS). We declare them locally with the right Objective-C struct
// encodings so `msg_send!` can return them by value without pulling in another
// crate.
#[repr(C)]
#[derive(Clone, Copy)]
struct NSPoint {
    x: f64,
    y: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct NSSize {
    width: f64,
    height: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct NSRect {
    origin: NSPoint,
    size: NSSize,
}

unsafe impl Encode for NSPoint {
    const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
}
unsafe impl Encode for NSSize {
    const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
}
unsafe impl Encode for NSRect {
    const ENCODING: Encoding = Encoding::Struct("CGRect", &[NSPoint::ENCODING, NSSize::ENCODING]);
}

// NSWindowStyleMask: borderless + non-activating panel.
const STYLE_NONACTIVATING_PANEL: usize = 1 << 7; // 128

// NSWindowCollectionBehavior bits.
const CAN_JOIN_ALL_SPACES: usize = 1 << 0; // 1
const STATIONARY: usize = 1 << 4; // 16
const FULL_SCREEN_AUXILIARY: usize = 1 << 8; // 256 — float over fullscreen apps
const COLLECTION_BEHAVIOR: usize = CAN_JOIN_ALL_SPACES | STATIONARY | FULL_SCREEN_AUXILIARY;

// NSWindowLevel: above ordinary windows.
const STATUS_WINDOW_LEVEL: isize = 25;

extern "C" {
    fn object_setClass(obj: *mut AnyObject, cls: *const AnyClass) -> *const AnyClass;
}

extern "C" fn can_become_key_window(_this: &AnyObject, _cmd: Sel) -> Bool {
    Bool::YES
}

extern "C" fn cannot_become_key_window(_this: &AnyObject, _cmd: Sel) -> Bool {
    Bool::NO
}

extern "C" fn can_become_main_window(_this: &AnyObject, _cmd: Sel) -> Bool {
    Bool::NO
}

/// Register (once) an NSPanel subclass that can become key while the app is
/// inactive. Stored as a raw pointer so it's `Send`/`Sync` in the `OnceLock`.
fn launcher_panel_class() -> *const AnyClass {
    static CLASS: OnceLock<usize> = OnceLock::new();
    *CLASS.get_or_init(|| {
        let superclass = AnyClass::get(c"NSPanel").expect("NSPanel runtime class");
        let mut builder = ClassBuilder::new(c"CetusLauncherPanel", superclass)
            .expect("register CetusLauncherPanel class");
        unsafe {
            builder.add_method(
                sel!(canBecomeKeyWindow),
                can_become_key_window as extern "C" fn(_, _) -> _,
            );
            builder.add_method(
                sel!(canBecomeMainWindow),
                can_become_main_window as extern "C" fn(_, _) -> _,
            );
        }
        builder.register() as *const AnyClass as usize
    }) as *const AnyClass
}

/// Register (once) an NSPanel subclass for the dictation HUD. Unlike the
/// launcher, it must NEVER become key — focus has to stay in the app the user is
/// dictating into so the injected keystrokes land there.
fn voice_hud_class() -> *const AnyClass {
    static CLASS: OnceLock<usize> = OnceLock::new();
    *CLASS.get_or_init(|| {
        let superclass = AnyClass::get(c"NSPanel").expect("NSPanel runtime class");
        let mut builder =
            ClassBuilder::new(c"CetusVoiceHud", superclass).expect("register CetusVoiceHud class");
        unsafe {
            builder.add_method(
                sel!(canBecomeKeyWindow),
                cannot_become_key_window as extern "C" fn(_, _) -> _,
            );
            builder.add_method(
                sel!(canBecomeMainWindow),
                can_become_main_window as extern "C" fn(_, _) -> _,
            );
        }
        builder.register() as *const AnyClass as usize
    }) as *const AnyClass
}

/// Reclass the HUD window into a non-activating, never-key panel and apply its
/// style / level / Spaces behavior. Call once after the window exists.
pub fn configure_hud(ns_window: *mut c_void) {
    if ns_window.is_null() {
        return;
    }
    let cls = voice_hud_class();
    let obj = ns_window as *mut AnyObject;
    unsafe {
        object_setClass(obj, cls);
        let window: &AnyObject = &*obj;
        let mask: usize = STYLE_NONACTIVATING_PANEL;
        let _: () = msg_send![window, setStyleMask: mask];
        let behavior: usize = COLLECTION_BEHAVIOR;
        let _: () = msg_send![window, setCollectionBehavior: behavior];
        let level: isize = STATUS_WINDOW_LEVEL;
        let _: () = msg_send![window, setLevel: level];
        let _: () = msg_send![window, setHidesOnDeactivate: Bool::NO];
        let _: () = msg_send![window, setFloatingPanel: Bool::YES];
        // No window shadow: the HUD is a transparent window with one small
        // capsule, so AppKit's rectangular drop shadow shows as a faint rounded
        // outline + a line above the pill. The capsule draws its own CSS shadow.
        let _: () = msg_send![window, setHasShadow: Bool::NO];
        // Belt-and-braces: force a fully transparent, shadow-free backing so the
        // ONLY thing ever on screen is the webview's CSS capsule — no window
        // background, no frost, no cached drop shadow peeking out behind the
        // (sometimes narrower) pill. Tauri's `transparent: true` already sets
        // these, but reclassing to the panel above can leave a stale opaque /
        // shadowed surface on some macOS versions — this nails it shut.
        let _: () = msg_send![window, setOpaque: Bool::NO];
        if let Some(ns_color) = AnyClass::get(c"NSColor") {
            let clear: *mut AnyObject = msg_send![ns_color, clearColor];
            let _: () = msg_send![window, setBackgroundColor: clear];
        }
        let _: () = msg_send![window, invalidateShadow];
    }
    disable_occlusion_throttling(ns_window);
}

/// Reclass the window into the non-activating launcher panel and apply its
/// style / level / Spaces behavior. Call once after the window exists.
pub fn configure(ns_window: *mut c_void) {
    if ns_window.is_null() {
        return;
    }
    let cls = launcher_panel_class();
    let obj = ns_window as *mut AnyObject;
    unsafe {
        object_setClass(obj, cls);
        let window: &AnyObject = &*obj;
        let mask: usize = STYLE_NONACTIVATING_PANEL;
        let _: () = msg_send![window, setStyleMask: mask];
        let behavior: usize = COLLECTION_BEHAVIOR;
        let _: () = msg_send![window, setCollectionBehavior: behavior];
        let level: isize = STATUS_WINDOW_LEVEL;
        let _: () = msg_send![window, setLevel: level];
        // Panels hide on app deactivation by default; cetus stays inactive while
        // the launcher is up, so keep it on screen.
        let _: () = msg_send![window, setHidesOnDeactivate: Bool::NO];
        let _: () = msg_send![window, setFloatingPanel: Bool::YES];
    }
    disable_occlusion_throttling(ns_window);
}

/// Disable WebKit's per-window occlusion throttling on `ns_window`.
///
/// macOS judges a parked / off-screen / occluded window to be "not visible" and
/// throttles its WKWebView: `requestAnimationFrame` drops to ~1 Hz, CSS
/// animations and timers stall, and after an idle stretch the rendered backing
/// store is discarded. The next `present` then has to wait for WebKit to
/// repaint, so the bare vibrancy (frosted gray) flashes in before the DOM does —
/// the idle flicker. This is SEPARATE from App Nap ([`prevent_app_nap`], a
/// process-level throttle): preventing App Nap does NOT stop per-window
/// occlusion suspension, which is why the parked-sliver keep-warm on its own
/// still flashes after a long idle.
///
/// `NSWindow` carries a private `windowOcclusionDetectionEnabled` flag — the same
/// one WebKitTestRunner clears to keep its web view rendering while occluded, and
/// that Raycast clears for its launcher. We clear it via KVC. The key is
/// uncontracted, so the set runs inside an Obj-C `@try` guard: on a macOS build
/// that ever drops it, the resulting `NSUnknownKeyException` is caught and logged
/// rather than aborting. Call once per window after it exists.
pub fn disable_occlusion_throttling(ns_window: *mut c_void) {
    if ns_window.is_null() {
        return;
    }
    let obj = ns_window as *mut AnyObject;
    // `*mut AnyObject` isn't `UnwindSafe` (AnyObject holds interior mutability),
    // so assert it across the catch boundary — we only read the pointer.
    let caught = objc2::exception::catch(core::panic::AssertUnwindSafe(|| unsafe {
        let window: &AnyObject = &*obj;
        let (Some(num_cls), Some(str_cls)) =
            (AnyClass::get(c"NSNumber"), AnyClass::get(c"NSString"))
        else {
            return;
        };
        let no: *mut AnyObject = msg_send![num_cls, numberWithBool: Bool::NO];
        let key: *mut AnyObject = msg_send![
            str_cls,
            stringWithUTF8String: c"windowOcclusionDetectionEnabled".as_ptr()
        ];
        let _: () = msg_send![window, setValue: no, forKey: key];
    }));
    if caught.is_err() {
        tracing::warn!(
            "disable_occlusion_throttling: NSWindow rejected the private \
             `windowOcclusionDetectionEnabled` KVC key (unsupported on this macOS?); \
             idle re-show may flash the vibrancy surface"
        );
    } else {
        tracing::debug!("disable_occlusion_throttling: cleared windowOcclusionDetectionEnabled");
    }
}

/// Center `ns_window` on the screen that currently holds the mouse cursor —
/// Raycast behavior: the launcher follows the mouse across displays, no click
/// needed to "activate" a screen first. Works entirely in AppKit coordinates
/// (points, bottom-left origin) so there's no coordinate-space mismatch.
///
/// `NSEvent.mouseLocation` is the live global cursor position regardless of
/// which app/window is key, which is exactly why this is reliable where Tauri's
/// `center()` (keyed to the active screen) is not.
pub fn center_on_mouse_screen(ns_window: *mut c_void) {
    if ns_window.is_null() {
        return;
    }
    let obj = ns_window as *mut AnyObject;
    unsafe {
        let Some(frame) = mouse_screen_frame() else {
            return;
        };
        let window: &AnyObject = &*obj;
        let win_frame: NSRect = msg_send![window, frame];
        let free_x = frame.size.width - win_frame.size.width;
        let free_y = frame.size.height - win_frame.size.height;
        // Horizontally centered; vertically biased upward — the panel sits
        // halfway between dead-center and the top (Raycast-style), so 3/4 of the
        // free vertical space ends up below it (AppKit y grows upward).
        let x = frame.origin.x + free_x / 2.0;
        let y = frame.origin.y + free_y * 0.75;
        let origin = NSPoint { x, y };
        let _: () = msg_send![window, setFrameOrigin: origin];
    }
}

/// Park `ns_window` at the bottom-center of the screen that currently holds
/// the mouse cursor — the dictation HUD's Wispr-style resting spot. Same
/// AppKit-native screen lookup as `center_on_mouse_screen`: Tauri's
/// `cursor_position()` reports physical pixels while macOS
/// `monitor_from_point()` expects AppKit points, so that pairing misresolves
/// on scaled/secondary displays and the HUD lands on the primary monitor.
pub fn bottom_center_on_mouse_screen(ns_window: *mut c_void) {
    if ns_window.is_null() {
        return;
    }
    let obj = ns_window as *mut AnyObject;
    unsafe {
        let Some(frame) = mouse_screen_frame() else {
            return;
        };
        let window: &AnyObject = &*obj;
        let win_frame: NSRect = msg_send![window, frame];
        // Sit near the very bottom of the screen (just above a typical Dock).
        let margin = 36.0;
        let x = frame.origin.x + (frame.size.width - win_frame.size.width) / 2.0;
        let y = frame.origin.y + margin;
        let origin = NSPoint {
            x: x.max(frame.origin.x),
            y,
        };
        let _: () = msg_send![window, setFrameOrigin: origin];
    }
}

/// Park `ns_window` at the top-center of the screen that currently holds the
/// mouse cursor, just below the menu bar — the meeting pill's resting spot,
/// mirroring where macOS puts its own screen-recording indicator.
pub fn top_center_on_mouse_screen(ns_window: *mut c_void) {
    if ns_window.is_null() {
        return;
    }
    let obj = ns_window as *mut AnyObject;
    unsafe {
        let Some(visible) = mouse_screen_visible_frame() else {
            return;
        };
        let window: &AnyObject = &*obj;
        let win_frame: NSRect = msg_send![window, frame];
        let margin = 6.0;
        let x = visible.origin.x + (visible.size.width - win_frame.size.width) / 2.0;
        let y = visible.origin.y + visible.size.height - win_frame.size.height - margin;
        let origin = NSPoint {
            x: x.max(visible.origin.x),
            y,
        };
        let _: () = msg_send![window, setFrameOrigin: origin];
    }
}

/// `visibleFrame` (excludes the menu bar and Dock) of the screen that currently
/// holds the mouse cursor. Containment is tested against the full frame — the
/// cursor can legitimately sit in the menu bar.
unsafe fn mouse_screen_visible_frame() -> Option<NSRect> {
    let ns_event = AnyClass::get(c"NSEvent")?;
    let ns_screen = AnyClass::get(c"NSScreen")?;
    let mouse: NSPoint = msg_send![ns_event, mouseLocation];
    let screens: *mut AnyObject = msg_send![ns_screen, screens];
    if screens.is_null() {
        return None;
    }
    let count: usize = msg_send![screens, count];
    for i in 0..count {
        let screen: *mut AnyObject = msg_send![screens, objectAtIndex: i];
        if screen.is_null() {
            continue;
        }
        let f: NSRect = msg_send![screen, frame];
        if mouse.x >= f.origin.x
            && mouse.x < f.origin.x + f.size.width
            && mouse.y >= f.origin.y
            && mouse.y < f.origin.y + f.size.height
        {
            let v: NSRect = msg_send![screen, visibleFrame];
            return Some(v);
        }
    }
    None
}

/// Frame of the screen that currently holds the mouse cursor, in AppKit
/// coordinates (points, bottom-left origin).
///
/// `NSEvent.mouseLocation` is the live global cursor position regardless of
/// which app/window is key, which is exactly why this is reliable where Tauri's
/// `center()` (keyed to the active screen) is not.
unsafe fn mouse_screen_frame() -> Option<NSRect> {
    let ns_event = AnyClass::get(c"NSEvent")?;
    let ns_screen = AnyClass::get(c"NSScreen")?;
    let mouse: NSPoint = msg_send![ns_event, mouseLocation];
    let screens: *mut AnyObject = msg_send![ns_screen, screens];
    if screens.is_null() {
        return None;
    }
    let count: usize = msg_send![screens, count];
    // Find the screen whose frame contains the cursor.
    for i in 0..count {
        let screen: *mut AnyObject = msg_send![screens, objectAtIndex: i];
        if screen.is_null() {
            continue;
        }
        let f: NSRect = msg_send![screen, frame];
        if mouse.x >= f.origin.x
            && mouse.x < f.origin.x + f.size.width
            && mouse.y >= f.origin.y
            && mouse.y < f.origin.y + f.size.height
        {
            return Some(f);
        }
    }
    None
}

/// Bring the panel to the current Space and give it key focus WITHOUT
/// activating cetus. Re-asserts collection behavior in case it was reset.
///
/// Deliberately uses `orderFrontRegardless` + `makeKeyWindow` rather than
/// `makeKeyAndOrderFront:`. The latter activates the owning app even for a
/// non-activating panel — which yanks cetus's (hidden/background) main window to
/// the foreground on every launcher open. The two-step form orders the panel
/// up and makes it key for typing while cetus stays inactive. The app is only
/// brought forward on submit (see `quick_submit`).
pub fn present(ns_window: *mut c_void) {
    if ns_window.is_null() {
        return;
    }
    let obj = ns_window as *mut AnyObject;
    unsafe {
        let window: &AnyObject = &*obj;
        let behavior: usize = COLLECTION_BEHAVIOR;
        let _: () = msg_send![window, setCollectionBehavior: behavior];
        // Undo a prior `park`: the panel may have been left click-through while
        // warming off-screen. Re-enable hit-testing before it takes key focus.
        let _: () = msg_send![window, setIgnoresMouseEvents: Bool::new(false)];
        let _: () = msg_send![window, orderFrontRegardless];
        let _: () = msg_send![window, makeKeyWindow];
    }
}

// Retained `id` returned by `addGlobalMonitorForEventsMatchingMask:handler:`,
// stored as a pointer-sized int so it survives across the present/park pair. 0 =
// no monitor installed. Only touched on the main thread (install/remove are both
// invoked from main-thread closures), but guarded so the type is `Sync`.
static CLICK_MONITOR: Mutex<usize> = Mutex::new(0);

// NSEventMask bits for the buttons that should count as an "outside click".
const NS_EVENT_MASK_LEFT_MOUSE_DOWN: u64 = 1 << 1;
const NS_EVENT_MASK_RIGHT_MOUSE_DOWN: u64 = 1 << 3;
const NS_EVENT_MASK_OTHER_MOUSE_DOWN: u64 = 1 << 25;

/// Install a global mouse-down monitor so the launcher dismisses when the user
/// clicks anywhere outside it — the Raycast/Spotlight mechanism.
///
/// A global monitor only sees events delivered to *other* applications, so a
/// click inside our own (key) panel never fires it; we don't have to hit-test.
/// This is far more reliable than `windowDidResignKey` for a non-activating
/// floating `NSPanel`, which keeps key across many app/desktop switches and so
/// misses most outside clicks. Mouse monitoring needs no Accessibility grant
/// (only keyboard monitoring does). Replaces any monitor already installed.
/// MUST run on the main thread.
pub fn install_outside_click_monitor(handler: impl Fn() + 'static) {
    remove_outside_click_monitor();
    let block = RcBlock::new(move |_event: *mut AnyObject| handler());
    unsafe {
        let Some(ns_event) = AnyClass::get(c"NSEvent") else {
            return;
        };
        let mask: u64 = NS_EVENT_MASK_LEFT_MOUSE_DOWN
            | NS_EVENT_MASK_RIGHT_MOUSE_DOWN
            | NS_EVENT_MASK_OTHER_MOUSE_DOWN;
        let monitor: *mut AnyObject = msg_send![
            ns_event,
            addGlobalMonitorForEventsMatchingMask: mask,
            handler: &*block,
        ];
        if monitor.is_null() {
            return;
        }
        // The returned token is autoreleased; retain it so it's still valid when
        // `removeMonitor:` is called later.
        let retained: *mut AnyObject = msg_send![monitor, retain];
        if let Ok(mut g) = CLICK_MONITOR.lock() {
            *g = retained as usize;
        }
    }
}

/// Tear down the global mouse-down monitor installed by
/// [`install_outside_click_monitor`]. No-op if none is installed. MUST run on
/// the main thread.
pub fn remove_outside_click_monitor() {
    let ptr = match CLICK_MONITOR.lock() {
        Ok(mut g) => std::mem::replace(&mut *g, 0),
        Err(_) => 0,
    };
    if ptr == 0 {
        return;
    }
    unsafe {
        let Some(ns_event) = AnyClass::get(c"NSEvent") else {
            return;
        };
        let obj = ptr as *mut AnyObject;
        let _: () = msg_send![ns_event, removeMonitor: obj];
        let _: () = msg_send![obj, release];
    }
}

/// Every display's full frame, in the global bottom-left coordinate space. Used
/// to pick a park corner that borders no other monitor.
unsafe fn all_screen_frames() -> Vec<NSRect> {
    let mut frames = Vec::new();
    let Some(screen_cls) = AnyClass::get(c"NSScreen") else {
        return frames;
    };
    let arr: *mut AnyObject = msg_send![screen_cls, screens];
    if arr.is_null() {
        return frames;
    }
    let n: usize = msg_send![arr, count];
    for i in 0..n {
        let s: *mut AnyObject = msg_send![arr, objectAtIndex: i];
        if !s.is_null() {
            frames.push(msg_send![s, frame]);
        }
    }
    frames
}

/// Origin (bottom-left) that parks a window of size `wf` as a ~1px corner sliver
/// on the main screen `vf`, with the rest of the window hanging off a corner that
/// borders NO other display.
///
/// The keep-warm sliver must stay on-screen (off all screens → WebKit purges the
/// backing store), but the naive top-right corner spills the window *body* onto a
/// monitor placed to the right or above the main screen — which is how the whole
/// launcher ends up permanently showing on the second screen. We flip each axis
/// toward a free side so the body always hangs into dead space.
fn parked_sliver_origin(vf: NSRect, wf: NSRect, frames: &[NSRect]) -> NSPoint {
    const EPS: f64 = 1.0;
    let (vmin_x, vmax_x) = (vf.origin.x, vf.origin.x + vf.size.width);
    let (vmin_y, vmax_y) = (vf.origin.y, vf.origin.y + vf.size.height);
    let overlaps_h =
        |f: &NSRect| f.origin.x < vmax_x - EPS && f.origin.x + f.size.width > vmin_x + EPS;
    let overlaps_v =
        |f: &NSRect| f.origin.y < vmax_y - EPS && f.origin.y + f.size.height > vmin_y + EPS;
    // A side is "occupied" when another display sits just past that edge of the
    // main screen, sharing extent along the perpendicular axis.
    let occ_right = frames
        .iter()
        .any(|f| f.origin.x >= vmax_x - EPS && overlaps_v(f));
    let occ_left = frames
        .iter()
        .any(|f| f.origin.x + f.size.width <= vmin_x + EPS && overlaps_v(f));
    let occ_top = frames
        .iter()
        .any(|f| f.origin.y >= vmax_y - EPS && overlaps_h(f));
    let occ_bottom = frames
        .iter()
        .any(|f| f.origin.y + f.size.height <= vmin_y + EPS && overlaps_h(f));
    // Keep the original top-right corner unless that side has a neighbour, then
    // flip to the opposite (free) side. If both sides of an axis are taken (3+
    // displays in a line) the spill is unavoidable — keep the original side.
    let go_right = !occ_right || occ_left;
    let go_top = !occ_top || occ_bottom;
    let x = if go_right {
        vmax_x - EPS
    } else {
        vmin_x + EPS - wf.size.width
    };
    let y = if go_top {
        vmax_y - EPS
    } else {
        vmin_y + EPS - wf.size.height
    };
    NSPoint { x, y }
}

/// Dismiss the panel WITHOUT ordering it fully out, so its WKWebView stays warm.
///
/// Tauri's `hide()` maps to `orderOut:`, which makes the window occluded; macOS
/// then suspends the webview's rendering and, once the window has sat idle,
/// *discards its backing store*. The next `present` has to wait for WebKit to
/// repaint, so the bare vibrancy (gray) flashes into the real UI — the idle
/// flicker. (App Nap, handled by [`prevent_app_nap`], is a *separate*, process-
/// level throttle; preventing it does not stop per-window occlusion suspension.)
///
/// Instead we keep the window ordered-in but shrink its on-screen footprint to a
/// single click-through pixel in the top-right corner of the usable screen. It
/// stays non-occluded, so WebKit keeps the frame alive; `present` just moves it
/// back to center. The window is never resized (only its origin moves), so there
/// is no relayout to repaint. The brief `orderOut` → `orderFrontRegardless` hands
/// keyboard focus back to the previously-active app (the panel may still be key
/// when dismissed via Esc / the gesture) without leaving the webview suspended:
/// the order-out is momentary, far short of the idle delay that triggers a purge.
pub fn park(ns_window: *mut c_void) {
    if ns_window.is_null() {
        return;
    }
    let obj = ns_window as *mut AnyObject;
    unsafe {
        let window: &AnyObject = &*obj;
        // Bind the parked sliver to the CURRENT Space (drop `canJoinAllSpaces`,
        // which `configure`/`present` set so the launcher can pop on any Space).
        // A canJoinAllSpaces window gets dragged into every Space-switch
        // animation — so the parked 1px sliver flashes each time you change
        // desktops. Space-bound, it just sits still on its Space. `present`
        // re-adds canJoinAllSpaces before showing, so the launcher still appears
        // on whatever Space is active when the gesture fires.
        let default_behavior: usize = 0; // NSWindowCollectionBehaviorDefault
        let _: () = msg_send![window, setCollectionBehavior: default_behavior];
        // 1px sliver at the top-right of the usable frame (clear of the menu bar
        // and the Dock, so it is never occluded by them). Only the origin moves.
        if let Some(screen_cls) = AnyClass::get(c"NSScreen") {
            let screen: *mut AnyObject = msg_send![screen_cls, mainScreen];
            if !screen.is_null() {
                let vf: NSRect = msg_send![screen, visibleFrame];
                let wf: NSRect = msg_send![window, frame];
                let origin = parked_sliver_origin(vf, wf, &all_screen_frames());
                let _: () = msg_send![window, setFrameOrigin: origin];
            }
        }
        // Make the sliver inert, then hand key focus back and re-add the window
        // ordered-in (NOT key) so it keeps painting.
        let _: () = msg_send![window, setIgnoresMouseEvents: Bool::new(true)];
        let null: *mut AnyObject = std::ptr::null_mut();
        let _: () = msg_send![window, orderOut: null];
        let _: () = msg_send![window, orderFrontRegardless];
    }
}

/// Like [`park`], but for the **main** window — decorated and user-placed, so it
/// needs three extra things the borderless launcher panel doesn't:
///   * its current origin is read and returned so [`unpark_main_window`] can put
///     it back exactly where the user left it (the launcher just re-centers);
///   * its drop shadow is dropped — a decorated window's shadow would smudge
///     onto the visible screen around the 1px sliver;
///   * its style mask is stripped to borderless for the duration of the park.
///     AppKit's constrain pass drags a *titled* window's frame fully back on
///     screen whenever it is ordered front (observed on macOS 14: "closing"
///     just bumped the window into the top-right corner, still fully visible
///     and — with `ignoresMouseEvents` set — completely inert). Borderless
///     windows are left alone, and with `fullSizeContentView` the content
///     layout doesn't change. Bonus: a borderless window refuses key status,
///     so the parked sliver can never sit there holding keyboard focus.
/// Stays Space-bound (we do NOT set `canJoinAllSpaces`): a window that joins all
/// Spaces gets dragged into every Space-switch animation and the 1px sliver
/// flashes on each desktop change. The cost is that switching Spaces leaves it
/// occluded on its old Space, so a reopen from a different Space after a long
/// idle may flash once (cold) — far rarer than flashing on every switch.
/// Returns the pre-park origin + style mask to stash for restore, or `None` if
/// there is no window to park.
pub fn park_main_window(ns_window: *mut c_void) -> Option<(f64, f64, usize)> {
    if ns_window.is_null() {
        return None;
    }
    let obj = ns_window as *mut AnyObject;
    unsafe {
        let window: &AnyObject = &*obj;
        let f: NSRect = msg_send![window, frame];
        let mask: usize = msg_send![window, styleMask];
        let saved = (f.origin.x, f.origin.y, mask);
        let borderless: usize = 0; // NSWindowStyleMaskBorderless
        let _: () = msg_send![window, setStyleMask: borderless];
        if let Some(screen_cls) = AnyClass::get(c"NSScreen") {
            let screen: *mut AnyObject = msg_send![screen_cls, mainScreen];
            if !screen.is_null() {
                let vf: NSRect = msg_send![screen, visibleFrame];
                let origin = parked_sliver_origin(vf, f, &all_screen_frames());
                let _: () = msg_send![window, setFrameOrigin: origin];
            }
        }
        let default_behavior: usize = 0; // NSWindowCollectionBehaviorDefault — Space-bound, no switch-flash
        let _: () = msg_send![window, setCollectionBehavior: default_behavior];
        let _: () = msg_send![window, setHasShadow: Bool::new(false)];
        let _: () = msg_send![window, setIgnoresMouseEvents: Bool::new(true)];
        let null: *mut AnyObject = std::ptr::null_mut();
        // orderOut removes the window from Mission Control. We do NOT follow
        // it with orderFrontRegardless: the old sliver-on-screen trick was
        // needed so that is_visible() returned true for the toggle logic, but
        // toggle_main now gates on !main_is_parked() first, so is_visible()
        // is irrelevant when parked. Keeping the window ordered-out means
        // Mission Control stays clean after ⌘W.
        let _: () = msg_send![window, orderOut: null];
        Some(saved)
    }
}

/// Undo [`park_main_window`]: restore the saved origin and style mask, the
/// shadow, hit-testing, and normal (Space-bound) collection behavior. The
/// caller still does the Tauri `show()` / `set_focus()` to bring it forward
/// and activate the app.
pub fn unpark_main_window(ns_window: *mut c_void, x: f64, y: f64, style_mask: usize) {
    if ns_window.is_null() {
        return;
    }
    let obj = ns_window as *mut AnyObject;
    unsafe {
        let window: &AnyObject = &*obj;
        let default_behavior: usize = 0; // NSWindowCollectionBehaviorDefault
        let _: () = msg_send![window, setCollectionBehavior: default_behavior];
        // Move back on screen FIRST, while still borderless: restoring the
        // titled mask at the off-screen sliver position would let AppKit's
        // constrain pass yank the frame somewhere arbitrary on screen before
        // we set the real origin.
        let origin = NSPoint { x, y };
        let _: () = msg_send![window, setFrameOrigin: origin];
        let _: () = msg_send![window, setStyleMask: style_mask];
        let _: () = msg_send![window, setHasShadow: Bool::new(true)];
        let _: () = msg_send![window, setIgnoresMouseEvents: Bool::new(false)];
    }
}

/// Install a one-shot observer that runs `cb` on the main thread every time cetus
/// becomes the active application — by ANY route (Cmd-Tab, Mission Control /
/// three-finger-swipe, App Exposé, clicking the app), not just a Dock reopen.
///
/// [`park_main_window`] leaves a closed main window fully ordered-out (so Mission
/// Control stays clean). The price is that such a window is unreachable through
/// the normal channels: it's gone from Mission Control, it can't receive a Tauri
/// `Focused` event, and Tauri's `Reopen` only fires for a Dock-icon click. This
/// observer is the catch-all that brings it back on whatever activation the user
/// performs; the callback decides whether anything is actually parked.
///
/// The observer (and its copied block) is intentionally leaked — it lives for the
/// whole process and is never removed.
pub fn install_app_active_observer<F: Fn() + 'static>(cb: F) {
    static INSTALLED: OnceLock<()> = OnceLock::new();
    if INSTALLED.set(()).is_err() {
        return; // already installed
    }
    unsafe {
        let Some(center_cls) = AnyClass::get(c"NSNotificationCenter") else {
            return;
        };
        let center: *mut AnyObject = msg_send![center_cls, defaultCenter];
        let Some(str_cls) = AnyClass::get(c"NSString") else {
            return;
        };
        // A freshly built NSString with the same characters matches the
        // NSApplicationDidBecomeActiveNotification constant: the center compares
        // names by string equality.
        let name_c = c"NSApplicationDidBecomeActiveNotification";
        let name: *mut AnyObject = msg_send![str_cls, stringWithUTF8String: name_c.as_ptr()];
        let block = RcBlock::new(move |_note: *mut AnyObject| {
            cb();
        });
        let null: *mut AnyObject = std::ptr::null_mut();
        // queue: nil → the block runs on the posting thread, which for app
        // activation is the main thread. object: nil → any sender.
        let token: *mut AnyObject = msg_send![
            center,
            addObserverForName: name,
            object: null,
            queue: null,
            usingBlock: &*block,
        ];
        // Keep the token (and thus the system's copied block) alive forever.
        let _: *mut AnyObject = msg_send![token, retain];
        std::mem::forget(block);
    }
}

/// First half of a paint-synced show: make `ns_window` fully transparent WITHOUT
/// changing its order, so it can be ordered front and activated while the user
/// sees nothing. Pair with [`reveal_after_paint`].
///
/// Used on the main window's unpark path: a window parked (ordered-out) through
/// a long idle can have its WKWebView backing store discarded, so showing it
/// opaque flashes the bare vibrancy surface before the DOM repaints. Disabling
/// occlusion detection ([`disable_occlusion_throttling`]) keeps the *parked*
/// webview warm, but a fully ordered-out window is still deprioritized — so the
/// main window also needs this gate on the way back in.
pub fn hide_alpha(ns_window: *mut c_void) {
    if ns_window.is_null() {
        return;
    }
    let obj = ns_window as *mut AnyObject;
    unsafe {
        let window: &AnyObject = &*obj;
        let _: () = msg_send![window, setAlphaValue: 0.0f64];
    }
}

/// Second half of a paint-synced show: reveal `ns_window` (alpha → 1) only once
/// its WKWebView has handed over a rendered frame, so a window whose backing
/// store was discarded during a long parked idle never shows the bare vibrancy
/// surface before the DOM paints.
///
/// Fast path: WebKit's private but ~decade-stable `_doAfterNextPresentationUpdate:`
/// fires right after the next painted frame (the same call Raycast uses to sync
/// window visibility to webview paint). Guaranteed path: a one-shot ~300 ms
/// main-thread `NSTimer` also reveals, so the window can never get stuck
/// invisible if that private selector is missing (OS change) or never fires
/// (webview still suspended). Both just set alpha to 1 — idempotent, so whichever
/// lands first wins and the other no-ops.
pub fn reveal_after_paint(ns_window: *mut c_void) {
    if ns_window.is_null() {
        return;
    }
    let obj = ns_window as *mut AnyObject;
    unsafe {
        let window: &AnyObject = &*obj;
        // Fast path: reveal after the webview's next presentation update.
        let content: *mut AnyObject = msg_send![window, contentView];
        let webview = if content.is_null() {
            None
        } else {
            find_wkwebview(content)
        };
        let responds = if let Some(webview) = webview {
            let r: Bool =
                msg_send![webview, respondsToSelector: sel!(_doAfterNextPresentationUpdate:)];
            if r.as_bool() {
                let w_ptr = obj as usize;
                let reveal = RcBlock::new(move || {
                    let win = &*(w_ptr as *mut AnyObject);
                    let _: () = msg_send![win, setAlphaValue: 1.0f64];
                    tracing::debug!("reveal_after_paint: revealed via presentation-update");
                });
                let _: () = msg_send![webview, _doAfterNextPresentationUpdate: &*reveal];
            }
            r.as_bool()
        } else {
            false
        };
        tracing::debug!(
            "reveal_after_paint: webview_found={}, presentation_update={}",
            webview.is_some(),
            responds
        );
        // Safety net only: reveal no later than ~2 s if the presentation-update
        // callback is missing (selector gone) or never fires (webview still
        // waking). Generous on purpose — after a long idle the WebContent
        // process can be relaunched cold, and a too-short ceiling would reveal
        // the window mid-repaint (the very flash we're killing). The fast path
        // above reveals as soon as the frame actually lands, so this ceiling
        // costs nothing in the normal case.
        if let Some(timer_cls) = AnyClass::get(c"NSTimer") {
            let w_ptr = obj as usize;
            let fire = RcBlock::new(move |_timer: *mut AnyObject| {
                let win = &*(w_ptr as *mut AnyObject);
                let visible: f64 = msg_send![win, alphaValue];
                if visible < 1.0 {
                    let _: () = msg_send![win, setAlphaValue: 1.0f64];
                    tracing::debug!("reveal_after_paint: revealed via 2s fallback timer");
                }
            });
            let _: *mut AnyObject = msg_send![
                timer_cls,
                scheduledTimerWithTimeInterval: 2.0f64,
                repeats: Bool::NO,
                block: &*fire,
            ];
        }
    }
}

/// Defensively re-enable mouse hit-testing (and the drop shadow) on a window.
///
/// [`park_main_window`] sets `ignoresMouseEvents: true` on the off-screen sliver
/// so it never intercepts clicks; [`unpark_main_window`] clears it again. The
/// park and the unpark now both run on the main thread holding the
/// `MAIN_PARKED_ORIGIN` lock, so they can no longer interleave — but a window
/// shown with the flag leaked looks normal (caret blinks, DOM stays focused)
/// while clicks pass straight through, so it can't be clicked to take key focus
/// and the keyboard goes dead until an app-level activation (Cmd-Tab) keys it
/// from the side. Cheap insurance against any remaining path to that state:
///
/// * [`crate::focus_main`] calls this on every non-parked summon, so a window
///   we are about to show is always clickable (the title-bar close button
///   included) even before it ever becomes key;
/// * the main window's `Focused(true)` handler calls it on every key-gain —
///   a key window must never ignore the mouse, and a parked sliver is never
///   meant to be key, so this is always safe and idempotent.
pub fn enable_mouse_events(ns_window: *mut c_void) {
    if ns_window.is_null() {
        return;
    }
    let obj = ns_window as *mut AnyObject;
    unsafe {
        let window: &AnyObject = &*obj;
        let _: () = msg_send![window, setIgnoresMouseEvents: Bool::new(false)];
        let _: () = msg_send![window, setHasShadow: Bool::new(true)];
    }
}

/// Re-arm the main window's WKWebView as first responder so the keyboard works.
///
/// After the app sits idle/occluded for a long time, WebKit can suspend the web
/// content process; on return it relaunches and repaints, but the AppKit
/// first-responder → web-content text-input binding is left stale. The window
/// looks fine and a click even shows a caret in the composer, yet keystrokes
/// never reach the page — the classic "input box won't type after long idle"
/// symptom. `enable_mouse_events` heals a deadened *mouse*, but not this: the
/// mouse is fine, it's the key-event routing that's broken.
///
/// Re-making the WKWebView the window's first responder rebuilds that routing.
/// It's idempotent during normal editing — while you type in a web text field
/// the WKWebView is *already* first responder, so this no-ops and never moves
/// the caret — so it's safe to fire on every key-window gain alongside the
/// mouse heal.
pub fn rearm_web_input(ns_window: *mut c_void) {
    if ns_window.is_null() {
        return;
    }
    let obj = ns_window as *mut AnyObject;
    unsafe {
        let window: &AnyObject = &*obj;
        let content: *mut AnyObject = msg_send![window, contentView];
        if content.is_null() {
            return;
        }
        if let Some(webview) = find_wkwebview(content) {
            let _: Bool = msg_send![window, makeFirstResponder: webview];
        }
    }
}

/// Depth-first search for the WKWebView under `view` (wry nests it inside its own
/// container NSView). Returns the first match, or `None` if the hierarchy holds
/// no web view.
unsafe fn find_wkwebview(view: *mut AnyObject) -> Option<*mut AnyObject> {
    if view.is_null() {
        return None;
    }
    if let Some(wk) = AnyClass::get(c"WKWebView") {
        let is: Bool = msg_send![view, isKindOfClass: wk];
        if is.as_bool() {
            return Some(view);
        }
    }
    let subviews: *mut AnyObject = msg_send![view, subviews];
    if subviews.is_null() {
        return None;
    }
    let count: usize = msg_send![subviews, count];
    for i in 0..count {
        let sub: *mut AnyObject = msg_send![subviews, objectAtIndex: i];
        if let Some(found) = find_wkwebview(sub) {
            return Some(found);
        }
    }
    None
}

/// Order a window off-screen (hide it) synchronously on the main thread.
///
/// Presenting the launcher un-hides a `Cmd+H`-hidden app, which makes AppKit
/// restore the app's *other* windows (the main window) too. open_panel calls
/// this right after `present` to push the main window back out when it wasn't on
/// screen before — so only the launcher shows. Done in the same main-thread pass
/// as the present, so the restore never reaches the screen.
pub fn order_out(ns_window: *mut c_void) {
    if ns_window.is_null() {
        return;
    }
    let obj = ns_window as *mut AnyObject;
    unsafe {
        let window: &AnyObject = &*obj;
        let null: *mut AnyObject = std::ptr::null_mut();
        let _: () = msg_send![window, orderOut: null];
    }
}

/// Hold an `NSProcessInfo` activity assertion for the app's lifetime so macOS
/// doesn't put cetus under **App Nap** while it sits idle in the background.
///
/// Under App Nap the WKWebView stops rendering, so switching back to a window
/// that's been unused for a while flashes the bare vibrancy surface (the gray
/// the sidebar normally rides on, with no DOM painted) until WebKit repaints.
/// cetus also does real background work (screen capture, automations, the
/// dreamer), so staying un-napped is wanted regardless. The returned token is
/// intentionally leaked — ending the activity would re-enable App Nap.
pub fn prevent_app_nap() {
    // NSActivityUserInitiatedAllowingIdleSystemSleep — prevents App Nap (and
    // sudden / automatic termination) while still letting the system idle-sleep.
    const NS_ACTIVITY_USER_INITIATED_ALLOWING_IDLE_SYSTEM_SLEEP: u64 = 0x00FF_FFFF;
    unsafe {
        let (Some(pinfo_cls), Some(str_cls)) =
            (AnyClass::get(c"NSProcessInfo"), AnyClass::get(c"NSString"))
        else {
            return;
        };
        let pinfo: *mut AnyObject = msg_send![pinfo_cls, processInfo];
        if pinfo.is_null() {
            return;
        }
        let reason: *mut AnyObject = msg_send![
            str_cls,
            stringWithUTF8String: c"cetus keeps its window rendered".as_ptr()
        ];
        let activity: *mut AnyObject = msg_send![
            pinfo,
            beginActivityWithOptions: NS_ACTIVITY_USER_INITIATED_ALLOWING_IDLE_SYSTEM_SLEEP,
            reason: reason
        ];
        // Retain past the autorelease pool and leak: the assertion must outlive
        // this scope (the whole process run).
        let _: *mut AnyObject = msg_send![activity, retain];
    }
}

/// Whether cetus is the frontmost (active) application. Used by the summon
/// hotkey to decide between bringing the app forward and hiding it.
pub fn app_is_active() -> bool {
    unsafe {
        let Some(cls) = AnyClass::get(c"NSApplication") else {
            return false;
        };
        let app: *mut AnyObject = msg_send![cls, sharedApplication];
        if app.is_null() {
            return false;
        }
        let active: Bool = msg_send![app, isActive];
        active.as_bool()
    }
}

/// Hide cetus exactly like ⌘H: orders out every window AND deactivates the app,
/// handing key focus back to the previously active app. (`NSWindow.orderOut`
/// alone would leave cetus active with no visible window.)
pub fn hide_app() {
    unsafe {
        let Some(cls) = AnyClass::get(c"NSApplication") else {
            return;
        };
        let app: *mut AnyObject = msg_send![cls, sharedApplication];
        if app.is_null() {
            return;
        }
        let null: *mut AnyObject = std::ptr::null_mut();
        let _: () = msg_send![app, hide: null];
    }
}

/// Bring the HUD onto the current Space, floating above other apps, WITHOUT
/// taking key focus (so the app being dictated into keeps it).
pub fn present_inactive(ns_window: *mut c_void) {
    if ns_window.is_null() {
        return;
    }
    let obj = ns_window as *mut AnyObject;
    unsafe {
        let window: &AnyObject = &*obj;
        let behavior: usize = COLLECTION_BEHAVIOR;
        let _: () = msg_send![window, setCollectionBehavior: behavior];
        let _: () = msg_send![window, orderFrontRegardless];
    }
}
