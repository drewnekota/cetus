"use client";
import { useEffect, useState } from "react";
import { QuickPanel } from "@/components/quick/quick-panel";
import { VoiceHud } from "@/components/quick/voice-hud";
import { MeetingHud } from "@/components/quick/meeting-hud";
import { Toaster } from "@/components/ui/sonner";

/** cetus runs two webviews off one static bundle: the full app (`main`) and the
 *  frameless global launcher (`quick`). Render the launcher only in the quick
 *  window so the main app's effects — and its single `quick-launch` listener —
 *  never mount twice.
 *
 *  The label is resolved in an effect (not synchronously) so the static export
 *  and the first client render both return `null` — no hydration mismatch — and
 *  the heavy main tree mounts a microtask later in the main window only. */
export function WindowRouter({ children }: { children: React.ReactNode }) {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => {
        if (alive) setLabel(getCurrentWindow().label);
      })
      .catch(() => {
        if (alive) setLabel("main");
      });
    return () => {
      alive = false;
    };
  }, []);

  if (label === null) return null;
  if (label === "quick") return <QuickPanel />;
  if (label === "voice") return <VoiceHud />;
  if (label === "meeting") return <MeetingHud />;
  // Main window only: toasts (e.g. a notification pointing at a deleted chat).
  return (
    <>
      {children}
      <Toaster />
    </>
  );
}
