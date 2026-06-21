// Color theme: follow the system, or lock to light / dark. Stored in
// localStorage (a pure presentation pref that must apply before paint — see the
// no-FOUC script in layout.tsx) and applied by toggling the `.dark` class on
// <html> (globals.css swaps the design-token vars off that class).

import { api } from "@/lib/tauri";

export type ThemePreference = "system" | "light" | "dark";

export interface ThemeOption {
  id: ThemePreference;
  label: string;
}

export const THEME_OPTIONS: ThemeOption[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

export const DEFAULT_THEME: ThemePreference = "system";
/** Shared with the pre-paint script in layout.tsx and the cross-window watcher. */
export const THEME_STORAGE_KEY = "cetus.theme";

/** The persisted preference (falls back to "system"). */
export function getThemePreference(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_THEME;
}

export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return true; // cetus shipped dark-only first — keep that as the safe default
  }
}

/** Resolve a preference to the concrete mode to paint. */
export function resolveTheme(pref: ThemePreference): "light" | "dark" {
  return pref === "system" ? (systemPrefersDark() ? "dark" : "light") : pref;
}

/** Run `toggle` with all CSS transitions suppressed for that one repaint.
 *
 * A theme change swaps every design token at once. Without this, every element
 * carrying a `transition-colors` (buttons, every sidebar row, cards…) animates
 * its color over ~150ms simultaneously — and since each is now a translucent
 * layer over the window's vibrancy, the browser recomposites the whole glass
 * stack every frame for the duration. That's the jank. We disable transitions,
 * flip the class, force a synchronous style flush so the new tokens paint with
 * transitions still off, then restore them on the next tick (so hover states
 * keep animating). Same technique as next-themes' `disableTransitionOnChange`. */
function withTransitionsDisabled(toggle: () => void) {
  const override = document.createElement("style");
  override.appendChild(
    document.createTextNode("*,*::before,*::after{transition:none !important}"),
  );
  document.head.appendChild(override);
  toggle();
  // Reading a computed style forces a synchronous style recalc, committing the
  // token swap while transitions are still off.
  void window.getComputedStyle(document.documentElement).opacity;
  // Re-enable transitions once the repaint is committed. The colors aren't
  // changing at this point, so nothing animates.
  window.setTimeout(() => override.remove(), 0);
}

function forceThemeRepaint() {
  const root = document.documentElement;
  root.classList.add("theme-repaint");
  // Touch layout while the repaint class is present, then leave it on for one
  // paint. This prods WebKit to invalidate transparent form-control layers that
  // can otherwise keep their old light/dark backing until an external repaint
  // event, such as taking a screenshot.
  void root.offsetHeight;
  requestAnimationFrame(() => {
    void root.offsetHeight;
    requestAnimationFrame(() => root.classList.remove("theme-repaint"));
  });
}

/** Toggle the `.dark` class to match a preference (this window). */
export function applyTheme(pref: ThemePreference) {
  const dark = resolveTheme(pref) === "dark";
  withTransitionsDisabled(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  });
  forceThemeRepaint();
  // Match the native window vibrancy (app-wide on macOS) to the theme. The raw
  // preference is passed so "system" hands control back to the OS — keeping the
  // frosted glass behind every window correct even when a locked theme differs
  // from the system appearance. Best-effort; fire-and-forget.
  api.setThemeAppearance(pref).catch(() => {});
}

/** Persist + apply a preference immediately (this window). */
export function setThemePreference(pref: ThemePreference) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    /* storage unavailable — still apply for this session */
  }
  applyTheme(pref);
}
