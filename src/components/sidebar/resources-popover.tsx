"use client";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Activity } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTranslation } from "@/lib/i18n";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ClaudeCodeIcon, CodexIcon } from "@/components/brand-icons";

/** Mirrors `resources::ResourceRow` / `ResourcesSnapshot` on the Rust side. */
interface ResourceRow {
  pid: number;
  label: string;
  kind: "app" | "engine" | "agent" | "helper" | "other";
  conversationId: string | null;
  conversationTitle: string | null;
  cpu: number;
  memoryBytes: number;
  processCount: number;
}

interface ResourcesSnapshot {
  rows: ResourceRow[];
  totalCpu: number;
  totalMemoryBytes: number;
  cpuCores: number;
  memTotalBytes: number;
  memUsedBytes: number;
  gpuUtilization: number | null;
}

/** Accent dot per row kind — same visual language as the kanban status dots. */
const KIND_DOT: Record<ResourceRow["kind"], string> = {
  app: "bg-muted-foreground/60",
  engine: "bg-info",
  agent: "bg-success",
  helper: "bg-muted-foreground/40",
  other: "bg-muted-foreground/40",
};

const GIB = 1024 ** 3;

/** Absolute per-row load flags (Superset-style): a subtree pinning more than a
 *  core (or CPUs' worth of memory) gets a dot so the culprit reads at a glance.
 *  Numbers stay the signal — the dot is emphasis, not the only encoding. */
function rowSeverity(r: ResourceRow): "high" | "elevated" | null {
  if (r.cpu >= 120 || r.memoryBytes >= 3 * GIB) return "high";
  if (r.cpu >= 70 || r.memoryBytes >= 1.5 * GIB) return "elevated";
  return null;
}

/** ~1 minute of context at the 2s poll cadence. */
const HISTORY_LEN = 30;

interface HistoryPoint {
  cpu: number;
  gpu: number | null;
}

/** Single-series stat-tile sparkline: no axes or grid (the tile label + value
 *  carry identity), fixed x-step so the line grows from the left instead of
 *  stretching as samples arrive. */
function Sparkline({
  values,
  max,
  className,
}: {
  values: number[];
  max: number;
  className?: string;
}) {
  const W = 96;
  const H = 24;
  const step = W / (HISTORY_LEN - 1);
  const points = values
    .map((v, i) => {
      const x = i * step;
      const y = H - 1.5 - (Math.min(v, max) / max) * (H - 3);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      className={className}
    >
      {values.length >= 2 && (
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

/** Icon button in the sidebar header that opens a live per-process resource
 *  breakdown of Cetus's own process tree: the app, the pi engine,
 *  per-conversation CLI-agent turns (claude/codex, with the conversation title
 *  recovered from the worktree), and helpers. The header adds host context:
 *  CPU/GPU sparklines and Cetus's share of system RAM. Polls only while open;
 *  the first sample after a cold start reads 0% CPU (sysinfo needs a delta)
 *  and corrects itself on the quick follow-up tick. */
export function ResourcesPopover({
  onSelectConversation,
}: {
  onSelectConversation?: (id: string) => void;
}) {
  const { t } = useTranslation("sidebar");
  const [open, setOpen] = useState(false);
  const [snap, setSnap] = useState<ResourcesSnapshot | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setHistory([]);
    const tick = () => {
      invoke<ResourcesSnapshot>("resources_snapshot")
        .then((s) => {
          if (cancelled) return;
          setSnap(s);
          setHistory((h) => {
            // Drop the cold-start 0% artifact so the sparkline doesn't open
            // with a fake dip; the 600ms warm tick provides the real first point.
            if (h.length === 0 && s.totalCpu === 0) return h;
            return [
              ...h,
              { cpu: s.totalCpu, gpu: s.gpuUtilization },
            ].slice(-HISTORY_LEN);
          });
        })
        .catch(() => {});
    };
    tick();
    // Quick second sample so CPU deltas show up ~immediately after opening.
    const warm = window.setTimeout(tick, 600);
    const interval = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      window.clearTimeout(warm);
      window.clearInterval(interval);
    };
  }, [open]);

  const cpuHistory = history.map((h) => h.cpu);
  // Floor of 100% keeps idle noise flat; the ceiling follows multi-core spikes.
  const cpuMax = Math.max(100, ...cpuHistory);
  const gpuHistory = history.map((h) => h.gpu ?? 0);

  const sharePct = snap
    ? (snap.totalMemoryBytes / Math.max(1, snap.memTotalBytes)) * 100
    : 0;
  const usedPct = snap
    ? (snap.memUsedBytes / Math.max(1, snap.memTotalBytes)) * 100
    : 0;
  const shareColor =
    sharePct >= 35
      ? "bg-destructive"
      : sharePct >= 20
        ? "bg-warning"
        : "bg-muted-foreground/60";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-hidden transition-colors",
                "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                "focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                "data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground",
              )}
            >
              <Activity className="size-3.5" />
              <span className="sr-only">{t("nav.resources")}</span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="right">{t("nav.resources")}</TooltipContent>
      </Tooltip>
      <PopoverContent side="right" align="start" className="w-80 p-0">
        <div className="border-b border-border px-3 py-2">
          <span className="text-xs font-semibold">{t("resources.title")}</span>
        </div>
        {snap && (
          <div className="border-b border-border px-3 py-2">
            <div
              className={cn(
                "grid gap-3",
                snap.gpuUtilization != null ? "grid-cols-2" : "grid-cols-1",
              )}
            >
              <div>
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-muted-foreground">
                    {t("resources.cpu")}
                  </span>
                  <span className="text-xs font-medium tabular-nums">
                    {snap.totalCpu.toFixed(0)}%
                  </span>
                </div>
                <Sparkline
                  values={cpuHistory}
                  max={cpuMax}
                  className="mt-1 h-6 w-full text-primary"
                />
              </div>
              {snap.gpuUtilization != null && (
                <div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs text-muted-foreground">
                      {t("resources.gpu")}
                    </span>
                    <span className="text-xs font-medium tabular-nums">
                      {snap.gpuUtilization.toFixed(0)}%
                    </span>
                  </div>
                  <Sparkline
                    values={gpuHistory}
                    max={100}
                    className="mt-1 h-6 w-full text-primary"
                  />
                </div>
              )}
            </div>
            <div className="mt-2" title={t("resources.memHint")}>
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-muted-foreground">
                  {t("resources.memory")}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {formatBytes(snap.totalMemoryBytes)} · {sharePct.toFixed(0)}%
                  {" / "}
                  {formatBytes(snap.memTotalBytes)}
                </span>
              </div>
              {/* System-wide usage sits as the faint band behind Cetus's own
                  share, so pressure and share read together on one track. */}
              <div className="relative mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-muted-foreground/25"
                  style={{ width: `${Math.min(100, usedPct)}%` }}
                />
                <div
                  className={cn(
                    "absolute inset-y-0 left-0 rounded-full",
                    shareColor,
                  )}
                  style={{ width: `${Math.min(100, sharePct)}%` }}
                />
              </div>
            </div>
          </div>
        )}
        <div className="max-h-72 overflow-y-auto p-1 scrollbar-slim">
          {!snap || snap.rows.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {t("resources.empty")}
            </p>
          ) : (
            snap.rows.map((r) => {
              const severity = rowSeverity(r);
              const clickable = Boolean(r.conversationId && onSelectConversation);
              const Row = clickable ? "button" : "div";
              return (
                <Row
                  key={r.pid}
                  {...(clickable
                    ? {
                        type: "button" as const,
                        title: t("resources.openConversation"),
                        onClick: () => {
                          onSelectConversation?.(r.conversationId!);
                          setOpen(false);
                        },
                      }
                    : {})}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent",
                    clickable && "cursor-pointer",
                  )}
                >
                  {r.label === "Claude Code" ? (
                    <ClaudeCodeIcon className="size-3.5 shrink-0 rounded-[2px]" />
                  ) : r.label === "Codex" ? (
                    <CodexIcon className="size-3.5 shrink-0 rounded-[2px]" />
                  ) : (
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        KIND_DOT[r.kind],
                      )}
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{r.label}</span>
                    {(r.conversationTitle || r.processCount > 1) && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {[
                          r.conversationTitle,
                          r.processCount > 1
                            ? t("resources.procCount", {
                                count: r.processCount,
                              })
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    )}
                  </span>
                  {severity && (
                    <span
                      title={
                        severity === "high"
                          ? t("resources.sevHigh")
                          : t("resources.sevElevated")
                      }
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        severity === "high" ? "bg-destructive" : "bg-warning",
                      )}
                    />
                  )}
                  <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
                    {r.cpu.toFixed(1)}%
                  </span>
                  <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
                    {formatBytes(r.memoryBytes)}
                  </span>
                </Row>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
