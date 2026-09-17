"use client";

/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
 * genre: modern-minimal · macrostructure: Workbench · designed-as-app */
// Full-window settings screen. Renders over the whole app (sidebar included)
// as a dedicated page rather than a modal dialog, with a left section rail and
// a scrollable content pane. Opened from the sidebar, the command palette, or
// ⌘, ; closed with Back or Esc.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useTranslation } from "@/lib/i18n";
import { api, onPiEvent } from "@/lib/tauri";
import type { MemoryEntry, MemoryState } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  SectionHeading,
  ToggleRow,
  SettingsRowsSkeleton,
  SettingsList,
} from "../settings-controls";

// =============================================================================
// Memory
// =============================================================================

export function MemorySection({ open }: { open: boolean }) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation("common");
  const [store, setStore] = useState<MemoryState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [draftCategory, setDraftCategory] = useState("");
  const [adding, setAdding] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);

  const load = useCallback(async () => {
    try {
      setStore(await api.listMemories());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // (Re)load whenever the page is opened so edits made elsewhere are fresh.
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  // Live-refresh when memory changes underneath us: the agent's manage_memory
  // tool (rides the pi event stream), which emits a dedicated
  // app-event, since it writes memory.json directly without a pi tool call).
  useEffect(() => {
    const unlisten: Array<() => void> = [];
    let cancelled = false;
    const track = (p: Promise<() => void>) =>
      p.then((fn) => {
        if (cancelled) fn();
        else unlisten.push(fn);
      });
    track(
      onPiEvent((e) => {
        if (
          e.type === "tool_execution_end" &&
          e.toolName === "manage_memory" &&
          !e.isError
        ) {
          load();
        }
      }),
    );
    return () => {
      cancelled = true;
      unlisten.forEach((fn) => fn());
    };
  }, [load]);

  async function toggleMaster(v: boolean) {
    setStore((s) => (s ? { ...s, enabled: v } : s));
    setError(null);
    try {
      await api.setMemoryEnabled(v);
    } catch (e) {
      setError(String(e));
      load();
    }
  }

  async function add() {
    const content = draft.trim();
    if (!content) return;
    setAdding(true);
    setError(null);
    try {
      await api.createMemory(content, draftCategory.trim() || null);
      setDraft("");
      setDraftCategory("");
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  }

  async function saveRow(id: string, content: string, category: string) {
    setError(null);
    try {
      await api.updateMemory(id, { content, category });
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function toggleRow(id: string, enabled: boolean) {
    // Optimistic flip so the switch feels instant.
    setStore((s) =>
      s
        ? {
            ...s,
            entries: s.entries.map((m) =>
              m.id === id ? { ...m, enabled } : m,
            ),
          }
        : s,
    );
    setError(null);
    try {
      await api.updateMemory(id, { enabled });
    } catch (e) {
      setError(String(e));
      load();
    }
  }

  async function removeRow(id: string) {
    setStore((s) =>
      s ? { ...s, entries: s.entries.filter((m) => m.id !== id) } : s,
    );
    setError(null);
    try {
      await api.deleteMemory(id);
    } catch (e) {
      setError(String(e));
      load();
    }
  }

  async function clearAll() {
    setError(null);
    try {
      await api.clearMemories();
      setStore((s) => (s ? { ...s, entries: [] } : s));
    } catch (e) {
      setError(String(e));
      load();
    } finally {
      setConfirmingClear(false);
    }
  }

  // Newest first — most recently touched memories at the top.
  const sorted = useMemo(
    () => [...(store?.entries ?? [])].sort((a, b) => b.updatedAt - a.updatedAt),
    [store?.entries],
  );
  const masterOn = store?.enabled ?? true;

  return (
    <section>
      <SectionHeading
        title={t("memory.title")}
        description={t("memory.description")}
      />

      <div className="mt-6 space-y-1">
        <ToggleRow
          id="memory-enabled"
          label={t("memory.enable.label")}
          description={t("memory.enable.description")}
          checked={masterOn}
          onCheckedChange={toggleMaster}
        />
      </div>

      {/* Add a memory */}
      <div
        className={cn(
          "mt-4 space-y-2 rounded-lg border border-border p-3",
          !masterOn && "opacity-60",
        )}
      >
        <Label
          htmlFor="memory-add"
          className="text-xs font-medium text-muted-foreground"
        >
          {t("memory.add.label")}
        </Label>
        <Textarea
          id="memory-add"
          placeholder={t("memory.add.placeholder")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <div className="flex items-center gap-2">
          <Input
            placeholder={t("memory.category.placeholder")}
            value={draftCategory}
            onChange={(e) => setDraftCategory(e.target.value)}
            className="h-8 flex-1 text-sm"
          />
          <Button
            size="sm"
            className="gap-1.5"
            onClick={add}
            disabled={!draft.trim() || adding}
          >
            <Plus className="size-3.5" />
            {adding ? t("memory.adding") : t("memory.add.button")}
          </Button>
        </div>
      </div>

      {/* Existing memories */}
      <div className="mt-6 flex items-center justify-between gap-4">
        <h3 className="text-xs font-medium text-muted-foreground">
          {store === null
            ? t("memory.loading")
            : sorted.length === 0
              ? t("memory.empty")
              : sorted.length === 1
                ? t("memory.count.one", { count: sorted.length })
                : t("memory.count.other", { count: sorted.length })}
        </h3>
        {sorted.length > 0 &&
          (confirmingClear ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {t("memory.deleteAllPrompt")}
              </span>
              <Button size="sm" variant="destructive" onClick={clearAll}>
                {tc("action.confirm")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirmingClear(false)}
              >
                {tc("action.cancel")}
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 text-destructive hover:text-destructive"
              onClick={() => setConfirmingClear(true)}
            >
              <Trash2 className="size-3.5" />
              {t("memory.clearAll")}
            </Button>
          ))}
      </div>

      {store === null && <SettingsRowsSkeleton />}
      {sorted.length > 0 && (
        <SettingsList className="mt-3">
          {sorted.map((m) => (
            <MemoryRow
              key={m.id}
              entry={m}
              onSave={saveRow}
              onToggle={toggleRow}
              onDelete={removeRow}
            />
          ))}
        </SettingsList>
      )}

      {error && <div className="mt-4 text-xs text-destructive">{error}</div>}
    </section>
  );
}

function MemoryRow({
  entry,
  onSave,
  onToggle,
  onDelete,
}: {
  entry: MemoryEntry;
  onSave: (id: string, content: string, category: string) => Promise<void>;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation("common");
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(entry.content);
  const [category, setCategory] = useState(entry.category ?? "");
  const [busy, setBusy] = useState(false);

  // Re-sync buffers when the entry changes underneath us (live refresh), but
  // never clobber an in-progress edit.
  useEffect(() => {
    if (!editing) {
      setContent(entry.content);
      setCategory(entry.category ?? "");
    }
  }, [entry, editing]);

  async function save() {
    const c = content.trim();
    if (!c) return;
    setBusy(true);
    await onSave(entry.id, c, category.trim());
    setBusy(false);
    setEditing(false);
  }

  function cancel() {
    setContent(entry.content);
    setCategory(entry.category ?? "");
    setEditing(false);
  }

  const agentAuthored = entry.source === "agent";

  if (editing) {
    return (
      <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={2}
          autoFocus
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              cancel();
            }
          }}
        />
        <div className="flex items-center gap-2">
          <Input
            placeholder={t("memory.category.placeholder")}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="h-8 flex-1 text-sm"
          />
          <Button size="sm" onClick={save} disabled={!content.trim() || busy}>
            {busy ? t("memory.saving") : t("memory.save")}
          </Button>
          <Button size="sm" variant="outline" onClick={cancel} disabled={busy}>
            {tc("action.cancel")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn("group min-w-0 px-4 py-3", !entry.enabled && "opacity-50")}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="break-words text-sm leading-snug">{entry.content}</p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span
              className={cn(
                "rounded px-1.5 py-0.5 font-medium",
                agentAuthored
                  ? "bg-skill/10 text-skill dark:text-skill"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {agentAuthored ? t("memory.tag.agent") : t("memory.tag.you")}
            </span>
            {entry.category && (
              <span className="rounded bg-muted px-1.5 py-0.5">
                {entry.category}
              </span>
            )}
            <span>
              {t("memory.editedOn", {
                date: new Date(entry.updatedAt).toLocaleDateString(),
              })}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Switch
            checked={entry.enabled}
            onCheckedChange={(v) => onToggle(entry.id, v)}
            aria-label={
              entry.enabled ? t("memory.muteAria") : t("memory.enableAria")
            }
          />
          <Button
            size="icon"
            variant="ghost"
            className="size-8 text-muted-foreground"
            onClick={() => setEditing(true)}
            aria-label={t("memory.editAria")}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-8 text-muted-foreground hover:text-destructive"
            onClick={() => onDelete(entry.id)}
            aria-label={t("memory.deleteAria")}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
