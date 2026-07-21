"use client";
import { useCallback, useEffect, useState } from "react";
import { Square } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { api, onAppEvent } from "@/lib/tauri";
import { formatElapsed } from "@/lib/format";
import { tt } from "@/lib/i18n";

/** The floating meeting-recording pill. The component IS the pill — it floats
 *  in its transparent `meeting` window (a never-key panel the backend shows at
 *  the top-center of the screen while a session is live, mirroring the macOS
 *  screen-recording indicator). Pulsing red dot + elapsed timer + one-click
 *  stop; the whole capsule is a drag region so it can be moved out of the way.
 *  Visibility is owned by the backend, so a recording is never on screen
 *  without its indicator. */
export function MeetingHud() {
  const [startedTs, setStartedTs] = useState<number | null>(null);
  const [stopping, setStopping] = useState(false);
  // 1s re-render tick driving the timer — elapsed derives locally from
  // startedTs, so ticking costs no IPC.
  const [, setTick] = useState(0);

  // Clear the opaque app body so only the capsule is visible.
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prevHtml = html.style.background;
    const prevBody = body.style.background;
    html.style.background = "transparent";
    body.style.background = "transparent";
    return () => {
      html.style.background = prevHtml;
      body.style.background = prevBody;
    };
  }, []);

  const refresh = useCallback(() => {
    api
      .meetingStatus()
      .then((s) => {
        setStartedTs(s.recording ? (s.startedTs ?? Date.now()) : null);
        if (!s.recording) setStopping(false);
      })
      .catch(() => {});
  }, []);

  // The webview persists hidden between sessions — sync off the backend's
  // session events instead of polling while invisible.
  useEffect(() => {
    refresh();
    let unlisten: (() => void) | undefined;
    onAppEvent((e) => {
      if (e.type === "meeting_event") refresh();
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, [refresh]);

  useEffect(() => {
    if (startedTs === null) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [startedTs]);

  if (startedTs === null) return null;

  const elapsed = formatElapsed(startedTs);

  async function onStop() {
    setStopping(true);
    try {
      await api.meetingStop();
    } catch {
      setStopping(false);
    }
  }

  return (
    <div
      data-tauri-drag-region
      className="flex h-screen w-screen items-center justify-center"
    >
      <div
        data-tauri-drag-region
        className="flex h-8 items-center gap-2 rounded-full bg-black pl-3 pr-1.5 shadow-[0_2px_10px_rgba(0,0,0,0.45)]"
      >
        <span className="pointer-events-none relative flex size-2 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-60" />
          <span className="relative inline-flex size-2 rounded-full bg-destructive" />
        </span>
        <span className="pointer-events-none text-xs font-medium tabular-nums text-white">
          {elapsed}
        </span>
        <button
          type="button"
          onClick={onStop}
          disabled={stopping}
          aria-label={tt("meeting", "action.stop")}
          title={tt("meeting", "action.stop")}
          className="flex size-5.5 shrink-0 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/15 hover:text-white"
        >
          {stopping ? (
            <Spinner className="size-3" />
          ) : (
            <Square className="size-2.5 fill-current" />
          )}
        </button>
      </div>
    </div>
  );
}
