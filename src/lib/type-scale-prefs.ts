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

// ── Line height ─────────────────────────────────────────────────────────────
// One multiplier applied to every token's unitless line-height (the
// `--text-*--line-height` vars the `text-*` utilities read). Same persistence
// and pre-paint model as the font size above.

export const LINE_HEIGHT_STORAGE_KEY = "cetus.lineHeight";

export const DEFAULT_UI_LINE_HEIGHT = 1;
/** Multipliers over the ramp's authored line-heights. */
export const UI_LINE_HEIGHTS = [0.9, 1, 1.1, 1.2] as const;
export type UiLineHeight = (typeof UI_LINE_HEIGHTS)[number];

/** Token → unitless line-height at the default multiplier. Mirrors globals.css. */
export const LINE_HEIGHT_RAMP: Record<string, number> = {
  "--text-2xs--line-height": 1.4,
  "--text-xs--line-height": 1.35,
  "--text-md--line-height": 1.4,
  "--text-sm--line-height": 1.43,
  "--text-base--line-height": 1.5,
  "--text-lg--line-height": 1.5,
  "--text-xl--line-height": 1.4,
  "--text-2xl--line-height": 1.33,
};

export function isUiLineHeight(n: number): n is UiLineHeight {
  return (UI_LINE_HEIGHTS as readonly number[]).includes(n);
}

export function getUiLineHeight(): UiLineHeight {
  if (typeof window === "undefined") return DEFAULT_UI_LINE_HEIGHT;
  try {
    const n = Number(localStorage.getItem(LINE_HEIGHT_STORAGE_KEY));
    return isUiLineHeight(n) ? n : DEFAULT_UI_LINE_HEIGHT;
  } catch {
    return DEFAULT_UI_LINE_HEIGHT;
  }
}

export function setUiLineHeight(factor: UiLineHeight) {
  try {
    if (factor === DEFAULT_UI_LINE_HEIGHT) {
      localStorage.removeItem(LINE_HEIGHT_STORAGE_KEY);
    } else {
      localStorage.setItem(LINE_HEIGHT_STORAGE_KEY, String(factor));
    }
  } catch {
    // Private mode / quota: still apply for this session.
  }
  applyUiLineHeight(factor);
}

/** Writes (or clears, at the default factor) the scaled line-heights onto <html>. */
export function applyUiLineHeight(factor: UiLineHeight) {
  if (typeof document === "undefined") return;
  const html = document.documentElement;
  for (const [token, lh] of Object.entries(LINE_HEIGHT_RAMP)) {
    if (factor === 1) html.style.removeProperty(token);
    else html.style.setProperty(token, (lh * factor).toFixed(3));
  }
}

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
