//! Windows and webviews, backed by Electron `BrowserWindow`s and
//! `WebContentsView`s. Every operation is a host call; queries made off the
//! main thread are answered from the host-fed [`WindowState`] cache.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{AppHandle, Error, Manager, Result, Theme, Url};

// ---------------------------------------------------------------------------
// dpi
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct LogicalSize<T> {
    pub width: T,
    pub height: T,
}
impl<T> LogicalSize<T> {
    pub const fn new(width: T, height: T) -> Self {
        Self { width, height }
    }
}
impl LogicalSize<f64> {}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct PhysicalSize<T> {
    pub width: T,
    pub height: T,
}
impl<T> PhysicalSize<T> {
    pub const fn new(width: T, height: T) -> Self {
        Self { width, height }
    }
}
impl<T: Into<f64> + Copy> PhysicalSize<T> {
    pub fn to_logical<U: FromF64>(&self, scale: f64) -> LogicalSize<U> {
        LogicalSize::new(
            U::from_f64(self.width.into() / scale),
            U::from_f64(self.height.into() / scale),
        )
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct LogicalPosition<T> {
    pub x: T,
    pub y: T,
}
impl<T> LogicalPosition<T> {
    pub const fn new(x: T, y: T) -> Self {
        Self { x, y }
    }
}
impl LogicalPosition<f64> {}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct PhysicalPosition<T> {
    pub x: T,
    pub y: T,
}
impl<T> PhysicalPosition<T> {
    pub const fn new(x: T, y: T) -> Self {
        Self { x, y }
    }
}
impl<T: Into<f64> + Copy> PhysicalPosition<T> {
    pub fn to_logical<U: FromF64>(&self, scale: f64) -> LogicalPosition<U> {
        LogicalPosition::new(
            U::from_f64(self.x.into() / scale),
            U::from_f64(self.y.into() / scale),
        )
    }
}

pub trait FromF64 {
    fn from_f64(v: f64) -> Self;
}
impl FromF64 for f64 {
    fn from_f64(v: f64) -> Self {
        v
    }
}
impl FromF64 for f32 {
    fn from_f64(v: f64) -> Self {
        v as f32
    }
}
impl FromF64 for i32 {
    fn from_f64(v: f64) -> Self {
        v.round() as i32
    }
}
impl FromF64 for u32 {
    fn from_f64(v: f64) -> Self {
        v.round().max(0.0) as u32
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum Size {
    Logical(LogicalSize<f64>),
    Physical(PhysicalSize<u32>),
}
impl Size {
    fn logical(&self, scale: f64) -> (f64, f64) {
        match self {
            Size::Logical(s) => (s.width, s.height),
            Size::Physical(s) => (s.width as f64 / scale, s.height as f64 / scale),
        }
    }
}
impl From<LogicalSize<f64>> for Size {
    fn from(s: LogicalSize<f64>) -> Self {
        Size::Logical(s)
    }
}
impl From<PhysicalSize<u32>> for Size {
    fn from(s: PhysicalSize<u32>) -> Self {
        Size::Physical(s)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum Position {
    Logical(LogicalPosition<f64>),
    Physical(PhysicalPosition<i32>),
}
impl Position {
    fn logical(&self, scale: f64) -> (f64, f64) {
        match self {
            Position::Logical(p) => (p.x, p.y),
            Position::Physical(p) => (p.x as f64 / scale, p.y as f64 / scale),
        }
    }
}
impl From<LogicalPosition<f64>> for Position {
    fn from(p: LogicalPosition<f64>) -> Self {
        Position::Logical(p)
    }
}
impl From<PhysicalPosition<i32>> for Position {
    fn from(p: PhysicalPosition<i32>) -> Self {
        Position::Physical(p)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub position: Position,
    pub size: Size,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PhysicalRect<P, S> {
    pub position: PhysicalPosition<P>,
    pub size: PhysicalSize<S>,
}

// ---------------------------------------------------------------------------
// Monitors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DisplayInfo {
    #[serde(default)]
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    work_x: f64,
    work_y: f64,
    work_width: f64,
    work_height: f64,
    scale: f64,
}

#[derive(Debug, Clone)]
pub struct Monitor {
    name: Option<String>,
    size: PhysicalSize<u32>,
    position: PhysicalPosition<i32>,
    work_area: PhysicalRect<i32, u32>,
    scale_factor: f64,
}

impl Monitor {
    fn from_display(d: DisplayInfo) -> Self {
        let s = d.scale;
        Monitor {
            name: Some(d.label),
            size: PhysicalSize::new((d.width * s) as u32, (d.height * s) as u32),
            position: PhysicalPosition::new((d.x * s) as i32, (d.y * s) as i32),
            work_area: PhysicalRect {
                position: PhysicalPosition::new((d.work_x * s) as i32, (d.work_y * s) as i32),
                size: PhysicalSize::new((d.work_width * s) as u32, (d.work_height * s) as u32),
            },
            scale_factor: s,
        }
    }
    pub fn name(&self) -> Option<&String> {
        self.name.as_ref()
    }
    pub fn size(&self) -> &PhysicalSize<u32> {
        &self.size
    }
    pub fn position(&self) -> &PhysicalPosition<i32> {
        &self.position
    }
    pub fn work_area(&self) -> &PhysicalRect<i32, u32> {
        &self.work_area
    }
    pub fn scale_factor(&self) -> f64 {
        self.scale_factor
    }
}

fn displays(v: Option<Value>) -> Vec<Monitor> {
    v.and_then(|v| serde_json::from_value::<Vec<DisplayInfo>>(v).ok())
        .unwrap_or_default()
        .into_iter()
        .map(Monitor::from_display)
        .collect()
}

// ---------------------------------------------------------------------------
// Window state cache
// ---------------------------------------------------------------------------

/// Last known state of a window, pushed by the host on every change.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WindowState {
    pub visible: bool,
    pub focused: bool,
    pub minimized: bool,
    pub maximized: bool,
    pub fullscreen: bool,
    /// Outer frame, logical points.
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// Content (inner) size, logical points.
    pub inner_width: f64,
    pub inner_height: f64,
    pub scale: f64,
    /// NSWindow pointer (macOS), resolved by the addon.
    pub ns_window: u64,
    pub url: String,
    pub title: String,
    /// Child webview (no window of its own).
    pub child: bool,
}

// ---------------------------------------------------------------------------
// Window events
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct CloseRequestApi {
    pub(crate) prevented: Arc<AtomicBool>,
}
impl CloseRequestApi {
    pub fn prevent_close(&self) {
        self.prevented.store(true, Ordering::SeqCst);
    }
}

#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum WindowEvent {
    CloseRequested { api: CloseRequestApi },
    Moved(PhysicalPosition<i32>),
    Resized(PhysicalSize<u32>),
    Focused(bool),
    Destroyed,
    ThemeChanged(Theme),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageLoadEvent {
    Started,
    Finished,
}

// ---------------------------------------------------------------------------
// WebviewWindow
// ---------------------------------------------------------------------------

pub struct WebviewWindow {
    app: AppHandle,
    label: String,
}

pub type Window = WebviewWindow;

impl Clone for WebviewWindow {
    fn clone(&self) -> Self {
        Self {
            app: self.app.clone(),
            label: self.label.clone(),
        }
    }
}

impl std::fmt::Debug for WebviewWindow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "WebviewWindow({})", self.label)
    }
}

impl Manager for WebviewWindow {
    fn app_handle(&self) -> &AppHandle {
        &self.app
    }
}

fn ok(_: Option<Value>) -> Result<()> {
    Ok(())
}

impl WebviewWindow {
    pub(crate) fn new(app: AppHandle, label: String) -> Self {
        Self { app, label }
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    fn call(&self, method: &str, args: Value) -> Option<Value> {
        self.app.host_call(
            "window",
            json!({ "label": self.label, "method": method, "args": args }),
        )
    }

    fn cached(&self) -> WindowState {
        self.app.cached_state(&self.label).unwrap_or_default()
    }

    fn patch(&self, f: impl FnOnce(&mut WindowState)) {
        let app = self.app.clone();
        let mut w = app.inner.windows.write().unwrap();
        if let Some(s) = w.get_mut(&self.label) {
            f(s);
        }
    }

    fn query_state(&self) -> WindowState {
        match self.call("state", Value::Null) {
            Some(v) => serde_json::from_value::<WindowState>(v)
                .map(|mut s| {
                    // The pointer is only resolved addon-side.
                    s.ns_window = self.cached().ns_window;
                    s
                })
                .unwrap_or_else(|_| self.cached()),
            None => self.cached(),
        }
    }

    fn scale(&self) -> f64 {
        let s = self.cached().scale;
        if s > 0.0 {
            s
        } else {
            2.0
        }
    }

    pub fn show(&self) -> Result<()> {
        self.patch(|s| s.visible = true);
        ok(self.call("show", Value::Null))
    }
    pub fn hide(&self) -> Result<()> {
        self.patch(|s| {
            s.visible = false;
            s.focused = false;
        });
        ok(self.call("hide", Value::Null))
    }
    pub fn close(&self) -> Result<()> {
        ok(self.call("close", Value::Null))
    }
    pub fn destroy(&self) -> Result<()> {
        ok(self.call("destroy", Value::Null))
    }
    pub fn set_focus(&self) -> Result<()> {
        ok(self.call("focus", Value::Null))
    }
    pub fn center(&self) -> Result<()> {
        ok(self.call("center", Value::Null))
    }
    pub fn minimize(&self) -> Result<()> {
        ok(self.call("minimize", Value::Null))
    }
    pub fn unminimize(&self) -> Result<()> {
        self.patch(|s| s.minimized = false);
        ok(self.call("restore", Value::Null))
    }
    pub fn maximize(&self) -> Result<()> {
        ok(self.call("maximize", Value::Null))
    }
    pub fn unmaximize(&self) -> Result<()> {
        ok(self.call("unmaximize", Value::Null))
    }
    pub fn set_fullscreen(&self, on: bool) -> Result<()> {
        ok(self.call("setFullScreen", json!([on])))
    }
    pub fn set_title(&self, title: &str) -> Result<()> {
        ok(self.call("setTitle", json!([title])))
    }
    pub fn set_theme(&self, theme: Option<Theme>) -> Result<()> {
        self.app.set_theme(theme);
        Ok(())
    }

    pub fn set_size<S: Into<Size>>(&self, size: S) -> Result<()> {
        let (w, h) = size.into().logical(self.scale());
        self.patch(|s| {
            s.width = w;
            s.height = h;
            s.inner_width = w;
            s.inner_height = h;
        });
        ok(self.call("setContentSize", json!([w, h])))
    }
    pub fn set_position<P: Into<Position>>(&self, pos: P) -> Result<()> {
        let (x, y) = pos.into().logical(self.scale());
        self.patch(|s| {
            s.x = x;
            s.y = y;
        });
        ok(self.call("setPosition", json!([x, y])))
    }

    pub fn is_visible(&self) -> Result<bool> {
        Ok(self.query_state().visible)
    }
    pub fn is_minimized(&self) -> Result<bool> {
        Ok(self.query_state().minimized)
    }
    pub fn is_maximized(&self) -> Result<bool> {
        Ok(self.query_state().maximized)
    }
    pub fn is_fullscreen(&self) -> Result<bool> {
        Ok(self.query_state().fullscreen)
    }
    pub fn scale_factor(&self) -> Result<f64> {
        let s = self.query_state().scale;
        Ok(if s > 0.0 { s } else { 2.0 })
    }
    pub fn outer_position(&self) -> Result<PhysicalPosition<i32>> {
        let s = self.query_state();
        let k = if s.scale > 0.0 { s.scale } else { 2.0 };
        Ok(PhysicalPosition::new(
            (s.x * k).round() as i32,
            (s.y * k).round() as i32,
        ))
    }
    pub fn outer_size(&self) -> Result<PhysicalSize<u32>> {
        let s = self.query_state();
        let k = if s.scale > 0.0 { s.scale } else { 2.0 };
        Ok(PhysicalSize::new(
            (s.width * k).round() as u32,
            (s.height * k).round() as u32,
        ))
    }
    pub fn inner_size(&self) -> Result<PhysicalSize<u32>> {
        let s = self.query_state();
        let k = if s.scale > 0.0 { s.scale } else { 2.0 };
        Ok(PhysicalSize::new(
            (s.inner_width * k).round() as u32,
            (s.inner_height * k).round() as u32,
        ))
    }
    pub fn title(&self) -> Result<String> {
        Ok(self.query_state().title)
    }

    pub fn current_monitor(&self) -> Result<Option<Monitor>> {
        let v = self.call("currentDisplay", Value::Null);
        Ok(displays(v.map(|v| Value::Array(vec![v])))
            .into_iter()
            .next())
    }
    pub fn primary_monitor(&self) -> Result<Option<Monitor>> {
        let v = self.app.host_call("primary_display", Value::Null);
        Ok(displays(v.map(|v| Value::Array(vec![v])))
            .into_iter()
            .next())
    }
    pub fn available_monitors(&self) -> Result<Vec<Monitor>> {
        Ok(displays(self.app.host_call("displays", Value::Null)))
    }
    /// `x`/`y` in physical pixels (window-API semantics).
    pub fn monitor_from_point(&self, x: f64, y: f64) -> Result<Option<Monitor>> {
        let v = self
            .app
            .host_call("display_at_physical_point", json!({ "x": x, "y": y }));
        Ok(displays(v.map(|v| Value::Array(vec![v])))
            .into_iter()
            .next())
    }

    #[cfg(target_os = "macos")]
    pub fn ns_window(&self) -> Result<*mut std::ffi::c_void> {
        let p = self.cached().ns_window;
        if p == 0 {
            Err(Error("no NSWindow for this window".into()))
        } else {
            Ok(p as usize as *mut std::ffi::c_void)
        }
    }

    pub fn url(&self) -> Result<Url> {
        let s = self
            .call("url", Value::Null)
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_else(|| self.cached().url);
        Url::parse(&s).map_err(|e| Error(e.to_string()))
    }
    pub fn navigate(&self, url: Url) -> Result<()> {
        ok(self.call("loadURL", json!([url.as_str()])))
    }
    pub fn reload(&self) -> Result<()> {
        ok(self.call("reload", Value::Null))
    }
    pub fn eval(&self, js: impl Into<String>) -> Result<()> {
        ok(self.call("eval", json!([js.into()])))
    }

    pub fn on_window_event<F: Fn(&WindowEvent) + Send + Sync + 'static>(&self, f: F) {
        self.app
            .inner
            .window_handlers
            .lock()
            .unwrap()
            .entry(self.label.clone())
            .or_default()
            .push(Arc::new(f));
    }

    /// Embed a child webview (Electron `WebContentsView`) in this window.
    pub fn add_child<P: Into<Position>, S: Into<Size>>(
        &self,
        builder: WebviewBuilder,
        position: P,
        size: S,
    ) -> Result<Webview> {
        let scale = self.scale();
        let (x, y) = position.into().logical(scale);
        let (w, h) = size.into().logical(scale);
        let app = self.app.clone();
        if let Some(h) = builder.on_title {
            app.inner
                .title_handlers
                .lock()
                .unwrap()
                .insert(builder.label.clone(), h);
        }
        app.update_window_state(
            &builder.label,
            Some(WindowState {
                child: true,
                visible: true,
                ..Default::default()
            }),
        );
        let _ = app.host_call(
            "create_child_webview",
            json!({
                "parent": self.label,
                "label": builder.label,
                "url": builder.url.to_string_lossy(),
                "initScript": builder.init_scripts,
                "bounds": { "x": x, "y": y, "width": w, "height": h },
            }),
        );
        Ok(Webview::new(self.app.clone(), builder.label))
    }
}

// ---------------------------------------------------------------------------
// Child webviews
// ---------------------------------------------------------------------------

pub struct Webview {
    app: AppHandle,
    label: String,
}

impl Clone for Webview {
    fn clone(&self) -> Self {
        Self {
            app: self.app.clone(),
            label: self.label.clone(),
        }
    }
}

impl Manager for Webview {
    fn app_handle(&self) -> &AppHandle {
        &self.app
    }
}

impl Webview {
    pub(crate) fn new(app: AppHandle, label: String) -> Self {
        Self { app, label }
    }
    pub fn label(&self) -> &str {
        &self.label
    }
    fn call(&self, method: &str, args: Value) -> Option<Value> {
        self.app.host_call(
            "webview",
            json!({ "label": self.label, "method": method, "args": args }),
        )
    }
    pub fn set_bounds(&self, rect: Rect) -> Result<()> {
        let (x, y) = rect.position.logical(2.0);
        let (w, h) = rect.size.logical(2.0);
        ok(self.call(
            "setBounds",
            json!([{ "x": x, "y": y, "width": w, "height": h }]),
        ))
    }
    pub fn navigate(&self, url: Url) -> Result<()> {
        ok(self.call("loadURL", json!([url.as_str()])))
    }
    pub fn eval(&self, js: impl Into<String>) -> Result<()> {
        ok(self.call("eval", json!([js.into()])))
    }
    pub fn reload(&self) -> Result<()> {
        ok(self.call("reload", Value::Null))
    }
    pub fn close(&self) -> Result<()> {
        self.app.update_window_state(&self.label, None);
        ok(self.call("close", Value::Null))
    }
    pub fn url(&self) -> Result<Url> {
        let s = self
            .call("url", Value::Null)
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default();
        Url::parse(&s).map_err(|e| Error(e.to_string()))
    }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum WebviewUrl {
    App(std::path::PathBuf),
    External(Url),
}
impl WebviewUrl {
    fn to_string_lossy(&self) -> String {
        match self {
            WebviewUrl::App(p) => format!("app:{}", p.display()),
            WebviewUrl::External(u) => u.to_string(),
        }
    }
}
impl Default for WebviewUrl {
    fn default() -> Self {
        WebviewUrl::App("index.html".into())
    }
}

type TitleCb = Arc<dyn Fn(String) + Send + Sync>;

pub struct WebviewBuilder {
    label: String,
    url: WebviewUrl,
    init_scripts: Vec<String>,
    on_title: Option<TitleCb>,
}

impl WebviewBuilder {
    pub fn new(label: impl Into<String>, url: WebviewUrl) -> Self {
        Self {
            label: label.into(),
            url,
            init_scripts: Vec::new(),
            on_title: None,
        }
    }
    pub fn initialization_script(mut self, js: impl Into<String>) -> Self {
        self.init_scripts.push(js.into());
        self
    }
    pub fn on_document_title_changed<F: Fn(Webview, String) + Send + Sync + 'static>(
        mut self,
        f: F,
    ) -> Self {
        let label = self.label.clone();
        self.on_title = Some(Arc::new(move |title| {
            if let Some(app) = crate::app() {
                let app: AppHandle = AppHandle {
                    inner: app.inner.clone(),
                };
                f(Webview::new(app, label.clone()), title);
            }
        }));
        self
    }
}

pub struct WebviewWindowBuilder<'a> {
    app: &'a AppHandle,
    label: String,
    url: WebviewUrl,
    opts: serde_json::Map<String, Value>,
    init_scripts: Vec<String>,
    on_title: Option<TitleCb>,
}

impl<'a> WebviewWindowBuilder<'a> {
    pub fn new<M: Manager>(manager: &'a M, label: impl Into<String>, url: WebviewUrl) -> Self {
        Self {
            app: manager.app_handle(),
            label: label.into(),
            url,
            opts: serde_json::Map::new(),
            init_scripts: Vec::new(),
            on_title: None,
        }
    }
    fn opt(mut self, k: &str, v: Value) -> Self {
        self.opts.insert(k.to_string(), v);
        self
    }
    pub fn title(self, t: impl Into<String>) -> Self {
        let t = t.into();
        self.opt("title", json!(t))
    }
    pub fn inner_size(self, w: f64, h: f64) -> Self {
        self.opt("width", json!(w)).opt("height", json!(h))
    }
    pub fn position(self, x: f64, y: f64) -> Self {
        self.opt("x", json!(x)).opt("y", json!(y))
    }
    pub fn resizable(self, on: bool) -> Self {
        self.opt("resizable", json!(on))
    }
    pub fn transparent(self, on: bool) -> Self {
        self.opt("transparent", json!(on))
    }
    pub fn visible(self, on: bool) -> Self {
        self.opt("show", json!(on))
    }
    pub fn focused(self, on: bool) -> Self {
        self.opt("focusable", json!(on))
    }
    pub fn center(self) -> Self {
        self.opt("center", json!(true))
    }
    pub fn data_directory(self, dir: std::path::PathBuf) -> Self {
        self.opt("partitionDir", json!(dir))
    }
    pub fn initialization_script(mut self, js: impl Into<String>) -> Self {
        self.init_scripts.push(js.into());
        self
    }
    pub fn on_document_title_changed<F: Fn(WebviewWindow, String) + Send + Sync + 'static>(
        mut self,
        f: F,
    ) -> Self {
        let label = self.label.clone();
        self.on_title = Some(Arc::new(move |title| {
            if let Some(app) = crate::app() {
                let app: AppHandle = AppHandle {
                    inner: app.inner.clone(),
                };
                f(WebviewWindow::new(app, label.clone()), title);
            }
        }));
        self
    }
    pub fn build(self) -> Result<WebviewWindow> {
        let app = self.app.clone();
        if app.inner.windows.read().unwrap().contains_key(&self.label) {
            return Err(Error(format!(
                "a window labeled `{}` already exists",
                self.label
            )));
        }
        if let Some(h) = self.on_title {
            app.inner
                .title_handlers
                .lock()
                .unwrap()
                .insert(self.label.clone(), h);
        }
        app.update_window_state(
            &self.label,
            Some(WindowState {
                visible: true,
                ..Default::default()
            }),
        );
        let _ = app.host_call(
            "create_window",
            json!({
                "label": self.label,
                "url": self.url.to_string_lossy(),
                "options": self.opts,
                "initScript": self.init_scripts,
            }),
        );
        Ok(WebviewWindow::new(self.app.clone(), self.label))
    }
}
