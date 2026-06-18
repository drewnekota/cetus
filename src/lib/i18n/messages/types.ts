import type { Locale } from "../config";

// A namespace bundles one feature area's strings for every language. English is
// the source of truth: author keys there first, then mirror the same key set in
// `zh` and `ja`. Keys are flat dotted strings (e.g. "appearance.title"); use
// `{name}`-style placeholders for interpolation (filled by the `t` function).
//
// Convention for adding a namespace:
//   1. Create `messages/<ns>.ts` exporting `export const <ns> = { en, zh, ja }
//      satisfies NamespaceMessages;`
//   2. Register it in `messages/index.ts` (the MESSAGES map).
//   3. In components: `const { t } = useTranslation("<ns>")` then `t("some.key")`.
export type NamespaceMessages = Record<Locale, Record<string, string>>;
