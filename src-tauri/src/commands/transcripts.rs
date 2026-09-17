use super::{err, AppState, CmdResult, Path, PathBuf, Serialize, State};

/// Backend full-text search over conversation titles + prose (see
/// search_index.rs). `archived`: true = archived only, false = active only,
/// omitted = both. Off the async runtime — a LIKE fallback for short tokens
/// scans the FTS table.
#[tauri::command]
pub async fn search_conversations(
    state: State<'_, AppState>,
    query: String,
    archived: Option<bool>,
    limit: Option<u32>,
) -> CmdResult<Vec<crate::search_index::ConversationSearchHit>> {
    let store = state.store.clone();
    let limit = limit.unwrap_or(12).clamp(1, 50);
    tauri::async_runtime::spawn_blocking(move || {
        crate::search_index::search(&store, &query, archived, limit).map_err(err)
    })
    .await
    .map_err(err)?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptExport {
    path: String,
    message_count: usize,
}

/// Write a conversation's transcript to `<app_data>/mention-exports/<id>.md`
/// so a prompt that `@`-mentions another chat can point the agent at a file it
/// can read. CLI-backend chats come from the cli_messages table; pi chats are
/// read straight from the session JSONL — no pi is spawned for this.
#[tauri::command]
pub async fn export_conversation_transcript(
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<TranscriptExport> {
    let conv = state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".to_string())?;
    let messages = if cetus_bridge::cli_agent::CliBackend::from_id(&conv.backend).is_some() {
        state.store.list_cli_messages(&id).map_err(err)?
    } else {
        let mut path = PathBuf::from(&conv.session_file);
        if conv.session_file.is_empty() {
            return Err("conversation has no transcript yet".to_string());
        }
        if path.is_relative() {
            path = state.app_data_dir.join("sessions").join(&path);
        }
        read_pi_session_messages(&path)?
    };
    let dir = state.app_data_dir.join("mention-exports");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let out = dir.join(format!("{}.md", conv.id));
    let (markdown, message_count) = render_transcript_markdown(&conv, &messages);
    std::fs::write(&out, markdown).map_err(err)?;
    Ok(TranscriptExport {
        path: out.to_string_lossy().to_string(),
        message_count,
    })
}

pub(crate) fn read_pi_session_messages(path: &Path) -> CmdResult<Vec<serde_json::Value>> {
    let raw = std::fs::read_to_string(path).map_err(err)?;
    Ok(raw
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|entry| entry.get("type").and_then(|t| t.as_str()) == Some("message"))
        .filter_map(|entry| entry.get("message").cloned())
        .collect())
}

/// Markdown transcript: user + assistant prose, tool calls as one-line markers.
/// Thinking and tool results are left out — the point is what was discussed
/// and decided, not a replay of every tool payload.
fn render_transcript_markdown(
    conv: &crate::store::Conversation,
    messages: &[serde_json::Value],
) -> (String, usize) {
    const MAX_MESSAGE_CHARS: usize = 20_000;
    let mut out = format!(
        "# {}

",
        conv.title.trim()
    );
    out.push_str(&format!(
        "- Conversation id: {}
- Runtime: {}
- Workspace: {}
- Last updated: {}

",
        conv.id,
        if conv.backend.is_empty() {
            "pi"
        } else {
            conv.backend.as_str()
        },
        conv.workspace_dir,
        chrono::DateTime::<chrono::Utc>::from_timestamp_millis(conv.updated_at)
            .map(|t| t.to_rfc3339())
            .unwrap_or_default(),
    ));
    let mut count = 0usize;
    for msg in messages {
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");
        if role != "user" && role != "assistant" {
            continue;
        }
        let mut body = String::new();
        match msg.get("content") {
            Some(serde_json::Value::String(text)) => body.push_str(text),
            Some(serde_json::Value::Array(blocks)) => {
                for block in blocks {
                    match block.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                if !body.is_empty() {
                                    body.push_str(
                                        "

",
                                    );
                                }
                                body.push_str(text);
                            }
                        }
                        Some("toolCall") | Some("tool_use") => {
                            let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                            if !body.is_empty() {
                                body.push_str(
                                    "

",
                                );
                            }
                            body.push_str(&format!("[tool call: {name}]"));
                        }
                        _ => {}
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
            continue;
        }
        let mut body = body.to_string();
        if body.chars().count() > MAX_MESSAGE_CHARS {
            body = body.chars().take(MAX_MESSAGE_CHARS).collect::<String>()
                + "

[… truncated]";
        }
        out.push_str(if role == "user" {
            "## User

"
        } else {
            "## Assistant

"
        });
        out.push_str(&body);
        out.push_str(
            "

",
        );
        count += 1;
    }
    (out, count)
}

/// Drop the machine blocks Cetus appends to user prompts (attachment paths,
/// mention resolutions) so an exported transcript reads like the chat did.
pub fn strip_prompt_blocks(text: &str) -> String {
    let mut out = text.to_string();
    for (open, close) in [
        ("<cetus-attachments>", "</cetus-attachments>"),
        ("<cetus-mentions>", "</cetus-mentions>"),
    ] {
        if let Some(start) = out.find(open) {
            if let Some(end_rel) = out[start..].find(close) {
                let end = start + end_rel + close.len();
                out.replace_range(start..end, "");
            }
        }
    }
    out.trim().to_string()
}
