"use client";
// Makes the whole window a drop target for files, so dropping a file on the
// transcript, the sidebar or the launcher attaches it to whatever composer is
// on screen — not just the ~60px of composer that used to (nominally) accept
// drops.
//
// The drop has to be read from the Tauri runtime rather than from HTML5 `drop`
// events: the runtime installs its own drag-drop handler on the webview and
// answers the OS itself, so the webview never sees a `drop` with files on it.
// That is also why the composer's own HTML5 handlers were dead code. The
// upside is that these events carry real filesystem paths, which lets a file
// too large to inline be referenced by path instead of dropped on the floor.
//
// Routing: whichever `[data-file-drop-target]` is visible takes the drop, last
// one in DOM order first so a portalled dialog's composer beats the chat
// composer behind it. There is at most one visible target per window in
// practice (hero and docked composers are mutually exclusive).
import { useEffect } from "react";

/** Fired on the target while a file drag hovers the window; detail = active. */
export const FILE_DRAG_EVENT = "cetus-file-drag";
/** Fired on the target when files are dropped; detail = absolute paths. */
export const FILE_DROP_EVENT = "cetus-file-drop";

function dropTarget(): HTMLElement | null {
  const targets = Array.from(
    document.querySelectorAll<HTMLElement>("[data-file-drop-target]"),
  ).filter((el) => el.getClientRects().length > 0);
  return targets[targets.length - 1] ?? null;
}

export function FileDropHost() {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // The target highlighted right now, so the highlight is always cleared on
    // the element that received it even if the layout changed mid-drag.
    let active: HTMLElement | null = null;
    // `over` events carry no paths, so remember whether this drag has any.
    let dragHasFiles = false;

    const highlight = (el: HTMLElement | null) => {
      if (active === el) return;
      active?.dispatchEvent(new CustomEvent(FILE_DRAG_EVENT, { detail: false }));
      el?.dispatchEvent(new CustomEvent(FILE_DRAG_EVENT, { detail: true }));
      active = el;
    };

    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent(({ payload }) => {
          if (payload.type === "enter") {
            dragHasFiles = payload.paths.length > 0;
            if (dragHasFiles) highlight(dropTarget());
            return;
          }
          if (payload.type === "over") {
            // Re-resolve on every hover: the composer can appear mid-drag (the
            // first message of a new chat swaps hero for docked).
            if (dragHasFiles) highlight(dropTarget());
            return;
          }
          if (payload.type === "drop") {
            const target = active ?? dropTarget();
            highlight(null);
            dragHasFiles = false;
            if (!payload.paths.length || !target) return;
            target.dispatchEvent(
              new CustomEvent(FILE_DROP_EVENT, { detail: payload.paths }),
            );
            return;
          }
          highlight(null);
          dragHasFiles = false;
        }),
      )
      .then((off) => {
        // Unmounted before the listener resolved — drop it immediately.
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {
        // Not running under Tauri (or the webview is gone): no drops to route.
      });

    return () => {
      disposed = true;
      highlight(null);
      unlisten?.();
    };
  }, []);
  return null;
}
