"use client";

import type { Conversation } from "@/lib/types";

/** Sentinel dir for the global "Pinned" section. NUL can't appear in a real
 *  filesystem path, so it never collides with a workspace dir. */
export const PINNED_GROUP_DIR = "\u0000pinned";

/** Sidebar display order: the global "Pinned" section first (present only when
 *  something is pinned), then the default "Chat" section, then folders in the
 *  user's (drag-reorderable) workspace order, chats within each group in list
 *  order. Exported so keyboard chat-switching walks this same order. */
export function groupByWorkspace(
  items: Conversation[],
  workspaceDirs: string[],
  hiddenWorkspaceDirs: string[],
  defaultWorkspace: string,
  autoSortConversations = true,
): { dir: string; items: Conversation[] }[] {
  const order: string[] = [];
  const map = new Map<string, Conversation[]>();
  const hidden = new Set(hiddenWorkspaceDirs);
  // The default workspace ("Chat") always exists and sits first — even with no
  // conversations yet, and regardless of any stale hidden entry.
  hidden.delete(defaultWorkspace);
  const ensure = (dir: string) => {
    if (hidden.has(dir)) return;
    if (!dir || map.has(dir)) return;
    map.set(dir, []);
    order.push(dir);
  };
  ensure(defaultWorkspace);
  for (const dir of workspaceDirs) ensure(dir);
  for (const c of items) {
    ensure(c.workspaceDir);
    map.get(c.workspaceDir)?.push(c);
  }
  if (!autoSortConversations) {
    for (const conversations of map.values()) {
      conversations.sort(
        (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
      );
    }
  }
  // Pins are global: pinned chats move out of their workspace group into one
  // "Pinned" section on top (newest pin first), which exists only while
  // something is pinned.
  const pinned = items
    .filter((c) => c.pinnedAt != null)
    .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
  const groups = order.map((dir) => {
    const groupItems = map.get(dir)!;
    return {
      dir,
      items: groupItems.some((c) => c.pinnedAt != null)
        ? groupItems.filter((c) => c.pinnedAt == null)
        : groupItems,
    };
  });
  return pinned.length > 0
    ? [{ dir: PINNED_GROUP_DIR, items: pinned }, ...groups]
    : groups;
}
