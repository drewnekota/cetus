//! Background scheduler that fires due automations.
//!
//! Runs as a single long-lived task on the Tauri async runtime. Every tick it
//! asks the store for automations whose `next_run_at` has arrived, fires each
//! one (mint a conversation, spawn pi, send the prompt), records the outcome,
//! and advances the schedule.
//!
//! It deliberately takes a `SchedulerCtx` — a cheap clone of the slice of
//! `AppState` it needs — rather than borrowing the Tauri-managed `AppState`.
//! That keeps the task `'static + Send` and lets it own its dependencies across
//! `.await` points (the pi pool is the same `Arc<Mutex<…>>` AppState holds, so
//! a conversation fired here is reused when the user later opens its card).

use crate::app_event::AppEvent;
use crate::automation::Automation;
use crate::pi_rpc::PiRpc;
use crate::secrets;
use crate::store::{now_ms, Conversation, Store};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use uuid::Uuid;

/// How often the scheduler checks for due automations. Minute-granularity
/// schedules tolerate a sub-minute slip, so a 20s cadence is plenty.
const TICK: Duration = Duration::from_secs(20);

type PiPool = Arc<Mutex<HashMap<String, Arc<PiRpc>>>>;
/// Set of automation ids with a fire currently in flight. A plain std mutex
/// (held only for set ops, never across an await) so the RAII guard can release
/// it from `Drop`, including on panic.
pub type InFlight = Arc<std::sync::Mutex<HashSet<String>>>;

/// The slice of `AppState` the scheduler needs. Cloneable (everything is an
/// `Arc`, `PathBuf`, or `AppHandle`) so it can run as a standalone task.
#[derive(Clone)]
pub struct SchedulerCtx {
    pub store: Arc<Store>,
    pub pool: PiPool,
    /// Dedup guard shared with `AppState` so a manual run-now and the scheduler
    /// tick (or overlapping ticks during a slow fire) can't double-fire one id.
    pub inflight: InFlight,
    pub handle: AppHandle,
    pub pi_bin: PathBuf,
    pub sessions_dir: PathBuf,
    pub default_workspace: PathBuf,
}

/// RAII claim on an automation id. Dropping it — normally or on panic —
/// releases the claim so the automation can fire again.
struct InFlightGuard {
    set: InFlight,
    id: String,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.set
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.id);
    }
}

/// Claim `id` if no fire is already in flight for it. `None` means "skip —
/// already running".
fn claim(set: &InFlight, id: &str) -> Option<InFlightGuard> {
    let mut g = set.lock().unwrap_or_else(|e| e.into_inner());
    if g.contains(id) {
        return None;
    }
    g.insert(id.to_string());
    Some(InFlightGuard {
        set: set.clone(),
        id: id.to_string(),
    })
}

/// Entry point: self-heal next-run times once, then tick forever.
pub async fn run_scheduler(ctx: SchedulerCtx) {
    ensure_next_runs(&ctx);
    loop {
        tokio::time::sleep(TICK).await;
        tick(&ctx).await;
    }
}

/// On startup, compute `next_run_at` for any enabled automation missing one.
/// Rows with a (possibly past-due) slot are left untouched so the next tick
/// fires them exactly once as catch-up rather than replaying a backlog.
fn ensure_next_runs(ctx: &SchedulerCtx) {
    let autos = match ctx.store.list_automations() {
        Ok(a) => a,
        Err(e) => {
            tracing::warn!("scheduler: list_automations failed: {e}");
            return;
        }
    };
    let now = now_ms();
    for a in autos {
        if !a.enabled || a.next_run_at.is_some() {
            continue;
        }
        let next = a.schedule.initial_next_run(now);
        if let Err(e) = ctx.store.set_automation_next_run(&a.id, next, now) {
            tracing::warn!("scheduler: set_next_run for {} failed: {e}", a.id);
            continue;
        }
        if let Ok(Some(updated)) = ctx.store.get_automation(&a.id) {
            emit(
                ctx,
                AppEvent::AutomationUpdated {
                    automation: updated,
                },
            );
        }
    }
}

async fn tick(ctx: &SchedulerCtx) {
    let now = now_ms();
    let due = match ctx.store.list_due_automations(now) {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!("scheduler: list_due failed: {e}");
            return;
        }
    };
    for auto in due {
        // Skip if a fire is already in flight (a previous tick is still running
        // it, or a manual run-now claimed it) — the row stays due until
        // mark_automation_ran advances next_run.
        let Some(guard) = claim(&ctx.inflight, &auto.id) else {
            continue;
        };
        // Each automation fires on its own task so one slow or wedged pi can't
        // stall the others or the tick loop; a panic is contained to the task.
        let ctx = ctx.clone();
        tauri::async_runtime::spawn(async move {
            let _ = run_and_record(&ctx, &auto, false, guard).await;
        });
    }
}

/// Fire `auto`, persist the outcome, and emit the matching event. Returns the
/// minted conversation on success so the run-now command can hand it straight
/// back to the caller (which navigates into it immediately).
///
/// When `manual` (run-now), the schedule is NOT advanced — a manual trigger
/// shouldn't shift the recurring slot or disable a one-shot.
async fn run_and_record(
    ctx: &SchedulerCtx,
    auto: &Automation,
    manual: bool,
    guard: InFlightGuard,
) -> Result<Conversation, String> {
    // At-most-once: advance the schedule BEFORE firing. The in-flight `claim`
    // guard is in-memory and dies with the process, so if we crash mid-fire the
    // row must already point at its next slot — otherwise it's still due and
    // re-fires on every restart. Computing `next_after(now)` (rather than
    // replaying a backlog of slots missed while asleep) also collapses a long
    // suspend into a single catch-up fire. A manual run-now never shifts the
    // schedule, so it skips this.
    if !manual {
        let now = now_ms();
        let (next_run, enabled) = if auto.schedule.is_recurring() {
            (auto.schedule.next_after(now), true)
        } else {
            // One-shot: spent → disable and clear the slot up front.
            (None, false)
        };
        if let Err(e) = ctx
            .store
            .set_automation_enabled(&auto.id, enabled, next_run, now)
        {
            tracing::warn!(
                "scheduler: pre-fire schedule advance for {} failed: {e}",
                auto.id
            );
        }
    }

    let created = create_conversation(ctx, auto).await;
    let ran_at = now_ms();
    match created {
        Ok((conv, pi)) => {
            let _ =
                ctx.store
                    .record_automation_outcome(&auto.id, ran_at, Some(&conv.id), "ok", None);
            if let Ok(Some(updated)) = ctx.store.get_automation(&auto.id) {
                emit(
                    ctx,
                    AppEvent::AutomationFired {
                        automation: updated,
                        conversation: conv.clone(),
                    },
                );
            }
            // Dispatch the prompt off the critical path. The row and its pi
            // already exist, so run-now returns *now* and the UI jumps straight
            // in — the perceived latency matches opening a fresh chat instead of
            // also waiting on `apply_choice` + `send_prompt`. The in-flight
            // `guard` rides into the task so the claim isn't released until the
            // prompt is actually sent; a dispatch failure downgrades the recorded
            // outcome to "error" and refreshes the card.
            let ctx = ctx.clone();
            let auto_id = auto.id.clone();
            let conv_id = conv.id.clone();
            let model = conv.model;
            let prompt = auto.prompt.clone();
            tauri::async_runtime::spawn(async move {
                let _guard = guard;
                let sent = async {
                    crate::model_bridge::apply_choice(&pi, model)
                        .await
                        .map_err(|e| e.to_string())?;
                    pi.send_prompt(&prompt, Vec::new())
                        .await
                        .map_err(|e| e.to_string())?;
                    Ok::<(), String>(())
                }
                .await;
                match sent {
                    Ok(()) => {
                        ctx.store.touch(&conv_id, now_ms()).ok();
                    }
                    Err(e) => {
                        tracing::warn!("automation {auto_id} prompt dispatch failed: {e}");
                        let _ = ctx.store.record_automation_outcome(
                            &auto_id,
                            now_ms(),
                            Some(&conv_id),
                            "error",
                            Some(&e),
                        );
                        if let Ok(Some(updated)) = ctx.store.get_automation(&auto_id) {
                            emit(
                                &ctx,
                                AppEvent::AutomationUpdated {
                                    automation: updated,
                                },
                            );
                        }
                    }
                }
            });
            Ok(conv)
        }
        Err(e) => {
            tracing::warn!("automation {} failed to fire: {e}", auto.id);
            let _ = ctx
                .store
                .record_automation_outcome(&auto.id, ran_at, None, "error", Some(&e));
            if let Ok(Some(updated)) = ctx.store.get_automation(&auto.id) {
                emit(
                    ctx,
                    AppEvent::AutomationUpdated {
                        automation: updated,
                    },
                );
            }
            // `guard` drops here → claim released.
            Err(e)
        }
    }
}

/// Run-now entry for the command layer. Fires immediately without shifting the
/// schedule and returns the minted conversation so the UI can jump straight
/// into it.
pub async fn run_now(ctx: &SchedulerCtx, id: &str) -> Result<Conversation, String> {
    let auto = ctx
        .store
        .get_automation(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "automation not found".to_string())?;
    let Some(guard) = claim(&ctx.inflight, id) else {
        return Err("this automation is already running".to_string());
    };
    run_and_record(ctx, &auto, true, guard).await
}

/// Mint a conversation: spawn its pi, open a session, register the pi in the
/// shared pool, and insert the row. Returns the row and its pi so the caller can
/// dispatch the prompt separately (off the critical path). Mirrors
/// `commands::new_conversation`, minus auto-titling — the run is titled after the
/// automation so its board card is recognizable.
async fn create_conversation(
    ctx: &SchedulerCtx,
    auto: &Automation,
) -> Result<(Conversation, Arc<PiRpc>), String> {
    let workspace = if auto.workspace_dir.trim().is_empty() {
        ctx.default_workspace.clone()
    } else {
        PathBuf::from(&auto.workspace_dir)
    };
    std::fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;

    let id = Uuid::new_v4().to_string();
    let env = secrets::load_env();
    let mut runtime_config = crate::prompts::cetus_runtime_config(None);
    if let Some(pi_dir) = ctx.pi_bin.parent() {
        runtime_config.plugin_extensions =
            crate::plugins::bridge_plugin_extensions(pi_dir, &ctx.store);
    }
    let event_sink = Arc::new(crate::tauri_bridge::TauriEventSink::new(ctx.handle.clone()));
    let task_spawner = Arc::new(crate::tauri_bridge::TauriTaskSpawner);
    let pi = Arc::new(
        PiRpc::spawn(
            event_sink,
            task_spawner,
            &ctx.pi_bin,
            &ctx.sessions_dir,
            &workspace,
            env,
            Some(id.clone()),
            runtime_config,
        )
        .map_err(|e| e.to_string())?,
    );
    let session_file = pi.new_session().await.map_err(|e| e.to_string())?;
    let now = now_ms();
    let conv = Conversation {
        id: id.clone(),
        title: run_title(&auto.name),
        session_file,
        workspace_dir: workspace.to_string_lossy().to_string(),
        model: auto.model,
        created_at: now,
        updated_at: now,
        archived_at: None,
        source_automation_id: Some(auto.id.clone()),
        parallel_group_id: None,
        solution_index: None,
        review_state: "none".to_string(),
    };
    // Register the pi in the shared pool BEFORE the row becomes visible, so a
    // concurrent pi_for() reuses this process rather than spawning a second one
    // on the same session file. (switch_conversation reads the row first, so an
    // open can only resolve once this pool entry is already in place.)
    ctx.pool.lock().await.insert(id.clone(), pi.clone());
    if let Err(e) = ctx.store.insert(&conv) {
        ctx.pool.lock().await.remove(&id); // undo registration; pi drops → child killed
        return Err(e.to_string());
    }
    Ok((conv, pi))
}

fn run_title(name: &str) -> String {
    let n = name.trim();
    if n.is_empty() {
        "Automation".to_string()
    } else {
        n.chars().take(80).collect()
    }
}

fn emit(ctx: &SchedulerCtx, event: AppEvent) {
    let _ = ctx.handle.emit("app-event", event);
}
