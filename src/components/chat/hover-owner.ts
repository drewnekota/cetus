import type { PointerEvent } from "react";

/** Single-owner hover tracking for message action toolbars.
 *
 *  CSS `:hover` is only recomputed on real mouse events. During a streaming
 *  reply the transcript auto-scrolls, so turns slide under a stationary
 *  pointer; WebKit latches `:hover` on each one as it passes and never clears
 *  it until the mouse physically moves — leaving several timestamp toolbars
 *  visible at once. No selector rewrite fixes that, so visibility is driven by
 *  pointer events instead: exactly one turn can hold `data-hovered`, and a
 *  scroll drops it (see the chat pane's scroll listener). */
let owner: HTMLElement | null = null;

function claim(el: HTMLElement) {
  if (owner === el) return;
  owner?.removeAttribute("data-hovered");
  owner = el;
  el.setAttribute("data-hovered", "");
}

/** Hide whichever toolbar is currently latched. Called on scroll: the pointer
 *  no longer points at the turn it entered, and no leave event will ever fire. */
export function clearHoverOwner() {
  owner?.removeAttribute("data-hovered");
  owner = null;
}

/** Spread onto a `data-message-hover-target` element. `onPointerMove` (not
 *  just enter) re-claims after a scroll cleared the owner while the pointer
 *  stayed inside the same turn — no boundary crossing happens in that case. */
export const messageHoverProps = {
  onPointerEnter: (e: PointerEvent<HTMLElement>) => claim(e.currentTarget),
  onPointerMove: (e: PointerEvent<HTMLElement>) => claim(e.currentTarget),
  onPointerLeave: (e: PointerEvent<HTMLElement>) => {
    if (owner === e.currentTarget) owner = null;
    e.currentTarget.removeAttribute("data-hovered");
  },
};
