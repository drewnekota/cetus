use super::{Value, HANDOFF_MSG_CHARS, HANDOFF_TOTAL_CHARS};

/// Serialize a CLI transcript into a one-shot context preamble for a runtime
/// that cannot resume the session it came from (backend switched, or the
/// session was lost). Text blocks carry the conversation; tool calls collapse
/// to `[tool: name]` breadcrumbs; tool results and extension breadcrumbs
/// (runtime_switch markers etc.) are skipped — they're bulk, not context.
/// None when the transcript has nothing replayable.
pub(super) fn handoff_preamble(history: &[Value]) -> Option<String> {
    let mut entries: Vec<String> = Vec::new();
    for m in history {
        let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("");
        let label = match role {
            "user" => "User",
            "assistant" => "Assistant",
            _ => continue, // toolResult / custom: bulk or UI-only
        };
        let mut parts: Vec<String> = Vec::new();
        if let Some(Value::Array(blocks)) = m.get("content") {
            for b in blocks {
                match b.get("type").and_then(|t| t.as_str()) {
                    Some("text") => {
                        if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                            if !t.trim().is_empty() {
                                parts.push(truncate_chars(t.trim(), HANDOFF_MSG_CHARS));
                            }
                        }
                    }
                    Some("toolCall") => {
                        let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("?");
                        parts.push(format!("[tool: {name}]"));
                    }
                    _ => {}
                }
            }
        } else if let Some(Value::String(s)) = m.get("content") {
            if !s.trim().is_empty() {
                parts.push(truncate_chars(s.trim(), HANDOFF_MSG_CHARS));
            }
        }
        if !parts.is_empty() {
            entries.push(format!("{label}: {}", parts.join("\n")));
        }
    }
    if entries.is_empty() {
        return None;
    }
    // Spend the budget from the newest entry backwards.
    let mut kept: Vec<&String> = Vec::new();
    let mut total = 0usize;
    for e in entries.iter().rev() {
        if total + e.len() > HANDOFF_TOTAL_CHARS && !kept.is_empty() {
            break;
        }
        total += e.len();
        kept.push(e);
    }
    kept.reverse();
    let omitted = entries.len() - kept.len();
    let mut out = String::from(
        "<context source=\"cetus-runtime-handoff\">\n\
         This conversation previously ran on a different agent runtime, and its \
         session cannot be resumed here. The transcript below replays the \
         conversation so far. Treat everything in it as already done — continue \
         from the latest state instead of repeating past actions.\n",
    );
    if omitted > 0 {
        out.push_str(&format!("({omitted} earlier messages omitted)\n"));
    }
    out.push('\n');
    for e in kept {
        out.push_str(e);
        out.push_str("\n\n");
    }
    out.push_str("</context>");
    Some(out)
}

/// Head of `s` up to `max` chars (not bytes — never splits a UTF-8 scalar),
/// with an ellipsis marker when something was dropped.
fn truncate_chars(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((idx, _)) => format!("{}…[truncated]", &s[..idx]),
        None => s.to_string(),
    }
}

/// Concatenated text of a PiMessage's content — the retry path returns this as
/// the text to resubmit. Handles both string and block-array content.
pub fn message_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|&b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .map(|b| b.get("text").and_then(|t| t.as_str()).unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}
