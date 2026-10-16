"use client";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  AlertCircle,
  Bot,
  Brain,
  Check,
  ChevronRight,
  CircleHelp,
  CircleSlash,
  Clock,
  FileSearch,
  Folder,
  Globe,
  Layers,
  MessageSquare,
  Pencil,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Spinner } from "@/components/ui/spinner";
import { summarizeArgs, subagentInfo } from "@/components/chat/tool-use-card";
import {
  Composer,
  type ComposerAttachment,
} from "@/components/chat/composer";
import {
  BACKENDS,
  type RuntimeSwitchTarget,
} from "@/components/chat/backend-picker";
import { cn } from "@/lib/utils";
import { formatTimestamp } from "@/lib/format";
import {
  computeFirstPromptPreview,
  computeLastReplyPreview,
  computeReplyCount,
  loadCachedPreviews,
  useChatStore,
} from "@/lib/chat-store";
import type { ChatState } from "@/lib/chat-state";
import {
  computeDigest,
  isStep,
  turnStart,
  type ActivityDigest,
  type StepBlock,
  type StepKind,
} from "@/lib/thread-activity";
import { toolActivityStatus, type ToolActivityStatus } from "@/lib/tool-status";
import { useLocale, useTranslation } from "@/lib/i18n";
import { workspaceName } from "@/lib/paths";
import {
  countActivity,
  useInputIds,
  type ActivityCounts,
} from "@/lib/session-activity";
import { ActivityBadges } from "./activity-badges";
import type {
  BackendId,
  CliControlRequest,
  Conversation,
  ModelChoice,
} from "@/lib/types";

interface Props {
  conversations: Conversation[];
  /** The feed's folder (the sidebar's workspace filter); null = every folder. */
  workspaceFilter: string | null;
  defaultWorkspace: string;
  streamingIds: Set<string>;
  unreadCompletedIds: Set<string>;
  /** Thread open in the side pane, or null. */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Mint a session in `workspaceDir` and send the prompt; resolves to its id. */
  onCreate: (
    text: string,
    attachments: ComposerAttachment[],
    workspaceDir: string,
  ) => Promise<string>;
  /** Folder new sessions start in (filter, else the main chat's folder). */
  workspaceDir: string;
  onWorkspaceChange: (dir: string) => void;
  modelChoice: ModelChoice;
  onModelChange: (next: ModelChoice) => void;
  pendingBackend: BackendId;
  onPendingBackendChange: (backend: BackendId) => void;
  pendingCliModel: string;
  pendingCliEffort: string;
  onPendingTuningChange: (model: string, effort: string) => void;
  backendSwitch: ({ token: number } & RuntimeSwitchTarget) | null;
  onRequestBackendSwitch: (target: RuntimeSwitchTarget) => void;
  focusToken: number;
  disabled?: boolean;
  /** The open thread's surface (transcript + its own composer). */
  thread: ReactNode;
}

// Rough height of a card plus the gap below it, until it's measured.
const ESTIMATED_ROW = 164;
// Gap between cards (and below the last one), and above the first.
const ROW_GAP = 24;
const LIST_TOP = 20;
// Previews warmed from IDB around the rendered window, each side.
const WARM_AROUND = 40;

/** Where each folder's feed was left: the card at the top of the viewport and
 *  how far into it, or pinned to the newest. Switching back resumes there. */
type FeedPlace = { id: string; delta: number } | "bottom";
const feedPlaces = new Map<string | null, FeedPlace>();

// Sorted feeds per conversations array, so the view, the docked thread's
// neighbours and the keyboard stepping share one sort per change.
const feedCache = new WeakMap<Conversation[], Map<string | null, Conversation[]>>();

/** The feed's sessions in display order — oldest first, like a channel, so
 *  the newest sits right above the composer that started it. Shared with the
 *  keyboard's previous/next-thread stepping. */
export function threadFeed(
  conversations: Conversation[],
  workspaceFilter: string | null,
): Conversation[] {
  let byFilter = feedCache.get(conversations);
  if (!byFilter) {
    byFilter = new Map();
    feedCache.set(conversations, byFilter);
  }
  let feed = byFilter.get(workspaceFilter);
  if (!feed) {
    feed = (
      workspaceFilter
        ? conversations.filter((c) => c.workspaceDir === workspaceFilter)
        : conversations.slice()
    ).sort((a, b) => a.createdAt - b.createdAt);
    byFilter.set(workspaceFilter, feed);
  }
  return feed;
}

/** A folder's sessions as one Slack-style channel: each session is a thread
 *  whose opening prompt reads as a message, with a card for its state below.
 *  Sending in the feed's composer starts a new session; opening a card docks
 *  the session beside the feed. No coordinator — every thread is an ordinary
 *  conversation. */
export const ThreadsView = memo(function ThreadsView({
  conversations,
  workspaceFilter,
  defaultWorkspace,
  streamingIds,
  unreadCompletedIds,
  selectedId,
  onSelect,
  onCreate,
  workspaceDir,
  onWorkspaceChange,
  modelChoice,
  onModelChange,
  pendingBackend,
  onPendingBackendChange,
  pendingCliModel,
  pendingCliEffort,
  onPendingTuningChange,
  backendSwitch,
  onRequestBackendSwitch,
  focusToken,
  disabled,
  thread,
}: Props) {
  const { t } = useTranslation("board");

  const feed = useMemo(
    () => threadFeed(conversations, workspaceFilter),
    [conversations, workspaceFilter],
  );

  const inputIds = useInputIds();
  const activity = useMemo(
    () =>
      countActivity(feed, streamingIds, unreadCompletedIds, inputIds).get(null),
    [feed, streamingIds, unreadCompletedIds, inputIds],
  );

  // Header badge click: open the next thread (after the open one, wrapping)
  // in that state. Opening a Done thread marks it read, so repeated clicks
  // walk through the unread ones.
  function jumpTo(k: keyof ActivityCounts) {
    const matches = (id: string) =>
      k === "input"
        ? inputIds.has(id)
        : !inputIds.has(id) &&
          (k === "working"
            ? streamingIds.has(id)
            : !streamingIds.has(id) && unreadCompletedIds.has(id));
    const from = selectedId ? feed.findIndex((c) => c.id === selectedId) : -1;
    let idx = feed.findIndex((c, i) => i > from && matches(c.id));
    if (idx < 0) idx = feed.findIndex((c) => matches(c.id));
    if (idx < 0) return;
    onSelect(feed[idx].id);
  }

  // Shared with the list: sending pins the feed to the bottom so the new
  // thread's card comes into view.
  const nearBottom = useRef(true);

  // Esc closes the docked thread — unless something layered on top (a menu,
  // popover, dialog, the find bar) or a text selection should take it first.
  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      if (
        document.querySelector(
          "[data-radix-popper-content-wrapper], [role=dialog], [role=listbox]",
        )
      )
        return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) return;
      e.preventDefault();
      onSelect(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, onSelect]);

  // Sending stays in the feed: the new thread's card shows its progress, and
  // the composer is free for the next task. Open a card to follow along.
  async function handleSend(text: string, attachments: ComposerAttachment[]) {
    nearBottom.current = true;
    try {
      await onCreate(text, attachments, workspaceDir);
    } catch (e) {
      console.error("[threads] create failed", e);
    }
  }

  const isDefault = workspaceFilter === defaultWorkspace;
  const folderLabel = workspaceFilter
    ? isDefault
      ? t("card.defaultWorkspace")
      : workspaceName(workspaceFilter)
    : t("threads.allWorkspaces");
  const FolderIcon = !workspaceFilter
    ? Layers
    : isDefault
      ? MessageSquare
      : Folder;
  // One column width for header, feed and composer so their edges line up.
  const column = cn("mx-auto w-full px-6", !selectedId && "max-w-4xl");

  return (
    <div className="flex min-h-0 flex-1 flex-row">
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-col",
          selectedId
            ? "w-[40%] min-w-[360px] max-w-[540px] shrink-0 border-r border-border/70"
            : "flex-1",
        )}
      >
        {/* Mirrors the docked thread's header (one h-10 line, hairline
            below) so the two panes line up side by side. Doubles as the
            window drag strip — the shell's own header shrinks to a sliver in
            this view. */}
        <div
          data-tauri-drag-region
          className="flex h-10 shrink-0 items-center border-b border-border/70"
        >
          <div
            data-tauri-drag-region
            className={cn(column, "flex min-w-0 items-center gap-2.5")}
          >
            <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate text-sm font-medium text-foreground">
              {folderLabel}
            </span>
            <ActivityBadges
              counts={activity}
              labels
              onPick={jumpTo}
              className="ml-auto text-muted-foreground"
            />
          </div>
        </div>
        {feed.length === 0 ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex flex-col items-center gap-1.5 py-28 text-center">
              <div className="text-sm font-medium text-foreground">
                {t("threads.empty.title")}
              </div>
              <div className="max-w-xs text-xs leading-5 text-muted-foreground">
                {t("threads.empty.body")}
              </div>
            </div>
          </div>
        ) : (
          <ThreadList
            feed={feed}
            column={column}
            workspaceFilter={workspaceFilter}
            defaultWorkspace={defaultWorkspace}
            streamingIds={streamingIds}
            unreadCompletedIds={unreadCompletedIds}
            selectedId={selectedId}
            onSelect={onSelect}
            nearBottom={nearBottom}
          />
        )}
        <div className={cn(column, "pb-4 pt-2")}>
          <Composer
            variant="docked"
            focusToken={focusToken}
            draftKey={`threads:${workspaceFilter ?? "all"}`}
            disabled={disabled}
            streaming={false}
            placeholder={t("threads.placeholder")}
            modelChoice={modelChoice}
            onModelChange={onModelChange}
            conversationId={null}
            workspaceDir={workspaceDir}
            defaultWorkspace={defaultWorkspace}
            onWorkspaceChange={onWorkspaceChange}
            onSend={(text, attachments) => {
              void handleSend(text, attachments ?? []);
            }}
            onAbort={() => {}}
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
      {selectedId && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{thread}</div>
      )}
    </div>
  );
});

/** The feed itself, virtualized: only the cards around the viewport are
 *  mounted (and subscribed to the store), so a folder with ten thousand
 *  sessions costs what one screenful does. Its own memo boundary, so the
 *  header, composer and docked thread re-rendering — and the list re-rendering
 *  on scroll — stay apart. */
const ThreadList = memo(function ThreadList({
  feed,
  column,
  workspaceFilter,
  defaultWorkspace,
  streamingIds,
  unreadCompletedIds,
  selectedId,
  onSelect,
  nearBottom,
}: {
  feed: Conversation[];
  column: string;
  workspaceFilter: string | null;
  defaultWorkspace: string;
  streamingIds: Set<string>;
  unreadCompletedIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  nearBottom: RefObject<boolean>;
}) {
  const { t } = useTranslation("board");
  const { locale } = useLocale();
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: feed.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (i) => feed[i].id,
    estimateSize: () => ESTIMATED_ROW,
    overscan: 4,
    paddingStart: LIST_TOP,
    // The feed opens at its newest end; start there rather than mounting the
    // oldest cards first and seeking.
    initialOffset: () => Math.max(0, feed.length * ESTIMATED_ROW),
    useFlushSync: false,
  });
  // A card that grows or shrinks above the reader (a preview landing, a
  // streaming card's steps) keeps the cards in view still; below, it moves
  // nothing.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _d, v) =>
    item.end <= (v.scrollElement?.scrollTop ?? 0);

  // On open / folder switch, resume where that folder was left (else the
  // bottom); after that, stick to the bottom when a new session lands while
  // the reader is already near the end.
  const lastFilter = useRef<string | null | undefined>(undefined);
  const lastCount = useRef(0);
  useLayoutEffect(() => {
    const switched = lastFilter.current !== workspaceFilter;
    const grew = feed.length > lastCount.current;
    lastFilter.current = workspaceFilter;
    lastCount.current = feed.length;
    if (switched) {
      const place = feedPlaces.get(workspaceFilter);
      const i =
        place && place !== "bottom"
          ? feed.findIndex((c) => c.id === place.id)
          : -1;
      nearBottom.current = i < 0;
      if (i >= 0 && place && place !== "bottom") {
        // Card sizes are cached by session id, so a folder seen before lays
        // out the same and the offset lands on the same card.
        const [start] = virtualizer.getOffsetForIndex(i, "start") ?? [0];
        virtualizer.scrollToOffset(start + place.delta);
        return;
      }
    }
    if (switched || (grew && nearBottom.current)) {
      virtualizer.scrollToIndex(feed.length - 1, { align: "end" });
    }
  }, [feed.length, workspaceFilter, virtualizer, nearBottom]);

  // Cards get measured (and previews arrive) after the first paint, changing
  // the list's height; stay pinned to the bottom through that as long as the
  // reader hasn't scrolled away.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (nearBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [nearBottom]);

  // Keep the open thread's card in view when it changes (keyboard stepping,
  // header badges) — it may be anywhere in the feed, mounted or not. Not
  // when a folder switch brings its docked thread back: the feed has just
  // resumed its own scroll position.
  const selectFilter = useRef(workspaceFilter);
  useEffect(() => {
    const switched = selectFilter.current !== workspaceFilter;
    selectFilter.current = workspaceFilter;
    if (!selectedId || switched) return;
    const i = feed.findIndex((c) => c.id === selectedId);
    if (i >= 0) virtualizer.scrollToIndex(i, { align: "auto" });
    // Only on a new selection, not when the feed changes under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, workspaceFilter]);

  const items = virtualizer.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items[items.length - 1]?.index ?? -1;

  // Warm the opening prompt / reply count / last reply from the small preview
  // records around the window — same approach as the board, never a
  // full-history hydrate. Debounced so a fast scroll through the feed only
  // loads where it stops.
  const attempted = useRef<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      const ids = feed
        .slice(Math.max(0, first - WARM_AROUND), last + 1 + WARM_AROUND)
        .map((c) => c.id)
        .filter((id) => !attempted.current.has(id));
      if (ids.length === 0) return;
      for (const id of ids) attempted.current.add(id);
      const previews = await loadCachedPreviews(ids);
      if (cancelled || Object.keys(previews).length === 0) return;
      useChatStore.getState().setPreviews(previews);
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [feed, first, last]);

  const today = startOfDay(Date.now());
  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        nearBottom.current =
          el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        const top = nearBottom.current
          ? undefined
          : virtualizer
              .getVirtualItems()
              .find((row) => row.end > el.scrollTop);
        feedPlaces.set(
          workspaceFilter,
          top
            ? { id: String(top.key), delta: el.scrollTop - top.start }
            : "bottom",
        );
      }}
      className="min-h-0 flex-1 overflow-y-auto"
      style={{ overflowAnchor: "none" }}
    >
      <div className={column}>
        <div
          ref={contentRef}
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {items.map((row) => {
            const c = feed[row.index];
            // A divider above the first session of each day.
            const day = startOfDay(c.createdAt);
            const prev = feed[row.index - 1];
            const divider =
              !prev || startOfDay(prev.createdAt) !== day
                ? dayLabel(day, today, locale, t)
                : null;
            return (
              <div
                key={row.key}
                ref={virtualizer.measureElement}
                data-index={row.index}
                data-thread-id={c.id}
                className="absolute left-0 top-0 flex w-full flex-col gap-6"
                style={{
                  transform: `translateY(${row.start}px)`,
                  paddingBottom: ROW_GAP,
                }}
              >
                {divider && <DayDivider label={divider} />}
                <ThreadItem
                  conversation={c}
                  showFolder={!workspaceFilter}
                  defaultWorkspace={defaultWorkspace}
                  streaming={streamingIds.has(c.id)}
                  unread={unreadCompletedIds.has(c.id)}
                  selected={selectedId === c.id}
                  onOpen={onSelect}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});

function DayDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 text-2xs font-medium tracking-wide text-muted-foreground/80">
      <span className="h-px flex-1 bg-border/70" />
      {label}
      <span className="h-px flex-1 bg-border/70" />
    </div>
  );
}

type ThreadStatus =
  | "working"
  | "input"
  | "failed"
  | "interrupted"
  | "review"
  | "unread"
  | "idle";

const STATUS_STYLE: Record<
  ThreadStatus,
  { dot: string; text: string; key: string }
> = {
  working: {
    dot: "bg-warning animate-pulse",
    text: "text-warning",
    key: "threads.status.working",
  },
  input: {
    dot: "bg-[var(--brand)] animate-pulse",
    text: "text-[var(--brand)]",
    key: "threads.status.input",
  },
  failed: {
    dot: "bg-destructive",
    text: "text-destructive",
    key: "threads.status.failed",
  },
  interrupted: {
    dot: "bg-destructive/70",
    text: "text-destructive",
    key: "threads.status.interrupted",
  },
  review: { dot: "bg-info", text: "text-info", key: "threads.status.review" },
  unread: {
    dot: "bg-success",
    text: "text-success",
    key: "threads.status.unread",
  },
  idle: {
    dot: "bg-muted-foreground/35",
    text: "text-muted-foreground",
    key: "threads.status.idle",
  },
};

interface ThreadItemProps {
  conversation: Conversation;
  showFolder: boolean;
  defaultWorkspace: string;
  streaming: boolean;
  unread: boolean;
  selected: boolean;
  onOpen: (id: string) => void;
}

/** Memoized per row so one streaming thread doesn't repaint the whole feed. */
const ThreadItem = memo(function ThreadItem({
  conversation: c,
  showFolder,
  defaultWorkspace,
  streaming,
  unread,
  selected,
  onOpen,
}: ThreadItemProps) {
  const { t } = useTranslation("board");
  const summary = useThreadSummary(c.id);
  const activity = useThreadActivity(c.id);
  const error = useChatStore((s) => s.chats[c.id]?.error ?? null);
  const question = useChatStore((s) => controlLabel(s.controlRequests[c.id]));
  const status: ThreadStatus = question
    ? "input"
    : streaming
      ? "working"
      : error
        ? "failed"
        : c.runState === "interrupted"
          ? "interrupted"
          : c.reviewState === "pending"
            ? "review"
            : unread && !selected
              ? "unread"
              : "idle";
  const style = STATUS_STYLE[status];
  const runtime =
    BACKENDS.find((b) => b.id === ((c.backend as BackendId) || "pi")) ??
    BACKENDS[0];
  const RuntimeIcon = runtime.icon;
  // The opening prompt reads as the message that started the thread. Until
  // it's known (an old preview record) the card's title stands in alone.
  const prompt = summary.firstPrompt;
  // Until the generated title lands, the title is just the prompt's first
  // line; showing it beside the runtime icon would read as the agent saying
  // it, so the card is labelled with the runtime instead.
  const titlePending = !!prompt && isFallbackTitle(c.title, prompt);
  const title = titlePending
    ? runtime.label
    : c.title || t("card.untitled");
  // While the turn runs the card is a live window onto it: the last few
  // steps, then whatever answer has streamed so far.
  const live = streaming && activity.recent.length > 0;

  return (
    <article
      className="flex flex-col gap-2"
    >
      {prompt && (
        <div className="flex justify-end pl-10">
          <div className="min-w-0 rounded-2xl bg-primary/15 px-4 py-2 dark:bg-primary/20">
            <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
              {plain(prompt)}
            </p>
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => onOpen(c.id)}
        aria-pressed={selected}
        className={cn(
          "group flex w-full min-w-0 flex-col rounded-xl border px-3.5 py-3 text-left outline-none transition-colors",
          "focus-visible:ring-2 focus-visible:ring-ring/50",
          selected
            ? "border-[var(--brand)]/45 bg-[var(--brand)]/[0.06]"
            : "border-border/70 bg-card hover:border-border hover:bg-accent/40",
        )}
      >
        <div className="flex w-full min-w-0 items-center gap-2.5">
          <RuntimeIcon className="size-4 shrink-0" />
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[13px] font-medium leading-5",
              titlePending ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {title}
          </span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {formatTimestamp(c.updatedAt)}
          </span>
        </div>
        {live && <StepList steps={activity.recent} />}
        {question && (
          <div className="ml-[26px] mt-2 flex min-w-0 items-start gap-1.5 self-stretch rounded-md bg-[var(--brand)]/[0.08] px-2 py-1.5 text-xs leading-5">
            <CircleHelp className="mt-[3px] size-3.5 shrink-0 text-[var(--brand)]" />
            <span className="min-w-0 line-clamp-2 text-foreground">
              <span className="font-medium">{t("threads.waiting")}</span>
              {question !== true && (
                <span className="text-muted-foreground"> — {question}</span>
              )}
            </span>
          </div>
        )}
        {summary.lastReply && (
          <p className="mt-1.5 line-clamp-3 w-full pl-[26px] text-xs leading-5 text-muted-foreground">
            {plain(summary.lastReply)}
          </p>
        )}
        {error && !streaming && (
          <p className="mt-1.5 line-clamp-2 w-full break-words pl-[26px] text-xs leading-5 text-destructive/90">
            {error}
          </p>
        )}
        <div className="mt-2 flex w-full min-w-0 items-center gap-1.5 pl-[26px] text-xs leading-4 text-muted-foreground">
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 font-medium",
              style.text,
            )}
          >
            <span className={cn("size-1.5 rounded-full", style.dot)} />
            {t(style.key)}
          </span>
          {streaming && activity.startedAt !== null && (
            <>
              <Sep />
              <Elapsed since={activity.startedAt} />
            </>
          )}
          {activity.toolCount > 0 && (
            <>
              <Sep />
              <DigestChips digest={activity.digest} />
            </>
          )}
          {summary.replyCount > 0 && (
            <>
              <Sep />
              <span className="shrink-0 tabular-nums">
                {t(
                  summary.replyCount === 1
                    ? "threads.reply"
                    : "threads.replies",
                  { count: summary.replyCount },
                )}
              </span>
            </>
          )}
          {c.sourceAutomationId && (
            <>
              <Sep />
              <span className="inline-flex shrink-0 items-center gap-1">
                <Clock className="size-3" />
                {t("threads.automation")}
              </span>
            </>
          )}
          {showFolder && (
            <>
              <Sep />
              <span className="min-w-0 truncate">
                {c.workspaceDir === defaultWorkspace
                  ? t("card.defaultWorkspace")
                  : workspaceName(c.workspaceDir)}
              </span>
            </>
          )}
          <span
            className={cn(
              "ml-auto inline-flex shrink-0 items-center gap-0.5 pl-2 transition-opacity",
              selected
                ? "opacity-0"
                : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
            )}
          >
            {t("threads.view")}
            <ChevronRight className="size-3.5" />
          </span>
        </div>
      </button>
    </article>
  );
});

/** The running turn's last few steps, one line each — a tool call with its
 *  argument preview, or the tail of the reasoning. Older steps fade out. */
function StepList({ steps }: { steps: ThreadStep[] }) {
  const { t } = useTranslation("board");
  return (
    <ol className="ml-[7px] mt-2 flex min-w-0 flex-col gap-1 self-stretch border-l border-border/70 pl-[18px]">
      {steps.map((step, i) => {
        const fade = steps.length - 1 - i;
        return (
          <li
            key={step.key}
            className={cn(
              "flex min-w-0 items-center gap-2 text-xs leading-5",
              fade === 1 && "opacity-75",
              fade >= 2 && "opacity-50",
            )}
          >
            <StepIcon step={step} />
            {step.kind === "thinking" ? (
              <>
                <span
                  className={cn(
                    "shrink-0 font-medium text-foreground/80",
                    step.status === "running" && "animate-shimmer-text",
                  )}
                >
                  {t("threads.thinking")}
                </span>
                {step.detail && (
                  <span className="min-w-0 truncate italic text-muted-foreground">
                    {step.detail}
                  </span>
                )}
              </>
            ) : (
              <>
                <span className="shrink-0 font-medium text-foreground/80">
                  {step.name}
                </span>
                {step.detail && (
                  <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                    {step.detail}
                  </span>
                )}
              </>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function StepIcon({ step }: { step: ThreadStep }) {
  const cls = "size-3 shrink-0";
  if (step.status === "running") {
    return step.kind === "thinking" ? (
      <Brain className={cn(cls, "text-muted-foreground")} />
    ) : (
      <Spinner className={cn(cls, "text-muted-foreground")} />
    );
  }
  if (step.status === "error")
    return <AlertCircle className={cn(cls, "text-warning")} />;
  if (step.status === "incomplete")
    return <CircleSlash className={cn(cls, "text-muted-foreground")} />;
  if (step.kind === "thinking")
    return <Brain className={cn(cls, "text-muted-foreground/70")} />;
  return <Check className={cn(cls, "text-muted-foreground/70")} />;
}

const DIGEST_ORDER: { kind: StepKind; icon: LucideIcon }[] = [
  { kind: "explore", icon: FileSearch },
  { kind: "edit", icon: Pencil },
  { kind: "run", icon: SquareTerminal },
  { kind: "web", icon: Globe },
  { kind: "agent", icon: Bot },
  { kind: "other", icon: Wrench },
];

/** The latest turn's tool calls by kind — icon + count, labelled on hover. */
function DigestChips({ digest }: { digest: ActivityDigest }) {
  const { t } = useTranslation("board");
  return (
    <span className="inline-flex shrink-0 items-center gap-2 tabular-nums">
      {DIGEST_ORDER.map(({ kind, icon: Icon }) => {
        const n = digest[kind];
        if (!n) return null;
        return (
          <span
            key={kind}
            title={t(`threads.digest.${kind}`, { count: n })}
            className="inline-flex items-center gap-0.5"
          >
            <Icon className="size-3" />
            {n}
          </span>
        );
      })}
    </span>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  const m = Math.floor(s / 60);
  return (
    <span className="shrink-0 tabular-nums">
      {m > 0 ? `${m}m ${s % 60}s` : `${s}s`}
    </span>
  );
}

/** Previews are raw Markdown cut mid-stream; drop the syntax that reads as
 *  noise on one or two lines (emphasis, headings, code ticks, list bullets). */
function plain(text: string): string {
  return text
    .replace(/\*\*|__|`+/g, "")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/(^|\s)[-*]\s+(?=\S)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether `title` is the placeholder the backend derives from the prompt
 *  (its first line, cut at 60 chars with an ellipsis) rather than a real one. */
function isFallbackTitle(title: string, prompt: string): boolean {
  const head = plain(title).replace(/…$/, "");
  return !!head && plain(prompt).startsWith(head);
}

function Sep() {
  return <span className="shrink-0 text-muted-foreground/50">·</span>;
}

interface ThreadSummary {
  firstPrompt: string | null;
  lastReply: string | null;
  replyCount: number;
}

const EMPTY_SUMMARY: ThreadSummary = {
  firstPrompt: null,
  lastReply: null,
  replyCount: 0,
};

// Zustand runs every row's selector on every streaming token; caching by the
// ChatState reference keeps that O(1) for every row but the one that changed.
const summaryCache = new WeakMap<ChatState, ThreadSummary>();
const previewSummaryCache = new WeakMap<object, ThreadSummary>();

/** Live summary when the conversation is resident, else its warmed preview
 *  record (whose opening prompt / reply count may be missing on old records). */
function useThreadSummary(convId: string): ThreadSummary {
  return useChatStore((s) => {
    const c = s.chats[convId];
    if (c && c.messages.length > 0) {
      let v = summaryCache.get(c);
      if (!v) {
        v = {
          firstPrompt: computeFirstPromptPreview(c.messages),
          lastReply: computeLastReplyPreview(c.messages),
          replyCount: computeReplyCount(c.messages),
        };
        summaryCache.set(c, v);
      }
      return v;
    }
    const p = s.previews[convId];
    if (!p) return EMPTY_SUMMARY;
    let v = previewSummaryCache.get(p);
    if (!v) {
      v = {
        firstPrompt: p.firstPrompt ?? null,
        lastReply: p.lastReply,
        replyCount: p.replyCount ?? 0,
      };
      previewSummaryCache.set(p, v);
    }
    return v;
  });
}

interface ThreadStep {
  key: string;
  kind: "thinking" | "tool";
  /** Tool name; "" for thinking. */
  name: string;
  /** Argument preview for a tool, the tail of the reasoning for thinking. */
  detail: string;
  status: ToolActivityStatus;
}

interface ThreadActivity {
  /** The latest turn's last few steps, oldest first. */
  recent: ThreadStep[];
  toolCount: number;
  digest: ActivityDigest;
  /** When the latest turn was sent; the live elapsed timer counts from it. */
  startedAt: number | null;
}

const RECENT_STEPS = 3;
const EMPTY_ACTIVITY: ThreadActivity = {
  recent: [],
  toolCount: 0,
  digest: {},
  startedAt: null,
};
const activityCache = new WeakMap<ChatState, ThreadActivity>();
const previewActivityCache = new WeakMap<object, ThreadActivity>();

function toStep(b: StepBlock, key: string): ThreadStep {
  if (b.kind === "thinking") {
    const flat = b.text.replace(/\s+/g, " ").trim();
    return {
      key,
      kind: "thinking",
      name: "",
      detail: flat.length > 160 ? `…${flat.slice(-160)}` : flat,
      status: b.streaming ? "running" : "settled",
    };
  }
  // A running subagent streams its live status into the result; prefer it
  // over the frozen launch args.
  const sub = subagentInfo(b.result?.details);
  const content = b.result?.content;
  const liveStatus =
    sub && Array.isArray(content) && content[0]?.type === "text"
      ? content[0].text
      : "";
  return {
    key,
    kind: "tool",
    name: b.name,
    detail: sub
      ? (liveStatus || sub.description || "").replace(/\s+/g, " ").trim()
      : summarizeArgs(b.args),
    status: toolActivityStatus(b),
  };
}

function computeActivity(c: ChatState): ThreadActivity {
  const messages = c.messages;
  const start = turnStart(messages);
  const steps: ThreadStep[] = [];
  let toolCount = 0;
  for (let i = start; i < messages.length; i++) {
    const m = messages[i];
    m.blocks.forEach((b, j) => {
      if (!isStep(b)) return;
      if (b.kind === "tool_use") toolCount++;
      steps.push(toStep(b, `${m.key}:${j}`));
    });
  }
  return {
    recent: steps.slice(-RECENT_STEPS),
    toolCount,
    digest: computeDigest(messages),
    startedAt: messages[start]?.createdAt ?? null,
  };
}

/** The latest turn's steps when the conversation is resident (a thread that
 *  ran this session streams into the store even while closed), else the tool
 *  digest from its preview record. */
function useThreadActivity(convId: string): ThreadActivity {
  return useChatStore((s) => {
    const c = s.chats[convId];
    if (c && c.messages.length > 0) {
      let v = activityCache.get(c);
      if (!v) {
        v = computeActivity(c);
        activityCache.set(c, v);
      }
      return v;
    }
    const p = s.previews[convId];
    if (!p?.digest) return EMPTY_ACTIVITY;
    let v = previewActivityCache.get(p);
    if (!v) {
      const digest = p.digest;
      v = {
        ...EMPTY_ACTIVITY,
        digest,
        toolCount: Object.values(digest).reduce((n, k) => n + (k ?? 0), 0),
      };
      previewActivityCache.set(p, v);
    }
    return v;
  });
}

/** What a pending control request asks, for the card's callout: the first
 *  question's text, else the tool waiting for permission; `true` when there
 *  is a request with nothing to quote, null when there is none. */
function controlLabel(
  reqs: CliControlRequest[] | undefined,
): string | true | null {
  const req = reqs?.[0];
  if (!req) return null;
  const q = req.input.questions?.[0]?.question;
  if (typeof q === "string" && q.trim()) return q.replace(/\s+/g, " ").trim();
  return req.toolName || true;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// toLocaleDateString builds a fresh formatter per call (~45µs in JSC); a long
// feed formats one per day, so keep them.
const dayFormats = new Map<string, Intl.DateTimeFormat>();

function dayLabel(
  day: number,
  today: number,
  locale: string,
  t: (key: string) => string,
): string {
  const diff = Math.round((today - day) / 86_400_000);
  if (diff === 0) return t("threads.today");
  if (diff === 1) return t("threads.yesterday");
  const withYear = new Date(day).getFullYear() !== new Date(today).getFullYear();
  const key = `${locale}:${withYear}`;
  let fmt = dayFormats.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      year: withYear ? "numeric" : undefined,
    });
    dayFormats.set(key, fmt);
  }
  return fmt.format(day);
}
