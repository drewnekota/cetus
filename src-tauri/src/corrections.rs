//! Learn from the user's post-insertion edits — the correction loop.
//!
//! After global dictation types its text into the focused app, the user often
//! fixes a misheard name by hand ("权利" → "全联", "Deep Seek" → "DeepSeek").
//! Best-in-class dictation apps mine exactly that signal: we re-read the
//! focused field (Accessibility API) a beat after insertion, diff what we
//! inserted against what's there now, and record small word-level
//! substitutions as wrong→right pairs. A pair seen [`MIN_COUNT`] times becomes
//! active: it is auto-applied to future transcripts, its right side is boosted
//! as an ASR hotword, and its wrong side is purged from the harvested-hotword
//! store (so the old self-learned-error loop can't re-entrench it).
//!
//! This replaces learning from our own output as the personalization signal —
//! the user's hands are ground truth; the cleanup model is not.
//!
//! Guard rails against learning garbage:
//! - The target is fingerprinted right after insertion (frontmost bundle id +
//!   the field must actually contain the inserted text) and re-checked before
//!   mining; a focus change or another dictation in the window aborts.
//! - Substitution pairs are sliced from the ORIGINAL strings (so "it's" stays
//!   "it's", never a token-joined "it s").
//! - CJK pairs need ≥2 chars per side — single-char swaps (的→地, 他→她) are
//!   grammar edits, not recognition fixes, and would corrupt future text.
//!
//! Storage mirrors `biasing.rs`: one JSON file under the app data dir, atomic
//! writes behind a process-wide lock, best-effort everywhere (a failure here
//! must never affect dictation).

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

const FILE: &str = "corrections.json";
/// A pair must be observed this many times before it's auto-applied. ASR hotword
/// biasing starts after the first tightly-classified edit, while this higher bar
/// prevents a one-off change of mind from becoming a standing rewrite rule.
const MIN_COUNT: u32 = 2;
/// Store ceiling; lowest-count, oldest pairs are dropped past this.
const MAX_PAIRS: usize = 200;
/// Per-side length ceiling (chars). Corrections are word-level; anything longer
/// is a rewrite, not a recognition fix.
const MAX_SIDE_CHARS: usize = 10;
/// Most substitutions a single session may contribute — a heavily edited field
/// means the user rewrote the text, not that recognition made 30 word errors.
const MAX_PAIRS_PER_SESSION: usize = 5;
/// Maximum time to establish the post-insertion fingerprint. Rich editors may
/// need a beat to rebuild their accessibility tree after synthetic typing.
const FINGERPRINT_WINDOW_MS: u64 = 3_000;
/// Observe edits for this long after the field fingerprint is established.
const WATCH_WINDOW_SECS: u64 = 18;
/// Debounce after a real user key event so IME/autocorrect can finish committing.
const EDIT_DEBOUNCE_MS: u64 = 450;
/// Even when the global event tap is unavailable, periodically re-read so the
/// feature still works with paste menus, dictation, or accessibility actions.
const FALLBACK_RECHECK_MS: u64 = 2_000;
/// How much of the field value we read (tail). Bounded so diffing stays cheap
/// and we never sweep up a whole document.
const FIELD_TAIL_CHARS: usize = 4000;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Pair {
    wrong: String,
    right: String,
    count: u32,
    /// Last time this pair was observed (ms since epoch) — recency tiebreak.
    #[serde(default)]
    last_ms: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    pairs: Vec<Pair>,
}

fn store_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(FILE)
}

/// Serializes read-modify-write cycles on the store (several watcher tasks can
/// land close together; last-write-wins would drop counts).
fn file_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn read_store(path: &Path) -> Store {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_store(path: &Path, store: &Store) -> std::io::Result<()> {
    let json = serde_json::to_string_pretty(store)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Apply every active (count ≥ [`MIN_COUNT`]) correction pair to `text`.
/// Longest `wrong` first so an overlapping shorter pair can't clobber a longer
/// match. ASCII pairs replace on word boundaries (case-insensitive match,
/// never inside URL/email/path-like runs); CJK pairs replace verbatim.
pub fn apply(app_data_dir: &Path, text: &str) -> String {
    let store = read_store(&store_path(app_data_dir));
    let mut active: Vec<&Pair> = store
        .pairs
        .iter()
        .filter(|p| p.count >= MIN_COUNT)
        .collect();
    if active.is_empty() {
        return text.to_string();
    }
    active.sort_by_key(|p| std::cmp::Reverse(p.wrong.chars().count()));
    let mut out = text.to_string();
    for p in active {
        let next = if p.wrong.is_ascii() {
            replace_ascii_word(&out, &p.wrong, &p.right)
        } else {
            out.replace(&p.wrong, &p.right)
        };
        if next != out {
            tracing::debug!(
                "corrections: applied {:?} → {:?} (count {})",
                p.wrong,
                p.right,
                p.count
            );
        }
        out = next;
    }
    out
}

/// Right-hand sides of observed pairs, most recently confirmed first. A single
/// tightly-classified edit is enough to bias ASR toward the user's spelling;
/// replaying wrong→right in [`apply`] remains gated on [`MIN_COUNT`] so a
/// one-off content edit can never become an automatic rewrite rule.
pub fn terms(app_data_dir: &Path) -> Vec<String> {
    let store = read_store(&store_path(app_data_dir));
    let mut observed: Vec<&Pair> = store.pairs.iter().collect();
    observed.sort_by_key(|p| std::cmp::Reverse(p.last_ms));
    let mut seen = HashSet::new();
    observed
        .iter()
        .map(|p| p.right.clone())
        .filter(|w| seen.insert(w.to_lowercase()))
        .collect()
}

/// Monotonic insertion counter: a watcher only mines if NO other dictation was
/// inserted during its window (a follow-up dictation into the same field would
/// otherwise diff two unrelated utterances into garbage pairs).
static INSERT_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Monotonic signal from the existing listen-only global event tap. It records
/// no key code or text — it only wakes an active correction watcher so AX/OCR
/// can be re-read promptly instead of waiting on a fixed ten-second timer.
static USER_INPUT_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn note_user_input() {
    USER_INPUT_GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

/// Watch one insertion: establish a cursor-aware field fingerprint, then re-read
/// promptly after user input (plus a slow fallback poll) and mine only edits
/// anchored to the inserted text. Fire-and-forget; the caller gates this on the
/// context-biasing setting because AX and optional local OCR read screen text.
pub fn watch_insertion(app: AppHandle, app_data_dir: PathBuf, inserted: String) {
    watch_insertion_impl(app, app_data_dir, inserted, None);
}

#[cfg(feature = "devtest")]
pub(crate) fn watch_insertion_target(
    app: AppHandle,
    app_data_dir: PathBuf,
    inserted: String,
    target: (String, String, i32),
) {
    watch_insertion_impl(app, app_data_dir, inserted, Some(target));
}

fn watch_insertion_impl(
    app: AppHandle,
    app_data_dir: PathBuf,
    inserted: String,
    target: Option<(String, String, i32)>,
) {
    use std::sync::atomic::Ordering;
    let trimmed = inserted.trim().to_string();
    // Tiny insertions ("ok") produce noise pairs, not corrections.
    if trimmed.chars().count() < 4 {
        return;
    }
    let gen = INSERT_GEN.fetch_add(1, Ordering::Relaxed) + 1;
    tokio::spawn(async move {
        let fingerprint_deadline =
            std::time::Instant::now() + std::time::Duration::from_millis(FINGERPRINT_WINDOW_MS);
        let initial = loop {
            if INSERT_GEN.load(Ordering::Relaxed) != gen {
                return;
            }
            let dir = app_data_dir.clone();
            let target = target.clone();
            let snapshot = tokio::task::spawn_blocking(move || {
                if let Some((app, bundle, pid)) = target {
                    crate::focused_text::capture_pid(app, bundle, pid, FIELD_TAIL_CHARS)
                } else {
                    crate::biasing::focused_snapshot(&dir, FIELD_TAIL_CHARS, true)
                }
            })
            .await
            .ok()
            .flatten();
            if let Some(snapshot) = snapshot {
                if snapshot.text().contains(&trimmed) {
                    tracing::debug!(
                        "corrections: fingerprinted {} via {} ({})",
                        snapshot.bundle_id,
                        snapshot.source,
                        snapshot.identifier
                    );
                    break snapshot;
                }
            }
            if std::time::Instant::now() >= fingerprint_deadline {
                tracing::debug!(
                    "corrections: inserted text could not be fingerprinted via AX/OCR; not mining"
                );
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        };

        let watch_deadline =
            std::time::Instant::now() + std::time::Duration::from_secs(WATCH_WINDOW_SECS);
        let mut seen_input = USER_INPUT_GEN.load(Ordering::Relaxed);
        let mut next_fallback =
            std::time::Instant::now() + std::time::Duration::from_millis(FALLBACK_RECHECK_MS);
        let mut last_edited: Option<String> = None;

        loop {
            if INSERT_GEN.load(Ordering::Relaxed) != gen {
                tracing::debug!("corrections: another dictation landed; watcher cancelled");
                return;
            }
            let now = std::time::Instant::now();
            if now >= watch_deadline {
                if let Some(edited) = last_edited {
                    crate::transcripts::amend(&app_data_dir, &trimmed, &edited);
                }
                tracing::debug!("corrections: watch window ended without a safe word-level fix");
                return;
            }

            let input = USER_INPUT_GEN.load(Ordering::Relaxed);
            let input_changed = input != seen_input;
            if !input_changed && now < next_fallback {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            }
            if input_changed {
                seen_input = input;
                tokio::time::sleep(std::time::Duration::from_millis(EDIT_DEBOUNCE_MS)).await;
                // More typing arrived during the debounce; wait for the new
                // quiet edge instead of sampling a half-committed IME edit.
                let latest = USER_INPUT_GEN.load(Ordering::Relaxed);
                if latest != seen_input {
                    seen_input = latest;
                    continue;
                }
            }
            next_fallback =
                std::time::Instant::now() + std::time::Duration::from_millis(FALLBACK_RECHECK_MS);

            let dir = app_data_dir.clone();
            let target = target.clone();
            let current = tokio::task::spawn_blocking(move || {
                if let Some((app, bundle, pid)) = target {
                    crate::focused_text::capture_pid(app, bundle, pid, FIELD_TAIL_CHARS)
                } else {
                    crate::biasing::focused_snapshot(&dir, FIELD_TAIL_CHARS, true)
                }
            })
            .await
            .ok()
            .flatten();
            let Some(current) = current else {
                continue;
            };
            if current.bundle_id != initial.bundle_id {
                tracing::debug!("corrections: focus moved to another app; watcher cancelled");
                return;
            }
            let low_confidence = initial.source == "screen-ocr" || current.source == "screen-ocr";
            if !low_confidence && !initial.same_target(&current) {
                tracing::debug!("corrections: focus moved to another field; watcher cancelled");
                return;
            }

            let field = current.text();
            if let Some(edited) = edited_span(&trimmed, &field) {
                last_edited = Some(edited);
            }
            let pairs = mine_pairs(&trimmed, &field);
            if pairs.is_empty() {
                continue;
            }
            // OCR is useful for otherwise invisible canvas/remote surfaces but
            // a full-screen diff is weaker evidence: accept only one compact
            // substitution, never a multi-pair rewrite.
            if low_confidence && pairs.len() != 1 {
                tracing::debug!("corrections: ambiguous OCR edit candidate rejected: {pairs:?}");
                continue;
            }
            if let Some(edited) = last_edited.as_deref() {
                crate::transcripts::amend(&app_data_dir, &trimmed, edited);
            }
            tracing::info!(
                "corrections: learned {} pair(s) via {}: {:?}",
                pairs.len(),
                current.source,
                pairs
            );
            let added = record(&app_data_dir, &pairs);
            if !added.is_empty() {
                crate::voice::show_dictionary_toast(&app, added);
            }
            return;
        }
    });
}

// ---------------------------------------------------------------------------
// Mining: inserted text vs the field's current state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Token {
    text: String,
    cjk: bool,
    /// Byte range in the source string, so substitution pairs can be sliced
    /// from the ORIGINAL text (preserving "it's" / "Deep-Seek" punctuation).
    start: usize,
    end: usize,
}

/// ASCII alphanumeric runs become one token each; every CJK char is its own
/// token (so 权利→全联 aligns at char granularity); everything else separates.
fn tokenize(text: &str) -> Vec<Token> {
    let mut out = Vec::new();
    let mut run_start: Option<usize> = None;
    for (i, c) in text.char_indices() {
        if c.is_ascii_alphanumeric() {
            if run_start.is_none() {
                run_start = Some(i);
            }
        } else {
            if let Some(s) = run_start.take() {
                out.push(Token {
                    text: text[s..i].to_string(),
                    cjk: false,
                    start: s,
                    end: i,
                });
            }
            if is_cjk(c) {
                out.push(Token {
                    text: c.to_string(),
                    cjk: true,
                    start: i,
                    end: i + c.len_utf8(),
                });
            }
        }
    }
    if let Some(s) = run_start {
        out.push(Token {
            text: text[s..].to_string(),
            cjk: false,
            start: s,
            end: text.len(),
        });
    }
    out
}

fn is_cjk(c: char) -> bool {
    ('\u{4e00}'..='\u{9fff}').contains(&c)
}

fn tok_eq(a: &Token, b: &Token) -> bool {
    if a.cjk || b.cjk {
        a.text == b.text
    } else {
        a.text.eq_ignore_ascii_case(&b.text)
    }
}

/// Token-level LCS alignment of the inserted text (`a`) against the field's
/// current content (`b`). `None` when either side is empty/oversized, or when
/// the inserted text is no longer substantially present — the user rewrote it
/// (or we read the wrong field) and nothing can be safely concluded.
struct Alignment {
    a: Vec<Token>,
    b: Vec<Token>,
    dp: Vec<Vec<u16>>,
}

fn align(inserted: &str, field: &str) -> Option<Alignment> {
    let a = tokenize(inserted); // what we typed
    let b = tokenize(field); // what the user kept
    if a.is_empty() || b.is_empty() || a.len() > 400 || b.len() > 3000 {
        return None;
    }
    let n = a.len();
    let m = b.len();
    let mut dp = vec![vec![0u16; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if tok_eq(&a[i], &b[j]) {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }
    if (dp[0][0] as usize) * 2 < n {
        return None;
    }
    Some(Alignment { a, b, dp })
}

/// Diff the inserted text against the field's current content and return
/// plausible recognition-fix substitutions (wrong → right).
fn mine_pairs(inserted: &str, field: &str) -> Vec<(String, String)> {
    // Untouched (or still present verbatim) → nothing to learn.
    if field.contains(inserted) {
        return Vec::new();
    }
    let Some(Alignment { a, b, dp }) = align(inserted, field) else {
        return Vec::new();
    };
    let n = a.len();
    let m = b.len();

    // Walk the alignment, collecting maximal mismatch runs on both sides.
    let mut pairs = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if tok_eq(&a[i], &b[j]) {
            i += 1;
            j += 1;
            continue;
        }
        let (si, sj) = (i, j);
        while i < n && j < m && !tok_eq(&a[i], &b[j]) {
            if dp[i + 1][j] >= dp[i][j + 1] {
                i += 1;
            } else {
                j += 1;
            }
        }
        if let Some(pair) = classify(&a[si..i], &b[sj..j], inserted, field) {
            pairs.push(pair);
            if pairs.len() >= MAX_PAIRS_PER_SESSION {
                break;
            }
        }
    }
    pairs
}

/// The field's current rendering of the inserted text — what the user's edits
/// turned the dictation into. Walks the same alignment as [`mine_pairs`] and
/// returns the field byte range spanning every token that lines up with the
/// inserted text: matches and substitutions stretch the span (anything between
/// them, including text the user typed in, rides along); leading/trailing
/// field-only tokens — the rest of the document — stay out. `None` when the
/// text is untouched, can't be located, or the span balloons past any
/// plausible edit (alignment latched onto scattered look-alike tokens).
fn edited_span(inserted: &str, field: &str) -> Option<String> {
    if field.contains(inserted) {
        return None; // untouched — nothing to amend
    }
    let Alignment { a, b, dp } = align(inserted, field)?;
    let n = a.len();
    let m = b.len();
    let mut start: Option<usize> = None;
    let mut end = 0usize;
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if tok_eq(&a[i], &b[j]) {
            start.get_or_insert(b[j].start);
            end = b[j].end;
            i += 1;
            j += 1;
            continue;
        }
        let (si, sj) = (i, j);
        while i < n && j < m && !tok_eq(&a[i], &b[j]) {
            if dp[i + 1][j] >= dp[i][j + 1] {
                i += 1;
            } else {
                j += 1;
            }
        }
        if i > si && j > sj {
            // Substitution: the field side of the run is the edited rendering.
            start.get_or_insert(b[sj].start);
            end = b[j - 1].end;
        }
    }
    let s = start?;
    if end <= s {
        return None;
    }
    // Tokens exclude punctuation, so a sentence-final 。/./! right after the
    // last aligned token belongs to the span — extend across any directly
    // attached punctuation run (stop at whitespace or the next word).
    for c in field[end..].chars() {
        if c.is_whitespace() || c.is_alphanumeric() {
            break;
        }
        end += c.len_utf8();
    }
    let edited = field[s..end].trim();
    if edited.is_empty() || edited == inserted {
        return None;
    }
    if edited.chars().count() > inserted.chars().count() * 2 + 80 {
        return None;
    }
    Some(edited.to_string())
}

/// Decide whether a mismatch run looks like a recognition fix (homophone swap,
/// spelling/casing fix) rather than the user changing their mind. The pair
/// text is sliced from the original strings so intra-run punctuation survives.
fn classify(
    wrong_run: &[Token],
    right_run: &[Token],
    inserted: &str,
    field: &str,
) -> Option<(String, String)> {
    if wrong_run.is_empty() || right_run.is_empty() {
        return None; // pure insertion/deletion — content change, not a fix
    }
    if wrong_run.len() > 3 || right_run.len() > 3 {
        return None;
    }
    let wrong = inserted[wrong_run[0].start..wrong_run[wrong_run.len() - 1].end].trim();
    let right = field[right_run[0].start..right_run[right_run.len() - 1].end].trim();
    if wrong.is_empty() || right.is_empty() || wrong == right {
        return None;
    }
    if wrong.chars().count() > MAX_SIDE_CHARS || right.chars().count() > MAX_SIDE_CHARS {
        return None;
    }
    let pure_cjk = |s: &str| s.chars().all(is_cjk);
    if pure_cjk(wrong) && pure_cjk(right) {
        // Chinese homophone swaps share no characters, so the filters are
        // length (同音替换 keeps roughly the same char count) and a ≥2-char
        // floor: single-char swaps (的→地, 他→她) are grammar/preference edits
        // that would corrupt future text if replayed globally.
        let (lw, lr) = (wrong.chars().count(), right.chars().count());
        if lw >= 2 && lr >= 2 && lw.abs_diff(lr) <= 1 {
            return Some((wrong.to_string(), right.to_string()));
        }
        return None;
    }
    if wrong.is_ascii() && right.is_ascii() {
        // Spelling/casing/spacing/punctuation fixes stay textually close.
        // One-character ASCII swaps are overwhelmingly content edits and are
        // too short for the hotword API anyway.
        if wrong.chars().count() < 2 || right.chars().count() < 2 {
            return None;
        }
        let dist = edit_distance(&wrong.to_lowercase(), &right.to_lowercase());
        let max_len = wrong.len().max(right.len());
        if dist <= (max_len / 2).max(2) {
            return Some((wrong.to_string(), right.to_string()));
        }
        return None;
    }
    None // mixed-script runs are usually content changes
}

fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for i in 1..=a.len() {
        cur[0] = i;
        for j in 1..=b.len() {
            let sub = prev[j - 1] + usize::from(a[i - 1] != b[j - 1]);
            cur[j] = sub.min(prev[j] + 1).min(cur[j - 1] + 1);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

// ---------------------------------------------------------------------------
// Store maintenance
// ---------------------------------------------------------------------------

fn record(app_data_dir: &Path, pairs: &[(String, String)]) -> Vec<String> {
    let path = store_path(app_data_dir);
    let _guard = file_lock().lock().unwrap();
    let mut store = read_store(&path);
    let known_terms: HashSet<String> = store.pairs.iter().map(|p| p.right.to_lowercase()).collect();
    let mut added = Vec::new();
    let now = crate::store::now_ms();
    for (wrong, right) in pairs {
        let existing = store.pairs.iter_mut().find(|p| {
            p.wrong.to_lowercase() == wrong.to_lowercase()
                && p.right.to_lowercase() == right.to_lowercase()
        });
        match existing {
            Some(p) => {
                p.count = p.count.saturating_add(1);
                p.last_ms = now;
                if p.count == MIN_COUNT {
                    // The pair just went active: stop boosting the wrong form
                    // that the old harvest loop may have learned.
                    crate::biasing::unlearn(app_data_dir, &p.wrong);
                }
            }
            None => {
                if !known_terms.contains(&right.to_lowercase())
                    && !added
                        .iter()
                        .any(|term: &String| term.eq_ignore_ascii_case(right))
                {
                    added.push(right.clone());
                }
                store.pairs.push(Pair {
                    wrong: wrong.clone(),
                    right: right.clone(),
                    count: 1,
                    last_ms: now,
                });
            }
        }
    }
    if store.pairs.len() > MAX_PAIRS {
        store
            .pairs
            .sort_by(|x, y| y.count.cmp(&x.count).then(y.last_ms.cmp(&x.last_ms)));
        store.pairs.truncate(MAX_PAIRS);
    }
    added.retain(|term| {
        store
            .pairs
            .iter()
            .any(|p| p.right.eq_ignore_ascii_case(term))
    });
    if let Err(e) = write_store(&path, &store) {
        tracing::warn!("corrections store write failed: {e}");
        return Vec::new();
    }
    added
}

/// Word-boundary, case-insensitive replacement for ASCII terms. "eric" inside
/// "generic" is never touched, and neither are URL/email/path-like runs
/// ("deepseek" in "deepseek.com" or "a@deepseek.io" stays put — only prose).
fn replace_ascii_word(text: &str, wrong: &str, right: &str) -> String {
    // ASCII-only lowercase of the byte stream: A-Z bytes are folded, every
    // other byte (incl. multi-byte UTF-8) is untouched — so byte offsets in
    // the haystack are valid in the original (str::to_lowercase can change
    // byte length and would make slicing panic).
    let lower_bytes: Vec<u8> = text.bytes().map(|b| b.to_ascii_lowercase()).collect();
    let lower_text = String::from_utf8(lower_bytes).unwrap_or_else(|_| text.to_string());
    let lower_wrong = wrong.to_ascii_lowercase();
    let bytes = text.as_bytes();
    // A boundary byte that glues the match to a larger token: identifier chars
    // and URL/email/path punctuation, plus a dot that continues into more
    // word characters ("deepseek.com" blocks; sentence-final "deepseek." not).
    let glued = |idx: Option<usize>, towards: isize| -> bool {
        let Some(i) = idx else { return false };
        let b = bytes[i];
        if b.is_ascii_alphanumeric() || matches!(b, b'@' | b'/' | b'\\' | b'_' | b'-') {
            return true;
        }
        if b == b'.' {
            let next = i.checked_add_signed(towards);
            return next
                .and_then(|n| bytes.get(n))
                .is_some_and(|nb| nb.is_ascii_alphanumeric());
        }
        false
    };
    let mut out = String::with_capacity(text.len());
    let mut idx = 0;
    while let Some(found) = lower_text[idx..].find(&lower_wrong) {
        let start = idx + found;
        let end = start + lower_wrong.len();
        let before_glued = glued(start.checked_sub(1), -1);
        let after_glued = end < bytes.len() && glued(Some(end), 1);
        out.push_str(&text[idx..start]);
        if before_glued || after_glued {
            out.push_str(&text[start..end]);
        } else {
            out.push_str(right);
        }
        idx = end;
        if idx >= text.len() {
            break;
        }
    }
    out.push_str(&text[idx..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mines_cjk_homophone_fix() {
        let pairs = mine_pairs("我去权利买东西然后回家", "我去全联买东西然后回家");
        assert_eq!(pairs, vec![("权利".to_string(), "全联".to_string())]);
    }

    #[test]
    fn rejects_single_char_cjk_swap() {
        // 的→地 is a grammar edit, not a recognition fix — must never be learned.
        assert!(mine_pairs("把图表改成蓝色的样子", "把图表改成红色的样子").is_empty());
    }

    #[test]
    fn mines_ascii_spelling_fix() {
        let pairs = mine_pairs(
            "please ping Deep Seek about the launch",
            "please ping DeepSeek about the launch",
        );
        assert_eq!(
            pairs,
            vec![("Deep Seek".to_string(), "DeepSeek".to_string())]
        );
    }

    #[test]
    fn rejects_one_character_ascii_swap() {
        assert!(mine_pairs("send it to A today", "send it to B today").is_empty());
    }

    #[test]
    fn slices_original_punctuation() {
        // The right side must come out as "let's", not a token-joined "let s".
        let pairs = mine_pairs("lets meet tomorrow at noon", "let's meet tomorrow at noon");
        assert_eq!(pairs, vec![("lets".to_string(), "let's".to_string())]);
    }

    #[test]
    fn ignores_full_rewrite() {
        let pairs = mine_pairs("我们明天下午三点开会", "完全不同的另一句话在这里");
        assert!(pairs.is_empty());
    }

    #[test]
    fn ignores_untouched() {
        assert!(mine_pairs("hello world", "prefix hello world suffix").is_empty());
    }

    #[test]
    fn edited_span_extracts_user_version() {
        // The dictation sits inside a larger document; the user fixed one word.
        // The amended history text must be the edited dictation WITH its final
        // punctuation, and without the surrounding document.
        let edited = edited_span(
            "我去权利买东西然后回家。",
            "上文在这里。我去全联买东西然后回家。下文继续",
        );
        assert_eq!(edited.as_deref(), Some("我去全联买东西然后回家。"));
    }

    #[test]
    fn edited_span_handles_rewrites_without_pairs() {
        // The user inserted words mid-sentence — no minable substitution pair,
        // but history should still pick up the reworked sentence.
        let edited = edited_span(
            "please ping Deep Seek about the launch",
            "ok. please ping Deep Seek directly about the launch now",
        );
        assert_eq!(
            edited.as_deref(),
            Some("please ping Deep Seek directly about the launch")
        );
    }

    #[test]
    fn edited_span_none_when_untouched() {
        assert!(edited_span("hello world", "prefix hello world suffix").is_none());
    }

    #[test]
    fn edited_span_none_on_full_rewrite() {
        assert!(edited_span("我们明天下午三点开会", "完全不同的另一句话在这里").is_none());
    }

    #[test]
    fn word_boundary_replace() {
        assert_eq!(
            replace_ascii_word("eric and generic", "eric", "Erik"),
            "Erik and generic"
        );
    }

    #[test]
    fn replace_skips_urls_and_emails() {
        assert_eq!(
            replace_ascii_word(
                "see deepseek.com or mail a@deepseek.io",
                "deepseek",
                "DeepSeek"
            ),
            "see deepseek.com or mail a@deepseek.io"
        );
        // Sentence-final dot is not a URL.
        assert_eq!(
            replace_ascii_word("ping deepseek. thanks", "deepseek", "DeepSeek"),
            "ping DeepSeek. thanks"
        );
    }

    #[test]
    fn replace_survives_non_ascii_haystack() {
        // to_lowercase()-based offsets would panic on mixed-width text.
        assert_eq!(
            replace_ascii_word("用 deepseek 跑 İstanbul 的测试", "deepseek", "DeepSeek"),
            "用 DeepSeek 跑 İstanbul 的测试"
        );
    }
}
