use crate::app_event::AppEvent;
use crate::bridge::RuntimeEvent;
use crate::pi_rpc::{EventSink, TaskSpawner};
use std::future::Future;
use std::pin::Pin;
use tauri::{AppHandle, Emitter};

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
