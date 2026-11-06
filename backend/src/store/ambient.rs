use super::{
    fts_match_expr, params, row_to_ax_context, AxContextEntry, AxContextMeta, AxSearchHit, Result,
    Store,
};

impl Store {
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

    /// Metadata of every entry in `[from_ts, to_ts)`, oldest first — the input
    /// to timeline aggregation. Text bodies stay in the DB (`text_chars` only).
    pub fn ax_context_range_meta(
        &self,
        from_ts: i64,
        to_ts: i64,
        limit: u32,
    ) -> Result<Vec<AxContextMeta>> {
        let conn = self.read_conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, ts, app_name, bundle_id, window_title, url, page_title, length(text)
             FROM ax_context WHERE ts >= ?1 AND ts < ?2 ORDER BY ts ASC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![from_ts, to_ts, limit], |r| {
            Ok(AxContextMeta {
                id: r.get(0)?,
                ts: r.get(1)?,
                app_name: r.get(2)?,
                bundle_id: r.get(3)?,
                window_title: r.get(4)?,
                url: r.get(5)?,
                page_title: r.get(6)?,
                text_chars: r.get(7)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// One entry by id — the drill-down step after a timeline/search hit.
    pub fn get_ax_context(&self, id: &str) -> Result<Option<AxContextEntry>> {
        let conn = self.read_conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, ts, app_name, bundle_id, window_title, url, page_title, text, text_hash
             FROM ax_context WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], row_to_ax_context)?;
        Ok(rows.next().transpose()?)
    }

    /// FTS search returning match-centered snippets (not full bodies), newest
    /// first, with an optional case-insensitive app-name/bundle filter. The
    /// snippet keeps agent-side token cost flat no matter how big the body is.
    pub fn search_ax_context_snippets(
        &self,
        query: &str,
        from_ts: i64,
        to_ts: i64,
        app_filter: &str,
        limit: u32,
    ) -> Result<Vec<AxSearchHit>> {
        let match_expr = fts_match_expr(query);
        if match_expr.is_empty() {
            return Ok(Vec::new());
        }
        let app = app_filter.trim().to_lowercase();
        let conn = self.read_conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT c.id, c.ts, c.app_name, c.window_title, c.url, c.page_title,
                    snippet(ax_context_fts, 1, '[', ']', ' … ', 24)
             FROM ax_context c JOIN ax_context_fts ON ax_context_fts.id = c.id
             WHERE ax_context_fts MATCH ?1 AND c.ts >= ?2 AND c.ts < ?3
               AND (?4 = '' OR instr(lower(coalesce(c.app_name,'') || ' ' || coalesce(c.bundle_id,'')), ?4) > 0)
             ORDER BY c.ts DESC LIMIT ?5",
        )?;
        let rows = stmt.query_map(params![match_expr, from_ts, to_ts, app, limit], |r| {
            Ok(AxSearchHit {
                id: r.get(0)?,
                ts: r.get(1)?,
                app_name: r.get(2)?,
                window_title: r.get(3)?,
                url: r.get(4)?,
                page_title: r.get(5)?,
                snippet: r.get(6)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Oldest/newest observation timestamps, None when the table is empty.
    pub fn ax_context_span(&self) -> Result<Option<(i64, i64)>> {
        let conn = self.read_conn.lock().unwrap();
        let span: (Option<i64>, Option<i64>) =
            conn.query_row("SELECT MIN(ts), MAX(ts) FROM ax_context", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?;
        Ok(match span {
            (Some(a), Some(b)) => Some((a, b)),
            _ => None,
        })
    }
}
