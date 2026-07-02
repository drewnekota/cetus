mod agent;
mod app_event;
mod auto_archive;
mod automation;
mod automation_tool;
mod ax;
mod bash;
mod biasing;
pub use cetus_bridge::{bridge, pi_rpc};
mod caps_remap;
mod capture;
mod commands;
mod corrections;
mod cua;
#[cfg(feature = "devtest")]
mod devtest;
mod discovery;
mod doubao;
mod dream;
#[cfg(target_os = "macos")]
mod host_tunnel;
mod hotkey;
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
mod run_engine;
mod scheduler;
mod secrets;
mod skill_review;
mod skill_tool;
mod skills;
mod slash_commands;
mod store;
mod tauri_bridge;
#[cfg(target_os = "macos")]
mod text_input;
mod titling;
mod transcripts;
mod ultra;
mod updater;
mod voice;
mod window_geom;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Listener, Manager};
use tokio::sync::Mutex;

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
    /// Per-sub-agent result waiters for Ultra Code (run_engine.rs), fulfilled by
    /// the `app-event` listener when a sub-agent calls `emit_node_result`.
    run_registry: run_engine::NodeResultRegistry,
    /// Shared concurrency cap across all Ultra sub-agents (≈ min(16, cores-2)).
    run_semaphore: Arc<tokio::sync::Semaphore>,
    /// Browser/computer "agent control": the macOS AX helper child + the
    /// emergency-stop flags. Shared with the app-event listener's AgentCtx.
    pub cua: cua::CuaRuntime,
}

impl AppState {
    /// Get-or-spawn the pi process owning `conv_id`. On first call we spawn,
    /// switch to the persisted session file, and push the conversation's
    /// model choice onto the fresh pi instance.
    pub async fn pi_for(&self, conv_id: &str) -> anyhow::Result<Arc<pi_rpc::PiRpc>> {
        // Reuse a cached pi without probing while it has spoken within this
        // window; past it, a sleep/wake cycle may have wedged the child.
        const PROBE_AFTER_IDLE: std::time::Duration = std::time::Duration::from_secs(60);
        // Probe budget for a long-idle cached pi. A healthy pi answers in
        // milliseconds; a wedged one costs the user these seconds once, then
        // gets respawned — instead of every RPC eating the full 30s timeout.
        const PING_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

        // Warm path: reuse the cached pi if its child is still alive. A
        // conversation left idle for a long time can have its pi die (OS reap on
        // sleep, crash, …) while the Arc lingers in the pool; reusing that would
        // write sends into a closed stdin and hang.
        let cached = self.pis.lock().await.get(conv_id).cloned();
        if let Some(p) = cached {
            if p.is_alive() {
                // Alive-as-a-process isn't enough after a long idle gap: a
                // machine sleep can leave the child running but unresponsive
                // (dead sockets, suspended event loop), where is_alive() stays
                // true and every RPC times out. Probe before trusting it. A
                // busy pi is exempt — it's mid-turn and guarded by the
                // stall-based turn timeout instead.
                if p.is_busy() || p.idle_for() < PROBE_AFTER_IDLE || p.ping(PING_TIMEOUT).await {
                    return Ok(p);
                }
                tracing::warn!(
                    "pi for {conv_id} alive but unresponsive after {:?} idle; respawning",
                    p.idle_for()
                );
                let mut guard = self.pis.lock().await;
                // Evict only the instance we probed — another caller may have
                // already replaced it with a fresh one we must not kill.
                if guard.get(conv_id).is_some_and(|cur| Arc::ptr_eq(cur, &p)) {
                    guard.remove(conv_id);
                }
            }
        }
        // Cold path: we're about to (re)spawn. First make sure any near-expiry
        // OAuth tokens in the mcporter vault are refreshed, so the bridge's
        // session_start reads a live token instead of a stale one (this is the
        // just-woke-from-sleep window the periodic sweep can miss). Done OUTSIDE
        // the pis lock so the network call can't stall other conversations; gated
        // + best-effort, so it's a cheap no-op when nothing is due.
        crate::mcp_oauth::refresh_due_tokens(crate::mcp_oauth::REFRESH_SKEW).await;

        // Re-check under a SHORT lock: another caller may have spawned while we
        // were unlocked (warm probe / token refresh), or a corpse may still be
        // here to evict. Then release the lock — the expensive spawn + session
        // init below must NOT hold it (see the long comment before the install).
        {
            let mut guard = self.pis.lock().await;
            if let Some(p) = guard.get(conv_id) {
                if p.is_alive() {
                    return Ok(p.clone());
                }
                tracing::info!("pi for {conv_id} died; respawning");
                guard.remove(conv_id);
            }
        }
        let conv = self
            .store
            .get(conv_id)?
            .ok_or_else(|| anyhow::anyhow!("conversation not found: {conv_id}"))?;
        let workspace = PathBuf::from(&conv.workspace_dir);
        if cetus_bridge::remote::parse_remote_workspace(&conv.workspace_dir).is_none() {
            std::fs::create_dir_all(&workspace).ok();
        }
        let mut env = secrets::load_env();
        // Custom DeepSeek endpoint (proxy / self-host / region). The
        // deepseek-endpoint extension reads this and overrides the provider's
        // baseUrl; absent → pi uses the stock api.deepseek.com.
        if let Some(base) = provider::deepseek_base_url(&self.store) {
            env.push(("DEEPSEEK_BASE_URL".into(), base));
        }
        // Per-conversation freeze: each conversation gets its own agent dir
        // (skills) + mcp.json, materialized once from the current global config on
        // first spawn. Pointing pi at these via env (overriding the process-global
        // PI_CODING_AGENT_DIR / CETUS_MCP_CONFIG) means later skill/connector toggles
        // never disturb an existing chat — and keeps each conversation's tool +
        // skills prefix byte-stable for DeepSeek's prompt cache.
        for (k, v) in self.conv_agent_env(conv_id, &workspace) {
            env.push((k, v));
        }
        // Ultra Code (global toggle) appends the workflow-authoring contract to
        // this conversation's system prompt so the agent can orchestrate.
        let mut extra = String::new();
        if ultra::load_settings(&self.store).enabled {
            extra.push_str(prompts::ULTRA_SYSTEM_PROMPT);
        }
        if let Some(p) = plugins::extra_system_prompt(&self.store) {
            extra.push_str(&p);
        }
        // Concrete "reply in <language>" anchor from the resolved UI locale, so
        // the model doesn't drift to whatever language recent context was in.
        extra.push_str(&locale::locale_system_prompt(&self.store));
        let mut runtime_config =
            prompts::cetus_runtime_config((!extra.is_empty()).then_some(extra));
        if let Some(pi_dir) = self.pi_bin.parent() {
            runtime_config.plugin_extensions =
                plugins::bridge_plugin_extensions(pi_dir, &self.store);
        }
        // Spawn the subprocess and run session init (new/switch + apply_choice,
        // several RPC round-trips) WITHOUT the pool lock. Holding it here was the
        // app-wide serialization point: while one conversation cold-started,
        // every other conversation's pool access blocked. Done unlocked, distinct
        // conversations spawn concurrently.
        let event_sink = Arc::new(tauri_bridge::TauriEventSink::new(self.handle.clone()));
        let task_spawner = Arc::new(tauri_bridge::TauriTaskSpawner);
        let pi = Arc::new(pi_rpc::PiRpc::spawn(
            event_sink,
            task_spawner,
            &self.pi_bin,
            &self.sessions_dir,
            &workspace,
            env,
            Some(conv_id.to_string()),
            runtime_config,
        )?);
        // A conversation minted by `new_conversation` has no session yet (it
        // skips the eager spawn). Create one now; an existing conversation just
        // re-attaches to its saved session. The freshly-minted file is persisted
        // only AFTER we win the install race below, so a losing racer can't
        // overwrite the winner's session pointer (which would strand history).
        let new_session_file = if conv.session_file.is_empty() {
            Some(pi.new_session().await?)
        } else {
            pi.switch_session(&conv.session_file).await?;
            None
        };
        model_bridge::apply_choice(&pi, conv.model).await?;

        // Install under a SHORT lock, losing a same-id race gracefully: if another
        // caller finished first and its pi is alive, keep theirs and drop ours —
        // our Arc's Drop reaps the child we just spawned (its empty session file,
        // if any, is a harmless orphan since this pi never took a turn).
        let mut guard = self.pis.lock().await;
        if let Some(existing) = guard.get(conv_id) {
            if existing.is_alive() {
                return Ok(existing.clone());
            }
            guard.remove(conv_id);
        }
        if let Some(session_file) = new_session_file {
            self.store.set_session_file(conv_id, &session_file)?;
        }
        guard.insert(conv_id.to_string(), pi.clone());
        Ok(pi)
    }

    /// Resolve (materializing once) this conversation's frozen agent dir + mcp.json
    /// and return the env overrides that point pi at them. The directory's
    /// existence is the snapshot: the first spawn copies the then-current enabled
    /// skills + connectors in; subsequent spawns reuse the frozen copy verbatim.
    /// Legacy conversations (created before this) materialize on their next spawn.
    fn conv_agent_env(&self, conv_id: &str, workspace: &Path) -> Vec<(String, String)> {
        let conv_dir = self.app_data_dir.join("conv-agents").join(conv_id);
        let mcp_path = conv_dir.join("mcp.json");
        if !conv_dir.exists() {
            let mut skill_budget = skills::SkillPromptBudget::from_env();
            skills::materialize_skills_into_with_budget(
                &self.app_data_dir,
                &conv_dir.join("skills"),
                &self.store,
                &mut skill_budget,
                Some(workspace),
            );
            plugins::plugin_freeze_skills(
                &self.app_data_dir,
                &conv_dir.join("skills"),
                &self.store,
                &mut skill_budget,
            );
            mcp::write_conv_config(&mcp_path, &self.store);
        }
        let mcp = mcp_path.to_string_lossy().into_owned();
        vec![
            (
                "PI_CODING_AGENT_DIR".into(),
                conv_dir.to_string_lossy().into_owned(),
            ),
            ("CETUS_MCP_CONFIG".into(), mcp.clone()),
            ("MCPORTER_CONFIG".into(), mcp),
        ]
    }

    /// Remove a conversation's frozen agent dir (skills + mcp.json). Called when
    /// the conversation is deleted so freezes don't accumulate on disk.
    pub fn remove_conv_agent(&self, conv_id: &str) {
        let _ = std::fs::remove_dir_all(self.app_data_dir.join("conv-agents").join(conv_id));
    }

    /// Lookup-only — returns None if no pi has been spawned for this id yet.
    /// Used by ops that should be no-ops when no process exists (abort,
    /// set_model_choice on an idle conversation, …).
    pub async fn pi_existing(&self, conv_id: &str) -> Option<Arc<pi_rpc::PiRpc>> {
        self.pis.lock().await.get(conv_id).cloned()
    }

    pub async fn set_active_conversation(&self, conv_id: Option<String>) {
        *self.active_conversation.lock().await = conv_id;
    }

    pub async fn active_conversation(&self) -> Option<String> {
        self.active_conversation.lock().await.clone()
    }

    /// Drop the pi owning `conv_id`. The Arc's Drop kills the child process.
    pub async fn kill_pi(&self, conv_id: &str) {
        self.pis.lock().await.remove(conv_id);
    }

    /// Drop every pi. Used when secrets change so the next pi_for call picks
    /// up fresh env vars from the keychain.
    pub async fn kill_all(&self) {
        self.pis.lock().await.clear();
    }

    pub fn pi_bin(&self) -> &Path {
        &self.pi_bin
    }
    pub fn sessions_dir(&self) -> &Path {
        &self.sessions_dir
    }
    pub fn handle(&self) -> &AppHandle {
        &self.handle
    }

    /// Clone of the workflow-engine result registry (shared with the app-event
    /// listener, which resolves a node's pending result on `emit_node_result`).
    pub fn run_registry(&self) -> run_engine::NodeResultRegistry {
        self.run_registry.clone()
    }

    /// Clone of the shared run concurrency limiter.
    pub fn run_semaphore(&self) -> Arc<tokio::sync::Semaphore> {
        self.run_semaphore.clone()
    }

    /// Bundle the dependencies the background scheduler needs into a cheap,
    /// `'static`-friendly clone (shares the live pi pool and store).
    pub fn scheduler_ctx(&self) -> scheduler::SchedulerCtx {
        scheduler::SchedulerCtx {
            store: self.store.clone(),
            pool: self.pis.clone(),
            inflight: self.inflight.clone(),
            handle: self.handle.clone(),
            pi_bin: self.pi_bin.clone(),
            sessions_dir: self.sessions_dir.clone(),
            default_workspace: self.default_workspace.clone(),
        }
    }
}

/// Where persisted logs live: `<app data>/logs/cetus.log.YYYY-MM-DD`, daily
/// rolling. Resolved without the Tauri path API because tracing must come up
/// before the app builder (the identifier matches tauri.conf.json).
fn log_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        dirs_home().map(|h| h.join("Library/Application Support/dev.cetus.app/logs"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        dirs_home().map(|h| h.join(".cetus/logs"))
    }
}

/// Keep the log directory bounded: drop files whose mtime is older than a week.
fn prune_old_logs(dir: &Path) {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            let pi_bin = pi_dir.join("pi");
            std::env::set_var(
                plugins::CETUS_USER_PLUGINS_ENV,
                plugins::user_plugins_dir(&app_data_dir),
            );

            let store = Arc::new(store::Store::open(&db_path).expect("open sqlite store"));
            // Size/position the main window before it's presented: restore the
            // user's last geometry, or default to 90% of the current monitor,
            // centered, on the first ever launch. Tracking + persistence is wired
            // up below via the main window's event handler and the exit flush.
            window_geom::restore_or_default(app.handle(), &store);
            // Default workspace lives under $HOME so the agent writes where the
            // user expects, not inside the app's install tree.
            let default_workspace = dirs_home()
                .map(|h| h.join("cetus"))
                .unwrap_or_else(|| app_data_dir.join("workspace"));
            std::fs::create_dir_all(&default_workspace).ok();

            // Quick-launcher config drives both the panel and the native gesture
            // listener; build the shared runtime from persisted settings.
            quick::migrate_voice_defaults(&store);
            let quick_settings = quick::load_settings(&store);
            let quick_runtime = quick::QuickRuntime::from_settings(&quick_settings);
            // If Caps Lock is the active voice trigger, (re)apply the HID remap
            // now — it clears on reboot, so it has to be re-established each launch.
            caps_remap::set_active(
                quick_settings.voice_enabled
                    && quick::voice_gesture_code(&quick_settings.voice_gesture)
                        == quick::VOICE_CAPS_LOCK,
            );

            // Ultra Code sub-agents: a per-node result registry the host awaits
            // and a shared concurrency cap. The host-side observer listens on the
            // SAME `app-event` channel pi_rpc emits to, resolving a sub-agent's
            // pending result the instant it calls `emit_node_result` — no UI
            // window required. The same listener answers Ultra `agent()` requests
            // (run a sub-agent, reply to the waiting in-pi script).
            let run_registry = run_engine::new_registry();
            let run_semaphore = run_engine::new_semaphore();
            // The pool + dedup set are shared by AppState, the scheduler, and the
            // listener's RunCtx, so a node spawned anywhere lands in one pool.
            let pis: Arc<Mutex<HashMap<String, Arc<pi_rpc::PiRpc>>>> =
                Arc::new(Mutex::new(HashMap::new()));
            let inflight: scheduler::InFlight =
                Arc::new(std::sync::Mutex::new(std::collections::HashSet::new()));
            // Browser/computer agent-control runtime: the AX helper child +
            // emergency-stop flags, shared by AppState and the app-event listener.
            let cua = cua::CuaRuntime::new();
            {
                let registry = run_registry.clone();
                let listener_ctx = run_engine::RunCtx {
                    sched: scheduler::SchedulerCtx {
                        store: store.clone(),
                        pool: pis.clone(),
                        inflight: inflight.clone(),
                        handle: handle.clone(),
                        pi_bin: pi_bin.clone(),
                        sessions_dir: sessions_dir.clone(),
                        default_workspace: default_workspace.clone(),
                    },
                    registry: run_registry.clone(),
                    semaphore: run_semaphore.clone(),
                };
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
                    run_engine::handle_app_event(&registry, payload);
                    ultra::maybe_handle_agent_request(&listener_ctx, payload);
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
                run_registry,
                run_semaphore,
                cua: cua.clone(),
            });

            // Meeting memory: the single in-flight capture session, shared by
            // the commands, the auto-detect monitor, and the global hotkey.
            app.manage(meeting::MeetingRuntime::default());

            // Background scheduler: fires due automations on a timer. Shares the
            // managed AppState's pi pool + store via a cheap ctx clone.
            let sched_ctx = app.state::<AppState>().scheduler_ctx();
            tauri::async_runtime::spawn(scheduler::run_scheduler(sched_ctx));

            // Dreaming: while the user is idle, consolidate recent sessions into
            // agent memory. Resolves AppState from the handle each tick; safe to
            // spawn now that AppState is managed above.
            dream::spawn_dreamer(app.handle().clone());

            // Auto-archive: opt-in background sweep that archives conversations
            // left untouched past the user's idle threshold. No-op while off.
            auto_archive::spawn_auto_archiver(app.handle().clone());

            // OAuth token keep-alive: proactively refresh near-expiry mcporter
            // tokens so remote connectors (Notion, …) don't silently die ~1h after
            // authorizing. No-op when there are no OAuth connectors.
            mcp_oauth::spawn_token_refresher();

            // Skill review: while the user is idle, distill reusable skills from
            // recent sessions and land them as disabled proposals for review.
            skill_review::spawn_skill_reviewer(app.handle().clone());

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
                                }
                            }
                        });
                    }
                    _ => {}
                });
            }
            // Bring a parked main window back on ANY activation of cetus — Cmd-Tab,
            // Mission Control / three-finger-swipe, App Exposé, or a click on the
            // app — not just a Dock reopen. A closed main window is parked fully
            // ordered-out (clean Mission Control), so it can't receive a `Focused`
            // event and the Dock-only `Reopen` handler never sees these routes;
            // without this catch-all the only way back was the summon hotkey/tray.
            #[cfg(target_os = "macos")]
            {
                let app_active = app.handle().clone();
                crate::panel::install_app_active_observer(move || {
                    // Only act when the window isn't already on screen — parked
                    // off-screen by a ⌘W close, or hidden ⌘H-style by the summon
                    // hotkey. A normal activation of an already-showing cetus must
                    // not disturb it.
                    if !main_is_parked()
                        && !MAIN_HOTKEY_HIDDEN.load(std::sync::atomic::Ordering::Relaxed)
                    {
                        return;
                    }
                    // A launcher gesture momentarily activates cetus before its
                    // non-activating panel is up, which would otherwise yank the
                    // parked window onscreen — same guard the Reopen handler uses.
                    let recent_launch = {
                        let st = app_active.state::<AppState>();
                        let last = st
                            .quick
                            .last_open_ms
                            .load(std::sync::atomic::Ordering::Relaxed);
                        last > 0 && store::now_ms() - last < 1500
                    };
                    if !recent_launch {
                        focus_main(&app_active);
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
                        "tray_quit" => app.exit(0),
                        _ => {}
                    });
                // Monochrome template glyph: macOS tints it to match the menu bar
                // (white in dark mode, black in light), like every native status item.
                if let Ok(icon) =
                    tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))
                {
                    tray = tray.icon(icon).icon_as_template(true);
                } else if let Some(icon) = app.default_window_icon() {
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
                // Keep cetus out of App Nap so a long-idle window doesn't flash
                // the bare vibrancy (no DOM) for a beat when you switch back to it.
                panel::prevent_app_nap();
                // Arc-style glass shell: the whole main window is a translucent
                // vibrancy surface. The DOM keeps the content card opaque, so the
                // frost shows through the sidebar + the margins around the card.
                // No corner radius — the decorated window clips its own corners.
                if let Some(win) = app.get_webview_window("main") {
                    let _ = apply_vibrancy(
                        &win,
                        NSVisualEffectMaterial::Sidebar,
                        Some(NSVisualEffectState::Active),
                        None,
                    );
                    // Stop WebKit from throttling/suspending the main window's
                    // webview while it's parked off-screen, so summoning it back
                    // after a long idle doesn't flash the bare vibrancy surface.
                    if let Ok(ptr) = win.ns_window() {
                        panel::disable_occlusion_throttling(ptr);
                    }
                }
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
                        // NOTE: do NOT `park()` here to pre-warm. At setup time
                        // the screen list / window size aren't settled, so the
                        // sliver move can no-op while `orderFrontRegardless`
                        // still shows the window — leaving a full-size,
                        // click-through, un-dismissable panel on launch. The
                        // first gesture warms it; every dismiss after that parks
                        // it warm. Only the first open per launch may flash.
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
            }
            Ok(())
        })
        // App menu bar. Start from the platform default (App / Edit / Window /
        // Help) so copy, paste, select-all and the rest keep their accelerators,
        // then graft a View menu carrying an explicit Reload bound to ⌘R — the
        // bare WKWebView has no reload command, so without this menu item ⌘R
        // never reaches the page (the JS guard is a focus-dependent fallback).
        .menu(|app| {
            use tauri::menu::{Menu, MenuItemBuilder, Submenu};
            let menu = Menu::default(app)?;
            let reload = MenuItemBuilder::with_id("view_reload", "Reload")
                .accelerator("CmdOrCtrl+R")
                .build(app)?;
            let view = Submenu::with_items(app, "View", true, &[&reload])?;
            // Conventional slot: right after Edit (App=0, Edit=1). Fall back to
            // appending if the default menu's shape ever differs.
            if menu.insert(&view, 2).is_err() {
                let _ = menu.append(&view);
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id.as_ref() == "view_reload" {
                reload_focused_window(app);
            }
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
        commands::archive_conversation,
        commands::set_review_state,
        commands::delete_conversation,
        commands::rename_conversation,
        commands::send_prompt,
        commands::get_conversation,
        commands::set_conversation_backend,
        commands::retry_last_turn,
        commands::abort,
        commands::pi_ping,
        commands::default_workspace,
        commands::pick_workspace_dir,
        commands::list_workspace_files,
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
        commands::reveal_in_finder,
        commands::open_external,
        commands::open_browser_window,
        commands::open_browser_panel,
        commands::set_browser_panel_bounds,
        commands::set_browser_panel_annotation_mode,
        commands::close_browser_panel,
        commands::open_path,
        commands::save_attachment,
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
        commands::set_theme_appearance,
        meeting::get_meeting_settings,
        meeting::set_meeting_settings,
        meeting::meeting_status,
        meeting::meeting_start,
        meeting::meeting_stop,
        meeting::list_meetings,
        meeting::delete_meeting,
        meeting::meeting_transcript,
        memory::list_memories,
        memory::create_memory,
        memory::update_memory,
        memory::delete_memory,
        memory::set_memory_enabled,
        memory::clear_memories,
        transcripts::list_transcripts,
        transcripts::set_transcripts_enabled,
        transcripts::clear_transcripts,
        ultra::get_ultra_settings,
        ultra::set_ultra_settings,
        provider::get_deepseek_base_url,
        provider::set_deepseek_base_url_cmd,
        locale::get_ui_locale,
        locale::set_ui_locale,
        dream::get_dream_settings,
        dream::set_dream_settings,
        auto_archive::get_auto_archive_settings,
        auto_archive::set_auto_archive_settings,
        skill_review::get_skill_review_settings,
        skill_review::set_skill_review_settings,
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
        updater::ignore_update_version,
        quick::quick_recapture_screenshot,
        quick::quick_dismiss,
        quick::quick_submit,
        quick::accessibility_trusted,
        quick::request_accessibility,
        quick::open_accessibility_settings,
        quick::screen_recording_trusted,
        quick::request_screen_recording,
        quick::open_screen_recording_settings,
        voice::voice_permissions,
        voice::request_voice_permissions,
        voice::open_microphone_settings,
        voice::insert_text,
        agent::get_agent_settings,
        agent::set_agent_settings,
        agent::agent_stop,
        plugins::list_plugins,
        plugins::set_plugin_enabled,
        plugins::import_plugin,
        plugins::reveal_plugin,
        plugins::delete_plugin,
        notify::post_notification,
        bash::run_bash,
    ]);

    #[cfg(feature = "devtest")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::list_conversations,
        commands::new_conversation,
        commands::fork_conversation,
        commands::switch_conversation,
        commands::set_active_conversation,
        commands::archive_conversation,
        commands::set_review_state,
        commands::delete_conversation,
        commands::rename_conversation,
        commands::send_prompt,
        commands::get_conversation,
        commands::set_conversation_backend,
        commands::retry_last_turn,
        commands::abort,
        commands::pi_ping,
        commands::default_workspace,
        commands::pick_workspace_dir,
        commands::list_workspace_files,
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
        commands::reveal_in_finder,
        commands::open_external,
        commands::open_browser_window,
        commands::open_browser_panel,
        commands::set_browser_panel_bounds,
        commands::set_browser_panel_annotation_mode,
        commands::close_browser_panel,
        commands::open_path,
        commands::save_attachment,
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
        commands::set_theme_appearance,
        meeting::get_meeting_settings,
        meeting::set_meeting_settings,
        meeting::meeting_status,
        meeting::meeting_start,
        meeting::meeting_stop,
        meeting::list_meetings,
        meeting::delete_meeting,
        meeting::meeting_transcript,
        memory::list_memories,
        memory::create_memory,
        memory::update_memory,
        memory::delete_memory,
        memory::set_memory_enabled,
        memory::clear_memories,
        transcripts::list_transcripts,
        transcripts::set_transcripts_enabled,
        transcripts::clear_transcripts,
        ultra::get_ultra_settings,
        ultra::set_ultra_settings,
        provider::get_deepseek_base_url,
        provider::set_deepseek_base_url_cmd,
        locale::get_ui_locale,
        locale::set_ui_locale,
        dream::get_dream_settings,
        dream::set_dream_settings,
        auto_archive::get_auto_archive_settings,
        auto_archive::set_auto_archive_settings,
        skill_review::get_skill_review_settings,
        skill_review::set_skill_review_settings,
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
        updater::ignore_update_version,
        quick::quick_recapture_screenshot,
        quick::quick_dismiss,
        quick::quick_submit,
        quick::accessibility_trusted,
        quick::request_accessibility,
        quick::open_accessibility_settings,
        quick::screen_recording_trusted,
        quick::request_screen_recording,
        quick::open_screen_recording_settings,
        voice::voice_permissions,
        voice::request_voice_permissions,
        voice::open_microphone_settings,
        voice::insert_text,
        agent::get_agent_settings,
        agent::set_agent_settings,
        agent::agent_stop,
        plugins::list_plugins,
        plugins::set_plugin_enabled,
        plugins::import_plugin,
        plugins::reveal_plugin,
        plugins::delete_plugin,
        notify::post_notification,
        bash::run_bash,
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
                // Hand Caps Lock back to the OS if we'd remapped it for dictation.
                caps_remap::restore();
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

/// Where the main window sat before [`park_main`] tucked it warm off-screen
/// (origin x, y + the style mask the park stripped to borderless); `None` when
/// it's showing normally. macOS-only.
#[cfg(target_os = "macos")]
static MAIN_PARKED_ORIGIN: std::sync::Mutex<Option<(f64, f64, usize)>> =
    std::sync::Mutex::new(None);

/// Whether the main window was hidden ⌘H-style by the summon hotkey
/// ([`toggle_main`]) rather than parked off-screen by a ⌘W close. `NSApplication
/// hide:` leaves no parked geometry, so the activation observer can't lean on
/// [`main_is_parked`] to know it must summon the window back on the next Cmd-Tab
/// / activation — this flag fills that gap. Cleared whenever [`focus_main`]
/// brings the window forward again.
#[cfg(target_os = "macos")]
static MAIN_HOTKEY_HIDDEN: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Whether the main window is currently parked (closed → tucked away warm and
/// ordered out). Read by the app-activation observer and the Dock-reopen handler
/// to decide whether an activation needs to summon the window back, and by
/// `toggle_main` to choose summon-vs-hide.
#[cfg(target_os = "macos")]
fn main_is_parked() -> bool {
    MAIN_PARKED_ORIGIN.lock().unwrap().is_some()
}

/// Hide the main window to the background on close while keeping its WKWebView
/// warm, so reopening after a long idle doesn't flash the bare vibrancy (the
/// same idle-discard issue [`crate::panel::park`] fixes for the launcher). Off
/// macOS there is no warm-park trick, so just hide it.
pub(crate) fn park_main(app: &AppHandle) {
    // Persist the last on-screen geometry (the close handler recorded it just
    // before this call), then freeze recording so the off-screen park move
    // can't overwrite it.
    window_geom::flush(&app.state::<AppState>().store);
    window_geom::suspend();
    #[cfg(target_os = "macos")]
    {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            // Take the lock for the whole park so a concurrent focus_main
            // can't interleave, and skip if already parked — a second close
            // would otherwise overwrite the saved real origin with the
            // off-screen sliver position and the next restore would "show"
            // the window off-screen.
            let mut slot = MAIN_PARKED_ORIGIN.lock().unwrap();
            if slot.is_some() {
                return;
            }
            if let Some(w) = app2.get_webview_window("main") {
                // A native-fullscreen window has no frame to park (and
                // stripping its style mask mid-fullscreen would wedge the
                // Space) — just hide it; focus_main's non-parked branch
                // shows it again.
                if w.is_fullscreen().unwrap_or(false) {
                    let _ = w.hide();
                    return;
                }
                if let Ok(ptr) = w.ns_window() {
                    *slot = crate::panel::park_main_window(ptr);
                }
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.hide();
        }
    }
}

/// Reload the focused window's webview — the View → Reload menu item / ⌘R. The
/// bare WKWebView ships no reload of its own, so the menu drives it via JS.
/// Targets whichever window currently has focus, falling back to the main one.
fn reload_focused_window(app: &AppHandle) {
    let target = app
        .webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window("main"));
    if let Some(win) = target {
        let _ = win.eval("window.location.reload()");
    }
}

/// Bring the main window to the foreground (shared by the tray menu, the macOS
/// dock-reopen handler, the launcher submit, and the global summon hotkey).
/// `set_focus` activates the app on macOS, so the OS switches to whichever
/// Space/desktop holds the window — the cross-desktop "jump to cetus" the summon
/// hotkey wants. If the window was parked warm off-screen, restore its real
/// position and chrome first.
pub(crate) fn focus_main(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            // Read-and-clear the parked origin HERE, on the main thread, not
            // on the caller's thread: park_main writes it from the main
            // thread, so taking it early from a worker (tray / launcher
            // submit) could interleave with a close and leave a fully-shown
            // window still ignoring the mouse (see panel::enable_mouse_events).
            let parked = MAIN_PARKED_ORIGIN.lock().unwrap().take();
            let was_parked = parked.is_some();
            tracing::debug!("focus_main: was_parked={was_parked}");
            // Window is coming forward — clear the ⌘H-hotkey-hidden flag the
            // activation observer watches so a later activation won't re-summon.
            MAIN_HOTKEY_HIDDEN.store(false, std::sync::atomic::Ordering::Relaxed);
            if let Some(w) = app2.get_webview_window("main") {
                if let Ok(ptr) = w.ns_window() {
                    match parked {
                        Some((x, y, mask)) => crate::panel::unpark_main_window(ptr, x, y, mask),
                        // Not parked — but a close→reopen race may still have
                        // leaked the park's mouse-ignore flag onto a window
                        // we're about to show. Healing is idempotent, so a
                        // summoned window is always clickable (red dot
                        // included) even before it ever becomes key.
                        None => crate::panel::enable_mouse_events(ptr),
                    }
                    // Paint-synced reveal for a window coming back from a park:
                    // a long ordered-out idle can discard its WKWebView backing
                    // store, so showing it opaque flashes the bare vibrancy
                    // before the DOM repaints. Go invisible BEFORE ordering it
                    // front (below), then reveal once the next frame presents.
                    // A warm (never-parked) window is already painted, so skip
                    // the extra hop and its latency.
                    if was_parked {
                        crate::panel::hide_alpha(ptr);
                    }
                }
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
                // Now that it's ordered front + activated (so WebKit repaints),
                // flip it visible after the webview presents its first frame.
                if was_parked {
                    if let Ok(ptr) = w.ns_window() {
                        crate::panel::reveal_after_paint(ptr);
                    }
                }
            }
            // Back on-screen at its real position — track moves again.
            window_geom::resume();
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
        window_geom::resume();
    }
}

/// Summon-hotkey behavior: bring cetus forward, or — if it's already the
/// frontmost app — hide it (⌘H-style), so the same key toggles the app in and
/// out. AppKit calls must run on the main thread.
fn toggle_main(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        let _ = app.clone().run_on_main_thread(move || {
            // "Active" alone is not enough to decide to hide: closing the main
            // window parks it off-screen WITHOUT deactivating the app, so
            // right after a ⌘W cetus is often still the active app with nothing
            // on screen — the is-active check alone would hide_app and the
            // summon press would look eaten. Only hide when the window is
            // genuinely showing (not parked AND visible); otherwise summon.
            let showing = !main_is_parked()
                && app
                    .get_webview_window("main")
                    .and_then(|w| w.is_visible().ok())
                    .unwrap_or(false);
            if crate::panel::app_is_active() && showing {
                crate::panel::hide_app();
                // ⌘H-style hide parks no geometry, so flag it for the activation
                // observer to summon the window back on the next Cmd-Tab.
                MAIN_HOTKEY_HIDDEN.store(true, std::sync::atomic::Ordering::Relaxed);
            } else {
                focus_main(&app);
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        focus_main(app);
    }
}

/// (Re)register the app's global shortcuts: the summon hotkey passed in plus
/// the meeting-capture toggle from its settings. Clears all previous bindings
/// first so a changed accelerator never leaves a stale registration behind. A
/// malformed accelerator is logged and skipped rather than failing the whole
/// settings save.
pub(crate) fn apply_summon_hotkey(app: &AppHandle, hotkey: &str) {
    #[cfg(desktop)]
    {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let gs = app.global_shortcut();
        let _ = gs.unregister_all();

        let hk = hotkey.trim();
        if !hk.is_empty() {
            match hk.parse::<tauri_plugin_global_shortcut::Shortcut>() {
                Ok(sc) => {
                    if let Err(e) = gs.register(sc) {
                        tracing::warn!("cetus: failed to register summon hotkey {hk:?}: {e}");
                    }
                }
                Err(e) => tracing::warn!("cetus: invalid summon hotkey {hk:?}: {e}"),
            }
        }

        // Meeting-capture toggle. sync_toggle_hotkey also stashes the parsed
        // shortcut so the plugin handler can route presses to the right action.
        // Gated on the feature's master switch: the binding ships with a
        // default, and an unregistered-but-bound hotkey must never be able to
        // start the mic for a user who hasn't opted in.
        let meeting_settings = meeting::load_settings(&app.state::<AppState>().store);
        let meeting_hk = if meeting_settings.enabled {
            meeting_settings.toggle_hotkey
        } else {
            String::new()
        };
        if let Some(sc) = meeting::sync_toggle_hotkey(&meeting_hk) {
            if let Err(e) = gs.register(sc) {
                tracing::warn!("cetus: failed to register meeting hotkey {meeting_hk:?}: {e}");
            }
        }
    }
}

/// Sync the OS login item with the "launch on startup" toggle. Enabling
/// registers cetus as a macOS login item (launches into the tray); disabling
/// removes it. Errors are logged and swallowed so a flaky login-item API never
/// fails the whole settings save.
pub(crate) fn apply_launch_on_startup(app: &AppHandle, enabled: bool) {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        let mgr = app.autolaunch();
        let res = if enabled { mgr.enable() } else { mgr.disable() };
        if let Err(e) = res {
            tracing::warn!("cetus: failed to set launch-on-startup={enabled}: {e}");
        }
    }
}

/// Return a writable directory containing the pi binary and its runtime tree.
///
/// Precedence:
/// 1. `PI_INSTALL` env var — absolute path to an existing install tree (dev).
/// 2. `<app_data>/pi-install` if already populated.
/// 3. Copy from the Tauri resource bundle (`<resource_dir>/pi-install`) to
///    `<app_data>/pi-install` on first launch.
fn resolve_pi_install(app: &AppHandle, app_data: &Path) -> anyhow::Result<PathBuf> {
    if let Ok(p) = std::env::var("PI_INSTALL") {
        let p = PathBuf::from(p);
        if p.join("pi").exists() {
            tracing::info!("using PI_INSTALL={}", p.display());
            // The bundled-resource overlay below never runs on this dev branch,
            // so without a sync here the install's cetus-extensions stay frozen at
            // whatever build-pi-sidecar.sh last produced — editing
            // src-tauri/cetus-extensions/*.ts (e.g. adding browser-use) would have
            // no effect, yet the capability prompt would still promise tools the
            // stale overlay never registered. Re-sync straight from the tracked
            // source so a pi respawn always reflects the current files.
            if let Some(src) = dev_ext_src() {
                if let Err(e) = sync_cetus_extensions_from(&src, &p) {
                    tracing::warn!("dev cetus-extensions sync skipped: {e}");
                } else {
                    tracing::info!("synced cetus-extensions from {}", src.display());
                }
            }
            if let Some(src) = plugins::dev_plugins_src() {
                if let Err(e) = sync_cetus_plugins_from(&src, &p) {
                    tracing::warn!("dev cetus-plugins sync skipped: {e}");
                } else {
                    tracing::info!("synced cetus-plugins from {}", src.display());
                }
            }
            std::env::set_var(
                plugins::CETUS_BUILTIN_PLUGINS_ENV,
                plugins::runtime_plugins_dir(&p),
            );
            return Ok(p);
        }
        anyhow::bail!("PI_INSTALL={} does not contain a pi binary", p.display());
    }

    let target = app_data.join("pi-install");
    let resource = app
        .path()
        .resource_dir()
        .map_err(|e| anyhow::anyhow!("resource_dir: {e}"))?
        .join("pi-install");

    if target.join("pi").exists() {
        // Always re-sync our cetus-extensions overlay so new tool files (and
        // edits to existing ones) ship without needing to wipe the install
        // tree. Without this, a stale install from before cetus-extensions/
        // existed would silently strand new tools.
        if let Some(src) = dev_ext_src() {
            sync_cetus_extensions_from(&src, &target)?;
            tracing::info!("synced cetus-extensions from {}", src.display());
        } else if resource.join("pi").exists() {
            sync_cetus_extensions(&resource, &target)?;
        }
        if let Some(src) = plugins::dev_plugins_src() {
            sync_cetus_plugins_from(&src, &target)?;
            tracing::info!("synced cetus-plugins from {}", src.display());
        } else if resource.join("pi").exists() {
            sync_cetus_plugins(&resource, &target)?;
        }
        if resource.join("pi").exists() {
            // The tree's node_modules is copied only on first install, so a
            // bundled pi-ai hotfix (the transform-messages content guard, see
            // scripts/build-pi-sidecar.sh) would otherwise never reach an
            // already-installed tree — leaving it permanently prone to the
            // "undefined is not an object (evaluating 'content')" brick.
            if let Err(e) = sync_pi_ai_guard(&resource, &target) {
                tracing::warn!("pi-ai guard sync skipped: {e}");
            }
        }
        std::env::set_var(
            plugins::CETUS_BUILTIN_PLUGINS_ENV,
            plugins::runtime_plugins_dir(&target),
        );
        return Ok(target);
    }

    if !resource.join("pi").exists() {
        anyhow::bail!(
            "pi-install missing from resources at {}; run scripts/build-pi-sidecar.sh",
            resource.display()
        );
    }
    tracing::info!(
        "installing pi tree {} → {}",
        resource.display(),
        target.display()
    );
    copy_dir(&resource, &target)?;
    if let Some(src) = dev_ext_src() {
        sync_cetus_extensions_from(&src, &target)?;
        tracing::info!("synced cetus-extensions from {}", src.display());
    }
    if let Some(src) = plugins::dev_plugins_src() {
        sync_cetus_plugins_from(&src, &target)?;
        tracing::info!("synced cetus-plugins from {}", src.display());
    }
    std::env::set_var(
        plugins::CETUS_BUILTIN_PLUGINS_ENV,
        plugins::runtime_plugins_dir(&target),
    );
    Ok(target)
}

/// Re-deploy `<resource>/cetus-extensions` over `<target>/cetus-extensions`.
/// Cheap (tiny number of small .ts files) and keeps tool updates flowing
/// without bumping the install version or wiping the cache.
fn sync_cetus_extensions(resource: &Path, target: &Path) -> std::io::Result<()> {
    sync_cetus_extensions_from(&resource.join(crate::bridge::CETUS_EXTENSIONS_DIR), target)
}

/// Re-deploy `<resource>/cetus-plugins` over `<target>/cetus-plugins`.
fn sync_cetus_plugins(resource: &Path, target: &Path) -> std::io::Result<()> {
    sync_cetus_plugins_from(&resource.join(plugins::CETUS_PLUGINS_DIR), target)
}

fn sync_cetus_plugins_from(src: &Path, target: &Path) -> std::io::Result<()> {
    let dst = target.join(plugins::CETUS_PLUGINS_DIR);
    if !src.exists() {
        return Ok(());
    }
    if dst.exists() {
        std::fs::remove_dir_all(&dst)?;
    }
    copy_dir(src, &dst)
}

/// Recursively copy `src` into `dst`, creating `dst`. Best-effort helper used
/// once at startup to carry pre-rename app data (the old `dev.jinqiu.kott` dir)
/// over to the new identifier's dir. Regular files and directories only —
/// symlinks are skipped so a stray link can't escape the tree or loop.
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ft.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if ft.is_file() {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Copy a cetus-extensions source directory over `<target>/cetus-extensions`,
/// replacing it wholesale so removed tool files don't linger, and pruning any
/// dir left behind by a previous name for the extensions tree. No-op when `src`
/// is absent.
fn sync_cetus_extensions_from(src: &Path, target: &Path) -> std::io::Result<()> {
    let dst = target.join(crate::bridge::CETUS_EXTENSIONS_DIR);
    if !src.exists() {
        return Ok(());
    }
    // A valid replacement is going in, so drop any extensions dir left by an
    // earlier name. The loader reads only CETUS_EXTENSIONS_DIR, so a renamed-away
    // copy is dead weight that hides rename bugs (it can leave an install with
    // tools the loader never sees). Pruned only once `src` is confirmed present
    // so we never strip the install down to no extensions at all.
    for legacy in crate::bridge::LEGACY_EXTENSION_DIRS {
        let stale = target.join(legacy);
        if stale.is_dir() {
            match std::fs::remove_dir_all(&stale) {
                Ok(()) => tracing::info!("pruned stale extensions dir {}", stale.display()),
                Err(e) => {
                    tracing::warn!(
                        "pruning stale extensions dir {} failed: {e}",
                        stale.display()
                    )
                }
            }
        }
    }
    if dst.exists() {
        std::fs::remove_dir_all(&dst)?;
    }
    copy_dir(src, &dst)
}

/// The tracked cetus-extensions source, located relative to this crate at compile
/// time. Only resolves on the machine that built the binary (the path is baked
/// in by `env!`), and returns `None` once that directory is gone — so a shipped
/// release, whose resources live elsewhere, never touches it.
fn dev_ext_src() -> Option<PathBuf> {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join(crate::bridge::CETUS_EXTENSIONS_DIR);
    p.is_dir().then_some(p)
}

/// Propagate the bundled pi-ai content guard into an already-installed tree.
///
/// `resolve_pi_install` copies the full `node_modules` only on first install and
/// thereafter re-syncs just `cetus-extensions`, so a guard added/upgraded in a
/// later build never reaches an existing writable tree. That left the live tree
/// crashing on null/empty `content` (a half-streamed turn) on every send — the
/// classic bricked conversation. Copy the one bundled file over whenever the
/// installed copy is missing or differs from it. Path-stable (no version in the
/// path), cheap, and idempotent. Only acts when the bundle itself is patched.
fn sync_pi_ai_guard(resource: &Path, target: &Path) -> std::io::Result<()> {
    const REL: &str = "node_modules/@earendil-works/pi-ai/dist/providers/transform-messages.js";
    let src = resource.join(REL);
    let dst = target.join(REL);
    if !src.exists() || !dst.exists() {
        return Ok(());
    }
    let src_txt = std::fs::read_to_string(&src)?;
    if !src_txt.contains("cetus-guard") {
        return Ok(()); // bundle unpatched (older build) — nothing to propagate
    }
    let dst_txt = std::fs::read_to_string(&dst).unwrap_or_default();
    if dst_txt != src_txt {
        std::fs::copy(&src, &dst)?;
        tracing::info!("synced pi-ai content guard into install tree");
    }
    Ok(())
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_symlink() {
            let link_target = std::fs::read_link(&from)?;
            #[cfg(unix)]
            {
                let _ = std::fs::remove_file(&to);
                std::os::unix::fs::symlink(&link_target, &to)?;
            }
            #[cfg(not(unix))]
            {
                // Best-effort: dereference and copy on platforms without symlinks.
                let resolved = std::fs::canonicalize(&from)?;
                if resolved.is_dir() {
                    copy_dir(&resolved, &to)?;
                } else {
                    std::fs::copy(&resolved, &to)?;
                }
            }
        } else if ty.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
            // Preserve executable bit for the pi binary and any tooling.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(&from)?.permissions().mode();
                let mut perms = std::fs::metadata(&to)?.permissions();
                perms.set_mode(mode);
                std::fs::set_permissions(&to, perms)?;
            }
        }
    }
    Ok(())
}
