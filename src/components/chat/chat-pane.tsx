"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { MessageBubble } from "@/components/chat/message-bubble";
import { MessageListBoundary } from "@/components/chat/message-list-boundary";
import { AssistantGroup } from "@/components/chat/assistant-turn";
import { AgentControlCard } from "@/components/chat/agent-control-card";
import { CliControlCard } from "@/components/chat/cli-control-card";
import { GlyphBackdrop } from "@/components/chat/glyph-backdrop";
import { AlertTriangle, ArrowDown, ArrowUp, Bot, Loader2, MessageCircle, Pencil, RotateCw, X } from "lucide-react";
import {
  Composer,
  type ComposerAttachment,
  type ComposerDraftRequest,
  type QuoteRequest,
  type QueuedMessage,
} from "@/components/chat/composer";
import {
  getTurnPreview,
  useAwaitingAssistant,
  useBackgroundTasks,
  useChatError,
  useHasMessages,
  useIsStreaming,
  useMessageKeys,
  useMessageRoles,
  useRunningSubagents,
} from "@/lib/chat-store";
import { useTranslation } from "@/lib/i18n";
import { flavorHeadline } from "@/lib/chat-flavor";
import type { BackendId, ModelChoice } from "@/lib/types";
import { api } from "@/lib/tauri";

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
  onQueue?: (
    text: string,
    attachments: ComposerAttachment[],
    beforeIds?: string[],
  ) => void;
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
  /** Backend choice for the not-yet-created conversation (hero composer);
   *  forwarded to the Composer. See Composer's prop docs. */
  pendingBackend?: BackendId;
  onPendingBackendChange?: (backend: BackendId) => void;
  pendingCliModel?: string;
  pendingCliEffort?: string;
  onPendingTuningChange?: (model: string, effort: string) => void;
  /** Keyboard runtime-switch request (token-keyed), forwarded to the Composer. */
  backendSwitch?: { token: number; backend: BackendId } | null;
  /** Tab-to-cycle-runtime request, forwarded to the Composer. */
  onRequestBackendSwitch?: (backend: BackendId) => void;
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
  pendingBackend,
  onPendingBackendChange,
  pendingCliModel,
  pendingCliEffort,
  onPendingTuningChange,
  backendSwitch,
  onRequestBackendSwitch,
}: Props) {
  const { locale } = useTranslation("chat");
  const hasMessages = useHasMessages(convId);
  const isStreaming = useIsStreaming(convId);
  const [quoteRequest, setQuoteRequest] = useState<QuoteRequest | null>(null);
  const [queuedDrafts, setQueuedDrafts] = useState<
    Record<string, { request: ComposerDraftRequest; beforeIds: string[] }>
  >({});
  const queuedDraftKey = convId ?? "new";
  const queuedDraft = queuedDrafts[queuedDraftKey] ?? null;
  const quoteIdRef = useRef(0);
  const queuedDraftIdRef = useRef(0);
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
  const editQueued = useCallback(
    (id: string) => {
      const index = (queued ?? []).findIndex((item) => item.id === id);
      if (index < 0) return;
      const item = queued![index];
      queuedDraftIdRef.current += 1;
      setQueuedDrafts((drafts) => ({
        ...drafts,
        [queuedDraftKey]: {
          request: {
            id: queuedDraftIdRef.current,
            text: item.text,
            attachments: item.attachments,
          },
          // Reinsert before the first successor that still exists when the
          // edited draft is submitted. This preserves FIFO order even if
          // earlier queued turns finish while the user is editing.
          beforeIds: queued!.slice(index + 1).map((successor) => successor.id),
        },
      }));
      onRemoveQueued?.(id);
    },
    [onRemoveQueued, queued, queuedDraftKey],
  );
  const queueFromComposer = useCallback(
    (text: string, attachments: ComposerAttachment[]) => {
      onQueue?.(text, attachments, queuedDraft?.beforeIds);
      setQueuedDrafts((drafts) => {
        const { [queuedDraftKey]: _submitted, ...rest } = drafts;
        return rest;
      });
    },
    [onQueue, queuedDraft, queuedDraftKey],
  );
  const sendFromComposer = useCallback(
    (text: string, attachments: ComposerAttachment[]) => {
      onSend(text, attachments);
      setQueuedDrafts((drafts) => {
        const { [queuedDraftKey]: _submitted, ...rest } = drafts;
        return rest;
      });
    },
    [onSend, queuedDraftKey],
  );

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
            conversationId={convId}
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
            pendingBackend={pendingBackend}
            onPendingBackendChange={onPendingBackendChange}
            pendingCliModel={pendingCliModel}
            pendingCliEffort={pendingCliEffort}
            onPendingTuningChange={onPendingTuningChange}
            backendSwitch={backendSwitch}
            onRequestBackendSwitch={onRequestBackendSwitch}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <MessageListBoundary key={convId ?? "new"}>
        <MessageList
          convId={convId}
          isStreaming={isStreaming}
          onRegenerate={onRegenerate}
          onRetry={onRetry}
          onForkMessage={onForkMessage}
          retrying={retrying}
          onQuote={addQuote}
        />
      </MessageListBoundary>
      <div className="relative z-10 bg-background px-4 pb-3 pt-2">
        <div className="mx-auto max-w-3xl space-y-2">
          {convId ? <BackgroundAgentsBar convId={convId} /> : null}
          {convId ? <CliControlCard convId={convId} /> : null}
          {convId ? <AgentControlCard conversationId={convId} /> : null}
          <QueuedMessages
            items={queued ?? []}
            onSteer={onSteerQueued}
            // Only one queue item can own the composer at a time. A second edit
            // would otherwise overwrite the first removed item's only draft.
            onEdit={onRemoveQueued && !queuedDraft ? editQueued : undefined}
            onRemove={onRemoveQueued}
          />
          <Composer
            variant="docked"
            focusToken={focusToken}
            draftKey={draftKey}
            disabled={disabled}
            streaming={isStreaming}
            modelChoice={modelChoice}
            conversationId={convId}
            onModelChange={onModelChange}
            workspaceDir={workspaceDir}
            defaultWorkspace={defaultWorkspace}
            onWorkspaceChange={onWorkspaceChange}
            onSend={sendFromComposer}
            onQueue={onQueue ? queueFromComposer : undefined}
            onSendFirstQueued={
              queued?.[0] && onSteerQueued
                ? () => onSteerQueued(queued[0].id)
                : undefined
            }
            onBash={onBash}
            onAbort={onAbort}
            draftRequest={queuedDraft?.request}
            ultra={ultra}
            onUltraToggle={onUltraToggle}
            quoteRequest={quoteRequest}
            backendSwitch={backendSwitch}
            onRequestBackendSwitch={onRequestBackendSwitch}
          />
        </div>
      </div>
    </div>
  );
}

/** Awareness strip for background work owned by this conversation: subagents
 *  (claude-code run_in_background Agent/Task, e.g. an UltraCode workflow) and
 *  session-scoped tasks (Monitors, background Bash) that outlive model turns.
 *  Without it the composer just says "Agent is running…" with no hint of
 *  *what* — or, worse, the conversation looks idle while a Monitor is watching
 *  something and will wake the agent later. Two sources, merged: the bridge's
 *  live task registry (`cli_background_tasks` snapshots — authoritative for
 *  CLI backends, cleared when the session process exits) and the rendered
 *  cards' running-subagent details (covers pi-backend runs). Renders nothing
 *  when both are empty. */
function BackgroundAgentsBar({ convId }: { convId: string }) {
  const { t } = useTranslation("chat");
  const agents = useRunningSubagents(convId);
  const tasks = useBackgroundTasks(convId);
  if (agents.length === 0 && tasks.length === 0) return null;
  // Prefer the human task description; fall back to the agent/task type.
  const seen = new Set(tasks.map((task) => `${task.kind}|${task.description}`));
  const labels = [
    ...tasks.map((task) => task.description || task.kind),
    ...agents
      .filter((a) => !seen.has(`${a.type}|${a.description}`))
      .map((a) => a.description || a.type),
  ].filter(Boolean);
  const shown = labels.slice(0, 3).join(", ");
  const extra = labels.length - Math.min(labels.length, 3);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-[#d97757]/30 bg-[#d97757]/5 px-2.5 py-1.5 text-[11px] text-muted-foreground">
      <Bot className="size-3.5 shrink-0 text-[#d97757]" />
      <Loader2 className="size-3 shrink-0 animate-spin text-[#d97757]" />
      <span className="shrink-0 font-medium text-foreground">
        {t("pane.backgroundAgents.title", { count: labels.length })}
      </span>
      {shown ? (
        <span className="truncate">
          {shown}
          {extra > 0 ? t("pane.backgroundAgents.more", { count: extra }) : ""}
        </span>
      ) : null}
    </div>
  );
}

// Deadzone (px from the true bottom) within which the list counts as "at the
// bottom" — drives stick-to-bottom follow and hides the scroll-to-bottom button.
const STICKY_BOTTOM_PX = 32;
// The elevator is intentionally less eager than sticky-bottom follow: a small
// nudge away from the latest message should not summon a floating control.
const SCROLL_TO_BOTTOM_BUTTON_MIN_PX = 360;
const SCROLL_TO_BOTTOM_BUTTON_VIEWPORT_RATIO = 0.5;
// Pre-render 800px above the viewport so older turns are ready during upward
// reading, while keeping the streaming/bottom edge tight. Positive overscan can
// let a single height correction during the open-at-end
// seek (or a streaming growth spurt) mount whole extra turns in the same
// commit; on conversations with huge turns those corrections chain into 50+
// nested sync updates and React kills the tree ("Maximum update depth
// exceeded" — the v0.3.14–v0.3.16 crash family). Every crashing configuration
// observed had overscan > 0, so keep this asymmetric: pre-render history, but
// do not add mounting pressure at the streaming/bottom edge.
const OVERSCAN_PX = { top: 800, bottom: 0 } as const;

type MessageGroup =
  | { kind: "assistant"; keys: string[] }
  | { kind: "single"; key: string };

/** Everything Virtuoso can measure as a row. Transient tail UI must be a real
 * row rather than a Footer: scrollToIndex("LAST") cannot account for Footer
 * height, which made conversation-open alignment fight the streaming
 * scroll-to-bottom observer while Thinking was visible. */
type MessageListItem =
  | MessageGroup
  | { kind: "thinking" }
  | { kind: "error" };

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
  // Keep every visible tail inside Virtuoso's measured data. In particular,
  // Thinking used to live in components.Footer, below the item addressed by
  // scrollToIndex("LAST"). On conversation switch the initial seek/open settle
  // aligned the last message while the streaming observer aligned the Footer,
  // producing several visible jumps between the two positions.
  const items = useMemo<MessageListItem[]>(() => {
    if (awaiting) return [...groups, { kind: "thinking" }];
    if (!isStreaming && hasError) return [...groups, { kind: "error" }];
    return groups;
  }, [groups, awaiting, isStreaming, hasError]);

  // react-virtuoso owns the scroll container and does the hard parts natively:
  // it measures each variable-height turn and corrects scroll in the SAME frame
  // a turn grows (image/KaTeX/streaming), so content above the fold never shoves
  // the viewport — that shove is exactly the jank the old hand-rolled
  // ResizeObserver compensation fought (and lost). It also only mounts the
  // visible window (+overscan), so a long history no longer parses every turn's
  // markdown up front — retiring the content-visibility windowing this file
  // used to hand-roll.
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  // The real scroll DOM node Virtuoso hands back — needed only by the quote
  // toolbar (selection root + scroll-to-dismiss). Held in state so its effects
  // re-run once the node exists.
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  // Keep the ref callback stable. An inline callback gets a new identity on
  // every render, so React clears the old ref with `null` and attaches the new
  // one again. Calling setState from both ref calls can recurse until React
  // throws "Maximum update depth exceeded" while Virtuoso is settling a large
  // conversation (especially in the faster production build).
  const setScrollerRef = useCallback((el: HTMLElement | Window | null) => {
    const next = el instanceof HTMLElement ? el : null;
    setScroller((current) => (current === next ? current : next));
  }, []);
  const [atBottom, setAtBottom] = useState(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const atBottomRef = useRef(true);
  // Topmost visible group index (from Virtuoso's rangeChanged) — drives the turn
  // navigator's active tick with no getBoundingClientRect scanning.
  const [topIndex, setTopIndex] = useState(0);
  const pendingInitialBottomRef = useRef<string | null>(convId);
  const setAtBottomState = useCallback((next: boolean) => {
    atBottomRef.current = next;
    setAtBottom(next);
  }, []);

  // Re-arm the open settle DURING render on conversation switch (not in an
  // effect): the keyed Virtuoso remounts — and starts its initial end seek —
  // before any parent effect would run.
  const [renderedConvId, setRenderedConvId] = useState(convId);
  if (renderedConvId !== convId) {
    setRenderedConvId(convId);
    pendingInitialBottomRef.current = convId;
  }

  // User turns paired with their index in the group list, for the navigator's
  // scroll-to-turn (Virtuoso scrollToIndex) and active-tick math.
  const userTurns = useMemo(() => {
    const out: { key: string; index: number }[] = [];
    groups.forEach((g, i) => {
      if (g.kind !== "single") return;
      if (roles[keys.indexOf(g.key)] === "user") out.push({ key: g.key, index: i });
    });
    return out;
  }, [groups, keys, roles]);

  // Snap to the newest message when the user sends (even if scrolled up reading);
  // followOutput then keeps the streaming reply pinned as long as we stay at the
  // bottom. Keyed on the last message key so it fires once per send, not per
  // token — and NOT on the first non-empty observation: when a restored
  // conversation happens to end on a user turn (agent never replied), hydration
  // must not count as "the user just sent" or the open position gets yanked.
  const prevLastKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const lastKey = keys[keys.length - 1] ?? null;
    if (
      prevLastKeyRef.current !== null &&
      lastKey !== prevLastKeyRef.current &&
      roles[roles.length - 1] === "user"
    ) {
      virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end" });
    }
    prevLastKeyRef.current = lastKey;
  }, [keys, roles]);


  // Open settle. The initial end seek runs on estimated turn heights; once the
  // landing holds still for a few frames, correct the residual offset exactly
  // once through Virtuoso's own API. Everything is rAF-paced and read-only in
  // between — no scroller.scrollTop writes, no overscan changes — because any
  // extra mounting pressure during this window is what used to chain into the
  // update-depth crash on conversations with huge turns.
  useEffect(() => {
    if (!scroller || !convId || pendingInitialBottomRef.current !== convId || items.length === 0) {
      return;
    }

    let prevDist = Number.NaN;
    let stable = 0;
    let budget = 120; // frame cap
    // Wall-clock cap. The scrollHeight probe forces a style resolve whenever
    // style is dirty; on a conversation with a huge DOM that's hundreds of ms
    // PER FRAME, so a frame budget alone lets this loop freeze the app for
    // minutes. Past the deadline the residual-offset correction is cosmetic —
    // give it up.
    const deadline = performance.now() + 2000;
    let frame = requestAnimationFrame(function step() {
      if (--budget <= 0 || performance.now() > deadline) {
        // Mark the open as done even though we never settled: leaving the ref
        // armed re-runs this whole loop on every items.length change (streamed
        // or hydrated items), which re-freezes a pathological conversation
        // indefinitely.
        pendingInitialBottomRef.current = null;
        return;
      }
      if (stable < 3) {
        // "Settled" = the distance to the bottom stopped moving — true both for
        // the normal landing AND when the user immediately scrolled elsewhere.
        const dist = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        stable = Math.abs(dist - prevDist) <= 1 ? stable + 1 : 0;
        prevDist = dist;
        frame = requestAnimationFrame(step);
        return;
      }
      pendingInitialBottomRef.current = null; // settled — this open is done
      // Only correct when meaningfully off; a settled-at-bottom open (or a user
      // who already scrolled away on purpose) needs no seek at all.
      if (prevDist > 1 && atBottomRef.current) {
        virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [convId, items.length, scroller]);

  // Streaming follow. Virtuoso's followOutput only reacts to NEW items; a
  // streaming reply grows an EXISTING item, so without help the view strands
  // slightly above the growing tail. Watch the item list itself — its height
  // tracks the content (the previously-observed viewport wrapper is height:100%
  // and never fires) — and, while the reader is pinned to the bottom, chase the
  // growth one rAF-paced write per frame.
  useEffect(() => {
    if (!scroller || !isStreaming) return;
    const content = scroller.querySelector('[data-testid="virtuoso-item-list"]');
    if (!content) return;

    let frame: number | null = null;
    const scrollIfPinned = () => {
      if (!atBottomRef.current) return;
      if (frame != null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (atBottomRef.current) scroller.scrollTop = scroller.scrollHeight;
      });
    };

    const ro = new ResizeObserver(scrollIfPinned);
    ro.observe(content);
    return () => {
      ro.disconnect();
      if (frame != null) cancelAnimationFrame(frame);
    };
  }, [isStreaming, scroller]);

  useEffect(() => {
    if (!scroller) return;

    let frame: number | null = null;
    const updateVisibility = () => {
      frame = null;
      const distanceFromBottom =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      const threshold = Math.max(
        SCROLL_TO_BOTTOM_BUTTON_MIN_PX,
        scroller.clientHeight * SCROLL_TO_BOTTOM_BUTTON_VIEWPORT_RATIO,
      );
      setShowScrollToBottom(distanceFromBottom > threshold);
    };
    const scheduleUpdate = () => {
      if (frame != null) return;
      frame = requestAnimationFrame(updateVisibility);
    };

    updateVisibility();
    scroller.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      scroller.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      if (frame != null) cancelAnimationFrame(frame);
    };
  }, [scroller, items.length]);

  const itemContent = useCallback(
    (index: number, item: MessageListItem) => {
      if (item.kind === "thinking") {
        return (
          <div className="mx-auto max-w-3xl px-6">
            <ThinkingPlaceholder />
          </div>
        );
      }
      if (item.kind === "error") {
        return (
          <div className="mx-auto max-w-3xl px-6">
            <MessageError convId={convId} onRetry={onRetry} retrying={retrying} />
          </div>
        );
      }

      const g = item;
      const isLast = index === items.length - 1;
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
            // A trailing user bubble means the agent was interrupted before it
            // replied (no assistant group followed). Offer Regenerate there too —
            // retryLastTurn already handles a user-only tail.
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
      // Center each turn on the reading column. Virtuoso measures this wrapper.
      return <div className="mx-auto max-w-3xl px-6">{node}</div>;
    },
    [
      items.length,
      keys,
      convId,
      onRegenerate,
      isStreaming,
      onForkMessage,
      awaiting,
      hasError,
      onRetry,
      retrying,
    ],
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <QuoteSelectionToolbar scroller={scroller} onQuote={onQuote} />
      <Virtuoso
        // Remount on conversation switch so the new chat lands at its own bottom
        // (initialTopMostItemIndex only applies at mount), with no scroll
        // position carried over from the previous conversation.
        key={convId ?? "new"}
        ref={virtuosoRef}
        scrollerRef={setScrollerRef}
        data={items}
        data-testid="message-list"
        className="scrollbar-slim min-h-0 flex-1 overscroll-contain bg-background"
        computeItemKey={(_i, item) => {
          if (item.kind === "assistant") return item.keys[0];
          if (item.kind === "single") return item.key;
          return `${convId ?? "new"}:tail:${item.kind}`;
        }}
        itemContent={itemContent}
        components={{ Header: TopSpacer }}
        // Align the LAST visible row to the viewport's BOTTOM on open. Thinking
        // and errors are rows too, so every bottom-follow path now targets the
        // same measured edge.
        initialTopMostItemIndex={{ index: Math.max(0, items.length - 1), align: "end" }}
        // Do not use alignToBottom: it pins a short/new conversation to the
        // bottom of the empty viewport. The initial index already opens an
        // overflowing history at its newest turn, while short chats keep the
        // normal top-down IM layout.
        followOutput={(isAtBottom) => (isAtBottom ? "auto" : false)}
        atBottomThreshold={STICKY_BOTTOM_PX}
        atBottomStateChange={setAtBottomState}
        rangeChanged={(range) => setTopIndex(range.startIndex)}
        increaseViewportBy={OVERSCAN_PX}
      />
      <TurnNavigator
        convId={convId}
        userTurns={userTurns}
        topIndex={topIndex}
        atBottom={atBottom}
        virtuosoRef={virtuosoRef}
      />
      <ScrollToBottomButton show={showScrollToBottom} virtuosoRef={virtuosoRef} />
    </div>
  );
}

/** Small breathing room above the first turn (Virtuoso Header slot). */
const TopSpacer = () => <div className="h-4" />;

/** Codex-style turn navigator: a thin gutter of ticks down the left edge, one
 *  per user turn. Ticks are evenly spaced and clustered together, vertically
 *  centered in the viewport (not spread across the full scroll height). The
 *  active tick (turn nearest the top of the viewport) brightens as you
 *  scroll; hovering a tick reveals a preview popover; click scrolls that turn
 *  to the top. Lives in the otherwise-empty left margin (content is centered
 *  max-w-3xl), and is pointer-transparent except on the ticks themselves so
 *  it never fights text selection. */
function TurnNavigator({
  convId,
  userTurns,
  topIndex,
  atBottom,
  virtuosoRef,
}: {
  convId: string | null;
  /** User turns paired with their index in the virtualized group list. */
  userTurns: { key: string; index: number }[];
  /** Topmost visible group index, published by the list's rangeChanged. */
  topIndex: number;
  /** Whether the message list is currently pinned to its bottom edge. */
  atBottom: boolean;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
}) {
  const [hover, setHover] = useState<number | null>(null);

  // At the bottom, the newest turn wins explicitly. During a conversation
  // switch Virtuoso can briefly publish an intermediate range while its
  // initial end seek settles; using that range alone leaves a middle tick
  // highlighted even though the viewport has already landed at the bottom.
  // Away from the bottom, keep tracking the last user turn at or above the
  // top of the viewport.
  const active = useMemo(() => {
    if (atBottom) return Math.max(0, userTurns.length - 1);
    let next = 0;
    for (let i = 0; i < userTurns.length; i++) {
      if (userTurns[i].index <= topIndex) next = i;
      else break;
    }
    return next;
  }, [atBottom, userTurns, topIndex]);

  if (userTurns.length < 2) return null;

  return (
    <div className="pointer-events-none absolute inset-y-0 left-0 z-20 hidden w-12 sm:flex sm:flex-col sm:items-start sm:justify-center">
      <div className="flex flex-col items-start gap-0">
        {userTurns.map((turn, i) => {
          const isActive = i === active;
          return (
            <div
              key={turn.key}
              className="pointer-events-auto relative flex items-center"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((h) => (h === i ? null : h))}
            >
              <button
                type="button"
                aria-label={`Jump to message ${i + 1}`}
                onClick={() =>
                  virtuosoRef.current?.scrollToIndex({
                    index: turn.index,
                    align: "start",
                    behavior: "smooth",
                  })
                }
                className="group flex h-1.5 items-center pl-3 pr-2"
              >
                <span
                  className={`block h-0.5 w-2.5 origin-left rounded-full transition-[background-color,transform] duration-100 group-hover:scale-x-[2] ${
                    isActive
                      ? "bg-foreground/60 group-hover:bg-foreground"
                      : "bg-muted-foreground/40 group-hover:bg-foreground"
                  }`}
                />
              </button>
              {hover === i && <TurnPreview convId={convId} turnKey={turn.key} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TurnPreview({
  convId,
  turnKey,
}: {
  convId: string | null;
  turnKey: string;
}) {
  const { prompt, reply } = useMemo(
    () => getTurnPreview(convId, turnKey),
    [convId, turnKey],
  );
  if (!prompt && !reply) return null;
  return (
    <div className="pointer-events-none absolute left-9 top-1/2 w-72 -translate-y-1/2 rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-[0_6px_18px_rgba(0,0,0,0.08),0_1px_3px_rgba(0,0,0,0.06)]">
      {prompt && (
        <p className="line-clamp-2 text-xs font-medium text-foreground">{prompt}</p>
      )}
      {reply && (
        <p className="mt-1.5 line-clamp-3 text-xs text-muted-foreground">{reply}</p>
      )}
    </div>
  );
}

/** "Message elevator": a floating button that appears when the reader has
 *  scrolled up away from the bottom of the conversation, and jumps them back
 *  down in one click. Lives outside the scroll container (as a sibling overlay)
 *  so it stays pinned to the viewport instead of scrolling with the messages.
 *  Visibility is deliberately stricter than Virtuoso's atBottom state so short
 *  reading nudges do not summon a floating control. */
function ScrollToBottomButton({
  show,
  virtuosoRef,
}: {
  show: boolean;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
}) {
  const { t } = useTranslation("chat");

  const scrollToBottom = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({
      index: "LAST",
      align: "end",
      behavior: "smooth",
    });
  }, [virtuosoRef]);

  return (
    <button
      type="button"
      aria-label={t("pane.scrollToBottom")}
      title={t("pane.scrollToBottom")}
      onClick={scrollToBottom}
      className={`absolute bottom-4 left-1/2 z-30 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-popover text-foreground shadow-[0_4px_14px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.08)] transition-all duration-150 hover:bg-muted ${
        show
          ? "pointer-events-auto translate-y-0 opacity-100"
          : "pointer-events-none translate-y-2 opacity-0"
      }`}
    >
      <ArrowDown className="size-4" />
    </button>
  );
}

function QuoteSelectionToolbar({
  scroller,
  onQuote,
}: {
  /** The Virtuoso scroll element: selection root + scroll-to-dismiss source. */
  scroller: HTMLElement | null;
  onQuote: (text: string) => void;
}) {
  const { t } = useTranslation("chat");
  const [selection, setSelection] = useState<{
    range: Range;
    text: string;
    left: number;
    top: number;
  } | null>(null);

  const clearSelection = useCallback(() => {
    const root = scroller;
    const sel = window.getSelection();
    if (root && sel && selectionBelongsToRoot(root, sel)) {
      sel.removeAllRanges();
    }
    setSelection(null);
  }, [scroller]);

  const readSelection = useCallback(() => {
    const root = scroller;
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

    const left = Math.round(rect.left + rect.width / 2);
    const top = Math.round(Math.max(8, rect.top - 8));

    setSelection((prev) => {
      if (
        prev &&
        prev.text === text &&
        prev.left === left &&
        prev.top === top &&
        sameRangeBoundaries(prev.range, range)
      ) {
        return prev;
      }

      return {
        range: range.cloneRange(),
        text,
        left,
        top,
      };
    });
  }, [scroller]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-quote-selection-toolbar]")) return;

      const root = scroller;
      const sel = window.getSelection();
      if (!root || !sel || !selectionBelongsToRoot(root, sel)) return;

      sel.removeAllRanges();
      setSelection(null);
    };
    const onPointerUp = () => window.setTimeout(readSelection, 0);
    const onKeyUp = () => readSelection();
    const onSelectionChange = () => readSelection();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearSelection();
    };
    const onScroll = () => clearSelection();

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("keydown", onKeyDown);
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("keydown", onKeyDown);
      scroller?.removeEventListener("scroll", onScroll);
    };
  }, [clearSelection, readSelection, scroller]);

  if (!selection) return null;

  // Portal to <body>: the chat pane lives inside SidebarInset, which has a
  // `backdrop-filter` — that establishes a containing block for fixed-position
  // descendants, so a `position: fixed` toolbar rendered inline would resolve
  // its viewport coordinates against the SidebarInset box (offset by the
  // sidebar width) and drift sideways. Rendering into <body> escapes that
  // containing block so `fixed` is viewport-relative again.
  return createPortal(
    <div
      data-quote-selection-toolbar
      className="fixed z-50 -translate-x-1/2 -translate-y-full select-none rounded-full border border-border bg-popover px-1 py-0.5 text-popover-foreground shadow-[0_4px_14px_rgba(0,0,0,0.10),0_1px_2px_rgba(0,0,0,0.06)]"
      style={{ left: selection.left, top: selection.top }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        type="button"
        onClick={() => {
          onQuote(serializeSelection(selection.range));
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

function sameRangeBoundaries(a: Range, b: Range): boolean {
  return (
    a.startContainer === b.startContainer &&
    a.startOffset === b.startOffset &&
    a.endContainer === b.endContainer &&
    a.endOffset === b.endOffset
  );
}

function selectionBelongsToRoot(root: HTMLElement, sel: Selection): boolean {
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    const ancestor = range.commonAncestorContainer;
    const node = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentNode;
    if (node && root.contains(node)) return true;
  }
  return false;
}

// Turn a live selection Range into plain text suitable for a `>` blockquote.
//
// `Selection.toString()` is unusable on rendered markdown that contains KaTeX:
// each math atom is its own inline-block span, so the serializer emits a newline
// after every character (turning `$0**$` into `0\n*\n*`), and the hidden MathML
// mirror gets duplicated alongside the visible render. Instead we clone the
// selected DOM, swap every `.katex` node back to its LaTeX source (pulled from
// the MathML `annotation`), then read `innerText` — which collapses the render
// noise while still honoring real block boundaries (paragraphs, list items).
function serializeSelection(range: Range): string {
  const container = document.createElement("div");
  container.appendChild(range.cloneContents());

  container.querySelectorAll(".katex").forEach((el) => {
    const tex = el
      .querySelector('annotation[encoding="application/x-tex"]')
      ?.textContent?.trim();
    // Always double-dollar: single-dollar math parsing is disabled (see
    // REMARK_MATH_OPTIONS), so `$…$` would no longer round-trip as math.
    const replacement = tex ? `$$${tex}$$` : (el.textContent ?? "");
    el.replaceWith(document.createTextNode(replacement));
  });

  // `innerText` needs layout, so the node must be attached and rendered. Keep it
  // offscreen and preserve line breaks, then remove it synchronously.
  container.style.cssText =
    "position:fixed;left:-99999px;top:0;white-space:pre-wrap;";
  document.body.appendChild(container);
  const text = container.innerText;
  container.remove();
  return text.trim();
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
 *  current run immediately, or return it to the composer for editing. */
function QueuedMessages({
  items,
  onSteer,
  onEdit,
  onRemove,
}: {
  items: QueuedMessage[];
  onSteer?: (id: string) => void;
  onEdit?: (id: string) => void;
  onRemove?: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {items.map((m) => (
        <QueuedMessageRow
          key={m.id}
          item={m}
          onSteer={onSteer}
          onEdit={onEdit}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}

function QueuedMessageRow({
  item,
  onSteer,
  onEdit,
  onRemove,
}: {
  item: QueuedMessage;
  onSteer?: (id: string) => void;
  onEdit?: (id: string) => void;
  onRemove?: (id: string) => void;
}) {
  const { t } = useTranslation("chat");
  const label =
    item.text.trim() ||
    (item.attachments.length
      ? t("pane.attachmentCount", { count: item.attachments.length })
      : t("pane.emptyMessage"));

  return (
    <div className="group flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/40 px-2.5 py-1.5 text-xs">
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {t("pane.queued")}
      </span>
      <span className="min-w-0 flex-1 truncate text-foreground/80">{label}</span>
      {onEdit && (
        <button
          type="button"
          onClick={() => onEdit(item.id)}
          title={t("pane.editQueued")}
          aria-label={t("pane.editQueued")}
          className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Pencil className="size-3" />
        </button>
      )}
      {onSteer && (
        <button
          type="button"
          onClick={() => onSteer(item.id)}
          title={t("pane.steerTooltip")}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-primary transition-colors hover:bg-primary/10"
        >
          <ArrowUp className="size-3" />
          {t("pane.steerNow")}
        </button>
      )}
      <button
        type="button"
        onClick={() => onRemove?.(item.id)}
        aria-label={t("pane.removeFromQueue")}
        className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** Shown between the user's send and the first message_start event so the
 *  conversation doesn't feel like it's hanging. For CLI backends
 *  (claude-code / codex) this covers the whole process boot — message_start is
 *  deferred until real content streams — so it reads like the native desktop
 *  apps: a shimmering status word plus an elapsed-seconds counter once the
 *  wait is long enough to notice. */
function ThinkingPlaceholder() {
  const { t } = useTranslation("chat");
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="flex w-full justify-start py-3">
      <div className="flex max-w-[88%] flex-col gap-2 items-start">
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {t("pane.assistant")}
        </div>
        <div className="flex items-baseline gap-2 text-sm">
          <span className="animate-shimmer-text font-medium">
            {t("pane.thinking")}
          </span>
          {elapsed >= 3 && (
            <span className="text-xs tabular-nums text-muted-foreground/70">
              {elapsed}s
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
