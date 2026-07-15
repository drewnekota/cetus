"use client";
// Shared, hook-bearing renderers for the pieces of a conversation turn. Pulled
// out of message-bubble.tsx so both a single bubble (user / custom) and a
// grouped assistant turn (assistant-turn.tsx) render text, attachments, and the
// hover toolbar identically.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkCjkFriendly from "remark-cjk-friendly";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import {
  markdownComponents,
  markdownUrlTransform,
  LinkifiedText,
  normalizeMath,
  KATEX_OPTIONS,
  REMARK_MATH_OPTIONS,
} from "@/lib/markdown";
import { Check, Copy, FileText, GitFork, RotateCcw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { RenderedBlock } from "@/lib/types";
import { ArtifactView } from "./artifact-view";
import { ContextCard } from "./context-card";
import { artifactsFromDetails, formatBytes } from "@/lib/artifact";
import { formatTimeHM, formatFullDateTime } from "@/lib/format";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";

const PROSE_CLASS = cn(
  "prose prose-sm dark:prose-invert max-w-none",
  // Contain unbreakable content (KaTeX nowrap spans, long tokens, wide tables)
  // to this message: without this it widens the Virtuoso scroller and puts a
  // horizontal scrollbar under the whole conversation.
  "min-w-0 overflow-x-auto",
  // Tighten default prose spacing so chat bubbles don't blow up.
  "prose-p:my-2 prose-pre:my-2 prose-ul:my-2 prose-ol:my-2 prose-headings:my-3",
  "prose-code:rounded prose-code:bg-secondary prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:before:content-none prose-code:after:content-none",
  "prose-pre:bg-secondary prose-pre:text-foreground",
  // Tables: prose-sm shrinks th/td to ~12px and prose-code drops another 15%.
  // Keep cell text at the bubble's base size and stop nested code from shrinking further.
  "prose-th:text-sm prose-th:py-2 prose-td:text-sm prose-td:py-2",
  "[&_td_code]:text-[0.95em] [&_th_code]:text-[0.95em]",
);

/** One parse of a markdown fragment. Memoized on the source string so an
 *  unchanged fragment (e.g. the frozen prefix of a streaming reply, or a prior
 *  bubble when a new message is appended) is never re-parsed — parsing is the
 *  expensive part (remark-gfm + remark-math + rehype-katex). */
const RawMarkdown = memo(function RawMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[[remarkGfm, { singleTilde: false }], [remarkMath, REMARK_MATH_OPTIONS], remarkCjkFriendly]}
      rehypePlugins={[[rehypeKatex, KATEX_OPTIONS]]}
      components={markdownComponents}
      urlTransform={markdownUrlTransform}
    >
      {normalizeMath(text)}
    </ReactMarkdown>
  );
});

// A block start that a mid-stream split must not cut adjacent to: list item,
// blockquote, or table row. Cutting there would momentarily break the construct
// (restart list numbering, split a table) until the next token arrives.
const UNSAFE_BLOCK = /^\s{0,3}([-*+]|\d+[.)]|>|\|)/;

/** Character offset where the streaming tail should begin: just past the last
 *  block boundary (blank line) that is *safe* to freeze a prefix at — outside
 *  any code fence, and with neither the block above nor the line below being a
 *  list / table / blockquote line. Returns -1 when there is no safe cut, so the
 *  caller renders the whole text as one tree. A settled message always renders
 *  un-split (see TextBlock), so a transient imperfect cut self-heals. */
function safeStreamSplit(text: string): number {
  const lines = text.split("\n");
  const lineStart: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStart.push(offset);
    offset += line.length + 1;
  }
  let cut = -1;
  let inFence = false;
  for (let i = 1; i < lines.length - 1; i++) {
    if (/^\s{0,3}(```|~~~)/.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence || lines[i].trim() !== "") continue; // only blank lines outside fences
    const prev = lines[i - 1];
    const next = lines[i + 1];
    if (prev.trim() === "" || next.trim() === "") continue; // need real content both sides
    if (UNSAFE_BLOCK.test(prev) || UNSAFE_BLOCK.test(next)) continue;
    cut = lineStart[i + 1];
  }
  // Only worth splitting when the frozen head is non-trivial.
  return cut < 64 ? -1 : cut;
}

/** Assistant markdown. While streaming, freeze the settled prefix as its own
 *  memoized parse and only re-parse the growing tail — so a long reply stops
 *  re-parsing its whole body on every throttle tick (the dominant streaming jank
 *  source). Settled messages render as a single tree, so the final output is
 *  always exact. */
const AssistantMarkdown = memo(function AssistantMarkdown({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}) {
  const cut = useMemo(() => (streaming ? safeStreamSplit(text) : -1), [text, streaming]);
  return (
    <div className={PROSE_CLASS}>
      {cut > 0 ? (
        <>
          <RawMarkdown text={text.slice(0, cut)} />
          <RawMarkdown text={text.slice(cut)} />
        </>
      ) : (
        <RawMarkdown text={text} />
      )}
    </div>
  );
});

/** While streaming, the tail bubble's text grows by a few chars per event. Re-
 *  parsing the whole markdown string on every token is O(n) per token → O(n²)
 *  over the message and is the dominant jank source on long replies. Throttle
 *  the value fed to the parser to ~once per `ms` — and since each parse costs
 *  O(current length), stretch the interval as the text grows so the total
 *  parse work per second stays roughly constant instead of scaling with reply
 *  length. The full text is flushed the moment streaming settles, so the final
 *  render is always exact. */
function useThrottledText(text: string, streaming: boolean, ms = 90): string {
  const [display, setDisplay] = useState(text);
  const latestRef = useRef(text);
  const timerRef = useRef<number | null>(null);
  latestRef.current = text;

  useEffect(() => {
    if (!streaming) {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setDisplay(text);
      return;
    }
    if (timerRef.current == null) {
      // 0 chars → ms; 10k chars → ms+100; capped at 500ms so even a huge
      // reply still visibly ticks twice a second.
      const interval = Math.min(500, ms + latestRef.current.length / 100);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setDisplay(latestRef.current);
      }, interval);
    }
  }, [text, streaming, ms]);

  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return streaming ? display : text;
}

/** A single text block. User text is rendered plain (just linkified); assistant
 *  text goes through the memoized, streaming-throttled markdown pipeline. */
export function TextBlock({
  text,
  streaming,
  isUser,
}: {
  text: string;
  streaming?: boolean;
  isUser: boolean;
}) {
  const throttled = useThrottledText(text, streaming ?? false);
  return (
    <div className="break-words text-sm leading-relaxed">
      {isUser ? (
        // User messages are plain text; markdown rendering is for assistant
        // output where the model emits **bold** / code / lists. We still linkify
        // bare URLs so a pasted link is clickable.
        <div className="whitespace-pre-wrap">
          <LinkifiedText text={text} />
        </div>
      ) : (
        <AssistantMarkdown text={throttled} streaming={streaming} />
      )}
      {streaming && (
        <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-current align-middle opacity-70" />
      )}
    </div>
  );
}

/** An attached image. Renders as a capped thumbnail that opens a full-size,
 *  zoomable view in a dialog on click. */
function ImageBlock({ dataUrl, name }: { dataUrl: string; name?: string }) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const label = name ?? t("bubble.attachment");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t("bubble.expandImage")}
        className="block cursor-zoom-in overflow-hidden rounded-lg border border-border/40 transition-opacity hover:opacity-90"
      >
        <img
          src={dataUrl}
          alt={label}
          className="max-h-72 object-contain"
        />
      </button>
      <DialogContent
        className="grid max-h-[90vh] max-w-[90vw] place-items-center border-none bg-transparent p-0 ring-0 sm:max-w-[90vw]"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{label}</DialogTitle>
        <img
          src={dataUrl}
          alt={label}
          className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-xl"
        />
      </DialogContent>
    </Dialog>
  );
}

/** Renders a non-process block — the things that are part of the *answer*
 *  (text, images, file chips, rich artifacts) rather than the tool/thinking
 *  activity. `thinking` / `tool_use` blocks are handled by the activity group,
 *  not here.
 *
 *  Memoized on (block, isUser): settled blocks keep their object ref across the
 *  parent group's per-token re-renders, so only the actively-streaming block
 *  actually re-renders. */
export const AnswerBlock = memo(function AnswerBlock({
  block,
  isUser,
}: {
  block: RenderedBlock;
  isUser: boolean;
}) {
  const { t } = useTranslation("chat");
  if (block.kind === "text")
    return <TextBlock text={block.text} streaming={block.streaming} isUser={isUser} />;
  if (block.kind === "image")
    return <ImageBlock dataUrl={block.dataUrl} name={block.name} />;
  if (block.kind === "file")
    return (
      <button
        type="button"
        onClick={() => invoke("reveal_in_finder", { path: block.path }).catch(console.error)}
        title={t("bubble.revealInFinder", { path: block.path })}
        className={cn(
          "flex max-w-xs items-center gap-2 rounded-lg border px-3 py-2 text-left",
          isUser ? "border-primary/25 bg-primary/10" : "border-border/60 bg-muted/40",
        )}
      >
        <FileText className="size-4 shrink-0 opacity-70" />
        <span className="min-w-0">
          <span className="block truncate text-xs font-medium">{block.name}</span>
          <span className="block text-[10px] opacity-70">{formatBytes(block.sizeBytes)}</span>
        </span>
      </button>
    );
  if (block.kind === "tool_use") {
    const artifacts = block.result ? artifactsFromDetails(block.result.details) : [];
    if (artifacts.length > 0) {
      return (
        <div className="flex w-full flex-col gap-3">
          {artifacts.map((artifact) => (
            <ArtifactView key={artifact.path} artifact={artifact} />
          ))}
        </div>
      );
    }
  }
  // Ambient context the quick launcher attached to this prompt — a compact chip.
  if (block.kind === "custom" && block.customType === "quick_context")
    return <ContextCard inner={block.text} isUser={isUser} />;
  return null;
});

/** Hover toolbar under a turn: copy the answer text, and (on the last assistant
 *  turn) regenerate it. Hidden until the row is hovered so it stays out of the
 *  way while reading. */
export function MessageActions({
  getText,
  hasText,
  createdAt,
  isUser,
  onRegenerate,
  onFork,
}: {
  /** Lazily build the clipboard string — only invoked on actual copy, so the
   *  active turn doesn't re-join its whole answer on every streaming token. */
  getText: () => string;
  /** Whether the turn has any copyable text (drives showing the copy button). */
  hasText: boolean;
  createdAt: number;
  isUser: boolean;
  onRegenerate?: () => void;
  onFork?: () => void;
}) {
  const { t } = useTranslation("chat");
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    const text = getText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error("copy failed", e);
    }
  }, [getText]);

  return (
    <div
      data-message-actions
      className={cn(
        "flex items-center gap-1 transition-opacity",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      <MessageTimestamp ts={createdAt} />
      {hasText && (
        <button
          type="button"
          onClick={copy}
          title={copied ? t("bubble.copied") : t("bubble.copy")}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? t("bubble.copied") : t("bubble.copy")}
        </button>
      )}
      {onRegenerate && (
        <button
          type="button"
          onClick={onRegenerate}
          title={t("bubble.regenerate")}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <RotateCcw className="size-3" />
          {t("bubble.regenerate")}
        </button>
      )}
      {onFork && (
        <button
          type="button"
          onClick={onFork}
          title={t("bubble.fork")}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <GitFork className="size-3" />
          {t("bubble.fork")}
        </button>
      )}
    </div>
  );
}

/** Shows clock time inline and the full date in the browser tooltip. Keep this
 *  node ref-free: virtualized histories detach many timestamps in one commit,
 *  and a compound Radix trigger ref can synchronously enqueue an update for
 *  every detach, eventually tripping React's nested-update guard. */
function MessageTimestamp({ ts }: { ts: number }) {
  return (
    <span
      title={formatFullDateTime(ts)}
      className="cursor-default px-1 text-[11px] tabular-nums text-muted-foreground/70 transition-colors hover:text-foreground"
    >
      {formatTimeHM(ts)}
    </span>
  );
}
