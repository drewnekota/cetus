use super::{
    fts_match_expr, params, row_to_screenshot, AxSearchHit, Result, Screenshot, ScreenshotMeta,
    Store,
};

impl Store {
    // ---- screenshots (screen-context collection) --------------------------

    pub fn insert_screenshot(&self, s: &Screenshot) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO screenshots
                (id, ts, app_name, window_title, file_path, phash, bytes, ocr_text, thumb_path, trigger)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
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
                s.trigger,
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
            "SELECT id, ts, app_name, window_title, file_path, phash, bytes, ocr_text, thumb_path, trigger
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
            "SELECT s.id, s.ts, s.app_name, s.window_title, s.file_path, s.phash, s.bytes, s.ocr_text, s.thumb_path, s.trigger
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

    /// Tiered retention, phase 1: drop only the *pixels* of frames older than
    /// `before_ts` — full JPEG and thumbnail — while the row, OCR text, and FTS
    /// index stay. Returns the file paths so the caller can unlink them.
    /// `file_path` is cleared to '' (the schema forbids NULL) as the marker the
    /// client and `context get` use for "text-only entry".
    pub fn prune_screenshot_frames(&self, before_ts: i64) -> Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let paths: Vec<String> = {
            let mut stmt = conn.prepare(
                "SELECT file_path, thumb_path FROM screenshots
                 WHERE ts < ?1 AND (file_path != '' OR thumb_path IS NOT NULL)",
            )?;
            let rows = stmt.query_map(params![before_ts], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })?;
            let mut out = Vec::new();
            for r in rows.flatten() {
                if !r.0.is_empty() {
                    out.push(r.0);
                }
                if let Some(thumb) = r.1 {
                    out.push(thumb);
                }
            }
            out
        };
        if !paths.is_empty() {
            conn.execute(
                "UPDATE screenshots SET file_path = '', thumb_path = NULL, bytes = 0
                 WHERE ts < ?1 AND (file_path != '' OR thumb_path IS NOT NULL)",
                params![before_ts],
            )?;
        }
        Ok(paths)
    }

    /// Metadata of every frame in `[from_ts, to_ts)`, oldest first — the OCR
    /// stream's input to timeline aggregation (mirrors `ax_context_range_meta`).
    pub fn screenshots_range_meta(
        &self,
        from_ts: i64,
        to_ts: i64,
        limit: u32,
    ) -> Result<Vec<ScreenshotMeta>> {
        let conn = self.read_conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, ts, app_name, window_title, trigger, length(coalesce(ocr_text,''))
             FROM screenshots WHERE ts >= ?1 AND ts < ?2 ORDER BY ts ASC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![from_ts, to_ts, limit], |r| {
            Ok(ScreenshotMeta {
                id: r.get(0)?,
                ts: r.get(1)?,
                app_name: r.get(2)?,
                window_title: r.get(3)?,
                trigger: r.get(4)?,
                text_chars: r.get(5)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// FTS search over OCR text returning match-centered snippets, newest first
    /// (mirrors `search_ax_context_snippets`; url/page_title are always None for
    /// this stream).
    pub fn search_screenshots_snippets(
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
            "SELECT s.id, s.ts, s.app_name, s.window_title,
                    snippet(screenshots_fts, 1, '[', ']', ' … ', 24)
             FROM screenshots s JOIN screenshots_fts ON screenshots_fts.id = s.id
             WHERE screenshots_fts MATCH ?1 AND s.ts >= ?2 AND s.ts < ?3
               AND (?4 = '' OR instr(lower(coalesce(s.app_name,'')), ?4) > 0)
             ORDER BY s.ts DESC LIMIT ?5",
        )?;
        let rows = stmt.query_map(params![match_expr, from_ts, to_ts, app, limit], |r| {
            Ok(AxSearchHit {
                id: r.get(0)?,
                ts: r.get(1)?,
                app_name: r.get(2)?,
                window_title: r.get(3)?,
                url: None,
                page_title: None,
                snippet: r.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// One frame by id — `context get` drill-down for the OCR stream.
    pub fn get_screenshot(&self, id: &str) -> Result<Option<Screenshot>> {
        let conn = self.read_conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, ts, app_name, window_title, file_path, phash, bytes, ocr_text, thumb_path, trigger
             FROM screenshots WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], row_to_screenshot)?;
        Ok(rows.next().transpose()?)
    }

    /// Oldest/newest frame timestamps, None when the table is empty.
    pub fn screenshots_span(&self) -> Result<Option<(i64, i64)>> {
        let conn = self.read_conn.lock().unwrap();
        let span: (Option<i64>, Option<i64>) =
            conn.query_row("SELECT MIN(ts), MAX(ts) FROM screenshots", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?;
        Ok(match span {
            (Some(a), Some(b)) => Some((a, b)),
            _ => None,
        })
    }
}
