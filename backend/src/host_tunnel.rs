//! Shared plumbing for the host-side tool tunnels (skills, automations, and the
//! browser/computer agent-control surface). Each pi extension tunnels a blocking
//! `ctx.ui.input` request to the Rust side over [`crate::pi_rpc`]; the handler
//! answers via the parent pi's `extension_ui_response`. The reply round-trip and
//! a small param accessor are byte-identical across all three handlers, so they
//! live here once instead of being copied per tunnel.

use crate::pi_rpc::PiRpc;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

/// The shared pi pool (same `Arc` as `AppState.pis`), keyed by conversation id.
pub type PiPool = Arc<Mutex<HashMap<String, Arc<PiRpc>>>>;

/// Reply to the requesting pi's blocking `ctx.ui.input` with a JSON result,
/// stringified into `value` (the shape the extension parses back). `label` names
/// the tunnel for log lines. Best-effort: a dead/absent pi is logged, not fatal.
pub async fn reply_to_pi(pool: &PiPool, conv: &str, req: &str, reply: Value, label: &str) {
    let payload = json!({
        "type": "extension_ui_response",
        "id": req,
        "value": reply.to_string(),
    });
    let pi = pool.lock().await.get(conv).cloned();
    if let Some(pi) = pi {
        if let Err(e) = pi.notify(payload).await {
            tracing::warn!("{label} reply to {conv} failed: {e}");
        }
    } else {
        tracing::warn!("{label}: no pi for {conv} to reply to");
    }
}

/// A trimmed, non-empty string field out of a request param object (`None` when
/// missing, non-string, or blank).
pub fn str_field(p: &Value, key: &str) -> Option<String> {
    p.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}
