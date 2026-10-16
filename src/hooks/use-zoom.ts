"use client";
import { useEffect } from "react";

const KEY = "cetus:zoom";
/** Emitted with the new zoom level (e.g. 1.25) whenever ⌘+/⌘−/⌘0 fires. */
export const ZOOM_EVENT = "cetus:zoom";

// The standard browser zoom ladder (matches Chrome/Safari): steps widen as you
// go, so it's 90 → 100 → 110 → 125 → 150 rather than a flat +10 each press.
const LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const MIN = LEVELS[0];
const MAX = LEVELS[LEVELS.length - 1];

// How long after a zoom lands we keep bottom-pinned scrollers pinned while
// virtual lists re-measure their rows at the new size.
const SETTLE_MS = 400;
// If the webview never reports a resize (zoom rounded to the same CSS width),
// restore anyway after this long.
const FALLBACK_MS = 250;

interface ScrollAnchor {
  el: HTMLElement;
  top: number;
  bottom: boolean;
}

/**
 * Where every scrolled pane sits right now. A zoom change re-lays out all
 * content at once, but each scroller keeps its old offset for the first frame,
 * so a tail-following chat paints mid-history and only snaps back to the
 * bottom a frame later (its follow runs in rAF). Recording the anchor up front
 * lets us put every pane back before that first frame is painted.
 */
function captureAnchors(): ScrollAnchor[] {
  const anchors: ScrollAnchor[] = [];
  for (const el of document.body.querySelectorAll<HTMLElement>("*")) {
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    const { overflowY } = getComputedStyle(el);
    if (overflowY !== "auto" && overflowY !== "scroll") continue;
    anchors.push({
      el,
      top: el.scrollTop,
      bottom: el.scrollHeight - el.scrollTop - el.clientHeight <= 2,
    });
  }
  return anchors;
}

function restoreAnchors(anchors: ScrollAnchor[], bottomOnly = false) {
  for (const a of anchors) {
    if (!a.el.isConnected) continue;
    if (a.bottom) a.el.scrollTop = a.el.scrollHeight;
    else if (!bottomOnly) a.el.scrollTop = a.top;
  }
}

/** In-flight zoom change; a rapid second press reuses its anchors. */
let pending: {
  anchors: ScrollAnchor[];
  cancel: () => void;
} | null = null;
let settling: (() => void) | null = null;

function setNativeZoom(z: number): Promise<void> {
  // Prefer the webview's *native* zoom: it scales like real browser zoom, so
  // viewport units and getBoundingClientRect stay consistent and Radix/
  // floating-ui popovers (Select, dropdowns, tooltips) anchor correctly.
  //
  // The CSS `zoom` property — what we used before — is NOT understood by
  // floating-ui: the trigger's rect comes back pre-scaled while the portaled
  // content (in <body>, also zoomed) re-applies the scale, so panels drift away
  // from their trigger proportionally to the zoom level.
  return import("@tauri-apps/api/webview")
    .then(({ getCurrentWebview }) => getCurrentWebview().setZoom(z))
    .catch(() => {
      // Browser / non-Tauri fallback (e.g. plain dev server): CSS zoom is the
      // only lever available. Popovers may drift here, but the desktop app uses
      // the native path above.
      document.documentElement.style.setProperty("zoom", String(z));
      document.documentElement.style.setProperty("--zoom", String(z));
      window.dispatchEvent(new Event("resize"));
    });
}

/**
 * Zoom to `z` without the content jumping: anchors are captured now and put
 * back inside the `resize` the webview fires when the new zoom is laid out —
 * that runs before the frame is painted, so no frame shows stale offsets.
 * `onApplied` runs at the same moment (the HUD shows in sync with the zoom).
 */
function apply(z: number, onApplied?: () => void) {
  const anchors = pending?.anchors ?? captureAnchors();
  pending?.cancel();
  settling?.();

  let done = false;
  const land = () => {
    if (done) return;
    done = true;
    pending?.cancel();
    pending = null;
    restoreAnchors(anchors);
    onApplied?.();
    settle(anchors);
  };
  const timer = window.setTimeout(land, FALLBACK_MS);
  window.addEventListener("resize", land);
  pending = {
    anchors,
    cancel: () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", land);
    },
  };
  void setNativeZoom(z);
}

/**
 * Hold bottom-pinned panes at the bottom while rows re-measure: virtual lists
 * resize their spacers over the next few frames, which would otherwise nudge
 * the tail away again. Any user scroll gesture ends it immediately.
 */
function settle(anchors: ScrollAnchor[]) {
  const pinned = anchors.filter((a) => a.bottom && a.el.isConnected);
  if (pinned.length === 0) return;
  const repin = () => restoreAnchors(pinned, true);
  const ro = new ResizeObserver(repin);
  for (const a of pinned) {
    ro.observe(a.el);
    for (const child of a.el.children) ro.observe(child);
  }
  let frame = requestAnimationFrame(function tick() {
    repin();
    frame = requestAnimationFrame(tick);
  });
  const stop = () => {
    ro.disconnect();
    cancelAnimationFrame(frame);
    window.clearTimeout(timer);
    window.removeEventListener("wheel", stop, true);
    window.removeEventListener("pointerdown", stop, true);
    if (settling === stop) settling = null;
  };
  const timer = window.setTimeout(stop, SETTLE_MS);
  window.addEventListener("wheel", stop, { capture: true, passive: true });
  window.addEventListener("pointerdown", stop, { capture: true, passive: true });
  settling = stop;
}

function clamp(z: number) {
  return Math.min(MAX, Math.max(MIN, Math.round(z * 100) / 100));
}

/** Next ladder rung strictly above `z` (or the max if already at/above top). */
function stepUp(z: number) {
  return LEVELS.find((l) => l > z + 1e-6) ?? MAX;
}

/** Next ladder rung strictly below `z` (or the min if already at/below bottom). */
function stepDown(z: number) {
  return [...LEVELS].reverse().find((l) => l < z - 1e-6) ?? MIN;
}

/** Cmd/Ctrl + (=/+/-/0) zooms the whole webview content. Persisted to localStorage. */
export function useZoom() {
  useEffect(() => {
    const initial = clamp(Number(localStorage.getItem(KEY)) || 1);
    void setNativeZoom(initial);

    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      let next: number | null = null;
      const current = clamp(Number(localStorage.getItem(KEY)) || 1);
      if (e.key === "=" || e.key === "+") next = stepUp(current);
      else if (e.key === "-" || e.key === "_") next = stepDown(current);
      else if (e.key === "0") next = 1;
      if (next == null) return;
      e.preventDefault();
      const z = next;
      // Let the transient HUD (ZoomHud) show the new level as a percentage —
      // once the zoom is actually on screen, not a frame ahead of it.
      const announce = () =>
        window.dispatchEvent(new CustomEvent(ZOOM_EVENT, { detail: z }));
      if (z === current) return announce(); // already at the end of the ladder
      localStorage.setItem(KEY, String(z));
      apply(z, announce);
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
