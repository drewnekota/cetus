use super::{
    err, now_ms, secrets, AppHandle, AppState, Automation, AutomationInput, CmdResult,
    Conversation, ModelChoice, Serialize, State, Value,
};

#[tauri::command]
pub async fn set_workspace(
    state: State<'_, AppState>,
    id: String,
    workspace_dir: String,
) -> CmdResult<Conversation> {
    if cetus_bridge::remote::parse_remote_workspace(&workspace_dir).is_none() {
        std::fs::create_dir_all(&workspace_dir).map_err(err)?;
    }
    state
        .store
        .set_workspace(&id, &workspace_dir, now_ms())
        .map_err(err)?;
    let conv = state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".to_string())?;
    // The pi process pinned to this conv was spawned with the *old* cwd.
    // Drop it; next interaction lazy-spawns with the new cwd.
    state.kill_pi(&id).await;
    state.kill_claude_session(&id);
    state.kill_codex_session(&id);
    state.kill_acp_session(&id);
    Ok(conv)
}

#[tauri::command]
pub async fn set_model_choice(
    state: State<'_, AppState>,
    id: String,
    choice: ModelChoice,
) -> CmdResult<Conversation> {
    state.store.set_model(&id, &choice, now_ms()).map_err(err)?;
    // If pi is already running for this conv, push the new choice through
    // immediately. If it's cold, the next pi_for() will pick it up from the
    // freshly persisted row.
    if let Some(pi) = state.pi_existing(&id).await {
        crate::model_bridge::apply_choice(&pi, &state.store, &choice)
            .await
            .map_err(err)?;
    }
    state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".to_string())
}

#[tauri::command]
pub async fn get_model_choice(state: State<'_, AppState>, id: String) -> CmdResult<ModelChoice> {
    let conv = state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".to_string())?;
    Ok(conv.model)
}

#[tauri::command]
pub async fn extension_ui_respond(
    state: State<'_, AppState>,
    conversation_id: String,
    id: String,
    payload: Value,
) -> CmdResult<()> {
    let mut obj = match payload {
        Value::Object(m) => m,
        _ => return Err("payload must be a JSON object".into()),
    };
    obj.insert(
        "type".to_string(),
        Value::String("extension_ui_response".to_string()),
    );
    obj.insert("id".to_string(), Value::String(id));
    let pi = state
        .pi_existing(&conversation_id)
        .await
        .ok_or_else(|| format!("no pi running for conversation {conversation_id}"))?;
    pi.notify(Value::Object(obj)).await.map_err(err)
}

#[tauri::command]
pub async fn list_api_keys() -> CmdResult<Vec<String>> {
    Ok(secrets::KNOWN_PROVIDERS
        .iter()
        .filter(|(prov, _)| secrets::has(prov))
        .map(|(prov, _)| (*prov).to_string())
        .collect())
}

#[tauri::command]
pub async fn list_api_keys_masked() -> CmdResult<std::collections::HashMap<String, String>> {
    let mut out = std::collections::HashMap::new();
    for (prov, _) in secrets::KNOWN_PROVIDERS {
        if let Ok(Some(raw)) = secrets::get(prov) {
            out.insert((*prov).to_string(), secrets::mask(&raw));
        }
    }
    Ok(out)
}

/// Return the full, unmasked key for a provider so the user can copy it back
/// out. These are the user's own keys on their own machine; the masked preview
/// (list_api_keys_masked) is still the default the UI shows.
#[tauri::command]
pub async fn reveal_api_key(provider: String) -> CmdResult<Option<String>> {
    secrets::get(&provider).map_err(err)
}

#[tauri::command]
pub async fn set_api_key(
    state: State<'_, AppState>,
    provider: String,
    key: String,
) -> CmdResult<()> {
    if !secrets::KNOWN_PROVIDERS.iter().any(|(p, _)| *p == provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    if key.is_empty() {
        secrets::delete(&provider).map_err(err)?;
    } else {
        secrets::set(&provider, &key).map_err(err)?;
    }
    // Kill every pi so the next interaction respawns with the new env.
    state.kill_all().await;
    state.kill_all_cli_sessions();
    Ok(())
}

#[tauri::command]
pub async fn delete_api_key(state: State<'_, AppState>, provider: String) -> CmdResult<()> {
    secrets::delete(&provider).map_err(err)?;
    state.kill_all().await;
    state.kill_all_cli_sessions();
    Ok(())
}

#[tauri::command]
pub async fn list_automations(state: State<'_, AppState>) -> CmdResult<Vec<Automation>> {
    crate::automation_api::list(&state)
}

#[tauri::command]
pub async fn create_automation(app: AppHandle, input: AutomationInput) -> CmdResult<Automation> {
    crate::automation_api::create(&app, input)
}

#[tauri::command]
pub async fn update_automation(
    app: AppHandle,
    id: String,
    input: AutomationInput,
) -> CmdResult<Automation> {
    crate::automation_api::update(&app, &id, input)
}

#[tauri::command]
pub async fn delete_automation(app: AppHandle, id: String) -> CmdResult<()> {
    crate::automation_api::delete(&app, &id)
}

#[tauri::command]
pub async fn set_automation_enabled(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> CmdResult<Automation> {
    crate::automation_api::set_enabled(&app, &id, enabled)
}

#[tauri::command]
pub async fn run_automation_now(state: State<'_, AppState>, id: String) -> CmdResult<Conversation> {
    let ctx = state.scheduler_ctx();
    crate::scheduler::run_now(&ctx, &id).await
}

// ---- screen-context collection (Rewind-like) ------------------------------

#[tauri::command]
pub async fn get_capture_settings(
    state: State<'_, AppState>,
) -> CmdResult<crate::capture::CaptureSettings> {
    Ok(crate::capture::load_settings(&state.store))
}

#[tauri::command]
pub async fn set_capture_settings(
    state: State<'_, AppState>,
    settings: crate::capture::CaptureSettings,
) -> CmdResult<()> {
    crate::capture::save_settings(&state.store, &settings).map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStats {
    pub enabled: bool,
    pub count: i64,
}

#[tauri::command]
pub async fn capture_stats(state: State<'_, AppState>) -> CmdResult<CaptureStats> {
    let enabled = crate::capture::load_settings(&state.store).enabled;
    let count = state.store.screenshots_count().map_err(err)?;
    Ok(CaptureStats { enabled, count })
}

#[tauri::command]
pub async fn recent_screenshots(
    state: State<'_, AppState>,
    limit: Option<u32>,
    before_ts: Option<i64>,
) -> CmdResult<Vec<crate::store::Screenshot>> {
    state
        .store
        .recent_screenshots(limit.unwrap_or(50), before_ts)
        .map_err(err)
}

#[tauri::command]
pub async fn search_screenshots(
    state: State<'_, AppState>,
    query: String,
    since_ts: Option<i64>,
    limit: Option<u32>,
    before_ts: Option<i64>,
) -> CmdResult<Vec<crate::store::Screenshot>> {
    state
        .store
        .search_screenshots(
            &query,
            since_ts.unwrap_or(0),
            limit.unwrap_or(50),
            before_ts,
        )
        .map_err(err)
}

// ---- ambient text context (Littlebird-like AX collector) -------------------

#[tauri::command]
pub async fn get_ambient_settings(
    state: State<'_, AppState>,
) -> CmdResult<crate::ambient::AmbientSettings> {
    Ok(crate::ambient::load_settings(&state.store))
}

#[tauri::command]
pub async fn set_ambient_settings(
    state: State<'_, AppState>,
    settings: crate::ambient::AmbientSettings,
) -> CmdResult<()> {
    crate::ambient::save_settings(&state.store, &settings).map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AmbientStats {
    pub enabled: bool,
    pub count: i64,
}

#[tauri::command]
pub async fn ambient_stats(state: State<'_, AppState>) -> CmdResult<AmbientStats> {
    let enabled = crate::ambient::load_settings(&state.store).enabled;
    let count = state.store.ax_context_count().map_err(err)?;
    Ok(AmbientStats { enabled, count })
}

#[tauri::command]
pub async fn recent_ambient_context(
    state: State<'_, AppState>,
    limit: Option<u32>,
    before_ts: Option<i64>,
) -> CmdResult<Vec<crate::store::AxContextEntry>> {
    state
        .store
        .recent_ax_context(limit.unwrap_or(50), before_ts)
        .map_err(err)
}

#[tauri::command]
pub async fn search_ambient_context(
    state: State<'_, AppState>,
    query: String,
    since_ts: Option<i64>,
    limit: Option<u32>,
    before_ts: Option<i64>,
) -> CmdResult<Vec<crate::store::AxContextEntry>> {
    state
        .store
        .search_ax_context(
            &query,
            since_ts.unwrap_or(0),
            limit.unwrap_or(50),
            before_ts,
        )
        .map_err(err)
}

#[tauri::command]
pub async fn clear_ambient_history(state: State<'_, AppState>) -> CmdResult<()> {
    state.store.clear_ax_context().map_err(err)
}

/// The compressed recent-activity block the composer injects (inner text of the
/// `<context source="cetus-ambient">` fence). Null when the collector is off or
/// the rolling window is empty — the composer simply sends the bare prompt.
#[tauri::command]
pub async fn ambient_recent_summary(state: State<'_, AppState>) -> CmdResult<Option<String>> {
    Ok(crate::ambient::recent_summary(&state.store))
}

/// Sync the native window appearance to the app's color theme. On macOS/Linux
/// this is app-wide, so it fixes the frosted vibrancy behind the launcher's
/// HUD glass when the user locks a theme that differs from the OS. `None`
/// (the "system" preference)
/// lets the OS drive it, which also keeps each webview's `prefers-color-scheme`
/// tracking the system for live updates. Best-effort — a missing window or an
/// unsupported platform is a no-op.
#[tauri::command]
pub async fn set_theme_appearance(app: tauri::AppHandle, preference: String) -> CmdResult<()> {
    use tauri::Manager;
    let theme = match preference.as_str() {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None,
    };
    // App-wide on macOS, so one window is enough; fall back if main is gone.
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_theme(theme);
    } else if let Some(w) = app.get_webview_window("quick") {
        let _ = w.set_theme(theme);
    }
    Ok(())
}
