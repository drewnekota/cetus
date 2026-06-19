"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  Composer,
  type ComposerAttachment,
  type FileAttachment,
  type ImageAttachment,
  type QueuedMessage,
} from "@/components/chat/composer";
import { ChatPane } from "@/components/chat/chat-pane";
import { GlyphBackdrop } from "@/components/chat/glyph-backdrop";
import { CommandPalette } from "@/components/command-palette";
import { AppSidebar } from "@/components/sidebar/app-sidebar";
import type { SidebarView } from "@/components/sidebar/view-toggle";
import { BoardView } from "@/components/board/board-view";
import { CreateTaskDialog } from "@/components/board/create-task-dialog";
import { AutomationsView } from "@/components/automation/automations-view";
import { AutomationDialog } from "@/components/automation/automation-dialog";
import { SessionDetailDialog } from "@/components/board/session-detail-dialog";
import { REVIEW_TOOL_NAME } from "@/lib/review";
import { DialogHost } from "@/components/extension-ui/dialog-host";
import { ZoomHud } from "@/components/zoom-hud";
import { TestHook } from "@/components/devtest/test-hook";
import { ScreenHistoryPage } from "@/components/screen-history/screen-history-page";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { api, onAppEvent, type Screenshot } from "@/lib/tauri";
import {
  useChatStore,
  useChatError,
  useIsStreaming,
  useHasArtifacts,
  useHasMessages,
  useStreamingIds,
  installChatPersistence,
  loadCachedMessages,
  loadLastActive,
  saveLastActive,
} from "@/lib/chat-store";
import { useZoom } from "@/hooks/use-zoom";
import { dispatchNotification, refreshPermission } from "@/lib/notifications";
import { tt } from "@/lib/i18n";
import { buildAttachmentRefs } from "@/lib/attachments";
import {
  DEFAULT_MODEL_CHOICE,
  type AppEvent,
  type Automation,
  type AutomationInput,
  type Conversation,
  type ExtensionUIRequest,
  type ModelChoice,
  type PiEvent,
  type PiMessage,
  type QuickLaunchPayload,
} from "@/lib/types";
import { composeWithContext } from "@/lib/quick-context";

// The settings UI is a ~3900-line client component (plus react-markdown for the
// skill previews). Code-split it so its chunk only loads the first time the user
// opens Settings, keeping it out of the cold-start bundle. ssr:false is safe —
// this is a static-export Tauri SPA with no server render. Gated on
// `settingsEverOpened` below so the mount (and thus the chunk fetch) is deferred
// until first open; it then stays mounted so reopen is instant.
const SettingsPage = dynamic(
  () => import("@/components/settings/settings-page").then((m) => m.SettingsPage),
  { ssr: false },
);

// First-run welcome + permission setup. Self-gating (a localStorage flag), so
// it's safe to always mount; renders nothing once dismissed. ssr:false for the
// same reason as SettingsPage — static-export SPA, no server render.
const Onboarding = dynamic(
  () => import("@/components/onboarding/onboarding").then((m) => m.Onboarding),
  { ssr: false },
);

/** Replace an automation by id, or prepend if new. Keeps server ordering. */
function mergeAutomation(list: Automation[], a: Automation): Automation[] {
  return list.some((x) => x.id === a.id)
    ? list.map((x) => (x.id === a.id ? a : x))
    : [a, ...list];
}

/** Replace a conversation by id, or prepend if new (a freshly-fired run). */
function mergeConversation(list: Conversation[], c: Conversation): Conversation[] {
  return list.some((x) => x.id === c.id)
    ? list.map((x) => (x.id === c.id ? c : x))
    : [c, ...list];
}

/** True when retry_last_turn failed only because the backend session has no
 *  user turn to fork from (the send never committed). Lets onRetry fall back to
 *  resubmitting the optimistic bubble instead of surfacing the raw error. */
function isNothingToRetry(e: unknown): boolean {
  return String(e).includes("nothing to retry");
}

/** Concatenated text of the most recent user message in the rendered store, or
 *  null if there isn't one. Used as the resubmit source when the backend has
 *  nothing to fork. */
function lastUserText(convId: string): string | null {
  const msgs = useChatStore.getState().chats[convId]?.messages;
  if (!msgs) return null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== "user") continue;
    const text = msgs[i].blocks
      .map((b) => ("text" in b ? b.text : ""))
      .join("")
      .trim();
    return text || null;
  }
  return null;
}

interface Outgoing {
  /** Image previews for the user bubble (data URLs). */
  localImages: { dataUrl: string; name?: string }[];
  /** Non-image attachments written to disk — chips for the bubble. */
  savedFiles: { name: string; path: string; mimeType: string; sizeBytes: number }[];
  /** ImageContent blocks for pi's `images` channel. */
  piImages: { type: "image"; data: string; mimeType: string }[];
  /** Prompt text sent to pi, with the read_document path block appended. */
  piMessage: string;
}

/** Split composer attachments into the image channel (→ pi images / vision-bridge)
 *  and on-disk files (→ read_document), writing the files out. Shared by every
 *  send path (main chat, create-task, detail dialog). */
async function prepareOutgoing(
  convId: string,
  text: string,
  attachments: ComposerAttachment[],
): Promise<Outgoing> {
  const images = attachments.filter((a): a is ImageAttachment => a.type === "image");
  const files = attachments.filter((a): a is FileAttachment => a.type === "file");
  const localImages = images.map((a) => ({
    dataUrl: `data:${a.mimeType};base64,${a.data}`,
    name: a.name,
  }));
  const savedFiles = await Promise.all(
    files.map(async (f) => ({
      name: f.name,
      path: await api.saveAttachment(convId, f.name, f.data),
      mimeType: f.mimeType,
      sizeBytes: f.sizeBytes,
    })),
  );
  const piImages = images.map((a) => ({
    type: "image" as const,
    data: a.data,
    mimeType: a.mimeType,
  }));
  return { localImages, savedFiles, piImages, piMessage: text + buildAttachmentRefs(savedFiles) };
}

export default function Home() {
  useZoom();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [piReady, setPiReady] = useState(false);
  // Store actions are pulled via getState() inside callbacks so we never
  // subscribe page.tsx to chat-store ticks.
  const chatStore = useChatStore;
  const error = useChatError(activeId);
  const isStreaming = useIsStreaming(activeId);
  const hasMessages = useHasMessages(activeId);
  const streamingIds = useStreamingIds();
  const [modelChoice, setModelChoice] = useState<ModelChoice>(DEFAULT_MODEL_CHOICE);
  useEffect(() => {
    try {
      const raw = localStorage.getItem("cetus:lastModelChoice");
      if (raw) setModelChoice((m) => ({ ...m, ...JSON.parse(raw) } as ModelChoice));
    } catch {}
  }, []);
  // Persist the active model/reasoning choice on *every* change — manual picker,
  // launcher adopt, and conversation switch alike — so the quick launcher (which
  // reads "cetus:lastModelChoice") always mirrors what the main composer shows.
  // Skip the very first run: that's the initial DEFAULT, before the load effect
  // above has hydrated state, and writing it would clobber the stored value.
  const modelChoiceHydrated = useRef(false);
  useEffect(() => {
    if (!modelChoiceHydrated.current) {
      modelChoiceHydrated.current = true;
      return;
    }
    try {
      localStorage.setItem("cetus:lastModelChoice", JSON.stringify(modelChoice));
    } catch {}
  }, [modelChoice]);
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null);
  const [defaultWorkspace, setDefaultWorkspace] = useState<string>("");
  const [storedProviders, setStoredProviders] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Latches true on first open so the code-split SettingsPage mounts (and its
  // chunk loads) lazily, then stays mounted for instant reopen.
  const [settingsEverOpened, setSettingsEverOpened] = useState(false);
  useEffect(() => {
    if (settingsOpen) setSettingsEverOpened(true);
  }, [settingsOpen]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyFrame, setHistoryFrame] = useState<Screenshot | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** Bumped on every "New chat" click; threaded into Composer so it can pull
   *  focus back even when the hero is already on screen and nothing remounts. */
  const [focusToken, setFocusToken] = useState(0);
  // Restore the last sidebar view across reloads (⌘R). Lazy initializer (guarded
  // for the static-export prerender, where window is absent) so a reload paints
  // the right page straight away instead of flashing the chat hero first.
  const [view, setView] = useState<SidebarView>(() => {
    if (typeof window === "undefined") return "chat";
    try {
      const v = localStorage.getItem("cetus:lastView");
      if (v === "chat" || v === "board" || v === "automations") return v;
    } catch {}
    return "chat";
  });
  useEffect(() => {
    try {
      localStorage.setItem("cetus:lastView", view);
    } catch {}
  }, [view]);
  const [boardWorkspaceFilter, setBoardWorkspaceFilter] = useState<string | null>(null);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  /** Ultra Code master switch, surfaced as a toggle in the composer. */
  const [ultraEnabled, setUltraEnabled] = useState(false);
  const [detailModelChoice, setDetailModelChoice] = useState<ModelChoice>(DEFAULT_MODEL_CHOICE);
  const [detailWorkspaceDir, setDetailWorkspaceDir] = useState<string | null>(null);
  const [detailFocusToken, setDetailFocusToken] = useState(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [automationDialogOpen, setAutomationDialogOpen] = useState(false);
  const [editingAutomation, setEditingAutomation] = useState<Automation | null>(null);
  /** Per-conversation follow-up queue: messages typed while the agent is mid-run.
   *  They sit above the composer and are delivered one-at-a-time as the run ends
   *  (follow-up), unless the user promotes one to a steer ("Steer now"). */
  const [queued, setQueued] = useState<Record<string, QueuedMessage[]>>({});
  /** True while a retry (fork + resubmit) is in flight, to disable the button. */
  const [retrying, setRetrying] = useState(false);
  /** Synchronous reentrancy guard. The `retrying` useState value is captured in
   *  onRetry's closure and stays stale across a rapid double-fire (two clicks, or
   *  a re-render that re-invokes onRetry before setRetrying commits), which would
   *  let a second retry fork away the message the first just re-sent and then hit
   *  "nothing to retry". This ref flips synchronously, so the second call bails. */
  const retryingRef = useRef(false);

  // Refs that mirror state for the global app-event handler. That handler
  // subscribes once (deps: [chatStore]) and would otherwise close over stale
  // values — refs keep notification decisions reading the live state.
  const conversationsRef = useRef<Conversation[]>([]);
  const activeIdRef = useRef<string | null>(null);
  /** Latest conversation the user *intends* to view. Captured synchronously on
   *  click (before any await) so a slower in-flight select for a previous chat
   *  can't clobber the newer one's state when its async work resolves late. */
  const pendingSelectRef = useRef<string | null>(null);
  const viewRef = useRef<SidebarView>("chat");
  /** Per-conversation run state, so the trailing agent_end can tell a clean
   *  finish from a failed/aborted one. `running` gates the whole thing so
   *  out-of-order or orphan events can't fire a spurious/double notification:
   *  an agent_end with no live run is ignored, a late stderr pi_error can't
   *  corrupt the next run's outcome, and a crash (pi_exited) closes the run so
   *  a trailing agent_end stays quiet. */
  const runStatusRef = useRef<
    Record<string, { running: boolean; outcome: "ok" | "errored" | "aborted" }>
  >({});
  conversationsRef.current = conversations;
  activeIdRef.current = activeId;
  viewRef.current = view;

  // Mirror the live queue + send fn so the flush effect (deps: streaming/active
  // only) never reads stale closures. onSend is a hoisted function declaration.
  const queuedRef = useRef(queued);
  queuedRef.current = queued;
  const onSendRef = useRef<typeof onSend>(undefined as unknown as typeof onSend);
  onSendRef.current = onSend; // onSend is hoisted (function declaration)

  // Deliver the next queued follow-up when the active conversation's run ends.
  // Fires only on a same-conversation streaming true→false transition, so a
  // conversation switch doesn't spuriously flush. One per transition → the next
  // item waits for the turn it just started to finish (sequential, in order).
  const prevRunRef = useRef<{ id: string | null; streaming: boolean }>({
    id: null,
    streaming: false,
  });
  useEffect(() => {
    const prev = prevRunRef.current;
    prevRunRef.current = { id: activeId, streaming: isStreaming };
    if (prev.id !== activeId) return; // conversation switch, not a run boundary
    if (!(prev.streaming && !isStreaming) || !activeId) return; // only true→false
    const q = queuedRef.current[activeId];
    if (!q || q.length === 0) return;
    const [next, ...rest] = q;
    setQueued((cur) => ({ ...cur, [activeId]: rest }));
    void onSendRef.current(next.text, next.attachments);
  }, [isStreaming, activeId]);

  /** Park a message in the follow-up queue (typed while the agent is mid-run). */
  function enqueueMessage(
    convId: string,
    text: string,
    attachments: ComposerAttachment[],
  ) {
    const id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `q-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    setQueued((q) => ({
      ...q,
      [convId]: [...(q[convId] ?? []), { id, text, attachments }],
    }));
  }

  function removeQueued(convId: string, id: string) {
    setQueued((q) => ({
      ...q,
      [convId]: (q[convId] ?? []).filter((m) => m.id !== id),
    }));
  }

  /** Promote a queued message to a steer: deliver it now (injects into the
   *  current run at the next tool boundary via send_prompt's "steer"). */
  function steerQueued(convId: string, id: string) {
    const item = (queuedRef.current[convId] ?? []).find((m) => m.id === id);
    if (!item) return;
    removeQueued(convId, id);
    void onSend(item.text, item.attachments);
  }

  // Install the IDB write-through cache exactly once.
  useEffect(() => {
    installChatPersistence();
  }, []);

  // Populate the cached OS notification permission without prompting. The
  // prompt itself is deferred to the first real notification or the settings
  // page, so launch stays quiet.
  useEffect(() => {
    refreshPermission().catch(() => {});
  }, []);

  // Stable so the Settings page's Esc-listener effect doesn't re-register on
  // every parent render.
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  /** Merge a Conversation row returned by a review-state mutation. Guarded two
   *  ways vs the plain mergeConversation: (1) only updates a row still in the
   *  list, so a response that resolves after the card was archived can't
   *  resurrect it; (2) never replaces a row with an older snapshot, so a stale
   *  response can't clobber a fresher touch / auto-title. The DB stays
   *  authoritative — a skipped update self-heals on the next refreshList. */
  const applyReviewedRow = useCallback((u: Conversation) => {
    setConversations((cs) =>
      cs.map((x) => (x.id === u.id && u.updatedAt >= x.updatedAt ? u : x)),
    );
  }, []);

  const refreshKeys = useCallback(async () => {
    const keys = await api.listApiKeys();
    setStoredProviders(keys);
    return keys;
  }, []);

  useEffect(() => {
    refreshKeys()
      .then((keys) => {
        if (keys.length === 0) setSettingsOpen(true);
      })
      .catch(console.error);
    api.defaultWorkspace().then(setDefaultWorkspace).catch(console.error);
  }, [refreshKeys]);

  // Sync the Ultra Code master switch on mount and whenever the settings page
  // closes (where it can be toggled), so the composer toggle seeds correctly.
  useEffect(() => {
    if (settingsOpen) return;
    api
      .getUltraSettings()
      .then((s) => setUltraEnabled(s.enabled))
      .catch(() => {});
  }, [settingsOpen]);

  /** Flip Ultra Code right from the composer. Persists the global switch; the
   *  backend recycles idle pis so the change applies on the next turn. */
  const onUltraToggle = useCallback(() => {
    setUltraEnabled((v) => {
      const next = !v;
      api.setUltraSettings({ enabled: next }).catch(() => {});
      return next;
    });
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      api.piPing().then((ok) => ok && setPiReady(true)).catch(console.error);

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
            const r = runStatusRef.current[cid];
            // Ignore an agent_end with no live run behind it (orphan or
            // replayed event) — only runs we saw start should notify.
            if (!r || !r.running) break;
            r.running = false;
            if (r.outcome === "aborted") break; // user aborted — stay quiet
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
              store.setError(
                evt.conversationId,
                `pi exited (code ${evt.code ?? "n/a"})`,
              );
              // Close out any live run so a trailing agent_end can't double-fire.
              const r = runStatusRef.current[evt.conversationId];
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
            if (evt.event.type !== "extension_ui_request" && cid) {
              store.piEvent(cid, evt.event);
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
          case "automation_updated":
            setAutomations((as) => mergeAutomation(as, evt.automation));
            break;
          case "automation_fired":
            // An automation minted a fresh conversation and started streaming.
            setAutomations((as) => mergeAutomation(as, evt.automation));
            setConversations((cs) => mergeConversation(cs, evt.conversation));
            break;
          case "meeting_event": {
            // Meeting capture lifecycle → localized OS notification. "started"
            // doubles as the consent surface (you should always know cetus is
            // transcribing), "saved" carries the generated title when one ran.
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
  }, [chatStore]);

  const refreshList = useCallback(async () => {
    const list = await api.listConversations(false);
    setConversations(list);
    return list;
  }, []);

  useEffect(() => {
    refreshList().catch(console.error);
  }, [refreshList]);

  const refreshAutomations = useCallback(async () => {
    const list = await api.listAutomations();
    setAutomations(list);
    return list;
  }, []);

  useEffect(() => {
    refreshAutomations().catch(console.error);
  }, [refreshAutomations]);

  // Happy-path hydration: as soon as we know which conversation was last
  // active, paint its cached RenderedMessage[] from IndexedDB *before* the
  // backend round-trip lands. The subsequent switchConversation() refreshes
  // from disk and the reducer takes over for new tokens.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const lastId = loadLastActive();
      if (!lastId) return;
      const cached = await loadCachedMessages(lastId);
      if (cancelled) return;
      if (cached && cached.length > 0) {
        chatStore.getState().hydrate(lastId, cached);
        setActiveId(lastId);
        const cachedLacksUser = !cached.some((m) => m.role === "user");
        // Attach pi and pull the canonical conversation row for model/workspace.
        // We deliberately DON'T `reset` from pi's history here: that history is
        // lossy for image turns (the vision-bridge strips the image bytes and
        // merges the gemini description into the user text), so the IDB cache is
        // the more faithful render. Keep it and let the reducer append new
        // turns on top. Exception: a legacy automation cache that dropped the
        // leading user prompt is repaired from pi history, which still carries it.
        api
          .switchConversation(lastId)
          .then(({ conversation, messages }) => {
            if (cancelled) return;
            setModelChoice(conversation.model);
            setWorkspaceDir(conversation.workspaceDir);
            if (cachedLacksUser && messages?.some((m) => m.role === "user")) {
              chatStore.getState().reset(lastId, messages);
            }
          })
          .catch(console.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chatStore]);

  // Persist last-active id whenever it changes, so the *next* cold start
  // knows what to hydrate.
  useEffect(() => {
    saveLastActive(activeId);
  }, [activeId]);

  // Global keyboard shortcuts (parallels macOS app conventions):
  //   ⌘R    — reload the webview (works even behind a modal)
  //   ⌘K    — command palette
  //   ⌘N    — new chat / new board task
  //   ⌘,    — open settings
  //   ⌘1/⌘2 — switch sidebar view (chats / board), browser-tab style
  //   ⌘⇧A   — toggle artifacts panel (chat view, when artifacts exist)
  //   Esc   — close artifacts panel, else abort current stream (palette closed)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘R / Ctrl+R — reload the webview. Tauri binds no reload shortcut and
      // cetus has no app menu, so wire it here (focus-scoped to this window, so
      // it doesn't hijack ⌘R system-wide the way a global shortcut would).
      // Handled before the modal guard so it's a true escape hatch even with a
      // dialog open; reloading also clears in-memory store state, which is
      // sometimes the only way out of a wedged render.
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "r"
      ) {
        e.preventDefault();
        window.location.reload();
        return;
      }
      // A modal owns the keyboard while open — don't fire app shortcuts (or
      // Esc-abort) behind it. Settings closes itself on Esc via a capture-phase
      // listener; the dialogs handle their own ⌘↵/Esc.
      if (
        settingsOpen ||
        automationDialogOpen ||
        newTaskOpen ||
        detailId !== null
      )
        return;
      const mod = e.metaKey || e.ctrlKey;
      // Esc — abort the current stream. (No mod key; palette owns its own Esc.)
      if (e.key === "Escape" && !mod && !paletteOpen) {
        if (isStreaming && activeId) {
          e.preventDefault();
          api.abort(activeId).catch(console.error);
          return;
        }
      }
      if (!mod || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (!e.shiftKey && k === "n") {
        e.preventDefault();
        if (view === "board") {
          setNewTaskOpen(true);
        } else {
          // chat or automations → start a new chat (automations are created
          // from the Automations page's own button).
          onNew();
        }
      } else if (k === "," || e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (!e.shiftKey && (e.key === "1" || e.key === "2" || e.key === "3")) {
        e.preventDefault();
        setView(e.key === "1" ? "chat" : e.key === "2" ? "board" : "automations");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, paletteOpen, isStreaming, activeId, settingsOpen, automationDialogOpen, newTaskOpen, detailId]);

  /** "New chat" only resets the local view to the hero — the backend
   *  conversation row is created lazily on the first send. This way clicking
   *  New chat multiple times never spawns orphan Untitled rows in the
   *  sidebar. Focus is yanked back to the textarea on every click. */
  function onNew() {
    // "New chat" is a conversations action — land on the chat hero even when
    // triggered from the Automations destination.
    setView("chat");
    setActiveId(null);
    setFocusToken((t) => t + 1);
  }

  const onSelect = useCallback(
    async (id: string) => {
      if (id === activeIdRef.current) return;
      // Mark this as the latest intent *before* any await. If the user clicks a
      // different chat while our async work is in flight, this ref moves on and
      // every guard below bails — so a slow select can't land its state on top
      // of a newer one (the "clicked A, landed on B" / stutter bug).
      pendingSelectRef.current = id;
      const isStale = () => pendingSelectRef.current !== id;
      // Flip the active chat *synchronously*, before any await. The highlight
      // and pane switch must not wait on the backend round-trip — `pi_for`
      // serializes on a global lock and lazy-spawns a pi process on first open,
      // so a cold switch can take hundreds of ms. Blocking the visual switch on
      // it makes rapid clicks feel like they do nothing. Messages stream in
      // once the cache/backend resolves below (guarded by `isStale`).
      setActiveId(id);
      // Capture liveness *before* we touch the store, so a background stream
      // for this conv can't be clobbered by a cache hydrate + reset.
      const liveState = chatStore.getState().chats[id];
      const hasLiveState = !!liveState && liveState.messages.length > 0;
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
      let cachedLacksUser = false;
      let cachedLen = 0;
      if (!hasLiveState) {
        // Optimistic: hydrate from IDB cache before the backend roundtrip so
        // the bubbles paint immediately.
        const cached = await loadCachedMessages(id);
        if (isStale()) return;
        if (cached && cached.length > 0) {
          chatStore.getState().hydrate(id, cached);
          cacheHit = true;
          cachedLen = cached.length;
          // Caches written before automation runs rendered their prompt are
          // assistant-only. Such a render is strictly less faithful than pi
          // history, so flag it to fall back below.
          cachedLacksUser = !cached.some((m) => m.role === "user");
        }
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
        ((cacheHit && (cachedLacksUser || cacheTooThin)) || liveNeedsRepair);
      if ((!hasLiveState && !cacheHit) || repairFromHistory) {
        chatStore.getState().reset(conversation.id, messages);
      }
    },
    // Reads activeIdRef (not activeId) so this keeps a stable identity across
    // selections — required for the memoized sidebar rows / board cards to skip
    // re-rendering when only the active highlight moves.
    [chatStore],
  );

  // Identity-stable handlers handed to the memoized AppSidebar / BoardView /
  // ConversationRow / Card. They read the live view via viewRef so none of them
  // need a `view` dependency that would break memoization on every view switch.
  const onSelectChat = useCallback(
    (id: string) => {
      setView("chat");
      onSelect(id);
    },
    [onSelect],
  );
  const onNewSidebar = useCallback(() => {
    if (viewRef.current === "board") {
      setNewTaskOpen(true);
    } else {
      setView("chat");
      setActiveId(null);
      setFocusToken((t) => t + 1);
    }
  }, []);

  // Open the conversation a clicked OS notification points at. notify.rs brings
  // the window forward and emits this with the conversation id. Archived → it's
  // not in the active list, so unarchive (which doubles as an existence check)
  // and reload; deleted → the unarchive throws and we surface a toast instead.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<{ conversationId: string | null }>(
      "notification-activate",
      async (e) => {
        const cid = e.payload?.conversationId;
        if (!cid) return;
        if (conversationsRef.current.some((c) => c.id === cid)) {
          onSelectChat(cid);
          return;
        }
        try {
          await api.archiveConversation(cid, false);
          await refreshList();
          onSelectChat(cid);
        } catch {
          toast.error("That conversation no longer exists.");
        }
      },
    ).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [onSelectChat, refreshList]);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const onOpenDetail = useCallback((id: string) => setDetailId(id), []);

  async function onModelChange(next: ModelChoice) {
    // The [modelChoice] effect mirrors this into localStorage; here we only need
    // to update state and the per-conversation backend record.
    setModelChoice(next);
    if (activeId) {
      api.setModelChoice(activeId, next).catch(console.error);
    }
  }

  async function onWorkspaceChange(dir: string) {
    setWorkspaceDir(dir);
    if (activeId) {
      const updated = await api.setWorkspace(activeId, dir);
      setConversations((cs) => cs.map((c) => (c.id === updated.id ? updated : c)));
    }
  }

  async function onSend(text: string, attachments: ComposerAttachment[] = []) {
    let id = activeId;
    if (!id) {
      const c = await api.newConversation(workspaceDir ?? undefined);
      id = c.id;
      // Insert the freshly-minted row locally instead of refetching the whole
      // list over IPC — we already hold it. The trailing refreshList() after
      // sendPrompt re-sorts by updated_at.
      setConversations((cs) => mergeConversation(cs, c));
      setActiveId(id);
      setWorkspaceDir(c.workspaceDir);
      api.setModelChoice(id, modelChoice).catch(console.error);
    }
    const convId = id;
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

  async function onAbort() {
    if (!activeId) return;
    // Bailing out of the run: drop anything parked for it rather than
    // auto-delivering the queue after the abort lands.
    setQueued((q) => ({ ...q, [activeId]: [] }));
    // pi.abort() stops the model but emits no agent_end, so end the run locally:
    // flips isStreaming false → the write-through cache flushes the rendered turn
    // and the run no longer looks "active" (which would stall get_messages on the
    // next reopen and leave only the user bubble).
    chatStore.getState().endStream(activeId);
    await api.abort(activeId);
  }

  /** ChatGPT-style "regenerate": roll the last turn out of history (so a
   *  failed/empty turn can't poison future sends), then resubmit the last user
   *  message. Drives both the header "Retry" button (on error) and the
   *  per-message "Regenerate" action on the final assistant turn. */
  async function onRetry() {
    const id = activeId;
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
      await onSend(text); // re-adds the user bubble + reruns the turn
    } catch (e) {
      console.error("[retry] error", e);
      chatStore.getState().setError(id, String(e));
    } finally {
      retryingRef.current = false;
      setRetrying(false);
    }
  }

  // --- Global quick launcher (separate frameless window) ------------------
  // The launcher gathers a prompt + optional screenshot and fires
  // "quick-launch" at the main window. We own conversation create/reuse and the
  // optimistic user bubble, so route the payload through the normal send path.
  async function quickLaunch(p: QuickLaunchPayload) {
    setView("chat");
    const localImages = p.image
      ? [{ dataUrl: `data:${p.image.mimeType};base64,${p.image.data}`, name: "Screenshot.jpg" }]
      : [];
    const images = p.image
      ? [{ type: "image" as const, data: p.image.data, mimeType: p.image.mimeType }]
      : [];

    // Adopt the model + Ultra choice the launcher made so the composer and the
    // launched conversation agree. Ultra is a global switch the launcher already
    // persisted backend-side; mirror it into the main window's state too.
    const launchedModel: ModelChoice = { model: p.model, reasoning: p.reasoning };
    // The [modelChoice] effect persists this to localStorage.
    setModelChoice(launchedModel);
    setUltraEnabled(p.ultra);

    let target: string | null = null;
    if (p.sessionMode === "last") {
      // The open conversation, else the most-recently-updated one.
      target = activeId ?? conversations[0]?.id ?? null;
      if (target && target !== activeId) await onSelect(target);
    }
    if (!target) {
      // Honor the repo chosen in the launcher; fall back to the main window's
      // current workspace, then the backend default.
      const c = await api.newConversation(p.workspaceDir ?? workspaceDir ?? undefined);
      target = c.id;
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
    const composed = composeWithContext(p.text, p.context);
    store.userSent(convId, composed, localImages);
    setFocusToken((t) => t + 1);
    try {
      await api.sendPrompt(convId, composed, images);
    } catch (e) {
      chatStore.getState().setError(convId, String(e));
    }
    refreshList().catch(() => {});
  }
  // Keep a live ref so the mount-once listener always calls the latest closure
  // (quickLaunch closes over activeId / conversations / workspaceDir).
  const quickLaunchRef = useRef(quickLaunch);
  quickLaunchRef.current = quickLaunch;
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<QuickLaunchPayload>("quick-launch", (e) => {
          void quickLaunchRef.current(e.payload);
        }),
      )
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Tray "Settings" item opens the settings screen (the window is shown natively
  // by the tray handler before this fires).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen("open-settings", () => setSettingsOpen(true)),
      )
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  /** Create-task dialog handler: mint a conversation, optimistically seed the
   *  user bubble, fire-and-forget sendPrompt (the agent streams asynchronously
   *  and shows up as a card on the kanban with a streaming dot). */
  async function onCreateTask(
    text: string,
    attachments: ComposerAttachment[],
  ) {
    const c = await api.newConversation(workspaceDir ?? undefined);
    const id = c.id;
    // Show the new card immediately via a local insert (no IPC); the .finally
    // refreshList below re-sorts once the run starts bumping updated_at.
    setConversations((cs) => mergeConversation(cs, c));
    api.setModelChoice(id, modelChoice).catch(console.error);
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
    // Don't await — let the agent stream in the background. The kanban card
    // shows a live "streaming" dot via streamingIds.
    api
      .sendPrompt(id, out.piMessage, out.piImages)
      .catch((e) => chatStore.getState().setError(id, String(e)))
      .finally(() => refreshList().catch(() => {}));
  }

  // --- Detail dialog (board card peek that supports chat) -----------------
  useEffect(() => {
    if (!detailId) return;
    const conv = conversations.find((c) => c.id === detailId);
    if (conv) {
      setDetailModelChoice(conv.model);
      setDetailWorkspaceDir(conv.workspaceDir);
    }
    setDetailFocusToken((t) => t + 1);
    const id = detailId;
    let cancelled = false;
    (async () => {
      // Snapshot liveness before any await so a streaming conv can't get
      // clobbered by a late cache hydrate + reset.
      const hasLiveState = (() => {
        const c = chatStore.getState().chats[id];
        return !!c && c.messages.length > 0;
      })();
      if (hasLiveState) return; // nothing to do; reducer owns state
      // Flip loading on synchronously, BEFORE the first await, so the dialog
      // paints its skeleton immediately instead of flashing ChatPane's empty
      // hero while the cache + history round-trips resolve. (Once a cache hit
      // hydrates the store, the dialog's hasChatEntry gate hides the skeleton.)
      setDetailLoading(true);
      const cached = await loadCachedMessages(id);
      if (cancelled) return;
      let cacheHit = false;
      let cachedLacksUser = false;
      if (cached && cached.length > 0) {
        chatStore.getState().hydrate(id, cached);
        cacheHit = true;
        cachedLacksUser = !cached.some((m) => m.role === "user");
      }
      try {
        const { messages } = await api.switchConversation(id);
        if (cancelled) return;
        // Keep the faithful cache render if we had one; pi history is the
        // lossy fallback (see onSelect / cold-start hydration). Exception: a
        // legacy automation cache that dropped the leading user prompt is
        // repaired from pi history, which still carries it.
        const repairFromHistory =
          cacheHit && cachedLacksUser && !!messages?.some((m) => m.role === "user");
        if (!cacheHit || repairFromHistory) chatStore.getState().reset(id, messages);
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailId]);

  async function onDetailSend(text: string, attachments: ComposerAttachment[] = []) {
    if (!detailId) return;
    const id = detailId;
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
    chatStore.getState().endStream(detailId);
    await api.abort(detailId);
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
      setConversations((cs) => cs.map((c) => (c.id === updated.id ? updated : c)));
    }
  }

  const onArchive = useCallback(
    async (c: Conversation) => {
      await api.archiveConversation(c.id, !c.archivedAt);
      await refreshList();
      chatStore.getState().drop(c.id);
      if (c.id === activeIdRef.current) {
        setActiveId(null);
      }
    },
    [refreshList, chatStore],
  );

  // --- Human-in-the-loop review (request_review tool → "Needs review") ------

  /** Approve a pending-review task → it leaves "Needs review" for "Done". */
  const onApproveReview = useCallback(
    async (id: string) => {
      try {
        const updated = await api.setReviewState(id, "approved");
        applyReviewedRow(updated);
      } catch (e) {
        console.error(e);
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
        api.setReviewState(id, "none").then(applyReviewedRow).catch(() => {});
      }
    },
    [applyReviewedRow],
  );

  // --- Automations --------------------------------------------------------
  function openNewAutomation() {
    setEditingAutomation(null);
    setAutomationDialogOpen(true);
  }
  function openEditAutomation(a: Automation) {
    setEditingAutomation(a);
    setAutomationDialogOpen(true);
  }
  /** Create or update; the dialog awaits this and surfaces any thrown error. */
  async function onSaveAutomation(input: AutomationInput, id: string | null) {
    const saved = id
      ? await api.updateAutomation(id, input)
      : await api.createAutomation(input);
    setAutomations((as) => mergeAutomation(as, saved));
  }
  async function onToggleAutomation(a: Automation, enabled: boolean) {
    // Optimistically flip only `enabled`, preserving any fresher fields a
    // concurrent automation event may have merged into the row.
    setAutomations((as) =>
      as.map((x) => (x.id === a.id ? { ...x, enabled } : x)),
    );
    try {
      const updated = await api.setAutomationEnabled(a.id, enabled);
      setAutomations((as) => mergeAutomation(as, updated));
    } catch (e) {
      console.error(e);
      // Revert just the flag on the current row — don't clobber newer state.
      setAutomations((as) =>
        as.map((x) => (x.id === a.id ? { ...x, enabled: !enabled } : x)),
      );
    }
  }
  async function onRunAutomation(a: Automation) {
    // Run-now mints a fresh conversation and starts streaming it; jump straight
    // into that chat so the click feels direct (like "View last run"), rather
    // than leaving the user parked on the Automations list waiting for the
    // `automation_fired` event to quietly add a row.
    let conv: Conversation;
    try {
      conv = await api.runAutomationNow(a.id);
    } catch (e) {
      console.error(e);
      return;
    }
    setConversations((cs) => mergeConversation(cs, conv));
    setModelChoice(conv.model);
    setWorkspaceDir(conv.workspaceDir);
    // Seed the prompt bubble so onSelect takes the client-side fast path and
    // doesn't block the jump on a get_messages round-trip while pi is mid-run.
    // Skip if streaming already populated the chat (pi echoes the prompt at the
    // head of the turn), to avoid a stray user bubble after assistant output.
    const existing = chatStore.getState().chats[conv.id];
    if (!existing || existing.messages.length === 0) {
      chatStore.getState().userSent(conv.id, a.prompt, [], []);
    }
    setView("chat");
    onSelect(conv.id);
  }
  async function onDeleteAutomation(a: Automation) {
    await api.deleteAutomation(a.id);
    setAutomations((as) => as.filter((x) => x.id !== a.id));
  }

  return (
    <SidebarProvider
      // Pin the shell to the window with `fixed inset-0` rather than a
      // viewport-height calc. CSS `zoom` (use-zoom) re-bases `svh` inside the
      // zoomed root on modern WebKit, so a `100svh/var(--zoom)` height would
      // double-compensate and drift as you ⌘+/⌘− — fixed insets fill the window
      // at any zoom. `!min-h-0` clears shadcn's `min-h-svh` so the sidebar's
      // `h-full` resolves against the window, not content. No background: the
      // window is a translucent vibrancy shell, so the frost shows in the
      // sidebar + the margins around the content card.
      className="fixed inset-0 !min-h-0"
    >
      <DialogHost />
      <ZoomHud />
      <Onboarding />
      {/* DEV-ONLY eval bridge — no-ops unless NEXT_PUBLIC_CETUS_DEVTEST === "1"
          (gated both here and internally). Always-mounted host. */}
      {process.env.NEXT_PUBLIC_CETUS_DEVTEST === "1" && <TestHook />}
      {/* cmdk's internal store has a race on first render with Turbopack +
          React 19: even though Radix Dialog hides DialogContent when closed,
          CommandPalette's CommandInput still ends up reaching for a null
          context (`o.subscribe` crash). Lazy-mount the palette so it's
          rendered only after the user actually opens it. */}
      {paletteOpen && <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        conversations={conversations}
        activeId={activeId}
        modelChoice={modelChoice}
        onSelectConversation={(id) => {
          setView("chat");
          setPaletteOpen(false);
          onSelect(id);
        }}
        onNewChat={() => {
          setPaletteOpen(false);
          if (view === "board") setNewTaskOpen(true);
          else onNew();
        }}
        onModelChange={(m) => {
          setPaletteOpen(false);
          onModelChange(m);
        }}
        onOpenSettings={() => {
          setPaletteOpen(false);
          setSettingsOpen(true);
        }}
        onViewChange={(v) => {
          setPaletteOpen(false);
          setView(v);
        }}
        onOpenScreenHistory={(q, frame) => {
          setPaletteOpen(false);
          setHistoryQuery(q ?? "");
          setHistoryFrame(frame ?? null);
          setHistoryOpen(true);
        }}
      />}
      <SessionDetailDialog
        conversation={conversations.find((c) => c.id === detailId) ?? null}
        open={detailId !== null}
        onOpenChange={(o) => {
          if (!o) setDetailId(null);
        }}
        onOpenInChat={(id) => {
          setDetailId(null);
          setView("chat");
          onSelect(id);
        }}
        loading={detailLoading}
        modelChoice={detailModelChoice}
        onModelChange={onDetailModelChange}
        workspaceDir={detailWorkspaceDir}
        defaultWorkspace={defaultWorkspace}
        onWorkspaceChange={onDetailWorkspaceChange}
        onSend={onDetailSend}
        onAbort={onDetailAbort}
        focusToken={detailFocusToken}
      />
      <CreateTaskDialog
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        modelChoice={modelChoice}
        onModelChange={onModelChange}
        workspaceDir={workspaceDir}
        defaultWorkspace={defaultWorkspace}
        onWorkspaceChange={onWorkspaceChange}
        onSubmit={onCreateTask}
      />
      <AutomationDialog
        open={automationDialogOpen}
        onOpenChange={setAutomationDialogOpen}
        automation={editingAutomation}
        defaultModel={modelChoice}
        defaultWorkspace={defaultWorkspace}
        onSubmit={onSaveAutomation}
      />
      {settingsEverOpened && (
        <SettingsPage
          open={settingsOpen}
          onClose={closeSettings}
          storedProviders={storedProviders}
          onSaved={() => {
            refreshKeys().catch(console.error);
          }}
          onConversationsChanged={() => {
            refreshList().catch(console.error);
          }}
          onOpenHistory={() => {
            closeSettings();
            setHistoryQuery("");
            setHistoryFrame(null);
            setHistoryOpen(true);
          }}
        />
      )}
      <ScreenHistoryPage
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        initialQuery={historyQuery}
        initialFrame={historyFrame}
      />
      <AppSidebar
        conversations={conversations}
        activeId={activeId}
        defaultWorkspace={defaultWorkspace}
        view={view}
        onViewChange={setView}
        workspaceFilter={boardWorkspaceFilter}
        onWorkspaceFilterChange={setBoardWorkspaceFilter}
        onSelect={onSelectChat}
        onNew={onNewSidebar}
        onArchive={onArchive}
        onOpenSettings={openSettings}
      />
      <SidebarInset className="m-2 flex min-h-0 flex-row overflow-hidden rounded-xl border border-border bg-background shadow-sm">
        <div className="flex min-w-0 flex-1 flex-col">
          <header
            data-tauri-drag-region
            className="flex h-10 items-center justify-end gap-3 px-4 text-xs text-muted-foreground"
          >
            {!piReady && <span className="text-muted-foreground/70">○ connecting…</span>}
            {/* With messages present, the failure surfaces inline at the end of
                the message list (see MessageError). Keep the header copy only as
                a fallback for errors that fire before any message exists
                (e.g. an attachment write failing on the very first send). */}
            {error && !hasMessages && (
              <span className="text-destructive">{error}</span>
            )}

          </header>
          {view === "automations" ? (
            <AutomationsView
              automations={automations}
              defaultWorkspace={defaultWorkspace}
              onNew={openNewAutomation}
              onEdit={openEditAutomation}
              onToggle={onToggleAutomation}
              onRunNow={onRunAutomation}
              onDelete={onDeleteAutomation}
              onOpenConversation={(id) => {
                setView("chat");
                onSelect(id);
              }}
            />
          ) : view === "board" ? (
            <BoardView
              conversations={conversations}
              workspaceFilter={boardWorkspaceFilter}
              defaultWorkspace={defaultWorkspace}
              streamingIds={streamingIds}
              onOpen={onOpenDetail}
              onArchive={onArchive}
              onApproveReview={onApproveReview}
              onRequestChanges={onRequestChanges}
            />
          ) : hasMessages ? (
            <ChatPane
              convId={activeId}
              modelChoice={modelChoice}
              onModelChange={onModelChange}
              workspaceDir={workspaceDir}
              defaultWorkspace={defaultWorkspace}
              onWorkspaceChange={onWorkspaceChange}
              onSend={onSend}
              onAbort={onAbort}
              onRegenerate={retrying ? undefined : onRetry}
              onRetry={onRetry}
              retrying={retrying}
              queued={activeId ? queued[activeId] : undefined}
              onQueue={(text, atts) => {
                if (activeId) enqueueMessage(activeId, text, atts);
              }}
              onSteerQueued={(id) => {
                if (activeId) steerQueued(activeId, id);
              }}
              onRemoveQueued={(id) => {
                if (activeId) removeQueued(activeId, id);
              }}
              ultra={ultraEnabled}
              onUltraToggle={onUltraToggle}
              focusToken={focusToken}
              disabled={!piReady}
            />
          ) : (
            <div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden px-6">
              <GlyphBackdrop />
              <div className="relative z-10 w-full max-w-2xl space-y-6">
                <h1 className="text-center font-serif text-4xl italic tracking-tight text-foreground">
                  What should we work on?
                </h1>
                <Composer
                  variant="hero"
                  focusToken={focusToken}
                  disabled={!piReady}
                  streaming={isStreaming}
                  modelChoice={modelChoice}
                  onModelChange={onModelChange}
                  workspaceDir={workspaceDir}
                  defaultWorkspace={defaultWorkspace}
                  onWorkspaceChange={onWorkspaceChange}
                  onSend={onSend}
                  onAbort={onAbort}
                  ultra={ultraEnabled}
                  onUltraToggle={onUltraToggle}
                />
              </div>
            </div>
          )}
        </div>

      </SidebarInset>
    </SidebarProvider>
  );
}
