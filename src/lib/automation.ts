// Frontend helpers for rendering automations: human-readable schedule
// descriptions and run-time formatting. The schedule shapes mirror the Rust
// `AutomationSchedule` in src-tauri/src/automation.rs.

import { tt } from "@/lib/i18n";
import type { AutomationSchedule } from "./types";

// Weekday metadata. The short/long display labels are message keys resolved at
// render time via `tt` so they translate with the active locale.
export const WEEKDAYS: { value: number; shortKey: string; longKey: string }[] = [
  { value: 0, shortKey: "weekday.short.sun", longKey: "weekday.long.sun" },
  { value: 1, shortKey: "weekday.short.mon", longKey: "weekday.long.mon" },
  { value: 2, shortKey: "weekday.short.tue", longKey: "weekday.long.tue" },
  { value: 3, shortKey: "weekday.short.wed", longKey: "weekday.long.wed" },
  { value: 4, shortKey: "weekday.short.thu", longKey: "weekday.long.thu" },
  { value: 5, shortKey: "weekday.short.fri", longKey: "weekday.long.fri" },
  { value: 6, shortKey: "weekday.short.sat", longKey: "weekday.long.sat" },
];

/** "Every 30 minutes", "Every 2 hours", "Daily" — pick the coarsest unit. */
function prettyInterval(everyMinutes: number): string {
  const m = Math.max(1, Math.round(everyMinutes));
  if (m % 1440 === 0) {
    const d = m / 1440;
    return d === 1
      ? tt("automation", "schedule.everyDay")
      : tt("automation", "schedule.everyDays", { n: d });
  }
  if (m % 60 === 0) {
    const h = m / 60;
    return h === 1
      ? tt("automation", "schedule.everyHour")
      : tt("automation", "schedule.everyHours", { n: h });
  }
  return m === 1
    ? tt("automation", "schedule.everyMinute")
    : tt("automation", "schedule.everyMinutes", { n: m });
}

function prettyWeekdays(weekdays: number[]): string | null {
  const set = [...new Set(weekdays)].sort((a, b) => a - b);
  if (set.length === 0 || set.length === 7) return null; // every day
  if (set.length === 5 && set.every((d) => d >= 1 && d <= 5))
    return tt("automation", "schedule.weekdays");
  if (set.length === 2 && set.includes(0) && set.includes(6))
    return tt("automation", "schedule.weekends");
  return set
    .map((d) => {
      const wd = WEEKDAYS[d];
      return wd ? tt("automation", wd.longKey) : String(d);
    })
    .join(", ");
}

/** A short label like "Weekdays at 09:00" or "Every 2 hours". */
export function describeSchedule(s: AutomationSchedule): string {
  switch (s.kind) {
    case "once":
      return tt("automation", "schedule.onceOn", {
        datetime: formatDateTime(s.atMs),
      });
    case "interval":
      return prettyInterval(s.everyMinutes);
    case "daily": {
      const days = prettyWeekdays(s.weekdays);
      return days
        ? tt("automation", "schedule.daysAt", { days, time: s.time })
        : tt("automation", "schedule.everyDayAt", { time: s.time });
    }
    case "cron":
      return tt("automation", "schedule.cron", { expr: s.expr });
  }
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** "Today 14:30", "Tomorrow 09:00", or "Jun 3, 09:00". */
export function formatNextRun(ms: number | null): string {
  if (ms == null) return tt("automation", "run.none");
  const d = new Date(ms);
  const now = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  if (sameDay) return tt("automation", "run.today", { time });
  if (isTomorrow) return tt("automation", "run.tomorrow", { time });
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

/** Relative "5m ago" / "2h ago" / date for the last-run timestamp. */
export function formatLastRun(ms: number | null): string {
  if (ms == null) return tt("automation", "run.never");
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return tt("automation", "run.justNow");
  if (min < 60) return tt("automation", "run.minutesAgo", { n: min });
  const hr = Math.round(min / 60);
  if (hr < 24) return tt("automation", "run.hoursAgo", { n: hr });
  const d = new Date(ms);
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
