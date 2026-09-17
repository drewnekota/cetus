"use client";

import type { Dispatch, SetStateAction, RefObject } from "react";
import { useCallback } from "react";
import { api } from "@/lib/tauri";
import { useChatStore, loadCachedMessages } from "@/lib/chat-store";
import { renderStartsMidConversation } from "@/lib/continuation-prompts";
import {
  type Conversation,
  type ModelChoice,
  type PiMessage,
} from "@/lib/types";

export function useConversationSelection({
  activeIdRef,
  pendingSelectRef,
  setLoadingChatId,
  chatStore,
  setActiveId,
  conversationsRef,
  setModelChoice,
  setWorkspaceDir,
}: {
  activeIdRef: RefObject<string | null>;
  pendingSelectRef: RefObject<string | null>;
  setLoadingChatId: Dispatch<SetStateAction<string | null>>;
  chatStore: typeof useChatStore;
  setActiveId: Dispatch<SetStateAction<string | null>>;
  conversationsRef: RefObject<Conversation[]>;
  setModelChoice: Dispatch<SetStateAction<ModelChoice>>;
  setWorkspaceDir: Dispatch<SetStateAction<string | null>>;
}) {
  const onSelect = useCallback(
    async (id: string) => {
      if (id === activeIdRef.current) return;
      // Mark this as the latest intent *before* any await. If the user clicks a
      // different chat while our async work is in flight, this ref moves on and
      // every guard below bails — so a slow select can't land its state on top
      // of a newer one (the "clicked A, landed on B" / stutter bug).
      pendingSelectRef.current = id;
      const isStale = () => pendingSelectRef.current !== id;
      const finishLoading = () => {
        setLoadingChatId((current) => (current === id ? null : current));
      };
      // Capture liveness before changing the visible id. A cold target needs a
      // stable loading transcript until hydration; otherwise `hasMessages`
      // briefly reads false and the main pane mistakes it for a new chat.
      const liveState = chatStore.getState().chats[id];
      const hasLiveState = !!liveState && liveState.messages.length > 0;
      setLoadingChatId(hasLiveState ? null : id);
      // Flip the active chat *synchronously*, before any await. The highlight
      // and pane switch must not wait on the backend round-trip — `pi_for`
      // serializes on a global lock and lazy-spawns a pi process on first open,
      // so a cold switch can take hundreds of ms. Blocking the visual switch on
      // it makes rapid clicks feel like they do nothing. Messages stream in
      // once the cache/backend resolves below (guarded by `isStale`).
      setActiveId(id);
      // A *settled* render with no user bubble at all is a stale, lossy render
      // — e.g. an automation that streamed under older code which dropped the
      // user prompt. Don't take the client-side fast path for it; fall through
      // to fetch pi history and repair below. Guarded on !isStreaming so we
      // never clobber an in-flight turn or hit get_messages' mid-run stall.
      const liveNeedsRepair =
        hasLiveState &&
        !liveState!.isStreaming &&
        !liveState!.messages.some((m) => m.role === "user");
      // We already hold this conversation's messages live in memory (opened or
      // streamed earlier this session) and its pi is attached. Switch purely
      // client-side and SKIP the backend round-trip: `switch_conversation` calls
      // `pi.get_messages()`, which blocks up to the 30s request timeout when the
      // pi is mid-run — it doesn't service control requests while an agent turn
      // streams. That timeout is spurious (the turn itself replies fine over the
      // event stream), but it stalls the metadata refresh and logs a scary
      // error. Metadata comes from the conversation row we already have.
      if (hasLiveState && !liveNeedsRepair) {
        const row = conversationsRef.current.find((c) => c.id === id);
        if (row) {
          setModelChoice(row.model);
          setWorkspaceDir(row.workspaceDir);
        }
        return;
      }
      let cacheHit = false;
      let cachedUnfaithful = false;
      let cachedLen = 0;
      if (!hasLiveState) {
        // Optimistic: hydrate from IDB cache before the backend roundtrip so
        // the bubbles paint immediately.
        const cached = await loadCachedMessages(id);
        if (isStale()) return;
        if (cached && cached.length > 0) {
          chatStore.getState().hydrate(id, cached);
          finishLoading();
          cacheHit = true;
          cachedLen = cached.length;
          // Caches written before automation runs rendered their prompt are
          // assistant-only, and caches a pre-fix auto-resume sweep overwrote
          // start at the resume prompt instead of the real opening prompt.
          // Both are strictly less faithful than pi history, so flag them to
          // fall back below.
          cachedUnfaithful =
            !cached.some((m) => m.role === "user") ||
            renderStartsMidConversation(cached);
        }
      }
      if (cacheHit && !cachedUnfaithful) {
        const row = conversationsRef.current.find((c) => c.id === id);
        if (row) {
          setModelChoice(row.model);
          setWorkspaceDir(row.workspaceDir);
        }
        return;
      }
      let conversation: Conversation;
      let messages: PiMessage[];
      try {
        ({ conversation, messages } = await api.switchConversation(id));
      } catch (e) {
        // A failed round-trip must not leave the click in limbo: the UI already
        // flipped to `id` optimistically, so log and bail rather than letting
        // the rejection silently abort the rest of the handler.
        console.error("switchConversation failed", id, e);
        finishLoading();
        return;
      }
      if (isStale()) return;
      setModelChoice(conversation.model);
      setWorkspaceDir(conversation.workspaceDir);
      // Seed from pi only when we have neither live state nor a cache hit. The
      // cache is the faithful render (pi history is lossy for image turns), so
      // we don't overwrite it; pi history is the fallback for conversations
      // this client has never rendered. Exception: a cache that dropped the
      // leading user prompt (legacy automation renders) is repaired from pi
      // history, which still carries the prompt.
      // pi history is authoritative for message COUNT. A cache thinner than
      // history means it missed turns — e.g. an interrupted run that never hit
      // agent_end, so only the user bubble (or a partial render) was cached.
      // Compare against pi's non-toolResult messages, since the cache folds
      // tool results into their tool_use blocks rather than keeping them as
      // separate entries. When history has more, repair from it.
      const piTurnCount =
        messages?.filter((m) => m.role !== "toolResult").length ?? 0;
      const cacheTooThin = cacheHit && piTurnCount > cachedLen;
      const repairFromHistory =
        !!messages?.some((m) => m.role === "user") &&
        ((cacheHit && (cachedUnfaithful || cacheTooThin)) || liveNeedsRepair);
      if ((!hasLiveState && !cacheHit) || repairFromHistory) {
        chatStore.getState().reset(conversation.id, messages);
      }
      finishLoading();
    },
    // Reads activeIdRef (not activeId) so this keeps a stable identity across
    // selections — required for the memoized sidebar rows / board cards to skip
    // re-rendering when only the active highlight moves.
    [chatStore],
  );
  return { onSelect };
}
