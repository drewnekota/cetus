//! `cetus` CLI: a thin std-only client for the control socket (`control.rs`),
//! entered via `Cetus cli …` in `main.rs`. The `cetus` shim on child agents'
//! `PATH` execs that, so from an agent's shell this is just `cetus cron list`.
//!
//! Kept deliberately dumb: parse argv → one JSON-lines request over
//! `$CETUS_SOCK` → pretty-print the response. The single smart bit is `cron
//! edit`, which get-merges so agents can send a partial patch instead of
//! reconstructing the full input. No tokio, no clap — this path must add
//! nothing to app startup and stay instant as a CLI.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};

const HELP: &str = r#"cetus — control CLI for the running Cetus app

USAGE
  cetus artifact <path>                Deliver any local file to the Cetus chat
  cetus cron list                      List scheduled automations
  cetus cron get <id>
  cetus cron create '<input-json>'
  cetus cron edit <id> '<patch-json>'  Merge fields into an existing automation
  cetus cron rm <id>
  cetus cron enable <id> | disable <id>
  cetus cron run <id>                  Fire now (does not shift the schedule)
  cetus ping | version | help

INPUT JSON — create requires name/prompt/schedule; edit takes any subset:
  {"name":"…","prompt":"…","schedule":<schedule>,
   "workspaceDir":"/abs/path",           // optional; agent cwd default
   "enabled":true,                       // optional; default true
   "backend":"pi"|"claude-code"|"codex", // optional; default "pi"
   "cliModel":"…","cliEffort":"…"}       // optional, CLI backends only

SCHEDULE (all times local):
  {"kind":"once","atMs":<epoch-ms>}
  {"kind":"interval","everyMinutes":30}
  {"kind":"daily","time":"09:00","weekdays":[1,2,3,4,5]}  // 0=Sun; [] = daily
  {"kind":"cron","expr":"0 9 * * 1-5"}                    // standard 5-field

Talks JSON-lines to the app over $CETUS_SOCK. Requires the Cetus app running.
Never edit Cetus's sqlite database directly — schedules are validated and
next-run times recomputed only on this path."#;

/// Entry point for `Cetus cli <args…>`. Returns the process exit code.
pub fn run(args: Vec<String>) -> i32 {
    match run_inner(&args) {
        Ok(out) => {
            println!("{out}");
            0
        }
        Err(e) => {
            eprintln!("cetus: {e}");
            1
        }
    }
}

fn run_inner(args: &[String]) -> Result<String, String> {
    let cmd: Vec<&str> = args.iter().map(String::as_str).collect();
    match cmd.as_slice() {
        [] | ["help" | "--help" | "-h"] | ["cron"] | ["cron", "help"] => Ok(HELP.to_string()),
        ["ping"] => request(&json!({ "op": "ping" })).map(|_| "ok".to_string()),
        ["version"] => request(&json!({ "op": "version" })).map(pretty),
        ["artifact", path] => artifact_marker(path),
        ["cron", "list"] => request(&json!({ "op": "automation.list" })).map(pretty),
        ["cron", "get", id] => {
            request(&json!({ "op": "automation.get", "automationId": id })).map(pretty)
        }
        ["cron", "create", input] => {
            let input = parse_json(input)?;
            request(&json!({ "op": "automation.create", "input": input })).map(pretty)
        }
        ["cron", "edit", id, patch] => {
            let patch = parse_json(patch)?;
            let existing = request(&json!({ "op": "automation.get", "automationId": id }))?;
            let input = merge_patch(&existing, &patch)?;
            request(&json!({ "op": "automation.update", "automationId": id, "input": input }))
                .map(pretty)
        }
        ["cron", "rm", id] => request(&json!({ "op": "automation.delete", "automationId": id }))
            .map(|_| "deleted".to_string()),
        ["cron", "enable", id] => request(
            &json!({ "op": "automation.enable", "automationId": id, "enabled": true }),
        )
        .map(pretty),
        ["cron", "disable", id] => request(
            &json!({ "op": "automation.enable", "automationId": id, "enabled": false }),
        )
        .map(pretty),
        ["cron", "run", id] => {
            request(&json!({ "op": "automation.runNow", "automationId": id })).map(pretty)
        }
        other => Err(format!(
            "unknown command: {:?} — run `cetus help`",
            other.join(" ")
        )),
    }
}

fn artifact_marker(raw: &str) -> Result<String, String> {
    let path = std::path::PathBuf::from(raw);
    let path = if path.is_absolute() {
        path
    } else {
        std::env::current_dir().map_err(|e| e.to_string())?.join(path)
    };
    let metadata = std::fs::metadata(&path)
        .map_err(|e| format!("cannot read artifact {}: {e}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("artifact is not a regular file: {}", path.display()));
    }
    let path = path.canonicalize().unwrap_or(path);
    Ok(format!(
        "CETUS_ARTIFACT:{}",
        json!({ "path": path.to_string_lossy(), "sizeBytes": metadata.len() })
    ))
}

fn parse_json(s: &str) -> Result<Value, String> {
    serde_json::from_str(s).map_err(|e| format!("invalid JSON argument: {e}"))
}

fn pretty(v: Value) -> String {
    serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string())
}

/// Build a full `AutomationInput` for `automation.update` from the fetched
/// automation overlaid with the caller's partial patch. Only input fields are
/// carried over — run-state (`nextRunAt`, counters, …) is server-derived and
/// silently dropped here so a round-tripped `get` output is a valid patch.
fn merge_patch(existing: &Value, patch: &Value) -> Result<Value, String> {
    let patch = patch
        .as_object()
        .ok_or_else(|| "patch must be a JSON object".to_string())?;
    const INPUT_FIELDS: [&str; 9] = [
        "name",
        "prompt",
        "workspaceDir",
        "model",
        "schedule",
        "enabled",
        "backend",
        "cliModel",
        "cliEffort",
    ];
    let mut input = serde_json::Map::new();
    for field in INPUT_FIELDS {
        if let Some(v) = patch.get(field).or_else(|| existing.get(field)) {
            input.insert(field.to_string(), v.clone());
        }
    }
    if let Some(unknown) = patch.keys().find(|k| !INPUT_FIELDS.contains(&k.as_str())) {
        return Err(format!(
            "unknown field {unknown:?} — editable fields: {}",
            INPUT_FIELDS.join(", ")
        ));
    }
    Ok(Value::Object(input))
}

/// Default socket path when `$CETUS_SOCK` isn't set (mirrors
/// `control::socket_path` without a Tauri handle): the app data dir of the
/// bundle identifier in `tauri.conf.json`.
fn socket_path() -> Result<std::path::PathBuf, String> {
    if let Ok(p) = std::env::var("CETUS_SOCK") {
        if !p.is_empty() {
            return Ok(p.into());
        }
    }
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    Ok(format!("{home}/Library/Application Support/dev.cetus.app/cetus.sock").into())
}

#[cfg(unix)]
fn request(req: &Value) -> Result<Value, String> {
    let path = socket_path()?;
    let mut stream = std::os::unix::net::UnixStream::connect(&path).map_err(|e| {
        format!(
            "cannot reach the Cetus app at {} ({e}) — is Cetus running?",
            path.display()
        )
    })?;
    let mut line = serde_json::to_string(req).map_err(|e| e.to_string())?;
    line.push('\n');
    stream
        .write_all(line.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut resp = String::new();
    BufReader::new(&stream)
        .read_line(&mut resp)
        .map_err(|e| e.to_string())?;
    let resp: Value =
        serde_json::from_str(resp.trim()).map_err(|e| format!("bad response: {e}"))?;
    if resp.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(resp
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown error")
            .to_string())
    }
}

#[cfg(not(unix))]
fn request(_req: &Value) -> Result<Value, String> {
    Err("the cetus CLI is only supported on unix".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_patch_overlays_and_filters() {
        let existing = json!({
            "id": "a1", "name": "old", "prompt": "p", "enabled": true,
            "schedule": {"kind": "cron", "expr": "0 9 * * *"},
            "nextRunAt": 123, "runCount": 7, "backend": "pi",
        });
        let merged = merge_patch(&existing, &json!({ "name": "new" })).unwrap();
        assert_eq!(merged["name"], "new");
        assert_eq!(merged["prompt"], "p");
        assert_eq!(merged["schedule"]["expr"], "0 9 * * *");
        // Server-derived state never round-trips into the input.
        assert!(merged.get("nextRunAt").is_none());
        assert!(merged.get("runCount").is_none());
    }

    #[test]
    fn merge_patch_rejects_unknown_fields() {
        let err = merge_patch(&json!({}), &json!({ "nextRunAt": 1 })).unwrap_err();
        assert!(err.contains("nextRunAt"));
    }

    #[test]
    fn help_covers_every_subcommand() {
        for cmd in ["artifact", "list", "get", "create", "edit", "rm", "enable", "disable", "run"] {
            assert!(HELP.contains(cmd), "help is missing `{cmd}`");
        }
    }

    #[test]
    fn artifact_command_emits_machine_readable_marker_for_any_file_type() {
        let path = std::env::temp_dir().join("cetus-cli-artifact.unknown-extension");
        std::fs::write(&path, b"payload").unwrap();
        let marker = artifact_marker(path.to_str().unwrap()).unwrap();
        let payload: Value = serde_json::from_str(marker.strip_prefix("CETUS_ARTIFACT:").unwrap()).unwrap();
        assert_eq!(payload["path"], json!(path.canonicalize().unwrap().to_string_lossy()));
        assert_eq!(payload["sizeBytes"], json!(7));
        let _ = std::fs::remove_file(path);
    }
}
