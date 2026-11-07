import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Locate,
  Terminal,
  Workflow,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { subagentInfo } from "@/components/chat/tool-use-card";
import { revealToolCall } from "@/components/chat/reveal-tool-call";
import {
  useBackgroundTasks,
  useRunningSubagents,
  useToolBlockDetails,
} from "@/lib/chat-store";
import { useTranslation } from "@/lib/i18n";
import type { CliBackgroundTask } from "@/lib/types";

/** A task that has reported progress before and then goes quiet this long is
 *  flagged idle. Background Bash and Monitors never report progress, so they
 *  are never flagged. */
const IDLE_AFTER_MS = 3 * 60_000;

/** One row of the strip: a bridge task, or a pi-backend subagent read off the
 *  rendered cards (which carries only the identity fields). */
export interface BackgroundItem extends CliBackgroundTask {
  /** Stable React key. */
  key: string;
}

/** The conversation's live background work, merged from the bridge's task
 *  registry (authoritative for CLI backends) and running subagent cards
 *  (covers pi-backend runs), deduplicated by launching card. */
export function useBackgroundItems(convId: string): BackgroundItem[] {
  const tasks = useBackgroundTasks(convId);
  const agents = useRunningSubagents(convId);
  return useMemo(() => {
    const seenCards = new Set(tasks.map((task) => task.toolUseId).filter(Boolean));
    const seenLabels = new Set(tasks.map((task) => `${task.kind}|${task.description}`));
    return [
      ...tasks.map((task) => ({ ...task, key: task.taskId })),
      ...agents
        .filter(
          (a) => !seenCards.has(a.id) && !seenLabels.has(`${a.type}|${a.description}`),
        )
        .map((a) => ({
          key: a.id,
          taskId: a.id,
          kind: a.type,
          description: a.description,
          toolUseId: a.id,
        })),
    ];
  }, [tasks, agents]);
}

/** Repaint every `ms` while mounted, for the elapsed/idle clocks. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function hasReportedProgress(item: BackgroundItem): boolean {
  return !!item.statusText || (item.stepCount ?? 0) > 0 || item.toolUses != null;
}

function idleFor(item: BackgroundItem, now: number): number | null {
  if (!hasReportedProgress(item) || item.lastActivityAt == null) return null;
  const quiet = now - item.lastActivityAt;
  return quiet >= IDLE_AFTER_MS ? quiet : null;
}

function KindIcon({ kind, className }: { kind: string; className?: string }) {
  if (kind === "Bash") return <Terminal className={className} />;
  if (kind === "Workflow") return <Workflow className={className} />;
  return <Bot className={className} />;
}

/** Awareness strip for background work owned by this conversation: subagents
 *  (a CLI backend's run_in_background Agent/Workflow) and session-scoped tasks
 *  (Monitors, background Bash) that outlive model turns. Collapsed it is one
 *  line — counts by kind plus whichever task moved last; expanded it lists
 *  every task with its latest progress, clock and usage. The strip is an
 *  index: the full step trace stays on the launching card, which each row
 *  jumps to. Renders nothing when there is no background work. */
export function BackgroundTasksBar({ convId }: { convId: string }) {
  const { t } = useTranslation("chat");
  const items = useBackgroundItems(convId);
  const [open, setOpen] = useState(false);
  const empty = items.length === 0;
  useEffect(() => {
    if (empty) setOpen(false);
  }, [empty]);
  if (empty) return null;
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-muted/40 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={t(open ? "pane.backgroundAgents.collapse" : "pane.backgroundAgents.expand")}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-muted/60"
      >
        <Spinner className="size-3 shrink-0" />
        <span className="shrink-0 font-medium text-foreground">
          {t("pane.backgroundAgents.title", { count: items.length })}
        </span>
        <CollapsedSummary items={items} open={open} />
        {open ? (
          <ChevronDown className="ml-auto size-3.5 shrink-0" />
        ) : (
          <ChevronUp className="ml-auto size-3.5 shrink-0" />
        )}
      </button>
      {open ? <TaskList convId={convId} items={items} /> : null}
    </div>
  );
}

/** Counts by kind, then the most recently active task's latest line. */
function CollapsedSummary({ items, open }: { items: BackgroundItem[]; open: boolean }) {
  const counts = useMemo(() => {
    const byKind = new Map<string, number>();
    for (const item of items) byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
    return [...byKind].map(([kind, n]) => `${n} ${kind}`).join(" · ");
  }, [items]);
  const latest = useMemo(() => {
    let best: BackgroundItem | null = null;
    for (const item of items) {
      if (!item.statusText) continue;
      if (!best || (item.lastActivityAt ?? 0) > (best.lastActivityAt ?? 0)) best = item;
    }
    return best;
  }, [items]);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="shrink-0">{counts}</span>
      {latest && !open ? (
        <span className="min-w-0 truncate">
          <span className="text-muted-foreground/60">·</span> {latest.description}
          <span className="text-muted-foreground/60"> — </span>
          {latest.statusText}
        </span>
      ) : null}
    </span>
  );
}

function TaskList({ convId, items }: { convId: string; items: BackgroundItem[] }) {
  const now = useNow(1000);
  // Most recently active first; quiet tasks sink.
  const sorted = useMemo(
    () =>
      [...items].sort((a, b) => {
        const idleA = idleFor(a, now) != null;
        const idleB = idleFor(b, now) != null;
        if (idleA !== idleB) return idleA ? 1 : -1;
        return (
          (b.lastActivityAt ?? b.startedAt ?? 0) - (a.lastActivityAt ?? a.startedAt ?? 0)
        );
      }),
    [items, now],
  );
  return (
    <ul className="max-h-64 divide-y divide-border/60 overflow-y-auto border-t border-border/60">
      {sorted.map((item) => (
        <TaskRow key={item.key} convId={convId} item={item} now={now} />
      ))}
    </ul>
  );
}

function TaskRow({
  convId,
  item,
  now,
}: {
  convId: string;
  item: BackgroundItem;
  now: number;
}) {
  const { t } = useTranslation("chat");
  const [stepsOpen, setStepsOpen] = useState(false);
  const details = useToolBlockDetails(convId, item.toolUseId);
  // The launching card is in the loaded transcript (not paged out).
  const hasCard = details !== undefined;
  const steps = subagentInfo(details)?.steps ?? [];
  const idle = idleFor(item, now);
  const toolUses = item.toolUses ?? (item.stepCount || undefined);
  const meta = [
    item.kind,
    item.startedAt != null ? formatDuration(now - item.startedAt) : null,
    toolUses != null ? t("pane.backgroundAgents.tools", { count: toolUses }) : null,
    item.totalTokens != null
      ? t("pane.backgroundAgents.tokens", { count: formatTokens(item.totalTokens) })
      : null,
  ].filter(Boolean);
  const latestStep = steps.at(-1);
  const status =
    item.statusText ||
    (latestStep ? [latestStep.tool, latestStep.detail].filter(Boolean).join(" ") : "");
  return (
    <li className="px-2.5 py-1.5">
      <div className="flex items-start gap-2">
        <KindIcon kind={item.kind} className="mt-0.5 size-3.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate text-foreground">
              {item.description || item.kind}
            </span>
            <span className="ml-auto shrink-0 tabular-nums text-muted-foreground/80">
              {meta.join(" · ")}
            </span>
            {idle != null ? (
              <span className="shrink-0 rounded bg-warning/15 px-1 text-warning">
                {t("pane.backgroundAgents.idle", { duration: formatDuration(idle) })}
              </span>
            ) : null}
          </div>
          {status ? (
            <div className="mt-0.5 flex items-center gap-1.5">
              {steps.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setStepsOpen((v) => !v)}
                  aria-expanded={stepsOpen}
                  title={t("pane.backgroundAgents.steps")}
                  className="shrink-0 rounded p-0.5 hover:bg-muted"
                >
                  {stepsOpen ? (
                    <ChevronDown className="size-3" />
                  ) : (
                    <ChevronRight className="size-3" />
                  )}
                </button>
              ) : null}
              <span className="min-w-0 truncate font-mono text-muted-foreground/80">
                {status}
              </span>
            </div>
          ) : null}
          {stepsOpen && steps.length > 0 ? (
            <div className="mt-1 space-y-0.5 pl-5">
              {steps.slice(-5).map((s, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  {s.done ? (
                    <Check className="size-2.5 shrink-0 text-success/80" />
                  ) : (
                    <Spinner className="size-2.5 shrink-0" />
                  )}
                  <span className="shrink-0 font-mono">{s.tool}</span>
                  <span className="min-w-0 truncate font-mono text-muted-foreground/70">
                    {s.detail}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        {hasCard && item.toolUseId ? (
          <button
            type="button"
            onClick={() => revealToolCall({ convId, toolCallId: item.toolUseId! })}
            title={t("pane.backgroundAgents.jump")}
            className="shrink-0 rounded p-0.5 hover:bg-muted hover:text-foreground"
          >
            <Locate className="size-3.5" />
          </button>
        ) : null}
      </div>
    </li>
  );
}
