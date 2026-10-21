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
 *  the label moves to the tooltip (sidebar rows). `onPick` makes each state
 *  a button that jumps to the next session in it. */
export function ActivityBadges({
  counts,
  labels,
  onPick,
  className,
}: {
  counts: ActivityCounts | undefined;
  labels?: boolean;
  onPick?: (k: keyof ActivityCounts) => void;
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
      {shown.map((i) => {
        const body = (
          <>
            <span className={cn("size-1.5 rounded-full", i.dot)} />
            {counts[i.k]}
            {labels && <span>{t(i.key)}</span>}
          </>
        );
        return onPick ? (
          <button
            key={i.k}
            type="button"
            title={t("threads.jumpTo", { status: t(i.key) })}
            onClick={() => onPick(i.k)}
            className="-mx-1.5 flex h-6 items-center gap-1 rounded-md px-1.5 transition-colors hover:bg-accent hover:text-foreground"
          >
            {body}
          </button>
        ) : (
          <span
            key={i.k}
            title={labels ? undefined : `${counts[i.k]} ${t(i.key)}`}
            className="flex items-center gap-1"
          >
            {body}
          </span>
        );
      })}
    </span>
  );
}
