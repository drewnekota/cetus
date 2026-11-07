"use client";

/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
 * genre: modern-minimal · macrostructure: Workbench · designed-as-app */
// Full-window settings screen. Renders over the whole app (sidebar included)
// as a dedicated page rather than a modal dialog, with a left section rail and
// a scrollable content pane. Opened from the sidebar, the command palette, or
// ⌘, ; closed with Back or Esc.
import { useEffect, useState } from "react";
import { ChevronRight, Cloud, Copy, KeyRound, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useTranslation } from "@/lib/i18n";
import { api } from "@/lib/api";
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

  // While it's on, keep the relay status, device list and the one-time QR
  // fresh — the code rotates as soon as a phone pairs with it.
  const enabled = remote?.enabled ?? false;
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      api
        .getRemoteSettings()
        .then(setRemote)
        .catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [enabled]);

  async function revoke(id: string) {
    setBusy(true);
    try {
      setRemote(await api.revokeRemoteDevice(id));
    } finally {
      setBusy(false);
    }
  }

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
          <div className="space-y-5 border-t border-border bg-muted/15 p-4">
            <div className="grid gap-5 sm:grid-cols-[180px_1fr]">
              {/* The generated SVG carries its own intrinsic size (≥256px);
                  scale it to the column (the viewBox keeps it square). */}
              <div
                className="w-full max-w-[180px] self-start overflow-hidden rounded-xl bg-white p-3 [&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
                dangerouslySetInnerHTML={{ __html: remote.appPairingQrSvg }}
              />
              <div className="min-w-0 space-y-3">
                <div className="text-sm font-medium">{t("remote.app.title")}</div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      remote.relay.connected
                        ? "bg-emerald-500"
                        : remote.relay.error
                          ? "bg-destructive"
                          : "bg-amber-500",
                    )}
                  />
                  <span className="truncate">
                    {remote.relay.connected
                      ? t("remote.relay.connected")
                      : remote.relay.error
                        ? t("remote.relay.error", { error: remote.relay.error })
                        : t("remote.relay.connecting")}
                  </span>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("remote.app.hint")}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() =>
                    void navigator.clipboard.writeText(remote.appPairingLink)
                  }
                >
                  <Copy className="size-3.5" />
                  {t("remote.app.copy")}
                </Button>
              </div>
            </div>

            <div>
              <div className="mb-2 text-xs font-medium text-muted-foreground">
                {t("remote.devices.title")}
              </div>
              {remote.devices.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("remote.devices.empty")}
                </p>
              ) : (
                <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-background">
                  {remote.devices.map((d) => (
                    <div key={d.id} className="flex items-center gap-3 px-3 py-2">
                      <Smartphone className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">{d.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {d.online ? (
                            <span className="text-emerald-600 dark:text-emerald-500">
                              {t("remote.devices.online")}
                            </span>
                          ) : (
                            t("remote.devices.lastSeen", {
                              when: new Date(d.lastSeenAt).toLocaleString(),
                            })
                          )}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive"
                        disabled={busy}
                        onClick={() => void revoke(d.id)}
                      >
                        {t("remote.devices.revoke")}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* The original browser companion over Tailscale stays available
                for anyone without the app. */}
            <details className="group rounded-lg border border-border bg-background">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-xs font-medium text-muted-foreground">
                <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
                {t("remote.browser.title")}
              </summary>
              <div className="space-y-3 border-t border-border p-3">
                <div className="grid gap-4 sm:grid-cols-[120px_1fr]">
                  <div
                    className="w-full max-w-[120px] self-start overflow-hidden rounded-lg bg-white p-2 [&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
                    dangerouslySetInnerHTML={{ __html: remote.pairingQrSvg }}
                  />
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex items-center gap-2 text-xs font-medium">
                      <span
                        className={cn(
                          "size-2 rounded-full",
                          remote.tailscaleReady ? "bg-emerald-500" : "bg-amber-500",
                        )}
                      />
                      {remote.tailscaleReady ? t("remote.ready") : t("remote.localOnly")}
                    </div>
                    <p className="truncate font-mono text-xs text-foreground/80">
                      {remote.accessUrl}
                    </p>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {t("remote.phoneRequirement")}
                    </p>
                    <p className="text-xs leading-relaxed text-amber-600 dark:text-amber-500">
                      {t("remote.proxyHint")}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" className="gap-1.5" onClick={copyUrl}>
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
            </details>
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
