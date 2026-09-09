"use client";
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { elementScroll, useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";

export interface ChatListSnapshot {
  scrollTop: number;
  measurements: VirtualItem[];
}
export interface ChatListHandle {
  scrollToIndex: (target: { index: number | "LAST"; align?: "start" | "center" | "end" }) => void;
  getState: (receive: (state: ChatListSnapshot) => void) => void;
  cancelScroll: () => void;
}

/** Variable-height virtualization only. Tail following belongs to the chat's
 * intent controller, and measurement corrections only anchor rows ABOVE the
 * viewport. Growing an answer below the reader must never move scrollTop. */
export function ChatVirtualList<T>({
  ref, data, itemContent, itemKey, scrollerRef, initialState, onRangeChange,
  onBottomChange, onHeightChange, className,
}: {
  ref?: Ref<ChatListHandle>;
  data: T[];
  itemContent: (index: number, item: T) => ReactNode;
  itemKey: (index: number, item: T) => string;
  scrollerRef: (element: HTMLElement | null) => void;
  initialState?: ChatListSnapshot;
  onRangeChange: (startIndex: number) => void;
  onBottomChange: (atBottom: boolean) => void;
  onHeightChange: () => void;
  className?: string;
}) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const seekAllowed = useRef(true);
  const setRef = useCallback((element: HTMLDivElement | null) => {
    setScroller(element);
    scrollerRef(element);
  }, [scrollerRef]);
  const getItemKey = useCallback((index: number) => itemKey(index, data[index]), [data, itemKey]);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: data.length,
    getScrollElement: () => scroller,
    getItemKey,
    estimateSize: () => 320,
    overscan: 2,
    paddingStart: 16,
    initialOffset: initialState?.scrollTop ?? Math.max(0, data.length * 320 - 500),
    initialMeasurementsCache: initialState?.measurements,
    // Let React batch resize notifications instead of recursively flushing
    // whole assistant turns while their markdown/activities are settling.
    useFlushSync: false,
    scrollToFn: (offset, options, instance) => {
      // scrollToIndex can reconcile after a measurement. An upward gesture
      // invalidates that seek too, not just the next automatic follow frame.
      if (seekAllowed.current || options.adjustments !== undefined) {
        elementScroll(offset, options, instance);
      }
    },
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    item.end <= (instance.scrollElement?.scrollTop ?? 0);

  useImperativeHandle(ref, () => ({
    scrollToIndex: ({ index, align = "start" }) => {
      seekAllowed.current = true;
      // Smooth seeks and dynamic row measurement have competing targets.
      virtualizer.scrollToIndex(index === "LAST" ? data.length - 1 : index, { align, behavior: "auto" });
    },
    cancelScroll: () => { seekAllowed.current = false; },
    getState: (receive) => receive({
      scrollTop: scroller?.scrollTop ?? 0,
      measurements: virtualizer.takeSnapshot(),
    }),
  }), [data.length, scroller, virtualizer]);

  const opened = useRef(false);
  useLayoutEffect(() => {
    if (!scroller || opened.current || data.length === 0) return;
    opened.current = true;
    if (!initialState) virtualizer.scrollToIndex(data.length - 1, { align: "end" });
  }, [data.length, initialState, scroller, virtualizer]);

  const rows = virtualizer.getVirtualItems();
  const totalHeight = virtualizer.getTotalSize();
  const startIndex = virtualizer.range?.startIndex ?? 0;
  useEffect(() => { onRangeChange(startIndex); }, [onRangeChange, startIndex]);
  useEffect(() => { onHeightChange(); }, [onHeightChange, totalHeight]);
  useEffect(() => {
    if (!scroller) return;
    const update = () => onBottomChange(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 32);
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    return () => { observer.disconnect(); scroller.removeEventListener("scroll", update); };
  }, [onBottomChange, scroller, totalHeight]);

  return (
    <div ref={setRef} data-testid="message-list" tabIndex={0} className={className}
      style={{ overflowY: "auto", overflowAnchor: "none", position: "relative", outline: "none" }}>
      <div data-chat-list-content style={{ height: totalHeight, position: "relative", width: "100%" }}>
        {rows.map(row => (
          <div key={row.key} ref={virtualizer.measureElement} data-index={row.index}
            style={{ position: "absolute", top: row.start, left: 0, width: "100%" }}>
            {itemContent(row.index, data[row.index])}
          </div>
        ))}
      </div>
    </div>
  );
}
