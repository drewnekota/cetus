"use client";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/tauri";

/** Region-select overlay for the contextful quick launcher: the `snip` window
 *  covers the cursor's screen (sized by Rust, see snip.rs) as a dimmed sheet.
 *  Drag to select the region to capture, click for the full screen, Esc to
 *  cancel. Coordinates go back to Rust in CSS pixels (== AppKit points)
 *  relative to this window; Rust maps them into global screen space. */

/** Drags smaller than this on either axis count as a click (= full screen). */
const CLICK_SLOP = 4;

type Drag = { x0: number; y0: number; x1: number; y1: number };

export function SnipOverlay() {
  const [drag, setDrag] = useState<Drag | null>(null);
  // One outcome per open: pointer-up, Esc, and a re-open all race on the same
  // overlay, so the first finish/cancel wins until the next `snip-open`.
  const doneRef = useRef(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    listen("snip-open", () => {
      doneRef.current = false;
      setDrag(null);
    }).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || doneRef.current) return;
      doneRef.current = true;
      setDrag(null);
      void api.snipCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const finish = useCallback((d: Drag) => {
    if (doneRef.current) return;
    doneRef.current = true;
    setDrag(null);
    const x = Math.round(Math.min(d.x0, d.x1));
    const y = Math.round(Math.min(d.y0, d.y1));
    const w = Math.round(Math.abs(d.x1 - d.x0));
    const h = Math.round(Math.abs(d.y1 - d.y0));
    // A (near-)click means "the whole screen".
    void api.snipFinish(w > CLICK_SLOP && h > CLICK_SLOP ? { x, y, w, h } : null);
  }, []);

  const sel =
    drag === null
      ? null
      : {
          left: Math.min(drag.x0, drag.x1),
          top: Math.min(drag.y0, drag.y1),
          width: Math.abs(drag.x1 - drag.x0),
          height: Math.abs(drag.y1 - drag.y0),
        };
  const selecting =
    sel !== null && sel.width > CLICK_SLOP && sel.height > CLICK_SLOP;

  return (
    <div
      className="fixed inset-0 cursor-crosshair select-none"
      onPointerDown={(e) => {
        if (e.button !== 0 || doneRef.current) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
      }}
      onPointerMove={(e) => {
        if (doneRef.current) return;
        setDrag((d) => (d ? { ...d, x1: e.clientX, y1: e.clientY } : d));
      }}
      onPointerUp={(e) => {
        if (e.button === 0 && drag) finish(drag);
      }}
    >
      {selecting ? (
        // The selection rect; its huge box-shadow dims everything outside it.
        <div
          className="absolute border border-white/90"
          style={{
            left: sel.left,
            top: sel.top,
            width: sel.width,
            height: sel.height,
            boxShadow: "0 0 0 100000px rgba(0, 0, 0, 0.35)",
          }}
        >
          <div className="absolute right-0 top-full mt-1.5 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[11px] leading-none text-white/90">
            {Math.round(sel.width)} × {Math.round(sel.height)}
          </div>
        </div>
      ) : (
        <div className="absolute inset-0 bg-black/25">
          <div className="absolute left-1/2 top-10 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/75 px-3.5 py-1.5 text-xs text-white/90 shadow-lg">
            Drag to select an area · Click for the full screen · Esc to cancel
          </div>
        </div>
      )}
    </div>
  );
}
