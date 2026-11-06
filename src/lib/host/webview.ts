// The current window's web contents: zoom + OS file drag-and-drop.

import { bridge } from "./bridge";
import type { Event, UnlistenFn } from "./event";

export type DragDropEvent =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

class CurrentWebview {
  async setZoom(z: number): Promise<void> {
    bridge().setZoom(z);
  }

  /** OS file drags over the window, with real filesystem paths on drop.
   *  `enter` reports one placeholder entry per dragged item (paths are only
   *  readable at drop time). */
  async onDragDropEvent(handler: (event: Event<DragDropEvent>) => void): Promise<UnlistenFn> {
    const b = bridge();
    let depth = 0;
    const emit = (payload: DragDropEvent) => handler({ event: "drag-drop", id: 0, payload });
    const pos = (e: DragEvent) => ({ x: e.clientX, y: e.clientY });
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (depth++ === 0) {
        const n = Math.max(1, e.dataTransfer?.items.length ?? 1);
        emit({ type: "enter", paths: Array.from({ length: n }, () => ""), position: pos(e) });
      }
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      emit({ type: "over", position: pos(e) });
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      if (--depth <= 0) {
        depth = 0;
        emit({ type: "leave" });
      }
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      const paths = Array.from(e.dataTransfer?.files ?? [])
        .map((f) => b.pathForFile(f))
        .filter(Boolean);
      emit({ type: "drop", paths, position: pos(e) });
    };
    window.addEventListener("dragenter", enter, true);
    window.addEventListener("dragover", over, true);
    window.addEventListener("dragleave", leave, true);
    window.addEventListener("drop", drop, true);
    return () => {
      window.removeEventListener("dragenter", enter, true);
      window.removeEventListener("dragover", over, true);
      window.removeEventListener("dragleave", leave, true);
      window.removeEventListener("drop", drop, true);
    };
  }
}

export function getCurrentWebview(): CurrentWebview {
  bridge();
  return new CurrentWebview();
}
