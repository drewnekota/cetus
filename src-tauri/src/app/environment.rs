use super::{dirs_home, Path, PathBuf};

/// Where persisted logs live: `<app data>/logs/cetus.log.YYYY-MM-DD`, daily
/// rolling. Resolved without the Tauri path API because tracing must come up
/// before the app builder (the identifier matches tauri.conf.json).
pub(super) fn log_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        dirs_home().map(|h| h.join("Library/Application Support/dev.cetus.app/logs"))
    }
    // Windows has no HOME, so `dirs_home()` was empty here and the app shipped
    // with **no log file at all** — every Windows bug report arrived blind.
    // %APPDATA% is where the rest of the app data (db, sessions, pi-install)
    // already lives, and it exists for every GUI process.
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(dirs_home)
            .map(|base| base.join("dev.cetus.app").join("logs"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        dirs_home().map(|h| h.join(".cetus/logs"))
    }
}

/// Keep the log directory bounded: drop files whose mtime is older than a week.
pub(super) fn prune_old_logs(dir: &Path) {
    const KEEP: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 3600);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > KEEP);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// GUI apps launched from the Dock/Finder inherit launchd's minimal
/// environment (`PATH=/usr/bin:/bin:…`, no shell exports), not the user's
/// shell environment — so bare spawns of user tools (`claude`, `codex`,
/// `node`, `mcporter`) fail with "No such file or directory", and CLIs whose
/// credentials live in a `.zshrc` export (`OPENAI_API_KEY` for a custom Codex
/// provider, `ANTHROPIC_BASE_URL`, proxies) die with missing-variable errors —
/// while both work fine when the app is started from a terminal. Ask the login
/// shell for its full environment once at startup: PATH is merged (shell
/// entries first, keeping any dirs only the current env has), every other
/// variable is adopted only where the current env has no value — never
/// overriding what launchd or the user set on this process.
///
/// Windows has no login shell to ask, and spawning a missing `/bin/zsh` from a
/// GUI process there only risks a console flash — so it's a no-op there.
#[cfg(target_os = "windows")]
pub(super) fn adopt_login_shell_env() {}

#[cfg(not(target_os = "windows"))]
pub(super) fn adopt_login_shell_env() {
    // Per-process/session values that would be nonsense to copy from a
    // throwaway probe shell into this process.
    const SKIP: &[&str] = &[
        "PATH",
        "PWD",
        "OLDPWD",
        "SHLVL",
        "_",
        "TERM",
        "TERM_PROGRAM",
        "TERM_PROGRAM_VERSION",
        "TERM_SESSION_ID",
        "TTY",
    ];
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    // `-i` matters: exports typically live in .zshrc, which only interactive
    // shells read (`-l` alone gets .zprofile and misses them). Rc files are
    // free to echo whatever they like, so bracket the payload with markers
    // instead of trusting raw stdout; `env -0` keeps multiline values intact.
    let output = std::process::Command::new(&shell)
        .args([
            "-ilc",
            "printf '__CETUS_ENV__'; command env -0; printf '__CETUS_ENV__'",
        ])
        .output();
    let Ok(output) = output else { return };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let Some(payload) = stdout.split("__CETUS_ENV__").nth(1) else {
        return;
    };
    for entry in payload.split('\0') {
        let Some((key, value)) = entry.split_once('=') else {
            continue;
        };
        if key.is_empty() || SKIP.contains(&key) {
            continue;
        }
        if std::env::var_os(key).is_none() {
            std::env::set_var(key, value);
        }
    }
    // PATH gets a merge instead of adopt-if-missing: launchd's minimal PATH is
    // always present, and child runtimes need the shell's entries in front.
    let shell_path = payload
        .split('\0')
        .find_map(|entry| entry.strip_prefix("PATH="))
        .unwrap_or_default();
    if shell_path.trim().is_empty() {
        return;
    }
    let mut merged: Vec<&str> = shell_path.split(':').filter(|d| !d.is_empty()).collect();
    let current = std::env::var("PATH").unwrap_or_default();
    for dir in current.split(':') {
        if !dir.is_empty() && !merged.contains(&dir) {
            merged.push(dir);
        }
    }
    std::env::set_var("PATH", merged.join(":"));
}
