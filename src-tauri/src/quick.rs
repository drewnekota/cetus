//! Global quick-launch panel: settings, screen capture, and the commands that
//! wire the frameless "quick" window to the main window.
//!
//! The launcher gesture itself (double / both ⌘) is detected natively on macOS
//! in `hotkey.rs`; this module owns everything that isn't the raw key tap.

mod permissions;
pub(crate) use permissions::*;
mod reply;
pub(crate) use reply::*;
mod panel;
pub(crate) use panel::*;
mod screenshot;
pub(crate) use screenshot::*;

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
    /// "double_cmd" (double-tap ⌘) | "double_opt" (double-tap right ⌥). Defaults to
    /// hold both ⌘.
    #[serde(default = "default_gesture_plain")]
    pub gesture_plain: String,
    /// Gesture that opens the launcher *with* a screenshot attached. Same option
    /// set as `gesture_plain`. Off by default; the compact launcher can attach a
    /// screenshot interactively and visual quick reply already captures one.
    #[serde(default = "default_gesture_shot")]
    pub gesture_shot: String,
    /// Gesture that captures the screen and asks a vision model for send-ready
    /// replies without starting a full agent conversation. Defaults to
    /// double-tap Option, mirroring the fastest common reply-assistant gesture.
    #[serde(default = "default_gesture_reply")]
    pub gesture_reply: String,
    /// Agent runtime used for one-shot quick replies. Uses the same stable ids
    /// as conversations ("pi" | "claude-code" | "codex" | ACP runtimes).
    /// Disabled or unknown runtimes fall back to Cetus at invocation time.
    #[serde(default = "crate::store::default_backend")]
    pub reply_backend: String,
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
    /// Opt-in legacy shortcut: double-tap the voice trigger to toggle
    /// hands-free dictation. Off by default so the same double-tap can belong
    /// exclusively to visual quick reply.
    #[serde(default)]
    pub voice_handsfree_shortcut: bool,
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
    /// Ask before quitting (Cmd+Q / menu Quit / tray Quit). On by default so a
    /// stray Cmd+Q next to Cmd+W can't silently kill every running agent
    /// session. Read at quit time, so toggling takes effect immediately.
    #[serde(default = "default_true")]
    pub confirm_quit: bool,
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
    "off".into()
}

fn default_gesture_reply() -> String {
    "double_opt".into()
}

fn default_voice_gesture() -> String {
    "right_option".into()
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
            gesture_reply: default_gesture_reply(),
            reply_backend: crate::store::default_backend(),
            summon_hotkey: String::new(),
            session_mode: "new".into(),
            voice_enabled: false,
            voice_gesture: default_voice_gesture(),
            voice_handsfree_shortcut: false,
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
            confirm_quit: true,
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
    normalize_reply_gesture(&mut settings);
    settings.voice_cleanup = true;
    settings.voice_cleanup_model.clear();
    settings.voice_insert_mode = default_voice_insert_mode();
    settings.voice_boosting_table_id.clear();
    settings
}

/// Older settings can already use the new default (double right Option) for one of
/// the two launcher actions. Preserve those assignments and move quick reply to
/// the first free gesture instead of silently stealing the user's shortcut.
fn normalize_reply_gesture(settings: &mut QuickSettings) {
    if settings.gesture_reply == "off"
        || (settings.gesture_reply != settings.gesture_plain
            && settings.gesture_reply != settings.gesture_shot)
    {
        return;
    }
    settings.gesture_reply = ["double_opt", "double_cmd", "both_opt", "both_cmd"]
        .into_iter()
        .find(|candidate| {
            *candidate != settings.gesture_plain && *candidate != settings.gesture_shot
        })
        .unwrap_or("off")
        .to_string();
}

fn save_settings(store: &crate::store::Store, s: &QuickSettings) -> anyhow::Result<()> {
    let mut s = s.clone();
    normalize_reply_gesture(&mut s);
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

/// Move installations that still have the exact old shortcut set onto the new
/// collision-free grammar. Any customization opts the user out: defaults must
/// never overwrite a deliberate binding. Hands-free itself is independently
/// default-off via serde for every existing settings blob.
pub fn migrate_shortcut_defaults(store: &crate::store::Store) {
    const MARKER: &str = "shortcut_defaults_v3_migrated";
    if matches!(store.get_setting(MARKER), Ok(Some(_))) {
        return;
    }
    let mut settings = load_settings(store);
    if apply_shortcut_defaults_v3(&mut settings) {
        if let Err(error) = save_settings(store, &settings) {
            tracing::warn!("shortcut defaults migration failed: {error}");
            return;
        }
        tracing::info!(
            "shortcut defaults migration: launcher=both Cmd, reply=double right Option, voice=hold right Option"
        );
    }
    let _ = store.set_setting(MARKER, "1");
}

fn apply_shortcut_defaults_v3(settings: &mut QuickSettings) -> bool {
    let untouched_old_defaults = settings.gesture_plain == "both_cmd"
        && settings.gesture_shot == "both_opt"
        && settings.gesture_reply == "double_opt"
        && settings.voice_gesture == "right_cmd";
    if !untouched_old_defaults {
        return false;
    }
    settings.gesture_shot = "off".into();
    settings.voice_gesture = "right_option".into();
    settings.voice_handsfree_shortcut = false;
    true
}

// ---- Gesture runtime ------------------------------------------------------

/// What a detected gesture should do. Each supported gesture (both-⌘,
/// both-⌥, double-⌘, double-right-⌥) is independently mapped from the three
/// per-function assignments (`gesture_plain` / `gesture_shot` /
/// `gesture_reply`).
pub const ACT_NONE: u8 = 0;
pub const ACT_PLAIN: u8 = 1; // open the launcher without a screenshot
pub const ACT_SHOT: u8 = 2; // open the launcher with a screenshot
pub const ACT_REPLY: u8 = 3; // direct screenshot → vision model → reply candidates

/// Resolve the three per-function gesture assignments into a per-gesture action
/// table: `(both_cmd, both_opt, double_cmd, double_opt)`. Reply is applied last
/// as a safety fallback, though the settings UI prevents duplicate assignments.
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
    assign(
        &s.gesture_reply,
        ACT_REPLY,
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
    /// True while the region-select ("snip") overlay is up, between
    /// `snip::begin` and the finish/cancel command. The gesture listener reads
    /// it so a second contextful gesture cancels the snip instead of stacking
    /// a launcher on top of the overlay.
    pub snip_active: Arc<AtomicBool>,
    /// Overlay frame + pre-focus context stashed by `snip::begin` for the
    /// overlay's `snip_finish` command. Written on the main thread before the
    /// overlay presents, so the finish command always sees it populated.
    pub snip_stash: Arc<std::sync::Mutex<Option<crate::snip::SnipStash>>>,
    /// The capture behind the quick-reply surface currently on screen, kept so
    /// switching the runtime in the panel can re-run the turn against the same
    /// screen. Re-capturing would be wrong — by then the frontmost app is the
    /// panel itself.
    pub reply_stash: Arc<std::sync::Mutex<Option<ReplyStash>>>,
    /// Bumped for every quick-reply turn (first run and each regenerate). Deltas
    /// and results carrying a stale run are dropped, so a superseded turn can't
    /// stream into the draft the user is now watching.
    pub reply_run: Arc<AtomicU32>,
    /// Main-window zoom (⌘+/⌘−) as a percentage, reported by the panel's
    /// webview on mount and whenever it changes. The launcher's logical window
    /// size scales with it so a zoomed-in UI doesn't clip inside a fixed box.
    pub scale_pct: Arc<AtomicU32>,
    /// Launcher content height in CSS px at 100% zoom, reported by the panel
    /// as its input/attachments grow. 0 = unknown (use the compact base).
    pub content_height: Arc<AtomicU32>,

    // ---- Global voice dictation (read live by the hotkey thread) ----
    pub voice_enabled: Arc<AtomicBool>,
    pub voice_gesture: Arc<AtomicU8>,
    /// Whether clean double-taps of `voice_gesture` may toggle hands-free.
    /// Disabled by default; quick reply owns double right-Option instead.
    pub voice_handsfree_shortcut: Arc<AtomicBool>,
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
            snip_active: Arc::new(AtomicBool::new(false)),
            snip_stash: Arc::new(std::sync::Mutex::new(None)),
            reply_stash: Arc::new(std::sync::Mutex::new(None)),
            reply_run: Arc::new(AtomicU32::new(0)),
            scale_pct: Arc::new(AtomicU32::new(100)),
            content_height: Arc::new(AtomicU32::new(0)),
            voice_enabled: Arc::new(AtomicBool::new(s.voice_enabled)),
            voice_gesture: Arc::new(AtomicU8::new(voice_gesture_code(&s.voice_gesture))),
            voice_handsfree_shortcut: Arc::new(AtomicBool::new(s.voice_handsfree_shortcut)),
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
        self.voice_handsfree_shortcut
            .store(s.voice_handsfree_shortcut, Ordering::Relaxed);
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

// ---- Commands -------------------------------------------------------------

#[tauri::command]
pub async fn get_quick_settings(state: State<'_, AppState>) -> Result<QuickSettings, String> {
    Ok(load_settings(&state.store))
}

#[tauri::command]
pub async fn set_quick_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    mut settings: QuickSettings,
) -> Result<(), String> {
    normalize_reply_gesture(&mut settings);
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

/// Dismiss the launcher. Clears the `shown` flag and, on macOS, orders the native
/// panel fully out on the main thread so it cannot interfere with Mission
/// Control's ordering of the main window; elsewhere, use Tauri's hide path.
pub(crate) fn park_quick(app: &AppHandle) {
    let state = app.state::<AppState>();
    // Mid re-capture the panel is intentionally hidden; the focus loss (and any
    // outside click landing in that sub-second gap) must not park it and drop
    // the stash that's being rebuilt.
    if state.quick.recapturing.load(Ordering::Relaxed) {
        return;
    }
    state.quick.shown.store(false, Ordering::Relaxed);
    // The reply capture belongs to the panel that just went away; dropping it
    // keeps a stale screen from being re-sent by a late runtime switch.
    *state.quick.reply_stash.lock().unwrap() = None;
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
    #[serde(default)]
    pub attachments: Vec<serde_json::Value>,
    pub session_mode: String,
    /// Repo the launched task should run in; None → main window's default.
    pub workspace_dir: Option<String>,
    /// Model + reasoning preset chosen in the launcher's model picker.
    pub model: String,
    pub reasoning: String,
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
    #[serde(default)]
    pub cli_effort: String,
    /// "Create more" mode: launch the task in the background and keep the
    /// panel up (and the main window where it is) so the next prompt can be
    /// typed right away.
    #[serde(default)]
    pub keep_open: bool,
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
            "attachments": payload.attachments,
            "sessionMode": payload.session_mode,
            "workspaceDir": payload.workspace_dir,
            "model": payload.model,
            "reasoning": payload.reasoning,
            "context": payload.context,
            "backend": payload.backend,
            "cliModel": payload.cli_model,
            "cliEffort": payload.cli_effort,
        }),
    );
    if payload.keep_open {
        return Ok(());
    }
    // Routes through `focus_main` so a parked (warm off-screen) main window is
    // restored to its real position before it's brought forward.
    crate::focus_main(&app);
    park_quick(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        apply_shortcut_defaults_v3, gesture_actions, normalize_reply_gesture, QuickSettings,
        ACT_NONE, ACT_PLAIN, ACT_REPLY,
    };

    #[test]
    fn default_gestures_are_collision_free() {
        let settings = QuickSettings::default();
        let actions = gesture_actions(&settings);
        // both Cmd, both Option, double Cmd, double right Option
        assert_eq!(actions, (ACT_PLAIN, ACT_NONE, ACT_NONE, ACT_REPLY));
        assert_eq!(settings.voice_gesture, "right_option");
        assert!(!settings.voice_handsfree_shortcut);
    }

    #[test]
    fn visual_reply_collision_moves_to_a_free_gesture() {
        let mut settings = QuickSettings::default();
        settings.gesture_reply = settings.gesture_plain.clone();
        normalize_reply_gesture(&mut settings);
        assert_eq!(settings.gesture_reply, "double_opt");
        let (both_cmd, _, _, double_opt) = gesture_actions(&settings);
        assert_eq!(both_cmd, ACT_PLAIN);
        assert_eq!(double_opt, ACT_REPLY);
    }

    #[test]
    fn migrates_only_the_untouched_old_shortcut_set() {
        let mut old = QuickSettings {
            gesture_shot: "both_opt".into(),
            voice_gesture: "right_cmd".into(),
            voice_handsfree_shortcut: true,
            ..Default::default()
        };
        assert!(apply_shortcut_defaults_v3(&mut old));
        assert_eq!(old.gesture_shot, "off");
        assert_eq!(old.voice_gesture, "right_option");
        assert!(!old.voice_handsfree_shortcut);

        let mut customized = old.clone();
        customized.gesture_plain = "double_cmd".into();
        assert!(!apply_shortcut_defaults_v3(&mut customized));
        assert_eq!(customized.gesture_plain, "double_cmd");
    }
}
