/** Cancellable, intent-driven tail following shared by all chat surfaces. */
export function bindChatTailScroll(
  scroller: HTMLElement,
  options: {
    isFollowing: () => boolean;
    setFollowing: (following: boolean) => void;
    isSearching: () => boolean;
    onRelease: () => void;
  },
): { schedule: () => void; dispose: () => void } {
  let previousTop = scroller.scrollTop;
  let downwardIntentAt = Number.NEGATIVE_INFINITY;
  let touchY: number | null = null;
  let frame: number | null = null;
  const release = () => {
    downwardIntentAt = Number.NEGATIVE_INFINITY;
    options.setFollowing(false);
    options.onRelease();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
  const schedule = () => {
    if (!options.isFollowing() || options.isSearching() || frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      // Intent can change between ResizeObserver delivery and this frame.
      if (options.isFollowing() && !options.isSearching()) {
        scroller.scrollTop = scroller.scrollHeight;
        previousTop = scroller.scrollTop;
      }
    });
  };
  const onScroll = () => {
    const top = scroller.scrollTop;
    // Offset changes alone do not imply user intent: measuring an estimated
    // row or collapsing content can legitimately move the offset upward.
    // A queued programmatic scroll, layout shrink, or a sub-pixel/no-op scroll
    // must never undo an upward gesture, even inside the at-bottom threshold.
    // Native scrolling and the final token's layout can land in the same frame
    // (notably WebKit). Allow a small bottom tolerance ONLY after recent,
    // deliberate downward movement; never use proximity to undo upward intent.
    if (performance.now() - downwardIntentAt <= 1000 && top > previousTop &&
        scroller.scrollHeight - top - scroller.clientHeight <= 24) {
      options.setFollowing(true);
      downwardIntentAt = Number.NEGATIVE_INFINITY;
      schedule();
    }
    previousTop = top;
  };
  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey) return; // pinch zoom is not a reading gesture
    if (event.deltaY < 0) release();
    else if (event.deltaY > 0) downwardIntentAt = performance.now();
  };
  const onTouchStart = (event: TouchEvent) => {
    touchY = event.touches[0]?.clientY ?? null;
  };
  const onTouchMove = (event: TouchEvent) => {
    const next = event.touches[0]?.clientY;
    if (touchY !== null && next !== undefined) {
      if (next > touchY) release();
      else if (next < touchY) downwardIntentAt = performance.now();
    }
    touchY = next ?? touchY;
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (event.defaultPrevented || target?.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (event.key === " " && target?.closest('button, [role="button"], a[href]')) return;
    if (["ArrowUp", "PageUp", "Home"].includes(event.key) ||
        (event.key === " " && event.shiftKey)) release();
    else if (["ArrowDown", "PageDown", "End", " "].includes(event.key)) downwardIntentAt = performance.now();
  };
  const onPointerDown = (event: PointerEvent) => {
    // Native scrollbar interaction targets the scroller itself. Stop writes
    // before dragging the thumb; downward dragging can resume at the bottom.
    if (event.target === scroller && event.clientX >= scroller.getBoundingClientRect().right - 16) {
      release();
      downwardIntentAt = performance.now();
    }
  };
  scroller.addEventListener("scroll", onScroll, { passive: true });
  scroller.addEventListener("wheel", onWheel, { passive: true, capture: true });
  scroller.addEventListener("touchstart", onTouchStart, { passive: true });
  scroller.addEventListener("touchmove", onTouchMove, { passive: true, capture: true });
  scroller.addEventListener("keydown", onKeyDown, true);
  scroller.addEventListener("pointerdown", onPointerDown, { passive: true });
  const observer = new ResizeObserver(schedule);
  observer.observe(scroller);
  const content = scroller.querySelector('[data-chat-list-content]');
  if (content) observer.observe(content);
  schedule();
  return { schedule, dispose: () => {
    observer.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
    scroller.removeEventListener("scroll", onScroll);
    scroller.removeEventListener("wheel", onWheel, true);
    scroller.removeEventListener("touchstart", onTouchStart);
    scroller.removeEventListener("touchmove", onTouchMove, true);
    scroller.removeEventListener("keydown", onKeyDown, true);
    scroller.removeEventListener("pointerdown", onPointerDown);
  } };
}
