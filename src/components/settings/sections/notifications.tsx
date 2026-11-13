"use client";

/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
 * genre: modern-minimal · macrostructure: Workbench · designed-as-app */
// Full-window settings screen. Renders over the whole app (sidebar included)
// as a dedicated page rather than a modal dialog, with a left section rail and
// a scrollable content pane. Opened from the sidebar, the command palette, or
// ⌘, ; closed with Back or Esc.
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import {
  NOTIFY_EVENTS,
  NOTIFY_SOUNDS,
  type NotifySound,
  ensurePermission,
  refreshPermission,
  useNotificationPrefs,
} from "@/lib/notifications";
import { cn } from "@/lib/utils";
import { SectionHeading, ToggleRow } from "../settings-controls";

// =============================================================================
// Notifications
// =============================================================================

export function NotificationsSection() {
  const { t } = useTranslation("settings");
  const {
    enabled,
    muteWhenFocused,
    sound,
    events,
    permissionGranted,
    setEnabled,
    setMuteWhenFocused,
    setSound,
    setEvent,
  } = useNotificationPrefs();

  // Sync the cached permission state when the section opens.
  useEffect(() => {
    refreshPermission().catch(() => {});
  }, []);

  async function onToggleEnabled(v: boolean) {
    setEnabled(v);
    // Turning it on is the natural moment to ask for OS permission.
    if (v) await ensurePermission();
  }

  function onPickSound(v: NotifySound) {
    setSound(v);
    // Let the pick be heard right away; default and none have no file to play.
    api.playNotificationSound(v).catch(() => {});
  }

  const blocked = enabled && permissionGranted === false;

  return (
    <section>
      <SectionHeading
        title={t("notifications.title")}
        description={t("notifications.description")}
      />

      <div className="mt-6 space-y-1">
        <ToggleRow
          id="notif-enabled"
          label={t("notifications.enable.label")}
          description={t("notifications.enable.description")}
          checked={enabled}
          onCheckedChange={onToggleEnabled}
        />
      </div>

      {blocked && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-warning/50 bg-warning/5 px-3 py-2 text-xs text-warning">
          <span>{t("notifications.blocked")}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => ensurePermission()}
          >
            {t("notifications.recheck")}
          </Button>
        </div>
      )}

      <div className="mt-6">
        <h3 className="text-xs font-medium text-muted-foreground">
          {t("notifications.notifyAbout")}
        </h3>
        <div
          className={cn(
            "mt-2 divide-y divide-border rounded-lg border border-border",
            !enabled && "pointer-events-none opacity-50",
          )}
        >
          {NOTIFY_EVENTS.map((evt) => (
            <ToggleRow
              key={evt.id}
              id={`notif-${evt.id}`}
              label={t(evt.labelKey)}
              description={t(evt.descriptionKey)}
              checked={events[evt.id]}
              onCheckedChange={(v) => setEvent(evt.id, v)}
              disabled={!enabled}
              boxed
            />
          ))}
        </div>
      </div>

      <div className="mt-6">
        <h3 className="text-xs font-medium text-muted-foreground">
          {t("notifications.behavior")}
        </h3>
        <div
          className={cn(
            "mt-2 divide-y divide-border rounded-lg border border-border",
            !enabled && "pointer-events-none opacity-50",
          )}
        >
          <div className="flex items-center justify-between gap-4 px-3 py-3">
            <div className="min-w-0 space-y-0.5">
              <Label htmlFor="notif-sound" className="font-medium">
                {t("notifications.sound.label")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("notifications.sound.description")}
              </p>
            </div>
            <Select
              value={sound}
              onValueChange={(v) => onPickSound(v as NotifySound)}
              disabled={!enabled}
            >
              <SelectTrigger id="notif-sound" className="w-40 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NOTIFY_SOUNDS.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.label ?? t(`notifications.sound.${s.id}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <ToggleRow
            id="notif-mute-focused"
            label={t("notifications.mute.label")}
            description={t("notifications.mute.description")}
            checked={muteWhenFocused}
            onCheckedChange={setMuteWhenFocused}
            disabled={!enabled}
            boxed
          />
        </div>
      </div>
    </section>
  );
}
