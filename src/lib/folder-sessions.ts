// The sessions of one folder as the Threads view lists them beside Cetus:
// what's waiting on the user, then what's running, then everything else by
// recency. Shared by the list, the docked thread's ↑/↓ buttons and the
// keyboard stepping so all three walk the same order.

import { useCoordinatorStore } from "./coordinator";
import type { Conversation } from "./types";

export type SessionGroup = "input" | "working" | "recent";

export interface GroupedSession {
  group: SessionGroup;
  conv: Conversation;
}

// One sort per conversations array, folder and registry.
type Cached = { registry: object; list: Conversation[] };
const byRecency = new WeakMap<Conversation[], Map<string, Cached>>();

/** A folder's sessions, newest activity first. Cetus itself (the folder's
 *  coordinator) and archived rows are left out. */
export function folderSessions(conversations: Conversation[], dir: string): Conversation[] {
  const { registry } = useCoordinatorStore.getState();
  let byDir = byRecency.get(conversations);
  if (!byDir) {
    byDir = new Map();
    byRecency.set(conversations, byDir);
  }
  const hit = byDir.get(dir);
  if (hit && hit.registry === registry) return hit.list;
  const coordinators = new Set(Object.values(registry.coordinators));
  const list = conversations
    .filter((c) => c.workspaceDir === dir && !c.archivedAt && !coordinators.has(c.id))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  byDir.set(dir, { registry, list });
  return list;
}

/** Display order: waiting on the user, then running, then the rest by recency. */
export function groupSessions(
  sessions: Conversation[],
  inputIds: ReadonlySet<string>,
  streamingIds: ReadonlySet<string>,
): GroupedSession[] {
  const input: GroupedSession[] = [];
  const working: GroupedSession[] = [];
  const recent: GroupedSession[] = [];
  for (const conv of sessions) {
    if (inputIds.has(conv.id)) input.push({ group: "input", conv });
    else if (streamingIds.has(conv.id)) working.push({ group: "working", conv });
    else recent.push({ group: "recent", conv });
  }
  return [...input, ...working, ...recent];
}
