//! macOS accessibility (AX) control helper — compile/resolve + long-lived IPC.
//!
//! Modeled on [`crate::ocr`]: the Swift source (`../cua/cetus-cua-helper.swift`)
//! is embedded with `include_str!`, lazily compiled with `swiftc` on first use,
//! and cached behind a `OnceLock`. Unlike the OCR helper, this one runs as a
//! **long-lived child** speaking newline-delimited JSON (one request line → one
//! response line): `AXUIElement` references are process-local and not
//! serializable, so a `dump` and a later `act` must reach the *same* process,
//! which holds the `index → AXUIElement` map in memory.
//!
//! Off macOS every call returns an error object — computer-use is macOS-only.

use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};

/// Shared, clone-friendly handle to the single AX helper child + the set of
/// conversations with a pending emergency-stop. Lives in `AppState` and is also
/// captured by the app-event listener's [`crate::agent::AgentCtx`].
#[derive(Clone)]
pub struct CuaRuntime {
    inner: Arc<Mutex<Inner>>,
    /// Conversations the user hit "Stop" on; consumed by the act path so an
    /// in-flight batch bails before touching the machine.
    stops: Arc<Mutex<HashSet<String>>>,
}

#[derive(Default)]
struct Inner {
    #[cfg(target_os = "macos")]
    proc: Option<imp::Helper>,
}

impl Default for CuaRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl CuaRuntime {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            stops: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// Flag `conv` for an emergency stop (the act path refuses the next batch).
    pub fn request_stop(&self, conv: &str) {
        self.stops.lock().unwrap().insert(conv.to_string());
    }

    /// Consume the stop flag for `conv`; true if one was pending.
    pub fn take_stop(&self, conv: &str) -> bool {
        self.stops.lock().unwrap().remove(conv)
    }

    /// Blocking: ensure the helper is up (compiling on first use) and exchange a
    /// single JSON request/response. Call inside `spawn_blocking`. Never panics —
    /// returns an `{"ok":false,"error":...}` object on any failure.
    pub fn request_blocking(&self, app_data: &Path, payload: &Value) -> Value {
        #[cfg(target_os = "macos")]
        {
            let mut g = match self.inner.lock() {
                Ok(g) => g,
                Err(_) => return json!({"ok": false, "error": "cua-runtime-poisoned"}),
            };
            imp::request(&mut g, app_data, payload)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (app_data, payload);
            json!({"ok": false, "error": "computer-use is macOS-only"})
        }
    }

    /// Drop the helper child (next request respawns it). Used on app teardown.
    pub fn shutdown(&self) {
        #[cfg(target_os = "macos")]
        {
            if let Ok(mut g) = self.inner.lock() {
                g.proc = None;
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::Inner;
    use serde_json::{json, Value};
    use std::io::{BufRead, BufReader, Write};
    use std::path::{Path, PathBuf};
    use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
    use std::sync::OnceLock;

    /// The Swift source, embedded at build time. Written to disk + compiled once
    /// on first use (mirrors `ocr.rs`).
    const HELPER_SRC: &str = include_str!("../cua/cetus-cua-helper.swift");

    /// Resolved helper path, computed once. `None` means "swiftc unavailable /
    /// build failed" — computer-use degrades to an error, capture/OCR still work.
    static HELPER: OnceLock<Option<PathBuf>> = OnceLock::new();

    pub struct Helper {
        // Kept so dropping `Helper` kills the child (Child's Drop does not, but we
        // start_kill on teardown by dropping the whole struct → fields drop; the
        // pipes close and the helper exits on EOF).
        _child: Child,
        stdin: ChildStdin,
        reader: BufReader<ChildStdout>,
    }

    impl Drop for Helper {
        fn drop(&mut self) {
            // Best-effort: closing stdin makes the helper's readLine loop hit EOF
            // and exit cleanly.
            let _ = self._child.kill();
            let _ = self._child.wait();
        }
    }

    fn helper_path(app_data: &Path) -> Option<&'static Path> {
        HELPER
            .get_or_init(|| resolve_or_compile(app_data))
            .as_deref()
    }

    fn resolve_or_compile(app_data: &Path) -> Option<PathBuf> {
        // Explicit override (dev / packaged builds that ship a prebuilt helper).
        if let Ok(p) = std::env::var("CETUS_CUA_HELPER") {
            let p = PathBuf::from(p);
            if p.exists() {
                return Some(p);
            }
        }
        let bin_dir = app_data.join("bin");
        let bin = bin_dir.join("cetus-cua-helper");
        std::fs::create_dir_all(&bin_dir).ok()?;
        let src = bin_dir.join("cetus-cua-helper.swift");
        let source_matches = std::fs::read_to_string(&src)
            .map(|existing| existing == HELPER_SRC)
            .unwrap_or(false);
        if bin.exists() && source_matches {
            return Some(bin);
        }
        if std::fs::write(&src, HELPER_SRC).is_err() {
            return None;
        }
        let output = Command::new("swiftc")
            .args([
                "-O",
                "-framework",
                "ApplicationServices",
                "-framework",
                "AppKit",
                "-framework",
                "CoreGraphics",
                "-o",
            ])
            .arg(&bin)
            .arg(&src)
            .output();
        match output {
            Ok(o) if o.status.success() && bin.exists() => {
                tracing::info!("compiled cua helper at {}", bin.display());
                Some(bin)
            }
            Ok(o) => {
                tracing::warn!(
                    "swiftc failed to build cua helper; computer-use disabled: {}",
                    String::from_utf8_lossy(&o.stderr)
                );
                None
            }
            Err(e) => {
                tracing::warn!("swiftc unavailable; computer-use disabled: {e}");
                None
            }
        }
    }

    fn spawn(app_data: &Path) -> Option<Helper> {
        let bin = helper_path(app_data)?;
        let mut child = Command::new(bin)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let stdin = child.stdin.take()?;
        let stdout = child.stdout.take()?;
        Some(Helper {
            _child: child,
            stdin,
            reader: BufReader::new(stdout),
        })
    }

    /// One request/response, respawning the helper once on a dead pipe.
    pub fn request(inner: &mut Inner, app_data: &Path, payload: &Value) -> Value {
        for attempt in 0..2 {
            if inner.proc.is_none() {
                match spawn(app_data) {
                    Some(h) => inner.proc = Some(h),
                    None => return json!({"ok": false, "error": "ax-helper-unavailable"}),
                }
            }
            let h = inner.proc.as_mut().unwrap();
            let mut line = payload.to_string();
            line.push('\n');
            if h.stdin.write_all(line.as_bytes()).is_err() || h.stdin.flush().is_err() {
                inner.proc = None;
                if attempt == 0 {
                    continue;
                }
                return json!({"ok": false, "error": "ax-helper-write-failed"});
            }
            let mut resp = String::new();
            match h.reader.read_line(&mut resp) {
                Ok(0) => {
                    inner.proc = None;
                    if attempt == 0 {
                        continue;
                    }
                    return json!({"ok": false, "error": "ax-helper-eof"});
                }
                Ok(_) => {
                    return serde_json::from_str(resp.trim()).unwrap_or_else(
                        |e| json!({"ok": false, "error": format!("ax-helper-bad-json: {e}")}),
                    );
                }
                Err(_) => {
                    inner.proc = None;
                    if attempt == 0 {
                        continue;
                    }
                    return json!({"ok": false, "error": "ax-helper-read-failed"});
                }
            }
        }
        json!({"ok": false, "error": "ax-helper-failed"})
    }
}
