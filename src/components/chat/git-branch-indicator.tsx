"use client";

import { useState, useEffect } from "react";
import { api } from "@/lib/tauri";

export function GitBranchIndicator({
  conversationId,
  workspaceDir,
  defaultWorkspace,
  streaming,
}: {
  conversationId: string | null;
  workspaceDir: string | null;
  defaultWorkspace: string;
  streaming: boolean;
}) {
  const [git, setGit] = useState<{ branch: string; path: string } | null>(null);
  const workspace = workspaceDir ?? defaultWorkspace;

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        if (conversationId) {
          const worktree = await api.conversationWorktree(conversationId);
          if (worktree?.exists) {
            if (!cancelled)
              setGit({ branch: worktree.branch, path: worktree.path });
            return;
          }
        }
        const branch = workspace
          ? await api.workspaceGitBranch(workspace)
          : null;
        if (!cancelled) setGit(branch ? { branch, path: workspace } : null);
      } catch {
        if (!cancelled) setGit(null);
      }
    };
    void refresh();
    const refreshVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    // Branches can also be switched from Cetus's terminal, which does not
    // blur/refocus the app window. Keep the small label honest without polling
    // while the app is in the background.
    const poll = window.setInterval(refreshVisible, 5_000);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [conversationId, workspace, streaming]);

  if (!git) return null;
  return (
    <span
      title={`${git.branch}\n${git.path}`}
      className="inline-flex min-w-0 items-center gap-1 text-muted-foreground/70"
    >
      <span aria-hidden="true">/</span>
      <span className="max-w-28 truncate">{git.branch}</span>
    </span>
  );
}
