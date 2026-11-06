use super::*;

#[test]
fn transient_agent_error_classification() {
    // The auto-retry class: rate-limit bursts and upstream overloads.
    assert!(is_transient_agent_error(
        "exceeded retry limit, last status: 429 Too Many Requests, request id: fd69baec"
    ));
    assert!(is_transient_agent_error("API Error: 529 Overloaded"));
    assert!(is_transient_agent_error("500 Internal Server Error"));
    // Quota exhaustion mentions limits too but holds until reset — no retry.
    assert!(!is_transient_agent_error(
        "Claude AI usage limit reached|1755400000"
    ));
    assert!(!is_transient_agent_error(
        "Your credit balance is too low to access the Anthropic API"
    ));
    // Unclassified failures stay with the user.
    assert!(!is_transient_agent_error("agent reported an error"));
    assert!(!is_transient_agent_error(
        "Codex app-server exited unexpectedly"
    ));
}

#[test]
fn agent_error_hint_matches_known_auth_failures() {
    assert!(
        agent_error_hint("Missing environment variable: `OPENAI_API_KEY`.")
            .is_some_and(|h| h.contains("codex login"))
    );
    assert!(agent_error_hint("Invalid API key · Please run /login")
        .is_some_and(|h| h.contains("/login")));
    assert!(agent_error_hint("stream closed unexpectedly").is_none());
}

#[test]
fn agent_error_bubble_carries_hint() {
    let mut tr = EventTranslator::new(CliBackend::Codex);
    let events = tr.finish(Some("Missing environment variable: `OPENAI_API_KEY`."));
    let text = serde_json::to_string(&events).unwrap();
    assert!(text.contains("agent error"), "{events:?}");
    assert!(text.contains("codex login"), "{events:?}");
}

#[test]
fn finish_flushes_blocks_still_streaming_on_abort() {
    // A turn killed mid-delta (Stop / codex-style steer interrupt) never
    // sees the open block's content_block_stop — finish() must settle it
    // so the partial text survives on screen and in the transcript.
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"message_start","message":{"role":"assistant","content":[]}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial answ"}}}"#);

    let ev = tr.finish(None);
    assert_eq!(
        types(&ev),
        vec![
            "message_update:text_end",
            "message_end",
            "agent_end",
            "agent_settled"
        ]
    );
    assert_eq!(
        ev[0]["assistantMessageEvent"]["content"],
        json!("partial answ")
    );
    let messages = tr.take_messages();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["content"][0]["text"], json!("partial answ"));
}

#[test]
fn turn_open_and_close_events() {
    // message_start is deferred to the first content event, so a turn that
    // never produced content opens no bubble and closes with the run-end
    // pair (agent_end + the settle signal) alone.
    let mut tr = EventTranslator::new(CliBackend::Codex);
    assert_eq!(types(&tr.start()), vec!["agent_start"]);
    assert_eq!(types(&tr.finish(None)), vec!["agent_end", "agent_settled"]);

    let mut tr = EventTranslator::new(CliBackend::Codex);
    let ev = tr.finish(Some("boom"));
    // an error turns into a visible text block before close — which opens
    // the (deferred) bubble first
    assert_eq!(
        types(&ev),
        vec![
            "message_start",
            "message_update:text_start",
            "message_update:text_delta",
            "message_update:text_end",
            "message_end",
            "agent_end",
            "agent_settled"
        ]
    );
}

#[test]
fn backend_ids_round_trip() {
    assert_eq!(CliBackend::from_id("codex"), Some(CliBackend::Codex));
    assert_eq!(
        CliBackend::from_id("claude-code"),
        Some(CliBackend::ClaudeCode)
    );
    assert_eq!(CliBackend::from_id("pi"), None);
    assert_eq!(CliBackend::Codex.as_str(), "codex");
    assert_eq!(CliBackend::from_id("dsh"), Some(CliBackend::Dsh));
    assert_eq!(CliBackend::Dsh.default_bin(), "dsh");
}

#[test]
fn auth_expiry_stderr_condenses_to_hint() {
    let codex_dump = r#"2026-07-06T09:00:11Z ERROR codex_models_manager::manager: failed to refresh available models: unexpected status 401 Unauthorized: Your authentication token has been invalidated. Please try signing in again., auth error code: token_invalidated
2026-07-06T09:00:15Z ERROR codex_login::auth::manager: Failed to refresh token: 401 Unauthorized: { "code": "refresh_token_invalidated" }"#;
    let hint = auth_expired_hint(CliBackend::Codex, codex_dump).unwrap();
    assert!(hint.contains("codex login"), "actionable: {hint}");
    assert!(hint.len() < 200, "short, not a log wall");
    assert_eq!(
        auth_expired_hint(CliBackend::Codex, "some unrelated panic"),
        None
    );
    let claude_hint = auth_expired_hint(CliBackend::ClaudeCode, "OAuth token has expired").unwrap();
    assert!(claude_hint.contains("/login"));
}

#[test]
fn messages_collect_for_persistence() {
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"command\":\"ls\"}"}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":1}}"#);
    tr.on_line(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"a.txt","is_error":false}]}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"message_start","message":{}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);
    tr.finish(None);
    let msgs = tr.take_messages();
    // assistant(thinking+toolCall) / toolResult / assistant(text)
    assert_eq!(msgs.len(), 3);
    assert_eq!(msgs[0]["role"], json!("assistant"));
    assert_eq!(msgs[0]["content"][1]["type"], json!("toolCall"));
    assert_eq!(msgs[1]["role"], json!("toolResult"));
    assert_eq!(msgs[1]["toolName"], json!("Bash"));
    assert_eq!(msgs[2]["content"][0]["text"], json!("done"));
}
