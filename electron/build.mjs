// Bundle the Electron main + preload scripts into electron/dist.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const release = Boolean(process.env.CETUS_ELECTRON_RELEASE);
const here = path.dirname(new URL(import.meta.url).pathname);
const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));

await build({
  entryPoints: {
    main: path.join(here, "main.ts"),
    preload: path.join(here, "preload.ts"),
  },
  outdir: path.join(here, "dist"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: release ? false : "inline",
  minify: release,
  logLevel: "warning",
  define: { __CETUS_APP_ID__: JSON.stringify(pkg.cetus.appId) },
});
