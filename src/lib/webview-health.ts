"use client";

import { api } from "./tauri";

const HEARTBEAT_INTERVAL_MS = 3_000;

/** Keep the native watchdog informed that the main renderer is alive. Focus,
 * pageshow, and visibility hooks also run the cheap native wake repair so a
 * resumed WKWebView refreshes cursor tracking before the first user click. */
export function installWebviewHealthMonitor(): () => void {
  let sequence = 0;
  let disposed = false;

  const beat = () => {
    if (disposed || document.visibilityState !== "visible") return;
    sequence += 1;
    void api.webviewHeartbeat(sequence).catch(() => {});
  };
  const wake = () => {
    if (disposed || document.visibilityState !== "visible") return;
    void api.wakeMainWebview().catch(() => {});
    beat();
  };
  const onVisibility = () => {
    if (document.visibilityState === "visible") wake();
  };

  wake();
  const timer = window.setInterval(beat, HEARTBEAT_INTERVAL_MS);
  window.addEventListener("focus", wake);
  window.addEventListener("pageshow", wake);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    disposed = true;
    window.clearInterval(timer);
    window.removeEventListener("focus", wake);
    window.removeEventListener("pageshow", wake);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
