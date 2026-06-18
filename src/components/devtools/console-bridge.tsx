"use client";
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

/// Forward webview console errors + uncaught exceptions to the Rust tracing
/// stream so a single terminal tails everything. Hooks once on mount; safe to
/// keep in production (silent on non-Tauri builds because invoke just rejects).
export function ConsoleBridge() {
  useEffect(() => {
    const send = (level: string, msg: string) => {
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
