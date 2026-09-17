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
import { Textarea } from "@/components/ui/textarea";
import { useTranslation } from "@/lib/i18n";
import { api } from "@/lib/tauri";
import type { SlashCommand } from "@/lib/types";
import {
  SectionHeading,
  SettingsRowsSkeleton,
  SettingsList,
} from "../settings-controls";

// =============================================================================
// Slash commands (local prompt snippets)
// =============================================================================

/** Manage user-defined slash commands — reusable prompt snippets triggered by
 *  typing `/<name>` in the composer. Stored locally; they sit alongside skills in
 *  the composer's slash menu (distinct icon). Create/edit/delete here. */
export function SlashCommandsSection({ open }: { open: boolean }) {
  const { t } = useTranslation("settings");
  const [commands, setCommands] = useState<SlashCommand[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null = closed; "new" = creating; a command = editing it.
  const [editing, setEditing] = useState<SlashCommand | "new" | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setCommands(await api.listSlashCommands());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  async function removeRow(id: string) {
    setCommands((cs) => (cs ? cs.filter((c) => c.id !== id) : cs));
    setError(null);
    try {
      await api.deleteSlashCommand(id);
    } catch (e) {
      setError(String(e));
      load();
    }
  }

  const sorted = useMemo(
    () => [...(commands ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [commands],
  );

  return (
    <section>
      <SectionHeading
        title={t("slashCmd.title")}
        description={t("slashCmd.description")}
      />

      <div className="mt-6">
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={() => setEditing("new")}
        >
          <Plus className="size-3.5" />
          {t("slashCmd.new")}
        </Button>
      </div>

      {editing && (
        <SlashCommandEditor
          command={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
          onError={setError}
        />
      )}

      <div className="mt-6">
        <h3 className="text-xs font-medium text-muted-foreground">
          {commands === null
            ? t("slashCmd.loading")
            : sorted.length === 0
              ? t("slashCmd.empty")
              : sorted.length === 1
                ? t("slashCmd.count.one", { count: sorted.length })
                : t("slashCmd.count.other", { count: sorted.length })}
        </h3>

        {commands === null && <SettingsRowsSkeleton />}
        {sorted.length > 0 && (
          <SettingsList className="mt-3">
            {sorted.map((c) => (
              <SlashCommandRow
                key={c.id}
                command={c}
                onEdit={() => setEditing(c)}
                onDelete={removeRow}
              />
            ))}
          </SettingsList>
        )}
      </div>

      {error && <div className="mt-4 text-xs text-destructive">{error}</div>}
    </section>
  );
}

function SlashCommandRow({
  command,
  onEdit,
  onDelete,
}: {
  command: SlashCommand;
  onEdit: () => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation("common");
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="group min-w-0 px-4 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="truncate text-sm font-medium">/{command.name}</p>
          {command.description && (
            <p className="text-xs leading-snug text-muted-foreground">
              {command.description}
            </p>
          )}
          <p className="line-clamp-2 whitespace-pre-wrap break-words font-mono text-xs leading-snug text-muted-foreground/80">
            {command.prompt}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            size="icon"
            variant="ghost"
            className="size-8 text-muted-foreground"
            onClick={onEdit}
            aria-label={t("slashCmd.editAria")}
          >
            <Pencil className="size-3.5" />
          </Button>
          {confirming ? (
            <>
              <Button
                size="sm"
                variant="destructive"
                className="h-8"
                onClick={() => onDelete(command.id)}
              >
                {t("slashCmd.delete")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 text-muted-foreground"
                onClick={() => setConfirming(false)}
              >
                {tc("action.cancel")}
              </Button>
            </>
          ) : (
            <Button
              size="icon"
              variant="ghost"
              className="size-8 text-muted-foreground hover:text-destructive"
              onClick={() => setConfirming(true)}
              aria-label={t("slashCmd.deleteAria")}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function SlashCommandEditor({
  command,
  onCancel,
  onSaved,
  onError,
}: {
  command: SlashCommand | null;
  onCancel: () => void;
  onSaved: () => void;
  onError: (e: string) => void;
}) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation("common");
  const [name, setName] = useState(command?.name ?? "");
  const [description, setDescription] = useState(command?.description ?? "");
  const [prompt, setPrompt] = useState(command?.prompt ?? "");
  const [saving, setSaving] = useState(false);

  const valid = name.trim().length > 0 && prompt.trim().length > 0;

  async function save() {
    if (!valid) return;
    setSaving(true);
    try {
      await api.upsertSlashCommand({
        id: command?.id,
        name: name.trim(),
        description: description.trim(),
        prompt,
      });
      onSaved();
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-4 space-y-2 rounded-lg border border-border bg-muted/30 p-3">
      <Label className="text-xs font-medium text-muted-foreground">
        {command
          ? t("slashCmd.editor.editTitle")
          : t("slashCmd.editor.newTitle")}
      </Label>
      <div className="flex items-center gap-1.5 rounded-md border border-border bg-background pl-2.5">
        <span className="text-sm text-muted-foreground">/</span>
        <Input
          placeholder={t("slashCmd.editor.namePlaceholder")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          className="border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
        />
      </div>
      <Input
        placeholder={t("slashCmd.editor.descPlaceholder")}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <Textarea
        placeholder={t("slashCmd.editor.promptPlaceholder")}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={5}
        className="text-sm"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={!valid || saving}>
          {saving ? t("slashCmd.editor.saving") : t("slashCmd.editor.save")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onCancel}
          disabled={saving}
        >
          {tc("action.cancel")}
        </Button>
      </div>
    </div>
  );
}
