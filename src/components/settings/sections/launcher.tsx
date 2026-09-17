"use client";

/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
 * genre: modern-minimal · macrostructure: Workbench · designed-as-app */
// Full-window settings screen. Renders over the whole app (sidebar included)
// as a dedicated page rather than a modal dialog, with a left section rail and
// a scrollable content pane. Opened from the sidebar, the command palette, or
// ⌘, ; closed with Back or Esc.
import { useEffect, useState } from "react";
import { useRuntimeCatalog } from "@/components/chat/backend-picker";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslation } from "@/lib/i18n";
import { api } from "@/lib/tauri";
import {
  DEFAULT_QUICK_SETTINGS,
  type BackendId,
  type QuickGesture,
  type QuickSessionMode,
  type QuickSettings,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { HotkeyRecorder } from "../hotkey-recorder";
import { SectionHeading, ToggleRow, SegmentRow } from "../settings-controls";

// =============================================================================
// Launcher
// =============================================================================

export function LauncherSection() {
  const { t } = useTranslation("settings");
  const { orderedBackends, enabledBackendIds } = useRuntimeCatalog();
  const [settings, setSettings] = useState<QuickSettings>(
    DEFAULT_QUICK_SETTINGS,
  );
  const [trusted, setTrusted] = useState<boolean | null>(null);
  const [screenRec, setScreenRec] = useState<boolean | null>(null);
  const isMac =
    typeof navigator !== "undefined" &&
    /mac/i.test(navigator.platform || navigator.userAgent || "");

  useEffect(() => {
    api
      .getQuickSettings()
      .then(setSettings)
      .catch(() => {});
    api
      .accessibilityTrusted()
      .then(setTrusted)
      .catch(() => {});
    api
      .screenRecordingTrusted()
      .then(setScreenRec)
      .catch(() => {});
  }, []);

  function update(patch: Partial<QuickSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    api.setQuickSettings(next).catch(() => {});
  }

  async function onGrant() {
    const ok = await api.requestAccessibility().catch(() => false);
    setTrusted(ok);
  }

  async function onGrantScreen() {
    const ok = await api.requestScreenRecording().catch(() => false);
    setScreenRec(ok);
  }

  const gestureName = (g: QuickGesture) =>
    g === "off"
      ? t("launcher.gesture.opt.off")
      : g === "double_cmd"
        ? t("launcher.gesture.opt.double")
        : g === "double_opt"
          ? t("launcher.gesture.opt.doubleOpt")
          : g === "both_opt"
            ? t("launcher.gesture.opt.bothOpt")
            : t("launcher.gesture.opt.both");

  // Selectable triggers for each function. The picker for one function hides the
  // gesture already taken by the other so the two can't collide.
  const GESTURE_OPTS: QuickGesture[] = [
    "off",
    "both_cmd",
    "both_opt",
    "double_cmd",
    "double_opt",
  ];

  // Show the first enabled global gesture in the master-switch hint.
  const gestureLabel = gestureName(
    settings.gesturePlain !== "off"
      ? settings.gesturePlain
      : settings.gestureShot !== "off"
        ? settings.gestureShot
        : settings.gestureReply,
  );

  // Screenshot launch and direct visual replies both need Screen Recording.
  const wantsScreenshot =
    settings.gestureShot !== "off" || settings.gestureReply !== "off";
  const replyBackends = orderedBackends.filter((runtime) =>
    enabledBackendIds.has(runtime.id),
  );

  return (
    <section>
      <SectionHeading
        title={t("launcher.title")}
        description={t("launcher.description")}
      />

      {isMac && trusted === false && (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-md border border-warning/50 bg-warning/5 px-3 py-2 text-xs text-warning">
          <span>{t("launcher.needAccessibility")}</span>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" onClick={onGrant}>
              {t("launcher.grantAccess")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => api.openAccessibilitySettings().catch(() => {})}
            >
              {t("launcher.openSettings")}
            </Button>
          </div>
        </div>
      )}
      {isMac && trusted === true && (
        <p className="mt-3 text-xs text-success">
          {t("launcher.accessibilityGranted")}
        </p>
      )}
      {isMac && wantsScreenshot && screenRec === false && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-warning/50 bg-warning/5 px-3 py-2 text-xs text-warning">
          <span>{t("launcher.needScreenRecording")}</span>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" onClick={onGrantScreen}>
              {t("launcher.grantAccess")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => api.openScreenRecordingSettings().catch(() => {})}
            >
              {t("launcher.openSettings")}
            </Button>
          </div>
        </div>
      )}
      {isMac && wantsScreenshot && screenRec === true && (
        <p className="mt-2 text-xs text-success">
          {t("launcher.screenRecordingGranted")}
        </p>
      )}
      {!isMac && (
        <p className="mt-3 text-xs text-muted-foreground">
          {t("launcher.macOnly")}
        </p>
      )}

      <div className="mt-6 space-y-1">
        <ToggleRow
          id="quick-enabled"
          label={t("launcher.enable.label")}
          description={t("launcher.enable.description", {
            gesture: gestureLabel,
          })}
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
        {/* Each function owns one collision-free global modifier gesture. */}
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <Label className="font-medium">
              {t("launcher.fn.plain.label")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("launcher.fn.plain.description")}
            </p>
          </div>
          <Select
            value={settings.gesturePlain}
            onValueChange={(v) => update({ gesturePlain: v as QuickGesture })}
          >
            <SelectTrigger className="w-52 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GESTURE_OPTS.filter(
                (g) =>
                  g === "off" ||
                  g === settings.gesturePlain ||
                  (g !== settings.gestureShot && g !== settings.gestureReply),
              ).map((g) => (
                <SelectItem key={g} value={g}>
                  {gestureName(g)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <Label className="font-medium">{t("launcher.fn.shot.label")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("launcher.fn.shot.description")}
            </p>
          </div>
          <Select
            value={settings.gestureShot}
            onValueChange={(v) => update({ gestureShot: v as QuickGesture })}
          >
            <SelectTrigger className="w-52 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GESTURE_OPTS.filter(
                (g) =>
                  g === "off" ||
                  g === settings.gestureShot ||
                  (g !== settings.gesturePlain && g !== settings.gestureReply),
              ).map((g) => (
                <SelectItem key={g} value={g}>
                  {gestureName(g)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <Label className="font-medium">
              {t("launcher.fn.reply.label")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("launcher.fn.reply.description")}
            </p>
          </div>
          <Select
            value={settings.gestureReply}
            onValueChange={(v) => update({ gestureReply: v as QuickGesture })}
          >
            <SelectTrigger className="w-52 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GESTURE_OPTS.filter(
                (g) =>
                  g === "off" ||
                  g === settings.gestureReply ||
                  (g !== settings.gesturePlain && g !== settings.gestureShot),
              ).map((g) => (
                <SelectItem key={g} value={g}>
                  {gestureName(g)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <Label className="font-medium">
              {t("launcher.replyRuntime.label")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("launcher.replyRuntime.description")}
            </p>
          </div>
          <Select
            value={
              enabledBackendIds.has(settings.replyBackend)
                ? settings.replyBackend
                : "pi"
            }
            onValueChange={(value) =>
              update({ replyBackend: value as BackendId })
            }
          >
            <SelectTrigger className="w-52 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {replyBackends.map((runtime) => (
                <SelectItem key={runtime.id} value={runtime.id}>
                  {runtime.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {isMac && (
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 space-y-0.5">
              <Label className="font-medium">
                {t("launcher.summon.label")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("launcher.summon.description")}
              </p>
            </div>
            <HotkeyRecorder
              value={settings.summonHotkey}
              onChange={(v) => update({ summonHotkey: v })}
              placeholder={t("launcher.summon.placeholder")}
              recordingLabel={t("launcher.summon.recording")}
              clearLabel={t("launcher.summon.clear")}
            />
          </div>
        )}

        <SegmentRow
          label={t("launcher.session.label")}
          description={t("launcher.session.description")}
          value={settings.sessionMode}
          onChange={(v) => update({ sessionMode: v as QuickSessionMode })}
          options={[
            { value: "new", label: t("launcher.session.opt.new") },
            { value: "last", label: t("launcher.session.opt.last") },
          ]}
        />
      </div>
    </section>
  );
}
