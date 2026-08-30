// Skin: a handful of seed colors per light/dark variant from which every design
// token in globals.css derives (neutrals are `ink` mixed into `surface`, scaled
// by `contrast`). Same model as the Codex desktop app's "chrome theme": instead
// of editing dozens of tokens, the user picks a preset or tweaks ~6 colors and
// the whole UI follows. Stored in localStorage (must apply before first paint —
// see the no-FOUC script in layout.tsx) and applied as inline custom properties
// on <html>, which override both the `:root` and `.dark` token blocks.

export type SkinVariant = "light" | "dark";

export interface SkinSeeds {
  /** Window / page background. `#rrggbb`. */
  surface: string;
  /** Primary text color; neutrals are mixes of ink into surface. */
  ink: string;
  /** Brand accent: primary buttons, focus rings, links. */
  accent: string;
  /** 0–100. 50 = stock spacing between surface and neutrals; higher = crisper
   *  borders / stronger hover lifts, lower = softer. */
  contrast: number;
  diffAdded: string;
  diffRemoved: string;
  skill: string;
}

export interface SkinPreset {
  id: string;
  name: string;
  light: SkinSeeds;
  dark: SkinSeeds;
}

/** What we persist: a base preset plus resolved seeds for both variants. Seeds
 *  are stored fully resolved so the pre-paint script can apply them without
 *  knowing about presets. */
export interface SkinPreference {
  presetId: string;
  light: SkinSeeds;
  dark: SkinSeeds;
}

/** Shared with the pre-paint script in layout.tsx and the cross-window watcher. */
export const SKIN_STORAGE_KEY = "cetus.skin";
export const DEFAULT_SKIN_ID = "cetus";

const CODEX_LIGHT_SEMANTIC = {
  diffAdded: "#00a240",
  diffRemoved: "#ba2623",
  skill: "#924ff7",
};
const CODEX_DARK_SEMANTIC = {
  diffAdded: "#40c977",
  diffRemoved: "#fa423e",
  skill: "#ad7bf9",
};

/** Built-in templates. Values mirror the vendor's own brand seeds where the
 *  source is public (Linear, Vercel, Raycast, Xcode, Codex), otherwise ours. */
export const SKIN_PRESETS: SkinPreset[] = [
  {
    id: "cetus",
    name: "Cetus",
    light: {
      surface: "#fcfcfd",
      ink: "#1b1b1b",
      accent: "#827be6",
      contrast: 50,
      diffAdded: "#52a450",
      diffRemoved: "#c94446",
      skill: "#8160d8",
    },
    dark: {
      surface: "#0f0f11",
      ink: "#e3e4e6",
      accent: "#827be6",
      contrast: 50,
      diffAdded: "#69c967",
      diffRemoved: "#ff7e78",
      skill: "#c2a1ff",
    },
  },
  {
    id: "codex",
    name: "Codex",
    light: {
      surface: "#ffffff",
      ink: "#1a1c1f",
      accent: "#339cff",
      contrast: 50,
      ...CODEX_LIGHT_SEMANTIC,
    },
    dark: {
      surface: "#181818",
      ink: "#ffffff",
      accent: "#339cff",
      contrast: 50,
      ...CODEX_DARK_SEMANTIC,
    },
  },
  {
    id: "linear",
    name: "Linear",
    light: {
      surface: "#fcfcfd",
      ink: "#1b1b1b",
      accent: "#5e6ad2",
      contrast: 45,
      diffAdded: "#52a450",
      diffRemoved: "#c94446",
      skill: "#8160d8",
    },
    dark: {
      surface: "#0f0f11",
      ink: "#e3e4e6",
      accent: "#606acc",
      contrast: 50,
      diffAdded: "#69c967",
      diffRemoved: "#ff7e78",
      skill: "#c2a1ff",
    },
  },
  {
    id: "vercel",
    name: "Vercel",
    light: {
      surface: "#ffffff",
      ink: "#171717",
      accent: "#006aff",
      contrast: 45,
      diffAdded: "#28a948",
      diffRemoved: "#eb001d",
      skill: "#a100f8",
    },
    dark: {
      surface: "#000000",
      ink: "#ededed",
      accent: "#006efe",
      contrast: 40,
      diffAdded: "#00ad3a",
      diffRemoved: "#f13342",
      skill: "#9540d5",
    },
  },
  {
    id: "raycast",
    name: "Raycast",
    light: {
      surface: "#ffffff",
      ink: "#030303",
      accent: "#ff6363",
      contrast: 50,
      ...CODEX_LIGHT_SEMANTIC,
    },
    dark: {
      surface: "#101010",
      ink: "#fefefe",
      accent: "#ff6363",
      contrast: 50,
      ...CODEX_DARK_SEMANTIC,
    },
  },
  {
    id: "xcode",
    name: "Xcode",
    light: {
      surface: "#ffffff",
      ink: "#000000",
      accent: "#0e0eff",
      contrast: 50,
      ...CODEX_LIGHT_SEMANTIC,
    },
    dark: {
      surface: "#1f1f24",
      ink: "#dddde0",
      accent: "#5482ff",
      contrast: 50,
      ...CODEX_DARK_SEMANTIC,
    },
  },
  {
    id: "paper",
    name: "Paper",
    light: {
      surface: "#f5f3ed",
      ink: "#2a2622",
      accent: "#b5573a",
      contrast: 55,
      diffAdded: "#4f8a3c",
      diffRemoved: "#b8433a",
      skill: "#7b5ea7",
    },
    dark: {
      surface: "#1c1a17",
      ink: "#e8e2d6",
      accent: "#d9825f",
      contrast: 55,
      diffAdded: "#8fc27a",
      diffRemoved: "#ef8a7e",
      skill: "#c4a6f0",
    },
  },
  {
    id: "mono",
    name: "Mono",
    light: {
      surface: "#ffffff",
      ink: "#000000",
      accent: "#000000",
      contrast: 60,
      diffAdded: "#2e7d32",
      diffRemoved: "#c62828",
      skill: "#555555",
    },
    dark: {
      surface: "#000000",
      ink: "#ffffff",
      accent: "#ffffff",
      contrast: 60,
      diffAdded: "#81c784",
      diffRemoved: "#ef9a9a",
      skill: "#bbbbbb",
    },
  },
];

export const SEED_COLOR_KEYS = [
  "surface",
  "ink",
  "accent",
  "diffAdded",
  "diffRemoved",
  "skill",
] as const satisfies readonly (keyof SkinSeeds)[];
export type SeedColorKey = (typeof SEED_COLOR_KEYS)[number];

/** Seed → CSS custom property it feeds. Mirrored in the layout.tsx pre-paint
 *  script; keep the two in sync. */
const SEED_CSS_VAR: Record<SeedColorKey, string> = {
  surface: "--surface",
  ink: "--ink",
  accent: "--brand",
  diffAdded: "--diff-added",
  diffRemoved: "--diff-removed",
  skill: "--skill",
};
const CONTRAST_CSS_VAR = "--contrast";
const ON_ACCENT_CSS_VAR = "--on-accent";

export function getSkinPreset(id: string): SkinPreset {
  return (
    SKIN_PRESETS.find((p) => p.id === id) ??
    SKIN_PRESETS.find((p) => p.id === DEFAULT_SKIN_ID) ??
    SKIN_PRESETS[0]
  );
}

export function defaultSkinPreference(): SkinPreference {
  const p = getSkinPreset(DEFAULT_SKIN_ID);
  return { presetId: p.id, light: { ...p.light }, dark: { ...p.dark } };
}

const HEX_RE = /^#[0-9a-f]{6}$/;

/** Accept `#rgb`, `#rrggbb`, `#rrggbbaa` (alpha dropped), any case → `#rrggbb`. */
export function normalizeHex(input: string | undefined | null): string | null {
  if (typeof input !== "string") return null;
  let v = input.trim().toLowerCase();
  if (!v.startsWith("#")) v = `#${v}`;
  if (/^#[0-9a-f]{3}$/.test(v)) {
    v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  } else if (/^#[0-9a-f]{8}$/.test(v)) {
    v = v.slice(0, 7);
  }
  return HEX_RE.test(v) ? v : null;
}

export function clampContrast(n: unknown, fallback: number): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(100, Math.max(0, Math.round(v)));
}

function sanitizeSeeds(raw: unknown, fallback: SkinSeeds): SkinSeeds {
  const r = (raw ?? {}) as Partial<Record<keyof SkinSeeds, unknown>>;
  const out: SkinSeeds = { ...fallback };
  for (const key of SEED_COLOR_KEYS) {
    const hex = normalizeHex(r[key] as string | undefined);
    if (hex) out[key] = hex;
  }
  out.contrast = clampContrast(r.contrast, fallback.contrast);
  return out;
}

/** The persisted skin, sanitized (falls back to the Cetus preset). */
export function getSkinPreference(): SkinPreference {
  const def = defaultSkinPreference();
  try {
    const raw = localStorage.getItem(SKIN_STORAGE_KEY);
    if (!raw) return def;
    const parsed = JSON.parse(raw) as Partial<SkinPreference>;
    const preset = getSkinPreset(
      typeof parsed.presetId === "string" ? parsed.presetId : DEFAULT_SKIN_ID,
    );
    return {
      presetId: preset.id,
      light: sanitizeSeeds(parsed.light, preset.light),
      dark: sanitizeSeeds(parsed.dark, preset.dark),
    };
  } catch {
    return def;
  }
}

export function seedsEqual(a: SkinSeeds, b: SkinSeeds): boolean {
  return (
    a.contrast === b.contrast &&
    SEED_COLOR_KEYS.every((k) => a[k] === b[k])
  );
}

/** True when the skin is the untouched Cetus default (nothing to override). */
export function isDefaultSkin(pref: SkinPreference): boolean {
  const def = defaultSkinPreference();
  return (
    pref.presetId === def.presetId &&
    seedsEqual(pref.light, def.light) &&
    seedsEqual(pref.dark, def.dark)
  );
}

/** True when either variant deviates from its base preset. */
export function isCustomized(pref: SkinPreference): boolean {
  const p = getSkinPreset(pref.presetId);
  return !seedsEqual(pref.light, p.light) || !seedsEqual(pref.dark, p.dark);
}

// --- luminance → text-on-accent ---------------------------------------------

function channel(c: number): number {
  const t = c / 255;
  return t <= 0.04045 ? t / 12.92 : ((t + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a `#rrggbb`. */
export function relativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return channel(r) * 0.2126 + channel(g) * 0.7152 + channel(b) * 0.0722;
}

/** Black or white text on a given accent. Same threshold Codex uses. Mirrored
 *  in the layout.tsx pre-paint script. */
export function textOnAccent(accentHex: string): "#000000" | "#ffffff" {
  return relativeLuminance(accentHex) > 0.179 ? "#000000" : "#ffffff";
}

// --- apply -------------------------------------------------------------------

/** Write one variant's seeds as inline custom properties on <html>. Passing the
 *  default skin clears them so the stylesheet's own values take over. */
export function applySkin(pref: SkinPreference, variant: SkinVariant) {
  const style = document.documentElement.style;
  const vars = [
    ...Object.values(SEED_CSS_VAR),
    CONTRAST_CSS_VAR,
    ON_ACCENT_CSS_VAR,
  ];
  if (isDefaultSkin(pref)) {
    for (const v of vars) style.removeProperty(v);
    return;
  }
  const seeds = pref[variant];
  for (const key of SEED_COLOR_KEYS) {
    style.setProperty(SEED_CSS_VAR[key], seeds[key]);
  }
  style.setProperty(CONTRAST_CSS_VAR, String(seeds.contrast));
  style.setProperty(ON_ACCENT_CSS_VAR, textOnAccent(seeds.accent));
}

/** Persist a skin. Applying is left to the caller (theme-prefs knows the
 *  resolved variant); cross-window sync rides the `storage` event. */
export function saveSkinPreference(pref: SkinPreference) {
  try {
    if (isDefaultSkin(pref)) localStorage.removeItem(SKIN_STORAGE_KEY);
    else localStorage.setItem(SKIN_STORAGE_KEY, JSON.stringify(pref));
  } catch {
    /* storage unavailable — still applies for this session */
  }
}

/** Snapshot a preset into a preference (drops any customizations). */
export function skinFromPreset(id: string): SkinPreference {
  const p = getSkinPreset(id);
  return { presetId: p.id, light: { ...p.light }, dark: { ...p.dark } };
}
