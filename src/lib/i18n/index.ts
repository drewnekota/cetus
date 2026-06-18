// Public entry point for the i18n module.
//   import { useTranslation, useLocale } from "@/lib/i18n";
export {
  I18nProvider,
  useTranslation,
  useLocale,
} from "./provider";
export {
  LOCALES,
  LOCALE_NATIVE_NAMES,
  DEFAULT_LOCALE,
  DEFAULT_LOCALE_PREFERENCE,
  detectSystemLocale,
  type Locale,
  type LocalePreference,
} from "./config";
export { tt, currentLocale } from "./standalone";
export type { Namespace } from "./messages";
