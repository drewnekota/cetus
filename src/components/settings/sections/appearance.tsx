"use client";

/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
 * genre: modern-minimal · macrostructure: Workbench · designed-as-app */
// Full-window settings screen. Renders over the whole app (sidebar included)
// as a dedicated page rather than a modal dialog, with a left section rail and
// a scrollable content pane. Opened from the sidebar, the command palette, or
// ⌘, ; closed with Back or Esc.
import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DEFAULT_THEME,
  THEME_OPTIONS,
  getThemePreference,
  setThemePreference,
  type ThemePreference,
} from "@/lib/theme-prefs";
import {
  getPermaLayersEnabled,
  setPermaLayersEnabled,
} from "@/lib/layer-prefs";
import { WallpaperSection } from "@/components/settings/wallpaper-section";
import { SkinSection } from "@/components/settings/skin-section";
import {
  DEFAULT_UI_FONT_SIZE,
  DEFAULT_UI_LINE_HEIGHT,
  UI_FONT_SIZES,
  UI_LINE_HEIGHTS,
  getUiFontSize,
  getUiLineHeight,
  setUiFontSize,
  setUiLineHeight,
  type UiFontSize,
  type UiLineHeight,
} from "@/lib/type-scale-prefs";
import { useTranslation } from "@/lib/i18n";
import { SectionHeading } from "../settings-controls";

// =============================================================================
// Appearance (theme)
// =============================================================================

const LINE_HEIGHT_LABEL_KEYS = {
  0.9: "appearance.lineHeight.compact",
  1: "appearance.lineHeight.default",
  1.1: "appearance.lineHeight.relaxed",
  1.2: "appearance.lineHeight.loose",
} as const satisfies Record<UiLineHeight, string>;

export function AppearanceSection() {
  const [theme, setThemeState] = useState<ThemePreference>(DEFAULT_THEME);
  const [permaLayers, setPermaLayers] = useState(true);
  const [fontSize, setFontSize] = useState<UiFontSize>(DEFAULT_UI_FONT_SIZE);
  const [lineHeight, setLineHeight] = useState<UiLineHeight>(
    DEFAULT_UI_LINE_HEIGHT,
  );
  const { t } = useTranslation("settings");

  // Reflect the persisted choice once we're in the browser (localStorage).
  useEffect(() => {
    setThemeState(getThemePreference());
    setPermaLayers(getPermaLayersEnabled());
    setFontSize(getUiFontSize());
    setLineHeight(getUiLineHeight());
  }, []);

  function chooseTheme(pref: ThemePreference) {
    setThemePreference(pref); // persists + toggles `.dark` live
    setThemeState(pref);
  }

  return (
    <section>
      <SectionHeading
        title={t("appearance.title")}
        description={t("appearance.description")}
      />

      <div className="mt-6 space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <Label className="font-medium">{t("appearance.theme.label")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("appearance.theme.description")}
            </p>
          </div>
          <Select
            value={theme}
            onValueChange={(v) => chooseTheme(v as ThemePreference)}
          >
            <SelectTrigger className="w-52 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THEME_OPTIONS.map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <Label className="font-medium">
              {t("appearance.fontSize.label")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("appearance.fontSize.description")}
            </p>
          </div>
          <Select
            value={String(fontSize)}
            onValueChange={(v) => {
              const n = Number(v) as UiFontSize;
              setUiFontSize(n); // persists + rewrites the ramp on <html> live
              setFontSize(n);
            }}
          >
            <SelectTrigger className="w-52 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {UI_FONT_SIZES.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n === DEFAULT_UI_FONT_SIZE
                    ? t("appearance.fontSize.default", { size: n })
                    : t("appearance.fontSize.option", { size: n })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <Label className="font-medium">
              {t("appearance.lineHeight.label")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("appearance.lineHeight.description")}
            </p>
          </div>
          <Select
            value={String(lineHeight)}
            onValueChange={(v) => {
              const n = Number(v) as UiLineHeight;
              setUiLineHeight(n); // persists + rewrites the line-heights on <html> live
              setLineHeight(n);
            }}
          >
            <SelectTrigger className="w-52 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {UI_LINE_HEIGHTS.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {t(LINE_HEIGHT_LABEL_KEYS[n])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <Label htmlFor="perma-layers" className="font-medium">
              {t("appearance.permaLayers.label")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("appearance.permaLayers.description")}
            </p>
          </div>
          <Switch
            id="perma-layers"
            checked={permaLayers}
            onCheckedChange={(v) => {
              setPermaLayersEnabled(v); // persists + applies the root class live
              setPermaLayers(v);
            }}
          />
        </div>

        <WallpaperSection />
        <SkinSection />
      </div>
    </section>
  );
}
