//! Global quick-launch panel: settings, screen capture, and the commands that
//! wire the frameless "quick" window to the main window.
//!
//! The launcher gesture itself (double / both ⌘) is detected natively on macOS
//! in `hotkey.rs`; this module owns everything that isn't the raw key tap.

use crate::AppState;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU8, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

/// Persisted launcher preferences. Stored as one JSON blob in `app_settings`
/// under [`SETTINGS_KEY`] so the panel (a separate webview) and the Rust gesture
/// listener read the same source of truth.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickSettings {
    /// Master switch for the global gesture.
    pub enabled: bool,
    /// Gesture that opens the launcher *without* a screenshot. One of
    /// "off" | "both_cmd" (hold both ⌘) | "both_opt" (hold both ⌥) |
    /// "double_cmd" (double-tap ⌘) | "double_opt" (double-tap ⌥). Defaults to
    /// hold both ⌘.
    #[serde(default = "default_gesture_plain")]
    pub gesture_plain: String,
    /// Gesture that opens the launcher *with* a screenshot attached. Same option
    /// set as `gesture_plain`. Defaults to hold both ⌥.
    #[serde(default = "default_gesture_shot")]
    pub gesture_shot: String,
    /// Optional configurable global hotkey that brings the main cetus window to
    /// the front (switching to its Space/desktop if it's on another one). A
    /// Tauri accelerator string, e.g. "Cmd+Shift+K"; empty = no hotkey. Unlike
    /// the ⌘-gesture this is a real OS hotkey (no Accessibility needed).
    #[serde(default)]
    pub summon_hotkey: String,
    /// "new" (always a fresh conversation) | "last" (continue the latest one).
    pub session_mode: String,

    // ---- Global voice dictation (Wispr-Flow style) ----
    // `#[serde(default)]` so upgrading from a pre-voice settings blob keeps the
    // user's launcher prefs instead of resetting everything to default.
    /// Master switch for hold-to-talk dictation anywhere on the system.
    #[serde(default)]
    pub voice_enabled: bool,
    /// Push-to-talk modifier held while speaking:
    /// "right_cmd" | "right_option" | "fn".
    #[serde(default = "default_voice_gesture")]
    pub voice_gesture: String,
    /// How the transcript is inserted into the focused app:
    /// "type" (Unicode key synthesis) | "paste" (clipboard + ⌘V).
    #[serde(default = "default_voice_insert_mode")]
    pub voice_insert_mode: String,
    /// Run the transcript through the Ark cleanup model (thought-to-text:
    /// filler removal, self-correction collapse, punctuation) before inserting
    /// it (global dictation only). On by default — the cleanup layer is where
    /// most of the perceived accuracy of best-in-class dictation lives; it
    /// silently no-ops without a `volc_ark` key.
    #[serde(default = "default_true")]
    pub voice_cleanup: bool,
    /// Override for the Ark cleanup model id (e.g. a newer Seed snapshot).
    /// Empty = the built-in default in `titling.rs`.
    #[serde(default)]
    pub voice_cleanup_model: String,
    /// Speech-recognition engine: "doubao" (Volcano Engine real-time streaming
    /// ASR — works in CN, ~90ms tail, native zh/en code-switch) or "apple"
    /// (on-device SFSpeechRecognizer — instant but single-locale). Doubao falls
    /// back to Apple when its key is missing. Defaults to "doubao".
    #[serde(default = "default_voice_asr_engine")]
    pub voice_asr_engine: String,
    /// Bias Doubao recognition toward the user's vocabulary + current topic by
    /// injecting a `corpus` (hotwords + context) into the request — closer to how
    /// 豆包输入法 uses context. On by default: without it recognition runs with
    /// zero personalization, which is the single biggest gap vs Wispr-class
    /// apps. Only affects the Doubao engine; gracefully empty without
    /// Accessibility trust. Read from the store at session start.
    #[serde(default = "default_true")]
    pub voice_context_biasing: bool,
    /// User-maintained hotword list, one term per line. Fed into the recognition
    /// `corpus` as boosted words. Only used when `voice_context_biasing` is on.
    #[serde(default)]
    pub voice_hotwords: String,
    /// ID of a server-side hotword table (热词词表) created in the Volcano console.
    /// Holds the long-tail personal dictionary that won't fit the ≤16 inline
    /// hotword budget; sent as `corpus.boosting_table_id`. Empty = none. Only used
    /// when `voice_context_biasing` is on.
    #[serde(default)]
    pub voice_boosting_table_id: String,
    /// Play a soft "bubble" pop when the dictation capsule appears. On by default
    /// (default fn so an old settings blob keeps the cue rather than silencing it).
    #[serde(default = "default_voice_start_sound")]
    pub voice_start_sound: bool,
    /// Register cetus as a macOS login item so it starts (in the tray) when the
    /// user logs in. Off by default. Applied via `tauri-plugin-autostart` every
    /// time settings are saved, so the OS login item tracks this flag.
    #[serde(default)]
    pub launch_on_startup: bool,
    /// Silently check for, download, and install app updates in the background
    /// at launch (applied on the next launch). On by default — read once at
    /// startup; toggling it takes effect next launch. Release builds only.
    #[serde(default = "default_true")]
    pub auto_update: bool,
}

fn default_voice_start_sound() -> bool {
    true
}

fn default_true() -> bool {
    true
}

fn default_gesture_plain() -> String {
    "both_cmd".into()
}

fn default_gesture_shot() -> String {
    "both_opt".into()
}

fn default_voice_gesture() -> String {
    "right_cmd".into()
}

fn default_voice_insert_mode() -> String {
    "type".into()
}

fn default_voice_asr_engine() -> String {
    "doubao".into()
}

impl Default for QuickSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            gesture_plain: default_gesture_plain(),
            gesture_shot: default_gesture_shot(),
            summon_hotkey: String::new(),
            session_mode: "new".into(),
            voice_enabled: false,
            voice_gesture: default_voice_gesture(),
            voice_insert_mode: default_voice_insert_mode(),
            voice_cleanup: true,
            voice_cleanup_model: String::new(),
            voice_asr_engine: default_voice_asr_engine(),
            voice_context_biasing: true,
            voice_hotwords: String::new(),
            voice_boosting_table_id: String::new(),
            voice_start_sound: true,
            launch_on_startup: false,
            auto_update: true,
        }
    }
}

const SETTINGS_KEY: &str = "quick_launch";

pub fn load_settings(store: &crate::store::Store) -> QuickSettings {
    let mut settings: QuickSettings = store
        .get_setting(SETTINGS_KEY)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    settings.voice_cleanup = true;
    settings.voice_cleanup_model.clear();
    settings.voice_insert_mode = default_voice_insert_mode();
    settings.voice_boosting_table_id.clear();
    settings
}

fn save_settings(store: &crate::store::Store, s: &QuickSettings) -> anyhow::Result<()> {
    let mut s = s.clone();
    s.voice_cleanup = true;
    s.voice_cleanup_model.clear();
    s.voice_insert_mode = default_voice_insert_mode();
    s.voice_boosting_table_id.clear();
    let json = serde_json::to_string(&s)?;
    store.set_setting(SETTINGS_KEY, &json)?;
    Ok(())
}

/// One-time migration: context biasing flipped to default-ON for the
/// voice-accuracy overhaul, but `save_settings` serializes the full struct, so
/// every pre-existing settings blob carries an explicit `false` that a serde
/// default can't reach. Cleanup is always normalized on load/save.
pub fn migrate_voice_defaults(store: &crate::store::Store) {
    const MARKER: &str = "voice_defaults_v2_migrated";
    if matches!(store.get_setting(MARKER), Ok(Some(_))) {
        return;
    }
    let mut s = load_settings(store);
    if !s.voice_context_biasing {
        s.voice_context_biasing = true;
        if let Err(e) = save_settings(store, &s) {
            tracing::warn!("voice defaults migration failed: {e}");
            return; // retry next launch; marker not set
        }
        tracing::info!("voice defaults migration: context biasing enabled");
    }
    let _ = store.set_setting(MARKER, "1");
}

// ---- Gesture runtime ------------------------------------------------------

/// What a detected gesture should do. Each of the three gestures (both-⌘,
/// double-⌘, double-⌥) is independently mapped to one of these from the two
/// per-function assignments (`gesture_plain` / `gesture_shot`).
pub const ACT_NONE: u8 = 0;
pub const ACT_PLAIN: u8 = 1; // open the launcher without a screenshot
pub const ACT_SHOT: u8 = 2; // open the launcher with a screenshot

/// Resolve the two per-function gesture assignments into a per-gesture action
/// table: `(both_cmd, both_opt, double_cmd, double_opt)`. The screenshot
/// function is applied last, so it wins if the same gesture is assigned to both.
pub fn gesture_actions(s: &QuickSettings) -> (u8, u8, u8, u8) {
    fn assign(g: &str, act: u8, bcmd: &mut u8, bopt: &mut u8, dcmd: &mut u8, dopt: &mut u8) {
        match g {
            "both_cmd" => *bcmd = act,
            "both_opt" => *bopt = act,
            "double_cmd" => *dcmd = act,
            "double_opt" => *dopt = act,
            _ => {}
        }
    }
    let (mut bcmd, mut bopt, mut dcmd, mut dopt) = (ACT_NONE, ACT_NONE, ACT_NONE, ACT_NONE);
    assign(
        &s.gesture_plain,
        ACT_PLAIN,
        &mut bcmd,
        &mut bopt,
        &mut dcmd,
        &mut dopt,
    );
    assign(
        &s.gesture_shot,
        ACT_SHOT,
        &mut bcmd,
        &mut bopt,
        &mut dcmd,
        &mut dopt,
    );
    (bcmd, bopt, dcmd, dopt)
}

// Push-to-talk modifier for global voice dictation. `caps_lock` is special: it
// isn't a real modifier — it's HID-remapped to F18 (see `caps_remap.rs`) and the
// event tap drives push-to-talk off that key's KeyDown/KeyUp instead of flags.
pub const VOICE_RIGHT_CMD: u8 = 0;
pub const VOICE_RIGHT_OPTION: u8 = 1;
pub const VOICE_FN: u8 = 2;
pub const VOICE_CAPS_LOCK: u8 = 3;

pub fn voice_gesture_code(g: &str) -> u8 {
    match g {
        "right_option" => VOICE_RIGHT_OPTION,
        "fn" => VOICE_FN,
        "caps_lock" => VOICE_CAPS_LOCK,
        _ => VOICE_RIGHT_CMD,
    }
}

// Transcript insertion strategy (see text_input.rs).
pub const INSERT_TYPE: u8 = 0;
pub const INSERT_PASTE: u8 = 1;

// Live dictation session kind, owned by the voice worker (see hotkey.rs) and
// read by the polling monitor so it never starts push-to-talk over an existing
// (hands-free) session. The worker is the single writer.
pub const SESSION_NONE: u8 = 0;
pub const SESSION_PTT: u8 = 1;
pub const SESSION_HANDSFREE: u8 = 2;

// Speech-recognition engine (see voice.rs / doubao.rs).
pub const ASR_APPLE: u8 = 0;
pub const ASR_DOUBAO: u8 = 1;

pub fn asr_engine_code(e: &str) -> u8 {
    match e {
        "apple" => ASR_APPLE,
        _ => ASR_DOUBAO,
    }
}

/// Lock-free view of the launcher config shared with the native key-tap thread,
/// so toggling the gesture / disabling the launcher in settings takes effect
/// live without rebuilding the tap.
#[derive(Clone)]
pub struct QuickRuntime {
    pub enabled: Arc<AtomicBool>,
    /// Per-gesture action ([`ACT_NONE`] | [`ACT_PLAIN`] | [`ACT_SHOT`]), read
    /// live by the key-tap thread so reassigning gestures in settings takes
    /// effect without rebuilding the tap.
    pub act_both: Arc<AtomicU8>,
    pub act_both_opt: Arc<AtomicU8>,
    pub act_double_cmd: Arc<AtomicU8>,
    pub act_double_opt: Arc<AtomicU8>,
    /// True while `quick_recapture_screenshot` has the panel hidden, so the
    /// gesture listener doesn't read that hidden state as "closed" and pop a
    /// second panel on top of the in-flight re-capture.
    pub recapturing: Arc<AtomicBool>,
    /// Whether the launcher is currently presented (vs. parked off-screen). The
    /// panel is kept warm by parking, not hiding (see [`crate::panel::park`]), so
    /// the OS window stays ordered-in even when dismissed — `is_visible()` can no
    /// longer tell "open" from "closed". This flag is the source of truth the
    /// gesture toggle reads instead.
    pub shown: Arc<AtomicBool>,
    /// Epoch-ms of the last launcher open. The macOS reopen handler reads it to
    /// tell a gesture-driven activation apart from a real dock click, so the
    /// launcher never drags the hidden main window up. 0 = never opened.
    pub last_open_ms: Arc<AtomicI64>,

    // ---- Global voice dictation (read live by the hotkey thread) ----
    pub voice_enabled: Arc<AtomicBool>,
    pub voice_gesture: Arc<AtomicU8>,
    pub voice_insert_mode: Arc<AtomicU8>,
    pub voice_cleanup: Arc<AtomicBool>,
    /// Recognition engine, read at start: [`ASR_APPLE`] | [`ASR_DOUBAO`].
    pub voice_asr_engine: Arc<AtomicU8>,
    /// Whether to play the soft "bubble" cue when the capsule appears.
    pub voice_start_sound: Arc<AtomicBool>,
    /// Monotonic counter the event tap bumps once per detected double-tap of the
    /// voice trigger. The monitor consumes the delta and asks the worker to
    /// toggle hands-free, so a fast double-tap never desyncs (each increment is a
    /// distinct toggle command, serialized by the worker).
    pub voice_hf_gen: Arc<AtomicU32>,
    /// The currently-live dictation kind ([`SESSION_NONE`] | [`SESSION_PTT`] |
    /// [`SESSION_HANDSFREE`]), written ONLY by the voice worker and read by the
    /// monitor so it won't start push-to-talk over an existing session.
    pub voice_session_kind: Arc<AtomicU8>,
    /// Transient push-to-talk state, written by the event tap and read by the
    /// dictation monitor thread (not persisted): the trigger modifier is cleanly
    /// held, and whether a non-modifier key dirtied the hold (a real shortcut).
    pub ptt_held: Arc<AtomicBool>,
    pub ptt_dirty: Arc<AtomicBool>,
}

impl QuickRuntime {
    pub fn from_settings(s: &QuickSettings) -> Self {
        let (bcmd, bopt, dcmd, dopt) = gesture_actions(s);
        Self {
            enabled: Arc::new(AtomicBool::new(s.enabled)),
            act_both: Arc::new(AtomicU8::new(bcmd)),
            act_both_opt: Arc::new(AtomicU8::new(bopt)),
            act_double_cmd: Arc::new(AtomicU8::new(dcmd)),
            act_double_opt: Arc::new(AtomicU8::new(dopt)),
            recapturing: Arc::new(AtomicBool::new(false)),
            shown: Arc::new(AtomicBool::new(false)),
            last_open_ms: Arc::new(AtomicI64::new(0)),
            voice_enabled: Arc::new(AtomicBool::new(s.voice_enabled)),
            voice_gesture: Arc::new(AtomicU8::new(voice_gesture_code(&s.voice_gesture))),
            voice_insert_mode: Arc::new(AtomicU8::new(INSERT_TYPE)),
            voice_cleanup: Arc::new(AtomicBool::new(true)),
            voice_asr_engine: Arc::new(AtomicU8::new(asr_engine_code(&s.voice_asr_engine))),
            voice_start_sound: Arc::new(AtomicBool::new(s.voice_start_sound)),
            voice_hf_gen: Arc::new(AtomicU32::new(0)),
            voice_session_kind: Arc::new(AtomicU8::new(SESSION_NONE)),
            ptt_held: Arc::new(AtomicBool::new(false)),
            ptt_dirty: Arc::new(AtomicBool::new(false)),
        }
    }

    fn apply(&self, s: &QuickSettings) {
        self.enabled.store(s.enabled, Ordering::Relaxed);
        let (bcmd, bopt, dcmd, dopt) = gesture_actions(s);
        self.act_both.store(bcmd, Ordering::Relaxed);
        self.act_both_opt.store(bopt, Ordering::Relaxed);
        self.act_double_cmd.store(dcmd, Ordering::Relaxed);
        self.act_double_opt.store(dopt, Ordering::Relaxed);
        self.voice_enabled.store(s.voice_enabled, Ordering::Relaxed);
        let new_gesture = voice_gesture_code(&s.voice_gesture);
        if self.voice_gesture.swap(new_gesture, Ordering::Relaxed) != new_gesture {
            // Reconfiguring the trigger mid-hold would otherwise leave ptt_held
            // stuck against the old modifier (no FlagsChanged fires for a key
            // that didn't physically move). Hard-reset the PTT signals so any
            // in-flight hold is abandoned cleanly under the new trigger.
            self.ptt_held.store(false, Ordering::Relaxed);
            self.ptt_dirty.store(false, Ordering::Relaxed);
        }
        self.voice_insert_mode.store(INSERT_TYPE, Ordering::Relaxed);
        self.voice_cleanup.store(true, Ordering::Relaxed);
        self.voice_asr_engine
            .store(asr_engine_code(&s.voice_asr_engine), Ordering::Relaxed);
        self.voice_start_sound
            .store(s.voice_start_sound, Ordering::Relaxed);
    }
}

// ---- Screen Recording permission (macOS) ----------------------------------

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

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

// ---- Screen capture -------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Screenshot {
    /// Bare base64 (no `data:` prefix) — matches pi-ai's ImageContent.data.
    pub data: String,
    pub mime_type: String,
}

/// Grab the main display. macOS-only (uses the built-in `screencapture`); other
/// platforms return None and the panel degrades to a text-only launcher.
pub fn capture_screenshot() -> Option<Screenshot> {
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
        let bytes = crate::capture::capture_primary_jpeg_native(1600)?;
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
        None
    }
}

// ---- Panel orchestration --------------------------------------------------

/// Center the quick panel on the monitor that currently holds the mouse cursor,
/// not the primary display. Tauri's `center()` centers on the window's current
/// monitor, so on a multi-display setup the launcher would keep popping up on
/// whatever screen it last lived on instead of the one the user is working on.
/// Falls back to `center()` if the cursor or its monitor can't be resolved.
///
/// macOS does this natively in `panel::center_on_mouse_screen` (AppKit cursor
/// tracking, no coordinate-space surprises); this is the cross-platform path.
#[cfg(not(target_os = "macos"))]
fn center_on_cursor_monitor(win: &tauri::WebviewWindow) {
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
    let (recapturing, settings) = {
        let state = app.state::<AppState>();
        (
            state.quick.recapturing.load(Ordering::Relaxed),
            load_settings(&state.store),
        )
    };
    // Mid re-capture the panel is intentionally hidden — don't treat that as
    // "closed" and pop a fresh panel that would clobber the user's typed text.
    if recapturing {
        return;
    }
    let win = match app.get_webview_window("quick") {
        Some(w) => w,
        None => return,
    };
    // A second gesture while the panel is up dismisses it. The window is parked
    // (kept warm, still ordered-in) rather than hidden, so consult the explicit
    // `shown` flag instead of `is_visible()`, which would always read true.
    if app.state::<AppState>().quick.shown.load(Ordering::Relaxed) {
        park_quick(app);
        return;
    }
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
                    crate::panel::center_on_mouse_screen(ptr);
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
            "quick open_panel present: {}ms (total since gesture-capture {}ms)",
            present_started.elapsed().as_millis(),
            cap_started.elapsed().as_millis()
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
            "screenshotDefault": capture,
            // Lets the panel tell "permission denied" apart from "shot not loaded
            // yet" — so it only shows the grant-permission hint when truly denied,
            // never as a flash on the first open before the capture lands.
            "screenshotPermission": screen_recording_granted(),
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
    if capture {
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

// ---- Commands -------------------------------------------------------------

#[tauri::command]
pub async fn get_quick_settings(state: State<'_, AppState>) -> Result<QuickSettings, String> {
    Ok(load_settings(&state.store))
}

#[tauri::command]
pub async fn set_quick_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: QuickSettings,
) -> Result<(), String> {
    save_settings(&state.store, &settings).map_err(|e| e.to_string())?;
    state.quick.apply(&settings);
    // Caps Lock as the voice trigger needs an HID remap to suppress its system
    // toggle; apply or restore it to match the current selection.
    crate::caps_remap::set_active(
        settings.voice_enabled && voice_gesture_code(&settings.voice_gesture) == VOICE_CAPS_LOCK,
    );
    // The summon hotkey is a real OS shortcut (not part of the ⌘-gesture tap),
    // so re-register it whenever settings change — no restart needed.
    crate::apply_summon_hotkey(&app, &settings.summon_hotkey);
    // Keep the OS login item in sync with the toggle.
    crate::apply_launch_on_startup(&app, settings.launch_on_startup);
    Ok(())
}

/// Hide the panel, grab the screen, restore the panel. Used when the user flips
/// the screenshot toggle ON after opening (the eager open-time capture only
/// runs when screenshot-by-default is set).
#[tauri::command]
pub async fn quick_recapture_screenshot(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Option<Screenshot>, String> {
    let recapturing = state.quick.recapturing.clone();
    recapturing.store(true, Ordering::Relaxed);
    let win = app.get_webview_window("quick");
    if let Some(w) = &win {
        let _ = w.hide();
    }
    // Window order-out is async and unbounded under load; give the compositor
    // room to actually drop the panel (and its vibrancy view) before we shoot
    // so the translucent panel isn't baked into the screenshot.
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    let shot = tauri::async_runtime::spawn_blocking(capture_screenshot)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(w) = &win {
        let _ = w.show();
        let _ = w.set_focus();
    }
    recapturing.store(false, Ordering::Relaxed);
    Ok(shot)
}

/// Park the launcher off-screen (keeping its webview warm) instead of hiding it.
/// Clears the `shown` flag and, on macOS, parks the native window on the main
/// thread; elsewhere there is no warm-park trick, so just hide it.
fn park_quick(app: &AppHandle) {
    app.state::<AppState>()
        .quick
        .shown
        .store(false, Ordering::Relaxed);
    #[cfg(target_os = "macos")]
    {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            // Drop the outside-click monitor first — the panel is going away, so
            // it must stop listening (and never fire against a parked window).
            crate::panel::remove_outside_click_monitor();
            if let Some(w) = app2.get_webview_window("quick") {
                if let Ok(ptr) = w.ns_window() {
                    crate::panel::park(ptr);
                }
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(win) = app.get_webview_window("quick") {
            let _ = win.hide();
        }
    }
}

/// Dismiss the panel without submitting (Esc / blur).
#[tauri::command]
pub async fn quick_dismiss(app: AppHandle) -> Result<(), String> {
    park_quick(&app);
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickSubmit {
    pub text: String,
    pub image: Option<Screenshot>,
    pub session_mode: String,
    /// Repo the launched task should run in; None → main window's default.
    pub workspace_dir: Option<String>,
    /// Model + reasoning preset chosen in the launcher's model picker.
    pub model: String,
    pub reasoning: String,
    /// Ultra Code (workflow orchestration) state chosen in the launcher.
    pub ultra: bool,
    /// Ambient context (frontmost app / browser URL / selection) the user kept
    /// on the panel. None when no screenshot rode along or all chips were removed.
    #[serde(default)]
    pub context: Option<crate::ocr::AmbientContext>,
    /// Coding-agent runtime chosen in the launcher ("pi" | "claude-code" |
    /// "codex"). Missing (older panel builds) → "pi".
    #[serde(default = "crate::store::default_backend")]
    pub backend: String,
    /// CLI backends' model override; empty → the CLI's own default.
    #[serde(default)]
    pub cli_model: String,
}

/// Hand the captured prompt to the main window, bring it forward, hide the
/// panel. The main window owns conversation create/reuse and the optimistic
/// user-bubble render, so we just forward the payload as a `quick-launch` event.
#[tauri::command]
pub async fn quick_submit(app: AppHandle, payload: QuickSubmit) -> Result<(), String> {
    let _ = app.emit_to(
        "main",
        "quick-launch",
        serde_json::json!({
            "text": payload.text,
            "image": payload.image,
            "sessionMode": payload.session_mode,
            "workspaceDir": payload.workspace_dir,
            "model": payload.model,
            "reasoning": payload.reasoning,
            "ultra": payload.ultra,
            "context": payload.context,
            "backend": payload.backend,
            "cliModel": payload.cli_model,
        }),
    );
    // Routes through `focus_main` so a parked (warm off-screen) main window is
    // restored to its real position before it's brought forward.
    crate::focus_main(&app);
    park_quick(&app);
    Ok(())
}

#[tauri::command]
pub async fn accessibility_trusted() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(crate::hotkey::is_trusted(false))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(true)
    }
}

/// Trigger the system Accessibility prompt (adds cetus to the list) and report
/// current trust.
#[tauri::command]
pub async fn request_accessibility() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(crate::hotkey::is_trusted(true))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(true)
    }
}

#[tauri::command]
pub async fn open_accessibility_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn screen_recording_trusted() -> Result<bool, String> {
    Ok(screen_recording_granted())
}

/// Trigger the system Screen Recording prompt. The grant only takes effect for
/// `screencapture` after the prompt is accepted (sometimes after a relaunch).
#[tauri::command]
pub async fn request_screen_recording() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(unsafe { CGRequestScreenCaptureAccess() })
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(true)
    }
}

#[tauri::command]
pub async fn open_screen_recording_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
