use super::*;

#[tokio::test]
async fn codex_app_server_keeps_thread_alive_after_turn_completed() {
    let dir = std::env::temp_dir().join(format!(
        "cetus-codex-app-server-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("fake-codex.sh");
    std::fs::write(
        &script,
        "#!/bin/sh\n\
         n=0\n\
         while IFS= read -r line; do\n\
           case \"$line\" in\n\
             *'\"method\":\"initialize\"'*) echo '{\"id\":1,\"result\":{\"userAgent\":\"fake\",\"codexHome\":\"/tmp\",\"platformFamily\":\"unix\",\"platformOs\":\"macos\"}}' ;;\n\
             *'\"method\":\"thread/start\"'*) echo '{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread-persistent\"}}}' ;;\n\
             *'\"method\":\"skills/list\"'*) echo '{\"id\":3,\"result\":{\"data\":[{\"skills\":[{\"name\":\"writer\",\"description\":\"Write clearly\",\"enabled\":true}]}]}}' ;;\n\
             *'\"method\":\"turn/start\"'*)\n\
               n=$((n + 1)); id=$((9 + n));\n\
               echo \"{\\\"id\\\":$id,\\\"result\\\":{\\\"turn\\\":{\\\"id\\\":\\\"turn-$n\\\"}}}\";\n\
               if [ \"$n\" -eq 1 ]; then\n\
                 echo '{\"method\":\"item/started\",\"params\":{\"threadId\":\"thread-persistent\",\"turnId\":\"turn-1\",\"item\":{\"type\":\"commandExecution\",\"id\":\"server-1\",\"command\":\"pnpm dev\",\"processId\":\"process-1\",\"status\":\"inProgress\",\"aggregatedOutput\":\"\",\"exitCode\":null}}}' ;\n\
               fi;\n\
               echo \"{\\\"method\\\":\\\"item/agentMessage/delta\\\",\\\"params\\\":{\\\"threadId\\\":\\\"thread-persistent\\\",\\\"turnId\\\":\\\"turn-$n\\\",\\\"itemId\\\":\\\"answer-$n\\\",\\\"delta\\\":\\\"turn-$n\\\"}}\";\n\
               echo \"{\\\"method\\\":\\\"item/completed\\\",\\\"params\\\":{\\\"threadId\\\":\\\"thread-persistent\\\",\\\"turnId\\\":\\\"turn-$n\\\",\\\"item\\\":{\\\"type\\\":\\\"agentMessage\\\",\\\"id\\\":\\\"answer-$n\\\",\\\"text\\\":\\\"turn-$n\\\"}}}\";\n\
               echo \"{\\\"method\\\":\\\"turn/completed\\\",\\\"params\\\":{\\\"threadId\\\":\\\"thread-persistent\\\",\\\"turn\\\":{\\\"id\\\":\\\"turn-$n\\\",\\\"status\\\":\\\"completed\\\",\\\"error\\\":null}}}\" ;;\n\
           esac\n\
         done\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
    let session = spawn_codex_session(
        sink.clone() as Arc<dyn EventSink>,
        &script.to_string_lossy(),
        &dir,
        None,
        None,
        Vec::new(),
        CliRunOpts::default(),
    )
    .unwrap();
    let first = session
        .start_turn("one".into(), Vec::new(), sink.clone() as Arc<dyn EventSink>)
        .unwrap()
        .await
        .unwrap();
    assert_eq!(first.resume_id.as_deref(), Some("thread-persistent"));
    assert!(first.messages.iter().any(|message| {
        message["content"]
            .as_array()
            .is_some_and(|content| content.iter().any(|block| block["text"] == json!("turn-1")))
    }));
    assert!(sink.0.lock().unwrap().iter().any(|event| {
        event["assistantMessageEvent"]["type"] == json!("text_delta")
            && event["assistantMessageEvent"]["delta"] == json!("turn-1")
    }));
    assert!(
        session.is_alive(),
        "turn/completed must not stop app-server"
    );

    let second = session
        .start_turn("two".into(), Vec::new(), sink.clone() as Arc<dyn EventSink>)
        .unwrap()
        .await
        .unwrap();
    assert!(second.messages.iter().any(|message| {
        message["content"]
            .as_array()
            .is_some_and(|content| content.iter().any(|block| block["text"] == json!("turn-2")))
    }));
    assert!(session.is_alive());

    session.shutdown();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn codex_app_server_steers_and_compacts_with_native_rpc() {
    let dir = std::env::temp_dir().join(format!(
        "cetus-codex-steer-compact-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("fake-codex.sh");
    std::fs::write(
        &script,
        "#!/bin/sh\n\
         while IFS= read -r line; do\n\
           case \"$line\" in\n\
             *'\"method\":\"initialize\"'*) echo '{\"id\":1,\"result\":{}}' ;;\n\
             *'\"method\":\"thread/start\"'*) echo '{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread-native\"}}}' ;;\n\
             *'\"method\":\"skills/list\"'*) echo '{\"id\":3,\"result\":{\"data\":[]}}' ;;\n\
             *'\"method\":\"turn/start\"'*)\n\
               echo '{\"id\":10,\"result\":{\"turn\":{\"id\":\"turn-native\"}}}';\n\
               echo '{\"method\":\"item/agentMessage/delta\",\"params\":{\"itemId\":\"answer-1\",\"delta\":\"before steer\"}}' ;;\n\
             *'\"method\":\"turn/steer\"'*)\n\
               echo '{\"id\":11,\"result\":{}}';\n\
               echo '{\"method\":\"item/started\",\"params\":{\"item\":{\"type\":\"userMessage\",\"id\":\"steer-1\",\"content\":[{\"type\":\"text\",\"text\":\"redirect\"}]}}}';\n\
               echo '{\"method\":\"item/completed\",\"params\":{\"item\":{\"type\":\"agentMessage\",\"id\":\"answer-2\",\"text\":\"after steer\"}}}';\n\
               echo '{\"method\":\"turn/completed\",\"params\":{\"turn\":{\"id\":\"turn-native\",\"status\":\"completed\",\"error\":null}}}' ;;\n\
             *'\"method\":\"thread/compact/start\"'*)\n\
               echo '{\"id\":12,\"result\":{}}';\n\
               echo '{\"method\":\"item/started\",\"params\":{\"item\":{\"type\":\"contextCompaction\",\"id\":\"compact-1\"}}}';\n\
               echo '{\"method\":\"item/completed\",\"params\":{\"item\":{\"type\":\"contextCompaction\",\"id\":\"compact-1\"}}}' ;;\n\
           esac\n\
         done\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
    let session = spawn_codex_session(
        sink.clone() as Arc<dyn EventSink>,
        &script.to_string_lossy(),
        &dir,
        None,
        None,
        Vec::new(),
        CliRunOpts::default(),
    )
    .unwrap();
    let outcome = session
        .start_turn(
            "begin".into(),
            Vec::new(),
            sink.clone() as Arc<dyn EventSink>,
        )
        .unwrap();
    let observed = sink.clone();
    for _ in 0..200 {
        if observed
            .0
            .lock()
            .unwrap()
            .iter()
            .any(|event| event["assistantMessageEvent"]["delta"] == json!("before steer"))
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let steer_message = json!({
        "role": "user",
        "content": [{ "type": "text", "text": "redirect" }],
    });
    session
        .steer("redirect".into(), Vec::new(), steer_message.clone())
        .unwrap();
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), outcome)
        .await
        .expect("native steer should let the turn complete")
        .unwrap();
    assert!(outcome.messages.contains(&steer_message));
    assert!(serde_json::to_string(&outcome.messages)
        .unwrap()
        .contains("after steer"));

    session.compact("manual").await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let events = sink.0.lock().unwrap();
    assert!(events
        .iter()
        .any(|event| event["type"] == "compaction_start"));
    assert!(events
        .iter()
        .any(|event| { event["type"] == "compaction_end" && event["aborted"] == json!(false) }));

    session.shutdown();
    drop(events);
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn codex_app_server_surfaces_and_answers_reverse_rpc_requests() {
    let dir = std::env::temp_dir().join(format!(
        "cetus-codex-server-request-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("fake-codex.sh");
    std::fs::write(
        &script,
        "#!/bin/sh\n\
         while IFS= read -r line; do\n\
           case \"$line\" in\n\
             *'\"method\":\"initialize\"'*) echo '{\"id\":1,\"result\":{}}' ;;\n\
             *'\"method\":\"thread/start\"'*) echo '{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread-rpc\"}}}' ;;\n\
             *'\"method\":\"skills/list\"'*) echo '{\"id\":3,\"result\":{\"data\":[]}}' ;;\n\
             *'\"method\":\"turn/start\"'*)\n\
               echo '{\"id\":10,\"result\":{\"turn\":{\"id\":\"turn-rpc\"}}}';\n\
               echo '{\"method\":\"mcpServer/elicitation/request\",\"id\":\"request-1\",\"params\":{\"threadId\":\"thread-rpc\",\"turnId\":\"turn-rpc\",\"serverName\":\"codex_apps\",\"mode\":\"form\",\"message\":\"Read repository PRs directly\",\"requestedSchema\":{\"type\":\"object\",\"properties\":{}},\"_meta\":{\"codex_approval_kind\":\"tool_suggestion\",\"tool_type\":\"plugin\",\"tool_id\":\"github@openai-curated-remote\",\"tool_name\":\"GitHub\",\"install_url\":\"https://example.test/install\"}}}' ;;\n\
             *'\"method\":\"plugin/install\"'*) echo '{\"id\":11,\"result\":{\"authPolicy\":\"NONE\",\"appsNeedingAuth\":[]}}' ;;\n\
             *'\"id\":\"request-1\",\"result\"'*)\n\
               echo '{\"method\":\"serverRequest/resolved\",\"params\":{\"threadId\":\"thread-rpc\",\"requestId\":\"request-1\"}}';\n\
               echo '{\"method\":\"item/completed\",\"params\":{\"item\":{\"type\":\"agentMessage\",\"id\":\"answer-rpc\",\"text\":\"continued\"}}}';\n\
               echo '{\"method\":\"turn/completed\",\"params\":{\"turn\":{\"id\":\"turn-rpc\",\"status\":\"completed\",\"error\":null}}}' ;;\n\
           esac\n\
         done\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
    let session = spawn_codex_session(
        sink.clone() as Arc<dyn EventSink>,
        &script.to_string_lossy(),
        &dir,
        None,
        None,
        Vec::new(),
        CliRunOpts::default(),
    )
    .unwrap();
    let outcome = session
        .start_turn(
            "suggest a plugin".into(),
            Vec::new(),
            sink.clone() as Arc<dyn EventSink>,
        )
        .unwrap();

    let responder = session.clone();
    let observed = sink.clone();
    tokio::spawn(async move {
        loop {
            let ready = observed.0.lock().unwrap().iter().any(|event| {
                event["type"] == json!("cli_control_request")
                    && event["requestId"] == json!("request-1")
            });
            if ready {
                responder
                    .install_plugin_and_respond(
                        json!("request-1"),
                        json!({ "action": "accept", "content": {}, "_meta": null }),
                        "github".to_string(),
                        "openai-curated-remote".to_string(),
                    )
                    .await
                    .unwrap();
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    });

    let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), outcome)
        .await
        .expect("turn should continue after the host response")
        .unwrap();
    let events = sink.0.lock().unwrap();
    let request = events
        .iter()
        .find(|event| event["type"] == json!("cli_control_request"))
        .expect("reverse request should reach the UI");
    assert_eq!(request["requestKind"], json!("mcp_elicitation"));
    assert_eq!(request["input"]["_meta"]["tool_name"], json!("GitHub"));
    assert!(events.iter().any(|event| {
        event["type"] == json!("cli_control_resolved") && event["requestId"] == json!("request-1")
    }));
    assert!(outcome.messages.iter().any(|message| {
        message["content"]
            .as_array()
            .is_some_and(|content| content.iter().any(|block| block["text"] == "continued"))
    }));

    session.shutdown();
    drop(events);
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let _ = std::fs::remove_dir_all(&dir);
}

/// A tool-suggestion elicitation nobody answers (cron run, lost card) must
/// not wedge the turn: past TOOL_SUGGESTION_TIMEOUT the session declines it
/// on the user's behalf and the turn continues to completion.
#[tokio::test]
async fn codex_auto_declines_unanswered_tool_suggestion() {
    let dir = std::env::temp_dir().join(format!(
        "cetus-codex-suggestion-timeout-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("fake-codex.sh");
    std::fs::write(
        &script,
        "#!/bin/sh\n\
         while IFS= read -r line; do\n\
           case \"$line\" in\n\
             *'\"method\":\"initialize\"'*) echo '{\"id\":1,\"result\":{}}' ;;\n\
             *'\"method\":\"thread/start\"'*) echo '{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread-timeout\"}}}' ;;\n\
             *'\"method\":\"skills/list\"'*) echo '{\"id\":3,\"result\":{\"data\":[]}}' ;;\n\
             *'\"method\":\"turn/start\"'*)\n\
               echo '{\"id\":10,\"result\":{\"turn\":{\"id\":\"turn-timeout\"}}}';\n\
               echo '{\"method\":\"mcpServer/elicitation/request\",\"id\":\"request-9\",\"params\":{\"threadId\":\"thread-timeout\",\"turnId\":\"turn-timeout\",\"serverName\":\"codex_apps\",\"mode\":\"form\",\"message\":\"Read repository PRs directly\",\"requestedSchema\":{\"type\":\"object\",\"properties\":{}},\"_meta\":{\"codex_approval_kind\":\"tool_suggestion\",\"tool_type\":\"plugin\",\"tool_id\":\"github@openai-curated-remote\",\"tool_name\":\"GitHub\",\"install_url\":\"https://example.test/install\"}}}' ;;\n\
             *'\"id\":\"request-9\"'*'decline'*)\n\
               echo '{\"method\":\"serverRequest/resolved\",\"params\":{\"threadId\":\"thread-timeout\",\"requestId\":\"request-9\"}}';\n\
               echo '{\"method\":\"item/completed\",\"params\":{\"item\":{\"type\":\"agentMessage\",\"id\":\"answer-timeout\",\"text\":\"continued without plugin\"}}}';\n\
               echo '{\"method\":\"turn/completed\",\"params\":{\"turn\":{\"id\":\"turn-timeout\",\"status\":\"completed\",\"error\":null}}}' ;;\n\
           esac\n\
         done\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
    let session = spawn_codex_session(
        sink.clone() as Arc<dyn EventSink>,
        &script.to_string_lossy(),
        &dir,
        None,
        None,
        Vec::new(),
        CliRunOpts::default(),
    )
    .unwrap();
    // Nobody answers the suggestion — the session must decline it itself.
    let outcome = session
        .start_turn(
            "suggest a plugin".into(),
            Vec::new(),
            sink.clone() as Arc<dyn EventSink>,
        )
        .unwrap();
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), outcome)
        .await
        .expect("turn should continue after the auto-decline")
        .unwrap();

    let events = sink.0.lock().unwrap();
    assert!(events.iter().any(|event| {
        event["type"] == json!("cli_control_request") && event["requestId"] == json!("request-9")
    }));
    assert!(events.iter().any(|event| {
        event["type"] == json!("cli_control_resolved") && event["requestId"] == json!("request-9")
    }));
    assert!(outcome.messages.iter().any(|message| {
        message["content"].as_array().is_some_and(|content| {
            content
                .iter()
                .any(|block| block["text"] == "continued without plugin")
        })
    }));

    session.shutdown();
    drop(events);
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let _ = std::fs::remove_dir_all(&dir);
}
