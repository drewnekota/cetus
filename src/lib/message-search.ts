// In-conversation find (⌘F). Unlike the command palette's cross-conversation
// search (conversation-search.ts), this is browser-⌘F semantics: one literal,
// case-insensitive substring — no tokenising, no AND, no relevance ranking.
// Every occurrence is a stop on the up/down walk.
//
// Matching happens on the message DATA rather than the DOM because the chat is
// virtualised (react-virtuoso mounts only the visible window), so a DOM-only
// find would silently miss everything off-screen. The DOM side (find-highlight.ts)
// only paints what is currently mounted.

import type { RenderedMessage } from "./types";

/** The prose a reader can actually see in a bubble: text + extension
 *  breadcrumbs. Thinking, tool calls and their output are deliberately skipped —
 *  they are collapsed or absent in the rendered turn, so counting them would
 *  produce matches the reader can never be shown. */
export function messageFindText(message: RenderedMessage): string {
  if (message.role === "tool" || message.role === "system") return "";
  const parts: string[] = [];
  for (const b of message.blocks) {
    if (b.kind === "text" || b.kind === "custom") parts.push(b.text);
  }
  return parts.join("\n");
}

/** One stop on the find walk: the Nth occurrence inside list row `itemIndex`
 *  (a row is a whole assistant turn or a single user message — the unit
 *  Virtuoso can scroll to). */
export interface FindMatch {
  itemIndex: number;
  /** 0-based occurrence index within that row's text. */
  nth: number;
}

/** Occurrence count of `needle` in `haystack`, both already lowercased.
 *  Overlapping matches are not counted (same as the browser's find). */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return count;
    count++;
    from = idx + needle.length;
  }
}

/**
 * Flatten per-row text into the ordered list of every occurrence, top to
 * bottom. `rowTexts[i]` is the visible prose of list row `i`; a row with no hit
 * simply contributes nothing.
 */
export function buildFindMatches(rowTexts: string[], query: string): FindMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: FindMatch[] = [];
  for (let i = 0; i < rowTexts.length; i++) {
    const n = countOccurrences(rowTexts[i].toLowerCase(), needle);
    for (let nth = 0; nth < n; nth++) matches.push({ itemIndex: i, nth });
  }
  return matches;
}

/** Wrap-around step through the match list. Returns 0 when there is nothing to
 *  step through, so callers can use the result unconditionally. */
export function stepMatch(total: number, current: number, delta: number): number {
  if (total <= 0) return 0;
  return ((current + delta) % total + total) % total;
}

/**
 * Keep the reader where they were when the match list is rebuilt under them (a
 * new message arriving mid-search): stay on the same occurrence index when it
 * still exists, otherwise clamp into range.
 */
export function preserveActive(total: number, previous: number): number {
  if (total <= 0) return 0;
  return Math.min(Math.max(previous, 0), total - 1);
}

/**
 * Where a fresh query should land: the first match at or below the row the
 * reader is currently looking at, wrapping to the top when everything is above
 * them. Browsers search onward from the viewport rather than restarting at the
 * document top, and in a long conversation the difference is the whole feature —
 * a search from the tail must not fling you back to the first turn.
 */
export function firstMatchFrom(matches: FindMatch[], topItemIndex: number): number {
  for (let i = 0; i < matches.length; i++) {
    if (matches[i].itemIndex >= topItemIndex) return i;
  }
  return 0;
}
