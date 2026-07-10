//! Shared automation CRUD used by both the frontend Tauri commands
//! (`commands.rs`) and the external control socket (`control.rs`).
//!
//! All schedule validation and `next_run_at` derivation happens here, so every
//! entry point — UI, agent tool, control socket — goes through the same rules.
//! Mutations emit `automation_updated` / `automation_deleted` app-events; the
//! frontend merge is an upsert-by-id, so the invoke return value and the event
//! landing on the same change is harmless, while a socket-driven change (which
//! the frontend never invoked) still refreshes the UI.

use crate::app_event::AppEvent;
use crate::automation::{Automation, AutomationInput};
use crate::store::now_ms;
use crate::AppState;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

fn emit(handle: &AppHandle, event: AppEvent) {
    let _ = handle.emit("app-event", event);
}

pub fn list(state: &AppState) -> Result<Vec<Automation>, String> {
    state.store.list_automations().map_err(|e| e.to_string())
}

pub fn get(state: &AppState, id: &str) -> Result<Automation, String> {
    state
        .store
        .get_automation(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "automation not found".to_string())
}

pub fn create(handle: &AppHandle, input: AutomationInput) -> Result<Automation, String> {
    input.schedule.validate()?;
    let state = handle.state::<AppState>();
    let now = now_ms();
    let workspace = input
        .workspace_dir
        .filter(|w| !w.trim().is_empty())
        .unwrap_or_else(|| state.default_workspace.to_string_lossy().to_string());
    let next_run = if input.enabled {
        input.schedule.initial_next_run(now)
    } else {
        None
    };
    let automation = Automation {
        id: Uuid::new_v4().to_string(),
        name: input.name.trim().to_string(),
        prompt: input.prompt,
        workspace_dir: workspace,
        model: input.model,
        schedule: input.schedule,
        enabled: input.enabled,
        created_at: now,
        updated_at: now,
        next_run_at: next_run,
        last_run_at: None,
        last_conversation_id: None,
        last_status: None,
        last_error: None,
        run_count: 0,
        backend: input.backend,
        cli_model: input.cli_model,
        cli_effort: input.cli_effort,
    };
    state
        .store
        .insert_automation(&automation)
        .map_err(|e| e.to_string())?;
    emit(
        handle,
        AppEvent::AutomationUpdated {
            automation: automation.clone(),
        },
    );
    Ok(automation)
}

pub fn update(handle: &AppHandle, id: &str, input: AutomationInput) -> Result<Automation, String> {
    input.schedule.validate()?;
    let state = handle.state::<AppState>();
    let existing = get(&state, id)?;
    let now = now_ms();
    let workspace = input
        .workspace_dir
        .filter(|w| !w.trim().is_empty())
        .unwrap_or_else(|| state.default_workspace.to_string_lossy().to_string());
    // Recompute the next fire from the (possibly new) schedule; carry forward
    // all run-state (last run, count, …).
    let next_run = if input.enabled {
        input.schedule.initial_next_run(now)
    } else {
        None
    };
    let updated = Automation {
        id: existing.id,
        name: input.name.trim().to_string(),
        prompt: input.prompt,
        workspace_dir: workspace,
        model: input.model,
        schedule: input.schedule,
        enabled: input.enabled,
        created_at: existing.created_at,
        updated_at: now,
        next_run_at: next_run,
        last_run_at: existing.last_run_at,
        last_conversation_id: existing.last_conversation_id,
        last_status: existing.last_status,
        last_error: existing.last_error,
        run_count: existing.run_count,
        backend: input.backend,
        cli_model: input.cli_model,
        cli_effort: input.cli_effort,
    };
    state
        .store
        .update_automation(&updated)
        .map_err(|e| e.to_string())?;
    emit(
        handle,
        AppEvent::AutomationUpdated {
            automation: updated.clone(),
        },
    );
    Ok(updated)
}

pub fn delete(handle: &AppHandle, id: &str) -> Result<(), String> {
    let state = handle.state::<AppState>();
    // Surface "not found" instead of a silent no-op delete, so a CLI caller
    // with a stale id gets a real error.
    get(&state, id)?;
    state
        .store
        .delete_automation(id)
        .map_err(|e| e.to_string())?;
    emit(handle, AppEvent::AutomationDeleted { id: id.to_string() });
    Ok(())
}

pub fn set_enabled(handle: &AppHandle, id: &str, enabled: bool) -> Result<Automation, String> {
    let state = handle.state::<AppState>();
    let existing = get(&state, id)?;
    let now = now_ms();
    let next_run = if enabled {
        // Keep a still-future slot; otherwise compute a fresh one from now.
        existing
            .next_run_at
            .filter(|&t| t > now)
            .or_else(|| existing.schedule.initial_next_run(now))
    } else {
        None
    };
    state
        .store
        .set_automation_enabled(id, enabled, next_run, now)
        .map_err(|e| e.to_string())?;
    let updated = get(&state, id)?;
    emit(
        handle,
        AppEvent::AutomationUpdated {
            automation: updated.clone(),
        },
    );
    Ok(updated)
}
