use super::{params, OptionalExtension, Result, Store};

impl Store {
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
    /// Each message carries the row's `created_at` as a `timestamp` field (ms)
    /// so reloaded history keeps real wall-clock times — the activity fold's
    /// "Worked for Xs" duration is derived from these on the frontend.
    pub fn list_cli_messages(&self, conv_id: &str) -> Result<Vec<serde_json::Value>> {
        let conn = self.read_conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT message_json, created_at FROM cli_messages WHERE conversation_id = ?1 ORDER BY id ASC",
        )?;
        let rows = stmt.query_map(params![conv_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        let mut out = Vec::new();
        for r in rows {
            let (json, ts) = r?;
            if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&json) {
                if let Some(obj) = v.as_object_mut() {
                    obj.entry("timestamp").or_insert(ts.into());
                }
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
}
