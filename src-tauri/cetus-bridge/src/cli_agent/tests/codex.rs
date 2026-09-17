use super::*;

#[test]
fn codex_context_uses_last_request_not_cumulative_thread_spend() {
    let event = codex_context_event(
        &json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "tokenUsage": {
                "total": { "totalTokens": 900000 },
                "last": { "totalTokens": 64000 },
                "modelContextWindow": 258400
            }
        }),
        12_345,
    )
    .unwrap();
    assert_eq!(event["usedTokens"], json!(64000));
    assert_eq!(event["contextWindow"], json!(258400));
    assert_eq!(event["transcriptBytes"], json!(12_345));
}

#[test]
fn codex_rate_limit_snapshot_maps_to_shared_quota_shape() {
    let event = codex_rate_limit_event(
        &json!({
            "rateLimits": {
                "limitId": "codex",
                "primary": {
                    "usedPercent": 84,
                    "resetsAt": 1_800_000_000
                }
            }
        }),
        &mut json!({}),
    )
    .unwrap();
    assert_eq!(event["type"], json!("cli_rate_limit"));
    assert_eq!(event["backend"], json!("codex"));
    assert_eq!(event["info"]["status"], json!("allowed_warning"));
    assert_eq!(event["info"]["utilization"], json!(0.84));
    assert_eq!(event["info"]["resetsAt"], json!(1_800_000_000));
}

#[test]
fn codex_quota_keeps_weekly_limit_across_sparse_and_other_pool_updates() {
    let mut cached = json!({});
    let event = codex_rate_limit_event(
        &json!({
            "rateLimits": {
                "limitId": "codex",
                "primary": { "usedPercent": 0, "windowDurationMins": 300 },
                "secondary": {
                    "usedPercent": 70,
                    "windowDurationMins": 10080,
                    "resetsAt": 1_800_000_000
                }
            }
        }),
        &mut cached,
    )
    .unwrap();
    assert_eq!(event["info"]["utilization"], json!(0.7));
    assert_eq!(event["info"]["rateLimitType"], json!("seven_day"));
    assert_eq!(event["info"]["resetsAt"], json!(1_800_000_000));
    let before = cached.clone();
    assert!(codex_rate_limit_event(
        &json!({
            "rateLimits": {
                "limitId": "codex_bengalfox",
                "primary": { "usedPercent": 0 },
                "secondary": { "usedPercent": 0 }
            }
        }),
        &mut cached
    )
    .is_none());
    assert_eq!(cached, before);
    let sparse = codex_rate_limit_event(
        &json!({
            "rateLimits": {
                "limitId": "codex",
                "primary": { "usedPercent": 5, "windowDurationMins": 300 },
                "secondary": null
            }
        }),
        &mut cached,
    )
    .unwrap();
    assert_eq!(sparse["info"], event["info"]);
    let exhausted = codex_rate_limit_event(
        &json!({
            "rateLimits": {
                "primary": { "usedPercent": 100, "windowDurationMins": 300 }
            }
        }),
        &mut cached,
    )
    .unwrap();
    assert_eq!(exhausted["info"]["status"], json!("rejected"));
    assert_eq!(exhausted["info"]["rateLimitType"], json!("five_hour"));
}

#[test]
fn codex_quota_accepts_secondary_only_and_legacy_fields() {
    let event = codex_rate_limit_event(
        &json!({
            "rate_limits": {
                "limit_id": null,
                "primary": null,
                "secondary": {
                    "used_percent": 85,
                    "window_duration_mins": 10080,
                    "resets_at": 1_800_000_000
                }
            }
        }),
        &mut json!({}),
    )
    .unwrap();
    assert_eq!(event["info"]["utilization"], json!(0.85));
    assert_eq!(event["info"]["status"], json!("allowed_warning"));
    assert_eq!(event["info"]["rateLimitType"], json!("seven_day"));
    assert!(codex_rate_limit_event(
        &json!({
            "rateLimits": { "primary": null, "secondary": null }
        }),
        &mut json!({})
    )
    .is_none());
}

#[test]
fn codex_skills_list_becomes_a_deduplicated_skill_catalog() {
    let commands = codex_skill_commands(&json!({
        "data": [
            { "skills": [
                { "name": "writer", "description": "Draft prose", "enabled": true },
                { "name": "hidden", "description": "Disabled", "enabled": false }
            ]},
            { "skills": [
                { "name": "Writer", "description": "Duplicate" },
                { "name": "reviewer", "description": "Review code" }
            ]}
        ]
    }));
    assert_eq!(commands.len(), 2);
    assert_eq!(commands[0]["name"], json!("writer"));
    assert_eq!(commands[0]["kind"], json!("skill"));
    assert_eq!(commands[1]["name"], json!("reviewer"));
}

#[tokio::test]
async fn codex_skill_probe_does_not_create_a_thread() {
    let dir = std::env::temp_dir().join(format!(
        "cetus-codex-skill-probe-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("fake-codex.sh");
    let requests = dir.join("requests.ndjson");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\n\
             while IFS= read -r line; do\n\
               echo \"$line\" >> '{}'\n\
               case \"$line\" in\n\
                 *'\"method\":\"initialize\"'*) echo '{{\"id\":1,\"result\":{{\"userAgent\":\"fake\"}}}}' ;;\n\
                 *'\"method\":\"skills/list\"'*) echo '{{\"id\":2,\"result\":{{\"data\":[{{\"skills\":[{{\"name\":\"writer\",\"description\":\"Write clearly\",\"enabled\":true}}]}}]}}}}' ;;\n\
               esac\n\
             done\n",
            requests.display()
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let commands = probe_codex_skills(&script.to_string_lossy(), &dir, true)
        .await
        .unwrap();
    assert_eq!(commands.len(), 1);
    assert_eq!(commands[0]["name"], json!("writer"));
    let requests = std::fs::read_to_string(requests).unwrap();
    assert!(requests.contains(r#""method":"skills/list""#));
    assert!(requests.contains(r#""forceReload":true"#));
    assert!(!requests.contains(r#""method":"thread/start""#));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn codex_text_phase_survives_streaming_and_persistence() {
    for phase in ["commentary", "final_answer"] {
        let mut tr = EventTranslator::new(CliBackend::Codex);
        tr.on_line(
            &json!({ "type": "item.started", "item": {
                "id": "answer", "type": "agent_message", "phase": phase,
            }})
            .to_string(),
        );
        let events = tr
            .on_line(r#"{"type":"item.agent_message.delta","item_id":"answer","delta":"Answer"}"#);
        assert!(events
            .iter()
            .any(|e| e["assistantMessageEvent"]["type"] == "text_start"
                && e["assistantMessageEvent"]["phase"] == phase));
        // Older/interrupted streams may omit phase at completion. Retain
        // the item.started metadata in both the UI and saved transcript.
        let events = tr.on_line(r#"{"type":"item.completed","item":{"id":"answer","type":"agent_message","text":"Answer"}}"#);
        assert!(events
            .iter()
            .any(|e| e["assistantMessageEvent"]["phase"] == phase));
        tr.finish(None);
        let messages = tr.take_messages();
        assert_eq!(messages[0]["content"][0]["phase"], phase);
        assert!(tr.codex_message_phases.is_empty());
    }
}

#[test]
fn codex_completed_only_phase_and_unknown_phase_are_safe() {
    for phase in ["final_answer", "commentary", "future_phase"] {
        let mut tr = EventTranslator::new(CliBackend::Codex);
        let item = normalize_codex_app_item(json!({
            "id": "answer", "type": "agentMessage", "text": "Answer", "phase": phase,
        }));
        let events = tr.on_line(&json!({ "type": "item.completed", "item": item }).to_string());
        let expected = if phase == "future_phase" {
            Value::Null
        } else {
            json!(phase)
        };
        assert_eq!(
            events.last().unwrap()["assistantMessageEvent"]["phase"],
            expected
        );
        tr.finish(None);
        assert_eq!(tr.take_messages()[0]["content"][0]["phase"], expected);
    }
}

#[test]
fn codex_partial_final_phase_survives_disconnect() {
    let mut tr = EventTranslator::new(CliBackend::Codex);
    tr.on_line(r#"{"type":"item.started","item":{"id":"answer","type":"agent_message","phase":"final_answer"}}"#);
    tr.on_line(
        r#"{"type":"item.agent_message.delta","item_id":"answer","delta":"Partial answer"}"#,
    );
    let events = tr.finish(Some("connection closed"));
    assert!(events
        .iter()
        .any(|e| e["assistantMessageEvent"]["type"] == "text_end"
            && e["assistantMessageEvent"]["phase"] == "final_answer"));
    let messages = tr.take_messages();
    assert_eq!(messages[0]["content"][0]["phase"], "final_answer");
    assert!(messages[0]["content"][1].get("phase").is_none());
    tr.begin_next_turn();
    assert!(tr.codex_message_phases.is_empty());
}

#[test]
fn codex_message_reasoning_and_command_translate() {
    let mut tr = EventTranslator::new(CliBackend::Codex);
    tr.on_line(r#"{"type":"thread.started","thread_id":"thr-7"}"#);
    assert_eq!(tr.resume_id.as_deref(), Some("thr-7"));
    assert!(tr.on_line(r#"{"type":"turn.started"}"#).is_empty());

    let ev = tr.on_line(
        r#"{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"ls","aggregated_output":"a.txt","exit_code":0}}"#,
    );
    assert_eq!(
        types(&ev),
        vec![
            "message_start",
            "message_update:toolcall_start",
            "message_update:toolcall_end",
            "tool_execution_start",
            "tool_execution_end"
        ]
    );
    assert_eq!(
        ev[2]["assistantMessageEvent"]["toolCall"]["name"],
        json!("shell")
    );

    let ev = tr.on_line(
        r#"{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"OK"}}"#,
    );
    assert_eq!(
        types(&ev),
        vec![
            "message_update:text_start",
            "message_update:text_delta",
            "message_update:text_end"
        ]
    );
}

#[test]
fn codex_item_started_streams_live_tool_card() {
    let mut tr = EventTranslator::new(CliBackend::Codex);
    // command surfaces the moment it starts running…
    let ev = tr.on_line(
        r#"{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"sleep 2","aggregated_output":""}}"#,
    );
    assert_eq!(
        types(&ev),
        vec![
            "message_start",
            "message_update:toolcall_start",
            "message_update:toolcall_end",
            "tool_execution_start"
        ]
    );
    // …and completion only attaches the result (no duplicate card/start)
    let ev = tr.on_line(
        r#"{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"sleep 2","aggregated_output":"done","exit_code":0}}"#,
    );
    assert_eq!(types(&ev), vec!["tool_execution_end"]);
    assert_eq!(ev[0]["result"]["content"][0]["text"], json!("done"));
}

#[test]
fn codex_app_server_deltas_stream_and_complete_without_duplicates() {
    let mut tr = EventTranslator::new(CliBackend::Codex);
    let mut ev = Vec::new();
    ev.extend(tr.on_line(
        r#"{"type":"item.reasoning.summary_delta","item_id":"r1","summary_index":0,"delta":"Checking "}"#,
    ));
    ev.extend(tr.on_line(
        r#"{"type":"item.reasoning.summary_delta","item_id":"r1","summary_index":0,"delta":"the repo"}"#,
    ));
    assert_eq!(
        types(&ev),
        vec![
            "message_start",
            "message_update:thinking_start",
            "message_update:thinking_delta",
            "message_update:thinking_delta",
        ]
    );
    let end = tr.on_line(
        r#"{"type":"item.completed","item":{"id":"r1","type":"reasoning","summary":["Checking the repo"],"content":[]}}"#,
    );
    assert_eq!(types(&end), vec!["message_update:thinking_end"]);
    assert_eq!(
        end[0]["assistantMessageEvent"]["content"],
        json!("Checking the repo")
    );

    let first =
        tr.on_line(r#"{"type":"item.agent_message.delta","item_id":"m1","delta":"partial"}"#);
    assert_eq!(
        types(&first),
        vec!["message_update:text_start", "message_update:text_delta"]
    );
    // Completed text is authoritative and replaces a divergent partial.
    let end = tr.on_line(
        r#"{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"final answer"}}"#,
    );
    assert_eq!(types(&end), vec!["message_update:text_end"]);
    assert_eq!(
        end[0]["assistantMessageEvent"]["content"],
        json!("final answer")
    );

    tr.finish(None);
    let messages = tr.take_messages();
    let content = messages[0]["content"].as_array().unwrap();
    assert_eq!(content.iter().filter(|b| b["type"] == "text").count(), 1);
}

#[test]
fn codex_command_output_delta_is_incremental_and_coalesced() {
    let mut tr = EventTranslator::new(CliBackend::Codex);
    tr.on_line(
        r#"{"type":"item.started","item":{"id":"cmd1","type":"command_execution","command":"build"}}"#,
    );
    let first =
        tr.on_line(r#"{"type":"item.tool_output.delta","item_id":"cmd1","delta":"line 1\n"}"#);
    let second =
        tr.on_line(r#"{"type":"item.tool_output.delta","item_id":"cmd1","delta":"line 2"}"#);
    assert_eq!(types(&first), vec!["tool_execution_delta"]);
    assert_eq!(first[0]["delta"], json!("line 1\n"));
    assert!(second.is_empty(), "updates inside 50ms should be coalesced");
    std::thread::sleep(TOOL_OUTPUT_FLUSH_INTERVAL + Duration::from_millis(5));
    let third =
        tr.on_line(r#"{"type":"item.tool_output.delta","item_id":"cmd1","delta":"line 3"}"#);
    assert_eq!(types(&third), vec!["tool_execution_delta"]);
    assert_eq!(third[0]["delta"], json!("line 2line 3"));
    assert_eq!(third[0]["totalBytes"], json!(19));
}

#[test]
fn codex_large_command_output_is_bounded_and_saved() {
    let dir = std::env::temp_dir().join(format!(
        "cetus-tool-output-test-{}",
        ARTIFACT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let mut tr =
        EventTranslator::new(CliBackend::Codex).with_artifact_storage(dir.clone(), dir.clone());
    tr.on_line(
        r#"{"type":"item.started","item":{"id":"cmd-large","type":"command_execution","command":"build"}}"#,
    );
    let full = "0123456789".repeat(10_000);
    let completed = json!({
        "type": "item.completed",
        "item": {
            "id": "cmd-large",
            "type": "command_execution",
            "command": "build",
            "aggregated_output": full,
            "exit_code": 0
        }
    });
    let events = tr.on_line(&completed.to_string());
    let end = events
        .iter()
        .find(|event| event["type"] == "tool_execution_end")
        .unwrap();
    let preview = end["result"]["content"][0]["text"].as_str().unwrap();
    assert!(preview.len() <= TOOL_OUTPUT_PREVIEW_BYTES);
    assert_eq!(
        end["result"]["details"]["toolOutput"]["truncated"],
        json!(true)
    );
    let path = end["result"]["details"]["toolOutput"]["path"]
        .as_str()
        .unwrap();
    assert_eq!(std::fs::read_to_string(path).unwrap(), full);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn codex_finish_preserves_an_interrupted_partial_message() {
    let mut tr = EventTranslator::new(CliBackend::Codex);
    tr.on_line(r#"{"type":"item.agent_message.delta","item_id":"m1","delta":"still working"}"#);
    let end = tr.finish(None);
    assert_eq!(types(&end)[0], "message_update:text_end");
    assert_eq!(
        end[0]["assistantMessageEvent"]["content"],
        json!("still working")
    );
    let messages = tr.take_messages();
    assert_eq!(messages[0]["content"][0]["text"], json!("still working"));
}

#[test]
fn codex_background_agent_stays_live_until_agent_state_settles() {
    let mut tr = EventTranslator::new(CliBackend::Codex);
    let started = normalize_codex_app_item(json!({
        "id": "spawn-1", "type": "collabAgentToolCall", "tool": "spawnAgent",
        "prompt": "inspect the parser", "model": "gpt-5", "status": "inProgress",
        "senderThreadId": "root", "receiverThreadIds": ["child-1"], "agentsStates": {},
    }));
    let ev = tr.on_line(&json!({ "type": "item.started", "item": started }).to_string());
    assert_eq!(
        types(&ev),
        vec![
            "message_start",
            "message_update:toolcall_start",
            "message_update:toolcall_end",
            "tool_execution_start",
            "tool_execution_update"
        ]
    );
    assert_eq!(
        ev[4]["partialResult"]["details"]["subagent"]["status"],
        json!("running")
    );

    // Completing the spawn call itself does not settle the card while the
    // child thread is still running.
    let running = normalize_codex_app_item(json!({
        "id": "spawn-1", "type": "collabAgentToolCall", "tool": "spawnAgent",
        "prompt": "inspect the parser", "status": "completed", "senderThreadId": "root",
        "receiverThreadIds": ["child-1"],
        "agentsStates": { "child-1": { "status": "running", "message": "reading files" } },
    }));
    let ev = tr.on_line(&json!({ "type": "item.completed", "item": running }).to_string());
    assert_eq!(types(&ev), vec!["tool_execution_update"]);

    // A later wait/collab item carries the terminal state for that same
    // child thread and settles the original spawn card.
    let completed = normalize_codex_app_item(json!({
        "id": "wait-1", "type": "collabAgentToolCall", "tool": "wait",
        "status": "completed", "senderThreadId": "root", "receiverThreadIds": ["child-1"],
        "agentsStates": { "child-1": { "status": "completed", "message": "parser is sound" } },
    }));
    let ev = tr.on_line(&json!({ "type": "item.completed", "item": completed }).to_string());
    assert_eq!(types(&ev), vec!["tool_execution_end"]);
    assert_eq!(
        ev[0]["result"]["content"][0]["text"],
        json!("parser is sound")
    );
    assert_eq!(
        ev[0]["result"]["details"]["subagent"]["status"],
        json!("completed")
    );
}

#[test]
fn codex_argv_shape() {
    let args = CliBackend::Codex.turn_args(
        "hello",
        &CliRunOpts {
            model: None,
            effort: Some("xhigh".into()),
            resume: None,
            bypass_approvals: true,
            images: vec!["/tmp/shot.png".into()],
            image_blocks: Vec::new(),
            append_system_prompt: None,
            ..Default::default()
        },
    );
    assert_eq!(args[0], "exec");
    assert!(args.contains(&"--json".to_string()));
    assert!(args.contains(&"--dangerously-bypass-approvals-and-sandbox".to_string()));
    assert!(args.contains(&"-c".to_string()));
    assert!(args.contains(&"model_reasoning_effort=\"xhigh\"".to_string()));
    assert!(args.contains(&"-i".to_string()));
    assert!(args.contains(&"/tmp/shot.png".to_string()));
    assert_eq!(args.last().unwrap(), "hello");
}
