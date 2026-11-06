//! Electron host runtime for the Cetus backend.
//!
//! The backend is loaded into Electron's main process as a Node-API addon.
//! This crate is the API it is written against (app handle, managed state,
//! events, commands, windows, plugins), implemented on top of the Electron
//! main process: windows/webviews/dialogs/shortcuts are Electron objects, and
//! every UI-side operation goes through a [`HostBackend`] the addon provides.
//!
//! Threading model:
//! - The Electron main thread is the AppKit main thread. Sync commands run
//!   there inline; `run_on_main_thread` closures and queued host calls run
//!   there in FIFO order.
//! - Async commands and spawned tasks run on a shared multi-thread tokio
//!   runtime ([`async_runtime`]).
//! - Rust never blocks waiting on JS. Host calls from the main thread are
//!   synchronous (live answers); from any other thread they are queued, and
//!   window queries are answered from a state cache the host keeps current.

use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;

pub use cetus_host_macros::{command, generate_handler};
pub use url::Url;

mod window;
pub use window::*;
pub mod plugins;
mod updater;

pub mod async_runtime;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Error(pub String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Error {}
impl From<String> for Error {
    fn from(s: String) -> Self {
        Error(s)
    }
}
impl From<&str> for Error {
    fn from(s: &str) -> Self {
        Error(s.to_string())
    }
}
impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

// ---------------------------------------------------------------------------
// Host backend (implemented by the Node-API addon)
// ---------------------------------------------------------------------------

/// The Electron side of the bridge. Implemented by the addon.
pub trait HostBackend: Send + Sync + 'static {
    /// True on the Electron main thread while JS can be called synchronously.
    fn on_main(&self) -> bool;
    /// Synchronous host call. Only meaningful when [`Self::on_main`] is true.
    fn call_sync(&self, op: &str, args: Value) -> Value;
    /// Run `f` on the main thread, FIFO with every other queued main-thread
    /// job and host call, with synchronous host calls available inside it.
    fn run_on_main(&self, f: Box<dyn FnOnce() + Send>);
    /// Host call whose (possibly asynchronous) result is delivered to `reply`
    /// on the main thread.
    fn call_reply(&self, op: String, args: Value, reply: Box<dyn FnOnce(Value) + Send>);
}

/// Static facts about the running host, supplied at init.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostConfig {
    pub identifier: String,
    pub product_name: String,
    pub version: String,
    pub resource_dir: PathBuf,
    #[serde(default)]
    pub dev_url: Option<String>,
    #[serde(default)]
    pub is_dev: bool,
}

// ---------------------------------------------------------------------------
// Config / package info / paths
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct BuildConfig {
    pub dev_url: Option<Url>,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub identifier: String,
    pub product_name: Option<String>,
    pub version: Option<String>,
    pub build: BuildConfig,
}

#[derive(Debug, Clone)]
pub struct PackageInfo {
    pub name: String,
    pub version: Version,
}

/// Minimal semver-ish version (only `to_string`/`Display` are used).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version(pub String);
impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

pub struct PathResolver {
    identifier: String,
    resource_dir: PathBuf,
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

impl PathResolver {
    pub fn app_data_dir(&self) -> Result<PathBuf> {
        Ok(home()
            .join("Library/Application Support")
            .join(&self.identifier))
    }
    pub fn resource_dir(&self) -> Result<PathBuf> {
        Ok(self.resource_dir.clone())
    }
    pub fn temp_dir(&self) -> Result<PathBuf> {
        Ok(std::env::temp_dir())
    }
}

// ---------------------------------------------------------------------------
// App internals
// ---------------------------------------------------------------------------

pub type EventId = u32;

type ListenerFn = Arc<dyn Fn(Event) + Send + Sync>;
type WindowHandler = Arc<dyn Fn(&WindowEvent) + Send + Sync>;
type TitleHandler = Arc<dyn Fn(String) + Send + Sync>;
pub type InvokeHandler = Box<dyn Fn(&str, InvokeCtx) -> Option<CommandOutput> + Send + Sync>;

pub(crate) struct AppInner {
    pub(crate) backend: Box<dyn HostBackend>,
    config: Config,
    package_info: PackageInfo,
    paths: PathResolver,
    states: RwLock<HashMap<TypeId, &'static (dyn Any + Send + Sync)>>,
    listeners: Mutex<HashMap<String, Vec<(EventId, ListenerFn)>>>,
    next_id: AtomicU32,
    pub(crate) window_handlers: Mutex<HashMap<String, Vec<WindowHandler>>>,
    pub(crate) title_handlers: Mutex<HashMap<String, TitleHandler>>,
    pub(crate) windows: RwLock<HashMap<String, WindowState>>,
    invoke_handler: OnceLock<InvokeHandler>,
    is_dev: bool,
}

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Bring the host runtime up. Called once by the addon.
pub fn init(backend: Box<dyn HostBackend>, cfg: HostConfig) -> AppHandle {
    let dev_url = cfg.dev_url.as_deref().and_then(|u| Url::parse(u).ok());
    let inner = AppInner {
        backend,
        config: Config {
            identifier: cfg.identifier.clone(),
            product_name: Some(cfg.product_name.clone()),
            version: Some(cfg.version.clone()),
            build: BuildConfig { dev_url },
        },
        package_info: PackageInfo {
            name: cfg.product_name.clone(),
            version: Version(cfg.version.clone()),
        },
        paths: PathResolver {
            identifier: cfg.identifier.clone(),
            resource_dir: cfg.resource_dir.clone(),
        },
        states: RwLock::new(HashMap::new()),
        listeners: Mutex::new(HashMap::new()),
        next_id: AtomicU32::new(1),
        window_handlers: Mutex::new(HashMap::new()),
        title_handlers: Mutex::new(HashMap::new()),
        windows: RwLock::new(HashMap::new()),
        invoke_handler: OnceLock::new(),
        is_dev: cfg.is_dev,
    };
    let app = AppHandle {
        inner: Arc::new(inner),
    };
    let _ = APP.set(app.clone());
    app
}

/// The process-wide app handle (after [`init`]).
pub fn app() -> Option<&'static AppHandle> {
    APP.get()
}

pub fn is_dev() -> bool {
    APP.get()
        .map(|a| a.inner.is_dev)
        .unwrap_or(cfg!(debug_assertions))
}

// ---------------------------------------------------------------------------
// AppHandle
// ---------------------------------------------------------------------------

pub struct AppHandle {
    pub(crate) inner: Arc<AppInner>,
}

impl Clone for AppHandle {
    fn clone(&self) -> Self {
        AppHandle {
            inner: self.inner.clone(),
        }
    }
}

impl std::fmt::Debug for AppHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AppHandle")
    }
}

/// Setup-time `App` — the same thing as the handle.
pub type App = AppHandle;

impl AppHandle {
    /// Setup-time compatibility: `app.handle()`.
    pub fn handle(&self) -> &Self {
        self
    }

    pub fn set_invoke_handler(&self, handler: InvokeHandler) {
        let _ = self.inner.invoke_handler.set(handler);
    }

    pub fn dispatch(&self, cmd: &str, ctx: InvokeCtx) -> Option<CommandOutput> {
        self.inner.invoke_handler.get().and_then(|h| h(cmd, ctx))
    }

    /// Run `f` on the main thread (FIFO with queued host work).
    pub fn run_on_main_thread<F: FnOnce() + Send + 'static>(&self, f: F) -> Result<()> {
        if self.inner.backend.on_main() {
            f();
        } else {
            self.inner.backend.run_on_main(Box::new(f));
        }
        Ok(())
    }

    /// Host call: synchronous (with result) on the main thread, queued
    /// fire-and-forget elsewhere.
    pub fn host_call(&self, op: &str, args: Value) -> Option<Value> {
        let b = &self.inner.backend;
        if b.on_main() {
            Some(b.call_sync(op, args))
        } else {
            let op = op.to_string();
            let app = self.clone();
            b.run_on_main(Box::new(move || {
                app.inner.backend.call_sync(&op, args);
            }));
            None
        }
    }

    /// Host call whose result is needed off the main thread.
    pub async fn host_call_async(&self, op: &str, args: Value) -> Value {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.inner.backend.call_reply(
            op.to_string(),
            args,
            Box::new(move |v| {
                let _ = tx.send(v);
            }),
        );
        rx.await.unwrap_or(Value::Null)
    }

    /// Host call answered synchronously from any thread: live on the main
    /// thread, otherwise queued and waited for up to `timeout`.
    pub fn host_call_blocking(
        &self,
        op: &str,
        args: Value,
        timeout: std::time::Duration,
    ) -> Option<Value> {
        if self.inner.backend.on_main() {
            return Some(self.inner.backend.call_sync(op, args));
        }
        let (tx, rx) = std::sync::mpsc::channel();
        self.host_call_then(op, args, move |v| {
            let _ = tx.send(v);
        });
        rx.recv_timeout(timeout).ok()
    }

    /// Host call with a callback for the (possibly async) result.
    pub fn host_call_then(
        &self,
        op: &str,
        args: Value,
        reply: impl FnOnce(Value) + Send + 'static,
    ) {
        self.inner
            .backend
            .call_reply(op.to_string(), args, Box::new(reply));
    }

    pub fn cursor_position(&self) -> Result<PhysicalPosition<f64>> {
        let v = self
            .host_call("cursor_position", Value::Null)
            .unwrap_or(Value::Null);
        let x = v.get("x").and_then(Value::as_f64).unwrap_or(0.0);
        let y = v.get("y").and_then(Value::as_f64).unwrap_or(0.0);
        let s = v.get("scale").and_then(Value::as_f64).unwrap_or(1.0);
        Ok(PhysicalPosition::new(x * s, y * s))
    }

    pub fn exit(&self, code: i32) {
        let _ = self.host_call("exit", serde_json::json!({ "code": code }));
    }

    pub fn restart(&self) -> ! {
        let _ = self.host_call("restart", Value::Null);
        std::thread::sleep(std::time::Duration::from_secs(5));
        std::process::exit(0)
    }

    pub fn set_theme(&self, theme: Option<Theme>) {
        let _ = self.host_call("set_theme", serde_json::json!({ "theme": theme }));
    }

    pub fn get_window(&self, label: &str) -> Option<Window> {
        self.get_webview_window(label)
    }

    pub fn get_webview(&self, label: &str) -> Option<Webview> {
        let exists = self
            .host_call("webview_exists", serde_json::json!({ "label": label }))
            .map(|v| v.as_bool().unwrap_or(false))
            .unwrap_or_else(|| self.inner.windows.read().unwrap().contains_key(label));
        exists.then(|| Webview::new(self.clone(), label.to_string()))
    }

    // ---- window-state cache (fed by the host) ----

    pub fn update_window_state(&self, label: &str, state: Option<WindowState>) {
        let mut w = self.inner.windows.write().unwrap();
        match state {
            Some(s) => {
                w.insert(label.to_string(), s);
            }
            None => {
                w.remove(label);
                drop(w);
                self.inner.window_handlers.lock().unwrap().remove(label);
                self.inner.title_handlers.lock().unwrap().remove(label);
            }
        }
    }

    /// Deliver a window event to the Rust-side handlers. Returns whether a
    /// handler prevented a close.
    pub fn dispatch_window_event(&self, label: &str, event: &WindowEvent) -> bool {
        let handlers = self
            .inner
            .window_handlers
            .lock()
            .unwrap()
            .get(label)
            .cloned()
            .unwrap_or_default();
        for h in handlers {
            h(event);
        }
        match event {
            WindowEvent::CloseRequested { api } => api.prevented.load(Ordering::SeqCst),
            _ => false,
        }
    }

    pub fn dispatch_title_changed(&self, label: &str, title: String) {
        let h = self
            .inner
            .title_handlers
            .lock()
            .unwrap()
            .get(label)
            .cloned();
        if let Some(h) = h {
            h(title);
        }
    }

    pub(crate) fn cached_state(&self, label: &str) -> Option<WindowState> {
        self.inner.windows.read().unwrap().get(label).cloned()
    }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

pub trait Manager {
    fn app_handle(&self) -> &AppHandle;

    fn state<T: Send + Sync + 'static>(&self) -> State<'_, T> {
        self.try_state::<T>()
            .unwrap_or_else(|| panic!("state not managed: {}", std::any::type_name::<T>()))
    }

    fn try_state<T: Send + Sync + 'static>(&self) -> Option<State<'_, T>> {
        let states = self.app_handle().inner.states.read().unwrap();
        let any = states.get(&TypeId::of::<T>()).copied()?;
        any.downcast_ref::<T>().map(State)
    }

    fn manage<T: Send + Sync + 'static>(&self, state: T) -> bool {
        let mut states = self.app_handle().inner.states.write().unwrap();
        if states.contains_key(&TypeId::of::<T>()) {
            return false;
        }
        let leaked: &'static T = Box::leak(Box::new(state));
        states.insert(TypeId::of::<T>(), leaked);
        true
    }

    fn get_webview_window(&self, label: &str) -> Option<WebviewWindow> {
        let app = self.app_handle();
        let exists = app.inner.windows.read().unwrap().contains_key(label);
        exists.then(|| WebviewWindow::new(app.clone(), label.to_string()))
    }

    fn webview_windows(&self) -> HashMap<String, WebviewWindow> {
        let app = self.app_handle();
        let labels: Vec<String> = app.inner.windows.read().unwrap().keys().cloned().collect();
        labels
            .into_iter()
            .map(|l| (l.clone(), WebviewWindow::new(app.clone(), l)))
            .collect()
    }

    fn path(&self) -> &PathResolver {
        &self.app_handle().inner.paths
    }

    fn config(&self) -> &Config {
        &self.app_handle().inner.config
    }

    fn package_info(&self) -> &PackageInfo {
        &self.app_handle().inner.package_info
    }
}

impl Manager for AppHandle {
    fn app_handle(&self) -> &AppHandle {
        self
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

pub struct State<'r, T: Send + Sync + 'static>(&'r T);

impl<'r, T: Send + Sync + 'static> State<'r, T> {
    pub fn inner(&self) -> &'r T {
        self.0
    }
}
impl<T: Send + Sync + 'static> std::ops::Deref for State<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        self.0
    }
}
impl<T: Send + Sync + 'static> Clone for State<'_, T> {
    fn clone(&self) -> Self {
        *self
    }
}
impl<T: Send + Sync + 'static> Copy for State<'_, T> {}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Event {
    id: EventId,
    payload: String,
}
impl Event {
    pub fn id(&self) -> EventId {
        self.id
    }
    pub fn payload(&self) -> &str {
        &self.payload
    }
}

#[derive(Debug, Clone)]
pub enum EventTarget {
    Any,
    Label(String),
}
impl From<&str> for EventTarget {
    fn from(s: &str) -> Self {
        EventTarget::Label(s.to_string())
    }
}
impl From<String> for EventTarget {
    fn from(s: String) -> Self {
        EventTarget::Label(s)
    }
}
impl From<&String> for EventTarget {
    fn from(s: &String) -> Self {
        EventTarget::Label(s.clone())
    }
}

fn emit_impl(app: &AppHandle, target: EventTarget, event: &str, payload: String) {
    // Rust-side listeners first (emits are delivered to both sides).
    let listeners: Vec<(EventId, ListenerFn)> = app
        .inner
        .listeners
        .lock()
        .unwrap()
        .get(event)
        .cloned()
        .unwrap_or_default();
    for (id, l) in listeners {
        l(Event {
            id,
            payload: payload.clone(),
        });
    }
    let target = match target {
        EventTarget::Any => Value::Null,
        EventTarget::Label(l) => Value::String(l),
    };
    let _ = app.host_call(
        "emit",
        serde_json::json!({ "target": target, "event": event, "payload": payload }),
    );
}

pub trait Emitter: Manager {
    fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) -> Result<()> {
        let json = serde_json::to_string(&payload).map_err(|e| Error(e.to_string()))?;
        emit_impl(self.app_handle(), EventTarget::Any, event, json);
        Ok(())
    }

    fn emit_to<I: Into<EventTarget>, S: Serialize + Clone>(
        &self,
        target: I,
        event: &str,
        payload: S,
    ) -> Result<()> {
        let json = serde_json::to_string(&payload).map_err(|e| Error(e.to_string()))?;
        emit_impl(self.app_handle(), target.into(), event, json);
        Ok(())
    }
}
impl<T: Manager> Emitter for T {}

pub trait Listener: Manager {
    fn listen<F: Fn(Event) + Send + Sync + 'static>(
        &self,
        event: impl Into<String>,
        handler: F,
    ) -> EventId {
        let app = self.app_handle();
        let id = app.inner.next_id.fetch_add(1, Ordering::Relaxed);
        app.inner
            .listeners
            .lock()
            .unwrap()
            .entry(event.into())
            .or_default()
            .push((id, Arc::new(handler)));
        id
    }

    fn listen_any<F: Fn(Event) + Send + Sync + 'static>(
        &self,
        event: impl Into<String>,
        handler: F,
    ) -> EventId {
        self.listen(event, handler)
    }

    fn unlisten(&self, id: EventId) {
        let app = self.app_handle();
        for v in app.inner.listeners.lock().unwrap().values_mut() {
            v.retain(|(i, _)| *i != id);
        }
    }

    fn once<F: FnOnce(Event) + Send + 'static>(
        &self,
        event: impl Into<String>,
        handler: F,
    ) -> EventId {
        let slot = Mutex::new(Some(handler));
        let app = self.app_handle().clone();
        let fired = Arc::new(AtomicBool::new(false));
        let id_cell: Arc<OnceLock<EventId>> = Arc::new(OnceLock::new());
        let id_for = id_cell.clone();
        let id = self.listen(event, move |e| {
            if fired.swap(true, Ordering::SeqCst) {
                return;
            }
            if let Some(h) = slot.lock().unwrap().take() {
                h(e);
            }
            if let Some(id) = id_for.get() {
                app.unlisten(*id);
            }
        });
        let _ = id_cell.set(id);
        id
    }
}
impl<T: Manager> Listener for T {}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// One `invoke` from a webview.
pub struct InvokeCtx {
    pub app: AppHandle,
    pub label: String,
    pub cmd: String,
    pub args: serde_json::Map<String, Value>,
}

impl InvokeCtx {
    pub fn arg<T: DeserializeOwned>(&self, key: &str) -> std::result::Result<T, Value> {
        let v = self.args.get(key).cloned().unwrap_or(Value::Null);
        serde_json::from_value(v).map_err(|e| {
            Value::String(format!(
                "invalid args `{key}` for command `{}`: {e}",
                self.cmd
            ))
        })
    }
}

pub type CommandFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = std::result::Result<Value, Value>> + Send>>;

pub enum CommandOutput {
    Ready(std::result::Result<Value, Value>),
    Future(CommandFuture),
}

#[doc(hidden)]
pub mod __private {
    pub use serde_json::Value;

    use super::*;

    pub trait FromCtx<'a>: Sized {
        fn from_ctx(ctx: &'a InvokeCtx) -> std::result::Result<Self, Value>;
    }

    impl<'a, T: Send + Sync + 'static> FromCtx<'a> for State<'a, T> {
        fn from_ctx(ctx: &'a InvokeCtx) -> std::result::Result<Self, Value> {
            ctx.app.try_state::<T>().ok_or_else(|| {
                Value::String(format!(
                    "state not managed for command `{}`: {}",
                    ctx.cmd,
                    std::any::type_name::<T>()
                ))
            })
        }
    }

    impl<'a> FromCtx<'a> for AppHandle {
        fn from_ctx(ctx: &'a InvokeCtx) -> std::result::Result<Self, Value> {
            Ok(AppHandle {
                inner: ctx.app.inner.clone(),
            })
        }
    }

    impl<'a> FromCtx<'a> for WebviewWindow {
        fn from_ctx(ctx: &'a InvokeCtx) -> std::result::Result<Self, Value> {
            let app: AppHandle = FromCtx::from_ctx(ctx)?;
            Ok(WebviewWindow::new(app, ctx.label.clone()))
        }
    }

    pub struct ResultTag;
    pub struct SerializeTag;

    pub trait ResultKind {
        fn __cetus_kind(&self) -> ResultTag {
            ResultTag
        }
    }
    impl<T: Serialize, E: Serialize> ResultKind for std::result::Result<T, E> {}

    pub trait SerializeKind {
        fn __cetus_kind(&self) -> SerializeTag {
            SerializeTag
        }
    }
    impl<T: Serialize> SerializeKind for &T {}

    impl ResultTag {
        pub fn wrap<T: Serialize, E: Serialize>(
            self,
            v: std::result::Result<T, E>,
        ) -> std::result::Result<Value, Value> {
            match v {
                Ok(t) => serde_json::to_value(t).map_err(|e| Value::String(e.to_string())),
                Err(e) => Err(serde_json::to_value(e).unwrap_or(Value::Null)),
            }
        }
    }
    impl SerializeTag {
        pub fn wrap<T: Serialize>(self, v: T) -> std::result::Result<Value, Value> {
            serde_json::to_value(v).map_err(|e| Value::String(e.to_string()))
        }
    }
}

// ---------------------------------------------------------------------------
// Misc types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Light,
    Dark,
}

pub mod webview {
    pub use crate::window::{PageLoadEvent, WebviewBuilder};
}

/// Test support: an app handle with a no-op host (no Electron process).
pub mod test {
    use super::*;

    struct NoopBackend;

    impl HostBackend for NoopBackend {
        fn on_main(&self) -> bool {
            false
        }
        fn call_sync(&self, _op: &str, _args: Value) -> Value {
            Value::Null
        }
        fn run_on_main(&self, f: Box<dyn FnOnce() + Send>) {
            f();
        }
        fn call_reply(&self, _op: String, _args: Value, reply: Box<dyn FnOnce(Value) + Send>) {
            reply(Value::Null);
        }
    }

    /// A fresh app handle backed by [`NoopBackend`]. Does not register as the
    /// process-wide [`app`].
    pub fn mock_app() -> AppHandle {
        let inner = AppInner {
            backend: Box::new(NoopBackend),
            config: Config {
                identifier: "test.cetus".into(),
                product_name: Some("Cetus".into()),
                version: Some("0.0.0".into()),
                build: BuildConfig { dev_url: None },
            },
            package_info: PackageInfo {
                name: "Cetus".into(),
                version: Version("0.0.0".into()),
            },
            paths: PathResolver {
                identifier: "test.cetus".into(),
                resource_dir: std::env::temp_dir(),
            },
            states: RwLock::new(HashMap::new()),
            listeners: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
            window_handlers: Mutex::new(HashMap::new()),
            title_handlers: Mutex::new(HashMap::new()),
            windows: RwLock::new(HashMap::new()),
            invoke_handler: OnceLock::new(),
            is_dev: true,
        };
        AppHandle {
            inner: Arc::new(inner),
        }
    }
}
