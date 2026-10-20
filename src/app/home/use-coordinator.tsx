"use client";

import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef } from "react";
import { api, onAppEvent } from "@/lib/tauri";
import { loadCachedMessages, useChatStore } from "@/lib/chat-store";
import { chatReducer, emptyChatState } from "@/lib/chat-state";
import { holdsActivity } from "@/lib/turn-notify";
import {
  backendLabel,
  CLI_REQUEST_PREFIX,
  clip,
  COORDINATOR_MODEL,
  COORDINATOR_TITLE,
  firstUserText,
  isCoordinatorId,
  latestReply,
  pendingQuestion,
  resolveCliModel,
  runtimeToBackend,
  threadsOf,
  useCoordinatorStore,
  type ThreadStatus,
} from "@/lib/coordinator";
import type { ComposerAttachment, ComposerRuntimeSelection } from "@/components/chat/composer";
import type { BackendId, Conversation, RenderedMessage } from "@/lib/types";
import { mergeConversation } from "./home-utils";

/** Cap on what `cetus thread read` hands the caller. */
const READ_CHARS = 16000;
// Most recently active non-thread sessions `cetus thread list` shows besides Cetus's
// own threads; older ones stay reachable by id.
const OTHER_SESSIONS_LISTED = 20;

type Reply = Record<string, unknown> & { ok: boolean };

export type CreateThread = (
  text: string,
  attachments: ComposerAttachment[],
  workspaceDir: string,
  opts: {
    backend: BackendId;
    /** CLI runtimes' model id; unset = the runtime's default. */
    cliModel?: string;
    cliEffort?: string;
    title?: string;
    beforeSend: (id: string) => Promise<void>;
  },
) => Promise<string>;

export function useCoordinator({
  chatStore,
  conversationsRef,
  setConversations,
  createThread,
  enqueueMessage,
  defaultBackendRef,
}: {
  chatStore: typeof useChatStore;
  conversationsRef: RefObject<Conversation[]>;
  setConversations: Dispatch<SetStateAction<Conversation[]>>;
  createThread: CreateThread;
  /** Sends now when idle, queues behind the running turn otherwise. */
  enqueueMessage: (convId: string, text: string) => void;
  /** Runtime a thread starts on when the coordinator doesn't name one. */
  defaultBackendRef: RefObject<BackendId>;
}) {
  const setRegistry = useCoordinatorStore((s) => s.setRegistry);
  // Latest callbacks for the long-lived listeners below.
  const createThreadRef = useRef(createThread);
  createThreadRef.current = createThread;
  const enqueueRef = useRef(enqueueMessage);
  enqueueRef.current = enqueueMessage;

  useEffect(() => {
    api.coordinatorRegistry().then(setRegistry).catch(console.error);
  }, [setRegistry]);

  // Each runtime's model catalog, probed once per app run (claude's spawns
  // the CLI).
  const catalogs = useRef(new Map<BackendId, Promise<{ id: string; label: string }[] | null>>());
  function catalogOf(backend: BackendId) {
    let p = catalogs.current.get(backend);
    if (!p) {
      p = api.getCliDefaults(backend).then((d) => d.models, () => null);
      catalogs.current.set(backend, p);
    }
    return p;
  }

  const conv = (id: string) => conversationsRef.current?.find((c) => c.id === id);

  async function messagesOf(id: string): Promise<RenderedMessage[]> {
    const live = chatStore.getState().chats[id]?.messages;
    if (live?.length) return live;
    const cached = await loadCachedMessages(id);
    if (cached?.length) return cached;
    // Never rendered here (a session opened elsewhere before this client saw
    // it): CLI transcripts read straight from the store, no process spawned.
    // A pi session would need its pi spawned, so it stays empty until opened.
    if ((conv(id)?.backend || "pi") === "pi") return [];
    try {
      const { messages } = await api.switchConversation(id);
      return chatReducer(emptyChatState, { type: "reset", messages }).messages;
    } catch {
      return [];
    }
  }

  function statusOf(id: string, messages: RenderedMessage[]): ThreadStatus {
    const s = chatStore.getState();
    if (s.controlRequests[id]?.length) return "needs_input";
    if (s.streamingIds.has(id) || holdsActivity(s.backgroundTasks[id])) return "working";
    if (s.chats[id]?.error) return "error";
    return latestReply(messages) ? "finished" : "idle";
  }

  /** Get (or mint) the coordinator conversation for `dir`. */
  const ensureCoordinator = useCallback(
    async (dir: string): Promise<string> => {
      // The registry may not have loaded yet on a cold start.
      const registry = await api.coordinatorRegistry();
      setRegistry(registry);
      const existing = registry.coordinators[dir];
      if (existing) {
        const row =
          conversationsRef.current?.find((c) => c.id === existing) ??
          (await api.getConversation(existing).catch(() => null));
        if (row && !row.archivedAt) {
          setConversations((cs) => mergeConversation(cs, row));
          return existing;
        }
      }
      const c = await api.newConversation(dir, COORDINATOR_MODEL);
      // Named before the first send so auto-titling leaves it alone, and
      // registered before its pi spawns so the pi gets the thread tools.
      const named = await api.renameConversation(c.id, COORDINATOR_TITLE);
      setRegistry(await api.coordinatorRegister(dir, c.id));
      setConversations((cs) => mergeConversation(cs, named));
      return c.id;
    },
    [conversationsRef, setConversations, setRegistry],
  );

  /** The user sent from Cetus's composer with another runtime picked: start
   *  that runtime's session on their message as-is. Cetus stays out of it (no
   *  link, no note): it's an ordinary session of the folder, which the
   *  timeline shows as its card. */
  const startDirect = useCallback(
    async (
      coordId: string,
      text: string,
      attachments: ComposerAttachment[],
      runtime: ComposerRuntimeSelection,
    ): Promise<void> => {
      const coordinator = conv(coordId);
      if (!coordinator) throw new Error("Cetus conversation not found");
      await createThreadRef.current(text, attachments, coordinator.workspaceDir, {
        backend: runtime.backend,
        cliModel: runtime.cliModel || undefined,
        cliEffort: runtime.cliEffort || undefined,
        beforeSend: async () => {},
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // --- thread tools -------------------------------------------------------
  // Cetus itself only starts threads and sends them follow-ups; nothing flows
  // back into its conversation — each session's card in the Threads view is
  // where the user reads status and replies. list/read/stop remain for
  // `cetus thread …` callers.
  useEffect(() => {
    async function handle(coordId: string, p: Record<string, unknown>): Promise<Reply> {
      const { registry } = useCoordinatorStore.getState();
      const own = new Set(threadsOf(registry, coordId));
      // Cetus also sees the folder's other sessions (opened from Chat, an
      // automation, …): they share its timeline, so the user can ask it about
      // them or hand them follow-ups.
      // `cetus thread` callers that aren't a coordinator keep to their own.
      const home = isCoordinatorId(registry, coordId) ? conv(coordId)?.workspaceDir : undefined;
      const inFolder = (c: Conversation) =>
        c.workspaceDir === home && !c.archivedAt && !isCoordinatorId(registry, c.id);
      const reachable = new Set(own);
      if (home) {
        const others = (conversationsRef.current ?? [])
          .filter((c) => inFolder(c) && !own.has(c.id))
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, OTHER_SESSIONS_LISTED);
        for (const c of others) reachable.add(c.id);
      }
      const threadId = typeof p.thread_id === "string" ? p.thread_id.trim() : "";
      const target = conv(threadId);
      const needThread = (): Reply | null =>
        own.has(threadId) || (home && target && inFolder(target))
          ? null
          : { ok: false, error: `no thread with id "${threadId}"; use the id thread_start returned (or 'cetus thread list' from a shell)` };

      switch (p.op) {
        case "start": {
          const task = typeof p.task === "string" ? p.task.trim() : "";
          if (!task) return { ok: false, error: "task is required" };
          const coordinator = conv(coordId);
          if (!coordinator) return { ok: false, error: "coordinator conversation not found" };
          const backend = runtimeToBackend(p.runtime) ?? defaultBackendRef.current ?? "pi";
          const title = typeof p.title === "string" ? p.title.trim().slice(0, 60) : "";
          const requested = typeof p.model === "string" ? p.model.trim() : "";
          let cliModel: string | undefined;
          let note: string | undefined;
          if (requested && backend === "pi") {
            note = "model ignored: Cetus threads use the user's selected model";
          } else if (requested) {
            const models = await catalogOf(backend);
            if (models?.length) {
              const r = resolveCliModel(requested, models);
              if ("error" in r) return { ok: false, error: r.error };
              cliModel = r.id;
            } else {
              // No catalog to check against: hand the CLI the name as given.
              cliModel = requested;
            }
          }
          const id = await createThreadRef.current(task, [], coordinator.workspaceDir, {
            backend,
            cliModel,
            title: title || undefined,
            // Linked before the prompt goes out, so the thread is Cetus's own
            // (thread_send reaches it) from its first event.
            beforeSend: async (tid) => {
              setRegistry(await api.coordinatorLinkThread(tid, coordId));
            },
          });
          return {
            ok: true,
            thread_id: id,
            title: title || conv(id)?.title || "",
            runtime: backendLabel(backend),
            ...(cliModel ? { model: cliModel } : {}),
            ...(note ? { note } : {}),
          };
        }
        case "send": {
          const bad = needThread();
          if (bad) return bad;
          const message = typeof p.message === "string" ? p.message.trim() : "";
          if (!message) return { ok: false, error: "message is required" };
          if (chatStore.getState().controlRequests[threadId]?.length) {
            return {
              ok: false,
              error:
                "the thread is blocked on a question or permission prompt inside it; " +
                "the user has to answer it in the thread (they can open its card)",
            };
          }
          const busy = chatStore.getState().streamingIds.has(threadId);
          enqueueRef.current(threadId, message);
          return {
            ok: true,
            thread_id: threadId,
            title: conv(threadId)?.title ?? "",
            delivered: busy ? "queued until its current turn ends" : "sent",
          };
        }
        case "list": {
          const ids = [...reachable].sort(
            (a, b) => (conv(a)?.createdAt ?? 0) - (conv(b)?.createdAt ?? 0),
          );
          const threads = await Promise.all(
            ids.map(async (id) => {
              const c = conv(id);
              if (!c) return null;
              const msgs = await messagesOf(id);
              return {
                id,
                yours: own.has(id),
                title: c.title,
                runtime: backendLabel(c.backend),
                status: statusOf(id, msgs),
                latest_reply: clip(latestReply(msgs).replace(/\s+/g, " "), 240),
              };
            }),
          );
          return { ok: true, threads: threads.filter(Boolean) };
        }
        case "read": {
          const bad = needThread();
          if (bad) return bad;
          const c = conv(threadId);
          const msgs = await messagesOf(threadId);
          const status = statusOf(threadId, msgs);
          return {
            ok: true,
            id: threadId,
            title: c?.title ?? "",
            runtime: backendLabel(c?.backend ?? "pi"),
            status,
            task: clip(firstUserText(msgs), 4000),
            latest_reply: clip(latestReply(msgs), READ_CHARS),
            ...(status === "needs_input"
              ? { waiting_on: pendingQuestion(chatStore.getState().controlRequests[threadId]) }
              : {}),
            error: chatStore.getState().chats[threadId]?.error ?? undefined,
          };
        }
        case "stop": {
          const bad = needThread();
          if (bad) return bad;
          if (!chatStore.getState().streamingIds.has(threadId)) {
            return { ok: true, note: "thread was not running" };
          }
          const backend = conv(threadId)?.backend ?? "pi";
          chatStore.getState().endStream(threadId, backend !== "pi");
          await api.abort(threadId);
          return { ok: true, stopped: threadId };
        }
        default:
          return { ok: false, error: `unknown op ${String(p.op)}` };
      }
    }

    let unlisten: (() => void) | undefined;
    let cancelled = false;
    onAppEvent((e) => {
      if (e.type !== "coordinator_tool_request") return;
      const { conversationId, requestId } = e;
      handle(conversationId, e.params ?? {})
        .catch((err): Reply => ({ ok: false, error: String(err) }))
        .then((reply) => {
          const value = JSON.stringify(reply);
          // `cetus thread …` from any runtime vs. the pi coordinator's tools.
          return requestId.startsWith(CLI_REQUEST_PREFIX)
            ? api.coordinatorCliRespond(requestId, value)
            : api.extensionUiRespond(conversationId, requestId, { value });
        })
        .catch((err) => console.error("[coordinator] reply failed", err));
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatStore, setRegistry]);

  return { ensureCoordinator, startDirect };
}
