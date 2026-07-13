//! Long-lived pseudo-terminal sessions for Workspace Terminal tabs.
//!
//! This is deliberately separate from `bash::run_bash`: the latter is the
//! composer's one-shot `!cmd` escape hatch, while this module owns interactive
//! shells with a real controlling TTY, streaming output, resize, and stdin.

use crate::AppState;
use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;
const MAX_DIMENSION: u16 = 1_000;

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

type Sessions = Arc<Mutex<HashMap<String, TerminalSession>>>;

#[derive(Default)]
pub struct TerminalRuntime {
    sessions: Sessions,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputEvent {
    session_id: String,
    /// PTY output is bytes, not necessarily valid UTF-8. Base64 preserves ANSI
    /// sequences and split multibyte characters for xterm.js's Uint8Array API.
    data_base64: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalExitEvent {
    session_id: String,
    exit_code: u32,
    signal: Option<String>,
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: cols.clamp(1, MAX_DIMENSION),
        rows: rows.clamp(1, MAX_DIMENSION),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn local_shell(cwd: &str) -> CommandBuilder {
    let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into());
    let mut command = CommandBuilder::new(shell);
    command.arg("-l");
    command.cwd(cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "cetus");
    command
}

fn remote_shell(remote: &cetus_bridge::remote::RemoteWorkspace) -> CommandBuilder {
    let mut command = CommandBuilder::new("ssh");
    // A remote command suppresses OpenSSH's automatic TTY allocation, even
    // though ssh itself is attached to our local PTY. Force one for the remote
    // login shell too.
    command.arg("-tt");
    if let Some(port) = remote.port {
        command.arg("-p");
        command.arg(port.to_string());
    }
    command.arg(&remote.target);
    command.arg(format!(
        "mkdir -p {path} && cd {path} && exec \"${{SHELL:-/bin/sh}}\" -l",
        path = cetus_bridge::remote::shell_word(&remote.path),
    ));
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "cetus");
    command
}

/// Start a real interactive shell for one Terminal tab. Repeated starts for an
/// already-live id are idempotent (important across harmless frontend rerenders).
#[tauri::command]
pub fn terminal_start(
    runtime: State<'_, TerminalRuntime>,
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: String,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<(), String> {
    if session_id.trim().is_empty() {
        return Err("terminal session id is empty".to_string());
    }
    // Hold the registry lock through spawn+insert so duplicate frontend mounts
    // cannot race two shells into the same tab id.
    let mut session_registry = runtime.sessions.lock().unwrap();
    if session_registry.contains_key(&session_id) {
        return Ok(());
    }

    let requested = cwd.unwrap_or_default();
    let remote = cetus_bridge::remote::parse_remote_workspace(&requested);
    let local_cwd = if remote.is_none() && std::path::Path::new(&requested).is_dir() {
        requested
    } else {
        state.default_workspace.to_string_lossy().into_owned()
    };
    let command = match remote.as_ref() {
        Some(remote) => remote_shell(remote),
        None => local_shell(&local_cwd),
    };

    let pair = native_pty_system()
        .openpty(pty_size(
            cols.unwrap_or(DEFAULT_COLS),
            rows.unwrap_or(DEFAULT_ROWS),
        ))
        .map_err(|error| format!("failed to open terminal: {error}"))?;
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("failed to start terminal shell: {error}"))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("failed to open terminal output: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("failed to open terminal input: {error}"))?;
    let killer = child.clone_killer();

    session_registry.insert(
        session_id.clone(),
        TerminalSession {
            master: pair.master,
            writer,
            killer,
        },
    );
    drop(session_registry);

    let sessions = runtime.sessions.clone();
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 16 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let _ = app.emit(
                        "terminal-output",
                        TerminalOutputEvent {
                            session_id: session_id.clone(),
                            data_base64: base64::engine::general_purpose::STANDARD
                                .encode(&buffer[..read]),
                        },
                    );
                }
            }
        }
        // Drain PTY output before announcing exit so the UI never paints the
        // exit marker ahead of the process's final line.
        let status = child.wait();
        sessions.lock().unwrap().remove(&session_id);
        if let Ok(status) = status {
            let _ = app.emit(
                "terminal-exit",
                TerminalExitEvent {
                    session_id,
                    exit_code: status.exit_code(),
                    signal: status.signal().map(str::to_string),
                },
            );
        }
    });

    Ok(())
}

#[tauri::command]
pub fn terminal_write(
    runtime: State<'_, TerminalRuntime>,
    session_id: String,
    data_base64: String,
) -> Result<(), String> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|error| format!("invalid terminal input: {error}"))?;
    let mut sessions = runtime.sessions.lock().unwrap();
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "terminal session is not running".to_string())?;
    session.writer.write_all(&data).map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn terminal_resize(
    runtime: State<'_, TerminalRuntime>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = runtime.sessions.lock().unwrap();
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "terminal session is not running".to_string())?;
    session
        .master
        .resize(pty_size(cols, rows))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn terminal_stop(
    runtime: State<'_, TerminalRuntime>,
    session_id: String,
) -> Result<(), String> {
    if let Some(mut session) = runtime.sessions.lock().unwrap().remove(&session_id) {
        session.killer.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

impl TerminalRuntime {
    pub fn shutdown_all(&self) {
        for (_, mut session) in self.sessions.lock().unwrap().drain() {
            let _ = session.killer.kill();
        }
    }
}
