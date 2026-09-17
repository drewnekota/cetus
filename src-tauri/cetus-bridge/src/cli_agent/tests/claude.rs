use super::*;

#[test]
fn claude_reports_latest_request_context_occupancy() {
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
    assert!(tr
        .on_line(
            r#"{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-opus-4-6","usage":{"input_tokens":100,"cache_creation_input_tokens":20,"cache_read_input_tokens":30}}}}"#,
        )
        .is_empty());
    assert!(tr
        .on_line(
            r#"{"type":"stream_event","event":{"type":"message_delta","usage":{"output_tokens":5}}}"#,
        )
        .is_empty());
    let events = tr.on_line(
        r#"{"type":"result","subtype":"success","is_error":false,"modelUsage":{"claude-opus-4-6":{"contextWindow":200000}}}"#,
    );
    assert_eq!(types(&events), vec!["cli_context_usage"]);
    assert_eq!(events[0]["usedTokens"], json!(155));
    assert_eq!(events[0]["contextWindow"], json!(200000));
}

#[test]
fn claude_text_tool_and_result_translate() {
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
    // init carries the resume session id
    tr.on_line(r#"{"type":"system","subtype":"init","session_id":"sess-1","cwd":"/tmp"}"#);
    assert_eq!(tr.resume_id.as_deref(), Some("sess-1"));

    // a tool_use block streamed via partial events (captured shapes)
    let mut ev = Vec::new();
    ev.extend(tr.on_line(r#"{"type":"stream_event","event":{"type":"message_start","message":{"role":"assistant","content":[]}}}"#));
    ev.extend(tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool-9","name":"Bash","input":{}}}}"#));
    ev.extend(tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"command\": "}}}"#));
    ev.extend(tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"ls\"}"}}}"#));
    ev.extend(
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#),
    );
    // the first content event opens the assistant bubble (deferred
    // message_start — not emitted at spawn time)
    assert_eq!(
        types(&ev),
        vec![
            "message_start",
            "message_update:toolcall_start",
            "message_update:toolcall_end"
        ]
    );
    // the tool_use id + parsed input land on toolcall_end
    assert_eq!(
        ev[2]["assistantMessageEvent"]["toolCall"]["id"],
        json!("tool-9")
    );
    assert_eq!(
        ev[2]["assistantMessageEvent"]["toolCall"]["arguments"]["command"],
        json!("ls")
    );

    // cumulative assistant snapshots are ignored (partials already streamed)
    assert!(tr
        .on_line(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-9","name":"Bash","input":{"command":"ls"}}]}}"#)
        .is_empty());

    // its result comes back on a user message
    let ev = tr.on_line(
        r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-9","content":"file.txt","is_error":false}]}}"#,
    );
    assert_eq!(
        types(&ev),
        vec!["tool_execution_start", "tool_execution_end"]
    );
    assert_eq!(ev[1]["toolCallId"], json!("tool-9"));
    assert_eq!(ev[1]["result"]["content"][0]["text"], json!("file.txt"));

    // final answer text streams as deltas
    let mut ev = Vec::new();
    ev.extend(tr.on_line(r#"{"type":"stream_event","event":{"type":"message_start","message":{"role":"assistant","content":[]}}}"#));
    ev.extend(tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#));
    ev.extend(tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"do"}}}"#));
    ev.extend(tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ne"}}}"#));
    ev.extend(
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#),
    );
    assert_eq!(
        types(&ev),
        vec![
            "message_update:text_start",
            "message_update:text_delta",
            "message_update:text_delta",
            "message_update:text_end"
        ]
    );
    assert_eq!(ev[3]["assistantMessageEvent"]["content"], json!("done"));

    // result flags the turn as complete (bidirectional close signal)
    tr.on_line(r#"{"type":"result","subtype":"success","is_error":false,"result":"done"}"#);
    assert!(tr.saw_result);
    // …and content streamed, so it's the turn's real outcome.
    assert!(!tr.result_is_spurious());
}

#[test]
fn claude_bare_result_before_any_content_is_spurious() {
    // Captured from claude 2.1.201: resuming a session whose previous turn
    // left a background task running flushes a bare success `result`
    // before the stdin user message is processed. Honoring it would
    // swallow the prompt.
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
    tr.on_line(r#"{"type":"system","subtype":"init","session_id":"sess-1","cwd":"/tmp"}"#);
    tr.on_line(r#"{"type":"result","subtype":"success","is_error":false}"#);
    assert!(tr.saw_result);
    assert!(tr.result_is_spurious());

    // The runner skips it; the real turn then streams and closes normally.
    tr.saw_result = false;
    tr.on_line(r#"{"type":"stream_event","event":{"type":"message_start","message":{"role":"assistant","content":[]}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"300"}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);
    tr.on_line(r#"{"type":"result","subtype":"success","is_error":false,"result":"300"}"#);
    assert!(tr.saw_result);
    assert!(!tr.result_is_spurious());
}

#[test]
fn claude_steer_splits_turn_at_merge_point() {
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
    // Pre-steer content: one streamed text block.
    tr.on_line(r#"{"type":"stream_event","event":{"type":"message_start","message":{"role":"assistant","content":[]}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"before"}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);

    // The user steers mid-turn; claude merges it on its NEXT API request.
    let steer = json!({ "role": "user", "content": [{ "type": "text", "text": "授权了" }] });
    tr.queue_steer(steer.clone());

    // That next message_start closes the open bubble and splices the row.
    let ev = tr.on_line(r#"{"type":"stream_event","event":{"type":"message_start","message":{"role":"assistant","content":[]}}}"#);
    assert_eq!(types(&ev), vec!["message_end"]);
    assert_eq!(tr.messages.len(), 2);
    assert_eq!(tr.messages[0]["role"], json!("assistant"));
    assert_eq!(tr.messages[0]["content"][0]["text"], json!("before"));
    assert_eq!(tr.messages[1], steer);

    // Post-steer content opens a fresh bubble with indices from 0.
    let mut ev = Vec::new();
    ev.extend(tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#));
    ev.extend(tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"after"}}}"#));
    ev.extend(
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#),
    );
    assert_eq!(
        types(&ev),
        vec![
            "message_start",
            "message_update:text_start",
            "message_update:text_delta",
            "message_update:text_end"
        ]
    );
    assert_eq!(ev[1]["assistantMessageEvent"]["contentIndex"], json!(0));

    tr.on_line(r#"{"type":"result","subtype":"success","is_error":false,"result":"after"}"#);
    tr.finish(None);
    // Transcript order: pre-steer segment, user row, post-steer segment.
    let msgs = tr.take_messages();
    assert_eq!(msgs.len(), 3);
    assert_eq!(msgs[1]["role"], json!("user"));
    assert_eq!(msgs[2]["role"], json!("assistant"));
    assert_eq!(msgs[2]["content"][0]["text"], json!("after"));
}

#[test]
fn claude_steer_never_consumed_still_persists_on_finish() {
    // A steer written just as the turn's result raced it is read by claude
    // as a self-started continuation turn — the row must still land in the
    // transcript, after the turn's own content.
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"message_start","message":{"role":"assistant","content":[]}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"answer"}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);
    let steer = json!({ "role": "user", "content": [{ "type": "text", "text": "late" }] });
    tr.queue_steer(steer.clone());
    tr.on_line(r#"{"type":"result","subtype":"success","is_error":false,"result":"answer"}"#);
    tr.finish(None);
    let msgs = tr.take_messages();
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0]["role"], json!("assistant"));
    assert_eq!(msgs[1], steer);
}

#[test]
fn claude_error_result_with_no_content_is_not_spurious() {
    // A turn that fails before streaming anything (API refusal etc.) must
    // still close and surface the error, not spin waiting for more.
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
    tr.on_line(
        r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom"}"#,
    );
    assert!(tr.saw_result);
    assert!(!tr.result_is_spurious());
    assert_eq!(tr.result_error.as_deref(), Some("boom"));
}

#[test]
fn claude_synthetic_snapshot_renders_slash_command_output() {
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
    // Captured from claude 2.1.199: `/usage` (and /cost, /context, /compact)
    // is handled locally and arrives ONLY as a synthetic assistant snapshot
    // — no stream_event partials.
    let ev = tr.on_line(
        r#"{"type":"assistant","message":{"id":"m1","model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"Current session: 28% used"}]}}"#,
    );
    assert_eq!(
        types(&ev),
        vec![
            "message_start",
            "message_update:text_start",
            "message_update:text_delta",
            "message_update:text_end"
        ]
    );
    assert_eq!(
        ev[3]["assistantMessageEvent"]["content"],
        json!("Current session: 28% used")
    );
    // …and it persists as a normal assistant message for history replay.
    tr.finish(None);
    let msgs = tr.take_messages();
    assert_eq!(msgs.len(), 1);
    assert_eq!(
        msgs[0]["content"][0]["text"],
        json!("Current session: 28% used")
    );

    // A real-model snapshot is a fallback when this CLI emitted no
    // stream_event content at all.
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
    let fallback = tr.on_line(r#"{"type":"assistant","message":{"model":"claude-fable-5","content":[{"type":"text","text":"fallback"}]}}"#);
    assert_eq!(
        fallback[2]["assistantMessageEvent"]["delta"],
        json!("fallback")
    );

    // Once partial content was observed, its cumulative snapshot remains
    // redundant and must not duplicate the visible response.
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"dup"}}}"#);
    assert!(tr
        .on_line(r#"{"type":"assistant","message":{"model":"claude-fable-5","content":[{"type":"text","text":"dup"}]}}"#)
        .is_empty());
}

#[test]
fn claude_content_indices_are_monotonic() {
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hm"}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);
    // the API reuses low indices across messages; ours must stay monotonic
    let ev = tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}}"#);
    assert_eq!(ev[0]["assistantMessageEvent"]["contentIndex"], json!(1));
}

/// Adaptive-thinking sessions with display omitted stream signature-only
/// thinking blocks (start + signature_delta + stop, no thinking_delta).
/// Those must not open a block, emit events, or persist an empty
/// `thinking` entry — the UI would show a dead "Thinking, 0 chars" step.
#[test]
fn claude_signature_only_thinking_is_suppressed() {
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
    assert!(tr
        .on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}}"#)
        .is_empty());
    assert!(tr
        .on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}}"#)
        .is_empty());
    assert!(tr
        .on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#)
        .is_empty());
    // the next block still takes index 0 — the ghost consumed nothing
    let ev = tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}}"#);
    assert_eq!(
        ev.last().unwrap()["assistantMessageEvent"]["contentIndex"],
        json!(0)
    );
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hi"}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":1}}"#);
    tr.finish(None);
    let msgs = tr.take_messages();
    assert_eq!(msgs.len(), 1);
    assert_eq!(
        msgs[0]["content"],
        json!([{ "type": "text", "text": "hi" }])
    );
}

/// With a thinking display active the deltas carry text: thinking_start is
/// deferred to the first delta, then streams and persists normally.
#[test]
fn claude_thinking_with_text_streams_and_persists() {
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
    assert!(tr
        .on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}}"#)
        .is_empty());
    let ev = tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"let me see"}}}"#);
    let kinds: Vec<&str> = ev
        .iter()
        .filter_map(|e| e["assistantMessageEvent"]["type"].as_str())
        .collect();
    assert_eq!(kinds, vec!["thinking_start", "thinking_delta"]);
    let ev =
        tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);
    assert_eq!(
        ev[0]["assistantMessageEvent"]["type"],
        json!("thinking_end")
    );
    assert_eq!(
        ev[0]["assistantMessageEvent"]["content"],
        json!("let me see")
    );
    tr.finish(None);
    let msgs = tr.take_messages();
    assert_eq!(
        msgs[0]["content"],
        json!([{ "type": "thinking", "thinking": "let me see" }])
    );
}

#[test]
fn claude_control_request_forwards_to_ui() {
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
    // Captured from claude 2.1.198 (--permission-prompt-tool stdio).
    let ev = tr.on_line(
        r#"{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{"question":"Which color?","header":"Color","options":[{"label":"Red","description":"warm"}],"multiSelect":false}]},"tool_use_id":"toolu_1"}}"#,
    );
    assert_eq!(types(&ev), vec!["cli_control_request"]);
    assert_eq!(ev[0]["requestId"], json!("req-1"));
    assert_eq!(ev[0]["toolName"], json!("AskUserQuestion"));
    assert_eq!(
        ev[0]["input"]["questions"][0]["question"],
        json!("Which color?")
    );
    // the init handshake ack is swallowed
    assert!(tr
        .on_line(r#"{"type":"control_response","response":{"subtype":"success","request_id":"init-1","response":{}}}"#)
        .is_empty());
}

/// The quota heartbeat surfaces as a `cli_rate_limit` event carrying the
/// CLI's rate_limit_info verbatim — and, as housekeeping, must neither
/// open the assistant bubble nor count as turn activity.
#[test]
fn claude_rate_limit_event_forwards_info() {
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
    // Captured from claude 2.1.208.
    let line = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1784008800,"rateLimitType":"five_hour","utilization":0.85,"overageStatus":"rejected","isUsingOverage":false}}"#;
    let ev = tr.on_line(line);
    assert_eq!(types(&ev), vec!["cli_rate_limit"]);
    assert_eq!(ev[0]["info"]["status"], json!("allowed_warning"));
    assert_eq!(ev[0]["info"]["utilization"], json!(0.85));
    assert_eq!(ev[0]["info"]["resetsAt"], json!(1784008800i64));
    assert!(!tr.opened, "quota heartbeat must not open the bubble");
    assert!(!is_turn_activity(line));
}

/// The initialize ack's `commands` catalog (built-ins + skills, captured
/// from claude 2.x) surfaces as a `cli_commands` event for the slash menu.
#[test]
fn initialize_ack_commands_surface_for_slash_menu() {
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
    let ev = tr.on_line(
        r#"{"type":"control_response","response":{"subtype":"success","request_id":"init-1","response":{"commands":[{"name":"usage","description":"Show plan usage","argumentHint":"","aliases":["cost"]},{"name":"compact","description":"Free up context","argumentHint":"<instructions>"}]}}}"#,
    );
    assert_eq!(types(&ev), vec!["cli_commands"]);
    assert_eq!(ev[0]["commands"][0]["name"], json!("usage"));
    assert_eq!(ev[0]["commands"][0]["kind"], json!("command"));
    assert_eq!(
        ev[0]["commands"][1]["argumentHint"],
        json!("<instructions>")
    );
}

#[test]
fn claude_stdin_lines_shape() {
    let lines = claude_stdin_lines("hi", &[("image/png".into(), "AAAA".into())]);
    assert_eq!(lines.len(), 2);
    let init: Value = serde_json::from_str(&lines[0]).unwrap();
    assert_eq!(init["request"]["subtype"], json!("initialize"));
    let user: Value = serde_json::from_str(&lines[1]).unwrap();
    assert_eq!(user["message"]["content"][0]["text"], json!("hi"));
    assert_eq!(
        user["message"]["content"][1]["source"]["media_type"],
        json!("image/png")
    );
    let resp: Value = serde_json::from_str(&claude_control_response_line(
        "r1",
        &json!({"behavior":"allow"}),
    ))
    .unwrap();
    assert_eq!(resp["response"]["request_id"], json!("r1"));
    assert_eq!(resp["response"]["response"]["behavior"], json!("allow"));
}

#[test]
fn sidechain_lines_are_dropped() {
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
    // A subagent's own lines carry parent_tool_use_id and must never leak
    // into the main transcript. With no registered task to attach them to
    // (defensive: task_started missed), snapshots are dropped outright;
    // sidechain stream_events are always dropped (their block indexes
    // would collide with the parent's).
    assert!(tr.on_line(r#"{"type":"stream_event","parent_tool_use_id":"tp","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#).is_empty());
    assert!(tr.on_line(r#"{"type":"assistant","parent_tool_use_id":"tp","message":{"model":"claude-fable-5","content":[{"type":"text","text":"sub says hi"}]}}"#).is_empty());
    assert!(tr.on_line(r#"{"type":"user","parent_tool_use_id":"tp","message":{"content":[{"type":"tool_result","tool_use_id":"inner-1","content":"ls output","is_error":false}]}}"#).is_empty());
    assert!(tr.take_messages().is_empty());
    assert!(tr.assistant_blocks_empty());
}

#[test]
fn sidechain_activity_paints_steps_on_agent_card() {
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tA","name":"Agent","input":{}}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);
    tr.on_line(r#"{"type":"system","subtype":"task_started","task_id":"bg1","tool_use_id":"tA","description":"scan repo","subagent_type":"Explore"}"#);
    // The subagent calls a tool → a running step appears on the Agent card.
    let ev = tr.on_line(r#"{"type":"assistant","parent_tool_use_id":"tA","message":{"content":[{"type":"tool_use","id":"inner-1","name":"Bash","input":{"command":"ls -la","description":"List files"}}]}}"#);
    let update = ev
        .iter()
        .find(|e| e["type"] == "tool_execution_update")
        .unwrap();
    assert_eq!(update["toolCallId"], json!("tA"));
    let steps = &update["partialResult"]["details"]["subagent"]["steps"];
    assert_eq!(steps[0]["tool"], json!("Bash"));
    assert_eq!(steps[0]["detail"], json!("List files"));
    assert_eq!(steps[0]["done"], json!(false));
    // Its tool_result settles that step.
    let ev = tr.on_line(r#"{"type":"user","parent_tool_use_id":"tA","message":{"content":[{"type":"tool_result","tool_use_id":"inner-1","content":"ls output","is_error":false}]}}"#);
    let update = ev
        .iter()
        .find(|e| e["type"] == "tool_execution_update")
        .unwrap();
    assert_eq!(
        update["partialResult"]["details"]["subagent"]["steps"][0]["done"],
        json!(true)
    );
    // task_progress keeps carrying the accumulated steps.
    let ev = tr.on_line(r#"{"type":"system","subtype":"task_progress","task_id":"bg1","tool_use_id":"tA","description":"Reading main.rs"}"#);
    assert_eq!(
        ev[0]["partialResult"]["details"]["subagent"]["steps"][0]["tool"],
        json!("Bash")
    );
    // Nothing leaked into the main transcript.
    tr.finish(None);
    assert!(tr
        .take_messages()
        .iter()
        .all(|m| m["role"] != json!("toolResult")));
}

#[test]
fn task_notification_summary_is_the_report() {
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tA","name":"Agent","input":{}}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);
    tr.on_line(r#"{"type":"system","subtype":"task_started","task_id":"bg1","tool_use_id":"tA","description":"scan repo","subagent_type":"Explore"}"#);
    tr.on_line(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tA","content":[{"type":"text","text":"Async agent launched successfully. agentId: abc"}],"is_error":false}]}}"#);
    tr.on_line(r#"{"type":"assistant","parent_tool_use_id":"tA","message":{"content":[{"type":"tool_use","id":"inner-1","name":"Read","input":{"file_path":"main.rs"}}]}}"#);
    let ev = tr.on_line(r#"{"type":"system","subtype":"task_notification","task_id":"bg1","tool_use_id":"tA","status":"completed","summary":"Found 3 files: main.rs, a.txt, b.txt"}"#);
    let end = ev
        .iter()
        .find(|e| e["type"] == "tool_execution_end")
        .unwrap();
    assert_eq!(
        end["result"]["content"][0]["text"],
        json!("Found 3 files: main.rs, a.txt, b.txt")
    );
    assert_eq!(
        end["result"]["details"]["subagent"]["steps"][0]["tool"],
        json!("Read")
    );
    // The persisted row was rewritten with the report + step trace, so a
    // reloaded conversation replays the same card.
    tr.finish(None);
    let msgs = tr.take_messages();
    let row = msgs
        .iter()
        .find(|m| m["role"] == json!("toolResult"))
        .unwrap();
    assert_eq!(
        row["content"][0]["text"],
        json!("Found 3 files: main.rs, a.txt, b.txt")
    );
    assert_eq!(row["details"]["subagent"]["type"], json!("Explore"));
}

#[test]
fn background_subagent_lifecycle() {
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
    // Main agent calls the Agent tool.
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tA","name":"Agent","input":{}}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);
    // CLI reports the background task started…
    tr.on_line(r#"{"type":"system","subtype":"task_started","task_id":"bg1","tool_use_id":"tA","description":"scan repo","subagent_type":"Explore"}"#);
    assert!(tr.has_pending_tasks());
    // …and immediately answers the tool call with the internal launch ack.
    let ev = tr.on_line(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tA","content":[{"type":"text","text":"Async agent launched successfully. agentId: abc (internal ID - do not mention)"}],"is_error":false}]}}"#);
    let tys = types(&ev);
    assert!(
        tys.contains(&"tool_execution_update".to_string()),
        "{tys:?}"
    );
    assert!(
        !tys.contains(&"tool_execution_end".to_string()),
        "card must stay running: {tys:?}"
    );
    let update = ev
        .iter()
        .find(|e| e["type"] == "tool_execution_update")
        .unwrap();
    let shown = update["partialResult"]["content"][0]["text"]
        .as_str()
        .unwrap();
    assert!(
        shown.contains("Explore"),
        "clean status, not the ack blob: {shown}"
    );
    assert!(
        !shown.contains("agentId"),
        "internal metadata hidden: {shown}"
    );
    // Progress paints onto the same card.
    let ev = tr.on_line(r#"{"type":"system","subtype":"task_progress","task_id":"bg1","tool_use_id":"tA","description":"Running ls","subagent_type":"Explore"}"#);
    assert_eq!(ev[0]["type"], json!("tool_execution_update"));
    assert_eq!(ev[0]["toolCallId"], json!("tA"));
    // Intermediate result: the turn must NOT close while bg1 runs.
    tr.on_line(r#"{"type":"result","subtype":"success","is_error":false}"#);
    assert!(tr.saw_result && tr.has_pending_tasks());
    tr.saw_result = false; // what the runner does in this case
                           // Completion settles the card and releases the turn.
    let ev = tr.on_line(r#"{"type":"system","subtype":"task_notification","task_id":"bg1","tool_use_id":"tA","status":"completed"}"#);
    let end = ev
        .iter()
        .find(|e| e["type"] == "tool_execution_end")
        .unwrap();
    assert_eq!(end["toolCallId"], json!("tA"));
    assert_eq!(end["isError"], json!(false));
    assert!(!tr.has_pending_tasks());
    // The persisted toolResult row carries the final status, not the ack.
    tr.finish(None);
    let msgs = tr.take_messages();
    let row = msgs
        .iter()
        .find(|m| m["role"] == json!("toolResult"))
        .unwrap();
    assert_eq!(row["toolName"], json!("Agent"));
    let text = row["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("completed"), "{text}");
}

/// Every change to the live background-task set (start, progress text,
/// completion) must emit a `cli_background_tasks` snapshot — the standing
/// state behind the frontend's task strip. Tasks outlive model turns, so
/// paint on the launching card alone isn't enough.
#[test]
fn background_task_changes_emit_strip_snapshots() {
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tA","name":"Agent","input":{}}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);

    let ev = tr.on_line(r#"{"type":"system","subtype":"task_started","task_id":"bg1","tool_use_id":"tA","description":"scan repo","subagent_type":"Explore"}"#);
    let snap = ev
        .iter()
        .find(|e| e["type"] == "cli_background_tasks")
        .unwrap();
    assert_eq!(snap["tasks"][0]["taskId"], json!("bg1"));
    assert_eq!(snap["tasks"][0]["kind"], json!("Explore"));
    assert_eq!(snap["tasks"][0]["description"], json!("scan repo"));

    let ev = tr.on_line(r#"{"type":"system","subtype":"task_progress","task_id":"bg1","tool_use_id":"tA","description":"Running ls","subagent_type":"Explore"}"#);
    let snap = ev
        .iter()
        .find(|e| e["type"] == "cli_background_tasks")
        .unwrap();
    assert_eq!(snap["tasks"][0]["statusText"], json!("Running ls"));

    // A sidechain step changes the card's step list but not the strip —
    // no redundant snapshot.
    let ev = tr.on_line(r#"{"type":"assistant","parent_tool_use_id":"tA","message":{"content":[{"type":"tool_use","id":"inner-1","name":"Read","input":{"file_path":"main.rs"}}]}}"#);
    assert!(!types(&ev).contains(&"cli_background_tasks".to_string()));

    let ev = tr.on_line(r#"{"type":"system","subtype":"task_notification","task_id":"bg1","tool_use_id":"tA","status":"completed","summary":"done"}"#);
    let snap = ev
        .iter()
        .find(|e| e["type"] == "cli_background_tasks")
        .unwrap();
    assert_eq!(snap["tasks"], json!([]));
}

/// A Monitor rides the task lifecycle as `task_type: local_bash` (real
/// event shape captured from claude 2.x): it must show in the strip
/// snapshot, must NOT hold the model turn open (a persistent monitor can
/// live for hours), and a firing emits no notification — the task stays
/// live in the strip. The CLI's own `background_tasks_changed` list is
/// translated as the authoritative snapshot.
#[test]
fn monitor_stays_in_strip_without_holding_the_turn() {
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
    let ev = tr.on_line(r#"{"type":"system","subtype":"task_started","task_id":"b864cfibk","tool_use_id":"tM","description":"content change in /tmp/flag.txt","task_type":"local_bash"}"#);
    let snap = ev
        .iter()
        .find(|e| e["type"] == "cli_background_tasks")
        .unwrap();
    assert_eq!(snap["tasks"][0]["kind"], json!("Bash"));
    assert_eq!(
        snap["tasks"][0]["description"],
        json!("content change in /tmp/flag.txt")
    );
    // local_bash never holds the turn — the reply can settle while the
    // monitor keeps watching.
    assert!(!tr.has_pending_turn_tasks());

    // The CLI's authoritative list re-emits the same snapshot (this is
    // what a resumed process reports even when our registry is empty).
    let ev = tr.on_line(r#"{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"b864cfibk","task_type":"local_bash","description":"content change in /tmp/flag.txt"}]}"#);
    let snap = ev
        .iter()
        .find(|e| e["type"] == "cli_background_tasks")
        .unwrap();
    assert_eq!(snap["tasks"][0]["taskId"], json!("b864cfibk"));
    assert_eq!(snap["tasks"][0]["kind"], json!("Bash"));

    // Turn boundary: the live monitor survives into the next turn's
    // registry, so the strip stays truthful across replies.
    tr.begin_next_turn();
    assert_eq!(
        tr.background_tasks_snapshot()[0]["taskId"],
        json!("b864cfibk")
    );
}

/// The Workflow tool's launch ack has its own wording — it must keep the
/// card running and the task pending like the Agent tool's ack does.
/// (Matching only the Agent string settled the card "completed" and let
/// the runner kill the CLI while the workflow was still running.)
#[test]
fn workflow_launch_ack_keeps_task_pending() {
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tW","name":"Workflow","input":{}}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);
    tr.on_line(r#"{"type":"system","subtype":"task_started","task_id":"wf1","tool_use_id":"tW","description":"Deep research harness"}"#);
    let ev = tr.on_line(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tW","content":"Workflow launched in background. Task ID: wabc123\nSummary: Deep research harness\nTranscript dir: /tmp/x","is_error":false}]}}"#);
    let tys = types(&ev);
    assert!(
        tys.contains(&"tool_execution_update".to_string()),
        "{tys:?}"
    );
    assert!(
        !tys.contains(&"tool_execution_end".to_string()),
        "card must stay running: {tys:?}"
    );
    assert!(tr.has_pending_tasks(), "the runner must hold the turn open");
    let update = ev
        .iter()
        .find(|e| e["type"] == "tool_execution_update")
        .unwrap();
    let shown = update["partialResult"]["content"][0]["text"]
        .as_str()
        .unwrap();
    assert!(
        shown.starts_with("Workflow running in background"),
        "{shown}"
    );
    assert!(
        !shown.contains("Task ID"),
        "internal metadata hidden: {shown}"
    );
    // Completion notification carries the report and releases the turn.
    let ev = tr.on_line(r#"{"type":"system","subtype":"task_notification","task_id":"wf1","tool_use_id":"tW","status":"completed","summary":"the findings"}"#);
    let end = ev
        .iter()
        .find(|e| e["type"] == "tool_execution_end")
        .unwrap();
    assert_eq!(end["result"]["content"][0]["text"], json!("the findings"));
    assert!(!tr.has_pending_tasks());
}

/// Claude Code reports `Bash(run_in_background=true)` through the same
/// task lifecycle as agents, but its launch result has command-specific
/// wording and `task_type: local_bash` instead of `subagent_type`.
#[test]
fn background_bash_stays_running_until_notification() {
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tBash","name":"Bash","input":{}}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"command\":\"sleep 30\",\"description\":\"Monitor CI\",\"run_in_background\":true}"}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);
    tr.on_line(r#"{"type":"system","subtype":"task_started","task_id":"shell1","tool_use_id":"tBash","description":"Monitor CI","task_type":"local_bash"}"#);
    assert!(tr.has_pending_tasks());

    let ev = tr.on_line(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tBash","content":"Command running in background with ID: shell1. Output is being written to: /tmp/shell1.output. You will be notified when it completes.","is_error":false}]}}"#);
    let tys = types(&ev);
    assert!(
        tys.contains(&"tool_execution_update".to_string()),
        "{tys:?}"
    );
    assert!(
        !tys.contains(&"tool_execution_end".to_string()),
        "card must stay running: {tys:?}"
    );
    assert!(
        tr.has_pending_tasks(),
        "the runner must keep reading the monitor stream"
    );
    assert!(
        !tr.has_pending_turn_tasks(),
        "background Bash must not keep the model turn open"
    );
    let update = ev
        .iter()
        .find(|e| e["type"] == "tool_execution_update")
        .unwrap();
    assert_eq!(
        update["partialResult"]["details"]["subagent"]["type"],
        json!("Bash")
    );
    let shown = update["partialResult"]["content"][0]["text"]
        .as_str()
        .unwrap();
    assert!(shown.starts_with("Background command running"), "{shown}");
    assert!(
        !shown.contains("/tmp/shell1.output"),
        "internal output path hidden: {shown}"
    );

    let ev = tr.on_line(r#"{"type":"system","subtype":"task_notification","task_id":"shell1","tool_use_id":"tBash","status":"completed","summary":"Background command completed (exit code 0)"}"#);
    let end = ev
        .iter()
        .find(|e| e["type"] == "tool_execution_end")
        .unwrap();
    assert_eq!(end["toolCallId"], json!("tBash"));
    assert_eq!(
        end["result"]["details"]["subagent"]["status"],
        json!("completed")
    );
    assert!(!tr.has_pending_tasks());
}

#[test]
fn sync_subagent_result_ends_task() {
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tB","name":"Task","input":{}}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);
    tr.on_line(r#"{"type":"system","subtype":"task_started","task_id":"bg2","tool_use_id":"tB","description":"quick check","subagent_type":"Explore"}"#);
    // A real report (no async-launch ack) settles the card and the task.
    let ev = tr.on_line(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tB","content":"the answer is 42","is_error":false}]}}"#);
    assert!(types(&ev).contains(&"tool_execution_end".to_string()));
    assert!(!tr.has_pending_tasks());
}

#[test]
fn claude_argv_shape() {
    let args = CliBackend::ClaudeCode.turn_args(
        "hello",
        &CliRunOpts {
            model: Some("fable".into()),
            effort: Some("max".into()),
            resume: Some("sess-1".into()),
            bypass_approvals: false,
            images: Vec::new(),
            image_blocks: Vec::new(),
            append_system_prompt: Some("host hint".into()),
            ..Default::default()
        },
    );
    assert!(args.contains(&"--output-format".to_string()));
    assert!(args.contains(&"--input-format".to_string()));
    assert!(args.contains(&"--include-partial-messages".to_string()));
    assert!(args.contains(&"--permission-prompt-tool".to_string()));
    assert!(args.contains(&"stdio".to_string()));
    assert!(args.contains(&"--effort".to_string()));
    assert!(args.contains(&"max".to_string()));
    assert!(args.contains(&"--resume".to_string()));
    assert!(args.contains(&"--append-system-prompt".to_string()));
    assert!(args.contains(&"host hint".to_string()));
    // no bypass flag: claude's default mode asks us per tool
    assert!(!args.contains(&"--dangerously-skip-permissions".to_string()));
    // the prompt rides stdin, not argv
    assert!(!args.contains(&"hello".to_string()));
}
