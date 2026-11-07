#!/usr/bin/env node
// Build the release Cetus.app (Electron) — unsigned; scripts/macos-sign.sh
// signs it afterwards. Version and bundle id come from package.json
// (`version`, `cetus.appId`).
//
//   node scripts/package-electron.mjs            # full build
//   node scripts/package-electron.mjs --skip-web # reuse an existing `out/`
//
// Prints the .app path on the last line of stdout.
//
// Bundle layout (Contents/Resources):
//   app.asar      electron/dist (main + preload) + a minimal package.json
//   native/       cetus.node — the Rust backend addon
//   bin/cetus     the `cetus` CLI agents shell out to
//   out/          the static Next export, served as app://cetus/
//   icons/        app icon
//   pi-install/   the bundled pi runtime (scripts/build-pi-sidecar.sh)

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { packager } from "@electron/packager";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const skipWeb = process.argv.includes("--skip-web");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const electronVersion = JSON.parse(
  fs.readFileSync(path.join(root, "node_modules", "electron", "package.json"), "utf8"),
).version;

function run(cmd, args, opts = {}) {
  console.error(`→ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: ["ignore", process.stderr, "inherit"], ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const backendDir = path.join(root, "backend");
if (!fs.existsSync(path.join(backendDir, "pi-install"))) {
  run(path.join(root, "scripts", "build-pi-sidecar.sh"), [], { cwd: root });
}
run("cargo", ["build", "--release", "--lib"], { cwd: backendDir });
run("cargo", ["build", "--release"], { cwd: path.join(backendDir, "cli") });
run("node", [path.join(root, "electron", "build.mjs")], {
  env: { ...process.env, CETUS_ELECTRON_RELEASE: "1" },
});
if (!skipWeb) run("pnpm", ["build"], { cwd: root });
if (!fs.existsSync(path.join(root, "out", "index.html"))) {
  console.error("out/index.html missing — run `pnpm build` first");
  process.exit(1);
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "cetus-package-"));
const appDir = path.join(stage, "app");
const resDir = path.join(stage, "resources");
fs.mkdirSync(appDir);
fs.mkdirSync(resDir);

fs.cpSync(path.join(root, "electron", "dist"), path.join(appDir, "dist"), { recursive: true });
fs.writeFileSync(
  path.join(appDir, "package.json"),
  JSON.stringify(
    { name: "cetus", productName: "Cetus", version: pkg.version, main: "dist/main.js" },
    null,
    2,
  ),
);

const native = path.join(resDir, "native");
fs.mkdirSync(native);
fs.copyFileSync(
  path.join(backendDir, "target", "release", "libcetus_lib.dylib"),
  path.join(native, "cetus.node"),
);
const bin = path.join(resDir, "bin");
fs.mkdirSync(bin);
fs.copyFileSync(path.join(backendDir, "cli", "target", "release", "cetus"), path.join(bin, "cetus"));
fs.chmodSync(path.join(bin, "cetus"), 0o755);
const icons = path.join(resDir, "icons");
fs.mkdirSync(icons);
for (const f of ["icon.png"]) {
  fs.copyFileSync(path.join(backendDir, "icons", f), path.join(icons, f));
}

const outDir = path.join(backendDir, "target", "electron");
const [appPath] = await packager({
  dir: appDir,
  out: outDir,
  overwrite: true,
  platform: "darwin",
  arch: "arm64",
  electronVersion,
  name: "Cetus",
  executableName: "Cetus",
  appBundleId: pkg.cetus.appId,
  appVersion: pkg.version,
  buildVersion: pkg.version,
  appCategoryType: "public.app-category.developer-tools",
  icon: path.join(backendDir, "icons", "icon.icns"),
  asar: true,
  prune: false,
  darwinDarkModeSupport: true,
  extraResource: [
    native,
    bin,
    icons,
    path.join(root, "out"),
    path.join(backendDir, "pi-install"),
  ],
  extendInfo: {
    LSMinimumSystemVersion: "13.0",
    NSMicrophoneUsageDescription:
      "Cetus uses your microphone to transcribe speech to text for voice input.",
    NSSpeechRecognitionUsageDescription:
      "Cetus transcribes your speech on-device so you can dictate instead of type.",
    NSAudioCaptureUsageDescription:
      "Cetus transcribes the other meeting participants from your system audio. No audio is stored.",
  },
  // Signing is done by scripts/macos-sign.sh (nested pi binaries need their
  // own entitlements, which the packager's signer doesn't know about).
  osxSign: undefined,
});

const app = path.join(appPath, "Cetus.app");

// The packager rewrites relative symlinks inside extraResource dirs (e.g.
// pi-install/node_modules/.bin/*) into absolute paths pointing back at the
// source tree; codesign rejects those ("invalid destination for symbolic
// link in bundle"). Point them back inside the bundle, relatively.
const bundleRes = path.join(app, "Contents", "Resources");
const resourceSources = new Map([
  [path.join(root, "out"), path.join(bundleRes, "out")],
  [path.join(backendDir, "pi-install"), path.join(bundleRes, "pi-install")],
  [native, path.join(bundleRes, "native")],
  [bin, path.join(bundleRes, "bin")],
  [icons, path.join(bundleRes, "icons")],
]);
(function fixLinks(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) {
      const target = fs.readlinkSync(p);
      if (!path.isAbsolute(target)) continue;
      for (const [src, dst] of resourceSources) {
        if (target === src || target.startsWith(src + path.sep)) {
          const mapped = path.join(dst, path.relative(src, target));
          fs.unlinkSync(p);
          fs.symlinkSync(path.relative(path.dirname(p), mapped), p);
          break;
        }
      }
    } else if (ent.isDirectory()) {
      fixLinks(p);
    }
  }
})(bundleRes);

fs.rmSync(stage, { recursive: true, force: true });
console.log(app);
