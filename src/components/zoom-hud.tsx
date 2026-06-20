"use client";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { ZOOM_EVENT } from "@/hooks/use-zoom";

/**
 * Transient zoom indicator. Listens for the `cetus:zoom` event fired by
 * {@link useZoom} on ⌘+/⌘−/⌘0 and flashes the current level as a centered
 * percentage pill, then fades out after a beat.
 */
export function ZoomHud() {
  const [pct, setPct] = useState<number | null>(null);
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function onZoom(e: Event) {
      const z = (e as CustomEvent<number>).detail;
      setPct(Math.round(z * 100));
      setVisible(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setVisible(false), 900);
    }
    window.addEventListener(ZOOM_EVENT, onZoom);
    return () => {
      window.removeEventListener(ZOOM_EVENT, onZoom);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  if (pct == null) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-[100] flex items-center justify-center">
      <div
        className={cn(
          "rounded-xl bg-foreground/90 px-5 py-3 text-lg tabular-nums text-background shadow-lg backdrop-blur-sm",
          "transition-opacity duration-200 ease-out",
          visible ? "opacity-100" : "opacity-0",
        )}
      >
        {pct}%
      </div>
    </div>
  );
}
