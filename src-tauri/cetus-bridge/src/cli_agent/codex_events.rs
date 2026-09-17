use super::{codex_text_phase, BackgroundTask, CodexToolOutput, EventTranslator, LiveKind};
use serde_json::{json, Value};

impl EventTranslator {
    pub(super) fn on_codex(&mut self, v: &Value) -> Vec<Value> {
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match ty {
            "thread.started" => {
                if let Some(tid) = v.get("thread_id").and_then(|s| s.as_str()) {
                    self.resume_id = Some(tid.to_string());
                }
                Vec::new()
            }
            "item.agent_message.delta" => {
                let id = v
                    .get("item_id")
                    .and_then(Value::as_str)
                    .unwrap_or("message");
                let delta = v.get("delta").and_then(Value::as_str).unwrap_or("");
                self.emit_codex_delta(format!("message:{id}"), id, LiveKind::Text, delta)
            }
            "item.reasoning.summary_delta" => {
                let id = v
                    .get("item_id")
                    .and_then(Value::as_str)
                    .unwrap_or("reasoning");
                let part = v.get("summary_index").and_then(Value::as_i64).unwrap_or(0);
                let delta = v.get("delta").and_then(Value::as_str).unwrap_or("");
                self.emit_codex_delta(
                    format!("reasoning-summary:{id}:{part}"),
                    id,
                    LiveKind::Thinking,
                    delta,
                )
            }
            "item.reasoning.text_delta" => {
                let id = v
                    .get("item_id")
                    .and_then(Value::as_str)
                    .unwrap_or("reasoning");
                let part = v.get("content_index").and_then(Value::as_i64).unwrap_or(0);
                let delta = v.get("delta").and_then(Value::as_str).unwrap_or("");
                self.emit_codex_delta(
                    format!("reasoning-text:{id}:{part}"),
                    id,
                    LiveKind::Thinking,
                    delta,
                )
            }
            "item.plan.delta" => {
                let id = v.get("item_id").and_then(Value::as_str).unwrap_or("plan");
                let delta = v.get("delta").and_then(Value::as_str).unwrap_or("");
                self.emit_codex_delta(format!("plan:{id}"), id, LiveKind::Thinking, delta)
            }
            "item.tool_output.delta" => {
                let id = v.get("item_id").and_then(Value::as_str).unwrap_or("item");
                let delta = v.get("delta").and_then(Value::as_str).unwrap_or("");
                if delta.is_empty() || !self.started_items.contains(id) {
                    return Vec::new();
                }
                let output = self
                    .codex_tool_output
                    .entry(id.to_string())
                    .or_insert_with(CodexToolOutput::new);
                output.push(delta);
                output.flush(id, false).into_iter().collect()
            }
            // A command starts executing: show its tool card immediately (with
            // a running spinner via tool_execution_start) instead of waiting
            // for completion — matches how the codex TUI surfaces commands.
            "item.started" => {
                let item = match v.get("item") {
                    Some(i) => i,
                    None => return Vec::new(),
                };
                let item_ty = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if item_ty == "agent_message" {
                    if let (Some(id), Some(phase)) = (
                        item.get("id").and_then(Value::as_str),
                        codex_text_phase(item),
                    ) {
                        self.codex_message_phases
                            .insert(id.to_string(), phase.to_string());
                    }
                    return Vec::new();
                }
                if item_ty == "user_message" {
                    return self.splice_codex_steer();
                }
                if item_ty == "collab_agent_tool_call" {
                    if item.get("tool").and_then(|t| t.as_str()) != Some("spawnAgent") {
                        return Vec::new();
                    }
                    let id = item.get("id").and_then(|t| t.as_str()).unwrap_or("item");
                    let Some(thread_id) = item
                        .get("receiver_thread_ids")
                        .and_then(Value::as_array)
                        .and_then(|ids| ids.first())
                        .and_then(Value::as_str)
                    else {
                        return Vec::new();
                    };
                    let description = item
                        .get("prompt")
                        .and_then(Value::as_str)
                        .unwrap_or("background task")
                        .to_string();
                    let subagent_type = item
                        .get("model")
                        .and_then(Value::as_str)
                        .unwrap_or("Codex")
                        .to_string();
                    let task = BackgroundTask {
                        tool_use_id: id.to_string(),
                        subagent_type,
                        description: description.clone(),
                        done: false,
                        steps: Vec::new(),
                        status_text: String::new(),
                    };
                    self.background_tasks
                        .insert(thread_id.to_string(), task.clone());
                    let mut out = self.emit_tool_call(
                        id,
                        "Agent",
                        &json!({ "prompt": description, "threadId": thread_id }),
                    );
                    out.push(json!({ "type": "tool_execution_start", "toolCallId": id }));
                    out.push(json!({
                        "type": "tool_execution_update",
                        "toolCallId": id,
                        "partialResult": {
                            "content": [{ "type": "text", "text": "Agent running in background" }],
                            "details": task.details("running"),
                        },
                    }));
                    return out;
                }
                if matches!(
                    item_ty,
                    "dynamic_tool_call" | "image_generation" | "mcp_tool_call"
                ) {
                    let id = item.get("id").and_then(Value::as_str).unwrap_or("item");
                    let name = if item_ty == "image_generation" {
                        "image_generation"
                    } else {
                        item.get("tool").and_then(Value::as_str).unwrap_or("tool")
                    };
                    let args = item.get("arguments").cloned().unwrap_or(Value::Null);
                    self.started_items.insert(id.to_string());
                    let mut out = self.emit_tool_call(id, name, &args);
                    out.push(json!({ "type": "tool_execution_start", "toolCallId": id }));
                    return out;
                }
                if item_ty == "file_change" {
                    let id = item.get("id").and_then(Value::as_str).unwrap_or("item");
                    let changes = item.get("changes").cloned().unwrap_or(Value::Null);
                    self.started_items.insert(id.to_string());
                    let mut out = self.emit_tool_call(id, "apply_patch", &changes);
                    out.push(json!({ "type": "tool_execution_start", "toolCallId": id }));
                    return out;
                }
                if matches!(item_ty, "web_search" | "image_view" | "sleep") {
                    let id = item.get("id").and_then(Value::as_str).unwrap_or("item");
                    let (name, args) = match item_ty {
                        "web_search" => (
                            "web_search",
                            json!({ "query": item.get("query").cloned().unwrap_or(Value::Null) }),
                        ),
                        "image_view" => (
                            "view_image",
                            json!({ "path": item.get("path").cloned().unwrap_or(Value::Null) }),
                        ),
                        _ => (
                            "wait",
                            json!({ "durationMs": item.get("durationMs").or_else(|| item.get("duration_ms")).cloned().unwrap_or(Value::Null) }),
                        ),
                    };
                    self.started_items.insert(id.to_string());
                    let mut out = self.emit_tool_call(id, name, &args);
                    out.push(json!({ "type": "tool_execution_start", "toolCallId": id }));
                    return out;
                }
                if item_ty != "command_execution" {
                    return Vec::new();
                }
                let id = item.get("id").and_then(|t| t.as_str()).unwrap_or("item");
                self.started_items.insert(id.to_string());
                let cmd = item.get("command").cloned().unwrap_or(Value::Null);
                let mut out = self.emit_tool_call(id, "shell", &json!({ "command": cmd }));
                out.push(json!({ "type": "tool_execution_start", "toolCallId": id }));
                out
            }
            "item.completed" => {
                let item = match v.get("item") {
                    Some(i) => i,
                    None => return Vec::new(),
                };
                let item_ty = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
                let id = item.get("id").and_then(|t| t.as_str()).unwrap_or("item");
                match item_ty {
                    "agent_message" => {
                        let t = item.get("text").and_then(|t| t.as_str()).unwrap_or("");
                        if let Some(phase) = codex_text_phase(item) {
                            self.codex_message_phases
                                .insert(id.to_string(), phase.to_string());
                        }
                        let phase = self.codex_message_phases.get(id).cloned();
                        let streamed = self.close_codex_item(id, Some(t));
                        if !streamed.is_empty() {
                            streamed
                        } else if !t.is_empty() {
                            self.emit_text_with_phase(t, phase.as_deref())
                        } else {
                            Vec::new()
                        }
                    }
                    "reasoning" => {
                        let completed = item
                            .get("summary")
                            .and_then(Value::as_array)
                            .filter(|parts| !parts.is_empty())
                            .or_else(|| item.get("content").and_then(Value::as_array))
                            .map(|parts| {
                                parts
                                    .iter()
                                    .filter_map(Value::as_str)
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            })
                            .or_else(|| {
                                item.get("text").and_then(Value::as_str).map(str::to_string)
                            })
                            .unwrap_or_default();
                        let streamed = self.close_codex_item(id, Some(&completed));
                        if !streamed.is_empty() {
                            streamed
                        } else if !completed.is_empty() {
                            self.emit_thinking(&completed)
                        } else {
                            Vec::new()
                        }
                    }
                    "plan" => {
                        let completed = item.get("text").and_then(Value::as_str).unwrap_or("");
                        let streamed = self.close_codex_item(id, Some(completed));
                        if !streamed.is_empty() {
                            streamed
                        } else if !completed.is_empty() {
                            self.emit_thinking(completed)
                        } else {
                            Vec::new()
                        }
                    }
                    "command_execution" => {
                        let mut out = self
                            .codex_tool_output
                            .get_mut(id)
                            .and_then(|output| output.flush(id, true))
                            .into_iter()
                            .collect::<Vec<_>>();
                        self.codex_tool_output.remove(id);
                        let output = item
                            .get("aggregated_output")
                            .or_else(|| item.get("output"))
                            .cloned()
                            .unwrap_or(Value::Null);
                        let is_err = item
                            .get("exit_code")
                            .and_then(|c| c.as_i64())
                            .map(|c| c != 0)
                            .unwrap_or(false);
                        // Card already emitted at item.started (normal path) —
                        // just attach the result; emit the full pair otherwise.
                        if self.started_items.remove(id) {
                            out.extend(self.emit_codex_command_result_end(id, &output, is_err));
                            return out;
                        }
                        let cmd = item.get("command").cloned().unwrap_or(Value::Null);
                        let args = json!({ "command": cmd });
                        let mut completed = self.emit_tool_call(id, "shell", &args);
                        completed.push(json!({ "type": "tool_execution_start", "toolCallId": id }));
                        completed.extend(self.emit_codex_command_result_end(id, &output, is_err));
                        completed
                    }
                    "file_change" => {
                        let changes = item.get("changes").cloned().unwrap_or(Value::Null);
                        if self.started_items.remove(id) {
                            self.emit_tool_result_end(id, &json!("applied"), false)
                        } else {
                            let mut out = self.emit_tool_call(id, "apply_patch", &changes);
                            out.extend(self.emit_tool_result(id, &json!("applied"), false));
                            out
                        }
                    }
                    "mcp_tool_call" => {
                        let name = item
                            .get("tool")
                            .and_then(|t| t.as_str())
                            .unwrap_or("mcp_tool");
                        let args = item.get("arguments").cloned().unwrap_or(Value::Null);
                        let result = item.get("result").cloned().unwrap_or(Value::Null);
                        if self.started_items.remove(id) {
                            self.emit_tool_result_end(id, &result, false)
                        } else {
                            let mut out = self.emit_tool_call(id, name, &args);
                            out.extend(self.emit_tool_result(id, &result, false));
                            out
                        }
                    }
                    "dynamic_tool_call" => {
                        let name = item.get("tool").and_then(Value::as_str).unwrap_or("tool");
                        let args = item.get("arguments").cloned().unwrap_or(Value::Null);
                        let result = item
                            .get("content_items")
                            .or_else(|| item.get("result"))
                            .cloned()
                            .unwrap_or(Value::Null);
                        let is_err = item.get("success").and_then(Value::as_bool) == Some(false);
                        if self.started_items.remove(id) {
                            return self.emit_tool_result_end(id, &result, is_err);
                        }
                        let mut out = self.emit_tool_call(id, name, &args);
                        out.extend(self.emit_tool_result(id, &result, is_err));
                        out
                    }
                    "image_generation" => {
                        let result = if let Some(path) =
                            item.get("saved_path").and_then(Value::as_str)
                        {
                            json!({ "type": "file", "path": path, "mimeType": "image/png" })
                        } else {
                            json!({
                                "type": "image",
                                "data": item.get("result").and_then(Value::as_str).unwrap_or(""),
                                "mimeType": "image/png"
                            })
                        };
                        if self.started_items.remove(id) {
                            return self.emit_tool_result_end(id, &result, false);
                        }
                        let mut out = self.emit_tool_call(id, "image_generation", &Value::Null);
                        out.extend(self.emit_tool_result(id, &result, false));
                        out
                    }
                    "web_search" | "image_view" | "sleep" => {
                        let result = match item_ty {
                            "web_search" => json!(item
                                .get("query")
                                .and_then(Value::as_str)
                                .map(|query| format!("Search completed: {query}"))
                                .unwrap_or_else(|| "Search completed".to_string())),
                            "image_view" => json!(item
                                .get("path")
                                .and_then(Value::as_str)
                                .map(|path| format!("Viewed {path}"))
                                .unwrap_or_else(|| "Image viewed".to_string())),
                            _ => json!("Wait completed"),
                        };
                        if self.started_items.remove(id) {
                            self.emit_tool_result_end(id, &result, false)
                        } else {
                            let name = match item_ty {
                                "web_search" => "web_search",
                                "image_view" => "view_image",
                                _ => "wait",
                            };
                            let mut out = self.emit_tool_call(id, name, &Value::Null);
                            out.extend(self.emit_tool_result(id, &result, false));
                            out
                        }
                    }
                    "collab_agent_tool_call" => {
                        let Some(states) = item.get("agents_states").and_then(Value::as_object)
                        else {
                            return Vec::new();
                        };
                        let mut out = Vec::new();
                        for (thread_id, state) in states {
                            let Some(task) = self.background_tasks.get_mut(thread_id) else {
                                continue;
                            };
                            if task.done {
                                continue;
                            }
                            let status = state
                                .get("status")
                                .and_then(Value::as_str)
                                .unwrap_or("running");
                            let terminal = matches!(
                                status,
                                "completed" | "interrupted" | "errored" | "shutdown" | "notFound"
                            );
                            task.done = terminal;
                            let task = task.clone();
                            let text = state
                                .get("message")
                                .and_then(Value::as_str)
                                .filter(|s| !s.trim().is_empty())
                                .map(str::to_string)
                                .unwrap_or_else(|| {
                                    format!("{} agent {status}", task.subagent_type)
                                });
                            if terminal {
                                out.extend(self.emit_tool_result_end_with_details(
                                    &task.tool_use_id,
                                    &json!(text),
                                    task.details(status),
                                    status != "completed",
                                ));
                            } else {
                                out.push(json!({
                                    "type": "tool_execution_update",
                                    "toolCallId": task.tool_use_id,
                                    "partialResult": {
                                        "content": [{ "type": "text", "text": text }],
                                        "details": task.details("running"),
                                    },
                                }));
                            }
                        }
                        out
                    }
                    "error" => {
                        let msg = item
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("error");
                        self.emit_text(&format!("⚠️ {msg}"))
                    }
                    _ => Vec::new(),
                }
            }
            // "turn.completed" is terminal; finish() closes the turn.
            _ => Vec::new(),
        }
    }
}
