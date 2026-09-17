"use client";

/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
 * genre: modern-minimal · macrostructure: Workbench · designed-as-app */
// Full-window settings screen. Renders over the whole app (sidebar included)
// as a dedicated page rather than a modal dialog, with a left section rail and
// a scrollable content pane. Opened from the sidebar, the command palette, or
// ⌘, ; closed with Back or Esc.
import { useEffect, useState } from "react";
import { ArchiveRestore, Trash2 } from "lucide-react";
import { NumberInput } from "@/components/ui/number-input";
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
import { api, onAppEvent } from "@/lib/tauri";
import type { AutoArchiveSettings, Conversation } from "@/lib/types";
import { DEFAULT_AUTO_ARCHIVE_SETTINGS } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  ToggleRow,
  SectionHeading,
  SettingsRowsSkeleton,
} from "../settings-controls";

// =============================================================================
// Archived chats
// =============================================================================

/** Opt-in auto-archive controls, shown atop the Archived chats page. */
function AutoArchiveSettingsBlock() {
  const { t } = useTranslation("settings");
  const [settings, setSettings] = useState<AutoArchiveSettings>(
    DEFAULT_AUTO_ARCHIVE_SETTINGS,
  );

  useEffect(() => {
    api
      .getAutoArchiveSettings()
      .then(setSettings)
      .catch(() => {});
  }, []);

  function update(patch: Partial<AutoArchiveSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    api.setAutoArchiveSettings(next).catch(() => {});
  }

  return (
    <div className="mt-6 rounded-lg border border-border p-4">
      <ToggleRow
        id="auto-archive-enabled"
        label={t("autoArchive.enable.label")}
        description={t("autoArchive.enable.description")}
        checked={settings.enabled}
        onCheckedChange={(v) => update({ enabled: v })}
      />

      <div
        className={cn(
          "mt-4 flex items-center justify-between gap-4",
          !settings.enabled && "pointer-events-none opacity-50",
        )}
      >
        <div className="min-w-0 space-y-0.5">
          <Label htmlFor="auto-archive-value" className="font-medium">
            {t("autoArchive.threshold.label")}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t("autoArchive.threshold.description")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <NumberInput
            id="auto-archive-value"
            min={1}
            fallback={1}
            className="w-20"
            value={settings.value}
            onValueChange={(v) => update({ value: v })}
          />
          <Select
            value={settings.unit}
            onValueChange={(v) =>
              update({ unit: v as AutoArchiveSettings["unit"] })
            }
          >
            <SelectTrigger className="w-24" id="auto-archive-unit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="hours">
                {t("autoArchive.unit.hours")}
              </SelectItem>
              <SelectItem value="days">{t("autoArchive.unit.days")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mt-4 border-t border-border pt-4">
        <ToggleRow
          id="auto-delete-enabled"
          label={t("autoDelete.enable.label")}
          description={t("autoDelete.enable.description")}
          checked={settings.deleteEnabled}
          onCheckedChange={(v) => update({ deleteEnabled: v })}
        />

        <div
          className={cn(
            "mt-4 flex items-center justify-between gap-4",
            !settings.deleteEnabled && "pointer-events-none opacity-50",
          )}
        >
          <div className="min-w-0 space-y-0.5">
            <Label htmlFor="auto-delete-value" className="font-medium">
              {t("autoDelete.threshold.label")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("autoDelete.threshold.description")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <NumberInput
              id="auto-delete-value"
              min={1}
              fallback={1}
              className="w-20"
              value={settings.deleteValue}
              onValueChange={(v) => update({ deleteValue: v })}
            />
            <Select
              value={settings.deleteUnit}
              onValueChange={(v) =>
                update({ deleteUnit: v as AutoArchiveSettings["unit"] })
              }
            >
              <SelectTrigger className="w-24" id="auto-delete-unit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="hours">
                  {t("autoArchive.unit.hours")}
                </SelectItem>
                <SelectItem value="days">
                  {t("autoArchive.unit.days")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ArchivedChatsSection({
  open,
  onConversationsChanged,
}: {
  open: boolean;
  onConversationsChanged?: (restored?: Conversation) => void;
}) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation("common");
  const [chats, setChats] = useState<Conversation[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const all = await api.listConversations(true);
      const archived = all
        .filter((c) => c.archivedAt != null)
        .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
      setChats(archived);
    } catch (e) {
      setError(String(e));
    }
  }

  // (Re)load whenever the page is opened, so the list is fresh each visit.
  useEffect(() => {
    if (open) load();
  }, [open]);

  // The auto-delete sweep purges rows out-of-band (including right after the
  // user lowers its threshold above); drop them live instead of waiting for
  // the next visit.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    onAppEvent((e) => {
      if (e.type === "conversation_deleted") {
        setChats((cs) => (cs ? cs.filter((x) => x.id !== e.id) : cs));
        onConversationsChanged?.();
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function restore(c: Conversation) {
    const originalIndex = chats?.findIndex((x) => x.id === c.id) ?? -1;
    setBusy(c.id);
    setError(null);
    // Restoring is the exact inverse of archive: local, reversible, and safe to
    // reflect immediately. Keep the row snapshot so a backend failure can put
    // it back without waiting for a full settings-page reload.
    setChats((cs) => (cs ? cs.filter((x) => x.id !== c.id) : cs));
    try {
      const restored = await api.archiveConversation(c.id, false);
      onConversationsChanged?.(restored);
    } catch (e) {
      setError(String(e));
      setChats((cs) => {
        if (!cs || cs.some((x) => x.id === c.id)) return cs;
        const insertionIndex = Math.min(Math.max(originalIndex, 0), cs.length);
        return [...cs.slice(0, insertionIndex), c, ...cs.slice(insertionIndex)];
      });
    } finally {
      setBusy(null);
    }
  }

  async function remove(c: Conversation) {
    setBusy(c.id);
    setError(null);
    try {
      await api.deleteConversation(c.id);
      setChats((cs) => (cs ? cs.filter((x) => x.id !== c.id) : cs));
      onConversationsChanged?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function deleteAll() {
    if (!chats?.length) return;
    setBusy("__all__");
    setError(null);
    try {
      await Promise.all(chats.map((c) => api.deleteConversation(c.id)));
      setChats([]);
      onConversationsChanged?.();
    } catch (e) {
      setError(String(e));
      // Reconcile against the backend — some may have been deleted.
      load();
    } finally {
      setBusy(null);
      setConfirmingAll(false);
    }
  }

  const count = chats?.length ?? 0;
  const deletingAll = busy === "__all__";

  return (
    <section>
      <SectionHeading
        title={t("archived.title")}
        description={t("archived.description")}
      />

      <AutoArchiveSettingsBlock />

      <div className="mt-6 flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          {chats === null
            ? t("archived.loading")
            : count === 0
              ? t("archived.empty")
              : count === 1
                ? t("archived.count.one", { count })
                : t("archived.count.other", { count })}
        </p>
        {count > 0 &&
          (confirmingAll ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {t("archived.deleteAllPrompt", { count })}
              </span>
              <Button
                size="sm"
                variant="destructive"
                onClick={deleteAll}
                disabled={deletingAll}
              >
                {deletingAll ? t("archived.deleting") : tc("action.confirm")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirmingAll(false)}
                disabled={deletingAll}
              >
                {tc("action.cancel")}
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 text-destructive hover:text-destructive"
              onClick={() => setConfirmingAll(true)}
            >
              <Trash2 className="size-3.5" />
              {t("archived.deleteAll")}
            </Button>
          ))}
      </div>

      {chats === null && <SettingsRowsSkeleton />}
      {count > 0 && (
        <div className="mt-4 divide-y divide-border rounded-lg border border-border">
          {chats!.map((c) => {
            const rowBusy = busy === c.id || deletingAll;
            return (
              <div
                key={c.id}
                className="flex items-center justify-between gap-3 px-3 py-2.5"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate text-sm font-medium">
                    {c.title || t("archived.untitled")}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {c.archivedAt
                      ? t("archived.archivedOn", {
                          date: new Date(c.archivedAt).toLocaleDateString(),
                        })
                      : null}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1.5"
                    onClick={() => restore(c)}
                    disabled={rowBusy}
                  >
                    <ArchiveRestore className="size-3.5" />
                    {t("archived.restore")}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => remove(c)}
                    disabled={rowBusy}
                    aria-label={t("archived.deleteAria")}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {error && <div className="mt-4 text-xs text-destructive">{error}</div>}
    </section>
  );
}
