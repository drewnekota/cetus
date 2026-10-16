// What needs attention in a folder: sessions running, waiting on the user, or
// finished but not yet opened. Settled, read sessions (idle) are left out on
// purpose — they only pile up, so a total count says nothing.

import { useMemo } from "react";
import { useChatStore } from "./chat-store";
import type { Conversation } from "./types";

export type ActivityCounts = { working: number; input: number; done: number };

export const NO_ACTIVITY: ActivityCounts = { working: 0, input: 0, done: 0 };

/** Sessions with a pending question / permission request. */
export function useInputIds(): Set<string> {
  // A joined string keeps the selector stable across unrelated store updates.
  const key = useChatStore((s) =>
    Object.keys(s.controlRequests)
      .filter((id) => s.controlRequests[id]?.length)
      .sort()
      .join("\n"),
  );
  return useMemo(() => new Set(key ? key.split("\n") : []), [key]);
}

/** Per-folder counts, plus the total under the `null` key. A session waiting
 *  on the user counts as input, not working. */
export function countActivity(
  conversations: Conversation[],
  streamingIds: Set<string>,
  unreadCompletedIds: Set<string>,
  inputIds: Set<string>,
): Map<string | null, ActivityCounts> {
  const m = new Map<string | null, ActivityCounts>();
  const bump = (dir: string | null, k: keyof ActivityCounts) => {
    const cur = m.get(dir) ?? { ...NO_ACTIVITY };
    cur[k]++;
    m.set(dir, cur);
  };
  for (const c of conversations) {
    const k: keyof ActivityCounts | null = inputIds.has(c.id)
      ? "input"
      : streamingIds.has(c.id)
        ? "working"
        : unreadCompletedIds.has(c.id)
          ? "done"
          : null;
    if (!k) continue;
    bump(c.workspaceDir, k);
    bump(null, k);
  }
  return m;
}
