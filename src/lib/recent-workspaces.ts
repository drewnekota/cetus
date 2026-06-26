"use client";

export const RECENT_WORKSPACES_STORAGE_KEY = "cetus:recentWorkspaces";
export const HIDDEN_WORKSPACES_STORAGE_KEY = "cetus:hiddenWorkspaces";
export const RECENT_WORKSPACES_CHANGED = "cetus:recent-workspaces-changed";
const MAX_RECENT_WORKSPACES = 8;

export function loadRecentWorkspaces(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_WORKSPACES_STORAGE_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr)
      ? arr.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

export function saveRecentWorkspaces(dirs: string[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      RECENT_WORKSPACES_STORAGE_KEY,
      JSON.stringify(dedupeWorkspaces(dirs).slice(0, MAX_RECENT_WORKSPACES)),
    );
    window.dispatchEvent(new Event(RECENT_WORKSPACES_CHANGED));
  } catch {}
}

export function rememberRecentWorkspace(dir: string): string[] {
  saveHiddenWorkspaces(loadHiddenWorkspaces().filter((d) => d !== dir));
  // Selecting a folder must NOT reorder the sidebar: keep an existing entry
  // exactly where it sits, and only prepend a genuinely new folder. The sidebar
  // order is otherwise user-controlled via drag-to-reorder.
  const current = loadRecentWorkspaces();
  const next = current.includes(dir) ? current : [dir, ...current];
  saveRecentWorkspaces(next);
  return next.slice(0, MAX_RECENT_WORKSPACES);
}

/** Persist an explicit, user-chosen ordering of the workspaces (drag-to-reorder
 *  in the sidebar). Writes the order verbatim (deduped) so it sticks. */
export function reorderRecentWorkspaces(dirs: string[]): string[] {
  const next = dedupeWorkspaces(dirs);
  saveRecentWorkspaces(next);
  return next.slice(0, MAX_RECENT_WORKSPACES);
}

export function loadHiddenWorkspaces(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(HIDDEN_WORKSPACES_STORAGE_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr)
      ? arr.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

export function saveHiddenWorkspaces(dirs: string[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      HIDDEN_WORKSPACES_STORAGE_KEY,
      JSON.stringify(dedupeWorkspaces(dirs)),
    );
    window.dispatchEvent(new Event(RECENT_WORKSPACES_CHANGED));
  } catch {}
}

export function hideWorkspace(dir: string): {
  recent: string[];
  hidden: string[];
} {
  const recent = loadRecentWorkspaces().filter((d) => d !== dir);
  const hidden = [dir, ...loadHiddenWorkspaces().filter((d) => d !== dir)];
  saveRecentWorkspaces(recent);
  saveHiddenWorkspaces(hidden);
  return { recent, hidden: dedupeWorkspaces(hidden) };
}

function dedupeWorkspaces(dirs: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out;
}
