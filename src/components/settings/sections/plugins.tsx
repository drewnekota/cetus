"use client";

/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
 * genre: modern-minimal · macrostructure: Workbench · designed-as-app */
// Full-window settings screen. Renders over the whole app (sidebar included)
// as a dedicated page rather than a modal dialog, with a left section rail and
// a scrollable content pane. Opened from the sidebar, the command palette, or
// ⌘, ; closed with Back or Esc.
import { useCallback, useEffect, useState } from "react";
import { Blocks, ExternalLink, FolderOpen, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslation } from "@/lib/i18n";
import { api } from "@/lib/tauri";
import type { PluginEntry } from "@/lib/types";
import { cn } from "@/lib/utils";
import { SectionHeading } from "../settings-controls";

// =============================================================================
// Shared bits
// =============================================================================

export function PluginsSection({ open }: { open: boolean }) {
  const { t } = useTranslation("settings");
  const [plugins, setPlugins] = useState<PluginEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setPlugins(await api.listPlugins());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  async function toggle(id: string, enabled: boolean) {
    setPlugins(
      (list) => list?.map((p) => (p.id === id ? { ...p, enabled } : p)) ?? null,
    );
    try {
      await api.setPluginEnabled(id, enabled);
      await load();
    } catch (e) {
      setError(String(e));
      load();
    }
  }

  async function importFolder() {
    setError(null);
    let path: string | null = null;
    try {
      path = await api.pickWorkspaceDir();
    } catch (e) {
      setError(String(e));
      return;
    }
    if (!path) return;
    setBusy(true);
    try {
      await api.importPlugin(path);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function deletePlugin(plugin: PluginEntry) {
    if (plugin.builtIn) return;
    if (!window.confirm(t("plugins.deleteConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      await api.deletePlugin(plugin.id);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const surfaceRows = [
    ["@Computer", t("plugins.surface.computer")],
    ["@Browser", t("plugins.surface.browser")],
  ];

  return (
    <section>
      <SectionHeading
        title={t("plugins.title")}
        description={t("plugins.description")}
      />

      <div className="mt-4">
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={importFolder}
          disabled={busy}
        >
          <FolderOpen className="size-3.5" />
          {busy ? t("plugins.importing") : t("plugins.import")}
        </Button>
      </div>

      <div className="mt-4 rounded-md border border-border bg-muted/30 px-3 py-2.5">
        <p className="text-xs font-medium">{t("plugins.surface.title")}</p>
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          {surfaceRows.map(([name, desc]) => (
            <div key={name} className="min-w-0">
              <p className="font-mono text-xs font-medium">{name}</p>
              <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                {desc}
              </p>
            </div>
          ))}
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {!plugins ? (
        <div className="mt-4 space-y-3">
          <Skeleton className="h-28 w-full rounded-md" />
          <Skeleton className="h-28 w-full rounded-md" />
        </div>
      ) : plugins.length === 0 ? (
        <div className="mt-4 flex h-48 flex-col items-center justify-center rounded-md border border-border text-center">
          <Blocks className="mb-3 size-8 text-muted-foreground" />
          <p className="text-sm font-medium">{t("plugins.empty")}</p>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {plugins.map((plugin) => (
            <article
              key={plugin.id}
              className={cn(
                "min-w-0 overflow-hidden rounded-md border border-border bg-card px-4 py-3",
                !plugin.enabled && "opacity-70",
              )}
            >
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="min-w-0 truncate text-sm font-medium">
                    {plugin.displayName}
                  </h3>
                  <p className="mt-1 line-clamp-3 break-words text-xs leading-snug text-muted-foreground">
                    {plugin.description || plugin.id}
                  </p>
                  {!plugin.available && plugin.unavailableReason && (
                    <p className="mt-2 rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-xs text-warning">
                      {plugin.unavailableReason}
                    </p>
                  )}
                </div>
                <Switch
                  checked={plugin.enabled}
                  onCheckedChange={(v) => toggle(plugin.id, v)}
                  disabled={!plugin.configurable || busy}
                  aria-label={plugin.displayName}
                />
              </div>

              <div className="mt-3 flex min-w-0 flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                  {plugin.id}
                </p>
                <div className="flex max-w-full flex-wrap items-center justify-end gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1.5 px-2"
                    onClick={() =>
                      api
                        .revealPlugin(plugin.id)
                        .catch((e) => setError(String(e)))
                    }
                  >
                    <ExternalLink className="size-3.5" />
                    {t("plugins.openFolder")}
                  </Button>
                  {!plugin.builtIn && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => deletePlugin(plugin)}
                      disabled={busy}
                      aria-label={t("plugins.delete")}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
