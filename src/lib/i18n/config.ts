// Language preference: follow the OS locale, or lock to a specific language.
// Stored in localStorage (a pure presentation pref, like theme/fonts — see
// theme-prefs.ts) under `cetus.locale`. Unlike theme there's no pre-paint script:
// the text-bearing app tree only mounts client-side (WindowRouter returns null
// until it resolves the window label), so the I18nProvider can read the saved
// preference synchronously without a hydration mismatch.

/** Languages Cetus ships. English is the source of truth / fallback. All are
 *  left-to-right; RTL languages (Arabic, Hebrew) would need layout work first. */
export type Locale =
  | "en"
  | "zh"
  | "ja"
  | "ko"
  | "es"
  | "pt"
  | "fr"
  | "de"
  | "it"
  | "ru";

/** What the user picks: a concrete language, or "system" to follow the OS. */
export type LocalePreference = "system" | Locale;

// Order shown in the picker: English first, then by rough global reach.
export const LOCALES: Locale[] = [
  "en",
  "zh",
  "ja",
  "ko",
  "es",
  "pt",
  "fr",
  "de",
  "it",
  "ru",
];

export const DEFAULT_LOCALE: Locale = "en";
export const DEFAULT_LOCALE_PREFERENCE: LocalePreference = "system";

/** Shared with the I18nProvider's cross-window `storage` listener. */
export const LOCALE_STORAGE_KEY = "cetus.locale";

/** Native name of each language, shown in the picker (never translated). */
export const LOCALE_NATIVE_NAMES: Record<Locale, string> = {
  en: "English",
  zh: "简体中文",
  ja: "日本語",
  ko: "한국어",
  es: "Español",
  pt: "Português",
  fr: "Français",
  de: "Deutsch",
  it: "Italiano",
  ru: "Русский",
};

const KNOWN: Locale[] = LOCALES;

/** Best-effort map of the OS/browser locale to one of ours. Region variants
 *  collapse to the base language (e.g. pt-BR → pt, zh-* → Simplified zh). */
export function detectSystemLocale(): Locale {
  try {
    const langs =
      navigator.languages && navigator.languages.length
        ? navigator.languages
        : [navigator.language];
    for (const raw of langs) {
      const tag = (raw || "").toLowerCase();
      if (tag.startsWith("zh")) return "zh";
      const base = tag.split("-")[0] as Locale;
      if (KNOWN.includes(base)) return base;
    }
  } catch {
    /* navigator unavailable */
  }
  return DEFAULT_LOCALE;
}

/** The persisted preference (falls back to "system"). */
export function getLocalePreference(): LocalePreference {
  try {
    const v = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (v === "system") return v;
    if (v && (LOCALES as string[]).includes(v)) return v as Locale;
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_LOCALE_PREFERENCE;
}

/** Resolve a preference to the concrete language to render. */
export function resolveLocale(pref: LocalePreference): Locale {
  return pref === "system" ? detectSystemLocale() : pref;
}

/** Persist a preference. The provider applies it live; this only writes. */
export function setLocalePreference(pref: LocalePreference) {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, pref);
  } catch {
    /* storage unavailable — caller still applies for this session */
  }
}
