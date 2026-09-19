//! Keep the Mac from idle-sleeping while cetus has a reason to stay up.
//!
//! Two independent reasons, each behind its own user preference:
//!
//!  * **Work in flight** — an agent turn is running in some conversation, or a
//!    meeting is being recorded. Scoped exactly like Codex's
//!    `prevent_idle_sleep` and Claude Code's built-in `caffeinate`: held from
//!    `agent_start` to `agent_end`, released the moment nothing is running.
//!  * **Remote access** — the mobile companion is enabled. The phone needs this
//!    Mac reachable at any hour, so the hold lasts as long as the toggle is on
//!    (Codex app: "Keep this Mac awake").
//!
//! Only *system* idle sleep is suppressed. The display still dims and locks on
//! its normal schedule (nothing here needs the screen, and an unattended
//! unlocked Mac is a security regression), and lid-close sleep is not
//! overridden — that needs `pmset` with root, which no shipping agent app does.
//!
//! One assertion covers every reason: the holders are folded into a single
//! `want` bit and the OS-level activity is begun / ended on transitions only.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Listener, Manager};

use crate::AppState;

/// Sentinel holder id for the meeting recorder (conversation ids are UUIDs, so
/// it cannot collide).
const WORK_HOLDER_MEETING: &str = "meeting";

#[derive(Default)]
struct Inner {
    /// Preference: hold while an agent turn or a meeting is running.
    work_pref: bool,
    /// Preference: hold while the mobile companion is enabled.
    remote_pref: bool,
    /// Conversation ids (and the meeting sentinel) with work in flight.
    work: HashSet<String>,
    /// Whether the remote server is currently up.
    remote_active: bool,
    /// Whether the OS assertion is currently held.
    held: bool,
}

static STATE: OnceLock<Mutex<Inner>> = OnceLock::new();

fn state() -> &'static Mutex<Inner> {
    STATE.get_or_init(|| {
        Mutex::new(Inner {
            // Matches the `QuickSettings` default; `initialize` loads the real
            // preference before any turn can start.
            work_pref: true,
            ..Inner::default()
        })
    })
}

fn with<R>(f: impl FnOnce(&mut Inner) -> R) -> R {
    let mut inner = state().lock().unwrap_or_else(|e| e.into_inner());
    let out = f(&mut inner);
    let want =
        (inner.work_pref && !inner.work.is_empty()) || (inner.remote_pref && inner.remote_active);
    if want != inner.held {
        inner.held = want;
        if want {
            tracing::info!(
                "awake: holding idle-sleep assertion (work={}, remote={})",
                inner.work.len(),
                inner.remote_active
            );
            platform::hold();
        } else {
            tracing::info!("awake: releasing idle-sleep assertion");
            platform::release();
        }
    }
    out
}

/// User preference: keep the Mac awake while agent turns / meetings run.
pub fn set_work_pref(on: bool) {
    with(|s| s.work_pref = on);
}

/// User preference: keep the Mac awake while remote access is enabled.
pub fn set_remote_pref(on: bool) {
    with(|s| s.remote_pref = on);
}

/// The remote server came up / went down.
pub fn set_remote_active(on: bool) {
    with(|s| s.remote_active = on);
}

/// Something started that should keep the machine up (an agent turn keyed by
/// conversation id, or the meeting recorder).
pub fn work_begin(id: &str) {
    with(|s| {
        s.work.insert(id.to_string());
    });
}

/// The matching end. Idempotent: an id that was never registered is a no-op.
pub fn work_end(id: &str) {
    with(|s| {
        s.work.remove(id);
    });
}

pub fn meeting_begin() {
    work_begin(WORK_HOLDER_MEETING);
}

pub fn meeting_end() {
    work_end(WORK_HOLDER_MEETING);
}

/// Load the preferences and start tracking agent turns off the app-event
/// stream. Every runtime (pi, Claude Code, Codex, ACP) brackets a turn with
/// `agent_start` / `agent_end`, and a process that dies mid-turn surfaces as
/// `pi_exited` / `pi_error`, so those three close the holder too.
pub fn initialize(app: &AppHandle) {
    let state = app.state::<AppState>();
    let quick = crate::quick::load_settings(&state.store);
    let remote_pref = state
        .store
        .get_setting(REMOTE_KEEP_AWAKE_KEY)
        .ok()
        .flatten()
        .as_deref()
        == Some("true");
    with(|s| {
        s.work_pref = quick.keep_awake_while_working;
        s.remote_pref = remote_pref;
    });

    app.listen("app-event", |event| {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(event.payload()) else {
            return;
        };
        let Some(conv) = value.get("conversationId").and_then(|v| v.as_str()) else {
            return;
        };
        match value.get("type").and_then(|v| v.as_str()) {
            Some("pi_event") => {
                match value
                    .get("event")
                    .and_then(|e| e.get("type"))
                    .and_then(|t| t.as_str())
                {
                    Some("agent_start") => work_begin(conv),
                    Some("agent_end") => work_end(conv),
                    _ => {}
                }
            }
            Some("pi_exited") | Some("pi_error") => work_end(conv),
            _ => {}
        }
    });
}

/// app_settings key for the remote-access keep-awake preference.
pub const REMOTE_KEEP_AWAKE_KEY: &str = "remote.keep_awake";

#[cfg(target_os = "macos")]
mod platform {
    //! `NSProcessInfo` activity with `NSActivityIdleSystemSleepDisabled`: the
    //! app-level form of an `IOPMAssertion` of type
    //! `PreventUserIdleSystemSleep`. Display sleep is untouched.

    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use std::sync::Mutex;

    /// `NSActivityIdleSystemSleepDisabled` (NSProcessInfo.h).
    const NS_ACTIVITY_IDLE_SYSTEM_SLEEP_DISABLED: u64 = 1 << 20;

    /// The retained activity token while held (as a pointer-sized integer so
    /// the static stays `Sync`). 0 = not held.
    static TOKEN: Mutex<usize> = Mutex::new(0);

    pub fn hold() {
        let mut token = TOKEN.lock().unwrap_or_else(|e| e.into_inner());
        if *token != 0 {
            return;
        }
        unsafe {
            let (Some(pinfo_cls), Some(str_cls)) =
                (AnyClass::get(c"NSProcessInfo"), AnyClass::get(c"NSString"))
            else {
                return;
            };
            let pinfo: *mut AnyObject = msg_send![pinfo_cls, processInfo];
            if pinfo.is_null() {
                return;
            }
            let reason: *mut AnyObject = msg_send![
                str_cls,
                stringWithUTF8String: c"cetus has work in flight".as_ptr()
            ];
            let activity: *mut AnyObject = msg_send![
                pinfo,
                beginActivityWithOptions: NS_ACTIVITY_IDLE_SYSTEM_SLEEP_DISABLED,
                reason: reason
            ];
            if activity.is_null() {
                return;
            }
            // Retain past the autorelease pool; released again in `release`.
            let _: *mut AnyObject = msg_send![activity, retain];
            *token = activity as usize;
        }
    }

    pub fn release() {
        let mut token = TOKEN.lock().unwrap_or_else(|e| e.into_inner());
        let activity = std::mem::replace(&mut *token, 0) as *mut AnyObject;
        if activity.is_null() {
            return;
        }
        unsafe {
            let Some(pinfo_cls) = AnyClass::get(c"NSProcessInfo") else {
                return;
            };
            let pinfo: *mut AnyObject = msg_send![pinfo_cls, processInfo];
            if !pinfo.is_null() {
                let _: () = msg_send![pinfo, endActivity: activity];
            }
            let _: () = msg_send![activity, release];
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    //! No-op elsewhere for now; the preference still round-trips so a future
    //! `SetThreadExecutionState` port needs no settings migration.
    pub fn hold() {}
    pub fn release() {}
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Both tests drive the one process-wide assertion; keep them sequential.
    static SERIAL: Mutex<()> = Mutex::new(());

    fn snapshot() -> (bool, usize, bool) {
        let s = state().lock().unwrap();
        (s.held, s.work.len(), s.remote_active)
    }

    #[test]
    fn folds_every_reason_into_one_hold() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        // Tests share the static; drive it from a known state.
        with(|s| {
            s.work.clear();
            s.remote_active = false;
            s.work_pref = true;
            s.remote_pref = false;
        });
        assert!(!snapshot().0);

        work_begin("c1");
        work_begin("c1"); // duplicate start is not double-counted
        work_begin("c2");
        assert!(snapshot().0);
        work_end("c1");
        assert!(snapshot().0, "c2 still running");
        work_end("c2");
        work_end("never-started");
        assert!(!snapshot().0);

        // Remote only holds when its own preference is on.
        set_remote_active(true);
        assert!(!snapshot().0);
        set_remote_pref(true);
        assert!(snapshot().0);
        set_remote_active(false);
        assert!(!snapshot().0);

        // Turning the work preference off drops a live hold immediately.
        work_begin("c3");
        assert!(snapshot().0);
        set_work_pref(false);
        assert!(!snapshot().0);
        work_end("c3");
        set_work_pref(true);
    }

    /// The OS really sees the assertion: `pmset -g assertions` lists every
    /// process holding `PreventUserIdleSystemSleep` with its reason string.
    #[cfg(target_os = "macos")]
    #[test]
    fn hold_is_visible_to_pmset() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        // NSProcessInfo registers the IOPM assertion asynchronously, so poll.
        fn settles_to(listed: bool) -> bool {
            let me = format!("pid {}(", std::process::id());
            for _ in 0..100 {
                let now = std::process::Command::new("pmset")
                    .args(["-g", "assertions"])
                    .output()
                    .map(|o| {
                        String::from_utf8_lossy(&o.stdout)
                            .lines()
                            .any(|l| l.contains(&me) && l.contains("cetus has work in flight"))
                    })
                    .unwrap_or(false);
                if now == listed {
                    return true;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            false
        }
        platform::hold();
        assert!(settles_to(true), "assertion missing from pmset while held");
        platform::release();
        assert!(settles_to(false), "assertion still listed after release");
    }
}
