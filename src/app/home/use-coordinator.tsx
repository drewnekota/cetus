"use client";

import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef } from "react";
import { api, onAppEvent } from "@/lib/tauri";
import { loadCachedMessages, useChatStore } from "@/lib/chat-store";
import {
  backendLabel,
  CLI_REQUEST_PREFIX,
  clip,
  STARTED_COMMAND,
  COORDINATOR_MODEL,
  COORDINATOR_TITLE,
  firstUserText,
  formatReport,
  latestReply,
  latestRequest,
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

/** A turn end is reported only once the thread has stayed idle this long, so
 *  a CLI's quick follow-up turn doesn't produce two reports. */
const SETTLE_MS = 1500;
/** Caps on what a report / thread_read hands the coordinator. */
const REPORT_CHARS = 6000;
const READ_CHARS = 16000;

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
    return (await loadCachedMessages(id)) ?? [];
  }

  function statusOf(id: string, messages: RenderedMessage[]): ThreadStatus {
    const s = chatStore.getState();
    if (s.controlRequests[id]?.length) return "needs_input";
    if (s.streamingIds.has(id)) return "working";
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
   *  that runtime's session on their message as-is (no hop through Cetus),
   *  linked to Cetus, and tell Cetus so it can track it. */
  const startDirect = useCallback(
    async (
      coordId: string,
      text: string,
      attachments: ComposerAttachment[],
      runtime: ComposerRuntimeSelection,
    ): Promise<void> => {
      const coordinator = conv(coordId);
      if (!coordinator) throw new Error("Cetus conversation not found");
      const id = await createThreadRef.current(text, attachments, coordinator.workspaceDir, {
        backend: runtime.backend,
        cliModel: runtime.cliModel || undefined,
        cliEffort: runtime.cliEffort || undefined,
        beforeSend: async (tid) => {
          setRegistry(await api.coordinatorLinkThread(tid, coordId));
        },
      });
      const names = attachments.map((a) => a.name).filter(Boolean);
      const note = formatReport({
        id,
        title: "",
        runtime: backendLabel(runtime.backend),
        status: "started",
        body: names.length ? `${text}\n\n(attached: ${names.join(", ")})` : text,
      });
      // A note, not a message: Cetus has nothing to answer. pi runs the
      // command even mid-turn and appends the note once that turn ends.
      await api.sendPrompt(coordId, `/${STARTED_COMMAND} ${note}`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setRegistry],
  );

  // --- thread tools -------------------------------------------------------
  useEffect(() => {
    async function handle(coordId: string, p: Record<string, unknown>): Promise<Reply> {
      const { registry } = useCoordinatorStore.getState();
      const own = new Set(threadsOf(registry, coordId));
      const threadId = typeof p.thread_id === "string" ? p.thread_id.trim() : "";
      const needThread = (): Reply | null =>
        own.has(threadId)
          ? null
          : { ok: false, error: `no thread with id "${threadId}"; call thread_list (or 'cetus thread list' from a shell) for ids` };

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
            // Linked before the prompt goes out, so even an instant failure
            // reports back.
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
          const threads = await Promise.all(
            [...own].map(async (id) => {
              const c = conv(id);
              if (!c) return null;
              const msgs = await messagesOf(id);
              return {
                id,
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

  // --- reports back to the coordinator -------------------------------------
  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    function report(threadId: string, status: "finished" | "error" | "needs_input") {
      const { registry } = useCoordinatorStore.getState();
      const coordId = registry.threads[threadId];
      if (!coordId || !conv(coordId)) return;
      const s = chatStore.getState();
      const c = conv(threadId);
      const msgs = s.chats[threadId]?.messages ?? [];
      const body =
        status === "needs_input"
          ? `The thread is waiting on the user:\n${pendingQuestion(s.controlRequests[threadId])}`
          : status === "error"
            ? `${s.chats[threadId]?.error ?? "The turn failed."}\n\n${clip(latestReply(msgs), REPORT_CHARS)}`
            : clip(latestReply(msgs), REPORT_CHARS);
      // A follow-up turn: say what it was asked, since the user may have typed
      // it in the thread itself.
      const request = latestRequest(msgs);
      const followUp = request && request !== firstUserText(msgs);
      enqueueRef.current(
        coordId,
        formatReport({
          id: threadId,
          title: c?.title ?? "",
          runtime: backendLabel(c?.backend ?? "pi"),
          status,
          body,
          request: followUp ? clip(request, 1500) : undefined,
        }),
      );
    }

    return chatStore.subscribe((s, prev) => {
      if (s.streamingIds === prev.streamingIds && s.controlRequests === prev.controlRequests) {
        return;
      }
      const { registry } = useCoordinatorStore.getState();
      for (const id of Object.keys(registry.threads)) {
        const asking = !!s.controlRequests[id]?.length;
        const wasAsking = !!prev.controlRequests[id]?.length;
        if (asking && !wasAsking) {
          report(id, "needs_input");
          continue;
        }
        const streaming = s.streamingIds.has(id);
        if (streaming) {
          clearTimeout(timers.get(id));
          timers.delete(id);
          continue;
        }
        if (!prev.streamingIds.has(id)) continue;
        // Turn ended: report once it has settled (and wasn't a deliberate stop).
        clearTimeout(timers.get(id));
        timers.set(
          id,
          setTimeout(() => {
            timers.delete(id);
            const now = chatStore.getState();
            if (now.streamingIds.has(id) || now.controlRequests[id]?.length) return;
            const chat = now.chats[id];
            if (chat?.aborted) return;
            report(id, chat?.error ? "error" : "finished");
          }, SETTLE_MS),
        );
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatStore]);

  return { ensureCoordinator, startDirect };
}
