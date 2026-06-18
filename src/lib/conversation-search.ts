// Client-side hybrid search over conversations: title metadata + cached message
// content. Content comes from the IndexedDB write-through cache (chat-store), so
// it covers every conversation this client has rendered; titles always match.
// Pure functions here keep the command-palette component lean and testable.

import type { RenderedMessage } from "./types";

export interface MatchRange {
  start: number;
  end: number;
}

/**
 * Flatten a conversation's human-visible prose (user + assistant text, plus
 * extension breadcrumbs) into one searchable blob. Skips thinking/tool/system
 * noise and caps length so a long conversation can't dominate memory or scan
 * time — the head of a thread is the most identifying part anyway.
 */
export function extractConversationText(
  messages: RenderedMessage[],
  cap = 8000,
): string {
  const parts: string[] = [];
  let len = 0;
  for (const m of messages) {
    if (m.role === "tool" || m.role === "system") continue;
    for (const b of m.blocks) {
      const t = b.kind === "text" || b.kind === "custom" ? b.text : "";
      if (!t) continue;
      parts.push(t);
      len += t.length + 1;
      if (len >= cap) return parts.join("\n").slice(0, cap);
    }
  }
  return parts.join("\n");
}

/** Lowercased, whitespace-split query tokens (empty tokens dropped). */
export function tokenize(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function mergeRanges(ranges: MatchRange[]): MatchRange[] {
  if (ranges.length <= 1) return ranges;
  ranges.sort((a, b) => a.start - b.start);
  const out: MatchRange[] = [{ ...ranges[0] }];
  for (let i = 1; i < ranges.length; i++) {
    const last = out[out.length - 1];
    const r = ranges[i];
    if (r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** Every (merged) occurrence of any token within `text`, case-insensitive. */
export function highlightRanges(text: string, tokens: string[]): MatchRange[] {
  if (!tokens.length || !text) return [];
  const lower = text.toLowerCase();
  const ranges: MatchRange[] = [];
  for (const tok of tokens) {
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(tok, from);
      if (idx === -1) break;
      ranges.push({ start: idx, end: idx + tok.length });
      from = idx + tok.length;
    }
  }
  return mergeRanges(ranges);
}

/**
 * A short snippet centred on the first content match, with highlight ranges
 * recomputed against the trimmed/ellipsised display string. Returns null when
 * no token appears in the content (e.g. a title-only match).
 */
export function buildSnippet(
  content: string,
  tokens: string[],
  window = 110,
): { text: string; ranges: MatchRange[] } | null {
  if (!tokens.length || !content) return null;
  const lower = content.toLowerCase();
  let first = -1;
  for (const tok of tokens) {
    const idx = lower.indexOf(tok);
    if (idx !== -1 && (first === -1 || idx < first)) first = idx;
  }
  if (first === -1) return null;
  const start = Math.max(0, first - Math.floor(window / 3));
  const slice = content.slice(start, start + window).replace(/\s+/g, " ").trim();
  const text =
    (start > 0 ? "… " : "") +
    slice +
    (start + window < content.length ? " …" : "");
  return { text, ranges: highlightRanges(text, tokens) };
}

/**
 * Hybrid relevance score. Title hits outweigh content hits, a title prefix and
 * a whole-phrase title hit get bonuses. Returns null when any token is missing
 * from both title and content (AND semantics — every word must appear).
 *
 * `contentLower` is expected to be ALREADY lowercased (the palette caches a
 * lowercased copy per conversation so we don't re-lowercase an 8k blob on every
 * keystroke); `title` is short and lowercased here.
 */
export function scoreConversation(
  title: string,
  contentLower: string,
  tokens: string[],
): number | null {
  if (!tokens.length) return 0;
  const t = title.toLowerCase();
  const c = contentLower;
  let score = 0;
  for (const tok of tokens) {
    const inTitle = t.includes(tok);
    const inContent = c.includes(tok);
    if (!inTitle && !inContent) return null;
    if (inTitle) {
      score += 10;
      if (t.startsWith(tok)) score += 4;
    }
    if (inContent) score += 2;
  }
  if (tokens.length > 1 && t.includes(tokens.join(" "))) score += 8;
  return score;
}

/** Compact relative time ("now", "5m", "3h", "2d", "4w", "6mo", "1y"). */
export function formatRelativeTime(ts: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (s < 45) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
}
