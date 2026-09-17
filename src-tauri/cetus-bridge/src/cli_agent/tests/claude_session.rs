use super::*;

#[tokio::test]
async fn persistent_claude_session_reuses_one_process_across_turns() {
    let dir = std::env::temp_dir().join(format!(
        "cetus-claude-session-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("fake-persistent-claude.sh");
    let pid_file = dir.join("pid");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\n\
             echo $$ > '{}'\n\
             echo '{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"persistent-1\"}}'\n\
             n=0\n\
             while IFS= read -r line; do\n\
               case \"$line\" in *'\"type\":\"user\"'*)\n\
                 n=$((n + 1))\n\
                 echo \"{{\\\"type\\\":\\\"item-ignored\\\"}}\"\n\
                 echo \"{{\\\"type\\\":\\\"stream_event\\\",\\\"event\\\":{{\\\"type\\\":\\\"content_block_start\\\",\\\"index\\\":0,\\\"content_block\\\":{{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"\\\"}}}}}}\"\n\
                 echo \"{{\\\"type\\\":\\\"stream_event\\\",\\\"event\\\":{{\\\"type\\\":\\\"content_block_delta\\\",\\\"index\\\":0,\\\"delta\\\":{{\\\"type\\\":\\\"text_delta\\\",\\\"text\\\":\\\"turn-$n\\\"}}}}}}\"\n\
                 echo \"{{\\\"type\\\":\\\"stream_event\\\",\\\"event\\\":{{\\\"type\\\":\\\"content_block_stop\\\",\\\"index\\\":0}}}}\"\n\
                 echo \"{{\\\"type\\\":\\\"result\\\",\\\"subtype\\\":\\\"success\\\",\\\"is_error\\\":false,\\\"result\\\":\\\"turn-$n\\\"}}\"\n\
               ;; esac\n\
             done\n",
            pid_file.display()
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
    let session = spawn_claude_session(
        sink.clone() as Arc<dyn EventSink>,
        &script.to_string_lossy(),
        &dir,
        None,
        None,
        Vec::new(),
        CliRunOpts::default(),
        None,
    )
    .unwrap();

    let first = session
        .start_turn(
            claude_user_message_line("one", &[]),
            sink.clone() as Arc<dyn EventSink>,
        )
        .unwrap()
        .await
        .unwrap();
    let pid = std::fs::read_to_string(&pid_file).unwrap();
    assert_eq!(first.messages[0]["content"][0]["text"], json!("turn-1"));
    assert!(
        session.is_alive(),
        "result must not tear down the CLI session"
    );

    let second = session
        .start_turn(
            claude_user_message_line("two", &[]),
            sink.clone() as Arc<dyn EventSink>,
        )
        .unwrap()
        .await
        .unwrap();
    assert_eq!(second.messages[0]["content"][0]["text"], json!("turn-2"));
    assert_eq!(std::fs::read_to_string(&pid_file).unwrap(), pid);

    session.shutdown();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let _ = std::fs::remove_dir_all(&dir);
}

/// A self-started continuation turn (Monitor/subagent wake-up) streams
/// with no active turn registered — its messages must reach the orphan
/// persistence channel instead of being wiped by the next StartTurn's
/// begin_next_turn (observed data loss: the wake-up's tool calls and
/// AskUserQuestion never hit the Cetus transcript).
#[tokio::test]
async fn continuation_turn_messages_reach_orphan_channel() {
    let dir = std::env::temp_dir().join(format!(
        "cetus-claude-orphan-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("fake-continuation-claude.sh");
    // On boot: init, then a spontaneous continuation turn (text + result)
    // BEFORE any user turn. Then answer user turns normally.
    std::fs::write(
        &script,
        "#!/bin/sh\n\
         echo '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"cont-1\"}'\n\
         echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}}'\n\
         echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"monitor woke me\"}}}'\n\
         echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":0}}'\n\
         echo '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"monitor woke me\"}'\n\
         while IFS= read -r line; do\n\
           case \"$line\" in *'\"type\":\"user\"'*)\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}}'\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"real turn\"}}}'\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":0}}'\n\
             echo '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"real turn\"}'\n\
           ;; esac\n\
         done\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
    let (orphan_tx, mut orphan_rx) = tokio::sync::mpsc::unbounded_channel();
    let session = spawn_claude_session(
        sink.clone() as Arc<dyn EventSink>,
        &script.to_string_lossy(),
        &dir,
        None,
        None,
        Vec::new(),
        CliRunOpts::default(),
        Some(orphan_tx),
    )
    .unwrap();

    // The continuation turn's reply lands on the orphan channel.
    let orphaned = tokio::time::timeout(std::time::Duration::from_secs(5), orphan_rx.recv())
        .await
        .expect("continuation message not shipped")
        .unwrap();
    assert_eq!(orphaned[0]["content"][0]["text"], json!("monitor woke me"));

    // A normal turn afterwards is unaffected and does NOT re-carry it.
    let outcome = session
        .start_turn(
            claude_user_message_line("hi", &[]),
            sink.clone() as Arc<dyn EventSink>,
        )
        .unwrap()
        .await
        .unwrap();
    assert_eq!(outcome.messages.len(), 1);
    assert_eq!(
        outcome.messages[0]["content"][0]["text"],
        json!("real turn")
    );

    session.shutdown();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let _ = std::fs::remove_dir_all(&dir);
}

/// A background task completing re-invokes the model: the CLI streams a
/// self-started continuation turn after the previous turn's result. That
/// turn must be announced to the frontend as a full stream — agent_start,
/// a fresh message_start (the previous turn's `opened` flag must not
/// suppress it), the reply deltas, and a closing agent_end — not just
/// silently persisted (observed: the reply only appeared after reopening
/// the conversation, reading as "Cetus never auto-responds").
#[tokio::test]
async fn continuation_turn_after_finished_turn_streams_to_base_sink() {
    let dir = std::env::temp_dir().join(format!(
        "cetus-claude-continuation-stream-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("fake-bg-continuation-claude.sh");
    // Turn 1 answers normally; right after its result the CLI reports the
    // background task settling and self-starts a continuation turn.
    std::fs::write(
        &script,
        "#!/bin/sh\n\
         echo '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"bg-cont-1\"}'\n\
         while IFS= read -r line; do\n\
           case \"$line\" in *'\"type\":\"user\"'*)\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}}'\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"launched\"}}}'\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":0}}'\n\
             echo '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"launched\"}'\n\
             echo '{\"type\":\"system\",\"subtype\":\"task_notification\",\"task_id\":\"bg1\",\"tool_use_id\":\"tA\",\"status\":\"completed\",\"summary\":\"done\"}'\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"role\":\"assistant\"}}}'\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}}'\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"task finished, continuing\"}}}'\n\
             echo '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":0}}'\n\
             echo '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"task finished, continuing\"}'\n\
           ;; esac\n\
         done\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
    let (orphan_tx, mut orphan_rx) = tokio::sync::mpsc::unbounded_channel();
    let session = spawn_claude_session(
        sink.clone() as Arc<dyn EventSink>,
        &script.to_string_lossy(),
        &dir,
        None,
        None,
        Vec::new(),
        CliRunOpts::default(),
        Some(orphan_tx),
    )
    .unwrap();

    let outcome = session
        .start_turn(
            claude_user_message_line("run it in the background", &[]),
            sink.clone() as Arc<dyn EventSink>,
        )
        .unwrap()
        .await
        .unwrap();
    assert_eq!(outcome.messages[0]["content"][0]["text"], json!("launched"));

    // The continuation turn's reply still reaches the orphan channel.
    let orphaned = tokio::time::timeout(std::time::Duration::from_secs(5), orphan_rx.recv())
        .await
        .expect("continuation message not shipped")
        .unwrap();
    assert_eq!(
        orphaned[0]["content"][0]["text"],
        json!("task finished, continuing")
    );

    // And it streamed live as a full second turn: agent_start,
    // message_start, the delta, message_end, agent_end — in order,
    // after the first turn's agent_end.
    let events = sink.0.lock().unwrap().clone();
    let first_end = events
        .iter()
        .position(|e| e["type"] == "agent_end")
        .expect("first turn closed");
    let tail = &events[first_end + 1..];
    let ty = |e: &Value| e["type"].as_str().unwrap_or("").to_string();
    let order: Vec<String> = tail
        .iter()
        .map(|e| ty(e))
        .filter(|t| {
            matches!(
                t.as_str(),
                "agent_start" | "message_start" | "message_update" | "message_end" | "agent_end"
            )
        })
        .collect();
    assert_eq!(
        order.first().map(String::as_str),
        Some("agent_start"),
        "{order:?}"
    );
    assert_eq!(
        order.get(1).map(String::as_str),
        Some("message_start"),
        "{order:?}"
    );
    assert_eq!(
        order.last().map(String::as_str),
        Some("agent_end"),
        "{order:?}"
    );
    assert!(
        order[..order.len() - 1].contains(&"message_end".to_string()),
        "{order:?}"
    );
    let delta_text: String = tail
        .iter()
        .filter(|e| e["type"] == "message_update")
        .filter_map(|e| e["assistantMessageEvent"]["delta"].as_str())
        .collect();
    assert_eq!(delta_text, "task finished, continuing");

    session.shutdown();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let _ = std::fs::remove_dir_all(&dir);
}

/// Live smoke test against the real claude binary — run manually with
/// `cargo test -p cetus-bridge --lib live_claude -- --ignored --nocapture`.
/// Requires claude auth; costs a few haiku tokens.
#[tokio::test]
#[ignore]
async fn live_claude_bidirectional_smoke() {
    let bin = std::env::var("HOME").unwrap() + "/.local/bin/claude";
    if !std::path::Path::new(&bin).exists() {
        eprintln!("claude not installed; skipping");
        return;
    }
    let dir = std::env::temp_dir().join("cetus-live-claude-smoke");
    std::fs::create_dir_all(&dir).unwrap();
    let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
    let env: Vec<(String, String)> = std::env::vars()
        .filter(|(k, _)| {
            !k.starts_with("CLAUDE") && !k.starts_with("ANTHROPIC") && !k.starts_with("SUPERSET")
        })
        .map(|(k, v)| {
            if k == "PATH" {
                (
                    k,
                    "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin".to_string(),
                )
            } else {
                (k, v)
            }
        })
        .collect();
    let outcome = run_cli_turn(
        sink.clone() as Arc<dyn EventSink>,
        CliBackend::ClaudeCode,
        &bin,
        &dir,
        "Reply with exactly the word: pong",
        None,
        env,
        CliRunOpts {
            model: Some("haiku".into()),
            bypass_approvals: true,
            ..Default::default()
        },
        Some(Arc::new(tokio::sync::Notify::new())),
        None,
        None,
    )
    .await
    .unwrap();
    let events = sink.0.lock().unwrap();
    let tys = types(&events);
    eprintln!("events: {tys:?}");
    eprintln!("messages: {:?}", outcome.messages);
    assert!(outcome.resume_id.is_some(), "session id captured");
    assert!(
        tys.iter().any(|t| t == "message_update:text_delta"),
        "streamed deltas"
    );
    assert_eq!(tys.last().map(String::as_str), Some("agent_settled"));
    assert!(outcome
        .messages
        .iter()
        .any(|m| m.to_string().to_lowercase().contains("pong")));
}
