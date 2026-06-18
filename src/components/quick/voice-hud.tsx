"use client";
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Loader } from "lucide-react";
import type { VoiceEventPayload } from "@/lib/types";

const BARS = 15;
const MIN_H = 3; // calm baseline height (px) — a flat row of dots when silent
const MAX_H = 20; // tallest the center bar reaches at full volume (px)

// Symmetric bell so the middle bars rise highest and the edges stay short — the
// equalizer reads as one voice "blob" opening from the center, not a flat block.
const ENVELOPE = Array.from({ length: BARS }, (_, i) => {
  const x = (i / (BARS - 1)) * 2 - 1; // -1..1
  return 0.4 + 0.6 * Math.cos((x * Math.PI) / 2);
});
// Fixed per-bar phase offsets so neighbors shimmer independently (adds life)
// instead of pulsing in lockstep.
const PHASE = Array.from({ length: BARS }, (_, i) => (i * 1.7) % (Math.PI * 2));

/** The floating global-dictation capsule. The component IS the pill — it floats,
 *  centered, in its transparent `voice` window (sized in tauri.conf.json), with
 *  no native chrome behind it. While recording it shows only a centered
 *  equalizer that opens vertically with your voice — no live transcript, like
 *  Wispr Flow: raw ASR partials differ from the cleaned final text, and showing
 *  them pulls the user into proofreading mid-sentence. While the cloud
 *  transcript + cleanup are in flight it shows a spinner. */
export function VoiceHud() {
  // True between release and insertion (cloud finalize + AI cleanup).
  const [busy, setBusy] = useState(false);
  // Mirror for the event closures: lets voice-level read the busy phase
  // without re-subscribing on every state change.
  const busyRef = useRef(false);
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  const targetRef = useRef(0); // latest mic energy, 0..1
  const energyRef = useRef(0); // eased energy driving every bar
  const markBusy = (b: boolean) => {
    busyRef.current = b;
    setBusy(b);
  };

  // Clear the opaque app body so only the black capsule is visible.
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

  // Subscriptions + the equalizer animation loop, sharing one closure so the
  // loop can be started on demand and stop itself when idle. The `voice` webview
  // persists hidden between dictations, so a loop that always reschedules would
  // run 60fps for the app's entire lifetime — a real background battery drain.
  // Instead the loop self-stops once there's nothing left to animate (spinner up
  // or bars fully relaxed to baseline in silence) and a fresh mic level restarts
  // it.
  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    let raf = 0;
    let running = false;
    const t0 = performance.now();

    const tick = (now: number) => {
      const t = (now - t0) / 1000;
      const target = targetRef.current;
      const k = target > energyRef.current ? 0.4 : 0.12; // snap open, ease shut
      energyRef.current += (target - energyRef.current) * k;
      const e = energyRef.current;
      for (let i = 0; i < BARS; i++) {
        const el = barsRef.current[i];
        if (!el) continue;
        const shimmer = 0.7 + 0.3 * Math.sin(t * 8 + PHASE[i]);
        const h = MIN_H + e * ENVELOPE[i] * shimmer * (MAX_H - MIN_H);
        el.style.height = `${h.toFixed(1)}px`;
      }
      // Park the loop when the spinner is showing (bars unmounted) or the
      // equalizer has eased back to its flat baseline in silence. voice-level
      // restarts it.
      if (cancelled || busyRef.current || (target === 0 && e < 0.002)) {
        running = false;
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    const startLoop = () => {
      if (running || cancelled) return;
      running = true;
      raf = requestAnimationFrame(tick);
    };

    const sub = async (
      name: string,
      handler: (p: VoiceEventPayload) => void,
    ) => {
      const un = await listen<VoiceEventPayload>(name, (e) => {
        if (e.payload.target !== "global") return;
        handler(e.payload);
      });
      if (cancelled) un();
      else unlisteners.push(un);
    };
    sub("voice-ready", () => {
      markBusy(false);
      targetRef.current = 0;
      startLoop(); // settle the bars to baseline, then self-park
    });
    // Fired by show_hud just before the window appears: the webview persists
    // hidden between sessions, so the previous dictation's spinner state
    // must be wiped before it can flash.
    sub("voice-reset", () => {
      markBusy(false);
      targetRef.current = 0;
      startLoop();
    });
    // Post-release processing in flight: swap the equalizer for a spinner. The
    // loop self-parks on the next frame (busyRef gates it).
    sub("voice-transcribing", () => {
      markBusy(true);
      targetRef.current = 0;
    });
    sub("voice-level", (p) => {
      // Drives the bars' amplitude while recording. The mic helper keeps
      // draining buffered level lines for a beat AFTER release, so a level
      // must never clear the spinner — it would flip the HUD back to the
      // equalizer for the whole cleanup wait. Busy is reliably cleared by
      // voice-reset/voice-ready at the next session start instead.
      if (busyRef.current) return;
      targetRef.current = Math.min(1, Math.max(0, p.level ?? 0));
      startLoop(); // wake the loop if it parked during silence
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      unlisteners.forEach((u) => u());
    };
  }, []);

  return (
    // A clean black capsule, centered in the transparent voice window.
    <div className="flex h-screen w-screen items-center justify-center">
      <div className="flex h-7 items-center justify-center gap-2 rounded-full bg-black px-3 shadow-[0_2px_10px_rgba(0,0,0,0.45)]">
        {busy ? (
          <Loader className="size-3.5 shrink-0 animate-spin text-white" />
        ) : (
          <span className="flex shrink-0 items-center gap-[2px]">
            {Array.from({ length: BARS }).map((_, i) => (
              <span
                key={i}
                ref={(el) => {
                  barsRef.current[i] = el;
                }}
                // items-center centers each bar, so growing height opens it up
                // AND down from the midline — a symmetric equalizer.
                className="w-[2px] rounded-full bg-white"
                style={{ height: `${MIN_H}px` }}
              />
            ))}
          </span>
        )}
      </div>
    </div>
  );
}
