use super::artifacts::{extracted_artifact_details, normalize_content};
use super::{
    am, claude_prompt_tokens, is_background_launch_ack, is_sidechain, summarize_tool_input,
    task_kind, BackgroundTask, EventTranslator, LiveBlock, LiveKind,
};
use serde_json::{json, Value};

impl EventTranslator {
    fn emit_claude_tool_result(&mut self, id: &str, content: &Value, is_error: bool) -> Vec<Value> {
        let task_id = self
            .background_tasks
            .iter()
            .find(|(_, t)| t.tool_use_id == id)
            .map(|(k, _)| k.clone());
        if let Some(task_id) = task_id {
            let task = self.background_tasks[&task_id].clone();
            if !task.done && is_background_launch_ack(content) {
                let tool_name = self.tool_names.get(id).map(String::as_str).unwrap_or("");
                let label = if tool_name == "Workflow" {
                    // Workflow tasks register with a generic subagent_type
                    // ("Task"); the tool name reads better than "Task agent".
                    format!("Workflow running in background — {}", task.description)
                } else if tool_name == "Bash" {
                    format!("Background command running — {}", task.description)
                } else {
                    format!(
                        "{} agent running in background — {}",
                        task.subagent_type, task.description
                    )
                };
                let status = json!([{ "type": "text", "text": label }]);
                let details = task.details("running");
                self.flush_assistant();
                self.messages.push(json!({
                    "role": "toolResult",
                    "toolCallId": id,
                    "toolName": self.tool_names.get(id).cloned().unwrap_or_else(|| "tool".to_string()),
                    "content": status,
                    "isError": false,
                    "details": details,
                }));
                return vec![
                    json!({ "type": "tool_execution_start", "toolCallId": id }),
                    json!({
                        "type": "tool_execution_update",
                        "toolCallId": id,
                        "partialResult": { "content": status, "details": details },
                    }),
                ];
            }
            // Synchronous subagent: the result is the real report and also
            // ends the task — don't hold the turn open for it. Keep the step
            // trace on the settled card (and the persisted row).
            let mut details = {
                let t = self
                    .background_tasks
                    .get_mut(&task_id)
                    .expect("task exists");
                t.done = true;
                t.details(if is_error { "failed" } else { "completed" })
            };
            // The CLI also runs foreground Bash through the task lifecycle
            // (task_type local_bash), so artifact markers in the result would
            // otherwise be lost with the plain-result path's extraction.
            if let Some(artifacts) = extracted_artifact_details(
                content,
                self.artifact_dir.as_deref(),
                self.cwd.as_deref(),
            ) {
                details["artifacts"] = artifacts;
            }
            let content = normalize_content(content);
            self.flush_assistant();
            self.messages.push(json!({
                "role": "toolResult",
                "toolCallId": id,
                "toolName": self.tool_names.get(id).cloned().unwrap_or_else(|| "tool".to_string()),
                "content": content,
                "isError": is_error,
                "details": details,
            }));
            return vec![
                json!({ "type": "tool_execution_start", "toolCallId": id }),
                json!({
                    "type": "tool_execution_end",
                    "toolCallId": id,
                    "result": { "content": content, "details": details },
                    "isError": is_error,
                }),
            ];
        }
        self.emit_tool_result(id, content, is_error)
    }

    /// A sidechain snapshot line (`parent_tool_use_id` set): the subagent's own
    /// tool calls and results. They must not splice into the main transcript —
    /// instead they accumulate as steps on the launching Agent/Task card so
    /// the user can watch the subagent work.
    fn on_claude_sidechain(&mut self, v: &Value) -> Vec<Value> {
        let parent = v
            .get("parent_tool_use_id")
            .and_then(|p| p.as_str())
            .unwrap_or("");
        let Some(task) = self
            .background_tasks
            .values_mut()
            .find(|t| t.tool_use_id == parent)
        else {
            return Vec::new();
        };
        let blocks = v
            .pointer("/message/content")
            .and_then(|c| c.as_array())
            .cloned()
            .unwrap_or_default();
        let mut changed = false;
        for b in &blocks {
            match b.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                "tool_use" => {
                    let id = b.get("id").and_then(|i| i.as_str()).unwrap_or("");
                    // Snapshots could repeat a block; a step per tool call.
                    if task.steps.iter().any(|s| s["id"] == json!(id)) {
                        continue;
                    }
                    task.steps.push(json!({
                        "id": id,
                        "tool": b.get("name").and_then(|n| n.as_str()).unwrap_or("tool"),
                        "detail": summarize_tool_input(b.get("input").unwrap_or(&Value::Null)),
                        "done": false,
                    }));
                    changed = true;
                }
                "tool_result" => {
                    let id = b.get("tool_use_id").and_then(|i| i.as_str()).unwrap_or("");
                    if let Some(s) = task.steps.iter_mut().find(|s| s["id"] == json!(id)) {
                        s["done"] = json!(true);
                        changed = true;
                    }
                }
                _ => {}
            }
        }
        if !changed || task.done {
            return Vec::new();
        }
        let text = if task.status_text.is_empty() {
            format!(
                "{} agent running — {}",
                task.subagent_type, task.description
            )
        } else {
            task.status_text.clone()
        };
        vec![json!({
            "type": "tool_execution_update",
            "toolCallId": task.tool_use_id,
            "partialResult": {
                "content": [{ "type": "text", "text": text }],
                "details": task.details("running"),
            },
        })]
    }

    /// The CLI's own authoritative list of live session-owned background
    /// tasks (`background_tasks_changed`, fires whenever the set changes).
    /// Translated straight into the frontend snapshot — after a resume this
    /// is the only source that knows what the fresh process still owns, our
    /// registry having started empty. `statusText` merges in from the
    /// registry where the task is one we tracked from `task_started`.
    fn on_claude_background_tasks_changed(&self, v: &Value) -> Vec<Value> {
        let Some(items) = v.get("tasks").and_then(|t| t.as_array()) else {
            return Vec::new();
        };
        let tasks: Vec<Value> = items
            .iter()
            .filter_map(|item| {
                let id = item.get("task_id").and_then(|t| t.as_str())?;
                let status_text = self
                    .background_tasks
                    .get(id)
                    .map(|t| t.status_text.clone())
                    .unwrap_or_default();
                Some(json!({
                    "taskId": id,
                    "kind": task_kind(item),
                    "description": item
                        .get("description")
                        .and_then(|t| t.as_str())
                        .unwrap_or("background task"),
                    "statusText": status_text,
                }))
            })
            .collect();
        vec![json!({ "type": "cli_background_tasks", "tasks": tasks })]
    }

    /// Live (not yet settled) background tasks — Monitors, async
    /// agents/workflows, background Bash — as the frontend's task strip
    /// renders them. Sorted by task id so equal registries compare equal.
    pub(super) fn background_tasks_snapshot(&self) -> Value {
        let mut live: Vec<(&String, &BackgroundTask)> = self
            .background_tasks
            .iter()
            .filter(|(_, t)| !t.done)
            .collect();
        live.sort_by(|a, b| a.0.cmp(b.0));
        Value::Array(
            live.into_iter()
                .map(|(id, t)| {
                    json!({
                        "taskId": id,
                        "kind": t.subagent_type,
                        "description": t.description,
                        "statusText": t.status_text,
                    })
                })
                .collect(),
        )
    }

    /// Background-task lifecycle system events (claude). Progress is painted
    /// onto the launching Agent/Task tool card via tool_execution_update; the
    /// notification settles the card and releases the turn (has_pending_tasks).
    /// Any change to the set of live tasks additionally emits a conversation-
    /// level `cli_background_tasks` snapshot: these tasks outlive model turns
    /// (a Monitor can wake the CLI hours later), so the frontend needs standing
    /// state, not just paint on the launching card.
    fn on_claude_task_event(&mut self, subtype: &str, v: &Value) -> Vec<Value> {
        let before = self.background_tasks_snapshot();
        let mut events = self.on_claude_task_event_inner(subtype, v);
        let after = self.background_tasks_snapshot();
        if before != after {
            events.push(json!({ "type": "cli_background_tasks", "tasks": after }));
        }
        events
    }

    fn on_claude_task_event_inner(&mut self, subtype: &str, v: &Value) -> Vec<Value> {
        let task_id = v.get("task_id").and_then(|t| t.as_str()).unwrap_or("");
        if task_id.is_empty() {
            return Vec::new();
        }
        match subtype {
            "task_started" => {
                let tool_use_id = v.get("tool_use_id").and_then(|t| t.as_str()).unwrap_or("");
                if !tool_use_id.is_empty() {
                    self.background_tasks.insert(
                        task_id.to_string(),
                        BackgroundTask {
                            tool_use_id: tool_use_id.to_string(),
                            subagent_type: task_kind(v),
                            description: v
                                .get("description")
                                .and_then(|t| t.as_str())
                                .unwrap_or("background task")
                                .to_string(),
                            done: false,
                            steps: Vec::new(),
                            status_text: String::new(),
                        },
                    );
                }
                // No event yet: the tool card may not exist until toolcall_end,
                // and the launch ack result paints the initial status anyway.
                Vec::new()
            }
            "task_progress" => {
                let Some(task) = self.background_tasks.get_mut(task_id) else {
                    return Vec::new();
                };
                let desc = v
                    .get("description")
                    .and_then(|t| t.as_str())
                    .unwrap_or("working…");
                task.status_text = desc.to_string();
                vec![json!({
                    "type": "tool_execution_update",
                    "toolCallId": task.tool_use_id,
                    "partialResult": {
                        "content": [{ "type": "text", "text": desc }],
                        "details": task.details("running"),
                    },
                })]
            }
            "task_updated" => {
                // Terminal status patch; the notification (which may race
                // this) does the card settling.
                if matches!(
                    v.pointer("/patch/status").and_then(|s| s.as_str()),
                    Some("completed") | Some("failed") | Some("stopped") | Some("killed")
                ) {
                    if let Some(t) = self.background_tasks.get_mut(task_id) {
                        t.done = true;
                    }
                }
                Vec::new()
            }
            "task_notification" => {
                let Some(task) = self.background_tasks.get_mut(task_id) else {
                    return Vec::new();
                };
                task.done = true;
                let task = task.clone();
                let status = v
                    .get("status")
                    .and_then(|s| s.as_str())
                    .unwrap_or("completed");
                let is_err = status != "completed";
                // The notification carries the subagent's actual report in
                // `summary` — for an async task this is the only place it
                // surfaces (no main-chain tool_result follows).
                let text = match v.get("summary").and_then(|s| s.as_str()) {
                    Some(s) if !s.trim().is_empty() => s.to_string(),
                    _ => format!(
                        "{} agent {} — {}",
                        task.subagent_type, status, task.description
                    ),
                };
                let content = json!([{ "type": "text", "text": text }]);
                let mut details = task.details(status);
                // For async tasks this summary is the only place a produced
                // file can surface — extract markers/paths like a plain result.
                if let Some(artifacts) = extracted_artifact_details(
                    &content,
                    self.artifact_dir.as_deref(),
                    self.cwd.as_deref(),
                ) {
                    details["artifacts"] = artifacts;
                }
                // Keep the persisted transcript in sync with what the card
                // now shows (the launch-ack row was already pushed).
                for m in self.messages.iter_mut().rev() {
                    if m.get("toolCallId").and_then(|i| i.as_str())
                        == Some(task.tool_use_id.as_str())
                    {
                        m["content"] = content.clone();
                        m["isError"] = json!(is_err);
                        m["details"] = details.clone();
                        break;
                    }
                }
                vec![json!({
                    "type": "tool_execution_end",
                    "toolCallId": task.tool_use_id,
                    "result": { "content": content, "details": details },
                    "isError": is_err,
                })]
            }
            _ => Vec::new(),
        }
    }
    pub(super) fn on_claude(&mut self, v: &Value) -> Vec<Value> {
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match ty {
            "system" => match v.get("subtype").and_then(|s| s.as_str()).unwrap_or("") {
                "init" => {
                    if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                        self.resume_id = Some(sid.to_string());
                    }
                    Vec::new()
                }
                sub @ ("task_started" | "task_progress" | "task_updated" | "task_notification") => {
                    self.on_claude_task_event(sub, v)
                }
                "background_tasks_changed" => self.on_claude_background_tasks_changed(v),
                _ => Vec::new(),
            },
            // Token-level partials (--include-partial-messages). These carry
            // the live content; the cumulative "assistant" snapshots below are
            // ignored to avoid double-rendering.
            "stream_event" => {
                // Sidechain partials (a subagent's own stream) would collide
                // with the parent's live_blocks — both count indexes from 0.
                if is_sidechain(v) {
                    return Vec::new();
                }
                let Some(event) = v.get("event") else {
                    return Vec::new();
                };
                self.on_claude_stream_event(event)
            }
            // Cumulative snapshots — normally redundant with stream_event
            // partials. They are also our compatibility fallback when a CLI
            // version accepts --include-partial-messages but emits no partial
            // content, plus the only output for synthetic slash commands.
            "assistant" => {
                // Sidechain snapshots (a subagent's own turns) feed the
                // launching card's step list instead of the main transcript.
                if is_sidechain(v) {
                    return self.on_claude_sidechain(v);
                }
                let msg = v.get("message");
                let model = msg.and_then(|m| m.get("model")).and_then(|m| m.as_str());
                if model != Some("<synthetic>") && self.claude_streamed_content {
                    return Vec::new();
                }
                let mut out = Vec::new();
                let blocks = msg
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array());
                if let Some(blocks) = blocks {
                    for b in blocks {
                        match b.get("type").and_then(Value::as_str).unwrap_or("") {
                            "text" => {
                                let text = b.get("text").and_then(Value::as_str).unwrap_or("");
                                if !text.is_empty() {
                                    out.extend(self.emit_text(text));
                                }
                            }
                            "thinking" => {
                                let thinking =
                                    b.get("thinking").and_then(Value::as_str).unwrap_or("");
                                if !thinking.is_empty() {
                                    out.extend(self.emit_thinking(thinking));
                                }
                            }
                            "tool_use" => {
                                let id = b.get("id").and_then(Value::as_str).unwrap_or("tool");
                                let name = b.get("name").and_then(Value::as_str).unwrap_or("tool");
                                let input = b.get("input").cloned().unwrap_or(Value::Null);
                                out.extend(self.emit_tool_call(id, name, &input));
                            }
                            _ => {}
                        }
                    }
                }
                if !out.is_empty() {
                    self.claude_streamed_content = true;
                }
                out
            }
            // Permission prompt / AskUserQuestion. Forwarded to the frontend
            // as a card; the host answers over stdin via the input channel.
            "control_request" => {
                let request_id = v.get("request_id").and_then(|r| r.as_str()).unwrap_or("");
                let Some(req) = v.get("request") else {
                    return Vec::new();
                };
                if req.get("subtype").and_then(|s| s.as_str()) != Some("can_use_tool") {
                    return Vec::new();
                }
                vec![json!({
                    "type": "cli_control_request",
                    "requestId": request_id,
                    "toolName": req.get("tool_name").and_then(|t| t.as_str()).unwrap_or(""),
                    "input": req.get("input").cloned().unwrap_or(Value::Null),
                    "toolUseId": req.get("tool_use_id").and_then(|t| t.as_str()).unwrap_or(""),
                    "suggestions": req.get("permission_suggestions").cloned().unwrap_or(Value::Null),
                })]
            }
            // Ack of our initialize handshake. It carries the CLI's slash
            // command catalog (built-ins like /usage /compact /context plus
            // every skill) — surface it so the composer's slash menu can offer
            // the runtime's real commands instead of a hardcoded snapshot.
            // Entries suffixed "(user)" / "(project)" are skills, which the
            // menu already lists from its own skill sources — the frontend
            // filters; we forward the catalog verbatim.
            "control_response" => {
                let Some(commands) = v
                    .pointer("/response/response/commands")
                    .and_then(|c| c.as_array())
                else {
                    return Vec::new();
                };
                let commands: Vec<Value> = commands
                    .iter()
                    .filter_map(|c| {
                        let name = c.get("name").and_then(|n| n.as_str())?;
                        let description =
                            c.get("description").and_then(|d| d.as_str()).unwrap_or("");
                        let is_skill = ["(user)", "(project)", "(plugin)", "(builtin)"]
                            .iter()
                            .any(|suffix| description.trim_end().ends_with(suffix));
                        Some(json!({
                            "name": name,
                            "description": description,
                            "argumentHint": c
                                .get("argumentHint")
                                .and_then(|d| d.as_str())
                                .unwrap_or(""),
                            "kind": if is_skill { "skill" } else { "command" },
                        }))
                    })
                    .collect();
                vec![json!({ "type": "cli_commands", "commands": commands })]
            }
            "user" => {
                // Sidechain traffic: a subagent's internal tool results. They
                // reference tool ids the frontend never saw, and emitting them
                // would splice foreign results into the parent transcript —
                // they settle the matching step on the launching card instead.
                if is_sidechain(v) {
                    return self.on_claude_sidechain(v);
                }
                let mut out = Vec::new();
                let content = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array());
                if let Some(blocks) = content {
                    for b in blocks {
                        if b.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                            let id = b.get("tool_use_id").and_then(|t| t.as_str()).unwrap_or("");
                            let is_err =
                                b.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
                            let c = b.get("content").cloned().unwrap_or(Value::Null);
                            out.extend(self.emit_claude_tool_result(id, &c, is_err));
                        }
                    }
                }
                // A main-chain tool result separates Claude API messages. If
                // the next response again lacks stream_event partials, allow
                // its cumulative assistant snapshot to act as fallback.
                self.claude_streamed_content = false;
                out
            }
            // Account-level quota heartbeat: claude reports the unified
            // rate-limit status after each API call (status allowed /
            // allowed_warning / rejected, utilization near the warning
            // threshold, reset epoch). Forwarded verbatim for the runtime
            // picker's quota line — it is not turn content and opens nothing.
            "rate_limit_event" => {
                let Some(info) = v.get("rate_limit_info") else {
                    return Vec::new();
                };
                vec![json!({ "type": "cli_rate_limit", "info": info })]
            }
            // Terminal event of the turn. In bidirectional mode the process
            // then idles for more stdin — the runner watches `saw_result` to
            // close the turn instead of waiting for EOF.
            "result" => {
                self.saw_result = true;
                if let Some(model_usage) = v.get("modelUsage").and_then(Value::as_object) {
                    let selected = self
                        .claude_model
                        .as_ref()
                        .and_then(|model| model_usage.get(model))
                        .or_else(|| model_usage.values().next());
                    self.claude_context_window = selected
                        .and_then(|usage| usage.get("contextWindow"))
                        .and_then(Value::as_u64)
                        .or(self.claude_context_window);
                }
                if v.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false) {
                    self.result_error = Some(
                        v.get("result")
                            .and_then(|r| r.as_str())
                            .unwrap_or("agent reported an error")
                            .to_string(),
                    );
                }
                self.claude_context_event().into_iter().collect()
            }
            _ => Vec::new(),
        }
    }

    /// One Anthropic streaming event from a claude `stream_event` line →
    /// live PiEvents, mirroring how pi streams blocks.
    fn on_claude_stream_event(&mut self, event: &Value) -> Vec<Value> {
        let ty = event.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match ty {
            "message_start" => {
                if let Some(message) = event.get("message") {
                    self.claude_model = message
                        .get("model")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    if let Some(usage) = message.get("usage") {
                        self.claude_context_used = claude_prompt_tokens(usage);
                    }
                }
                // New API message: any straggler blocks are closed by their
                // own content_block_stop; just reset the index map.
                self.live_blocks.clear();
                self.claude_streamed_content = false;
                let usage_event = self.claude_context_event();
                if self.pending_steer.is_empty() {
                    return usage_event.into_iter().collect();
                }
                // A steered user message merges into the turn on this API
                // request. Split the turn here: settle the open assistant
                // bubble, splice the user row(s) in at their real position,
                // and let the next content event open a fresh bubble (indices
                // restart with it) — so live view and reloaded transcript both
                // show the steer where it landed, not after the whole turn.
                self.flush_assistant();
                self.messages.append(&mut self.pending_steer);
                let mut out = Vec::new();
                if self.opened {
                    out.push(json!({ "type": "message_end" }));
                    self.opened = false;
                }
                self.next_index = 0;
                if let Some(event) = usage_event {
                    out.push(event);
                }
                out
            }
            "content_block_start" => {
                let idx = event.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
                let Some(cb) = event.get("content_block") else {
                    return Vec::new();
                };
                let kind = cb.get("type").and_then(|t| t.as_str()).unwrap_or("");
                match kind {
                    "text" => {
                        let our_index = self.alloc_index();
                        let initial = cb.get("text").and_then(Value::as_str).unwrap_or("");
                        if !initial.is_empty() {
                            self.claude_streamed_content = true;
                        }
                        self.live_blocks.insert(
                            idx,
                            LiveBlock {
                                our_index,
                                kind: LiveKind::Text,
                                buffer: initial.to_string(),
                                tool: None,
                                closed: false,
                                started: true,
                            },
                        );
                        let mut out = vec![am(
                            json!({ "type": "text_start", "contentIndex": our_index }),
                        )];
                        if !initial.is_empty() {
                            out.push(am(json!({
                                "type": "text_delta",
                                "contentIndex": our_index,
                                "delta": initial,
                            })));
                        }
                        out
                    }
                    "thinking" => {
                        let initial = cb.get("thinking").and_then(Value::as_str).unwrap_or("");
                        if !initial.is_empty() {
                            self.claude_streamed_content = true;
                        }
                        // thinking_start (and the index) waits for the first
                        // thinking_delta — see LiveBlock::started.
                        let started = !initial.is_empty();
                        let our_index = if started { self.alloc_index() } else { 0 };
                        self.live_blocks.insert(
                            idx,
                            LiveBlock {
                                our_index,
                                kind: LiveKind::Thinking,
                                buffer: initial.to_string(),
                                tool: None,
                                closed: false,
                                started,
                            },
                        );
                        if started {
                            vec![
                                am(json!({ "type": "thinking_start", "contentIndex": our_index })),
                                am(
                                    json!({ "type": "thinking_delta", "contentIndex": our_index, "delta": initial }),
                                ),
                            ]
                        } else {
                            Vec::new()
                        }
                    }
                    "tool_use" => {
                        self.claude_streamed_content = true;
                        let id = cb.get("id").and_then(|t| t.as_str()).unwrap_or("");
                        let name = cb.get("name").and_then(|t| t.as_str()).unwrap_or("tool");
                        self.tool_names.insert(id.to_string(), name.to_string());
                        let our_index = self.alloc_index();
                        self.live_blocks.insert(
                            idx,
                            LiveBlock {
                                our_index,
                                kind: LiveKind::ToolUse,
                                buffer: String::new(),
                                tool: Some((id.to_string(), name.to_string())),
                                closed: false,
                                started: true,
                            },
                        );
                        vec![am(
                            json!({ "type": "toolcall_start", "contentIndex": our_index }),
                        )]
                    }
                    _ => Vec::new(),
                }
            }
            "content_block_delta" => {
                let idx = event.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
                let Some(delta) = event.get("delta") else {
                    return Vec::new();
                };
                let dty = delta.get("type").and_then(|t| t.as_str()).unwrap_or("");
                let Some(block) = self.live_blocks.get_mut(&idx) else {
                    return Vec::new();
                };
                match dty {
                    "text_delta" => {
                        let t = delta.get("text").and_then(|t| t.as_str()).unwrap_or("");
                        if t.is_empty() {
                            return Vec::new();
                        }
                        self.claude_streamed_content = true;
                        block.buffer.push_str(t);
                        vec![am(json!({
                            "type": "text_delta",
                            "contentIndex": block.our_index,
                            "delta": t,
                        }))]
                    }
                    "thinking_delta" => {
                        let t = delta.get("thinking").and_then(|t| t.as_str()).unwrap_or("");
                        if t.is_empty() {
                            return Vec::new();
                        }
                        self.claude_streamed_content = true;
                        block.buffer.push_str(t);
                        let mut out = Vec::new();
                        if !block.started {
                            block.started = true;
                            block.our_index = self.next_index;
                            self.next_index += 1;
                            out.push(am(json!({
                                "type": "thinking_start",
                                "contentIndex": block.our_index,
                            })));
                        }
                        out.push(am(json!({
                            "type": "thinking_delta",
                            "contentIndex": block.our_index,
                            "delta": t,
                        })));
                        out
                    }
                    "input_json_delta" => {
                        let t = delta
                            .get("partial_json")
                            .and_then(|t| t.as_str())
                            .unwrap_or("");
                        block.buffer.push_str(t);
                        Vec::new()
                    }
                    _ => Vec::new(),
                }
            }
            "content_block_stop" => {
                let idx = event.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
                let Some(block) = self.live_blocks.get_mut(&idx) else {
                    return Vec::new();
                };
                if block.closed {
                    return Vec::new();
                }
                block.closed = true;
                let our_index = block.our_index;
                match block.kind {
                    LiveKind::Text => {
                        let text = std::mem::take(&mut block.buffer);
                        self.assistant_blocks
                            .push(json!({ "type": "text", "text": text }));
                        vec![am(json!({
                            "type": "text_end",
                            "contentIndex": our_index,
                            "content": text,
                        }))]
                    }
                    LiveKind::Thinking => {
                        // Never started: signature-only block (thinking
                        // display omitted) — nothing was opened, nothing to
                        // close or persist.
                        if !block.started {
                            return Vec::new();
                        }
                        let text = std::mem::take(&mut block.buffer);
                        self.assistant_blocks
                            .push(json!({ "type": "thinking", "thinking": text }));
                        vec![am(json!({
                            "type": "thinking_end",
                            "contentIndex": our_index,
                            "content": text,
                        }))]
                    }
                    LiveKind::ToolUse => {
                        let (id, name) = block.tool.clone().unwrap_or_default();
                        let args: Value = serde_json::from_str(&block.buffer).unwrap_or(json!({}));
                        self.assistant_blocks.push(json!({
                            "type": "toolCall", "id": id, "name": name, "arguments": args,
                        }));
                        vec![am(json!({
                            "type": "toolcall_end",
                            "contentIndex": our_index,
                            "toolCall": { "id": id, "name": name, "arguments": args },
                        }))]
                    }
                }
            }
            "message_delta" => {
                if let Some(output) = event
                    .pointer("/usage/output_tokens")
                    .and_then(Value::as_u64)
                {
                    self.claude_context_used = self.claude_context_used.saturating_add(output);
                }
                self.claude_context_event().into_iter().collect()
            }
            _ => Vec::new(),
        }
    }
}
