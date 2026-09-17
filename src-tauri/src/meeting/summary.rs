use super::{
    emit_meeting_event, json, now_ms, AppHandle, Duration, Local, Path, Store, Value,
    RECALL_KEEP_LINES, RECALL_MAX_BYTES, RECALL_TEXT_CAP, SUMMARY_HEAD_CHARS, SUMMARY_MIN_CHARS,
    SUMMARY_SYSTEM_PROMPT, SUMMARY_TAIL_CHARS,
};
use chrono::TimeZone;

/// One-shot out-of-band minutes pass (mirrors titling::generate_title).
pub(super) async fn summarize(
    app: &AppHandle,
    store: &Store,
    recall: &Path,
    id: &str,
    app_hint: Option<&str>,
) -> anyhow::Result<()> {
    let segs = store.meeting_segments(id)?;
    let mut transcript = String::new();
    for s in &segs {
        let hm = Local
            .timestamp_millis_opt(s.ts)
            .single()
            .map(|dt| dt.format("%H:%M").to_string())
            .unwrap_or_default();
        transcript.push_str(&format!("[{hm}] ({}) {}\n", s.source, s.text));
    }
    let total_chars = transcript.chars().count();
    if total_chars < SUMMARY_MIN_CHARS {
        emit_meeting_event(app, "saved", id, app_hint, None);
        return Ok(());
    }
    if total_chars > SUMMARY_HEAD_CHARS + SUMMARY_TAIL_CHARS {
        let head: String = transcript.chars().take(SUMMARY_HEAD_CHARS).collect();
        let tail: String = transcript
            .chars()
            .skip(total_chars - SUMMARY_TAIL_CHARS)
            .collect();
        transcript = format!("{head}\n[… transcript truncated …]\n{tail}");
    }

    let target = crate::custom_models::utility_target(store)
        .ok_or_else(|| anyhow::anyhow!("no LLM endpoint configured; skipping meeting summary"))?;
    let body = json!({
        "model": target.model,
        "messages": [
            { "role": "system", "content": SUMMARY_SYSTEM_PROMPT },
            { "role": "user", "content": transcript },
        ],
        "stream": false,
        "temperature": 0.3,
        "max_tokens": 2048,
        "response_format": { "type": "json_object" },
    });
    let mut req = reqwest::Client::new()
        .post(&target.url)
        .json(&body)
        .timeout(Duration::from_secs(90));
    if !target.api_key.is_empty() {
        req = req.bearer_auth(&target.api_key);
    }
    let resp = req.send().await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        anyhow::bail!("meeting summary failed: {status} {text}");
    }
    let value: Value = resp.json().await?;
    let content = value
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("summary response missing content"))?;
    // Some OpenAI-compatible endpoints ignore response_format and wrap the
    // JSON in a markdown fence; strip it before parsing.
    let content = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let parsed: Value = serde_json::from_str(content)?;
    let title = parsed
        .get("title")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let summary = parsed
        .get("summary")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if summary.is_empty() {
        emit_meeting_event(app, "saved", id, app_hint, None);
        return Ok(());
    }
    store.set_meeting_summary(id, &title, &summary)?;
    append_recall(
        recall,
        now_ms(),
        "summary",
        "summary",
        app_hint,
        Some(&title),
        &summary,
    );
    emit_meeting_event(
        app,
        "saved",
        id,
        app_hint,
        if title.is_empty() { None } else { Some(&title) },
    );
    Ok(())
}

// ---- `cetus meeting` CLI (agent-facing) -------------------------------------
//
// Server-side formatting for the control socket's `meeting.*` ops, mirroring
// `ambient.rs` for `cetus context`: the std-only CLI prints the returned text
// raw. This is what makes meeting transcripts reachable from every runtime —
// the pi extension (`meeting-recall.ts`) covers only the built-in agent, while
// claude-code / codex sessions see the `cetus` shim on their PATH.

fn fmt_cli_ts(ts: i64, fmt: &str) -> String {
    Local
        .timestamp_millis_opt(ts)
        .single()
        .map(|dt| dt.format(fmt).to_string())
        .unwrap_or_default()
}

/// `cetus meeting list`: one line per recorded meeting, newest first.
pub fn cli_list(store: &Store, limit: u32) -> Result<String, String> {
    let meetings = store
        .list_meetings(limit.clamp(1, 200))
        .map_err(|e| e.to_string())?;
    if meetings.is_empty() {
        return Ok(
            "No recorded meetings. Meeting capture may be off (Settings → Meetings), \
             or nothing has been recorded yet."
                .to_string(),
        );
    }
    let mut out = String::from(
        "Recorded meetings (newest first). \
         `cetus meeting transcript <id|latest>` prints one in full.\n",
    );
    for m in &meetings {
        let start = fmt_cli_ts(m.started_ts, "%Y-%m-%d %H:%M");
        let end = match m.ended_ts {
            Some(t) => fmt_cli_ts(t, "%H:%M"),
            None => "LIVE".to_string(),
        };
        out.push_str(&format!(
            "\n{}  {start}–{end}  {} segments{}{}",
            m.id,
            m.segment_count,
            m.app_name
                .as_deref()
                .map(|a| format!("  [{a}]"))
                .unwrap_or_default(),
            m.title
                .as_deref()
                .map(|t| format!("  {t}"))
                .unwrap_or_default(),
        ));
    }
    Ok(out)
}

/// `cetus meeting transcript <id|latest>`: header + summary + full transcript.
pub fn cli_transcript(store: &Store, id: &str) -> Result<String, String> {
    let id = if id == "latest" {
        store
            .list_meetings(1)
            .map_err(|e| e.to_string())?
            .first()
            .map(|m| m.id.clone())
            .ok_or_else(|| "no recorded meetings".to_string())?
    } else {
        id.to_string()
    };
    let meeting = store
        .list_meetings(200)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("no meeting with id {id:?} — run `cetus meeting list`"))?;
    let segs = store.meeting_segments(&id).map_err(|e| e.to_string())?;

    let mut out = format!(
        "Meeting {}\nStarted: {}{}{}\n",
        meeting.id,
        fmt_cli_ts(meeting.started_ts, "%Y-%m-%d %H:%M:%S"),
        match meeting.ended_ts {
            Some(t) => format!("\nEnded: {}", fmt_cli_ts(t, "%Y-%m-%d %H:%M:%S")),
            None => "\nEnded: (still recording)".to_string(),
        },
        meeting
            .app_name
            .as_deref()
            .map(|a| format!("\nApp: {a}"))
            .unwrap_or_default(),
    );
    if let Some(title) = meeting.title.as_deref().filter(|t| !t.is_empty()) {
        out.push_str(&format!("Title: {title}\n"));
    }
    if let Some(summary) = meeting.summary.as_deref().filter(|s| !s.is_empty()) {
        out.push_str(&format!("\n## Summary\n{summary}\n"));
    }
    out.push_str("\n## Transcript (`you` = the user's mic; `them` = everyone else, heard through system audio)\n");
    if segs.is_empty() {
        out.push_str("(no transcript segments)\n");
    }
    for s in &segs {
        let who = if s.source == "mic" { "you" } else { "them" };
        out.push_str(&format!(
            "[{}] {who}: {}\n",
            fmt_cli_ts(s.ts, "%H:%M:%S"),
            s.text
        ));
    }
    Ok(out)
}

// ---- recall log (agent-facing) ----------------------------------------------

/// Append one entry the `meeting-recall` pi extension can read. Self-trims when
/// the file grows past the byte cap (same scheme as capture.rs).
pub(super) fn append_recall(
    path: &Path,
    ts: i64,
    kind: &str,
    source: &str,
    app: Option<&str>,
    title: Option<&str>,
    text: &str,
) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut t: String = text.replace(['\n', '\r'], " ");
    if t.chars().count() > RECALL_TEXT_CAP {
        t = t.chars().take(RECALL_TEXT_CAP).collect();
    }
    let iso = Local
        .timestamp_millis_opt(ts)
        .single()
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_default();
    let line = json!({
        "ts": ts,
        "iso": iso,
        "kind": kind,
        "source": source,
        "app": app.unwrap_or(""),
        "title": title.unwrap_or(""),
        "text": t,
    })
    .to_string();

    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(f, "{line}");
    }

    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > RECALL_MAX_BYTES {
            if let Ok(content) = std::fs::read_to_string(path) {
                let lines: Vec<&str> = content.lines().collect();
                let start = lines.len().saturating_sub(RECALL_KEEP_LINES);
                let kept = lines[start..].join("\n");
                let _ = std::fs::write(path, format!("{kept}\n"));
            }
        }
    }
}
