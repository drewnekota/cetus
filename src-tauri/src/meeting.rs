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
//!    one-shot out-of-band LLM call (see [`crate::custom_models::utility_target`])
//!    distills a title + minutes, stored next to the transcript.
//!
//! Capture itself lives in a lazily-`swiftc`-compiled helper
//! (`meeting/cetus-meeting-helper.swift`): mic via AVAudioEngine plus — on
//! macOS 14.2+ — the system audio output via a CoreAudio process tap, each
//! stream transcribed on-device with SFSpeechRecognizer. Segments land in
//! SQLite (`meetings` / `meeting_segments`) for the UI and in a rolling JSONL
//! recall log (read by the `meeting-recall` pi extension) for the agent; CLI
//! runtimes (claude-code / codex) reach the same transcripts via
//! `cetus meeting …` on the control socket (see `cli_list` / `cli_transcript`).
//! Both
//! engines additionally stream per-utterance partial hypotheses, broadcast as
//! `meeting-caption` events (Granola-style live captions: hover the recording
//! pill to watch them settle; see `emit_caption`). When
//! `save_audio` is on (the default) the helper also encodes each stream to
//! AAC under `app_data/meetings/<id>/`; with it off no audio touches disk.

mod commands;
pub(crate) use commands::*;
mod monitor;
pub(crate) use monitor::*;
mod summary;
pub(crate) use summary::*;
mod transcription;
use transcription::*;

use crate::store::{now_ms, Meeting, MeetingSegment, Store};
use crate::AppState;
use chrono::Local;
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
/// Silence backstop for auto sessions: several conferencing apps (Tencent
/// Meeting, Zoom, …) keep the microphone device open after the call ends, so
/// the mic-release auto-stop above never fires and the session records until
/// the 6h cap. When neither ASR stream has produced a caption (partial or
/// final) for this long, the call is over — finalize AND suppress auto-detect
/// until the app releases the mic (without suppression the monitor would
/// restart a fresh session on its next tick and recording would never
/// actually end). The suppression is the trade-off that sets this threshold:
/// a fully-silent stretch this long mid-call ends recording for the rest of
/// that call (the hotkey re-arms it), so it must be longer than an ordinary
/// mid-meeting lull — but short enough that a dead call doesn't keep the
/// red pill up for long. Auto-only: a manual session is the user's explicit
/// intent (e.g. taping an in-person session with long silences), and it can
/// only end by explicit stop or the max cap. An empty-transcript session is
/// deleted on stop anyway, so a session cut short by mistake with no speech
/// in it loses nothing.
const AUTO_IDLE_STOP_SECS: u64 = 5 * 60;
/// Cadence of the session watchdog's max-duration / idle checks.
const WATCHDOG_TICK_SECS: u64 = 60;
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

/// Native apps trusted to represent a call when they hold the microphone.
/// Everything else is ignored by auto-detect and remains available through the
/// manual button/hotkey. Browser bundles are handled separately below because
/// a browser using the mic is not evidence of a meeting by itself.
const MEETING_APP_BUNDLES: &[&str] = &[
    "us.zoom.xos",
    "com.microsoft.teams",
    "com.microsoft.teams2",
    "com.apple.FaceTime",
    "com.tinyspeck.slackmacgap",
    "com.larksuite.suite",
    "com.bytedance.feishu",
    "com.tencent.meeting",
    "com.tencent.voov",
    "com.alibaba.DingTalkMac",
    "com.cisco.webexmeetingsapp",
    "Cisco-Systems.Spark",
    "net.whatsapp.WhatsApp",
    "com.hnc.Discord",
    "org.telegram.desktop",
];

/// Browsers whose active-tab URL Cetus can read through the existing bounded
/// AppleScript bridge. Firefox is deliberately absent: without a reliable URL
/// signal, treating the whole browser as a meeting app would recreate the
/// false-positive behavior this allowlist is meant to prevent.
const MEETING_BROWSER_BUNDLES: &[&str] = &[
    "com.apple.Safari",
    "com.apple.SafariTechnologyPreview",
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
    "company.thebrowser.Browser",
    "com.thebrowser.Browser",
];

/// A microphone-using browser only qualifies when its active tab is on one of
/// these meeting/calling domains. Subdomains match as well.
const MEETING_WEB_DOMAINS: &[&str] = &[
    "meet.google.com",
    "teams.microsoft.com",
    "teams.live.com",
    "zoom.us",
    "webex.com",
    "meet.jit.si",
    "whereby.com",
    "around.co",
    "slack.com",
    "discord.com",
    "web.whatsapp.com",
    "web.telegram.org",
    "meeting.tencent.com",
    "voovmeeting.com",
    "meeting.dingtalk.com",
    "vc.feishu.cn",
    "larksuite.com",
];

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
    /// Keep the raw audio (AAC per stream) next to the transcript.
    #[serde(default = "default_true")]
    pub save_audio: bool,
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
    if cfg!(target_os = "macos") {
        "Cmd+Shift+M".into()
    } else {
        "Ctrl+Shift+M".into()
    }
}

impl Default for MeetingSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            auto_detect: true,
            system_audio: true,
            summarize: true,
            save_audio: true,
            asr_engine: default_asr_engine(),
            retention_days: default_retention(),
            toggle_hotkey: default_toggle_hotkey(),
        }
    }
}

pub fn load_settings(store: &Store) -> MeetingSettings {
    let mut settings: MeetingSettings = match store.get_setting(SETTINGS_KEY) {
        Ok(Some(json)) => serde_json::from_str(&json).unwrap_or_default(),
        _ => MeetingSettings::default(),
    };
    // Migrate the short-lived Ctrl+Alt+M default (and the macOS default that
    // older Windows builds persisted verbatim) back onto the platform default,
    // while preserving every user-recorded custom binding.
    let legacy_default = cfg!(target_os = "macos") && settings.toggle_hotkey == "Ctrl+Alt+M"
        || !cfg!(target_os = "macos")
            && matches!(
                settings.toggle_hotkey.as_str(),
                "Ctrl+Alt+M" | "Cmd+Shift+M"
            );
    if legacy_default {
        settings.toggle_hotkey = default_toggle_hotkey();
    }
    settings
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

/// Where a meeting's raw audio lives when `save_audio` is on. Derived from the
/// id (not stored in the DB) so delete/prune can clean up unconditionally.
fn audio_dir(app_data: &Path, id: &str) -> PathBuf {
    app_data.join("meetings").join(id)
}

/// Best-effort removal of a meeting's saved audio.
fn remove_audio_dir(app_data: &Path, id: &str) {
    let dir = audio_dir(app_data, id);
    if dir.is_dir() {
        if let Err(e) = std::fs::remove_dir_all(&dir) {
            tracing::warn!("meeting: failed to remove audio dir {}: {e}", dir.display());
        }
    }
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
  <string>cetus listens during meetings to transcribe them into searchable notes.</string>
  <key>NSSpeechRecognitionUsageDescription</key>
  <string>cetus transcribes meetings on-device so you can recall what was said.</string>
  <key>NSAudioCaptureUsageDescription</key>
  <string>cetus transcribes the other meeting participants from your system audio.</string>
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
        let bin = bin_dir.join("cetus-meeting-helper-v9");
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
    /// Granola-style cancel semantics: set when the user stops a session while
    /// the call app still holds the mic, cleared by the monitor once the mic is
    /// released. While set, auto-detect never restarts a session — a user stop
    /// is final for the current call, not a 6-second pause.
    auto_suppressed: std::sync::atomic::AtomicBool,
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
    /// Epoch-ms of the last ASR caption (partial or final) from either stream.
    /// Read by the watchdog's idle check; starts at session start.
    last_activity: Arc<AtomicI64>,
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
        // Always record the raw mic — never Apple's voice-processing (AEC)
        // unit. Manual sessions used to keep AEC on so speaker playback would
        // not be transcribed twice, but in practice the VP unit's output was
        // silent for the whole call: every AEC session on record produced zero
        // `mic` segments (and a ~3 kbps mic.m4a), while the one `--no-aec`
        // session transcribed both sides fine. The VP unit is also a
        // system-wide side effect (its AGC audibly lowers the user's voice for
        // everyone on the call). Speaker users may see the far side echoed
        // into "You" lines; a dead "You" stream is the worse failure.
        args.push("--no-aec".into());
        let id = uuid::Uuid::new_v4().to_string();
        if settings.save_audio {
            args.push("--save-dir".into());
            args.push(audio_dir(app_data, &id).into_os_string());
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

        let started_ts = now_ms();
        if let Err(e) = store.insert_meeting(&id, started_ts, app_hint.as_deref()) {
            kill_active_capture(); // never leave the mic hot on a failed start
            let _ = child.wait().await;
            remove_audio_dir(app_data, &id);
            return Err(e.to_string());
        }

        let segments = Arc::new(AtomicI64::new(0));
        let last_activity = Arc::new(AtomicI64::new(started_ts));
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
            last_activity: last_activity.clone(),
        });
        drop(slot);

        emit_meeting_event(app, "started", &id, app_hint.as_deref(), None);
        spawn_pill_watcher(app.clone(), id.clone());
        // Session watchdog: finalize after MAX_SESSION_SECS (any session), or —
        // auto sessions only — after AUTO_IDLE_STOP_SECS without a caption from
        // either ASR stream (see the constant for why mic release alone is not
        // a reliable end-of-call signal). The id check makes every tick a no-op
        // once the session has ended normally.
        {
            let app = app.clone();
            let watchdog_id = id.clone();
            let last_activity = last_activity.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(WATCHDOG_TICK_SECS)).await;
                    let runtime = app.state::<MeetingRuntime>();
                    let ours = {
                        let slot = runtime.active.lock().await;
                        match slot.as_ref() {
                            Some(s) if s.id == watchdog_id => Some((s.started_ts, s.auto)),
                            _ => None,
                        }
                    };
                    let Some((started_ts, auto)) = ours else {
                        return;
                    };
                    let now = now_ms();
                    let over_max = now - started_ts >= (MAX_SESSION_SECS * 1000) as i64;
                    let idle = auto
                        && now - last_activity.load(Ordering::Relaxed)
                            >= (AUTO_IDLE_STOP_SECS * 1000) as i64;
                    if over_max || idle {
                        tracing::info!(
                            "meeting: {} reached; auto-finalizing {watchdog_id}",
                            if over_max {
                                "max session duration"
                            } else {
                                "transcript silence limit"
                            }
                        );
                        // suppress_auto: the call app may still hold the mic
                        // (that is precisely the case the idle stop exists
                        // for) — without suppression the monitor would restart
                        // a session immediately and this stop would be a no-op.
                        let _ = stop_internal(&app, true).await;
                        return;
                    }
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
///
/// `suppress_auto` marks a stop that is final for the current call — the user
/// asked (pill button, Settings, hotkey) or a watchdog concluded the call is
/// over (idle / max duration). It suppresses auto-detect until the call app
/// releases the mic; otherwise the stop is un-stoppable: the monitor still
/// sees the app on the mic and restarts a session on its next tick. The one
/// caller passing `false` is the mic-release auto-stop, where the occupancy
/// that would retrigger is already gone.
async fn stop_internal(app: &AppHandle, suppress_auto: bool) -> Result<bool, String> {
    let runtime = app.state::<MeetingRuntime>();
    let (stdin, pid) = {
        let mut slot = runtime.active.lock().await;
        match slot.as_mut() {
            None => return Ok(false),
            Some(s) => (s.stdin.take(), s.child_pid),
        }
    };
    if suppress_auto {
        runtime.auto_suppressed.store(true, Ordering::Relaxed);
    }
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
        if i == 60 && pid.is_some() {
            kill_active_capture();
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
                // A previous session may have left the panel expanded (hidden
                // while hovered) — always present collapsed.
                crate::panel::resize_keep_top_center(ptr, HUD_COLLAPSED.0, HUD_COLLAPSED.1);
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
#[cfg(target_os = "macos")]
// Params are a grab-bag of distinct spawn-time context; a struct would just
// relocate the list, so allow the arity.
#[allow(clippy::too_many_arguments)]
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
                            app.clone(),
                            store.clone(),
                            &app_data,
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
        } else if let Some(p) = v.get("partial") {
            // Live-caption hypothesis for the current utterance — HUD-only,
            // never persisted (the following `segment` is the durable record).
            let source = p.get("source").and_then(|s| s.as_str()).unwrap_or("mic");
            let ts = p.get("ts").and_then(|t| t.as_i64()).unwrap_or_else(now_ms);
            let text = p.get("text").and_then(|t| t.as_str()).unwrap_or("");
            emit_caption(&app, &id, source, "partial", ts, text);
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
            emit_caption(&app, &id, source, "final", ts, text);
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
    for mut task in cloud_tasks {
        // Bounded join: a wedged ASR socket must not keep the session slot
        // occupied forever (the stop spinner would never resolve).
        if tokio::time::timeout(Duration::from_secs(15), &mut task)
            .await
            .is_err()
        {
            tracing::warn!("meeting: cloud ASR finalize timed out; aborting");
            task.abort();
        }
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
    // Announce the end immediately (the HUD and Settings resync off this);
    // "saved" follows once the summary lands.
    emit_meeting_event(&app, "stopped", &id, app_hint.as_deref(), None);

    let count = segments.load(Ordering::Relaxed);
    let ended_ts = now_ms();
    if let Err(e) = store.finish_meeting(&id, ended_ts, count) {
        tracing::warn!("meeting: finalize failed: {e}");
    }
    if count == 0 {
        // Nothing was said — drop the empty shell row (and its audio) entirely.
        let _ = store.delete_meeting(&id);
        remove_audio_dir(&app_data, &id);
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

#[cfg(target_os = "macos")]
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

#[cfg(not(target_os = "macos"))]
fn kill_active_capture() {}

/// Synchronous exit hook: do not leave a privacy-sensitive capture helper
/// holding the microphone if the desktop process is killed/restarted.
pub fn shutdown_capture() {
    kill_active_capture();
}

/// (mic, system) PCM channels plus the spawned task handles. Grouped so the
/// tuple reads as one thing instead of three free-floating types.
type CloudAsrChannels = (
    tokio::sync::mpsc::Sender<Vec<u8>>,
    tokio::sync::mpsc::Sender<Vec<u8>>,
    Vec<tokio::task::JoinHandle<()>>,
);

/// Broadcast one live-caption line to the HUD. `kind` is `partial` (whole-text
/// replace of the in-flight hypothesis for `source`) or `final` (append; also
/// clears that source's partial). Broadcast, not `emit_to`: the meeting pill is
/// the consumer today, but the transcript view in Settings listens too, and
/// broadcast is the pattern that survived the emit_to("main") regression.
fn emit_caption(app: &AppHandle, id: &str, source: &str, kind: &str, ts: i64, text: &str) {
    // Any caption (either stream, partial or final) proves the call is still
    // alive — feed the watchdog's idle check. Both the local-engine reader and
    // the cloud-ASR tasks funnel through here, so this is the one choke point.
    // try_lock: this is a sync path and a missed bump self-heals on the next
    // caption, which arrives multiple times per second during speech.
    if let Ok(slot) = app.state::<MeetingRuntime>().active.try_lock() {
        if let Some(s) = slot.as_ref().filter(|s| s.id == id) {
            s.last_activity.store(now_ms(), Ordering::Relaxed);
        }
    }
    let _ = app.emit(
        "meeting-caption",
        json!({
            "meetingId": id,
            "source": source,
            "kind": kind,
            "ts": ts,
            "text": text,
        }),
    );
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
        match stop_internal(&app, true).await {
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
