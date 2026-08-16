"use client";
import { useEffect } from "react";
import {
  THEME_STORAGE_KEY,
  applyTheme,
  getThemePreference,
} from "@/lib/theme-prefs";
import {
  LAYER_STORAGE_KEY,
  applyPermaLayers,
  getPermaLayersEnabled,
} from "@/lib/layer-prefs";

/** Keeps the main window's `.dark` class in sync with the saved theme after the
 *  initial pre-paint apply: re-applies on OS-appearance changes (only matters
 *  while following the system) and on cross-window preference changes — the
 *  Settings page writes localStorage, which fires a `storage` event in every
 *  other same-origin window. Mounted only in the main window; the frameless
 *  launcher / voice HUD overlays stay dark by design. */
export function ThemeWatcher() {
  useEffect(() => {
    applyTheme(getThemePreference());
    // Same lifecycle as the theme: apply the persisted compositing-layer A/B
    // choice on mount and follow cross-window changes below. Logged (console
    // forwards into the log files) so the periodic "webview memory" series
    // in the same files carries which arm of the A/B it was measured under.
    const layersOn = getPermaLayersEnabled();
    applyPermaLayers(layersOn);
    console.info(`[layer-ab] permanent compositing layers: ${layersOn ? "on" : "off"}`);

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystem = () => {
      if (getThemePreference() === "system") applyTheme("system");
    };
    const onStorage = (e: StorageEvent) => {
      // key is null when storage is cleared wholesale.
      if (e.key === null || e.key === THEME_STORAGE_KEY) {
        applyTheme(getThemePreference());
      }
      if (e.key === null || e.key === LAYER_STORAGE_KEY) {
        applyPermaLayers(getPermaLayersEnabled());
      }
    };
    mq.addEventListener("change", onSystem);
    window.addEventListener("storage", onStorage);
    return () => {
      mq.removeEventListener("change", onSystem);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return null;
}
