"use client";

import type { Dispatch, SetStateAction, RefObject } from "react";
import {
  type ComposerAttachment,
  type ComposerRuntimeSelection,
  type QueuedMessage,
} from "@/components/chat/composer";
import { toast } from "sonner";
import { api } from "@/lib/tauri";
import { useChatStore } from "@/lib/chat-store";
import {
  type Conversation,
  type ModelChoice,
  type BackendId,
} from "@/lib/types";
import { Outgoing, prepareOutgoing } from "./home-utils";

export function useDetailActions({
  applyRuntimeSelection,
  maybeRunCodexCommand,
  maybeClearReview,
  chatStore,
  refreshList,
  detailId,
  setDetailFocusToken,
  setQueued,
  isCliConv,
  retryConversation,
  queuedRef,
  removeQueued,
  setDetailModelChoice,
  setDetailWorkspaceDir,
  setConversations,
}: {
  applyRuntimeSelection: (
    convId: string,
    runtime: ComposerRuntimeSelection,
    fallbackBackend?: BackendId | undefined,
  ) => Promise<void>;
  maybeRunCodexCommand: (
    convId: string,
    text: string,
    attachments: ComposerAttachment[],
  ) => Promise<boolean>;
  maybeClearReview: (id: string) => void;
  chatStore: typeof useChatStore;
  refreshList: () => Promise<Conversation[]>;
  detailId: string | null;
  setDetailFocusToken: Dispatch<SetStateAction<number>>;
  setQueued: Dispatch<SetStateAction<Record<string, QueuedMessage[]>>>;
  isCliConv: (id: string | null) => boolean;
  retryConversation: (
    id: string | null,
    send: (text: string, attachments?: ComposerAttachment[]) => Promise<void>,
  ) => Promise<void>;
  queuedRef: RefObject<Record<string, QueuedMessage[]>>;
  removeQueued: (convId: string, id: string) => void;
  setDetailModelChoice: Dispatch<SetStateAction<ModelChoice>>;
  setDetailWorkspaceDir: Dispatch<SetStateAction<string | null>>;
  setConversations: Dispatch<SetStateAction<Conversation[]>>;
}) {
  /** Deliver a queued follow-up to `convId`, regardless of which surface (if
   *  any) currently has it open. Mirrors the core of onSend/onDetailSend without
   *  the surface-specific focus handling, so the store-driven flush can send to
   *  a background conversation the user has navigated away from. */
  async function deliverQueued(
    convId: string,
    text: string,
    attachments: ComposerAttachment[] = [],
    runtime?: ComposerRuntimeSelection,
  ) {
    if (runtime) {
      try {
        await applyRuntimeSelection(convId, runtime);
      } catch (e) {
        console.error("[queue] set backend failed", e);
        toast.error(typeof e === "string" ? e : "Couldn't switch runtime.");
        return;
      }
    }
    if (await maybeRunCodexCommand(convId, text, attachments)) return;
    maybeClearReview(convId);
    const store = chatStore.getState();
    store.ensure(convId);
    let out: Outgoing;
    try {
      out = await prepareOutgoing(convId, text, attachments);
    } catch (e) {
      chatStore.getState().setError(convId, `attachment failed: ${e}`);
      return;
    }
    store.userSent(convId, text, out.localImages, out.savedFiles);
    try {
      await api.sendPrompt(convId, out.piMessage, out.piImages);
    } catch (e) {
      chatStore.getState().setError(convId, String(e));
    }
    refreshList().catch(() => {});
  }

  async function onDetailSend(
    text: string,
    attachments: ComposerAttachment[] = [],
    runtime?: ComposerRuntimeSelection,
  ) {
    if (!detailId) return;
    const id = detailId;
    if (runtime) {
      try {
        await applyRuntimeSelection(id, runtime);
      } catch (e) {
        console.error("[detail-send] set backend failed", e);
        toast.error(typeof e === "string" ? e : "Couldn't switch runtime.");
        return;
      }
    }
    if (await maybeRunCodexCommand(id, text, attachments)) {
      setDetailFocusToken((token) => token + 1);
      return;
    }
    // Sending feedback from the review surface clears the "Needs review" flag.
    maybeClearReview(id);
    const store = chatStore.getState();
    store.ensure(id);
    let out: Outgoing;
    try {
      out = await prepareOutgoing(id, text, attachments);
    } catch (e) {
      chatStore.getState().setError(id, `attachment failed: ${e}`);
      return;
    }
    store.userSent(id, text, out.localImages, out.savedFiles);
    setDetailFocusToken((t) => t + 1);
    try {
      await api.sendPrompt(id, out.piMessage, out.piImages);
    } catch (e) {
      chatStore.getState().setError(id, String(e));
    }
    refreshList().catch(() => {});
  }

  async function onDetailAbort() {
    if (!detailId) return;
    // Bailing out: drop anything parked for this conversation rather than
    // auto-delivering the queue after the abort lands (mirrors onAbort).
    setQueued((q) => ({ ...q, [detailId]: [] }));
    chatStore.getState().endStream(detailId, isCliConv(detailId));
    await api.abort(detailId);
  }

  /** Roll back + rerun the last turn from the detail dialog. */
  function onDetailRetry() {
    return retryConversation(detailId, onDetailSend);
  }

  /** Promote a queued follow-up to an immediate send from the detail dialog.
   *  Routes through onDetailSend so the delivery lands on `detailId` (not the
   *  main chat's activeId). */
  function steerQueuedDetail(id: string) {
    if (!detailId) return;
    const item = (queuedRef.current[detailId] ?? []).find((m) => m.id === id);
    if (!item) return;
    removeQueued(detailId, id);
    void onDetailSend(item.text, item.attachments, item.runtime);
  }

  async function onDetailModelChange(next: ModelChoice) {
    setDetailModelChoice(next);
    if (detailId) {
      api.setModelChoice(detailId, next).catch(console.error);
    }
  }

  async function onDetailWorkspaceChange(dir: string) {
    setDetailWorkspaceDir(dir);
    if (detailId) {
      const updated = await api.setWorkspace(detailId, dir);
      setConversations((cs) =>
        cs.map((c) => (c.id === updated.id ? updated : c)),
      );
    }
  }
  return {
    deliverQueued,
    onDetailModelChange,
    onDetailWorkspaceChange,
    onDetailSend,
    onDetailAbort,
    onDetailRetry,
    steerQueuedDetail,
  };
}
