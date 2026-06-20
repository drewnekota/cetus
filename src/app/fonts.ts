import localFont from "next/font/local";

// Fonts used by the app. Sans and mono follow the OS (system font stacks in
// globals.css — SF Pro / Segoe UI / etc.), so the only face we self-host is the
// serif used for headings and hero titles: Old Standard TT (SIL OFL, bundled
// via @fontsource so the open-source build ships without any proprietary
// fonts).
//
// NOTE: next/font requires every value here — including `src` paths — to be a
// literal written inline (no helpers/variables), hence the repeated paths.

export const oldStandard = localFont({
  variable: "--font-old-standard",
  display: "swap",
  src: [
    { path: "../../node_modules/@fontsource/old-standard-tt/files/old-standard-tt-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../../node_modules/@fontsource/old-standard-tt/files/old-standard-tt-latin-400-italic.woff2", weight: "400", style: "italic" },
    { path: "../../node_modules/@fontsource/old-standard-tt/files/old-standard-tt-latin-700-normal.woff2", weight: "700", style: "normal" },
  ],
});

/** Font variables applied on <html> so `--font-old-standard` resolves; the
 *  serif role var in globals.css points at it. */
export const fontVariables = oldStandard.variable;
