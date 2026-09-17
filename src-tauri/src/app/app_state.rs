use super::{
    locale, mcp, model_bridge, pi_rpc, plugins, prompts, provider, scheduler, secrets, skills,
    tauri_bridge, AppHandle, AppState, Arc, CliInput, CliSteer, CliTurnHandle, Path, PathBuf,
};

impl AppState {
    pub fn claude_session(
        &self,
        conv_id: &str,
    ) -> Option<cetus_bridge::cli_agent::ClaudeSessionHandle> {
        let mut sessions = self.claude_sessions.lock().unwrap();
        if sessions.get(conv_id).is_some_and(|s| !s.is_alive()) {
            sessions.remove(conv_id);
        }
        sessions.get(conv_id).cloned()
    }

    pub fn set_claude_session(
        &self,
        conv_id: String,
        session: cetus_bridge::cli_agent::ClaudeSessionHandle,
    ) {
        if let Some(old) = self
            .claude_sessions
            .lock()
            .unwrap()
            .insert(conv_id, session)
        {
            old.shutdown();
        }
    }

    pub fn kill_claude_session(&self, conv_id: &str) {
        if let Some(session) = self.claude_sessions.lock().unwrap().remove(conv_id) {
            session.shutdown();
        }
        self.cli_commands.lock().unwrap().remove(conv_id);
    }

    pub fn codex_session(
        &self,
        conv_id: &str,
    ) -> Option<cetus_bridge::cli_agent::CodexSessionHandle> {
        let mut sessions = self.codex_sessions.lock().unwrap();
        if sessions.get(conv_id).is_some_and(|s| !s.is_alive()) {
            sessions.remove(conv_id);
        }
        sessions.get(conv_id).cloned()
    }

    pub fn set_codex_session(
        &self,
        conv_id: String,
        session: cetus_bridge::cli_agent::CodexSessionHandle,
    ) {
        if let Some(old) = self.codex_sessions.lock().unwrap().insert(conv_id, session) {
            old.shutdown();
        }
    }

    pub fn kill_codex_session(&self, conv_id: &str) {
        if let Some(session) = self.codex_sessions.lock().unwrap().remove(conv_id) {
            session.shutdown();
        }
        self.cli_commands.lock().unwrap().remove(conv_id);
    }

    pub fn acp_session(&self, conv_id: &str) -> Option<cetus_bridge::cli_agent::AcpSessionHandle> {
        let mut sessions = self.acp_sessions.lock().unwrap();
        if sessions
            .get(conv_id)
            .is_some_and(|session| !session.is_alive())
        {
            sessions.remove(conv_id);
        }
        sessions.get(conv_id).cloned()
    }

    pub fn set_acp_session(
        &self,
        conv_id: String,
        session: cetus_bridge::cli_agent::AcpSessionHandle,
    ) {
        if let Some(old) = self.acp_sessions.lock().unwrap().insert(conv_id, session) {
            old.shutdown();
        }
    }

    pub fn kill_acp_session(&self, conv_id: &str) {
        if let Some(session) = self.acp_sessions.lock().unwrap().remove(conv_id) {
            session.shutdown();
        }
        self.cli_commands.lock().unwrap().remove(conv_id);
    }

    pub fn kill_all_cli_sessions(&self) {
        for (_, session) in self.claude_sessions.lock().unwrap().drain() {
            session.shutdown();
        }
        for (_, session) in self.codex_sessions.lock().unwrap().drain() {
            session.shutdown();
        }
        for (_, session) in self.acp_sessions.lock().unwrap().drain() {
            session.shutdown();
        }
        self.cli_commands.lock().unwrap().clear();
    }

    pub fn cache_cli_commands(&self, conv_id: &str, commands: Vec<serde_json::Value>) {
        self.cli_commands
            .lock()
            .unwrap()
            .insert(conv_id.to_string(), commands);
    }

    pub fn cache_cli_command_catalog(&self, key: &str, commands: Vec<serde_json::Value>) {
        self.cli_command_catalogs
            .lock()
            .unwrap()
            .insert(key.to_string(), commands);
    }

    pub fn cli_command_catalog(&self, key: &str) -> Option<Vec<serde_json::Value>> {
        self.cli_command_catalogs.lock().unwrap().get(key).cloned()
    }

    pub fn cli_commands(&self, conv_id: &str) -> Vec<serde_json::Value> {
        self.cli_commands
            .lock()
            .unwrap()
            .get(conv_id)
            .cloned()
            .unwrap_or_default()
    }

    /// Register a CLI-backend turn for `conv_id`, returning its kill switch,
    /// the stdin-lines receiver, and the pending-steer counter for the runner.
    /// Errors when a turn is already running — one turn per conversation.
    #[allow(clippy::type_complexity)]
    pub fn begin_cli_turn(
        &self,
        conv_id: &str,
    ) -> Result<
        (
            Arc<tokio::sync::Notify>,
            tokio::sync::mpsc::UnboundedReceiver<CliInput>,
            Arc<std::sync::atomic::AtomicUsize>,
            Arc<std::sync::atomic::AtomicBool>,
        ),
        String,
    > {
        let mut turns = self.cli_turns.lock().unwrap();
        if turns.contains_key(conv_id) {
            return Err("agent is already running for this conversation".to_string());
        }
        let notify = Arc::new(tokio::sync::Notify::new());
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let steer_pending = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let closing = Arc::new(std::sync::atomic::AtomicBool::new(false));
        turns.insert(
            conv_id.to_string(),
            CliTurnHandle {
                kill: notify.clone(),
                input: tx,
                steer_pending: steer_pending.clone(),
                done: Arc::new(tokio::sync::Notify::new()),
                closing: closing.clone(),
            },
        );
        Ok((notify, rx, steer_pending, closing))
    }

    /// Clear a finished CLI turn's registration and wake anyone waiting on
    /// its settlement (`cli_interrupt_turn`).
    pub fn end_cli_turn(&self, conv_id: &str) {
        if let Some(h) = self.cli_turns.lock().unwrap().remove(conv_id) {
            h.done.notify_one();
        }
    }

    /// Whether a CLI turn is currently registered for this conversation
    /// (running or still settling). Gates runtime switching: rebinding the
    /// backend mid-turn would route the next steer/prompt into the wrong
    /// CLI's stdin.
    pub fn cli_turn_active(&self, conv_id: &str) -> bool {
        self.cli_turns.lock().unwrap().contains_key(conv_id)
    }

    /// Count a turn dispatch for this conversation and return the new
    /// generation. A scheduled auto-retry snapshots this and gives way when
    /// the generation moved on before it fired (something else dispatched).
    pub fn bump_cli_dispatch(&self, conv_id: &str) -> u64 {
        let mut map = self.cli_auto_retry.lock().unwrap();
        let entry = map.entry(conv_id.to_string()).or_default();
        entry.generation += 1;
        entry.generation
    }

    /// Current dispatch generation (see `bump_cli_dispatch`).
    pub fn cli_dispatch_generation(&self, conv_id: &str) -> u64 {
        self.cli_auto_retry
            .lock()
            .unwrap()
            .get(conv_id)
            .map(|entry| entry.generation)
            .unwrap_or(0)
    }

    /// Record one more auto-retry attempt; returns the 1-based attempt number,
    /// or None once `max` consecutive attempts have been spent.
    pub fn next_cli_auto_retry(&self, conv_id: &str, max: u32) -> Option<u32> {
        let mut map = self.cli_auto_retry.lock().unwrap();
        let entry = map.entry(conv_id.to_string()).or_default();
        if entry.attempts >= max {
            return None;
        }
        entry.attempts += 1;
        Some(entry.attempts)
    }

    /// Reset the consecutive auto-retry counter (a turn settled without a
    /// transient error, so the next failure starts a fresh retry budget).
    pub fn reset_cli_auto_retry(&self, conv_id: &str) {
        if let Some(entry) = self.cli_auto_retry.lock().unwrap().get_mut(conv_id) {
            entry.attempts = 0;
        }
    }

    /// Return the settlement signal only when a registered turn has already
    /// emitted `agent_end`. Native steer is no longer valid in this narrow
    /// phase; callers should wait and dispatch a normal next turn instead.
    pub fn cli_turn_done_if_closing(&self, conv_id: &str) -> Option<Arc<tokio::sync::Notify>> {
        let turns = self.cli_turns.lock().unwrap();
        let handle = turns.get(conv_id)?;
        handle
            .closing
            .load(std::sync::atomic::Ordering::SeqCst)
            .then(|| handle.done.clone())
    }

    /// Fire the kill switch of a running CLI turn. No-op when idle.
    pub fn abort_cli_turn(&self, conv_id: &str) {
        if let Some(h) = self.cli_turns.lock().unwrap().get(conv_id) {
            h.kill.notify_one();
        }
    }

    /// Kill a running CLI turn and hand back its settlement signal (fired by
    /// `end_cli_turn` after the outcome persisted). None when no turn is
    /// running — the caller should dispatch normally instead.
    pub fn cli_interrupt_turn(&self, conv_id: &str) -> Option<Arc<tokio::sync::Notify>> {
        let turns = self.cli_turns.lock().unwrap();
        let h = turns.get(conv_id)?;
        h.kill.notify_one();
        Some(h.done.clone())
    }

    /// Try to inject a steer user message into a running CLI turn's stdin.
    ///  - `Idle`: no turn is running — dispatch a fresh turn.
    ///  - `Closing`: the turn already emitted `agent_end` (its stdin is dead) —
    ///    the caller should wait on the returned settlement signal, then
    ///    redispatch the prompt as a fresh resuming turn. This catches the
    ///    follow-up queue's flush, which fires on exactly that `agent_end` while
    ///    the turn is still registered (unregistration trails persistence).
    ///  - `Steered`: injected into a live turn.
    pub fn cli_steer(&self, conv_id: &str, line: String, message: serde_json::Value) -> CliSteer {
        let turns = self.cli_turns.lock().unwrap();
        let Some(h) = turns.get(conv_id) else {
            return CliSteer::Idle;
        };
        if h.closing.load(std::sync::atomic::Ordering::SeqCst) {
            return CliSteer::Closing(h.done.clone());
        }
        // Count first: the runner must never see the message on stdin while
        // the counter still reads zero (it would close the turn on `result`
        // with the steer unread).
        h.steer_pending
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if h.input.send(CliInput::Steer { line, message }).is_ok() {
            CliSteer::Steered
        } else {
            // Receiver gone (child exited between the closing check and the
            // send) — treat as closing so the prompt still lands.
            CliSteer::Closing(h.done.clone())
        }
    }

    /// Write one line into a running CLI turn's stdin (a control_response
    /// answering a permission prompt or AskUserQuestion).
    pub fn cli_send_input(&self, conv_id: &str, line: String) -> Result<(), String> {
        let turns = self.cli_turns.lock().unwrap();
        let Some(h) = turns.get(conv_id) else {
            return Err("no running agent turn for this conversation".to_string());
        };
        h.input
            .send(CliInput::Line(line))
            .map_err(|_| "the agent turn already ended".to_string())
    }

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
        let mut extra = String::new();
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
        model_bridge::apply_choice(&pi, &self.store, &conv.model).await?;

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
