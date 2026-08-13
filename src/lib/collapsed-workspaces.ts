const COLLAPSED_WORKSPACES_KEY = "cetus.sidebar-collapsed-dirs";

export function loadCollapsedWorkspaceDirs(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(COLLAPSED_WORKSPACES_KEY);
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

export function persistCollapsedWorkspaceDirs(dirs: ReadonlySet<string>) {
  try {
    window.localStorage.setItem(
      COLLAPSED_WORKSPACES_KEY,
      JSON.stringify([...dirs]),
    );
  } catch {}
}

/** Chat ids in sidebar order, excluding rows hidden inside folded workspaces. */
export function visibleConversationIds(
  groups: ReadonlyArray<{
    dir: string;
    items: ReadonlyArray<{ id: string }>;
  }>,
  collapsedDirs: ReadonlySet<string>,
): string[] {
  return groups.flatMap((group) =>
    collapsedDirs.has(group.dir) ? [] : group.items.map((chat) => chat.id),
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
