//! macOS: make the launcher a true Spotlight/Raycast-style overlay — it appears
//! on the user's current Space and takes keyboard focus WITHOUT activating cetus
//! (the menu bar / foreground app never change).
//!
//! The trick is a non-activating `NSPanel`. A plain `NSWindow` can only be key
//! while its app is active, and a *plain* `NSPanel` returns `canBecomeKeyWindow
//! = NO` for a borderless window — which is why an earlier naive reclass left
//! the panel completely inert. So we register an `NSPanel` SUBCLASS at runtime
//! that overrides `canBecomeKeyWindow → YES` (the tauri-nspanel approach),
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

#[allow(dead_code)]
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
#[allow(dead_code)]
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
#[allow(dead_code)]
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

/// Whether `obj` is an `NSPanel` (Electron's `type: 'panel'` windows are; the
/// panel-only setters below must not be sent to anything else).
unsafe fn is_panel(obj: &AnyObject) -> bool {
    match AnyClass::get(c"NSPanel") {
        Some(cls) => {
            let yes: Bool = msg_send![obj, isKindOfClass: cls];
            yes.as_bool()
        }
        None => false,
    }
}

/// Reclass the HUD window into a non-activating, never-key panel and apply its
/// style / level / Spaces behavior. Call once after the window exists.
pub fn configure_hud(ns_window: *mut c_void) {
    if ns_window.is_null() {
        return;
    }
    let obj = ns_window as *mut AnyObject;
    unsafe {
        // Electron creates these as `type: 'panel'` NSPanels already
        // (focusable or not); reclassing its window would break Electron.
        let window: &AnyObject = &*obj;
        let behavior: usize = COLLECTION_BEHAVIOR;
        let _: () = msg_send![window, setCollectionBehavior: behavior];
        let level: isize = STATUS_WINDOW_LEVEL;
        let _: () = msg_send![window, setLevel: level];
        let _: () = msg_send![window, setHidesOnDeactivate: Bool::NO];
        if is_panel(window) {
            let mask: usize = msg_send![window, styleMask];
            let mask = mask | STYLE_NONACTIVATING_PANEL;
            let _: () = msg_send![window, setStyleMask: mask];
            let _: () = msg_send![window, setFloatingPanel: Bool::YES];
        }
        // No window shadow: the HUD is a transparent window with one small
        // capsule, so AppKit's rectangular drop shadow shows as a faint rounded
        // outline + a line above the pill. The capsule draws its own CSS shadow.
        let _: () = msg_send![window, setHasShadow: Bool::NO];
        // Belt-and-braces: force a fully transparent, shadow-free backing so the
        // ONLY thing ever on screen is the webview's CSS capsule — no window
        // background, no frost, no cached drop shadow peeking out behind the
        // (sometimes narrower) pill. A `transparent: true` window already sets
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
    let obj = ns_window as *mut AnyObject;
    unsafe {
        // Electron creates these as `type: 'panel'` NSPanels already
        // (focusable or not); reclassing its window would break Electron.
        let window: &AnyObject = &*obj;
        let behavior: usize = COLLECTION_BEHAVIOR;
        let _: () = msg_send![window, setCollectionBehavior: behavior];
        let level: isize = STATUS_WINDOW_LEVEL;
        let _: () = msg_send![window, setLevel: level];
        // Panels hide on app deactivation by default; cetus stays inactive while
        // the launcher is up, so keep it on screen.
        let _: () = msg_send![window, setHidesOnDeactivate: Bool::NO];
        if is_panel(window) {
            let mask: usize = msg_send![window, styleMask];
            let mask = mask | STYLE_NONACTIVATING_PANEL;
            let _: () = msg_send![window, setStyleMask: mask];
            let _: () = msg_send![window, setFloatingPanel: Bool::YES];
        } else {
            let cls: *const AnyClass = msg_send![window, class];
            tracing::warn!(
                "panel::configure: window class {:?} is not an NSPanel",
                (*cls).name()
            );
        }
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

/// Size `ns_window` to `width`×`height` (points) and place it on the screen
/// that holds the mouse cursor in ONE `setFrame:` call, with the same
/// upward-biased centering (halfway between dead-center and the top, Raycast-style). Sizing and placing
/// separately (`set_size` + a centering pass) races: the two go through
/// different main-thread queues, so the centering can run against the old
/// frame and the panel lands off-center by half the size delta.
pub fn place_on_mouse_screen(ns_window: *mut c_void, width: f64, height: f64) {
    if ns_window.is_null() {
        return;
    }
    let obj = ns_window as *mut AnyObject;
    unsafe {
        let Some(frame) = mouse_screen_frame() else {
            return;
        };
        let window: &AnyObject = &*obj;
        let free_x = frame.size.width - width;
        let free_y = frame.size.height - height;
        let rect = NSRect {
            origin: NSPoint {
                x: frame.origin.x + free_x / 2.0,
                y: frame.origin.y + free_y * 0.75,
            },
            size: NSSize { width, height },
        };
        let _: () = msg_send![window, setFrame: rect, display: true];
    }
}

/// Resize `ns_window` to `width`×`height` (points) keeping its top edge where
/// it is and re-centering it horizontally on the screen it currently occupies.
/// Used when the panel's scale changes while it is up (⌘+/⌘− in the main
/// window): growing anchored at the top-left would walk it off-center.
pub fn resize_keep_top_centered(ns_window: *mut c_void, width: f64, height: f64) {
    if ns_window.is_null() {
        return;
    }
    let obj = ns_window as *mut AnyObject;
    unsafe {
        let window: &AnyObject = &*obj;
        let old: NSRect = msg_send![window, frame];
        let screen: *mut AnyObject = msg_send![window, screen];
        let screen_frame: Option<NSRect> = if screen.is_null() {
            mouse_screen_frame()
        } else {
            Some(msg_send![screen, frame])
        };
        let x = match screen_frame {
            Some(f) => f.origin.x + (f.size.width - width) / 2.0,
            None => old.origin.x + (old.size.width - width) / 2.0,
        };
        let top = old.origin.y + old.size.height;
        let rect = NSRect {
            origin: NSPoint { x, y: top - height },
            size: NSSize { width, height },
        };
        let _: () = msg_send![window, setFrame: rect, display: true];
    }
}

/// Park `ns_window` at the bottom-center of the screen that currently holds
/// the mouse cursor — the dictation HUD's Wispr-style resting spot. Same
/// AppKit-native screen lookup as `place_on_mouse_screen`: the host's
/// `cursor_position()` reports physical pixels while
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

/// Resize `ns_window` to `width`×`height` points, keeping its top edge and
/// horizontal center where they are — the meeting pill's hover-expand: the
/// caption card grows downward while the capsule stays put under the cursor.
/// Anchored to the window's own frame (not the mouse screen) so a pill the
/// user dragged elsewhere expands in place.
pub fn resize_keep_top_center(ns_window: *mut c_void, width: f64, height: f64) {
    if ns_window.is_null() {
        return;
    }
    let obj = ns_window as *mut AnyObject;
    unsafe {
        let window: &AnyObject = &*obj;
        let frame: NSRect = msg_send![window, frame];
        let center_x = frame.origin.x + frame.size.width / 2.0;
        let top = frame.origin.y + frame.size.height;
        let rect = NSRect {
            origin: NSPoint {
                x: center_x - width / 2.0,
                y: top - height,
            },
            size: NSSize { width, height },
        };
        let _: () = msg_send![window, setFrame: rect, display: true];
    }
}

/// Whether the global cursor is inside `ns_window`'s frame, padded by `slop`
/// points on every side. Both `NSEvent.mouseLocation` and the window frame are
/// AppKit global points (bottom-left origin), so the containment test needs no
/// coordinate conversion — unlike pairing the host's `cursor_position()` (physical
/// pixels) with window geometry, which misresolves on scaled/secondary
/// displays (see `bottom_center_on_mouse_screen`).
pub fn cursor_inside_window(ns_window: *mut c_void, slop: f64) -> bool {
    if ns_window.is_null() {
        return false;
    }
    let obj = ns_window as *mut AnyObject;
    unsafe {
        let Some(ns_event) = AnyClass::get(c"NSEvent") else {
            return false;
        };
        let mouse: NSPoint = msg_send![ns_event, mouseLocation];
        let window: &AnyObject = &*obj;
        let f: NSRect = msg_send![window, frame];
        mouse.x >= f.origin.x - slop
            && mouse.x <= f.origin.x + f.size.width + slop
            && mouse.y >= f.origin.y - slop
            && mouse.y <= f.origin.y + f.size.height + slop
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
/// which app/window is key, which is exactly why this is reliable where the
/// host's `center()` (keyed to the active screen) is not.
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

/// Resize `ns_window` to exactly cover the screen that currently holds the
/// mouse cursor, and return that frame in CG "global display" coordinates
/// (top-left origin, points) — the space `screencapture -R` expects. AppKit's
/// global space is bottom-left-origin anchored at the primary screen; CG's is
/// top-left-origin at that same screen, so y flips against the primary
/// screen's top edge.
pub fn cover_mouse_screen(ns_window: *mut c_void) -> Option<(f64, f64, f64, f64)> {
    if ns_window.is_null() {
        return None;
    }
    let obj = ns_window as *mut AnyObject;
    unsafe {
        let frame = mouse_screen_frame()?;
        let window: &AnyObject = &*obj;
        let _: () = msg_send![window, setFrame: frame, display: Bool::YES];
        // The primary screen (screens[0], AppKit origin (0,0)) defines both
        // coordinate spaces' anchor.
        let ns_screen = AnyClass::get(c"NSScreen")?;
        let screens: *mut AnyObject = msg_send![ns_screen, screens];
        if screens.is_null() {
            return None;
        }
        let count: usize = msg_send![screens, count];
        if count == 0 {
            return None;
        }
        let primary: *mut AnyObject = msg_send![screens, objectAtIndex: 0usize];
        if primary.is_null() {
            return None;
        }
        let pf: NSRect = msg_send![primary, frame];
        let primary_top = pf.origin.y + pf.size.height;
        Some((
            frame.origin.x,
            primary_top - (frame.origin.y + frame.size.height),
            frame.size.width,
            frame.size.height,
        ))
    }
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

/// Dismiss the launcher and remove it from WindowServer's ordered window list.
///
/// An earlier keep-warm scheme parked the panel as a one-pixel, click-through
/// sliver and immediately called `orderFrontRegardless`. Although visually
/// hidden, that high-level floating panel remained cetus's front ordered window.
/// Mission Control could then activate cetus by raising the sliver instead of
/// the selected main window, leaving the main window underneath the previously
/// active app. A hidden auxiliary window must never participate in app ordering,
/// so dismissal now ends at `orderOut:`.
///
/// [`disable_occlusion_throttling`] still reduces idle WebKit suspension, and
/// [`present`] re-centers/orders the launcher when it is next requested. A cold
/// launcher repaint is preferable to corrupting the main window's z-order.
pub fn park(ns_window: *mut c_void) {
    if ns_window.is_null() {
        return;
    }
    let obj = ns_window as *mut AnyObject;
    unsafe {
        let window: &AnyObject = &*obj;
        // Drop all-Spaces behavior while hidden. `present` restores it before
        // ordering the launcher onto whichever Space is active next.
        let default_behavior: usize = 0; // NSWindowCollectionBehaviorDefault
        let _: () = msg_send![window, setCollectionBehavior: default_behavior];
        // Make it inert before ordering out so a close/open race cannot leave a
        // stale panel intercepting clicks. `present` re-enables hit-testing.
        let _: () = msg_send![window, setIgnoresMouseEvents: Bool::new(true)];
        let null: *mut AnyObject = std::ptr::null_mut();
        let _: () = msg_send![window, orderOut: null];
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
/// scheduler), so staying un-napped is wanted regardless. The returned token is
/// intentionally leaked — ending the activity would re-enable App Nap.
pub fn prevent_app_nap() {
    // NSActivityUserInitiatedAllowingIdleSystemSleep — prevents App Nap (and
    // sudden / automatic termination) while still letting the system idle-sleep.
    // NSProcessInfo.h: UserInitiated = 0x00FFFFFF (which already carries the
    // IdleSystemSleepDisabled bit, 1 << 20); the AllowingIdleSystemSleep
    // variant masks that bit off. 0x00FFFFFF here used to pin a permanent
    // PreventUserIdleSystemSleep assertion for the app's whole lifetime —
    // sleep suppression is opt-in and scoped in `awake` instead.
    const NS_ACTIVITY_USER_INITIATED_ALLOWING_IDLE_SYSTEM_SLEEP: u64 = 0x00EF_FFFF;
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

/// Whether `ns_window` lives on the currently active Space. `isOnActiveSpace`
/// answers for ordered-out windows too ("would ordering it in land it on the
/// active Space?"), so pair it with a visibility check when the question is
/// "can the user actually see this window right now".
///
/// A window that is visible but on ANOTHER Space is the blind spot the
/// summon toggle used to have: `isVisible` says
/// YES (it is ordered in — just on a desktop the user isn't looking at), so
/// "visible" checks alone mistake it for on-screen, and the summon hotkey
/// would *hide* the app instead of jumping to it.
pub fn is_on_active_space(ns_window: *mut c_void) -> bool {
    if ns_window.is_null() {
        return false;
    }
    let obj = ns_window as *mut AnyObject;
    unsafe {
        let window: &AnyObject = &*obj;
        let on: Bool = msg_send![window, isOnActiveSpace];
        on.as_bool()
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

// =============================================================================
// Activation watch — diagnostics for the "Mission Control leaves the main
// window at the bottom" family. On every app activation / deactivation / Space
// change the caller gets a chance to dump [`order_snapshot`] to the log, so a
// recurrence can finally be attributed to whichever window sat in front of the
// main one at that instant. IRON RULE: nothing reached from these observers may
// ever order a window front — the old summon-on-activate observer that did
// exactly that was itself the root cause of this bug family.
// =============================================================================

/// Copy an `NSString*` into a Rust `String`. `None` for null.
unsafe fn nsstring_to_string(s: *mut AnyObject) -> Option<String> {
    if s.is_null() {
        return None;
    }
    Some((*s.cast::<objc2_foundation::NSString>()).to_string())
}

/// One entry per `NSApp.windows` member:
/// `[<label> vis=_ key=_ ord=_ lvl=_ space=_ mini=_]`.
///
/// `labels` maps NSWindow pointers to host window labels; windows not in the
/// map (AppKit internals such as the status-bar item) fall back to their class
/// name. `ord` is `orderedIndex` — front-to-back position among the app's
/// visible windows, so the *lowest* ordered-in window during a bad Mission
/// Control raise is the culprit. MUST run on the main thread.
pub fn order_snapshot(labels: &[(String, usize)]) -> String {
    unsafe {
        let Some(app_cls) = AnyClass::get(c"NSApplication") else {
            return String::new();
        };
        let nsapp: *mut AnyObject = msg_send![app_cls, sharedApplication];
        if nsapp.is_null() {
            return String::new();
        }
        let windows: *mut AnyObject = msg_send![nsapp, windows];
        if windows.is_null() {
            return String::new();
        }
        let n: usize = msg_send![windows, count];
        let mut parts: Vec<String> = Vec::with_capacity(n);
        for i in 0..n {
            let w: *mut AnyObject = msg_send![windows, objectAtIndex: i];
            if w.is_null() {
                continue;
            }
            let label = labels
                .iter()
                .find(|(_, ptr)| *ptr == w as usize)
                .map(|(l, _)| l.clone())
                .unwrap_or_else(|| {
                    let cls: *mut AnyObject = msg_send![w, className];
                    nsstring_to_string(cls).unwrap_or_else(|| "?".into())
                });
            let vis: Bool = msg_send![w, isVisible];
            let key: Bool = msg_send![w, isKeyWindow];
            let ord: isize = msg_send![w, orderedIndex];
            let lvl: isize = msg_send![w, level];
            let space: Bool = msg_send![w, isOnActiveSpace];
            let mini: Bool = msg_send![w, isMiniaturized];
            parts.push(format!(
                "[{label} vis={} key={} ord={ord} lvl={lvl} space={} mini={}]",
                vis.as_bool() as u8,
                key.as_bool() as u8,
                space.as_bool() as u8,
                mini.as_bool() as u8,
            ));
        }
        parts.join(" ")
    }
}

/// Install block observers for app activation, deactivation, and active-Space
/// changes, all delivered on the main queue. `on_event` receives a short tag
/// ("did-become-active" / "did-resign-active" / "active-space-changed") and is
/// expected to log an [`order_snapshot`]; it must never order windows front
/// (orderOut-only cleanup is allowed). Installs once; the observer tokens are
/// retained and intentionally leaked — they live as long as the app. MUST run
/// on the main thread.
pub fn install_activation_watch(on_event: impl Fn(&'static str) + 'static) {
    static INSTALLED: OnceLock<()> = OnceLock::new();
    if INSTALLED.set(()).is_err() {
        return;
    }
    let on_event = std::rc::Rc::new(on_event);
    unsafe {
        let Some(nc_cls) = AnyClass::get(c"NSNotificationCenter") else {
            return;
        };
        let default_nc: *mut AnyObject = msg_send![nc_cls, defaultCenter];
        let Some(queue_cls) = AnyClass::get(c"NSOperationQueue") else {
            return;
        };
        let main_queue: *mut AnyObject = msg_send![queue_cls, mainQueue];
        // Space changes are posted on NSWorkspace's own center, not the default
        // one.
        let workspace_nc: *mut AnyObject = match AnyClass::get(c"NSWorkspace") {
            Some(ws_cls) => {
                let ws: *mut AnyObject = msg_send![ws_cls, sharedWorkspace];
                if ws.is_null() {
                    std::ptr::null_mut()
                } else {
                    msg_send![ws, notificationCenter]
                }
            }
            None => std::ptr::null_mut(),
        };
        let observers: [(*mut AnyObject, &str, &'static str); 3] = [
            (
                default_nc,
                "NSApplicationDidBecomeActiveNotification",
                "did-become-active",
            ),
            (
                default_nc,
                "NSApplicationDidResignActiveNotification",
                "did-resign-active",
            ),
            (
                workspace_nc,
                "NSWorkspaceActiveSpaceDidChangeNotification",
                "active-space-changed",
            ),
        ];
        for (center, name, tag) in observers {
            if center.is_null() || main_queue.is_null() {
                continue;
            }
            let cb = on_event.clone();
            let block = RcBlock::new(move |_note: *mut AnyObject| cb(tag));
            let ns_name = objc2_foundation::NSString::from_str(name);
            let null: *mut AnyObject = std::ptr::null_mut();
            let token: *mut AnyObject = msg_send![
                center,
                addObserverForName: &*ns_name,
                object: null,
                queue: main_queue,
                usingBlock: &*block,
            ];
            // The token is autoreleased; retain it (and never release) so the
            // observer stays registered for the app's lifetime.
            if !token.is_null() {
                let _: *mut AnyObject = msg_send![token, retain];
            }
        }
    }
}

#[cfg(test)]
mod app_nap_tests {
    /// The App Nap activity must not double as a sleep assertion: `pmset` lists
    /// every `PreventUserIdleSystemSleep` holder by reason string, and ours
    /// must never appear there (it did while the options constant carried the
    /// IdleSystemSleepDisabled bit).
    #[test]
    fn app_nap_activity_allows_idle_sleep() {
        super::prevent_app_nap();
        // Registration is asynchronous; give it ample time to show up if it
        // is going to.
        std::thread::sleep(std::time::Duration::from_millis(500));
        let out = std::process::Command::new("pmset")
            .args(["-g", "assertions"])
            .output()
            .expect("pmset");
        let text = String::from_utf8_lossy(&out.stdout);
        // Only this process: a running cetus.app (possibly an older build)
        // shows up in the same listing.
        let me = format!("pid {}(", std::process::id());
        let offending: Vec<&str> = text
            .lines()
            .filter(|l| {
                l.contains(&me)
                    && l.contains("cetus keeps its window rendered")
                    && l.contains("PreventUserIdleSystemSleep")
            })
            .collect();
        assert!(
            offending.is_empty(),
            "App Nap activity holds sleep: {offending:?}"
        );
    }
}
