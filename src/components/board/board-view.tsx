"use client";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArchiveRestore, Check, Clock, Folder, Images, MessageCircleQuestion, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatTimestamp } from "@/lib/format";
import { useChatStore, loadCachedMessages } from "@/lib/chat-store";
import type { ChatState } from "@/lib/chat-state";
import { isArtifactDetails } from "@/lib/artifact";
import { isReviewRequestDetails, type ReviewRequestDetails } from "@/lib/review";
import { ArtifactsDialog } from "@/components/board/artifacts-dialog";
import { useTranslation } from "@/lib/i18n";
import { workspaceName } from "@/lib/paths";
import type { Conversation } from "@/lib/types";

interface Props {
  conversations: Conversation[];
  workspaceFilter: string | null;
  defaultWorkspace: string;
  /** Conversation ids currently streaming (used to bucket cards into "In progress"). */
  streamingIds: Set<string>;
  onOpen: (id: string) => void;
  onArchive: (c: Conversation) => void;
  /** Approve a pending-review conversation → it drops to "Done". */
  onApproveReview: (id: string) => void;
  /** Send a pending-review conversation back with feedback (opens the chat). */
  onRequestChanges: (c: Conversation) => void;
}

// Cards land in "Needs review" when a conversation's agent called the
// `request_review` tool (reviewState === "pending") — the human-in-the-loop
// handoff.
type ColumnId = "in_progress" | "needs_review" | "done";
const COLUMNS: {
  id: ColumnId;
  labelKey: string;
  pill: string;
}[] = [
  { id: "in_progress", labelKey: "column.inProgress", pill: "bg-warning/15 text-warning" },
  { id: "needs_review", labelKey: "column.needsReview", pill: "bg-info/15 text-info" },
  { id: "done", labelKey: "column.done", pill: "bg-success/15 text-success" },
];

// Cap on how many cards the board warms from the IDB cache on mount (newest
// first). Beyond this, a card's artifact badge / reply preview lights up when
// it's opened — avoids a hundreds-deep read storm on board open.
const WARMUP_CAP = 90;

function bucket(c: Conversation, streamingIds: Set<string>): ColumnId {
  // A streaming conv wins — even a pending-review conv shows "In progress" while
  // the agent is still streaming (e.g. after the user sent feedback back).
  if (streamingIds.has(c.id)) return "in_progress";
  if (c.reviewState === "pending") return "needs_review";
  return "done";
}

export const BoardView = memo(function BoardView({
  conversations,
  workspaceFilter,
  defaultWorkspace,
  streamingIds,
  onOpen,
  onArchive,
  onApproveReview,
  onRequestChanges,
}: Props) {
  const { t } = useTranslation("board");
  const filtered = useMemo(
    () =>
      workspaceFilter
        ? conversations.filter((c) => c.workspaceDir === workspaceFilter)
        : conversations,
    [conversations, workspaceFilter],
  );

  // Conversation whose artifacts the viewer dialog is showing (null = closed).
  const [artifactsForId, setArtifactsForId] = useState<string | null>(null);

  // Warm the chat store from the IDB cache for cards we haven't opened this
  // session, so the artifact badge + last-reply preview light up without
  // having to open each task first. Guarded to never clobber a live/streaming
  // conversation (those already sit in the store) and attempted at most once
  // per id. The reducer treats these hydrated entries as the source of truth,
  // exactly like opening the card would.
  const attempted = useRef<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Bound the warm-up to the most-recent cards instead of hydrating the
      // whole (potentially hundreds-long) board from IDB on every open — that
      // storm of reads is what made opening the board hitch. `filtered` is
      // updated_at-desc, so the slice is what's most likely on screen anyway.
      for (const c of filtered.slice(0, WARMUP_CAP)) {
        if (cancelled) return;
        if (attempted.current.has(c.id)) continue;
        attempted.current.add(c.id);
        if (c.id in useChatStore.getState().chats) continue;
        const cached = await loadCachedMessages(c.id);
        if (cancelled) return;
        if (cached && cached.length > 0 && !(c.id in useChatStore.getState().chats)) {
          useChatStore.getState().hydrate(c.id, cached);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filtered]);

  const byCol = useMemo(() => {
    const m: Record<ColumnId, Conversation[]> = {
      in_progress: [],
      needs_review: [],
      done: [],
    };
    for (const c of filtered) m[bucket(c, streamingIds)].push(c);
    for (const k of Object.keys(m) as ColumnId[]) {
      m[k].sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return m;
  }, [filtered, streamingIds]);

  const artifactsConv = filtered.find((c) => c.id === artifactsForId) ?? null;

  return (
    <div className="flex-1 overflow-x-auto overflow-y-hidden p-4">
      <ArtifactsDialog
        convId={artifactsForId}
        title={artifactsConv?.title}
        open={artifactsForId !== null}
        onOpenChange={(o) => {
          if (!o) setArtifactsForId(null);
        }}
      />
      <div className="flex h-full gap-3 md:grid md:grid-cols-3">
        {COLUMNS.map((col) => {
          const items = byCol[col.id];
          return (
            <section
              key={col.id}
              className="flex h-full min-h-0 min-w-[260px] flex-col rounded-xl bg-muted/30 p-2 md:min-w-0"
            >
              <header className="flex items-center justify-between px-1 pb-2">
                <span
                  className={cn(
                    "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium tracking-[-0.2px]",
                    col.pill,
                  )}
                >
                  {t(col.labelKey)}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {items.length}
                </span>
              </header>
              <div className="flex-1 space-y-1.5 overflow-y-auto pr-0.5">
                {items.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border/60 px-3 py-4 text-center text-[11px] text-muted-foreground">
                    {t("column.empty")}
                  </div>
                ) : (
                  items.map((conv) => (
                    <Card
                      key={conv.id}
                      conversation={conv}
                      defaultWorkspace={defaultWorkspace}
                      streaming={streamingIds.has(conv.id)}
                      onOpen={onOpen}
                      onArchive={onArchive}
                      onOpenArtifacts={setArtifactsForId}
                      onApproveReview={onApproveReview}
                      onRequestChanges={onRequestChanges}
                    />
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
});

/** Memoized so a single conversation streaming / changing column / landing its
 *  title doesn't repaint every card in every column. Bites because the parent
 *  passes identity-stable callbacks (page.tsx useCallbacks + the setArtifactsForId
 *  setter) and `conversation`/`streaming` only change for the affected card. */
const Card = memo(function Card({
  conversation,
  defaultWorkspace,
  streaming,
  onOpen,
  onArchive,
  onOpenArtifacts,
  onApproveReview,
  onRequestChanges,
}: {
  conversation: Conversation;
  defaultWorkspace: string;
  streaming: boolean;
  onOpen: (id: string) => void;
  onArchive: (c: Conversation) => void;
  onOpenArtifacts: (id: string) => void;
  onApproveReview: (id: string) => void;
  onRequestChanges: (c: Conversation) => void;
}) {
  const { t } = useTranslation("board");
  const archived = !!conversation.archivedAt;
  const artifactCount = useArtifactCount(conversation.id);
  // Only the resting (non-streaming) pending state gets the review affordance —
  // while the agent is still streaming feedback back, the card sits in progress.
  const pendingReview = conversation.reviewState === "pending" && !streaming;
  const review = useLatestReviewRequest(conversation.id);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(conversation.id)}
      onKeyDown={(e) => {
        // Only the card itself — let Enter on inner buttons (artifacts /
        // dropdown) activate those without also opening the session.
        if (e.key === "Enter" && e.target === e.currentTarget) onOpen(conversation.id);
      }}
      // Skip layout/paint for cards scrolled out of a column without unmounting
      // them (keeps their store subscriptions live). Reserves ~96px so the
      // column scrollbar stays stable.
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 96px" }}
      className="group relative cursor-pointer rounded-lg border border-border bg-card px-3 py-2.5 shadow-[0px_1px_3px_0px_rgba(0,0,0,0.04)] transition-colors hover:border-border/80 hover:shadow-[0px_3px_8px_0px_rgba(0,0,0,0.06)]"
    >
      <div className="flex items-start gap-1.5 text-sm font-medium leading-snug text-foreground">
        {streaming && (
          <span
            className="mt-1.5 inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-warning"
            aria-label={t("card.streaming")}
          />
        )}
        {conversation.sourceAutomationId && (
          <Clock
            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
            aria-label={t("card.createdByAutomation")}
          />
        )}
        <span className="line-clamp-2">{conversation.title || t("card.untitled")}</span>
      </div>
      {conversation.reviewState === "approved" && (
        <div className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-medium text-success dark:text-success">
          <Check className="size-3" />
          {t("card.reviewed")}
        </div>
      )}
      <LastReplyPreview convId={conversation.id} />
      {pendingReview && (
        <div className="mt-2 rounded-md border border-info/30 bg-info/5 px-2 py-1.5">
          <div className="flex items-center gap-1 text-[11px] font-medium text-info dark:text-info">
            <MessageCircleQuestion className="size-3.5 shrink-0" />
            {t("card.needsYourReview")}
          </div>
          {review?.summary && (
            <p className="mt-1 line-clamp-3 text-[11px] leading-snug text-muted-foreground">
              {review.summary}
            </p>
          )}
          {review?.questions && review.questions.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {review.questions.map((q, i) => (
                <li
                  key={i}
                  className="flex gap-1 text-[11px] leading-snug text-muted-foreground"
                >
                  <span className="text-info">•</span>
                  <span className="line-clamp-2">{q}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex gap-1.5">
            <Button
              type="button"
              size="sm"
              className="h-7 flex-1 gap-1 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                onApproveReview(conversation.id);
              }}
            >
              <Check className="size-3.5" />
              {t("card.approve")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 flex-1 gap-1 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                onRequestChanges(conversation);
              }}
            >
              <RotateCcw className="size-3.5" />
              {t("card.requestChanges")}
            </Button>
          </div>
        </div>
      )}
      <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="inline-flex min-w-0 items-center gap-1">
          <Folder className="size-3 shrink-0" />
          <span className="truncate">
            {conversation.workspaceDir === defaultWorkspace
              ? t("card.defaultWorkspace")
              : shorten(conversation.workspaceDir, defaultWorkspace)}
          </span>
        </span>
        <span className="shrink-0 tabular-nums">
          {formatTimestamp(conversation.updatedAt)}
        </span>
      </div>
      {artifactCount > 0 && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onOpenArtifacts(conversation.id);
          }}
          className="mt-2.5 h-7 w-full justify-center gap-1.5 text-xs"
        >
          <Images className="size-3.5" />
          {t("card.viewArtifacts")}
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
            {artifactCount}
          </span>
        </Button>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onArchive(conversation);
        }}
        title={archived ? t("card.unarchive") : t("card.archive")}
        aria-label={archived ? t("card.unarchive") : t("card.archive")}
        className="absolute top-1.5 right-1.5 inline-flex size-6 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-accent-foreground group-hover:opacity-100 focus-visible:opacity-100"
      >
        {archived ? (
          <ArchiveRestore className="size-3.5" />
        ) : (
          <Archive className="size-3.5" />
        )}
      </button>
    </div>
  );
});

// Zustand runs every mounted card's selectors on every store tick — i.e. on
// every streaming token, for every card on the board. The reducer replaces the
// ChatState object only for the conversation that changed, so caching each
// card's derived value by ChatState reference turns those per-token full-message
// scans into O(1) WeakMap hits for every card except the one actually streaming.

const previewCache = new WeakMap<ChatState, string | null>();
const artifactCountCache = new WeakMap<ChatState, number>();
const reviewCache = new WeakMap<ChatState, ReviewRequestDetails | null>();

function computeLastReplyPreview(c: ChatState): string | null {
  // Walk backwards: most recent assistant text wins.
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const m = c.messages[i];
    if (m.role !== "assistant") continue;
    for (let j = m.blocks.length - 1; j >= 0; j--) {
      const b = m.blocks[j];
      if (b.kind === "text" && b.text.trim()) {
        return b.text.replace(/\s+/g, " ").slice(0, 220);
      }
    }
  }
  return null;
}

function computeArtifactCount(c: ChatState): number {
  let n = 0;
  for (const m of c.messages) {
    for (const b of m.blocks) {
      if (
        b.kind === "tool_use" &&
        b.name === "send_artifact" &&
        b.result &&
        isArtifactDetails(b.result.details)
      ) {
        n++;
      }
    }
  }
  return n;
}

function computeLatestReviewRequest(c: ChatState): ReviewRequestDetails | null {
  let latest: ReviewRequestDetails | null = null;
  for (const m of c.messages) {
    for (const b of m.blocks) {
      if (
        b.kind === "tool_use" &&
        b.name === "request_review" &&
        b.result &&
        isReviewRequestDetails(b.result.details)
      ) {
        latest = b.result.details as ReviewRequestDetails; // last one wins
      }
    }
  }
  return latest;
}

function cachedDerive<T>(
  cache: WeakMap<ChatState, T>,
  c: ChatState,
  compute: (c: ChatState) => T,
): T {
  if (cache.has(c)) return cache.get(c) as T;
  const value = compute(c);
  cache.set(c, value);
  return value;
}

/** Pulls the last assistant text block from the in-memory chat (if any) and
 *  renders a 2-line preview. Conversations not yet opened this session show
 *  nothing — opening the card via SessionDetailDialog will populate the store
 *  and the preview lights up after that. */
function LastReplyPreview({ convId }: { convId: string }) {
  const preview = useChatStore((s) => {
    const c = s.chats[convId];
    return c ? cachedDerive(previewCache, c, computeLastReplyPreview) : null;
  });
  if (!preview) return null;
  return (
    <div className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
      {preview}
    </div>
  );
}

/** Number of send_artifact results in a conversation's in-store render. Reads 0
 *  for conversations not yet hydrated (the board warms these from cache on
 *  mount, so the badge appears shortly after the board opens). */
function useArtifactCount(convId: string): number {
  return useChatStore((s) => {
    const c = s.chats[convId];
    return c ? cachedDerive(artifactCountCache, c, computeArtifactCount) : 0;
  });
}

/** Latest request_review tool payload for a conversation (summary + questions),
 *  or null. Drives the "Needs your review" banner on the card. Returns null for
 *  conversations not yet hydrated — the board warms these from cache on mount.
 *  The WeakMap cache keeps the returned object identity-stable across ticks, so
 *  a plain selector (no useShallow) suffices. */
function useLatestReviewRequest(convId: string): ReviewRequestDetails | null {
  return useChatStore((s) => {
    const c = s.chats[convId];
    return c ? cachedDerive(reviewCache, c, computeLatestReviewRequest) : null;
  });
}

function shorten(p: string, defaultWorkspace: string): string {
  if (p === defaultWorkspace) return "default";
  return workspaceName(p);
}
