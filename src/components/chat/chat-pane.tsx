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
import { ChatVirtualList, type ChatListSnapshot, type ChatListHandle } from "./chat-virtual-list";
import { MessageBubble } from "@/components/chat/message-bubble";
import { ArtifactNavProvider } from "@/components/chat/artifact-view";
import type { RuntimeSwitchTarget } from "@/components/chat/backend-picker";
import { MessageListBoundary } from "@/components/chat/message-list-boundary";
import { AssistantGroup } from "@/components/chat/assistant-turn";
import { bindChatTailScroll } from "@/lib/chat-tail-scroll";
import { clearHoverOwner } from "@/components/chat/hover-owner";
import { AgentControlCard } from "@/components/chat/agent-control-card";
import { CliControlCard } from "@/components/chat/cli-control-card";
import { WallpaperFrame } from "@/components/chat/wallpaper-frame";
import { GlyphBackdrop } from "@/components/chat/glyph-backdrop";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Bot,
  MessageCircle,
  Pencil,
  RotateCw,
  X,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import {
  Composer,
  type ComposerAttachment,
  type ComposerDraftRequest,
  type ComposerRuntimeSelection,
  type QuoteRequest,
  type QueuedMessage,
} from "@/components/chat/composer";
import {
  getTurnPreview,
  useAwaitingAssistant,
  useBackgroundTasks,
  useChatError,
  useChatStore,
  useCompaction,
  useHasMessages,
  useIsStreaming,
  useMessageKeys,
  useMessageRoles,
  useRunningSubagents,
} from "@/lib/chat-store";
import { toast } from "sonner";
import { findQuoteSource, quoteRange } from "@/lib/quote-navigation";
import { FindBar } from "@/components/chat/find-bar";
import {
  clearFindHighlights,
  FIND_IN_CHAT_EVENT,
  paintFindHighlights,
  revealRange,
} from "@/components/chat/find-highlight";
import {
  buildFindMatches,
  firstMatchFrom,
  messageFindText,
  preserveActive,
  stepMatch,
} from "@/lib/message-search";
import { useTranslation } from "@/lib/i18n";
import { flavorHeadline } from "@/lib/chat-flavor";
import type { BackendId, ModelChoice } from "@/lib/types";
import { api } from "@/lib/tauri";
import { runtimeThemeStyle } from "@/lib/runtime-theme";

interface Props {
  /** Conversation id to subscribe to. Null means "new chat" — shows hero. */
  convId: string | null;
  /** Runtime currently serving this conversation. Drives status semantics and
   *  color only; the normalized turn/task events remain runtime-agnostic. */
  backend?: BackendId;
  modelChoice: ModelChoice;
  onModelChange: (next: ModelChoice) => void;
  workspaceDir: string | null;
  defaultWorkspace: string;
  onWorkspaceChange: (dir: string) => void;
  onSend: (
    text: string,
    attachments: ComposerAttachment[],
    runtime?: ComposerRuntimeSelection,
  ) => void;
  /** Route a leading-`!` command from the Composer to the Terminal surface. */
  onBash?: (command: string) => void;
  onAbort: () => void;
  /** Roll back + rerun the last failed turn — drives the inline error row's Retry button. */
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
    runtime?: ComposerRuntimeSelection,
    beforeIds?: string[],
  ) => void;
  onSteerQueued?: (id: string) => void;
  onRemoveQueued?: (id: string) => void;
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
  backendSwitch?: ({ token: number } & RuntimeSwitchTarget) | null;
  /** Tab-to-cycle-runtime request, forwarded to the Composer. */
  onRequestBackendSwitch?: (target: RuntimeSwitchTarget) => void;
  /** Nudge the reading column toward the sidebar on wide desktop layouts.
   *  The main shell enables this only while the right workspace dock is closed;
   *  embedded/detail chat surfaces keep true geometric centering. */
  opticalCenter?: boolean;
  /** The last turn was cut down mid-run (app quit / update restart / crash) —
   *  show the resume banner above the composer. Hidden while streaming. */
  interrupted?: boolean;
  /** Resume the interrupted turn (sends a continuation prompt). */
  onResumeInterrupted?: () => void;
  /** Dismiss the interrupted-run banner without resuming. */
  onDismissInterrupted?: () => void;
}

/** The shared "chat experience" body — messages list + composer with
 *  workspace/model pickers. Used by the main chat view, the new-task dialog,
 *  and the session detail dialog so each one feels identical to compose in.
 *  Sticks to the bottom while streaming, releases stick when the user scrolls
 *  up (so reading older context doesn't fight live updates). */
export function ChatPane({
  convId,
  backend = "pi",
  modelChoice,
  onModelChange,
  workspaceDir,
  defaultWorkspace,
  onWorkspaceChange,
  onSend,
  onBash,
  onAbort,
  onRetry,
  onForkMessage,
  retrying,
  queued,
  onQueue,
  onSteerQueued,
  onRemoveQueued,
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
  opticalCenter = false,
  interrupted,
  onResumeInterrupted,
  onDismissInterrupted,
}: Props) {
  const { locale } = useTranslation("chat");
  const hasMessages = useHasMessages(convId);
  const isStreaming = useIsStreaming(convId);
  const compaction = useCompaction(convId);
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
    (
      text: string,
      attachments: ComposerAttachment[],
      runtime?: ComposerRuntimeSelection,
    ) => {
      onQueue?.(text, attachments, runtime, queuedDraft?.beforeIds);
      setQueuedDrafts((drafts) => {
        const { [queuedDraftKey]: _submitted, ...rest } = drafts;
        return rest;
      });
    },
    [onQueue, queuedDraft, queuedDraftKey],
  );
  const sendFromComposer = useCallback(
    (
      text: string,
      attachments: ComposerAttachment[],
      runtime?: ComposerRuntimeSelection,
    ) => {
      onSend(text, attachments, runtime);
      setQueuedDrafts((drafts) => {
        const { [queuedDraftKey]: _submitted, ...rest } = drafts;
        return rest;
      });
    },
    [onSend, queuedDraftKey],
  );

  if (!hasMessages) {
    return (
      <WallpaperFrame className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-6">
        <GlyphBackdrop />
        <div
          className={`relative z-10 w-full max-w-2xl space-y-5 panel-motion transition-[translate] ${
            opticalCenter ? "xl:-translate-x-10 2xl:-translate-x-12" : ""
          }`}
        >
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
      </WallpaperFrame>
    );
  }

  return (
    <WallpaperFrame className="flex min-h-0 flex-1 flex-col bg-background">
      <ArtifactNavProvider convId={convId}>
        <MessageListBoundary key={convId ?? "new"}>
          <MessageList
            convId={convId}
            workspaceDir={workspaceDir}
            isStreaming={isStreaming}
            onRetry={onRetry}
            onForkMessage={onForkMessage}
            retrying={retrying}
            onQuote={addQuote}
            opticalCenter={opticalCenter}
          />
        </MessageListBoundary>
      </ArtifactNavProvider>
      <div className="chat-composer-dock relative z-10 bg-background px-4 pb-3 pt-2">
        <div
          className={`mx-auto max-w-3xl space-y-2 panel-motion transition-[translate] ${
            opticalCenter ? "xl:-translate-x-10 2xl:-translate-x-12" : ""
          }`}
        >
          {convId ? <BackgroundAgentsBar convId={convId} backend={backend} /> : null}
          {interrupted && !isStreaming ? (
            <InterruptedBar
              onResume={onResumeInterrupted}
              onDismiss={onDismissInterrupted}
            />
          ) : null}
          {compaction.active ? <CompactionBar reason={compaction.reason} /> : null}
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
            quoteRequest={quoteRequest}
            backendSwitch={backendSwitch}
            onRequestBackendSwitch={onRequestBackendSwitch}
          />
        </div>
      </div>
    </WallpaperFrame>
  );
}

function CompactionBar({ reason }: { reason: string | null }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-sky-500/25 bg-sky-500/5 px-2.5 py-1.5 text-xs text-muted-foreground">
      <Spinner className="size-3 text-sky-600" />
      <span className="font-medium text-foreground">Compacting context…</span>
      {reason ? <span className="truncate">{reason}</span> : null}
    </div>
  );
}

/** Offer to pick an interrupted turn back up. Shown when the conversation's
 *  persisted run_state is "interrupted" — its last turn died mid-run (app
 *  quit, update restart, or crash) instead of settling. The boot sweep
 *  normally auto-resumes an interrupted run once, so reaching this banner
 *  means that automatic retry was already spent (the resumed run got cut
 *  down again) — the user decides whether to try once more. Resume continues
 *  the original task via the conversation's resumed session; dismiss just
 *  clears the marker. */
function InterruptedBar({
  onResume,
  onDismiss,
}: {
  onResume?: () => void;
  onDismiss?: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-2.5 py-1.5 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">Run interrupted</span>
      <span className="min-w-0 truncate">
        The last run was cut short by a restart.
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {onResume ? (
          <button
            type="button"
            onClick={onResume}
            className="rounded-md bg-foreground px-2 py-0.5 font-medium text-background transition-opacity hover:opacity-85"
          >
            Resume
          </button>
        ) : null}
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md border border-border px-2 py-0.5 font-medium text-foreground transition-colors hover:bg-muted"
          >
            Dismiss
          </button>
        ) : null}
      </span>
    </div>
  );
}

/** Awareness strip for background work owned by this conversation: subagents
 *  (for example, a CLI backend's run_in_background Agent/Task) and
 *  session-scoped tasks (Monitors, background Bash) that outlive model turns.
 *  Without it the composer just says "Agent is running…" with no hint of
 *  *what* — or, worse, the conversation looks idle while a Monitor is watching
 *  something and will wake the agent later. Two sources, merged: the bridge's
 *  live task registry (`cli_background_tasks` snapshots — authoritative for
 *  CLI backends, cleared when the session process exits) and the rendered
 *  cards' running-subagent details (covers pi-backend runs). Renders nothing
 *  when both are empty. */
function BackgroundAgentsBar({
  convId,
  backend,
}: {
  convId: string;
  backend: BackendId;
}) {
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
    <div
      style={{
        ...runtimeThemeStyle(backend),
        borderColor: "color-mix(in oklab, var(--runtime-color) 30%, transparent)",
        backgroundColor: "color-mix(in oklab, var(--runtime-color) 6%, transparent)",
      }}
      className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs text-muted-foreground"
    >
      <Bot className="size-3.5 shrink-0 text-[var(--runtime-color)]" />
      <Spinner className="size-3 text-[var(--runtime-color)]" />
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

// The elevator is intentionally less eager than sticky-bottom follow: a small
// nudge away from the latest message should not summon a floating control.
const SCROLL_TO_BOTTOM_BUTTON_MIN_PX = 360;
const SCROLL_TO_BOTTOM_BUTTON_VIEWPORT_RATIO = 0.5;
// The turn navigator occupies the left 48px from `sm` upward. Before the
// max-w-3xl reading column has enough viewport space to center itself clear of
// that rail (896px), reserve the rail explicitly so its ticks never overlap
// message text. At wider sizes the column's normal centering provides the gap.
const MESSAGE_ROW_GUTTER_CLASS = "px-4 sm:pl-14 min-[896px]:px-4";

/** Reading position per conversation, so a half-read history resumes where it
 *  was left instead of snapping to the newest turn. Only conversations the
 *  reader scrolled AWAY from the bottom get an entry: sitting at the bottom is
 *  the default open position and must keep following new messages.
 *
 *  ChatListSnapshot is the unit here (scrollTop + the measured item
 *  sizes): a raw scrollTop alone restores wrong, because a remounted list only
 *  has height ESTIMATES for the turns it hasn't mounted yet. Deliberately
 *  in-memory (module scope, not IndexedDB): it is worth exactly one app session,
 *  and the message store already pays enough persistence cost. */
const readingAnchors = new Map<string, ChatListSnapshot>();
const MAX_READING_ANCHORS = 64;
// How long after opening a conversation scroll events are still treated as part
// of the landing rather than as the reader moving.
const OPEN_SETTLE_MS = 1000;

function rememberReadingAnchor(convId: string, snapshot: ChatListSnapshot) {
  // Delete-then-set so the Map's insertion order stays a true LRU.
  readingAnchors.delete(convId);
  readingAnchors.set(convId, snapshot);
  while (readingAnchors.size > MAX_READING_ANCHORS) {
    const oldest = readingAnchors.keys().next().value;
    if (oldest === undefined) break;
    readingAnchors.delete(oldest);
  }
}

type MessageGroup =
  | { kind: "assistant"; keys: string[] }
  | { kind: "single"; key: string };

/** Every visible element is a measured row. Transient tail UI must be a real
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
  workspaceDir,
  isStreaming,
  onRetry,
  onForkMessage,
  retrying,
  onQuote,
  opticalCenter,
}: {
  convId: string | null;
  workspaceDir: string | null;
  isStreaming: boolean;
  onRetry?: () => void;
  onForkMessage?: (messageKey: string, messageIndex: number) => void;
  retrying?: boolean;
  onQuote: (text: string) => void;
  opticalCenter: boolean;
}) {
  const keys = useMessageKeys(convId);
  const roles = useMessageRoles(convId);
  // Merge consecutive assistant (+tool) messages into one group so the whole
  // agent loop reads as a single turn — one ASSISTANT header, one activity
  // timeline — instead of a header + tool cards per round.
  const groups = useMemo(() => buildGroups(keys, roles), [keys, roles]);
  const awaiting = useAwaitingAssistant(convId);
  const hasError = !!useChatError(convId);
  // Thinking and errors are measured rows so every bottom seek uses the same
  // edge as the streaming follow controller.
  const items = useMemo<MessageListItem[]>(() => {
    if (awaiting) return [...groups, { kind: "thinking" }];
    if (!isStreaming && hasError) return [...groups, { kind: "error" }];
    return groups;
  }, [groups, awaiting, isStreaming, hasError]);

  // Virtualization measures rows; the intent controller owns tail-following.
  const listRef = useRef<ChatListHandle>(null);
  // The real scroll DOM node the virtual list hands back — needed only by the quote
  // toolbar (selection root + scroll-to-dismiss). Held in state so its effects
  // re-run once the node exists.
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  // Keep the ref callback stable. An inline callback gets a new identity on
  // every render, so React clears the old ref with `null` and attaches the new
  // one again. Calling setState from both ref calls can recurse until React
  // throws "Maximum update depth exceeded" while the virtual list is settling a large
  // conversation (especially in the faster production build).
  const setScrollerRef = useCallback((el: HTMLElement | Window | null) => {
    const next = el instanceof HTMLElement ? el : null;
    setScroller((current) => (current === next ? current : next));
  }, []);
  // The reading position this open should land on, read ONCE per conversation
  // switch (the virtual list only honours it at mount). Undefined = land at the newest
  // turn, the default for a conversation last left at the bottom.
  const restoreRef = useRef<ChatListSnapshot | undefined>(
    convId ? readingAnchors.get(convId) : undefined,
  );
  const [atBottom, setAtBottom] = useState(!restoreRef.current);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const atBottomRef = useRef(!restoreRef.current);
  // User intent is separate from the list's at-bottom reporting so an
  // upward gesture can stop streaming follow immediately.
  const followTailRef = useRef(!restoreRef.current);
  const tailScrollRef = useRef<ReturnType<typeof bindChatTailScroll> | null>(null);
  // Topmost visible group index (from the virtualizer's visible range) — drives the turn
  // navigator's active tick with no getBoundingClientRect scanning.
  const [topIndex, setTopIndex] = useState(0);
  const prevLastKeyRef = useRef<string | null>(null);
  const setAtBottomState = useCallback((next: boolean) => {
    atBottomRef.current = next;
    setAtBottom(next);
  }, []);

  // ⌘F find state. `focusTick` doubles as the open signal's identity so a second
  // ⌘F re-selects the field instead of doing nothing.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findActive, setFindActive] = useState(0);
  const [findFocusTick, setFindFocusTick] = useState(0);
  // Read by the streaming follow, which must not drag the reader off a match.
  const findOpenRef = useRef(false);
  findOpenRef.current = findOpen;

  // Restore each conversation before mounting its virtual list.
  const [renderedConvId, setRenderedConvId] = useState(convId);
  if (renderedConvId !== convId) {
    setRenderedConvId(convId);
    const anchor = convId ? readingAnchors.get(convId) : undefined;
    restoreRef.current = anchor;
    // Seed the bottom state pessimistically for a restored open. The list will
    // publish the truth a frame later; until then the streaming follow (which
    // reads the ref, not the state) must not yank a restored position down.
    atBottomRef.current = !anchor;
    followTailRef.current = !anchor;
    setAtBottom(!anchor);
    // Forget the previous conversation's tail: switching into a chat that ends
    // on a user turn must not read as "the user just sent" and seek to LAST.
    prevLastKeyRef.current = null;
  }

  // User turns paired with their index in the group list, for the navigator's
  // scroll-to-turn (the virtual list scrollToIndex) and active-tick math.
  const userTurns = useMemo(() => {
    const out: { key: string; index: number }[] = [];
    groups.forEach((g, i) => {
      if (g.kind !== "single") return;
      if (roles[keys.indexOf(g.key)] === "user") out.push({ key: g.key, index: i });
    });
    return out;
  }, [groups, keys, roles]);

  // The prose behind each list row, for ⌘F. Read straight off the store rather
  // than through a hook: subscribing to message BODIES here would re-render the
  // whole list on every streamed token, which is exactly what this file's
  // per-bubble subscriptions exist to avoid. The trade-off is that a reply
  // streaming in while the bar is open only joins the match list once the turn
  // count changes — searching live output is not what ⌘F is for.
  const findRowTexts = useMemo(() => {
    if (!findOpen || !convId) return [];
    const byKey = useChatStore.getState().chats[convId]?.byKey;
    if (!byKey) return [];
    return items.map((item) => {
      if (item.kind === "assistant")
        return item.keys
          .map((k) => (byKey[k] ? messageFindText(byKey[k]) : ""))
          .join("\n");
      if (item.kind === "single") return byKey[item.key] ? messageFindText(byKey[item.key]) : "";
      return "";
    });
    // `keys` covers hydration filling in a conversation whose groups already exist.
  }, [findOpen, convId, items, keys]);

  const findMatches = useMemo(
    () => buildFindMatches(findRowTexts, findQuery),
    [findRowTexts, findQuery],
  );

  // A new query resumes from the reader's position rather than the first turn.
  // topIndex is read through a ref so this doesn't re-run (and re-jump) on every
  // scroll event while the bar sits open.
  const topIndexRef = useRef(0);
  topIndexRef.current = topIndex;
  useEffect(() => {
    setFindActive(firstMatchFrom(findMatches, topIndexRef.current));
    // findMatches is deliberately not a dependency: it also changes when a
    // message arrives, and re-homing the cursor then would move the reader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findQuery]);

  // Keep the cursor inside the (possibly shrunken) match list when the
  // conversation changes under it.
  useEffect(() => {
    setFindActive((prev) => preserveActive(findMatches.length, prev));
  }, [findMatches]);

  // Scroll the active occurrence into view, then paint. The row may not be
  // mounted in this frame — the virtual list needs a tick to realise a row that was far
  // off-screen — so wait for it rather than painting a miss.
  const current = findMatches[findActive] ?? null;
  useEffect(() => {
    if (!scroller || !findOpen) return;
    if (!current) {
      clearFindHighlights();
      return;
    }
    listRef.current?.scrollToIndex({ index: current.itemIndex, align: "center" });
    let frames = 12;
    let frame = requestAnimationFrame(function step() {
      const range = paintFindHighlights(scroller, findQuery, current);
      if (range) {
        revealRange(scroller, range);
        // One more pass: revealing may have mounted rows that were off-screen.
        frame = requestAnimationFrame(() => paintFindHighlights(scroller, findQuery, current));
        return;
      }
      if (--frames > 0) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [scroller, findOpen, findQuery, current]);

  // Repaint when the virtual list mounts or retires rows under an unchanged active
  // match (ordinary scrolling while the bar is open).
  const repaintFind = useCallback(() => {
    if (!scroller || !findOpen || !current) return;
    paintFindHighlights(scroller, findQuery, current);
  }, [scroller, findOpen, findQuery, current]);

  // ⌘F arrives as an event from the app's global handler, which has already
  // cleared the modal and view guards. A repeat press re-focuses and selects
  // the field rather than toggling the bar shut — the browser convention.
  useEffect(() => {
    const onFind = () => {
      followTailRef.current = false;
      listRef.current?.cancelScroll();
      setFindOpen(true);
      setFindFocusTick((n) => n + 1);
    };
    window.addEventListener(FIND_IN_CHAT_EVENT, onFind);
    return () => window.removeEventListener(FIND_IN_CHAT_EVENT, onFind);
  }, []);

  // Esc closes the bar from anywhere in the chat, not just from inside the
  // field (the reader may have clicked back into the transcript).
  useEffect(() => {
    if (!findOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setFindOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [findOpen]);

  // Leave no paint behind when the bar closes or the conversation switches.
  useEffect(() => {
    if (!findOpen) clearFindHighlights();
  }, [findOpen]);
  useEffect(() => {
    setFindOpen(false);
    setFindQuery("");
    setFindActive(0);
    clearFindHighlights();
  }, [convId]);
  useEffect(() => clearFindHighlights, []);

  const closeFind = useCallback(() => setFindOpen(false), []);
  const stepFind = useCallback(
    (delta: number) => setFindActive((prev) => stepMatch(findMatches.length, prev, delta)),
    [findMatches.length],
  );

  // Snap to the newest message when the user sends (even if scrolled up reading);
  // The tail controller then keeps the streaming reply pinned until the reader
  // scrolls away. Keyed on the last message key so it fires once per send, not per
  // token — and NOT on the first non-empty observation: when a restored
  // conversation happens to end on a user turn (agent never replied), hydration
  // must not count as "the user just sent" or the open position gets yanked.
  useEffect(() => {
    const lastKey = keys[keys.length - 1] ?? null;
    if (
      prevLastKeyRef.current !== null &&
      lastKey !== prevLastKeyRef.current &&
      roles[roles.length - 1] === "user"
    ) {
      followTailRef.current = true;
      listRef.current?.scrollToIndex({ index: "LAST", align: "end" });
    }
    prevLastKeyRef.current = lastKey;
  }, [keys, roles]);


  // Remember the reading position while the reader is away from the bottom, so
  // switching conversations (or to another view) and back resumes mid-history
  // instead of jumping to the newest turn.
  //
  // Only ARMED scrolls count. The open sequence, the send/elevator seeks and the
  // streaming follow all move the scroller programmatically; if those captured,
  // a conversation opened mid-history would immediately overwrite (or, once
  // the list briefly reports at-bottom during the landing, erase) the very
  // anchor being restored. The arm is either a real pointer/keyboard scroll
  // gesture or simply "the open is long over".
  useEffect(() => {
    if (!scroller || !convId) return;

    let armed = false;
    let frame: number | null = null;
    const arm = () => {
      armed = true;
    };
    const settle = window.setTimeout(arm, OPEN_SETTLE_MS);

    const capture = () => {
      frame = null;
      // At the bottom there is nothing to resume — drop any stale anchor so the
      // next open follows new messages as usual.
      if (followTailRef.current && atBottomRef.current) {
        readingAnchors.delete(convId);
        return;
      }
      // getState reads the virtualizer's measured sizes and scroll offset: no DOM
      // measurement, so this stays off the forced-layout path.
      listRef.current?.getState((snapshot) => {
        // scrollTop === 0 is a valid reading position: after deliberately
        // scrolling a long conversation to its first turn, switching away and
        // back must resume there. Fresh/short conversations do not create a
        // false anchor because capture only runs after an actual scroll event.
        rememberReadingAnchor(convId, snapshot);
      });
    };
    const onScroll = () => {
      if (!armed || frame != null) return;
      frame = requestAnimationFrame(capture);
    };

    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("wheel", arm, { passive: true });
    scroller.addEventListener("touchmove", arm, { passive: true });
    scroller.addEventListener("pointerdown", arm, { passive: true });
    scroller.addEventListener("keydown", arm);
    return () => {
      window.clearTimeout(settle);
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", arm);
      scroller.removeEventListener("touchmove", arm);
      scroller.removeEventListener("pointerdown", arm);
      scroller.removeEventListener("keydown", arm);
      // Deliberately no final flush here: by the time this cleanup runs the
      // keyed virtual list has already remounted for the NEXT conversation, so
      // getState would file that list's position under this convId.
      if (frame != null) cancelAnimationFrame(frame);
    };
  }, [scroller, convId]);

  // One cancellable owner for row growth, appended rows, and viewport resizing.
  // Keep this active after streaming ends too (images and final markdown settle).
  useEffect(() => {
    if (!scroller) return;
    const binding = bindChatTailScroll(scroller, {
      isFollowing: () => followTailRef.current,
      setFollowing: (next) => { followTailRef.current = next; },
      isSearching: () => findOpenRef.current,
      onRelease: () => { listRef.current?.cancelScroll(); },
    });
    tailScrollRef.current = binding;
    return () => {
      tailScrollRef.current = null;
      binding.dispose();
    };
  }, [scroller]);

  // Any scroll invalidates the hovered turn: content moved under a stationary
  // pointer, and no pointer event will fire to hand the toolbar off or hide
  // it. The next real pointer move re-claims (hover-owner.ts).
  useEffect(() => {
    if (!scroller) return;
    scroller.addEventListener("scroll", clearHoverOwner, { passive: true });
    return () => scroller.removeEventListener("scroll", clearHoverOwner);
  }, [scroller]);

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
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(scroller);
    const content = scroller.querySelector('[data-chat-list-content]');
    if (content) observer.observe(content);
    scroller.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      if (frame != null) cancelAnimationFrame(frame);
    };
  }, [scroller, items.length]);

  const quoteCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => quoteCleanupRef.current?.(), [convId]);
  const { t: quoteT } = useTranslation("chat");
  const jumpToQuote = useCallback((messageKey: string, quote: string) => {
    if (!convId || !scroller) return;
    const byKey = useChatStore.getState().chats[convId]?.byKey;
    if (!byKey) return;
    const source = findQuoteSource(keys.map((key) => byKey[key]), keys.indexOf(messageKey), quote);
    const sourceKey = keys[source];
    const rowIndex = groups.findIndex((group) => group.kind === "assistant"
      ? group.keys.includes(sourceKey) : group.key === sourceKey);
    if (source < 0 || rowIndex < 0) {
      toast(quoteT("quote.sourceNotFound"));
      return;
    }
    quoteCleanupRef.current?.();
    setFindOpen(false);
    followTailRef.current = false;
    listRef.current?.cancelScroll();
    listRef.current?.scrollToIndex({ index: rowIndex, align: "center" });
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let animation: Animation | undefined;
    const highlights = (globalThis.CSS as unknown as {
      highlights?: { set: (name: string, value: unknown) => void; delete: (name: string) => void };
    })?.highlights;
    const Highlight = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    let frame = requestAnimationFrame(function reveal() {
      const row = scroller.querySelector<HTMLElement>(`[data-find-row="${rowIndex}"]`);
      // Allow virtual row measurements to settle before refining the position.
      if (++attempts < 3 || !row) {
        if (attempts < 60) frame = requestAnimationFrame(reveal);
        return;
      }
      listRef.current?.cancelScroll();
      const range = quoteRange(row, quote);
      if (range) {
        revealRange(scroller, range);
        if (highlights && Highlight) highlights.set("cetus-quote", new Highlight(range));
      }
      if (!range || !highlights || !Highlight) {
        animation = row.animate([
          { backgroundColor: "transparent" },
          { backgroundColor: "rgba(160, 140, 255, 0.22)" },
          { backgroundColor: "transparent" },
        ], { duration: 1800 });
      }
      timer = setTimeout(() => highlights?.delete("cetus-quote"), 2400);
    });
    quoteCleanupRef.current = () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      animation?.cancel();
      highlights?.delete("cetus-quote");
    };
  }, [convId, scroller, keys, groups, quoteT]);

  const itemContent = useCallback(
    (index: number, item: MessageListItem) => {
      if (item.kind === "thinking") {
        return (
          <div className={MESSAGE_ROW_GUTTER_CLASS}>
            <div
              className={`mx-auto max-w-3xl panel-motion transition-[translate] ${
                opticalCenter ? "xl:-translate-x-10 2xl:-translate-x-12" : ""
              }`}
            >
              <ThinkingPlaceholder />
            </div>
          </div>
        );
      }
      if (item.kind === "error") {
        return (
          <div className={MESSAGE_ROW_GUTTER_CLASS}>
            <div
              className={`mx-auto max-w-3xl panel-motion transition-[translate] ${
                opticalCenter ? "xl:-translate-x-10 2xl:-translate-x-12" : ""
              }`}
            >
              <MessageError convId={convId} onRetry={onRetry} retrying={retrying} />
            </div>
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
            workspaceDir={workspaceDir}
            keys={g.keys}
            active={isStreaming && isLast}
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
            onQuoteClick={(quote) => jumpToQuote(g.key, quote)}
            onFork={
              onForkMessage && messageIndex >= 0
                ? () => onForkMessage(forkMessageKey, messageIndex)
                : undefined
            }
          />
        );
      // Center each turn on the reading column. The virtual list measures the outer
      // wrapper. Once the viewport can center max-w-3xl clear of the navigator,
      // this returns to the composer's px-4 geometry so both columns line up.
      return (
        // data-find-row is how the ⌘F painter locates a mounted row's text
        // nodes without knowing anything about the bubbles inside it.
        <div className={MESSAGE_ROW_GUTTER_CLASS} data-find-row={index}>
          <div
            className={`mx-auto max-w-3xl panel-motion transition-[translate] ${
              opticalCenter ? "xl:-translate-x-10 2xl:-translate-x-12" : ""
            }`}
          >
            {node}
          </div>
        </div>
      );
    },
    [
      items.length,
      keys,
      convId,
      isStreaming,
      onForkMessage,
      awaiting,
      hasError,
      onRetry,
      retrying,
      opticalCenter,
      jumpToQuote,
    ],
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <QuoteSelectionToolbar scroller={scroller} onQuote={onQuote} />
      <ChatVirtualList
        // Each conversation mounts with its own saved position or newest turn.
        key={convId ?? "new"}
        ref={listRef}
        scrollerRef={setScrollerRef}
        data={items}
        className="chat-message-scroll scrollbar-slim min-h-0 flex-1 bg-background"
        itemKey={(_i, item) => {
          if (item.kind === "assistant") return item.keys[0];
          if (item.kind === "single") return item.key;
          return `${convId ?? "new"}:tail:${item.kind}`;
        }}
        itemContent={itemContent}
        initialState={restoreRef.current}
        onHeightChange={() => tailScrollRef.current?.schedule()}
        onBottomChange={setAtBottomState}
        onRangeChange={(startIndex) => {
          setTopIndex(startIndex);
          repaintFind();
        }}
      />
      {findOpen && (
        <FindBar
          query={findQuery}
          onQueryChange={setFindQuery}
          total={findMatches.length}
          active={findActive}
          onStep={stepFind}
          onClose={closeFind}
          opticalCenter={opticalCenter}
          focusTick={findFocusTick}
        />
      )}
      <TurnNavigator
        convId={convId}
        userTurns={userTurns}
        topIndex={topIndex}
        atBottom={atBottom}
        listRef={listRef}
        onNavigate={() => {
          followTailRef.current = false;
          listRef.current?.cancelScroll();
        }}
      />
      <ScrollToBottomButton
        show={showScrollToBottom}
        listRef={listRef}
        opticalCenter={opticalCenter}
        onFollowTail={() => {
          followTailRef.current = true;
        }}
      />
    </div>
  );
}

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
  listRef,
  onNavigate,
}: {
  convId: string | null;
  /** User turns paired with their index in the virtualized group list. */
  userTurns: { key: string; index: number }[];
  /** Topmost visible group index, published by the virtualizer. */
  topIndex: number;
  /** Whether the message list is currently pinned to its bottom edge. */
  atBottom: boolean;
  listRef: RefObject<ChatListHandle | null>;
  onNavigate: () => void;
}) {
  const [hover, setHover] = useState<number | null>(null);

  // At the bottom, the newest turn wins explicitly. During a conversation
  // switch the virtual list can briefly publish an intermediate range while its
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
                onClick={() => {
                  onNavigate();
                  listRef.current?.scrollToIndex({
                    index: turn.index,
                    align: "start",
                  });
                }}
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
 *  Visibility is deliberately stricter than the list's atBottom state so short
 *  reading nudges do not summon a floating control. */
function ScrollToBottomButton({
  show,
  listRef,
  opticalCenter,
  onFollowTail,
}: {
  show: boolean;
  listRef: RefObject<ChatListHandle | null>;
  opticalCenter: boolean;
  onFollowTail: () => void;
}) {
  const { t } = useTranslation("chat");

  const scrollToBottom = useCallback(() => {
    onFollowTail();
    listRef.current?.scrollToIndex({
      index: "LAST",
      align: "end",
    });
  }, [onFollowTail, listRef]);

  return (
    <button
      type="button"
      aria-label={t("pane.scrollToBottom")}
      title={t("pane.scrollToBottom")}
      onClick={scrollToBottom}
      className={`fade-layer absolute bottom-4 right-[max(1rem,calc((100%-48rem)/2))] z-30 flex size-9 items-center justify-center rounded-full border border-border bg-popover text-foreground shadow-[0_4px_14px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.08)] transition-all panel-motion hover:bg-muted ${
        opticalCenter ? "xl:-translate-x-10 2xl:-translate-x-12" : ""
      } ${
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
  /** The virtual list scroll element: selection root + scroll-to-dismiss source. */
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

  const readSelection = useCallback((finalize = false) => {
    const root = scroller;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0 || sel.isCollapsed) {
      setSelection(null);
      return;
    }

    let range = sel.getRangeAt(0);
    const ancestor = range.commonAncestorContainer;
    const node = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentNode;
    if (!node || !root.contains(node)) {
      setSelection(null);
      return;
    }

    // WebKit lets a drag begin/end on a markdown block boundary or on whitespace
    // between blocks. Those structural endpoints can paint the empty remainder
    // of a row as selected (and can even leave a non-collapsed, visually empty
    // Range). Once the gesture is complete, reduce the Range to its first and
    // last real character so the native highlight matches what can be quoted.
    if (finalize) {
      const trimmed = trimSelectionToText(range, root);
      if (trimmed) {
        sel.removeAllRanges();
        sel.addRange(trimmed);
        range = trimmed;
      } else {
        sel.removeAllRanges();
        setSelection(null);
        return;
      }
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
    const onPointerUp = () => window.setTimeout(() => readSelection(true), 0);
    const onKeyUp = () => readSelection(true);
    const onSelectionChange = () => readSelection(false);
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

/** Remove structural/whitespace boundaries from a completed native selection. */
function trimSelectionToText(range: Range, root: HTMLElement): Range | null {
  let first: { node: Text; offset: number } | null = null;
  let last: { node: Text; offset: number } | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.data || !range.intersectsNode(node)) continue;

    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.data.length;
    if (start >= end) continue;

    const selected = node.data.slice(start, end);
    const firstCharacter = selected.search(/\S/u);
    if (firstCharacter >= 0 && !first) {
      first = { node, offset: start + firstCharacter };
    }

    const trailingWhitespace = selected.match(/\s*$/u)?.[0].length ?? 0;
    if (trailingWhitespace < selected.length) {
      last = { node, offset: end - trailingWhitespace };
    }
  }
  if (!first || !last) return null;

  const trimmed = range.cloneRange();
  trimmed.setStart(first.node, first.offset);
  trimmed.setEnd(last.node, last.offset);
  return trimmed.collapsed ? null : trimmed;
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
              {retrying ? <Spinner className="size-3" /> : <RotateCw className="size-3" />}
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
      <span className="shrink-0 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
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
        <div className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
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
