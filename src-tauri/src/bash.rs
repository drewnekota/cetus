//! Local shell escape hatch for the composer's `!` bash mode.
//!
//! Runs a one-shot command in the conversation's workspace directory and
//! returns its output to the frontend, which renders it inline in the chat.
//! This bypasses the agent entirely — it's the in-app equivalent of dropping
//! to a terminal, mirroring Claude Code's `!` prefix.

use crate::AppState;
use std::process::Stdio;
use std::time::Duration;
use tauri::State;
use tokio::process::Command;

/// Hard ceiling on captured output so a runaway command (`yes`, a huge log)
/// can't blow up the IPC payload or the rendered bubble. Each stream is capped
/// independently.
const MAX_OUTPUT_BYTES: usize = 100_000;

/// Wall-clock limit for a single command. Long enough for a build step, short
/// enough that a hung process (waiting on stdin, a stuck network call) doesn't
/// wedge the composer forever.
const TIMEOUT: Duration = Duration::from_secs(120);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BashResult {
    pub stdout: String,
    pub stderr: String,
    /// Process exit code, or -1 when the process was killed by a signal /
    /// the timeout (no code available).
    pub exit_code: i32,
    pub timed_out: bool,
    /// The directory the command actually ran in (echoed back so the UI can
    /// show it without re-deriving the fallback).
    pub cwd: String,
}

/// Truncate UTF-8 safely at a byte budget, appending a marker when clipped.
fn cap(mut s: String) -> String {
    if s.len() <= MAX_OUTPUT_BYTES {
        return s;
    }
    // Back off to a char boundary so we never split a multibyte sequence.
    let mut end = MAX_OUTPUT_BYTES;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s.truncate(end);
    s.push_str("\n… [output truncated]");
    s
}

/// Run `command` in a login shell rooted at `cwd` (falling back to the default
/// workspace when `cwd` is absent or not a directory). Errors only surface for
/// spawn failures — a non-zero exit is a normal result carried in `exit_code`.
#[tauri::command]
pub async fn run_bash(
    state: State<'_, AppState>,
    command: String,
    cwd: Option<String>,
) -> Result<BashResult, String> {
    let dir = cwd
        .filter(|d| {
            cetus_bridge::remote::parse_remote_workspace(d).is_some()
                || std::path::Path::new(d).is_dir()
        })
        .unwrap_or_else(|| state.default_workspace.to_string_lossy().to_string());

    if let Some(remote) = cetus_bridge::remote::parse_remote_workspace(&dir) {
        return run_remote_bash(remote, command).await;
    }

    // Use the user's interactive shell so PATH / aliases match their terminal;
    // `-l -c` loads the login profile then runs the command string. Fall back
    // to /bin/sh when $SHELL is unset (rare, but keeps us safe).
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());

    let child = Command::new(&shell)
        .arg("-l")
        .arg("-c")
        .arg(&command)
        .current_dir(&dir)
        // Detach stdin so an interactive command (one that reads input) returns
        // promptly on EOF instead of hanging until the timeout.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to launch {shell}: {e}"))?;

    // Grab the pid before wait_with_output consumes the handle, so the timeout
    // branch can still reap the orphaned process group instead of leaking it.
    let pid = child.id();

    let output = match tokio::time::timeout(TIMEOUT, child.wait_with_output()).await {
        Ok(res) => res.map_err(|e| e.to_string())?,
        Err(_) => {
            if let Some(pid) = pid {
                let _ = std::process::Command::new("/bin/kill")
                    .arg("-9")
                    .arg(pid.to_string())
                    .output();
            }
            return Ok(BashResult {
                stdout: String::new(),
                stderr: format!("Command timed out after {}s.", TIMEOUT.as_secs()),
                exit_code: -1,
                timed_out: true,
                cwd: dir,
            });
        }
    };

    Ok(BashResult {
        stdout: cap(String::from_utf8_lossy(&output.stdout).into_owned()),
        stderr: cap(String::from_utf8_lossy(&output.stderr).into_owned()),
        exit_code: output.status.code().unwrap_or(-1),
        timed_out: false,
        cwd: dir,
    })
}

async fn run_remote_bash(
    remote: cetus_bridge::remote::RemoteWorkspace,
    command: String,
) -> Result<BashResult, String> {
    let script = format!(
        "mkdir -p {} && cd {} && exec \"${{SHELL:-/bin/sh}}\" -lc {}",
        cetus_bridge::remote::shell_word(&remote.path),
        cetus_bridge::remote::shell_word(&remote.path),
        cetus_bridge::remote::shell_word(&command),
    );
    let mut ssh = Command::new("ssh");
    ssh.args(cetus_bridge::remote::remote_command_args(&remote, &script))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = ssh
        .spawn()
        .map_err(|e| format!("failed to launch ssh {}: {e}", remote.target))?;
    let pid = child.id();
    let output = match tokio::time::timeout(TIMEOUT, child.wait_with_output()).await {
        Ok(res) => res.map_err(|e| e.to_string())?,
        Err(_) => {
            if let Some(pid) = pid {
                let _ = std::process::Command::new("/bin/kill")
                    .arg("-9")
                    .arg(pid.to_string())
                    .output();
            }
            return Ok(BashResult {
                stdout: String::new(),
                stderr: format!("Command timed out after {}s.", TIMEOUT.as_secs()),
                exit_code: -1,
                timed_out: true,
                cwd: remote.display(),
            });
        }
    };

    Ok(BashResult {
        stdout: cap(String::from_utf8_lossy(&output.stdout).into_owned()),
        stderr: cap(String::from_utf8_lossy(&output.stderr).into_owned()),
        exit_code: output.status.code().unwrap_or(-1),
        timed_out: false,
        cwd: remote.display(),
    })
}
