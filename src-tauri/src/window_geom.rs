//! Remember the main window's size and position across launches.
//!
//! We manage this ourselves instead of `tauri-plugin-window-state` because the
//! main window is warm-parked off-screen on close (see
//! [`crate::panel::park_main_window`] / [`crate::park_main`]): that plugin reads
//! the *live* window geometry at exit, so quitting while parked would persist
//! the off-screen sliver position. Here we keep the last real geometry in an
//! in-memory cache, freeze it while the window is parked, and only flush to the
//! store on park + exit — so the saved value is always the on-screen one.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::store::Store;

const KEY: &str = "main_window_geometry";

/// Fraction of the current monitor the window fills on the first ever launch
/// (or when the saved geometry no longer lands on any connected display).
const DEFAULT_FRACTION: f64 = 0.9;

#[derive(Clone, Copy, Serialize, Deserialize)]
struct Geom {
    /// Physical-pixel outer position + inner size of the main window.
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    #[serde(default)]
    maximized: bool,
    /// True only after the user has explicitly moved or resized the main
    /// window. Older persisted geometry did not carry this field, so it
    /// deserializes as false and falls back to the 90%-centered default.
    #[serde(default)]
    user_set: bool,
}

/// Last known on-screen geometry of the main window, updated on move/resize and
/// flushed to the store on park + app exit.
static LAST: Mutex<Option<Geom>> = Mutex::new(None);

/// While true (the window is parked warm off-screen), move/resize events are
/// ignored so the off-screen sliver position never overwrites the saved one.
static SUSPENDED: AtomicBool = AtomicBool::new(false);

/// Freeze geometry recording — called just before the window is parked.
pub fn suspend() {
    SUSPENDED.store(true, Ordering::Relaxed);
}

/// Resume geometry recording — called once the window is restored on-screen.
pub fn resume() {
    SUSPENDED.store(false, Ordering::Relaxed);
}

/// Snapshot the main window's current geometry into the in-memory cache. No-op
/// while parked. Move/resize events mark the geometry as user-set; the close
/// snapshot preserves the existing flag so merely closing the default window
/// does not opt users into a restored fixed size forever.
pub fn record(win: &WebviewWindow, user_set: bool) {
    if SUSPENDED.load(Ordering::Relaxed) {
        return;
    }
    let existing_user_set = LAST.lock().unwrap().map(|g| g.user_set).unwrap_or(false);
    if let Some(mut g) = read_live(win) {
        g.user_set = user_set || existing_user_set;
        *LAST.lock().unwrap() = Some(g);
    }
}

fn read_live(win: &WebviewWindow) -> Option<Geom> {
    // A minimized window reports bogus geometry — keep the last good values.
    if win.is_minimized().unwrap_or(false) {
        return None;
    }
    // A fullscreen window's frame is the whole display, and the enter/exit
    // transitions fire Moved/Resized too — recording any of it would restore
    // a display-sized window later. Keep the last real windowed geometry.
    if win.is_fullscreen().unwrap_or(false) {
        return None;
    }
    let pos = win.outer_position().ok()?;
    let size = win.inner_size().ok()?;
    Some(Geom {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        maximized: win.is_maximized().unwrap_or(false),
        user_set: false,
    })
}

/// Persist the cached geometry to the store. Called when the window parks and
/// on app exit.
pub fn flush(store: &Store) {
    let g = *LAST.lock().unwrap();
    if let Some(g) = g {
        if let Ok(json) = serde_json::to_string(&g) {
            let _ = store.set_setting(KEY, &json);
        }
    }
}

fn load(store: &Store) -> Option<Geom> {
    let raw = store.get_setting(KEY).ok().flatten()?;
    serde_json::from_str(&raw).ok()
}

/// On launch: restore the saved geometry if it still lands on a connected
/// monitor; otherwise size the window to 90% of the current monitor, centered.
pub fn restore_or_default(app: &AppHandle, store: &Store) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    if let Some(g) = load(store) {
        if on_some_monitor(&win, &g) {
            if g.user_set {
                let _ = win.set_size(PhysicalSize::new(g.width, g.height));
                let _ = win.set_position(PhysicalPosition::new(g.x, g.y));
                if g.maximized {
                    let _ = win.maximize();
                }
                *LAST.lock().unwrap() = Some(g);
                return;
            }
        }
    }
    if let Some(g) = default_geom(&win) {
        let _ = win.set_size(PhysicalSize::new(g.width, g.height));
        let _ = win.set_position(PhysicalPosition::new(g.x, g.y));
        *LAST.lock().unwrap() = Some(g);
    }
}

/// 90%-of-monitor, centered on whichever monitor currently holds the window
/// (falling back to the primary monitor).
fn default_geom(win: &WebviewWindow) -> Option<Geom> {
    let mon = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten())?;
    let mp = mon.position();
    let ms = mon.size();
    let width = (ms.width as f64 * DEFAULT_FRACTION).round() as u32;
    let height = (ms.height as f64 * DEFAULT_FRACTION).round() as u32;
    let x = mp.x + ((ms.width.saturating_sub(width)) / 2) as i32;
    let y = mp.y + ((ms.height.saturating_sub(height)) / 2) as i32;
    Some(Geom {
        x,
        y,
        width,
        height,
        maximized: false,
        user_set: false,
    })
}

/// True if the saved window's center lies inside any connected monitor, so we
/// don't restore onto a display that's no longer attached.
fn on_some_monitor(win: &WebviewWindow, g: &Geom) -> bool {
    let cx = g.x + (g.width / 2) as i32;
    let cy = g.y + (g.height / 2) as i32;
    let monitors = match win.available_monitors() {
        Ok(m) => m,
        Err(_) => return true, // can't tell — trust the saved value
    };
    monitors.iter().any(|m| {
        let p = m.position();
        let s = m.size();
        cx >= p.x && cx < p.x + s.width as i32 && cy >= p.y && cy < p.y + s.height as i32
    })
}
