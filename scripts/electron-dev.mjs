#!/usr/bin/env node
// `pnpm app`: build the Rust backend addon + the `cetus` CLI, bundle the
// Electron scripts, make sure the Next dev server is up, then launch Electron.
//
// Runs under its own data dir (identifier `run.cetus.electron` unless
// CETUS_IDENTIFIER is set), so it never touches the release app's sessions or
// control socket.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const devUrl = process.env.CETUS_DEV_URL ?? "http://localhost:17381";

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

console.log("[app] building backend addon…");
run("cargo", ["build", "--lib"], { cwd: path.join(root, "backend") });
console.log("[app] building cetus CLI…");
run("cargo", ["build"], { cwd: path.join(root, "backend", "cli") });

const dylib = path.join(root, "backend", "target", "debug", "libcetus_lib.dylib");
const nativeDir = path.join(root, "electron", "native");
fs.mkdirSync(nativeDir, { recursive: true });
fs.copyFileSync(dylib, path.join(nativeDir, "cetus.node"));

console.log("[app] bundling electron scripts…");
run("node", [path.join(root, "electron", "build.mjs")]);

async function up() {
  try {
    const r = await fetch(devUrl, { signal: AbortSignal.timeout(2000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

let next = null;
if (!(await up())) {
  console.log("[app] starting next dev…");
  next = spawn("pnpm", ["dev"], { cwd: root, stdio: "inherit" });
  for (let i = 0; i < 240 && !(await up()); i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

const electron = path.join(root, "node_modules", ".bin", "electron");
const app = spawn(electron, ["."], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, CETUS_DEV_URL: devUrl },
});
app.on("exit", (code) => {
  next?.kill("SIGTERM");
  process.exit(code ?? 0);
});
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    app.kill(sig);
    next?.kill(sig);
  });
}
