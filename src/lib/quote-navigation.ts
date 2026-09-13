import type { RenderedMessage } from "./types";
import { messageFindText } from "./message-search";
import { splitLeadingQuote } from "./user-quote";

/** Quotes contain rendered prose; ignore Markdown decoration and layout spacing. */
export function normalizeQuote(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, "");
}

/** Old transcripts only carry quote text, so prefer the nearest earlier source.
 * Exclude quote headers themselves to avoid jumping between replies. */
export function findQuoteSource(messages: (RenderedMessage | undefined)[], before: number, quote: string): number {
  const needle = normalizeQuote(quote);
  if (!needle) return -1;
  for (let i = before - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    let text = messageFindText(message);
    if (message.role === "user") text = splitLeadingQuote(text)?.text ?? text;
    if (normalizeQuote(text).includes(needle)) return i;
  }
  return -1;
}

/** Match across inline Markdown elements and paragraph boundaries. */
export function quoteRange(root: HTMLElement, quote: string): Range | null {
  const needle = normalizeQuote(quote);
  if (!needle) return null;
  const points: { node: Text; offset: number }[] = [];
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('[data-message-actions], [data-quote-link], .katex-mathml')) continue;
    const value = node.nodeValue ?? "";
    for (let offset = 0; offset < value.length; offset++) {
      if (/[\s*_`~]/.test(value[offset])) continue;
      text += value[offset];
      points.push({ node: node as Text, offset });
    }
  }
  const start = text.indexOf(needle);
  if (start < 0) return null;
  const first = points[start];
  const last = points[start + needle.length - 1];
  const range = document.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
  return range;
}
