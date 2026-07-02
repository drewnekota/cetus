"use client";
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

/// Forward webview console errors + uncaught exceptions to the Rust tracing
/// stream so a single terminal tails everything. Hooks once on mount; safe to
/// keep in production (silent on non-Tauri builds because invoke just rejects).
export function ConsoleBridge() {
  useEffect(() => {
    // Rate-limit the IPC: a component that warns in a render loop (or KaTeX
    // grumbling mid-stream) would otherwise turn every console call into a
    // Tauri round-trip and jank the UI. 20 lines/sec, then dropped with one
    // marker line; the webview console still gets everything.
    const WINDOW_MS = 1000;
    const MAX_PER_WINDOW = 20;
    let windowStart = 0;
    let sentInWindow = 0;
    let droppedInWindow = 0;
    const send = (level: string, msg: string) => {
      const now = Date.now();
      if (now - windowStart > WINDOW_MS) {
        if (droppedInWindow > 0) {
          invoke("log_fe", {
            level: "warn",
            msg: `console-bridge: dropped ${droppedInWindow} log line(s) (rate limit)`,
          }).catch(() => {});
        }
        windowStart = now;
        sentInWindow = 0;
        droppedInWindow = 0;
      }
      if (sentInWindow >= MAX_PER_WINDOW) {
        droppedInWindow++;
        return;
      }
      sentInWindow++;
      invoke("log_fe", { level, msg }).catch(() => {});
    };

    const stringify = (args: unknown[]) =>
      args
        .map((a) => {
          if (a instanceof Error) return `${a.message}\n${a.stack ?? ""}`;
          if (typeof a === "string") return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(" ");

    const origError = console.error;
    const origWarn = console.warn;
    console.error = (...args: unknown[]) => {
      send("error", stringify(args));
      origError.apply(console, args as never[]);
    };
    console.warn = (...args: unknown[]) => {
      send("warn", stringify(args));
      origWarn.apply(console, args as never[]);
    };

    const onError = (e: ErrorEvent) => {
      send("error", `${e.message}\n${e.error?.stack ?? ""} @ ${e.filename}:${e.lineno}:${e.colno}`);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason;
      const text =
        r instanceof Error ? `${r.message}\n${r.stack ?? ""}` : stringify([r]);
      send("error", `unhandledrejection: ${text}`);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);

    return () => {
      console.error = origError;
      console.warn = origWarn;
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
