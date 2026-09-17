"use client";

import type { Dispatch, SetStateAction } from "react";
import { type ComposerAttachment } from "@/components/chat/composer";
import type { SidebarView } from "@/components/sidebar/view-toggle";
import { api } from "@/lib/tauri";
import { useChatStore } from "@/lib/chat-store";
import {
  type Conversation,
  type ModelChoice,
  type QuickLaunchPayload,
} from "@/lib/types";
import {
  composeWithContext,
  splitSelectionOverflow,
} from "@/lib/quick-context";
import { utf8ToBase64, mergeConversation, prepareOutgoing } from "./home-utils";

export function useQuickLaunch({
  setView,
  setModelChoice,
  activeId,
  conversations,
  onSelect,
  setConversations,
  setActiveId,
  setWorkspaceDir,
  maybeClearReview,
  chatStore,
  setFocusToken,
  refreshList,
}: {
  setView: Dispatch<SetStateAction<SidebarView>>;
  setModelChoice: Dispatch<SetStateAction<ModelChoice>>;
  activeId: string | null;
  conversations: Conversation[];
  onSelect: (id: string) => Promise<void>;
  setConversations: Dispatch<SetStateAction<Conversation[]>>;
  setActiveId: Dispatch<SetStateAction<string | null>>;
  setWorkspaceDir: Dispatch<SetStateAction<string | null>>;
  maybeClearReview: (id: string) => void;
  chatStore: typeof useChatStore;
  setFocusToken: Dispatch<SetStateAction<number>>;
  refreshList: () => Promise<Conversation[]>;
}) {
  // --- Global quick launcher (separate frameless window) ------------------
  // The launcher gathers a prompt + optional screenshot and fires
  // "quick-launch" at the main window. We own conversation create/reuse and the
  // optimistic user bubble, so route the payload through the normal send path.
  async function quickLaunch(p: QuickLaunchPayload) {
    setView("chat");
    // A huge selection rides inline only up to its budget; the full text goes
    // along as a file so nothing is lost and the fence stays readable.
    const { inline: context, overflow } = splitSelectionOverflow(p.context);
    const attachments: ComposerAttachment[] = [
      ...(overflow
        ? [
            {
              type: "file" as const,
              data: utf8ToBase64(overflow),
              mimeType: "text/plain",
              name: "selection.txt",
              sizeBytes: new TextEncoder().encode(overflow).length,
            },
          ]
        : []),
      ...(p.image
        ? [
            {
              type: "image" as const,
              data: p.image.data,
              mimeType: p.image.mimeType,
              name: "Screenshot.jpg",
              previewUrl: `data:${p.image.mimeType};base64,${p.image.data}`,
            },
          ]
        : []),
      ...(p.attachments ?? []).map((attachment) =>
        attachment.type === "image"
          ? {
              ...attachment,
              previewUrl: `data:${attachment.mimeType};base64,${attachment.data}`,
            }
          : attachment,
      ),
    ];

    // Adopt the model choice the launcher made so the composer and launched
    // conversation agree.
    const launchedModel: ModelChoice = {
      model: p.model,
      reasoning: p.reasoning,
    };
    // The launcher already persisted its own pick to localStorage.
    setModelChoice(launchedModel);

    let target: string | null = null;
    if (p.sessionMode === "last") {
      // The open conversation, else the most-recently-updated one.
      target = activeId ?? conversations[0]?.id ?? null;
      if (target && target !== activeId) await onSelect(target);
    }
    if (!target) {
      // A null workspaceDir means the launcher's visible "Chat" default, not
      // the main window's current repo.
      const c = await api.newConversation(p.workspaceDir ?? undefined);
      target = c.id;
      // Coding-agent runtime chosen in the launcher (Cetus / Claude Code /
      // Codex). Applied to fresh conversations only — reusing "last" keeps
      // that conversation's own backend. Awaited so the first send_prompt
      // already routes through the chosen backend.
      if (p.backend && p.backend !== "pi") {
        try {
          await api.setConversationBackend(c.id, p.backend);
          if (p.cliModel || p.cliEffort) {
            await api.setConversationCliModel(
              c.id,
              p.cliModel ?? "",
              p.cliEffort ?? "",
            );
          }
        } catch (e) {
          console.error("[quick-launch] set backend failed", e);
        }
      }
      // Local insert instead of a full refetch; trailing refreshList re-sorts.
      setConversations((cs) => mergeConversation(cs, c));
      setActiveId(target);
      setWorkspaceDir(c.workspaceDir);
    } else if (target !== activeId) {
      setActiveId(target);
    }
    const convId = target;
    // Apply the launcher's model to the target (new or reused) before sending.
    api.setModelChoice(convId, launchedModel).catch(console.error);
    // Continuing an existing task from the launcher (sessionMode "last") is the
    // same "moving on" signal as the other send paths — drop it out of review.
    maybeClearReview(convId);
    const store = chatStore.getState();
    store.ensure(convId);
    // Fold any ambient context into a fenced block ahead of the prompt — the
    // model reads it as environment data, the bubble renders it as a chip. One
    // composed string drives both the optimistic render and the model send.
    const composed = composeWithContext(p.text, context);
    let out: Awaited<ReturnType<typeof prepareOutgoing>>;
    try {
      out = await prepareOutgoing(convId, composed, attachments);
    } catch (e) {
      store.ensure(convId);
      chatStore.getState().setError(convId, String(e));
      return;
    }
    store.userSent(convId, composed, out.localImages, out.savedFiles);
    setFocusToken((t) => t + 1);
    try {
      await api.sendPrompt(convId, out.piMessage, out.piImages);
    } catch (e) {
      chatStore.getState().setError(convId, String(e));
    }
    refreshList().catch(() => {});
  }
  return { quickLaunch };
}
