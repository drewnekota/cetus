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
import { INTERRUPTED_RESUME_PROMPT } from "@/lib/continuation-prompts";
import {
  type Conversation,
  type ModelChoice,
  type RunState,
  type BackendId,
} from "@/lib/types";
import {
  mergeConversation,
  Outgoing,
  prepareOutgoing,
  lastUserText,
  isNothingToRetry,
} from "./home-utils";

export function useMessageActions({
  conversationsRef,
  chatStore,
  setConversations,
  activeId,
  workspaceDir,
  setActiveId,
  setWorkspaceDir,
  modelChoice,
  setFocusToken,
  maybeClearReview,
  refreshList,
  openTerminalWithCommand,
  setQueued,
  retryingRef,
  setRetrying,
}: {
  conversationsRef: RefObject<Conversation[]>;
  chatStore: typeof useChatStore;
  setConversations: Dispatch<SetStateAction<Conversation[]>>;
  activeId: string | null;
  workspaceDir: string | null;
  setActiveId: Dispatch<SetStateAction<string | null>>;
  setWorkspaceDir: Dispatch<SetStateAction<string | null>>;
  modelChoice: ModelChoice;
  setFocusToken: Dispatch<SetStateAction<number>>;
  maybeClearReview: (id: string) => void;
  refreshList: () => Promise<Conversation[]>;
  openTerminalWithCommand: (commandRaw: string) => void;
  setQueued: Dispatch<SetStateAction<Record<string, QueuedMessage[]>>>;
  retryingRef: RefObject<boolean>;
  setRetrying: Dispatch<SetStateAction<boolean>>;
}) {
  /** Commit the runtime displayed in the composer immediately before its
   *  message is delivered. Runtime picking is intentionally only local UI
   *  state until this point, so cycling with Tab does not create audit events. */
  async function applyRuntimeSelection(
    convId: string,
    runtime: ComposerRuntimeSelection,
    fallbackBackend: BackendId = "pi",
  ) {
    const conversation = conversationsRef.current.find((c) => c.id === convId);
    const previous =
      (conversation?.backend as BackendId | undefined) ?? fallbackBackend;
    const previousModel = conversation?.cliModel ?? "";
    const previousEffort = conversation?.cliEffort ?? "";
    if (previous !== runtime.backend) {
      await api.setConversationBackend(convId, runtime.backend);
      const store = chatStore.getState();
      // Native slash catalogs belong to the runtime process that reported
      // them. Never carry Claude commands into Codex (or vice versa) while the
      // newly selected runtime is still starting.
      store.setCliCommands(convId, []);
      store.clearCliContextUsage(convId);
      if ((store.chats[convId]?.messages.length ?? 0) > 0) {
        store.runtimeSwitch(convId, previous, runtime.backend);
      }
    }
    if (
      runtime.backend !== "pi" &&
      (previous !== runtime.backend ||
        previousModel !== runtime.cliModel ||
        previousEffort !== runtime.cliEffort)
    ) {
      await api.setConversationCliModel(
        convId,
        runtime.cliModel,
        runtime.cliEffort,
      );
    }
    if (
      previous !== runtime.backend ||
      previousModel !== runtime.cliModel ||
      previousEffort !== runtime.cliEffort
    ) {
      const update = (c: Conversation) =>
        c.id === convId
          ? {
              ...c,
              backend: runtime.backend,
              cliModel: runtime.cliModel,
              cliEffort: runtime.cliEffort,
            }
          : c;
      conversationsRef.current = conversationsRef.current.map(update);
      setConversations((items) => items.map(update));
    }
  }

  async function maybeRunCodexCommand(
    convId: string,
    text: string,
    attachments: ComposerAttachment[],
  ): Promise<boolean> {
    const backend = conversationsRef.current.find(
      (c) => c.id === convId,
    )?.backend;
    if (
      backend !== "codex" ||
      attachments.length > 0 ||
      !/^\/compact(?:\s.*)?$/s.test(text.trim())
    ) {
      return false;
    }
    try {
      await api.compactConversation(convId);
    } catch (error) {
      chatStore.getState().setError(convId, String(error));
    }
    return true;
  }

  async function onSend(
    text: string,
    attachments: ComposerAttachment[] = [],
    runtime?: ComposerRuntimeSelection,
  ) {
    let id = activeId;
    let createdBackend: BackendId = "pi";
    if (!id) {
      const c = await api.newConversation(workspaceDir ?? undefined);
      id = c.id;
      createdBackend = (c.backend as BackendId | undefined) ?? "pi";
      // Insert the freshly-minted row locally instead of refetching the whole
      // list over IPC — we already hold it. The trailing refreshList() after
      // sendPrompt re-sorts by updated_at.
      setConversations((cs) => mergeConversation(cs, c));
      setActiveId(id);
      setWorkspaceDir(c.workspaceDir);
      api.setModelChoice(id, modelChoice).catch(console.error);
    }
    const convId = id;
    if (runtime) {
      try {
        await applyRuntimeSelection(convId, runtime, createdBackend);
      } catch (e) {
        console.error("[send] set backend failed", e);
        toast.error(typeof e === "string" ? e : "Couldn't switch runtime.");
        return;
      }
    }
    if (await maybeRunCodexCommand(convId, text, attachments)) {
      setFocusToken((token) => token + 1);
      return;
    }
    // A new prompt to a task that was waiting on review means we're moving on —
    // drop it out of "Needs review".
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
    // Reclaim focus so the next prompt is one keystroke away — Tauri's
    // webview steals focus away from the textarea after a submit on macOS.
    setFocusToken((t) => t + 1);
    try {
      await api.sendPrompt(convId, out.piMessage, out.piImages);
    } catch (e) {
      chatStore.getState().setError(convId, String(e));
    }
    refreshList().catch(() => {});
  }

  /** Main-chat bash entry: `!cmd` is a Terminal surface shortcut, not a chat
   *  message. Open/focus the right Terminal tab and run the command there. */
  function onBash(command: string) {
    setFocusToken((t) => t + 1);
    openTerminalWithCommand(command);
  }

  /** True when `id` runs on any CLI backend (claude-code / codex / the ACP
   *  runtimes / dsh — everything except pi). Their runner persists a stopped
   *  turn's partial messages, so an abort keeps what streamed on screen
   *  instead of dropping the in-flight turn (pi's semantics — see
   *  end_stream's keepPartial). */
  function isCliConv(id: string | null): boolean {
    const b = conversationsRef.current.find((c) => c.id === id)?.backend;
    return !!b && b !== "pi";
  }

  async function onAbort() {
    if (!activeId) return;
    // Bailing out of the run: drop anything parked for it rather than
    // auto-delivering the queue after the abort lands.
    setQueued((q) => ({ ...q, [activeId]: [] }));
    // pi.abort() stops the model but emits no agent_end, so end the run locally:
    // flips isStreaming false → the write-through cache flushes the rendered turn
    // and the run no longer looks "active" (which would stall get_messages on the
    // next reopen and leave only the user bubble).
    chatStore.getState().endStream(activeId, isCliConv(activeId));
    await api.abort(activeId);
  }

  /** Optimistically repaint one conversation's run_state so the interrupted
   *  banner reacts instantly; the next refreshList re-syncs from the store. */
  function setLocalRunState(id: string, runState: RunState) {
    setConversations((cs) =>
      cs.map((c) => (c.id === id ? { ...c, runState } : c)),
    );
  }

  /** Resume a turn that a quit/update restart cut down mid-run. Not a replay
   *  of the original prompt: the session resumes with its full context, and a
   *  visible continuation message asks the agent to check what already
   *  happened before finishing the task — so side effects (files written,
   *  messages sent) aren't blindly redone. */
  function onResumeInterrupted() {
    if (!activeId) return;
    setLocalRunState(activeId, "running");
    onSend(INTERRUPTED_RESUME_PROMPT, []).catch(console.error);
  }

  /** Dismiss the interrupted-run banner without resuming. */
  function onDismissInterrupted() {
    if (!activeId) return;
    setLocalRunState(activeId, "idle");
    api.clearInterrupted(activeId).catch(console.error);
  }

  /** Roll the last failed/empty turn out of history, then resubmit the last
   *  user message. Drives the inline error row's Retry button. */
  function onRetry() {
    return retryConversation(activeId, onSend);
  }

  /** ChatGPT-style "regenerate" for an arbitrary conversation: roll the last
   *  turn out of history (so a failed/empty turn can't poison future sends),
   *  then resubmit the last user message through `send` (onSend for the main
   *  chat, onDetailSend for the board detail dialog — each re-adds the user
   *  bubble on its own surface). */
  async function retryConversation(
    id: string | null,
    send: (text: string, attachments?: ComposerAttachment[]) => Promise<void>,
  ) {
    if (!id || retryingRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    try {
      // The optimistic user bubble that's already on screen. If the backend has
      // nothing to fork (the original send died before committing the turn —
      // e.g. a pi gone stale after a long idle), this is the message the user
      // wants resent. Capture it before we touch the store.
      const pendingText = lastUserText(id);
      let text: string;
      try {
        const res = await api.retryLastTurn(id);
        text = res.text;
        // Truncated history — the failed/poisoned turn was forked away.
        chatStore.getState().reset(id, res.messages);
      } catch (e) {
        // No committed user turn to roll back to: the send never reached the
        // session, so there's nothing to fork. Fall back to resubmitting the
        // optimistic bubble rather than dead-ending on the raw backend error.
        if (!isNothingToRetry(e) || !pendingText) throw e;
        text = pendingText;
        chatStore.getState().reset(id, []); // drop the stranded bubble + error
      }
      chatStore.getState().setError(id, null);
      await send(text); // re-adds the user bubble + reruns the turn
    } catch (e) {
      console.error("[retry] error", e);
      chatStore.getState().setError(id, String(e));
    } finally {
      retryingRef.current = false;
      setRetrying(false);
    }
  }
  return {
    onSend,
    setLocalRunState,
    applyRuntimeSelection,
    maybeRunCodexCommand,
    isCliConv,
    retryConversation,
    onBash,
    onAbort,
    onRetry,
    onResumeInterrupted,
    onDismissInterrupted,
  };
}
