use super::*;

/// End-to-end over a fake CLI: a shell script standing in for `claude`
/// ignores its argv and emits captured-format JSONL. Exercises the full
/// spawn → stream → finish path including resume-token pickup and message
/// collection.
#[tokio::test]
async fn run_cli_turn_streams_and_collects_end_to_end() {
    let dir = std::env::temp_dir().join(format!("cetus-cli-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("fake-claude.sh");
    std::fs::write(
        &script,
        "#!/bin/sh\n\
         echo '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"sess-e2e\"}'\n\
         echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}}'\n\
         echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}}'\n\
         echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":0}}'\n\
         echo '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"hello\"}'\n\
         sleep 30\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
    let outcome = run_cli_turn(
        sink.clone() as Arc<dyn EventSink>,
        CliBackend::ClaudeCode,
        &script.to_string_lossy(),
        &dir,
        "hi",
        None,
        Vec::new(),
        CliRunOpts::default(),
        Some(Arc::new(tokio::sync::Notify::new())),
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(outcome.resume_id.as_deref(), Some("sess-e2e"));
    assert!(!outcome.aborted);
    assert_eq!(outcome.messages.len(), 1);
    assert_eq!(outcome.messages[0]["content"][0]["text"], json!("hello"));

    let events = sink.0.lock().unwrap();
    let types = types(&events);
    assert_eq!(types.first().map(String::as_str), Some("agent_start"));
    assert_eq!(types.last().map(String::as_str), Some("agent_settled"));
    assert!(types.iter().any(|t| t == "message_update:text_end"));

    let _ = std::fs::remove_dir_all(&dir);
}

/// The abort switch kills a long-running CLI mid-turn: the turn closes
/// promptly with whatever streamed instead of waiting out the child.
#[tokio::test]
async fn run_cli_turn_abort_kills_child() {
    let dir = std::env::temp_dir().join(format!("cetus-cli-abort-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("fake-slow.sh");
    std::fs::write(
        &script,
        "#!/bin/sh\n\
         echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}}'\n\
         echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"partial\"}}}'\n\
         echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":0}}'\n\
         sleep 30\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
    let abort = Arc::new(tokio::sync::Notify::new());
    let killer = abort.clone();
    // Fire the stop only after the first streamed text arrived, so the
    // "keeps what already streamed" assertion isn't racing the spawn.
    let watch = sink.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            let seen = watch.0.lock().unwrap().iter().any(|e| {
                e.get("assistantMessageEvent")
                    .and_then(|a| a.get("type"))
                    .and_then(|t| t.as_str())
                    == Some("text_end")
            });
            if seen {
                killer.notify_one();
                return;
            }
        }
    });
    let started = std::time::Instant::now();
    let outcome = run_cli_turn(
        sink.clone() as Arc<dyn EventSink>,
        CliBackend::ClaudeCode,
        &script.to_string_lossy(),
        &dir,
        "hi",
        None,
        Vec::new(),
        CliRunOpts::default(),
        Some(abort),
        None,
        None,
    )
    .await
    .unwrap();

    assert!(outcome.aborted);
    // Well under the script's 30s sleep — the child was killed, not waited.
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
    // What streamed before the stop is kept for the transcript.
    assert_eq!(outcome.messages.len(), 1);
    // Content streamed → the CLI saved the session; resume id is safe.
    assert!(outcome.streamed);
    let events = sink.0.lock().unwrap();
    assert_eq!(
        types(&events).last().map(String::as_str),
        Some("agent_settled")
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// Stop before any content streamed: the init event already carried a
/// session id, but claude hasn't written the session to disk yet, so the
/// outcome must flag the turn as not-streamed — persisting that id would
/// make every later `--resume` fail with "No conversation found".
#[tokio::test]
async fn run_cli_turn_abort_before_content_marks_unstreamed() {
    let dir =
        std::env::temp_dir().join(format!("cetus-cli-abort-early-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("fake-boot.sh");
    // The marker file signals "init is in the pipe" so the stop below can't
    // fire before the child even booted (parallel test runs load the box
    // enough for a fixed sleep to lose that race).
    std::fs::write(
        &script,
        "#!/bin/sh\n\
         echo '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"ghost-session\"}'\n\
         touch \"$0.ready\"\n\
         sleep 30\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
    let abort = Arc::new(tokio::sync::Notify::new());
    let killer = abort.clone();
    let ready = script.with_extension("sh.ready");
    tokio::spawn(async move {
        while !ready.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        // One beat for the reader to consume the buffered init line, so the
        // select can't randomly pick the abort branch and drop it.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        killer.notify_one();
    });
    let outcome = run_cli_turn(
        sink.clone() as Arc<dyn EventSink>,
        CliBackend::ClaudeCode,
        &script.to_string_lossy(),
        &dir,
        "hi",
        None,
        Vec::new(),
        CliRunOpts::default(),
        Some(abort),
        None,
        None,
    )
    .await
    .unwrap();

    assert!(outcome.aborted);
    // The ghost session id was captured but flagged unsafe to persist.
    assert_eq!(outcome.resume_id.as_deref(), Some("ghost-session"));
    assert!(!outcome.streamed);
    assert!(!outcome.resume_rejected);
    // No error bubble — a user stop is not a failure.
    let events = sink.0.lock().unwrap();
    assert!(!types(&events)
        .iter()
        .any(|t| t == "message_update:text_end"));

    let _ = std::fs::remove_dir_all(&dir);
}

/// A `--resume` token the CLI can't find (its turn was killed before the
/// session hit disk) must be flagged so the caller resets it, and the bare
/// "agent reported an error" replaced with an actionable message.
#[tokio::test]
async fn run_cli_turn_dead_resume_token_flags_rejection() {
    let dir =
        std::env::temp_dir().join(format!("cetus-cli-dead-resume-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("fake-dead-resume.sh");
    std::fs::write(
        &script,
        "#!/bin/sh\n\
         echo 'No conversation found with session ID: ghost-session' >&2\n\
         echo '{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"is_error\":true,\"result\":null}'\n\
         sleep 30\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
    let outcome = run_cli_turn(
        sink.clone() as Arc<dyn EventSink>,
        CliBackend::ClaudeCode,
        &script.to_string_lossy(),
        &dir,
        "hi",
        None,
        Vec::new(),
        CliRunOpts {
            resume: Some("ghost-session".into()),
            ..CliRunOpts::default()
        },
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert!(outcome.resume_rejected);
    // The surfaced error tells the user what happened and what to do.
    let text = outcome.messages[0]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("couldn't resume"), "got: {text}");
    assert!(text.contains("send your message again"), "got: {text}");

    let _ = std::fs::remove_dir_all(&dir);
}

/// A missing binary must still close the turn (message_end/agent_end) with
/// a visible error instead of stranding the frontend in streaming state.
#[tokio::test]
async fn run_cli_turn_missing_binary_closes_turn() {
    let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
    let outcome = run_cli_turn(
        sink.clone() as Arc<dyn EventSink>,
        CliBackend::Codex,
        "/nonexistent/cetus-test-binary",
        Path::new("/tmp"),
        "hi",
        None,
        Vec::new(),
        CliRunOpts::default(),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert!(outcome.resume_id.is_none());
    // The failure is surfaced as a persisted assistant message too.
    assert_eq!(outcome.messages.len(), 1);
    let events = sink.0.lock().unwrap();
    let types = types(&events);
    assert_eq!(types.last().map(String::as_str), Some("agent_settled"));
    assert!(types.iter().any(|t| t == "message_update:text_end"));
}

/// A steer that merged into the running turn: its `result` already covers
/// the injected message, so after the quiet grace window the turn closes —
/// well before the idling child's sleep runs out.
#[tokio::test]
async fn run_cli_turn_steer_merged_closes_after_grace() {
    let dir = std::env::temp_dir().join(format!("cetus-cli-steer-merge-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("fake-merged.sh");
    std::fs::write(
        &script,
        "#!/bin/sh\n\
         echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}}'\n\
         echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"merged\"}}}'\n\
         echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":0}}'\n\
         echo '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"merged\"}'\n\
         sleep 30\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
    let steer = Arc::new(std::sync::atomic::AtomicUsize::new(1));
    let started = std::time::Instant::now();
    let outcome = run_cli_turn(
        sink.clone() as Arc<dyn EventSink>,
        CliBackend::ClaudeCode,
        &script.to_string_lossy(),
        &dir,
        "hi",
        None,
        Vec::new(),
        CliRunOpts::default(),
        None,
        None,
        Some(steer),
    )
    .await
    .unwrap();

    assert!(!outcome.aborted);
    assert_eq!(outcome.messages[0]["content"][0]["text"], json!("merged"));
    let elapsed = started.elapsed();
    // Held open through the grace window, but nowhere near the child's
    // 30s idle sleep.
    assert!(
        elapsed >= std::time::Duration::from_millis(1900),
        "{elapsed:?}"
    );
    assert!(elapsed < std::time::Duration::from_secs(10), "{elapsed:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A fast subagent: its completion notification lands BEFORE the turn's
/// `result` (observed on 2.1.201), so `has_pending_tasks` is already false
/// when the result arrives. The runner must still hold the close through
/// the quiet window — the CLI's continuation turn (the main agent
/// digesting the subagent's report) arrives after that result, and killing
/// on it would silently discard the subagent's work.
#[tokio::test]
async fn run_cli_turn_holds_close_for_subagent_continuation() {
    let dir = std::env::temp_dir().join(format!("cetus-cli-subagent-cont-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("fake-subagent.sh");
    std::fs::write(
        &script,
        "#!/bin/sh\n\
         echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tA\",\"name\":\"Agent\",\"input\":{}}}}'\n\
         echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":0}}'\n\
         echo '{\"type\":\"system\",\"subtype\":\"task_started\",\"task_id\":\"bg1\",\"tool_use_id\":\"tA\",\"description\":\"scan\",\"subagent_type\":\"Explore\"}'\n\
         echo '{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"tA\",\"content\":[{\"type\":\"text\",\"text\":\"Async agent launched successfully\"}],\"is_error\":false}]}}'\n\
         echo '{\"type\":\"system\",\"subtype\":\"task_notification\",\"task_id\":\"bg1\",\"tool_use_id\":\"tA\",\"status\":\"completed\",\"summary\":\"found it\"}'\n\
         echo '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"launched\"}'\n\
         sleep 1\n\
         echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}}'\n\
         echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"the subagent found it\"}}}'\n\
         echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":0}}'\n\
         echo '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"done\"}'\n\
         sleep 30\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
    let started = std::time::Instant::now();
    let outcome = run_cli_turn(
        sink.clone() as Arc<dyn EventSink>,
        CliBackend::ClaudeCode,
        &script.to_string_lossy(),
        &dir,
        "hi",
        None,
        Vec::new(),
        CliRunOpts::default(),
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert!(!outcome.aborted);
    // The continuation turn's text made it into the transcript — the
    // runner did not kill the child at the first result.
    let all = serde_json::to_string(&outcome.messages).unwrap();
    assert!(all.contains("the subagent found it"), "{all}");
    assert!(
        all.contains("found it"),
        "notification summary persisted: {all}"
    );
    let elapsed = started.elapsed();
    // Closed after the continuation + one quiet window, not the 30s idle.
    assert!(elapsed < std::time::Duration::from_secs(10), "{elapsed:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A steer that landed after the model finished: claude starts a NEW turn
/// after the first `result`. The pending steer keeps the runner reading —
/// the steered turn streams fully and its own `result` closes the run.
#[tokio::test]
async fn run_cli_turn_steer_new_turn_keeps_streaming() {
    let dir = std::env::temp_dir().join(format!("cetus-cli-steer-turn-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("fake-steered.sh");
    std::fs::write(
        &script,
        "#!/bin/sh\n\
         echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}}'\n\
         echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"first\"}}}'\n\
         echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":0}}'\n\
         echo '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"first\"}'\n\
         sleep 1\n\
         echo '{\"type\":\"system\",\"subtype\":\"status\",\"status\":\"requesting\"}'\n\
         echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}}'\n\
         echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"steered\"}}}'\n\
         echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":0}}'\n\
         echo '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"steered\"}'\n\
         sleep 30\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
    let steer = Arc::new(std::sync::atomic::AtomicUsize::new(1));
    let started = std::time::Instant::now();
    let outcome = run_cli_turn(
        sink.clone() as Arc<dyn EventSink>,
        CliBackend::ClaudeCode,
        &script.to_string_lossy(),
        &dir,
        "hi",
        None,
        Vec::new(),
        CliRunOpts::default(),
        None,
        None,
        Some(steer),
    )
    .await
    .unwrap();

    assert!(!outcome.aborted);
    // Both the pre-steer and the steered turn's text made it out.
    let all = serde_json::to_string(&outcome.messages).unwrap();
    assert!(all.contains("first") && all.contains("steered"), "{all}");
    // Closed on the steered turn's result, not the 30s idle sleep.
    assert!(
        started.elapsed() < std::time::Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
    let _ = std::fs::remove_dir_all(&dir);
}
