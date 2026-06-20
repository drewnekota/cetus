//! Shared sub-agent machinery for Ultra Code.
//!
//! Ultra Code lets the model author a JS workflow (run in pi's Bun runtime by
//! the `ultra-runtime` extension) whose `agent()` primitive spawns real cetus
//! sub-agents. Each such call tunnels to the host (see `ultra.rs`), which runs
//! one sub-agent here via [`run_agent_node`], reusing a shared pool + registry +
//! concurrency semaphore so a wide model-authored fan-out can't exhaust the pool.
//!
//! A node is an ordinary `Conversation` + its own `pi --mode rpc` child. It
//! reports its result by calling the `emit_node_result` tool (see the cetus
//! extension of the same name); the host observes that completion by listening
//! on the same `app-event` channel `pi_rpc` emits to ([`handle_app_event`]
//! resolves the node's pending oneshot). That makes node completion structured
//! and independent of any UI window being open.

use crate::model::ModelChoice;
use crate::pi_rpc::PiRpc;
use crate::scheduler::SchedulerCtx;
use crate::secrets;
use crate::store::{now_ms, Conversation};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::{oneshot, Semaphore};
use uuid::Uuid;

/// How long we wait for a sub-agent to call `emit_node_result` before giving up.
/// Generous — sub-agents do real coding work.
const NODE_TIMEOUT_SECS: u64 = 20 * 60;

/// conversation_id -> a one-shot the caller awaits for that node's result. The
/// `app-event` listener (registered in `lib.rs`) fulfils it. A plain std mutex:
/// only held for the brief insert/remove, never across an await.
pub type NodeResultRegistry = Arc<std::sync::Mutex<HashMap<String, oneshot::Sender<Value>>>>;

pub fn new_registry() -> NodeResultRegistry {
    Arc::new(std::sync::Mutex::new(HashMap::new()))
}

/// Concurrency cap shared across all sub-agents, ≈ Claude Code's `min(16, cores-2)`.
pub fn new_semaphore() -> Arc<Semaphore> {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    let permits = cores.saturating_sub(2).clamp(2, 16);
    Arc::new(Semaphore::new(permits))
}

/// Cheap, `'static`-friendly bundle a sub-agent runs with — the scheduler slice
/// (pool, store, handle, paths) plus the node-result registry + semaphore.
#[derive(Clone)]
pub struct RunCtx {
    pub sched: SchedulerCtx,
    pub registry: NodeResultRegistry,
    pub semaphore: Arc<Semaphore>,
}

// =============================================================================
// app-event observer (called by the listener registered in lib.rs)
// =============================================================================

/// Inspect one serialized `app-event` payload and, if it is a node reporting its
/// result (or a node's pi exiting before it did), fulfil that node's pending
/// one-shot. A cheap substring pre-filter skips the streaming-token firehose.
pub fn handle_app_event(registry: &NodeResultRegistry, payload: &str) {
    if !(payload.contains("node_result") || payload.contains("pi_exited")) {
        return;
    }
    let v: Value = match serde_json::from_str(payload) {
        Ok(v) => v,
        Err(_) => return,
    };
    match v.get("type").and_then(|t| t.as_str()).unwrap_or("") {
        "pi_event" => {
            let conv = match v.get("conversationId").and_then(|c| c.as_str()) {
                Some(c) => c,
                None => return,
            };
            let inner = v.get("event");
            let inner_type = inner
                .and_then(|e| e.get("type"))
                .and_then(|t| t.as_str())
                .unwrap_or("");
            if inner_type != "tool_execution_end" {
                return;
            }
            let details = inner
                .and_then(|e| e.get("result"))
                .and_then(|r| r.get("details"));
            let is_node_result =
                details.and_then(|d| d.get("kind")).and_then(|k| k.as_str()) == Some("node_result");
            if !is_node_result {
                return;
            }
            if let Some(tx) = registry.lock().unwrap().remove(conv) {
                let _ = tx.send(details.cloned().unwrap_or(Value::Null));
            }
        }
        "pi_exited" => {
            if let Some(conv) = v.get("conversationId").and_then(|c| c.as_str()) {
                // Exited before reporting → resolve with Null so the caller
                // treats the node as failed instead of hanging to the timeout.
                if let Some(tx) = registry.lock().unwrap().remove(conv) {
                    let _ = tx.send(Value::Null);
                }
            }
        }
        _ => {}
    }
}

// =============================================================================
// Sub-agent runner (called by ultra.rs for each cetus.agent() call)
// =============================================================================

/// Run ONE ad-hoc sub-agent for the Ultra in-process runtime (`ultra.rs` calls
/// this each time the model-authored script invokes `agent()`): spawn a hidden
/// conversation, send the prompt (+ the emit_node_result instruction), await its
/// structured result, reap the pi, archive the conversation, and return the
/// `emit_node_result` details. Reuses the shared registry + semaphore so a wide
/// model-authored fan-out can't exhaust the pool. No run_nodes row — the script's
/// control flow is arbitrary JS, not a predefined plan.
pub async fn run_agent_node(
    ctx: &RunCtx,
    workspace: &Path,
    prompt: &str,
    label: &str,
    model: ModelChoice,
    subdir: Option<&str>,
    schema: Option<&Value>,
) -> Result<Value, String> {
    let _permit = ctx
        .semaphore
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| "run engine shutting down".to_string())?;

    let mut full = prompt.to_string();
    if let Some(sub) = subdir {
        std::fs::create_dir_all(workspace.join(sub)).ok();
        full.push_str(&format!(
            "\n\nIMPORTANT: write every file you create under the `./{sub}/` subfolder of the workspace."
        ));
    }
    // The sub-agent's FINAL MESSAGE is its return value to the orchestrator
    // (Claude-Code semantics), so the whole answer must live there — not in the
    // one-line `emit_node_result` summary, which is only a completion signal.
    full.push_str(
        "\n\n---\nWrite your COMPLETE answer as your final assistant message: that \
         text is returned verbatim to the orchestrator, so put everything it needs \
         there. Do NOT rely on the summary below to carry content.",
    );
    if let Some(schema) = schema {
        full.push_str(&format!(
            " Your final message MUST be a single JSON value conforming to this JSON \
             Schema, with NO prose and NO code fences around it:\n{}",
            serde_json::to_string(schema).unwrap_or_else(|_| "{}".to_string())
        ));
    }
    full.push_str(
        "\nThen call the `emit_node_result` tool with a one-line `summary` to signal \
         you are done, and end your turn.",
    );

    let id = Uuid::new_v4().to_string();
    let env = secrets::load_env();
    let pi = Arc::new(
        PiRpc::spawn(
            ctx.sched.handle.clone(),
            &ctx.sched.pi_bin,
            &ctx.sched.sessions_dir,
            workspace,
            env,
            Some(id.clone()),
            None, // sub-agents never inherit Ultra mode (recursion guard)
        )
        .map_err(|e| e.to_string())?,
    );
    let session_file = pi.new_session().await.map_err(|e| e.to_string())?;
    let now = now_ms();
    let title = if label.trim().is_empty() {
        "Ultra sub-agent".to_string()
    } else {
        format!("Ultra · {label}")
    };
    let conv = Conversation {
        id: id.clone(),
        title,
        session_file,
        workspace_dir: workspace.to_string_lossy().to_string(),
        model,
        created_at: now,
        updated_at: now,
        // Born archived: an Ultra sub-agent is an implementation detail of the
        // parent's `run_workflow`, not a chat the user started, so it must never
        // surface in the sidebar / board (both list `archived_at IS NULL`). We
        // re-stamp archived_at on completion below so the archived list orders by
        // finish time; inserting it visible and archiving only at the end would
        // flash every fan-out node into the sidebar for the run's duration.
        archived_at: Some(now),
        source_automation_id: None,
        parallel_group_id: None,
        solution_index: None,
        review_state: "none".to_string(),
    };
    ctx.sched.pool.lock().await.insert(id.clone(), pi.clone());
    if let Err(e) = ctx.sched.store.insert(&conv) {
        ctx.sched.pool.lock().await.remove(&id);
        return Err(format!("insert conv: {e}"));
    }
    let _ = pi.apply_choice(model).await;

    let (tx, rx) = oneshot::channel::<Value>();
    ctx.registry.lock().unwrap().insert(id.clone(), tx);

    if let Err(e) = pi.send_prompt(&full, Vec::new()).await {
        ctx.registry.lock().unwrap().remove(&id);
        ctx.sched.pool.lock().await.remove(&id);
        return Err(format!("send_prompt: {e}"));
    }
    ctx.sched.store.touch(&id, now_ms()).ok();

    let timeout = std::time::Duration::from_secs(NODE_TIMEOUT_SECS);
    let result = tokio::time::timeout(timeout, rx).await;
    ctx.registry.lock().unwrap().remove(&id);

    // Abort the worker's turn before reaping. On a clean completion the turn has
    // already ended, so this is a no-op; on a timeout it stops a model that's
    // still mid-turn from burning tokens until the Arc's Drop eventually kills the
    // child. Cheap insurance against a stalled-but-not-dead pi running on.
    let _ = pi.abort().await;

    // Reap the worker pi. The conversation was born archived (hidden); re-stamp
    // archived_at to now so the archived list orders sub-agents by finish time.
    ctx.sched.pool.lock().await.remove(&id);
    ctx.sched.store.set_archived(&id, true, now_ms()).ok();

    let mut details = match result {
        Ok(Ok(details)) if details.get("kind").and_then(|k| k.as_str()) == Some("node_result") => {
            details
        }
        Ok(_) => return Err("sub-agent exited before reporting a result".to_string()),
        Err(_) => return Err("sub-agent timed out".to_string()),
    };

    // Attach the sub-agent's final message text — the orchestrator's default
    // return value. The model writes its real answer here; `emit_node_result`'s
    // summary is only a one-line status, so without this the answer is lost.
    // The read parses the whole session jsonl (which grows with turn count), so
    // run it on a blocking thread rather than stalling the async runtime.
    let session_file = conv.session_file.clone();
    let final_text = tokio::task::spawn_blocking(move || read_final_assistant_text(&session_file))
        .await
        .ok()
        .flatten();
    if let Some(text) = final_text {
        if let Some(obj) = details.as_object_mut() {
            obj.insert("text".to_string(), Value::String(text));
        }
    }
    Ok(details)
}

/// Read the sub-agent's final assistant message text from its session jsonl.
/// Returns the concatenated `text` blocks of the last assistant message that has
/// any (the answer it ended its turn on), or None if the file is unreadable or
/// the agent produced no prose. Best-effort: a malformed line is skipped.
fn read_final_assistant_text(session_file: &str) -> Option<String> {
    let content = std::fs::read_to_string(session_file).ok()?;
    let mut last: Option<String> = None;
    for line in content.lines() {
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("message") {
            continue;
        }
        let msg = match v.get("message") {
            Some(m) => m,
            None => continue,
        };
        if msg.get("role").and_then(|r| r.as_str()) != Some("assistant") {
            continue;
        }
        let blocks = match msg.get("content").and_then(|c| c.as_array()) {
            Some(b) => b,
            None => continue,
        };
        let mut buf = String::new();
        for b in blocks {
            if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                    if !buf.is_empty() {
                        buf.push('\n');
                    }
                    buf.push_str(t);
                }
            }
        }
        let trimmed = buf.trim();
        if !trimmed.is_empty() {
            last = Some(trimmed.to_string());
        }
    }
    last
}
