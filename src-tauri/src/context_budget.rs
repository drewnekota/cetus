//! Character budgets for screen context that rides along with a prompt.
//!
//! Every on-demand context path (quick reply, the launcher's `<context>` fence,
//! `cetus context now`) attaches the same kinds of fields — app, window title,
//! URL, selected text, the focused window's AX text — and every one of them
//! used to clamp with a bare `chars().take(n)`. That silently drops the tail
//! mid-sentence, tells the model nothing was cut, and lets one oversized field
//! crowd out the rest. This module replaces those clamps with:
//!
//! * per-field budgets, spent in priority order out of one shared total, so a
//!   huge selection can't starve the AX text (or vice versa);
//! * line-aligned truncation: the cut backs up to the last newline when one
//!   sits within the final 20% of the budget, so the model gets whole lines;
//! * an explicit `[… <label> truncated: N characters omitted]` marker, so the
//!   model knows more exists rather than assuming the text simply ended.
//!
//! All sizes are in `char`s (not bytes) so CJK text is budgeted the same as
//! ASCII.

/// Per-field caps shared by every on-demand path. Small metadata fields get
/// fixed caps; the big free-text fields get budgets that also compete for the
/// shared total (see [`Budget`]).
pub const APP_CHARS: usize = 80;
pub const TITLE_CHARS: usize = 200;
pub const URL_CHARS: usize = 500;
pub const SELECTION_CHARS: usize = 4_000;
pub const VISIBLE_TEXT_CHARS: usize = 8_000;
/// Total for one attached context block. Sized so selection + AX text both fit
/// in full at their own caps with room for metadata; the total only bites when
/// a caller raises a field budget above its default.
pub const TOTAL_CHARS: usize = 16_000;

/// Marker appended when a field was cut. The label names the field so a prompt
/// with several truncated fields still reads unambiguously.
pub fn marker(label: &str, omitted: usize) -> String {
    format!("[… {label} truncated: {omitted} characters omitted]")
}

/// Truncate `text` to at most `max_chars` chars, preferring a line boundary,
/// and append a marker naming what was cut. Returns the text unchanged when it
/// already fits. The marker is not counted against `max_chars` — it is short,
/// bounded, and callers care about the budget of *content*.
pub fn clip_lines(text: &str, max_chars: usize, label: &str) -> String {
    let total = text.chars().count();
    if total <= max_chars {
        return text.to_string();
    }
    if max_chars == 0 {
        return marker(label, total);
    }
    // Byte offset of the char boundary at `max_chars`.
    let cut_byte = text
        .char_indices()
        .nth(max_chars)
        .map(|(i, _)| i)
        .unwrap_or(text.len());
    let head = &text[..cut_byte];
    // Back up to a newline if one sits in the final 20% of the budget — whole
    // lines read better than a mid-line cut, but not at the cost of most of it.
    let floor_chars = max_chars - max_chars / 5;
    let mut keep = head;
    if let Some(nl) = head.rfind('\n') {
        if head[..nl].chars().count() >= floor_chars {
            keep = &head[..nl];
        }
    }
    let keep = keep.trim_end();
    let kept = keep.chars().count();
    let omitted = total - kept;
    if keep.is_empty() {
        marker(label, total)
    } else {
        format!("{keep}\n{}", marker(label, omitted))
    }
}

/// Truncate a single-line field (title, URL, app name): no newline search, an
/// inline marker so the field stays one line.
pub fn clip_flat(text: &str, max_chars: usize) -> String {
    let total = text.chars().count();
    if total <= max_chars {
        return text.to_string();
    }
    let head: String = text.chars().take(max_chars).collect();
    format!(
        "{} [… {} characters omitted]",
        head.trim_end(),
        total - max_chars
    )
}

/// One shared pool of characters that fields draw from in priority order. Each
/// [`take`](Budget::take) is capped by both the field's own budget and what is
/// left in the pool, so callers list fields most-important-first and the tail
/// fields absorb the squeeze.
pub struct Budget {
    remaining: usize,
}

impl Budget {
    pub fn new(total: usize) -> Self {
        Self { remaining: total }
    }

    #[cfg(test)]
    pub fn remaining(&self) -> usize {
        self.remaining
    }

    /// Spend up to `field_budget` chars of the pool on `text`, truncating with
    /// [`clip_lines`]. Returns None when `text` is blank or the pool is empty —
    /// callers then omit the field entirely rather than emitting a bare marker.
    pub fn take(&mut self, text: &str, field_budget: usize, label: &str) -> Option<String> {
        let text = text.trim();
        if text.is_empty() {
            return None;
        }
        let cap = field_budget.min(self.remaining);
        if cap == 0 {
            return None;
        }
        let out = clip_lines(text, cap, label);
        self.remaining = self.remaining.saturating_sub(out.chars().count().min(cap));
        Some(out)
    }

    /// Single-line variant of [`take`](Budget::take) for metadata fields.
    pub fn take_flat(&mut self, text: &str, field_budget: usize) -> Option<String> {
        let text = text.trim();
        if text.is_empty() {
            return None;
        }
        let cap = field_budget.min(self.remaining);
        if cap == 0 {
            return None;
        }
        let out = clip_flat(text, cap);
        self.remaining = self.remaining.saturating_sub(out.chars().count().min(cap));
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fits_unchanged() {
        assert_eq!(clip_lines("a\nb\nc", 10, "x"), "a\nb\nc");
        assert_eq!(clip_flat("hello", 5), "hello");
    }

    #[test]
    fn cuts_on_line_boundary_when_close() {
        // 100-char budget; a newline at char 90 (within the last 20%) wins.
        let text = format!("{}\n{}", "a".repeat(90), "b".repeat(50));
        let out = clip_lines(&text, 100, "sel");
        assert!(out.starts_with(&"a".repeat(90)));
        assert!(out.ends_with("[… sel truncated: 51 characters omitted]")); // 50 b + the newline
        assert!(!out.contains('b'));
    }

    #[test]
    fn ignores_early_newline() {
        // Newline at char 10 is far below the 80% floor — cut mid-line instead.
        let text = format!("{}\n{}", "a".repeat(10), "b".repeat(200));
        let out = clip_lines(&text, 100, "sel");
        assert!(out.contains('b'));
        assert!(out.ends_with("[… sel truncated: 111 characters omitted]"));
    }

    #[test]
    fn counts_chars_not_bytes() {
        let text = "汉".repeat(30);
        let out = clip_lines(&text, 10, "t");
        assert!(out.starts_with(&"汉".repeat(10)));
        assert!(out.contains("20 characters omitted"));
    }

    #[test]
    fn budget_squeezes_tail_fields() {
        let mut b = Budget::new(100);
        let first = b.take(&"x".repeat(80), 80, "first").unwrap();
        assert_eq!(first.chars().count(), 80);
        let second = b.take(&"y".repeat(80), 80, "second").unwrap();
        assert!(second.starts_with(&"y".repeat(20)));
        assert!(second.contains("60 characters omitted"));
        assert!(b.take("z", 10, "third").is_none());
    }

    #[test]
    fn blank_fields_are_skipped() {
        let mut b = Budget::new(100);
        assert!(b.take("   ", 50, "sel").is_none());
        assert_eq!(b.remaining(), 100);
    }
}
