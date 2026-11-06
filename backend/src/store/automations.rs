use super::AUTOMATION_COLS;
use super::{params, row_to_automation, Automation, OptionalExtension, Result, Store};

impl Store {
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
                a.model.model.to_persist(),
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
                a.model.model.to_persist(),
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
}
