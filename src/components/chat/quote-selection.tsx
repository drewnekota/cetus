"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MessageCircle } from "lucide-react";
import { useTranslation } from "@/lib/i18n";

export function QuoteSelectionToolbar({
  scroller,
  onQuote,
}: {
  /** The virtual list scroll element: selection root + scroll-to-dismiss source. */
  scroller: HTMLElement | null;
  onQuote: (text: string) => void;
}) {
  const { t } = useTranslation("chat");
  const [selection, setSelection] = useState<{
    range: Range;
    text: string;
    left: number;
    top: number;
  } | null>(null);

  const clearSelection = useCallback(() => {
    const root = scroller;
    const sel = window.getSelection();
    if (root && sel && selectionBelongsToRoot(root, sel)) {
      sel.removeAllRanges();
    }
    setSelection(null);
  }, [scroller]);

  const readSelection = useCallback(
    (finalize = false) => {
      const root = scroller;
      const sel = window.getSelection();
      if (!root || !sel || sel.rangeCount === 0 || sel.isCollapsed) {
        setSelection(null);
        return;
      }

      let range = sel.getRangeAt(0);
      const ancestor = range.commonAncestorContainer;
      const node =
        ancestor.nodeType === Node.ELEMENT_NODE
          ? ancestor
          : ancestor.parentNode;
      if (!node || !root.contains(node)) {
        setSelection(null);
        return;
      }

      // WebKit lets a drag begin/end on a markdown block boundary or on whitespace
      // between blocks. Those structural endpoints can paint the empty remainder
      // of a row as selected (and can even leave a non-collapsed, visually empty
      // Range). Once the gesture is complete, reduce the Range to its first and
      // last real character so the native highlight matches what can be quoted.
      if (finalize) {
        const trimmed = trimSelectionToText(range, root);
        if (trimmed) {
          sel.removeAllRanges();
          sel.addRange(trimmed);
          range = trimmed;
        } else {
          sel.removeAllRanges();
          setSelection(null);
          return;
        }
      }

      const text = sel.toString().trim();
      if (!text) {
        setSelection(null);
        return;
      }

      const rect = selectionAnchorRect(range);
      if (rect.width === 0 && rect.height === 0) {
        setSelection(null);
        return;
      }

      const left = Math.round(rect.left + rect.width / 2);
      const top = Math.round(Math.max(8, rect.top - 8));

      setSelection((prev) => {
        if (
          prev &&
          prev.text === text &&
          prev.left === left &&
          prev.top === top &&
          sameRangeBoundaries(prev.range, range)
        ) {
          return prev;
        }

        return {
          range: range.cloneRange(),
          text,
          left,
          top,
        };
      });
    },
    [scroller],
  );

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-quote-selection-toolbar]")) return;

      const root = scroller;
      const sel = window.getSelection();
      if (!root || !sel || !selectionBelongsToRoot(root, sel)) return;

      sel.removeAllRanges();
      setSelection(null);
    };
    const onPointerUp = () => window.setTimeout(() => readSelection(true), 0);
    const onKeyUp = () => readSelection(true);
    const onSelectionChange = () => readSelection(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearSelection();
    };
    const onScroll = () => clearSelection();

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("keydown", onKeyDown);
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("keydown", onKeyDown);
      scroller?.removeEventListener("scroll", onScroll);
    };
  }, [clearSelection, readSelection, scroller]);

  if (!selection) return null;

  // Portal to <body>: the chat pane lives inside SidebarInset, which has a
  // `backdrop-filter` — that establishes a containing block for fixed-position
  // descendants, so a `position: fixed` toolbar rendered inline would resolve
  // its viewport coordinates against the SidebarInset box (offset by the
  // sidebar width) and drift sideways. Rendering into <body> escapes that
  // containing block so `fixed` is viewport-relative again.
  return createPortal(
    <div
      data-quote-selection-toolbar
      className="fixed z-50 -translate-x-1/2 -translate-y-full select-none rounded-full border border-border bg-popover px-1 py-0.5 text-popover-foreground shadow-[0_4px_14px_rgba(0,0,0,0.10),0_1px_2px_rgba(0,0,0,0.06)]"
      style={{ left: selection.left, top: selection.top }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        type="button"
        onClick={() => {
          onQuote(serializeSelection(selection.range));
          window.getSelection()?.removeAllRanges();
          setSelection(null);
        }}
        className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted"
      >
        <MessageCircle className="size-3.5" />
        {t("quote.addToChat")}
      </button>
    </div>,
    document.body,
  );
}

/** Remove structural/whitespace boundaries from a completed native selection. */
function trimSelectionToText(range: Range, root: HTMLElement): Range | null {
  let first: { node: Text; offset: number } | null = null;
  let last: { node: Text; offset: number } | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.data || !range.intersectsNode(node)) continue;

    const start = node === range.startContainer ? range.startOffset : 0;
    const end =
      node === range.endContainer ? range.endOffset : node.data.length;
    if (start >= end) continue;

    const selected = node.data.slice(start, end);
    const firstCharacter = selected.search(/\S/u);
    if (firstCharacter >= 0 && !first) {
      first = { node, offset: start + firstCharacter };
    }

    const trailingWhitespace = selected.match(/\s*$/u)?.[0].length ?? 0;
    if (trailingWhitespace < selected.length) {
      last = { node, offset: end - trailingWhitespace };
    }
  }
  if (!first || !last) return null;

  const trimmed = range.cloneRange();
  trimmed.setStart(first.node, first.offset);
  trimmed.setEnd(last.node, last.offset);
  return trimmed.collapsed ? null : trimmed;
}

function sameRangeBoundaries(a: Range, b: Range): boolean {
  return (
    a.startContainer === b.startContainer &&
    a.startOffset === b.startOffset &&
    a.endContainer === b.endContainer &&
    a.endOffset === b.endOffset
  );
}

function selectionBelongsToRoot(root: HTMLElement, sel: Selection): boolean {
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    const ancestor = range.commonAncestorContainer;
    const node =
      ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentNode;
    if (node && root.contains(node)) return true;
  }
  return false;
}

// Turn a live selection Range into plain text suitable for a `>` blockquote.
//
// `Selection.toString()` is unusable on rendered markdown that contains KaTeX:
// each math atom is its own inline-block span, so the serializer emits a newline
// after every character (turning `$0**$` into `0\n*\n*`), and the hidden MathML
// mirror gets duplicated alongside the visible render. Instead we clone the
// selected DOM, swap every `.katex` node back to its LaTeX source (pulled from
// the MathML `annotation`), then read `innerText` — which collapses the render
// noise while still honoring real block boundaries (paragraphs, list items).
function serializeSelection(range: Range): string {
  const container = document.createElement("div");
  container.appendChild(range.cloneContents());

  container.querySelectorAll(".katex").forEach((el) => {
    const tex = el
      .querySelector('annotation[encoding="application/x-tex"]')
      ?.textContent?.trim();
    // Always double-dollar: single-dollar math parsing is disabled (see
    // REMARK_MATH_OPTIONS), so `$…$` would no longer round-trip as math.
    const replacement = tex ? `$$${tex}$$` : (el.textContent ?? "");
    el.replaceWith(document.createTextNode(replacement));
  });

  // `innerText` needs layout, so the node must be attached and rendered. Keep it
  // offscreen and preserve line breaks, then remove it synchronously.
  container.style.cssText =
    "position:fixed;left:-99999px;top:0;white-space:pre-wrap;";
  document.body.appendChild(container);
  const text = container.innerText;
  container.remove();
  return text.trim();
}

function selectionAnchorRect(range: Range): DOMRect {
  const rects = selectionTextRects(range);
  if (rects.length === 0) return range.getBoundingClientRect();

  // Anchor to the FIRST (top) line of the selection only, so the toolbar sits
  // centered directly above where the selection begins. Using the full
  // bounding box would center over the widest line, drifting the button off
  // the visible top edge on multi-line selections.
  const top = Math.min(...rects.map((rect) => rect.top));
  const firstLine = rects.filter((rect) => rect.top <= top + 2);
  const left = Math.min(...firstLine.map((rect) => rect.left));
  const right = Math.max(...firstLine.map((rect) => rect.right));
  const bottom = Math.max(...firstLine.map((rect) => rect.bottom));

  return DOMRect.fromRect({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  });
}

function selectionTextRects(range: Range): DOMRect[] {
  const common = range.commonAncestorContainer;
  const rects: DOMRect[] = [];

  const pushTextNodeRects = (node: Text) => {
    if (!node.data || !range.intersectsNode(node)) return;
    const textRange = document.createRange();
    const start = node === range.startContainer ? range.startOffset : 0;
    const end =
      node === range.endContainer ? range.endOffset : node.data.length;
    if (start >= end) return;

    textRange.setStart(node, start);
    textRange.setEnd(node, end);
    rects.push(
      ...Array.from(textRange.getClientRects()).filter(
        (rect) => rect.width > 0 && rect.height > 0,
      ),
    );
    textRange.detach();
  };

  if (common.nodeType === Node.TEXT_NODE) {
    pushTextNodeRects(common as Text);
    return rects;
  }

  const walker = document.createTreeWalker(common, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) pushTextNodeRects(walker.currentNode as Text);
  return rects;
}
