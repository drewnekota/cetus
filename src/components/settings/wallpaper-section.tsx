"use client";

import { useRef, useState } from "react";
import { ImagePlus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useTranslation } from "@/lib/i18n";
import { prepareWallpaper, saveWallpaper, saveWallpaperFade, useWallpaper } from "@/lib/wallpaper-prefs";

export function WallpaperSection() {
  const { t } = useTranslation("settings");
  const { image, fade, ready } = useWallpaper();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function upload(file: File) {
    setBusy(true);
    setError("");
    try { await saveWallpaper(await prepareWallpaper(file)); }
    catch { setError(t("appearance.wallpaper.uploadError")); }
    finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true);
    setError("");
    try { await saveWallpaper(null); }
    catch { setError(t("appearance.wallpaper.saveError")); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-0.5">
        <Label className="font-medium">{t("appearance.wallpaper.label")}</Label>
        <p className="text-xs text-muted-foreground">{t("appearance.wallpaper.description")}</p>
      </div>
      {image && (
        <div
          role="img"
          aria-label={t("appearance.wallpaper.preview")}
          className="flex h-36 items-center justify-center rounded-lg border border-border bg-background bg-cover bg-center"
          style={{ backgroundImage: `linear-gradient(color-mix(in srgb, var(--background) ${fade}%, transparent), color-mix(in srgb, var(--background) ${fade}%, transparent)), url("${image}")` }}
        >
          <span className="rounded-lg border border-border bg-card px-5 py-3 text-xs text-foreground">{t("appearance.wallpaper.preview")}</span>
        </div>
      )}
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        aria-label={t("appearance.wallpaper.upload")}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void upload(file);
        }}
      />
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={busy || !ready} onClick={() => input.current?.click()}>
          <ImagePlus className="size-3.5" />
          {t(busy ? "appearance.wallpaper.saving" : image ? "appearance.wallpaper.replace" : "appearance.wallpaper.upload")}
        </Button>
        {image && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void remove()}><Trash2 className="size-3.5" />{t("appearance.wallpaper.remove")}</Button>}
      </div>
      {image && (
        <div className="flex items-center gap-3">
          <Label htmlFor="wallpaper-fade" className="text-xs">{t("appearance.wallpaper.fade")}</Label>
          <input id="wallpaper-fade" type="range" min={0} max={95} step={5} value={fade} disabled={busy} className="h-1.5 w-40 cursor-pointer accent-primary" onChange={(event) => {
            try { saveWallpaperFade(Number(event.target.value)); setError(""); }
            catch { setError(t("appearance.wallpaper.saveError")); }
          }} />
          <span className="text-xs tabular-nums text-muted-foreground">{fade}%</span>
        </div>
      )}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
