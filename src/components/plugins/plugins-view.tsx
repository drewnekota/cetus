"use client";

import { useCallback, useEffect, useState } from "react";
import { Blocks, ExternalLink, FolderOpen, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/tauri";
import { useTranslation } from "@/lib/i18n";
import type { PluginEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

export function PluginsView() {
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
    load();
  }, [load]);

  async function toggle(id: string, enabled: boolean) {
    setPlugins((list) =>
      list?.map((p) => (p.id === id ? { ...p, enabled } : p)) ?? null,
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h1 className="text-base font-semibold">{t("plugins.title")}</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("plugins.description")}
          </p>
        </div>
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

      <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <SurfaceGuide />

        {error && (
          <p className="mb-4 mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        {!plugins ? (
          <div className="mt-4 grid min-w-0 gap-3 lg:grid-cols-2">
            <Skeleton className="h-32 w-full rounded-md" />
            <Skeleton className="h-32 w-full rounded-md" />
          </div>
        ) : plugins.length === 0 ? (
          <div className="mt-4 flex h-64 flex-col items-center justify-center rounded-md border border-border text-center">
            <Blocks className="mb-3 size-8 text-muted-foreground" />
            <p className="text-sm font-medium">{t("plugins.empty")}</p>
          </div>
        ) : (
          <div className="mt-4 grid min-w-0 gap-3 lg:grid-cols-2">
            {plugins.map((plugin) => (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                busy={busy}
                labels={{
                  builtIn: t("plugins.source.builtIn"),
                  user: t("plugins.source.user"),
                  openFolder: t("plugins.openFolder"),
                  delete: t("plugins.delete"),
                }}
                onToggle={toggle}
                onDelete={deletePlugin}
                onError={setError}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SurfaceGuide() {
  const { t } = useTranslation("settings");
  const rows = [
    ["@Computer", t("plugins.surface.computer")],
    ["@Browser", t("plugins.surface.browser")],
  ];
  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5">
      <p className="text-xs font-medium">{t("plugins.surface.title")}</p>
      <div className="mt-2 grid gap-2 md:grid-cols-3">
        {rows.map(([name, desc]) => (
          <div key={name} className="min-w-0">
            <p className="font-mono text-[11px] font-medium">{name}</p>
            <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
              {desc}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function PluginCard({
  plugin,
  busy,
  labels,
  onToggle,
  onDelete,
  onError,
}: {
  plugin: PluginEntry;
  busy: boolean;
  labels: {
    builtIn: string;
    user: string;
    openFolder: string;
    delete: string;
  };
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (plugin: PluginEntry) => void;
  onError: (error: string) => void;
}) {
  const contributions = [
    ...plugin.mcpServers.map((name) => `MCP: ${name}`),
    ...plugin.apps.map((path) => `App: ${fileName(path)}`),
    ...plugin.extensions.map((path) => `Extension: ${fileName(path)}`),
    ...plugin.nativeCapabilities,
    ...plugin.interfaceCapabilities,
  ];

  return (
    <article
      className={cn(
        "min-w-0 overflow-hidden rounded-md border border-border bg-card px-4 py-3",
        !plugin.enabled && "opacity-70",
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="min-w-0 truncate text-sm font-medium">
              {plugin.displayName}
            </h2>
            <Badge>{plugin.builtIn ? labels.builtIn : labels.user}</Badge>
            {plugin.riskLevel && <Badge>{plugin.riskLevel}</Badge>}
          </div>
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
          onCheckedChange={(v) => onToggle(plugin.id, v)}
          disabled={!plugin.configurable || busy}
          aria-label={plugin.displayName}
        />
      </div>

      {contributions.length > 0 && (
        <div className="mt-3 flex min-w-0 flex-wrap gap-1.5">
          {contributions.map((label) => (
            <Badge key={label}>{label}</Badge>
          ))}
        </div>
      )}

      <div className="mt-3 flex min-w-0 flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
          {plugin.id}
        </p>
        <div className="flex max-w-full flex-wrap items-center justify-end gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 px-2"
            onClick={() => api.revealPlugin(plugin.id).catch((e) => onError(String(e)))}
          >
            <ExternalLink className="size-3.5" />
            {labels.openFolder}
          </Button>
          {!plugin.builtIn && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              onClick={() => onDelete(plugin)}
              disabled={busy}
              aria-label={labels.delete}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
      {children}
    </span>
  );
}

function fileName(path: string) {
  return path.split("/").pop() || path;
}
