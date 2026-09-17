"use client";

/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
 * genre: modern-minimal · macrostructure: Workbench · designed-as-app */
// Full-window settings screen. Renders over the whole app (sidebar included)
// as a dedicated page rather than a modal dialog, with a left section rail and
// a scrollable content pane. Opened from the sidebar, the command palette, or
// ⌘, ; closed with Back or Esc.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useTranslation } from "@/lib/i18n";
import { api } from "@/lib/tauri";
import {
  DEFAULT_QUICK_SETTINGS,
  type QuickSettings,
  type TranscriptState,
  type VoiceAsrEngine,
  type VoiceGesture,
  type VoicePermissions,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { SectionHeading, SegmentRow, ToggleRow } from "../settings-controls";

// =============================================================================
// Voice dictation
// =============================================================================

export function VoiceSection() {
  const { t } = useTranslation("settings");
  const [settings, setSettings] = useState<QuickSettings>(
    DEFAULT_QUICK_SETTINGS,
  );
  const [perms, setPerms] = useState<VoicePermissions | null>(null);
  const [trusted, setTrusted] = useState<boolean | null>(null);
  const isMac =
    typeof navigator !== "undefined" &&
    /mac/i.test(navigator.platform || navigator.userAgent || "");

  useEffect(() => {
    api
      .getQuickSettings()
      .then((s) =>
        setSettings({
          ...s,
          voiceInsertMode: "type",
          voiceCleanup: true,
          voiceCleanupModel: "",
          voiceBoostingTableId: "",
        }),
      )
      .catch(() => {});
    api
      .voicePermissions()
      .then(setPerms)
      .catch(() => {});
    api
      .accessibilityTrusted()
      .then(setTrusted)
      .catch(() => {});
  }, []);

  function update(patch: Partial<QuickSettings>) {
    const next = {
      ...settings,
      ...patch,
      voiceInsertMode: "type" as const,
      voiceCleanup: true,
      voiceCleanupModel: "",
      voiceBoostingTableId: "",
    };
    setSettings(next);
    api.setQuickSettings(next).catch(() => {});
  }

  // Dictation history (voice context) — opt-in store both the user and the agent
  // (via the recall_dictation tool) can read.
  const [transcripts, setTranscripts] = useState<TranscriptState>({
    enabled: false,
    entries: [],
  });
  useEffect(() => {
    api
      .listTranscripts()
      .then(setTranscripts)
      .catch(() => {});
  }, []);
  function setHistoryEnabled(enabled: boolean) {
    setTranscripts((t) => ({ ...t, enabled }));
    api.setTranscriptsEnabled(enabled).catch(() => {});
  }
  function clearHistory() {
    setTranscripts((t) => ({ ...t, entries: [] }));
    api.clearTranscripts().catch(() => {});
  }

  async function onGrantVoice() {
    const next = await api.requestVoicePermissions().catch(() => null);
    if (next) setPerms(next);
  }

  async function onGrantAx() {
    const ok = await api.requestAccessibility().catch(() => false);
    setTrusted(ok);
  }

  const micOk = perms?.mic === "authorized";
  const speechOk = perms?.speech === "authorized";
  const voiceReady = micOk && speechOk;

  const gestureLabel =
    settings.voiceGesture === "right_option"
      ? t("voice.gesture.rightOption")
      : settings.voiceGesture === "fn"
        ? t("voice.gesture.fn")
        : settings.voiceGesture === "caps_lock"
          ? t("voice.triggerKey.opt.capsLock")
          : t("voice.gesture.rightCmd");

  return (
    <section>
      <SectionHeading
        title={t("voice.title")}
        description={t("voice.description")}
      />

      {!isMac && (
        <p className="mt-3 text-xs text-muted-foreground">
          {t("voice.macOnly")}
        </p>
      )}

      {isMac && perms && !voiceReady && (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-md border border-warning/50 bg-warning/5 px-3 py-2 text-xs text-warning">
          <span>{t("voice.needPerms")}</span>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" onClick={onGrantVoice}>
              {t("voice.grantAccess")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => api.openMicrophoneSettings().catch(() => {})}
            >
              {t("voice.openSettings")}
            </Button>
          </div>
        </div>
      )}
      {isMac && voiceReady && (
        <p className="mt-3 text-xs text-success">{t("voice.permsGranted")}</p>
      )}

      {isMac && (
        <div className="mt-6">
          <SegmentRow
            label={t("voice.engine.label")}
            description={
              settings.voiceAsrEngine === "doubao"
                ? t("voice.engine.doubaoDesc")
                : t("voice.engine.appleDesc")
            }
            value={settings.voiceAsrEngine === "apple" ? "apple" : "doubao"}
            onChange={(v) => update({ voiceAsrEngine: v as VoiceAsrEngine })}
            options={[
              { value: "doubao", label: t("voice.engine.opt.doubao") },
              { value: "apple", label: t("voice.engine.opt.apple") },
            ]}
          />
        </div>
      )}

      <div className="mt-6 space-y-1">
        <ToggleRow
          id="voice-enabled"
          label={t("voice.enable.label")}
          description={t("voice.enable.description", { gesture: gestureLabel })}
          checked={settings.voiceEnabled}
          onCheckedChange={(v) => update({ voiceEnabled: v })}
        />
      </div>

      {isMac && settings.voiceEnabled && trusted === false && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-warning/50 bg-warning/5 px-3 py-2 text-xs text-warning">
          <span>{t("voice.needAccessibility")}</span>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" onClick={onGrantAx}>
              {t("voice.grantAccess")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => api.openAccessibilitySettings().catch(() => {})}
            >
              {t("voice.openSettings")}
            </Button>
          </div>
        </div>
      )}

      <div
        className={cn(
          "mt-4 space-y-5",
          !settings.voiceEnabled && "pointer-events-none opacity-50",
        )}
      >
        <div>
          <SegmentRow
            label={t("voice.triggerKey.label")}
            description={t("voice.triggerKey.holdDesc")}
            value={settings.voiceGesture}
            onChange={(v) => update({ voiceGesture: v as VoiceGesture })}
            options={[
              { value: "right_cmd", label: t("voice.triggerKey.opt.rightCmd") },
              {
                value: "right_option",
                label: t("voice.triggerKey.opt.rightOption"),
              },
              { value: "fn", label: t("voice.triggerKey.opt.fn") },
              { value: "caps_lock", label: t("voice.triggerKey.opt.capsLock") },
            ]}
          />
          {settings.voiceGesture === "caps_lock" && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t("voice.triggerKey.capsNote")}
            </p>
          )}
        </div>

        <div className="rounded-lg border border-border">
          <ToggleRow
            id="voice-handsfree-shortcut"
            label={t("voice.handsfreeShortcut.label")}
            description={t("voice.handsfreeShortcut.description", {
              gesture: gestureLabel,
            })}
            checked={settings.voiceHandsfreeShortcut}
            onCheckedChange={(v) => update({ voiceHandsfreeShortcut: v })}
            boxed
          />
        </div>

        <div className="rounded-lg border border-border">
          <ToggleRow
            id="voice-start-sound"
            label={t("voice.startSound.label")}
            description={t("voice.startSound.description")}
            checked={settings.voiceStartSound}
            onCheckedChange={(v) => update({ voiceStartSound: v })}
            boxed
          />
        </div>

        {settings.voiceAsrEngine === "doubao" && (
          <div className="rounded-lg border border-border">
            <ToggleRow
              id="voice-context-biasing"
              label={t("voice.biasing.label")}
              description={t("voice.biasing.description")}
              checked={settings.voiceContextBiasing}
              onCheckedChange={(v) => update({ voiceContextBiasing: v })}
              boxed
            />
            {settings.voiceContextBiasing && (
              <div className="space-y-2 border-t border-border px-3 py-2.5">
                <Label htmlFor="voice-hotwords" className="text-xs font-medium">
                  {t("voice.biasing.hotwordsLabel")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("voice.biasing.hotwordsHint")}
                </p>
                <Textarea
                  id="voice-hotwords"
                  value={settings.voiceHotwords}
                  onChange={(e) => update({ voiceHotwords: e.target.value })}
                  placeholder={t("voice.biasing.hotwordsPlaceholder")}
                  rows={4}
                  className="text-xs"
                />
              </div>
            )}
          </div>
        )}
      </div>

      {isMac && (
        <div className="mt-6 rounded-lg border border-border">
          <ToggleRow
            id="dictation-history"
            label={t("voice.history.label")}
            description={t("voice.history.description")}
            checked={transcripts.enabled}
            onCheckedChange={setHistoryEnabled}
            boxed
          />
          {transcripts.enabled && (
            <div className="border-t border-border px-3 py-2.5">
              {transcripts.entries.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("voice.history.empty")}
                </p>
              ) : (
                <>
                  <div className="max-h-40 space-y-1 overflow-y-auto">
                    {[...transcripts.entries]
                      .reverse()
                      .slice(0, 50)
                      .map((e) => (
                        <p
                          key={e.id}
                          className="truncate text-xs text-muted-foreground"
                          title={e.text}
                        >
                          {e.text}
                        </p>
                      ))}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="mt-2 h-7 px-2 text-xs text-muted-foreground"
                    onClick={clearHistory}
                  >
                    {t("voice.history.clear", {
                      n: transcripts.entries.length,
                    })}
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
