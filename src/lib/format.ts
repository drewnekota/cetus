export function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Just the clock — hour and minute. Used for the hover timestamp on a message. */
export function formatTimeHM(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Full date down to the second — year/month/day hour:minute:second. Shown in
 *  the tooltip when you hover the message's clock timestamp. */
export function formatFullDateTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Elapsed `m:ss` since a start timestamp — the live recording clock shown in
 *  the meeting HUD and the Meetings settings section. */
export function formatElapsed(startedTs: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - startedTs) / 1000));
  return `${Math.floor(secs / 60)}:${(secs % 60).toString().padStart(2, "0")}`;
}

/** Compact byte size for the Resources panel: MB below 1 GB, GB above. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const gb = bytes / 2 ** 30;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 1 : 2)} GB`;
  const mb = bytes / 2 ** 20;
  return `${mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}
