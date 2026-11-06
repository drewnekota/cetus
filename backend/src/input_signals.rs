//! Keyboard *timing* signals for the event-driven screen-context capture.
//!
//! Fed by the existing listen-only CGEventTap in `hotkey.rs` (no extra tap, no
//! extra permission): on every KeyDown the tap reports the keycode and modifier
//! flags here, and this module reduces them to a handful of atomics the capture
//! loop polls. Privacy contract: nothing but *timestamps* is retained — no key
//! codes, no characters, no ordering. The only classification made is "was this
//! a commit gesture" (Enter / ⌘Enter / ⌘S / ⌘C), and only its time survives.
//!
//! Why these gestures: they are the moments the screen is most worth remembering.
//! Enter submits — a sent message, a run command, a search; ⌘S commits a
//! document; ⌘C marks content the user explicitly wanted. Capturing shortly
//! *after* them records the action together with its result.

use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};

/// macOS virtual keycodes (layout-independent physical keys).
const KVK_RETURN: i64 = 36;
const KVK_KEYPAD_ENTER: i64 = 76;
const KVK_ANSI_S: i64 = 1;
const KVK_ANSI_C: i64 = 8;

/// CGEventFlags ⌘ mask (same value hotkey.rs uses).
const M_CMD: u64 = 1 << 20;

/// Two keystrokes further apart than this belong to different bursts.
const BURST_GAP_MS: i64 = 4_000;

/// ms timestamp of the most recent commit gesture (0 = never).
static LAST_COMMIT_MS: AtomicI64 = AtomicI64::new(0);
/// ms timestamp of the most recent keystroke of any kind (0 = never).
static LAST_KEYDOWN_MS: AtomicI64 = AtomicI64::new(0);
/// Keystrokes in the current burst (resets when the gap exceeds BURST_GAP_MS).
static BURST_KEYS: AtomicU32 = AtomicU32::new(0);

/// Called from the event-tap callback on every KeyDown. Must stay cheap — it
/// runs inside the tap's per-event budget.
pub fn note_key_down(keycode: i64, flags: u64) {
    let now = crate::store::now_ms();
    let prev = LAST_KEYDOWN_MS.swap(now, Ordering::Relaxed);
    if now - prev > BURST_GAP_MS {
        BURST_KEYS.store(1, Ordering::Relaxed);
    } else {
        BURST_KEYS.fetch_add(1, Ordering::Relaxed);
    }

    let cmd = flags & M_CMD != 0;
    let commit = matches!(keycode, KVK_RETURN | KVK_KEYPAD_ENTER)
        || (cmd && matches!(keycode, KVK_ANSI_S | KVK_ANSI_C));
    if commit {
        LAST_COMMIT_MS.store(now, Ordering::Relaxed);
    }
}

/// ms timestamp of the last commit gesture, 0 when none has been seen.
pub fn last_commit_ms() -> i64 {
    LAST_COMMIT_MS.load(Ordering::Relaxed)
}

/// ms timestamp of the last keystroke, 0 when none has been seen.
pub fn last_keydown_ms() -> i64 {
    LAST_KEYDOWN_MS.load(Ordering::Relaxed)
}

/// Keystrokes in the burst that `last_keydown_ms` belongs to.
pub fn burst_keys() -> u32 {
    BURST_KEYS.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commit_and_burst_classification() {
        note_key_down(KVK_ANSI_S, 0); // plain 's' — not a commit
        assert_eq!(last_commit_ms(), 0);
        note_key_down(KVK_ANSI_S, M_CMD); // ⌘S — commit
        assert!(last_commit_ms() > 0);
        let c1 = last_commit_ms();
        note_key_down(KVK_RETURN, 0); // Enter — commit
        assert!(last_commit_ms() >= c1);
        assert!(burst_keys() >= 3);
    }
}
