//! On-device dictation via a tiny Swift helper (SFSpeechRecognizer), mirroring
//! the lazy-`swiftc`-compile pattern in [`crate::ocr`].
//!
//! The helper streams JSONL while it captures the mic; we parse those lines and
//! re-emit them as Tauri events (`voice-partial` / `voice-final` / `voice-ready`
//! / `voice-error`) so any window — the composer, the quick panel, or the global
//! HUD — can render a live transcript. Only one dictation runs at a time.
//!
//! The `*_internal` fns hold the actual logic; the `#[tauri::command]` wrappers
//! and the native push-to-talk thread (`hotkey.rs`) both call them.
//!
//! macOS only. On other platforms every command is a graceful no-op/error.

use crate::AppState;
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{oneshot, Mutex};

/// Microphone + Speech Recognition authorization, as reported by the helper.
/// Values: "authorized" | "denied" | "restricted" | "undetermined" | "unknown".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoicePermissions {
    pub mic: String,
    pub speech: String,
}

impl VoicePermissions {
    #[allow(dead_code)] // only constructed on non-macOS builds
    fn unsupported() -> Self {
        Self {
            mic: "unsupported".into(),
            speech: "unsupported".into(),
        }
    }
}

/// The currently-running dictation, if any. Shared in [`AppState`] so stop/cancel
/// can reach the live child process.
#[derive(Default, Clone)]
pub struct DictationState {
    inner: Arc<Mutex<Option<Active>>>,
    /// A pre-warmed `stream --standby` helper parked on stdin. Writing "go\n"
    /// starts its audio engine within the AVAudioEngine spin-up alone — the
    /// fork/exec + dyld + Swift-runtime cost was paid ahead of the keypress, so
    /// less of the user's first word is lost. Never holds the mic while parked.
    #[cfg(target_os = "macos")]
    warm: Arc<Mutex<Option<Warm>>>,
}

#[cfg(target_os = "macos")]
struct Active {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    /// Resolved by the stdout reader once the helper prints its `final` line, so
    /// `stop` can return the transcript to the (Rust) global-dictation caller
    /// without round-tripping through the event bus.
    final_rx: Option<oneshot::Receiver<String>>,
    /// Latest streaming partial. When the final never lands (server hang, the
    /// 8 s stop timeout), inserting this beats silently discarding the whole
    /// utterance — total loss is the failure users forgive least.
    last_partial: Arc<std::sync::Mutex<String>>,
    /// True when `child` is the disclaim shim (a process-group leader). Cancel
    /// then kills the whole group so the disclaimed helper dies with it, instead
    /// of leaking as an orphan that keeps the mic hot.
    group_leader: bool,
}

/// A parked standby helper (see [`DictationState::warm`]).
#[cfg(target_os = "macos")]
struct Warm {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    stdout: Option<tokio::process::ChildStdout>,
    group_leader: bool,
}

// Non-macOS keeps the struct shape minimal; nothing is ever stored.
#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
struct Active {
    _final_rx: Option<oneshot::Receiver<String>>,
}

// ---- Helper resolution (lazy swiftc compile, mirrors ocr.rs) --------------

// pub(crate): the meeting helper (meeting.rs) reuses the disclaim shim so its
// own TCC prompts carry the embedded usage strings too.
#[cfg(target_os = "macos")]
pub(crate) mod helper {
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::OnceLock;

    const HELPER_SRC: &str = include_str!("../speech/cetus-speech-helper.swift");

    // A standalone CLI binary has no bundle Info.plist, so macOS TCC has no
    // usage-description strings to show when the helper requests Microphone /
    // Speech Recognition access — and it *crashes the process with SIGABRT*
    // ("must contain an NSSpeechRecognitionUsageDescription key") instead of
    // prompting. We embed a minimal Info.plist directly into the Mach-O via the
    // linker's `__TEXT,__info_plist` section so the prompts work. Keep the
    // strings in sync with src-tauri/Info.plist (the app bundle's copy).
    const HELPER_PLIST: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>dev.cetus.app.speech-helper</string>
  <key>CFBundleName</key>
  <string>cetus-speech-helper</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>cetus uses your microphone to transcribe speech to text for voice input.</string>
  <key>NSSpeechRecognitionUsageDescription</key>
  <string>cetus transcribes your speech on-device so you can dictate instead of type.</string>
</dict>
</plist>
"#;

    static HELPER: OnceLock<Option<PathBuf>> = OnceLock::new();

    pub fn path(app_data: &Path) -> Option<&'static Path> {
        HELPER
            .get_or_init(|| resolve_or_compile(app_data))
            .as_deref()
    }

    // A tiny C launcher that spawns the speech helper with TCC responsibility
    // disclaimed, so the helper is its own responsible process and macOS reads
    // its embedded Info.plist (see cetus-spawn-disclaim.c). Lazily compiled with
    // `cc`, same pattern as the Swift helper.
    const SHIM_SRC: &str = include_str!("../speech/cetus-spawn-disclaim.c");
    static SHIM: OnceLock<Option<PathBuf>> = OnceLock::new();

    pub fn shim_path(app_data: &Path) -> Option<&'static Path> {
        SHIM.get_or_init(|| compile_shim(app_data)).as_deref()
    }

    fn compile_shim(app_data: &Path) -> Option<PathBuf> {
        let bin_dir = app_data.join("bin");
        let bin = bin_dir.join("cetus-spawn-disclaim");
        if bin.exists() {
            return Some(bin);
        }
        std::fs::create_dir_all(&bin_dir).ok()?;
        let src = bin_dir.join("cetus-spawn-disclaim.c");
        if std::fs::write(&src, SHIM_SRC).is_err() {
            return None;
        }
        let output = Command::new("cc")
            .args(["-O2", "-o"])
            .arg(&bin)
            .arg(&src)
            .output();
        match output {
            Ok(o) if o.status.success() && bin.exists() => {
                tracing::info!("compiled disclaim shim at {}", bin.display());
                Some(bin)
            }
            Ok(o) => {
                tracing::warn!(
                    "cc failed to build disclaim shim; falling back to direct spawn: {}",
                    String::from_utf8_lossy(&o.stderr)
                );
                None
            }
            Err(e) => {
                tracing::warn!("cc unavailable; falling back to direct spawn: {e}");
                None
            }
        }
    }

    fn resolve_or_compile(app_data: &Path) -> Option<PathBuf> {
        if let Ok(p) = std::env::var("CETUS_SPEECH_HELPER") {
            let p = PathBuf::from(p);
            if p.exists() {
                return Some(p);
            }
        }
        let bin_dir = app_data.join("bin");
        // Bump the version suffix whenever the embedded Swift changes so cached
        // installs recompile. `-v2` added the embedded Info.plist (TCC prompt);
        // `-v3` added optional `--wav` capture for cloud re-transcription;
        // `-v4` added the silence gate (skip the WAV when no speech, so cloud
        // Whisper can't hallucinate text from a silent clip);
        // `-v6` added stream `--standby` (pre-warmed helper), the 200 ms
        // release-tail capture, and the stream-mode speech gate.
        let bin = bin_dir.join("cetus-speech-helper-v6");
        if bin.exists() {
            return Some(bin);
        }
        std::fs::create_dir_all(&bin_dir).ok()?;
        let src = bin_dir.join("cetus-speech-helper.swift");
        if std::fs::write(&src, HELPER_SRC).is_err() {
            return None;
        }
        // Embedded Info.plist carrying the Microphone + Speech usage strings,
        // linked into the binary's __TEXT,__info_plist section (see HELPER_PLIST).
        let plist = bin_dir.join("cetus-speech-helper.plist");
        if std::fs::write(&plist, HELPER_PLIST).is_err() {
            return None;
        }
        let output = Command::new("swiftc")
            .args(["-O", "-framework", "Speech", "-framework", "AVFoundation"])
            .arg("-Xlinker")
            .arg("-sectcreate")
            .arg("-Xlinker")
            .arg("__TEXT")
            .arg("-Xlinker")
            .arg("__info_plist")
            .arg("-Xlinker")
            .arg(&plist)
            .arg("-o")
            .arg(&bin)
            .arg(&src)
            .output();
        match output {
            Ok(o) if o.status.success() && bin.exists() => {
                tracing::info!("compiled speech helper at {}", bin.display());
                Some(bin)
            }
            Ok(o) => {
                tracing::warn!(
                    "swiftc failed to build speech helper; dictation disabled: {}",
                    String::from_utf8_lossy(&o.stderr)
                );
                None
            }
            Err(e) => {
                tracing::warn!("swiftc unavailable; dictation disabled: {e}");
                None
            }
        }
    }
}

/// Resolve how to invoke the speech helper: through the disclaim shim when it's
/// available (so the helper is its own TCC-responsible process and uses its
/// embedded usage strings), otherwise direct. Returns the program to spawn, the
/// leading args (the helper path when shimmed), and whether the spawned child is
/// a process-group leader (true when shimmed — see cancel_internal).
#[cfg(target_os = "macos")]
fn helper_command(
    state: &AppState,
) -> Result<(std::path::PathBuf, Vec<std::ffi::OsString>, bool), String> {
    let bin = helper::path(&state.app_data_dir)
        .ok_or("speech helper unavailable (swiftc missing?)")?
        .to_path_buf();
    match helper::shim_path(&state.app_data_dir) {
        Some(shim) => Ok((shim.to_path_buf(), vec![bin.into_os_string()], true)),
        // No C compiler — fall back to direct spawn. This still works in a
        // packaged .app (the bundle's Info.plist covers the responsible process);
        // it only regresses under `tauri dev`.
        None => Ok((bin, Vec::new(), false)),
    }
}

/// Spawn the `stream` helper (optionally in `--standby`), wire its stderr to the
/// log, and hand back the pipes. Shared by the live path and [`prewarm`].
#[cfg(target_os = "macos")]
fn spawn_stream_helper(
    state: &AppState,
    standby: bool,
    tag: &'static str,
) -> Result<
    (
        tokio::process::Child,
        tokio::process::ChildStdin,
        tokio::process::ChildStdout,
        bool,
    ),
    String,
> {
    use tokio::process::Command;
    let (program, mut args, group_leader) = helper_command(state)?;
    args.push("stream".into());
    if standby {
        args.push("--standby".into());
    }
    let mut child = Command::new(&program)
        .args(&args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start dictation: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin on helper")?;
    let stdout = child.stdout.take().ok_or("no stdout on helper")?;
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!("speech-helper({tag}): {line}");
            }
        });
    }
    Ok((child, stdin, stdout, group_leader))
}

/// Park a standby helper for the next dictation, if the Doubao stream path is
/// the one that would run and nothing is parked yet. Best-effort and cheap to
/// call repeatedly; the parked process holds no mic and exits quietly on EOF.
#[cfg(target_os = "macos")]
pub async fn prewarm(state: &AppState) {
    use std::sync::atomic::Ordering;
    if !state.quick.voice_enabled.load(Ordering::Relaxed) {
        return;
    }
    let engine = state.quick.voice_asr_engine.load(Ordering::Relaxed);
    if engine != crate::quick::ASR_DOUBAO || !crate::secrets::has("doubao") {
        return;
    }
    // A dev-override helper (CETUS_SPEECH_HELPER) may predate `--standby`; an
    // old binary would ignore the flag and grab the mic at park time. Only
    // pre-warm the version-gated compiled helper.
    if std::env::var("CETUS_SPEECH_HELPER").is_ok() {
        return;
    }
    // Resolve (= lazily compile) the helper + shim off this thread: the first
    // run after a version bump pays seconds of swiftc, which must not stall
    // the caller (the voice worker awaits this on its command loop).
    let app_data = state.app_data_dir.clone();
    let compiled = tokio::task::spawn_blocking(move || {
        let h = helper::path(&app_data).is_some();
        let _ = helper::shim_path(&app_data);
        h
    })
    .await
    .unwrap_or(false);
    if !compiled {
        return;
    }
    let mut warm = state.dictation.warm.lock().await;
    if let Some(w) = warm.as_mut() {
        // Replace a parked helper that has since died (crash, system cleanup).
        if w.child.try_wait().ok().flatten().is_none() {
            return;
        }
        *warm = None;
    }
    match spawn_stream_helper(state, true, "standby") {
        Ok((child, stdin, stdout, group_leader)) => {
            *warm = Some(Warm {
                child,
                stdin,
                stdout: Some(stdout),
                group_leader,
            });
        }
        Err(e) => tracing::debug!("voice prewarm skipped: {e}"),
    }
}

/// Take the parked standby helper if it's still alive.
#[cfg(target_os = "macos")]
async fn take_warm(state: &AppState) -> Option<Warm> {
    let mut slot = state.dictation.warm.lock().await;
    let mut w = slot.take()?;
    if w.child.try_wait().ok().flatten().is_some() {
        return None; // exited while parked
    }
    if w.stdout.is_none() {
        return None;
    }
    Some(w)
}

// ---- Permissions ----------------------------------------------------------

#[tauri::command]
pub async fn voice_permissions(state: State<'_, AppState>) -> Result<VoicePermissions, String> {
    #[cfg(target_os = "macos")]
    {
        run_perm_subcommand(&state, "permcheck").await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
        Ok(VoicePermissions::unsupported())
    }
}

/// Trigger the macOS Microphone + Speech Recognition prompts (when undetermined)
/// and report the resulting authorization status.
#[tauri::command]
pub async fn request_voice_permissions(
    state: State<'_, AppState>,
) -> Result<VoicePermissions, String> {
    #[cfg(target_os = "macos")]
    {
        run_perm_subcommand(&state, "request").await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
        Ok(VoicePermissions::unsupported())
    }
}

#[tauri::command]
pub async fn open_microphone_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
async fn run_perm_subcommand(
    state: &AppState,
    sub: &'static str,
) -> Result<VoicePermissions, String> {
    let (program, mut args, _) = helper_command(state)?;
    args.push(sub.into());
    let out = tokio::process::Command::new(&program)
        .args(&args)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value =
        serde_json::from_str(text.trim()).map_err(|e| format!("bad helper output: {e}"))?;
    Ok(VoicePermissions {
        mic: v
            .get("mic")
            .and_then(|x| x.as_str())
            .unwrap_or("unknown")
            .to_string(),
        speech: v
            .get("speech")
            .and_then(|x| x.as_str())
            .unwrap_or("unknown")
            .to_string(),
    })
}

// ---- Dictation lifecycle (internal) ---------------------------------------

/// Start capturing the mic and streaming a transcript. `target` ("composer" |
/// "quick" | "global") is echoed back on every event so a surface can ignore a
/// session it didn't start.
#[cfg(target_os = "macos")]
pub async fn start_internal(
    state: &AppState,
    app: &AppHandle,
    target: String,
) -> Result<(), String> {
    use tokio::process::Command;

    let mut guard = state.dictation.inner.lock().await;
    if guard.is_some() {
        return Err("a dictation is already running".into());
    }

    let engine = state
        .quick
        .voice_asr_engine
        .load(std::sync::atomic::Ordering::Relaxed);

    // Doubao real-time streaming path: the helper streams live PCM (the `stream`
    // subcommand) which we forward over a WebSocket, emitting `voice-partial` as
    // text arrives and `voice-final` ~90ms after release. Structurally distinct
    // from the Apple/batch-cloud flow below, so it fills the Active slot and
    // returns here.
    if engine == crate::quick::ASR_DOUBAO && crate::secrets::has("doubao") {
        use base64::Engine as _;
        let key = crate::secrets::get("doubao")
            .ok()
            .flatten()
            .unwrap_or_default();
        let resource = crate::doubao::DEFAULT_RESOURCE_ID.to_string();
        // Corpus assembly does file IO, jieba segmentation, and an Accessibility
        // round-trip — run it concurrently with helper startup so it can never
        // delay the mic going live (it used to sit on the critical path).
        let settings = crate::quick::load_settings(&state.store);
        let corpus_dir = state.app_data_dir.clone();
        let corpus_task =
            tokio::task::spawn_blocking(move || build_corpus_with(&corpus_dir, &settings));

        // Prefer the pre-warmed standby helper: "go\n" starts its (already
        // loaded) audio engine immediately. Fall back to a cold spawn.
        let mut picked = None;
        if let Some(mut w) = take_warm(state).await {
            use tokio::io::AsyncWriteExt;
            if let Some(out) = w.stdout.take() {
                if w.stdin.write_all(b"go\n").await.is_ok() && w.stdin.flush().await.is_ok() {
                    tracing::debug!("doubao asr: using pre-warmed helper");
                    picked = Some((w.child, w.stdin, out, w.group_leader));
                }
            }
        }
        let (child, stdin, stdout, group_leader) = match picked {
            Some(t) => t,
            None => spawn_stream_helper(state, false, "stream")?,
        };
        let (final_tx, final_rx) = oneshot::channel::<String>();
        let (pcm_tx, pcm_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
        let last_partial = Arc::new(std::sync::Mutex::new(String::new()));
        // Helper reports {"speech":bool} at stop; a no-speech session (accidental
        // hold, room noise) is discarded rather than typed.
        let speech_seen = Arc::new(std::sync::atomic::AtomicBool::new(true));

        // Stream task: run the Doubao session, emit partials + final, hand the
        // final back to the (global) stop caller, clear Active. History recording
        // happens downstream in finish_ptt, AFTER cleanup — so history, dialog
        // continuity, and hotword learning all see the same text the user got.
        let app_s = app.clone();
        let target_s = target.clone();
        let inner_s = state.dictation.inner.clone();
        let speech_s = speech_seen.clone();
        let partial_s = last_partial.clone();
        tokio::spawn(async move {
            let corpus = corpus_task.await.unwrap_or_default();
            tracing::info!(
                "doubao asr (push-to-talk) starting: resource_id={resource}, hotwords={}, context={}, recent={}, table={}",
                corpus.hotwords.len(),
                corpus.context.is_some(),
                corpus.recent.is_some(),
                corpus.boosting_table_id.is_some()
            );
            let on_partial = {
                let app = app_s.clone();
                let target = target_s.clone();
                move |txt: &str| {
                    if let Ok(mut p) = partial_s.lock() {
                        *p = txt.to_string();
                    }
                    let _ = app.emit("voice-partial", json_payload(&target, "text", txt));
                }
            };
            let mut final_text =
                match crate::doubao::stream(&key, &resource, corpus, pcm_rx, on_partial).await {
                    Ok(t) => t,
                    Err(e) => {
                        tracing::warn!("doubao stream failed: {e}");
                        let _ = app_s.emit(
                            "voice-error",
                            json_payload(&target_s, "message", "Doubao recognition failed"),
                        );
                        String::new()
                    }
                };
            // Gate discard on BOTH signals agreeing: the RMS gate says silence
            // AND the transcript is short (noise hallucinations are brief). A
            // long coherent transcript is stronger evidence of speech than the
            // energy floor — quiet mics/low-gain interfaces must not lose real
            // dictations to an RMS threshold.
            if !speech_s.load(std::sync::atomic::Ordering::Relaxed)
                && !final_text.trim().is_empty()
                && final_text.chars().count() <= 10
            {
                tracing::info!(
                    "doubao asr: no speech detected; discarding {} chars of noise transcript",
                    final_text.chars().count()
                );
                final_text = String::new();
            }
            tracing::info!(
                "doubao asr (push-to-talk) final [{}]: {} chars: {:?}",
                target_s,
                final_text.chars().count(),
                preview(&final_text)
            );
            let _ = app_s.emit("voice-final", json_payload(&target_s, "text", &final_text));
            let _ = final_tx.send(final_text);
            *inner_s.lock().await = None;
        });

        // Reader task: parse the helper's JSONL → forward PCM to the stream,
        // re-emit level/ready, and on `pcm_end`/EOF drop `pcm_tx` so the Doubao
        // session sees end-of-audio and finalizes.
        let app_r = app.clone();
        let target_r = target.clone();
        let speech_r = speech_seen.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                if let Some(p) = v.get("pcm").and_then(|x| x.as_str()) {
                    if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(p) {
                        if pcm_tx.send(bytes).await.is_err() {
                            break;
                        }
                    }
                } else if let Some(l) = v.get("level").and_then(|x| x.as_f64()) {
                    let _ = app_r.emit(
                        "voice-level",
                        serde_json::json!({ "target": target_r, "level": l }),
                    );
                } else if v.get("ready").is_some() {
                    let _ = app_r.emit("voice-ready", serde_json::json!({ "target": target_r }));
                } else if let Some(s) = v.get("speech").and_then(|x| x.as_bool()) {
                    speech_r.store(s, std::sync::atomic::Ordering::Relaxed);
                } else if v.get("pcm_end").is_some() {
                    break;
                } else if let Some(e) = v.get("error").and_then(|x| x.as_str()) {
                    let _ = app_r.emit("voice-error", json_payload(&target_r, "message", e));
                    break;
                }
            }
            // pcm_tx is dropped as this task ends → Doubao sees end-of-audio.
        });

        *guard = Some(Active {
            child,
            stdin,
            final_rx: Some(final_rx),
            last_partial,
            group_leader,
        });
        // Park a fresh standby helper for the next dictation (best-effort).
        let app_w = app.clone();
        tokio::spawn(async move {
            prewarm(&app_w.state::<AppState>()).await;
        });
        return Ok(());
    }

    // Non-Doubao path: Apple on-device dictation (SFSpeechRecognizer via the
    // `listen` helper). Any engine other than Doubao-with-a-key lands here.
    if engine == crate::quick::ASR_DOUBAO {
        tracing::info!("doubao selected but no key set → falling back to Apple on-device asr");
    } else {
        tracing::info!("apple on-device asr (push-to-talk) starting");
    }
    let (program, mut args, group_leader) = helper_command(state)?;
    args.push("listen".into());

    let mut child = Command::new(&program)
        .args(&args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start dictation: {e}"))?;

    let stdin = child.stdin.take().ok_or("no stdin on helper")?;
    let stdout = child.stdout.take().ok_or("no stdout on helper")?;
    let stderr = child.stderr.take();
    let (final_tx, final_rx) = oneshot::channel::<String>();

    // Drain stderr to the log so a misbehaving helper is diagnosable.
    if let Some(stderr) = stderr {
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!("speech-helper: {line}");
            }
        });
    }

    // Parse the JSONL stream → Tauri events. On EOF the helper has exited, so
    // clear the active slot.
    let app_for_reader = app.clone();
    let target_for_reader = target.clone();
    let inner = state.dictation.inner.clone();
    let last_partial = Arc::new(std::sync::Mutex::new(String::new()));
    let partial_w = last_partial.clone();
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut final_tx = Some(final_tx);
        // Track whether the helper ever went live and whether it reported a
        // terminal outcome (a final transcript or an explicit error). If it
        // exits without either, it died abnormally — most often a SIGABRT from
        // a TCC privacy violation when Microphone/Speech Recognition isn't yet
        // authorized — and we must synthesize an error, or the UI surface that
        // started this session sticks in its "starting" state forever.
        let mut saw_ready = false;
        let mut saw_terminal = false;
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if let Some(l) = v.get("level").and_then(|x| x.as_f64()) {
                // ~20/s amplitude for the waveform indicator. Checked first since
                // it's the most frequent line.
                let _ = app_for_reader.emit(
                    "voice-level",
                    serde_json::json!({ "target": target_for_reader, "level": l }),
                );
            } else if let Some(p) = v.get("partial").and_then(|x| x.as_str()) {
                if let Ok(mut lp) = partial_w.lock() {
                    *lp = p.to_string();
                }
                let _ = app_for_reader
                    .emit("voice-partial", json_payload(&target_for_reader, "text", p));
            } else if let Some(f) = v.get("final").and_then(|x| x.as_str()) {
                saw_terminal = true;
                let final_text = f.to_string();
                tracing::info!(
                    "apple asr final [{}]: {} chars: {:?}",
                    target_for_reader,
                    final_text.chars().count(),
                    preview(&final_text)
                );
                if let Some(tx) = final_tx.take() {
                    let _ = tx.send(final_text.clone());
                }
                let _ = app_for_reader.emit(
                    "voice-final",
                    json_payload(&target_for_reader, "text", &final_text),
                );
                // History recording happens in finish_ptt, after cleanup, so all
                // downstream consumers see the same text the user received.
            } else if v.get("ready").is_some() {
                saw_ready = true;
                let _ = app_for_reader.emit(
                    "voice-ready",
                    serde_json::json!({ "target": target_for_reader }),
                );
            } else if let Some(e) = v.get("error").and_then(|x| x.as_str()) {
                saw_terminal = true;
                let _ = app_for_reader.emit(
                    "voice-error",
                    json_payload(&target_for_reader, "message", e),
                );
            }
        }
        // Helper exited. If it never sent a final, unblock any waiter.
        if let Some(tx) = final_tx.take() {
            let _ = tx.send(String::new());
        }
        // No final and no error line means an abnormal exit (crash, killed, or
        // permission denied before it could speak). Surface it so the UI resets
        // instead of hanging — and point at the usual culprit when it never even
        // went live.
        if !saw_terminal {
            let msg = if saw_ready {
                "dictation ended unexpectedly".to_string()
            } else {
                "couldn't start dictation — check Microphone & Speech Recognition \
                 access for cetus in System Settings › Privacy & Security"
                    .to_string()
            };
            let _ = app_for_reader.emit(
                "voice-error",
                json_payload(&target_for_reader, "message", &msg),
            );
        }
        *inner.lock().await = None;
    });

    *guard = Some(Active {
        child,
        stdin,
        final_rx: Some(final_rx),
        last_partial,
        group_leader,
    });
    Ok(())
}

/// Finalize the running dictation (newline → helper stdin), wait for the final
/// transcript, and return it. "" if nothing is running.
#[cfg(target_os = "macos")]
pub async fn stop_internal(state: &AppState) -> String {
    use tokio::io::AsyncWriteExt;

    let (rx, last_partial) = {
        let mut guard = state.dictation.inner.lock().await;
        let Some(active) = guard.as_mut() else {
            return String::new();
        };
        let _ = active.stdin.write_all(b"\n").await;
        let _ = active.stdin.flush().await;
        (active.final_rx.take(), active.last_partial.clone())
    };
    match rx {
        // Covers the Doubao stream finalizing after the helper signals
        // end-of-audio (~tens of ms, sometimes a beat longer under load). Kept
        // tight (8s, not tens of seconds) because the voice worker awaits this
        // call serially — a long wait would stall the next gesture's command
        // behind it. A hung session falls back to the last streaming partial:
        // imperfect text beats silently discarding the whole utterance.
        Some(rx) => match tokio::time::timeout(std::time::Duration::from_secs(8), rx).await {
            Ok(Ok(text)) => text,
            _ => {
                let partial = last_partial.lock().map(|p| p.clone()).unwrap_or_default();
                if !partial.trim().is_empty() {
                    tracing::warn!(
                        "dictation final timed out; falling back to last partial ({} chars)",
                        partial.chars().count()
                    );
                }
                partial
            }
        },
        None => String::new(),
    }
}

/// Block until the single dictation slot is free (or `timeout` elapses). The
/// voice worker calls this before any start so a previous session that is still
/// tearing down (its async task clears the slot a beat after the stop call
/// returns) can't make the new start error with "already running".
#[cfg(target_os = "macos")]
pub async fn await_slot_free(state: &AppState, timeout: std::time::Duration) {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if state.dictation.inner.lock().await.is_none() {
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

/// Abort dictation immediately, discarding any transcript.
#[cfg(target_os = "macos")]
pub async fn cancel_internal(state: &AppState) {
    let mut guard = state.dictation.inner.lock().await;
    if let Some(mut active) = guard.take() {
        // When shimmed, the helper runs disclaimed in the shim's process group;
        // SIGKILL the whole group so the helper dies too (not just the shim).
        if active.group_leader {
            if let Some(pid) = active.child.id() {
                // Safe: killpg just signals; an already-dead group is a no-op.
                unsafe {
                    libc::killpg(pid as libc::pid_t, libc::SIGKILL);
                }
            }
        }
        // Reap the (now-dead) shim, or SIGKILL the helper directly in the
        // no-shim fallback.
        let _ = active.child.kill().await;
    }
}

// ---- Hands-free dictation (continuous, tap-to-toggle) ---------------------

/// Start a hands-free Doubao session: stream the mic continuously and insert
/// each completed (VAD-`definite`) sentence into the focused app as it lands,
/// until [`stop_handsfree_internal`] is called. Fills the same `Active` slot as
/// push-to-talk (only one dictation runs at a time), but with no `final_rx` —
/// insertion happens live per sentence rather than once on release. Requires the
/// Doubao key; returns an error otherwise (the caller stays on push-to-talk).
#[cfg(target_os = "macos")]
pub async fn start_handsfree_internal(state: &AppState, app: &AppHandle) -> Result<(), String> {
    use base64::Engine as _;
    use std::sync::atomic::Ordering;
    use tokio::process::Command;

    if !crate::secrets::has("doubao") {
        return Err("hands-free requires the Doubao engine + key".into());
    }
    let mut guard = state.dictation.inner.lock().await;
    if guard.is_some() {
        return Err("a dictation is already running".into());
    }

    let key = crate::secrets::get("doubao")
        .ok()
        .flatten()
        .unwrap_or_default();
    let resource = crate::doubao::DEFAULT_RESOURCE_ID.to_string();
    let corpus = build_corpus(state);
    tracing::info!(
        "doubao asr (hands-free) starting: resource_id={resource}, hotwords={}, context={}, recent={}, table={}",
        corpus.hotwords.len(),
        corpus.context.is_some(),
        corpus.recent.is_some(),
        corpus.boosting_table_id.is_some()
    );
    let mode_code = state.quick.voice_insert_mode.load(Ordering::Relaxed);

    let (program, mut args, group_leader) = helper_command(state)?;
    args.push("stream".into());
    let mut child = Command::new(&program)
        .args(&args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start dictation: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin on helper")?;
    let stdout = child.stdout.take().ok_or("no stdout on helper")?;
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!("speech-helper(handsfree): {line}");
            }
        });
    }
    let (pcm_tx, pcm_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);

    // Stream task: each completed sentence is inserted into the focused app and
    // recorded to history. Insertion is synchronous so sentences land in order;
    // the brief block only stalls reading the next (already-buffered) frame.
    let app_s = app.clone();
    let inner_s = state.dictation.inner.clone();
    let app_data = state.app_data_dir.clone();
    tokio::spawn(async move {
        // Last char of the previous insertion, for sentence joining below.
        let prev_end = std::sync::Mutex::new(None::<char>);
        let on_sentence = {
            let app = app_s.clone();
            let app_data = app_data.clone();
            move |sentence: &str| {
                let normalized = crate::titling::normalize_zh_en_spacing(sentence.trim());
                if normalized.is_empty() {
                    return;
                }
                let s = normalized.as_str();
                tracing::info!("doubao asr (hands-free) sentence: {:?}", preview(s));
                // Show the latest sentence in the HUD, then type/paste it into
                // wherever the user is focused. Joining rules for consecutive
                // sentences: ASCII-ending → trailing space (English prose);
                // CJK-ending → none (Chinese is never space-separated), but if
                // the NEXT sentence starts with ASCII we prepend the zh→en
                // boundary space ("…跑测试 Then deploy", not "…跑测试Then").
                let _ = app.emit("voice-partial", json_payload("global", "text", s));
                let mode = if mode_code == crate::quick::INSERT_PASTE {
                    crate::text_input::InsertMode::Paste
                } else {
                    crate::text_input::InsertMode::Type
                };
                let mut payload = String::new();
                {
                    let prev = prev_end.lock().map(|p| *p).unwrap_or(None);
                    let starts_ascii = s.chars().next().is_some_and(|c| c.is_ascii_alphanumeric());
                    if starts_ascii && prev.is_some_and(|c| !c.is_ascii()) {
                        payload.push(' ');
                    }
                }
                payload.push_str(s);
                let ends_ascii = s.chars().last().is_some_and(|c| c.is_ascii());
                if ends_ascii {
                    payload.push(' ');
                }
                if let Ok(mut p) = prev_end.lock() {
                    *p = payload.chars().last();
                }
                if let Err(e) = crate::text_input::insert_text(&payload, mode) {
                    tracing::warn!("hands-free insert failed: {e}");
                }
                let (rec_text, ad) = (s.to_string(), app_data.clone());
                tokio::task::spawn_blocking(move || {
                    crate::transcripts::record(&ad, &rec_text, "global");
                });
            }
        };
        if let Err(e) =
            crate::doubao::stream_hands_free(&key, &resource, corpus, pcm_rx, on_sentence).await
        {
            tracing::warn!("doubao hands-free stream failed: {e}");
            let _ = app_s.emit(
                "voice-error",
                json_payload("global", "message", "Doubao recognition failed"),
            );
        }
        // Session ended (toggled off / helper exited): clear the HUD transcript.
        let _ = app_s.emit("voice-final", json_payload("global", "text", ""));
        *inner_s.lock().await = None;
    });

    // Reader task: forward PCM, re-emit level/ready; `pcm_end`/EOF drops `pcm_tx`
    // so the Doubao session finalizes the trailing sentence and ends.
    let app_r = app.clone();
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if let Some(p) = v.get("pcm").and_then(|x| x.as_str()) {
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(p) {
                    if pcm_tx.send(bytes).await.is_err() {
                        break;
                    }
                }
            } else if let Some(l) = v.get("level").and_then(|x| x.as_f64()) {
                let _ = app_r.emit(
                    "voice-level",
                    serde_json::json!({ "target": "global", "level": l }),
                );
            } else if v.get("ready").is_some() {
                let _ = app_r.emit("voice-ready", serde_json::json!({ "target": "global" }));
            } else if v.get("pcm_end").is_some() {
                break;
            } else if let Some(e) = v.get("error").and_then(|x| x.as_str()) {
                let _ = app_r.emit("voice-error", json_payload("global", "message", e));
                break;
            }
        }
        // pcm_tx is dropped as this task ends → Doubao sees end-of-audio.
    });

    *guard = Some(Active {
        child,
        stdin,
        final_rx: None,
        last_partial: Arc::new(std::sync::Mutex::new(String::new())),
        group_leader,
    });
    Ok(())
}

/// Stop a hands-free session gracefully: newline → helper stdin makes it flush
/// the trailing audio and exit, so the last sentence still gets inserted. The
/// stream task clears the `Active` slot once the session winds down.
#[cfg(target_os = "macos")]
pub async fn stop_handsfree_internal(state: &AppState) {
    use tokio::io::AsyncWriteExt;
    let mut guard = state.dictation.inner.lock().await;
    if let Some(active) = guard.as_mut() {
        let _ = active.stdin.write_all(b"\n").await;
        let _ = active.stdin.flush().await;
    }
}

// Dictation lifecycle is driven entirely by the global push-to-talk path
// (see `hotkey.rs`), which calls `start_internal` / `stop_internal` /
// `cancel_internal` directly. The in-app mic surfaces were removed, so there
// are no longer any `start_dictation` / `stop_dictation` / `cancel_dictation`
// commands invoked from the frontend.

#[cfg(target_os = "macos")]
fn json_payload(target: &str, key: &str, value: &str) -> serde_json::Value {
    serde_json::json!({ "target": target, key: value })
}

/// Assemble the recognition biasing corpus for a dictation session. Empty (no
/// `corpus` on the wire, unchanged recognition) unless the user turned on context
/// biasing in settings.
#[cfg(target_os = "macos")]
pub(crate) fn build_corpus(state: &AppState) -> crate::doubao::Corpus {
    let settings = crate::quick::load_settings(&state.store);
    build_corpus_with(&state.app_data_dir, &settings)
}

/// [`build_corpus`] body, decoupled from `AppState` so the push-to-talk path can
/// run it on a blocking task concurrently with helper startup (the focused-field
/// AX read alone can cost hundreds of ms).
#[cfg(target_os = "macos")]
pub(crate) fn build_corpus_with(
    app_data_dir: &std::path::Path,
    settings: &crate::quick::QuickSettings,
) -> crate::doubao::Corpus {
    if !settings.voice_context_biasing {
        return crate::doubao::Corpus::default();
    }
    // Electron apps build their AX tree lazily — poke the frontmost app awake
    // before the focused-field read below. The tree materializes async, so this
    // read may still miss on the app's first dictation; the finish-time corpus
    // and the correction watcher's +1.2s/+10s re-reads land after it's up.
    crate::ax::wake_frontmost_app();
    let mut corpus = crate::biasing::build(app_data_dir, &settings.voice_hotwords);
    // Dialog continuity: feed the previous dictation (when history is on) as a
    // `dialog_ctx` entry, so a sentence picked up where the last one left off
    // recognizes consistently. One entry — more dilutes the live focused context.
    // Tail-capped: a long prior dictation would swamp the small inline corpus
    // budget (hotwords + focused-field context share it).
    if let Some(prev) = crate::transcripts::recent(app_data_dir, 1).pop() {
        let tail: Vec<char> = prev.trim().chars().rev().take(200).collect();
        let tail: String = tail.into_iter().rev().collect();
        if !tail.is_empty() {
            corpus.recent = Some(tail);
        }
    }
    if let Some(r) = &corpus.recent {
        tracing::debug!(
            "biasing: dialog continuity (previous dictation, {} chars): {:?}",
            r.chars().count(),
            preview(r)
        );
    }
    if let Some(t) = &corpus.boosting_table_id {
        tracing::debug!("biasing: server hotword table: {t}");
    }
    corpus
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn build_corpus(_state: &AppState) -> crate::doubao::Corpus {
    crate::doubao::Corpus::default()
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn build_corpus_with(
    _app_data_dir: &std::path::Path,
    _settings: &crate::quick::QuickSettings,
) -> crate::doubao::Corpus {
    crate::doubao::Corpus::default()
}

/// Single-line, length-capped rendering of a transcript for logs — keeps debug
/// output readable (and one line) no matter how long the dictation ran.
#[cfg(target_os = "macos")]
pub(crate) fn preview(s: &str) -> String {
    let one_line = s.trim().replace('\n', " ⏎ ");
    let capped: String = one_line.chars().take(160).collect();
    if one_line.chars().count() > 160 {
        format!("{capped}…")
    } else {
        capped
    }
}

// ---- Global dictation HUD -------------------------------------------------

/// Float the dictation HUD over the current Space without stealing key focus
/// from the app the user is dictating into. macOS only.
#[cfg(target_os = "macos")]
pub fn show_hud(app: &AppHandle) {
    // Stamp before ANY event/sound/window work. Some of those operations can make
    // macOS briefly mark cetus active; the activation observer must see this as a
    // voice-HUD open and leave the parked/hidden main window alone.
    app.state::<AppState>()
        .quick
        .last_open_ms
        .store(crate::store::now_ms(), std::sync::atomic::Ordering::Relaxed);
    // The HUD webview persists hidden between sessions, so the previous
    // dictation's transcript/spinner state would flash on re-show — reset it
    // before the window appears.
    let _ = app.emit("voice-reset", serde_json::json!({ "target": "global" }));
    if app
        .state::<AppState>()
        .quick
        .voice_start_sound
        .load(std::sync::atomic::Ordering::Relaxed)
    {
        play_start_chime();
    }
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let Some(win) = app.get_webview_window("voice") else {
            tracing::warn!("show_hud: no 'voice' webview window — HUD cannot show");
            return;
        };
        // Deliberately DON'T call Tauri's `show()`: on macOS it maps to
        // `makeKeyAndOrderFront:`, which *activates* cetus — even for this
        // non-activating panel — un-hiding the app and yanking its main window
        // to the foreground every time push-to-talk fires. `present_inactive`
        // orders the HUD up over the current Space without activating the app,
        // so focus stays in whatever the user is dictating into. Same reasoning
        // as the launcher panel (see `quick::open_panel`).
        if let Ok(ptr) = win.ns_window() {
            crate::panel::bottom_center_on_mouse_screen(ptr);
            crate::panel::present_inactive(ptr);
            tracing::debug!(
                "show_hud: voice HUD presented inactive (visible={:?})",
                win.is_visible()
            );
        } else {
            tracing::warn!("show_hud: voice window has no ns_window — HUD cannot show");
        }
    });
}

/// A soft "bubble" pop the moment the capsule appears, so the start of dictation
/// has an audible cue. macOS system sound at low volume, on a detached thread so
/// it never delays showing the HUD. Best-effort — silently does nothing if the
/// sound is missing or `afplay` fails. The webview itself can't reliably play
/// audio (it's a non-activating panel that never gets a user gesture), so this
/// is done natively.
#[cfg(target_os = "macos")]
fn play_start_chime() {
    std::thread::spawn(|| {
        let _ = std::process::Command::new("/usr/bin/afplay")
            .args(["-v", "0.35", "/System/Library/Sounds/Pop.aiff"])
            .status();
    });
}

#[cfg(target_os = "macos")]
pub fn hide_hud(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("voice") {
        let _ = win.hide();
    }
}

/// Flip the HUD from its live waveform to a spinner while post-release processing
/// (the cloud transcript finalizing + the AI cleanup pass) is in flight, so the
/// user can see it's still working between release and insertion. The HUD is
/// already on screen from session start; this only changes its state.
#[cfg(target_os = "macos")]
pub fn show_transcribing(app: &AppHandle) {
    let _ = app.emit(
        "voice-transcribing",
        serde_json::json!({ "target": "global" }),
    );
}

// ---- Text injection (global dictation) ------------------------------------

/// Type `text` into whatever app currently has focus. `mode` is "type" (Unicode
/// key synthesis, default) or "paste" (clipboard + ⌘V). macOS only.
#[tauri::command]
pub async fn insert_text(text: String, mode: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mode = crate::text_input::InsertMode::from_str(mode.as_deref().unwrap_or("type"));
        crate::text_input::insert_text(&text, mode)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (text, mode);
        Err("text insertion is only available on macOS".into())
    }
}
