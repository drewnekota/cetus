// Non-React translator for plain `.ts` modules (lib helpers, formatters,
// notification builders) that can't call the `useTranslation` hook. It resolves
// the active locale from the saved preference on every call. That's fine for
// live language switching: these helpers run during render, and the provider
// re-renders the whole tree on a language change, so the next call reads the new
// locale. Inside React components, prefer the `useTranslation` hook.

import {
  DEFAULT_LOCALE,
  type Locale,
  getLocalePreference,
  resolveLocale,
} from "./config";
import { MESSAGES, type Namespace } from "./messages";

function interpolate(
  template: string,
  vars?: Record<string, string | number>,
): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, name) =>
    name in vars ? String(vars[name]) : m,
  );
}

/** The active language right now (preference resolved against the OS). */
export function currentLocale(): Locale {
  return resolveLocale(getLocalePreference());
}

/** Translate a key in a namespace using the current locale. */
export function tt(
  ns: Namespace,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const table = MESSAGES[ns] as Record<Locale, Record<string, string>>;
  const locale = currentLocale();
  const raw = table?.[locale]?.[key] ?? table?.[DEFAULT_LOCALE]?.[key] ?? key;
  return interpolate(raw, vars);
}
