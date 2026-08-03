"use client";
import { ArrowLeftRight, CornerDownRight } from "lucide-react";
import type { RenderedBlock, RenderedMessage } from "@/lib/types";
import { useMessage } from "@/lib/chat-store";
import { BACKENDS } from "./backend-picker";
import { VisionCard } from "./vision-card";
import { BashCard } from "./bash-card";
import { AnswerBlock, MessageActions } from "./message-blocks";
import { messageHoverProps } from "./hover-owner";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";

interface Props {
  /** Subscription mode: re-renders only when the message at this key changes. */
  convId?: string | null;
  messageKey?: string;
  /** Legacy direct-prop mode (used by callers that already hold the message). */
  message?: RenderedMessage;
  /** Copy this conversation through this message into a new conversation. */
  onFork?: () => void;
}

/** Renders a single non-assistant message — user input or a custom extension
 *  breadcrumb. Assistant turns are rendered (and grouped) by AssistantGroup, so
 *  they never reach this component. */
export function MessageBubble({
  convId,
  messageKey,
  message: directMessage,
  onFork,
}: Props) {
  // Pull from the store when we got a key — fine-grained re-renders during
  // streaming. Otherwise fall through to whatever the caller passed in.
  const subscribed = useMessage(convId, messageKey ?? "");
  const message = directMessage ?? subscribed;
  if (!message) return null;
  return <MessageBubbleView message={message} onFork={onFork} />;
}

/** Concatenate a message's text blocks (markdown source) for the clipboard. */
function messageText(message: RenderedMessage): string {
  return message.blocks
    .filter((b): b is Extract<RenderedBlock, { kind: "text" }> => b.kind === "text")
    .map((b) => b.text)
    .join("\n\n")
    .trim();
}

function MessageBubbleView({
  message,
  onFork,
}: {
  message: RenderedMessage;
  onFork?: () => void;
}) {
  const { t } = useTranslation("chat");
  const isUser = message.role === "user";
  // A user message that leads with a `>` blockquote was composed via "Add to
  // chat": lift the quote back out and show it as a ChatGPT-style header above
  // the bubble instead of raw `> ` lines inside it.
  const quoteSplit = isUser ? splitUserQuote(message.blocks) : null;
  const blocks = quoteSplit?.blocks ?? message.blocks;

  // Custom messages (e.g. vision_describe) sit center-aligned and unstyled —
  // they're extension breadcrumbs, not a participant in the conversation. The
  // vision_describe breadcrumb shows what the vision model saw on the user's
  // behalf, so align it left with the assistant.
  if (message.role === "custom") {
    // The runtime-switch audit marker renders as a full-width divider, not a
    // card — it separates "what ran on the old runtime" from what follows.
    const runtimeSwitch = message.blocks.find(
      (b) => b.kind === "custom" && b.customType === "runtime_switch",
    );
    if (runtimeSwitch && runtimeSwitch.kind === "custom") {
      return (
        <RuntimeSwitchDivider text={runtimeSwitch.text} details={runtimeSwitch.details} />
      );
    }
    return (
      <div className="flex w-full justify-start py-2">
        <div className="flex w-full max-w-[88%] flex-col gap-2 items-start">
          {message.blocks.map((b, i) => {
            if (b.kind !== "custom") return null;
            if (b.customType === "vision_describe")
              return <VisionCard key={i} text={b.text} details={b.details} />;
            if (b.customType === "bash_exec")
              return <BashCard key={i} command={b.text} details={b.details} />;
            return null;
          })}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn("flex w-full gap-3 py-3", isUser ? "justify-end" : "justify-start")}
      data-testid={`message-${message.role}`}
    >
      <div
        data-message-hover-target
        {...messageHoverProps}
        className={cn(
          "flex max-w-[88%] flex-col gap-2",
          isUser ? "items-end" : "items-start",
        )}
      >
        {!isUser && (
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("pane.assistant")}
          </div>
        )}
        {quoteSplit && (
          <div className="flex max-w-full items-start gap-1.5 px-1 text-[13px] leading-relaxed text-muted-foreground">
            <CornerDownRight className="mt-1 size-3.5 shrink-0 opacity-70" />
            <span className="line-clamp-2 min-w-0 whitespace-pre-wrap break-words">
              {quoteSplit.quote}
            </span>
          </div>
        )}
        {blocks.length > 0 && (
          <div
            className={cn(
              "flex w-fit max-w-full flex-col gap-2",
              isUser && "rounded-2xl bg-primary/15 px-4 py-2 dark:bg-primary/20",
            )}
          >
            {blocks.map((b, i) => (
              <AnswerBlock key={i} block={b} isUser={isUser} />
            ))}
          </div>
        )}
        <MessageActions
          getText={() => messageText(message)}
          hasText={message.blocks.some((b) => b.kind === "text" && b.text.trim().length > 0)}
          createdAt={message.createdAt}
          isUser={isUser}
          onFork={onFork}
        />
      </div>
    </div>
  );
}

/** Split a leading `>` blockquote (the "Add to chat" wire format) off a user
 *  message's first text block. Returns the quote plus the blocks with the
 *  quote removed, or null when the message doesn't start with a blockquote. */
function splitUserQuote(
  blocks: RenderedBlock[],
): { quote: string; blocks: RenderedBlock[] } | null {
  const idx = blocks.findIndex((b) => b.kind === "text");
  if (idx === -1) return null;
  const block = blocks[idx];
  if (block.kind !== "text") return null;
  const lines = block.text.split("\n");
  let end = 0;
  while (end < lines.length && /^>(\s|$)/.test(lines[end])) end++;
  if (end === 0) return null;
  const quote = lines
    .slice(0, end)
    .map((line) => line.replace(/^> ?/, ""))
    .join("\n")
    .trim();
  if (!quote) return null;
  const rest = lines.slice(end).join("\n").trim();
  const next = blocks.slice();
  if (rest) next[idx] = { ...block, text: rest };
  else next.splice(idx, 1);
  return { quote, blocks: next };
}

/** Display label for a backend id carried by a runtime_switch marker. */
function backendLabel(id: unknown): string | null {
  if (typeof id !== "string" || !id) return null;
  return BACKENDS.find((b) => b.id === id)?.label ?? id;
}

/** The runtime-switch audit marker: a centered divider ("Codex → Claude Code")
 *  making the provider change explicit in the transcript — context above ran on
 *  the old runtime, everything below runs on the new one. */
function RuntimeSwitchDivider({ text, details }: { text: string; details?: unknown }) {
  const { t } = useTranslation("chat");
  const d = (details ?? {}) as { from?: unknown; to?: unknown };
  const from = backendLabel(d.from);
  const to = backendLabel(d.to);
  const label = from && to ? `${from} → ${to}` : text;
  return (
    <div className="flex w-full items-center gap-3 py-3" data-testid="runtime-switch">
      <div className="h-px flex-1 bg-border/60" />
      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <ArrowLeftRight className="size-3 opacity-70" />
        {t("bubble.runtimeSwitch")} {label}
      </span>
      <div className="h-px flex-1 bg-border/60" />
    </div>
  );
}
