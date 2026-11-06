// Preload for the app windows: the renderer's only door into the host.
// Exposed as `window.__CETUS__`; `src/lib/host/*` wraps it in the API shape
// the frontend uses (invoke / listen / window / webview).

import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";

function argValue(prefix: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit?.slice(prefix.length);
}

type Listener = (event: { event: string; id: number; payload: unknown }) => void;

const listeners = new Map<string, Set<Listener>>();

ipcRenderer.on("cetus:event", (_e, event: string, payload: string) => {
  const set = listeners.get(event);
  if (!set?.size) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    parsed = payload;
  }
  for (const cb of [...set]) {
    try {
      cb({ event, id: 0, payload: parsed });
    } catch (err) {
      console.error(err);
    }
  }
});

// One-time carry-over from the Tauri build (see electron/webkit-storage.ts).
// Synchronous so the items are in place before the page's first read.
// Only on the app's own origin — never into an error page's.
const onAppOrigin = location.protocol === "app:" || location.hostname === "localhost";
const carried = onAppOrigin
  ? (ipcRenderer.sendSync("cetus:take-storage") as Record<string, string> | null)
  : null;
if (carried) {
  for (const [key, value] of Object.entries(carried)) {
    try {
      if (localStorage.getItem(key) == null) localStorage.setItem(key, value);
    } catch (err) {
      console.error("storage carry-over failed for", key, err);
    }
  }
}

contextBridge.exposeInMainWorld("__CETUS__", {
  label: argValue("--cetus-label=") ?? "main",
  version: argValue("--cetus-version=") ?? "0.0.0",
  async invoke(cmd: string, args?: Record<string, unknown>) {
    const env = (await ipcRenderer.invoke("cetus:invoke", cmd, JSON.stringify(args ?? {}))) as {
      ok: boolean;
      value: unknown;
    };
    if (env.ok) return env.value;
    throw env.value;
  },
  listen(event: string, cb: Listener) {
    let set = listeners.get(event);
    if (!set) listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  },
  windowOp(method: string, args?: unknown[]) {
    return ipcRenderer.invoke("cetus:window", method, args ?? []);
  },
  setZoom(z: number) {
    webFrame.setZoomFactor(z);
  },
  pathForFile(file: File) {
    return webUtils.getPathForFile(file);
  },
});
