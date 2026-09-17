use super::{
    AppState, BufReader, Context, Conversation, Duration, Path, PathBuf, Serialize, State, Stdio,
    TokioCommand, Value,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

/// What a CLI backend actually runs when no per-conversation override is set,
/// resolved from the vendor's own config on disk — so the tuning menu can echo
/// "Default (Opus)" instead of a bare "Default". For codex it also carries the
/// live model catalog reported by the CLI itself, which replaces the static
/// fallback catalog in the UI. Everything is best-effort: unreadable config or
/// an unavailable CLI → None → the UI shows a plain "Default".
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CliDefaults {
    /// Raw configured model id (e.g. "claude-fable-5[1m]" / "gpt-5.5").
    pub model: Option<String>,
    /// Raw configured reasoning effort (e.g. "high" / "medium").
    pub effort: Option<String>,
    /// Models the CLI itself lists (selectable id + display name).
    pub models: Option<Vec<CliModelEntry>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliModelEntry {
    pub id: String,
    pub label: String,
}

#[tauri::command]
pub async fn get_cli_defaults(backend: String) -> Result<CliDefaults, String> {
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .map_err(|e| e.to_string())?;
    Ok(match backend.as_str() {
        "claude-code" => {
            let mut defaults = claude_defaults(&home);
            // The initialize probe is the only source of the live model
            // catalog, so it runs even when settings pin a model — otherwise
            // a pinned model would leave the picker on the static alias list,
            // blind to new releases. The pinned model itself still wins over
            // the probed account default (which is rollout dependent and not
            // persisted in settings).
            if let Some(probed) = probe_claude_defaults().await {
                if defaults.model.is_none() {
                    defaults.model = probed.model;
                }
                defaults.models = probed.models;
            }
            defaults
        }
        "codex" => codex_defaults(&home),
        "grok" => probe_grok_defaults().await.unwrap_or_default(),
        "dsh" => dsh_defaults(&home),
        _ => CliDefaults::default(),
    })
}

/// Grok exposes its account-specific model catalog and each model's supported
/// reasoning efforts in the ACP initialize response. Probe that response so
/// the picker follows server-side rollouts instead of relying on a stale list.
async fn probe_grok_defaults() -> Option<CliDefaults> {
    let mut command = TokioCommand::new("grok");
    command
        .args(["agent", "stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().ok()?;
    let mut stdin = child.stdin.take()?;
    let stdout = child.stdout.take()?;
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": 1,
            "clientCapabilities": {
                "fs": { "readTextFile": false, "writeTextFile": false },
                "terminal": false
            },
            "clientInfo": { "name": "cetus", "version": env!("CARGO_PKG_VERSION") }
        }
    })
    .to_string();
    stdin.write_all(request.as_bytes()).await.ok()?;
    stdin.write_all(b"\n").await.ok()?;
    stdin.flush().await.ok()?;

    let mut lines = BufReader::new(stdout).lines();
    let response = tokio::time::timeout(Duration::from_secs(10), async {
        while let Ok(Some(line)) = lines.next_line().await {
            let value: Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(_) => continue,
            };
            if value.get("id").and_then(Value::as_u64) == Some(1) {
                return Some(value);
            }
        }
        None
    })
    .await
    .ok()
    .flatten()?;
    let _ = child.kill().await;
    let _ = child.wait().await;

    let state = response.pointer("/result/_meta/modelState")?;
    let model = state
        .get("currentModelId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let available = state.get("availableModels")?.as_array()?;
    let models: Vec<CliModelEntry> = available
        .iter()
        .filter_map(|entry| {
            let id = entry.get("modelId")?.as_str()?.to_string();
            let label = entry
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(&id)
                .to_string();
            Some(CliModelEntry { id, label })
        })
        .collect();
    let selected = available
        .iter()
        .find(|entry| entry.get("modelId").and_then(Value::as_str) == model.as_deref());
    let effort = selected
        .and_then(|entry| entry.pointer("/_meta/reasoningEffort"))
        .and_then(Value::as_str)
        .map(str::to_string);
    Some(CliDefaults {
        model,
        effort,
        models: (!models.is_empty()).then_some(models),
    })
}

/// Whether the third-party runtimes Cetus can launch are present on PATH.
/// `adopt_login_shell_env` runs before Tauri is built, so this sees the same
/// PATH later used by the actual Claude Code / Codex child processes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliRuntimeStatus {
    pub claude_code: bool,
    pub codex: bool,
    pub opencode: bool,
    pub grok: bool,
    pub kimi: bool,
    pub dsh: bool,
    /// `Some(false)` = the codex binary exists but has no visible credentials
    /// (no `~/.codex/auth.json`, no `OPENAI_API_KEY` in this process's env), so
    /// a session would die with "Missing environment variable" — the desktop
    /// app's own login does not carry over to the CLI. `None` when codex isn't
    /// installed at all.
    pub codex_logged_in: Option<bool>,
}

/// Best-effort: `codex login` persists ChatGPT/API-key auth as
/// `~/.codex/auth.json`; a custom provider may instead rely on an env var.
/// This is a presence check, not a validity check — an expired token still
/// reads as logged in.
fn codex_logged_in() -> bool {
    let auth_file = std::env::var("HOME")
        .map(|home| PathBuf::from(home).join(".codex/auth.json"))
        .is_ok_and(|path| path.exists());
    auth_file || std::env::var("OPENAI_API_KEY").is_ok_and(|key| !key.trim().is_empty())
}

#[tauri::command]
pub async fn get_cli_runtime_status() -> Result<CliRuntimeStatus, String> {
    let codex = executable_on_path("codex");
    Ok(CliRuntimeStatus {
        claude_code: executable_on_path("claude"),
        codex,
        opencode: executable_on_path("opencode"),
        grok: executable_on_path("grok"),
        kimi: executable_on_path("kimi"),
        dsh: executable_on_path("dsh"),
        codex_logged_in: codex.then(codex_logged_in),
    })
}

/// Return the last native slash-command/skill catalog reported by this
/// conversation's live CLI session. The event stream remains the update path;
/// this snapshot makes the menu resilient to renderer reloads and listener
/// startup races.
#[tauri::command]
pub async fn get_cli_commands(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<Value>, String> {
    Ok(state.cli_commands(&conversation_id))
}

/// Resolve a runtime's native slash-command/skill catalog *before* any session
/// exists — the new-chat composer has no conversation to read a live catalog
/// from, and otherwise falls back to a hardcoded handful of built-ins.
/// Claude Code answers this from its initialize handshake; Codex answers it
/// from app-server `skills/list` without creating a thread. The result is
/// cached per (backend, cwd) for the app's lifetime because either probe costs
/// a process spawn. Live sessions keep updating their own catalog through
/// `cli_commands` events, so this only ever fills the pre-session gap.
#[tauri::command]
pub async fn probe_cli_commands(
    state: State<'_, AppState>,
    backend: String,
    cwd: Option<String>,
    force_refresh: Option<bool>,
) -> Result<Vec<Value>, String> {
    if backend != "claude-code" && backend != "codex" {
        // ACP runtimes announce their catalogs only after a session opens.
        return Ok(Vec::new());
    }
    let dir = cwd.unwrap_or_default();
    let key = format!("{backend}\n{dir}");
    let cached = state.cli_command_catalog(&key);
    if !force_refresh.unwrap_or(false) {
        if let Some(cached) = cached.clone() {
            return Ok(cached);
        }
    }
    let resolved = match backend.as_str() {
        // No --safe-mode here: it suppresses skill loading, and skills are the
        // main thing this catalog exists to surface (user-level skills alone
        // can be 100+ entries; safe-mode reports none of them).
        "claude-code" => probe_claude_initialize(Some(Path::new(&dir)), false)
            .await
            .map(|ack| claude_commands_from_initialize(&ack)),
        "codex" => {
            let probe_dir = match Path::new(&dir).is_dir() {
                true => PathBuf::from(&dir),
                false => std::env::current_dir().map_err(|e| e.to_string())?,
            };
            match cetus_bridge::cli_agent::probe_codex_skills(
                "codex",
                &probe_dir,
                force_refresh.unwrap_or(false),
            )
            .await
            {
                Ok(commands) => Some(commands),
                Err(error) => {
                    tracing::warn!("Codex skill catalog probe failed: {error}");
                    None
                }
            }
        }
        _ => None,
    };
    let Some(commands) = resolved else {
        // A transient runtime failure must not throw away the last good menu.
        return Ok(cached.unwrap_or_default());
    };
    // Cache empty successful responses too: a refresh after the user removes
    // their last skill must clear the stale catalog.
    state.cache_cli_command_catalog(&key, commands.clone());
    Ok(commands)
}

/// Mirror Cetus's archive state into Codex's own saved-thread inventory so
/// clients backed by the same CODEX_HOME (including the Codex app) put the
/// conversation in the same bucket. This is deliberately best-effort at the
/// call sites: a missing/older CLI must not make a local Cetus archive fail.
///
/// Claude Code has no corresponding archive API/CLI command. Its session
/// picker therefore remains independent of Cetus's archive state.
pub(crate) async fn sync_codex_archive_state(
    conversation: &Conversation,
    archive: bool,
) -> anyhow::Result<()> {
    if conversation.backend != "codex" || conversation.session_file.trim().is_empty() {
        return Ok(());
    }

    let action = if archive { "archive" } else { "unarchive" };
    let mut command = TokioCommand::new("codex");
    command
        .arg(action)
        .arg(conversation.session_file.trim())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(10), command.output())
        .await
        .with_context(|| format!("`codex {action}` timed out"))?
        .with_context(|| format!("failed to launch `codex {action}`"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let detail = if stderr.is_empty() {
        output.status.to_string()
    } else {
        stderr
    };
    anyhow::bail!("`codex {action}` failed: {detail}")
}

fn executable_on_path(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).any(|dir| dir.join(name).is_file()))
        .unwrap_or(false)
}

fn claude_defaults(home: &Path) -> CliDefaults {
    let raw = std::fs::read_to_string(home.join(".claude/settings.json")).unwrap_or_default();
    let v: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let s = |key: &str| v.get(key).and_then(|x| x.as_str()).map(str::to_string);
    // settings.json holds an explicit `model` only when the user pinned one; the
    // `/model` picker instead persists its choice to ~/.claude.json's top-level
    // `model`, so fall back there before giving up. Neither present means the
    // account's recommended default; `probe_claude_defaults` resolves it.
    let model = s("model").or_else(|| claude_json_model(home));
    CliDefaults {
        model,
        effort: s("effortLevel"),
        models: None,
    }
}

async fn probe_claude_defaults() -> Option<CliDefaults> {
    claude_defaults_from_initialize(&probe_claude_initialize(None, true).await?)
}

/// Run Claude Code's initialize handshake and return the raw ack. It carries
/// both the account's resolved model catalog and the full slash-command/skill
/// catalog for `cwd` (project skills are cwd-dependent, so pass the workspace
/// the conversation will run in). `safe_mode` passes `--safe-mode`, which
/// keeps user hooks/plugins from running during a read-only probe — but it
/// also strips the entire skill catalog from the ack, so it's only for the
/// models probe, never the slash-command one. Keep stdin open until the
/// response arrives, then terminate the idle process without sending a turn.
async fn probe_claude_initialize(cwd: Option<&Path>, safe_mode: bool) -> Option<Value> {
    let mut command = TokioCommand::new("claude");
    if safe_mode {
        command.arg("--safe-mode");
    }
    command
        .args([
            "-p",
            "--output-format",
            "stream-json",
            "--input-format",
            "stream-json",
            "--verbose",
            "--permission-prompt-tool",
            "stdio",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Some(dir) = cwd.filter(|dir| dir.is_dir()) {
        command.current_dir(dir);
    }
    let mut child = command.spawn().ok()?;
    let mut stdin = child.stdin.take()?;
    let stdout = child.stdout.take()?;
    let init = serde_json::json!({
        "type": "control_request",
        "request_id": "cetus-models",
        "request": { "subtype": "initialize" },
    })
    .to_string();
    stdin.write_all(init.as_bytes()).await.ok()?;
    stdin.write_all(b"\n").await.ok()?;
    stdin.flush().await.ok()?;

    let mut lines = BufReader::new(stdout).lines();
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        while let Ok(Some(line)) = lines.next_line().await {
            let value: Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(_) => continue,
            };
            if value.pointer("/response/response").is_some() {
                return Some(value);
            }
        }
        None
    })
    .await
    .ok()
    .flatten();
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}

/// Version digits carried by a model id ("claude-fable-5-1[1m]" → "5.1"),
/// skipping 8-digit date stamps ("claude-haiku-4-5-20251001" → "4.5").
fn claude_model_version(raw: &str) -> Option<String> {
    let base = raw.split('[').next().unwrap_or(raw);
    let nums: Vec<&str> = base
        .split('-')
        .filter(|t| !t.is_empty() && t.len() < 8 && t.bytes().all(|b| b.is_ascii_digit()))
        .collect();
    (!nums.is_empty()).then(|| nums.join("."))
}

/// Append the model's version to the CLI's display name ("Fable" →
/// "Fable 5.1", "Opus (1M context)" → "Opus 5 (1M context)"). The initialize
/// catalog's displayName carries no version, so two CLI releases pointing
/// "Fable" at different models would otherwise be indistinguishable in the
/// picker. The version comes from the selectable id, falling back to
/// resolvedModel for floating aliases like "opus[1m]"; names already carrying
/// a digit are left alone.
pub(super) fn claude_versioned_label(
    display_name: &str,
    id: &str,
    resolved: Option<&str>,
) -> String {
    let (name, suffix) = match display_name.split_once(" (") {
        Some((name, rest)) => (name, Some(rest)),
        None => (display_name, None),
    };
    if name.bytes().any(|b| b.is_ascii_digit()) {
        return display_name.to_string();
    }
    let Some(version) =
        claude_model_version(id).or_else(|| resolved.and_then(claude_model_version))
    else {
        return display_name.to_string();
    };
    match suffix {
        Some(rest) => format!("{name} {version} ({rest}"),
        None => format!("{name} {version}"),
    }
}

pub(super) fn claude_defaults_from_initialize(value: &Value) -> Option<CliDefaults> {
    let models = value.pointer("/response/response/models")?.as_array()?;
    let default = models
        .iter()
        .find(|model| model.get("value").and_then(Value::as_str) == Some("default"))?;
    let model = default
        .get("resolvedModel")
        .and_then(Value::as_str)
        .map(str::to_string);
    let catalog: Vec<CliModelEntry> = models
        .iter()
        .filter_map(|entry| {
            let id = entry.get("value")?.as_str()?;
            if id == "default" {
                return None;
            }
            let label = entry
                .get("displayName")
                .and_then(Value::as_str)
                .unwrap_or(id);
            let resolved = entry.get("resolvedModel").and_then(Value::as_str);
            Some(CliModelEntry {
                id: id.to_string(),
                label: claude_versioned_label(label, id, resolved),
            })
        })
        .collect();
    Some(CliDefaults {
        model,
        effort: None,
        models: (!catalog.is_empty()).then_some(catalog),
    })
}

/// The slash-command/skill catalog carried by the initialize ack, in the same
/// shape the bridge emits as `cli_commands` (see `cetus_bridge::cli_agent`):
/// descriptions ending in "(user)"/"(project)"/"(plugin)"/"(builtin)" are
/// skills, everything else is a built-in command.
pub(super) fn claude_commands_from_initialize(value: &Value) -> Vec<Value> {
    let Some(commands) = value
        .pointer("/response/response/commands")
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    commands
        .iter()
        .filter_map(|command| {
            let name = command.get("name").and_then(Value::as_str)?;
            let description = command
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("");
            let is_skill = ["(user)", "(project)", "(plugin)", "(builtin)"]
                .iter()
                .any(|suffix| description.trim_end().ends_with(suffix));
            Some(serde_json::json!({
                "name": name,
                "description": description,
                "argumentHint": command
                    .get("argumentHint")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                "kind": if is_skill { "skill" } else { "command" },
            }))
        })
        .collect()
}

/// Top-level `model` from ~/.claude.json, where the `/model` picker persists an
/// explicitly chosen default. Absent when the user stays on the recommended one.
fn claude_json_model(home: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(home.join(".claude.json")).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    v.get("model").and_then(|x| x.as_str()).map(str::to_string)
}

fn codex_defaults(home: &Path) -> CliDefaults {
    // config.toml: `model` / `model_reasoning_effort` are top-level keys (they
    // sit above the first [section]), so a line scan beats pulling in a full
    // TOML parser as a dependency.
    let cfg = std::fs::read_to_string(home.join(".codex/config.toml")).unwrap_or_default();
    let mut model = None;
    let mut effort = None;
    for line in cfg.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            break;
        }
        if let Some(v) = toml_str_value(line, "model") {
            model = Some(v);
        }
        if let Some(v) = toml_str_value(line, "model_reasoning_effort") {
            effort = Some(v);
        }
    }
    // models_cache.json is the catalog codex itself fetched; "hide" entries are
    // internal (auto-review etc.).
    let cache = std::fs::read_to_string(home.join(".codex/models_cache.json")).unwrap_or_default();
    let cache: Value = serde_json::from_str(&cache).unwrap_or(Value::Null);
    let entries = cache.get("models").and_then(|m| m.as_array());
    let models: Vec<CliModelEntry> = entries
        .map(|arr| {
            arr.iter()
                .filter(|m| m.get("visibility").and_then(|v| v.as_str()) != Some("hide"))
                .filter_map(|m| {
                    let id = m.get("slug")?.as_str()?.to_string();
                    let label = m
                        .get("display_name")
                        .and_then(|d| d.as_str())
                        .unwrap_or(&id)
                        .to_string();
                    Some(CliModelEntry { id, label })
                })
                .collect()
        })
        .unwrap_or_default();
    // No explicit effort in config → the default model's own default level.
    if effort.is_none() {
        effort = entries.and_then(|arr| {
            arr.iter()
                .find(|m| m.get("slug").and_then(|s| s.as_str()) == model.as_deref())
                .and_then(|m| m.get("default_reasoning_level"))
                .and_then(|d| d.as_str())
                .map(str::to_string)
        });
    }
    CliDefaults {
        model,
        effort,
        models: (!models.is_empty()).then_some(models),
    }
}

/// DSH persists the selection made by its model picker under the
/// `agent-default-model` mapping in `$DSH_HOME/settings.yaml`. Keep this
/// deliberately small instead of adding a YAML dependency for three scalar
/// fields; stop at the next top-level key so similarly named plugin settings
/// cannot be mistaken for the agent defaults.
fn dsh_defaults(home: &Path) -> CliDefaults {
    let dsh_home = std::env::var_os("DSH_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".dsh"));
    let raw = std::fs::read_to_string(dsh_home.join("settings.yaml")).unwrap_or_default();
    let mut defaults = dsh_defaults_from_settings(&raw);
    defaults.model = Some("deepseek-flash".into());
    defaults
}

pub(super) fn dsh_defaults_from_settings(raw: &str) -> CliDefaults {
    let mut in_defaults = false;
    let mut model = None;
    let mut effort = None;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indented = line.starts_with([' ', '\t']);
        if !indented {
            in_defaults = trimmed == "agent-default-model:";
            continue;
        }
        if !in_defaults {
            continue;
        }
        if let Some(value) = yaml_scalar(trimmed, "model") {
            model = Some(value);
        } else if let Some(value) = yaml_scalar(trimmed, "reasoningEffort") {
            effort = Some(value);
        }
    }
    CliDefaults {
        model,
        effort,
        models: None,
    }
}

fn yaml_scalar(line: &str, key: &str) -> Option<String> {
    let value = line.strip_prefix(key)?.strip_prefix(':')?.trim();
    let value = value.split(" #").next()?.trim();
    let unquoted = value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .or_else(|| {
            value
                .strip_prefix('\'')
                .and_then(|value| value.strip_suffix('\''))
        })
        .unwrap_or(value);
    (!unquoted.is_empty()).then(|| unquoted.to_string())
}

/// `key = "value"` on a single TOML line → value. Rejects longer keys sharing
/// the prefix (`model` won't match `model_reasoning_effort` — the remainder
/// must start with `=`).
fn toml_str_value(line: &str, key: &str) -> Option<String> {
    let rest = line.strip_prefix(key)?.trim_start();
    let rest = rest.strip_prefix('=')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    rest.split('"').next().map(str::to_string)
}
