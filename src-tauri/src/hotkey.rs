//! macOS-only global launcher gesture, detected with a CGEventTap.
//!
//! The OS hotkey API (RegisterHotKey / `global-hotkey`, what
//! tauri-plugin-global-shortcut wraps) can only register a modifier + a
//! non-modifier key. The launcher wants a *modifier-only* gesture — hold both
//! ⌘ keys, or double-tap ⌘ — so we listen to raw `FlagsChanged` events with a
//! listen-only event tap instead.
//!
//! Left/right ⌘ are told apart via the device-dependent flag bits macOS sets on
//! the event: `0x8` = left ⌘, `0x10` = right ⌘. A listen-only tap doesn't alter
//! the event stream but still requires the process to be trusted for
//! Accessibility, so we wait for trust before installing it.

use crate::quick::{self, QuickRuntime};
use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::event::{
    CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType, EventField,
};
use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const LCMD: u64 = 0x0000_0008; // NX_DEVICELCMDKEYMASK
const RCMD: u64 = 0x0000_0010; // NX_DEVICERCMDKEYMASK
const DEV_LALT: u64 = 0x0000_0020; // NX_DEVICELALTKEYMASK (left ⌥)
const DEV_RALT: u64 = 0x0000_0040; // NX_DEVICERALTKEYMASK (right ⌥)

// CGEventFlags generic modifier masks — used to require a *clean* push-to-talk
// hold (the trigger modifier and nothing else).
const M_SHIFT: u64 = 1 << 17;
const M_CTRL: u64 = 1 << 18;
const M_ALT: u64 = 1 << 19;
const M_CMD: u64 = 1 << 20;
const M_FN: u64 = 1 << 23;
const M_ALL: u64 = M_SHIFT | M_CTRL | M_ALT | M_CMD | M_FN;

/// Whether the configured push-to-talk modifier is held with no other modifier
/// (a clean hold, not part of a shortcut chord).
fn ptt_clean_held(bits: u64, gesture: u8) -> bool {
    match gesture {
        quick::VOICE_RIGHT_CMD => (bits & M_ALL) == M_CMD && (bits & RCMD) != 0,
        quick::VOICE_RIGHT_OPTION => (bits & M_ALL) == M_ALT && (bits & DEV_RALT) != 0,
        quick::VOICE_FN => (bits & M_ALL) == M_FN,
        // Caps Lock is HID-remapped to F18 and tracked off KeyDown/KeyUp, never
        // from modifier flags — so it's never "held" from this flag-based check.
        quick::VOICE_CAPS_LOCK => false,
        _ => false,
    }
}

/// Apply one rising/falling edge of the voice push-to-talk trigger to the shared
/// tap state. Shared by the modifier-gesture path (FlagsChanged) and the Caps
/// Lock path (F18 KeyDown/KeyUp): a clean press starts the hold timer; a brief
/// clean release feeds the hands-free double-tap counter exactly as the inline
/// modifier logic did. Returns the previous held state for caller-specific
/// gap handling.
fn voice_trigger_edge(
    held: bool,
    vtap: &RefCell<VoiceTap>,
    ptt_held: &AtomicBool,
    ptt_dirty: &AtomicBool,
    voice_hf_gen: &AtomicU32,
) -> bool {
    let was = ptt_held.swap(held, Ordering::Relaxed);
    let mut v = vtap.borrow_mut();
    if held && !was {
        // Rising edge: a clean trigger press begins.
        v.press_at = Some(Instant::now());
        v.dirty = false;
        ptt_dirty.store(false, Ordering::Relaxed);
    } else if !held && was {
        // Falling edge: a clean release shorter than the hold threshold is a tap
        // (feeds double-tap detection); anything else can't seed one.
        let brief = v
            .press_at
            .take()
            .map(|t| t.elapsed() < PTT_HOLD_THRESHOLD)
            .unwrap_or(false);
        if brief && !v.dirty {
            let now = Instant::now();
            match v.last_tap.take() {
                Some(prev) if now.duration_since(prev) < VOICE_DOUBLE_GAP => {
                    voice_hf_gen.fetch_add(1, Ordering::Relaxed);
                }
                _ => v.last_tap = Some(now),
            }
        } else {
            v.last_tap = None;
        }
        v.dirty = false;
    }
    was
}

// Double-tap tuning.
const MAX_TAP_HOLD: Duration = Duration::from_millis(400);
const MAX_TAP_GAP: Duration = Duration::from_millis(500);

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
    static kAXTrustedCheckOptionPrompt: CFStringRef;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    // Re-arm an event tap the OS disabled (after a callback timeout, heavy
    // load, or sleep/wake). `tap` is a CFMachPortRef passed as an opaque ptr.
    fn CGEventTapEnable(tap: *const c_void, enable: bool);
    // Live modifier-flag state for the whole session, independent of any event.
    // After the OS disables the tap we lose the FlagsChanged edges that fired
    // while it was dead, so we read the real state to resync on re-arm.
    fn CGEventSourceFlagsState(state_id: u32) -> u64;
}

// kCGEventSourceStateCombinedSessionState — the state every app sees.
const COMBINED_SESSION_STATE: u32 = 0;

/// Whether this process is trusted for Accessibility. `prompt` triggers the
/// system permission dialog (and adds cetus to the list) when not yet trusted.
pub fn is_trusted(prompt: bool) -> bool {
    unsafe {
        let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
        let value = if prompt {
            CFBoolean::true_value()
        } else {
            CFBoolean::false_value()
        };
        let pairs = [(key.as_CFType(), value.as_CFType())];
        let opts = CFDictionary::from_CFType_pairs(&pairs);
        AXIsProcessTrustedWithOptions(opts.as_concrete_TypeRef())
    }
}

/// Spawn the gesture listener on a dedicated thread. Blocks (inside the thread)
/// until Accessibility is granted, then installs the tap and runs its run loop
/// forever.
pub fn spawn_listener(app: AppHandle, runtime: QuickRuntime) {
    // Push-to-talk dictation is driven off the same event tap; its monitor runs
    // on its own thread, reacting to the tap's `ptt_*` flags.
    spawn_voice_monitor(app.clone(), runtime.clone());
    let _ = std::thread::Builder::new()
        .name("cetus-hotkey".into())
        .spawn(move || {
            wait_for_trust(&runtime);
            run_tap(app, runtime);
        });
}

/// Block until Accessibility is granted. The system prompt is only surfaced
/// while the launcher is enabled, so a user who turns it off isn't nagged; we
/// still poll silently so granting access later starts the tap without a
/// restart.
fn wait_for_trust(runtime: &QuickRuntime) {
    let mut prompted = false;
    loop {
        if is_trusted(false) {
            return;
        }
        let wants = runtime.enabled.load(Ordering::Relaxed)
            || runtime.voice_enabled.load(Ordering::Relaxed);
        if wants && !prompted {
            is_trusted(true); // shows the system dialog once
            prompted = true;
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// Double-tap tracker for a single modifier. Used twice: once for ⌘ (the
/// primary launcher gesture) and once for ⌥ (the secondary, no-screenshot
/// trigger). `mod_down` is the tracked modifier, whichever this instance owns.
#[derive(Default)]
struct DoubleState {
    mod_down: bool,
    press_at: Option<Instant>,
    last_tap: Option<Instant>,
    /// A non-modifier key (or an extra modifier) was seen during this hold, so
    /// it's a real shortcut, not a clean tap.
    dirty: bool,
}

/// Event-tap-local tap/double-tap tracker for the *voice* trigger, mirroring
/// [`DoubleState`] but keyed to the configured push-to-talk modifier. Lives in
/// the callback (exact `Instant` timing per edge) — the polling monitor can't
/// classify reliably. On a completed double-tap the callback bumps
/// `voice_hf_gen`; the monitor turns that into a hands-free toggle.
#[derive(Default)]
struct VoiceTap {
    /// When the current clean hold of the trigger began (None = not held).
    press_at: Option<Instant>,
    /// Release time of a pending first tap, awaiting a possible second.
    last_tap: Option<Instant>,
    /// A key was pressed during this hold → a chord, not a tap.
    dirty: bool,
}

fn run_tap(app: AppHandle, runtime: QuickRuntime) {
    let was_both = Cell::new(false);
    let was_both_opt = Cell::new(false);
    let dbl = RefCell::new(DoubleState::default());
    let alt = RefCell::new(DoubleState::default());
    let vtap = RefCell::new(VoiceTap::default());
    let enabled = runtime.enabled.clone();
    let act_both = runtime.act_both.clone();
    let act_both_opt = runtime.act_both_opt.clone();
    let act_double_cmd = runtime.act_double_cmd.clone();
    let act_double_opt = runtime.act_double_opt.clone();
    let voice_enabled = runtime.voice_enabled.clone();
    let voice_gesture = runtime.voice_gesture.clone();
    let voice_hf_gen = runtime.voice_hf_gen.clone();
    let ptt_held = runtime.ptt_held.clone();
    let ptt_dirty = runtime.ptt_dirty.clone();
    let cb_app = app.clone();
    // The OS disables a tap on callback timeout / heavy load / sleep-wake and
    // delivers a TapDisabled* event. We must re-arm it via the mach port, which
    // we only have *after* the tap is built — share it through this cell, set
    // below and read inside the callback (same thread, so Rc<Cell> is fine).
    let port: Rc<Cell<*const c_void>> = Rc::new(Cell::new(std::ptr::null()));
    let cb_port = port.clone();

    let tap = CGEventTap::new(
        CGEventTapLocation::Session,
        CGEventTapPlacement::HeadInsertEventTap,
        CGEventTapOptions::ListenOnly,
        vec![
            CGEventType::FlagsChanged,
            CGEventType::KeyDown,
            // KeyUp is only consulted for the Caps Lock (F18) release edge.
            CGEventType::KeyUp,
        ],
        move |_proxy, event_type, event| {
            // Re-arm if the system disabled us — do this regardless of the
            // enabled toggle so the tap survives for when it's switched back on.
            if matches!(
                event_type,
                CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput
            ) {
                let p = cb_port.get();
                if !p.is_null() {
                    unsafe { CGEventTapEnable(p, true) };
                }
                // Any edge that fired while the tap was dead is lost. The
                // dangerous one is a missed *release*: it wedges `ptt_held` true,
                // so the HUD never hides and the trigger goes dead until the user
                // taps the modifier again. Re-derive all edge-tracked state from
                // the live modifier flags so we resync rather than trust stale
                // edges — a missed press or release both self-correct here.
                let bits = unsafe { CGEventSourceFlagsState(COMBINED_SESSION_STATE) };
                let held = voice_enabled.load(Ordering::Relaxed)
                    && ptt_clean_held(bits, voice_gesture.load(Ordering::Relaxed));
                ptt_held.store(held, Ordering::Relaxed);
                ptt_dirty.store(false, Ordering::Relaxed);
                {
                    let mut v = vtap.borrow_mut();
                    *v = VoiceTap::default();
                    // Keep a surviving hold alive (re-timed from now); a pending
                    // first tap can't bridge the gap, so it's dropped.
                    if held {
                        v.press_at = Some(Instant::now());
                    }
                }
                *dbl.borrow_mut() = DoubleState::default();
                *alt.borrow_mut() = DoubleState::default();
                was_both.set((bits & LCMD != 0) && (bits & RCMD != 0));
                was_both_opt.set((bits & DEV_LALT != 0) && (bits & DEV_RALT != 0));
                tracing::warn!("cetus: event tap was disabled by the OS; re-armed and resynced");
                return None;
            }
            if !enabled.load(Ordering::Relaxed) {
                was_both.set(false);
                return None;
            }

            if matches!(event_type, CGEventType::KeyDown | CGEventType::KeyUp) {
                // Caps Lock (HID-remapped to F18) drives push-to-talk off its
                // clean KeyDown/KeyUp edges, not modifier flags. Intercept its
                // own key first so it doesn't dirty itself as a "chord".
                if voice_enabled.load(Ordering::Relaxed)
                    && voice_gesture.load(Ordering::Relaxed) == quick::VOICE_CAPS_LOCK
                    && event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE)
                        == crate::caps_remap::REMAPPED_KEYCODE
                {
                    voice_trigger_edge(
                        matches!(event_type, CGEventType::KeyDown),
                        &vtap,
                        &ptt_held,
                        &ptt_dirty,
                        &voice_hf_gen,
                    );
                    return None;
                }
                // A bare KeyUp of any other key is irrelevant to launcher and
                // modifier-gesture tracking (which keys off press + flag edges).
                if matches!(event_type, CGEventType::KeyUp) {
                    return None;
                }
                // A real keystroke while ⌘ (or ⌥) is held disqualifies that
                // double-tap — it's a shortcut chord, not a clean tap.
                if dbl.borrow().mod_down {
                    dbl.borrow_mut().dirty = true;
                }
                if alt.borrow().mod_down {
                    alt.borrow_mut().dirty = true;
                }
                if voice_enabled.load(Ordering::Relaxed) {
                    // A key pressed mid-hold means the push-to-talk modifier is
                    // part of a shortcut, not a dictation request.
                    if ptt_held.load(Ordering::Relaxed) {
                        ptt_dirty.store(true, Ordering::Relaxed);
                    }
                    // Any keystroke also dirties the voice tap and breaks a
                    // pending double-tap (real double-taps have no typing between
                    // them), closing the "two unrelated taps" false-positive.
                    let mut v = vtap.borrow_mut();
                    v.dirty = true;
                    v.last_tap = None;
                }
                return None;
            }
            // FlagsChanged.
            let bits = event.get_flags().bits();
            // Set to Some(capture) when a launcher gesture completes; capture =
            // whether this gesture's function attaches a screenshot.
            let mut fire: Option<bool> = None;

            // Voice trigger: maintain ptt_held for the hold (push-to-talk) path
            // AND classify clean taps into a double-tap (hands-free toggle) right
            // here, where each edge carries exact timing. The monitor only times
            // the hold threshold and consumes double-tap pulses; it never has to
            // infer a tap from 15ms samples.
            if voice_enabled.load(Ordering::Relaxed) {
                let gesture = voice_gesture.load(Ordering::Relaxed);
                if gesture == quick::VOICE_CAPS_LOCK {
                    // Caps Lock is tracked off F18 KeyDown/KeyUp, not flags. A
                    // modifier toggling between two taps still contaminates a
                    // pending first tap, so drop it (mirrors the key-press case).
                    if (bits & M_ALL) != 0 && vtap.borrow().last_tap.is_some() {
                        vtap.borrow_mut().last_tap = None;
                    }
                } else {
                    let held = ptt_clean_held(bits, gesture);
                    let was = voice_trigger_edge(held, &vtap, &ptt_held, &ptt_dirty, &voice_hf_gen);
                    if !held && !was && (bits & M_ALL) != 0 && vtap.borrow().last_tap.is_some() {
                        // A *different* modifier became active between two taps —
                        // the gap is contaminated, so drop the pending first tap.
                        vtap.borrow_mut().last_tap = None;
                    }
                }
            } else {
                ptt_held.store(false, Ordering::Relaxed);
            }

            // Each gesture's action ([`ACT_NONE`] disarms its detector). The
            // capture bool handed to the panel is "this gesture's action is the
            // with-screenshot function".
            let act_both = act_both.load(Ordering::Relaxed);
            let act_bopt = act_both_opt.load(Ordering::Relaxed);
            let act_dcmd = act_double_cmd.load(Ordering::Relaxed);
            let act_dopt = act_double_opt.load(Ordering::Relaxed);

            // --- both-⌘: rising edge of "left AND right ⌘ held" ---
            let both = (bits & LCMD != 0) && (bits & RCMD != 0);
            if both && !was_both.get() {
                was_both.set(true);
                if act_both != quick::ACT_NONE {
                    fire = Some(act_both == quick::ACT_SHOT);
                }
            } else if !both {
                was_both.set(false);
            }

            // --- both-⌥: rising edge of "left AND right ⌥ held" ---
            let both_opt = (bits & DEV_LALT != 0) && (bits & DEV_RALT != 0);
            if both_opt && !was_both_opt.get() {
                was_both_opt.set(true);
                if act_bopt != quick::ACT_NONE {
                    fire = Some(act_bopt == quick::ACT_SHOT);
                }
            } else if !both_opt {
                was_both_opt.set(false);
            }

            // --- double-tap ⌘ ---
            let cmd_any = (bits & (LCMD | RCMD)) != 0;
            if act_dcmd != quick::ACT_NONE {
                let mut d = dbl.borrow_mut();
                // Holding *both* ⌘ keys is the both-⌘ gesture, not a single-⌘
                // tap — dirty this hold so the two ⌘ gestures can coexist.
                if both {
                    d.dirty = true;
                }
                if cmd_any && !d.mod_down {
                    d.mod_down = true;
                    d.press_at = Some(Instant::now());
                    d.dirty = both;
                } else if !cmd_any && d.mod_down {
                    d.mod_down = false;
                    let brief = d
                        .press_at
                        .map(|t| t.elapsed() < MAX_TAP_HOLD)
                        .unwrap_or(false);
                    if brief && !d.dirty {
                        let now = Instant::now();
                        match d.last_tap.take() {
                            Some(prev) if now.duration_since(prev) < MAX_TAP_GAP => {
                                fire = Some(act_dcmd == quick::ACT_SHOT);
                            }
                            _ => d.last_tap = Some(now),
                        }
                    } else {
                        d.last_tap = None;
                    }
                } else if d.mod_down {
                    // Another modifier toggled while ⌘ held — not a clean tap.
                    d.dirty = true;
                }
            }

            // --- double-tap ⌥ ---
            // Same clean-double-tap logic as ⌘, keyed to the generic Option mask
            // (either ⌥). If global voice is also bound to right-⌥, a right-⌥
            // double-tap can satisfy both — by default voice is off and uses
            // right-⌘, so there's no overlap out of the box.
            if act_dopt != quick::ACT_NONE {
                let alt_any = (bits & M_ALT) != 0;
                let mut a = alt.borrow_mut();
                // Holding *both* ⌥ keys is the both-⌥ gesture, not a single-⌥
                // tap — dirty this hold so the two ⌥ gestures can coexist.
                if both_opt {
                    a.dirty = true;
                }
                if alt_any && !a.mod_down {
                    a.mod_down = true;
                    a.press_at = Some(Instant::now());
                    a.dirty = both_opt;
                } else if !alt_any && a.mod_down {
                    a.mod_down = false;
                    let brief = a
                        .press_at
                        .map(|t| t.elapsed() < MAX_TAP_HOLD)
                        .unwrap_or(false);
                    if brief && !a.dirty {
                        let now = Instant::now();
                        match a.last_tap.take() {
                            Some(prev) if now.duration_since(prev) < MAX_TAP_GAP => {
                                fire = Some(act_dopt == quick::ACT_SHOT);
                            }
                            _ => a.last_tap = Some(now),
                        }
                    } else {
                        a.last_tap = None;
                    }
                } else if a.mod_down {
                    a.dirty = true;
                }
            }

            if let Some(capture) = fire {
                trigger(&cb_app, capture);
            }
            None
        },
    );

    let tap = match tap {
        Ok(t) => t,
        Err(_) => {
            tracing::warn!("cetus: failed to create CGEventTap (Accessibility?)");
            return;
        }
    };

    let source = match tap.mach_port.create_runloop_source(0) {
        Ok(s) => s,
        Err(_) => {
            tracing::warn!("cetus: failed to create run loop source for event tap");
            return;
        }
    };
    // Hand the callback the mach port so it can re-arm the tap on disable.
    port.set(tap.mach_port.as_concrete_TypeRef() as *const c_void);
    let current = CFRunLoop::get_current();
    unsafe {
        current.add_source(&source, kCFRunLoopCommonModes);
    }
    tap.enable();
    tracing::info!("cetus: launcher gesture listener active");
    CFRunLoop::run_current();
}

fn trigger(app: &AppHandle, capture: bool) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        quick::open_panel(&app, capture).await;
    });
}

// ---- Push-to-talk dictation monitor ---------------------------------------

/// The single tap-vs-hold boundary for the voice trigger. A clean press held at
/// least this long is push-to-talk; a clean release before it is a *tap* (which
/// feeds double-tap detection). Using one boundary for both — rather than a
/// separate tap-max — removes the dead band where a release is neither.
const PTT_HOLD_THRESHOLD: Duration = Duration::from_millis(250);

/// Max gap between the two taps of a hands-free double-tap. Tighter than the
/// launcher's 500ms: a stray pair of clean modifier taps shouldn't silently
/// start an always-listening mic, so we sit at the snappy end of the UX range.
const VOICE_DOUBLE_GAP: Duration = Duration::from_millis(300);

/// One serialized voice lifecycle action. The monitor thread hands these to the
/// async [`run_voice_worker`] so starts and stops never overlap — the root fix
/// for the orphaned-session race (a fast double-tap or quick PTT release used to
/// be able to stop before the start had filled the shared slot, leaving a hot
/// mic nothing could turn off).
#[derive(Debug)]
enum VoiceCmd {
    StartPtt,
    StopPttInsert,
    CancelPtt,
    ToggleHandsFree,
    StopAll,
}

/// Drive global dictation off the event tap's signals: hold the trigger to talk
/// (release inserts the transcript), double-tap to toggle hands-free. The
/// monitor only *produces* commands; one async worker consumes them in order and
/// owns the session, so the monitor never blocks and lifecycle never races.
pub fn spawn_voice_monitor(app: AppHandle, runtime: QuickRuntime) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<VoiceCmd>();
    // The worker awaits the dictation lifecycle on the Tauri async runtime; the
    // monitor samples the event-tap signals on its own thread and feeds it.
    tauri::async_runtime::spawn(run_voice_worker(app, runtime.clone(), rx));
    let _ = std::thread::Builder::new()
        .name("cetus-voice-ptt".into())
        .spawn(move || run_voice_monitor(runtime, tx));
}

fn run_voice_monitor(runtime: QuickRuntime, tx: tokio::sync::mpsc::UnboundedSender<VoiceCmd>) {
    let mut press_start: Option<Instant> = None; // PTT hold timer
    let mut ptt_engaged = false; // StartPtt sent; awaiting release/chord
    let mut last_gen = runtime.voice_hf_gen.load(Ordering::Relaxed);
    // Poll fast (responsive PTT timing) only while voice is usable; when it's off
    // — the default — back off hard so this thread isn't waking ~66×/s for the
    // app's whole lifetime. `fast` tracks the previous iteration's state so the
    // sleep adapts; a one-cycle lag on enabling is harmless (a hold still has to
    // clear PTT_HOLD_THRESHOLD anyway).
    let mut fast = true;
    let mut disabled_idle = false; // already torn down for this disabled stretch
    loop {
        std::thread::sleep(Duration::from_millis(if fast { 15 } else { 200 }));

        let enabled = runtime.voice_enabled.load(Ordering::Relaxed);
        fast = enabled;
        if !enabled {
            // Tear the session down once on the enabled→disabled edge instead of
            // re-sending StopAll every poll (which flooded the worker channel).
            if !disabled_idle {
                if ptt_engaged {
                    let _ = tx.send(VoiceCmd::CancelPtt);
                    ptt_engaged = false;
                }
                let _ = tx.send(VoiceCmd::StopAll); // tear down hands-free if any
                press_start = None;
                // Don't replay taps queued while disabled.
                last_gen = runtime.voice_hf_gen.load(Ordering::Relaxed);
                disabled_idle = true;
            }
            continue;
        }
        disabled_idle = false;

        // Each double-tap the event tap classified since the last poll is exactly
        // one toggle command. Sending the integer delta (not a "changed" flag)
        // keeps a burst correct, and the worker serializes them against the real
        // session, so a rapid double-double-tap can't desync.
        let gen = runtime.voice_hf_gen.load(Ordering::Relaxed);
        let mut pending = gen.wrapping_sub(last_gen);
        while pending > 0 {
            let _ = tx.send(VoiceCmd::ToggleHandsFree);
            pending -= 1;
        }
        last_gen = gen;

        let kind = runtime.voice_session_kind.load(Ordering::Relaxed);
        let held = runtime.ptt_held.load(Ordering::Relaxed);
        let dirty = runtime.ptt_dirty.load(Ordering::Relaxed);

        if ptt_engaged {
            if !held {
                let _ = tx.send(VoiceCmd::StopPttInsert);
                ptt_engaged = false;
                press_start = None;
            } else if dirty {
                // A key joined the hold — it's a chord, abort the dictation.
                let _ = tx.send(VoiceCmd::CancelPtt);
                ptt_engaged = false;
                press_start = None;
            }
        } else if kind == quick::SESSION_NONE && held && !dirty {
            // Time a clean hold. A live session (kind != NONE, i.e. hands-free)
            // suppresses push-to-talk, so holding during it can't start a second.
            match press_start {
                None => press_start = Some(Instant::now()),
                Some(t) if t.elapsed() >= PTT_HOLD_THRESHOLD => {
                    let _ = tx.send(VoiceCmd::StartPtt);
                    ptt_engaged = true;
                    press_start = None;
                }
                _ => {}
            }
        } else {
            press_start = None;
        }
    }
}

/// Serialized consumer of [`VoiceCmd`]. Owns the live session kind (mirrored to
/// `voice_session_kind` for the monitor) and awaits each transition fully, so a
/// start always completes — slot filled — before the next stop runs.
async fn run_voice_worker(
    app: AppHandle,
    runtime: QuickRuntime,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<VoiceCmd>,
) {
    use std::time::Duration as Dur;
    let free = Dur::from_secs(3);
    let mut kind = quick::SESSION_NONE;
    // Park a standby speech helper so the first dictation's mic comes up fast.
    // Spawned: the first prewarm may compile the helper (seconds of swiftc),
    // and the command loop must start consuming immediately.
    {
        let app_pw = app.clone();
        tokio::spawn(async move {
            crate::voice::prewarm(&app_pw.state::<crate::AppState>()).await;
        });
    }
    while let Some(cmd) = rx.recv().await {
        let state = app.state::<crate::AppState>();
        tracing::debug!("voice worker: {cmd:?} (session kind={kind})");
        match cmd {
            VoiceCmd::StartPtt => {
                if kind == quick::SESSION_NONE {
                    crate::voice::await_slot_free(&state, free).await;
                    match crate::voice::start_internal(&state, &app, "global".to_string()).await {
                        Ok(()) => {
                            crate::voice::show_hud(&app);
                            kind = quick::SESSION_PTT;
                        }
                        Err(e) => tracing::warn!("voice dictation start failed: {e}"),
                    }
                }
            }
            VoiceCmd::StopPttInsert => {
                if kind == quick::SESSION_PTT {
                    finish_ptt(&app, &runtime).await;
                    kind = quick::SESSION_NONE;
                }
            }
            VoiceCmd::CancelPtt => {
                if kind == quick::SESSION_PTT {
                    crate::voice::cancel_internal(&state).await;
                    crate::voice::hide_hud(&app);
                    kind = quick::SESSION_NONE;
                }
            }
            VoiceCmd::ToggleHandsFree => match kind {
                quick::SESSION_NONE => {
                    crate::voice::await_slot_free(&state, free).await;
                    match crate::voice::start_handsfree_internal(&state, &app).await {
                        Ok(()) => {
                            crate::voice::show_hud(&app);
                            kind = quick::SESSION_HANDSFREE;
                        }
                        Err(e) => tracing::warn!("hands-free start failed: {e}"),
                    }
                }
                quick::SESSION_HANDSFREE => {
                    crate::voice::stop_handsfree_internal(&state).await;
                    crate::voice::await_slot_free(&state, free).await;
                    crate::voice::hide_hud(&app);
                    kind = quick::SESSION_NONE;
                }
                // A double-tap during push-to-talk (you're mid-hold) is ignored.
                _ => {}
            },
            VoiceCmd::StopAll => {
                match kind {
                    quick::SESSION_PTT => {
                        crate::voice::cancel_internal(&state).await;
                        crate::voice::hide_hud(&app);
                    }
                    quick::SESSION_HANDSFREE => {
                        crate::voice::stop_handsfree_internal(&state).await;
                        crate::voice::await_slot_free(&state, free).await;
                        crate::voice::hide_hud(&app);
                    }
                    _ => {}
                }
                kind = quick::SESSION_NONE;
            }
        }
        runtime.voice_session_kind.store(kind, Ordering::Relaxed);
    }
}

/// Finalize a push-to-talk hold: stop the stream, optionally AI-clean the text,
/// apply learned corrections, then type/paste it into the focused app — and
/// watch the field afterwards to learn from the user's edits. Runs inside the
/// serialized worker.
async fn finish_ptt(app: &AppHandle, runtime: &QuickRuntime) {
    let t0 = std::time::Instant::now();
    let state = app.state::<crate::AppState>();
    let mode_code = runtime.voice_insert_mode.load(Ordering::Relaxed);
    let cleanup = runtime.voice_cleanup.load(Ordering::Relaxed);
    let settings = crate::quick::load_settings(&state.store);
    // The frontmost app names the tone target for cleanup (email vs chat vs
    // IDE). Fetched concurrently with the ASR finalize — it spawns a helper.
    let app_data_for_front = state.app_data_dir.clone();
    let front_task =
        tokio::task::spawn_blocking(move || crate::ocr::frontmost_app(&app_data_for_front));
    // The cleanup corpus (AX read of the focused field, file IO, jieba) is also
    // assembled concurrently with the finalize. When the field is AX-unreadable
    // (Electron/canvas UIs) we fall back to OCR-ing the screen — Wispr-style —
    // so cleanup still sees what the user is writing into. Both reads share the
    // context-biasing opt-in (build_corpus_with returns empty without it).
    let corpus_task = cleanup.then(|| {
        let ad = state.app_data_dir.clone();
        let settings = settings.clone();
        tokio::task::spawn_blocking(move || {
            let mut corpus = crate::voice::build_corpus_with(&ad, &settings);
            if settings.voice_context_biasing && corpus.context.is_none() {
                if let Some(screen) = crate::capture::ocr_screen_now(&ad) {
                    // Tail of the OCR text in reading order ≈ the bottom of the
                    // window — where chat composers and fresh prose live.
                    let flat = screen.split_whitespace().collect::<Vec<_>>().join(" ");
                    let tail: Vec<char> = flat.chars().rev().take(400).collect();
                    let tail: String = tail.into_iter().rev().collect();
                    if !tail.is_empty() {
                        tracing::debug!(
                            "voice context: focused field AX-unreadable; screen-OCR fallback ({} chars)",
                            tail.chars().count()
                        );
                        corpus.context = Some(tail);
                    }
                }
            }
            corpus
        })
    });
    // Keep the HUD up but swap its waveform for a spinner: the user has released,
    // so what follows (stream finalize + the cloud cleanup pass) is loading time
    // they're waiting on. The HUD is hidden once that's done, just before insert.
    crate::voice::show_transcribing(app);
    let mut text = crate::voice::stop_internal(&state).await;
    let asr_ms = t0.elapsed().as_millis();
    let app_name = front_task.await.ok().flatten().map(|i| i.app);
    tracing::debug!("voice context: frontmost app = {:?}", app_name);
    let t_clean = std::time::Instant::now();
    if cleanup && !text.trim().is_empty() {
        if let Ok(Some(key)) = crate::secrets::get("volc_ark") {
            // Hand the cleanup pass the same biasing we gave ASR (hotwords +
            // focused-field text, or its screen-OCR stand-in) so it fixes
            // proper-noun spelling and zh/en boundaries the same way — plus the
            // frontmost app for tone and the previous dictation for continuity.
            // Mostly empty when context biasing is off.
            let corpus = match corpus_task {
                Some(task) => task.await.unwrap_or_default(),
                None => crate::doubao::Corpus::default(),
            };
            match crate::titling::cleanup_transcript(
                &key,
                &text,
                corpus.context.as_deref(),
                &corpus.hotwords,
                app_name.as_deref(),
                corpus.recent.as_deref(),
                None,
            )
            .await
            {
                Ok(clean) => {
                    tracing::info!(
                        "voice cleanup applied: {} → {} chars: {:?}",
                        text.chars().count(),
                        clean.chars().count(),
                        crate::voice::preview(&clean)
                    );
                    text = clean;
                }
                Err(e) => tracing::warn!("voice cleanup failed, using raw transcript: {e}"),
            }
        } else {
            tracing::info!("voice cleanup enabled but no volc_ark key — using raw transcript");
        }
    }
    let cleanup_ms = t_clean.elapsed().as_millis();
    // User-confirmed corrections ("Deep Seek"→"DeepSeek") outrank both ASR and
    // the cleanup model — the user's own edits are ground truth.
    if settings.voice_context_biasing {
        let before = text.clone();
        text = crate::corrections::apply(&state.app_data_dir, &text);
        if text != before {
            tracing::info!(
                "voice corrections changed the transcript: {:?} → {:?}",
                crate::voice::preview(&before),
                crate::voice::preview(&text)
            );
        }
    }
    text = crate::titling::normalize_zh_en_spacing(&text);
    crate::voice::hide_hud(app);
    if text.trim().is_empty() {
        return;
    }
    // Record what the user actually received: history, dialog continuity, and
    // hotword learning all key off this one final text (the raw/cleaned split
    // used to bias future recognition toward pre-cleanup errors).
    {
        let (ad, rec) = (state.app_data_dir.clone(), text.clone());
        tokio::task::spawn_blocking(move || crate::transcripts::record(&ad, &rec, "global"));
    }
    // Learn the user's distinctive terms from what they actually accepted, so
    // future recognition leans toward them. Only when context biasing is on.
    if settings.voice_context_biasing {
        let ad = state.app_data_dir.clone();
        let learned = text.clone();
        tokio::task::spawn_blocking(move || crate::biasing::harvest(&ad, &learned));
    }
    tracing::info!(
        "voice insert ({:?} mode, asr {asr_ms}ms + cleanup {cleanup_ms}ms): {} chars: {:?}",
        if mode_code == quick::INSERT_PASTE {
            "paste"
        } else {
            "type"
        },
        text.chars().count(),
        crate::voice::preview(&text)
    );
    // Let key focus return to the target app after the HUD orders out.
    tokio::time::sleep(Duration::from_millis(90)).await;
    let mode = if mode_code == quick::INSERT_PASTE {
        crate::text_input::InsertMode::Paste
    } else {
        crate::text_input::InsertMode::Type
    };
    if let Err(e) = crate::text_input::insert_text(&text, mode) {
        tracing::warn!("voice insert failed: {e}");
    } else if settings.voice_context_biasing {
        // Re-read the field in a few seconds and mine the user's manual fixes
        // (the correction-learning loop). Shares the screen-reading opt-in.
        crate::corrections::watch_insertion(state.app_data_dir.clone(), text.clone());
    }
}
