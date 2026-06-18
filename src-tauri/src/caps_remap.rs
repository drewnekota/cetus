//! Caps Lock → F18 HID remap for the global voice trigger (macOS).
//!
//! Caps Lock isn't a clean momentary modifier: macOS toggles its lock state and
//! LED down in the HID layer *before* a CGEventTap ever sees the event, so a tap
//! cannot suppress it. The only reliable way to repurpose it for push-to-talk is
//! the same HID-layer remap that System Settings → Keyboard → Modifier Keys
//! uses — here driven through the system `hidutil` tool. We map Caps Lock (usage
//! `0x700000039`) to F18 (`0x70000006D`), an otherwise-unused key: that kills the
//! toggle and LED, and hands the event tap clean F18 KeyDown/KeyUp edges to drive
//! dictation from (see `hotkey.rs`).
//!
//! The mapping is system-wide and clears on reboot, so we (re)apply it whenever
//! Caps Lock is the active voice trigger and restore it on quit / when the user
//! switches away. We only ever *clear* the mapping if we ourselves applied it, so
//! a user's own `hidutil` remaps are left untouched unless they pick this option.

/// macOS virtual keycode that the remapped Caps Lock now emits (kVK_F18). The
/// event tap watches for this to drive push-to-talk.
pub const REMAPPED_KEYCODE: i64 = 79;

#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};

/// Whether *we* currently have the Caps Lock → F18 mapping applied, so restore
/// only ever clears a mapping we set.
#[cfg(target_os = "macos")]
static APPLIED: AtomicBool = AtomicBool::new(false);

// hidutil payloads. Sources/destinations are HID usages on page 0x07.
#[cfg(target_os = "macos")]
const MAP_JSON: &str = r#"{"UserKeyMapping":[{"HIDKeyboardModifierMappingSrc":0x700000039,"HIDKeyboardModifierMappingDst":0x70000006D}]}"#;
#[cfg(target_os = "macos")]
const CLEAR_JSON: &str = r#"{"UserKeyMapping":[]}"#;

#[cfg(target_os = "macos")]
fn run_hidutil(payload: &str) {
    match std::process::Command::new("hidutil")
        .args(["property", "--set", payload])
        .output()
    {
        Ok(out) if out.status.success() => {}
        Ok(out) => tracing::warn!(
            "hidutil caps-lock remap failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ),
        Err(e) => tracing::warn!("hidutil not runnable for caps-lock remap: {e}"),
    }
}

/// Drive the remap from the desired state — `true` when Caps Lock is the active
/// voice trigger. Idempotent: safe to call on every settings save and at
/// startup. Reapplies the mapping while active (cheap; survives a prior reboot
/// clear) and clears it only when we had it applied.
#[cfg(target_os = "macos")]
pub fn set_active(active: bool) {
    if active {
        run_hidutil(MAP_JSON);
        APPLIED.store(true, Ordering::Relaxed);
    } else if APPLIED.swap(false, Ordering::Relaxed) {
        run_hidutil(CLEAR_JSON);
    }
}

/// Restore the system Caps Lock behavior if we remapped it. Call on app exit.
#[cfg(target_os = "macos")]
pub fn restore() {
    if APPLIED.swap(false, Ordering::Relaxed) {
        run_hidutil(CLEAR_JSON);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn set_active(_active: bool) {}

#[cfg(not(target_os = "macos"))]
pub fn restore() {}
