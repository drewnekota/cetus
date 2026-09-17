use super::*;

#[test]
fn acp_updates_translate_text_tools_and_commands() {
    for backend in [
        CliBackend::OpenCode,
        CliBackend::Grok,
        CliBackend::Kimi,
        CliBackend::Dsh,
    ] {
        let mut tr = EventTranslator::new(backend);
        let mut events = tr.start();
        events.extend(tr.on_acp_update(&json!({
            "sessionUpdate": "agent_thought_chunk",
            "content": { "type": "text", "text": "checking" }
        })));
        events.extend(tr.on_acp_update(&json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": "hello" }
        })));
        events.extend(tr.on_acp_update(&json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "tool-1",
            "title": "Read file",
            "kind": "read",
            "status": "in_progress",
            "rawInput": { "path": "README.md" }
        })));
        events.extend(tr.on_acp_update(&json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "tool-1",
            "status": "completed",
            "rawOutput": "contents"
        })));
        events.extend(tr.on_acp_update(&json!({
            "sessionUpdate": "available_commands_update",
            "availableCommands": [{
                "name": "review",
                "description": "Review changes",
                "input": "[path]"
            }]
        })));
        events.extend(tr.finish(None));

        let event_types = types(&events);
        assert!(event_types.contains(&"message_update:thinking_delta".to_string()));
        assert!(event_types.contains(&"message_update:text_delta".to_string()));
        assert!(event_types.contains(&"message_update:toolcall_end".to_string()));
        assert!(event_types.contains(&"tool_execution_start".to_string()));
        assert!(event_types.contains(&"tool_execution_end".to_string()));
        assert!(event_types.contains(&"cli_commands".to_string()));
        assert_eq!(
            event_types.last().map(String::as_str),
            Some("agent_settled")
        );
        let messages = tr.take_messages();
        assert!(messages
            .iter()
            .any(|message| message.to_string().contains("hello")));
        assert!(messages
            .iter()
            .any(|message| message.to_string().contains("contents")));
    }
}

#[test]
fn acp_permission_never_upgrades_a_deny_into_an_allow() {
    let params = json!({ "options": [
        { "optionId": "always", "kind": "allow_always" },
        { "optionId": "once", "kind": "allow_once" },
        { "optionId": "no", "kind": "reject_once" },
    ]});
    // Once-scoped wins, so one Allow never becomes a standing grant.
    assert_eq!(
        acp_permission_response(&params, true)["outcome"]["optionId"],
        json!("once")
    );
    assert_eq!(
        acp_permission_response(&params, false)["outcome"]["optionId"],
        json!("no")
    );

    // An agent offering nothing to reject with must not have the first
    // (allowing) option picked on its behalf.
    let allow_only = json!({ "options": [{ "optionId": "yes", "kind": "allow_once" }] });
    assert_eq!(
        acp_permission_response(&allow_only, false),
        json!({ "outcome": { "outcome": "cancelled" } })
    );
    let unknown_kinds = json!({ "options": [{ "optionId": "weird", "kind": "proceed" }] });
    assert_eq!(
        acp_permission_response(&unknown_kinds, false),
        json!({ "outcome": { "outcome": "cancelled" } })
    );
    assert_eq!(
        acp_permission_response(&json!({}), true),
        json!({ "outcome": { "outcome": "cancelled" } })
    );
}

#[test]
fn acp_stop_reasons_surface_only_when_abnormal() {
    let reason = |value: &str| acp_stop_reason_error(&json!({ "result": { "stopReason": value } }));
    assert_eq!(reason("end_turn"), None);
    assert_eq!(reason("cancelled"), None);
    assert!(reason("refusal").unwrap().contains("declined"));
    assert!(reason("max_tokens").unwrap().contains("token limit"));
    assert!(reason("something_new").unwrap().contains("something_new"));
    assert_eq!(acp_stop_reason_error(&json!({ "result": {} })), None);
}

#[test]
fn acp_command_hints_read_the_object_form() {
    let event = acp_commands_event(&json!({
        "availableCommands": [
            { "name": "review", "description": "Review", "input": { "hint": "[path]" } },
            { "name": "plain" },
        ]
    }));
    assert_eq!(event["commands"][0]["argumentHint"], json!("[path]"));
    assert_eq!(event["commands"][0]["description"], json!("Review"));
    assert_eq!(event["commands"][1]["argumentHint"], json!(""));
}

#[test]
fn native_acp_runtime_descriptors_are_stable() {
    assert_eq!(CliBackend::from_id("opencode"), Some(CliBackend::OpenCode));
    assert_eq!(CliBackend::OpenCode.default_bin(), "opencode");
    assert_eq!(CliBackend::OpenCode.acp_args(), ["acp"]);
    assert_eq!(CliBackend::from_id("grok"), Some(CliBackend::Grok));
    assert_eq!(CliBackend::Grok.acp_args(), ["agent", "stdio"]);
    assert_eq!(CliBackend::from_id("kimi"), Some(CliBackend::Kimi));
    assert_eq!(CliBackend::Kimi.acp_args(), ["acp"]);
}

#[cfg(unix)]
#[tokio::test]
async fn acp_session_end_to_end_with_permission_and_tool_updates() {
    use std::os::unix::fs::PermissionsExt;

    let dir = std::env::temp_dir().join(format!(
        "cetus-acp-e2e-{}-{}",
        std::process::id(),
        ARTIFACT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("fake-acp.py");
    std::fs::write(
        &script,
        r#"#!/usr/bin/env python3
import json, sys
prompt_id = None
for raw in sys.stdin:
    msg = json.loads(raw)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc":"2.0","id":msg["id"],"result":{
            "protocolVersion":1,
            "agentCapabilities":{"loadSession":True}
        }}), flush=True)
    elif method == "session/new":
        print(json.dumps({"jsonrpc":"2.0","id":msg["id"],"result":{
            "sessionId":"fake-session"
        }}), flush=True)
    elif method == "session/prompt":
        prompt_id = msg["id"]
        sid = msg["params"]["sessionId"]
        print(json.dumps({"jsonrpc":"2.0","method":"session/update","params":{
            "sessionId":sid,
            "update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"ACP "}}
        }}), flush=True)
        print(json.dumps({"jsonrpc":"2.0","id":90,"method":"session/request_permission","params":{
            "sessionId":sid,
            "toolCall":{"toolCallId":"tool-1","title":"Run check","kind":"execute"},
            "options":[
                {"optionId":"allow-once","name":"Allow","kind":"allow_once"},
                {"optionId":"reject-once","name":"Reject","kind":"reject_once"}
            ]
        }}), flush=True)
    elif msg.get("id") == 90:
        sid = "fake-session"
        print(json.dumps({"jsonrpc":"2.0","method":"session/update","params":{
            "sessionId":sid,
            "update":{"sessionUpdate":"tool_call","toolCallId":"tool-1","title":"Run check",
                      "kind":"execute","status":"completed","rawInput":{"command":"true"},
                      "rawOutput":"ok"}
        }}), flush=True)
        print(json.dumps({"jsonrpc":"2.0","method":"session/update","params":{
            "sessionId":sid,
            "update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"works"}}
        }}), flush=True)
        print(json.dumps({"jsonrpc":"2.0","id":prompt_id,"result":{"stopReason":"end_turn"}}), flush=True)
"#,
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

    for backend in [CliBackend::OpenCode, CliBackend::Grok, CliBackend::Kimi] {
        let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
        let session = spawn_acp_session(
            backend,
            &script.to_string_lossy(),
            &dir,
            Some(dir.join("artifacts")),
            Some(format!("conv-{}", backend.as_str())),
            Vec::new(),
            CliRunOpts {
                bypass_approvals: false,
                ..Default::default()
            },
        )
        .unwrap();
        let outcome_rx = session
            .start_turn(
                "test".into(),
                Vec::new(),
                sink.clone() as Arc<dyn EventSink>,
            )
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if sink
                    .0
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|event| event["type"] == "cli_control_request")
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("ACP permission request did not arrive");
        session.respond_permission(json!(90), true).unwrap();
        let outcome = tokio::time::timeout(Duration::from_secs(10), outcome_rx)
            .await
            .expect("ACP turn timed out")
            .expect("ACP outcome channel closed");
        session.shutdown();

        assert_eq!(outcome.resume_id.as_deref(), Some("fake-session"));
        assert!(outcome.streamed);
        let messages = serde_json::to_string(&outcome.messages).unwrap();
        assert!(
            messages.contains("ACP ") && messages.contains("works"),
            "{}: {messages}",
            backend.as_str()
        );
        assert!(
            messages.contains("\"ok\""),
            "{}: {messages}",
            backend.as_str()
        );
        let events = sink.0.lock().unwrap();
        let event_types = types(&events);
        assert!(event_types.contains(&"cli_control_request".to_string()));
        assert!(event_types.contains(&"tool_execution_end".to_string()));
        assert_eq!(
            event_types.last().map(String::as_str),
            Some("agent_settled")
        );
    }
    let _ = std::fs::remove_dir_all(dir);
}

/// An agent that can't `session/load` starts an empty session, so the host's
/// cold-start preamble has to ride the first prompt or the conversation
/// silently loses its context. Also covers the two things an agent does
/// before any turn exists: announcing its commands, and (badly behaved)
/// asking for permission.
#[cfg(unix)]
#[tokio::test]
async fn acp_cold_start_replays_context_commands_and_cancels_orphan_requests() {
    use std::os::unix::fs::PermissionsExt;

    let dir = std::env::temp_dir().join(format!(
        "cetus-acp-cold-{}-{}",
        std::process::id(),
        ARTIFACT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("fake-acp-cold.py");
    std::fs::write(
        &script,
        r#"#!/usr/bin/env python3
import json, sys
orphan = "unanswered"
for raw in sys.stdin:
    msg = json.loads(raw)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc":"2.0","id":msg["id"],"result":{
            "protocolVersion":1,
            "agentCapabilities":{"loadSession":False}
        }}), flush=True)
        # Reverse request before any turn exists — must not wedge the handshake.
        print(json.dumps({"jsonrpc":"2.0","id":91,"method":"session/request_permission","params":{
            "sessionId":"fresh-session",
            "toolCall":{"toolCallId":"t0","title":"Early"},
            "options":[{"optionId":"allow-once","kind":"allow_once"}]
        }}), flush=True)
    elif method == "session/new":
        print(json.dumps({"jsonrpc":"2.0","id":msg["id"],"result":{
            "sessionId":"fresh-session"
        }}), flush=True)
        # Commands are announced here, long before the first turn's sink exists.
        print(json.dumps({"jsonrpc":"2.0","method":"session/update","params":{
            "sessionId":"fresh-session",
            "update":{"sessionUpdate":"available_commands_update","availableCommands":[
                {"name":"review","description":"Review","input":{"hint":"[path]"}}
            ]}
        }}), flush=True)
    elif msg.get("id") == 91:
        orphan = json.dumps(msg.get("result") or msg.get("error"))
    elif method == "session/prompt":
        text = msg["params"]["prompt"][0]["text"]
        print(json.dumps({"jsonrpc":"2.0","method":"session/update","params":{
            "sessionId":"fresh-session",
            "update":{"sessionUpdate":"agent_message_chunk",
                      "content":{"type":"text","text":"saw:" + text + "|orphan:" + orphan}}
        }}), flush=True)
        print(json.dumps({"jsonrpc":"2.0","id":msg["id"],"result":{"stopReason":"end_turn"}}), flush=True)
"#,
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

    let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
    let session = spawn_acp_session(
        CliBackend::OpenCode,
        &script.to_string_lossy(),
        &dir,
        None,
        Some("conv-cold".into()),
        Vec::new(),
        CliRunOpts {
            bypass_approvals: true,
            // A token left over from a process that no longer exists.
            resume: Some("stale-session".into()),
            cold_start_preamble: Some("HANDOFF_MARKER".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let outcome_rx = session
        .start_turn("hi".into(), Vec::new(), sink.clone() as Arc<dyn EventSink>)
        .unwrap();
    let outcome = tokio::time::timeout(Duration::from_secs(10), outcome_rx)
        .await
        .expect("ACP cold-start turn timed out")
        .expect("ACP outcome channel closed");
    session.shutdown();

    // A fresh session id replaces the stale one...
    assert_eq!(outcome.resume_id.as_deref(), Some("fresh-session"));
    let messages = serde_json::to_string(&outcome.messages).unwrap();
    // ...and the context handoff went with the first prompt.
    assert!(messages.contains("HANDOFF_MARKER"), "{messages}");
    // The pre-turn permission request was answered, not dropped.
    assert!(messages.contains("cancelled"), "{messages}");

    let events = sink.0.lock().unwrap();
    let commands = events
        .iter()
        .find(|event| event["type"] == "cli_commands")
        .expect("commands announced before the turn should replay into it");
    assert_eq!(commands["commands"][0]["name"], json!("review"));
    assert_eq!(commands["commands"][0]["argumentHint"], json!("[path]"));
    drop(events);
    let _ = std::fs::remove_dir_all(dir);
}

/// Real native-ACP smoke test. Run manually with:
/// `cargo test -p cetus-bridge live_opencode_acp_smoke -- --ignored --nocapture`.
#[tokio::test]
#[ignore]
async fn live_opencode_acp_smoke() {
    let dir = std::env::temp_dir().join("cetus-live-opencode-acp");
    std::fs::create_dir_all(&dir).unwrap();
    let sink = Arc::new(TestSink(std::sync::Mutex::new(Vec::new())));
    let session = match spawn_acp_session(
        CliBackend::OpenCode,
        "opencode",
        &dir,
        Some(dir.join("artifacts")),
        Some("live-opencode".into()),
        std::env::vars().collect(),
        CliRunOpts {
            bypass_approvals: true,
            ..Default::default()
        },
    ) {
        Ok(session) => session,
        Err(error) => {
            eprintln!("opencode unavailable; skipping: {error}");
            return;
        }
    };
    let outcome = tokio::time::timeout(
        Duration::from_secs(180),
        session
            .start_turn(
                "Reply with exactly CETUS_ACP_OK. Do not use tools.".into(),
                Vec::new(),
                sink.clone() as Arc<dyn EventSink>,
            )
            .unwrap(),
    )
    .await
    .expect("live OpenCode ACP turn timed out")
    .expect("live OpenCode outcome channel closed");
    session.shutdown();
    let messages = serde_json::to_string(&outcome.messages).unwrap();
    eprintln!("OpenCode ACP messages: {messages}");
    assert!(messages.contains("CETUS_ACP_OK"), "{messages}");
}
