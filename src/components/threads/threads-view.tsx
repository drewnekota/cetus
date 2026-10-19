"use client";
import { memo, useEffect, useMemo, type ReactNode } from "react";
import { Folder, MessageSquare } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";
import { workspaceName } from "@/lib/paths";
import { folderSessions, groupSessions } from "@/lib/folder-sessions";
import {
  countActivity,
  useInputIds,
  type ActivityCounts,
} from "@/lib/session-activity";
import type { Conversation } from "@/lib/types";
import { ActivityBadges } from "./activity-badges";
import { CoordinatorInstructionsButton } from "./coordinator-instructions";
import { SessionsPanel } from "./sessions-panel";
import { SessionTimelineProvider, type SessionTimeline } from "./session-timeline";
import { threadsOf, useCoordinatorStore } from "@/lib/coordinator";

interface Props {
  /** The folder this view shows. */
  dir: string;
  defaultWorkspace: string;
  /** The folder's Cetus conversation pane, once it is the active chat. */
  coordinator: ReactNode;
  conversations: Conversation[];
  streamingIds: Set<string>;
  unreadCompletedIds: Set<string>;
  /** Session docked beside Cetus, or null. */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** The docked session's surface (transcript + its own composer). */
  thread: ReactNode;
}

/** A folder as one conversation with Cetus, which answers, works, or runs
 *  threads (ordinary sessions on any runtime) and reports back. Beside it,
 *  every session in the folder; opening one docks it in that pane. */
export const ThreadsView = memo(function ThreadsView({
  dir,
  defaultWorkspace,
  coordinator,
  conversations,
  streamingIds,
  unreadCompletedIds,
  selectedId,
  onSelect,
  thread,
}: Props) {
  const { t } = useTranslation("board");
  const inputIds = useInputIds();
  const sessions = useMemo(() => folderSessions(conversations, dir), [conversations, dir]);
  // Cetus's pane doubles as the folder's timeline, the way the Threads feed
  // read before Cetus: every session it didn't start itself (its own threads
  // already sit in its transcript as tool cards or "Sent to" notes) shows
  // where it began, so sessions opened from Chat appear here too.
  const registry = useCoordinatorStore((s) => s.registry);
  const timelineSessions = useMemo(() => {
    const cetus = registry.coordinators[dir];
    const own = new Set(cetus ? threadsOf(registry, cetus) : []);
    return sessions
      .filter((c) => !own.has(c.id))
      .sort((a, b) => a.createdAt - b.createdAt);
  }, [sessions, registry, dir]);
  const timeline = useMemo<SessionTimeline>(
    () => ({
      sessions: timelineSessions,
      // Archived sessions too, so their messages keep their card.
      conversation: (id) => conversations.find((c) => c.id === id),
      streamingIds,
      unreadCompletedIds,
      selectedId,
      onSelect,
    }),
    [timelineSessions, conversations, streamingIds, unreadCompletedIds, selectedId, onSelect],
  );
  const activity = useMemo(
    () => countActivity(sessions, streamingIds, unreadCompletedIds, inputIds).get(null),
    [sessions, streamingIds, unreadCompletedIds, inputIds],
  );

  // Header badge click: open the next session (after the open one, wrapping)
  // in that state. Opening a finished one marks it read, so repeated clicks
  // walk through the unread ones.
  function jumpTo(k: keyof ActivityCounts) {
    const order = groupSessions(sessions, inputIds, streamingIds).map((s) => s.conv);
    const matches = (id: string) =>
      k === "input"
        ? inputIds.has(id)
        : !inputIds.has(id) &&
          (k === "working"
            ? streamingIds.has(id)
            : !streamingIds.has(id) && unreadCompletedIds.has(id));
    const from = selectedId ? order.findIndex((c) => c.id === selectedId) : -1;
    let idx = order.findIndex((c, i) => i > from && matches(c.id));
    if (idx < 0) idx = order.findIndex((c) => matches(c.id));
    if (idx >= 0) onSelect(order[idx].id);
  }

  // Esc closes the docked session — unless something layered on top (a menu,
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

  const isDefault = dir === defaultWorkspace;
  const FolderIcon = isDefault ? MessageSquare : Folder;

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
        {/* Mirrors the docked session's header (one h-10 line, hairline
            below) so the two panes line up side by side. Doubles as the
            window drag strip — the shell's own header shrinks to a sliver in
            this view. */}
        <div
          data-tauri-drag-region
          className="flex h-10 shrink-0 items-center gap-2.5 border-b border-border/70 px-6"
        >
          <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {isDefault ? t("card.defaultWorkspace") : workspaceName(dir)}
          </span>
          <CoordinatorInstructionsButton />
          <ActivityBadges
            counts={activity}
            labels
            onPick={jumpTo}
            className="ml-auto text-muted-foreground"
          />
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          {coordinator ? (
            <SessionTimelineProvider value={timeline}>{coordinator}</SessionTimelineProvider>
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <Spinner className="size-4 text-muted-foreground" />
            </div>
          )}
        </div>
      </div>
      {selectedId ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{thread}</div>
      ) : (
        <SessionsPanel
          dir={dir}
          conversations={conversations}
          streamingIds={streamingIds}
          unreadCompletedIds={unreadCompletedIds}
          onSelect={onSelect}
        />
      )}
    </div>
  );
});
