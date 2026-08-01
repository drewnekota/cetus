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
