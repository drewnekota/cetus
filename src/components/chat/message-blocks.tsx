"use client";
// Shared, hook-bearing renderers for the pieces of a conversation turn. Pulled
// out of message-bubble.tsx so both a single bubble (user / custom) and a
// grouped assistant turn (assistant-turn.tsx) render text, attachments, and the
// hover toolbar identically.
import { memo, useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkCjkFriendly from "remark-cjk-friendly";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { markdownComponents, LinkifiedText, normalizeMath, KATEX_OPTIONS } from "@/lib/markdown";
import { Check, Copy, FileText, GitFork, RotateCcw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { RenderedBlock } from "@/lib/types";
import { ArtifactView } from "./artifact-view";
import { ContextCard } from "./context-card";
import { isArtifactDetails, formatBytes } from "@/lib/artifact";
import { formatTimeHM, formatFullDateTime } from "@/lib/format";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";

/** Assistant markdown is expensive to parse (remark-gfm + remark-math +
 *  rehype-katex). Memoizing on the source string means a bubble only re-parses
 *  when its own text actually changes — so a sibling re-render (e.g. a new
 *  message added to the list) doesn't reparse every prior bubble. */
const AssistantMarkdown = memo(function AssistantMarkdown({ text }: { text: string }) {
  return (
    <div
      className={cn(
        "prose prose-sm dark:prose-invert max-w-none",
        // Tighten default prose spacing so chat bubbles don't blow up.
        "prose-p:my-2 prose-pre:my-2 prose-ul:my-2 prose-ol:my-2 prose-headings:my-3",
        "prose-code:rounded prose-code:bg-secondary prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:before:content-none prose-code:after:content-none",
        "prose-pre:bg-secondary prose-pre:text-foreground",
        // Tables: prose-sm shrinks th/td to ~12px and prose-code drops another 15%.
        // Keep cell text at the bubble's base size and stop nested code from shrinking further.
        "prose-th:text-sm prose-th:py-2 prose-td:text-sm prose-td:py-2",
        "[&_td_code]:text-[0.95em] [&_th_code]:text-[0.95em]"
      )}
    >
      <ReactMarkdown remarkPlugins={[[remarkGfm, { singleTilde: false }], remarkMath, remarkCjkFriendly]} rehypePlugins={[[rehypeKatex, KATEX_OPTIONS]]} components={markdownComponents}>
        {normalizeMath(text)}
      </ReactMarkdown>
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
        <AssistantMarkdown text={throttled} />
      )}
      {streaming && (
        <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-current align-middle opacity-70" />
      )}
    </div>
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
    return (
      <img
        src={block.dataUrl}
        alt={block.name ?? t("bubble.attachment")}
        title={block.name}
        className="max-h-72 rounded-lg border border-border/40 object-contain"
      />
    );
  if (block.kind === "file")
    return (
      <button
        type="button"
        onClick={() => invoke("reveal_in_finder", { path: block.path }).catch(console.error)}
        title={t("bubble.revealInFinder", { path: block.path })}
        className={cn(
          "flex max-w-xs items-center gap-2 rounded-lg border px-3 py-2 text-left",
          isUser
            ? "border-primary-foreground/20 bg-primary-foreground/10"
            : "border-border/60 bg-muted/40",
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
    // send_artifact piggybacks on the tool-call plumbing but renders as a rich
    // inline preview instead of being folded into the activity timeline.
    if (block.name === "send_artifact" && block.result && isArtifactDetails(block.result.details)) {
      return <ArtifactView artifact={block.result.details} />;
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
      className={cn(
        "flex items-center gap-1 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100",
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

/** The hover timestamp: shows clock time (HH:mm) inline, and the full date down
 *  to the second in a tooltip when you hover the time itself. */
function MessageTimestamp({ ts }: { ts: number }) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-default px-1 text-[11px] tabular-nums text-muted-foreground/70 transition-colors hover:text-foreground">
            {formatTimeHM(ts)}
          </span>
        </TooltipTrigger>
        <TooltipContent>{formatFullDateTime(ts)}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
