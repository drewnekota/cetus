"use client";
/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
 * genre: modern-minimal · macrostructure: Workbench · designed-as-app */
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/tauri";
import type { SlashCommand } from "@/lib/types";
import { useTranslation } from "@/lib/i18n";

/** What the editor needs to prefill — the timestamps on a stored command are
 *  irrelevant here, so a menu row can be handed over directly. */
export type EditableSlashCommand = Pick<
  SlashCommand,
  "id" | "name" | "description" | "prompt"
>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The command being edited, or null to create a new one. */
  command?: EditableSlashCommand | null;
  /** Prefills the name field when creating — the token typed after `/`. */
  initialName?: string;
  /** Fired with the saved command, plus whether it was newly created. */
  onSaved?: (command: SlashCommand, created: boolean) => void;
}

/**
 * Create or edit a local slash command straight from the composer's slash menu,
 * so a reusable prompt can be captured or fixed at the moment it's wanted
 * instead of taking a detour into Settings. Same store as the Settings editor.
 */
export function SlashCommandDialog({
  open,
  onOpenChange,
  command,
  initialName,
  onSaved,
}: Props) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation("common");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset per opening; the dialog stays mounted across openings.
  useEffect(() => {
    if (!open) return;
    setName(command?.name ?? initialName ?? "");
    setDescription(command?.description ?? "");
    setPrompt(command?.prompt ?? "");
    setError(null);
    setSaving(false);
  }, [open, command, initialName]);

  const valid = name.trim().length > 0 && prompt.trim().length > 0;

  async function save() {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await api.upsertSlashCommand({
        id: command?.id,
        name: name.trim(),
        description: description.trim(),
        prompt,
      });
      onSaved?.(saved, !command);
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="w-[90vw] max-w-lg gap-0 p-0 sm:max-w-lg"
      >
        <div className="border-b border-border px-5 py-3">
          <DialogTitle className="text-sm font-medium">
            {command ? t("slashCmd.editor.editTitle") : t("slashCmd.editor.newTitle")}
          </DialogTitle>
        </div>

        <div className="space-y-2 p-4">
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
            rows={6}
            className="text-sm"
            // ⌘/Ctrl+⏎ saves — the composer habit carries over.
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void save();
              }
            }}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {tc("action.cancel")}
          </Button>
          <Button size="sm" onClick={save} disabled={!valid || saving}>
            {saving ? t("slashCmd.editor.saving") : t("slashCmd.editor.save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
