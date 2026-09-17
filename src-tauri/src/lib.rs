#[path = "app/pi_install.rs"]
mod pi_install;
use pi_install::*;
#[path = "app/window_lifecycle.rs"]
mod window_lifecycle;
pub(crate) use window_lifecycle::*;
#[path = "app/environment.rs"]
mod environment;
use environment::*;
mod agent;
mod ambient;
mod app_event;
#[path = "app/app_state.rs"]
mod app_state;
mod artifact_thumbnail;
mod auto_archive;
mod automation;
mod automation_api;
mod automation_tool;
mod ax;
mod bash;
mod biasing;
pub use cetus_bridge::{bridge, pi_rpc};
mod caps_remap;
mod capture;
pub mod cli;
mod cli_backend;
mod commands;
mod context_budget;
mod context_now;
#[cfg(unix)]
mod control;
#[cfg(not(unix))]
#[path = "control_stub.rs"]
mod control;
mod corrections;
mod cua;
mod custom_models;
#[cfg(feature = "devtest")]
mod devtest;
mod diagnostics;
mod discovery;
mod doubao;
mod focused_text;
mod host_tunnel;
#[cfg(target_os = "macos")]
mod hotkey;
mod input_signals;
mod locale;
mod mcp;
mod mcp_oauth;
mod mcp_tool;
mod meeting;
mod memory;
mod model;
mod model_bridge;
mod notify;
mod ocr;
#[cfg(target_os = "macos")]
mod panel;
mod plugins;
mod prompts;
mod provider;
mod quick;
mod quick_reply;
mod remote;
mod resources;
mod scheduler;
mod search_index;
mod secrets;
mod skill_tool;
mod skills;
mod slash_commands;
mod snip;
mod store;
mod tauri_bridge;
mod terminal;
#[cfg(target_os = "macos")]
mod text_input;
#[cfg(not(target_os = "macos"))]
#[path = "text_input_stub.rs"]
mod text_input;
mod titling;
mod transcripts;
mod updater;
mod voice;
mod webkit_prefs;
mod webview_health;
mod window_geom;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Listener, Manager};
use tokio::sync::Mutex;

#[cfg(target_os = "windows")]
const PI_BINARY_NAME: &str = "pi.exe";
#[cfg(not(target_os = "windows"))]
const PI_BINARY_NAME: &str = "pi";

/// Pool of `pi --mode rpc` child processes — one per active conversation.
///
/// Processes are lazy: a conversation only gets a pi spawned the first time
/// we need to interact with it (sendPrompt, switch + load messages, …). They
/// stay alive for the rest of the session until the conversation is archived,
/// deleted, or an API key changes (which forces a full pool reset to pick up
/// new env vars).
pub struct AppState {
    pub store: Arc<store::Store>,
    /// Conversation currently visible in the chat pane. Auto-archive skips this
    /// row even if its persisted `updated_at` is old, so a chat can't disappear
    /// while the user is reading it.
    active_conversation: Arc<Mutex<Option<String>>>,
    /// Shared with the scheduler task so an automation-fired conversation's pi
    /// lands in the same pool the rest of the app reuses via `pi_for`.
    pis: Arc<Mutex<HashMap<String, Arc<pi_rpc::PiRpc>>>>,
    /// Automation ids with a fire in flight — shared with the scheduler so a
    /// manual run-now and the tick can't double-fire. Std mutex (set ops only).
    inflight: scheduler::InFlight,
    handle: AppHandle,
    sessions_dir: PathBuf,
    pi_bin: PathBuf,
    pi_dir: PathBuf,
    /// Root of the app's data dir (where the lazily-compiled native helpers and
    /// other on-disk state live). Used by [`voice`] to resolve its Swift helper.
    pub app_data_dir: PathBuf,
    /// The single in-flight dictation session, shared so stop/cancel can reach
    /// the live helper process.
    pub dictation: voice::DictationState,
    /// User-facing default workspace (~/cetus). Used when a conversation has no
    /// explicit workspace_dir set.
    pub default_workspace: PathBuf,
    /// Live view of the quick-launcher gesture config, shared with the native
    /// key-tap thread so settings changes apply without a restart.
    pub quick: quick::QuickRuntime,
    /// Browser/computer "agent control": the macOS AX helper child + the
    /// emergency-stop flags. Shared with the app-event listener's AgentCtx.
    pub cua: cua::CuaRuntime,
    /// In-flight CLI-backend turns (claude-code / codex), keyed by conversation
    /// id. Presence = a turn is running; the Notify is its kill switch (fired
    /// with `notify_one` so a signal sent between stream reads isn't lost) and
    /// the sender feeds the child's stdin (control responses answering
    /// permission prompts / AskUserQuestion).
    cli_turns: std::sync::Mutex<HashMap<String, CliTurnHandle>>,
    /// Conversation-scoped Claude Code processes. Unlike `cli_turns` (which is
    /// only the currently streaming UI turn), these remain alive while idle so
    /// Claude's background Bash jobs can survive across replies.
    claude_sessions:
        std::sync::Mutex<HashMap<String, cetus_bridge::cli_agent::ClaudeSessionHandle>>,
    /// Conversation-scoped Codex app-server threads. Background terminals are
    /// owned here and therefore survive `turn/completed`.
    codex_sessions: std::sync::Mutex<HashMap<String, cetus_bridge::cli_agent::CodexSessionHandle>>,
    /// Conversation-scoped native ACP sessions (OpenCode / Grok Build / Kimi).
    acp_sessions: std::sync::Mutex<HashMap<String, cetus_bridge::cli_agent::AcpSessionHandle>>,
    /// Last slash-command/skill catalog reported by each live CLI session.
    /// Unlike the matching UI event, this survives a renderer reload, so the
    /// composer can hydrate the menu without restarting the vendor process.
    cli_commands: std::sync::Mutex<HashMap<String, Vec<serde_json::Value>>>,
    /// Same catalog, but keyed by "{backend}\n{cwd}" and resolved by probing
    /// the runtime directly, so the new-chat composer (which has no
    /// conversation yet) can show the runtime's real commands and skills.
    cli_command_catalogs: std::sync::Mutex<HashMap<String, Vec<serde_json::Value>>>,
    /// Auto-retry bookkeeping for CLI turns that settled on a transient
    /// provider error (429 burst / overload), keyed by conversation id.
    /// `generation` counts dispatches: a scheduled retry snapshots it and
    /// fires only if nothing else (user send, steer redispatch) dispatched in
    /// the meantime. `attempts` counts consecutive auto-retries and resets on
    /// any turn that settles without a transient error.
    cli_auto_retry: std::sync::Mutex<HashMap<String, CliAutoRetry>>,
}

/// See [`AppState::cli_auto_retry`].
#[derive(Default, Clone, Copy)]
pub struct CliAutoRetry {
    pub attempts: u32,
    pub generation: u64,
}

/// One line bound for a running CLI turn's stdin.
pub enum CliInput {
    /// A raw protocol line (control_response answering a permission prompt
    /// or AskUserQuestion).
    Line(String),
    /// A steered user message: `line` is the stdin injection, `message` the
    /// PiMessage-shaped user row the claude session splices into the
    /// transcript at the steer's merge point (so it renders and persists
    /// where it landed in the turn, not after it).
    Steer {
        line: String,
        message: serde_json::Value,
    },
}

/// Handles onto one running CLI-backend turn.
struct CliTurnHandle {
    kill: Arc<tokio::sync::Notify>,
    input: tokio::sync::mpsc::UnboundedSender<CliInput>,
    /// Steer messages injected into this turn's stdin and not yet settled by
    /// the runner (see `run_cli_turn`'s steer grace). Bumped before the line
    /// is sent so the runner can't observe the message without the count.
    steer_pending: Arc<std::sync::atomic::AtomicUsize>,
    /// Fired (notify_one — the permit survives a fire-before-wait race) by
    /// `end_cli_turn` once the turn fully settled: outcome persisted,
    /// registration cleared. The codex steer path waits on this before
    /// redispatching so the interrupted turn's partial messages and resume
    /// token are on disk first.
    done: Arc<tokio::sync::Notify>,
    /// Set true the instant the runner emits this turn's `agent_end` (via the
    /// dispatch's ClosingSink), BEFORE that event reaches the frontend. Past
    /// this point the child no longer reads stdin, so a steer would vanish into
    /// a dead pipe. The frontend flushes its follow-up queue exactly on
    /// `agent_end`, and that flush lands here while the turn is still registered
    /// (unregistration trails persistence) — the flag routes it to a fresh
    /// resuming turn instead of a lost steer.
    closing: Arc<std::sync::atomic::AtomicBool>,
}

/// Outcome of trying to steer a prompt into a running CLI turn.
pub enum CliSteer {
    /// Injected into a live turn's stdin.
    Steered,
    /// The turn is wrapping up (past `agent_end`): wait on the settlement
    /// signal, then redispatch the prompt as a fresh turn resuming the thread.
    Closing(Arc<tokio::sync::Notify>),
    /// No turn is running — dispatch a fresh turn directly.
    Idle,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Must run before anything can spawn a child process (and before threads
    // exist — `set_var` is not thread-safe).
    adopt_login_shell_env();

    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    // Logs go to stdout (the dev terminal) AND a daily-rolling file under the
    // app data dir, so sessions are diagnosable after the fact — including
    // packaged builds, where stdout goes nowhere. The non-blocking writer's
    // guard must outlive the process; parked in a static.
    static LOG_GUARD: std::sync::OnceLock<tracing_appender::non_blocking::WorkerGuard> =
        std::sync::OnceLock::new();
    let file_layer = log_dir().and_then(|dir| {
        std::fs::create_dir_all(&dir).ok()?;
        prune_old_logs(&dir);
        let (writer, guard) =
            tracing_appender::non_blocking(tracing_appender::rolling::daily(&dir, "cetus.log"));
        let _ = LOG_GUARD.set(guard);
        Some(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(writer),
        )
    });
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,cetus_lib=debug")),
        )
        .with(tracing_subscriber::fmt::layer())
        .with(file_layer)
        .init();

    let builder = tauri::Builder::default()
        .plugin(webkit_prefs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        // Login-item registration for the "launch on startup" toggle. Launches
        // with `--autostart` so we can tell a login-item start from a manual one
        // (cetus stays in the tray rather than popping the main window).
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        // Configurable global hotkeys. One handler dispatches by shortcut: the
        // meeting-capture toggle (when configured) starts/stops a transcription
        // session; anything else is the summon shortcut, which toggles the main
        // window — forward if cetus is in the background (macOS switches to its
        // Space on activation), or hidden ⌘H-style if it's already frontmost.
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        if meeting::is_toggle_shortcut(shortcut) {
                            meeting::toggle_from_hotkey(app);
                        } else {
                            toggle_main(app);
                        }
                    }
                })
                .build(),
        )
        // Last line of defence against the app webview navigating away from
        // cetus' own document. That failure is unrecoverable in practice: the
        // UI is replaced by whatever was loaded (rendered unstyled over our
        // transparent window), no in-page code survives to undo it, and even
        // ⌘R only reloads the *new* URL. Every link in the app is therefore
        // intercepted and routed to the OS — see `openMarkdownLink` — and this
        // refuses `file:` for the cases that get missed.
        //
        // Scope is deliberately narrow. `on_navigation` cannot tell a main
        // frame from a subframe, and the local-file previews (`asset:`) and
        // artifact iframes (`blob:`/`data:`) are subframe navigations that must
        // keep working, so only `file:` — which nothing in the app legitimately
        // loads — can be refused here. The in-app browser windows are exempt:
        // navigating is their entire job.
        .plugin(
            // `()` config: the plugin takes no `tauri.conf.json` settings, and
            // nothing else pins the type parameter for inference.
            tauri::plugin::Builder::<tauri::Wry, ()>::new("navigation-guard")
                .on_navigation(|webview, url| {
                    let label = webview.label();
                    if url.scheme() != "file"
                        || label == commands::BROWSER_WINDOW_LABEL
                        || label == commands::BROWSER_PANEL_LABEL
                    {
                        return true;
                    }
                    tracing::warn!("blocked file: navigation in webview {label}: {url}");
                    false
                })
                .build(),
        );

    // Recovery net behind the navigation guard above. `on_navigation` cannot
    // tell a main-frame navigation from a subframe one, so it cannot refuse
    // http(s) without also breaking artifact iframes. This callback, however,
    // only fires for main-frame loads (WKNavigationDelegate didCommit), so a
    // foreign http(s) URL here means the app UI has been replaced — a link
    // click that escaped interception (middle click, the context menu's
    // "Open Link", or a link drag dropped back onto the window; wry forwards
    // OS drags to WebKit, whose default is to navigate to a dropped link).
    // Navigate straight back to the app shell instead of staying stranded.
    let builder = builder.on_page_load(|webview, payload| {
        if !matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
            return;
        }
        let label = webview.label();
        if label == commands::BROWSER_WINDOW_LABEL || label == commands::BROWSER_PANEL_LABEL {
            return;
        }
        let url = payload.url();
        if !matches!(url.scheme(), "http" | "https") {
            return;
        }
        let host = url.host_str().unwrap_or("");
        // Windows serves the bundled frontend from tauri.localhost; dev builds
        // serve it from the localhost dev server.
        if host == "tauri.localhost" || (tauri::is_dev() && host == "localhost") {
            return;
        }
        tracing::warn!("app webview {label} navigated away to {url}; restoring the app shell");
        let home = tauri::is_dev()
            .then(|| {
                webview
                    .app_handle()
                    .config()
                    .build
                    .dev_url
                    .as_ref()
                    .map(|u| u.as_str().to_owned())
            })
            .flatten()
            .unwrap_or_else(|| {
                if cfg!(windows) {
                    "http://tauri.localhost".to_owned()
                } else {
                    "tauri://localhost".to_owned()
                }
            });
        if let Ok(home) = tauri::Url::parse(&home) {
            let webview = webview.clone();
            tauri::async_runtime::spawn(async move {
                let _ = webview.navigate(home);
            });
        }
    });

    // WKWebView runs out-of-process. If macOS reclaims or crashes that content
    // process, reload just the frontend; chats and drafts hydrate from durable
    // stores on page load.
    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(|webview| {
        if webview.label() == "main" {
            tracing::warn!("main WKWebView content process terminated; reloading UI");
            // Navigate to the current URL rather than `reload()`: after a
            // client-requested kill+reset there is no page state left to
            // reload, and `reload()` would settle on an empty document.
            match webview.url() {
                Ok(url) => {
                    let _ = webview.navigate(url);
                }
                Err(_) => {
                    let _ = webview.reload();
                }
            }
        }
    });

    let builder = builder
        .setup(|app| {
            // Started as a login item (the autostart plugin appends `--autostart`):
            // keep cetus resident in the tray instead of popping the main window in
            // the user's face right after they log in.
            if std::env::args().any(|a| a == "--autostart") {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.hide();
                }
            }

            let handle = app.handle().clone();
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            // One-time migration across the kott→cetus rename: the bundle
            // identifier changed (dev.jinqiu.kott → dev.cetus.app), which
            // moves Tauri's app_data_dir to a fresh, empty path. If the new dir
            // doesn't exist yet but the old one does, copy it over so existing
            // settings, conversations, memory, and logs carry across. Copy (not
            // move) so a downgrade still finds its data.
            // Trigger on the core DB being absent rather than the dir: an
            // earlier launch of the renamed build may have already created an
            // empty data dir, which would otherwise block the migration.
            if !app_data_dir.join("pi-desktop.db").exists() {
                if let Some(old) = app_data_dir
                    .parent()
                    .map(|p| p.join("dev.jinqiu.kott"))
                    .filter(|p| p.is_dir())
                {
                    let migrate = || -> std::io::Result<()> {
                        std::fs::create_dir_all(&app_data_dir)?;
                        for entry in std::fs::read_dir(&old)? {
                            let entry = entry?;
                            // Skip pi-install: a regenerable build artifact that's
                            // re-synced on launch. Copying it would also drag the
                            // stale pre-rename extension dir along.
                            if entry.file_name().to_str() == Some("pi-install") {
                                continue;
                            }
                            let to = app_data_dir.join(entry.file_name());
                            if entry.file_type()?.is_dir() {
                                copy_dir_recursive(&entry.path(), &to)?;
                            } else {
                                std::fs::copy(entry.path(), &to)?;
                            }
                        }
                        Ok(())
                    };
                    match migrate() {
                        Ok(()) => tracing::info!(
                            "migrated app data {} -> {}",
                            old.display(),
                            app_data_dir.display()
                        ),
                        Err(e) => tracing::warn!("app data migration skipped: {e}"),
                    }
                }
            }
            std::fs::create_dir_all(&app_data_dir).ok();
            let sessions_dir = app_data_dir.join("sessions");
            std::fs::create_dir_all(&sessions_dir).ok();
            let db_path = app_data_dir.join("pi-desktop.db");

            // Resolve bundled pi-install. Tauri's resource_dir is read-only in
            // production (.app/Contents/Resources), so on first launch we copy
            // the whole tree to <app_data>/pi-install and run pi from there.
            // PI_INSTALL env var overrides for local dev iteration.
            let pi_dir =
                resolve_pi_install(app.handle(), &app_data_dir).expect("locate/install pi tree");
            let pi_bin = pi_dir.join(PI_BINARY_NAME);
            std::env::set_var(
                plugins::CETUS_USER_PLUGINS_ENV,
                plugins::user_plugins_dir(&app_data_dir),
            );

            let store = Arc::new(store::Store::open(&db_path).expect("open sqlite store"));
            // A fresh process can't have live CLI turns, so any row still
            // "running" was cut down mid-run — by a crash or kill that never
            // reached the exit hook below. Demote them so the UI can offer to
            // resume. (Quit/update-restart already demoted theirs on exit;
            // this boot sweep is the backstop and the primary path.)
            match store.mark_running_interrupted() {
                Ok(n) if n > 0 => {
                    tracing::info!("marked {n} conversation(s) interrupted from a previous run")
                }
                Ok(_) => {}
                Err(e) => tracing::warn!("interrupted-run sweep failed: {e}"),
            }
            // Size/position the main window before it's presented: restore the
            // user's last geometry, or default to 90% of the current monitor,
            // centered, on the first ever launch. Tracking + persistence is wired
            // up below via the main window's event handler and the exit flush.
            window_geom::restore_or_default(app.handle(), &store);
            // Default workspace lives under the user's home so the agent writes
            // where the user expects, not inside the app's install tree.
            // `<app_data>/workspace` is the pre-Windows-home fallback: installs
            // made while `dirs_home()` was HOME-only put their "Chat"
            // conversations there, and those rows carry the absolute path, so
            // keep using it wherever it already exists rather than stranding
            // them under a folder named "workspace".
            let legacy_workspace = app_data_dir.join("workspace");
            let default_workspace = match dirs_home() {
                Some(home) if !legacy_workspace.is_dir() => home.join("cetus"),
                Some(_) | None => legacy_workspace,
            };
            std::fs::create_dir_all(&default_workspace).ok();
            tracing::info!("default workspace: {}", default_workspace.display());

            // Quick-launcher config drives both the panel and the native gesture
            // listener; build the shared runtime from persisted settings.
            quick::migrate_voice_defaults(&store);
            quick::migrate_shortcut_defaults(&store);
            let quick_settings = quick::load_settings(&store);
            let quick_runtime = quick::QuickRuntime::from_settings(&quick_settings);
            // If Caps Lock is the active voice trigger, (re)apply the HID remap
            // now — it clears on reboot, so it has to be re-established each launch.
            caps_remap::set_active(
                quick_settings.voice_enabled
                    && quick::voice_gesture_code(&quick_settings.voice_gesture)
                        == quick::VOICE_CAPS_LOCK,
            );

            // The pool + dedup set are shared by AppState and the scheduler.
            let pis: Arc<Mutex<HashMap<String, Arc<pi_rpc::PiRpc>>>> =
                Arc::new(Mutex::new(HashMap::new()));
            let inflight: scheduler::InFlight =
                Arc::new(std::sync::Mutex::new(std::collections::HashSet::new()));
            // Browser/computer agent-control runtime: the AX helper child +
            // emergency-stop flags, shared by AppState and the app-event listener.
            let cua = cua::CuaRuntime::new();
            {
                let agent_ctx = agent::AgentCtx {
                    pool: pis.clone(),
                    handle: handle.clone(),
                    app_data_dir: app_data_dir.clone(),
                    cua: cua.clone(),
                };
                let automation_ctx = automation_tool::AutomationToolCtx {
                    store: store.clone(),
                    pool: pis.clone(),
                    handle: handle.clone(),
                    default_workspace: default_workspace.clone(),
                };
                let skill_ctx = skill_tool::SkillToolCtx {
                    store: store.clone(),
                    pool: pis.clone(),
                    handle: handle.clone(),
                    app_data_dir: app_data_dir.clone(),
                };
                let mcp_ctx = mcp_tool::McpToolCtx {
                    store: store.clone(),
                    pool: pis.clone(),
                    handle: handle.clone(),
                    app_data_dir: app_data_dir.clone(),
                };
                app.handle().listen("app-event", move |event| {
                    let payload = event.payload();
                    agent::maybe_handle_control_request(&agent_ctx, payload);
                    automation_tool::maybe_handle_automation_request(&automation_ctx, payload);
                    skill_tool::maybe_handle_skill_request(&skill_ctx, payload);
                    mcp_tool::maybe_handle_mcp_request(&mcp_ctx, payload);
                });
            }

            // pi processes are lazy-spawned per-conversation in pi_for(); no
            // global pi at boot.
            app.manage(AppState {
                store,
                active_conversation: Arc::new(Mutex::new(None)),
                pis,
                inflight,
                handle,
                sessions_dir,
                pi_bin,
                pi_dir,
                app_data_dir: app_data_dir.clone(),
                dictation: voice::DictationState::default(),
                default_workspace,
                quick: quick_runtime.clone(),
                cua: cua.clone(),
                cli_turns: std::sync::Mutex::new(HashMap::new()),
                claude_sessions: std::sync::Mutex::new(HashMap::new()),
                codex_sessions: std::sync::Mutex::new(HashMap::new()),
                acp_sessions: std::sync::Mutex::new(HashMap::new()),
                cli_commands: std::sync::Mutex::new(HashMap::new()),
                cli_command_catalogs: std::sync::Mutex::new(HashMap::new()),
                cli_auto_retry: std::sync::Mutex::new(HashMap::new()),
            });
            let remote_runtime = remote::RemoteRuntime::new(&app.state::<AppState>().store);
            app.manage(remote_runtime);
            remote::initialize(app.handle().clone());
            app.manage(terminal::TerminalRuntime::default());

            // Meeting memory: the single in-flight capture session, shared by
            // the commands, the auto-detect monitor, and the global hotkey.
            app.manage(meeting::MeetingRuntime::default());

            // Background scheduler: fires due automations on a timer. Shares the
            // managed AppState's pi pool + store via a cheap ctx clone.
            let sched_ctx = app.state::<AppState>().scheduler_ctx();
            tauri::async_runtime::spawn(scheduler::run_scheduler(sched_ctx));

            // Auto-archive: opt-in background sweep that archives conversations
            // left untouched past the user's idle threshold. No-op while off.
            auto_archive::spawn_auto_archiver(app.handle().clone());

            // ⌘K content search index: backfills every conversation (archived
            // included) after a startup grace, then keeps stale rows current.
            search_index::spawn_indexer(app.handle().clone());

            // OAuth token keep-alive: proactively refresh near-expiry mcporter
            // tokens so remote connectors (Notion, …) don't silently die ~1h after
            // authorizing. No-op when there are no OAuth connectors.
            mcp_oauth::spawn_token_refresher();

            // Always-on control socket + the `cetus` CLI shim: the supported
            // path for third-party CLI runtimes (claude-code / codex) to read
            // and edit automations through the running app instead of poking
            // the sqlite file. See `control.rs`.
            control::install_cli_shim(&app.state::<AppState>().app_data_dir);
            control::start(app.handle().clone());

            // DEV-ONLY external eval bridge (M4). Compiled out of release; the
            // server itself early-returns unless CETUS_DEVTEST=1 / CETUS_DEVTEST_SOCK
            // is set, so this line is safe to leave in a devtest build.
            #[cfg(feature = "devtest")]
            devtest::start_uds_server(app.handle().clone());

            // cetus stays resident in the background so the global launcher
            // keeps working after the main window is closed. Closing any window
            // just HIDES it; the dock icon, the tray "Open cetus" item, or a dock
            // reopen bring the main window back. Quit is Cmd+Q or the tray.
            // Main window: park it warm on close (keeps its webview from being
            // discarded so reopening after idle doesn't flash). Other windows
            // just hide.
            if let Some(win) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                let win_geom = win.clone();
                win.on_window_event(move |event| match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        // Capture the real on-screen geometry before park tucks
                        // the window off-screen, then persist it.
                        window_geom::record(&win_geom, false);
                        park_main(&app_handle);
                    }
                    // Remember wherever the user drags/resizes the window to.
                    tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                        window_geom::record(&win_geom, true);
                    }
                    // A fully-shown main window that just became key MUST accept
                    // the mouse. The warm-park dance can leave `ignoresMouseEvents`
                    // set under a close→reopen race (see panel::enable_mouse_events),
                    // which deadens clicks — and so the keyboard, since you can't
                    // click to take key focus — until you Cmd-Tab away and back.
                    // Healing it on every key-gain makes that self-correct, and
                    // turns the Cmd-Tab the user would otherwise need into a no-op
                    // recovery (it fires this event too). Safe + idempotent: a key
                    // window never legitimately ignores the mouse, and a parked
                    // sliver is never key.
                    //
                    // Same gain also re-arms the WKWebView as first responder
                    // (rearm_web_input): after a long idle WebKit can leave the
                    // key-event routing stale, so the composer won't accept typing
                    // even though it looks (and clicks) fine. Both heals are
                    // idempotent, so running them on every key-gain is free.
                    #[cfg(target_os = "macos")]
                    tauri::WindowEvent::Focused(true) => {
                        let app_h = app_handle.clone();
                        let _ = app_handle.run_on_main_thread(move || {
                            if let Some(w) = app_h.get_webview_window("main") {
                                if let Ok(ptr) = w.ns_window() {
                                    crate::panel::enable_mouse_events(ptr);
                                    crate::panel::rearm_web_input(ptr);
                                    crate::panel::refresh_webview_tracking(ptr);
                                }
                            }
                            crate::webview_health::arm_focus_watchdog(app_h);
                        });
                        updater::check_after_focus(app_handle.clone());
                    }
                    _ => {}
                });
            }
            // NOTE: there used to be an NSApplicationDidBecomeActive observer
            // here that summoned a parked/hidden/off-Space main window on ANY
            // activation (Cmd-Tab, Mission Control, App Exposé). It fought
            // Mission Control's own raise (window landed under others) and was
            // removed in favor of stock macOS behavior: activation alone brings
            // nothing back; recall paths are the Dock click (`Reopen` handler),
            // the summon hotkey, and the tray.
            //
            // What remains is a WATCH-ONLY probe for the "Mission Control
            // leaves the main window at the bottom" family: every activation /
            // deactivation / Space change logs each window's ordering state
            // (search the log for "activation-watch") so the next recurrence
            // can be attributed. Sole permitted action: a quick-launcher panel
            // found still ordered in while its `shown` flag says dismissed (a
            // leaked dismiss path — the prime suspect for stealing Mission
            // Control's raise) is parked again. orderOut only; per the note
            // above, this observer must NEVER order any window front.
            #[cfg(target_os = "macos")]
            {
                let app_h = app.handle().clone();
                panel::install_activation_watch(move |event| {
                    let labels: Vec<(String, usize)> = app_h
                        .webview_windows()
                        .iter()
                        .filter_map(|(label, w)| {
                            w.ns_window().ok().map(|p| (label.clone(), p as usize))
                        })
                        .collect();
                    tracing::info!(
                        "activation-watch {event}: {}",
                        panel::order_snapshot(&labels)
                    );
                    if event != "did-become-active" {
                        return;
                    }
                    let launcher_shown = app_h
                        .state::<AppState>()
                        .quick
                        .shown
                        .load(std::sync::atomic::Ordering::Relaxed);
                    if launcher_shown {
                        return;
                    }
                    if let Some(w) = app_h.get_webview_window("quick") {
                        if w.is_visible().unwrap_or(false) {
                            tracing::warn!(
                                "activation-watch: quick launcher ordered-in while \
                                 dismissed — parking it"
                            );
                            quick::park_quick(&app_h);
                        }
                    }
                });
            }
            for label in ["quick", "voice"] {
                if let Some(win) = app.get_webview_window(label) {
                    let win_for_hide = win.clone();
                    win.on_window_event(move |event| {
                        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                            api.prevent_close();
                            let _ = win_for_hide.hide();
                        }
                    });
                }
            }

            // Menu-bar tray: cetus keeps a presence even with every window closed
            // (the launcher runs headless), and gives a no-Dock way to reopen or
            // quit. The Dock icon stays. Click the tray to drop the menu.
            {
                use tauri::menu::{Menu, MenuItem};
                use tauri::tray::TrayIconBuilder;
                let open_i = MenuItem::with_id(app, "tray_open", "Open cetus", true, None::<&str>)?;
                let settings_i =
                    MenuItem::with_id(app, "tray_settings", "Settings", true, None::<&str>)?;
                let quit_i = MenuItem::with_id(app, "tray_quit", "Quit cetus", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&open_i, &settings_i, &quit_i])?;
                let mut tray = TrayIconBuilder::with_id("cetus-tray")
                    .tooltip("cetus")
                    .menu(&menu)
                    .show_menu_on_left_click(true)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "tray_open" => focus_main(app),
                        "tray_settings" => {
                            focus_main(app);
                            let _ = app.emit_to("main", "open-settings", ());
                        }
                        "tray_quit" => request_quit(app),
                        _ => {}
                    });
                // macOS wants a monochrome template glyph so the system can
                // tint it for the current menu-bar appearance. Windows does
                // not apply that tint and rendered the same asset as a black
                // silhouette, so use the full-color application logo there.
                #[cfg(target_os = "macos")]
                {
                    if let Ok(icon) =
                        tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))
                    {
                        tray = tray.icon(icon).icon_as_template(true);
                    } else if let Some(icon) = app.default_window_icon() {
                        tray = tray.icon(icon.clone());
                    }
                }
                #[cfg(not(target_os = "macos"))]
                if let Some(icon) = app.default_window_icon() {
                    tray = tray.icon(icon.clone());
                }
                tray.build(app)?;
            }

            // Screen-context collection (Rewind-like). Export the recall-log path
            // so the `screen-recall` pi extension (which inherits this env) can
            // read it, then start the background capture loop. Off by default;
            // gated on the user toggle, so this is a cheap poll until enabled.
            std::env::set_var("CETUS_SCREEN_LOG", capture::recall_log_path(&app_data_dir));
            capture::spawn(app.state::<AppState>().store.clone(), app_data_dir.clone());

            // Ambient text context (Littlebird-like AX collector) — the text-mode
            // sibling of the capture loop above. Same contract: off by default,
            // cheap toggle poll until enabled. Own bundle id keeps cetus from
            // observing its own windows.
            ambient::spawn(
                app.state::<AppState>().store.clone(),
                app.config().identifier.clone(),
            );

            // Meeting memory (ambient audio transcription). Export the recall-log
            // path so the `meeting-recall` pi extension can read it, then start
            // the mic-use monitor. Off by default; cheap poll until enabled.
            std::env::set_var("CETUS_MEETING_LOG", meeting::recall_log_path(&app_data_dir));
            meeting::spawn_monitor(
                app.handle().clone(),
                app.state::<AppState>().store.clone(),
                app_data_dir.clone(),
            );

            // Persistent agent memory: export the store path so the `memory` pi
            // extension (which inherits this env) reads/writes the same file the
            // Memory settings page edits. See memory.rs.
            std::env::set_var("CETUS_MEMORY_PATH", memory::memory_path(&app_data_dir));

            // Dictation history (voice context): export the store path so the
            // `dictation-recall` pi extension (which inherits this env) reads the
            // same file the Voice settings page edits. See transcripts.rs.
            std::env::set_var(
                "CETUS_DICTATION_PATH",
                transcripts::transcripts_path(&app_data_dir),
            );

            // User-installed Skills: point pi's agent dir at a cetus-managed
            // location (isolated from the user's personal ~/.pi) so pi discovers
            // and auto-enables every SKILL.md under `<agentDir>/skills`. Then
            // materialise the enabled skills there from the library. pi reads
            // skills at session start, so the resync + a pi recycle on any change
            // (see skills.rs) make installs take effect on the next turn.
            std::env::set_var("PI_CODING_AGENT_DIR", skills::agent_dir(&app_data_dir));
            std::fs::create_dir_all(skills::active_skills_dir(&app_data_dir)).ok();
            skills::resync_active_dir(&app_data_dir, &app.state::<AppState>().store);

            // MCP connectors ("Connectors"): publish the consolidated server
            // config + its path. The `mcp-bridge.ts` pi extension reads it (via
            // mcporter) and registers each enabled server's tools with the agent.
            // `CETUS_MCP_CONFIG` is what the bridge reads; `MCPORTER_CONFIG` lets
            // mcporter's own config discovery (and its CLI) find the same file.
            let mcp_config = mcp::config_path(&app_data_dir);
            std::env::set_var("CETUS_MCP_CONFIG", &mcp_config);
            std::env::set_var("MCPORTER_CONFIG", &mcp_config);
            mcp::export_config(&app_data_dir, &app.state::<AppState>().store);

            // Custom model providers (Settings → Models): publish
            // `<app_data>/custom-models.json` + its path so the custom-models
            // pi extension registers each configured provider at spawn.
            // Registration happens at startup, so changes recycle idle pis
            // (see custom_models.rs) rather than hot-reloading.
            std::env::set_var(
                "CETUS_MODELS_CONFIG",
                custom_models::config_path(&app_data_dir),
            );
            custom_models::export_config(&app_data_dir, &app.state::<AppState>().store);

            // Publish the agent-control enable flag so the browser-use /
            // computer-use extensions register their tools only when on.
            agent::export_enabled(&app.state::<AppState>().store);

            // Frost the frameless quick panel and let it ride along to whatever
            // Space is active when the launcher fires. macOS-only; elsewhere the
            // window is just a plain transparent popup.
            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{
                    apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState,
                };
                // Keep cetus out of App Nap so a long-idle window doesn't come
                // back with throttled timers for a beat when you switch to it.
                panel::prevent_app_nap();
                // NO vibrancy on the main window: the DOM shell paints an opaque
                // bg-sidebar over the full window, so a behind-window blur was
                // invisible — while still making WindowServer recompute a
                // window-sized blur every time anything behind cetus repainted
                // (steady multi-10% GPU with the window open on a busy desktop).
                // Occlusion throttling stays enabled for the same reason: with
                // an opaque DOM there is no bare-vibrancy flash to hide, so let
                // WebKit suspend the webview whenever the window is covered.
                if let Some(win) = app.get_webview_window("quick") {
                    let _ = apply_vibrancy(
                        &win,
                        NSVisualEffectMaterial::HudWindow,
                        Some(NSVisualEffectState::Active),
                        Some(16.0),
                    );
                    // Turn it into a non-activating NSPanel: shows on the
                    // user's current Space and types without activating cetus.
                    // Setup runs on the main thread, where AppKit is safe.
                    if let Ok(ptr) = win.ns_window() {
                        panel::configure(ptr);
                        // It starts ordered out from config. Do not present it
                        // until the launcher gesture supplies the correct Space
                        // and cursor screen.
                    }
                }
                // The region-select ("snip") overlay: same non-activating,
                // key-capable panel treatment as the launcher (Esc must reach
                // its webview), but no vibrancy — it's a transparent sheet the
                // user drags a selection on. Sized to the target screen at
                // gesture time (see snip.rs).
                if let Some(win) = app.get_webview_window("snip") {
                    if let Ok(ptr) = win.ns_window() {
                        panel::configure(ptr);
                    }
                }
                // The dictation HUD: a never-key panel so the app being dictated
                // into keeps focus and the injected keystrokes land there. No
                // vibrancy — the HUD draws its own solid black capsule, and a
                // frosted layer behind it only bled a highlight past the pill's
                // edges (the "weird line" above the capsule). The window stays
                // fully transparent so only the capsule shows.
                if let Some(win) = app.get_webview_window("voice") {
                    if let Ok(ptr) = win.ns_window() {
                        panel::configure_hud(ptr);
                    }
                }
                // The meeting-recording pill gets the same never-key panel
                // treatment: it floats over full-screen meeting apps without
                // stealing focus from the call.
                if let Some(win) = app.get_webview_window("meeting") {
                    if let Ok(ptr) = win.ns_window() {
                        panel::configure_hud(ptr);
                    }
                }
                hotkey::spawn_listener(app.handle().clone(), quick_runtime);
            }
            // Register the persistent notification delegate so a clicked banner
            // opens its conversation. Setup runs on the main thread (AppKit-safe).
            notify::init(app.handle());
            // Register the user's summon hotkey (if any) now the plugin is up.
            apply_summon_hotkey(app.handle(), &quick_settings.summon_hotkey);
            // Check for an app update in the background. When auto-update is on
            // it installs silently (applied on next launch); when off it only
            // surfaces a passive "update-available" toast. Release builds only —
            // dev never self-updates.
            #[cfg(not(debug_assertions))]
            {
                let updater_handle = app.handle().clone();
                tauri::async_runtime::spawn(updater::startup_check(
                    updater_handle,
                    quick_settings.auto_update,
                ));
                updater::spawn_periodic_checks(app.handle().clone());
            }

            // Renderer-footprint time series for the log files: the main
            // webview's memory has ratcheted to multi-GB over a day of use
            // (2026-08-15 investigation), and log-file curves are how the
            // compositing-layer A/B in Settings → Appearance gets judged.
            #[cfg(target_os = "macos")]
            {
                let probe_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let mut tick = tokio::time::interval(std::time::Duration::from_secs(300));
                    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                    loop {
                        tick.tick().await;
                        let report = resources::webview_footprint_report(&probe_handle);
                        if !report.is_empty() {
                            tracing::info!("webview memory: {report}");
                        }
                    }
                });
            }
            Ok(())
        })
        // App menu bar. Keep the platform defaults so copy, paste, select-all
        // and the rest retain their accelerators, then add Reload to View. The
        // main UI hydrates conversations and drafts from durable stores after a
        // frontend reload.
        .menu(|app| {
            let menu = tauri::menu::Menu::default(app)?;
            // Swap the platform's predefined Quit for our own item. On macOS the
            // predefined one sends `terminate:` straight to NSApp, which skips
            // Tauri's ExitRequested hook entirely — so it's the only way to put
            // a "Quit Cetus?" confirmation in front of a stray Cmd+Q.
            {
                use tauri::menu::{MenuItem, MenuItemKind};
                let quit = MenuItem::with_id(
                    app,
                    "app_quit",
                    format!("Quit {}", app.package_info().name),
                    true,
                    Some("CmdOrCtrl+Q"),
                )?;
                for item in menu.items()? {
                    let MenuItemKind::Submenu(submenu) = item else {
                        continue;
                    };
                    let predefined_quit = submenu.items()?.into_iter().find(|it| {
                        matches!(it, MenuItemKind::Predefined(p)
                            if p.text().map(|t| t.starts_with("Quit")).unwrap_or(false))
                    });
                    if let Some(old) = predefined_quit {
                        submenu.remove(&old)?;
                        submenu.append(&quit)?;
                        break;
                    }
                }
            }
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{MenuItem, MenuItemKind};

                let reload =
                    MenuItem::with_id(app, "view_reload", "Reload", true, Some("CmdOrCtrl+R"))?;
                if let Some(MenuItemKind::Submenu(view)) = menu.items()?.into_iter().find(|item| {
                    matches!(
                        item,
                        MenuItemKind::Submenu(submenu)
                            if matches!(submenu.text().as_deref(), Ok("View"))
                    )
                }) {
                    view.prepend(&reload)?;
                }
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "view_reload" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.reload();
                }
            }
            "app_quit" => request_quit(app),
            _ => {}
        });

    // Self-update plugin. Registered only in release builds so `tauri dev` never
    // tries to parse the (release-only) signing pubkey or hit the update server.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    // The invoke_handler list is duplicated across the two cfg branches because
    // the devtest commands only exist when the `devtest` feature is enabled.
    // KEEP THE NON-DEVTEST PORTION OF BOTH LISTS IDENTICAL.
    #[cfg(not(feature = "devtest"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::list_conversations,
        commands::new_conversation,
        commands::fork_conversation,
        commands::switch_conversation,
        commands::set_active_conversation,
        commands::set_conversation_unread,
        commands::set_conversation_pinned,
        commands::archive_conversation,
        commands::clear_interrupted,
        commands::claim_auto_resume,
        commands::set_review_state,
        commands::delete_conversation,
        commands::rename_conversation,
        commands::send_prompt,
        commands::compact_conversation,
        commands::get_conversation,
        commands::set_conversation_backend,
        commands::conversation_worktree,
        commands::workspace_git_branch,
        commands::set_conversation_cli_model,
        remote::get_remote_settings,
        remote::set_remote_enabled,
        remote::rotate_remote_access,
        resources::resources_snapshot,
        cli_backend::get_cli_agent_settings,
        cli_backend::set_cli_agent_settings,
        cli_backend::get_cli_defaults,
        cli_backend::get_cli_runtime_status,
        diagnostics::export_diagnostics,
        cli_backend::get_cli_commands,
        cli_backend::probe_cli_commands,
        cli_backend::cli_control_respond,
        commands::retry_last_turn,
        commands::abort,
        commands::pi_ping,
        webview_health::webview_heartbeat,
        webview_health::wake_main_webview,
        commands::default_workspace,
        commands::pick_workspace_dir,
        commands::save_artifact_copy,
        commands::list_workspace_files,
        commands::list_workspace_directory,
        commands::search_workspace_files,
        commands::export_conversation_transcript,
        commands::create_workspace_entry,
        commands::rename_workspace_entry,
        commands::trash_workspace_entry,
        commands::set_workspace,
        commands::set_model_choice,
        commands::get_model_choice,
        commands::extension_ui_respond,
        commands::list_api_keys,
        commands::list_api_keys_masked,
        commands::reveal_api_key,
        commands::set_api_key,
        commands::delete_api_key,
        commands::log_fe,
        commands::read_text_file,
        commands::read_dropped_file,
        commands::read_workspace_text_file,
        commands::write_workspace_text_file,
        commands::reveal_in_finder,
        commands::open_external,
        commands::open_browser_window,
        commands::open_browser_panel,
        commands::set_browser_panel_bounds,
        commands::set_browser_panel_annotation_mode,
        commands::close_browser_panel,
        commands::open_path,
        commands::save_attachment,
        commands::read_clipboard_file_paths,
        commands::list_automations,
        commands::create_automation,
        commands::update_automation,
        commands::delete_automation,
        commands::set_automation_enabled,
        commands::run_automation_now,
        commands::get_capture_settings,
        commands::set_capture_settings,
        commands::capture_stats,
        commands::recent_screenshots,
        commands::search_screenshots,
        commands::search_conversations,
        commands::get_ambient_settings,
        commands::set_ambient_settings,
        commands::ambient_stats,
        commands::recent_ambient_context,
        commands::search_ambient_context,
        commands::clear_ambient_history,
        commands::ambient_recent_summary,
        commands::set_theme_appearance,
        meeting::get_meeting_settings,
        meeting::set_meeting_settings,
        meeting::meeting_status,
        meeting::meeting_start,
        meeting::meeting_stop,
        meeting::list_meetings,
        meeting::delete_meeting,
        meeting::meeting_transcript,
        meeting::meeting_audio_dir,
        meeting::meeting_hud_set_expanded,
        meeting::meeting_hud_cursor_inside,
        memory::list_memories,
        memory::create_memory,
        memory::update_memory,
        memory::delete_memory,
        memory::set_memory_enabled,
        memory::clear_memories,
        transcripts::list_transcripts,
        transcripts::set_transcripts_enabled,
        transcripts::clear_transcripts,
        provider::get_deepseek_base_url,
        provider::set_deepseek_base_url_cmd,
        locale::get_ui_locale,
        locale::set_ui_locale,
        custom_models::list_custom_providers,
        custom_models::upsert_custom_provider,
        custom_models::delete_custom_provider,
        auto_archive::get_auto_archive_settings,
        auto_archive::set_auto_archive_settings,
        skills::list_skills,
        skills::set_skills_enabled,
        skills::import_skill,
        skills::create_skill,
        skills::set_skill_enabled,
        skills::delete_skill,
        skills::reveal_skill,
        skills::list_discovered_skills,
        skills::read_discovered_skill,
        skills::reveal_discovered_skill,
        slash_commands::list_slash_commands,
        slash_commands::upsert_slash_command,
        slash_commands::delete_slash_command,
        mcp::list_connectors,
        mcp::add_connector,
        mcp::update_connector,
        mcp::set_connector_enabled,
        mcp::remove_connector,
        mcp::test_connector,
        mcp::authorize_connector,
        mcp::preview_mcp_import,
        discovery::get_discovery_settings,
        discovery::set_discovery_settings,
        quick::get_quick_settings,
        quick::set_quick_settings,
        updater::check_for_update,
        updater::install_update,
        updater::update_download_progress,
        updater::ignore_update_version,
        updater::pending_update_version,
        updater::relaunch_app,
        quick::quick_recapture_screenshot,
        quick::quick_dismiss,
        quick::quick_reply_insert,
        quick::quick_reply_regenerate,
        quick::quick_submit,
        quick::quick_set_scale,
        quick::quick_set_content_height,
        quick::accessibility_trusted,
        quick::request_accessibility,
        quick::open_accessibility_settings,
        quick::screen_recording_trusted,
        quick::request_screen_recording,
        quick::open_screen_recording_settings,
        quick::full_disk_access_trusted,
        quick::open_full_disk_access_settings,
        snip::snip_finish,
        snip::snip_cancel,
        voice::voice_permissions,
        voice::request_voice_permissions,
        voice::open_microphone_settings,
        voice::insert_text,
        voice::copy_voice_result,
        agent::get_agent_settings,
        agent::set_agent_settings,
        agent::agent_stop,
        artifact_thumbnail::get_artifact_thumbnail,
        plugins::list_plugins,
        plugins::set_plugin_enabled,
        plugins::import_plugin,
        plugins::reveal_plugin,
        plugins::delete_plugin,
        notify::post_notification,
        bash::run_bash,
        terminal::terminal_start,
        terminal::terminal_write,
        terminal::terminal_resize,
        terminal::terminal_stop,
    ]);

    #[cfg(feature = "devtest")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::list_conversations,
        commands::new_conversation,
        commands::fork_conversation,
        commands::switch_conversation,
        commands::set_active_conversation,
        commands::set_conversation_unread,
        commands::set_conversation_pinned,
        commands::archive_conversation,
        commands::clear_interrupted,
        commands::claim_auto_resume,
        commands::set_review_state,
        commands::delete_conversation,
        commands::rename_conversation,
        commands::send_prompt,
        commands::compact_conversation,
        commands::get_conversation,
        commands::set_conversation_backend,
        commands::conversation_worktree,
        commands::workspace_git_branch,
        commands::set_conversation_cli_model,
        remote::get_remote_settings,
        remote::set_remote_enabled,
        remote::rotate_remote_access,
        resources::resources_snapshot,
        cli_backend::get_cli_agent_settings,
        cli_backend::set_cli_agent_settings,
        cli_backend::get_cli_defaults,
        cli_backend::get_cli_runtime_status,
        diagnostics::export_diagnostics,
        cli_backend::get_cli_commands,
        cli_backend::probe_cli_commands,
        cli_backend::cli_control_respond,
        commands::retry_last_turn,
        commands::abort,
        commands::pi_ping,
        webview_health::webview_heartbeat,
        webview_health::wake_main_webview,
        commands::default_workspace,
        commands::pick_workspace_dir,
        commands::save_artifact_copy,
        commands::list_workspace_files,
        commands::list_workspace_directory,
        commands::search_workspace_files,
        commands::export_conversation_transcript,
        commands::create_workspace_entry,
        commands::rename_workspace_entry,
        commands::trash_workspace_entry,
        commands::set_workspace,
        commands::set_model_choice,
        commands::get_model_choice,
        commands::extension_ui_respond,
        commands::list_api_keys,
        commands::list_api_keys_masked,
        commands::reveal_api_key,
        commands::set_api_key,
        commands::delete_api_key,
        commands::log_fe,
        commands::read_text_file,
        commands::read_dropped_file,
        commands::read_workspace_text_file,
        commands::write_workspace_text_file,
        commands::reveal_in_finder,
        commands::open_external,
        commands::open_browser_window,
        commands::open_browser_panel,
        commands::set_browser_panel_bounds,
        commands::set_browser_panel_annotation_mode,
        commands::close_browser_panel,
        commands::open_path,
        commands::save_attachment,
        commands::read_clipboard_file_paths,
        commands::list_automations,
        commands::create_automation,
        commands::update_automation,
        commands::delete_automation,
        commands::set_automation_enabled,
        commands::run_automation_now,
        commands::get_capture_settings,
        commands::set_capture_settings,
        commands::capture_stats,
        commands::recent_screenshots,
        commands::search_screenshots,
        commands::search_conversations,
        commands::get_ambient_settings,
        commands::set_ambient_settings,
        commands::ambient_stats,
        commands::recent_ambient_context,
        commands::search_ambient_context,
        commands::clear_ambient_history,
        commands::ambient_recent_summary,
        commands::set_theme_appearance,
        meeting::get_meeting_settings,
        meeting::set_meeting_settings,
        meeting::meeting_status,
        meeting::meeting_start,
        meeting::meeting_stop,
        meeting::list_meetings,
        meeting::delete_meeting,
        meeting::meeting_transcript,
        meeting::meeting_audio_dir,
        meeting::meeting_hud_set_expanded,
        meeting::meeting_hud_cursor_inside,
        memory::list_memories,
        memory::create_memory,
        memory::update_memory,
        memory::delete_memory,
        memory::set_memory_enabled,
        memory::clear_memories,
        transcripts::list_transcripts,
        transcripts::set_transcripts_enabled,
        transcripts::clear_transcripts,
        provider::get_deepseek_base_url,
        provider::set_deepseek_base_url_cmd,
        locale::get_ui_locale,
        locale::set_ui_locale,
        custom_models::list_custom_providers,
        custom_models::upsert_custom_provider,
        custom_models::delete_custom_provider,
        auto_archive::get_auto_archive_settings,
        auto_archive::set_auto_archive_settings,
        skills::list_skills,
        skills::set_skills_enabled,
        skills::import_skill,
        skills::create_skill,
        skills::set_skill_enabled,
        skills::delete_skill,
        skills::reveal_skill,
        skills::list_discovered_skills,
        skills::read_discovered_skill,
        skills::reveal_discovered_skill,
        slash_commands::list_slash_commands,
        slash_commands::upsert_slash_command,
        slash_commands::delete_slash_command,
        mcp::list_connectors,
        mcp::add_connector,
        mcp::update_connector,
        mcp::set_connector_enabled,
        mcp::remove_connector,
        mcp::test_connector,
        mcp::authorize_connector,
        mcp::preview_mcp_import,
        discovery::get_discovery_settings,
        discovery::set_discovery_settings,
        quick::get_quick_settings,
        quick::set_quick_settings,
        updater::check_for_update,
        updater::install_update,
        updater::update_download_progress,
        updater::ignore_update_version,
        updater::pending_update_version,
        updater::relaunch_app,
        quick::quick_recapture_screenshot,
        quick::quick_dismiss,
        quick::quick_reply_insert,
        quick::quick_reply_regenerate,
        quick::quick_submit,
        quick::quick_set_scale,
        quick::quick_set_content_height,
        quick::accessibility_trusted,
        quick::request_accessibility,
        quick::open_accessibility_settings,
        quick::screen_recording_trusted,
        quick::request_screen_recording,
        quick::open_screen_recording_settings,
        quick::full_disk_access_trusted,
        quick::open_full_disk_access_settings,
        snip::snip_finish,
        snip::snip_cancel,
        voice::voice_permissions,
        voice::request_voice_permissions,
        voice::open_microphone_settings,
        voice::insert_text,
        voice::copy_voice_result,
        agent::get_agent_settings,
        agent::set_agent_settings,
        agent::agent_stop,
        artifact_thumbnail::get_artifact_thumbnail,
        plugins::list_plugins,
        plugins::set_plugin_enabled,
        plugins::import_plugin,
        plugins::reveal_plugin,
        plugins::delete_plugin,
        notify::post_notification,
        bash::run_bash,
        terminal::terminal_start,
        terminal::terminal_write,
        terminal::terminal_resize,
        terminal::terminal_stop,
        devtest::test_eval,
        devtest::test_screenshot,
        devtest::test_ax,
        devtest::test_dom,
        devtest::test_dom_result,
    ]);

    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // Persist the main window's last size/position on quit (Cmd+Q, tray
            // "Quit", dock-quit). Reads the cached on-screen geometry, so a quit
            // while the window is parked off-screen still saves the real values.
            if let tauri::RunEvent::Exit = &_event {
                window_geom::flush(&_app.state::<AppState>().store);
                _app.state::<terminal::TerminalRuntime>().shutdown_all();
                // Hand Caps Lock back to the OS if we'd remapped it for dictation.
                caps_remap::restore();
                // A dev hot-reload or app quit must never orphan a meeting
                // helper with the microphone/system-audio tap still active.
                meeting::shutdown_capture();
                // The sessions killed below take their in-flight turns with
                // them — no outcome will ever settle, so persist the
                // interruption first (synchronous rusqlite write; the process
                // is exiting and spawned tasks wouldn't run).
                let _ = _app.state::<AppState>().store.mark_running_interrupted();
                _app.state::<AppState>().kill_all_cli_sessions();
            }
            // cetus is resident: closing the window only hides it. A macOS dock
            // click (Reopen) with nothing visible should bring the main window
            // back, matching standard app behavior.
            #[cfg(target_os = "macos")]
            {
                if let tauri::RunEvent::Reopen {
                    has_visible_windows,
                    ..
                } = &_event
                {
                    // A parked main window is ordered fully out, so this usually
                    // arrives with has_visible_windows == false; the explicit
                    // main_is_parked() check is belt-and-braces for any macOS
                    // version that still counts the ordered-out window.
                    if !*has_visible_windows || main_is_parked() {
                        // A launcher gesture can momentarily activate cetus before
                        // its non-activating panel is on screen, which macOS may
                        // deliver as a reopen — don't let that yank the (hidden)
                        // main window up. A real dock click has no recent gesture.
                        let recent_launch = {
                            let st = _app.state::<AppState>();
                            let last = st
                                .quick
                                .last_open_ms
                                .load(std::sync::atomic::Ordering::Relaxed);
                            last > 0 && store::now_ms() - last < 1500
                        };
                        if !recent_launch {
                            focus_main(_app);
                        }
                    }
                }
            }
        });
}
