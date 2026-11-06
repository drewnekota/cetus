use anyhow::{Context, Result};
use serde_json::Value;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command as TokioCommand;

// ===========================================================================
// DSH backend: dsh's `acp` profile is a standard ACP v1 stdio server, so a
// conversation drives `dsh --profile acp` through the same `spawn_acp_session`
// path as the other native ACP runtimes. What stays dsh-specific lives here:
// the Flash model overlay, legacy plugin cleanup, `.env` credential passthrough,
// the version gate
// (dsh < 0.1.2 has no `acp` profile), and the mapping from Cetus's model /
// effort choice onto dsh's `session/set_config_option` catalog.
// ===========================================================================
// Applied only to Cetus-launched ACP processes, after user profile overlays.
const DSH_FLASH_PATCH: &str = r#"- id: llm-deepseek
  config:
    models:
      - id: deepseek-flash
        name: DeepSeek V4.1 Flash
        contextWindow: 1000000
        maxTokens: 384000
        inputModalities: [text, image]
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-flash
- id: acp
  config:
    provider: deepseek-official
    model: deepseek-flash
"#;
pub(super) fn dsh_home() -> std::path::PathBuf {
    std::env::var("DSH_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".dsh")
        })
}

/// Prepare only the model overlay. App capabilities are exposed through the
/// shared Cetus CLI, not through dsh-specific plugins.
pub(super) fn dsh_prepare_runtime(home: &std::path::Path) -> Result<std::path::PathBuf> {
    let config = home.join("cordis.patch.yml");
    match std::fs::read_to_string(&config) {
        Ok(text) => {
            let (user, previous) = dsh_split_managed_block(&text);
            if previous.is_some() {
                std::fs::write(&config, user)
                    .context("could not remove retired Cetus plugin mounts")?;
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("could not read dsh plugin overlay"),
    }
    let root = home.join("cetus-runtime");
    std::fs::create_dir_all(&root)?;
    let patch = root.join("flash.patch.yml");
    if std::fs::read_to_string(&patch).ok().as_deref() != Some(DSH_FLASH_PATCH) {
        std::fs::write(&patch, DSH_FLASH_PATCH)?;
    }
    Ok(root)
}

const DSH_MANAGED_BEGIN: &str = "# >>> dsh-companion managed block (do not edit)";
const DSH_MANAGED_END: &str = "# <<< dsh-companion managed block";

/// Split `cordis.patch.yml` into the user's text and Cetus's managed block
/// (`None` when there is none). The block is returned in the exact form the
/// writer emits, so an unchanged mount is a no-op write.
fn dsh_split_managed_block(text: &str) -> (String, Option<String>) {
    let Some(begin) = text.find(DSH_MANAGED_BEGIN) else {
        return (text.to_string(), None);
    };
    let Some(end_rel) = text[begin..].find(DSH_MANAGED_END) else {
        return (text.to_string(), None);
    };
    let end = begin + end_rel + DSH_MANAGED_END.len();
    let end = end
        + text[end..]
            .find('\n')
            .map(|n| n + 1)
            .unwrap_or(text.len() - end);
    let before = text[..begin].trim_end_matches('\n');
    let mut user = String::from(before);
    if !before.is_empty() {
        user.push('\n');
    }
    user.push_str(&text[end..]);
    let block = format!("\n{}", &text[begin..end]);
    (user, Some(block))
}

/// Oldest dsh whose `acp` profile Cetus can drive. Earlier releases only had
/// the ApiProxy gateway that the retired companion bridge wrapped.
const DSH_MIN_VERSION: (u64, u64, u64) = (0, 1, 2);

/// `major.minor.patch` from a version string, ignoring any prerelease or build
/// suffix (`0.1.2-rc.1` → `(0, 1, 2)`).
fn parse_semver_triple(text: &str) -> Option<(u64, u64, u64)> {
    let core = text
        .trim()
        .trim_start_matches('v')
        .split(['-', '+'])
        .next()?;
    let mut parts = core.split('.').map(|part| part.trim().parse::<u64>().ok());
    Some((parts.next()??, parts.next()??, parts.next()??))
}

/// Reject a dsh that predates the `acp` profile with a message that says what
/// to install, instead of the opaque boot error `--profile acp` would produce.
fn dsh_check_version(version: &str) -> Result<()> {
    let parsed = parse_semver_triple(version)
        .with_context(|| format!("could not parse the dsh version {version:?}"))?;
    anyhow::ensure!(
        parsed >= DSH_MIN_VERSION,
        "dsh {} is too old for Cetus: it drives dsh over the `acp` profile, which needs dsh \
         {}.{}.{} or newer. Upgrade with `npm i -g @deepseek-ai/dsh@latest` and retry.",
        version.trim(),
        DSH_MIN_VERSION.0,
        DSH_MIN_VERSION.1,
        DSH_MIN_VERSION.2
    );
    Ok(())
}

/// Binaries already verified this process lifetime; `dsh --version` boots node,
/// so it is only worth paying once per install.
static DSH_VERIFIED_BINS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// Run `dsh --version` and gate on [`DSH_MIN_VERSION`]. Cached per binary.
pub(super) async fn dsh_require_supported_version(bin: &str) -> Result<()> {
    if DSH_VERIFIED_BINS
        .lock()
        .unwrap()
        .iter()
        .any(|verified| verified == bin)
    {
        return Ok(());
    }
    let output = tokio::time::timeout(
        Duration::from_secs(30),
        TokioCommand::new(bin)
            .arg("--version")
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .context("`dsh --version` timed out")?
    .with_context(|| format!("failed to run `{bin} --version`"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let version = stdout
        .lines()
        .map(str::trim)
        .find(|line| parse_semver_triple(line).is_some())
        .unwrap_or_else(|| stdout.trim());
    dsh_check_version(version)?;
    DSH_VERIFIED_BINS.lock().unwrap().push(bin.to_string());
    Ok(())
}

/// `$DSH_HOME/.env` is dsh's own credential file; hand it to the child so the
/// native model adapters see their keys regardless of which shell
/// rc files a non-interactive login shell reads. Caller-supplied env is applied
/// afterwards and wins.
pub(super) fn dsh_dotenv() -> Vec<(String, String)> {
    let Ok(text) = std::fs::read_to_string(dsh_home().join(".env")) else {
        return Vec::new();
    };
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| {
            let (key, value) = line.split_once('=')?;
            let value = value.trim().trim_matches('"').trim_matches('\'');
            Some((key.trim().to_string(), value.to_string()))
        })
        .collect()
}

/// Every selectable value of one ACP session config option, flattening the
/// optional `{ group, options: [...] }` nesting dsh uses for provider groups.
fn acp_config_choices(option: &Value) -> Vec<(String, String)> {
    let mut choices = Vec::new();
    let mut stack: Vec<&Value> = option
        .get("options")
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .unwrap_or_default();
    while let Some(item) = stack.pop() {
        if let Some(nested) = item.get("options").and_then(Value::as_array) {
            stack.extend(nested.iter());
            continue;
        }
        if let Some(value) = item.get("value").and_then(Value::as_str) {
            let name = item.get("name").and_then(Value::as_str).unwrap_or("");
            choices.push((value.to_string(), name.to_string()));
        }
    }
    choices
}

/// Map Cetus's per-conversation model / effort choice onto dsh's
/// `session/set_config_option` calls, using the catalog dsh returned with the
/// session. Cetus stores bare model ids (`deepseek-v4-pro`); dsh's option
/// values are `["<provider>", "<model>"]` JSON strings, so a choice matches on
/// the whole value, on the model half, or on the display name. Unknown values
/// are skipped (dsh keeps its own default) rather than sent to fail.
pub(super) fn dsh_config_updates(
    config_options: &Value,
    model: Option<&str>,
    effort: Option<&str>,
) -> Vec<(String, String)> {
    let options = config_options.as_array().cloned().unwrap_or_default();
    let option = |id: &str| {
        options
            .iter()
            .find(|option| option.get("id").and_then(Value::as_str) == Some(id))
    };
    let mut updates = Vec::new();
    if let Some(model) = model.map(str::trim).filter(|value| !value.is_empty()) {
        if let Some(option) = option("model") {
            let choices = acp_config_choices(option);
            let matched = choices.iter().find(|(value, name)| {
                if value == model || name.eq_ignore_ascii_case(model) {
                    return true;
                }
                serde_json::from_str::<Value>(value)
                    .ok()
                    .and_then(|parsed| {
                        parsed
                            .as_array()
                            .and_then(|pair| pair.last())
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                    .is_some_and(|candidate| candidate == model)
            });
            match matched {
                Some((value, _)) => updates.push(("model".to_string(), value.clone())),
                None => tracing::warn!("dsh has no model {model:?}; keeping its default"),
            }
        }
    }
    if let Some(effort) = effort.map(str::trim).filter(|value| !value.is_empty()) {
        if let Some(option) = option("reasoning_effort") {
            let choices = acp_config_choices(option);
            let matched = choices
                .iter()
                .find(|(value, name)| value == effort || name.eq_ignore_ascii_case(effort));
            match matched {
                Some((value, _)) => updates.push(("reasoning_effort".to_string(), value.clone())),
                None => {
                    tracing::warn!("dsh has no reasoning effort {effort:?}; keeping its default")
                }
            }
        }
    }
    updates
}

#[cfg(test)]
mod dsh_tests {
    use super::super::{spawn_acp_session, CliBackend, CliRunOpts, EventTranslator};
    use super::*;
    use crate::bridge::RuntimeEvent;
    use crate::pi_rpc::EventSink;
    use serde_json::json;
    use std::sync::Arc;

    #[test]
    fn dsh_is_driven_over_the_acp_profile() {
        assert!(CliBackend::Dsh.is_acp());
        assert_eq!(CliBackend::Dsh.acp_args(), ["--profile", "acp"]);
        assert!(CliBackend::Dsh
            .turn_args("ignored", &CliRunOpts::default())
            .is_empty());
    }

    #[test]
    fn dsh_version_gate_accepts_0_1_2_and_rejects_older() {
        assert!(dsh_check_version("0.1.2-rc.1").is_ok());
        assert!(dsh_check_version("0.1.2").is_ok());
        assert!(dsh_check_version("v0.2.0\n").is_ok());
        let error = dsh_check_version("0.1.1-rc.2").unwrap_err().to_string();
        assert!(error.contains("0.1.1-rc.2"), "{error}");
        assert!(error.contains("npm i -g @deepseek-ai/dsh"), "{error}");
        assert!(dsh_check_version("garbage").is_err());
    }

    fn sample_catalog() -> Value {
        json!([
            {
                "id": "model", "type": "select",
                "currentValue": "[\"deepseek-official\",\"deepseek-v4-flash\"]",
                "options": [{
                    "group": "deepseek-official", "name": "DeepSeek",
                    "options": [
                        { "value": "[\"deepseek-official\",\"deepseek-v4-flash\"]", "name": "DeepSeek-V4-Flash" },
                        { "value": "[\"deepseek-official\",\"deepseek-v4-pro\"]", "name": "DeepSeek-V4-Pro" }
                    ]
                }]
            },
            {
                "id": "reasoning_effort", "type": "select", "currentValue": "high",
                "options": [
                    { "value": "off", "name": "Off" }, { "value": "low", "name": "Low" },
                    { "value": "high", "name": "High" }, { "value": "max", "name": "Max" }
                ]
            }
        ])
    }

    #[test]
    fn dsh_config_updates_map_bare_model_ids_onto_provider_pairs() {
        let updates = dsh_config_updates(&sample_catalog(), Some("deepseek-v4-pro"), Some("max"));
        assert_eq!(
            updates,
            [
                (
                    "model".to_string(),
                    "[\"deepseek-official\",\"deepseek-v4-pro\"]".to_string()
                ),
                ("reasoning_effort".to_string(), "max".to_string()),
            ]
        );
        // Display names and full values match too.
        let by_name = dsh_config_updates(&sample_catalog(), Some("DeepSeek-V4-Flash"), None);
        assert_eq!(
            by_name[0].1,
            "[\"deepseek-official\",\"deepseek-v4-flash\"]"
        );
        let by_value = dsh_config_updates(
            &sample_catalog(),
            Some("[\"deepseek-official\",\"deepseek-v4-flash\"]"),
            None,
        );
        assert_eq!(by_value.len(), 1);
    }

    #[test]
    fn dsh_legacy_managed_block_isolated_from_user_config() {
        let user = "- id: dsh-gal\n  name: '/nowhere/dsh-gal/lib/index.js'\n";
        let block = format!(
            "\n{DSH_MANAGED_BEGIN}\n- insert:\n    - id: dsh-vision\n      name: '/old/app/dsh-vision/lib/index.js'\n{DSH_MANAGED_END}\n"
        );
        let text = format!("{user}{block}");
        let (rest, previous) = dsh_split_managed_block(&text);
        assert_eq!(rest, user);
        assert_eq!(previous.as_deref(), Some(block.as_str()));
        // No block at all, and a block in the middle of user text.
        assert_eq!(dsh_split_managed_block(user), (user.to_string(), None));
        let middle = format!("{block}- id: after\n  name: '@scope/pkg'\n");
        let (rest, previous) = dsh_split_managed_block(&middle);
        assert_eq!(rest, "- id: after\n  name: '@scope/pkg'\n");
        assert!(previous.is_some());
    }

    #[test]
    fn dsh_upgrade_removes_only_managed_plugins_and_is_idempotent() {
        let home = std::env::temp_dir().join(format!("cetus-dsh-migration-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        let config = home.join("cordis.patch.yml");
        let user = "- id: user-plugin\n  name: '@scope/plugin'\n";
        std::fs::write(&config, format!("{user}\n{DSH_MANAGED_BEGIN}\n- insert:\n    - id: dsh-companion-bridge\n      name: '/old/bridge.js'\n    - id: dsh-artifact\n      name: '/old/artifact.js'\n{DSH_MANAGED_END}\n")).unwrap();
        let runtime = dsh_prepare_runtime(&home).unwrap();
        assert_eq!(std::fs::read_to_string(&config).unwrap(), user);
        assert_eq!(
            std::fs::read_to_string(runtime.join("flash.patch.yml")).unwrap(),
            DSH_FLASH_PATCH
        );
        dsh_prepare_runtime(&home).unwrap();
        assert_eq!(std::fs::read_to_string(&config).unwrap(), user);
        // User-managed plugin rows outside our old marker are preserved.
        let own = "- id: dsh-artifact\n  name: '@custom/artifact'\n";
        std::fs::write(&config, own).unwrap();
        dsh_prepare_runtime(&home).unwrap();
        assert_eq!(std::fs::read_to_string(&config).unwrap(), own);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn dsh_config_updates_skip_unknown_choices_and_empty_input() {
        assert!(dsh_config_updates(&sample_catalog(), Some("gpt-9"), Some("medium")).is_empty());
        assert!(dsh_config_updates(&sample_catalog(), Some(""), Some("")).is_empty());
        assert!(dsh_config_updates(&Value::Null, Some("deepseek-v4-pro"), None).is_empty());
    }

    /// CLI artifact markers in bash output must become file cards over ACP.
    #[test]
    fn dsh_cli_artifact_marker_is_promoted_over_acp() {
        let dir =
            std::env::temp_dir().join(format!("cetus-dsh-acp-artifact-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("report.pdf");
        std::fs::write(&file, b"%PDF").unwrap();
        let mut translator =
            EventTranslator::new(CliBackend::Dsh).with_artifact_storage(dir.clone(), dir.clone());
        let mut events = translator.on_acp_update(&json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "call-1",
            "title": "bash",
            "kind": "execute",
            "status": "in_progress",
            "rawInput": { "command": format!("cetus artifact {}", file.display()) }
        }));
        let marker = format!(
            "CETUS_ARTIFACT:{}",
            json!({ "path": file.to_string_lossy(), "sizeBytes": 4 })
        );
        events.extend(translator.on_acp_update(&json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "call-1",
            "status": "completed",
            "content": [{ "type": "content", "content": { "type": "text", "text": format!("Delivered report.pdf to the user.\n{marker}") } }]
        })));
        assert!(events
            .iter()
            .any(|event| event.get("type") == Some(&json!("tool_execution_start"))));
        let end = events
            .iter()
            .find(|event| event.get("type") == Some(&json!("tool_execution_end")))
            .expect("tool result event");
        assert_eq!(end["result"]["details"]["name"], json!("report.pdf"));
        assert_eq!(end["result"]["details"]["artifactKind"], json!("pdf"));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Drive a real `dsh --profile acp` end to end through the generic ACP
    /// session path: version gate, model selection, native images and CLI tools,
    /// then a resume of the same session in a fresh process.
    /// `cargo test -p cetus-bridge live_dsh_acp -- --ignored --nocapture`;
    /// `CETUS_TEST_DSH_BIN` picks the binary (default `dsh` on PATH).
    /// Requires `cetus` on PATH and a running app for read-only CLI checks.
    #[tokio::test]
    #[ignore]
    async fn live_dsh_acp_smoke() {
        struct Sink(std::sync::Mutex<Vec<Value>>);
        impl EventSink for Sink {
            fn emit(&self, event: RuntimeEvent) {
                if let RuntimeEvent::Protocol { event, .. } = event {
                    self.0.lock().unwrap().push(event);
                }
            }
        }
        let bin = std::env::var("CETUS_TEST_DSH_BIN").unwrap_or_else(|_| "dsh".to_string());
        // Isolated DSH_HOME so the run cannot lean on a developer's own plugin
        // mounts; only provider credentials and defaults are carried over.
        let original_home = dsh_home();
        let isolated_home =
            std::env::temp_dir().join(format!("cetus-live-dsh-acp-{}", std::process::id()));
        std::fs::create_dir_all(&isolated_home).unwrap();
        for file in [".env", "settings.yaml"] {
            if let Ok(bytes) = std::fs::read(original_home.join(file)) {
                std::fs::write(isolated_home.join(file), bytes).unwrap();
            }
        }
        std::env::set_var("DSH_HOME", &isolated_home);
        let cwd = std::env::temp_dir().join("cetus-live-dsh-acp-cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::write(
            cwd.join("cli-test-report.txt"),
            "Cetus CLI delivery smoke test",
        )
        .unwrap();
        let env: Vec<(String, String)> = std::env::vars().collect();

        let run = |resume: Option<String>, prompt: &str, images: Vec<(String, String)>| {
            let sink = Arc::new(Sink(std::sync::Mutex::new(Vec::new())));
            let session = spawn_acp_session(
                CliBackend::Dsh,
                &bin,
                &cwd,
                Some(cwd.join("artifacts")),
                Some("live-dsh-acp".into()),
                env.clone(),
                CliRunOpts {
                    model: Some("deepseek-v4-flash".into()),
                    effort: Some("low".into()),
                    resume,
                    bypass_approvals: true,
                    ..Default::default()
                },
            )
            .unwrap();
            let receiver = session
                .start_turn(prompt.to_string(), images, sink.clone())
                .unwrap();
            async move {
                let outcome = tokio::time::timeout(Duration::from_secs(240), receiver)
                    .await
                    .expect("live dsh turn timed out")
                    .expect("live dsh session exited");
                session.shutdown();
                (outcome, sink)
            }
        };

        let (first, sink) = run(
            None,
            "Reply with exactly CETUS_DSH_OK. Do not use tools.",
            Vec::new(),
        )
        .await;
        assert!(first.error.is_none(), "{:?}", first.error);
        let messages = serde_json::to_string(&first.messages).unwrap();
        assert!(messages.contains("CETUS_DSH_OK"), "{messages}");
        assert!(sink.0.lock().unwrap().iter().any(|event| {
            event
                .pointer("/assistantMessageEvent/type")
                .and_then(Value::as_str)
                == Some("text_delta")
        }));
        let session_id = first.resume_id.clone().expect("dsh session id");

        // The native bash tool uses the same CLI as other runtimes. Queries
        // are read-only and discard private contents; artifact output is caught
        // by this test's sink rather than delivered to a real conversation.
        let (second, sink) = run(
            Some(session_id.clone()),
            "What exact token did I ask you to reply with a moment ago? Repeat that token. Then use your native bash tool to run these Cetus CLI commands: `cetus cron list >/dev/null`, `cetus context timeline --last 1m >/dev/null`, `cetus context search cetus-test --last 1m >/dev/null`, and `cetus artifact cli-test-report.txt`. Keep the artifact command output visible. Do not use any Cetus plugin tools. Reply DONE after all commands succeed.",
            Vec::new(),
        )
        .await;
        assert!(second.error.is_none(), "{:?}", second.error);
        assert_eq!(second.resume_id.as_deref(), Some(session_id.as_str()));
        let messages = serde_json::to_string(&second.messages).unwrap();
        assert!(
            messages.contains("CETUS_DSH_OK"),
            "resume lost context: {messages}"
        );
        let (vision, _) = run(
            Some(session_id.clone()),
            "What is the solid color of this image? Reply with just the English color name. Do not use tools.",
            vec![("image/png".into(), "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==".into())],
        ).await;
        assert!(vision.error.is_none(), "{:?}", vision.error);
        let vision_messages = serde_json::to_string(&vision.messages).unwrap();
        assert!(
            vision_messages.to_lowercase().contains("red"),
            "{vision_messages}"
        );
        let events = sink.0.lock().unwrap();
        let recorded = serde_json::to_string(&*events).unwrap();
        for command in [
            "cetus cron list",
            "cetus context timeline",
            "cetus context search",
            "cetus artifact",
        ] {
            assert!(recorded.contains(command), "CLI command missing: {command}");
        }
        assert!(
            events
                .iter()
                .any(|event| event.pointer("/result/details/name")
                    == Some(&json!("cli-test-report.txt"))),
            "CLI artifact was not promoted to a file card: {recorded}"
        );
        assert!(
            !isolated_home.join("cordis.patch.yml").exists(),
            "must not mount Cetus plugins"
        );
        assert!(
            events.iter().any(|event| event
                .pointer("/assistantMessageEvent/type")
                .and_then(Value::as_str)
                == Some("toolcall_start")
                || event.get("type").and_then(Value::as_str) == Some("tool_execution_start")),
            "no tool call observed: {}",
            serde_json::to_string(&*events).unwrap()
        );
        let _ = std::fs::remove_dir_all(isolated_home);
    }
}
