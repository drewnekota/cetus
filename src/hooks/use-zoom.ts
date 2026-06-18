"use client";
import { useEffect } from "react";

const KEY = "cetus:zoom";
/** Emitted with the new zoom level (e.g. 1.25) whenever ⌘+/⌘−/⌘0 fires. */
export const ZOOM_EVENT = "cetus:zoom";

// The standard browser zoom ladder (matches Chrome/Safari): steps widen as you
// go, so it's 90 → 100 → 110 → 125 → 150 rather than a flat +10 each press.
const LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const MIN = LEVELS[0];
const MAX = LEVELS[LEVELS.length - 1];

function apply(z: number) {
  // Prefer the webview's *native* zoom: it scales like real browser zoom, so
  // viewport units and getBoundingClientRect stay consistent and Radix/
  // floating-ui popovers (Select, dropdowns, tooltips) anchor correctly.
  //
  // The CSS `zoom` property — what we used before — is NOT understood by
  // floating-ui: the trigger's rect comes back pre-scaled while the portaled
  // content (in <body>, also zoomed) re-applies the scale, so panels drift away
  // from their trigger proportionally to the zoom level.
  void import("@tauri-apps/api/webview")
    .then(({ getCurrentWebview }) => getCurrentWebview().setZoom(z))
    .catch(() => {
      // Browser / non-Tauri fallback (e.g. plain dev server): CSS zoom is the
      // only lever available. Popovers may drift here, but the desktop app uses
      // the native path above.
      document.documentElement.style.setProperty("zoom", String(z));
      document.documentElement.style.setProperty("--zoom", String(z));
    });
}

function clamp(z: number) {
  return Math.min(MAX, Math.max(MIN, Math.round(z * 100) / 100));
}

/** Next ladder rung strictly above `z` (or the max if already at/above top). */
function stepUp(z: number) {
  return LEVELS.find((l) => l > z + 1e-6) ?? MAX;
}

/** Next ladder rung strictly below `z` (or the min if already at/below bottom). */
function stepDown(z: number) {
  return [...LEVELS].reverse().find((l) => l < z - 1e-6) ?? MIN;
}

/** Cmd/Ctrl + (=/+/-/0) zooms the whole webview content. Persisted to localStorage. */
export function useZoom() {
  useEffect(() => {
    const initial = clamp(Number(localStorage.getItem(KEY)) || 1);
    apply(initial);

    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      let next: number | null = null;
      const current = clamp(Number(localStorage.getItem(KEY)) || 1);
      if (e.key === "=" || e.key === "+") next = stepUp(current);
      else if (e.key === "-" || e.key === "_") next = stepDown(current);
      else if (e.key === "0") next = 1;
      if (next == null) return;
      e.preventDefault();
      localStorage.setItem(KEY, String(next));
      apply(next);
      // Let the transient HUD (ZoomHud) show the new level as a percentage.
      window.dispatchEvent(new CustomEvent(ZOOM_EVENT, { detail: next }));
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
