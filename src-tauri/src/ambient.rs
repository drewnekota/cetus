//! Littlebird-like resident ambient context: a background task that keeps a
//! rolling, text-only memory of what the user is looking at.
//!
//! The collector reads the frontmost app's *structured* text over the
//! accessibility API — window title, visible text, browser URL. No pixels, no
//! keystrokes, nothing from secure text fields. It is the text-mode sibling of
//! the screenshot pipeline in `capture.rs` and follows the same product
//! contract: off by default, per-app exclusion enforced before anything is
//! read, retention pruning, and a delete-everything switch.
//!
//! Cost model (the reason this can run all day where OCR capture can't): every
//! AX attribute read is a synchronous IPC round-trip into the target app, so
//! the loop is tiered —
//!   * every tick (~2s): a cheap probe — frontmost identity via NSWorkspace
//!     (no IPC into the app) plus the focused window's title (2 AX reads).
//!   * only when the probe sees a change (app switch / window or tab title
//!     change), or a slow refresh (30s) falls due in the same app: the bounded
//!     visible-text walk (`ax::visible_text`, node/depth/char/wall-clock caps).
//!   * only on a change tick in a known browser: the AppleScript URL fetch
//!     (2s-bounded) — never on the steady-state path.
//! A content hash then drops unchanged snapshots, so an idle screen writes
//! nothing: the steady-state cost is the title probe, and the disk only sees
//! actual activity.

use crate::store::{now_ms, AxContextEntry, Store};
use chrono::TimeZone;
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// app_settings key holding the JSON-serialized [`AmbientSettings`].
const SETTINGS_KEY: &str = "ambient_context";
/// Poll cadence while the collector is disabled, so toggling it on bites fast.
const DISABLED_POLL_SECS: u64 = 3;
/// Cap on the visible-text walk per snapshot (chars).
const MAX_TEXT_CHARS: usize = 4000;
/// Re-walk the same window's text at most this often when nothing visibly
/// changed (title-stable scrolling/typing still updates content).
const SLOW_REFRESH_SECS: u64 = 30;
/// How often to run retention pruning.
const PRUNE_INTERVAL_SECS: u64 = 3600;

/// User-configurable collector settings. Persisted as JSON in app_settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmbientSettings {
    /// Master switch. Off by default — never observe without explicit opt-in.
    #[serde(default)]
    pub enabled: bool,
    /// Seconds between cheap probes (clamped to >= 1 at runtime).
    #[serde(default = "default_interval")]
    pub interval_seconds: u64,
    /// App names / bundle ids to skip (case-insensitive substring match) —
    /// password managers, banking apps, and the like.
    #[serde(default)]
    pub excluded_apps: Vec<String>,
    /// Delete entries older than this many days (0 = keep forever).
    #[serde(default = "default_retention")]
    pub retention_days: u32,
}

fn default_interval() -> u64 {
    2
}
fn default_retention() -> u32 {
    3
}

impl Default for AmbientSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_seconds: default_interval(),
            excluded_apps: Vec::new(),
            retention_days: default_retention(),
        }
    }
}

pub fn load_settings(store: &Store) -> AmbientSettings {
    match store.get_setting(SETTINGS_KEY) {
        Ok(Some(json)) => serde_json::from_str(&json).unwrap_or_default(),
        _ => AmbientSettings::default(),
    }
}

pub fn save_settings(store: &Store, settings: &AmbientSettings) -> anyhow::Result<()> {
    let json = serde_json::to_string(settings)?;
    store.set_setting(SETTINGS_KEY, &json)?;
    Ok(())
}

/// What one collector tick observed. Everything runs inside `spawn_blocking`
/// (AX and AppleScript calls block); this is the result lifted back out.
struct Observation {
    app: String,
    bundle: String,
    title: String,
    /// None = the walk was skipped this tick (no change, refresh not due).
    text: Option<String>,
    url: String,
    page_title: String,
}

/// Mutable loop state threaded between ticks.
#[derive(Default)]
struct TickState {
    last_bundle: String,
    last_title: String,
    last_hash: Option<u64>,
    /// Cached browser tab (url, title) so steady-state ticks never re-script.
    last_url: String,
    last_page_title: String,
}

/// Start the background collector. Cheap when disabled (polls the toggle every
/// few seconds); `own_bundle_id` keeps cetus from observing itself.
pub fn spawn(store: Arc<Store>, own_bundle_id: String) {
    tauri::async_runtime::spawn(async move {
        let mut state = TickState::default();
        let mut last_full_read: Option<Instant> = None;
        let mut last_prune = Instant::now();

        loop {
            let settings = load_settings(&store);
            if !settings.enabled {
                // Drop stale change-tracking so re-enabling starts fresh.
                state = TickState::default();
                last_full_read = None;
                tokio::time::sleep(Duration::from_secs(DISABLED_POLL_SECS)).await;
                continue;
            }

            if last_prune.elapsed().as_secs() >= PRUNE_INTERVAL_SECS {
                let store2 = store.clone();
                let retention = settings.retention_days;
                let _ = tokio::task::spawn_blocking(move || prune(&store2, retention)).await;
                last_prune = Instant::now();
            }

            let excluded = settings.excluded_apps.clone();
            let own_bundle = own_bundle_id.clone();
            let prev_bundle = state.last_bundle.clone();
            let prev_title = state.last_title.clone();
            let refresh_due = last_full_read
                .map(|t| t.elapsed().as_secs() >= SLOW_REFRESH_SECS)
                .unwrap_or(true);

            let observed = tokio::task::spawn_blocking(move || {
                observe_once(
                    &excluded,
                    &own_bundle,
                    &prev_bundle,
                    &prev_title,
                    refresh_due,
                )
            })
            .await
            .ok()
            .flatten();

            if let Some(obs) = observed {
                let changed_window = obs.bundle != state.last_bundle || obs.title != state.last_title;
                state.last_bundle = obs.bundle.clone();
                state.last_title = obs.title.clone();
                if changed_window {
                    // Fresh window/tab: yesterday's cached tab URL no longer
                    // applies unless this observation re-fetched one.
                    state.last_url.clear();
                    state.last_page_title.clear();
                }
                if !obs.url.is_empty() {
                    state.last_url = obs.url.clone();
                    state.last_page_title = obs.page_title.clone();
                }

                if let Some(text) = obs.text {
                    last_full_read = Some(Instant::now());
                    let url = if obs.url.is_empty() {
                        state.last_url.clone()
                    } else {
                        obs.url.clone()
                    };
                    let page_title = if obs.page_title.is_empty() {
                        state.last_page_title.clone()
                    } else {
                        obs.page_title.clone()
                    };
                    let mut h = DefaultHasher::new();
                    (&obs.bundle, &obs.title, &url, &text).hash(&mut h);
                    let hash = h.finish();
                    if state.last_hash != Some(hash) {
                        state.last_hash = Some(hash);
                        let entry = AxContextEntry {
                            id: uuid::Uuid::new_v4().to_string(),
                            ts: now_ms(),
                            app_name: Some(obs.app).filter(|s| !s.is_empty()),
                            bundle_id: Some(obs.bundle).filter(|s| !s.is_empty()),
                            window_title: Some(obs.title).filter(|s| !s.is_empty()),
                            url: Some(url).filter(|s| !s.is_empty()),
                            page_title: Some(page_title).filter(|s| !s.is_empty()),
                            text,
                            text_hash: Some(hash as i64),
                        };
                        if let Err(e) = store.insert_ax_context(&entry) {
                            tracing::warn!("ambient context: db insert failed: {e}");
                        }
                    }
                }
            }

            let interval = settings.interval_seconds.max(1);
            tokio::time::sleep(Duration::from_secs(interval)).await;
        }
    });
}

/// One blocking tick. Returns None when there is nothing to record (excluded
/// app, cetus itself, no frontmost app). `text` inside is None when the
/// expensive walk was skipped.
fn observe_once(
    excluded: &[String],
    own_bundle: &str,
    prev_bundle: &str,
    prev_title: &str,
    refresh_due: bool,
) -> Option<Observation> {
    let (app, bundle, pid) = crate::ax::frontmost_identity()?;
    // Never observe cetus itself — the panel/main window would otherwise
    // dominate the memory with its own chat text.
    if !own_bundle.is_empty() && bundle == own_bundle {
        return None;
    }
    // Exclusion runs before ANY read into the app, same promise as capture.rs.
    if is_excluded(excluded, &app, &bundle) {
        return None;
    }

    let title = crate::ax::focused_window_title(pid).unwrap_or_default();
    let changed = bundle != prev_bundle || title != prev_title;
    if !changed && !refresh_due {
        // Steady state: the ~2s tick cost stops here (identity + title reads).
        return Some(Observation {
            app,
            bundle,
            title,
            text: None,
            url: String::new(),
            page_title: String::new(),
        });
    }

    // Change (or slow refresh) tick: do the bounded walk. Electron trees sleep
    // until poked; the wake is debounced per-pid so this is a no-op repeat.
    crate::ax::wake_frontmost_app();
    let text = crate::ax::visible_text(pid, MAX_TEXT_CHARS).unwrap_or_default();

    // Browser URL only on a *change* tick — an AppleScript round-trip per tab
    // switch is fine, one per slow refresh of an idle page is not needed (the
    // cached URL in TickState covers it).
    let (url, page_title) = if changed {
        crate::ax::fetch_browser_url(&bundle).unwrap_or_default()
    } else {
        (String::new(), String::new())
    };

    Some(Observation {
        app,
        bundle,
        title,
        text: Some(text),
        url,
        page_title,
    })
}

fn is_excluded(patterns: &[String], app: &str, bundle: &str) -> bool {
    let name = app.to_lowercase();
    let bundle = bundle.to_lowercase();
    patterns.iter().any(|p| {
        let p = p.trim().to_lowercase();
        !p.is_empty() && (name.contains(&p) || bundle.contains(&p))
    })
}

fn prune(store: &Store, retention_days: u32) {
    if retention_days == 0 {
        return; // keep forever
    }
    let before = now_ms() - (retention_days as i64) * 86_400 * 1000;
    match store.prune_ax_context(before) {
        Ok(n) if n > 0 => {
            tracing::info!("ambient context: pruned {n} entries older than {retention_days}d");
        }
        Ok(_) => {}
        Err(e) => tracing::warn!("ambient context: prune failed: {e}"),
    }
}

// ---- recent-activity summary (chat injection) -------------------------------

/// How far back the injected summary looks.
const SUMMARY_WINDOW_MINUTES: i64 = 5;
/// Row budget pulled from the DB for one summary.
const SUMMARY_MAX_ENTRIES: u32 = 40;
/// Char budget of the whole summary (the fence must not eat the prompt).
const SUMMARY_MAX_CHARS: usize = 1600;
/// Char budget of the current (latest) entry's text excerpt.
const SUMMARY_LATEST_TEXT_CHARS: usize = 900;

/// Compress the rolling memory into the compact block the chat composer
/// injects: a chronological activity trail (consecutive same-window entries
/// merged) plus a text excerpt of what is on screen now. None when the
/// collector is off or the window is empty.
pub fn recent_summary(store: &Store) -> Option<String> {
    if !load_settings(store).enabled {
        return None;
    }
    let since = now_ms() - SUMMARY_WINDOW_MINUTES * 60_000;
    let entries = store.ax_context_since(since, SUMMARY_MAX_ENTRIES).ok()?;
    if entries.is_empty() {
        return None;
    }

    // Merge consecutive entries of the same window/tab, keeping the newest.
    let mut merged: Vec<&AxContextEntry> = Vec::new();
    for e in &entries {
        let same = merged.last().is_some_and(|m| {
            m.bundle_id == e.bundle_id && m.window_title == e.window_title && m.url == e.url
        });
        if same {
            *merged.last_mut().unwrap() = e;
        } else {
            merged.push(e);
        }
    }

    let mut lines: Vec<String> = Vec::new();
    lines.push(format!(
        "Recent activity (last {SUMMARY_WINDOW_MINUTES} min, newest last):"
    ));
    for e in &merged {
        let t = chrono::Local
            .timestamp_millis_opt(e.ts)
            .single()
            .map(|dt| dt.format("%H:%M").to_string())
            .unwrap_or_default();
        let mut line = format!("- {t} {}", e.app_name.as_deref().unwrap_or("?"));
        if let Some(title) = e
            .page_title
            .as_deref()
            .filter(|s| !s.is_empty())
            .or(e.window_title.as_deref())
        {
            line.push_str(&format!(" — {title}"));
        }
        if let Some(url) = e.url.as_deref().filter(|s| !s.is_empty()) {
            line.push_str(&format!(" ({url})"));
        }
        lines.push(line);
    }

    if let Some(latest) = merged.last() {
        if !latest.text.is_empty() {
            let excerpt: String = latest.text.chars().take(SUMMARY_LATEST_TEXT_CHARS).collect();
            lines.push("Currently on screen:".to_string());
            lines.push(excerpt.trim().to_string());
        }
    }

    let mut out = lines.join("\n");
    if out.chars().count() > SUMMARY_MAX_CHARS {
        out = out.chars().take(SUMMARY_MAX_CHARS).collect();
    }
    Some(out)
}
