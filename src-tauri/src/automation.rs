//! Scheduled automations: a saved prompt that fires on a schedule.
//!
//! When an automation fires it mints a fresh conversation (like a board task),
//! sends its prompt, and lets the agent stream in the background — the run shows
//! up on the Kanban board as a normal conversation titled after the automation.
//!
//! This module owns the data model plus all schedule math: given a schedule and
//! a reference time, compute the next instant it should fire. Three schedule
//! kinds mirror the openclaw cron design (`at` / `every` / `cron`) plus a
//! friendly `daily` shorthand. Cron expressions are evaluated by a small
//! self-contained parser (standard 5-field, local wall-clock) so we don't pull
//! in a cron crate — `chrono` (already in the tree) covers timezone handling.

use crate::model::ModelChoice;
use chrono::{Datelike, Duration, Local, LocalResult, TimeZone};
use serde::{Deserialize, Serialize};

/// A persisted scheduled automation. `model`/`schedule` are reconstructed from
/// their DB columns (split model, JSON schedule) in `store`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub id: String,
    pub name: String,
    pub prompt: String,
    /// Absolute path used as pi's cwd when this automation fires.
    pub workspace_dir: String,
    pub model: ModelChoice,
    pub schedule: AutomationSchedule,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
    /// Epoch-ms of the next scheduled fire, or None when the automation is
    /// disabled / has no future occurrence (e.g. a spent one-shot).
    pub next_run_at: Option<i64>,
    pub last_run_at: Option<i64>,
    /// Conversation minted by the most recent run.
    pub last_conversation_id: Option<String>,
    /// "ok" | "error" for the most recent run.
    pub last_status: Option<String>,
    pub last_error: Option<String>,
    pub run_count: i64,
}

/// How often an automation fires. Tagged union shared verbatim with the
/// frontend (`AutomationSchedule` in types.ts) and stored as JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AutomationSchedule {
    /// One-shot at an absolute epoch-ms instant. Disabled after it fires.
    Once {
        #[serde(rename = "atMs")]
        at_ms: i64,
    },
    /// Fixed interval. Re-anchored to "now" after each run so a long downtime
    /// produces a single catch-up fire rather than a backlog storm.
    Interval {
        #[serde(rename = "everyMinutes")]
        every_minutes: i64,
    },
    /// A local wall-clock time ("HH:MM") on the given weekdays (0=Sun..6=Sat).
    /// Empty `weekdays` means every day.
    Daily {
        time: String,
        #[serde(default)]
        weekdays: Vec<u32>,
    },
    /// Standard 5-field cron expression, evaluated in local time.
    Cron { expr: String },
}

impl AutomationSchedule {
    /// Reject schedules we can't evaluate (or that could never fire) before
    /// they're persisted.
    pub fn validate(&self) -> Result<(), String> {
        // Per-kind syntactic checks.
        match self {
            AutomationSchedule::Once { at_ms } => {
                if *at_ms <= 0 {
                    return Err("invalid timestamp".into());
                }
            }
            AutomationSchedule::Interval { every_minutes } => {
                if *every_minutes < 1 {
                    return Err("interval must be at least 1 minute".into());
                }
            }
            AutomationSchedule::Daily { time, weekdays } => {
                parse_hhmm(time).ok_or_else(|| format!("invalid time '{time}', expected HH:MM"))?;
                if weekdays.iter().any(|&d| d > 6) {
                    return Err("weekday out of range (expected 0-6)".into());
                }
            }
            AutomationSchedule::Cron { expr } => {
                parse_cron(expr).ok_or_else(|| format!("invalid cron expression '{expr}'"))?;
            }
        }
        // Schedulability probe: a syntactically-valid expression can still have
        // no future occurrence (e.g. cron "0 0 30 2 *" — Feb 30 never exists),
        // which would persist as an enabled automation that silently never
        // fires. Reject it now. One-shots are exempt: a past instant is
        // intentional (it fires on the next tick).
        if self.is_recurring() && self.next_after(Local::now().timestamp_millis()).is_none() {
            return Err("this schedule has no upcoming run time".into());
        }
        Ok(())
    }

    /// The next fire strictly after `after_ms`, or None if there is none.
    /// One-shots return their instant only while still in the future.
    pub fn next_after(&self, after_ms: i64) -> Option<i64> {
        match self {
            AutomationSchedule::Once { at_ms } => {
                if *at_ms > after_ms {
                    Some(*at_ms)
                } else {
                    None
                }
            }
            AutomationSchedule::Interval { every_minutes } => {
                Some(after_ms + (*every_minutes).max(1) * 60_000)
            }
            AutomationSchedule::Daily { time, weekdays } => {
                next_daily_after(time, weekdays, after_ms)
            }
            AutomationSchedule::Cron { expr } => next_cron_after(expr, after_ms),
        }
    }

    /// The first fire after creation/enable. One-shots keep their literal
    /// instant (even if already past → fires on the next scheduler tick) so a
    /// "remind me at 9:00" set at 9:01 still runs immediately.
    pub fn initial_next_run(&self, now: i64) -> Option<i64> {
        match self {
            AutomationSchedule::Once { at_ms } => Some(*at_ms),
            other => other.next_after(now),
        }
    }

    pub fn is_recurring(&self) -> bool {
        !matches!(self, AutomationSchedule::Once { .. })
    }
}

/// Create/update payload from the frontend. `next_run_at` and run-state are
/// derived server-side, never trusted from the client.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationInput {
    pub name: String,
    pub prompt: String,
    pub workspace_dir: Option<String>,
    pub model: ModelChoice,
    pub schedule: AutomationSchedule,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

// ---- schedule math --------------------------------------------------------

fn parse_hhmm(s: &str) -> Option<(u32, u32)> {
    let (h, m) = s.split_once(':')?;
    let h: u32 = h.trim().parse().ok()?;
    let m: u32 = m.trim().parse().ok()?;
    if h > 23 || m > 59 {
        return None;
    }
    Some((h, m))
}

/// Resolve an epoch-ms to local time, tolerating DST folds (pick the earlier
/// of an ambiguous pair).
fn local_from_ms(ms: i64) -> Option<chrono::DateTime<Local>> {
    match Local.timestamp_millis_opt(ms) {
        LocalResult::Single(dt) => Some(dt),
        LocalResult::Ambiguous(dt, _) => Some(dt),
        LocalResult::None => None,
    }
}

/// Resolve a local naive datetime to an absolute instant, skipping the spring-
/// forward gap (returns None) and folding the fall-back overlap to the earlier.
fn local_from_naive(naive: chrono::NaiveDateTime) -> Option<chrono::DateTime<Local>> {
    match Local.from_local_datetime(&naive) {
        LocalResult::Single(dt) => Some(dt),
        LocalResult::Ambiguous(dt, _) => Some(dt),
        LocalResult::None => None,
    }
}

fn next_daily_after(time: &str, weekdays: &[u32], after_ms: i64) -> Option<i64> {
    let (h, m) = parse_hhmm(time)?;
    let after = local_from_ms(after_ms)?;
    let start = after.date_naive();
    // A weekday set has at most a 7-day gap; 8 days of lookahead covers the
    // same-day-but-later case plus any weekly slot.
    for offset in 0..=8 {
        let date = start.checked_add_signed(Duration::days(offset))?;
        let wd = date.weekday().num_days_from_sunday();
        if !weekdays.is_empty() && !weekdays.contains(&wd) {
            continue;
        }
        if let Some(naive) = date.and_hms_opt(h, m, 0) {
            if let Some(dt) = local_from_naive(naive) {
                let ms = dt.timestamp_millis();
                if ms > after_ms {
                    return Some(ms);
                }
            }
        }
    }
    None
}

struct CronFields {
    minutes: Vec<u32>,
    hours: Vec<u32>,
    doms: Vec<u32>,
    months: Vec<u32>,
    dows: Vec<u32>,
    /// Whether the day-of-month / day-of-week fields were literal `*`. Drives
    /// the Vixie "OR when both constrained" matching rule.
    dom_wild: bool,
    dow_wild: bool,
}

/// Parse one cron field (e.g. `*/5`, `1-5`, `0,30`) into the sorted set of
/// values it matches within `[min, max]`. None on any malformed token.
fn parse_field(field: &str, min: u32, max: u32) -> Option<Vec<u32>> {
    let mut out: Vec<u32> = Vec::new();
    for tok in field.split(',') {
        let tok = tok.trim();
        if tok.is_empty() {
            return None;
        }
        let (range_part, step) = match tok.split_once('/') {
            Some((r, s)) => (r, s.trim().parse::<u32>().ok().filter(|&n| n >= 1)?),
            None => (tok, 1),
        };
        let (lo, hi) = if range_part == "*" {
            (min, max)
        } else if let Some((a, b)) = range_part.split_once('-') {
            (a.trim().parse().ok()?, b.trim().parse().ok()?)
        } else {
            let v: u32 = range_part.trim().parse().ok()?;
            // A bare value with a step (`5/15`) ranges to the max; without a
            // step it's just that single value.
            if step == 1 {
                (v, v)
            } else {
                (v, max)
            }
        };
        if lo < min || hi > max || lo > hi {
            return None;
        }
        let mut v = lo;
        while v <= hi {
            out.push(v);
            v += step;
        }
    }
    out.sort_unstable();
    out.dedup();
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn parse_cron(expr: &str) -> Option<CronFields> {
    let parts: Vec<&str> = expr.split_whitespace().collect();
    if parts.len() != 5 {
        return None;
    }
    let minutes = parse_field(parts[0], 0, 59)?;
    let hours = parse_field(parts[1], 0, 23)?;
    let doms = parse_field(parts[2], 1, 31)?;
    let months = parse_field(parts[3], 1, 12)?;
    // Cron allows both 0 and 7 for Sunday; normalize 7 → 0.
    let dows_raw = parse_field(parts[4], 0, 7)?;
    let mut dows: Vec<u32> = dows_raw
        .iter()
        .map(|&d| if d == 7 { 0 } else { d })
        .collect();
    dows.sort_unstable();
    dows.dedup();
    Some(CronFields {
        minutes,
        hours,
        doms,
        months,
        dows,
        dom_wild: parts[2] == "*",
        dow_wild: parts[4] == "*",
    })
}

fn next_cron_after(expr: &str, after_ms: i64) -> Option<i64> {
    let f = parse_cron(expr)?;
    let after = local_from_ms(after_ms)?;
    let start = after.date_naive();
    // ~8 years of lookahead: enough to resolve the sparsest standard schedule,
    // a Feb-29 cron across a century non-leap year (e.g. 2096→2104 = 2920 days,
    // since 2100 is not a leap year).
    for offset in 0..=3000 {
        let date = start.checked_add_signed(Duration::days(offset))?;
        if !f.months.contains(&date.month()) {
            continue;
        }
        let dom_m = f.doms.contains(&date.day());
        let dow_m = f.dows.contains(&date.weekday().num_days_from_sunday());
        let day_ok = match (f.dom_wild, f.dow_wild) {
            (true, true) => true,
            (false, true) => dom_m,
            (true, false) => dow_m,
            // Both constrained → match either (standard Vixie cron behavior).
            (false, false) => dom_m || dow_m,
        };
        if !day_ok {
            continue;
        }
        // Hours/minutes are sorted, time is monotonic within a day, so the
        // first (hour, minute) past `after_ms` is the earliest valid slot.
        for &hh in &f.hours {
            for &mm in &f.minutes {
                if let Some(naive) = date.and_hms_opt(hh, mm, 0) {
                    if let Some(dt) = local_from_naive(naive) {
                        let ms = dt.timestamp_millis();
                        if ms > after_ms {
                            return Some(ms);
                        }
                    }
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
        let naive = chrono::NaiveDate::from_ymd_opt(y, mo, d)
            .unwrap()
            .and_hms_opt(h, mi, 0)
            .unwrap();
        local_from_naive(naive).unwrap().timestamp_millis()
    }

    #[test]
    fn interval_steps_forward() {
        let s = AutomationSchedule::Interval { every_minutes: 30 };
        let base = ms(2026, 6, 1, 9, 0);
        assert_eq!(s.next_after(base), Some(base + 30 * 60_000));
    }

    #[test]
    fn once_only_in_future() {
        let s = AutomationSchedule::Once { at_ms: 1000 };
        assert_eq!(s.next_after(500), Some(1000));
        assert_eq!(s.next_after(1000), None);
        // initial keeps a past instant so it fires on the next tick.
        assert_eq!(s.initial_next_run(5000), Some(1000));
    }

    #[test]
    fn daily_every_day_rolls_to_tomorrow() {
        // after 10:00, a 09:00 daily fires tomorrow at 09:00.
        let after = ms(2026, 6, 1, 10, 0);
        let next = AutomationSchedule::Daily {
            time: "09:00".into(),
            weekdays: vec![],
        }
        .next_after(after);
        assert_eq!(next, Some(ms(2026, 6, 2, 9, 0)));
    }

    #[test]
    fn daily_same_day_when_time_still_ahead() {
        let after = ms(2026, 6, 1, 8, 0);
        let next = AutomationSchedule::Daily {
            time: "09:00".into(),
            weekdays: vec![],
        }
        .next_after(after);
        assert_eq!(next, Some(ms(2026, 6, 1, 9, 0)));
    }

    #[test]
    fn cron_top_of_every_hour() {
        let after = ms(2026, 6, 1, 9, 15);
        let next = AutomationSchedule::Cron {
            expr: "0 * * * *".into(),
        }
        .next_after(after);
        assert_eq!(next, Some(ms(2026, 6, 1, 10, 0)));
    }

    #[test]
    fn cron_weekday_9am() {
        // 2026-06-01 is a Monday. "0 9 * * 1-5" after Mon 10:00 → Tue 09:00.
        let after = ms(2026, 6, 1, 10, 0);
        let next = AutomationSchedule::Cron {
            expr: "0 9 * * 1-5".into(),
        }
        .next_after(after);
        assert_eq!(next, Some(ms(2026, 6, 2, 9, 0)));
    }

    #[test]
    fn cron_validation() {
        assert!(AutomationSchedule::Cron {
            expr: "0 9 * * *".into()
        }
        .validate()
        .is_ok());
        assert!(AutomationSchedule::Cron {
            expr: "bogus".into()
        }
        .validate()
        .is_err());
        assert!(AutomationSchedule::Cron {
            expr: "99 9 * * *".into()
        }
        .validate()
        .is_err());
    }
}
