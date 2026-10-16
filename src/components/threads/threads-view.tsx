"use client";
import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
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
import { Button } from "@/components/ui/button";
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
import { countActivity, useInputIds } from "@/lib/session-activity";
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

// How many sessions the feed mounts at first; older ones load on demand.
const PAGE = 60;
// Cap on preview records warmed from IDB per feed (newest first).
const WARMUP_CAP = 120;

/** The feed's sessions in display order — oldest first, like a channel, so
 *  the newest sits right above the composer that started it. Shared with the
 *  keyboard's previous/next-thread stepping. */
export function threadFeed(
  conversations: Conversation[],
  workspaceFilter: string | null,
): Conversation[] {
  return (
    workspaceFilter
      ? conversations.filter((c) => c.workspaceDir === workspaceFilter)
      : conversations.slice()
  ).sort((a, b) => a.createdAt - b.createdAt);
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
  const { locale } = useLocale();

  const feed = useMemo(
    () => threadFeed(conversations, workspaceFilter),
    [conversations, workspaceFilter],
  );

  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [workspaceFilter]);
  const visible = useMemo(
    () => feed.slice(Math.max(0, feed.length - limit)),
    [feed, limit],
  );
  const hidden = feed.length - visible.length;

  const inputIds = useInputIds();
  const activity = useMemo(
    () =>
      countActivity(feed, streamingIds, unreadCompletedIds, inputIds).get(null),
    [feed, streamingIds, unreadCompletedIds, inputIds],
  );

  // Warm the opening prompt / reply count / last reply from the small preview
  // records — same approach as the board, never a full-history hydrate.
  const attempted = useRef<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ids = visible
        .slice(-WARMUP_CAP)
        .map((c) => c.id)
        .filter((id) => !attempted.current.has(id));
      if (ids.length === 0) return;
      for (const id of ids) attempted.current.add(id);
      const previews = await loadCachedPreviews(ids);
      if (cancelled || Object.keys(previews).length === 0) return;
      useChatStore.getState().setPreviews(previews);
    })();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  // Stick to the bottom: on open / folder switch, and when a new session lands
  // while the reader is already near the end.
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const lastFilter = useRef<string | null | undefined>(undefined);
  const lastCount = useRef(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const switched = lastFilter.current !== workspaceFilter;
    const grew = feed.length > lastCount.current;
    lastFilter.current = workspaceFilter;
    lastCount.current = feed.length;
    if (switched || (grew && nearBottom.current)) {
      el.scrollTop = el.scrollHeight;
    }
  }, [feed.length, workspaceFilter]);

  // Previews arrive after the first paint and grow the rows; stay pinned to
  // the bottom through that (and through a streaming row's preview) as long
  // as the reader hasn't scrolled away.
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (nearBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  // Keep the open thread's card in view when it changes (keyboard stepping).
  useEffect(() => {
    if (!selectedId) return;
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-thread-id="${selectedId}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

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
        {/* Mirrors the docked thread's header (one h-11 line, hairline
            below) so the two panes line up side by side. */}
        <div className="flex h-11 shrink-0 items-center border-b border-border/70">
          <div className={cn(column, "flex min-w-0 items-center gap-2.5")}>
            <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate text-sm font-medium text-foreground">
              {folderLabel}
            </span>
            <ActivityBadges
              counts={activity}
              labels
              className="ml-auto text-muted-foreground"
            />
          </div>
        </div>
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            nearBottom.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div
            ref={contentRef}
            className={cn(column, "flex flex-col gap-6 pb-6 pt-5")}
          >
            {hidden > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-center text-xs text-muted-foreground"
                onClick={() => setLimit((n) => n + PAGE)}
              >
                {t("threads.showEarlier", { count: hidden })}
              </Button>
            )}
            {feed.length === 0 && (
              <div className="flex flex-col items-center gap-1.5 py-28 text-center">
                <div className="text-sm font-medium text-foreground">
                  {t("threads.empty.title")}
                </div>
                <div className="max-w-xs text-xs leading-5 text-muted-foreground">
                  {t("threads.empty.body")}
                </div>
              </div>
            )}
            {visible.map((c, i) => {
              const prev = visible[i - 1];
              const day = dayLabel(c.createdAt, locale, t);
              const showDay =
                !prev || dayLabel(prev.createdAt, locale, t) !== day;
              return (
                <Fragment key={c.id}>
                  {showDay && <DayDivider label={day} />}
                  <ThreadItem
                    conversation={c}
                    showFolder={!workspaceFilter}
                    defaultWorkspace={defaultWorkspace}
                    streaming={streamingIds.has(c.id)}
                    unread={unreadCompletedIds.has(c.id)}
                    selected={selectedId === c.id}
                    onOpen={onSelect}
                  />
                </Fragment>
              );
            })}
          </div>
        </div>
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

/** Memoized per row so one streaming thread doesn't repaint the whole feed. */
const ThreadItem = memo(function ThreadItem({
  conversation: c,
  showFolder,
  defaultWorkspace,
  streaming,
  unread,
  selected,
  onOpen,
}: {
  conversation: Conversation;
  showFolder: boolean;
  defaultWorkspace: string;
  streaming: boolean;
  unread: boolean;
  selected: boolean;
  onOpen: (id: string) => void;
}) {
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
  const title = c.title || t("card.untitled");
  // The opening prompt reads as the message that started the thread. Until
  // it's known (an old preview record) the card's title stands in alone,
  // rather than repeating the title as a fake message.
  const prompt =
    summary.firstPrompt && summary.firstPrompt !== c.title
      ? summary.firstPrompt
      : null;
  // While the turn runs the card is a live window onto it: the last few
  // steps, then whatever answer has streamed so far.
  const live = streaming && activity.recent.length > 0;

  return (
    <article
      data-thread-id={c.id}
      className="flex flex-col gap-2"
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 140px" }}
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
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5 text-foreground">
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

function dayLabel(
  ms: number,
  locale: string,
  t: (key: string) => string,
): string {
  const d = new Date(ms);
  const today = new Date();
  const startOf = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (diff === 0) return t("threads.today");
  if (diff === 1) return t("threads.yesterday");
  return d.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}
