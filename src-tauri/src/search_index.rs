//! Backend content index for the ⌘K cross-conversation search.
//!
//! The frontend palette searches message text out of its IndexedDB render
//! cache, which only covers conversations this client has rendered and is
//! pruned of archived rows on every launch. This module keeps a SQLite FTS5
//! row per conversation (title + visible user/assistant prose) so archived
//! chats — and anything the render cache has lost — stay searchable by
//! content across restarts.
//!
//! Text comes from the same sources `export_conversation_transcript` reads:
//! the `cli_messages` table for CLI runtimes, the pi session JSONL for pi.
//! Rows are rebuilt whole (one conversation = one FTS row) at two points:
//! right after a CLI turn settles, and from a low-priority background sweep
//! that picks up whatever is stale — pi turns, forks, retries, and the
//! backfill of every conversation that predates the index.

use crate::store::{Conversation, Store};
use crate::AppState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Per-conversation cap on indexed prose. A trigram index is ~3x the text, so
/// bound the worst case; conversations this long are search-by-title anyway.
const MAX_BODY_CHARS: usize = 200_000;
/// Startup grace before the first sweep — keep the launch path quiet.
const STARTUP_GRACE: Duration = Duration::from_secs(20);
/// Rows per sweep batch and the pause between batches. A batch that came back
/// full means we're still backfilling, so the next one follows quickly.
const BATCH: u32 = 25;
const BUSY_TICK: Duration = Duration::from_secs(2);
const IDLE_TICK: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSearchHit {
    pub conversation: Conversation,
    /// Short window of body text around the first query token, or empty when
    /// only the title matched.
    pub snippet: String,
}

/// Visible prose of one PiMessage-shaped value: user + assistant text blocks
/// only. Thinking, tool calls and tool results are skipped — same reader-facing
/// scope as the palette's IndexedDB extractor and the transcript export.
fn message_text(msg: &serde_json::Value) -> Option<String> {
    let role = msg.get("role").and_then(|r| r.as_str())?;
    if role != "user" && role != "assistant" {
        return None;
    }
    let mut body = String::new();
    match msg.get("content") {
        Some(serde_json::Value::String(text)) => body.push_str(text),
        Some(serde_json::Value::Array(blocks)) => {
            for block in blocks {
                if block.get("type").and_then(|t| t.as_str()) != Some("text") {
                    continue;
                }
                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                    if !body.is_empty() {
                        body.push('\n');
                    }
                    body.push_str(text);
                }
            }
        }
        _ => {}
    }
    let body = if role == "user" {
        crate::commands::strip_prompt_blocks(&body)
    } else {
        body
    };
    let body = body.trim();
    if body.is_empty() {
        None
    } else {
        Some(body.to_string())
    }
}

fn join_capped(messages: &[serde_json::Value]) -> String {
    let mut out = String::new();
    let mut chars = 0usize;
    for m in messages {
        let Some(text) = message_text(m) else {
            continue;
        };
        if !out.is_empty() {
            out.push('\n');
        }
        let take = MAX_BODY_CHARS.saturating_sub(chars);
        if take == 0 {
            break;
        }
        let n = text.chars().count();
        if n > take {
            out.extend(text.chars().take(take));
            break;
        }
        out.push_str(&text);
        chars += n + 1;
    }
    out
}

/// The searchable body for a conversation. CLI runtimes persist their
/// transcript in `cli_messages`; pi keeps it in the session JSONL under
/// `<app_data>/sessions`. A conversation that switched runtime can have both,
/// so both are read when present. `app_data_dir` = None skips the pi file.
pub fn conversation_body(
    store: &Store,
    app_data_dir: Option<&Path>,
    conv: &Conversation,
) -> String {
    let mut messages = store.list_cli_messages(&conv.id).unwrap_or_default();
    let is_cli = cetus_bridge::cli_agent::CliBackend::from_id(&conv.backend).is_some();
    if !is_cli && !conv.session_file.is_empty() {
        if let Some(root) = app_data_dir {
            let mut path = PathBuf::from(&conv.session_file);
            if path.is_relative() {
                path = root.join("sessions").join(&path);
            }
            if let Ok(pi) = crate::commands::read_pi_session_messages(&path) {
                messages.extend(pi);
            }
        }
    }
    join_capped(&messages)
}

/// Rebuild one conversation's index row from its current transcript.
pub fn reindex(store: &Store, app_data_dir: Option<&Path>, conv: &Conversation) {
    let body = conversation_body(store, app_data_dir, conv);
    if let Err(e) = store.upsert_conversation_index(&conv.id, &conv.title, &body, conv.updated_at) {
        tracing::warn!("search index: reindex {} failed: {e}", conv.id);
    }
}

/// Reindex by id — the post-turn hook for CLI runtimes (no pi file to read, so
/// no app_data_dir needed). Unknown ids are a no-op.
pub fn reindex_cli(store: &Store, conv_id: &str) {
    if let Ok(Some(conv)) = store.get(conv_id) {
        reindex(store, None, &conv);
    }
}

/// Background sweep: index every conversation whose row is missing or older
/// than the conversation. Runs off the main thread with a startup grace, in
/// small batches, so a first-launch backfill over hundreds of chats never
/// competes with the UI.
pub fn spawn_indexer(handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_GRACE).await;
        loop {
            let state = handle.state::<AppState>();
            let store: Arc<Store> = state.store.clone();
            let app_data_dir = state.app_data_dir.clone();
            let done = tauri::async_runtime::spawn_blocking(move || -> usize {
                let stale = match store.stale_index_conversations(BATCH) {
                    Ok(rows) => rows,
                    Err(e) => {
                        tracing::warn!("search index: stale query failed: {e}");
                        return 0;
                    }
                };
                for conv in &stale {
                    reindex(&store, Some(&app_data_dir), conv);
                }
                stale.len()
            })
            .await
            .unwrap_or(0);
            tokio::time::sleep(if done as u32 >= BATCH {
                BUSY_TICK
            } else {
                IDLE_TICK
            })
            .await;
        }
    });
}

/// Lowercased query tokens, mirroring the frontend's tokenizer.
fn tokens(query: &str) -> Vec<String> {
    query
        .split_whitespace()
        .map(|t| t.to_lowercase())
        .filter(|t| !t.is_empty())
        .collect()
}

/// A ~110-char window around the first token hit in `body`, whitespace
/// collapsed. Empty when no token appears in the body (title-only hit).
fn snippet(body: &str, toks: &[String]) -> String {
    const WINDOW: usize = 110;
    if body.is_empty() || toks.is_empty() {
        return String::new();
    }
    let lower = body.to_lowercase();
    // Find the earliest byte offset of any token in the lowercased body, then
    // map it back to a char index. Lowercasing can change byte lengths for
    // non-ASCII, so index by chars of `lower` and slice `lower` too — the
    // snippet is display text, and case-folded display is acceptable.
    let mut first: Option<usize> = None;
    for t in toks {
        if let Some(i) = lower.find(t.as_str()) {
            first = Some(first.map_or(i, |f| f.min(i)));
        }
    }
    let Some(byte_at) = first else {
        return String::new();
    };
    let char_at = lower[..byte_at].chars().count();
    let chars: Vec<char> = lower.chars().collect();
    let start = char_at.saturating_sub(WINDOW / 3);
    let end = (start + WINDOW).min(chars.len());
    let mut text: String = chars[start..end].iter().collect();
    text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = String::new();
    if start > 0 {
        out.push_str("… ");
    }
    out.push_str(text.trim());
    if end < chars.len() {
        out.push_str(" …");
    }
    out
}

pub fn search(
    store: &Store,
    query: &str,
    archived: Option<bool>,
    limit: u32,
) -> anyhow::Result<Vec<ConversationSearchHit>> {
    let toks = tokens(query);
    let rows = store.search_conversations_raw(query, archived, limit)?;
    Ok(rows
        .into_iter()
        .map(|(conversation, _title, body)| ConversationSearchHit {
            snippet: snippet(&body, &toks),
            conversation,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn message_text_keeps_prose_and_drops_tools() {
        let m = json!({"role":"assistant","content":[
            {"type":"thinking","thinking":"secret"},
            {"type":"text","text":"Hello"},
            {"type":"toolCall","name":"bash"},
            {"type":"text","text":"world"}
        ]});
        assert_eq!(message_text(&m).as_deref(), Some("Hello\nworld"));
        let tool = json!({"role":"toolResult","content":"x"});
        assert!(message_text(&tool).is_none());
    }

    #[test]
    fn snippet_windows_around_first_hit() {
        let body = "a".repeat(200) + " the needle is here " + &"b".repeat(200);
        let s = snippet(&body, &tokens("needle"));
        assert!(s.starts_with("… "));
        assert!(s.ends_with(" …"));
        assert!(s.contains("needle"));
        assert_eq!(snippet(&body, &tokens("absent")), "");
    }

    #[test]
    fn snippet_handles_cjk() {
        let body = "这是一个很长的对话，里面提到了归档搜索功能的实现细节。";
        let s = snippet(body, &tokens("归档"));
        assert!(s.contains("归档搜索"));
    }
}
