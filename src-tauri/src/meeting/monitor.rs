use super::{
    helper_command, load_settings, now_ms, remove_audio_dir, start_internal, stop_internal,
    AppHandle, Arc, Duration, Instant, Manager, MeetingRuntime, Ordering, Path, PathBuf, Store,
    Value, AUTO_START_SECS, AUTO_STOP_SECS, MEETING_APP_BUNDLES, MEETING_BROWSER_BUNDLES,
    MEETING_WEB_DOMAINS, PRUNE_INTERVAL_SECS,
};

// =============================================================================
// Auto-detect monitor loop
// =============================================================================

fn is_native_meeting_app(bundle: &str) -> bool {
    MEETING_APP_BUNDLES.contains(&bundle)
}

fn is_meeting_browser(bundle: &str) -> bool {
    MEETING_BROWSER_BUNDLES.contains(&bundle)
}

fn url_host(url: &str) -> Option<&str> {
    let (_, rest) = url.trim().split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host_port = authority.rsplit('@').next()?;
    let host = host_port.split(':').next()?.trim_end_matches('.');
    (!host.is_empty()).then_some(host)
}

fn is_meeting_web_url(url: &str) -> bool {
    let Some(host) = url_host(url) else {
        return false;
    };
    MEETING_WEB_DOMAINS.iter().any(|domain| {
        host.eq_ignore_ascii_case(domain)
            || host
                .strip_suffix(domain)
                .is_some_and(|prefix| prefix.ends_with('.'))
    })
}

#[cfg(target_os = "macos")]
async fn trusted_meeting_app(apps: &[String]) -> Option<String> {
    if let Some(bundle) = apps.iter().find(|bundle| is_native_meeting_app(bundle)) {
        return Some(bundle.clone());
    }
    for bundle in apps.iter().filter(|bundle| is_meeting_browser(bundle)) {
        let browser = bundle.clone();
        let url = tokio::task::spawn_blocking(move || crate::ax::fetch_browser_url(&browser))
            .await
            .ok()
            .flatten()
            .map(|(url, _)| url);
        if url.as_deref().is_some_and(is_meeting_web_url) {
            return Some(bundle.clone());
        }
    }
    None
}

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
    let mut raw_mic_active = false;
    let mut raw_mic_apps: Vec<String> = Vec::new();
    let mut mic_active = false;
    // Once a browser tab qualifies, keep the browser trusted while it retains
    // the mic so switching tabs during a call does not stop the session.
    let mut trusted_app: Option<String> = None;
    let mut active_since: Option<Instant> = None;
    let mut inactive_since: Option<Instant> = None;
    let mut last_prune = Instant::now();
    // One-shot latches so a helper that can't be built (or a monitor the OS
    // can't provide) logs once instead of every loop tick.
    let mut helper_broken = false;

    loop {
        let settings = load_settings(&store);

        if last_prune.elapsed().as_secs() >= PRUNE_INTERVAL_SECS {
            prune(&store, &app_data, settings.retention_days);
            last_prune = Instant::now();
        }

        if !(settings.enabled && settings.auto_detect) || helper_broken {
            if let Some((mut c, _, stdin)) = child.take() {
                drop(stdin); // EOF → helper exits
                let _ = c.wait().await;
            }
            mic_active = false;
            raw_mic_active = false;
            raw_mic_apps.clear();
            trusted_app = None;
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
                        raw_mic_active = !pids.is_empty();
                        raw_mic_apps = mic
                            .get("apps")
                            .and_then(|a| a.as_array())
                            .map(|a| {
                                a.iter()
                                    .filter_map(|x| x.as_str())
                                    .map(String::from)
                                    .collect()
                            })
                            .unwrap_or_default();
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

        // Convert raw microphone occupancy into trusted meeting occupancy.
        // Unknown apps (dictation tools, voice memos, games, arbitrary sites)
        // never enter the auto-start/stop state machine.
        if !raw_mic_active {
            trusted_app = None;
        } else if !trusted_app
            .as_ref()
            .is_some_and(|bundle| raw_mic_apps.contains(bundle))
        {
            trusted_app = trusted_meeting_app(&raw_mic_apps).await;
        }
        let now_active = trusted_app.is_some();
        if now_active != mic_active {
            mic_active = now_active;
            // Info-level on the occupancy edges: these are rare (call
            // start/end) and are the evidence needed to diagnose "the meeting
            // app quit but recording kept going" — was the release ever seen?
            if mic_active {
                tracing::info!("meeting monitor: trusted mic occupancy by {trusted_app:?}");
                active_since = Some(Instant::now());
                inactive_since = None;
            } else {
                tracing::info!(
                    "meeting monitor: trusted mic occupancy ended (remaining mic apps: {raw_mic_apps:?})"
                );
                inactive_since = Some(Instant::now());
                active_since = None;
            }
        }

        // Debounced state machine.
        let (session_state, suppressed) = {
            let runtime = app.state::<MeetingRuntime>();
            // A mic release ends the "call" a user-stop suppressed; the next
            // occupancy is a fresh call and may auto-start again.
            if !mic_active {
                runtime.auto_suppressed.store(false, Ordering::Relaxed);
            }
            let slot = runtime.active.lock().await;
            (
                slot.as_ref().map(|s| s.auto),
                runtime.auto_suppressed.load(Ordering::Relaxed),
            )
        };
        match session_state {
            None if mic_active
                && !suppressed
                && active_since
                    .map(|t| t.elapsed().as_secs() >= AUTO_START_SECS)
                    .unwrap_or(false) =>
            {
                let hint = trusted_app.clone();
                tracing::info!("meeting auto-start: trusted mic app {hint:?}");
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
                tracing::info!("meeting auto-stop: trusted mic released");
                if let Err(e) = stop_internal(&app, false).await {
                    tracing::warn!("meeting auto-stop failed: {e}");
                }
                inactive_since = None;
            }
            _ => {}
        }
    }
}

pub(super) fn prune(store: &Store, app_data: &Path, retention_days: u32) {
    if retention_days == 0 {
        return;
    }
    let before = now_ms() - (retention_days as i64) * 86_400 * 1000;
    // Saved audio first: fetching ids after the SQL delete would orphan dirs.
    if let Ok(ids) = store.meeting_ids_started_before(before) {
        for id in ids {
            remove_audio_dir(app_data, &id);
        }
    }
    match store.prune_meetings(before) {
        Ok(n) if n > 0 => {
            tracing::info!("meeting: pruned {n} meetings older than {retention_days}d")
        }
        Ok(_) => {}
        Err(e) => tracing::warn!("meeting: prune failed: {e}"),
    }
}

#[cfg(test)]
mod auto_detect_tests {
    use super::*;

    #[test]
    fn native_allowlist_rejects_dictation_apps() {
        assert!(is_native_meeting_app("us.zoom.xos"));
        assert!(is_native_meeting_app("com.microsoft.teams2"));
        assert!(!is_native_meeting_app("com.example.doubao-input"));
        assert!(!is_native_meeting_app("com.apple.VoiceMemos"));
    }

    #[test]
    fn meeting_domains_match_exact_hosts_and_subdomains() {
        assert!(is_meeting_web_url("https://meet.google.com/abc-defg-hij"));
        assert!(is_meeting_web_url("https://acme.zoom.us/j/123"));
        assert!(is_meeting_web_url("https://teams.microsoft.com/v2/"));
        assert!(!is_meeting_web_url(
            "https://example.com/?next=meet.google.com"
        ));
        assert!(!is_meeting_web_url("https://notzoom.us.example.com/j/123"));
        assert!(!is_meeting_web_url("not a url"));
    }

    #[test]
    fn ordinary_browser_mic_use_is_not_a_native_meeting_app() {
        assert!(is_meeting_browser("com.google.Chrome"));
        assert!(!is_native_meeting_app("com.google.Chrome"));
    }
}
