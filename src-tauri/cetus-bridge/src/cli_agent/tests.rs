use super::acp_session::{acp_permission_response, acp_stop_reason_error};
use super::artifacts::{
    artifact_details, extracted_artifact_details, ARTIFACT_SEQUENCE, TOOL_OUTPUT_FLUSH_INTERVAL,
    TOOL_OUTPUT_PREVIEW_BYTES,
};
use super::codex_session::{
    codex_context_event, codex_rate_limit_event, codex_skill_commands, normalize_codex_app_item,
};
use super::*;
use crate::bridge::RuntimeEvent;
use base64::Engine as _;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::time::Duration;

mod acp;
mod artifacts;
mod claude;
mod claude_session;
mod codex;
mod codex_session;
mod common;
mod runner;

/// Collects every Protocol event's inner PiEvent for assertions.
struct TestSink(std::sync::Mutex<Vec<Value>>);
impl EventSink for TestSink {
    fn emit(&self, event: RuntimeEvent) {
        if let RuntimeEvent::Protocol { event, .. } = event {
            self.0.lock().unwrap().push(event);
        }
    }
}

fn types(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .map(|e| {
            let t = e.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if t == "message_update" {
                let sub = e
                    .get("assistantMessageEvent")
                    .and_then(|a| a.get("type"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("");
                format!("message_update:{sub}")
            } else {
                t.to_string()
            }
        })
        .collect()
}

fn artifact_test_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "cetus-artifact-{label}-{}",
        ARTIFACT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}
