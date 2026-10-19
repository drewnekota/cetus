"use client";

import { useSyncExternalStore } from "react";
import { api } from "@/lib/tauri";
import {
  loadHiddenWorkspaces,
  loadRecentWorkspaces,
  saveHiddenWorkspaces,
  saveRecentWorkspaces,
} from "@/lib/recent-workspaces";
import {
  loadCollapsedWorkspaceDirs,
  loadExpandedWorkspaceDirs,
  persistCollapsedWorkspaceDirs,
  persistExpandedWorkspaceDirs,
} from "@/lib/collapsed-workspaces";

// Folders that no longer exist on disk and couldn't be found elsewhere. The
// backend migrates renamed/moved folders on its own (see folders.rs); what
// is left here needs the user to point Cetus at the new location.

let missing: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function setMissing(next: ReadonlySet<string>) {
  if (
    next.size === missing.size &&
    [...next].every((dir) => missing.has(dir))
  ) {
    return;
  }
  missing = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const EMPTY: ReadonlySet<string> = new Set();

export function useMissingFolders(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => missing,
    () => EMPTY,
  );
}

/** Check the given folders. Moved ones are migrated by the backend, which
 *  announces each with a `workspace-moved` event. */
export async function checkFolders(dirs: string[]): Promise<void> {
  const unique = [...new Set(dirs.filter(Boolean))];
  if (unique.length === 0) return;
  const results = await api.checkWorkspaceFolders(unique);
  setMissing(
    new Set(results.filter((r) => r.status === "missing").map((r) => r.dir)),
  );
}

/** "Locate folder…": pick the folder's new location and migrate to it.
 *  Resolves false when the picker was cancelled. */
export async function locateFolder(dir: string): Promise<boolean> {
  const picked = await api.pickWorkspaceDir();
  if (!picked || picked === dir) return false;
  await api.relocateWorkspace(dir, picked);
  return true;
}

/** `path` with `from` swapped for `to` when it is `from` or inside it. */
export function rebasePath(path: string, from: string, to: string): string {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? to + path.slice(from.length) : path;
}

const QUICK_WORKSPACE_KEY = "cetus:quickWorkspace";

/** Follow a folder move in everything the frontend keeps in localStorage:
 *  the sidebar list (and its order), hidden folders, folded/expanded groups
 *  and the launcher's folder. */
export function rebaseStoredFolders(from: string, to: string) {
  const swap = (dirs: Iterable<string>) =>
    [...dirs].map((d) => rebasePath(d, from, to));
  saveRecentWorkspaces(swap(loadRecentWorkspaces()));
  saveHiddenWorkspaces(swap(loadHiddenWorkspaces()));
  persistCollapsedWorkspaceDirs(new Set(swap(loadCollapsedWorkspaceDirs())));
  persistExpandedWorkspaceDirs(new Set(swap(loadExpandedWorkspaceDirs())));
  try {
    const quick = window.localStorage.getItem(QUICK_WORKSPACE_KEY);
    if (quick) {
      window.localStorage.setItem(
        QUICK_WORKSPACE_KEY,
        rebasePath(quick, from, to),
      );
    }
  } catch {}
  setMissing(
    new Set([...missing].filter((d) => rebasePath(d, from, to) === d)),
  );
}
