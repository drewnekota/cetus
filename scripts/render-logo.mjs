// The Cetus logo, defined once and written to every place that ships it.
//
//   node scripts/render-logo.mjs
//
// Needs Google Chrome (for rasterizing) plus macOS sips and iconutil.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(import.meta.url), "../..");
const require = createRequire(path.join(root, "package.json"));
const { chromium } = require("@playwright/test");

// The mark, drawn in a 1024 box (it spans roughly 100–924).
const GLYPH =
  "M512 108C739.541 108 924 292.459 924 520C924 700.997 807.285 854.733 645.012 910.054C632.927 914.174 626.884 916.234 619.386 915.916C613.304 915.658 605.851 913.437 600.62 910.323C594.171 906.484 589.642 900.683 580.583 889.081L369.758 619.073C352.563 597.052 343.965 586.041 333.522 582.073C324.369 578.594 314.258 578.594 305.105 582.072C294.661 586.041 286.064 597.052 268.869 619.073L223.165 677.607C205.689 699.989 196.951 711.18 184.352 714.738C174.521 717.514 160.565 715.455 151.955 709.958C140.92 702.912 136.525 691.579 127.735 668.912C109.824 622.728 100 572.511 100 520C100 292.459 284.459 108 512 108Z";

/**
 * inset   margin around the tile in the 1024 canvas (macOS icons keep 100).
 * radius  tile corner radius as a fraction of the tile's side.
 * effects the bloom, drop shadows and rim light; off for marks drawn tiny,
 *         where they only cost a filter pass.
 * attrs   extra attributes for the root element.
 */
function logo({ inset = 100, radius = 0.2257, effects = true, attrs = "", title = "" } = {}) {
  const side = 1024 - inset * 2;
  const k = side / 824; // everything below was tuned on an 824px tile
  const r = side * radius;
  const tile = `<rect x="${inset}" y="${inset}" width="${side}" height="${side}" rx="${r}"`;
  const place = `translate(512 ${512 + 8 * k}) scale(${0.67 * k}) translate(-512 -512)`;
  const span = `x1="0" y1="${inset}" x2="0" y2="${1024 - inset}" gradientUnits="userSpaceOnUse"`;
  const glyphSpan = `x1="0" y1="108" x2="0" y2="916" gradientUnits="userSpaceOnUse"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"${attrs}>${title}
<defs>
<linearGradient id="cetus-tile" ${span}><stop stop-color="#302c5e"/><stop offset=".55" stop-color="#191733"/><stop offset="1" stop-color="#0a0915"/></linearGradient>
<radialGradient id="cetus-glow" cx="512" cy="${512 - 57 * k}" r="${430 * k}" gradientUnits="userSpaceOnUse"><stop stop-color="#8f87ff" stop-opacity=".42"/><stop offset=".6" stop-color="#8f87ff" stop-opacity=".1"/><stop offset="1" stop-color="#8f87ff" stop-opacity="0"/></radialGradient>
<linearGradient id="cetus-rim" ${span}><stop stop-color="#fff" stop-opacity=".3"/><stop offset=".22" stop-color="#fff" stop-opacity=".04"/><stop offset=".8" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".5"/></linearGradient>
<linearGradient id="cetus-glyph" ${glyphSpan}><stop stop-color="#d6d2ff"/><stop offset=".45" stop-color="#9d96f7"/><stop offset="1" stop-color="#6f65e6"/></linearGradient>
<linearGradient id="cetus-edge" ${glyphSpan}><stop stop-color="#fff" stop-opacity=".75"/><stop offset=".35" stop-color="#fff" stop-opacity="0"/><stop offset=".7" stop-color="#2a2190" stop-opacity="0"/><stop offset="1" stop-color="#2a2190" stop-opacity=".45"/></linearGradient>
<clipPath id="cetus-tile-clip">${tile}/></clipPath>
<clipPath id="cetus-glyph-clip"><path d="${GLYPH}"/></clipPath>${effects ? `
<filter id="cetus-bloom" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="62"/></filter>
<filter id="cetus-shadow" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#05041a" flood-opacity=".45"/><feDropShadow dx="0" dy="44" stdDeviation="46" flood-color="#05041a" flood-opacity=".55"/></filter>` : ""}
</defs>
${tile} fill="url(#cetus-tile)"/>
<g clip-path="url(#cetus-tile-clip)"><rect width="1024" height="1024" fill="url(#cetus-glow)"/>${effects ? `
<g transform="${place}"><path d="${GLYPH}" fill="#8f87ff" opacity=".36" filter="url(#cetus-bloom)"/></g>` : ""}</g>${effects && radius ? `
${tile} fill="none" stroke="url(#cetus-rim)" stroke-width="4" clip-path="url(#cetus-tile-clip)"/>` : ""}
<g transform="${place}"><path d="${GLYPH}" fill="url(#cetus-glyph)"${effects ? ' filter="url(#cetus-shadow)"' : ""}/>
<path d="${GLYPH}" fill="none" stroke="url(#cetus-edge)" stroke-width="14" clip-path="url(#cetus-glyph-clip)"/></g>
</svg>
`;
}

const master = logo(); // macOS-style: rounded tile with a margin, transparent corners
const square = logo({ inset: 0, radius: 0 }); // iOS rounds the corners itself
// The in-app brand mark and the phone companion's home-screen icon.
const mark = logo({
  inset: 0,
  effects: false,
  attrs: ' width="1em" height="1em" style="flex:none;line-height:1"',
  title: "<title>Cetus</title>",
});

const out = (...p) => path.join(root, ...p);
writeFileSync(out("docs/logo.svg"), master);
writeFileSync(out("public/brands/cetus.svg"), mark);
writeFileSync(out("website/assets/brands/cetus.svg"), mark);
writeFileSync(out("backend/remote/icon.svg"), logo({ inset: 0, effects: false }));

const browser = await chromium.launch({ channel: "chrome" });
async function png(svg, size, file, opaque = false) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0;background:${opaque ? "#0a0915" : "transparent"}}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.screenshot({ path: file, omitBackground: !opaque });
  await page.close();
}
await png(master, 1024, out("docs/logo.png"));
await png(master, 1024, out("website/assets/logo.png"));
await png(master, 512, out("backend/icons/icon.png"));
await png(master, 512, out("src/app/icon.png"));
await png(square, 1024, out("ios/App/Assets.xcassets/AppIcon.appiconset/icon-1024.png"), true);
await png(square, 256, out("ios/App/Assets.xcassets/Logo.imageset/logo.png"), true);

// Each .icns size is rendered from the vector, not scaled down from 1024.
const work = mkdtempSync(path.join(tmpdir(), "cetus-logo-"));
const iconset = path.join(work, "icon.iconset");
mkdirSync(iconset);
for (const size of [16, 32, 128, 256, 512]) {
  await png(master, size, path.join(iconset, `icon_${size}x${size}.png`));
  await png(master, size * 2, path.join(iconset, `icon_${size}x${size}@2x.png`));
}
await browser.close();
execFileSync("iconutil", ["-c", "icns", iconset, "-o", out("backend/icons/icon.icns")]);
rmSync(work, { recursive: true });
console.log("Logo written to docs, website, public, backend and ios.");
