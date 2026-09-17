"use client";

import {
  useCallback,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

const SIDEBAR_WIDTH_KEY = "cetus.sidebar-width";

const SIDEBAR_MIN_WIDTH = 180;

const SIDEBAR_MAX_WIDTH = 420;

const SIDEBAR_DEFAULT_WIDTH = 224;

// 14rem, matches the prior fixed width

function clampWidth(w: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, w));
}

/** Drag-to-resize state for the sidebar, persisted to localStorage. Width is in
 *  px and clamped to [MIN, MAX]; double-click the handle to reset to default. */
export function useSidebarWidth() {
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === "undefined") return SIDEBAR_DEFAULT_WIDTH;
    const saved = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return saved > 0 ? clampWidth(saved) : SIDEBAR_DEFAULT_WIDTH;
  });

  const persist = useCallback((w: number) => {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w));
    } catch {}
  }, []);

  const startResize = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      let startWidth = SIDEBAR_DEFAULT_WIDTH;
      let latest = startWidth;
      // Read the live width off the rendered sidebar so the drag starts from
      // wherever it currently sits, even mid-animation.
      const root = e.currentTarget.parentElement;
      if (root) startWidth = latest = root.getBoundingClientRect().width;

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (ev: PointerEvent) => {
        latest = clampWidth(startWidth + (ev.clientX - startX));
        setWidth(latest);
      };
      const onUp = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        persist(latest);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [persist],
  );

  const resetWidth = useCallback(() => {
    setWidth(SIDEBAR_DEFAULT_WIDTH);
    persist(SIDEBAR_DEFAULT_WIDTH);
  }, [persist]);

  return { width, startResize, resetWidth };
}

export function SidebarResizeHandle({
  onResizeStart,
  onReset,
}: {
  onResizeStart: (e: ReactPointerEvent<HTMLElement>) => void;
  onReset: () => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onResizeStart}
      onDoubleClick={onReset}
      className="group/resize absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none select-none"
    >
      {/* 1px line straddling the edge; brightens on hover/drag for affordance. */}
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover/resize:bg-sidebar-border group-active/resize:bg-sidebar-border" />
    </div>
  );
}
