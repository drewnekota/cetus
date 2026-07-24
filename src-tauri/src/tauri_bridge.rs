use crate::app_event::AppEvent;
use crate::bridge::RuntimeEvent;
use crate::pi_rpc::{EventSink, TaskSpawner};
use std::future::Future;
use std::pin::Pin;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone)]
pub struct TauriEventSink {
    handle: AppHandle,
}

impl TauriEventSink {
    pub fn new(handle: AppHandle) -> Self {
        Self { handle }
    }
}

impl EventSink for TauriEventSink {
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
        let _ = self
            .handle
            .emit_to("main", "app-event", AppEvent::from(event));
    }
}

#[derive(Clone)]
pub struct TauriTaskSpawner;

impl TaskSpawner for TauriTaskSpawner {
    fn spawn(&self, fut: Pin<Box<dyn Future<Output = ()> + Send + 'static>>) {
        tauri::async_runtime::spawn(fut);
    }
}
