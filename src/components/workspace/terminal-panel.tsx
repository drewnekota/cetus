"use client";

import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTermTerminal, type ITheme } from "@xterm/xterm";
import { api } from "@/lib/tauri";
import { TerminalRunRequest } from "./workspace-panel";

/* xterm.js keeps a `_keyDownSeen` flag that swallows `input` events arriving
 * after a keydown it didn't handle. Doubao IME's English mode reports
 * keyCode 229 for every keystroke (its AI features intercept even English
 * typing) without ever firing composition events, so past the first character
 * of a fast burst every keystroke lands in that swallowed path and is lost —
 * xtermjs/xterm.js#5887, unfixed upstream as of 6.0. Re-emit `insertText`
 * input events the stock handler declined while no real composition is
 * active. This reaches into private internals, so every access is guarded:
 * if an xterm upgrade renames them we degrade to unpatched behavior rather
 * than crash. */
function patchImeKeycode229Input(terminal: XTermTerminal) {
  const core = (terminal as unknown as { _core?: Record<string, unknown> })
    ._core;
  if (!core) return;
  const original = core._inputEvent;
  const cancel = core.cancel;
  const coreService = core.coreService as
    | { triggerDataEvent?: (data: string, wasUserInput?: boolean) => void }
    | undefined;
  const triggerDataEvent = coreService?.triggerDataEvent?.bind(coreService);
  if (
    typeof original !== "function" ||
    typeof cancel !== "function" ||
    !triggerDataEvent
  ) {
    return;
  }
  core._inputEvent = (event: InputEvent) => {
    if (original.call(core, event)) return true;
    const composing = (
      core._compositionHelper as { _isComposing?: boolean } | undefined
    )?._isComposing;
    if (
      !event.data ||
      event.inputType !== "insertText" ||
      event.isComposing ||
      composing ||
      core._keyPressHandled ||
      terminal.options.screenReaderMode
    ) {
      return false;
    }
    core._unprocessedDeadKey = false;
    triggerDataEvent(event.data, true);
    cancel.call(core, event);
    return true;
  };
}

export function TerminalPanel({
  sessionId,
  workspaceDir,
  visible,
  runRequest,
  focusRequest,
}: {
  sessionId: string;
  workspaceDir: string;
  visible: boolean;
  runRequest?: TerminalRunRequest;
  focusRequest?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTermTerminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const readyRef = useRef<Promise<void>>(Promise.resolve());
  const enqueueWriteRef = useRef<((bytes: Uint8Array) => void) | null>(null);
  const lastRunRequestRef = useRef<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new XTermTerminal({
      allowProposedApi: false,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 10_000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    patchImeKeycode229Input(terminal);
    terminalRef.current = terminal;
    fitRef.current = fit;

    let cancelled = false;
    let unlistenOutput: UnlistenFn | undefined;
    let unlistenExit: UnlistenFn | undefined;

    const ready = (async () => {
      [unlistenOutput, unlistenExit] = await Promise.all([
        listen<TerminalOutputEvent>("terminal-output", (event) => {
          if (event.payload.sessionId !== sessionId) return;
          terminal.write(base64ToBytes(event.payload.dataBase64));
        }),
        listen<TerminalExitEvent>("terminal-exit", (event) => {
          if (event.payload.sessionId !== sessionId) return;
          const { exitCode, signal } = event.payload;
          terminal.writeln(
            `\r\n\x1b[90m[process exited${signal ? `: ${signal}` : ` with code ${exitCode}`}]\x1b[0m`,
          );
        }),
      ]);
      if (cancelled) {
        unlistenOutput();
        unlistenExit();
        return;
      }
      if (host.offsetWidth && host.offsetHeight) fit.fit();
      await api.terminalStart(
        sessionId,
        workspaceDir,
        terminal.cols,
        terminal.rows,
      );
    })().catch((error) => {
      if (!cancelled) {
        terminal.writeln(
          `\r\n\x1b[31mFailed to start terminal: ${String(error)}\x1b[0m`,
        );
      }
    });
    readyRef.current = ready;

    // Keystrokes must reach the PTY in order, but each invoke is an independent
    // IPC request with no cross-request ordering guarantee. Keep exactly one
    // write in flight and coalesce anything typed during the roundtrip into the
    // next batch — this also holds input typed before the shell finishes
    // starting instead of dropping it on "session is not running".
    let pendingInput: Uint8Array[] = [];
    let writeInFlight = false;
    const enqueueWrite = (bytes: Uint8Array) => {
      if (cancelled || bytes.length === 0) return;
      pendingInput.push(bytes);
      if (writeInFlight) return;
      writeInFlight = true;
      void (async () => {
        try {
          await readyRef.current;
        } catch {
          // Start failed; the terminal already shows the error.
        }
        while (!cancelled && pendingInput.length > 0) {
          const batch = pendingInput;
          pendingInput = [];
          const merged = new Uint8Array(
            batch.reduce((total, chunk) => total + chunk.length, 0),
          );
          let offset = 0;
          for (const chunk of batch) {
            merged.set(chunk, offset);
            offset += chunk.length;
          }
          try {
            await api.terminalWrite(sessionId, bytesToBase64(merged));
          } catch {
            break;
          }
        }
        writeInFlight = false;
      })();
    };
    enqueueWriteRef.current = enqueueWrite;

    const encoder = new TextEncoder();
    const inputDisposable = terminal.onData((data) => {
      enqueueWrite(encoder.encode(data));
    });
    const binaryDisposable = terminal.onBinary((data) => {
      enqueueWrite(Uint8Array.from(data, (char) => char.charCodeAt(0)));
    });
    const resizeObserver = new ResizeObserver(() => {
      if (!host.offsetWidth || !host.offsetHeight) return;
      fit.fit();
      void ready
        .then(() => api.terminalResize(sessionId, terminal.cols, terminal.rows))
        .catch(() => {});
    });
    resizeObserver.observe(host);

    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = terminalTheme();
    });
    // `class` flips light/dark; `style` carries the skin's inline seed vars.
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    return () => {
      cancelled = true;
      enqueueWriteRef.current = null;
      resizeObserver.disconnect();
      themeObserver.disconnect();
      inputDisposable.dispose();
      binaryDisposable.dispose();
      unlistenOutput?.();
      unlistenExit?.();
      terminalRef.current = null;
      fitRef.current = null;
      terminal.dispose();
      void api.terminalStop(sessionId).catch(() => {});
    };
  }, [sessionId, workspaceDir]);

  useEffect(() => {
    if (!visible) return;
    window.requestAnimationFrame(() => {
      fitRef.current?.fit();
      const terminal = terminalRef.current;
      if (terminal) {
        void readyRef.current
          .then(() =>
            api.terminalResize(sessionId, terminal.cols, terminal.rows),
          )
          .catch(() => {});
        terminal.focus();
      }
    });
  }, [visible, focusRequest, sessionId]);

  useEffect(() => {
    if (!runRequest || lastRunRequestRef.current === runRequest.id) return;
    lastRunRequestRef.current = runRequest.id;
    if (!runRequest.autoRun) return;
    enqueueWriteRef.current?.(
      new TextEncoder().encode(`${runRequest.command}\r`),
    );
  }, [runRequest, sessionId]);

  return (
    <div
      ref={hostRef}
      className="h-full w-full bg-background px-2 py-1"
      onClick={() => terminalRef.current?.focus()}
    />
  );
}

interface TerminalOutputEvent {
  sessionId: string;
  dataBase64: string;
}

interface TerminalExitEvent {
  sessionId: string;
  exitCode: number;
  signal?: string | null;
}

function terminalTheme(): ITheme {
  // Read the live seed tokens so a custom skin (Settings → Appearance) carries
  // into the terminal instead of the stock surface/ink hexes. xterm needs
  // concrete colors, not var() references.
  const root = document.documentElement;
  const dark = root.classList.contains("dark");
  const css = getComputedStyle(root);
  const seed = (name: string, fallback: string) =>
    css.getPropertyValue(name).trim() || fallback;
  const background = seed("--surface", dark ? "#0f0f11" : "#fcfcfd");
  const foreground = seed("--ink", dark ? "#e3e4e6" : "#1b1b1b");
  return {
    background,
    foreground,
    cursor: foreground,
    selectionBackground: dark ? "#3f3c70" : "#dcd9fa",
  };
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(window.atob(value), (char) => char.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return window.btoa(binary);
}
