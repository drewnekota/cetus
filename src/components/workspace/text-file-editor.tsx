"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import { api } from "@/lib/tauri";

// Keep unsaved buffers across file selection and panel/tab remounts. Contents
// (including .env secrets) stay in memory, never in browser storage.
type Buffer = { text: string; original: string };
const drafts = new Map<string, Buffer>();
const pendingSaves = new Set<string>();
const listeners = new Map<string, Set<(buffer: Buffer) => void>>();
function updateBuffer(key: string, buffer: Buffer) {
  if (buffer.text === buffer.original && !pendingSaves.has(key)) drafts.delete(key);
  else drafts.set(key, buffer);
  listeners.get(key)?.forEach((listener) => listener(buffer));
}

export function TextFileEditor({ workspaceDir, path, text }: {
  workspaceDir: string;
  path: string;
  text: string;
}) {
  const { t } = useTranslation("chat");
  const key = JSON.stringify([workspaceDir, path]);
  const [buffer, setBuffer] = useState(() => drafts.get(key) ?? { text, original: text });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const savingRef = useRef(false);
  const dirty = buffer.text !== buffer.original;
  useEffect(() => {
    const subscribers = listeners.get(key) ?? new Set();
    subscribers.add(setBuffer);
    listeners.set(key, subscribers);
    return () => {
      subscribers.delete(setBuffer);
      if (!subscribers.size) listeners.delete(key);
    };
  }, [key]);

  async function reload() {
    if (savingRef.current || pendingSaves.has(key)) return;
    if (dirty && !window.confirm(t("workspacePanel.confirmReload"))) return;
    savingRef.current = true;
    setSaving(true);
    setReloading(true);
    setError(null);
    try {
      const value = await api.readWorkspaceTextFile(workspaceDir, path);
      if (value.truncated) throw new Error(t("workspacePanel.tooLargeToEdit"));
      updateBuffer(key, { text: value.text, original: value.text });
    } catch (error) {
      setError(String(error));
    } finally {
      savingRef.current = false;
      setSaving(false);
      setReloading(false);
    }
  }

  async function save() {
    if (!dirty || savingRef.current || pendingSaves.has(key)) return;
    pendingSaves.add(key);
    savingRef.current = true;
    setSaving(true);
    setError(null);
    const submitted = buffer;
    try {
      await api.writeWorkspaceTextFile(workspaceDir, path, submitted.text, submitted.original);
      // Typing and switching files remain possible during the write.
      const current = drafts.get(key) ?? submitted;
      const next = { text: current.text, original: submitted.text };
      updateBuffer(key, next);
    } catch (error) {
      setError(String(error));
    } finally {
      pendingSaves.delete(key);
      const current = drafts.get(key);
      if (current?.text === current?.original) drafts.delete(key);
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={(event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        event.stopPropagation();
        void save();
      }
    }}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1">
        <span className="flex-1 text-2xs text-muted-foreground">
          {dirty ? t("workspacePanel.unsaved") : t("workspacePanel.saved")}
        </span>
        <Button size="xs" variant="ghost" disabled={saving} onClick={() => void reload()}>
          {t("workspacePanel.reload")}
        </Button>
        <Button size="xs" variant="ghost" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? t("workspacePanel.saving") : t("workspacePanel.save")}
        </Button>
      </div>
      {error && <p role="alert" className="shrink-0 px-3 py-2 text-xs text-destructive">{error}</p>}
      <textarea
        aria-label={t("workspacePanel.editFile", { path })}
        data-testid="workspace-text-editor"
        className="min-h-0 flex-1 resize-none overflow-auto bg-background px-4 py-3 font-mono text-xs leading-relaxed text-foreground outline-none"
        readOnly={reloading}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        value={buffer.text}
        onChange={(event) => {
          const next = { ...buffer, text: event.target.value };
          // HTML textareas normalize CRLF. Retain the file's original convention.
          if (buffer.original.includes("\r\n")) next.text = next.text.replace(/\r?\n/g, "\r\n");
          updateBuffer(key, next);
        }}
      />
    </div>
  );
}
