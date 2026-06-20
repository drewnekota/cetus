//! Recognition biasing for the Doubao/Seed-ASR engine.
//!
//! Assembles a [`crate::doubao::Corpus`] — a small set of boosted **hotwords**
//! plus a short free-text **context** — so recognition favors the user's
//! vocabulary and what they're currently writing, the way 豆包输入法 leans on
//! context. Four sources feed it (all behind the `voice_context_biasing` setting,
//! off by default):
//!
//! 1. **User word list** — a manual newline list in settings (highest priority).
//! 2. **Learned terms** — distinctive words harvested from past cleaned
//!    transcripts ([`harvest`]); the cetus-appropriate form of "learn from
//!    corrections", since once we type into another app we can't see edits, but
//!    we *can* see what the cleanup pass settled on.
//! 3. **Agent memory** — distinctive terms pulled from the persistent notes.
//! 4. **Focused field** — a short snippet of the text the user is writing right
//!    now, read via the Accessibility API (best-effort; see [`focused_snippet`]).
//!
//! The inline corpus shares a small (~200-token) budget on the wire, so every
//! source is aggressively capped. An empty result makes the request byte-for-byte
//! identical to the un-biased one (see `Corpus::is_empty`).

use crate::doubao::Corpus;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// Max boosted words per request. Small on purpose: the inline corpus budget is
/// tight (~100 tokens for 热词直传 on the bidirectional streaming endpoint) and
/// a long list dilutes the bias (raises false triggers).
const MAX_HOTWORDS: usize = 24;
/// Hotword length window (chars). The API documents "<10 chars" per hotword, and
/// 1-char tokens are noise — so keep 2..=10.
const MIN_HOTWORD_CHARS: usize = 2;
const MAX_HOTWORD_CHARS: usize = 10;
/// Tail of the focused field we send as `dialog_ctx` context.
const MAX_CONTEXT_CHARS: usize = 100;
/// A learned term must be heard at least this many times before it's boosted, so
/// a one-off mishearing never becomes a permanent bias.
const LEARN_MIN_COUNT: u32 = 2;
/// Cap on the learned store so it can't grow without bound.
const MAX_LEARNED_TERMS: usize = 200;
/// Cap on distinct tokens pulled from one text, so a pathologically long input
/// can't balloon the intermediate map before [`prune`] re-bounds the store.
const MAX_TOKENS_PER_TEXT: usize = 64;

const LEARNED_FILE: &str = "learned_hotwords.json";

/// Serializes read-modify-write cycles on the learned store: `harvest` (after
/// each dictation) and `unlearn` (from the corrections watcher) can land close
/// together, and last-write-wins would silently drop one side's update.
fn learned_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Build the recognition corpus from all enabled sources. Cheap and infallible —
/// any source that errors simply contributes nothing.
pub fn build(app_data_dir: &Path, manual: &str) -> Corpus {
    let mut hotwords: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    // 1. Manual list — highest priority, added first so it always survives the cap.
    for line in manual.lines() {
        add_hotword(&mut hotwords, &mut seen, line);
    }
    let n_manual = hotwords.len();
    // 2. Correction-confirmed terms — words the user demonstrably fixed by hand
    // (see `corrections.rs`); the strongest learned signal we have.
    for word in crate::corrections::terms(app_data_dir) {
        add_hotword(&mut hotwords, &mut seen, &word);
    }
    let n_corrections = hotwords.len() - n_manual;
    // 3. Learned terms (most-heard first).
    for word in learned_terms(app_data_dir) {
        add_hotword(&mut hotwords, &mut seen, &word);
    }
    let n_learned = hotwords.len() - n_manual - n_corrections;
    // 4. Agent memory.
    for word in memory_terms(app_data_dir) {
        add_hotword(&mut hotwords, &mut seen, &word);
    }
    let n_memory = hotwords.len() - n_manual - n_corrections - n_learned;

    // 5. Live context: what the user is writing in the focused field.
    let context = focused_snippet(MAX_CONTEXT_CHARS);

    tracing::debug!(
        "biasing: hotwords ({} = manual {n_manual} + corrections {n_corrections} + learned {n_learned} + memory {n_memory}): {hotwords:?}",
        hotwords.len()
    );
    match &context {
        Some(c) => tracing::debug!(
            "biasing: focused-field context ({} chars): {:?}",
            c.chars().count(),
            c
        ),
        None => tracing::debug!("biasing: no focused-field context (unreadable role or empty)"),
    }

    // `recent` (prior dictation) and `boosting_table_id` (server-side table) are
    // filled in by the caller — they need the transcript store / settings.
    Corpus {
        hotwords,
        context,
        ..Default::default()
    }
}

/// Learn distinctive terms from a (cleaned) transcript so future recognition is
/// biased toward the user's actual vocabulary. Best-effort; a write failure is
/// swallowed. Call with the final text the user accepted.
pub fn harvest(app_data_dir: &Path, text: &str) {
    let tokens = distinctive_tokens(text);
    if tokens.is_empty() {
        return;
    }
    let path = learned_path(app_data_dir);
    let _guard = learned_lock().lock().unwrap();
    let mut store = read_learned(&path);
    for tok in tokens {
        let key = tok.to_lowercase();
        let entry = store.terms.entry(key).or_insert_with(|| LearnedTerm {
            word: tok.clone(),
            count: 0,
        });
        entry.count = entry.count.saturating_add(1);
        // Prefer a capitalized rendering if we've seen one — proper nouns read
        // better to the model as "DeepSeek" than "deepseek".
        if tok.chars().next().is_some_and(|c| c.is_uppercase()) {
            entry.word = tok.clone();
        }
    }
    prune(&mut store);
    let _ = write_learned(&path, &store);
}

// ---------------------------------------------------------------------------
// Hotword assembly
// ---------------------------------------------------------------------------

/// Normalize and append a candidate hotword, deduped case-insensitively and
/// bounded by [`MAX_HOTWORDS`]. Strips an optional `|weight` suffix (table-file
/// syntax) so we never bias toward the literal string "term|8".
fn add_hotword(out: &mut Vec<String>, seen: &mut HashSet<String>, raw: &str) {
    if out.len() >= MAX_HOTWORDS {
        return;
    }
    let word = raw.split('|').next().unwrap_or(raw).trim();
    let n = word.chars().count();
    if !(MIN_HOTWORD_CHARS..=MAX_HOTWORD_CHARS).contains(&n) {
        return;
    }
    let key = word.to_lowercase();
    if seen.insert(key) {
        out.push(word.to_string());
    }
}

/// Drop a term from the learned store — called when the corrections loop
/// confirms it was a mishearing, so the old harvest can't keep boosting it.
pub fn unlearn(app_data_dir: &Path, term: &str) {
    let path = learned_path(app_data_dir);
    let _guard = learned_lock().lock().unwrap();
    let mut store = read_learned(&path);
    if store.terms.remove(&term.to_lowercase()).is_some() {
        let _ = write_learned(&path, &store);
    }
}

/// Tail of the focused field's text, for the post-insertion correction learner
/// (`corrections.rs`). Same best-effort AX read as the biasing snippet.
pub(crate) fn focused_tail(max_chars: usize) -> Option<String> {
    focused_snippet(max_chars)
}

/// Learned terms whose count cleared the threshold, most-heard first.
fn learned_terms(app_data_dir: &Path) -> Vec<String> {
    let store = read_learned(&learned_path(app_data_dir));
    let mut terms: Vec<&LearnedTerm> = store
        .terms
        .values()
        .filter(|t| t.count >= LEARN_MIN_COUNT)
        .collect();
    terms.sort_by(|a, b| b.count.cmp(&a.count));
    terms.into_iter().map(|t| t.word.clone()).collect()
}

/// Distinctive terms mined from the user's persistent memory notes.
fn memory_terms(app_data_dir: &Path) -> Vec<String> {
    let state = crate::memory::snapshot(app_data_dir);
    if !state.enabled {
        return Vec::new();
    }
    let mut out = Vec::new();
    for entry in state.entries.iter().filter(|e| e.enabled) {
        out.extend(distinctive_tokens(&entry.content));
    }
    out
}

// ---------------------------------------------------------------------------
// Tokenizer — distinctive terms worth boosting (English jargon + Chinese names)
// ---------------------------------------------------------------------------

/// Pull out distinctive terms worth boosting from a piece of text. Two scripts,
/// two strategies:
/// - **Latin** (English jargon, brand/product names) via [`ascii_terms`] — a
///   cheap split on non-alphanumerics; no segmenter needed.
/// - **Chinese** (人名/地名/机构/专名) via [`chinese_terms`] — zh has no spaces, so
///   a segmenter + POS tags are required to isolate a term from a sentence.
///
/// These are exactly the words zh/en code-switch ASR mishears most, on both sides
/// of the switch. The combined list is re-bounded to [`MAX_TOKENS_PER_TEXT`].
fn distinctive_tokens(text: &str) -> Vec<String> {
    let mut tokens = ascii_terms(text);
    for word in chinese_terms(text) {
        if tokens.len() >= MAX_TOKENS_PER_TEXT {
            break;
        }
        tokens.push(word);
    }
    tokens
}

/// Latin-alphanumeric runs of 2..=10 chars that contain a letter, aren't pure
/// numbers, and aren't common words — English jargon and product names.
fn ascii_terms(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for raw in text.split(|c: char| !c.is_ascii_alphanumeric()) {
        if tokens.len() >= MAX_TOKENS_PER_TEXT {
            break;
        }
        let n = raw.chars().count();
        if !(MIN_HOTWORD_CHARS..=MAX_HOTWORD_CHARS).contains(&n) {
            continue;
        }
        if !raw.chars().any(|c| c.is_ascii_alphabetic()) {
            continue; // pure numbers / version-ish noise
        }
        let lower = raw.to_lowercase();
        if STOPWORDS.contains(&lower.as_str()) {
            continue;
        }
        if seen.insert(lower) {
            tokens.push(raw.to_string());
        }
    }
    tokens
}

/// POS tags jieba assigns to proper nouns — the terms ASR gets wrong and the
/// user is least likely to hand-enter: 人名 / 地名 / 机构 / 其他专名 (and the
/// translated/foreign-name variants). We deliberately skip plain nouns (`n`) —
/// they're common-vocabulary words the model already knows.
const PROPER_NOUN_TAGS: &[&str] = &["nr", "nrt", "nrfg", "ns", "nt", "nz"];

/// Mine distinctive Chinese proper nouns to boost, via segmentation + POS tags.
/// Keeps 2..=[`MAX_HOTWORD_CHARS`]-char terms tagged as a proper noun and
/// containing at least one CJK character. The dictionary loads once, lazily.
fn chinese_terms(text: &str) -> Vec<String> {
    use once_cell::sync::Lazy;
    static JIEBA: Lazy<jieba_rs::Jieba> = Lazy::new(jieba_rs::Jieba::new);

    // Cheap bail: nothing to segment if there's no CJK at all (the common
    // English-only transcript), so we never pay segmentation on it.
    if !text.chars().any(is_cjk) {
        return Vec::new();
    }
    let mut tokens = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for tag in JIEBA.tag(text, true) {
        if tokens.len() >= MAX_TOKENS_PER_TEXT {
            break;
        }
        if !PROPER_NOUN_TAGS.contains(&tag.tag) {
            continue;
        }
        let word = tag.word.trim();
        let n = word.chars().count();
        if !(MIN_HOTWORD_CHARS..=MAX_HOTWORD_CHARS).contains(&n) {
            continue;
        }
        if !word.chars().any(is_cjk) {
            continue; // Latin proper nouns are covered by `ascii_terms`.
        }
        if seen.insert(word.to_string()) {
            tokens.push(word.to_string());
        }
    }
    tokens
}

/// True for the common CJK Unified Ideographs block — enough to tell "this text
/// has Chinese in it" and to reject Latin-only jieba tokens.
fn is_cjk(c: char) -> bool {
    ('\u{4e00}'..='\u{9fff}').contains(&c)
}

/// Common English words we never want to learn as hotwords. Small on purpose —
/// just the high-frequency function words that survive the length filter.
const STOPWORDS: &[&str] = &[
    "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "her", "was", "one",
    "our", "out", "day", "get", "has", "him", "his", "how", "man", "new", "now", "old", "see",
    "two", "way", "who", "boy", "did", "its", "let", "put", "say", "she", "too", "use", "that",
    "this", "with", "have", "from", "they", "will", "would", "there", "their", "what", "about",
    "which", "when", "make", "like", "time", "just", "know", "take", "into", "your", "some",
    "could", "them", "than", "then", "look", "only", "come", "over", "also", "back", "after",
    "want", "because", "good", "much", "where", "very", "well", "should", "okay", "yeah", "gonna",
    "really", "thing", "things", "something", "anything", "everything",
];

// ---------------------------------------------------------------------------
// Learned-term store (JSON under the app data dir)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LearnedTerm {
    word: String,
    count: u32,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct LearnedStore {
    #[serde(default)]
    version: u32,
    /// lowercased term → record (display casing + count).
    #[serde(default)]
    terms: HashMap<String, LearnedTerm>,
}

fn learned_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(LEARNED_FILE)
}

fn read_learned(path: &Path) -> LearnedStore {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Atomic write (temp file + rename) so a crash mid-write can't corrupt the store.
/// The temp name is unique per write so two overlapping writers can't clobber each
/// other's temp file (PTT is serial today, but this removes the only race window).
fn write_learned(path: &Path, store: &LearnedStore) -> std::io::Result<()> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let json = serde_json::to_string_pretty(store)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("{}.{n}.tmp", std::process::id()));
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)
}

/// Keep the store bounded: when it overflows, drop the lowest-count terms.
fn prune(store: &mut LearnedStore) {
    if store.terms.len() <= MAX_LEARNED_TERMS {
        return;
    }
    let mut by_count: Vec<(String, u32)> =
        store.terms.iter().map(|(k, v)| (k.clone(), v.count)).collect();
    by_count.sort_by(|a, b| b.1.cmp(&a.1));
    let keep: HashSet<String> = by_count
        .into_iter()
        .take(MAX_LEARNED_TERMS)
        .map(|(k, _)| k)
        .collect();
    store.terms.retain(|k, _| keep.contains(k));
}

// ---------------------------------------------------------------------------
// Focused-field context via the Accessibility API (macOS)
// ---------------------------------------------------------------------------

/// A short tail of the text in the currently-focused field — "what the user is
/// writing right now" — for use as dictation context. Best-effort and totally
/// silent: returns `None` on any failure, on non-text or password fields, or
/// without Accessibility trust. NEVER panics (it must never take down the host).
#[cfg(target_os = "macos")]
fn focused_snippet(max_chars: usize) -> Option<String> {
    use accessibility_sys::{
        kAXChildrenAttribute, kAXErrorSuccess, kAXFocusedUIElementAttribute, kAXRoleAttribute,
        kAXSelectedTextAttribute, kAXSubroleAttribute, kAXValueAttribute, AXIsProcessTrusted,
        AXUIElementCopyAttributeValue, AXUIElementCreateSystemWide, AXUIElementRef,
        AXUIElementSetMessagingTimeout,
    };
    use core_foundation::array::{
        CFArrayGetCount, CFArrayGetTypeID, CFArrayGetValueAtIndex, CFArrayRef,
    };
    use core_foundation::base::{CFGetTypeID, CFType, CFTypeRef, TCFType};
    use core_foundation::string::{CFString, CFStringRef};
    use std::ptr;

    // Copy an attribute as a managed CFType (Create Rule → released on drop).
    unsafe fn copy_attr(el: AXUIElementRef, attr: &str) -> Option<CFType> {
        let mut out: CFTypeRef = ptr::null();
        let key = CFString::new(attr);
        let err = AXUIElementCopyAttributeValue(el, key.as_concrete_TypeRef(), &mut out);
        if err != kAXErrorSuccess || out.is_null() {
            return None;
        }
        Some(CFType::wrap_under_create_rule(out))
    }

    // Copy a string attribute, rejecting non-string AXValue/CFNumber/etc. types.
    unsafe fn copy_string(el: AXUIElementRef, attr: &str) -> Option<String> {
        let v = copy_attr(el, attr)?;
        if CFGetTypeID(v.as_CFTypeRef()) != CFString::type_id() {
            return None;
        }
        let s: CFString = CFString::wrap_under_get_rule(v.as_CFTypeRef() as CFStringRef);
        Some(s.to_string())
    }

    // An element's own editable text: the whole value (so the correction re-read
    // sees the full field, not just a stray selection), the active selection as a
    // fallback for elements that only expose that.
    unsafe fn own_text(el: AXUIElementRef) -> Option<String> {
        copy_string(el, kAXValueAttribute)
            .filter(|s| !s.trim().is_empty())
            .or_else(|| {
                copy_string(el, kAXSelectedTextAttribute).filter(|s| !s.trim().is_empty())
            })
    }

    // Append leaf text from `el`'s subtree into `out`, in reading order. A node
    // with its own non-empty value is a text leaf (take it, don't recurse —
    // children just re-expose the same runs); otherwise descend. Bounded three
    // ways — character budget, node budget (each node is one AX round-trip), and
    // depth — because a focused web area can be a whole document and every read
    // costs an IPC. Each element gets its own messaging timeout: only the root
    // inherited the 0.25s bound, children default to the ~6s global otherwise.
    unsafe fn gather(
        el: AXUIElementRef,
        out: &mut String,
        chars_left: &mut usize,
        nodes_left: &mut usize,
        depth: usize,
    ) {
        if *chars_left == 0 || *nodes_left == 0 || depth > 6 {
            return;
        }
        *nodes_left -= 1;
        AXUIElementSetMessagingTimeout(el, 0.25);
        if let Some(t) = own_text(el) {
            for c in t.trim().chars() {
                if *chars_left == 0 {
                    break;
                }
                out.push(c);
                *chars_left -= 1;
            }
            if *chars_left > 0 {
                out.push(' ');
                *chars_left -= 1;
            }
            return;
        }
        let Some(children) = copy_attr(el, kAXChildrenAttribute) else {
            return;
        };
        if CFGetTypeID(children.as_CFTypeRef()) != CFArrayGetTypeID() {
            return;
        }
        let arr = children.as_CFTypeRef() as CFArrayRef;
        let count = CFArrayGetCount(arr);
        for i in 0..count {
            if *chars_left == 0 || *nodes_left == 0 {
                break;
            }
            let child = CFArrayGetValueAtIndex(arr, i) as AXUIElementRef;
            if !child.is_null() {
                gather(child, out, chars_left, nodes_left, depth + 1);
            }
        }
    }

    if !unsafe { AXIsProcessTrusted() } {
        return None;
    }
    unsafe {
        let sys_ref = AXUIElementCreateSystemWide();
        if sys_ref.is_null() {
            return None;
        }
        let sys = CFType::wrap_under_create_rule(sys_ref as CFTypeRef);
        let sys_el = sys.as_CFTypeRef() as AXUIElementRef;
        // Bound EVERY round-trip, including the focused-element lookup below (which
        // is already routed to the focused app's process) — otherwise that first
        // call uses the ~6s global default and a frozen app stalls us that long.
        AXUIElementSetMessagingTimeout(sys_el, 0.25);

        let focused = copy_attr(sys_el, kAXFocusedUIElementAttribute)?;
        let focused_el = focused.as_CFTypeRef() as AXUIElementRef;
        // Re-bound on the focused element itself for the role/value reads.
        AXUIElementSetMessagingTimeout(focused_el, 0.25);

        let role = copy_string(focused_el, kAXRoleAttribute).unwrap_or_default();
        let subrole = copy_string(focused_el, kAXSubroleAttribute).unwrap_or_default();
        // Never read a secure (password) field, whatever its role looks like.
        if role == "AXSecureTextField" || subrole == "AXSecureTextField" {
            return None;
        }

        // 1) The focused element's own text — covers native fields and standard
        //    web <input>/<textarea> (a real text role with a populated value).
        let mut text = own_text(focused_el);

        // 2) Empty value? Rich/contenteditable web composers (Slack, Discord,
        //    ChatGPT, Notion…) focus an editable root that exposes no AXValue and
        //    keep the text in descendant AXStaticText nodes — that's the bulk of
        //    the "focused field unreadable" misses. Crawl the subtree for them,
        //    gated to container-ish roles so we never sweep a focused button/list.
        if text.is_none() {
            let descend = subrole == "AXContentEditable"
                || matches!(
                    role.as_str(),
                    "AXTextArea"
                        | "AXTextField"
                        | "AXComboBox"
                        | "AXScrollArea"
                        | "AXGroup"
                        | "AXWebArea"
                        | "AXUnknown"
                        | ""
                );
            if descend {
                let mut buf = String::new();
                let mut chars_left = max_chars.saturating_mul(2).max(256);
                let mut nodes_left = 250usize;
                gather(focused_el, &mut buf, &mut chars_left, &mut nodes_left, 0);
                let buf = buf.trim();
                if !buf.is_empty() {
                    text = Some(buf.to_string());
                }
            }
        }

        let Some(text) = text else {
            tracing::debug!("focused_snippet: no readable text (role {role:?}, subrole {subrole:?})");
            return None;
        };
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return None;
        }
        // Keep the tail nearest the caret.
        let tail: Vec<char> = trimmed.chars().rev().take(max_chars).collect();
        Some(tail.into_iter().rev().collect())
    }
}

#[cfg(not(target_os = "macos"))]
fn focused_snippet(_max_chars: usize) -> Option<String> {
    None
}
