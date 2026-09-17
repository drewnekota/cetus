use super::*;
use serde_json::json;

#[test]
fn legacy_cli_settings_enable_and_order_every_runtime_by_default() {
    let settings: CliAgentSettings = serde_json::from_value(json!({
        "bypassApprovals": false,
        "isolateInWorktree": true
    }))
    .unwrap();
    assert!(!settings.bypass_approvals);
    assert!(settings.isolate_in_worktree);
    assert!(settings.claude_code_enabled);
    assert!(settings.codex_enabled);
    assert!(settings.opencode_enabled);
    assert!(settings.grok_enabled);
    assert!(settings.kimi_enabled);
    assert!(settings.dsh_enabled);
    assert_eq!(
        settings.runtime_order,
        [
            "pi",
            "claude-code",
            "codex",
            "opencode",
            "grok",
            "kimi",
            "dsh"
        ]
    );
}

#[test]
fn runtime_order_deduplicates_discards_unknown_and_appends_new_entries() {
    let mut settings = CliAgentSettings {
        runtime_order: vec!["kimi".into(), "unknown".into(), "pi".into(), "kimi".into()],
        ..Default::default()
    };
    normalize_runtime_order(&mut settings);
    assert_eq!(
        settings.runtime_order,
        [
            "kimi",
            "pi",
            "claude-code",
            "codex",
            "opencode",
            "grok",
            "dsh"
        ]
    );
}

#[test]
fn runtime_order_keeps_presets_interleaved_and_drops_invalid_ones() {
    let mut settings = CliAgentSettings {
        runtime_order: vec![
            "preset-a".into(),
            "pi".into(),
            "preset-gone".into(),
            "claude-code".into(),
        ],
        runtime_presets: vec![
            RuntimePreset {
                id: "preset-a".into(),
                backend: "claude-code".into(),
                model: "fable".into(),
                effort: "medium".into(),
            },
            // Unlisted preset: appended to the tail of the order.
            RuntimePreset {
                id: "preset-b".into(),
                backend: "codex".into(),
                model: "gpt-5.5".into(),
                effort: "high".into(),
            },
            // Invalid backend: dropped entirely.
            RuntimePreset {
                id: "preset-bad".into(),
                backend: "pi".into(),
                model: String::new(),
                effort: String::new(),
            },
        ],
        ..Default::default()
    };
    normalize_runtime_order(&mut settings);
    assert_eq!(
        settings.runtime_order,
        [
            "preset-a",
            "pi",
            "claude-code",
            "codex",
            "opencode",
            "grok",
            "kimi",
            "dsh",
            "preset-b"
        ]
    );
    assert_eq!(
        settings
            .runtime_presets
            .iter()
            .map(|p| p.id.as_str())
            .collect::<Vec<_>>(),
        ["preset-a", "preset-b"]
    );
}

#[test]
fn claude_initialize_resolves_recommended_model_and_catalog() {
    let response = json!({
        "type": "control_response",
        "response": { "response": { "models": [
            {
                "value": "default",
                "resolvedModel": "claude-opus-4-8[1m]",
                "displayName": "Default (recommended)"
            },
            {
                "value": "opus[1m]",
                "resolvedModel": "claude-opus-4-8[1m]",
                "displayName": "Opus (1M context)"
            },
            {
                "value": "claude-fable-5-1[1m]",
                "resolvedModel": "claude-fable-5-1",
                "displayName": "Fable"
            },
            {
                "value": "haiku",
                "resolvedModel": "claude-haiku-4-5-20251001",
                "displayName": "Haiku"
            }
        ]}}
    });
    let defaults = claude_defaults_from_initialize(&response).unwrap();
    assert_eq!(defaults.model.as_deref(), Some("claude-opus-4-8[1m]"));
    let models = defaults.models.unwrap();
    assert_eq!(models.len(), 3);
    assert_eq!(models[0].id, "opus[1m]");
    // Floating alias carries no version itself → resolvedModel's, spliced
    // ahead of the parenthetical.
    assert_eq!(models[0].label, "Opus 4.8 (1M context)");
    assert_eq!(models[1].label, "Fable 5.1");
    // Date stamps are not versions.
    assert_eq!(models[2].label, "Haiku 4.5");
}

#[test]
fn claude_versioned_label_leaves_versioned_names_alone() {
    assert_eq!(
        claude_versioned_label("GPT-5.5", "gpt-5.5", None),
        "GPT-5.5"
    );
    assert_eq!(claude_versioned_label("Fable", "fable", None), "Fable");
}

#[test]
fn claude_initialize_yields_slash_catalog_for_sessionless_composers() {
    let response = json!({
        "type": "control_response",
        "response": { "response": { "commands": [
            { "name": "usage", "description": "Show session cost", "argumentHint": "" },
            { "name": "simplify", "description": "Clean up the diff (user)", "argumentHint": "[<target>]" }
        ]}}
    });
    let commands = claude_commands_from_initialize(&response);
    assert_eq!(commands.len(), 2);
    assert_eq!(commands[0]["name"], "usage");
    assert_eq!(commands[0]["kind"], "command");
    assert_eq!(commands[1]["kind"], "skill");
    assert_eq!(commands[1]["argumentHint"], "[<target>]");
    // A models-only ack (no catalog) must not fabricate entries.
    assert!(claude_commands_from_initialize(&json!({"response":{"response":{}}})).is_empty());
}

#[test]
fn dsh_settings_resolve_default_model_and_effort() {
    let defaults = dsh_defaults_from_settings(
        r#"
ui-onboarding:
  welcomeNoticeVersion: 1
agent-default-model:
  provider: deepseek-official
  model: "deepseek-v4-flash"
  reasoningEffort: high # selected in the DSH picker
another-plugin:
  model: must-not-win
"#,
    );
    assert_eq!(defaults.model.as_deref(), Some("deepseek-v4-flash"));
    assert_eq!(defaults.effort.as_deref(), Some("high"));
    assert!(defaults.models.is_none());
}

#[test]
fn handoff_preamble_replays_conversation_and_skips_bulk() {
    assert!(handoff_preamble(&[]).is_none());
    let history = vec![
        json!({"role":"user","content":[{"type":"text","text":"fix the bug"}]}),
        json!({"role":"assistant","content":[
                {"type":"toolCall","id":"t1","name":"Bash","arguments":{}},
                {"type":"text","text":"done, fixed in foo.rs"}]}),
        json!({"role":"toolResult","toolCallId":"t1","content":[{"type":"text","text":"huge tool dump"}]}),
        json!({"role":"custom","customType":"runtime_switch","content":[{"type":"text","text":"Codex → Claude Code"}]}),
    ];
    let p = handoff_preamble(&history).unwrap();
    assert!(p.contains("User: fix the bug"));
    assert!(p.contains("[tool: Bash]"));
    assert!(p.contains("done, fixed in foo.rs"));
    assert!(!p.contains("huge tool dump"));
    assert!(!p.contains("runtime_switch"));
    assert!(p.starts_with("<context source=\"cetus-runtime-handoff\">"));
    assert!(p.ends_with("</context>"));
}

#[test]
fn handoff_preamble_spends_budget_from_the_tail() {
    let long = "x".repeat(HANDOFF_MSG_CHARS + 500);
    let history: Vec<Value> = (0..40)
        .map(|i| {
            json!({"role":"user","content":[{"type":"text",
                       "text": format!("turn {i}: {long}")}]})
        })
        .collect();
    let p = handoff_preamble(&history).unwrap();
    assert!(p.len() < HANDOFF_TOTAL_CHARS + 1_000);
    assert!(p.contains("turn 39"), "newest turn must survive");
    assert!(!p.contains("turn 0:"), "oldest turn should be dropped");
    assert!(p.contains("earlier messages omitted"));
    assert!(p.contains("…[truncated]"));
}
