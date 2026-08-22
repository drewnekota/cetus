const COLLAPSED_WORKSPACES_KEY = "cetus.sidebar-collapsed-dirs";
const EXPANDED_WORKSPACES_KEY = "cetus.sidebar-expanded-dirs";

/** Chat rows shown per workspace group before the tail truncates behind a
 *  "Show more" row. Purely a display cap — all rows stay in memory. */
export const WORKSPACE_VISIBLE_LIMIT = 5;

function loadDirSet(key: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((dir): dir is string => typeof dir === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

function persistDirSet(key: string, dirs: ReadonlySet<string>) {
  try {
    window.localStorage.setItem(key, JSON.stringify([...dirs]));
  } catch {}
}

export function loadCollapsedWorkspaceDirs(): Set<string> {
  return loadDirSet(COLLAPSED_WORKSPACES_KEY);
}

export function persistCollapsedWorkspaceDirs(dirs: ReadonlySet<string>) {
  persistDirSet(COLLAPSED_WORKSPACES_KEY, dirs);
}

/** Workspaces whose "Show more" row was expanded past WORKSPACE_VISIBLE_LIMIT. */
export function loadExpandedWorkspaceDirs(): Set<string> {
  return loadDirSet(EXPANDED_WORKSPACES_KEY);
}

export function persistExpandedWorkspaceDirs(dirs: ReadonlySet<string>) {
  persistDirSet(EXPANDED_WORKSPACES_KEY, dirs);
}

/** The rows a group actually renders: everything when expanded, else the first
 *  WORKSPACE_VISIBLE_LIMIT. Shared with keyboard navigation so ⌥⌘↑/↓ never
 *  lands on a row hidden behind "Show more". */
export function visibleGroupItems<T>(
  items: ReadonlyArray<T>,
  expanded: boolean,
): ReadonlyArray<T> {
  return expanded ? items : items.slice(0, WORKSPACE_VISIBLE_LIMIT);
}

/** Chat ids in sidebar order, excluding rows hidden inside folded workspaces
 *  and rows truncated behind an unexpanded "Show more". */
export function visibleConversationIds(
  groups: ReadonlyArray<{
    dir: string;
    items: ReadonlyArray<{ id: string }>;
  }>,
  collapsedDirs: ReadonlySet<string>,
  expandedDirs: ReadonlySet<string>,
): string[] {
  return groups.flatMap((group) =>
    collapsedDirs.has(group.dir)
      ? []
      : visibleGroupItems(group.items, expandedDirs.has(group.dir)).map(
          (chat) => chat.id,
        ),
  );
}

/** The next visible chat in the current workspace, wrapping at the end. */
export function nextConversationIdInWorkspace(
  visibleIds: ReadonlyArray<string>,
  conversations: ReadonlyArray<{ id: string; workspaceDir: string }>,
  currentId: string,
): string | undefined {
  const workspaceDir = conversations.find((chat) => chat.id === currentId)?.workspaceDir;
  if (workspaceDir === undefined) return undefined;

  const workspaceIds = visibleIds.filter(
    (id) =>
      id !== currentId &&
      conversations.find((chat) => chat.id === id)?.workspaceDir === workspaceDir,
  );
  if (workspaceIds.length === 0) return undefined;

  const currentIndex = visibleIds.indexOf(currentId);
  return (
    workspaceIds.find((id) => visibleIds.indexOf(id) > currentIndex) ??
    workspaceIds[0]
  );
}
