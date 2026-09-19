"use client";

/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
 * genre: modern-minimal · macrostructure: Workbench · designed-as-app */
// Full-window settings screen. Renders over the whole app (sidebar included)
// as a dedicated page rather than a modal dialog, with a left section rail and
// a scrollable content pane. Opened from the sidebar, the command palette, or
// ⌘, ; closed with Back or Esc.
import { useEffect, useState } from "react";
import { Cloud, Copy, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useTranslation } from "@/lib/i18n";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { SectionHeading, ToggleRow } from "../settings-controls";

export function RemoteSection() {
  const { t } = useTranslation("settings");
  const [remote, setRemote] = useState<Awaited<
    ReturnType<typeof api.getRemoteSettings>
  > | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .getRemoteSettings()
      .then(setRemote)
      .catch(() => {});
  }, []);

  async function toggle(enabled: boolean) {
    setBusy(true);
    try {
      setRemote(await api.setRemoteEnabled(enabled));
    } finally {
      setBusy(false);
    }
  }

  async function toggleKeepAwake(enabled: boolean) {
    setBusy(true);
    try {
      setRemote(await api.setRemoteKeepAwake(enabled));
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    setBusy(true);
    try {
      setRemote(await api.rotateRemoteAccess());
    } finally {
      setBusy(false);
    }
  }

  async function copyUrl() {
    if (!remote) return;
    await navigator.clipboard.writeText(remote.pairingUrl);
  }

  return (
    <section>
      <SectionHeading
        title={t("remote.title")}
        description={t("remote.description")}
      />
      <div className="mt-6 overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between gap-5 p-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
              <Cloud className="size-4" />
            </div>
            <div>
              <Label htmlFor="remote-access" className="font-medium">
                {t("remote.enable")}
              </Label>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {t("remote.enableDescription")}
              </p>
            </div>
          </div>
          <Switch
            id="remote-access"
            checked={remote?.enabled ?? false}
            disabled={!remote || busy}
            onCheckedChange={toggle}
          />
        </div>
        {remote?.enabled ? (
          <div className="border-t border-border bg-muted/15 p-4">
            <div className="grid gap-5 sm:grid-cols-[180px_1fr]">
              {/* The generated SVG carries its own intrinsic size (≥256px), which
                  overflows this 180px column and used to get cropped by the
                  clip. Scale it to the column instead — the viewBox keeps it
                  square — and hug the top rather than stretching to the row. */}
              <div
                className="w-full max-w-[180px] self-start overflow-hidden rounded-xl bg-white p-3 [&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
                dangerouslySetInnerHTML={{ __html: remote.pairingQrSvg }}
              />
              <div className="min-w-0 space-y-4">
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span
                      className={cn(
                        "size-2 rounded-full",
                        remote.tailscaleReady
                          ? "bg-emerald-500"
                          : "bg-amber-500",
                      )}
                    />
                    {remote.tailscaleReady
                      ? t("remote.ready")
                      : t("remote.localOnly")}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {remote.tailscaleMessage}
                  </p>
                </div>
                <div className="rounded-lg border border-border bg-background p-3">
                  <p className="truncate font-mono text-xs text-foreground/80">
                    {remote.accessUrl}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {t("remote.scanHint")}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {t("remote.phoneRequirement")}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-amber-600 dark:text-amber-500">
                    {t("remote.proxyHint")}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={copyUrl}
                  >
                    <Copy className="size-3.5" />
                    {t("remote.copy")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1.5 text-muted-foreground"
                    disabled={busy}
                    onClick={rotate}
                  >
                    <KeyRound className="size-3.5" />
                    {t("remote.rotate")}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
      <div className="mt-2">
        <ToggleRow
          id="remote-keep-awake"
          label={t("remote.keepAwake.label")}
          description={t("remote.keepAwake.description")}
          checked={remote?.keepAwake ?? false}
          disabled={!remote || busy}
          onCheckedChange={toggleKeepAwake}
        />
      </div>
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        {t("remote.security")}
      </p>
    </section>
  );
}
