//! One-shot diagnostics report for user bug reports. Everything a "codex
//! doesn't work in Cetus" style thread needs — versions, PATH, runtime
//! presence/auth, recent log tail — collected into a single sanitized text the
//! user can review and paste into an issue or chat. Values that could carry
//! secrets (config values, env vars other than PATH/SHELL) are never included;
//! only key *names* and file *presence* are reported.

use std::path::PathBuf;
use std::time::Duration;

use tokio::process::Command;

/// Runtimes worth probing, matching `CliRuntimeStatus`.
const RUNTIMES: &[&str] = &["claude", "codex", "opencode", "grok", "kimi", "dsh"];

#[tauri::command]
pub async fn export_diagnostics() -> Result<String, String> {
    let mut out = String::new();
    let mut push = |line: &str| {
        out.push_str(line);
        out.push('\n');
    };

    push("== Cetus diagnostics ==");
    push(&format!("cetus {}", env!("CARGO_PKG_VERSION")));
    push(&format!(
        "{} {}",
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    push(&format!(
        "generated {}",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S %z")
    ));
    push("Review before sharing — paths below include your username.");

    push("\n== Environment ==");
    push(&format!(
        "SHELL = {}",
        std::env::var("SHELL").unwrap_or_else(|_| "(unset)".into())
    ));
    push("PATH =");
    for dir in std::env::var("PATH").unwrap_or_default().split(':') {
        push(&format!("  {dir}"));
    }

    push("\n== Runtimes ==");
    for bin in RUNTIMES {
        match resolve_on_path(bin) {
            Some(path) => {
                let version = version_of(&path).await;
                push(&format!("{bin}: {} — {version}", path.display()));
            }
            None => push(&format!("{bin}: not on PATH")),
        }
    }

    push("\n== Codex auth/config ==");
    if let Some(home) = crate::dirs_home() {
        let auth = home.join(".codex/auth.json");
        push(&format!(
            "~/.codex/auth.json: {}",
            if auth.exists() {
                "present"
            } else {
                "MISSING (run `codex login`)"
            }
        ));
        push(&format!(
            "OPENAI_API_KEY in app env: {}",
            if std::env::var("OPENAI_API_KEY").is_ok_and(|k| !k.trim().is_empty()) {
                "set"
            } else {
                "unset"
            }
        ));
        match std::fs::read_to_string(home.join(".codex/config.toml")) {
            Ok(text) => {
                push("~/.codex/config.toml keys (values redacted):");
                for line in toml_skeleton(&text) {
                    push(&format!("  {line}"));
                }
            }
            Err(_) => push("~/.codex/config.toml: absent"),
        }
    }

    push("\n== Recent log ==");
    match latest_log() {
        Some((path, tail)) => {
            push(&format!("{} (last {} lines)", path.display(), tail.len()));
            for line in tail {
                push(&line);
            }
        }
        None => push("no log file found"),
    }

    Ok(out)
}

/// First hit for `bin` on this process's PATH (the same PATH child runtimes
/// inherit, post `adopt_login_shell_env`).
fn resolve_on_path(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|dir| {
        let candidate = dir.join(bin);
        #[cfg(target_os = "windows")]
        let candidate = candidate.with_extension("exe");
        candidate.is_file().then_some(candidate)
    })
}

/// `<bin> --version`, first line, 3s cap — a hung binary shouldn't hang the
/// report.
async fn version_of(path: &PathBuf) -> String {
    let run = Command::new(path).arg("--version").output();
    match tokio::time::timeout(Duration::from_secs(3), run).await {
        Ok(Ok(output)) if output.status.success() => String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .to_string(),
        Ok(Ok(output)) => format!("--version exited {}", output.status),
        Ok(Err(error)) => format!("failed to run: {error}"),
        Err(_) => "--version timed out".into(),
    }
}

/// Structure of a TOML file without any of its values: `[table]` headers
/// verbatim, `key = value` reduced to `key = …`. Enough to spot a custom
/// model provider or `preferred_auth_method` without leaking keys or URLs.
fn toml_skeleton(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.starts_with('[') {
                return Some(trimmed.to_string());
            }
            let key = trimmed.split('=').next()?.trim();
            (!key.is_empty() && !key.starts_with('#') && trimmed.contains('='))
                .then(|| format!("{key} = …"))
        })
        .collect()
}

/// Most recently modified file in the log dir, with its last 120 lines.
fn latest_log() -> Option<(PathBuf, Vec<String>)> {
    let dir = crate::log_dir()?;
    let newest = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| e.path().is_file())
        .max_by_key(|e| {
            e.metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH)
        })?;
    let text = std::fs::read_to_string(newest.path()).ok()?;
    let lines: Vec<&str> = text.lines().collect();
    let tail = lines
        .iter()
        .skip(lines.len().saturating_sub(120))
        .map(|s| s.to_string())
        .collect();
    Some((newest.path(), tail))
}

#[cfg(test)]
mod tests {
    use super::toml_skeleton;

    #[test]
    fn toml_skeleton_redacts_values() {
        let text = "model = \"gpt-5.3\"\n# comment\n[model_providers.proxy]\nbase_url = \"https://secret.example\"\nenv_key = \"OPENAI_API_KEY\"\n";
        let lines = toml_skeleton(text);
        assert_eq!(
            lines,
            vec![
                "model = …",
                "[model_providers.proxy]",
                "base_url = …",
                "env_key = …",
            ]
        );
        assert!(!lines.join("\n").contains("secret"));
    }
}
