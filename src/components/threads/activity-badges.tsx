import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";
import type { ActivityCounts } from "@/lib/session-activity";

// Same dots and colors as the thread cards' status line.
const ITEMS = [
  {
    k: "input",
    dot: "bg-[var(--brand)] animate-pulse",
    key: "threads.status.input",
  },
  { k: "working", dot: "bg-warning animate-pulse", key: "threads.status.working" },
  { k: "done", dot: "bg-success", key: "threads.status.unread" },
] as const;

/** Dot + count per state that needs attention; renders nothing when the
 *  folder is quiet. `labels` spells the state out (feed header); without it
 *  the label moves to the tooltip (sidebar rows). */
export function ActivityBadges({
  counts,
  labels,
  className,
}: {
  counts: ActivityCounts | undefined;
  labels?: boolean;
  className?: string;
}) {
  const { t } = useTranslation("board");
  const shown = ITEMS.filter((i) => (counts?.[i.k] ?? 0) > 0);
  if (!counts || shown.length === 0) return null;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center text-xs tabular-nums",
        labels ? "gap-3" : "gap-2",
        className,
      )}
    >
      {shown.map((i) => (
        <span
          key={i.k}
          title={labels ? undefined : `${counts[i.k]} ${t(i.key)}`}
          className="flex items-center gap-1"
        >
          <span className={cn("size-1.5 rounded-full", i.dot)} />
          {counts[i.k]}
          {labels && <span>{t(i.key)}</span>}
        </span>
      ))}
    </span>
  );
}
