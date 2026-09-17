use super::{
    audio_dir, load_settings, remove_audio_dir, save_settings, start_internal, stop_internal,
    AppHandle, AppState, Manager, Meeting, MeetingRuntime, MeetingSegment, MeetingSettings,
    MeetingStatus, Ordering, State,
};

// =============================================================================
// Tauri commands
// =============================================================================

#[tauri::command]
pub async fn get_meeting_settings(state: State<'_, AppState>) -> Result<MeetingSettings, String> {
    Ok(load_settings(&state.store))
}

#[tauri::command]
pub async fn set_meeting_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: MeetingSettings,
) -> Result<(), String> {
    save_settings(&state.store, &settings).map_err(|e| e.to_string())?;
    // Re-register both global shortcuts (summon + meeting toggle).
    let summon = crate::quick::load_settings(&state.store).summon_hotkey;
    crate::apply_summon_hotkey(&app, &summon);
    Ok(())
}

#[tauri::command]
pub async fn meeting_status(runtime: State<'_, MeetingRuntime>) -> Result<MeetingStatus, String> {
    let slot = runtime.active.lock().await;
    Ok(match slot.as_ref() {
        Some(s) => MeetingStatus {
            recording: true,
            started_ts: Some(s.started_ts),
            auto: s.auto,
            app_hint: s.app_hint.clone(),
            segments: s.segments.load(Ordering::Relaxed),
            engine: s.engine.clone(),
            meeting_id: Some(s.id.clone()),
        },
        None => MeetingStatus {
            recording: false,
            started_ts: None,
            auto: false,
            app_hint: None,
            segments: 0,
            engine: "idle".into(),
            meeting_id: None,
        },
    })
}

#[tauri::command]
pub async fn meeting_start(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let store = state.store.clone();
    let app_data = state.app_data_dir.clone();
    start_internal(&app, &store, &app_data, false, None).await
}

#[tauri::command]
pub async fn meeting_stop(app: AppHandle) -> Result<bool, String> {
    stop_internal(&app, true).await
}

#[tauri::command]
pub async fn list_meetings(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<Meeting>, String> {
    state
        .store
        .list_meetings(limit.unwrap_or(50).min(200))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_meeting(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.store.delete_meeting(&id).map_err(|e| e.to_string())?;
    remove_audio_dir(&state.app_data_dir, &id);
    Ok(())
}

/// The meeting's saved-audio directory, or None when nothing was kept (audio
/// saving off, or the session predates the feature).
#[tauri::command]
pub async fn meeting_audio_dir(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<String>, String> {
    // Ids are our own UUIDs; refuse anything path-like from a hostile webview.
    if id.contains(['/', '\\', '.']) {
        return Err("invalid meeting id".into());
    }
    let dir = audio_dir(&state.app_data_dir, &id);
    Ok(dir.is_dir().then(|| dir.to_string_lossy().into_owned()))
}

/// Pill geometry: collapsed is the bare capsule; expanded adds the live-caption
/// card below it (Granola-style hover reveal). Sized here, not in the webview —
/// the panel is non-resizable for the user, and resize + reanchor must be one
/// main-thread mutation to avoid a visible two-step jump.
pub(super) const HUD_COLLAPSED: (f64, f64) = (220.0, 52.0);
// Expanded size leaves 20px side / 16px bottom transparent margins around the
// 400px-wide caption card so its CSS drop shadow fades out inside the window
// instead of being hard-clipped at the window edge (a visible gray rectangle).
const HUD_EXPANDED: (f64, f64) = (440.0, 336.0);

/// Grow/shrink the meeting pill window in place, keeping its top-center anchor
/// (the capsule must not move under the cursor mid-hover).
#[tauri::command]
pub async fn meeting_hud_set_expanded(app: AppHandle, expanded: bool) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, expanded);
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let (w, h) = if expanded {
            HUD_EXPANDED
        } else {
            HUD_COLLAPSED
        };
        app.clone()
            .run_on_main_thread(move || {
                if let Some(win) = app.get_webview_window("meeting") {
                    if let Ok(ptr) = win.ns_window() {
                        crate::panel::resize_keep_top_center(ptr, w, h);
                    }
                }
            })
            .map_err(|e| e.to_string())
    }
}

/// Whether the cursor is currently over the meeting pill window (with a small
/// grace margin). The expanded HUD polls this instead of doing its own
/// cursor-vs-frame math: Tauri's JS `cursorPosition()` and the window geometry
/// live in different coordinate spaces on scaled/secondary displays, which made
/// the frontend's containment test read "outside" while hovering and fold the
/// card moments after it opened.
#[tauri::command]
pub async fn meeting_hud_cursor_inside(app: AppHandle) -> Result<bool, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(false)
    }
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.clone()
            .run_on_main_thread(move || {
                let inside = app
                    .get_webview_window("meeting")
                    .and_then(|win| win.ns_window().ok())
                    .map(|ptr| crate::panel::cursor_inside_window(ptr, 16.0))
                    .unwrap_or(false);
                let _ = tx.send(inside);
            })
            .map_err(|e| e.to_string())?;
        rx.await.map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn meeting_transcript(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<MeetingSegment>, String> {
    state.store.meeting_segments(&id).map_err(|e| e.to_string())
}
