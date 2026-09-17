"use client";

/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
 * genre: modern-minimal · macrostructure: Workbench · designed-as-app */
// Full-window settings screen. Renders over the whole app (sidebar included)
// as a dedicated page rather than a modal dialog, with a left section rail and
// a scrollable content pane. Opened from the sidebar, the command palette, or
// ⌘, ; closed with Back or Esc.
import { useEffect, useState } from "react";
import { Monitor } from "lucide-react";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useTranslation } from "@/lib/i18n";
import { api, type CaptureSettings } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { SectionHeading, ToggleRow } from "../settings-controls";

// =============================================================================
// Screen context (Rewind-like collection)
// =============================================================================

export function ScreenContextSection({
  onOpenHistory,
}: {
  onOpenHistory: () => void;
}) {
  const { t } = useTranslation("settings");
  const [settings, setSettings] = useState<CaptureSettings | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [excludedText, setExcludedText] = useState("");
  const isMac =
    typeof navigator !== "undefined" &&
    /mac/i.test(navigator.platform || navigator.userAgent || "");

  useEffect(() => {
    api
      .getCaptureSettings()
      .then((s) => {
        setSettings(s);
        setExcludedText(s.excludedApps.join(", "));
      })
      .catch(() => {});
    api
      .captureStats()
      .then((st) => setCount(st.count))
      .catch(() => {});
  }, []);

  function update(patch: Partial<CaptureSettings>) {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      api.setCaptureSettings(next).catch(() => {});
      return next;
    });
  }

  function commitExcluded() {
    const apps = excludedText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    update({ excludedApps: apps });
  }

  if (!settings) return null;

  return (
    <section>
      <SectionHeading
        title={t("screen.title")}
        description={t("screen.description")}
      />

      {!isMac && (
        <p className="mt-3 text-xs text-muted-foreground">
          {t("screen.macOnly")}
        </p>
      )}

      <div className="mt-4">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={onOpenHistory}
        >
          <Monitor className="size-3.5" />
          {t("screen.browse")}
        </Button>
      </div>

      <div className="mt-6 space-y-1">
        <ToggleRow
          id="capture-enabled"
          label={t("screen.enable.label")}
          description={t("screen.enable.description")}
          checked={settings.enabled}
          onCheckedChange={(v) => update({ enabled: v })}
        />
      </div>

      <div
        className={cn(
          "mt-4 space-y-5",
          !settings.enabled && "pointer-events-none opacity-50",
        )}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <Label htmlFor="capture-interval" className="font-medium">
              {t("screen.interval.label")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("screen.interval.description")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <NumberInput
              id="capture-interval"
              min={2}
              fallback={30}
              className="w-20"
              value={settings.intervalSeconds}
              onValueChange={(v) => update({ intervalSeconds: v })}
            />
            <span className="text-xs text-muted-foreground">
              {t("screen.interval.unit")}
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <Label htmlFor="capture-retention" className="font-medium">
              {t("screen.retention.label")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("screen.retention.description")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <NumberInput
              id="capture-retention"
              min={0}
              fallback={0}
              className="w-20"
              value={settings.retentionDays}
              onValueChange={(v) => update({ retentionDays: v })}
            />
            <span className="text-xs text-muted-foreground">
              {t("screen.retention.unit")}
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <Label htmlFor="capture-frame-retention" className="font-medium">
              {t("screen.frameRetention.label")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("screen.frameRetention.description")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <NumberInput
              id="capture-frame-retention"
              min={0}
              fallback={0}
              className="w-20"
              value={settings.frameRetentionDays}
              onValueChange={(v) => update({ frameRetentionDays: v })}
            />
            <span className="text-xs text-muted-foreground">
              {t("screen.frameRetention.unit")}
            </span>
          </div>
        </div>

        <div className="rounded-lg border border-border">
          <ToggleRow
            id="capture-ocr"
            label={t("screen.ocr.label")}
            description={t("screen.ocr.description")}
            checked={settings.ocrEnabled}
            onCheckedChange={(v) => update({ ocrEnabled: v })}
            boxed
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="capture-excluded" className="font-medium">
            {t("screen.excluded.label")}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t("screen.excluded.description")}
          </p>
          <Input
            id="capture-excluded"
            placeholder="1Password, Messages, com.apple.keychainaccess"
            value={excludedText}
            onChange={(e) => setExcludedText(e.target.value)}
            onBlur={commitExcluded}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitExcluded();
              }
            }}
          />
        </div>
      </div>

      {count !== null && (
        <p className="mt-6 text-xs text-muted-foreground">
          {count === 1
            ? t("screen.frames.one", { count: count.toLocaleString() })
            : t("screen.frames.other", { count: count.toLocaleString() })}
        </p>
      )}
    </section>
  );
}
