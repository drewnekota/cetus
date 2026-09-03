"use client";
import { forwardRef, useMemo } from "react";
import { cn } from "@/lib/utils";
import { findMentionSpans } from "@/lib/mentions";

/**
 * The pill layer behind the composer textarea. The textarea keeps rendering
 * its own text (so IME composition, selection and the caret behave exactly as
 * native), and this layer — same font, padding and wrapping, positioned
 * underneath — repeats the text invisibly and paints a rounded background
 * under every `@label` run. Because both layers lay out the same string with
 * the same metrics, the highlight sits exactly under the token.
 *
 * The caller mirrors the textarea's scrollTop onto this element (see
 * Composer's onScroll) so the pills stay aligned when the field overflows.
 */
export const MentionHighlight = forwardRef<
  HTMLDivElement,
  { text: string; labels: string[]; className?: string }
>(function MentionHighlight({ text, labels, className }, ref) {
  const segments = useMemo(() => {
    const spans = findMentionSpans(text, labels);
    if (spans.length === 0) return null;
    const out: { text: string; pill: boolean }[] = [];
    let last = 0;
    for (const s of spans) {
      if (s.start > last) out.push({ text: text.slice(last, s.start), pill: false });
      out.push({ text: text.slice(s.start, s.end), pill: true });
      last = s.end;
    }
    if (last < text.length) out.push({ text: text.slice(last), pill: false });
    return out;
  }, [text, labels]);

  if (!segments) return null;
  return (
    <div
      ref={ref}
      aria-hidden
      className={cn(
        // overflow-x-hidden + pre-wrap + break-words: the textarea's own wrapping
        // rules, so line breaks land in the same places.
        "pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-transparent",
        className,
      )}
    >
      {segments.map((s, i) =>
        s.pill ? (
          <span
            key={i}
            className="rounded-md bg-primary/15 ring-1 ring-primary/20 [box-decoration-break:clone] dark:bg-primary/25"
          >
            {s.text}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
      {/* A trailing newline only takes up a line when something follows it. */}
      {text.endsWith("\n") ? "​" : null}
    </div>
  );
});
