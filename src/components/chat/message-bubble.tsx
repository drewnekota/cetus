"use client";
import { ArrowLeftRight } from "lucide-react";
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
  /** Roll back + rerun this turn. Wired only on a trailing user bubble that the
   *  agent never replied to (interrupted before its first message). */
  onRegenerate?: () => void;
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
  onRegenerate,
  onFork,
}: Props) {
  // Pull from the store when we got a key — fine-grained re-renders during
  // streaming. Otherwise fall through to whatever the caller passed in.
  const subscribed = useMessage(convId, messageKey ?? "");
  const message = directMessage ?? subscribed;
  if (!message) return null;
  return <MessageBubbleView message={message} onRegenerate={onRegenerate} onFork={onFork} />;
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
  onRegenerate,
  onFork,
}: {
  message: RenderedMessage;
  onRegenerate?: () => void;
  onFork?: () => void;
}) {
  const { t } = useTranslation("chat");
  const isUser = message.role === "user";

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
        <div
          className={cn(
            "flex w-fit max-w-full flex-col gap-2",
            isUser && "rounded-2xl bg-primary/15 px-4 py-2 dark:bg-primary/20",
          )}
        >
          {message.blocks.map((b, i) => (
            <AnswerBlock key={i} block={b} isUser={isUser} />
          ))}
        </div>
        <MessageActions
          getText={() => messageText(message)}
          hasText={message.blocks.some((b) => b.kind === "text" && b.text.trim().length > 0)}
          createdAt={message.createdAt}
          isUser={isUser}
          onRegenerate={isUser ? onRegenerate : undefined}
          onFork={onFork}
        />
      </div>
    </div>
  );
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
