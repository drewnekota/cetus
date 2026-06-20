"use client";
import {
  Clock,
  Folder,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { describeSchedule, formatLastRun, formatNextRun } from "@/lib/automation";
import { useTranslation } from "@/lib/i18n";
import { workspaceName } from "@/lib/paths";
import type { Automation } from "@/lib/types";

interface Props {
  automations: Automation[];
  defaultWorkspace: string;
  onNew: () => void;
  onEdit: (a: Automation) => void;
  onToggle: (a: Automation, enabled: boolean) => void;
  onRunNow: (a: Automation) => void;
  onDelete: (a: Automation) => void;
  onOpenConversation: (id: string) => void;
}

export function AutomationsView({
  automations,
  defaultWorkspace,
  onNew,
  onEdit,
  onToggle,
  onRunNow,
  onDelete,
  onOpenConversation,
}: Props) {
  const { t } = useTranslation("automation");
  return (
    <div className="flex-1 overflow-y-auto px-4 pb-6 pt-2">
      <div className="mx-auto w-full max-w-3xl">
        <div className="flex items-center justify-between pb-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              {t("view.title")}
            </h2>
            <p className="text-xs text-muted-foreground">{t("view.subtitle")}</p>
          </div>
          <Button size="sm" onClick={onNew} className="gap-1.5">
            <Plus className="size-4" />
            {t("view.new")}
          </Button>
        </div>

        {automations.length === 0 ? (
          <button
            type="button"
            onClick={onNew}
            className="flex w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border/70 px-6 py-16 text-center transition-colors hover:border-border hover:bg-muted/30"
          >
            <span className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Clock className="size-5" />
            </span>
            <span className="text-sm font-medium text-foreground">
              {t("empty.title")}
            </span>
            <span className="max-w-sm text-xs text-muted-foreground">
              {t("empty.description")}
            </span>
          </button>
        ) : (
          <div className="space-y-2">
            {automations.map((a) => (
              <AutomationCard
                key={a.id}
                automation={a}
                defaultWorkspace={defaultWorkspace}
                onEdit={() => onEdit(a)}
                onToggle={(enabled) => onToggle(a, enabled)}
                onRunNow={() => onRunNow(a)}
                onDelete={() => onDelete(a)}
                onOpenConversation={onOpenConversation}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AutomationCard({
  automation,
  defaultWorkspace,
  onEdit,
  onToggle,
  onRunNow,
  onDelete,
  onOpenConversation,
}: {
  automation: Automation;
  defaultWorkspace: string;
  onEdit: () => void;
  onToggle: (enabled: boolean) => void;
  onRunNow: () => void;
  onDelete: () => void;
  onOpenConversation: (id: string) => void;
}) {
  const { t } = useTranslation("automation");
  const a = automation;
  return (
    <div
      className={cn(
        "group relative rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-border/80",
        !a.enabled && "opacity-70",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Clock className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium text-foreground">
              {a.name || t("card.untitled")}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-snug text-muted-foreground">
            {a.prompt}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-medium text-foreground/80">
              {describeSchedule(a.schedule)}
            </span>
            {a.enabled ? (
              <span>{t("card.next", { time: formatNextRun(a.nextRunAt) })}</span>
            ) : (
              <span className="text-warning/80">{t("card.paused")}</span>
            )}
            <span className="inline-flex min-w-0 items-center gap-1">
              <Folder className="size-3 shrink-0" />
              <span className="truncate">
                {shorten(a.workspaceDir, defaultWorkspace, t("card.defaultWorkspace"))}
              </span>
            </span>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 text-[11px]">
            <span className="text-muted-foreground">
              {a.runCount > 0
                ? t(a.runCount === 1 ? "card.runs" : "card.runs_plural", {
                    count: a.runCount,
                    time: formatLastRun(a.lastRunAt),
                  })
                : t("card.neverRun")}
            </span>
            {a.lastStatus === "error" && (
              <span className="text-destructive" title={a.lastError ?? undefined}>
                {t("card.lastRunFailed")}
              </span>
            )}
            {a.lastConversationId && (
              <button
                type="button"
                onClick={() => onOpenConversation(a.lastConversationId!)}
                className="text-primary hover:underline"
              >
                {t("card.viewLastRun")}
              </button>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Switch
            checked={a.enabled}
            onCheckedChange={onToggle}
            aria-label={a.enabled ? t("card.disable") : t("card.enable")}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onRunNow}
            title={t("card.runNow")}
          >
            <Play className="size-4" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                aria-label={t("card.more")}
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-36 rounded-lg">
              <DropdownMenuItem onClick={onEdit}>
                <Pencil />
                <span>{t("card.edit")}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onRunNow}>
                <Play />
                <span>{t("card.runNow")}</span>
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 />
                <span>{t("card.delete")}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

function shorten(
  p: string,
  defaultWorkspace: string,
  defaultLabel: string,
): string {
  if (!p || p === defaultWorkspace) return defaultLabel;
  return workspaceName(p);
}
