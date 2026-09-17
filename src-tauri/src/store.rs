//! SQLite-backed metadata for conversations.
//! Messages themselves live in pi's session jsonl files; we only own the index.
//!
//! Schema is reset on major rewrites by bumping SCHEMA_VERSION below. We're in
//! pre-1.0; users are devs; we don't preserve old data across breaking shape
//! changes.

mod ambient;
mod automations;
mod conversations;
mod meetings;
mod messages;
mod screenshots;
mod search;
#[cfg(test)]
mod tests;

use crate::automation::{Automation, AutomationSchedule};
use crate::model::{ModelChoice, ModelRef, ReasoningLevel};
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
    /// When a run finished without the user having looked at the result since —
    /// the timestamp behind the sidebar's unread dot. Persisted (rather than kept
    /// as renderer state) so the dot survives a restart and so auto-archive can
    /// skip chats whose output hasn't been read. Cleared when the conversation is
    /// opened, and when it is archived by hand.
    #[serde(default)]
    pub unread_at: Option<i64>,
    /// Project-scoped pin: when set, the sidebar sorts this chat to the top of
    /// its workspace group (newest pin first). None = not pinned. Deliberately
    /// not "activity" — pinning never touches `updated_at`.
    #[serde(default)]
    pub pinned_at: Option<i64>,
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
    /// Persisted run lifecycle for CLI-backend turns, so a restart can tell a
    /// finished conversation from one whose turn was cut down mid-run.
    /// "idle" (no turn / finished normally) | "running" (a turn is in flight —
    /// only ever true while the app lives; leftovers at boot mean a crash) |
    /// "aborted" (the user pressed Stop — never offered a resume) |
    /// "interrupted" (the turn died without settling: app quit/update restart,
    /// crash, or the child vanished — the UI offers to resume it). pi turns
    /// don't participate and stay "idle".
    #[serde(default = "default_run_state")]
    pub run_state: String,
}

/// Default run state for rows/payloads that predate the `run_state` column.
pub fn default_run_state() -> String {
    "idle".to_string()
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
    /// What caused this frame to be kept: "commit" (Enter/⌘S/⌘C), "switch"
    /// (app/window change), "typing" (burst ended), "interval" (fallback timer).
    /// None for frames captured before event-driven triggers existed.
    pub trigger: Option<String>,
}

/// [`Screenshot`] minus pixels and text body — what timeline aggregation reads
/// (mirrors [`AxContextMeta`] for the OCR stream).
#[derive(Debug, Clone)]
pub struct ScreenshotMeta {
    pub id: String,
    pub ts: i64,
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub trigger: Option<String>,
    pub text_chars: i64,
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

/// [`AxContextEntry`] minus the text body: what timeline aggregation reads. A
/// day of collection is thousands of rows × up to `MAX_TEXT_CHARS` each, so the
/// range scan must not haul the bodies through the row mapper.
#[derive(Debug, Clone)]
pub struct AxContextMeta {
    pub id: String,
    pub ts: i64,
    pub app_name: Option<String>,
    pub bundle_id: Option<String>,
    pub window_title: Option<String>,
    pub url: Option<String>,
    pub page_title: Option<String>,
    pub text_chars: i64,
}

/// One FTS hit with a match-centered snippet instead of the full body.
#[derive(Debug, Clone)]
pub struct AxSearchHit {
    pub id: String,
    pub ts: i64,
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub url: Option<String>,
    pub page_title: Option<String>,
    pub snippet: String,
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
                ds_model TEXT NOT NULL DEFAULT 'flash',
                reasoning TEXT NOT NULL DEFAULT 'think_high',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                archived_at INTEGER,
                unread_at INTEGER,
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
                ds_model TEXT NOT NULL DEFAULT 'flash',
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

            -- Cross-conversation content search (⌘K). One row per conversation
            -- holding its title + visible prose, rebuilt whole whenever the
            -- conversation changes (see search_index.rs). Trigram tokenizer so
            -- CJK runs and code identifiers match as substrings — unicode61
            -- would treat a whole Chinese sentence as one token. Trigger-free
            -- like the other FTS tables; conversation_index records what the
            -- row was built from so the background sweep can find stale ones.
            CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts
                USING fts5(id UNINDEXED, title, body, tokenize = 'trigram');
            CREATE TABLE IF NOT EXISTS conversation_index (
                id TEXT PRIMARY KEY,
                indexed_updated_at INTEGER NOT NULL,
                indexed_at INTEGER NOT NULL
            );
            "#,
        )?;
        // Additive column for automation-minted conversations. A DB created
        // before this column existed won't get it from CREATE TABLE (the table
        // already exists), so add it via a guarded ALTER — preserving the user's
        // chats instead of forcing a schema-reset drop.
        ensure_column(&conn, "conversations", "source_automation_id", "TEXT")?;
        // Unread marker for finished runs. Additive; pre-existing rows start
        // NULL (= read), which is the right default for chats that predate it.
        ensure_column(&conn, "conversations", "unread_at", "INTEGER")?;
        // Project-scoped pin marker: the sidebar sorts pinned chats first within
        // their workspace group. Additive; pre-existing rows start unpinned.
        ensure_column(&conn, "conversations", "pinned_at", "INTEGER")?;
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
        // Persisted turn lifecycle (idle | running | aborted | interrupted) so
        // a restart can offer to resume turns that were cut down mid-run.
        // Additive; pre-existing rows default to 'idle'.
        ensure_column(
            &conn,
            "conversations",
            "run_state",
            "TEXT NOT NULL DEFAULT 'idle'",
        )?;
        // One-shot auto-resume budget for interrupted runs: 1 = the current
        // interruption was already auto-resumed once, so a repeat interruption
        // falls back to the manual Resume banner instead of looping (a run
        // that crashes the app must not restart itself forever). Cleared when
        // a turn settles (idle/aborted) or the banner is dismissed. Additive.
        ensure_column(
            &conn,
            "conversations",
            "auto_resumed",
            "INTEGER NOT NULL DEFAULT 0",
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
        // Why a frame was kept ("commit" / "switch" / "typing" / "interval").
        // Additive — pre-event-driven frames stay NULL.
        ensure_column(&conn, "screenshots", "trigger", "TEXT")?;
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
        trigger: r.get(9)?,
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
        model: ModelRef::parse(&model_str).unwrap_or_default(),
        reasoning: ReasoningLevel::parse(&reasoning_str).unwrap_or(ReasoningLevel::High),
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

/// Column list `row_to_conversation` expects, aliased to `c` for joins.
const CONVERSATION_COLS: &str = "c.id, c.title, c.session_file, c.workspace_dir, c.ds_model, c.reasoning, c.created_at, c.updated_at, c.archived_at, c.unread_at, c.source_automation_id, c.parallel_group_id, c.solution_index, c.review_state, c.backend, c.cli_model, c.cli_effort, c.run_state, c.pinned_at";
const CONVERSATION_COL_COUNT: usize = 19;

fn row_to_conversation(r: &rusqlite::Row<'_>) -> rusqlite::Result<Conversation> {
    let model_str: String = r.get(4)?;
    let reasoning_str: String = r.get(5)?;
    let model = ModelRef::parse(&model_str).unwrap_or_default();
    let reasoning = ReasoningLevel::parse(&reasoning_str).unwrap_or(ReasoningLevel::High);
    Ok(Conversation {
        id: r.get(0)?,
        title: r.get(1)?,
        session_file: r.get(2)?,
        workspace_dir: r.get(3)?,
        model: ModelChoice { model, reasoning },
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
        archived_at: r.get(8)?,
        unread_at: r.get(9)?,
        source_automation_id: r.get(10)?,
        parallel_group_id: r.get(11)?,
        solution_index: r.get(12)?,
        review_state: r.get(13)?,
        backend: r.get(14)?,
        cli_model: r.get(15)?,
        cli_effort: r.get(16)?,
        run_state: r.get(17)?,
        pinned_at: r.get(18)?,
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
