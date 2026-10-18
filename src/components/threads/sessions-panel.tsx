"use client";
import { memo, useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { BACKENDS } from "@/components/chat/backend-picker";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";
import {
  computeLastReplyPreview,
  loadCachedPreviews,
  useChatStore,
} from "@/lib/chat-store";
import {
  folderSessions,
  groupSessions,
  type SessionGroup,
} from "@/lib/folder-sessions";
import { useInputIds } from "@/lib/session-activity";
import type { Conversation } from "@/lib/types";
import { plainPreview } from "./thread-cards";

// Same dots as the thread cards and the header badges.
const GROUP_DOT: Record<SessionGroup, string> = {
  input: "bg-[var(--brand)] animate-pulse",
  working: "bg-warning animate-pulse",
  recent: "bg-muted-foreground/50",
};

type Row =
  | { kind: "header"; group: SessionGroup; count: number }
  | { kind: "session"; conv: Conversation };

const HEADER_HEIGHT = 30;
const SESSION_HEIGHT = 64;
// Previews warmed from IDB around the rendered window, each side.
const WARM_AROUND = 30;

/** Every session in the folder beside Cetus: what's waiting on the user,
 *  then what's running, then the rest by recency. Threads Cetus started and
 *  sessions started anywhere else sit together; the runtime icon tells them
 *  apart. Virtualized, so a folder with thousands of sessions stays cheap.
 *  Opening one docks it in place of this pane. */
export const SessionsPanel = memo(function SessionsPanel({
  dir,
  conversations,
  streamingIds,
  unreadCompletedIds,
  onSelect,
}: {
  dir: string;
  conversations: Conversation[];
  streamingIds: Set<string>;
  unreadCompletedIds: Set<string>;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation("board");
  const inputIds = useInputIds();
  const sessions = useMemo(() => folderSessions(conversations, dir), [conversations, dir]);
  const rows = useMemo(() => {
    const out: Row[] = [];
    const grouped = groupSessions(sessions, inputIds, streamingIds);
    for (let i = 0; i < grouped.length; ) {
      const group = grouped[i].group;
      let j = i;
      while (j < grouped.length && grouped[j].group === group) j++;
      out.push({ kind: "header", group, count: j - i });
      for (let k = i; k < j; k++) out.push({ kind: "session", conv: grouped[k].conv });
      i = j;
    }
    return out;
  }, [sessions, inputIds, streamingIds]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === "header" ? HEADER_HEIGHT : SESSION_HEIGHT),
    getItemKey: (i) => {
      const r = rows[i];
      return r.kind === "header" ? `h:${r.group}` : r.conv.id;
    },
    overscan: 8,
  });
  const items = virtualizer.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items[items.length - 1]?.index ?? -1;

  // Warm last-reply previews from the small IDB records around the window,
  // never a full-history hydrate. Debounced so a fast scroll only loads where
  // it stops.
  const attempted = useRef<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      const ids = rows
        .slice(Math.max(0, first - WARM_AROUND), last + 1 + WARM_AROUND)
        .flatMap((r) => (r.kind === "session" ? [r.conv.id] : []))
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
  }, [rows, first, last]);

  return (
    <aside className="flex min-h-0 w-[320px] shrink-0 flex-col border-l border-border/70">
      <div className="flex h-10 shrink-0 items-center border-b border-border/70 px-4 text-sm font-medium text-foreground">
        {t("coordinator.overview")}
        <span className="ml-1.5 text-xs font-normal text-muted-foreground">
          {sessions.length || ""}
        </span>
      </div>
      {sessions.length === 0 ? (
        <div className="px-4 py-10 text-center text-xs leading-5 text-muted-foreground">
          {t("coordinator.overview.empty")}
        </div>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((item) => {
              const row = rows[item.index];
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="absolute inset-x-0 top-0"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {row.kind === "header" ? (
                    <div className="flex items-center gap-1.5 px-2 pb-1 pt-3 text-xs text-muted-foreground">
                      <span className={cn("size-1.5 rounded-full", GROUP_DOT[row.group])} />
                      {t(`coordinator.group.${row.group}`)}
                      <span className="tabular-nums">{row.count}</span>
                    </div>
                  ) : (
                    <SessionRow
                      conv={row.conv}
                      unread={unreadCompletedIds.has(row.conv.id)}
                      onSelect={onSelect}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </aside>
  );
});

const SessionRow = memo(function SessionRow({
  conv,
  unread,
  onSelect,
}: {
  conv: Conversation;
  unread: boolean;
  onSelect: (id: string) => void;
}) {
  const reply = useChatStore((s) => {
    const m = s.chats[conv.id]?.messages;
    return (m?.length ? computeLastReplyPreview(m) : s.previews[conv.id]?.lastReply) ?? "";
  });
  const failed = useChatStore((s) => !!s.chats[conv.id]?.error);
  const Icon = BACKENDS.find((b) => b.id === conv.backend)?.icon;
  const preview = useMemo(() => plainPreview(reply), [reply]);
  return (
    <button
      type="button"
      onClick={() => onSelect(conv.id)}
      className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-muted/70"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {Icon && <Icon className="size-3.5 shrink-0" />}
        <span
          className={cn(
            "truncate text-sm text-foreground",
            unread && "font-medium",
          )}
        >
          {conv.title || "Untitled"}
        </span>
        {(failed || unread) && (
          <span
            className={cn(
              "ml-auto size-1.5 shrink-0 rounded-full",
              failed ? "bg-destructive" : "bg-success",
            )}
          />
        )}
      </span>
      {preview && (
        <span className="line-clamp-2 text-xs leading-5 text-muted-foreground">{preview}</span>
      )}
    </button>
  );
});
