"use client";
// Window-level backstop for link handling. Every anchor the app renders is
// individually intercepted and routed to the OS (see `openMarkdownLink`), but
// interception at the component level only covers plain left clicks. The
// remaining input paths all end the same way — WKWebView navigates the app
// webview in place, which replaces the UI and is unrecoverable from the page
// (see the navigation-guard comment in lib.rs):
//
//  - middle click fires `auxclick`, which component `onClick` never sees;
//  - a link click that drifts a few pixels becomes a WebKit link drag, and
//    dropping it back onto the window navigates to the dragged URL (wry
//    forwards OS drags to WebKit rather than swallowing them);
//  - the native context menu's "Open Link" bypasses DOM events entirely.
//
// This component closes the first two from the page and suppresses the third
// by dropping the native menu everywhere except where it is actually useful
// (images, editable fields and selected text). Keeping the menu off elsewhere also
// removes its Back/Forward/Reload items, which navigate the app webview out of
// the live UI — Back in particular tears down the running session view. The
// Rust `on_page_load` recovery net remains behind it for anything else that
// slips through.
import { useEffect } from "react";

import { openMarkdownLink } from "@/lib/markdown";

/** The href of the closest enclosing anchor, unless it is a same-page hash. */
function anchorHref(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const a = target.closest("a[href]");
  if (!a) return null;
  const href = a.getAttribute("href");
  return href && !href.startsWith("#") ? href : null;
}

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("input, textarea, [contenteditable]") != null
  );
}

/** Whether the right click landed on text the user has selected. */
function hasSelectionAt(target: EventTarget | null): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !(target instanceof Node)) {
    return false;
  }
  return selection.containsNode(target, true);
}

export function LinkGuard() {
  useEffect(() => {
    // Bubble phase, so component-level handlers (which preventDefault and
    // route the link themselves) run first and are not double-opened.
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      const href = anchorHref(e.target);
      if (!href) return;
      e.preventDefault();
      openMarkdownLink(href);
    };
    const onAuxClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 1) return;
      const href = anchorHref(e.target);
      if (!href) return;
      e.preventDefault();
      openMarkdownLink(href);
    };
    // Keep native image copying available for both inline thumbnails and
    // full-size previews. Elsewhere, only editing and selected-text copy need
    // the native menu; its navigation commands can leave the live app UI.
    const onContextMenu = (e: MouseEvent) => {
      if (e.target instanceof HTMLImageElement) return;
      if (isEditable(e.target) && !anchorHref(e.target)) return;
      if (hasSelectionAt(e.target)) return;
      e.preventDefault();
    };
    // Cancelling `drop` cancels WebKit's default navigation to the dropped
    // URL. Editable targets keep their native drop (text into the composer);
    // file drops are unaffected — they are consumed via Tauri's drag-drop
    // events (see FileDropHost), not HTML5 ones.
    const onDragOver = (e: DragEvent) => {
      if (!isEditable(e.target)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (!isEditable(e.target)) e.preventDefault();
    };
    document.addEventListener("click", onClick);
    document.addEventListener("auxclick", onAuxClick);
    document.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("auxclick", onAuxClick);
      document.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
    };
  }, []);
  return null;
}
