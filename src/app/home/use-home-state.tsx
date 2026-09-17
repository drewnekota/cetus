"use client";

import type { RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ComposerAttachment,
  type ComposerRuntimeSelection,
  type QueuedMessage,
} from "@/components/chat/composer";
import { groupByWorkspace } from "@/components/sidebar/app-sidebar";
import type { SidebarView } from "@/components/sidebar/view-toggle";
import { api, type Screenshot } from "@/lib/tauri";
import {
  useChatStore,
  useChatError,
  useIsStreaming,
  useHasArtifacts,
  useHasMessages,
  useActivityIds,
  useStreamingIds,
  loadLastActive,
} from "@/lib/chat-store";
import { useLocale, useTranslation } from "@/lib/i18n";
import { flavorHeadline } from "@/lib/chat-flavor";
import {
  DEFAULT_MODEL_CHOICE,
  type Automation,
  type Conversation,
  type ModelChoice,
  type BackendId,
} from "@/lib/types";
import {
  loadCollapsedWorkspaceDirs,
  loadExpandedWorkspaceDirs,
  persistCollapsedWorkspaceDirs,
  persistExpandedWorkspaceDirs,
  visibleConversationIds,
} from "@/lib/collapsed-workspaces";
import {
  KEYBOARD_SHORTCUTS_EVENT,
  KEYBOARD_SHORTCUTS_STORAGE_KEY,
  readKeyboardShortcuts,
} from "@/lib/keyboard-shortcuts";
import { reconcileTemporaryWorkspaces } from "@/lib/recent-workspaces";
import {
  PersistedAppViewState,
  SIDEBAR_OPEN_KEY,
  WorkspaceDocksByChatState,
  createInitialWorkspaceDocksByChat,
  NEW_CHAT_WORKSPACE_KEY,
  createInitialWorkspaceDocks,
  usePanelPresence,
  APP_VIEW_STATE_KEY,
} from "./home-utils";
import { usePendingRuntime } from "./use-pending-runtime";

export function useHomeState({
  initialViewState,
  autoSortConversations,
  onSend,
  deliverQueued,
}: {
  initialViewState: PersistedAppViewState;
  autoSortConversations: boolean;
  onSend: (
    text: string,
    attachments?: ComposerAttachment[] | undefined,
    runtime?: ComposerRuntimeSelection | undefined,
  ) => Promise<void>;
  deliverQueued: (
    convId: string,
    text: string,
    attachments?: ComposerAttachment[] | undefined,
    runtime?: ComposerRuntimeSelection | undefined,
  ) => Promise<void>;
}) {
  const { t } = useTranslation("chat");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsLoaded, setConversationsLoaded] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(() =>
    initialViewState.view === "chat" ? loadLastActive() : null,
  );
  // A selected conversation can be absent from the in-memory LRU and need an
  // IndexedDB/backend round-trip before its messages exist. Keep that distinct
  // from a genuinely empty/new chat so the pane never flashes the hero between
  // two populated conversations.
  const [loadingChatId, setLoadingChatId] = useState<string | null>(null);
  const [piReady, setPiReady] = useState(false);
  // Store actions are pulled via getState() inside callbacks so we never
  // subscribe page.tsx to chat-store ticks.
  const chatStore = useChatStore;
  const error = useChatError(activeId);
  const isStreaming = useIsStreaming(activeId);
  const hasMessages = useHasMessages(activeId);
  // Aggregated artifacts gallery for the active chat — parity with the board
  // detail dialog's Artifacts button (opens the same ArtifactsDialog).
  const activeHasArtifacts = useHasArtifacts(activeId);
  const [chatArtifactsOpen, setChatArtifactsOpen] = useState(false);
  // Backend serving the active conversation (null for a not-yet-persisted new
  // chat). Drives steer-capability gating for the follow-up queue.
  const activeConvBackend = useMemo<BackendId | null>(
    () =>
      (conversations.find((c) => c.id === activeId)?.backend as
        BackendId | undefined) ?? null,
    [conversations, activeId],
  );
  // Interrupted-run banner: the active conversation's last CLI turn was cut
  // down mid-run (persisted run_state, swept at boot/exit) and nothing has
  // started since. ChatPane additionally hides the banner while streaming.
  const activeConvInterrupted = useMemo(
    () =>
      conversations.find((c) => c.id === activeId)?.runState === "interrupted",
    [conversations, activeId],
  );
  const streamingIds = useStreamingIds();
  const activityIds = useActivityIds();
  const [unreadCompletedIds, setUnreadCompletedIds] = useState<Set<string>>(
    () => new Set(),
  );
  // Mirror of the set, so markUnread can dedupe (and skip the write) without
  // doing I/O inside a setState updater — which React may run twice.
  const unreadIdsRef = useRef<Set<string>>(unreadCompletedIds);
  /** Guards the one-shot hydration in refreshList (which runs on every send). */
  const unreadHydratedRef = useRef(false);
  /** Flip a chat's unread dot and persist it (conversations.unreadAt). The
   *  renderer decides *when* — it sees agent_end, retries, and whether the chat
   *  was on screen — while the row is what survives a restart and what the
   *  auto-archive sweep checks before filing a chat away. */
  const markUnread = useCallback((cid: string, unread: boolean) => {
    if (unreadIdsRef.current.has(cid) === unread) return;
    const next = new Set(unreadIdsRef.current);
    if (unread) next.add(cid);
    else next.delete(cid);
    unreadIdsRef.current = next;
    setUnreadCompletedIds(next);
    api.setConversationUnread(cid, unread).catch(console.error);
  }, []);
  const {
    setModelChoice,
    requestBackendSwitch,
    modelChoice,
    pendingBackend,
    pendingCliModel,
    pendingCliEffort,
    setPendingBackend,
    onPendingTuningChange,
    backendSwitch,
  } = usePendingRuntime({ activeId });
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null);
  const [defaultWorkspace, setDefaultWorkspace] = useState<string>("");
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>([]);
  const [hiddenWorkspaces, setHiddenWorkspaces] = useState<string[]>([]);
  // A hidden workspace can still receive a fresh automation conversation.
  // Surface it for as long as that workspace has active chats, without changing
  // the user's persisted recent/hidden workspace preferences.
  const [temporaryWorkspaces, setTemporaryWorkspaces] = useState<string[]>([]);
  const [storedProviders, setStoredProviders] = useState<string[]>([]);

  // ---- Smart routing (experimental) ---------------------------------------
  // Roster the entry composers hand to the router: recent conversations plus
  // their cached last-reply previews (board card cache — best-effort). Reloaded
  // only when the top-of-list ids actually change, not on every updated_at bump.
  // Once the last active chat in a temporary workspace is archived, remove the
  // empty folder from the sidebar naturally.
  useEffect(() => {
    setTemporaryWorkspaces((dirs) =>
      reconcileTemporaryWorkspaces(dirs, conversations),
    );
  }, [conversations]);
  const [settingsOpen, setSettingsOpen] = useState(
    initialViewState.settingsOpen === true,
  );
  // Latches true on first open so the code-split SettingsPage mounts (and its
  // chunk loads) lazily, then stays mounted for instant reopen.
  const [settingsEverOpened, setSettingsEverOpened] = useState(
    initialViewState.settingsOpen === true,
  );
  useEffect(() => {
    if (settingsOpen) setSettingsEverOpened(true);
  }, [settingsOpen]);
  const [historyOpen, setHistoryOpen] = useState(
    initialViewState.historyOpen === true,
  );
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyFrame, setHistoryFrame] = useState<Screenshot | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** Bumped on every "New chat" click; threaded into Composer so it can pull
   *  focus back even when the hero is already on screen and nothing remounts. */
  const [focusToken, setFocusToken] = useState(0);
  // Random greeting for the landing hero, re-rolled per new chat (focusToken
  // bumps on "New chat") + on language switch. Stays put across keystrokes.
  const { locale } = useLocale();
  const heroHeadline = useMemo(
    () => flavorHeadline(locale),
    [locale, focusToken],
  );
  // Restore the last sidebar view across reloads (⌘R). Lazy initializer (guarded
  // for the static-export prerender, where window is absent) so a reload paints
  // the right page straight away instead of flashing the chat hero first.
  const [view, setView] = useState<SidebarView>(() => {
    if (initialViewState.view) return initialViewState.view;
    if (typeof window === "undefined") return "chat";
    try {
      const v = localStorage.getItem("cetus:lastView");
      if (v === "chat" || v === "board" || v === "automations") return v;
    } catch {}
    return "chat";
  });
  // Collapsed sidebar = focus mode: only the conversation stays. Persisted
  // like the view so a reload keeps the layout you chose.
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      return localStorage.getItem(SIDEBAR_OPEN_KEY) !== "0";
    } catch {}
    return true;
  });
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_OPEN_KEY, sidebarOpen ? "1" : "0");
    } catch {}
  }, [sidebarOpen]);
  // This is shared with the sidebar because folded chat rows are not navigation
  // targets either: archive fallback and keyboard switching must only walk rows
  // the user can currently see.
  const [collapsedWorkspaceDirs, setCollapsedWorkspaceDirs] = useState(
    loadCollapsedWorkspaceDirs,
  );
  const toggleWorkspaceCollapsed = useCallback((dir: string) => {
    setCollapsedWorkspaceDirs((current) => {
      const next = new Set(current);
      if (!next.delete(dir)) next.add(dir);
      persistCollapsedWorkspaceDirs(next);
      return next;
    });
  }, []);
  // Same sharing rationale as collapsed dirs: rows truncated behind a group's
  // "Show more" are not navigation targets either.
  const [expandedWorkspaceDirs, setExpandedWorkspaceDirs] = useState(
    loadExpandedWorkspaceDirs,
  );
  const toggleWorkspaceExpanded = useCallback((dir: string) => {
    setExpandedWorkspaceDirs((current) => {
      const next = new Set(current);
      if (!next.delete(dir)) next.add(dir);
      persistExpandedWorkspaceDirs(next);
      return next;
    });
  }, []);
  const [keyboardShortcuts, setKeyboardShortcuts] = useState(
    readKeyboardShortcuts,
  );
  useEffect(() => {
    const reload = () => setKeyboardShortcuts(readKeyboardShortcuts());
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === KEYBOARD_SHORTCUTS_STORAGE_KEY) reload();
    };
    window.addEventListener(KEYBOARD_SHORTCUTS_EVENT, reload);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(KEYBOARD_SHORTCUTS_EVENT, reload);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("cetus:lastView", view);
    } catch {}
  }, [view]);
  // Browser-style page history for ⌘[ / ⌘]. A "page" is the sidebar view, the
  // active chat within it, plus whether Settings covers it; every change lands
  // on the stack, and applying an entry sets navApplyingRef so the recorder
  // effect below doesn't re-push the state it just restored.
  type NavEntry = {
    view: SidebarView;
    activeId: string | null;
    settings: boolean;
  };
  const currentNavEntry = useCallback(
    (): NavEntry => ({
      view,
      // A chat is only a distinct page inside the chat view; elsewhere the
      // active chat is incidental, so collapse it to null to avoid spurious
      // page switches.
      activeId: view === "chat" ? activeId : null,
      settings: settingsOpen,
    }),
    [view, activeId, settingsOpen],
  );
  const sameNavEntry = (a: NavEntry | null | undefined, b: NavEntry) =>
    !!a &&
    a.view === b.view &&
    a.activeId === b.activeId &&
    a.settings === b.settings;
  // Ctrl+Tab is MRU page switching: it toggles the last complete page, not just
  // the last sidebar view. That makes separate chats and Settings participate.
  const previousPageRef = useRef<NavEntry | null>(null);
  const committedPageRef = useRef<NavEntry>(currentNavEntry());
  useEffect(() => {
    const next = currentNavEntry();
    if (!sameNavEntry(committedPageRef.current, next)) {
      previousPageRef.current = committedPageRef.current;
      committedPageRef.current = next;
    }
  }, [currentNavEntry]);
  const navHistoryRef = useRef<NavEntry[]>([]);
  const navIndexRef = useRef(0);
  const navApplyingRef = useRef(false);
  useEffect(() => {
    if (navApplyingRef.current) {
      navApplyingRef.current = false;
      return;
    }
    const hist = navHistoryRef.current;
    const current = hist[navIndexRef.current];
    const entry = currentNavEntry();
    if (sameNavEntry(current, entry)) return;
    // A new page after going back forks the timeline: drop the forward entries.
    hist.splice(navIndexRef.current + 1);
    hist.push(entry);
    if (hist.length > 100) hist.splice(0, hist.length - 100);
    navIndexRef.current = hist.length - 1;
  }, [currentNavEntry]);
  const applyNavEntry = useCallback((entry: NavEntry) => {
    navApplyingRef.current = true;
    setView(entry.view);
    if (entry.view === "chat") setActiveId(entry.activeId);
    setSettingsOpen(entry.settings);
  }, []);
  const switchToPreviousPage = useCallback(() => {
    const prev = previousPageRef.current;
    if (prev && !sameNavEntry(committedPageRef.current, prev))
      applyNavEntry(prev);
  }, [applyNavEntry]);
  const navigateBack = useCallback(() => {
    if (navIndexRef.current <= 0) return;
    navIndexRef.current -= 1;
    applyNavEntry(navHistoryRef.current[navIndexRef.current]);
  }, [applyNavEntry]);
  const navigateForward = useCallback(() => {
    if (navIndexRef.current >= navHistoryRef.current.length - 1) return;
    navIndexRef.current += 1;
    applyNavEntry(navHistoryRef.current[navIndexRef.current]);
  }, [applyNavEntry]);
  const [workspaceDocksByChat, setWorkspaceDocksByChat] =
    useState<WorkspaceDocksByChatState>(createInitialWorkspaceDocksByChat);
  const workspaceDocksByChatRef =
    useRef<WorkspaceDocksByChatState>(workspaceDocksByChat);
  const workspaceKey = activeId ?? NEW_CHAT_WORKSPACE_KEY;
  const workspaceDocks =
    workspaceDocksByChat[workspaceKey] ?? createInitialWorkspaceDocks();
  const sideWorkspace = workspaceDocks.side;
  const bottomWorkspace = workspaceDocks.bottom;
  const sideWorkspacePresence = usePanelPresence(sideWorkspace.open);
  const bottomWorkspacePresence = usePanelPresence(bottomWorkspace.open);
  const [boardWorkspaceFilter, setBoardWorkspaceFilter] = useState<
    string | null
  >(initialViewState.boardWorkspaceFilter ?? null);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(
    initialViewState.detailId ?? null,
  );
  useEffect(() => {
    try {
      localStorage.setItem(
        APP_VIEW_STATE_KEY,
        JSON.stringify({
          view,
          settingsOpen,
          historyOpen,
          detailId,
          boardWorkspaceFilter,
        } satisfies PersistedAppViewState),
      );
    } catch {}
  }, [view, settingsOpen, historyOpen, detailId, boardWorkspaceFilter]);
  const [detailModelChoice, setDetailModelChoice] =
    useState<ModelChoice>(DEFAULT_MODEL_CHOICE);
  const [detailWorkspaceDir, setDetailWorkspaceDir] = useState<string | null>(
    null,
  );
  const [detailFocusToken, setDetailFocusToken] = useState(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [automationDialogOpen, setAutomationDialogOpen] = useState(false);
  const [editingAutomation, setEditingAutomation] = useState<Automation | null>(
    null,
  );
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
  /** Synchronous guards for optimistic archive mutations. The row disappears
   *  before React commits the next render, so a rapid shortcut repeat could
   *  otherwise dispatch the same backend mutation twice. */
  const archivingIdsRef = useRef(new Set<string>());
  const archivingWorkspacesRef = useRef(new Set<string>());

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
  workspaceDocksByChatRef.current = workspaceDocksByChat;
  // Visible chat ids in the sidebar's visual order (workspace groups flattened),
  // mirrored into a ref so archive fallback and the identity-stable switchChat
  // handler both skip rows hidden by a folded workspace.
  const orderedChatIds = useMemo(() => {
    const groups = groupByWorkspace(
      conversations,
      [...recentWorkspaces, ...temporaryWorkspaces],
      hiddenWorkspaces.filter((dir) => !temporaryWorkspaces.includes(dir)),
      defaultWorkspace,
      autoSortConversations,
    );
    return visibleConversationIds(
      groups,
      collapsedWorkspaceDirs,
      expandedWorkspaceDirs,
    );
  }, [
    conversations,
    recentWorkspaces,
    hiddenWorkspaces,
    temporaryWorkspaces,
    defaultWorkspace,
    autoSortConversations,
    collapsedWorkspaceDirs,
    expandedWorkspaceDirs,
  ]);
  const orderedChatIdsRef = useRef<string[]>([]);
  orderedChatIdsRef.current = orderedChatIds;
  const selectChatRef = useRef<(id: string) => void>(() => {});

  // Mirror the live queue + send fn so the flush effect (deps: streaming sig
  // only) never reads stale closures. onSend is a hoisted function declaration.
  const queuedRef = useRef(queued);
  queuedRef.current = queued;
  const onSendRef = useRef<typeof onSend>(
    undefined as unknown as typeof onSend,
  );
  onSendRef.current = onSend; // onSend is hoisted (function declaration)
  const deliverQueuedRef = useRef<typeof deliverQueued>(
    undefined as unknown as typeof deliverQueued,
  );
  deliverQueuedRef.current = deliverQueued; // hoisted function declaration

  // Comma-joined ids of every active conversation (streaming, awaiting the
  // first event, or compacting). Object.is over the string means this only
  // re-renders when that set changes, and the flush effect below re-runs on
  // exactly those boundaries.
  const streamingSig = useChatStore((s) =>
    Array.from(s.streamingIds).sort().join(","),
  );

  // Deliver the next queued follow-up whenever ANY conversation's run ends —
  // active chat, detail dialog, or a background run the user has navigated away
  // from. Keying off the store (not the active/detail conversation) is what lets
  // a queue survive a chat switch: the old per-surface effects only observed the
  // mounted conversation, so a run that finished in the background stranded its
  // queue. One flush per true→false transition → items go out sequentially, each
  // waiting for the turn it just started to finish.
  const prevStreamingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const current = new Set(
      streamingSig ? streamingSig.split(",").filter(Boolean) : [],
    );
    const prev = prevStreamingRef.current;
    prevStreamingRef.current = current;
    for (const id of prev) {
      if (current.has(id)) continue; // still running — not a run boundary
      const q = queuedRef.current[id];
      if (!q || q.length === 0) continue;
      const [next, ...rest] = q;
      setQueued((cur) => ({ ...cur, [id]: rest }));
      void deliverQueuedRef.current(
        id,
        next.text,
        next.attachments,
        next.runtime,
      );
    }
  }, [streamingSig]);
  return {
    conversations,
    detailId,
    chatStore,
    setQueued,
    queuedRef,
    conversationsLoaded,
    conversationsRef,
    activeIdRef,
    setSettingsOpen,
    setConversations,
    setStoredProviders,
    setDefaultWorkspace,
    setRecentWorkspaces,
    setHiddenWorkspaces,
    setPiReady,
    viewRef,
    runStatusRef,
    markUnread,
    t,
    setAutomations,
    setTemporaryWorkspaces,
    unreadHydratedRef,
    unreadIdsRef,
    setUnreadCompletedIds,
    setConversationsLoaded,
    setHistoryQuery,
    setHistoryFrame,
    setHistoryOpen,
    archivingIdsRef,
    orderedChatIdsRef,
    selectChatRef,
    pendingSelectRef,
    setView,
    setWorkspaceDir,
    setActiveId,
    setFocusToken,
    setDetailId,
    activeId,
    setLoadingChatId,
    setModelChoice,
    view,
    keyboardShortcuts,
    setPaletteOpen,
    automationDialogOpen,
    newTaskOpen,
    navigateBack,
    navigateForward,
    switchToPreviousPage,
    settingsOpen,
    historyOpen,
    sideWorkspace,
    setSidebarOpen,
    boardWorkspaceFilter,
    defaultWorkspace,
    setNewTaskOpen,
    requestBackendSwitch,
    setWorkspaceDocksByChat,
    workspaceDocksByChatRef,
    workspaceDocks,
    sideWorkspacePresence,
    bottomWorkspacePresence,
    workspaceDir,
    onSendRef,
    modelChoice,
    retryingRef,
    setRetrying,
    pendingBackend,
    pendingCliModel,
    pendingCliEffort,
    setDetailModelChoice,
    setDetailWorkspaceDir,
    setDetailFocusToken,
    setDetailLoading,
    archivingWorkspacesRef,
    setBoardWorkspaceFilter,
    setEditingAutomation,
    setAutomationDialogOpen,
    sidebarOpen,
    paletteOpen,
    detailLoading,
    detailModelChoice,
    detailWorkspaceDir,
    detailFocusToken,
    retrying,
    queued,
    chatArtifactsOpen,
    activeHasArtifacts,
    setChatArtifactsOpen,
    setPendingBackend,
    onPendingTuningChange,
    editingAutomation,
    settingsEverOpened,
    storedProviders,
    historyQuery,
    historyFrame,
    activityIds,
    unreadCompletedIds,
    recentWorkspaces,
    temporaryWorkspaces,
    hiddenWorkspaces,
    collapsedWorkspaceDirs,
    expandedWorkspaceDirs,
    toggleWorkspaceCollapsed,
    toggleWorkspaceExpanded,
    piReady,
    error,
    hasMessages,
    automations,
    loadingChatId,
    activeConvBackend,
    activeConvInterrupted,
    focusToken,
    backendSwitch,
    heroHeadline,
    isStreaming,
  };
}
