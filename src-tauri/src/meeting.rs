//! Meeting memory: ambient audio transcription (Granola/Rewind-style, text-only).
//!
//! Three tiers, all feeding the same pipeline:
//! 1. **Manual** — a Settings button or the configurable global hotkey starts /
//!    stops a capture session (covers in-person meetings where no app touches
//!    the microphone).
//! 2. **Auto-detect** — a background `monitor` helper watches the CoreAudio
//!    process objects for *other* apps capturing the mic (Zoom, Teams, FaceTime,
//!    feishu…). Sustained use starts a session; sustained release ends it.
//!    Only auto-started sessions are auto-stopped, so a manual session never
//!    dies under you.
//! 3. **Post-meeting summary** — when a session ends with enough transcript, a
//!    one-shot DeepSeek call (same out-of-band pattern as [`crate::dream`])
//!    distills a title + minutes, stored next to the transcript.
//!
//! Capture itself lives in a lazily-`swiftc`-compiled helper
//! (`meeting/cetus-meeting-helper.swift`): mic via AVAudioEngine plus — on
//! macOS 14.2+ — the system audio output via a CoreAudio process tap, each
//! stream transcribed on-device with SFSpeechRecognizer. **No audio is ever
//! written to disk**; only text reaches this module. Segments land in SQLite
//! (`meetings` / `meeting_segments`) for the UI and in a rolling JSONL recall
//! log (read by the `meeting-recall` pi extension) for the agent.

use crate::store::{now_ms, Meeting, MeetingSegment, Store};
use crate::{secrets, AppState};
use chrono::{Local, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

const SETTINGS_KEY: &str = "meeting";

/// Other-app mic use must persist this long before a session auto-starts
/// (debounces sound checks and one-tap voice notes).
const AUTO_START_SECS: u64 = 6;
/// …and must be gone this long before an auto session auto-stops (call apps
/// briefly release the device when switching audio routes).
const AUTO_STOP_SECS: u64 = 30;
/// Hard cap on a single session's length. A manual session is ended only by an
/// explicit stop, so without this a forgotten/walked-away session would hold the
/// mic + system-audio tap + two speech recognizers open indefinitely. Applies to
/// auto sessions too (belt-and-braces). 6h comfortably clears any real meeting.
const MAX_SESSION_SECS: u64 = 6 * 60 * 60;
/// Skip the summary when the whole transcript is shorter than this — there is
/// nothing worth distilling in a pocket-dial's worth of text.
const SUMMARY_MIN_CHARS: usize = 200;
/// Transcript budget (chars) sent to the summary model: head + tail when over.
const SUMMARY_HEAD_CHARS: usize = 16_000;
const SUMMARY_TAIL_CHARS: usize = 8_000;
/// Recall-log self-trim caps (meetings produce more lines than screen OCR).
const RECALL_MAX_BYTES: u64 = 4_000_000;
const RECALL_KEEP_LINES: usize = 4000;
/// Per-segment text cap in the recall log.
const RECALL_TEXT_CAP: usize = 2000;
/// How often the monitor loop runs retention pruning.
const PRUNE_INTERVAL_SECS: u64 = 3600;

const SUMMARY_MODEL: &str = "deepseek-v4-pro";

/// PID to terminate on process exit. Negative means a process group created by
/// `cetus-spawn-disclaim`; positive means a directly spawned helper.
static ACTIVE_CAPTURE_TARGET: AtomicI64 = AtomicI64::new(0);

const SUMMARY_SYSTEM_PROMPT: &str = "\
You summarize a meeting transcript captured on the user's machine. The `mic` \
lines are the user speaking; the `system` lines are everyone else (heard \
through the speakers). The transcript is automatic speech recognition output — \
expect recognition errors and fix obvious ones silently.\n\n\
Respond with STRICT JSON only — no prose, no code fences:\n\
{\"title\":\"...\",\"summary\":\"...\"}\n\
`title`: at most 8 words naming the meeting's actual subject.\n\
`summary`: concise markdown minutes — key points discussed, decisions made, \
and action items (with owners when stated). Use short bullet lists under bold \
mini-headers. Skip filler and small talk. Write BOTH fields in the language \
the meeting was held in.";

// =============================================================================
// Settings (persisted in app_settings, mirrors CaptureSettings)
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSettings {
    /// Master switch. Off by default — never listen without explicit opt-in.
    #[serde(default)]
    pub enabled: bool,
    /// Start/stop sessions automatically when another app uses the microphone.
    #[serde(default = "default_true")]
    pub auto_detect: bool,
    /// Also transcribe system audio output (the other participants). Needs
    /// macOS 14.2+; silently degrades to mic-only below that.
    #[serde(default = "default_true")]
    pub system_audio: bool,
    /// Generate a title + minutes when a session ends.
    #[serde(default = "default_true")]
    pub summarize: bool,
    /// "auto" uses SeedASR when a Doubao key is configured and otherwise
    /// falls back to Apple on-device recognition. "local" never sends audio.
    #[serde(default = "default_asr_engine")]
    pub asr_engine: String,
    /// Delete meetings older than this many days (0 = keep forever).
    #[serde(default = "default_retention")]
    pub retention_days: u32,
    /// Global accelerator that starts/stops a manual session ("" = none).
    /// Only registered while `enabled` is on, so the default binding can't
    /// start the mic for users who never opted into the feature.
    #[serde(default = "default_toggle_hotkey")]
    pub toggle_hotkey: String,
}

fn default_true() -> bool {
    true
}
fn default_retention() -> u32 {
    90
}
fn default_asr_engine() -> String {
    "auto".into()
}
fn default_toggle_hotkey() -> String {
    "Cmd+Shift+M".into()
}

impl Default for MeetingSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            auto_detect: true,
            system_audio: true,
            summarize: true,
            asr_engine: default_asr_engine(),
            retention_days: default_retention(),
            toggle_hotkey: default_toggle_hotkey(),
        }
    }
}

pub fn load_settings(store: &Store) -> MeetingSettings {
    match store.get_setting(SETTINGS_KEY) {
        Ok(Some(json)) => serde_json::from_str(&json).unwrap_or_default(),
        _ => MeetingSettings::default(),
    }
}

fn save_settings(store: &Store, settings: &MeetingSettings) -> anyhow::Result<()> {
    store.set_setting(SETTINGS_KEY, &serde_json::to_string(settings)?)?;
    Ok(())
}

/// Path of the rolling recall log read by the `meeting-recall` pi extension.
/// Kept here so `lib.rs` (which exports it via `CETUS_MEETING_LOG`) and the
/// writer never diverge.
pub fn recall_log_path(app_data: &Path) -> PathBuf {
    app_data.join("meeting-context").join("recall.jsonl")
}

// =============================================================================
// Helper resolution (lazy swiftc compile, mirrors voice.rs)
// =============================================================================

#[cfg(target_os = "macos")]
mod helper {
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::OnceLock;

    const HELPER_SRC: &str = include_str!("../meeting/cetus-meeting-helper.swift");

    // Embedded Info.plist so TCC shows usage strings instead of SIGABRT-ing the
    // bare CLI binary (same trick as the speech helper). NSAudioCapture is the
    // macOS 14.2+ "record system audio" permission the process tap prompts for.
    const HELPER_PLIST: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>dev.cetus.app.meeting-helper</string>
  <key>CFBundleName</key>
  <string>cetus-meeting-helper</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>cetus listens during meetings to transcribe them into searchable notes. No audio is stored.</string>
  <key>NSSpeechRecognitionUsageDescription</key>
  <string>cetus transcribes meetings on-device so you can recall what was said.</string>
  <key>NSAudioCaptureUsageDescription</key>
  <string>cetus transcribes the other meeting participants from your system audio. No audio is stored.</string>
</dict>
</plist>
"#;

    static HELPER: OnceLock<Option<PathBuf>> = OnceLock::new();

    pub fn path(app_data: &Path) -> Option<&'static Path> {
        HELPER
            .get_or_init(|| resolve_or_compile(app_data))
            .as_deref()
    }

    fn resolve_or_compile(app_data: &Path) -> Option<PathBuf> {
        if let Ok(p) = std::env::var("CETUS_MEETING_HELPER") {
            let p = PathBuf::from(p);
            if p.exists() {
                return Some(p);
            }
        }
        let bin_dir = app_data.join("bin");
        // Bump the version suffix whenever the embedded Swift changes so cached
        // installs recompile.
        let bin = bin_dir.join("cetus-meeting-helper-v6");
        if bin.exists() {
            return Some(bin);
        }
        std::fs::create_dir_all(&bin_dir).ok()?;
        let src = bin_dir.join("cetus-meeting-helper.swift");
        std::fs::write(&src, HELPER_SRC).ok()?;
        let plist = bin_dir.join("cetus-meeting-helper.plist");
        std::fs::write(&plist, HELPER_PLIST).ok()?;

        // SDK cascade: the system-audio tap symbols need a 14.2+ SDK and the
        // process-object monitor a 14.0+ SDK. Retry with feature cut-downs so
        // an older toolchain still yields a (mic-only / no-autodetect) helper.
        let flag_sets: [&[&str]; 3] = [
            &[],
            &["-D", "NO_TAP"],
            &["-D", "NO_TAP", "-D", "NO_PROC_MONITOR"],
        ];
        let mut last_err = String::new();
        for flags in flag_sets {
            let mut cmd = Command::new("swiftc");
            cmd.args([
                "-O",
                "-framework",
                "Speech",
                "-framework",
                "AVFoundation",
                "-framework",
                "CoreAudio",
                "-framework",
                "AudioToolbox",
            ]);
            cmd.args(flags);
            cmd.arg("-Xlinker")
                .arg("-sectcreate")
                .arg("-Xlinker")
                .arg("__TEXT")
                .arg("-Xlinker")
                .arg("__info_plist")
                .arg("-Xlinker")
                .arg(&plist)
                .arg("-o")
                .arg(&bin)
                .arg(&src);
            match cmd.output() {
                Ok(o) if o.status.success() && bin.exists() => {
                    if !flags.is_empty() {
                        tracing::warn!("meeting helper compiled with reduced features: {flags:?}");
                    } else {
                        tracing::info!("compiled meeting helper at {}", bin.display());
                    }
                    return Some(bin);
                }
                Ok(o) => last_err = String::from_utf8_lossy(&o.stderr).into_owned(),
                Err(e) => {
                    tracing::warn!("swiftc unavailable; meeting capture disabled: {e}");
                    return None;
                }
            }
        }
        tracing::warn!(
            "swiftc failed to build meeting helper; meeting capture disabled: {last_err}"
        );
        None
    }
}

/// Resolve how to invoke the meeting helper: through the disclaim shim when
/// available (so the helper is its own TCC-responsible process and uses its
/// embedded usage strings), otherwise direct — same dance as voice.rs.
#[cfg(target_os = "macos")]
fn helper_command(app_data: &Path) -> Result<(PathBuf, Vec<std::ffi::OsString>), String> {
    let bin = helper::path(app_data)
        .ok_or("meeting helper unavailable (swiftc missing?)")?
        .to_path_buf();
    match crate::voice::helper::shim_path(app_data) {
        Some(shim) => Ok((shim.to_path_buf(), vec![bin.into_os_string()])),
        None => Ok((bin, Vec::new())),
    }
}

// =============================================================================
// Runtime (the single in-flight session)
// =============================================================================

#[derive(Default)]
pub struct MeetingRuntime {
    active: tokio::sync::Mutex<Option<ActiveSession>>,
}

struct ActiveSession {
    id: String,
    started_ts: i64,
    auto: bool,
    app_hint: Option<String>,
    engine: String,
    /// Taken by `stop` — dropping it (EOF) or writing a newline asks the helper
    /// to finalize, after which the reader task cleans this slot up.
    stdin: Option<tokio::process::ChildStdin>,
    child_pid: Option<u32>,
    segments: Arc<AtomicI64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingStatus {
    pub recording: bool,
    pub started_ts: Option<i64>,
    pub auto: bool,
    pub app_hint: Option<String>,
    pub segments: i64,
    pub engine: String,
    pub meeting_id: Option<String>,
}

/// Start a capture session. Holds the runtime lock across the whole start so a
/// hotkey press and the auto-detector can't double-record.
async fn start_internal(
    app: &AppHandle,
    store: &Arc<Store>,
    app_data: &Path,
    auto: bool,
    app_hint: Option<String>,
) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, store, app_data, auto, app_hint);
        return Err("meeting capture is macOS-only".into());
    }
    #[cfg(target_os = "macos")]
    {
        let runtime = app.state::<MeetingRuntime>();
        let mut slot = runtime.active.lock().await;
        if slot.is_some() {
            return Err("a meeting is already being recorded".into());
        }

        // Resolve (= lazily compile) the helper off the async runtime: the
        // first run pays seconds of swiftc.
        let app_data_buf = app_data.to_path_buf();
        let (program, mut args) =
            tokio::task::spawn_blocking(move || helper_command(&app_data_buf))
                .await
                .map_err(|e| e.to_string())??;
        args.push("record".into());
        let settings = load_settings(store);
        let cloud = settings.asr_engine != "local" && crate::secrets::has("doubao");
        if !settings.system_audio {
            args.push("--no-system".into());
        }
        if cloud {
            args.push("--cloud".into());
        }

        let grouped = program
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.contains("spawn-disclaim"))
            .unwrap_or(false);
        let mut child = tokio::process::Command::new(&program)
            .args(&args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to start meeting capture: {e}"))?;
        if let Some(pid) = child.id() {
            ACTIVE_CAPTURE_TARGET.store(
                if grouped { -(pid as i64) } else { pid as i64 },
                Ordering::Relaxed,
            );
        }
        let stdin = child.stdin.take().ok_or("no stdin on meeting helper")?;
        let stdout = child.stdout.take().ok_or("no stdout on meeting helper")?;
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!("meeting-helper: {line}");
                }
            });
        }

        let id = uuid::Uuid::new_v4().to_string();
        let started_ts = now_ms();
        if let Err(e) = store.insert_meeting(&id, started_ts, app_hint.as_deref()) {
            kill_active_capture(); // never leave the mic hot on a failed start
            let _ = child.wait().await;
            return Err(e.to_string());
        }

        let segments = Arc::new(AtomicI64::new(0));
        *slot = Some(ActiveSession {
            id: id.clone(),
            started_ts,
            auto,
            app_hint: app_hint.clone(),
            engine: if cloud {
                "cloud".into()
            } else {
                "local".into()
            },
            child_pid: child.id(),
            stdin: Some(stdin),
            segments: segments.clone(),
        });
        drop(slot);

        emit_meeting_event(app, "started", &id, app_hint.as_deref(), None);
        spawn_pill_watcher(app.clone(), id.clone());
        // Max-duration safety stop: finalize the session after MAX_SESSION_SECS if
        // it's still the same one running. A plain sleep (no polling) — the id
        // check makes it a no-op once the session has ended normally.
        {
            let app = app.clone();
            let watchdog_id = id.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(MAX_SESSION_SECS)).await;
                let runtime = app.state::<MeetingRuntime>();
                let still_ours = runtime
                    .active
                    .lock()
                    .await
                    .as_ref()
                    .map(|s| s.id == watchdog_id)
                    .unwrap_or(false);
                if still_ours {
                    tracing::info!(
                        "meeting: max session duration reached; auto-finalizing {watchdog_id}"
                    );
                    let _ = stop_internal(&app).await;
                }
            });
        }
        tauri::async_runtime::spawn(run_reader(
            app.clone(),
            store.clone(),
            app_data.to_path_buf(),
            id,
            child,
            stdout,
            segments,
            cloud,
        ));
        Ok(())
    }
}

/// Ask the live session to finalize. Returns false when nothing was recording.
/// The reader task (not this fn) does the actual cleanup, so crash and stop
/// funnel through one place; we just nudge stdin and wait for it.
async fn stop_internal(app: &AppHandle) -> Result<bool, String> {
    let runtime = app.state::<MeetingRuntime>();
    let (stdin, pid) = {
        let mut slot = runtime.active.lock().await;
        match slot.as_mut() {
            None => return Ok(false),
            Some(s) => (s.stdin.take(), s.child_pid),
        }
    };
    if let Some(mut stdin) = stdin {
        use tokio::io::AsyncWriteExt;
        let _ = stdin.write_all(b"\n").await;
        let _ = stdin.flush().await;
        // Dropping stdin is the EOF backstop if the write raced the helper.
    }
    // Wait for the reader to clear the slot; force-kill a wedged helper.
    for i in 0..80u32 {
        if runtime.active.lock().await.is_none() {
            return Ok(true);
        }
        if i == 60 {
            if pid.is_some() {
                kill_active_capture();
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Ok(true)
}

/// Recording indicator: while the session is live, a floating pill (the
/// `meeting` webview, configured as a never-key panel) sits below the menu bar
/// with a red dot, the timer, and a stop button. The watcher polls the runtime
/// slot and hides the pill once its session is gone, so stop, auto-stop, and
/// crash all reset the indicator through the one cleanup path.
#[cfg(target_os = "macos")]
fn spawn_pill_watcher(app: AppHandle, session_id: String) {
    tauri::async_runtime::spawn(async move {
        show_pill(&app);
        loop {
            let live = {
                let runtime = app.state::<MeetingRuntime>();
                let slot = runtime.active.lock().await;
                matches!(slot.as_ref(), Some(s) if s.id == session_id)
            };
            if !live {
                hide_pill(&app);
                return;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
}

/// Float the meeting pill at the top-center of the screen the user is on,
/// without stealing key focus from the meeting app.
#[cfg(target_os = "macos")]
fn show_pill(app: &AppHandle) {
    // Stamp the open so the Dock-`Reopen` handler ignores the reopen that
    // presenting the pill can cause — otherwise a closed (parked) main window
    // gets yanked forward when a meeting auto-starts.
    // Same guard the launcher and the voice HUD use (see `quick::open_panel`).
    app.state::<AppState>()
        .quick
        .last_open_ms
        .store(crate::store::now_ms(), Ordering::Relaxed);
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(win) = app.get_webview_window("meeting") {
            if let Ok(ptr) = win.ns_window() {
                // Mirror the voice HUD: position + `present_inactive` only.
                // Deliberately NOT `win.show()` (= `makeKeyAndOrderFront:`), which
                // activates cetus even for this non-activating panel.
                crate::panel::top_center_on_mouse_screen(ptr);
                crate::panel::present_inactive(ptr);
            }
        }
    });
}

#[cfg(target_os = "macos")]
fn hide_pill(app: &AppHandle) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(win) = app.get_webview_window("meeting") {
            let _ = win.hide();
        }
    });
}

/// Consume the helper's JSONL stream: index segments, then finalize the session
/// when the helper exits (normal stop, auto-stop, or crash — all the same path).
async fn run_reader(
    app: AppHandle,
    store: Arc<Store>,
    app_data: PathBuf,
    id: String,
    mut child: tokio::process::Child,
    stdout: tokio::process::ChildStdout,
    segments: Arc<AtomicI64>,
    cloud: bool,
) {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let recall = recall_log_path(&app_data);
    let app_hint = {
        let runtime = app.state::<MeetingRuntime>();
        let slot = runtime.active.lock().await;
        slot.as_ref().and_then(|s| s.app_hint.clone())
    };
    // Do not open the ASR sockets until the helper produces its first PCM
    // packet. A cold CoreAudio system tap can take >10s to initialize; opening
    // earlier makes the provider time out while the audio hardware is still
    // coming online.
    let mut mic_pcm = None;
    let mut system_pcm = None;
    let mut cloud_tasks = Vec::new();

    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(pcm) = v.get("pcm") {
            use base64::Engine as _;
            let source = pcm.get("source").and_then(|s| s.as_str()).unwrap_or("mic");
            if let Some(data) = pcm.get("data").and_then(|d| d.as_str()) {
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) {
                    if cloud && mic_pcm.is_none() && system_pcm.is_none() {
                        let (mic, system, tasks) = spawn_cloud_asr(
                            store.clone(),
                            id.clone(),
                            recall.clone(),
                            app_hint.clone(),
                            segments.clone(),
                        );
                        mic_pcm = Some(mic);
                        system_pcm = Some(system);
                        cloud_tasks = tasks;
                    }
                    let tx = if source == "system" {
                        &system_pcm
                    } else {
                        &mic_pcm
                    };
                    if let Some(tx) = tx {
                        let _ = tx.send(bytes).await;
                    }
                }
            }
        } else if let Some(source) = v.get("pcm_end").and_then(|s| s.as_str()) {
            if source == "system" {
                system_pcm.take();
            } else {
                mic_pcm.take();
            }
        } else if let Some(seg) = v.get("segment") {
            let source = seg.get("source").and_then(|s| s.as_str()).unwrap_or("mic");
            let ts = seg
                .get("ts")
                .and_then(|t| t.as_i64())
                .unwrap_or_else(now_ms);
            let text = seg
                .get("text")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .trim();
            if text.is_empty() {
                continue;
            }
            if let Err(e) = store.insert_meeting_segment(&id, ts, source, text) {
                tracing::warn!("meeting: segment insert failed: {e}");
            }
            append_recall(
                &recall,
                ts,
                "segment",
                source,
                app_hint.as_deref(),
                None,
                text,
            );
            segments.fetch_add(1, Ordering::Relaxed);
        } else if let Some(w) = v.get("warn").and_then(|w| w.as_str()) {
            tracing::warn!("meeting helper: {w}");
        } else if let Some(e) = v.get("error").and_then(|e| e.as_str()) {
            tracing::warn!("meeting helper error: {e}");
        }
    }
    drop(mic_pcm);
    drop(system_pcm);
    for task in cloud_tasks {
        let _ = task.await;
    }
    let _ = child.wait().await;
    ACTIVE_CAPTURE_TARGET.store(0, Ordering::Relaxed);

    // Clear the slot if it is still ours (stop_internal polls for this).
    {
        let runtime = app.state::<MeetingRuntime>();
        let mut slot = runtime.active.lock().await;
        if slot.as_ref().map(|s| s.id == id).unwrap_or(false) {
            *slot = None;
        }
    }

    let count = segments.load(Ordering::Relaxed);
    let ended_ts = now_ms();
    if let Err(e) = store.finish_meeting(&id, ended_ts, count) {
        tracing::warn!("meeting: finalize failed: {e}");
    }
    if count == 0 {
        // Nothing was said — drop the empty shell row entirely.
        let _ = store.delete_meeting(&id);
        return;
    }

    let settings = load_settings(&store);
    if settings.summarize {
        if let Err(e) = summarize(&app, &store, &recall, &id, app_hint.as_deref()).await {
            tracing::warn!("meeting: summary failed: {e}");
            emit_meeting_event(&app, "saved", &id, app_hint.as_deref(), None);
        }
    } else {
        emit_meeting_event(&app, "saved", &id, app_hint.as_deref(), None);
    }
}

fn kill_active_capture() {
    let target = ACTIVE_CAPTURE_TARGET.swap(0, Ordering::Relaxed);
    if target != 0 {
        // SAFETY: target is either the child PID or the negated process-group
        // leader PID created by our disclaim shim. SIGKILL is the final
        // backstop after graceful stdin shutdown, or during app exit.
        unsafe {
            libc::kill(target as libc::pid_t, libc::SIGKILL);
        }
    }
}

/// Synchronous exit hook: do not leave a privacy-sensitive capture helper
/// holding the microphone if the desktop process is killed/restarted.
pub fn shutdown_capture() {
    kill_active_capture();
}

#[cfg(target_os = "macos")]
fn spawn_cloud_asr(
    store: Arc<Store>,
    id: String,
    recall: PathBuf,
    app_hint: Option<String>,
    segments: Arc<AtomicI64>,
) -> (
    tokio::sync::mpsc::Sender<Vec<u8>>,
    tokio::sync::mpsc::Sender<Vec<u8>>,
    Vec<tokio::task::JoinHandle<()>>,
) {
    let key = crate::secrets::get("doubao")
        .ok()
        .flatten()
        .unwrap_or_default();
    let resource = crate::doubao::DEFAULT_RESOURCE_ID.to_string();
    let (mic_tx, mic_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
    let (system_tx, system_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
    let mut tasks = Vec::new();
    for (source, rx) in [("mic", mic_rx), ("system", system_rx)] {
        let key = key.clone();
        let resource = resource.clone();
        let store = store.clone();
        let id = id.clone();
        let recall = recall.clone();
        let app_hint = app_hint.clone();
        let segments = segments.clone();
        tasks.push(tokio::spawn(async move {
            let store_for_sentence = store.clone();
            let id_for_sentence = id.clone();
            let recall_for_sentence = recall.clone();
            let hint_for_sentence = app_hint.clone();
            let on_sentence = move |text: &str| {
                let text = text.trim();
                if text.is_empty() {
                    return;
                }
                let ts = now_ms();
                if let Err(e) =
                    store_for_sentence.insert_meeting_segment(&id_for_sentence, ts, source, text)
                {
                    tracing::warn!("meeting: cloud segment insert failed: {e}");
                    return;
                }
                append_recall(
                    &recall_for_sentence,
                    ts,
                    "segment",
                    source,
                    hint_for_sentence.as_deref(),
                    None,
                    text,
                );
                segments.fetch_add(1, Ordering::Relaxed);
            };
            if let Err(e) = crate::doubao::stream_hands_free(
                &key,
                &resource,
                crate::doubao::Corpus::default(),
                rx,
                on_sentence,
            )
            .await
            {
                tracing::warn!("meeting: {source} cloud ASR failed: {e}");
            }
        }));
    }
    (mic_tx, system_tx, tasks)
}

/// One-shot DeepSeek minutes pass (out-of-band, mirrors dream::distill).
async fn summarize(
    app: &AppHandle,
    store: &Store,
    recall: &Path,
    id: &str,
    app_hint: Option<&str>,
) -> anyhow::Result<()> {
    let segs = store.meeting_segments(id)?;
    let mut transcript = String::new();
    for s in &segs {
        let hm = Local
            .timestamp_millis_opt(s.ts)
            .single()
            .map(|dt| dt.format("%H:%M").to_string())
            .unwrap_or_default();
        transcript.push_str(&format!("[{hm}] ({}) {}\n", s.source, s.text));
    }
    let total_chars = transcript.chars().count();
    if total_chars < SUMMARY_MIN_CHARS {
        emit_meeting_event(app, "saved", id, app_hint, None);
        return Ok(());
    }
    if total_chars > SUMMARY_HEAD_CHARS + SUMMARY_TAIL_CHARS {
        let head: String = transcript.chars().take(SUMMARY_HEAD_CHARS).collect();
        let tail: String = transcript
            .chars()
            .skip(total_chars - SUMMARY_TAIL_CHARS)
            .collect();
        transcript = format!("{head}\n[… transcript truncated …]\n{tail}");
    }

    let api_key = secrets::get("deepseek")?
        .ok_or_else(|| anyhow::anyhow!("no DeepSeek API key; skipping meeting summary"))?;
    let body = json!({
        "model": SUMMARY_MODEL,
        "messages": [
            { "role": "system", "content": SUMMARY_SYSTEM_PROMPT },
            { "role": "user", "content": transcript },
        ],
        "stream": false,
        "temperature": 0.3,
        "max_tokens": 2048,
        "response_format": { "type": "json_object" },
    });
    let resp = reqwest::Client::new()
        .post(crate::provider::deepseek_chat_url(store))
        .bearer_auth(&api_key)
        .json(&body)
        .timeout(Duration::from_secs(90))
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        anyhow::bail!("meeting summary failed: {status} {text}");
    }
    let value: Value = resp.json().await?;
    let content = value
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("summary response missing content"))?;
    let parsed: Value = serde_json::from_str(content)?;
    let title = parsed
        .get("title")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let summary = parsed
        .get("summary")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if summary.is_empty() {
        emit_meeting_event(app, "saved", id, app_hint, None);
        return Ok(());
    }
    store.set_meeting_summary(id, &title, &summary)?;
    append_recall(
        recall,
        now_ms(),
        "summary",
        "summary",
        app_hint,
        Some(&title),
        &summary,
    );
    emit_meeting_event(
        app,
        "saved",
        id,
        app_hint,
        if title.is_empty() { None } else { Some(&title) },
    );
    Ok(())
}

/// Broadcast a meeting lifecycle event; the frontend turns these into localized
/// notifications (rust has no i18n).
fn emit_meeting_event(
    app: &AppHandle,
    kind: &str,
    id: &str,
    app_hint: Option<&str>,
    title: Option<&str>,
) {
    let _ = app.emit(
        "app-event",
        json!({
            "type": "meeting_event",
            "kind": kind,
            "meetingId": id,
            "app": app_hint,
            "title": title,
        }),
    );
}

// ---- recall log (agent-facing) ----------------------------------------------

/// Append one entry the `meeting-recall` pi extension can read. Self-trims when
/// the file grows past the byte cap (same scheme as capture.rs).
fn append_recall(
    path: &Path,
    ts: i64,
    kind: &str,
    source: &str,
    app: Option<&str>,
    title: Option<&str>,
    text: &str,
) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut t: String = text.replace(['\n', '\r'], " ");
    if t.chars().count() > RECALL_TEXT_CAP {
        t = t.chars().take(RECALL_TEXT_CAP).collect();
    }
    let iso = Local
        .timestamp_millis_opt(ts)
        .single()
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_default();
    let line = json!({
        "ts": ts,
        "iso": iso,
        "kind": kind,
        "source": source,
        "app": app.unwrap_or(""),
        "title": title.unwrap_or(""),
        "text": t,
    })
    .to_string();

    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(f, "{line}");
    }

    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > RECALL_MAX_BYTES {
            if let Ok(content) = std::fs::read_to_string(path) {
                let lines: Vec<&str> = content.lines().collect();
                let start = lines.len().saturating_sub(RECALL_KEEP_LINES);
                let kept = lines[start..].join("\n");
                let _ = std::fs::write(path, format!("{kept}\n"));
            }
        }
    }
}

// =============================================================================
// Auto-detect monitor loop
// =============================================================================

/// Start the background mic-use monitor. Cheap when disabled (polls the toggle
/// every few seconds); spawns the `monitor` helper only while auto-detect is on.
pub fn spawn_monitor(app: AppHandle, store: Arc<Store>, app_data: PathBuf) {
    tauri::async_runtime::spawn(async move {
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (app, store, app_data);
        }
        #[cfg(target_os = "macos")]
        monitor_loop(app, store, app_data).await;
    });
}

#[cfg(target_os = "macos")]
async fn monitor_loop(app: AppHandle, store: Arc<Store>, app_data: PathBuf) {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let mut child: Option<(
        tokio::process::Child,
        tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
        tokio::process::ChildStdin,
    )> = None;
    let mut mic_active = false;
    let mut mic_apps: Vec<String> = Vec::new();
    let mut active_since: Option<Instant> = None;
    let mut inactive_since: Option<Instant> = None;
    let mut last_prune = Instant::now();
    // One-shot latches so a helper that can't be built (or a monitor the OS
    // can't provide) logs once instead of every loop tick.
    let mut helper_broken = false;

    loop {
        let settings = load_settings(&store);

        if last_prune.elapsed().as_secs() >= PRUNE_INTERVAL_SECS {
            prune(&store, settings.retention_days);
            last_prune = Instant::now();
        }

        if !(settings.enabled && settings.auto_detect) || helper_broken {
            if let Some((mut c, _, stdin)) = child.take() {
                drop(stdin); // EOF → helper exits
                let _ = c.wait().await;
            }
            mic_active = false;
            active_since = None;
            inactive_since = None;
            tokio::time::sleep(Duration::from_secs(4)).await;
            continue;
        }

        if child.is_none() {
            let app_data2 = app_data.clone();
            let resolved = tokio::task::spawn_blocking(move || helper_command(&app_data2)).await;
            let (program, mut args) = match resolved {
                Ok(Ok(v)) => v,
                _ => {
                    helper_broken = true;
                    continue;
                }
            };
            args.push("monitor".into());
            match tokio::process::Command::new(&program)
                .args(&args)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
            {
                Ok(mut c) => {
                    let stdin = c.stdin.take();
                    let stdout = c.stdout.take();
                    match (stdin, stdout) {
                        (Some(si), Some(so)) => {
                            child = Some((c, BufReader::new(so).lines(), si));
                        }
                        _ => {
                            helper_broken = true;
                            continue;
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("meeting monitor spawn failed: {e}");
                    helper_broken = true;
                    continue;
                }
            }
        }

        // Read one event or re-check settings after a short wait.
        let line = {
            let (_, lines, _) = child.as_mut().unwrap();
            tokio::select! {
                l = lines.next_line() => Some(l),
                _ = tokio::time::sleep(Duration::from_secs(3)) => None,
            }
        };
        match line {
            Some(Ok(Some(l))) => {
                if let Ok(v) = serde_json::from_str::<Value>(&l) {
                    if let Some(mic) = v.get("mic") {
                        // Belt-and-braces: drop our own recorder's pid (the
                        // helper already filters cetus bundle ids).
                        let own_pid = {
                            let runtime = app.state::<MeetingRuntime>();
                            let slot = runtime.active.lock().await;
                            slot.as_ref().and_then(|s| s.child_pid)
                        };
                        let pids: Vec<i64> = mic
                            .get("pids")
                            .and_then(|p| p.as_array())
                            .map(|a| a.iter().filter_map(|x| x.as_i64()).collect())
                            .unwrap_or_default();
                        let pids: Vec<i64> = pids
                            .into_iter()
                            .filter(|p| Some(*p as u32) != own_pid)
                            .collect();
                        let now_active = !pids.is_empty();
                        if now_active != mic_active {
                            mic_active = now_active;
                            if mic_active {
                                active_since = Some(Instant::now());
                                inactive_since = None;
                                mic_apps = mic
                                    .get("apps")
                                    .and_then(|a| a.as_array())
                                    .map(|a| {
                                        a.iter()
                                            .filter_map(|x| x.as_str())
                                            .map(String::from)
                                            .collect()
                                    })
                                    .unwrap_or_default();
                            } else {
                                inactive_since = Some(Instant::now());
                                active_since = None;
                            }
                        }
                    } else if v.get("warn").is_some() {
                        // monitor_unavailable: OS too old for process objects.
                        tracing::warn!("meeting auto-detect unavailable on this macOS");
                        helper_broken = true;
                        continue;
                    }
                }
            }
            Some(Ok(None)) | Some(Err(_)) => {
                // Helper exited/EOF — drop it; next tick respawns (or stays off).
                if let Some((mut c, _, stdin)) = child.take() {
                    drop(stdin);
                    let _ = c.wait().await;
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            None => {}
        }

        // Debounced state machine.
        let session_state = {
            let runtime = app.state::<MeetingRuntime>();
            let slot = runtime.active.lock().await;
            slot.as_ref().map(|s| s.auto)
        };
        match session_state {
            None if mic_active
                && active_since
                    .map(|t| t.elapsed().as_secs() >= AUTO_START_SECS)
                    .unwrap_or(false) =>
            {
                let hint = mic_apps.first().cloned();
                tracing::info!("meeting auto-start: mic in use by {mic_apps:?}");
                if let Err(e) = start_internal(&app, &store, &app_data, true, hint).await {
                    tracing::warn!("meeting auto-start failed: {e}");
                    // Don't retry every tick on a hard failure.
                    active_since = Some(Instant::now());
                }
            }
            Some(true)
                if !mic_active
                    && inactive_since
                        .map(|t| t.elapsed().as_secs() >= AUTO_STOP_SECS)
                        .unwrap_or(false) =>
            {
                if let Err(e) = stop_internal(&app).await {
                    tracing::warn!("meeting auto-stop failed: {e}");
                }
                inactive_since = None;
            }
            _ => {}
        }
    }
}

fn prune(store: &Store, retention_days: u32) {
    if retention_days == 0 {
        return;
    }
    let before = now_ms() - (retention_days as i64) * 86_400 * 1000;
    match store.prune_meetings(before) {
        Ok(n) if n > 0 => {
            tracing::info!("meeting: pruned {n} meetings older than {retention_days}d")
        }
        Ok(_) => {}
        Err(e) => tracing::warn!("meeting: prune failed: {e}"),
    }
}

// =============================================================================
// Global toggle hotkey
// =============================================================================

#[cfg(desktop)]
mod hotkey_state {
    use std::sync::RwLock;
    use tauri_plugin_global_shortcut::Shortcut;

    pub static TOGGLE: RwLock<Option<Shortcut>> = RwLock::new(None);
}

/// Parse + stash the meeting toggle accelerator so the global-shortcut handler
/// can route presses. Returns the parsed shortcut for registration.
#[cfg(desktop)]
pub(crate) fn sync_toggle_hotkey(hotkey: &str) -> Option<tauri_plugin_global_shortcut::Shortcut> {
    let parsed = hotkey
        .trim()
        .parse::<tauri_plugin_global_shortcut::Shortcut>()
        .ok()
        .filter(|_| !hotkey.trim().is_empty());
    *hotkey_state::TOGGLE.write().unwrap() = parsed;
    parsed
}

#[cfg(desktop)]
pub(crate) fn is_toggle_shortcut(sc: &tauri_plugin_global_shortcut::Shortcut) -> bool {
    hotkey_state::TOGGLE
        .read()
        .unwrap()
        .map(|t| t == *sc)
        .unwrap_or(false)
}

/// Hotkey press: stop the live session, or start a manual one.
#[cfg(desktop)]
pub(crate) fn toggle_from_hotkey(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match stop_internal(&app).await {
            Ok(true) => {}
            Ok(false) => {
                let (store, app_data) = {
                    let state = app.state::<AppState>();
                    (state.store.clone(), state.app_data_dir.clone())
                };
                if let Err(e) = start_internal(&app, &store, &app_data, false, None).await {
                    tracing::warn!("meeting hotkey start failed: {e}");
                }
            }
            Err(e) => tracing::warn!("meeting hotkey stop failed: {e}"),
        }
    });
}

// =============================================================================
// Tauri commands
// =============================================================================

#[tauri::command]
pub async fn get_meeting_settings(state: State<'_, AppState>) -> Result<MeetingSettings, String> {
    Ok(load_settings(&state.store))
}

#[tauri::command]
pub async fn set_meeting_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: MeetingSettings,
) -> Result<(), String> {
    save_settings(&state.store, &settings).map_err(|e| e.to_string())?;
    // Re-register both global shortcuts (summon + meeting toggle).
    let summon = crate::quick::load_settings(&state.store).summon_hotkey;
    crate::apply_summon_hotkey(&app, &summon);
    Ok(())
}

#[tauri::command]
pub async fn meeting_status(runtime: State<'_, MeetingRuntime>) -> Result<MeetingStatus, String> {
    let slot = runtime.active.lock().await;
    Ok(match slot.as_ref() {
        Some(s) => MeetingStatus {
            recording: true,
            started_ts: Some(s.started_ts),
            auto: s.auto,
            app_hint: s.app_hint.clone(),
            segments: s.segments.load(Ordering::Relaxed),
            engine: s.engine.clone(),
            meeting_id: Some(s.id.clone()),
        },
        None => MeetingStatus {
            recording: false,
            started_ts: None,
            auto: false,
            app_hint: None,
            segments: 0,
            engine: "idle".into(),
            meeting_id: None,
        },
    })
}

#[tauri::command]
pub async fn meeting_start(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let store = state.store.clone();
    let app_data = state.app_data_dir.clone();
    start_internal(&app, &store, &app_data, false, None).await
}

#[tauri::command]
pub async fn meeting_stop(app: AppHandle) -> Result<bool, String> {
    stop_internal(&app).await
}

#[tauri::command]
pub async fn list_meetings(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<Meeting>, String> {
    state
        .store
        .list_meetings(limit.unwrap_or(50).min(200))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_meeting(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.store.delete_meeting(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn meeting_transcript(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<MeetingSegment>, String> {
    state.store.meeting_segments(&id).map_err(|e| e.to_string())
}
