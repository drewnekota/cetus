use super::{
    params, row_to_conversation, Conversation, ModelChoice, OptionalExtension, Result, Store,
};

impl Store {
    pub fn insert(&self, c: &Conversation) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO conversations (id, title, session_file, workspace_dir, ds_model, reasoning, created_at, updated_at, archived_at, unread_at, source_automation_id, parallel_group_id, solution_index, review_state, backend, cli_model, cli_effort, run_state, pinned_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
            params![
                c.id,
                c.title,
                c.session_file,
                c.workspace_dir,
                c.model.model.to_persist(),
                c.model.reasoning.as_str(),
                c.created_at,
                c.updated_at,
                c.archived_at,
                c.unread_at,
                c.source_automation_id,
                c.parallel_group_id,
                c.solution_index,
                c.review_state,
                c.backend,
                c.cli_model,
                c.cli_effort,
                c.run_state,
                c.pinned_at,
            ],
        )?;
        Ok(())
    }

    pub fn list(&self, include_archived: bool) -> Result<Vec<Conversation>> {
        let conn = self.read_conn.lock().unwrap();
        let sql = if include_archived {
            "SELECT id, title, session_file, workspace_dir, ds_model, reasoning, created_at, updated_at, archived_at, unread_at, source_automation_id, parallel_group_id, solution_index, review_state, backend, cli_model, cli_effort, run_state, pinned_at
             FROM conversations WHERE archived_at IS NOT NULL ORDER BY archived_at DESC"
        } else {
            "SELECT id, title, session_file, workspace_dir, ds_model, reasoning, created_at, updated_at, archived_at, unread_at, source_automation_id, parallel_group_id, solution_index, review_state, backend, cli_model, cli_effort, run_state, pinned_at
             FROM conversations WHERE archived_at IS NULL ORDER BY updated_at DESC"
        };
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map([], row_to_conversation)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn get(&self, id: &str) -> Result<Option<Conversation>> {
        let conn = self.read_conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, title, session_file, workspace_dir, ds_model, reasoning, created_at, updated_at, archived_at, unread_at, source_automation_id, parallel_group_id, solution_index, review_state, backend, cli_model, cli_effort, run_state, pinned_at
             FROM conversations WHERE id = ?1",
        )?;
        let row = stmt
            .query_row(params![id], row_to_conversation)
            .optional()?;
        Ok(row)
    }

    pub fn set_archived(&self, id: &str, archived: bool, ts: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let value: Option<i64> = if archived { Some(ts) } else { None };
        // Archiving is an explicit dismissal, so it also clears the unread dot —
        // otherwise a restored chat would come back wearing a stale badge. (The
        // auto-archive sweep never reaches an unread row; see auto_archive.rs.)
        conn.execute(
            "UPDATE conversations SET archived_at = ?1, updated_at = ?2, unread_at = NULL WHERE id = ?3",
            params![value, ts, id],
        )?;
        Ok(())
    }

    /// Set/clear the unread marker. Deliberately does NOT touch `updated_at`:
    /// reading a chat isn't activity, and bumping it would reorder the sidebar
    /// and reset the auto-archive idle clock.
    pub fn set_unread(&self, id: &str, unread_at: Option<i64>) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE conversations SET unread_at = ?1 WHERE id = ?2",
            params![unread_at, id],
        )?;
        Ok(())
    }

    /// Set/clear the project-scoped pin. Like `set_unread`, deliberately does
    /// NOT touch `updated_at`: pinning isn't activity, and bumping it would
    /// reorder the recency sort and reset the auto-archive idle clock.
    pub fn set_pinned(&self, id: &str, pinned_at: Option<i64>) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE conversations SET pinned_at = ?1 WHERE id = ?2",
            params![pinned_at, id],
        )?;
        Ok(())
    }

    pub fn rename(&self, id: &str, title: &str, ts: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE conversations SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![title, ts, id],
        )?;
        Ok(())
    }

    /// Switch a conversation's backend AND swap its resume token: the current
    /// session_file (the active runtime's resume token — claude session_id /
    /// codex thread_id / pi session jsonl path) is stashed in `resume_tokens`
    /// under the old backend id, and the new backend's stashed token (if any)
    /// is restored into session_file. Without the swap the next turn would run
    /// e.g. `claude --resume <codex-thread-id>` — a guaranteed resume failure
    /// that also destroys the old runtime's token.
    ///
    /// Returns the previous backend id when a switch actually happened, None
    /// when the conversation is missing or already on `new_backend`.
    pub fn switch_backend(&self, id: &str, new_backend: &str, ts: i64) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let row: Option<(String, String, String)> = conn
            .query_row(
                "SELECT backend, session_file, resume_tokens FROM conversations WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((old_backend, session_file, tokens_raw)) = row else {
            return Ok(None);
        };
        if old_backend == new_backend {
            return Ok(None);
        }
        let mut tokens: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(&tokens_raw).unwrap_or_default();
        if session_file.is_empty() {
            tokens.remove(&old_backend);
        } else {
            tokens.insert(old_backend.clone(), serde_json::Value::String(session_file));
        }
        let restored = tokens
            .get(new_backend)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        conn.execute(
            "UPDATE conversations
             SET backend = ?1, session_file = ?2, resume_tokens = ?3, updated_at = ?4
             WHERE id = ?5",
            params![
                new_backend,
                restored,
                serde_json::Value::Object(tokens).to_string(),
                ts,
                id
            ],
        )?;
        Ok(Some(old_backend))
    }

    /// Set the CLI backend's model + reasoning-effort overrides for a
    /// conversation (empty → the CLI's configured default).
    pub fn set_cli_model(&self, id: &str, model: &str, effort: &str, ts: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE conversations SET cli_model = ?1, cli_effort = ?2, updated_at = ?3 WHERE id = ?4",
            params![model, effort, ts, id],
        )?;
        Ok(())
    }

    pub fn touch(&self, id: &str, ts: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
            params![ts, id],
        )?;
        Ok(())
    }

    /// Most recent `updated_at` across non-archived conversations (0 if none).
    /// Backs "cetus has been quiet" gates cheaply — callers use
    /// `idx_conv_updated` instead of materializing the whole conversation list
    /// every tick just to take a max.
    pub fn latest_activity_ms(&self) -> Result<i64> {
        let conn = self.read_conn.lock().unwrap();
        let v: Option<i64> = conn.query_row(
            "SELECT MAX(updated_at) FROM conversations WHERE archived_at IS NULL",
            [],
            |r| r.get(0),
        )?;
        Ok(v.unwrap_or(0))
    }

    pub fn set_title_if_empty(&self, id: &str, title: &str, ts: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE conversations SET title = ?1, updated_at = ?2 WHERE id = ?3 AND (title = '' OR title IS NULL)",
            params![title, ts, id],
        )?;
        Ok(())
    }

    /// Record the pi session file once it's been created. `new_conversation`
    /// inserts the row with an empty session_file (no eager pi spawn); `pi_for`
    /// mints the session lazily on first use and persists it here.
    pub fn set_session_file(&self, id: &str, session_file: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE conversations SET session_file = ?1 WHERE id = ?2",
            params![session_file, id],
        )?;
        Ok(())
    }

    pub fn set_model(&self, id: &str, choice: &ModelChoice, ts: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE conversations SET ds_model = ?1, reasoning = ?2, updated_at = ?3 WHERE id = ?4",
            params![choice.model.to_persist(), choice.reasoning.as_str(), ts, id],
        )?;
        Ok(())
    }

    /// Set the human-in-the-loop review state ("none" | "pending" | "approved"
    /// | "changes_requested"). Bumps updated_at so the board re-sorts the card.
    pub fn set_review_state(&self, id: &str, state: &str, ts: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE conversations SET review_state = ?1, updated_at = ?2 WHERE id = ?3",
            params![state, ts, id],
        )?;
        Ok(())
    }

    /// Set the persisted turn lifecycle ("idle" | "running" | "aborted" |
    /// "interrupted"). Deliberately does NOT touch `updated_at`: this is
    /// machine state flipping on every turn, and bumping it would reorder the
    /// sidebar and reset the auto-archive idle clock.
    pub fn set_run_state(&self, id: &str, state: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        // A settled turn (idle/aborted) refunds the one-shot auto-resume
        // budget: the next interruption is a fresh incident, not a repeat of
        // the one that already got its automatic retry.
        conn.execute(
            "UPDATE conversations SET run_state = ?1,
                    auto_resumed = CASE WHEN ?1 IN ('idle', 'aborted') THEN 0 ELSE auto_resumed END
             WHERE id = ?2",
            params![state, id],
        )?;
        Ok(())
    }

    /// Claim the one-shot auto-resume for an interrupted conversation.
    /// Atomic: only the caller that flips `auto_resumed` 0 → 1 while the row
    /// is still "interrupted" gets `true`; a conversation whose auto-resume
    /// already ran (and got interrupted again before settling) gets `false`
    /// and falls back to the manual Resume banner.
    pub fn claim_auto_resume(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE conversations SET auto_resumed = 1
             WHERE id = ?1 AND run_state = 'interrupted' AND auto_resumed = 0",
            params![id],
        )?;
        Ok(n > 0)
    }

    /// Demote every "running" row to "interrupted". Called on app exit (the
    /// still-registered turns are about to be killed) and again at boot — a
    /// crash or kill -9 never reaches the exit hook, but a fresh process can't
    /// have live turns, so any leftover "running" row was cut down mid-run.
    /// Returns how many rows flipped.
    pub fn mark_running_interrupted(&self) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE conversations SET run_state = 'interrupted' WHERE run_state = 'running'",
            [],
        )?;
        Ok(n)
    }

    /// Dismiss an interrupted-run marker without resuming. Guarded on the
    /// current state so it can't stomp a turn that started in the meantime.
    pub fn clear_interrupted(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE conversations SET run_state = 'idle', auto_resumed = 0 WHERE id = ?1 AND run_state = 'interrupted'",
            params![id],
        )?;
        Ok(())
    }

    pub fn set_workspace(&self, id: &str, dir: &str, ts: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE conversations SET workspace_dir = ?1, updated_at = ?2 WHERE id = ?3",
            params![dir, ts, id],
        )?;
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
        Ok(())
    }
}
