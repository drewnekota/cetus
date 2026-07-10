//! SQLite-backed metadata for conversations.
//! Messages themselves live in pi's session jsonl files; we only own the index.
//!
//! Schema is reset on major rewrites by bumping SCHEMA_VERSION below. We're in
//! pre-1.0; users are devs; we don't preserve old data across breaking shape
//! changes.

use crate::automation::{Automation, AutomationSchedule};
use crate::model::{DsModel, ModelChoice, ReasoningLevel};
use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const SCHEMA_VERSION: i64 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub session_file: String,
    /// Absolute path the agent should treat as its working directory.
    pub workspace_dir: String,
    pub model: ModelChoice,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived_at: Option<i64>,
    /// Set when this conversation was minted by an automation firing — carries
    /// that automation's id so the UI can badge the run. None for user chats.
    pub source_automation_id: Option<String>,
    /// Set when this conversation is one candidate of a parallel-solutions task
    /// — shared by all siblings of the same task so the UI can cluster them and
    /// surface a side-by-side review. None for ordinary conversations.
    pub parallel_group_id: Option<String>,
    /// Which candidate (0-based) this is within its [`parallel_group_id`]. None
    /// for ordinary conversations.
    pub solution_index: Option<i64>,
    /// Human-in-the-loop review state, set by the `request_review` tool and the
    /// board's approve / send-back actions. "none" (default, normal flow) |
    /// "pending" (agent asked for review → sits in the board's "Needs review"
    /// column) | "approved" | "changes_requested".
    pub review_state: String,
    /// Which agent runtime backs this conversation: "pi" (default, the built-in
    /// harness) | "claude-code" | "codex" (headless CLI backends orchestrated via
    /// [`cetus_bridge::cli_agent`]). Additive; pre-existing rows default to "pi".
    #[serde(default = "default_backend")]
    pub backend: String,
    /// Model override passed to the CLI backend (`claude --model` / `codex -m`).
    /// Empty → the CLI's own configured default. Unused for pi (which has the
    /// typed ds_model/reasoning pair instead).
    #[serde(default)]
    pub cli_model: String,
    /// Reasoning-effort override for the CLI backend (`claude --effort` /
    /// codex `model_reasoning_effort`). Empty → the CLI's default.
    #[serde(default)]
    pub cli_effort: String,
}

/// Default backend for rows/payloads that predate the `backend` column.
pub fn default_backend() -> String {
    "pi".to_string()
}

/// One captured screen frame. Heavy pixels stay on disk at `file_path`; this
/// is the searchable index row.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Screenshot {
    pub id: String,
    pub ts: i64,
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub file_path: String,
    /// Small JPEG variant beside the full frame, for the grid/palette previews.
    /// None for frames captured before thumbnails existed (client falls back to
    /// `file_path`).
    pub thumb_path: Option<String>,
    pub phash: Option<i64>,
    pub bytes: i64,
    pub ocr_text: Option<String>,
}

/// One observed ambient-context change: structured text read off the frontmost
/// app's accessibility tree (window title + visible text + browser URL). Text
/// only — the pixel-based sibling is [`Screenshot`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AxContextEntry {
    pub id: String,
    pub ts: i64,
    pub app_name: Option<String>,
    pub bundle_id: Option<String>,
    pub window_title: Option<String>,
    pub url: Option<String>,
    pub page_title: Option<String>,
    pub text: String,
    pub text_hash: Option<i64>,
}

/// One recorded meeting (ambient-audio transcription session). Transcript text
/// lives in `meeting_segments`; this is the session header the UI lists.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meeting {
    pub id: String,
    pub started_ts: i64,
    pub ended_ts: Option<i64>,
    /// Model-generated short title; None until the post-meeting summary ran.
    pub title: Option<String>,
    /// Model-generated markdown minutes; None when summaries are off/skipped.
    pub summary: Option<String>,
    /// Bundle id of the app that triggered auto-detection (e.g. "us.zoom.xos").
    /// None for manual sessions.
    pub app_name: Option<String>,
    pub segment_count: i64,
}

/// One transcript segment within a meeting. `source` is "mic" (the user) or
/// "system" (everyone else, heard through the speakers).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSegment {
    pub ts: i64,
    pub source: String,
    pub text: String,
}

pub struct Store {
    /// The write connection. All mutations (and anything that must read its own
    /// just-written row) go through this single serialized handle.
    conn: Mutex<Connection>,
    /// A second connection to the same WAL database, dedicated to hot read paths
    /// (conversation list/get, settings, automations, screenshot + meeting
    /// queries). WAL lets a reader run concurrently with the writer, so UI reads
    /// no longer block behind the continuous screen-capture / meeting-segment
    /// writes that monopolised the single connection. Writers see no change.
    read_conn: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let mut conn = open_conn(path)?;
        // Corruption guard: if the database is unreadable, quarantine it (and its
        // -wal/-shm siblings) to a `.corrupt.<ts>.bak` and start fresh, rather
        // than crashing on every launch or operating on a torn file. We only own
        // an index here (messages live in pi's session jsonl), so a rebuilt empty
        // index is recoverable — silently reading a corrupt one is not.
        if !integrity_ok(&conn) {
            tracing::error!(
                "sqlite integrity check failed for {}; quarantining and starting fresh",
                path.display()
            );
            drop(conn);
            quarantine(path);
            conn = open_conn(path)?;
        }
        // Schema evolution is ADDITIVE ONLY — we never drop user data on a
        // version bump. Older shapes are reconciled column-by-column via
        // `ensure_column` below; `user_version` is just a marker we keep current.
        let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if current != SCHEMA_VERSION {
            tracing::info!("schema {current} -> {SCHEMA_VERSION}, reconciling additively");
        }
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                session_file TEXT NOT NULL,
                workspace_dir TEXT NOT NULL,
                ds_model TEXT NOT NULL DEFAULT 'pro',
                reasoning TEXT NOT NULL DEFAULT 'think_high',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                archived_at INTEGER,
                source_automation_id TEXT,
                parallel_group_id TEXT,
                solution_index INTEGER,
                review_state TEXT NOT NULL DEFAULT 'none',
                backend TEXT NOT NULL DEFAULT 'pi',
                cli_model TEXT NOT NULL DEFAULT '',
                cli_effort TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_conv_archived ON conversations (archived_at);
            CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations (updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_conv_workspace ON conversations (workspace_dir);

            -- Generic key/value bag for app-level preferences (e.g. the quick
            -- launcher config). Additive: not tied to SCHEMA_VERSION so bumping
            -- the conversations schema never wipes user settings.
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            -- Scheduled automations (saved prompts that fire on a schedule).
            -- Additive like app_settings: not gated on SCHEMA_VERSION so a
            -- conversations-table reset never drops the user's automations.
            CREATE TABLE IF NOT EXISTS automations (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                prompt TEXT NOT NULL,
                workspace_dir TEXT NOT NULL,
                ds_model TEXT NOT NULL DEFAULT 'pro',
                reasoning TEXT NOT NULL DEFAULT 'think_high',
                schedule_json TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                next_run_at INTEGER,
                last_run_at INTEGER,
                last_conversation_id TEXT,
                last_status TEXT,
                last_error TEXT,
                run_count INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_automation_due ON automations (enabled, next_run_at);

            -- Rewind-like screen-context index. Heavy pixels live as JPEG files
            -- on disk (file_path); this table only holds the searchable text +
            -- metadata + a pointer. Additive like app_settings so it survives a
            -- conversations-table reset.
            CREATE TABLE IF NOT EXISTS screenshots (
                id TEXT PRIMARY KEY,
                ts INTEGER NOT NULL,
                app_name TEXT,
                window_title TEXT,
                file_path TEXT NOT NULL,
                phash INTEGER,
                bytes INTEGER NOT NULL DEFAULT 0,
                ocr_text TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_shot_ts ON screenshots (ts DESC);
            CREATE INDEX IF NOT EXISTS idx_shot_app ON screenshots (app_name);
            -- Standalone FTS5 index over OCR text (bundled rusqlite ships FTS5).
            -- We write (id, ocr_text) directly rather than using external-content
            -- so there are no triggers to keep in sync.
            CREATE VIRTUAL TABLE IF NOT EXISTS screenshots_fts
                USING fts5(id UNINDEXED, ocr_text);

            -- Meeting memory (ambient audio transcription). Text only — no
            -- audio is ever stored. Additive like app_settings so it survives
            -- a conversations-table reset. See meeting.rs.
            CREATE TABLE IF NOT EXISTS meetings (
                id TEXT PRIMARY KEY,
                started_ts INTEGER NOT NULL,
                ended_ts INTEGER,
                title TEXT,
                summary TEXT,
                app_name TEXT,
                segment_count INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_meeting_started ON meetings (started_ts DESC);
            CREATE TABLE IF NOT EXISTS meeting_segments (
                id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL,
                ts INTEGER NOT NULL,
                source TEXT NOT NULL,
                text TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_mseg_meeting ON meeting_segments (meeting_id, ts);

            -- Transcript rows for CLI-backend conversations (claude-code /
            -- codex). pi conversations replay history from their session jsonl;
            -- CLI turns have no such file, so each turn's messages (PiMessage
            -- JSON, the shape the chat UI renders) land here. `resume_before` on
            -- a user row is the backend resume token in effect BEFORE that turn,
            -- which is what retry/fork restore to roll a turn back. Additive
            -- like app_settings so it survives a conversations-table reset.
            CREATE TABLE IF NOT EXISTS cli_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT NOT NULL,
                message_json TEXT NOT NULL,
                resume_before TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_cli_msgs_conv ON cli_messages (conversation_id, id);

            -- Littlebird-like rolling ambient context: structured text read off
            -- the frontmost app's AX tree (no pixels, no keystrokes). One row per
            -- observed change; heavy dedup happens before insert. Additive like
            -- app_settings so it survives a conversations-table reset.
            CREATE TABLE IF NOT EXISTS ax_context (
                id TEXT PRIMARY KEY,
                ts INTEGER NOT NULL,
                app_name TEXT,
                bundle_id TEXT,
                window_title TEXT,
                url TEXT,
                page_title TEXT,
                text TEXT NOT NULL DEFAULT '',
                text_hash INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_axctx_ts ON ax_context (ts DESC);
            -- FTS over the visible text + titles, same trigger-free pattern as
            -- screenshots_fts.
            CREATE VIRTUAL TABLE IF NOT EXISTS ax_context_fts
                USING fts5(id UNINDEXED, text);
            "#,
        )?;
        // Additive column for automation-minted conversations. A DB created
        // before this column existed won't get it from CREATE TABLE (the table
        // already exists), so add it via a guarded ALTER — preserving the user's
        // chats instead of forcing a schema-reset drop.
        ensure_column(&conn, "conversations", "source_automation_id", "TEXT")?;
        // Parallel-solutions grouping. Additive like source_automation_id so an
        // existing DB keeps its chats instead of being dropped by a schema bump.
        ensure_column(&conn, "conversations", "parallel_group_id", "TEXT")?;
        ensure_column(&conn, "conversations", "solution_index", "INTEGER")?;
        // Human-in-the-loop review state. Additive so an existing DB keeps its
        // chats; defaults to 'none' for every pre-existing row.
        ensure_column(
            &conn,
            "conversations",
            "review_state",
            "TEXT NOT NULL DEFAULT 'none'",
        )?;
        // Coding-agent backend selector (pi | claude-code | codex). Additive so
        // an existing DB keeps its chats; pre-existing rows default to 'pi'.
        ensure_column(
            &conn,
            "conversations",
            "backend",
            "TEXT NOT NULL DEFAULT 'pi'",
        )?;
        ensure_column(
            &conn,
            "conversations",
            "cli_model",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column(
            &conn,
            "conversations",
            "cli_effort",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        // Per-runtime resume-token stash (JSON map: backend id → session_file
        // value). session_file only holds the ACTIVE runtime's token; switching
        // backends stashes the old one here and restores the new one, so a
        // conversation can hop claude-code → codex → back and still resume each
        // runtime's own session. Additive; pre-existing rows start empty.
        ensure_column(
            &conn,
            "conversations",
            "resume_tokens",
            "TEXT NOT NULL DEFAULT '{}'",
        )?;
        // Coding-agent backend for automations (pi | claude-code | codex) and
        // the CLI model override their fired conversations inherit. Additive.
        ensure_column(
            &conn,
            "automations",
            "backend",
            "TEXT NOT NULL DEFAULT 'pi'",
        )?;
        ensure_column(
            &conn,
            "automations",
            "cli_model",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column(
            &conn,
            "automations",
            "cli_effort",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        // Defensive: a conversations table created before ds_model/reasoning
        // existed (an older shape) won't get them from CREATE TABLE IF NOT
        // EXISTS. Add them additively so reconciliation never leaves a row the
        // reader can't map — the alternative used to be dropping the table.
        ensure_column(
            &conn,
            "conversations",
            "ds_model",
            "TEXT NOT NULL DEFAULT 'pro'",
        )?;
        ensure_column(
            &conn,
            "conversations",
            "reasoning",
            "TEXT NOT NULL DEFAULT 'think_high'",
        )?;
        // Thumbnail variant for the screen-history grid (see capture::save_jpeg).
        // Additive — frames captured before this column keep thumb_path = NULL
        // and the client falls back to the full image.
        ensure_column(&conn, "screenshots", "thumb_path", "TEXT")?;
        conn.execute(&format!("PRAGMA user_version = {SCHEMA_VERSION}"), [])?;
        // Open the dedicated read connection after the schema exists. Same file,
        // same WAL pragmas; it never writes, so it can read concurrently with the
        // writer above.
        let read_conn = open_conn(path)?;
        Ok(Self {
            conn: Mutex::new(conn),
            read_conn: Mutex::new(read_conn),
        })
    }

    pub fn insert(&self, c: &Conversation) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO conversations (id, title, session_file, workspace_dir, ds_model, reasoning, created_at, updated_at, archived_at, source_automation_id, parallel_group_id, solution_index, review_state, backend, cli_model, cli_effort)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                c.id,
                c.title,
                c.session_file,
                c.workspace_dir,
                c.model.model.as_str(),
                c.model.reasoning.as_str(),
                c.created_at,
                c.updated_at,
                c.archived_at,
                c.source_automation_id,
                c.parallel_group_id,
                c.solution_index,
                c.review_state,
                c.backend,
                c.cli_model,
                c.cli_effort,
            ],
        )?;
        Ok(())
    }

    pub fn list(&self, include_archived: bool) -> Result<Vec<Conversation>> {
        let conn = self.read_conn.lock().unwrap();
        let sql = if include_archived {
            "SELECT id, title, session_file, workspace_dir, ds_model, reasoning, created_at, updated_at, archived_at, source_automation_id, parallel_group_id, solution_index, review_state, backend, cli_model, cli_effort
             FROM conversations WHERE archived_at IS NOT NULL ORDER BY archived_at DESC"
        } else {
            "SELECT id, title, session_file, workspace_dir, ds_model, reasoning, created_at, updated_at, archived_at, source_automation_id, parallel_group_id, solution_index, review_state, backend, cli_model, cli_effort
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
            "SELECT id, title, session_file, workspace_dir, ds_model, reasoning, created_at, updated_at, archived_at, source_automation_id, parallel_group_id, solution_index, review_state, backend, cli_model, cli_effort
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
        conn.execute(
            "UPDATE conversations SET archived_at = ?1, updated_at = ?2 WHERE id = ?3",
            params![value, ts, id],
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
            tokens.insert(
                old_backend.clone(),
                serde_json::Value::String(session_file),
            );
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
    /// Backs the dreamer's "cetus has been quiet" gate cheaply — it uses
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

    pub fn set_model(&self, id: &str, choice: ModelChoice, ts: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE conversations SET ds_model = ?1, reasoning = ?2, updated_at = ?3 WHERE id = ?4",
            params![choice.model.as_str(), choice.reasoning.as_str(), ts, id],
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

    // ---- cli_messages (claude-code / codex transcripts) ---------------------

    /// Append one PiMessage-shaped JSON value to a CLI conversation's transcript.
    /// `resume_before` should be set on user rows only: the backend resume token
    /// in effect before the turn this message opens (empty conversation → None).
    pub fn append_cli_message(
        &self,
        conv_id: &str,
        message: &serde_json::Value,
        resume_before: Option<&str>,
        ts: i64,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO cli_messages (conversation_id, message_json, resume_before, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![conv_id, message.to_string(), resume_before, ts],
        )?;
        Ok(())
    }

    /// A CLI conversation's full transcript, oldest first, as PiMessage JSON.
    pub fn list_cli_messages(&self, conv_id: &str) -> Result<Vec<serde_json::Value>> {
        let conn = self.read_conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT message_json FROM cli_messages WHERE conversation_id = ?1 ORDER BY id ASC",
        )?;
        let rows = stmt.query_map(params![conv_id], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            if let Ok(v) = serde_json::from_str(&r?) {
                out.push(v);
            }
        }
        Ok(out)
    }

    /// A CLI conversation's transcript with row-level detail, oldest first:
    /// (row id, message JSON, resume token stored on the row). Fork truncation
    /// needs the per-row resume tokens; plain rendering uses
    /// [`Self::list_cli_messages`].
    pub fn list_cli_rows(
        &self,
        conv_id: &str,
    ) -> Result<Vec<(i64, serde_json::Value, Option<String>)>> {
        let conn = self.read_conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, message_json, resume_before FROM cli_messages
             WHERE conversation_id = ?1 ORDER BY id ASC",
        )?;
        let rows = stmt.query_map(params![conv_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })?;
        let mut out = Vec::new();
        for r in rows {
            let (id, json, resume) = r?;
            if let Ok(v) = serde_json::from_str(&json) {
                out.push((id, v, resume));
            }
        }
        Ok(out)
    }

    /// The most recent user row of a CLI conversation:
    /// (row id, message JSON, resume token in effect before that turn).
    pub fn last_cli_user_message(
        &self,
        conv_id: &str,
    ) -> Result<Option<(i64, serde_json::Value, Option<String>)>> {
        let conn = self.read_conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, message_json, resume_before FROM cli_messages
             WHERE conversation_id = ?1
               AND json_extract(message_json, '$.role') = 'user'
             ORDER BY id DESC LIMIT 1",
        )?;
        let row = stmt
            .query_row(params![conv_id], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })
            .optional()?;
        Ok(row.and_then(|(id, json, resume)| {
            serde_json::from_str(&json).ok().map(|v| (id, v, resume))
        }))
    }

    /// Drop transcript rows from `from_id` (inclusive) on — the retry rollback.
    pub fn delete_cli_messages_from(&self, conv_id: &str, from_id: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM cli_messages WHERE conversation_id = ?1 AND id >= ?2",
            params![conv_id, from_id],
        )?;
        Ok(())
    }

    /// Drop a conversation's whole CLI transcript (conversation deletion).
    pub fn delete_cli_messages(&self, conv_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM cli_messages WHERE conversation_id = ?1",
            params![conv_id],
        )?;
        Ok(())
    }

    /// Copy the first `limit` transcript rows (or all, when None) from one CLI
    /// conversation to another — the fork clone. Timestamps carry over so the
    /// fork reads as the same history.
    pub fn copy_cli_messages(&self, src: &str, dst: &str, limit: Option<usize>) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        match limit {
            Some(n) => conn.execute(
                "INSERT INTO cli_messages (conversation_id, message_json, resume_before, created_at)
                 SELECT ?2, message_json, resume_before, created_at FROM cli_messages
                 WHERE conversation_id = ?1 ORDER BY id ASC LIMIT ?3",
                params![src, dst, n as i64],
            )?,
            None => conn.execute(
                "INSERT INTO cli_messages (conversation_id, message_json, resume_before, created_at)
                 SELECT ?2, message_json, resume_before, created_at FROM cli_messages
                 WHERE conversation_id = ?1 ORDER BY id ASC",
                params![src, dst],
            )?,
        };
        Ok(())
    }

    // ---- app_settings key/value -------------------------------------------

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let conn = self.read_conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT value FROM app_settings WHERE key = ?1")?;
        let row = stmt.query_row(params![key], |r| r.get(0)).optional()?;
        Ok(row)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn delete_setting(&self, key: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM app_settings WHERE key = ?1", params![key])?;
        Ok(())
    }

    // ---- automations ------------------------------------------------------

    pub fn insert_automation(&self, a: &Automation) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO automations
                (id, name, prompt, workspace_dir, ds_model, reasoning, schedule_json,
                 enabled, created_at, updated_at, next_run_at, last_run_at,
                 last_conversation_id, last_status, last_error, run_count, backend, cli_model, cli_effort)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",
            params![
                a.id,
                a.name,
                a.prompt,
                a.workspace_dir,
                a.model.model.as_str(),
                a.model.reasoning.as_str(),
                serde_json::to_string(&a.schedule)?,
                a.enabled as i64,
                a.created_at,
                a.updated_at,
                a.next_run_at,
                a.last_run_at,
                a.last_conversation_id,
                a.last_status,
                a.last_error,
                a.run_count,
                a.backend,
                a.cli_model,
                a.cli_effort,
            ],
        )?;
        Ok(())
    }

    /// Overwrite every column from `a` (run-state included). The caller is
    /// responsible for carrying forward run-state it doesn't intend to change.
    pub fn update_automation(&self, a: &Automation) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE automations SET
                name=?2, prompt=?3, workspace_dir=?4, ds_model=?5, reasoning=?6,
                schedule_json=?7, enabled=?8, updated_at=?9, next_run_at=?10,
                last_run_at=?11, last_conversation_id=?12, last_status=?13,
                last_error=?14, run_count=?15, backend=?16, cli_model=?17, cli_effort=?18
             WHERE id=?1",
            params![
                a.id,
                a.name,
                a.prompt,
                a.workspace_dir,
                a.model.model.as_str(),
                a.model.reasoning.as_str(),
                serde_json::to_string(&a.schedule)?,
                a.enabled as i64,
                a.updated_at,
                a.next_run_at,
                a.last_run_at,
                a.last_conversation_id,
                a.last_status,
                a.last_error,
                a.run_count,
                a.backend,
                a.cli_model,
                a.cli_effort,
            ],
        )?;
        Ok(())
    }

    pub fn list_automations(&self) -> Result<Vec<Automation>> {
        let conn = self.read_conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "SELECT {AUTOMATION_COLS} FROM automations ORDER BY created_at DESC"
        ))?;
        let rows = stmt.query_map([], row_to_automation)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn get_automation(&self, id: &str) -> Result<Option<Automation>> {
        let conn = self.read_conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "SELECT {AUTOMATION_COLS} FROM automations WHERE id=?1"
        ))?;
        let row = stmt.query_row(params![id], row_to_automation).optional()?;
        Ok(row)
    }

    /// Enabled automations whose next fire is at or before `now`.
    pub fn list_due_automations(&self, now: i64) -> Result<Vec<Automation>> {
        let conn = self.read_conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "SELECT {AUTOMATION_COLS} FROM automations
             WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?1
             ORDER BY next_run_at ASC"
        ))?;
        let rows = stmt.query_map(params![now], row_to_automation)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn delete_automation(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM automations WHERE id=?1", params![id])?;
        Ok(())
    }

    pub fn set_automation_enabled(
        &self,
        id: &str,
        enabled: bool,
        next_run: Option<i64>,
        ts: i64,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE automations SET enabled=?2, next_run_at=?3, updated_at=?4 WHERE id=?1",
            params![id, enabled as i64, next_run, ts],
        )?;
        Ok(())
    }

    pub fn set_automation_next_run(&self, id: &str, next_run: Option<i64>, ts: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE automations SET next_run_at=?2, updated_at=?3 WHERE id=?1",
            params![id, next_run, ts],
        )?;
        Ok(())
    }

    /// Record the outcome of a run and advance the schedule. Bumps run_count.
    #[allow(clippy::too_many_arguments)]
    pub fn mark_automation_ran(
        &self,
        id: &str,
        ran_at: i64,
        conv_id: Option<&str>,
        status: &str,
        error: Option<&str>,
        next_run: Option<i64>,
        enabled: bool,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE automations SET
                last_run_at=?2, last_conversation_id=?3, last_status=?4,
                last_error=?5, next_run_at=?6, enabled=?7, updated_at=?2,
                run_count = run_count + 1
             WHERE id=?1",
            params![id, ran_at, conv_id, status, error, next_run, enabled as i64],
        )?;
        Ok(())
    }

    /// Record only the outcome of a run (last-run metadata + run_count); leaves
    /// `next_run_at`/`enabled` untouched. The scheduler advances the schedule
    /// BEFORE firing (at-most-once across a crash), so the post-fire write must
    /// NOT move the slot again — that's what this method is for.
    /// [`mark_automation_ran`] remains for callers that want the combined update.
    pub fn record_automation_outcome(
        &self,
        id: &str,
        ran_at: i64,
        conv_id: Option<&str>,
        status: &str,
        error: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE automations SET
                last_run_at=?2, last_conversation_id=?3, last_status=?4,
                last_error=?5, updated_at=?2, run_count = run_count + 1
             WHERE id=?1",
            params![id, ran_at, conv_id, status, error],
        )?;
        Ok(())
    }

    // ---- screenshots (screen-context collection) --------------------------

    pub fn insert_screenshot(&self, s: &Screenshot) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO screenshots
                (id, ts, app_name, window_title, file_path, phash, bytes, ocr_text, thumb_path)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                s.id,
                s.ts,
                s.app_name,
                s.window_title,
                s.file_path,
                s.phash,
                s.bytes,
                s.ocr_text,
                s.thumb_path,
            ],
        )?;
        Ok(())
    }

    /// Attach OCR text to an existing frame and (re)index it in FTS.
    pub fn set_screenshot_ocr(&self, id: &str, text: &str) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        // One transaction for the row update + FTS reindex: a crash between the
        // three statements would otherwise desync the FTS index from the row, and
        // it collapses three autocommits (three fsyncs) into one on a per-frame
        // hot path.
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE screenshots SET ocr_text = ?1 WHERE id = ?2",
            params![text, id],
        )?;
        tx.execute("DELETE FROM screenshots_fts WHERE id = ?1", params![id])?;
        tx.execute(
            "INSERT INTO screenshots_fts (id, ocr_text) VALUES (?1, ?2)",
            params![id, text],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Newest frames first. `before_ts` is an exclusive upper bound on `ts` for
    /// keyset pagination — pass the oldest already-loaded frame's ts to fetch the
    /// next older page; None for the first page.
    pub fn recent_screenshots(
        &self,
        limit: u32,
        before_ts: Option<i64>,
    ) -> Result<Vec<Screenshot>> {
        let conn = self.read_conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, ts, app_name, window_title, file_path, phash, bytes, ocr_text, thumb_path
             FROM screenshots WHERE ts < ?2 ORDER BY ts DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(
            params![limit, before_ts.unwrap_or(i64::MAX)],
            row_to_screenshot,
        )?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Full-text search over OCR'd frames, newest first, restricted to frames
    /// captured at or after `since_ts`. `before_ts` is the keyset-pagination
    /// cursor (exclusive upper bound). An empty query falls back to recent.
    pub fn search_screenshots(
        &self,
        query: &str,
        since_ts: i64,
        limit: u32,
        before_ts: Option<i64>,
    ) -> Result<Vec<Screenshot>> {
        let match_expr = fts_match_expr(query);
        if match_expr.is_empty() {
            let recent = self.recent_screenshots(limit, before_ts)?;
            return Ok(recent.into_iter().filter(|s| s.ts >= since_ts).collect());
        }
        let conn = self.read_conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT s.id, s.ts, s.app_name, s.window_title, s.file_path, s.phash, s.bytes, s.ocr_text, s.thumb_path
             FROM screenshots s JOIN screenshots_fts ON screenshots_fts.id = s.id
             WHERE screenshots_fts MATCH ?1 AND s.ts >= ?2 AND s.ts < ?4
             ORDER BY s.ts DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(
            params![match_expr, since_ts, limit, before_ts.unwrap_or(i64::MAX)],
            row_to_screenshot,
        )?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn screenshots_count(&self) -> Result<i64> {
        let conn = self.read_conn.lock().unwrap();
        Ok(conn.query_row("SELECT COUNT(*) FROM screenshots", [], |r| r.get(0))?)
    }

    /// Delete frames older than `before_ts`, returning their file paths so the
    /// caller can unlink the JPEGs from disk.
    pub fn prune_screenshots(&self, before_ts: i64) -> Result<Vec<String>> {
        let mut conn = self.conn.lock().unwrap();
        let paths: Vec<String> = {
            let mut stmt =
                conn.prepare("SELECT file_path, thumb_path FROM screenshots WHERE ts < ?1")?;
            let rows = stmt.query_map(params![before_ts], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })?;
            // Unlink the thumbnail alongside the full frame.
            let mut out = Vec::new();
            for r in rows.flatten() {
                out.push(r.0);
                if let Some(thumb) = r.1 {
                    out.push(thumb);
                }
            }
            out
        };
        {
            let tx = conn.transaction()?;
            tx.execute(
                "DELETE FROM screenshots_fts WHERE id IN
                    (SELECT id FROM screenshots WHERE ts < ?1)",
                params![before_ts],
            )?;
            tx.execute("DELETE FROM screenshots WHERE ts < ?1", params![before_ts])?;
            tx.commit()?;
        }
        // After a real prune, compact what the 24/7 capture stream would otherwise
        // grow without bound: merge the FTS index segments, return freed pages to
        // the OS, and truncate the WAL. Best-effort — never fail a prune over
        // maintenance.
        if !paths.is_empty() {
            let _ = conn.execute_batch(
                "INSERT INTO screenshots_fts(screenshots_fts) VALUES('optimize');
                 PRAGMA incremental_vacuum;
                 PRAGMA wal_checkpoint(TRUNCATE);",
            );
        }
        Ok(paths)
    }

    // ---- ax_context (rolling ambient text context) -------------------------

    /// Insert one observed change, indexing its text in FTS in the same
    /// transaction (same crash-consistency rationale as `set_screenshot_ocr`).
    pub fn insert_ax_context(&self, e: &AxContextEntry) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO ax_context
                (id, ts, app_name, bundle_id, window_title, url, page_title, text, text_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                e.id,
                e.ts,
                e.app_name,
                e.bundle_id,
                e.window_title,
                e.url,
                e.page_title,
                e.text,
                e.text_hash,
            ],
        )?;
        // Index titles alongside the body so a search for a page/window name hits.
        let fts_text = format!(
            "{} {} {} {}",
            e.window_title.as_deref().unwrap_or(""),
            e.page_title.as_deref().unwrap_or(""),
            e.url.as_deref().unwrap_or(""),
            e.text
        );
        tx.execute(
            "INSERT INTO ax_context_fts (id, text) VALUES (?1, ?2)",
            params![e.id, fts_text.trim()],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Newest entries first. `before_ts` is the keyset-pagination cursor
    /// (exclusive upper bound on ts), mirroring `recent_screenshots`.
    pub fn recent_ax_context(
        &self,
        limit: u32,
        before_ts: Option<i64>,
    ) -> Result<Vec<AxContextEntry>> {
        let conn = self.read_conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, ts, app_name, bundle_id, window_title, url, page_title, text, text_hash
             FROM ax_context WHERE ts < ?2 ORDER BY ts DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(
            params![limit, before_ts.unwrap_or(i64::MAX)],
            row_to_ax_context,
        )?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Entries observed at or after `since_ts`, oldest first (chronological — the
    /// shape the "recent activity" summary wants). Bounded by `limit` newest.
    pub fn ax_context_since(&self, since_ts: i64, limit: u32) -> Result<Vec<AxContextEntry>> {
        let conn = self.read_conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, ts, app_name, bundle_id, window_title, url, page_title, text, text_hash
             FROM (SELECT * FROM ax_context WHERE ts >= ?1 ORDER BY ts DESC LIMIT ?2)
             ORDER BY ts ASC",
        )?;
        let rows = stmt.query_map(params![since_ts, limit], row_to_ax_context)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Full-text search over ambient entries, newest first. Empty query falls
    /// back to recent, mirroring `search_screenshots`.
    pub fn search_ax_context(
        &self,
        query: &str,
        since_ts: i64,
        limit: u32,
        before_ts: Option<i64>,
    ) -> Result<Vec<AxContextEntry>> {
        let match_expr = fts_match_expr(query);
        if match_expr.is_empty() {
            let recent = self.recent_ax_context(limit, before_ts)?;
            return Ok(recent.into_iter().filter(|e| e.ts >= since_ts).collect());
        }
        let conn = self.read_conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT c.id, c.ts, c.app_name, c.bundle_id, c.window_title, c.url, c.page_title, c.text, c.text_hash
             FROM ax_context c JOIN ax_context_fts ON ax_context_fts.id = c.id
             WHERE ax_context_fts MATCH ?1 AND c.ts >= ?2 AND c.ts < ?4
             ORDER BY c.ts DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(
            params![match_expr, since_ts, limit, before_ts.unwrap_or(i64::MAX)],
            row_to_ax_context,
        )?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn ax_context_count(&self) -> Result<i64> {
        let conn = self.read_conn.lock().unwrap();
        Ok(conn.query_row("SELECT COUNT(*) FROM ax_context", [], |r| r.get(0))?)
    }

    /// Delete entries older than `before_ts`. Row + FTS in one transaction; the
    /// same post-prune compaction as screenshots since this stream also grows
    /// unbounded when the collector runs all day.
    pub fn prune_ax_context(&self, before_ts: i64) -> Result<usize> {
        let mut conn = self.conn.lock().unwrap();
        let n;
        {
            let tx = conn.transaction()?;
            tx.execute(
                "DELETE FROM ax_context_fts WHERE id IN
                    (SELECT id FROM ax_context WHERE ts < ?1)",
                params![before_ts],
            )?;
            n = tx.execute("DELETE FROM ax_context WHERE ts < ?1", params![before_ts])?;
            tx.commit()?;
        }
        if n > 0 {
            let _ = conn.execute_batch(
                "INSERT INTO ax_context_fts(ax_context_fts) VALUES('optimize');
                 PRAGMA incremental_vacuum;
                 PRAGMA wal_checkpoint(TRUNCATE);",
            );
        }
        Ok(n)
    }

    /// The "delete my history" button: drop everything at once.
    pub fn clear_ax_context(&self) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM ax_context_fts", [])?;
        tx.execute("DELETE FROM ax_context", [])?;
        tx.commit()?;
        let _ = conn.execute_batch("PRAGMA incremental_vacuum; PRAGMA wal_checkpoint(TRUNCATE);");
        Ok(())
    }

    // ---- meetings (ambient audio transcription) ----------------------------

    pub fn insert_meeting(&self, id: &str, started_ts: i64, app_name: Option<&str>) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO meetings (id, started_ts, app_name) VALUES (?1, ?2, ?3)",
            params![id, started_ts, app_name],
        )?;
        Ok(())
    }

    pub fn finish_meeting(&self, id: &str, ended_ts: i64, segment_count: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE meetings SET ended_ts = ?2, segment_count = ?3 WHERE id = ?1",
            params![id, ended_ts, segment_count],
        )?;
        Ok(())
    }

    pub fn set_meeting_summary(&self, id: &str, title: &str, summary: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE meetings SET title = ?2, summary = ?3 WHERE id = ?1",
            params![id, title, summary],
        )?;
        Ok(())
    }

    pub fn insert_meeting_segment(
        &self,
        meeting_id: &str,
        ts: i64,
        source: &str,
        text: &str,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO meeting_segments (id, meeting_id, ts, source, text)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                uuid::Uuid::new_v4().to_string(),
                meeting_id,
                ts,
                source,
                text
            ],
        )?;
        Ok(())
    }

    pub fn list_meetings(&self, limit: u32) -> Result<Vec<Meeting>> {
        let conn = self.read_conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, started_ts, ended_ts, title, summary, app_name, segment_count
             FROM meetings ORDER BY started_ts DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], |r| {
            Ok(Meeting {
                id: r.get(0)?,
                started_ts: r.get(1)?,
                ended_ts: r.get(2)?,
                title: r.get(3)?,
                summary: r.get(4)?,
                app_name: r.get(5)?,
                segment_count: r.get(6)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// A meeting's full transcript, oldest segment first.
    pub fn meeting_segments(&self, meeting_id: &str) -> Result<Vec<MeetingSegment>> {
        let conn = self.read_conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT ts, source, text FROM meeting_segments
             WHERE meeting_id = ?1 ORDER BY ts ASC",
        )?;
        let rows = stmt.query_map(params![meeting_id], |r| {
            Ok(MeetingSegment {
                ts: r.get(0)?,
                source: r.get(1)?,
                text: r.get(2)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn delete_meeting(&self, id: &str) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM meeting_segments WHERE meeting_id = ?1",
            params![id],
        )?;
        tx.execute("DELETE FROM meetings WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    /// Delete meetings (and their segments) that STARTED before `before_ts`.
    /// Returns how many meetings were removed.
    pub fn prune_meetings(&self, before_ts: i64) -> Result<usize> {
        let mut conn = self.conn.lock().unwrap();
        let n = {
            let tx = conn.transaction()?;
            tx.execute(
                "DELETE FROM meeting_segments WHERE meeting_id IN
                    (SELECT id FROM meetings WHERE started_ts < ?1)",
                params![before_ts],
            )?;
            let n = tx.execute(
                "DELETE FROM meetings WHERE started_ts < ?1",
                params![before_ts],
            )?;
            tx.commit()?;
            n
        };
        if n > 0 {
            let _ = conn.execute_batch(
                "PRAGMA incremental_vacuum;
                 PRAGMA wal_checkpoint(TRUNCATE);",
            );
        }
        Ok(n)
    }
}

/// Turn a free-text query into a safe FTS5 MATCH expression: each whitespace
/// token becomes a quoted term, AND-ed together. Empty input → empty string.
fn fts_match_expr(query: &str) -> String {
    query
        .split_whitespace()
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

fn row_to_screenshot(r: &rusqlite::Row<'_>) -> rusqlite::Result<Screenshot> {
    Ok(Screenshot {
        id: r.get(0)?,
        ts: r.get(1)?,
        app_name: r.get(2)?,
        window_title: r.get(3)?,
        file_path: r.get(4)?,
        phash: r.get(5)?,
        bytes: r.get(6)?,
        ocr_text: r.get(7)?,
        thumb_path: r.get(8)?,
    })
}

fn row_to_ax_context(r: &rusqlite::Row<'_>) -> rusqlite::Result<AxContextEntry> {
    Ok(AxContextEntry {
        id: r.get(0)?,
        ts: r.get(1)?,
        app_name: r.get(2)?,
        bundle_id: r.get(3)?,
        window_title: r.get(4)?,
        url: r.get(5)?,
        page_title: r.get(6)?,
        text: r.get(7)?,
        text_hash: r.get(8)?,
    })
}

const AUTOMATION_COLS: &str = "id, name, prompt, workspace_dir, ds_model, reasoning, \
    schedule_json, enabled, created_at, updated_at, next_run_at, last_run_at, \
    last_conversation_id, last_status, last_error, run_count, backend, cli_model, cli_effort";

fn row_to_automation(r: &rusqlite::Row<'_>) -> rusqlite::Result<Automation> {
    let model_str: String = r.get(4)?;
    let reasoning_str: String = r.get(5)?;
    let model = ModelChoice {
        model: DsModel::parse(&model_str).unwrap_or(DsModel::Pro),
        reasoning: ReasoningLevel::parse(&reasoning_str).unwrap_or(ReasoningLevel::ThinkHigh),
    };
    let schedule_json: String = r.get(6)?;
    let schedule: AutomationSchedule = serde_json::from_str(&schedule_json).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let enabled: i64 = r.get(7)?;
    Ok(Automation {
        id: r.get(0)?,
        name: r.get(1)?,
        prompt: r.get(2)?,
        workspace_dir: r.get(3)?,
        model,
        schedule,
        enabled: enabled != 0,
        created_at: r.get(8)?,
        updated_at: r.get(9)?,
        next_run_at: r.get(10)?,
        last_run_at: r.get(11)?,
        last_conversation_id: r.get(12)?,
        last_status: r.get(13)?,
        last_error: r.get(14)?,
        run_count: r.get(15)?,
        backend: r.get(16)?,
        cli_model: r.get(17)?,
        cli_effort: r.get(18)?,
    })
}

fn row_to_conversation(r: &rusqlite::Row<'_>) -> rusqlite::Result<Conversation> {
    let model_str: String = r.get(4)?;
    let reasoning_str: String = r.get(5)?;
    let model = DsModel::parse(&model_str).unwrap_or(DsModel::Pro);
    let reasoning = ReasoningLevel::parse(&reasoning_str).unwrap_or(ReasoningLevel::ThinkHigh);
    Ok(Conversation {
        id: r.get(0)?,
        title: r.get(1)?,
        session_file: r.get(2)?,
        workspace_dir: r.get(3)?,
        model: ModelChoice { model, reasoning },
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
        archived_at: r.get(8)?,
        source_automation_id: r.get(9)?,
        parallel_group_id: r.get(10)?,
        solution_index: r.get(11)?,
        review_state: r.get(12)?,
        backend: r.get(13)?,
        cli_model: r.get(14)?,
        cli_effort: r.get(15)?,
    })
}

/// Add `column` to `table` if it isn't already present. Lets us evolve a table
/// additively without a SCHEMA_VERSION bump (which would drop it).
fn ensure_column(conn: &Connection, table: &str, column: &str, decl: &str) -> Result<()> {
    let names: Vec<String> = {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    if !names.iter().any(|n| n == column) {
        conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"),
            [],
        )?;
    }
    Ok(())
}

/// Open a connection with the durability / corruption-hardening pragmas we want
/// on every handle. WAL + a busy timeout suit a desktop app where the scheduler,
/// commands, and screen-capture all touch the same DB; `synchronous=NORMAL` is
/// the right durability/throughput trade for WAL on a single host; and
/// `cell_size_check` makes SQLite surface B-tree corruption early instead of
/// silently reading a torn page.
fn open_conn(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path).context("open sqlite")?;
    conn.execute_batch(
        // auto_vacuum=INCREMENTAL must be set before any table is created to take
        // effect (a no-op on an existing NONE database until a full VACUUM), so it
        // lives here in the connection opener that runs ahead of the schema. It
        // lets `prune_*` reclaim freed pages via `PRAGMA incremental_vacuum`
        // instead of the continuous-capture DB only ever growing.
        "PRAGMA auto_vacuum=INCREMENTAL;
         PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         PRAGMA busy_timeout=5000;
         PRAGMA foreign_keys=ON;
         PRAGMA temp_store=MEMORY;
         PRAGMA cell_size_check=ON;",
    )
    .context("apply sqlite pragmas")?;
    Ok(conn)
}

/// Quick structural integrity probe. `PRAGMA quick_check` returns the single row
/// "ok" on a healthy database; anything else (or an error) signals corruption.
/// At `Store::open` time this is the only handle in the cetus process and nothing
/// else writes `state.db`, so a failure here means corruption, not contention.
fn integrity_ok(conn: &Connection) -> bool {
    matches!(
        conn.query_row("PRAGMA quick_check(1)", [], |r| r.get::<_, String>(0)),
        Ok(s) if s == "ok"
    )
}

/// Move a corrupt database and its WAL/SHM siblings aside so the next open starts
/// clean (and SQLite can't try to recover the new file from a stale -wal).
/// Best-effort: a failed rename just means we proceed on the existing file and
/// let `open_conn` surface any hard error.
fn quarantine(path: &Path) {
    let ts = now_ms();
    for suffix in ["", "-wal", "-shm"] {
        let mut from = path.as_os_str().to_owned();
        from.push(suffix);
        let from = PathBuf::from(from);
        if !from.exists() {
            continue;
        }
        let mut to = from.as_os_str().to_owned();
        to.push(format!(".corrupt.{ts}.bak"));
        if let Err(e) = std::fs::rename(&from, PathBuf::from(to)) {
            tracing::warn!("failed to quarantine {}: {e}", from.display());
        }
    }
}

pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_store() -> (Store, PathBuf) {
        let path =
            std::env::temp_dir().join(format!("cetus-store-test-{}.db", uuid::Uuid::new_v4()));
        (Store::open(&path).unwrap(), path)
    }

    #[test]
    fn cli_messages_round_trip_retry_and_fork_copy() {
        let (store, path) = temp_store();

        // Turn 1: user (no prior resume) + assistant.
        store
            .append_cli_message(
                "c1",
                &json!({"role":"user","content":[{"type":"text","text":"first"}]}),
                None,
                1,
            )
            .unwrap();
        store
            .append_cli_message("c1", &json!({"role":"assistant","content":[]}), None, 2)
            .unwrap();
        // Turn 2: user resumed from sess-1.
        store
            .append_cli_message(
                "c1",
                &json!({"role":"user","content":[{"type":"text","text":"second"}]}),
                Some("sess-1"),
                3,
            )
            .unwrap();
        store
            .append_cli_message("c1", &json!({"role":"assistant","content":[]}), None, 4)
            .unwrap();

        let msgs = store.list_cli_messages("c1").unwrap();
        assert_eq!(msgs.len(), 4);

        // Retry contract: last user row carries its pre-turn resume token, and
        // deleting from it drops the whole failed turn.
        let (row_id, msg, resume) = store.last_cli_user_message("c1").unwrap().unwrap();
        assert_eq!(msg["content"][0]["text"], json!("second"));
        assert_eq!(resume.as_deref(), Some("sess-1"));
        store.delete_cli_messages_from("c1", row_id).unwrap();
        assert_eq!(store.list_cli_messages("c1").unwrap().len(), 2);

        // Fork copy honors the row limit; full copy takes everything.
        store.copy_cli_messages("c1", "c2", Some(1)).unwrap();
        assert_eq!(store.list_cli_messages("c2").unwrap().len(), 1);
        store.copy_cli_messages("c1", "c3", None).unwrap();
        assert_eq!(store.list_cli_messages("c3").unwrap().len(), 2);

        store.delete_cli_messages("c1").unwrap();
        assert!(store.list_cli_messages("c1").unwrap().is_empty());

        drop(store);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn switch_backend_stashes_and_restores_resume_tokens() {
        let (store, path) = temp_store();
        let conv = Conversation {
            id: "c1".into(),
            title: String::new(),
            session_file: String::new(),
            workspace_dir: "/tmp".into(),
            model: Default::default(),
            created_at: 1,
            updated_at: 1,
            archived_at: None,
            source_automation_id: None,
            parallel_group_id: None,
            solution_index: None,
            review_state: "none".into(),
            backend: "codex".into(),
            cli_model: String::new(),
            cli_effort: String::new(),
        };
        store.insert(&conv).unwrap();
        store.set_session_file("c1", "codex-thread-1").unwrap();

        // codex → claude: the codex token is stashed, claude starts blank.
        assert_eq!(
            store.switch_backend("c1", "claude-code", 2).unwrap(),
            Some("codex".to_string())
        );
        let c = store.get("c1").unwrap().unwrap();
        assert_eq!(c.backend, "claude-code");
        assert_eq!(c.session_file, "");

        // Claude runs a turn and persists its own token.
        store.set_session_file("c1", "claude-sess-1").unwrap();

        // claude → codex: claude's token is stashed, codex's restored.
        assert_eq!(
            store.switch_backend("c1", "codex", 3).unwrap(),
            Some("claude-code".to_string())
        );
        let c = store.get("c1").unwrap().unwrap();
        assert_eq!(c.session_file, "codex-thread-1");

        // Back again: claude's token round-trips too.
        store.switch_backend("c1", "claude-code", 4).unwrap();
        let c = store.get("c1").unwrap().unwrap();
        assert_eq!(c.session_file, "claude-sess-1");

        // Same backend / missing conversation: no-op.
        assert_eq!(store.switch_backend("c1", "claude-code", 5).unwrap(), None);
        assert_eq!(store.switch_backend("nope", "codex", 5).unwrap(), None);

        drop(store);
        let _ = std::fs::remove_file(&path);
    }
}
