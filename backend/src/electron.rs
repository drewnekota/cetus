//! Node-API surface of the backend, loaded by the Electron main process.
//!
//! The addon is the [`host::HostBackend`]: it holds the JS host object
//! (`electron/host.ts`), runs main-thread jobs through a threadsafe function
//! (so they execute on the Electron main thread — also the AppKit main
//! thread — in FIFO order), and exposes the entry points the host calls:
//! `init`/`start`, `invoke`, window state + events, shortcut presses and
//! app-level events.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::mem::ManuallyDrop;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};

use host::{CommandOutput, InvokeCtx, WindowEvent, WindowState};
use napi::threadsafe_function::{
    ErrorStrategy, ThreadSafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use napi::{Env, JsFunction, JsObject, JsString, JsUnknown, Ref, ValueType};
use napi_derive::napi;
use serde_json::{json, Value};

struct Job(Box<dyn FnOnce() + Send>);

static TSFN: OnceLock<ThreadsafeFunction<Job, ErrorStrategy::Fatal>> = OnceLock::new();
static MAIN: OnceLock<std::thread::ThreadId> = OnceLock::new();
static REPLY_ID: AtomicU32 = AtomicU32::new(1);
/// Callbacks waiting on an async host call, keyed by reply id.
type ReplyFn = Box<dyn FnOnce(Value) + Send>;
static REPLIES: Mutex<Option<HashMap<u32, ReplyFn>>> = Mutex::new(None);

thread_local! {
    /// The napi env of the JS turn currently executing on this thread (main
    /// thread only); null outside one.
    static ENV: Cell<napi::sys::napi_env> = const { Cell::new(std::ptr::null_mut()) };
    /// Reference to the JS host object. Never dropped (lives for the process).
    static HOST: RefCell<Option<ManuallyDrop<Ref<()>>>> = const { RefCell::new(None) };
}

struct EnvGuard(napi::sys::napi_env);

fn enter(env: &Env) -> EnvGuard {
    EnvGuard(ENV.with(|e| e.replace(env.raw())))
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        ENV.with(|e| e.set(self.0));
    }
}

fn run_guarded(what: &str, f: impl FnOnce()) {
    if let Err(e) = catch_unwind(AssertUnwindSafe(f)) {
        let msg = e
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default();
        tracing::error!("panic in {what}: {msg}");
    }
}

/// Call `host.call(op, argsJson)` synchronously. Only on the main thread
/// inside a JS turn. The host never throws; it returns a JSON string or
/// undefined.
fn host_call_js(op: &str, args: &Value) -> Option<Value> {
    let raw = ENV.with(|e| e.get());
    if raw.is_null() {
        return None;
    }
    let env = unsafe { Env::from_raw(raw) };
    HOST.with(|h| {
        let h = h.borrow();
        let r = h.as_ref()?;
        let host: JsObject = env.get_reference_value(r).ok()?;
        let f: JsFunction = host.get_named_property("call").ok()?;
        let a = env.create_string(op).ok()?;
        let b = env.create_string(&args.to_string()).ok()?;
        let res: JsUnknown = f.call(Some(&host), &[a, b]).ok()?;
        if res.get_type().ok()? != ValueType::String {
            return None;
        }
        let s: JsString = unsafe { res.cast() };
        let s = s.into_utf8().ok()?.into_owned().ok()?;
        serde_json::from_str(&s).ok()
    })
}

struct Backend;

impl host::HostBackend for Backend {
    fn on_main(&self) -> bool {
        MAIN.get() == Some(&std::thread::current().id()) && ENV.with(|e| !e.get().is_null())
    }

    fn call_sync(&self, op: &str, args: Value) -> Value {
        host_call_js(op, &args).unwrap_or(Value::Null)
    }

    fn run_on_main(&self, f: Box<dyn FnOnce() + Send>) {
        if let Some(t) = TSFN.get() {
            t.call(Job(f), ThreadsafeFunctionCallMode::NonBlocking);
        }
    }

    fn call_reply(&self, op: String, args: Value, reply: Box<dyn FnOnce(Value) + Send>) {
        let id = REPLY_ID.fetch_add(1, Ordering::Relaxed);
        REPLIES
            .lock()
            .unwrap()
            .get_or_insert_with(HashMap::new)
            .insert(id, reply);
        self.run_on_main(Box::new(move || {
            host_call_js("__async", &json!({ "op": op, "args": args, "replyId": id }));
        }));
    }
}

fn app() -> napi::Result<host::AppHandle> {
    host::app()
        .cloned()
        .ok_or_else(|| napi::Error::from_reason("host not initialized"))
}

/// Bring the host runtime up. `host` is the JS host object (`call`, `noop`).
#[napi]
pub fn init(env: Env, host: JsObject, config_json: String) -> napi::Result<()> {
    let _ = MAIN.set(std::thread::current().id());
    let _g = enter(&env);
    let noop: JsFunction = host.get_named_property("noop")?;
    let r = env.create_reference(host)?;
    HOST.with(|h| *h.borrow_mut() = Some(ManuallyDrop::new(r)));

    let mut tsfn: ThreadsafeFunction<Job, ErrorStrategy::Fatal> =
        noop.create_threadsafe_function(0, |ctx: ThreadSafeCallContext<Job>| {
            let _g = enter(&ctx.env);
            run_guarded("main-thread job", ctx.value.0);
            Ok(Vec::<JsUnknown>::new())
        })?;
    let _ = tsfn.unref(&env);
    let _ = TSFN.set(tsfn);

    host::async_runtime::enter_forever();
    let cfg: host::HostConfig = serde_json::from_str(&config_json)
        .map_err(|e| napi::Error::from_reason(format!("bad host config: {e}")))?;
    host::init(Box::new(Backend), cfg);
    Ok(())
}

/// Run backend setup. Call after the app windows exist (their state is
/// pushed first, so setup can configure them).
#[napi]
pub fn start(env: Env) -> napi::Result<()> {
    let _g = enter(&env);
    let app = app()?;
    match catch_unwind(AssertUnwindSafe(|| crate::start(&app))) {
        Ok(r) => r.map_err(|e| napi::Error::from_reason(e.to_string())),
        Err(_) => Err(napi::Error::from_reason("backend setup panicked (see log)")),
    }
}

fn envelope(r: Result<Value, Value>) -> String {
    match r {
        Ok(v) => json!({ "ok": true, "value": v }).to_string(),
        Err(e) => json!({ "ok": false, "value": e }).to_string(),
    }
}

/// Invoke a backend command. Sync commands answer inline (the returned
/// envelope); async ones return `null` and answer later through the host's
/// `invoke_reply` op.
#[napi]
pub fn invoke(env: Env, id: u32, label: String, cmd: String, args: String) -> Option<String> {
    let _g = enter(&env);
    let app = app().ok()?;
    let args = match serde_json::from_str::<Value>(&args) {
        Ok(Value::Object(m)) => m,
        _ => serde_json::Map::new(),
    };
    let ctx = InvokeCtx {
        app: app.clone(),
        label,
        cmd: cmd.clone(),
        args,
    };
    let out = match catch_unwind(AssertUnwindSafe(|| app.dispatch(&cmd, ctx))) {
        Ok(o) => o,
        Err(_) => {
            tracing::error!("command {cmd} panicked");
            return Some(envelope(Err(Value::String(format!(
                "command {cmd} panicked"
            )))));
        }
    };
    match out {
        None => Some(envelope(Err(Value::String(format!(
            "command {cmd} not found"
        ))))),
        Some(CommandOutput::Ready(r)) => Some(envelope(r)),
        Some(CommandOutput::Future(fut)) => {
            host::async_runtime::spawn(async move {
                let r = match tokio::spawn(fut).await {
                    Ok(r) => r,
                    Err(e) => Err(Value::String(format!("command {cmd} failed: {e}"))),
                };
                let (ok, value) = match r {
                    Ok(v) => (true, v),
                    Err(v) => (false, v),
                };
                app.host_call(
                    "invoke_reply",
                    json!({ "id": id, "ok": ok, "value": value }),
                );
            });
            None
        }
    }
}

/// Result for a `call_reply` host call.
#[napi]
pub fn host_reply(env: Env, id: u32, json: String) {
    let _g = enter(&env);
    let reply = REPLIES.lock().unwrap().as_mut().and_then(|m| m.remove(&id));
    if let Some(reply) = reply {
        let v = serde_json::from_str(&json).unwrap_or(Value::Null);
        run_guarded("host reply", || reply(v));
    }
}

#[cfg(target_os = "macos")]
fn ns_window_of_view(view: u64) -> u64 {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    if view == 0 {
        return 0;
    }
    unsafe {
        let v = view as usize as *mut AnyObject;
        let w: *mut AnyObject = msg_send![&*v, window];
        w as usize as u64
    }
}

#[cfg(not(target_os = "macos"))]
fn ns_window_of_view(_view: u64) -> u64 {
    0
}

/// Window state push from the host (`state_json` null = window gone).
/// `ns_view` is the decimal NSView pointer from `getNativeWindowHandle()`.
#[napi]
pub fn window_state(env: Env, label: String, state_json: Option<String>, ns_view: Option<String>) {
    let _g = enter(&env);
    let Ok(app) = app() else { return };
    let Some(json) = state_json else {
        app.update_window_state(&label, None);
        return;
    };
    let Ok(mut state) = serde_json::from_str::<WindowState>(&json) else {
        return;
    };
    let prev = {
        use host::Manager;
        app.get_webview_window(&label)
            .and_then(|w| w.ns_window().ok())
            .map(|p| p as usize as u64)
            .unwrap_or(0)
    };
    state.ns_window = match ns_view.and_then(|v| v.parse::<u64>().ok()) {
        Some(view) => ns_window_of_view(view),
        None => prev,
    };
    app.update_window_state(&label, Some(state));
}

/// Window event from the host. Returns true when a close was prevented.
#[napi]
pub fn window_event(env: Env, label: String, kind: String, payload: Option<String>) -> bool {
    let _g = enter(&env);
    let Ok(app) = app() else { return false };
    let p: Value = payload
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    let num = |k: &str| p.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    let event = match kind.as_str() {
        "close" => WindowEvent::CloseRequested {
            api: Default::default(),
        },
        "moved" => WindowEvent::Moved(host::PhysicalPosition::new(
            num("x") as i32,
            num("y") as i32,
        )),
        "resized" => WindowEvent::Resized(host::PhysicalSize::new(
            num("width") as u32,
            num("height") as u32,
        )),
        "focus" => WindowEvent::Focused(p.as_bool().unwrap_or(false)),
        "destroyed" => WindowEvent::Destroyed,
        _ => return false,
    };
    let mut prevented = false;
    run_guarded("window event", || {
        prevented = app.dispatch_window_event(&label, &event);
    });
    prevented
}

#[napi]
pub fn title_changed(env: Env, label: String, title: String) {
    let _g = enter(&env);
    if let Ok(app) = app() {
        run_guarded("title handler", || {
            app.dispatch_title_changed(&label, title)
        });
    }
}

#[napi]
pub fn shortcut(env: Env, accelerator: String) {
    let _g = enter(&env);
    if let Ok(app) = app() {
        run_guarded("shortcut", || {
            host::plugins::global_shortcut::dispatch(&app, &accelerator)
        });
    }
}

/// App-level event (menu/tray click, Dock reopen, exit).
#[napi]
pub fn app_event(env: Env, kind: String, payload: Option<String>) -> bool {
    let _g = enter(&env);
    let Ok(app) = app() else { return false };
    let p: Value = payload
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    let mut handled = false;
    run_guarded("app event", || {
        handled = crate::electron_app_event(&app, &kind, &p);
    });
    handled
}
