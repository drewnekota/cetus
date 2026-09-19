"use client";

/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
 * genre: modern-minimal · macrostructure: Workbench · designed-as-app */
// Full-window settings screen. Renders over the whole app (sidebar included)
// as a dedicated page rather than a modal dialog, with a left section rail and
// a scrollable content pane. Opened from the sidebar, the command palette, or
// ⌘, ; closed with Back or Esc.
import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  LOCALE_NATIVE_NAMES,
  LOCALES,
  useLocale,
  useTranslation,
  type LocalePreference,
} from "@/lib/i18n";
import {
  setConversationAutoSort,
  useConversationAutoSort,
} from "@/lib/conversation-order";
import { api, onUpdateDownloadProgress, onUpdateReady } from "@/lib/tauri";
import type { UpdateMeta, UpdateDownloadProgress } from "@/lib/types";
import { DEFAULT_QUICK_SETTINGS, type QuickSettings } from "@/lib/types";
import {
  updateDownloadPercent,
  updateDownloadSize,
  UpdateProgressBar,
} from "../update-progress";
import { SectionHeading, ToggleRow } from "../settings-controls";

// =============================================================================
// General
// =============================================================================

// App-level basics: the display language and OS launch-on-startup. Language is a
// common-namespace pref (localStorage via useLocale); launch-on-startup is a
// QuickSettings field (the launcher also re-fetches QuickSettings on open, so
// the two editors don't drift within a session).
export function GeneralSection() {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation("common");
  const { preference: localePref, setPreference: setLocalePref } = useLocale();
  const autoSortConversations = useConversationAutoSort();
  const [settings, setSettings] = useState<QuickSettings>(
    DEFAULT_QUICK_SETTINGS,
  );
  const [appVersion, setAppVersion] = useState("");
  const [checkState, setCheckState] = useState<
    | "idle"
    | "checking"
    | "upToDate"
    | "available"
    | "installing"
    | "ready"
    | "failed"
  >("idle");
  const [pending, setPending] = useState<UpdateMeta | null>(null);
  const [downloadProgress, setDownloadProgress] =
    useState<UpdateDownloadProgress | null>(null);
  const [diagState, setDiagState] = useState<"idle" | "busy" | "copied">(
    "idle",
  );

  async function copyDiagnostics() {
    setDiagState("busy");
    try {
      const report = await api.exportDiagnostics();
      await navigator.clipboard.writeText(report);
      setDiagState("copied");
      setTimeout(() => setDiagState("idle"), 2000);
    } catch {
      setDiagState("idle");
    }
  }

  useEffect(() => {
    api
      .getQuickSettings()
      .then(setSettings)
      .catch(() => {});
    api
      .pendingUpdateVersion()
      .then((version) => {
        if (version) setCheckState("ready");
      })
      .catch(() => {});
    // This section unmounts whenever another settings section is open, so a
    // download started here (or by a background check) is usually already
    // running by the time we come back. Re-attach to it instead of resetting to
    // an idle "Check for updates".
    api
      .updateDownloadProgress()
      .then((progress) => {
        if (!progress || progress.finished || progress.failed) return;
        setDownloadProgress(progress);
        setCheckState("installing");
      })
      .catch(() => {});
    import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    onUpdateDownloadProgress((progress) => {
      setDownloadProgress(progress);
      if (progress.failed) {
        setDownloadProgress(null);
        setCheckState("failed");
        return;
      }
      if (progress.finished) {
        setCheckState("ready");
        setTimeout(() => setDownloadProgress(null), 800);
      } else {
        // A background check can start a download while this panel is open.
        setCheckState("installing");
      }
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    onUpdateReady(() => setCheckState("ready")).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  function update(patch: Partial<QuickSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    api.setQuickSettings(next).catch(() => {});
  }

  async function checkUpdates() {
    setCheckState("checking");
    try {
      const u = await api.checkForUpdate();
      if (u) {
        setPending(u);
        setCheckState("available");
      } else {
        setCheckState("upToDate");
      }
    } catch {
      setCheckState("failed");
    }
  }

  async function installNow() {
    setCheckState("installing");
    setDownloadProgress(null);
    try {
      const staged = await api.installUpdate();
      if (!staged) {
        // A download was already in flight (background check, or this panel
        // before it was unmounted). It keeps running and reports through the
        // progress / update-ready events — don't claim it's done.
        return;
      }
      setPending(null);
      setDownloadProgress(null);
      // Swap is on disk. Surface a Restart button so the user can apply it now
      // instead of waiting for the next launch.
      setCheckState("ready");
    } catch {
      setDownloadProgress(null);
      setCheckState("failed");
    }
  }

  function restartNow() {
    api.relaunchApp().catch(() => {});
  }

  const downloadPercent = updateDownloadPercent(downloadProgress);
  const downloadSize = updateDownloadSize(downloadProgress);

  return (
    <section>
      <SectionHeading
        title={t("general.title")}
        description={t("general.description")}
      />

      <div className="mt-6 space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <Label className="font-medium">{tc("language.label")}</Label>
            <p className="text-xs text-muted-foreground">
              {tc("language.description")}
            </p>
          </div>
          <Select
            value={localePref}
            onValueChange={(v) => setLocalePref(v as LocalePreference)}
          >
            <SelectTrigger className="w-52 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">{tc("language.system")}</SelectItem>
              {LOCALES.map((loc) => (
                <SelectItem key={loc} value={loc}>
                  {LOCALE_NATIVE_NAMES[loc]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mt-2">
        <ToggleRow
          id="auto-sort-conversations"
          label={t("general.autoSortConversations.label")}
          description={t("general.autoSortConversations.description")}
          checked={autoSortConversations}
          onCheckedChange={setConversationAutoSort}
        />
        <ToggleRow
          id="launch-on-startup"
          label={t("launcher.startup.label")}
          description={t("launcher.startup.description")}
          checked={settings.launchOnStartup}
          onCheckedChange={(v) => update({ launchOnStartup: v })}
        />
        <ToggleRow
          id="auto-update"
          label={t("general.autoUpdate.label")}
          description={t("general.autoUpdate.description")}
          checked={settings.autoUpdate}
          onCheckedChange={(v) => update({ autoUpdate: v })}
        />
        <ToggleRow
          id="confirm-quit"
          label={t("general.confirmQuit.label")}
          description={t("general.confirmQuit.description")}
          checked={settings.confirmQuit}
          onCheckedChange={(v) => update({ confirmQuit: v })}
        />
        <ToggleRow
          id="keep-awake-while-working"
          label={t("general.keepAwake.label")}
          description={t("general.keepAwake.description")}
          checked={settings.keepAwakeWhileWorking}
          onCheckedChange={(v) => update({ keepAwakeWhileWorking: v })}
        />
        <div className="flex items-center justify-between gap-4 py-3">
          <div className="min-w-0 space-y-0.5">
            <div className="flex items-center gap-2">
              <Label className="font-medium">{t("update.check.label")}</Label>
              {appVersion ? (
                <span className="font-mono text-xs text-muted-foreground">
                  v{appVersion}
                </span>
              ) : null}
            </div>
            {checkState !== "idle" ? (
              <p className="text-xs text-muted-foreground">
                {checkState === "checking"
                  ? t("update.check.checking")
                  : checkState === "installing"
                    ? [
                        t("update.installing"),
                        downloadPercent == null ? null : `${downloadPercent}%`,
                        downloadSize,
                      ]
                        .filter(Boolean)
                        .join(" ")
                    : checkState === "ready"
                      ? t("update.installed")
                      : checkState === "upToDate"
                        ? t("update.check.upToDate")
                        : checkState === "available" && pending
                          ? t("update.check.available", {
                              version: pending.version,
                            })
                          : checkState === "failed"
                            ? t("update.failed")
                            : ""}
              </p>
            ) : null}
          </div>
          {checkState === "ready" ? (
            <Button size="sm" className="shrink-0 gap-1.5" onClick={restartNow}>
              <RotateCw className="size-3.5" />
              {t("update.check.restart")}
            </Button>
          ) : checkState === "available" || checkState === "installing" ? (
            <Button
              size="sm"
              className="shrink-0"
              disabled={checkState === "installing"}
              onClick={installNow}
            >
              {checkState === "installing"
                ? t("update.installing")
                : t("update.check.install")}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={checkState === "checking"}
              onClick={checkUpdates}
            >
              {checkState === "checking"
                ? t("update.check.checking")
                : t("update.check.button")}
            </Button>
          )}
        </div>
        {checkState === "installing" ? (
          <div className="mt-2 max-w-md">
            <UpdateProgressBar progress={downloadProgress} />
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-4 py-3">
          <div className="min-w-0 space-y-0.5">
            <Label className="font-medium">{t("diagnostics.label")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("diagnostics.description")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={diagState === "busy"}
            onClick={copyDiagnostics}
          >
            {diagState === "copied"
              ? t("diagnostics.copied")
              : t("diagnostics.copy")}
          </Button>
        </div>
      </div>
    </section>
  );
}
