//! Rewind-like screen-context collection.
//!
//! A background tokio task periodically grabs a frame of the primary monitor,
//! drops near-identical frames (perceptual hash), writes the pixels as a JPEG
//! on disk, indexes a row in SQLite, and (on macOS) OCRs the frame on-device
//! via Apple Vision so the agent can later recall what was on screen.
//!
//! Capture and the heavy work (encode + OCR) run inside `spawn_blocking` so the
//! async runtime is never blocked. Everything is gated behind a user toggle and
//! is off by default — screen content is sensitive.

use crate::ocr::{self, AppInfo};
use crate::store::{now_ms, Screenshot, Store};
use chrono::{Local, TimeZone};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// app_settings key holding the JSON-serialized [`CaptureSettings`].
const SETTINGS_KEY: &str = "screen_capture";
/// Frames whose perceptual hash is within this Hamming distance of the last
/// stored frame are treated as duplicates and dropped.
const DEDUPE_HAMMING: u32 = 6;
/// Longest edge (px) of stored JPEGs — downscaled to bound disk use.
const MAX_EDGE: u32 = 1600;
// Long-edge of the thumbnail written next to each full frame. The history grid
// and palette previews render tiles ~56–220px wide, so decoding the 1600px full
// frame into them is the dominant scroll/fan-spin cost — the thumb fixes it.
const THUMB_EDGE: u32 = 400;
/// Poll cadence while capture is disabled, so toggling it on takes effect fast.
const DISABLED_POLL_SECS: u64 = 3;
/// How often to run retention pruning.
const PRUNE_INTERVAL_SECS: u64 = 3600;
/// Per-entry OCR text cap in the recall log (chars).
const RECALL_TEXT_CAP: usize = 1500;
/// Rewrite the recall log down to this many lines once it grows past the cap.
const RECALL_MAX_BYTES: u64 = 2_000_000;
const RECALL_KEEP_LINES: usize = 1500;

/// User-configurable collection settings. Persisted as JSON in app_settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSettings {
    /// Master switch. Off by default — never capture without explicit opt-in.
    #[serde(default)]
    pub enabled: bool,
    /// Seconds between capture attempts (clamped to >= 2 at runtime).
    #[serde(default = "default_interval")]
    pub interval_seconds: u64,
    /// App names / bundle ids to skip (case-insensitive substring match).
    #[serde(default)]
    pub excluded_apps: Vec<String>,
    /// Delete frames older than this many days (0 = keep forever).
    #[serde(default = "default_retention")]
    pub retention_days: u32,
    /// Run on-device OCR (Apple Vision) on each kept frame.
    #[serde(default = "default_true")]
    pub ocr_enabled: bool,
}

fn default_interval() -> u64 {
    30
}
fn default_retention() -> u32 {
    7
}
fn default_true() -> bool {
    true
}

impl Default for CaptureSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_seconds: 30,
            excluded_apps: Vec::new(),
            retention_days: default_retention(),
            ocr_enabled: true,
        }
    }
}

pub fn load_settings(store: &Store) -> CaptureSettings {
    match store.get_setting(SETTINGS_KEY) {
        Ok(Some(json)) => serde_json::from_str(&json).unwrap_or_default(),
        _ => CaptureSettings::default(),
    }
}

pub fn save_settings(store: &Store, settings: &CaptureSettings) -> anyhow::Result<()> {
    let json = serde_json::to_string(settings)?;
    store.set_setting(SETTINGS_KEY, &json)?;
    Ok(())
}

/// Path of the rolling recall log read by the `screen-recall` pi extension.
/// Kept in one place so `lib.rs` (which exports it via `CETUS_SCREEN_LOG`) and
/// the writer here never diverge.
pub fn recall_log_path(app_data: &Path) -> PathBuf {
    app_data.join("screen-context").join("recall.jsonl")
}

/// Start the background capture loop. Cheap when disabled (just polls the
/// toggle every few seconds).
pub fn spawn(store: Arc<Store>, app_data: PathBuf) {
    tauri::async_runtime::spawn(async move {
        let screenshots_dir = app_data.join("screenshots");
        let recall = recall_log_path(&app_data);
        let mut last_hash: Option<u64> = None;
        let mut last_prune = Instant::now();

        loop {
            let settings = load_settings(&store);
            if !settings.enabled {
                tokio::time::sleep(Duration::from_secs(DISABLED_POLL_SECS)).await;
                continue;
            }

            if last_prune.elapsed().as_secs() >= PRUNE_INTERVAL_SECS {
                let store2 = store.clone();
                let retention = settings.retention_days;
                let _ = tokio::task::spawn_blocking(move || prune(&store2, retention)).await;
                last_prune = Instant::now();
            }

            let store2 = store.clone();
            let app_data2 = app_data.clone();
            let dir2 = screenshots_dir.clone();
            let recall2 = recall.clone();
            let settings2 = settings.clone();
            let prev = last_hash;
            let outcome = tokio::task::spawn_blocking(move || {
                capture_once(&store2, &app_data2, &dir2, &recall2, &settings2, prev)
            })
            .await;
            if let Ok(Some(h)) = outcome {
                last_hash = Some(h);
            }

            let interval = settings.interval_seconds.max(2);
            tokio::time::sleep(Duration::from_secs(interval)).await;
        }
    });
}

/// Capture, dedup, store, and OCR a single frame. Returns the new baseline hash
/// when a frame was stored (so the caller updates its dedup reference), or
/// `None` when the tick was skipped (disabled-app, duplicate, or error).
fn capture_once(
    store: &Store,
    app_data: &Path,
    dir: &Path,
    recall: &Path,
    settings: &CaptureSettings,
    prev_hash: Option<u64>,
) -> Option<u64> {
    // Exclusion is enforced *before* capture so excluded windows never touch
    // disk (cheaper and safer than capture-then-delete).
    let app = ocr::frontmost_app(app_data);
    if let Some(a) = &app {
        if is_excluded(&settings.excluded_apps, a) {
            return None;
        }
    }

    let img = capture_primary()?;
    // Dedupe BEFORE the expensive work: dhash's Nearest pre-shrink makes hashing
    // the full-resolution frame near-free, so a duplicate tick (idle screen — the
    // common case) costs only the grab + hash. The stored-resolution downscale,
    // JPEG encodes, and OCR below run only for frames that actually changed.
    let hash = dhash(&img);
    if let Some(p) = prev_hash {
        if hamming(p, hash) <= DEDUPE_HAMMING {
            return None;
        }
    }
    let resized = downscale(&img, MAX_EDGE);
    drop(img); // free the full-resolution buffer before encoding work

    // Re-sample the frontmost app now that we hold a frame about to be persisted.
    // The pre-capture check above avoids the grab in the common case, but if the
    // user switched INTO an excluded app (password manager, banking…) in the
    // window between that check and the framebuffer grab, drop the in-memory
    // frame before it ever touches disk — the subsystem's core privacy promise.
    // The fresh sample also gives more accurate attribution than the stale one.
    let app = ocr::frontmost_app(app_data);
    if let Some(a) = &app {
        if is_excluded(&settings.excluded_apps, a) {
            return None; // nothing persisted; leave prev_hash unchanged
        }
    }

    let ts = now_ms();
    let (path, thumb_path, bytes) = match save_jpeg(resized, dir, ts) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("screen capture: save failed: {e}");
            return None;
        }
    };

    let app_name = app
        .as_ref()
        .map(|a| a.app.clone())
        .filter(|s| !s.is_empty());
    let shot = Screenshot {
        id: uuid::Uuid::new_v4().to_string(),
        ts,
        app_name: app_name.clone(),
        window_title: None,
        file_path: path.to_string_lossy().into_owned(),
        thumb_path: thumb_path.map(|p| p.to_string_lossy().into_owned()),
        phash: Some(hash as i64),
        bytes: bytes as i64,
        ocr_text: None,
    };
    if let Err(e) = store.insert_screenshot(&shot) {
        tracing::warn!("screen capture: db insert failed: {e}");
        // Frame is on disk and the hash advanced; keep going.
        return Some(hash);
    }

    let mut text = String::new();
    if settings.ocr_enabled {
        if let Some(t) = ocr::recognize(app_data, &path) {
            text = t;
            if !text.is_empty() {
                let _ = store.set_screenshot_ocr(&shot.id, &text);
            }
        }
    }

    append_recall(recall, ts, app_name.as_deref(), &text);
    Some(hash)
}

/// One-shot capture + OCR of the primary monitor, independent of the rolling
/// capture loop (works even while periodic capture is off). Used as a dictation
/// context fallback when the focused field can't be read over AX (Electron and
/// canvas-drawn UIs). Nothing is persisted: the frame lives in a temp file only
/// long enough for the Vision helper to read it. Caller gates this on the
/// voice screen-reading opt-in. Blocking (capture + OCR each cost hundreds of
/// ms) — run inside `spawn_blocking`.
pub fn ocr_screen_now(app_data: &Path) -> Option<String> {
    let img = capture_primary()?;
    let rgb = image::DynamicImage::ImageRgba8(downscale(&img, MAX_EDGE)).to_rgb8();
    let path = std::env::temp_dir().join(format!("cetus-voice-ctx-{}.jpg", std::process::id()));
    if let Err(e) = rgb.save(&path) {
        tracing::debug!("voice context OCR: temp frame save failed: {e}");
        return None;
    }
    let text = ocr::recognize(app_data, &path);
    let _ = std::fs::remove_file(&path);
    text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

/// Capture the primary display via native macOS tools and return a bounded JPEG
/// for the quick launcher's first-paint path. `screencapture` grabs the frame in
/// ~100ms on current macOS; `sips -Z` keeps the resize/JPEG work in Apple's
/// optimized image stack. Avoid doing this resize through the Rust `image` crate
/// in debug builds: that pure-Rust path takes multiple seconds on large Retina
/// frames, which makes the screenshot launcher feel stuck.
#[cfg(target_os = "macos")]
pub fn capture_primary_jpeg_native(max_edge: u32) -> Option<Vec<u8>> {
    let started = Instant::now();
    let path = std::env::temp_dir().join(format!(
        "cetus-launch-shot-{}-{}.jpg",
        std::process::id(),
        now_ms()
    ));
    let grab_started = Instant::now();
    let ok = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-x", "-t", "jpg"])
        .arg(&path)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    let grab_ms = grab_started.elapsed().as_millis();
    if !ok {
        let _ = std::fs::remove_file(&path);
        tracing::info!("capture_primary_jpeg_native: screencapture failed after {grab_ms}ms");
        return None;
    }
    let resize_started = Instant::now();
    let resized = std::process::Command::new("/usr/bin/sips")
        .args(["-Z", &max_edge.to_string()])
        .arg(&path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let resize_ms = resize_started.elapsed().as_millis();
    if !resized {
        tracing::debug!("capture_primary_jpeg_native: sips resize failed; using original frame");
    }
    let read_started = Instant::now();
    let bytes = std::fs::read(&path).ok();
    let read_ms = read_started.elapsed().as_millis();
    let _ = std::fs::remove_file(&path);
    let bytes = bytes?;
    if bytes.is_empty() {
        return None;
    }
    tracing::debug!(
        "capture_primary_jpeg_native: grab={grab_ms}ms resize={resize_ms}ms read={read_ms}ms total={}ms bytes={}",
        started.elapsed().as_millis(),
        bytes.len()
    );
    Some(bytes)
}

/// Capture the primary monitor as an RGBA image. We lift the raw bytes out of
/// xcap's buffer and rebuild with our own `image` crate so a version skew
/// between the two never breaks compilation.
fn capture_primary() -> Option<image::RgbaImage> {
    let monitors = xcap::Monitor::all().ok()?;
    let monitor = monitors.into_iter().next()?;
    let frame = monitor.capture_image().ok()?;
    let (w, h) = (frame.width(), frame.height());
    let raw = frame.into_raw();
    image::RgbaImage::from_raw(w, h, raw)
}

fn is_excluded(patterns: &[String], app: &AppInfo) -> bool {
    let name = app.app.to_lowercase();
    let bundle = app.bundle_id.to_lowercase();
    patterns.iter().any(|p| {
        let p = p.trim().to_lowercase();
        !p.is_empty() && (name.contains(&p) || bundle.contains(&p))
    })
}

// ---- perceptual hash (dHash) ----------------------------------------------

fn lum(p: &image::Rgba<u8>) -> u32 {
    let [r, g, b, _] = p.0;
    (r as u32 * 299 + g as u32 * 587 + b as u32 * 114) / 1000
}

/// 64-bit difference hash: downscale to 9x8 grayscale, then one bit per
/// horizontal neighbour comparison.
///
/// Runs on the full-resolution capture on *every* tick — including dropped
/// duplicates — so it must stay cheap. A Triangle filter straight to 9x8 reads
/// every source pixel (~8M on Retina); the Nearest pre-shrink instead samples a
/// fixed grid, bounding the cost regardless of capture resolution. Nearest is
/// deterministic, so an unchanged screen still hashes identically (hamming 0).
fn dhash(img: &image::RgbaImage) -> u64 {
    const PRE_W: u32 = 72;
    const PRE_H: u32 = 64;
    let small = if img.width() > PRE_W && img.height() > PRE_H {
        let pre = image::imageops::resize(img, PRE_W, PRE_H, image::imageops::FilterType::Nearest);
        image::imageops::resize(&pre, 9, 8, image::imageops::FilterType::Triangle)
    } else {
        image::imageops::resize(img, 9, 8, image::imageops::FilterType::Triangle)
    };
    let mut hash: u64 = 0;
    let mut bit = 0u32;
    for y in 0..8u32 {
        for x in 0..8u32 {
            if lum(small.get_pixel(x, y)) > lum(small.get_pixel(x + 1, y)) {
                hash |= 1u64 << bit;
            }
            bit += 1;
        }
    }
    hash
}

fn hamming(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

// ---- storage ---------------------------------------------------------------

/// Save the captured frame as a full JPEG plus a small thumbnail beside it
/// (`<time>.thumb.jpg`). Returns (full_path, thumb_path, full_bytes). The thumb
/// is best-effort: if it fails we still keep the frame and return None for it,
/// and the client falls back to the full image. `resized` is already downscaled
/// to `MAX_EDGE` by the caller (the thumbnail is derived from it, not from the
/// full-resolution frame).
fn save_jpeg(
    resized: image::RgbaImage,
    dir: &Path,
    ts: i64,
) -> anyhow::Result<(PathBuf, Option<PathBuf>, u64)> {
    let dt = Local
        .timestamp_millis_opt(ts)
        .single()
        .ok_or_else(|| anyhow::anyhow!("bad timestamp {ts}"))?;
    let day_dir = dir.join(dt.format("%Y-%m-%d").to_string());
    std::fs::create_dir_all(&day_dir)?;
    let stem = dt.format("%H-%M-%S-%3f").to_string();
    let path = day_dir.join(format!("{stem}.jpg"));

    // Thumbnail variant for the history grid + palette previews — derived from
    // the already-shrunk frame (400px from 1600px is cheap), not the original.
    let thumb_target = day_dir.join(format!("{stem}.thumb.jpg"));
    let thumb_rgb = image::DynamicImage::ImageRgba8(downscale(&resized, THUMB_EDGE)).to_rgb8();

    // JPEG has no alpha channel — flatten to RGB before encoding. Consumes
    // `resized` last so the thumbnail can borrow it above.
    let rgb = image::DynamicImage::ImageRgba8(resized).to_rgb8();
    rgb.save(&path)?;

    let thumb_path = match thumb_rgb.save(&thumb_target) {
        Ok(()) => Some(thumb_target),
        Err(e) => {
            tracing::warn!("screen capture: thumb save failed: {e}");
            None
        }
    };

    let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok((path, thumb_path, bytes))
}

fn downscale(img: &image::RgbaImage, max_edge: u32) -> image::RgbaImage {
    let (w, h) = (img.width(), img.height());
    let longest = w.max(h);
    if longest <= max_edge || longest == 0 {
        return img.clone();
    }
    let scale = max_edge as f32 / longest as f32;
    let nw = ((w as f32 * scale).round() as u32).max(1);
    let nh = ((h as f32 * scale).round() as u32).max(1);
    image::imageops::resize(img, nw, nh, image::imageops::FilterType::Triangle)
}

// ---- recall log (agent-facing) --------------------------------------------

/// Append one entry the `screen-recall` pi extension can read. Self-trims when
/// the file grows past the byte cap.
fn append_recall(path: &Path, ts: i64, app: Option<&str>, text: &str) {
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
    let line = serde_json::json!({
        "ts": ts,
        "iso": iso,
        "app": app.unwrap_or(""),
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

// ---- retention -------------------------------------------------------------

fn prune(store: &Store, retention_days: u32) {
    if retention_days == 0 {
        return; // keep forever
    }
    let before = now_ms() - (retention_days as i64) * 86_400 * 1000;
    match store.prune_screenshots(before) {
        Ok(paths) => {
            let n = paths.len();
            for p in paths {
                let _ = std::fs::remove_file(&p);
            }
            if n > 0 {
                tracing::info!("screen capture: pruned {n} frames older than {retention_days}d");
            }
        }
        Err(e) => tracing::warn!("screen capture: prune failed: {e}"),
    }
}
