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
}

/** Accent dot per row kind — same visual language as the kanban status dots. */
const KIND_DOT: Record<ResourceRow["kind"], string> = {
  app: "bg-muted-foreground/60",
  engine: "bg-info",
  agent: "bg-success",
  helper: "bg-muted-foreground/40",
  other: "bg-muted-foreground/40",
};

/** Icon button in the sidebar header that opens a live per-process resource
 *  breakdown of Cetus's own process tree: the app, the pi engine,
 *  per-conversation CLI-agent turns (claude/codex, with the conversation title
 *  recovered from the worktree), and helpers. Polls only while open; the first
 *  sample after a cold start reads 0% CPU (sysinfo needs a delta) and corrects
 *  itself on the quick follow-up tick. */
export function ResourcesPopover() {
  const { t } = useTranslation("sidebar");
  const [open, setOpen] = useState(false);
  const [snap, setSnap] = useState<ResourcesSnapshot | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const tick = () => {
      invoke<ResourcesSnapshot>("resources_snapshot")
        .then((s) => {
          if (!cancelled) setSnap(s);
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
        <div className="flex items-baseline justify-between border-b border-border px-3 py-2">
          <span className="text-xs font-semibold">{t("resources.title")}</span>
          {snap && (
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {t("resources.cpu")} {snap.totalCpu.toFixed(1)}% ·{" "}
              {t("resources.memory")} {formatBytes(snap.totalMemoryBytes)}
            </span>
          )}
        </div>
        <div className="max-h-72 overflow-y-auto p-1 scrollbar-slim">
          {!snap || snap.rows.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {t("resources.empty")}
            </p>
          ) : (
            snap.rows.map((r) => (
              <div
                key={r.pid}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent"
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
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {[
                        r.conversationTitle,
                        r.processCount > 1
                          ? t("resources.procCount", { count: r.processCount })
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  )}
                </span>
                <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
                  {r.cpu.toFixed(1)}%
                </span>
                <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
                  {formatBytes(r.memoryBytes)}
                </span>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
