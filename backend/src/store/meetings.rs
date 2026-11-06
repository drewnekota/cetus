use super::{params, Meeting, MeetingSegment, Result, Store};

impl Store {
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

    /// Ids of meetings that started before `before_ts` — the prune pre-pass,
    /// so the caller can also remove per-meeting files (saved audio) on disk.
    pub fn meeting_ids_started_before(&self, before_ts: i64) -> Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id FROM meetings WHERE started_ts < ?1")?;
        let rows = stmt.query_map(params![before_ts], |r| r.get(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
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
