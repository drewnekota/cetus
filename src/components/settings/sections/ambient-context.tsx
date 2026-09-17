"use client";

/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
 * genre: modern-minimal · macrostructure: Workbench · designed-as-app */
// Full-window settings screen. Renders over the whole app (sidebar included)
// as a dedicated page rather than a modal dialog, with a left section rail and
// a scrollable content pane. Opened from the sidebar, the command palette, or
// ⌘, ; closed with Back or Esc.
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useTranslation } from "@/lib/i18n";
import { api, type AmbientSettings } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { SectionHeading, ToggleRow } from "../settings-controls";

// =============================================================================
// Ambient text context (accessibility collector)
// =============================================================================

export function AmbientContextSection() {
  const { t } = useTranslation("settings");
  const [settings, setSettings] = useState<AmbientSettings | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [excludedText, setExcludedText] = useState("");

  useEffect(() => {
    api
      .getAmbientSettings()
      .then((s) => {
        setSettings(s);
        setExcludedText(s.excludedApps.join(", "));
      })
      .catch(() => {});
    api
      .ambientStats()
      .then((st) => setCount(st.count))
      .catch(() => {});
  }, []);

  function update(patch: Partial<AmbientSettings>) {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      api.setAmbientSettings(next).catch(() => {});
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
        title={t("ambient.title")}
        description={t("ambient.description")}
      />

      <div className="mt-6 space-y-1">
        <ToggleRow
          id="ambient-enabled"
          label={t("ambient.enable.label")}
          description={t("ambient.enable.description")}
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
            <Label htmlFor="ambient-retention" className="font-medium">
              {t("ambient.retention.label")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("ambient.retention.description")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <NumberInput
              id="ambient-retention"
              min={0}
              fallback={0}
              className="w-20"
              value={settings.retentionDays}
              onValueChange={(v) => update({ retentionDays: v })}
            />
            <span className="text-xs text-muted-foreground">
              {t("ambient.retention.unit")}
            </span>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ambient-excluded" className="font-medium">
            {t("ambient.excluded.label")}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t("ambient.excluded.description")}
          </p>
          <Input
            id="ambient-excluded"
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

        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              api
                .clearAmbientHistory()
                .then(() => setCount(0))
                .catch(() => {});
            }}
          >
            {t("ambient.clear")}
          </Button>
        </div>
      </div>

      {count !== null && (
        <p className="mt-6 text-xs text-muted-foreground">
          {count === 1
            ? t("ambient.entries.one", { count: count.toLocaleString() })
            : t("ambient.entries.other", { count: count.toLocaleString() })}
        </p>
      )}
    </section>
  );
}
