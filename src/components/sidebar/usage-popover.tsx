"use client";
import { useCallback, useEffect, useState } from "react";
import { Gauge, RefreshCw } from "lucide-react";
import { invoke } from "@/lib/host/core";
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
import { ClaudeCodeIcon, CodexIcon } from "@/components/brand-icons";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Mirrors `usage::UsageSnapshot` on the Rust side. */
interface UsageWindow {
  id: string;
  label: string;
  usedPct: number | null;
  resetsAt: string | null;
}

interface ProviderUsage {
  provider: "claude" | "codex";
  status: "ok" | "signedOut" | "expired" | "error";
  plan: string | null;
  account: string | null;
  windows: UsageWindow[];
  details: { label: string; value: string }[];
  error: string | null;
}

interface UsageSnapshot {
  providers: ProviderUsage[];
  fetchedAt: number;
}

const PROVIDERS = {
  claude: { name: "Claude", Icon: ClaudeCodeIcon },
  codex: { name: "Codex", Icon: CodexIcon },
} as const;

/** "2d 22h" / "3h 5m" / "12m". */
function countdown(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function resetLabel(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const when = at.toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${countdown(at.getTime() - Date.now())} · ${when}`;
}

function barColor(pct: number): string {
  if (pct > 90) return "bg-destructive";
  if (pct >= 70) return "bg-warning";
  return "bg-primary";
}

function WindowRow({ w }: { w: UsageWindow }) {
  const { t } = useTranslation("sidebar");
  const pct = w.usedPct == null ? null : Math.min(100, Math.max(0, w.usedPct));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate">{w.label}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {pct == null ? "—" : t("usage.used", { pct: Math.round(pct) })}
        </span>
      </div>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
        {pct != null && (
          <div
            className={cn("h-full rounded-full", barColor(pct))}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
      {w.resetsAt && (
        <div className="mt-1 text-2xs tabular-nums text-muted-foreground">
          {t("usage.resets", { when: resetLabel(w.resetsAt) })}
        </div>
      )}
    </div>
  );
}

function ProviderCard({ p }: { p: ProviderUsage }) {
  const { t } = useTranslation("sidebar");
  const { name, Icon } = PROVIDERS[p.provider];
  return (
    <div className="px-3 py-3">
      <div className="flex items-center gap-2">
        <Icon className="size-3.5 shrink-0 rounded-[2px]" />
        <span className="text-sm">{name}</span>
        {p.plan && (
          <span className="rounded-full bg-muted px-1.5 py-px text-2xs capitalize text-muted-foreground">
            {p.plan}
          </span>
        )}
      </div>
      {p.status === "ok" ? (
        <div className="mt-3 flex flex-col gap-3">
          {p.windows.map((w) => (
            <WindowRow key={w.id} w={w} />
          ))}
          {p.details.map((d) => (
            <div
              key={d.label}
              className="flex items-baseline justify-between gap-2 text-xs"
            >
              <span className="text-muted-foreground">{d.label}</span>
              <span className="tabular-nums">{d.value}</span>
            </div>
          ))}
          {p.account && (
            <div className="truncate text-2xs text-muted-foreground">
              {p.account}
            </div>
          )}
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          {p.status === "signedOut"
            ? t("usage.signedOut", { name })
            : p.status === "expired"
              ? t("usage.expired", { name })
              : p.error}
        </p>
      )}
    </div>
  );
}

/** Footer readout of the Claude / Codex subscription limits the user is signed
 *  into — the same numbers `/usage` shows inside each CLI. */
export function UsagePopover() {
  const { t } = useTranslation("sidebar");
  const [open, setOpen] = useState(false);
  const [snap, setSnap] = useState<UsageSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (force: boolean) => {
    setLoading(true);
    try {
      setSnap(await invoke<UsageSnapshot>("provider_usage", { force }));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // The backend serves a cached snapshot for a couple of minutes, so opening
  // the popover repeatedly doesn't hammer the vendors' endpoints.
  useEffect(() => {
    if (open) void load(false);
  }, [open, load]);

  // Signed-out runtimes only add noise; show them only when nothing is signed in.
  const shown = snap?.providers.filter((p) => p.status !== "signedOut") ?? [];
  const providers = shown.length ? shown : (snap?.providers ?? []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid="usage-trigger"
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-hidden transition-colors",
                "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                "focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                "data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground",
              )}
            >
              <Gauge className="size-3.5" />
              <span className="sr-only">{t("nav.usage")}</span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="right">{t("nav.usage")}</TooltipContent>
      </Tooltip>
      <PopoverContent side="right" align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs font-semibold">{t("usage.title")}</span>
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={loading}
            title={t("usage.refresh")}
            className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className={cn("size-3", loading && "animate-spin")} />
            <span className="sr-only">{t("usage.refresh")}</span>
          </button>
        </div>
        {error ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">{error}</p>
        ) : !snap ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            {t("usage.loading")}
          </p>
        ) : (
          <div className="max-h-[70vh] divide-y divide-border overflow-y-auto scrollbar-slim">
            {providers.map((p) => (
              <ProviderCard key={p.provider} p={p} />
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
