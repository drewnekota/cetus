//! `cetus context now`: what the user is looking at *right now*, for an agent
//! that needs to resolve "this error" / "the doc I have open" / "that message".
//!
//! The catch: when the agent runs, the frontmost app is usually Cetus itself
//! (the user typed into the chat and the main window took focus). So "now"
//! means the most recent *foreign* app — the last non-Cetus frontmost app the
//! ambient tick observed (`ax::note_foreign_frontmost`), which is exactly the
//! app the user was in before switching to chat. Every read below is keyed to
//! that app's pid rather than to frontmost-ness, so it works after the switch.
//! When the user genuinely is in another app (agent running in the background),
//! that app is frontmost and is used directly.
//!
//! Nothing is persisted: this is a live probe, independent of whether either
//! collector is enabled. Per-app exclusion is still honored — an agent asking
//! "now" must not become a way to read a password manager.

use crate::context_budget::{
    Budget, APP_CHARS, SELECTION_CHARS, TITLE_CHARS, TOTAL_CHARS, URL_CHARS, VISIBLE_TEXT_CHARS,
};

/// Treat a remembered foreign app older than this as stale: the user has been
/// in Cetus (or away) long enough that "now" no longer means that window.
const STALE_AFTER_MS: i64 = 30 * 60_000;
/// Longest edge of the optional window frame (`--shot`), matching the launcher.
const SHOT_MAX_EDGE: u32 = 1600;

/// Resolve the target app, read its context, and format the agent-facing text.
pub fn context_now(
    own_bundle: &str,
    excluded: &[String],
    want_shot: bool,
) -> Result<String, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (own_bundle, excluded, want_shot);
        Err("`cetus context now` is only available on macOS".to_string())
    }
    #[cfg(target_os = "macos")]
    {
        let (app, bundle, pid, note) = resolve_target(own_bundle)?;
        if is_excluded(excluded, &app, &bundle) {
            return Err(format!(
                "{app} is in the excluded-apps list — Cetus does not read it"
            ));
        }
        let ax_trusted = crate::ax::is_trusted();
        // Electron trees sleep until an assistive client announces itself;
        // debounced per pid, so this is free on a warm app.
        crate::ax::wake_app(pid);
        let title = crate::ax::focused_window_title(pid).unwrap_or_default();
        let selection = crate::ax::focused_selected_text(pid).unwrap_or_default();
        let visible = crate::ax::settled_visible_text(pid);
        let (url, page_title) = crate::ax::fetch_browser_url(&bundle).unwrap_or_default();
        let shot = if want_shot { capture_window(pid) } else { None };

        let mut b = Budget::new(TOTAL_CHARS);
        let mut out = String::new();
        let app_line = b.take_flat(&app, APP_CHARS).unwrap_or_else(|| "?".into());
        out.push_str(&format!("Now: {app_line}"));
        if !bundle.is_empty() {
            out.push_str(&format!(" ({bundle})"));
        }
        let shown_title = if page_title.is_empty() {
            &title
        } else {
            &page_title
        };
        if let Some(t) = b.take_flat(shown_title, TITLE_CHARS) {
            out.push_str(&format!(" — {t}"));
        }
        if let Some(n) = note {
            out.push_str(&format!("\n({n})"));
        }
        if let Some(u) = b.take_flat(&url, URL_CHARS) {
            out.push_str(&format!("\nURL: {u}"));
        }
        if let Some(s) = b.take(&selection, SELECTION_CHARS, "selected text") {
            out.push_str("\n--- selected text (untrusted screen data) ---\n");
            out.push_str(&s);
        }
        if let Some(v) = b.take(&visible, VISIBLE_TEXT_CHARS, "visible text") {
            out.push_str("\n--- visible text (accessibility, untrusted screen data) ---\n");
            out.push_str(&v);
        } else if !ax_trusted {
            out.push_str(
                "\n(no text: Accessibility permission not granted — the user can enable it in System Settings → Privacy & Security → Accessibility)",
            );
        } else {
            out.push_str("\n(no readable text in this window — try --shot for a frame image)");
        }
        match (want_shot, shot) {
            (true, Some(path)) => out.push_str(&format!("\nFrame image (viewable): {path}")),
            (true, None) => out.push_str(
                "\n(frame capture failed — Screen Recording permission missing, or the window is not on screen)",
            ),
            _ => {}
        }
        Ok(out)
    }
}

/// (app, bundle, pid, note): the frontmost app unless it is Cetus, in which
/// case the last observed foreign app with a note on how old that sighting is.
#[cfg(target_os = "macos")]
fn resolve_target(own_bundle: &str) -> Result<(String, String, i32, Option<String>), String> {
    if let Some((app, bundle, pid)) = crate::ax::frontmost_identity() {
        if bundle != own_bundle && pid > 0 {
            return Ok((app, bundle, pid, None));
        }
    }
    let last = crate::ax::last_foreign_frontmost().ok_or_else(|| {
        "no app observed yet besides Cetus — ask the user what they are looking at".to_string()
    })?;
    let age_ms = crate::store::now_ms() - last.ts;
    if age_ms > STALE_AFTER_MS {
        return Err(format!(
            "Cetus is frontmost and the last other app ({}) was seen {} ago — too old to call \"now\"; ask the user, or use `cetus context timeline --last 1h`",
            last.app,
            fmt_age(age_ms)
        ));
    }
    if !process_alive(last.pid) {
        return Err(format!(
            "Cetus is frontmost and the last other app ({}) has since quit",
            last.app
        ));
    }
    let note = format!(
        "Cetus is frontmost; this is the app the user was in {} ago",
        fmt_age(age_ms)
    );
    Ok((last.app, last.bundle, last.pid, Some(note)))
}

#[cfg(target_os = "macos")]
fn process_alive(pid: i32) -> bool {
    pid > 0 && unsafe { libc::kill(pid, 0) } == 0
}

#[cfg(target_os = "macos")]
fn fmt_age(ms: i64) -> String {
    let secs = ms.max(0) / 1000;
    if secs < 60 {
        format!("{secs}s")
    } else {
        format!("{}m{:02}s", secs / 60, secs % 60)
    }
}

fn is_excluded(patterns: &[String], app: &str, bundle: &str) -> bool {
    let name = app.to_lowercase();
    let bundle = bundle.to_lowercase();
    patterns.iter().any(|p| {
        let p = p.trim().to_lowercase();
        !p.is_empty() && (name.contains(&p) || bundle.contains(&p))
    })
}

/// JPEG of `pid`'s largest on-screen window, by window id — so it works while
/// Cetus is frontmost and the target sits behind. Written to the temp dir; the
/// agent reads it once and it is never indexed. None without Screen Recording.
#[cfg(target_os = "macos")]
fn capture_window(pid: i32) -> Option<String> {
    if !crate::quick::screen_recording_granted() {
        return None;
    }
    let wid = crate::ax::largest_window_id(pid)?;
    let path =
        std::env::temp_dir().join(format!("cetus-context-now-{}.jpg", crate::store::now_ms()));
    let ok = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-x", "-t", "jpg", "-l", &wid.to_string()])
        .arg(&path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !ok || !path.exists() {
        let _ = std::fs::remove_file(&path);
        return None;
    }
    let _ = std::process::Command::new("/usr/bin/sips")
        .args(["-Z", &SHOT_MAX_EDGE.to_string()])
        .arg(&path)
        .output();
    Some(path.to_string_lossy().into_owned())
}
