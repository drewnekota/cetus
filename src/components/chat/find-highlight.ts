// Painting side of in-conversation find (⌘F). Kept apart from message-search.ts
// so the matching logic stays pure and testable while everything that has to
// touch live DOM lives here.
//
// Highlights use the CSS Custom Highlight API rather than wrapping matches in
// <mark> elements. Wrapping would mean threading a query through MessageBubble,
// the markdown renderer and every card below it — and re-rendering all of them
// on each keystroke. Highlight ranges paint over the existing DOM instead, so a
// search costs nothing but a text-node walk (styles live in globals.css under
// ::highlight(cetus-find)). Unsupported engines just get no paint; navigation
// and the match counter still work.

const ALL = "cetus-find";
const ACTIVE = "cetus-find-active";

/** Raised by the app's global keydown handler when ⌘F survives its modal and
 *  view guards, and listened for by the message list. Going through an event
 *  rather than a second window keydown listener means the find bar can't open
 *  behind Settings, the screen-history overlay or the Kanban view — the guards
 *  live in exactly one place. */
export const FIND_IN_CHAT_EVENT = "cetus-find-in-chat";

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

function registry(): HighlightRegistry | null {
  const css = globalThis.CSS as unknown as
    | { highlights?: HighlightRegistry; Highlight?: unknown }
    | undefined;
  return css?.highlights && typeof css.Highlight === "function"
    ? css.highlights
    : null;
}

/** Every occurrence of `needle` inside `root`'s text nodes, in document order.
 *  Rows are walked one at a time by the caller, so ranges come out in the same
 *  order buildFindMatches counted them. */
function rangesIn(root: HTMLElement, needle: string): Range[] {
  const out: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue;
    if (!text) continue;
    // Chrome (the hover toolbar) is not conversation content: matching "copy"
    // should not light up every turn's Copy button.
    if (node.parentElement?.closest("[data-message-actions]")) continue;
    const lower = text.toLowerCase();
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(needle, from);
      if (idx === -1) break;
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + needle.length);
      out.push(range);
      from = idx + needle.length;
    }
  }
  return out;
}

/** Rows currently mounted by Virtuoso, keyed by their item index. */
function mountedRows(scroller: HTMLElement): Map<number, HTMLElement> {
  const rows = new Map<number, HTMLElement>();
  for (const el of scroller.querySelectorAll<HTMLElement>("[data-find-row]")) {
    const index = Number(el.dataset.findRow);
    if (Number.isInteger(index)) rows.set(index, el);
  }
  return rows;
}

export function clearFindHighlights() {
  const reg = registry();
  if (!reg) return;
  reg.delete(ALL);
  reg.delete(ACTIVE);
}

/**
 * Repaint every match inside the mounted rows and single out the active one.
 * Returns the active occurrence's range when it is mounted and painted, so the
 * caller can bring it into view — null when the active row is still off-screen
 * or the engine has no Highlight API.
 *
 * A match found in the DOM can drift from the one counted in the data (markdown
 * syntax characters never reach the DOM, and a card may truncate its text), so
 * the active occurrence is clamped to what the row actually has rather than
 * assumed present.
 */
export function paintFindHighlights(
  scroller: HTMLElement,
  query: string,
  active: { itemIndex: number; nth: number } | null,
): Range | null {
  const reg = registry();
  if (!reg) return null;
  const needle = query.trim().toLowerCase();
  if (!needle) {
    clearFindHighlights();
    return null;
  }

  const Highlight = (globalThis.CSS as unknown as { Highlight: new (...r: Range[]) => unknown })
    .Highlight;
  const all: Range[] = [];
  let activeRange: Range | null = null;

  for (const [index, row] of mountedRows(scroller)) {
    const ranges = rangesIn(row, needle);
    if (!ranges.length) continue;
    if (active && active.itemIndex === index) {
      activeRange = ranges[Math.min(active.nth, ranges.length - 1)];
    }
    all.push(...ranges);
  }

  const rest = activeRange ? all.filter((r) => r !== activeRange) : all;
  if (rest.length) reg.set(ALL, new Highlight(...rest));
  else reg.delete(ALL);
  if (activeRange) reg.set(ACTIVE, new Highlight(activeRange));
  else reg.delete(ACTIVE);

  return activeRange;
}

/** Nudge the scroller so `range` sits comfortably inside the viewport. Written
 *  as a direct scrollTop delta rather than scrollIntoView, which would also
 *  scroll ancestor containers and can fight Virtuoso mid-settle. */
export function revealRange(scroller: HTMLElement, range: Range) {
  const rect = range.getBoundingClientRect();
  if (!rect.height) return; // hidden inside a collapsed card — row scroll stands
  const view = scroller.getBoundingClientRect();
  const margin = 48;
  if (rect.top >= view.top + margin && rect.bottom <= view.bottom - margin) return;
  scroller.scrollTop += rect.top - view.top - view.height / 3;
}
