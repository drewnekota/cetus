import localFont from "next/font/local";

// Fonts used by the app. Sans and mono follow the OS (system font stacks in
// globals.css — SF Pro / Segoe UI / etc.), so the only face we self-host is the
// serif used for headings and hero titles: Fraunces (SIL OFL, bundled via
// @fontsource so the open-source build ships without any proprietary fonts).
//
// NOTE: next/font requires every value here — including `src` paths — to be a
// literal written inline (no helpers/variables), hence the repeated paths.

export const fraunces = localFont({
  variable: "--font-fraunces",
  display: "swap",
  src: [
    { path: "../../node_modules/@fontsource-variable/fraunces/files/fraunces-latin-wght-normal.woff2", weight: "100 900", style: "normal" },
    { path: "../../node_modules/@fontsource-variable/fraunces/files/fraunces-latin-wght-italic.woff2", weight: "100 900", style: "italic" },
  ],
});

/** Font variables applied on <html> so `--font-fraunces` resolves; the serif
 *  role var in globals.css points at it. */
export const fontVariables = fraunces.variable;
