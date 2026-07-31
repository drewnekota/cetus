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
const MAX_TEXT_CHARS: usize = 8000;
/// Re-walk the same window's text at most this often when nothing visibly
/// changed (title-stable scrolling/typing still updates content).
const SLOW_REFRESH_SECS: u64 = 30;
/// Skip the walk entirely when the user hasn't touched keyboard/mouse for this
/// long — the frontmost window is still there, but nobody is looking at it,
/// and background title churn (unread counters, players) is not activity.
const IDLE_SKIP_SECS: f64 = 120.0;
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

            // Retention pruning runs whether or not collection is on — turning
            // the collector off must not turn the retention promise off with it.
            if last_prune.elapsed().as_secs() >= PRUNE_INTERVAL_SECS {
                let store2 = store.clone();
                let retention = settings.retention_days;
                let _ = tokio::task::spawn_blocking(move || prune(&store2, retention)).await;
                last_prune = Instant::now();
            }

            if !settings.enabled {
                // Drop stale change-tracking so re-enabling starts fresh.
                state = TickState::default();
                last_full_read = None;
                tokio::time::sleep(Duration::from_secs(DISABLED_POLL_SECS)).await;
                continue;
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
                let changed_window =
                    obs.bundle != state.last_bundle || obs.title != state.last_title;
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
    // Idle gate: no keyboard/mouse for a while means nobody is reading this
    // screen — skip the walk even on "changes" (background title churn:
    // unread counters, players, live dashboards).
    let idle = crate::ax::seconds_since_last_input() >= IDLE_SKIP_SECS;
    if (!changed && !refresh_due) || idle {
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
            let excerpt: String = latest
                .text
                .chars()
                .take(SUMMARY_LATEST_TEXT_CHARS)
                .collect();
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

// ---- agentic retrieval (control socket → `cetus context` CLI) ---------------
//
// The reader of this stream is an agent (claude-code / codex / pi), not a
// human, so everything below is shaped for token cost: server-side duration
// math (the model must never sum minutes itself), match-centered snippets
// instead of bodies, and a hard segment cap that bounces the caller back with
// "narrow the range" instead of silently truncating.

/// Safety valve on the timeline range scan (rows, not bytes — meta only).
const RANGE_SCAN_LIMIT: u32 = 50_000;
/// Above this many window segments the listing is withheld (rollup still
/// returned) and the caller is told to narrow the range.
const TIMELINE_MAX_SEGMENTS: usize = 200;
/// A silence longer than this between observations is reported as time away.
const TIMELINE_GAP_MS: i64 = 10 * 60_000;
/// Foreground grace credited after the last observation of a segment that ends
/// in a gap (the user kept looking at it for a bit after the last change).
const TIMELINE_TAIL_MS: i64 = 2 * 60_000;
/// Per-segment text excerpt budget for `--text`.
const EXCERPT_CHARS: usize = 280;
/// At most this many segments get excerpts (longest-duration first).
const EXCERPT_MAX_SEGMENTS: usize = 30;
/// Search result cap (the CLI default is lower).
pub const SEARCH_MAX_LIMIT: u32 = 40;

/// Resolve a caller-supplied time range. Priority: explicit `[from,to)` ms >
/// `last` ms > `day` (`today` / `yesterday` / `YYYY-MM-DD`) > today.
pub fn resolve_range(
    day: Option<&str>,
    from_ms: Option<i64>,
    to_ms: Option<i64>,
    last_ms: Option<i64>,
) -> Result<(i64, i64), String> {
    let now = now_ms();
    if from_ms.is_some() || to_ms.is_some() {
        let from = from_ms.ok_or("`toMs` given without `fromMs`")?;
        let to = to_ms.unwrap_or(now);
        if to <= from {
            return Err("empty range: `toMs` must be after `fromMs`".into());
        }
        return Ok((from, to));
    }
    if let Some(last) = last_ms {
        if last <= 0 {
            return Err("`lastMs` must be positive".into());
        }
        return Ok((now - last, now));
    }
    let today = chrono::Local::now().date_naive();
    let date = match day.map(str::trim).filter(|s| !s.is_empty()) {
        None | Some("today") => today,
        Some("yesterday") => today.pred_opt().ok_or("date out of range")?,
        Some(s) => chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
            .map_err(|_| format!("bad day {s:?} — use today, yesterday, or YYYY-MM-DD"))?,
    };
    let start_of = |d: chrono::NaiveDate| -> Result<i64, String> {
        let dt = d.and_hms_opt(0, 0, 0).ok_or("date out of range")?;
        chrono::Local
            .from_local_datetime(&dt)
            .earliest()
            .map(|t| t.timestamp_millis())
            .ok_or_else(|| "cannot resolve local midnight".into())
    };
    let from = start_of(date)?;
    let to = start_of(date.succ_opt().ok_or("date out of range")?)?.min(now);
    if to <= from {
        return Err("that day hasn't started yet".into());
    }
    Ok((from, to))
}

/// Collector status line for agents: whether there is any data to query.
pub fn context_status(store: &Store) -> String {
    let settings = load_settings(store);
    let count = store.ax_context_count().unwrap_or(0);
    let mut out = format!(
        "Ambient screen context collector: {}.",
        if settings.enabled {
            "enabled"
        } else {
            "disabled (the user can turn it on in Cetus Settings → Screen Context)"
        }
    );
    match store.ax_context_span() {
        Ok(Some((oldest, newest))) if count > 0 => {
            out.push_str(&format!(
                "\n{count} entries, {} → {}.",
                fmt_local(oldest),
                fmt_local(newest)
            ));
            if settings.retention_days > 0 {
                out.push_str(&format!(" Retention: {} days.", settings.retention_days));
            }
        }
        _ => out.push_str("\nNo entries recorded."),
    }
    out
}

/// One merged run of foreground time on the same window/tab.
struct Segment {
    start: i64,
    /// ts of the last observation folded in (end is derived at print time).
    last: i64,
    end: i64,
    app: String,
    title: String,
    url: String,
    /// Entry with the most text in the segment — the drill-down target.
    best_id: String,
    best_chars: i64,
}

/// The workhorse behind "what did I do today": aggregate the raw observation
/// stream into an app rollup plus a window-level timeline, durations computed
/// here so the caller never has to.
pub fn context_timeline(
    store: &Store,
    from: i64,
    to: i64,
    by_app: bool,
    app_filter: &str,
    with_text: bool,
) -> Result<String, String> {
    let rows = store
        .ax_context_range_meta(from, to, RANGE_SCAN_LIMIT)
        .map_err(|e| e.to_string())?;
    // Judged against the raw scan, before the app filter shrinks the set.
    let truncated = rows.len() as u32 >= RANGE_SCAN_LIMIT;
    let filter = app_filter.trim().to_lowercase();
    let rows: Vec<_> = rows
        .into_iter()
        .filter(|r| {
            filter.is_empty() || {
                let hay = format!(
                    "{} {}",
                    r.app_name.as_deref().unwrap_or(""),
                    r.bundle_id.as_deref().unwrap_or("")
                )
                .to_lowercase();
                hay.contains(&filter)
            }
        })
        .collect();

    let mut header = format!("Screen activity {} – {}", fmt_local(from), fmt_local(to));
    if !filter.is_empty() {
        header.push_str(&format!(" (app filter: {app_filter})"));
    }
    if truncated {
        header.push_str(&format!(
            "\nWARNING: range hit the {RANGE_SCAN_LIMIT}-row scan cap — later activity in \
             the range is NOT included. Narrow the range."
        ));
    }
    if rows.is_empty() {
        let enabled = load_settings(store).enabled;
        return Ok(format!(
            "{header}\nNo activity recorded in this range.{}",
            if enabled {
                ""
            } else {
                " Note: the collector is currently disabled."
            }
        ));
    }

    // Merge consecutive same-window observations into segments.
    let mut segs: Vec<Segment> = Vec::new();
    for r in &rows {
        let title = r
            .page_title
            .clone()
            .filter(|s| !s.is_empty())
            .or_else(|| r.window_title.clone())
            .unwrap_or_default();
        let app = r.app_name.clone().unwrap_or_else(|| "?".into());
        let url = r.url.clone().unwrap_or_default();
        let same = segs.last().is_some_and(|s| {
            s.app == app && s.title == title && s.url == url && r.ts - s.last <= TIMELINE_GAP_MS
        });
        if same {
            let s = segs.last_mut().unwrap();
            s.last = r.ts;
            if r.text_chars > s.best_chars {
                s.best_chars = r.text_chars;
                s.best_id = r.id.clone();
            }
        } else {
            segs.push(Segment {
                start: r.ts,
                last: r.ts,
                end: r.ts,
                app,
                title,
                url,
                best_id: r.id.clone(),
                best_chars: r.text_chars,
            });
        }
    }
    // Segment end: the next segment's start when contiguous, else a small
    // grace after the last observation (then the gap is reported as away).
    let now = now_ms();
    for i in 0..segs.len() {
        let next_start = segs.get(i + 1).map(|s| s.start);
        let s = &mut segs[i];
        s.end = match next_start {
            Some(ns) if ns - s.last <= TIMELINE_GAP_MS => ns,
            _ => (s.last + TIMELINE_TAIL_MS).min(to).min(now),
        }
        .max(s.last);
    }

    // App rollup: total duration + top windows per app.
    use std::collections::HashMap;
    let mut apps: HashMap<&str, (i64, HashMap<&str, i64>)> = HashMap::new();
    for s in &segs {
        let e = apps.entry(&s.app).or_default();
        e.0 += s.end - s.start;
        if !s.title.is_empty() {
            *e.1.entry(&s.title).or_default() += s.end - s.start;
        }
    }
    let total: i64 = segs.iter().map(|s| s.end - s.start).sum();
    let mut app_rows: Vec<_> = apps.into_iter().collect();
    app_rows.sort_by_key(|(_, (d, _))| -d);

    let mut out = vec![
        header,
        "Durations are foreground time observed by the collector (input-idle stretches over 10m show as [away]).".into(),
        format!(
            "Total {} across {} apps, {} window segments.",
            fmt_dur(total),
            app_rows.len(),
            segs.len()
        ),
        String::new(),
        "By app:".into(),
    ];
    for (app, (dur, titles)) in &app_rows {
        let mut t: Vec<_> = titles.iter().collect();
        t.sort_by_key(|(_, d)| -**d);
        let tops = t
            .iter()
            .take(3)
            .map(|(title, d)| format!("{} ({})", clip(title, 60), fmt_dur(**d)))
            .collect::<Vec<_>>()
            .join(", ");
        out.push(format!(
            "  {:>7}  {app}{}",
            fmt_dur(*dur),
            if tops.is_empty() {
                String::new()
            } else {
                format!(" — {tops}")
            }
        ));
    }

    if !by_app {
        out.push(String::new());
        if segs.len() > TIMELINE_MAX_SEGMENTS {
            out.push(format!(
                "Timeline: {} window segments — too many to list. Narrow the range \
                 (e.g. --last 2h, --from-ms/--to-ms), filter with --app, or use --by app.",
                segs.len()
            ));
        } else {
            // Which segments get a text excerpt: the longest ones, bounded.
            let mut excerpt_ids: Vec<&str> = Vec::new();
            if with_text {
                let mut by_dur: Vec<&Segment> = segs.iter().collect();
                by_dur.sort_by_key(|s| -(s.end - s.start));
                excerpt_ids = by_dur
                    .iter()
                    .take(EXCERPT_MAX_SEGMENTS)
                    .map(|s| s.best_id.as_str())
                    .collect();
            }
            out.push("Timeline (oldest first):".into());
            let mut prev_end: Option<i64> = None;
            for s in &segs {
                if let Some(pe) = prev_end {
                    if s.start - pe > TIMELINE_GAP_MS {
                        out.push(format!("  [away {}]", fmt_dur(s.start - pe)));
                    }
                }
                prev_end = Some(s.end);
                let mut line = format!(
                    "  {}–{} ({})  {} — {}",
                    fmt_hm(s.start),
                    fmt_hm(s.end),
                    fmt_dur(s.end - s.start),
                    s.app,
                    clip(&s.title, 80)
                );
                if !s.url.is_empty() {
                    line.push_str(&format!(" <{}>", clip(&s.url, 90)));
                }
                out.push(line);
                if excerpt_ids.contains(&s.best_id.as_str()) {
                    if let Ok(Some(e)) = store.get_ax_context(&s.best_id) {
                        let ex = clip(&collapse_ws(&e.text), EXCERPT_CHARS);
                        if !ex.is_empty() {
                            out.push(format!("      » {ex}"));
                        }
                    }
                }
            }
            out.push(String::new());
            out.push(
                "Drill down: `cetus context search <query>` or `cetus context get <id>` \
                 (search results carry ids)."
                    .into(),
            );
        }
    }
    Ok(out.join("\n"))
}

/// Full-text search formatted for an agent: one header line per hit plus a
/// match-centered snippet, ids included for `context get` drill-down.
pub fn context_search(
    store: &Store,
    query: &str,
    from: i64,
    to: i64,
    app_filter: &str,
    limit: u32,
) -> Result<String, String> {
    if query.trim().is_empty() {
        return Err("missing query".into());
    }
    let limit = limit.clamp(1, SEARCH_MAX_LIMIT);
    let hits = store
        .search_ax_context_snippets(query, from, to, app_filter, limit)
        .map_err(|e| e.to_string())?;
    let mut out = vec![format!(
        "{} match(es) for {query:?}, {} – {}{}:",
        hits.len(),
        fmt_local(from),
        fmt_local(to),
        if app_filter.trim().is_empty() {
            String::new()
        } else {
            format!(" (app filter: {app_filter})")
        }
    )];
    if hits.is_empty() {
        out.push(
            "Nothing matched. FTS is exact-word AND matching — try fewer/other words, \
             a wider time range, or `cetus context timeline` to see what was open."
                .into(),
        );
    }
    for h in &hits {
        let title = h
            .page_title
            .as_deref()
            .filter(|s| !s.is_empty())
            .or(h.window_title.as_deref())
            .unwrap_or("");
        let mut line = format!(
            "- {}  {} — {}",
            fmt_local(h.ts),
            h.app_name.as_deref().unwrap_or("?"),
            clip(title, 80)
        );
        if let Some(url) = h.url.as_deref().filter(|s| !s.is_empty()) {
            line.push_str(&format!(" <{}>", clip(url, 90)));
        }
        line.push_str(&format!("  [id {}]", h.id));
        out.push(line);
        let sn = collapse_ws(&h.snippet);
        if !sn.is_empty() {
            out.push(format!("    {sn}"));
        }
    }
    Ok(out.join("\n"))
}

/// One full captured entry — the last step of the drill-down ladder.
pub fn context_get(store: &Store, id: &str) -> Result<String, String> {
    let e = store
        .get_ax_context(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no entry with id {id:?} (pruned, or wrong id?)"))?;
    let mut out = format!(
        "{}  {} — {}",
        fmt_local(e.ts),
        e.app_name.as_deref().unwrap_or("?"),
        e.page_title
            .as_deref()
            .filter(|s| !s.is_empty())
            .or(e.window_title.as_deref())
            .unwrap_or("")
    );
    if let Some(url) = e.url.as_deref().filter(|s| !s.is_empty()) {
        out.push_str(&format!("\nURL: {url}"));
    }
    out.push_str("\n--- captured screen text ---\n");
    out.push_str(e.text.trim());
    Ok(out)
}

fn fmt_local(ts: i64) -> String {
    chrono::Local
        .timestamp_millis_opt(ts)
        .single()
        .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| ts.to_string())
}

fn fmt_hm(ts: i64) -> String {
    chrono::Local
        .timestamp_millis_opt(ts)
        .single()
        .map(|dt| dt.format("%H:%M").to_string())
        .unwrap_or_default()
}

fn fmt_dur(ms: i64) -> String {
    let secs = (ms.max(0)) / 1000;
    let (h, m) = (secs / 3600, (secs % 3600) / 60);
    if h > 0 {
        format!("{h}h{:02}m", m)
    } else if m > 0 {
        format!("{m}m")
    } else {
        format!("{secs}s")
    }
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max.saturating_sub(1)).collect();
        format!("{cut}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_range_prefers_explicit_over_day() {
        let (from, to) = resolve_range(Some("today"), Some(100), Some(200), None).unwrap();
        assert_eq!((from, to), (100, 200));
    }

    #[test]
    fn resolve_range_last_wins_over_day() {
        let (from, to) = resolve_range(Some("yesterday"), None, None, Some(60_000)).unwrap();
        assert_eq!(to - from, 60_000);
    }

    #[test]
    fn resolve_range_rejects_garbage_day() {
        assert!(resolve_range(Some("someday"), None, None, None).is_err());
        assert!(resolve_range(None, None, Some(5), None).is_err());
        assert!(resolve_range(None, Some(9), Some(5), None).is_err());
    }

    #[test]
    fn durations_format_compactly() {
        assert_eq!(fmt_dur(45_000), "45s");
        assert_eq!(fmt_dur(7 * 60_000), "7m");
        assert_eq!(fmt_dur(3 * 3_600_000 + 5 * 60_000), "3h05m");
    }

    #[test]
    fn timeline_merges_windows_marks_gaps_and_search_drills_down() {
        let path =
            std::env::temp_dir().join(format!("cetus-ambient-test-{}.db", uuid::Uuid::new_v4()));
        let store = Store::open(&path).unwrap();
        let t0: i64 = 1_700_000_000_000;
        let mk =
            |ts: i64, app: &str, title: &str, url: &str, page: &str, text: &str| AxContextEntry {
                id: uuid::Uuid::new_v4().to_string(),
                ts,
                app_name: Some(app.to_string()),
                bundle_id: Some(format!("com.test.{}", app.to_lowercase())),
                window_title: Some(title.to_string()),
                url: Some(url.to_string()).filter(|s| !s.is_empty()),
                page_title: Some(page.to_string()).filter(|s| !s.is_empty()),
                text: text.to_string(),
                text_hash: None,
            };
        // Two Cursor observations 5m apart (merge), a Chrome tab, a 40m gap,
        // then Cursor again.
        for e in [
            mk(
                t0,
                "Cursor",
                "main.rs — cetus",
                "",
                "",
                "fn main hello world",
            ),
            mk(
                t0 + 300_000,
                "Cursor",
                "main.rs — cetus",
                "",
                "",
                "fn main hello world edited",
            ),
            mk(
                t0 + 600_000,
                "Chrome",
                "Hacker News",
                "https://news.ycombinator.com",
                "Hacker News",
                "Dayflow show hn git log for your day",
            ),
            mk(
                t0 + 3_000_000,
                "Cursor",
                "main.rs — cetus",
                "",
                "",
                "fn main round two",
            ),
        ] {
            store.insert_ax_context(&e).unwrap();
        }

        let out = context_timeline(&store, t0 - 1_000, t0 + 3_600_000, false, "", false).unwrap();
        // Cursor rows merged into one 10m segment (5m gap folds, ends at
        // Chrome's start), Chrome gets the tail grace, the 38m silence is away.
        assert!(out.contains("By app:"), "{out}");
        assert!(out.contains("Cursor"), "{out}");
        assert!(out.contains("Hacker News"), "{out}");
        assert!(out.contains("[away 38m]"), "{out}");
        // Two timeline segments plus the by-app top-windows mention.
        assert_eq!(out.matches("Cursor — main.rs").count(), 3, "{out}");

        // App filter narrows the rollup.
        let cursor_only =
            context_timeline(&store, t0 - 1_000, t0 + 3_600_000, true, "cursor", false).unwrap();
        assert!(!cursor_only.contains("Chrome"), "{cursor_only}");

        // Search → id → full text: the drill-down ladder.
        let found = context_search(&store, "Dayflow", t0 - 1_000, t0 + 3_600_000, "", 10).unwrap();
        assert!(found.contains("Hacker News"), "{found}");
        let hits = store
            .search_ax_context_snippets("Dayflow", t0 - 1_000, t0 + 3_600_000, "", 10)
            .unwrap();
        let full = context_get(&store, &hits[0].id).unwrap();
        assert!(full.contains("git log for your day"), "{full}");

        let _ = std::fs::remove_file(&path);
    }
}
