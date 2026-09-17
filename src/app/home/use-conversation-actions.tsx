"use client";

import type { Dispatch, SetStateAction, RefObject } from "react";
import { useCallback } from "react";
import type { SidebarView } from "@/components/sidebar/view-toggle";
import { toast } from "sonner";
import { api } from "@/lib/tauri";
import {
  useChatStore,
  copyCachedMessages,
  saveLastActive,
} from "@/lib/chat-store";
import { type Conversation, type ModelChoice } from "@/lib/types";
import {
  hideWorkspace,
  reorderRecentWorkspaces,
} from "@/lib/recent-workspaces";
import { mergeConversation } from "./home-utils";

export function useConversationActions({
  archiveConversation,
  setConversations,
  archivingWorkspacesRef,
  conversationsRef,
  archivingIdsRef,
  setDetailId,
  activeIdRef,
  pendingSelectRef,
  setActiveId,
  setBoardWorkspaceFilter,
  chatStore,
  refreshList,
  setRecentWorkspaces,
  setHiddenWorkspaces,
  setWorkspaceDir,
  defaultWorkspace,
  setView,
  setModelChoice,
  setFocusToken,
  applyReviewedRow,
}: {
  archiveConversation: (c: Conversation) => Promise<void>;
  setConversations: Dispatch<SetStateAction<Conversation[]>>;
  archivingWorkspacesRef: RefObject<Set<string>>;
  conversationsRef: RefObject<Conversation[]>;
  archivingIdsRef: RefObject<Set<string>>;
  setDetailId: Dispatch<SetStateAction<string | null>>;
  activeIdRef: RefObject<string | null>;
  pendingSelectRef: RefObject<string | null>;
  setActiveId: Dispatch<SetStateAction<string | null>>;
  setBoardWorkspaceFilter: Dispatch<SetStateAction<string | null>>;
  chatStore: typeof useChatStore;
  refreshList: () => Promise<Conversation[]>;
  setRecentWorkspaces: Dispatch<SetStateAction<string[]>>;
  setHiddenWorkspaces: Dispatch<SetStateAction<string[]>>;
  setWorkspaceDir: Dispatch<SetStateAction<string | null>>;
  defaultWorkspace: string;
  setView: Dispatch<SetStateAction<SidebarView>>;
  setModelChoice: Dispatch<SetStateAction<ModelChoice>>;
  setFocusToken: Dispatch<SetStateAction<number>>;
  applyReviewedRow: (u: Conversation) => void;
}) {
  const onArchive = useCallback(
    async (c: Conversation) => {
      try {
        await archiveConversation(c);
      } catch (e) {
        console.error("archiveConversation failed", e);
        toast.error("Couldn't archive that conversation.");
      }
    },
    [archiveConversation],
  );

  const onTogglePin = useCallback(async (c: Conversation) => {
    const pinned = c.pinnedAt == null;
    const pinnedAt = pinned ? Date.now() : null;
    // Optimistic: the row jumps to / leaves the pinned block immediately; the
    // persisted marker lands behind it (and is rolled back on failure).
    setConversations((cs) =>
      cs.map((x) => (x.id === c.id ? { ...x, pinnedAt } : x)),
    );
    try {
      await api.setConversationPinned(c.id, pinned);
    } catch (e) {
      console.error("setConversationPinned failed", e);
      setConversations((cs) =>
        cs.map((x) =>
          x.id === c.id ? { ...x, pinnedAt: c.pinnedAt ?? null } : x,
        ),
      );
      toast.error("Couldn't pin that conversation.");
    }
  }, []);

  const onRename = useCallback(async (c: Conversation, title: string) => {
    // Optimistic: the row retitles immediately; rolled back on failure.
    setConversations((cs) =>
      cs.map((x) => (x.id === c.id ? { ...x, title } : x)),
    );
    try {
      const updated = await api.renameConversation(c.id, title);
      setConversations((cs) =>
        cs.map((x) => (x.id === updated.id ? updated : x)),
      );
    } catch (e) {
      console.error("renameConversation failed", e);
      setConversations((cs) =>
        cs.map((x) => (x.id === c.id ? { ...x, title: c.title } : x)),
      );
      toast.error("Couldn't rename that conversation.");
    }
  }, []);

  const onRevealWorkspace = useCallback(async (dir: string) => {
    try {
      await api.openPath(dir);
    } catch (e) {
      console.error("reveal workspace failed", dir, e);
      toast.error("Couldn't reveal that folder.");
    }
  }, []);

  const onArchiveWorkspaceChats = useCallback(
    async (dir: string) => {
      if (archivingWorkspacesRef.current.has(dir)) return;
      const targets = conversationsRef.current.filter(
        (c) =>
          c.workspaceDir === dir &&
          !c.archivedAt &&
          !archivingIdsRef.current.has(c.id),
      );
      if (targets.length === 0) return;
      archivingWorkspacesRef.current.add(dir);
      const targetIds = new Set(targets.map((c) => c.id));
      for (const id of targetIds) archivingIdsRef.current.add(id);

      // Match single-chat archive semantics: the workspace vanishes at click
      // time, while the slower process cleanup / Codex sync finishes behind it.
      setConversations((cs) => cs.filter((c) => !targetIds.has(c.id)));
      setDetailId((id) => (id && targetIds.has(id) ? null : id));
      if (activeIdRef.current && targetIds.has(activeIdRef.current)) {
        pendingSelectRef.current = null;
        activeIdRef.current = null;
        saveLastActive(null);
        setActiveId(null);
      }
      setBoardWorkspaceFilter((filter) => (filter === dir ? null : filter));

      try {
        const results = await Promise.allSettled(
          targets.map((c) => api.archiveConversation(c.id, true)),
        );
        const store = chatStore.getState();
        results.forEach((result, index) => {
          if (result.status === "fulfilled") store.drop(targets[index].id);
        });
        const failed = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        if (failed) throw failed.reason;
      } catch (e) {
        console.error("archive workspace chats failed", dir, e);
        // Some rows may have committed, so query the backend instead of blindly
        // restoring every optimistic removal. allSettled above guarantees the
        // reconciliation cannot race the remaining archive commands.
        await refreshList().catch(console.error);
        toast.error("Couldn't archive those chats.");
      } finally {
        for (const id of targetIds) archivingIdsRef.current.delete(id);
        archivingWorkspacesRef.current.delete(dir);
      }
    },
    [chatStore, refreshList],
  );

  const onRemoveWorkspace = useCallback(
    (dir: string) => {
      const next = hideWorkspace(dir);
      setRecentWorkspaces(next.recent);
      setHiddenWorkspaces(next.hidden);
      setBoardWorkspaceFilter((filter) => (filter === dir ? null : filter));
      setWorkspaceDir((current) =>
        current === dir ? defaultWorkspace || null : current,
      );
      const active = conversationsRef.current.find(
        (c) => c.id === activeIdRef.current,
      );
      if (active?.workspaceDir === dir) {
        saveLastActive(null);
        setActiveId(null);
      }
    },
    [defaultWorkspace],
  );

  const onReorderWorkspaces = useCallback((dirs: string[]) => {
    setRecentWorkspaces(reorderRecentWorkspaces(dirs));
  }, []);

  const onFork = useCallback(
    async (
      c: Conversation,
      messageKey?: string | null,
      messageIndex?: number | null,
    ) => {
      const store = chatStore.getState();
      if (store.chats[c.id]?.isStreaming) {
        toast.error("Wait for the current run to finish before forking.");
        return;
      }
      try {
        const { conversation, messages } = await api.forkConversation(
          c.id,
          messageKey,
          messageIndex,
        );
        setConversations((cs) => mergeConversation(cs, conversation));

        const liveCopy = store.cloneRendered(c.id, conversation.id, messageKey);
        if (!liveCopy) {
          const cached = await copyCachedMessages(c.id, conversation.id);
          if (cached && cached.length > 0) {
            chatStore.getState().hydrate(conversation.id, cached);
          } else {
            chatStore.getState().reset(conversation.id, messages);
          }
        }

        pendingSelectRef.current = conversation.id;
        setView("chat");
        setActiveId(conversation.id);
        setModelChoice(conversation.model);
        setWorkspaceDir(conversation.workspaceDir);
        setFocusToken((t) => t + 1);
      } catch (e) {
        console.error("forkConversation failed", e);
        toast.error("Couldn't fork that conversation.");
      }
    },
    [chatStore],
  );

  // --- Human-in-the-loop review (request_review tool → "Needs review") ------

  /** Approve a pending-review task → it leaves "Needs review" for "Done". */
  const onApproveReview = useCallback(
    async (id: string) => {
      const previous = conversationsRef.current.find((c) => c.id === id);
      if (!previous) return;
      setConversations((cs) =>
        cs.map((c) => (c.id === id ? { ...c, reviewState: "approved" } : c)),
      );
      try {
        const updated = await api.setReviewState(id, "approved");
        applyReviewedRow(updated);
      } catch (e) {
        console.error(e);
        // Revert only if this optimistic value is still current; a newer event
        // or user action wins over this failed request.
        setConversations((cs) =>
          cs.map((c) =>
            c.id === id && c.reviewState === "approved"
              ? { ...c, reviewState: previous.reviewState }
              : c,
          ),
        );
        toast.error("Couldn't approve that conversation.");
      }
    },
    [applyReviewedRow],
  );

  /** "Request changes": open the conversation so the user can type feedback.
   *  The pending flag is cleared when they actually send (see maybeClearReview),
   *  so a card they merely peek at stays in "Needs review". */
  const onRequestChanges = useCallback((c: Conversation) => {
    setDetailId(c.id);
  }, []);

  /** Clear a conversation's review flag once the user sends it a fresh prompt —
   *  giving feedback (or just continuing) means it's no longer waiting on review.
   *  Reads the live conversations list via a ref so it stays cheap on every send. */
  const maybeClearReview = useCallback(
    (id: string) => {
      const c = conversationsRef.current.find((x) => x.id === id);
      if (c && c.reviewState !== "none") {
        api
          .setReviewState(id, "none")
          .then(applyReviewedRow)
          .catch(() => {});
      }
    },
    [applyReviewedRow],
  );
  return {
    maybeClearReview,
    onFork,
    onRevealWorkspace,
    onArchiveWorkspaceChats,
    onRemoveWorkspace,
    onReorderWorkspaces,
    onArchive,
    onTogglePin,
    onRename,
    onApproveReview,
    onRequestChanges,
  };
}
