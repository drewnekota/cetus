"use client";
import { memo, useEffect, useState } from "react";
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
  Globe,
  Pencil,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { summarizeArgs, subagentInfo } from "@/components/chat/tool-use-card";
import { BACKENDS } from "@/components/chat/backend-picker";
import { cn } from "@/lib/utils";
import { formatTimestamp } from "@/lib/format";
import {
  computeFirstPromptPreview,
  computeLastReplyPreview,
  computeReplyCount,
  loadCachedPreviews,
  useChatStore,
  type ConvPreview,
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
import { useTranslation } from "@/lib/i18n";
import { api } from "@/lib/tauri";
import { useSessionTimeline } from "./session-timeline";
import type { BackendId, CliControlRequest, Conversation } from "@/lib/types";

// A session Cetus didn't start (opened from Chat, an automation, another
// runtime's `cetus thread`), shown in Cetus's timeline where it began: the
// opening prompt as the user's message, then a live card for the session.
// Same card the Threads feed had before Cetus, so that history reads on.

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

// Mounted cards ask for their preview records (opening prompt, last reply,
// tool digest) in one batch per frame burst — the timeline is virtualized, so
// only what's on screen loads, never a full-history hydrate. A session this
// client never rendered has no preview record; its opening prompt is read
// from the transcript instead, so the card still leads with the user's words.
const warmQueue = new Set<string>();
const warmed = new Set<string>();
let warmTimer: ReturnType<typeof setTimeout> | null = null;

function warmPreview(id: string) {
  if (warmed.has(id)) return;
  warmed.add(id);
  warmQueue.add(id);
  warmTimer ??= setTimeout(async () => {
    warmTimer = null;
    const ids = [...warmQueue];
    warmQueue.clear();
    const previews = await loadCachedPreviews(ids);
    const { chats } = useChatStore.getState();
    const missing = ids.filter(
      (id) => !previews[id]?.firstPrompt && !chats[id]?.messages.length,
    );
    if (missing.length > 0) {
      try {
        const read = await api.conversationSummaries(missing);
        for (const [id, r] of Object.entries(read)) {
          const base: ConvPreview = previews[id] ?? {
            v: 1,
            lastReply: null,
            artifactCount: 0,
            review: null,
          };
          previews[id] = {
            ...base,
            firstPrompt: r.firstPrompt ?? base.firstPrompt ?? null,
            lastReply: base.lastReply ?? r.lastReply?.replace(/\s+/g, " ").trim() ?? null,
          };
        }
      } catch (e) {
        console.error("[threads] conversation summaries failed", e);
      }
    }
    if (Object.keys(previews).length > 0) useChatStore.getState().setPreviews(previews);
  }, 80);
}

/** Memoized per row so one streaming session doesn't repaint the timeline. */
export const SessionCard = memo(function SessionCard({
  conversation: c,
  prompt: knownPrompt,
}: {
  conversation: Conversation;
  /** The opening prompt when the caller already has it (a message sent
   *  straight to a runtime), so the card doesn't wait on its preview. */
  prompt?: string;
}) {
  const { t } = useTranslation("board");
  const summary = useThreadSummary(c.id);
  const activity = useThreadActivity(c.id);
  const timeline = useSessionTimeline();
  useEffect(() => warmPreview(c.id), [c.id]);
  const streaming = !!timeline?.streamingIds.has(c.id);
  const unread = !!timeline?.unreadCompletedIds.has(c.id);
  const selected = timeline?.selectedId === c.id;
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
  const prompt = knownPrompt?.trim() || summary.firstPrompt;
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
      className="flex flex-col gap-3"
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
        onClick={() => timeline?.onSelect(c.id)}
        aria-pressed={selected}
        className={cn(
          "group flex w-full max-w-[90%] min-w-0 flex-col self-start rounded-xl border px-3.5 py-3 text-left outline-none transition-colors",
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
