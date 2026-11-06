use super::CONVERSATION_COLS;
use super::{
    now_ms, params, row_to_conversation, Conversation, Result, Store, CONVERSATION_COL_COUNT,
};

impl Store {
    // ---- conversation search index (⌘K content search) ---------------------

    /// Replace a conversation's search-index row. `updated_at` is the
    /// conversation's `updated_at` the text was built from; the sweep reindexes
    /// when the row moves past it.
    pub fn upsert_conversation_index(
        &self,
        id: &str,
        title: &str,
        body: &str,
        updated_at: i64,
    ) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM conversation_fts WHERE id = ?1", params![id])?;
        tx.execute(
            "INSERT INTO conversation_fts (id, title, body) VALUES (?1, ?2, ?3)",
            params![id, title, body],
        )?;
        tx.execute(
            "INSERT INTO conversation_index (id, indexed_updated_at, indexed_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET indexed_updated_at = excluded.indexed_updated_at,
                                           indexed_at = excluded.indexed_at",
            params![id, updated_at, now_ms()],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn delete_conversation_index(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM conversation_fts WHERE id = ?1", params![id])?;
        conn.execute("DELETE FROM conversation_index WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Conversations whose index row is missing or older than the conversation
    /// itself, newest activity first. Archived rows included — that's the point.
    pub fn stale_index_conversations(&self, limit: u32) -> Result<Vec<Conversation>> {
        let conn = self.read_conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "SELECT {CONVERSATION_COLS} FROM conversations c
             LEFT JOIN conversation_index i ON i.id = c.id
             WHERE i.id IS NULL OR i.indexed_updated_at < c.updated_at
             ORDER BY c.updated_at DESC LIMIT ?1"
        ))?;
        let rows = stmt.query_map(params![limit], row_to_conversation)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Full-text search over indexed conversations. Every whitespace token must
    /// appear (AND) in title or body. Tokens of three or more characters go
    /// through the trigram index; shorter ones (a two-character Chinese word is
    /// the common case) fall back to LIKE, which the trigram table answers with
    /// a scan — fine at hundreds of conversations. `archived`: Some(true) only
    /// archived rows, Some(false) only active, None both. Returns raw
    /// (conversation, title, body) so the caller can build snippets.
    pub fn search_conversations_raw(
        &self,
        query: &str,
        archived: Option<bool>,
        limit: u32,
    ) -> Result<Vec<(Conversation, String, String)>> {
        let mut long: Vec<String> = Vec::new();
        let mut short: Vec<String> = Vec::new();
        for tok in query.split_whitespace() {
            if tok.chars().count() >= 3 {
                long.push(format!("\"{}\"", tok.replace('"', "\"\"")));
            } else {
                short.push(tok.to_string());
            }
        }
        if long.is_empty() && short.is_empty() {
            return Ok(Vec::new());
        }
        let mut wheres: Vec<String> = Vec::new();
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if !long.is_empty() {
            args.push(Box::new(long.join(" ")));
            wheres.push(format!("f.conversation_fts MATCH ?{}", args.len()));
        }
        for tok in &short {
            let pat = format!(
                "%{}%",
                tok.replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            );
            args.push(Box::new(pat));
            let n = args.len();
            wheres.push(format!(
                "(f.title LIKE ?{n} ESCAPE '\\' OR f.body LIKE ?{n} ESCAPE '\\')"
            ));
        }
        match archived {
            Some(true) => wheres.push("c.archived_at IS NOT NULL".into()),
            Some(false) => wheres.push("c.archived_at IS NULL".into()),
            None => {}
        }
        let order = if long.is_empty() {
            "c.updated_at DESC".to_string()
        } else {
            "bm25(f.conversation_fts, 0.0, 6.0, 1.0), c.updated_at DESC".to_string()
        };
        args.push(Box::new(limit));
        let sql = format!(
            "SELECT {CONVERSATION_COLS}, f.title, f.body FROM conversation_fts f
             JOIN conversations c ON c.id = f.id
             WHERE {} ORDER BY {order} LIMIT ?{}",
            wheres.join(" AND "),
            args.len(),
        );
        let conn = self.read_conn.lock().unwrap();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), |r| {
            let conv = row_to_conversation(r)?;
            let title: String = r.get(CONVERSATION_COL_COUNT)?;
            let body: String = r.get(CONVERSATION_COL_COUNT + 1)?;
            Ok((conv, title, body))
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }
}
