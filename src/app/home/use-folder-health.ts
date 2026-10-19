"use client";

import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { toast } from "sonner";
import { onWorkspaceMoved } from "@/lib/tauri";
import { tt } from "@/lib/i18n";
import { loadRecentWorkspaces } from "@/lib/recent-workspaces";
import { checkFolders, rebasePath, rebaseStoredFolders } from "@/lib/folder-health";
import type { Conversation } from "@/lib/types";

/** Re-check on focus at most this often. A check is a `stat` per folder, but
 *  focus fires on every app switch. */
const FOCUS_RECHECK_MS = 30_000;

function folderName(dir: string): string {
  return dir.split("/").filter(Boolean).pop() ?? dir;
}

/** Notice workspace folders renamed, moved or deleted on disk: check at
 *  startup and when the main window regains focus, and follow the backend's
 *  `workspace-moved` events into the in-memory rows and stored lists. */
export function useFolderHealth({
  conversationsLoaded,
  conversationsRef,
  setConversations,
  setWorkspaceDir,
  setTemporaryWorkspaces,
}: {
  conversationsLoaded: boolean;
  conversationsRef: RefObject<Conversation[]>;
  setConversations: Dispatch<SetStateAction<Conversation[]>>;
  setWorkspaceDir: Dispatch<SetStateAction<string | null>>;
  setTemporaryWorkspaces: Dispatch<SetStateAction<string[]>>;
}) {
  const lastCheckRef = useRef(0);

  useEffect(() => {
    let disposed = false;
    const unlisten = onWorkspaceMoved(({ from, to }) => {
      if (disposed) return;
      setConversations((cs) =>
        cs.map((c) => {
          const dir = rebasePath(c.workspaceDir, from, to);
          return dir === c.workspaceDir ? c : { ...c, workspaceDir: dir };
        }),
      );
      setWorkspaceDir((d) => (d ? rebasePath(d, from, to) : d));
      setTemporaryWorkspaces((dirs) => dirs.map((d) => rebasePath(d, from, to)));
      rebaseStoredFolders(from, to);
      toast.success(
        tt("sidebar", "folder.moved", {
          from: folderName(from),
          to: folderName(to),
        }),
        { description: to },
      );
    });
    return () => {
      disposed = true;
      void unlisten.then((fn) => fn());
    };
  }, [setConversations, setWorkspaceDir, setTemporaryWorkspaces]);

  useEffect(() => {
    if (!conversationsLoaded) return;
    const run = () => {
      lastCheckRef.current = Date.now();
      const dirs = [
        ...loadRecentWorkspaces(),
        ...(conversationsRef.current ?? []).map((c) => c.workspaceDir),
      ];
      checkFolders(dirs).catch(console.error);
    };
    run();
    const onFocus = () => {
      if (Date.now() - lastCheckRef.current >= FOCUS_RECHECK_MS) run();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [conversationsLoaded, conversationsRef]);
}
