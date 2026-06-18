"use client";
// App-wide translation context. Holds the active language preference, exposes a
// namespaced `t()` to read strings, and `setPreference()` to switch live. A
// language change re-renders the whole tree instantly (no reload) and is mirrored
// to every other window via the `storage` event — the same cross-window sync the
// theme uses (see theme-watcher.tsx).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  DEFAULT_LOCALE,
  DEFAULT_LOCALE_PREFERENCE,
  LOCALE_STORAGE_KEY,
  type Locale,
  type LocalePreference,
  getLocalePreference,
  resolveLocale,
  setLocalePreference,
} from "./config";
import { MESSAGES, type Namespace } from "./messages";
import { api } from "@/lib/tauri";

interface I18nContextValue {
  /** The concrete language being rendered (preference resolved against the OS). */
  locale: Locale;
  /** The raw saved preference ("system" | a language). */
  preference: LocalePreference;
  /** Persist + apply a new preference live, across all windows. */
  setPreference: (pref: LocalePreference) => void;
  /** Look up a key within a namespace, with optional `{var}` interpolation. */
  translate: (
    ns: Namespace,
    key: string,
    vars?: Record<string, string | number>,
  ) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function interpolate(
  template: string,
  vars?: Record<string, string | number>,
): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, name) =>
    name in vars ? String(vars[name]) : m,
  );
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  // Safe to read synchronously: text-bearing components only mount after the
  // window label resolves (WindowRouter), i.e. fully client-side.
  const [preference, setPreferenceState] = useState<LocalePreference>(() =>
    typeof window === "undefined"
      ? DEFAULT_LOCALE_PREFERENCE
      : getLocalePreference(),
  );

  const locale = useMemo(() => resolveLocale(preference), [preference]);

  // Keep <html lang> honest for accessibility / spellcheck.
  useEffect(() => {
    try {
      document.documentElement.lang = locale;
    } catch {
      /* no-op */
    }
  }, [locale]);

  // Mirror the resolved locale to the backend so it anchors the conversation
  // system prompt to a concrete reply language (otherwise the model guesses the
  // language from recent context). Fire-and-forget, like the theme sync.
  useEffect(() => {
    api.setUiLocale(locale).catch(() => {});
  }, [locale]);

  // Cross-window sync: the Settings picker writes localStorage, which fires a
  // `storage` event in every other same-origin window. Re-read on system-locale
  // following is irrelevant (the OS locale can't change at runtime here).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === LOCALE_STORAGE_KEY) {
        setPreferenceState(getLocalePreference());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setPreference = useCallback((pref: LocalePreference) => {
    setLocalePreference(pref); // persist
    setPreferenceState(pref); // apply live, this window
  }, []);

  const translate = useCallback(
    (ns: Namespace, key: string, vars?: Record<string, string | number>) => {
      const table = MESSAGES[ns] as
        | Record<Locale, Record<string, string>>
        | undefined;
      const raw =
        table?.[locale]?.[key] ??
        table?.[DEFAULT_LOCALE]?.[key] ??
        key; // last resort: surface the key so a miss is visible, not blank
      return interpolate(raw, vars);
    },
    [locale],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, preference, setPreference, translate }),
    [locale, preference, setPreference, translate],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function useI18nContext(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Render outside the provider (shouldn't happen) — degrade to English keys
    // rather than crash.
    return {
      locale: DEFAULT_LOCALE,
      preference: DEFAULT_LOCALE_PREFERENCE,
      setPreference: () => {},
      translate: (ns, key, vars) =>
        interpolate(
          (MESSAGES[ns] as Record<Locale, Record<string, string>> | undefined)?.[
            DEFAULT_LOCALE
          ]?.[key] ?? key,
          vars,
        ),
    };
  }
  return ctx;
}

/** Access the active locale + preference + setter (for the language picker). */
export function useLocale() {
  const { locale, preference, setPreference } = useI18nContext();
  return { locale, preference, setPreference };
}

/** Namespaced translator: `const { t } = useTranslation("settings")`. */
export function useTranslation(ns: Namespace) {
  const { translate, locale } = useI18nContext();
  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) =>
      translate(ns, key, vars),
    [translate, ns],
  );
  return { t, locale };
}
