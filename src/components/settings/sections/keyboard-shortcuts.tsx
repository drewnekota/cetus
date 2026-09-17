"use client";

/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
 * genre: modern-minimal · macrostructure: Workbench · designed-as-app */
// Full-window settings screen. Renders over the whole app (sidebar included)
// as a dedicated page rather than a modal dialog, with a left section rail and
// a scrollable content pane. Opened from the sidebar, the command palette, or
// ⌘, ; closed with Back or Esc.
import { useMemo, useState } from "react";
import { RotateCw } from "lucide-react";
import {
  BACKENDS,
  runtimePresetLabel,
  useRuntimeSlots,
} from "@/components/chat/backend-picker";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import { HotkeyRecorder } from "../hotkey-recorder";
import {
  RUNTIME_SLOT_SHORTCUT_IDS,
  SHORTCUT_DEFINITIONS,
  defaultShortcutMap,
  readKeyboardShortcuts,
  resetKeyboardShortcuts,
  shortcutDisplay,
  writeKeyboardShortcuts,
  type ShortcutId,
  type ShortcutMap,
} from "@/lib/keyboard-shortcuts";
import { SectionHeading } from "../settings-controls";

// =============================================================================
// Keyboard shortcuts
// =============================================================================

export function KeyboardShortcutsSection() {
  const { t } = useTranslation("settings");
  const [query, setQuery] = useState("");
  const [shortcuts, setShortcuts] = useState<ShortcutMap>(
    readKeyboardShortcuts,
  );
  const defaults = defaultShortcutMap();
  // The runtime slots are positional, so spell out who currently occupies each
  // one instead of leaving the user to count rows in the Runtimes page.
  const runtimeSlots = useRuntimeSlots();
  const slotDescription = (id: ShortcutId): string | null => {
    const slot = RUNTIME_SLOT_SHORTCUT_IDS.indexOf(
      id as (typeof RUNTIME_SLOT_SHORTCUT_IDS)[number],
    );
    if (slot < 0) return null;
    const entry = runtimeSlots[slot];
    if (!entry) return t("keyboard.runtimeSlot.empty");
    const label =
      entry.kind === "preset"
        ? runtimePresetLabel(entry.preset)
        : (BACKENDS.find((runtime) => runtime.id === entry.id)?.label ??
          entry.id);
    return t("keyboard.runtimeSlot.current", { runtime: label });
  };

  const conflictById = useMemo(() => {
    const byAccelerator = new Map<string, ShortcutId[]>();
    for (const def of SHORTCUT_DEFINITIONS) {
      const value = shortcuts[def.id];
      if (!value) continue;
      byAccelerator.set(value, [...(byAccelerator.get(value) ?? []), def.id]);
    }
    const conflicts = new Map<ShortcutId, ShortcutId[]>();
    for (const ids of byAccelerator.values()) {
      if (ids.length < 2) continue;
      for (const id of ids)
        conflicts.set(
          id,
          ids.filter((other) => other !== id),
        );
    }
    return conflicts;
  }, [shortcuts]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SHORTCUT_DEFINITIONS;
    return SHORTCUT_DEFINITIONS.filter((shortcut) => {
      const haystack =
        `${shortcut.label} ${shortcut.description} ${shortcutDisplay(
          shortcuts[shortcut.id],
        )}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [query, shortcuts]);

  function save(next: ShortcutMap) {
    setShortcuts(next);
    writeKeyboardShortcuts(next);
  }

  function update(id: ShortcutId, accelerator: string) {
    save({ ...shortcuts, [id]: accelerator });
  }

  function resetOne(id: ShortcutId) {
    update(id, defaults[id]);
  }

  function resetAll() {
    const next = defaultShortcutMap();
    setShortcuts(next);
    resetKeyboardShortcuts();
  }

  return (
    <section>
      <SectionHeading
        title={t("keyboard.title")}
        description={t("keyboard.description")}
      />

      <div className="mt-6 flex items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("keyboard.search")}
          className="max-w-sm bg-background"
        />
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={resetAll}
        >
          <RotateCw className="size-3.5" />
          {t("keyboard.resetAll")}
        </Button>
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border border-border bg-background">
        <div className="grid grid-cols-[minmax(0,1fr)_18rem] border-b border-border bg-muted/30 px-4 py-2 text-xs font-medium text-muted-foreground">
          <span>{t("keyboard.column.command")}</span>
          <span>{t("keyboard.column.keybinding")}</span>
        </div>
        {filtered.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            {t("keyboard.empty")}
          </p>
        ) : (
          filtered.map((shortcut) => {
            const value = shortcuts[shortcut.id];
            const conflictIds = conflictById.get(shortcut.id) ?? [];
            const conflictText = conflictIds
              .map(
                (id) =>
                  SHORTCUT_DEFINITIONS.find((def) => def.id === id)?.label,
              )
              .filter(Boolean)
              .join(", ");
            return (
              <div
                key={shortcut.id}
                className="grid grid-cols-[minmax(0,1fr)_18rem] items-center gap-4 border-b border-border px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {shortcut.label}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {slotDescription(shortcut.id) ?? shortcut.description}
                  </p>
                  {conflictText && (
                    <p className="mt-1 text-xs text-destructive">
                      {t("keyboard.conflict", { commands: conflictText })}
                    </p>
                  )}
                </div>
                <div className="flex min-w-0 items-center justify-end gap-1.5">
                  <HotkeyRecorder
                    value={value}
                    onChange={(v) => update(shortcut.id, v)}
                    placeholder={t("keyboard.unassigned")}
                    recordingLabel={t("launcher.summon.recording")}
                    clearLabel={t("keyboard.clear")}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground"
                    title={t("keyboard.reset")}
                    aria-label={t("keyboard.reset")}
                    disabled={value === defaults[shortcut.id]}
                    onClick={() => resetOne(shortcut.id)}
                  >
                    <RotateCw className="size-3.5" />
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
