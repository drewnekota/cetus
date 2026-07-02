"use client";
import { useEffect, useState } from "react";
import { Clock, CornerDownLeft, Command as CommandKey } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ModelPicker } from "@/components/chat/model-picker";
import { WorkspacePicker } from "@/components/chat/workspace-picker";
import { BACKENDS, CliTuningMenu } from "@/components/chat/backend-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { WEEKDAYS } from "@/lib/automation";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  DEFAULT_MODEL_CHOICE,
  type Automation,
  type AutomationInput,
  type AutomationSchedule,
  type BackendId,
  type ModelChoice,
} from "@/lib/types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null → create; otherwise edit this automation. */
  automation: Automation | null;
  defaultModel: ModelChoice;
  defaultWorkspace: string;
  onSubmit: (input: AutomationInput, id: string | null) => Promise<void>;
}

type Mode = "interval" | "daily" | "once" | "cron";
type IntervalUnit = "minutes" | "hours" | "days";

const MODES: { id: Mode; labelKey: string }[] = [
  { id: "interval", labelKey: "mode.interval" },
  { id: "daily", labelKey: "mode.daily" },
  { id: "once", labelKey: "mode.once" },
  { id: "cron", labelKey: "mode.cron" },
];

const UNIT_MINUTES: Record<IntervalUnit, number> = {
  minutes: 1,
  hours: 60,
  days: 1440,
};

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** Split a minute count back into the coarsest whole unit for editing. */
function splitInterval(everyMinutes: number): { value: number; unit: IntervalUnit } {
  const m = Math.max(1, everyMinutes);
  if (m % 1440 === 0) return { value: m / 1440, unit: "days" };
  if (m % 60 === 0) return { value: m / 60, unit: "hours" };
  return { value: m, unit: "minutes" };
}

export function AutomationDialog({
  open,
  onOpenChange,
  automation,
  defaultModel,
  defaultWorkspace,
  onSubmit,
}: Props) {
  const { t } = useTranslation("automation");
  const { t: tc } = useTranslation("common");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState<ModelChoice>(defaultModel ?? DEFAULT_MODEL_CHOICE);
  // Which agent runtime fired runs use (Cetus / Claude Code / Codex) and the
  // CLI backends' optional model override.
  const [backend, setBackend] = useState<BackendId>("pi");
  const [cliModel, setCliModel] = useState("");
  const [cliEffort, setCliEffort] = useState("");
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);

  const [mode, setMode] = useState<Mode>("daily");
  const [intervalValue, setIntervalValue] = useState(1);
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>("hours");
  const [dailyTime, setDailyTime] = useState("09:00");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [onceAt, setOnceAt] = useState("");
  const [cronExpr, setCronExpr] = useState("0 9 * * *");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset the form whenever the dialog opens (create defaults, or prefill the
  // automation being edited).
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSubmitting(false);
    if (automation) {
      setName(automation.name);
      setPrompt(automation.prompt);
      setModel(automation.model);
      setBackend(automation.backend ?? "pi");
      setCliModel(automation.cliModel ?? "");
      setCliEffort(automation.cliEffort ?? "");
      setWorkspaceDir(automation.workspaceDir || null);
      setEnabled(automation.enabled);
      const s = automation.schedule;
      setMode(s.kind);
      if (s.kind === "interval") {
        const { value, unit } = splitInterval(s.everyMinutes);
        setIntervalValue(value);
        setIntervalUnit(unit);
      } else if (s.kind === "daily") {
        setDailyTime(s.time);
        setWeekdays(s.weekdays);
      } else if (s.kind === "once") {
        setOnceAt(toLocalInput(s.atMs));
      } else if (s.kind === "cron") {
        setCronExpr(s.expr);
      }
    } else {
      setName("");
      setPrompt("");
      setModel(defaultModel ?? DEFAULT_MODEL_CHOICE);
      setBackend("pi");
      setCliModel("");
      setCliEffort("");
      setWorkspaceDir(null);
      setEnabled(true);
      setMode("daily");
      setIntervalValue(1);
      setIntervalUnit("hours");
      setDailyTime("09:00");
      setWeekdays([]);
      setOnceAt(toLocalInput(Date.now() + 60 * 60 * 1000));
      setCronExpr("0 9 * * *");
    }
    // defaultModel is intentionally omitted: re-running this reset when the
    // parent's model changes while the dialog is open would wipe in-progress
    // edits. It's read fresh on each open / automation transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, automation]);

  function buildSchedule(): AutomationSchedule | { error: string } {
    switch (mode) {
      case "interval": {
        const v = Math.floor(intervalValue);
        if (!Number.isFinite(v) || v < 1)
          return { error: t("error.intervalMin") };
        return { kind: "interval", everyMinutes: v * UNIT_MINUTES[intervalUnit] };
      }
      case "daily": {
        if (!/^\d{1,2}:\d{2}$/.test(dailyTime))
          return { error: t("error.timeFormat") };
        return { kind: "daily", time: dailyTime, weekdays: [...weekdays].sort((a, b) => a - b) };
      }
      case "once": {
        const ms = new Date(onceAt).getTime();
        if (!Number.isFinite(ms)) return { error: t("error.pickDateTime") };
        return { kind: "once", atMs: ms };
      }
      case "cron": {
        const expr = cronExpr.trim();
        if (expr.split(/\s+/).length !== 5)
          return { error: t("error.cronFields") };
        return { kind: "cron", expr };
      }
    }
  }

  async function handleSubmit() {
    if (submitting) return;
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setError(t("error.promptRequired"));
      return;
    }
    const schedule = buildSchedule();
    if ("error" in schedule) {
      setError(schedule.error);
      return;
    }
    const finalName =
      name.trim() ||
      trimmedPrompt.split("\n")[0].slice(0, 60) ||
      t("fallback.name");
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(
        {
          name: finalName,
          prompt: trimmedPrompt,
          workspaceDir,
          model,
          schedule,
          enabled,
          backend,
          cliModel: backend === "pi" ? "" : cliModel,
          cliEffort: backend === "pi" ? "" : cliEffort,
        },
        automation?.id ?? null,
      );
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  }

  function toggleWeekday(d: number) {
    setWeekdays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d],
    );
  }

  // Split the cron help text on the {expr} placeholder so the example can be
  // rendered inside a styled <code> element while the surrounding words stay
  // translatable.
  const cronHelpParts = t("cron.help").split("{expr}");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="flex max-h-[88vh] w-[90vw] max-w-2xl flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void handleSubmit();
          }
        }}
      >
        <DialogTitle className="sr-only">
          {automation ? t("dialog.editTitle") : t("dialog.newTitle")}
        </DialogTitle>

        {/* Breadcrumb header */}
        <div className="flex items-center gap-2 border-b border-border px-5 py-3">
          <div className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-xs font-semibold text-foreground">
            <Clock className="size-3" />
            {t("dialog.breadcrumb")}
          </div>
          <span className="text-xs text-muted-foreground">›</span>
          <span className="text-xs font-medium text-foreground">
            {automation ? t("dialog.edit") : t("dialog.new")}
          </span>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {/* Name */}
          <div className="space-y-1.5">
            <Label htmlFor="auto-name">{t("dialog.name")}</Label>
            <Input
              id="auto-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("dialog.namePlaceholder")}
            />
          </div>

          {/* Prompt */}
          <div className="space-y-1.5">
            <Label htmlFor="auto-prompt">{t("dialog.prompt")}</Label>
            <Textarea
              id="auto-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t("dialog.promptPlaceholder")}
              rows={4}
              className="min-h-[96px] resize-none"
            />
          </div>

          {/* Schedule */}
          <div className="space-y-2">
            <Label>{t("dialog.schedule")}</Label>
            <div className="inline-flex w-full items-center rounded-lg border border-border bg-card p-0.5">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMode(m.id)}
                  className={cn(
                    "flex-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    mode === m.id
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(m.labelKey)}
                </button>
              ))}
            </div>

            <div className="rounded-lg border border-border bg-muted/30 p-3">
              {mode === "interval" && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">{t("field.every")}</span>
                  <Input
                    type="number"
                    min={1}
                    value={intervalValue}
                    onChange={(e) => setIntervalValue(Number(e.target.value))}
                    className="h-8 w-20"
                  />
                  <select
                    value={intervalUnit}
                    onChange={(e) => setIntervalUnit(e.target.value as IntervalUnit)}
                    className="h-8 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring"
                  >
                    <option value="minutes">{t("unit.minutes")}</option>
                    <option value="hours">{t("unit.hours")}</option>
                    <option value="days">{t("unit.days")}</option>
                  </select>
                </div>
              )}

              {mode === "daily" && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground">{t("field.at")}</span>
                    <Input
                      type="time"
                      value={dailyTime}
                      onChange={(e) => setDailyTime(e.target.value)}
                      className="h-8 w-32"
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    {WEEKDAYS.map((d) => (
                      <button
                        key={d.value}
                        type="button"
                        onClick={() => toggleWeekday(d.value)}
                        title={t(d.longKey)}
                        className={cn(
                          "flex size-7 items-center justify-center rounded-full text-xs font-medium transition-colors",
                          weekdays.includes(d.value)
                            ? "bg-foreground text-background"
                            : "bg-card text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {t(d.shortKey)}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {weekdays.length === 0
                      ? t("daily.everyDay")
                      : t("daily.selectedDays")}
                  </p>
                </div>
              )}

              {mode === "once" && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">{t("field.on")}</span>
                  <Input
                    type="datetime-local"
                    value={onceAt}
                    onChange={(e) => setOnceAt(e.target.value)}
                    className="h-8 w-60"
                  />
                </div>
              )}

              {mode === "cron" && (
                <div className="space-y-1.5">
                  <Input
                    value={cronExpr}
                    onChange={(e) => setCronExpr(e.target.value)}
                    placeholder={t("cron.placeholder")}
                    className="h-8 font-mono"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    {cronHelpParts.flatMap((part, i) =>
                      i === 0
                        ? [part]
                        : [
                            <code key={i} className="font-mono">
                              0 9 * * 1-5
                            </code>,
                            part,
                          ],
                    )}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Metadata bar */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
          <WorkspacePicker
            workspaceDir={workspaceDir}
            defaultWorkspace={defaultWorkspace}
            onChange={setWorkspaceDir}
          />
          <div className="ml-auto flex items-center gap-1">
            <Select
              value={backend}
              onValueChange={(v) => {
                setBackend(v as BackendId);
                // Model/effort overrides belong to one backend's catalog.
                setCliModel("");
                setCliEffort("");
              }}
            >
              <SelectTrigger
                size="sm"
                className="h-7 gap-1.5 border-0 bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-muted hover:text-foreground focus-visible:ring-0 data-[size=sm]:h-7"
              >
                {(() => {
                  const current =
                    BACKENDS.find((b) => b.id === backend) ?? BACKENDS[0];
                  const Icon = current.icon;
                  return (
                    <>
                      <Icon className="size-3" />
                      <span className="truncate">{current.label}</span>
                    </>
                  );
                })()}
              </SelectTrigger>
              <SelectContent align="end">
                {BACKENDS.map((b) => {
                  const Icon = b.icon;
                  return (
                    <SelectItem key={b.id} value={b.id} className="text-xs">
                      <Icon className="size-4" />
                      <span className="truncate">{b.label}</span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {backend === "pi" ? (
              <ModelPicker value={model} onChange={setModel} />
            ) : (
              <CliTuningMenu
                backend={backend}
                model={cliModel}
                effort={cliEffort}
                onModelChange={setCliModel}
                onEffortChange={setCliEffort}
              />
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border px-5 py-3">
          {error ? (
            <span className="text-xs text-destructive">{error}</span>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              {t("footer.hint")}
            </span>
          )}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              {tc("action.cancel")}
            </Button>
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={!prompt.trim() || submitting}
              className="gap-1.5"
            >
              {submitting
                ? t("footer.saving")
                : automation
                  ? t("footer.saveChanges")
                  : t("footer.create")}
              <kbd className="flex items-center gap-0.5 rounded border border-primary-foreground/20 bg-primary-foreground/10 px-1.5 py-0.5 leading-none text-primary-foreground/70">
                <CommandKey className="size-3" />
                <CornerDownLeft className="size-3" />
              </kbd>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
