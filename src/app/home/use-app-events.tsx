"use client";

import type { Dispatch, SetStateAction, RefObject } from "react";
import { useEffect } from "react";
import { type QueuedMessage } from "@/components/chat/composer";
import type { SidebarView } from "@/components/sidebar/view-toggle";
import { REVIEW_TOOL_NAME } from "@/lib/review";
import { api, onAppEvent } from "@/lib/tauri";
import { useChatStore } from "@/lib/chat-store";
import { dispatchNotification } from "@/lib/notifications";
import { tt } from "@/lib/i18n";
import {
  type AppEvent,
  type Automation,
  type CliBackgroundTask,
  type CliControlRequest,
  type CliRateLimitInfo,
  type CliSlashCommand,
  type Conversation,
  type ExtensionUIRequest,
  type PiEvent,
} from "@/lib/types";
import { mergeAutomation, mergeConversation } from "./home-utils";

export function useAppEvents({
  setPiReady,
  conversationsRef,
  activeIdRef,
  viewRef,
  runStatusRef,
  markUnread,
  queuedRef,
  chatStore,
  t,
  applyReviewedRow,
  setConversations,
  setAutomations,
  setTemporaryWorkspaces,
}: {
  setPiReady: Dispatch<SetStateAction<boolean>>;
  conversationsRef: RefObject<Conversation[]>;
  activeIdRef: RefObject<string | null>;
  viewRef: RefObject<SidebarView>;
  runStatusRef: RefObject<
    Record<string, { running: boolean; outcome: "ok" | "errored" | "aborted" }>
  >;
  markUnread: (cid: string, unread: boolean) => void;
  queuedRef: RefObject<Record<string, QueuedMessage[]>>;
  chatStore: typeof useChatStore;
  t: (key: string, vars?: Record<string, string | number>) => string;
  applyReviewedRow: (u: Conversation) => void;
  setConversations: Dispatch<SetStateAction<Conversation[]>>;
  setAutomations: Dispatch<SetStateAction<Automation[]>>;
  setTemporaryWorkspaces: Dispatch<SetStateAction<string[]>>;
}) {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      api
        .piPing()
        .then((ok) => ok && setPiReady(true))
        .catch(console.error);

      const convTitle = (cid: string) =>
        conversationsRef.current.find((c) => c.id === cid)?.title?.trim() ||
        "Untitled";
      // When the window is focused and the event belongs to the chat the user
      // is already watching, an OS banner is just noise — suppress it there.
      const watchingNow = (cid: string) =>
        cid === activeIdRef.current && viewRef.current === "chat";

      const notifyForPiEvent = (
        cid: string,
        pe: PiEvent | ExtensionUIRequest,
      ) => {
        switch (pe.type) {
          case "agent_start":
            runStatusRef.current[cid] = { running: true, outcome: "ok" };
            markUnread(cid, false);
            break;
          case "message_update": {
            const r = runStatusRef.current[cid];
            if (r?.running && pe.assistantMessageEvent.type === "error") {
              r.outcome =
                pe.assistantMessageEvent.reason === "aborted"
                  ? "aborted"
                  : "errored";
            }
            break;
          }
          case "agent_end": {
            // pi auto-retries transient provider failures (and retries after an
            // overflow compaction) — `willRetry` says another run is coming for
            // the SAME prompt. Notifying here would announce "your task is
            // ready" mid-retry; the run that finally settles notifies instead.
            if (pe.willRetry) break;
            const r = runStatusRef.current[cid];
            // Ignore an agent_end with no live run behind it (orphan or
            // replayed event) — only runs we saw start should notify.
            if (!r || !r.running) break;
            r.running = false;
            if (r.outcome === "aborted") break; // user aborted — stay quiet
            // A queued follow-up is about to auto-deliver (the flush effect
            // consumes the queue after this handler), so the conversation isn't
            // really done — stay quiet and let the final run notify.
            if ((queuedRef.current[cid]?.length ?? 0) > 0) break;
            // One notification for any finished run (interactive reply, board
            // task, or automation — they're all just chats); the body carries
            // success vs error.
            dispatchNotification("task_finished", {
              title: convTitle(cid),
              body:
                r.outcome === "errored"
                  ? "Finished with an error."
                  : "Your task is ready.",
              suppressWhenFocused: watchingNow(cid),
              conversationId: cid,
            });
            markUnread(cid, !watchingNow(cid));
            break;
          }
        }
      };

      const u = await onAppEvent((evt: AppEvent) => {
        const store = chatStore.getState();
        switch (evt.type) {
          case "pi_ready":
            setPiReady(true);
            break;
          case "pi_error": {
            if (evt.conversationId) {
              store.setError(evt.conversationId, evt.message);
              // Mark the *active* run as failed so the trailing agent_end
              // notifies as an error. Guarding on `running` keeps a late stderr
              // line from a finished run from corrupting the next run's
              // outcome. We don't notify here: pi_error also fires for benign
              // stderr lines and would be far too noisy.
              const r = runStatusRef.current[evt.conversationId];
              if (r?.running) r.outcome = "errored";
            }
            break;
          }
          case "pi_exited": {
            if (evt.conversationId) {
              const r = runStatusRef.current[evt.conversationId];
              const liveInStore = store.streamingIds.has(evt.conversationId);
              // macOS sleep/resume can leave us with a late sidecar-exit event
              // for a conversation whose run had already settled. Do not poison
              // that transcript with a Retry state unless the frontend still
              // believes this conversation has a live run.
              if (!r?.running && !liveInStore) break;
              store.setError(
                evt.conversationId,
                `pi exited (code ${evt.code ?? "n/a"})`,
              );
              // The child is gone; any control request it was waiting on can
              // never be answered, so drop the card — and it owned every live
              // background task (monitors, async agents), so clear the strip.
              store.clearControlRequest(evt.conversationId);
              store.setBackgroundTasks(evt.conversationId, []);
              // Close out any live run so a trailing agent_end can't double-fire.
              if (r) r.running = false;
              dispatchNotification("task_finished", {
                title: convTitle(evt.conversationId),
                body: `Agent process exited (code ${evt.code ?? "n/a"}).`,
                conversationId: evt.conversationId,
              });
            }
            break;
          }
          case "pi_event": {
            const cid = evt.conversationId;
            // extension_ui_request → DialogHost; cli_control_request → the
            // CliControlCard in the chat pane; cli_background_tasks → the
            // task strip. None of these belong in the reducer.
            const eventType = evt.event.type as string;
            if (
              evt.event.type !== "extension_ui_request" &&
              eventType !== "cli_control_request" &&
              eventType !== "cli_control_resolved" &&
              eventType !== "cli_background_tasks" &&
              eventType !== "cli_commands" &&
              eventType !== "cli_rate_limit" &&
              eventType !== "cli_context_usage" &&
              cid
            ) {
              store.piEvent(cid, evt.event);
            }
            // Account-level quota heartbeat. The snapshot is per runtime (not
            // per conversation), so the runtime picker reads it back by id.
            if (eventType === "cli_rate_limit") {
              const quotaEvent = evt.event as unknown as {
                backend?: string;
                info?: CliRateLimitInfo;
              };
              if (quotaEvent.info) {
                store.setCliRateLimit(
                  quotaEvent.backend ?? "claude-code",
                  quotaEvent.info,
                );
              }
            }
            if (cid && eventType === "cli_context_usage") {
              const usage = evt.event as unknown as {
                usedTokens?: number;
                contextWindow?: number;
                transcriptBytes?: number;
              };
              if (
                Number.isFinite(usage.usedTokens) &&
                Number.isFinite(usage.contextWindow) &&
                usage.contextWindow! > 0
              ) {
                store.setCliContextUsage(cid, {
                  usedTokens: Math.max(0, usage.usedTokens!),
                  contextWindow: usage.contextWindow!,
                  transcriptBytes: Number.isFinite(usage.transcriptBytes)
                    ? Math.max(0, usage.transcriptBytes!)
                    : undefined,
                });
              }
            }
            // The CLI session's slash-command catalog (initialize ack) — the
            // composer's slash menu reads it back per conversation.
            if (cid && eventType === "cli_commands") {
              store.setCliCommands(
                cid,
                (evt.event as unknown as { commands?: CliSlashCommand[] })
                  .commands ?? [],
              );
            }
            // Live background tasks (Monitors, async agents, background Bash)
            // owned by the conversation's CLI session. Standing state — they
            // outlive model turns, so the bridge streams the full set on every
            // change (empty when the session process exits).
            if (cid && eventType === "cli_background_tasks") {
              store.setBackgroundTasks(
                cid,
                (evt.event as unknown as { tasks?: CliBackgroundTask[] })
                  .tasks ?? [],
              );
            }
            // A claude-code control request (permission prompt / AskUserQuestion)
            // is parked in the store — captured here in the app's single
            // always-mounted listener so it survives conversation switches and
            // can't be dropped by a per-card listener's async registration. The
            // card reads it back; agent_end clears any that went unanswered
            // (the child is gone, so there's nothing left to answer).
            if (cid && eventType === "cli_control_request") {
              const req = evt.event as unknown as CliControlRequest;
              store.pushControlRequest(cid, req);
              dispatchNotification("awaiting_input", {
                title: t("cliControl.notifyTitle"),
                body:
                  req.toolName === "AskUserQuestion"
                    ? (req.input.questions?.[0]?.question ?? req.toolName)
                    : req.toolName,
                suppressWhenFocused: true,
                conversationId: cid,
              });
            }
            // Codex confirms reverse JSON-RPC requests when they are answered
            // or invalidated by turn cleanup. Remove a stale card even when
            // the resolution did not originate from this window.
            if (cid && eventType === "cli_control_resolved") {
              const resolved = evt.event as unknown as {
                requestId?: string | number;
              };
              if (resolved.requestId != null) {
                store.clearControlRequest(cid, resolved.requestId);
              }
            }
            if (cid && eventType === "agent_end") {
              store.clearControlRequest(cid);
            }
            // The agent called request_review → park this conversation in the
            // board's "Needs review" column. pi tools can't write our DB, so the
            // frontend persists the state on observing the tool's completion
            // (mirrors how parallel-task status is driven from here).
            if (
              cid &&
              evt.event.type === "tool_execution_end" &&
              evt.event.toolName === REVIEW_TOOL_NAME &&
              !evt.event.isError
            ) {
              api
                .setReviewState(cid, "pending")
                .then(applyReviewedRow)
                .catch(() => {});
            }
            if (cid) notifyForPiEvent(cid, evt.event);
            break;
          }
          case "conversation_updated": {
            // Async auto-title (or other out-of-band change) landed — merge the
            // fresh row into the sidebar list in place. If it just got archived
            // (e.g. by the auto-archive sweep), drop it from the active list.
            const updated = evt.conversation;
            setConversations((cs) =>
              updated.archivedAt != null
                ? cs.filter((c) => c.id !== updated.id)
                : cs.map((c) => (c.id === updated.id ? updated : c)),
            );
            break;
          }
          case "conversation_deleted":
            // Auto-delete sweep purged an archived chat. It's normally already
            // out of the active list; filter defensively anyway.
            setConversations((cs) => cs.filter((c) => c.id !== evt.id));
            break;
          case "automation_updated":
            setAutomations((as) => mergeAutomation(as, evt.automation));
            break;
          case "automation_deleted":
            // Deleted out-of-band (control socket / cetus CLI).
            setAutomations((as) => as.filter((a) => a.id !== evt.id));
            break;
          case "automation_fired":
            // An automation minted a fresh conversation and started streaming.
            setAutomations((as) => mergeAutomation(as, evt.automation));
            setConversations((cs) => mergeConversation(cs, evt.conversation));
            setTemporaryWorkspaces((dirs) =>
              dirs.includes(evt.conversation.workspaceDir)
                ? dirs
                : [...dirs, evt.conversation.workspaceDir],
            );
            break;
          case "meeting_event": {
            // Meeting capture lifecycle → localized OS notification. "started"
            // doubles as the consent surface (you should always know cetus is
            // transcribing), "saved" carries the generated title when one ran.
            // "stopped" is a UI-resync signal only — no notification.
            if (evt.kind === "stopped") break;
            const started = evt.kind === "started";
            dispatchNotification("meeting", {
              title: tt(
                "meeting",
                started ? "notify.started.title" : "notify.saved.title",
              ),
              body:
                (!started && evt.title) ||
                tt(
                  "meeting",
                  started ? "notify.started.body" : "notify.saved.body",
                ),
            });
            break;
          }
        }
      });
      if (cancelled) u();
      else unlisten = u;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [chatStore, markUnread]);
}
