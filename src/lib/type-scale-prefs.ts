// Type scale: one "UI font size" number (Codex desktop's `sansFontSize` model)
// from which every Tailwind text token derives. globals.css declares the ramp
// at the default size; any other size is applied as inline custom properties
// on <html>, which override the `:root` theme vars the `text-*` utilities read.
// Stored in localStorage and applied before first paint (see the no-FOUC script
// in layout.tsx — its ramp table must stay in sync with TYPE_RAMP below).

/** Shared with the pre-paint script in layout.tsx and the cross-window watcher. */
export const TYPE_SCALE_STORAGE_KEY = "cetus.fontSize";

/** The size the ramp in globals.css is authored at (the `text-sm` UI size). */
export const DEFAULT_UI_FONT_SIZE = 14;
export const UI_FONT_SIZES = [12, 13, 14, 15, 16] as const;
export type UiFontSize = (typeof UI_FONT_SIZES)[number];

/** Token → px at the default UI size. Mirrors the `@theme` block in globals.css. */
export const TYPE_RAMP: Record<string, number> = {
  "--text-2xs": 11,
  "--text-xs": 12,
  "--text-md": 13,
  "--text-sm": 14,
  "--text-base": 15,
  "--text-lg": 18,
  "--text-xl": 20,
  "--text-2xl": 24,
};

export function isUiFontSize(n: number): n is UiFontSize {
  return (UI_FONT_SIZES as readonly number[]).includes(n);
}

export function getUiFontSize(): UiFontSize {
  if (typeof window === "undefined") return DEFAULT_UI_FONT_SIZE;
  try {
    const n = Number(localStorage.getItem(TYPE_SCALE_STORAGE_KEY));
    return isUiFontSize(n) ? n : DEFAULT_UI_FONT_SIZE;
  } catch {
    return DEFAULT_UI_FONT_SIZE;
  }
}

export function setUiFontSize(size: UiFontSize) {
  try {
    if (size === DEFAULT_UI_FONT_SIZE) {
      localStorage.removeItem(TYPE_SCALE_STORAGE_KEY);
    } else {
      localStorage.setItem(TYPE_SCALE_STORAGE_KEY, String(size));
    }
  } catch {
    // Private mode / quota: still apply for this session.
  }
  applyUiFontSize(size);
}

/** Writes (or clears, at the default size) the scaled ramp onto <html>. */
export function applyUiFontSize(size: UiFontSize) {
  if (typeof document === "undefined") return;
  const html = document.documentElement;
  const ratio = size / DEFAULT_UI_FONT_SIZE;
  for (const [token, px] of Object.entries(TYPE_RAMP)) {
    if (ratio === 1) html.style.removeProperty(token);
    else html.style.setProperty(token, `${Math.round(px * ratio)}px`);
  }
}
