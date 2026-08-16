// A/B switch for the permanent compositing layers (the `fade-layer` utility,
// the per-message actions row, and friends — see globals.css). Those
// `translateZ(0)` hacks fix subpixel hover jitter at fractional zoom, but each
// forces a long-lived IOSurface; the 2026-08-15 investigation measured the
// main webview's graphics memory ratcheting by hundreds of MB per hour of
// active use. This pref lets a build run with the layers off so footprint can
// be compared over real use before deciding what to keep.
//
// Stored in localStorage (presentation-only, per-machine) and applied by
// toggling `no-perma-layers` on <html>; globals.css neutralizes the transforms
// under that class.

export const LAYER_STORAGE_KEY = "cetus.permaLayers";
const ROOT_CLASS = "no-perma-layers";

/** Whether the permanent compositing layers are enabled (the default). */
export function getPermaLayersEnabled(): boolean {
  try {
    return localStorage.getItem(LAYER_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Toggle the root class to match `enabled`. */
export function applyPermaLayers(enabled: boolean) {
  document.documentElement.classList.toggle(ROOT_CLASS, !enabled);
}

/** Persist and apply in one step (Settings toggle). */
export function setPermaLayersEnabled(enabled: boolean) {
  try {
    localStorage.setItem(LAYER_STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // Ignore; the class still applies for this session.
  }
  applyPermaLayers(enabled);
}
