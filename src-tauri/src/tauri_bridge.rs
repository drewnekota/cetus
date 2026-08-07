use crate::app_event::AppEvent;
use crate::bridge::RuntimeEvent;
use crate::pi_rpc::{EventSink, TaskSpawner};
use crate::CetusRuntime;
use std::future::Future;
use std::pin::Pin;
use tauri::{Emitter, Manager};

#[derive(Clone)]
pub struct TauriEventSink<R: tauri::Runtime = CetusRuntime> {
    handle: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> TauriEventSink<R> {
    pub fn new(handle: tauri::AppHandle<R>) -> Self {
        Self { handle }
    }
}

impl<R: tauri::Runtime> EventSink for TauriEventSink<R> {
    fn emit(&self, event: RuntimeEvent) {
        if let RuntimeEvent::Protocol {
            conversation_id: Some(conversation_id),
            event,
        } = &event
        {
            if event.get("type").and_then(serde_json::Value::as_str) == Some("cli_commands") {
                let commands = event
                    .get("commands")
                    .and_then(serde_json::Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                self.handle
                    .state::<crate::AppState>()
                    .cache_cli_commands(conversation_id, commands);
            }
        }
        // Must stay a broadcast `emit`: backend listeners (remote.rs, devtest.rs,
        // and the host-tunnel handlers in lib.rs) subscribe via AppHandle::listen,
        // which registers EventTarget::App and never matches an
        // `emit_to("main")`. Webview listeners use target Any and receive every
        // emit either way, so narrowing the target only silences the backend.
        let _ = self.handle.emit("app-event", AppEvent::from(event));
    }
}

#[derive(Clone)]
pub struct TauriTaskSpawner;

impl TaskSpawner for TauriTaskSpawner {
    fn spawn(&self, fut: Pin<Box<dyn Future<Output = ()> + Send + 'static>>) {
        tauri::async_runtime::spawn(fut);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use tauri::Listener;

    /// Regression test for v0.3.34→v0.3.51: narrowing the sink to
    /// `emit_to("main")` silently cut off every `AppHandle::listen`
    /// subscriber (Cetus Remote's WebSocket fan-out, devtest, and the
    /// automation/skill/MCP/agent-control host tunnels).
    #[test]
    fn runtime_events_reach_app_handle_listeners() {
        let app = tauri::test::mock_app();
        let received = Arc::new(AtomicBool::new(false));
        let seen = received.clone();
        app.handle().listen("app-event", move |event| {
            if event.payload().contains("pi_event") {
                seen.store(true, Ordering::SeqCst);
            }
        });
        let sink = TauriEventSink::new(app.handle().clone());
        sink.emit(RuntimeEvent::Protocol {
            conversation_id: Some("conv-1".into()),
            event: serde_json::json!({ "type": "message_update" }),
        });
        assert!(received.load(Ordering::SeqCst));
    }
}
