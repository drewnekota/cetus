// Electron main process. Hosts the Rust backend (a Node-API addon built from
// backend/) and owns everything UI-side: windows, child webviews, menus,
// global shortcuts, dialogs and the custom protocols.
//
// The backend talks to this process through `host.call(op, argsJson)` (see
// `handle` below); renderers talk to the backend through the preload bridge
// (`cetus:invoke`), and backend events fan out to renderers as `cetus:event`.

import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeTheme,
  Notification,
  protocol,
  screen,
  shell,
  WebContentsView,
  type Display,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { APP_WINDOWS } from "./windows";
import { readWebKitStorage, type StorageItems } from "./webkit-storage";

// GUI launches get launchd's bare environment. Adopt the user's interactive
// login-shell env (API keys, proxies, PATH) so child runtimes (claude, codex,
// pi) behave like they do in a terminal. Done here, before Chromium starts
// its helper processes: setenv is not thread-safe, so changing the
// environment later races process launches.
function adoptLoginShellEnv() {
  const SKIP = new Set(["PATH", "PWD", "OLDPWD", "SHLVL", "_", "TERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM_SESSION_ID", "TTY"]);
  const shell = process.env.SHELL || "/bin/zsh";
  const r = spawnSync(shell, ["-ilc", "printf '__CETUS_ENV__'; command env -0; printf '__CETUS_ENV__'"], {
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const payload = (r.stdout ?? "").split("__CETUS_ENV__")[1];
  if (!payload) return;
  const entries = payload.split("\0");
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    if (SKIP.has(key) || process.env[key] !== undefined) continue;
    process.env[key] = entry.slice(eq + 1);
  }
  const shellPath = entries.find((e) => e.startsWith("PATH="))?.slice(5) ?? "";
  if (shellPath.trim()) {
    const merged = shellPath.split(":").filter(Boolean);
    for (const dir of (process.env.PATH ?? "").split(":")) {
      if (dir && !merged.includes(dir)) merged.push(dir);
    }
    process.env.PATH = merged.join(":");
  }
  process.env.CETUS_SHELL_ENV_ADOPTED = "1";
}
adoptLoginShellEnv();

const isDev = !app.isPackaged;
// electron/dist/main.js in dev; Contents/Resources/app.asar/… when packaged.
const ROOT = isDev ? path.resolve(__dirname, "..", "..") : process.resourcesPath;
const DEV_URL = process.env.CETUS_DEV_URL ?? "http://localhost:17381";
const APP_URL = isDev ? `${DEV_URL}/` : "app://cetus/index.html";
// Release bundle id, from `cetus.appId` in package.json (injected by
// electron/build.mjs).
declare const __CETUS_APP_ID__: string;
// Dev runs under its own identifier so it never shares the release app's data
// dir, control socket or running sessions.
const IDENTIFIER =
  process.env.CETUS_IDENTIFIER ?? (isDev ? "run.cetus.electron" : __CETUS_APP_ID__);
const DATA_DIR = path.join(os.homedir(), "Library", "Application Support", IDENTIFIER);
const NATIVE_PATH = isDev
  ? path.join(ROOT, "electron", "native", "cetus.node")
  : path.join(process.resourcesPath, "native", "cetus.node");
const PRELOAD = path.join(__dirname, "preload.js");
const AUTOSTART = process.argv.some((a) => a === "--autostart" || a === "--background-relaunch");

app.setName("Cetus");
// Dev-only: CDP endpoint for driving/inspecting the renderers from scripts.
if (isDev && process.env.CETUS_DEBUG_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.CETUS_DEBUG_PORT);
}
app.setPath("userData", path.join(DATA_DIR, "webview"));
process.env.CETUS_CLI_BIN ??= isDev
  ? path.join(ROOT, "backend", "cli", "target", "debug", "cetus")
  : path.join(process.resourcesPath, "bin", "cetus");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "asset",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true },
  },
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

// Main-process log: stdout plus <data>/logs/electron-main.log (packaged
// builds have no stdout to read).
const MAIN_LOG = path.join(DATA_DIR, "logs", "electron-main.log");
function log(level: "info" | "warn" | "error", ...parts: unknown[]) {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${parts
    .map((p) => (p instanceof Error ? (p.stack ?? p.message) : typeof p === "string" ? p : JSON.stringify(p)))
    .join(" ")}`;
  (level === "info" ? console.log : console.error)(line);
  try {
    fs.mkdirSync(path.dirname(MAIN_LOG), { recursive: true });
    fs.appendFileSync(MAIN_LOG, line + "\n");
  } catch {
    // logging must never throw
  }
}

// ---------------------------------------------------------------------------
// Native addon
// ---------------------------------------------------------------------------

interface Native {
  init(host: object, configJson: string): void;
  start(): void;
  invoke(id: number, label: string, cmd: string, args: string): string | null;
  hostReply(id: number, json: string): void;
  windowState(label: string, stateJson: string | null, nsView: string | null): void;
  windowEvent(label: string, kind: string, payload: string | null): boolean;
  titleChanged(label: string, title: string): void;
  shortcut(accelerator: string): void;
  appEvent(kind: string, payload: string | null): boolean;
}

function loadNative(): Native {
  const mod = { exports: {} as Native };
  process.dlopen(mod, NATIVE_PATH);
  return mod.exports;
}

let native: Native;

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

const windows = new Map<string, BrowserWindow>();
const childViews = new Map<string, { view: WebContentsView; parent: string }>();
const labelByContents = new Map<number, string>();
let quitting = false;
const liveNotifications = new Set<Notification>();

function displayInfo(d: Display) {
  return {
    label: d.label,
    x: d.bounds.x,
    y: d.bounds.y,
    width: d.bounds.width,
    height: d.bounds.height,
    workX: d.workArea.x,
    workY: d.workArea.y,
    workWidth: d.workArea.width,
    workHeight: d.workArea.height,
    scale: d.scaleFactor,
  };
}

function stateOf(win: BrowserWindow) {
  const b = win.getBounds();
  const c = win.getContentBounds();
  const d = screen.getDisplayMatching(b);
  return {
    visible: win.isVisible(),
    focused: win.isFocused(),
    minimized: win.isMinimized(),
    maximized: win.isMaximized(),
    fullscreen: win.isFullScreen(),
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    innerWidth: c.width,
    innerHeight: c.height,
    scale: d.scaleFactor,
    url: win.webContents.getURL(),
    title: win.getTitle(),
  };
}

function nsView(win: BrowserWindow): string | null {
  if (process.platform !== "darwin") return null;
  try {
    return win.getNativeWindowHandle().readBigUInt64LE(0).toString();
  } catch {
    return null;
  }
}

function pushState(label: string) {
  const win = windows.get(label);
  if (!win || win.isDestroyed()) return;
  native.windowState(label, JSON.stringify(stateOf(win)), nsView(win));
}

function isAppUrl(url: string) {
  return isDev ? url.startsWith(DEV_URL) : url.startsWith("app://");
}

function guardNavigation(contents: WebContents) {
  // The app shell must never navigate away from its own document: links are
  // routed to the OS, anything else is refused.
  contents.on("will-navigate", (e, url) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
}

function wireWindow(label: string, win: BrowserWindow, opts: { app: boolean }) {
  windows.set(label, win);
  labelByContents.set(win.webContents.id, label);
  const sync = () => pushState(label);
  const scale = () => screen.getDisplayMatching(win.getBounds()).scaleFactor;

  win.on("close", (e) => {
    if (quitting) return;
    if (native.windowEvent(label, "close", null)) e.preventDefault();
  });
  win.on("closed", () => {
    windows.delete(label);
    native.windowState(label, null, null);
    native.windowEvent(label, "destroyed", null);
  });
  win.on("move", () => {
    sync();
    const b = win.getBounds();
    const s = scale();
    native.windowEvent(label, "moved", JSON.stringify({ x: b.x * s, y: b.y * s }));
  });
  win.on("resize", () => {
    sync();
    const c = win.getContentBounds();
    const s = scale();
    native.windowEvent(
      label,
      "resized",
      JSON.stringify({ width: c.width * s, height: c.height * s }),
    );
  });
  win.on("focus", () => {
    sync();
    native.windowEvent(label, "focus", "true");
  });
  win.on("blur", () => {
    sync();
    native.windowEvent(label, "focus", "false");
  });
  for (const ev of [
    "show",
    "hide",
    "minimize",
    "restore",
    "maximize",
    "unmaximize",
    "enter-full-screen",
    "leave-full-screen",
  ] as const) {
    win.on(ev as "show", sync);
  }
  win.webContents.on("page-title-updated", (_e, title) => native.titleChanged(label, title));
  win.webContents.on("did-navigate", sync);

  if (opts.app) {
    guardNavigation(win.webContents);
    // A failed first load (dev server still compiling, a network-service
    // restart) would leave the window on about:blank for good — retry.
    let retries = 0;
    win.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3 /* ABORTED */) return;
      log("warn", `[cetus] ${label} failed to load ${url}: ${desc} (${code})`);
      if (retries++ < 20) setTimeout(() => void win.loadURL(APP_URL), 500 * Math.min(retries, 6));
    });
    win.webContents.on("render-process-gone", (_e, details) => {
      if (details.reason === "clean-exit") return;
      log("warn", `[cetus] ${label} renderer gone (${details.reason}); reloading`);
      void win.loadURL(APP_URL);
    });
  }
  sync();
}

/** Load the frontend; re-issue the navigation if it hasn't committed in a
 *  few seconds (a load caught by a network-service restart can hang). */
function loadApp(label: string, win: BrowserWindow, attempt = 0) {
  let retried = false;
  win.loadURL(APP_URL).catch((e) => {
    log("warn", `[cetus] ${label} loadURL: ${e}`);
    if (String(e).includes("ERR_ABORTED") || attempt >= 10 || win.isDestroyed()) return;
    retried = true;
    setTimeout(() => loadApp(label, win, attempt + 1), 1000);
  });
  setTimeout(() => {
    if (retried) return;
    if (win.isDestroyed() || win.webContents.getURL().startsWith(APP_URL.replace(/\/$/, ""))) return;
    if (attempt >= 10) return;
    log("warn", `[cetus] ${label} still on ${win.webContents.getURL() || "about:blank"}; reloading`);
    loadApp(label, win, attempt + 1);
  }, 8000);
}

function createAppWindow(label: string, options: Electron.BrowserWindowConstructorOptions) {
  const win = new BrowserWindow({
    ...options,
    backgroundColor: options.transparent ? "#00000000" : undefined,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: label === "main",
      additionalArguments: [`--cetus-label=${label}`, `--cetus-version=${app.getVersion()}`],
    },
  });
  wireWindow(label, win, { app: true });
  return win;
}

function runInitScripts(contents: WebContents, scripts: string[]) {
  if (!scripts.length) return;
  contents.on("dom-ready", () => {
    for (const s of scripts) void contents.executeJavaScript(s, true).catch(() => {});
  });
}

function createBrowserWindow(args: {
  label: string;
  url: string;
  options: Record<string, unknown>;
  initScript: string[];
}) {
  const o = args.options;
  const win = new BrowserWindow({
    title: (o.title as string) ?? "Cetus",
    width: (o.width as number) ?? 1200,
    height: (o.height as number) ?? 820,
    resizable: (o.resizable as boolean) ?? true,
    webPreferences: {
      partition: "persist:cetus-browser",
      contextIsolation: true,
      sandbox: true,
    },
  });
  wireWindow(args.label, win, { app: false });
  runInitScripts(win.webContents, args.initScript);
  void win.loadURL(args.url);
  return win;
}

function createChildWebview(args: {
  parent: string;
  label: string;
  url: string;
  initScript: string[];
  bounds: { x: number; y: number; width: number; height: number };
}) {
  const parent = windows.get(args.parent);
  if (!parent) return;
  const view = new WebContentsView({
    webPreferences: { partition: "persist:cetus-browser", contextIsolation: true, sandbox: true },
  });
  parent.contentView.addChildView(view);
  view.setBounds(roundRect(args.bounds));
  childViews.set(args.label, { view, parent: args.parent });
  labelByContents.set(view.webContents.id, args.label);
  view.webContents.on("page-title-updated", (_e, title) => native.titleChanged(args.label, title));
  runInitScripts(view.webContents, args.initScript);
  void view.webContents.loadURL(args.url);
}

function roundRect(b: { x: number; y: number; width: number; height: number }) {
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.max(1, Math.round(b.width)),
    height: Math.max(1, Math.round(b.height)),
  };
}

function windowOp(label: string, method: string, args: unknown): unknown {
  const win = windows.get(label);
  if (!win || win.isDestroyed()) return method === "state" ? null : undefined;
  const a = Array.isArray(args) ? args : [];
  let result: unknown;
  switch (method) {
    case "state":
      return stateOf(win);
    case "show":
      if (win.isFocusable()) win.show();
      else win.showInactive();
      break;
    case "hide":
      win.hide();
      break;
    case "close":
      win.close();
      return;
    case "destroy":
      win.destroy();
      return;
    case "focus":
      if (!win.isVisible()) win.show();
      win.focus();
      if (label === "main") app.focus({ steal: true });
      break;
    case "center":
      win.center();
      break;
    case "minimize":
      win.minimize();
      break;
    case "restore":
      if (win.isMinimized()) win.restore();
      break;
    case "maximize":
      win.maximize();
      break;
    case "unmaximize":
      win.unmaximize();
      break;
    case "setFullScreen":
      win.setFullScreen(Boolean(a[0]));
      break;
    case "setTitle":
      win.setTitle(String(a[0] ?? ""));
      break;
    case "setAlwaysOnTop":
      win.setAlwaysOnTop(Boolean(a[0]));
      break;
    case "setIgnoreMouseEvents":
      win.setIgnoreMouseEvents(Boolean(a[0]));
      break;
    case "setResizable":
      win.setResizable(Boolean(a[0]));
      break;
    case "setSkipTaskbar":
      win.setSkipTaskbar(Boolean(a[0]));
      break;
    case "setVisibleOnAllWorkspaces":
      win.setVisibleOnAllWorkspaces(Boolean(a[0]), { visibleOnFullScreen: true });
      break;
    case "setContentSize":
      win.setContentSize(Math.max(1, Math.round(Number(a[0]))), Math.max(1, Math.round(Number(a[1]))));
      break;
    case "setMinimumSize":
      win.setMinimumSize(Math.round(Number(a[0])), Math.round(Number(a[1])));
      break;
    case "setPosition":
      win.setPosition(Math.round(Number(a[0])), Math.round(Number(a[1])));
      break;
    case "currentDisplay":
      return displayInfo(screen.getDisplayMatching(win.getBounds()));
    case "url":
      return win.webContents.getURL();
    case "loadURL":
      void win.loadURL(String(a[0]));
      break;
    case "reload":
      win.webContents.reload();
      break;
    case "eval":
      void win.webContents.executeJavaScript(String(a[0]), true).catch(() => {});
      break;
    case "setZoomFactor":
      win.webContents.setZoomFactor(Number(a[0]) || 1);
      break;
    default:
      log("warn", `[cetus] unknown window op ${method}`);
  }
  pushState(label);
  return result;
}

function webviewOp(label: string, method: string, args: unknown): unknown {
  const child = childViews.get(label);
  const contents = child?.view.webContents ?? windows.get(label)?.webContents;
  if (!contents || contents.isDestroyed()) return undefined;
  const a = Array.isArray(args) ? args : [];
  switch (method) {
    case "setBounds":
      child?.view.setBounds(roundRect(a[0] as { x: number; y: number; width: number; height: number }));
      return;
    case "loadURL":
      void contents.loadURL(String(a[0]));
      return;
    case "eval":
      void contents.executeJavaScript(String(a[0]), true).catch(() => {});
      return;
    case "reload":
      contents.reload();
      return;
    case "url":
      return contents.getURL();
    case "setZoomFactor":
      contents.setZoomFactor(Number(a[0]) || 1);
      return;
    case "close":
      if (child) {
        windows.get(child.parent)?.contentView.removeChildView(child.view);
        childViews.delete(label);
        contents.close();
      } else {
        windows.get(label)?.close();
      }
      return;
  }
}

// ---------------------------------------------------------------------------
// Host calls from the backend
// ---------------------------------------------------------------------------

type Pending = (env: { ok: boolean; value: unknown }) => void;
const pendingInvokes = new Map<number, Pending>();
let nextInvoke = 1;

function finalExit(code = 0, relaunch = false) {
  if (quitting) return;
  quitting = true;
  try {
    native.appEvent("exit", null);
  } catch (e) {
    log("error", "[cetus] exit hook failed", e);
  }
  globalShortcut.unregisterAll();
  if (relaunch) app.relaunch({ args: process.argv.slice(1).filter((a) => a !== "--autostart") });
  app.exit(code);
}

function handle(op: string, args: any): unknown {
  switch (op) {
    case "emit": {
      const { target, event, payload } = args as { target: string | null; event: string; payload: string };
      for (const [label, win] of windows) {
        if (target && target !== label) continue;
        if (!win.isDestroyed() && labelByContents.has(win.webContents.id)) {
          win.webContents.send("cetus:event", event, payload);
        }
      }
      return;
    }
    case "invoke_reply": {
      const resolve = pendingInvokes.get(args.id);
      if (resolve) {
        pendingInvokes.delete(args.id);
        resolve({ ok: args.ok, value: args.value });
      }
      return;
    }
    case "window":
      return windowOp(args.label, args.method, args.args);
    case "webview":
      return webviewOp(args.label, args.method, args.args);
    case "webview_exists":
      return childViews.has(args.label) || windows.has(args.label);
    case "create_window":
      createBrowserWindow(args);
      return;
    case "create_child_webview":
      createChildWebview(args);
      return;
    case "cursor_position": {
      const p = screen.getCursorScreenPoint();
      return { x: p.x, y: p.y, scale: screen.getDisplayNearestPoint(p).scaleFactor };
    }
    case "primary_display":
      return displayInfo(screen.getPrimaryDisplay());
    case "displays":
      return screen.getAllDisplays().map(displayInfo);
    case "display_at_physical_point": {
      const hit = screen.getAllDisplays().find((d) => {
        const x = args.x / d.scaleFactor;
        const y = args.y / d.scaleFactor;
        const b = d.bounds;
        return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
      });
      return hit ? displayInfo(hit) : null;
    }
    case "set_theme":
      nativeTheme.themeSource = args.theme ?? "system";
      return;
    case "exit":
      setImmediate(() => finalExit(args?.code ?? 0));
      return;
    case "restart":
      setImmediate(() => finalExit(0, true));
      return;
    case "shortcut_register":
      try {
        return globalShortcut.register(args.accelerator, () => native.shortcut(args.accelerator));
      } catch {
        return false;
      }
    case "shortcut_unregister":
      globalShortcut.unregister(args.accelerator);
      return;
    case "shortcut_unregister_all":
      globalShortcut.unregisterAll();
      return;
    case "set_login_item":
      app.setLoginItemSettings({ openAtLogin: Boolean(args.enabled), args: ["--autostart"] });
      return;
    case "get_login_item":
      return app.getLoginItemSettings().openAtLogin;
    case "notify": {
      const n = new Notification({ title: args.title, body: args.body });
      // Keep a reference until it settles so the click handler stays alive.
      liveNotifications.add(n);
      const done = () => liveNotifications.delete(n);
      n.on("click", () => {
        done();
        native.appEvent("notification_click", JSON.stringify({ conversationId: args.conversationId ?? null }));
      });
      n.on("close", done);
      n.show();
      return;
    }
    case "dialog_pick_folder":
      return dialog
        .showOpenDialog({ properties: ["openDirectory", "createDirectory"] })
        .then((r) => (r.canceled ? null : (r.filePaths[0] ?? null)));
    case "dialog_save_file":
      return dialog
        .showSaveDialog({ defaultPath: args.name ?? undefined })
        .then((r) => (r.canceled ? null : (r.filePath ?? null)));
    case "dialog_message":
      return dialog
        .showMessageBox({
          type: "warning",
          message: args.title,
          detail: args.body,
          buttons: args.buttons,
          defaultId: 0,
          cancelId: Math.max(0, (args.buttons?.length ?? 1) - 1),
        })
        .then((r) => r.response);
    case "renderer_pids": {
      const out: [string, number][] = [];
      for (const [label, win] of windows) {
        if (!win.isDestroyed()) out.push([label, win.webContents.getOSProcessId()]);
      }
      for (const [label, { view }] of childViews) {
        if (!view.webContents.isDestroyed()) out.push([label, view.webContents.getOSProcessId()]);
      }
      return out;
    }
    case "__async": {
      const { replyId } = args;
      Promise.resolve()
        .then(() => handle(args.op, args.args))
        .then(
          (v) => native.hostReply(replyId, JSON.stringify(v ?? null)),
          (e) => {
            log("error", `[cetus] async host op ${args.op} failed`, e);
            native.hostReply(replyId, "null");
          },
        );
      return;
    }
    default:
      log("warn", `[cetus] unknown host op ${op}`);
      return;
  }
}

const host = {
  noop() {},
  call(op: string, argsJson: string): string | undefined {
    try {
      const r = handle(op, JSON.parse(argsJson));
      if (r === undefined || r instanceof Promise) return undefined;
      return JSON.stringify(r);
    } catch (e) {
      log("error", `[cetus] host op ${op} failed`, e);
      return undefined;
    }
  },
};

// ---------------------------------------------------------------------------
// Renderer bridge
// ---------------------------------------------------------------------------

ipcMain.handle("cetus:invoke", (e, cmd: string, argsJson: string) => {
  const label = labelByContents.get(e.sender.id) ?? "main";
  const id = nextInvoke++;
  return new Promise((resolve) => {
    pendingInvokes.set(id, resolve);
    let env: string | null;
    try {
      env = native.invoke(id, label, cmd, argsJson || "{}");
    } catch (err) {
      pendingInvokes.delete(id);
      resolve({ ok: false, value: String(err) });
      return;
    }
    if (env != null) {
      pendingInvokes.delete(id);
      resolve(JSON.parse(env));
    }
  });
});

// First launch after the move from Tauri: hand the old WebKit localStorage
// (preferences, drafts, sidebar state) to the main window's preload once.
const STORAGE_MIGRATED = path.join(DATA_DIR, "webview", ".webkit-storage-migrated");
let pendingStorage: StorageItems | null = null;
if ((!isDev || process.env.CETUS_MIGRATE_WEBKIT) && !fs.existsSync(STORAGE_MIGRATED)) {
  try {
    // CETUS_MIGRATE_WEBKIT=<identifier> exercises this from a dev build.
    pendingStorage = readWebKitStorage(process.env.CETUS_MIGRATE_WEBKIT || IDENTIFIER) ?? {};
  } catch (err) {
    log("warn", "[cetus] could not read WebKit localStorage", err);
    pendingStorage = {};
  }
}

ipcMain.on("cetus:take-storage", (e) => {
  const label = labelByContents.get(e.sender.id);
  if (label !== "main" || pendingStorage == null) {
    e.returnValue = null;
    return;
  }
  e.returnValue = pendingStorage;
  log("info", `[cetus] migrated ${Object.keys(pendingStorage).length} localStorage items from WebKit`);
  pendingStorage = null;
  try {
    fs.mkdirSync(path.dirname(STORAGE_MIGRATED), { recursive: true });
    fs.writeFileSync(STORAGE_MIGRATED, new Date().toISOString());
  } catch (err) {
    log("warn", "[cetus] could not write storage migration marker", err);
  }
});

ipcMain.handle("cetus:window", (e, method: string, args: unknown) => {
  const label = labelByContents.get(e.sender.id) ?? "main";
  return windowOp(label, method, args);
});

// ---------------------------------------------------------------------------
// Protocols
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".heic": "image/heic",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

function serveFile(file: string, req: Request): Response {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error("not a file");
  } catch {
    return new Response("not found", { status: 404 });
  }
  const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const headers: Record<string, string> = {
    "content-type": type,
    "accept-ranges": "bytes",
    "access-control-allow-origin": "*",
  };
  const range = req.headers.get("range");
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (m && stat.size > 0) {
    let start = m[1] ? Number(m[1]) : NaN;
    let end = m[2] ? Number(m[2]) : stat.size - 1;
    if (Number.isNaN(start)) {
      start = Math.max(0, stat.size - end);
      end = stat.size - 1;
    }
    end = Math.min(end, stat.size - 1);
    if (start > end) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${stat.size}` } });
    }
    const body = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream;
    return new Response(body, {
      status: 206,
      headers: {
        ...headers,
        "content-range": `bytes ${start}-${end}/${stat.size}`,
        "content-length": String(end - start + 1),
      },
    });
  }
  const body = Readable.toWeb(fs.createReadStream(file)) as ReadableStream;
  return new Response(body, { headers: { ...headers, "content-length": String(stat.size) } });
}

function registerProtocols() {
  // `asset://localhost/<encodeURIComponent(absolutePath)>` — local file
  // previews (convertFileSrc).
  protocol.handle("asset", (req) => {
    const u = new URL(req.url);
    const file = decodeURIComponent(u.pathname.replace(/^\//, ""));
    return serveFile(file, req);
  });
  // `app://cetus/…` — the static frontend export in packaged builds.
  protocol.handle("app", (req) => {
    const out = path.join(ROOT, "out");
    const rel = decodeURIComponent(new URL(req.url).pathname);
    const candidates = [rel, `${rel}.html`, path.join(rel, "index.html")];
    for (const c of candidates) {
      const file = path.join(out, c);
      if (file.startsWith(out) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return serveFile(file, req);
      }
    }
    return serveFile(path.join(out, "index.html"), req);
  });
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function menuEvent(id: string) {
  native.appEvent("menu", JSON.stringify(id));
}

function buildMenu() {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        // Our own Quit (not the `quit` role) so a stray Cmd+Q goes through
        // the backend's "Quit Cetus?" confirmation.
        { label: `Quit ${app.name}`, accelerator: "CmdOrCtrl+Q", click: () => menuEvent("app_quit") },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => menuEvent("view_reload") },
        ...(isDev ? ([{ role: "toggleDevTools" }] as MenuItemConstructorOptions[]) : []),
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }, { type: "separator" }, { role: "front" }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    native?.appEvent("reopen", JSON.stringify({ hasVisibleWindows: false }));
  });

  // The app menu's Quit goes straight to the backend's "Quit Cetus?" prompt
  // (`app_quit`), so a quit arriving here came from outside — Dock menu,
  // logout/shutdown, AppleScript, SIGTERM. Don't hold those behind a modal;
  // just run the exit cleanup.
  app.on("before-quit", (e) => {
    if (quitting) return;
    e.preventDefault();
    finalExit(0);
  });
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => finalExit(0));
  }

  app.on("activate", (_e, hasVisibleWindows) => {
    native?.appEvent("reopen", JSON.stringify({ hasVisibleWindows }));
  });

  // Resident app: closing windows never quits.
  app.on("window-all-closed", () => {});

  app.whenReady().then(() => {
    registerProtocols();
    native = loadNative();
    native.init(
      host,
      JSON.stringify({
        identifier: IDENTIFIER,
        productName: "Cetus",
        version: app.getVersion(),
        resourceDir: isDev ? path.join(ROOT, "backend") : process.resourcesPath,
        devUrl: isDev ? DEV_URL : null,
        isDev,
      }),
    );

    for (const spec of APP_WINDOWS) createAppWindow(spec.label, spec.options);
    buildMenu();

    try {
      native.start();
    } catch (e) {
      log("error", "[cetus] backend start failed", e);
      dialog.showErrorBox("Cetus failed to start", String(e));
      app.exit(1);
      return;
    }

    log("info", `[cetus] backend started; loading ${APP_URL} into ${windows.size} windows`);
    for (const [label, win] of windows) loadApp(label, win);
    const main = windows.get("main");
    if (main && !AUTOSTART) {
      main.once("ready-to-show", () => {
        if (!main.isVisible()) main.show();
      });
    }
  });
}
