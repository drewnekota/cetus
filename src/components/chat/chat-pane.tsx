"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { MessageBubble } from "@/components/chat/message-bubble";
import { AssistantGroup } from "@/components/chat/assistant-turn";
import { AgentControlCard } from "@/components/chat/agent-control-card";
import { GlyphBackdrop } from "@/components/chat/glyph-backdrop";
import { AlertTriangle, ArrowUp, MessageCircle, RotateCw, X } from "lucide-react";
import {
  Composer,
  type ComposerAttachment,
  type QuoteRequest,
  type QueuedMessage,
} from "@/components/chat/composer";
import {
  useAwaitingAssistant,
  useChatError,
  useHasMessages,
  useIsStreaming,
  useMessageKeys,
  useMessageRoles,
} from "@/lib/chat-store";
import { useTranslation } from "@/lib/i18n";
import { flavorHeadline } from "@/lib/chat-flavor";
import type { ModelChoice } from "@/lib/types";

interface Props {
  /** Conversation id to subscribe to. Null means "new chat" — shows hero. */
  convId: string | null;
  modelChoice: ModelChoice;
  onModelChange: (next: ModelChoice) => void;
  workspaceDir: string | null;
  defaultWorkspace: string;
  onWorkspaceChange: (dir: string) => void;
  onSend: (text: string, attachments: ComposerAttachment[]) => void;
  /** Route a leading-`!` command from the Composer to the Terminal surface. */
  onBash?: (command: string) => void;
  onAbort: () => void;
  /** Roll back + rerun the last turn. Wired only on the last assistant message.
   *  Omitted (e.g. detail dialog) → no Regenerate button. */
  onRegenerate?: () => void;
  /** Roll back + rerun the last (failed) turn — drives the inline error row's
   *  Retry button. Same handler as onRegenerate but shown on send failure. */
  onRetry?: () => void;
  /** Copy the current conversation through a specific message into a new chat. */
  onForkMessage?: (messageKey: string, messageIndex: number) => void;
  /** Whether a retry is currently in flight (disables/animates the button). */
  retrying?: boolean;
  /** Follow-up queue (messages typed while the agent is mid-run). When omitted,
   *  the composer falls back to immediate steer while streaming. */
  queued?: QueuedMessage[];
  onQueue?: (text: string, attachments: ComposerAttachment[]) => void;
  onSteerQueued?: (id: string) => void;
  onRemoveQueued?: (id: string) => void;
  /** Ultra Code state + toggle, forwarded to the composer. */
  ultra?: boolean;
  onUltraToggle?: () => void;
  focusToken: number;
  /** Persist the composer's unsent draft under this key (forwarded to Composer).
   *  Omit to keep the draft ephemeral (e.g. the detail dialog). */
  draftKey?: string;
  /** Headline shown above the composer when no messages exist yet. */
  emptyHeadline?: string;
  /** Visually pause the composer (e.g. detail dialog before history loads). */
  disabled?: boolean;
}

/** The shared "chat experience" body — messages list + composer with
 *  workspace/model pickers. Used by the main chat view, the new-task dialog,
 *  and the session detail dialog so each one feels identical to compose in.
 *  Sticks to the bottom while streaming, releases stick when the user scrolls
 *  up (so reading older context doesn't fight live updates). */
export function ChatPane({
  convId,
  modelChoice,
  onModelChange,
  workspaceDir,
  defaultWorkspace,
  onWorkspaceChange,
  onSend,
  onBash,
  onAbort,
  onRegenerate,
  onRetry,
  onForkMessage,
  retrying,
  queued,
  onQueue,
  onSteerQueued,
  onRemoveQueued,
  ultra,
  onUltraToggle,
  focusToken,
  draftKey,
  emptyHeadline,
  disabled,
}: Props) {
  const { locale } = useTranslation("chat");
  const hasMessages = useHasMessages(convId);
  const isStreaming = useIsStreaming(convId);
  const [quoteRequest, setQuoteRequest] = useState<QuoteRequest | null>(null);
  const quoteIdRef = useRef(0);
  // A fresh greeting per new chat. Keyed on focusToken (bumped when "New chat"
  // is clicked) + convId + locale so it re-rolls on a new chat but stays put
  // across keystrokes/re-renders. An explicit emptyHeadline prop still wins.
  const randomHeadline = useMemo(
    () => flavorHeadline(locale),
    [locale, convId, focusToken],
  );
  const headline = emptyHeadline ?? randomHeadline;
  const addQuote = useCallback((text: string) => {
    quoteIdRef.current += 1;
    setQuoteRequest({ id: quoteIdRef.current, text });
  }, []);

  if (!hasMessages) {
    return (
      <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-6">
        <GlyphBackdrop />
        <div className="relative z-10 w-full max-w-2xl space-y-5">
          <h2 className="text-center font-serif text-3xl italic tracking-tight text-foreground">
            {headline}
          </h2>
          <Composer
            variant="hero"
            focusToken={focusToken}
            draftKey={draftKey}
            disabled={disabled}
            streaming={isStreaming}
            modelChoice={modelChoice}
            onModelChange={onModelChange}
            workspaceDir={workspaceDir}
            defaultWorkspace={defaultWorkspace}
            onWorkspaceChange={onWorkspaceChange}
            onSend={onSend}
            onBash={onBash}
            onAbort={onAbort}
            ultra={ultra}
            onUltraToggle={onUltraToggle}
            quoteRequest={quoteRequest}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <MessageList
        convId={convId}
        isStreaming={isStreaming}
        onRegenerate={onRegenerate}
        onRetry={onRetry}
        onForkMessage={onForkMessage}
        retrying={retrying}
        onQuote={addQuote}
      />
      <div className="relative z-10 bg-background px-4 pb-3 pt-2">
        <div className="mx-auto max-w-3xl space-y-2">
          {convId ? <AgentControlCard conversationId={convId} /> : null}
          <QueuedMessages
            items={queued ?? []}
            onSteer={onSteerQueued}
            onRemove={onRemoveQueued}
          />
          <Composer
            variant="docked"
            focusToken={focusToken}
            draftKey={draftKey}
            disabled={disabled}
            streaming={isStreaming}
            modelChoice={modelChoice}
            onModelChange={onModelChange}
            workspaceDir={workspaceDir}
            defaultWorkspace={defaultWorkspace}
            onWorkspaceChange={onWorkspaceChange}
            onSend={onSend}
            onQueue={onQueue}
            onBash={onBash}
            onAbort={onAbort}
            ultra={ultra}
            onUltraToggle={onUltraToggle}
            quoteRequest={quoteRequest}
          />
        </div>
      </div>
    </div>
  );
}

type MessageGroup =
  | { kind: "assistant"; keys: string[] }
  | { kind: "single"; key: string };

/** Collapse consecutive assistant/tool messages (one agent loop) into a single
 *  group; user and custom messages stay standalone. */
function buildGroups(keys: string[], roles: string[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let run: string[] | null = null;
  const flush = () => {
    if (run) {
      groups.push({ kind: "assistant", keys: run });
      run = null;
    }
  };
  for (let i = 0; i < keys.length; i++) {
    const role = roles[i] ?? "assistant";
    if (role === "assistant" || role === "tool") {
      if (!run) run = [];
      run.push(keys[i]);
    } else {
      flush();
      groups.push({ kind: "single", key: keys[i] });
    }
  }
  flush();
  return groups;
}

/** Isolated so per-token store updates don't re-render the composer subtree.
 *  Each MessageBubble subscribes to its own slot, so a streaming text_delta
 *  repaints exactly one bubble. The list container only re-renders when
 *  messages are added or removed (message_start / user_sent). */
function MessageList({
  convId,
  isStreaming,
  onRegenerate,
  onRetry,
  onForkMessage,
  retrying,
  onQuote,
}: {
  convId: string | null;
  isStreaming: boolean;
  onRegenerate?: () => void;
  onRetry?: () => void;
  onForkMessage?: (messageKey: string, messageIndex: number) => void;
  retrying?: boolean;
  onQuote: (text: string) => void;
}) {
  const keys = useMessageKeys(convId);
  const roles = useMessageRoles(convId);
  // Merge consecutive assistant (+tool) messages into one group so the whole
  // agent loop reads as a single turn — one ASSISTANT header, one activity
  // timeline — instead of a header + tool cards per round.
  const groups = useMemo(() => buildGroups(keys, roles), [keys, roles]);
  const awaiting = useAwaitingAssistant(convId);
  // When the turn errored, the inline MessageError row owns the Retry action —
  // don't also put a Regenerate on the trailing user bubble (avoid two buttons).
  const hasError = !!useChatError(convId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = distance < 32;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Scroll on add/remove (keys array reference changes).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [keys]);

  // Stick to bottom whenever the content actually grows — token deltas mutate
  // the tail bubble's height without changing `keys`. A ResizeObserver fires
  // only on real layout changes, so we no longer reflow every animation frame
  // for the whole stream (the old rAF loop was a continuous jank source).
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (stickToBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={scrollRef}
      className="scrollbar-slim relative min-h-0 flex-1 overscroll-contain overflow-y-auto bg-background"
      data-testid="message-list"
    >
      <QuoteSelectionToolbar containerRef={contentRef} scrollRef={scrollRef} onQuote={onQuote} />
      <div ref={contentRef} className="mx-auto max-w-3xl px-6 py-4">
        {groups.map((g, gi) => {
          const isLast = gi === groups.length - 1;
          const messageIndex =
            g.kind === "assistant"
              ? keys.indexOf(g.keys[g.keys.length - 1])
              : keys.indexOf(g.key);
          const forkMessageKey =
            g.kind === "assistant" ? g.keys[g.keys.length - 1] : g.key;
          const node =
            g.kind === "assistant" ? (
              <AssistantGroup
                convId={convId}
                keys={g.keys}
                onRegenerate={onRegenerate && !isStreaming && isLast ? onRegenerate : undefined}
                onFork={
                  onForkMessage && messageIndex >= 0
                    ? () => onForkMessage(forkMessageKey, messageIndex)
                    : undefined
                }
              />
            ) : (
              <MessageBubble
                convId={convId}
                messageKey={g.key}
                // A trailing user bubble means the agent was interrupted before
                // it replied (no assistant group followed). Offer Regenerate
                // there too — retryLastTurn already handles a user-only tail.
                onRegenerate={
                  onRegenerate && isLast && !isStreaming && !awaiting && !hasError
                    ? onRegenerate
                    : undefined
                }
                onFork={
                  onForkMessage && messageIndex >= 0
                    ? () => onForkMessage(forkMessageKey, messageIndex)
                    : undefined
                }
              />
            );
          // content-visibility lets the browser skip layout + paint for turns
          // scrolled out of view WITHOUT unmounting them — so per-message store
          // subscriptions and activity-group expand state survive (a windowing
          // virtualizer would lose both). The streaming tail (last group) is left
          // always-painted so live token growth + stick-to-bottom stay exact.
          return (
            <div
              key={g.kind === "assistant" ? g.keys[0] : g.key}
              style={
                isLast
                  ? undefined
                  : { contentVisibility: "auto", containIntrinsicSize: "auto 200px" }
              }
            >
              {node}
            </div>
          );
        })}
        {awaiting && <ThinkingPlaceholder />}
        {!isStreaming && !awaiting && (
          <MessageError convId={convId} onRetry={onRetry} retrying={retrying} />
        )}
      </div>
    </div>
  );
}

function QuoteSelectionToolbar({
  containerRef,
  scrollRef,
  onQuote,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
  onQuote: (text: string) => void;
}) {
  const { t } = useTranslation("chat");
  const [selection, setSelection] = useState<{
    text: string;
    left: number;
    top: number;
  } | null>(null);

  const readSelection = useCallback(() => {
    const root = containerRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0 || sel.isCollapsed) {
      setSelection(null);
      return;
    }

    const range = sel.getRangeAt(0);
    const ancestor = range.commonAncestorContainer;
    const node = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentNode;
    if (!node || !root.contains(node)) {
      setSelection(null);
      return;
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

    setSelection({
      text,
      left: Math.round(rect.left + rect.width / 2),
      top: Math.round(Math.max(8, rect.top - 8)),
    });
  }, [containerRef]);

  useEffect(() => {
    const onPointerUp = () => window.setTimeout(readSelection, 0);
    const onKeyUp = () => readSelection();
    const onSelectionChange = () => readSelection();
    const onScroll = () => setSelection(null);

    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("keyup", onKeyUp);
    scrollRef.current?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keyup", onKeyUp);
      scrollRef.current?.removeEventListener("scroll", onScroll);
    };
  }, [readSelection, scrollRef]);

  if (!selection) return null;

  // Portal to <body>: the chat pane lives inside SidebarInset, which has a
  // `backdrop-filter` — that establishes a containing block for fixed-position
  // descendants, so a `position: fixed` toolbar rendered inline would resolve
  // its viewport coordinates against the SidebarInset box (offset by the
  // sidebar width) and drift sideways. Rendering into <body> escapes that
  // containing block so `fixed` is viewport-relative again.
  return createPortal(
    <div
      className="fixed z-50 -translate-x-1/2 -translate-y-full rounded-full border border-border bg-popover px-1 py-0.5 text-popover-foreground shadow-[0_4px_14px_rgba(0,0,0,0.10),0_1px_2px_rgba(0,0,0,0.06)]"
      style={{ left: selection.left, top: selection.top }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        type="button"
        onClick={() => {
          onQuote(selection.text);
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
    const end = node === range.endContainer ? range.endOffset : node.data.length;
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

/** Inline failure row pinned to the end of the message list: surfaces a send /
 *  run error right under the last message (rather than in the far-off header)
 *  and offers a Retry that rolls back + reruns the last turn. Self-guards on the
 *  conversation-level error, so it renders nothing on a healthy chat. */
function MessageError({
  convId,
  onRetry,
  retrying,
}: {
  convId: string | null;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const { t } = useTranslation("chat");
  const error = useChatError(convId);
  if (!error) return null;
  return (
    <div className="flex w-full justify-start py-3">
      <div className="flex max-w-[88%] items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="break-words">{error}</span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              disabled={retrying}
              className="inline-flex w-fit items-center gap-1 rounded-md border border-destructive/30 px-2 py-0.5 text-xs font-medium transition-colors hover:bg-destructive/10 disabled:opacity-50"
            >
              <RotateCw className={`size-3 ${retrying ? "animate-spin" : ""}`} />
              {retrying ? t("pane.retrying") : t("pane.retry")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The follow-up queue rendered just above the composer: messages the user
 *  typed while the agent was mid-run. Each waits for the run to end (then it's
 *  delivered as a new turn), or the user can "Steer now" to inject it into the
 *  current run immediately. */
function QueuedMessages({
  items,
  onSteer,
  onRemove,
}: {
  items: QueuedMessage[];
  onSteer?: (id: string) => void;
  onRemove?: (id: string) => void;
}) {
  const { t } = useTranslation("chat");
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {items.map((m) => {
        const label =
          m.text.trim() ||
          (m.attachments.length
            ? t("pane.attachmentCount", { count: m.attachments.length })
            : t("pane.emptyMessage"));
        return (
          <div
            key={m.id}
            className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/40 px-2.5 py-1.5 text-xs"
          >
            <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {t("pane.queued")}
            </span>
            <span className="min-w-0 flex-1 truncate text-foreground/80">{label}</span>
            <button
              type="button"
              onClick={() => onSteer?.(m.id)}
              title={t("pane.steerTooltip")}
              className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-primary transition-colors hover:bg-primary/10"
            >
              <ArrowUp className="size-3" />
              {t("pane.steerNow")}
            </button>
            <button
              type="button"
              onClick={() => onRemove?.(m.id)}
              aria-label={t("pane.removeFromQueue")}
              className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Shown between the user's send and pi's first message_start event so the
 *  conversation doesn't feel like it's hanging. Three dots, no layout shift. */
function ThinkingPlaceholder() {
  const { t } = useTranslation("chat");
  return (
    <div className="flex w-full justify-start py-3">
      <div className="flex max-w-[88%] flex-col gap-2 items-start">
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {t("pane.assistant")}
        </div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
          <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
          <span className="size-1.5 animate-bounce rounded-full bg-current" />
        </div>
      </div>
    </div>
  );
}
