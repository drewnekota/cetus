"use client";

import { useEffect, useRef } from "react";
import { BACKENDS } from "@/components/chat/backend-picker";
import { Spinner } from "@/components/ui/spinner";
import type { ChatSwitcherState } from "@/app/home/use-home-state";
import { formatRelativeTime } from "@/lib/conversation-search";
import { useTranslation } from "@/lib/i18n";
import { workspaceName } from "@/lib/paths";
import type { Conversation } from "@/lib/types";
import { cn } from "@/lib/utils";

/** The ⌃⇥ switcher: recent chats, most recently used first, over the app.
 *  The keyboard hook drives it; a click picks a row directly. */
export function ChatSwitcher({
  state,
  conversations,
  activityIds,
  unreadCompletedIds,
  onPick,
}: {
  state: ChatSwitcherState;
  conversations: Conversation[];
  activityIds: Set<string>;
  unreadCompletedIds: Set<string>;
  onPick: (id: string | null) => void;
}) {
  const { t } = useTranslation("sidebar");
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${state.index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [state.index]);
  const byId = new Map(conversations.map((c) => [c.id, c]));
  const now = Date.now();

  return (
    <div
      data-chat-switcher
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/25"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onPick(null);
      }}
    >
      <div
        ref={listRef}
        role="listbox"
        className="flex max-h-[min(520px,70vh)] w-[440px] max-w-[calc(100vw-64px)] flex-col gap-0.5 overflow-y-auto rounded-xl border border-foreground/10 bg-popover p-1.5 text-popover-foreground shadow-2xl"
      >
        {state.ids.map((id, i) => {
          const c = byId.get(id);
          if (!c) return null;
          const selected = i === state.index;
          const runtime =
            BACKENDS.find((b) => b.id === c.backend) ??
            BACKENDS.find((b) => b.id === "pi");
          return (
            <button
              key={id}
              type="button"
              role="option"
              aria-selected={selected}
              data-index={i}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(id)}
              className={cn(
                "flex h-12 w-full shrink-0 items-center gap-3 rounded-lg px-3 text-left text-sm transition-colors",
                selected
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent/50",
              )}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">
                  {c.title || t("conversation.untitled")}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {[workspaceName(c.workspaceDir), runtime?.label]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <span className="flex min-w-7 shrink-0 items-center justify-end font-mono text-xs tabular-nums text-muted-foreground/70">
                {activityIds.has(id) ? (
                  <>
                    <Spinner className="size-3" />
                    <span className="sr-only">
                      {t("conversation.inProgress")}
                    </span>
                  </>
                ) : unreadCompletedIds.has(id) ? (
                  <span className="block size-2 rounded-full bg-primary">
                    <span className="sr-only">Unread</span>
                  </span>
                ) : (
                  formatRelativeTime(c.updatedAt, now)
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
