// One-time carry-over of the Tauri build's localStorage (preferences, drafts,
// sidebar state) into Electron. WebKit keeps it per origin in
//   ~/Library/WebKit/<identifier>/WebsiteData/Default/<salt>/<salt>/LocalStorage/localstorage.sqlite3
// as `ItemTable(key TEXT, value BLOB)`, values UTF-16LE. The main window's
// preload takes the items once and writes them into its own localStorage
// before the page runs.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type StorageItems = Record<string, string>;

function findDatabase(identifier: string): string | null {
  const base = path.join(os.homedir(), "Library", "WebKit", identifier, "WebsiteData", "Default");
  let best: { file: string; mtime: number } | null = null;
  let outer: string[];
  try {
    outer = fs.readdirSync(base);
  } catch {
    return null;
  }
  for (const a of outer) {
    let inner: string[];
    try {
      inner = fs.readdirSync(path.join(base, a));
    } catch {
      continue;
    }
    for (const b of inner) {
      const dir = path.join(base, a, b);
      const file = path.join(dir, "LocalStorage", "localstorage.sqlite3");
      try {
        // The `origin` file names the scheme and host; the Tauri app was `tauri://localhost`.
        if (!fs.readFileSync(path.join(dir, "origin")).includes("tauri")) continue;
        const mtime = fs.statSync(file).mtimeMs;
        if (!best || mtime > best.mtime) best = { file, mtime };
      } catch {
        continue;
      }
    }
  }
  return best?.file ?? null;
}

/** Items from the Tauri build's localStorage, or null when there is none. */
export function readWebKitStorage(identifier: string): StorageItems | null {
  const db = findDatabase(identifier);
  if (!db) return null;
  // Read a copy: the WAL may hold the newest writes and sqlite3 wants to
  // create a -shm next to whatever it opens.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cetus-webkit-ls-"));
  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(db + suffix)) fs.copyFileSync(db + suffix, path.join(tmp, "ls.sqlite3" + suffix));
    }
    const r = spawnSync(
      "/usr/bin/sqlite3",
      ["-json", path.join(tmp, "ls.sqlite3"), "SELECT key, hex(value) AS v FROM ItemTable"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    if (r.status !== 0) throw new Error(r.stderr || `sqlite3 exited ${r.status}`);
    const rows = (r.stdout.trim() ? JSON.parse(r.stdout) : []) as { key: string; v: string }[];
    const items: StorageItems = {};
    for (const row of rows) items[row.key] = Buffer.from(row.v, "hex").toString("utf16le");
    return items;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
