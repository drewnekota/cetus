"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ComposerAttachment,
  type ComposerRuntimeSelection,
} from "@/components/chat/composer";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { api, onUpdateReady } from "@/lib/tauri";
import {
  installChatPersistence,
  loadCachedMessages,
  loadLastActive,
  pruneMessageCache,
  saveLastActive,
} from "@/lib/chat-store";
import { useZoom } from "@/hooks/use-zoom";
import { refreshPermission } from "@/lib/notifications";
import {
  INTERRUPTED_RESUME_PROMPT,
  renderStartsMidConversation,
} from "@/lib/continuation-prompts";
import { installWebviewHealthMonitor } from "@/lib/webview-health";
import {
  type Automation,
  type AutomationInput,
  type Conversation,
  type ModelChoice,
  type QuickLaunchPayload,
  type BackendId,
} from "@/lib/types";
import { OPEN_RUNTIME_SETTINGS_EVENT } from "@/lib/runtime-settings";
import { useRuntimeSlots } from "@/components/chat/backend-picker";
import { saveModelChoice } from "@/lib/model-choice";
import { useConversationAutoSort } from "@/lib/conversation-order";
import { nextConversationIdInWorkspace } from "@/lib/collapsed-workspaces";
import {
  HIDDEN_WORKSPACES_STORAGE_KEY,
  loadHiddenWorkspaces,
  loadRecentWorkspaces,
  RECENT_WORKSPACES_CHANGED,
  RECENT_WORKSPACES_STORAGE_KEY,
  reconcileTemporaryWorkspaces,
} from "@/lib/recent-workspaces";
import {
  PersistedAppViewState,
  readAppViewState,
  mergeConversation,
  BrowserControlEvent,
  BrowserAnnotationEvent,
  browserAnnotationMessage,
  Outgoing,
  prepareOutgoing,
  mergeAutomation,
} from "./home/home-utils";
import { useAppEvents } from "./home/use-app-events";
import { useHomeKeyboardShortcuts } from "./home/use-home-keyboard-shortcuts";
import { useWorkspaceActions } from "./home/use-workspace-actions";
import { useMessageActions } from "./home/use-message-actions";
import { useQuickLaunch } from "./home/use-quick-launch";
import { useDetailActions } from "./home/use-detail-actions";
import { useConversationActions } from "./home/use-conversation-actions";
import { renderHome } from "./home/home-view";
import { useHomeState } from "./home/use-home-state";
import { useConversationSelection } from "./home/use-conversation-selection";

export default function Home() {
  useZoom();
  useEffect(() => installWebviewHealthMonitor(), []);
  const autoSortConversations = useConversationAutoSort();
  const initialViewStateRef = useRef<PersistedAppViewState | null>(null);
  if (initialViewStateRef.current === null) {
    initialViewStateRef.current = readAppViewState();
  }
  const {
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
  } = useHomeState({
    initialViewState: initialViewStateRef.current,
    autoSortConversations,
    onSend,
    deliverQueued,
  });

  // Backend serving the detail-dialog conversation, for steer-capability gating.
  const detailConvBackend = useMemo<BackendId | null>(
    () =>
      (conversations.find((c) => c.id === detailId)?.backend as
        BackendId | undefined) ?? null,
    [conversations, detailId],
  );

  /** Park a message in the follow-up queue (typed while the agent is mid-run). */
  function enqueueMessage(
    convId: string,
    text: string,
    attachments: ComposerAttachment[],
    runtime: ComposerRuntimeSelection | undefined,
    beforeIds: string[] = [],
  ) {
    // The composer's `streaming` prop is a rendered snapshot. A completion can
    // settle the store after that render but just before Enter reaches here;
    // queueing from the stale prop would miss the already-fired active→idle
    // boundary and strand the follow-up forever. Re-check the synchronous store
    // at the hand-off point and send immediately when the conversation is idle.
    if (!chatStore.getState().streamingIds.has(convId)) {
      void deliverQueued(convId, text, attachments, runtime);
      return;
    }
    const id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `q-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    setQueued((q) => {
      const current = q[convId] ?? [];
      const beforeIndex = current.findIndex((item) =>
        beforeIds.includes(item.id),
      );
      const insertAt = beforeIndex < 0 ? current.length : beforeIndex;
      return {
        ...q,
        [convId]: [
          ...current.slice(0, insertAt),
          { id, text, attachments, runtime },
          ...current.slice(insertAt),
        ],
      };
    });
  }

  function removeQueued(convId: string, id: string) {
    setQueued((q) => ({
      ...q,
      [convId]: (q[convId] ?? []).filter((m) => m.id !== id),
    }));
  }

  /** Promote a queued message to a steer: deliver it now. pi/claude-code inject
   *  into the current run; codex interrupts the run and resumes the thread. */
  function steerQueued(convId: string, id: string) {
    const item = (queuedRef.current[convId] ?? []).find((m) => m.id === id);
    if (!item) return;
    removeQueued(convId, id);
    void onSend(item.text, item.attachments, item.runtime);
  }

  // Install the IDB write-through cache exactly once.
  useEffect(() => {
    installChatPersistence();
  }, []);

  // Prune cache records for conversations that no longer exist or were
  // archived — the cache is a render accelerator, but left unpruned it grows
  // by hundreds of MB and startup hydration against it froze the app. Runs
  // once per session, well off the startup path; ids are read from the ref at
  // fire time so conversations created in the meantime are kept.
  useEffect(() => {
    if (!conversationsLoaded) return;
    const timer = window.setTimeout(() => {
      const keep = conversationsRef.current.map((c) => c.id);
      if (activeIdRef.current) keep.push(activeIdRef.current);
      void pruneMessageCache(keep);
    }, 15_000);
    return () => window.clearTimeout(timer);
  }, [conversationsLoaded]);

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

  useEffect(() => {
    const refresh = () => {
      setRecentWorkspaces(loadRecentWorkspaces());
      setHiddenWorkspaces(loadHiddenWorkspaces());
    };
    refresh();
    const onStorage = (e: StorageEvent) => {
      if (
        e.key === RECENT_WORKSPACES_STORAGE_KEY ||
        e.key === HIDDEN_WORKSPACES_STORAGE_KEY ||
        e.key === null
      ) {
        refresh();
      }
    };
    window.addEventListener(RECENT_WORKSPACES_CHANGED, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(RECENT_WORKSPACES_CHANGED, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  useAppEvents({
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
  });

  const refreshList = useCallback(async () => {
    const list = await api.listConversations(false);
    // Reconcile against current rows instead of swapping in all-new objects:
    // every rendered field bumps updated_at server-side, so id+updatedAt equal
    // → the old object is still accurate and keeping its reference preserves
    // the memo() on each sidebar row / board card. Without this, the trailing
    // refresh after every send/archive re-rendered the entire list for rows
    // that hadn't changed.
    setConversations((prev) => {
      const byId = new Map(prev.map((c) => [c.id, c]));
      let identical = prev.length === list.length;
      const next = list.map((c, i) => {
        const old = byId.get(c.id);
        const keep = old && old.updatedAt === c.updatedAt ? old : c;
        if (identical && keep !== prev[i]) identical = false;
        return keep;
      });
      return identical ? prev : next;
    });
    // Rebuild ephemeral automation workspace visibility from persisted rows.
    // This also recovers chats restored before the restore callback learned to
    // surface their workspace explicitly.
    setTemporaryWorkspaces((dirs) => reconcileTemporaryWorkspaces(dirs, list));
    // Seed the unread dots from the persisted rows, once. Later refreshes are
    // not a source of truth: they race in-flight markUnread writes and would
    // resurrect a dot the user just cleared by opening the chat.
    if (!unreadHydratedRef.current) {
      unreadHydratedRef.current = true;
      const unread = new Set(
        list.filter((c) => c.unreadAt != null).map((c) => c.id),
      );
      if (unread.size) {
        unreadIdsRef.current = unread;
        setUnreadCompletedIds(unread);
        // Whatever is on screen right now has been read by definition. The
        // clear for it may have already run against a row this fetch had
        // in flight, so re-assert it instead of painting a stale dot.
        if (viewRef.current === "chat" && activeIdRef.current) {
          markUnread(activeIdRef.current, false);
        }
      }
    }
    setConversationsLoaded(true);
    return list;
  }, [markUnread]);

  // Read through a ref so reordering runtimes in Settings doesn't re-register
  // the (large) global keydown handler.
  const runtimeSlots = useRuntimeSlots();
  const runtimeSlotsRef = useRef(runtimeSlots);
  runtimeSlotsRef.current = runtimeSlots;

  // Runtime picker footer opens the dedicated Runtime settings page. This is a
  // DOM event because the picker and settings page live in the same renderer.
  useEffect(() => {
    const openRuntimeSettings = () => setSettingsOpen(true);
    window.addEventListener(OPEN_RUNTIME_SETTINGS_EVENT, openRuntimeSettings);
    return () =>
      window.removeEventListener(
        OPEN_RUNTIME_SETTINGS_EVENT,
        openRuntimeSettings,
      );
  }, []);

  // Identity-stable SettingsPage props — the panel stays mounted after first
  // open and is memoized, so unstable inline callbacks here would defeat that.
  const onSettingsSaved = useCallback(() => {
    refreshKeys().catch(console.error);
  }, [refreshKeys]);
  const onSettingsConversationsChanged = useCallback(
    (restored?: Conversation) => {
      if (restored) {
        // Automation chats can belong to a workspace the user deliberately
        // removed from the persistent sidebar. Their initial fire surfaces that
        // workspace temporarily; restoring the last archived chat must do the
        // same or the active row is immediately filtered back out.
        setConversations((cs) => mergeConversation(cs, restored));
        setTemporaryWorkspaces((dirs) =>
          dirs.includes(restored.workspaceDir)
            ? dirs
            : [...dirs, restored.workspaceDir],
        );
        return;
      }
      refreshList().catch(console.error);
    },
    [refreshList],
  );
  const openHistoryFromSettings = useCallback(() => {
    closeSettings();
    setHistoryQuery("");
    setHistoryFrame(null);
    setHistoryOpen(true);
  }, [closeSettings]);

  const archiveConversation = useCallback(
    async (c: Conversation) => {
      if (archivingIdsRef.current.has(c.id)) return;
      archivingIdsRef.current.add(c.id);

      const archiving = !c.archivedAt;
      const isActive = c.id === activeIdRef.current;
      const ids = orderedChatIdsRef.current;
      const stateIndex = conversationsRef.current.findIndex(
        (x) => x.id === c.id,
      );
      const nextId = nextConversationIdInWorkspace(
        ids,
        conversationsRef.current,
        c.id,
      );

      // Archiving is local, reversible, and overwhelmingly likely to succeed:
      // remove the row and navigate immediately instead of waiting for process
      // shutdown / Codex inventory sync. Keep the chat cache until the backend
      // confirms so a failed mutation can be restored without reloading it.
      if (archiving) {
        setConversations((cs) => cs.filter((x) => x.id !== c.id));
        if (isActive && nextId) {
          selectChatRef.current(nextId);
        } else if (isActive) {
          // The archived chat was the only visible row in this workspace.
          // Start a fresh chat there instead of crossing into another folder.
          pendingSelectRef.current = null;
          activeIdRef.current = null;
          setView("chat");
          setWorkspaceDir(c.workspaceDir);
          saveLastActive(null);
          setActiveId(null);
          setFocusToken((t) => t + 1);
        }
      }

      try {
        const updated = await api.archiveConversation(c.id, archiving);
        if (archiving) {
          chatStore.getState().drop(c.id);
        } else {
          setConversations((cs) => mergeConversation(cs, updated));
        }
      } catch (error) {
        if (archiving) {
          // Roll back only the missing row. Do not force navigation back to it:
          // the user may already have moved elsewhere while the request ran.
          setConversations((cs) => {
            if (cs.some((x) => x.id === c.id)) return cs;
            const insertionIndex = Math.min(Math.max(stateIndex, 0), cs.length);
            return [
              ...cs.slice(0, insertionIndex),
              c,
              ...cs.slice(insertionIndex),
            ];
          });
        }
        throw error;
      } finally {
        archivingIdsRef.current.delete(c.id);
      }
    },
    [chatStore],
  );

  useEffect(() => {
    refreshList().catch(console.error);
  }, [refreshList]);

  useEffect(() => {
    if (!detailId) return;
    if (!conversationsLoaded) return;
    if (conversations.some((c) => c.id === detailId)) return;
    setDetailId(null);
  }, [conversations, conversationsLoaded, detailId]);

  // The persisted/optimistic active id can outlive its conversation (for
  // example when the last chat is deleted in another window, or a selection
  // loses a race with a list refresh). Once the authoritative list has loaded,
  // never leave that orphan id driving the cold-conversation skeleton.
  useEffect(() => {
    if (!conversationsLoaded || !activeId) return;
    if (conversations.some((c) => c.id === activeId)) return;
    pendingSelectRef.current = null;
    activeIdRef.current = null;
    saveLastActive(null);
    setLoadingChatId(null);
    setActiveId(null);
  }, [activeId, conversations, conversationsLoaded]);

  // Auto-resume sweep: once the authoritative list is in, every conversation
  // whose last run was cut down mid-turn (quit / update restart / crash — the
  // boot sweep marked it "interrupted") picks itself back up. The claim is a
  // one-shot per interruption, persisted on the row: a run that gets cut down
  // again before settling loses the claim and falls back to the manual Resume
  // banner, so a run that crashes the app can't restart itself forever.
  const autoResumeSweptRef = useRef(false);
  useEffect(() => {
    if (!conversationsLoaded || autoResumeSweptRef.current) return;
    autoResumeSweptRef.current = true;
    for (const c of conversationsRef.current) {
      if (c.runState !== "interrupted") continue;
      const id = c.id;
      api
        .claimAutoResume(id)
        .then(async (claimed) => {
          if (!claimed) return;
          setLocalRunState(id, "running");
          chatStore.getState().ensure(id);
          // Seeding the resume prompt into an empty store entry would strand
          // the transcript: every open path treats "has live messages" as
          // authoritative and skips cache hydration, and the write-through
          // persister would then overwrite the IDB cache with just this tail.
          // Hydrate the cached render first so the prompt appends to history.
          if ((chatStore.getState().chats[id]?.messages.length ?? 0) === 0) {
            const cached = await loadCachedMessages(id);
            const store = chatStore.getState();
            if (
              (store.chats[id]?.messages.length ?? 0) === 0 &&
              cached &&
              cached.length > 0
            ) {
              store.hydrate(id, cached);
            }
          }
          chatStore.getState().userSent(id, INTERRUPTED_RESUME_PROMPT);
          return api.sendPrompt(id, INTERRUPTED_RESUME_PROMPT);
        })
        .catch(console.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationsLoaded]);

  const refreshAutomations = useCallback(async () => {
    const list = await api.listAutomations();
    setAutomations(list);
    return list;
  }, []);

  useEffect(() => {
    refreshAutomations().catch(console.error);
  }, [refreshAutomations]);

  // Restore the last active chat on cold start / ⌘R. Flip activeId
  // synchronously so a reload on a chat stays on that chat even when the IDB
  // render cache is empty; the cache and backend history fill in afterward.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const lastId = loadLastActive();
      if (!lastId) return;
      if (viewRef.current !== "chat") return;
      pendingSelectRef.current = lastId;
      const isStale = () => pendingSelectRef.current !== lastId;
      setActiveId(lastId);
      const cached = await loadCachedMessages(lastId);
      if (cancelled) return;
      const row = conversationsRef.current.find((c) => c.id === lastId);
      if (row) {
        setModelChoice(row.model);
        setWorkspaceDir(row.workspaceDir);
      }
      // The auto-resume sweep may have seeded this conversation (resume prompt
      // + streaming turn) while the cache read was in flight. It hydrates the
      // cache itself before seeding, so hydrating here would only clobber the
      // live rows.
      if ((chatStore.getState().chats[lastId]?.messages.length ?? 0) > 0)
        return;
      // "Unfaithful" covers both legacy automation renders that dropped the
      // user prompt entirely and caches that a pre-fix auto-resume sweep
      // overwrote with just the resume-prompt tail — both are repaired from
      // pi history below.
      let cachedUnfaithful = false;
      if (cached && cached.length > 0) {
        chatStore.getState().hydrate(lastId, cached);
        cachedUnfaithful =
          !cached.some((m) => m.role === "user") ||
          renderStartsMidConversation(cached);
      }
      // A reload does not stop a running pi; it only remounts this webview.
      // During a turn, get_messages cannot reply until the run completes, so
      // calling switchConversation here can time out and falsely kick the UI
      // back to a new chat. If IDB has a faithful render, keep it and let the
      // existing app-event stream continue updating this conversation.
      if (cached && cached.length > 0 && !cachedUnfaithful) return;
      // Attach pi and pull the canonical conversation row for model/workspace.
      // We deliberately DON'T `reset` from pi's history when the cache is
      // faithful: that history is lossy for image turns, so IDB is the better
      // render. If there is no cache, or a legacy cache dropped the user prompt,
      // fall back to pi history.
      api
        .switchConversation(lastId)
        .then(({ conversation, messages }) => {
          if (cancelled || isStale()) return;
          setModelChoice(conversation.model);
          setWorkspaceDir(conversation.workspaceDir);
          if (
            (!cached || cached.length === 0 || cachedUnfaithful) &&
            messages?.some((m) => m.role === "user")
          ) {
            chatStore.getState().reset(lastId, messages);
          }
        })
        .catch((e) => {
          console.error("restore last active failed", lastId, e);
          if (!cancelled && !isStale() && !cached?.length) setActiveId(null);
        });
    })();
    return () => {
      cancelled = true;
    };
  }, [chatStore]);

  // Persist last-active id whenever it changes, so the *next* cold start
  // knows what to hydrate.
  useEffect(() => {
    if (activeId) saveLastActive(activeId);
  }, [activeId]);

  // Tell the backend which conversation is actually visible in the chat pane.
  // Auto-archive uses this to avoid removing a stale-but-open chat while the
  // user is reading it. Other surfaces clear the marker so old chats can still
  // archive once they are no longer foregrounded.
  useEffect(() => {
    api
      .setActiveConversation(view === "chat" ? activeId : null)
      .catch(console.error);
  }, [activeId, view]);

  useEffect(() => {
    if (view !== "chat" || !activeId) return;
    markUnread(activeId, false);
  }, [activeId, view, markUnread]);
  useHomeKeyboardShortcuts({
    keyboardShortcuts,
    setPaletteOpen,
    automationDialogOpen,
    newTaskOpen,
    detailId,
    navigateBack,
    navigateForward,
    switchToPreviousPage,
    settingsOpen,
    view,
    historyOpen,
    sideWorkspace,
    switchWorkspaceTab: (...args) => switchWorkspaceTab(...args),
    switchChat: (...args) => switchChat(...args),
    orderedChatIdsRef,
    onSelectChat: (...args) => onSelectChat(...args),
    setSidebarOpen,
    toggleSideWorkspacePanel: (...args) => toggleSideWorkspacePanel(...args),
    toggleTerminalPanel: (...args) => toggleTerminalPanel(...args),
    openWorkspaceTab: (...args) => openWorkspaceTab(...args),
    closeWorkspaceTab: (...args) => closeWorkspaceTab(...args),
    boardWorkspaceFilter,
    defaultWorkspace,
    setWorkspaceDir,
    setNewTaskOpen,
    onNew,
    conversationsRef,
    activeIdRef,
    archiveConversation,
    setSettingsOpen,
    runtimeSlotsRef,
    requestBackendSwitch,
    setView,
  });
  const {
    switchWorkspaceTab,
    toggleSideWorkspacePanel,
    toggleTerminalPanel,
    openWorkspaceTab,
    closeWorkspaceTab,
    openVisibleBrowser,
    openTerminalWithCommand,
    openWorkspacePanelLayout,
    renderWorkspaceDock,
  } = useWorkspaceActions({
    t,
    activeIdRef,
    setWorkspaceDocksByChat,
    workspaceDocksByChatRef,
    workspaceDocks,
    sideWorkspacePresence,
    bottomWorkspacePresence,
    workspaceDir,
    defaultWorkspace,
    onSend,
    setView,
  });

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<BrowserControlEvent>("browser-control-request", (e) => {
      const payload = e.payload;
      if (payload?.op !== "open" || !payload.url) return;
      openVisibleBrowser(payload.url, payload.conversationId);
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // openVisibleBrowser reads live tab state through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** "New chat" only resets the local view to the hero — the backend
   *  conversation row is created lazily on the first send. This way clicking
   *  New chat multiple times never spawns orphan Untitled rows in the
   *  sidebar. Focus is yanked back to the textarea on every click. */
  function onNew(nextWorkspaceDir?: string) {
    // "New chat" is a conversations action — land on the chat hero even when
    // triggered from the Automations destination.
    setView("chat");
    if (nextWorkspaceDir) {
      setWorkspaceDir(nextWorkspaceDir);
    }
    // Invalidate a cold selection/restore before its async cache or backend
    // work can finish on top of the new-chat hero.
    pendingSelectRef.current = null;
    activeIdRef.current = null;
    saveLastActive(null);
    setLoadingChatId(null);
    setActiveId(null);
    setFocusToken((t) => t + 1);
  }
  const { onSelect } = useConversationSelection({
    activeIdRef,
    pendingSelectRef,
    setLoadingChatId,
    chatStore,
    setActiveId,
    conversationsRef,
    setModelChoice,
    setWorkspaceDir,
  });

  // Identity-stable handlers handed to the memoized AppSidebar / BoardView /
  // ConversationRow / Card. They read the live view via viewRef so none of them
  // need a `view` dependency that would break memoization on every view switch.
  const onSelectChat = useCallback(
    (id: string) => {
      markUnread(id, false);
      setView("chat");
      onSelect(id);
    },
    [onSelect, markUnread],
  );
  selectChatRef.current = onSelectChat;
  const switchChat = useCallback(
    (direction: 1 | -1) => {
      // Walk the sidebar's visual order (grouped by workspace), not the raw
      // recency-sorted list — otherwise ⌥⌘↑/↓ jumps across folders in an order
      // the user can't see.
      const ids = orderedChatIdsRef.current;
      if (ids.length === 0) return;
      const activeIndex = ids.indexOf(activeIdRef.current ?? "");
      const currentIndex =
        activeIndex >= 0 ? activeIndex : direction > 0 ? -1 : 0;
      const nextIndex = (currentIndex + direction + ids.length) % ids.length;
      onSelectChat(ids[nextIndex]);
    },
    [onSelectChat],
  );
  const onNewSidebar = useCallback(
    (nextWorkspaceDir?: string) => {
      const taskWorkspace =
        viewRef.current === "board" &&
        nextWorkspaceDir &&
        nextWorkspaceDir !== defaultWorkspace
          ? nextWorkspaceDir
          : null;
      if (taskWorkspace) {
        setWorkspaceDir(taskWorkspace);
        setNewTaskOpen(true);
      } else {
        onNew(nextWorkspaceDir || defaultWorkspace || undefined);
      }
    },
    [defaultWorkspace],
  );

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

  // Browser WebView annotations are emitted by a separate top-level window.
  // Route them through the same send path as normal user feedback so the active
  // conversation receives URL + selected element context.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<BrowserAnnotationEvent>("browser-annotation", async (e) => {
      const payload = e.payload;
      if (!payload?.url || !payload.note) return;
      setView("chat");
      await onSendRef.current(browserAnnotationMessage(payload));
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // A downloaded-but-not-yet-applied update. Set when the backend reports the
  // swap is on disk (silent auto-install, or a manual install); drives the
  // sidebar's persistent "Restart to update" button.
  const [updateReadyVersion, setUpdateReadyVersion] = useState<string | null>(
    null,
  );
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    api
      .pendingUpdateVersion()
      .then((version) => {
        if (!cancelled && version) {
          setUpdateReadyVersion(version);
        }
      })
      .catch(() => {});
    onUpdateReady((u) => {
      setUpdateReadyVersion(u.version);
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
  const onRestartToUpdate = useCallback(() => {
    api.relaunchApp().catch(console.error);
  }, []);

  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const onOpenDetail = useCallback((id: string) => setDetailId(id), []);

  async function onModelChange(next: ModelChoice) {
    // An explicit pick is what the sticky new-chat choice (and the quick
    // launcher) should follow; conversation switches deliberately don't save.
    setModelChoice(next);
    saveModelChoice(next);
    if (activeId) {
      api.setModelChoice(activeId, next).catch(console.error);
    }
  }

  async function onWorkspaceChange(dir: string) {
    setWorkspaceDir(dir);
    if (activeId) {
      const updated = await api.setWorkspace(activeId, dir);
      setConversations((cs) =>
        cs.map((c) => (c.id === updated.id ? updated : c)),
      );
    }
  }
  const useMessageActionsResult = useMessageActions({
    conversationsRef,
    chatStore,
    setConversations,
    activeId,
    workspaceDir,
    setActiveId,
    setWorkspaceDir,
    modelChoice,
    setFocusToken,
    maybeClearReview: (...args) => maybeClearReview(...args),
    refreshList,
    openTerminalWithCommand,
    setQueued,
    retryingRef,
    setRetrying,
  });
  function applyRuntimeSelection(
    ...args: Parameters<typeof useMessageActionsResult.applyRuntimeSelection>
  ) {
    return useMessageActionsResult.applyRuntimeSelection(...args);
  }
  function maybeRunCodexCommand(
    ...args: Parameters<typeof useMessageActionsResult.maybeRunCodexCommand>
  ) {
    return useMessageActionsResult.maybeRunCodexCommand(...args);
  }
  function onSend(...args: Parameters<typeof useMessageActionsResult.onSend>) {
    return useMessageActionsResult.onSend(...args);
  }
  function onBash(...args: Parameters<typeof useMessageActionsResult.onBash>) {
    return useMessageActionsResult.onBash(...args);
  }
  function isCliConv(
    ...args: Parameters<typeof useMessageActionsResult.isCliConv>
  ) {
    return useMessageActionsResult.isCliConv(...args);
  }
  function onAbort(
    ...args: Parameters<typeof useMessageActionsResult.onAbort>
  ) {
    return useMessageActionsResult.onAbort(...args);
  }
  function setLocalRunState(
    ...args: Parameters<typeof useMessageActionsResult.setLocalRunState>
  ) {
    return useMessageActionsResult.setLocalRunState(...args);
  }
  function onResumeInterrupted(
    ...args: Parameters<typeof useMessageActionsResult.onResumeInterrupted>
  ) {
    return useMessageActionsResult.onResumeInterrupted(...args);
  }
  function onDismissInterrupted(
    ...args: Parameters<typeof useMessageActionsResult.onDismissInterrupted>
  ) {
    return useMessageActionsResult.onDismissInterrupted(...args);
  }
  function onRetry(
    ...args: Parameters<typeof useMessageActionsResult.onRetry>
  ) {
    return useMessageActionsResult.onRetry(...args);
  }
  function retryConversation(
    ...args: Parameters<typeof useMessageActionsResult.retryConversation>
  ) {
    return useMessageActionsResult.retryConversation(...args);
  }
  const useQuickLaunchResult = useQuickLaunch({
    setView,
    setModelChoice,
    activeId,
    conversations,
    onSelect,
    setConversations,
    setActiveId,
    setWorkspaceDir,
    maybeClearReview: (...args) => maybeClearReview(...args),
    chatStore,
    setFocusToken,
    refreshList,
  });
  function quickLaunch(
    ...args: Parameters<typeof useQuickLaunchResult.quickLaunch>
  ) {
    return useQuickLaunchResult.quickLaunch(...args);
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
  async function onCreateTask(text: string, attachments: ComposerAttachment[]) {
    const c = await api.newConversation(workspaceDir ?? undefined);
    const id = c.id;
    // Runtime chosen in the dialog — the shared pending state (same one the chat
    // hero + quick launcher use). Applied before the first prompt goes out so it
    // already routes through Claude Code / Codex.
    if (pendingBackend !== "pi") {
      try {
        await api.setConversationBackend(id, pendingBackend);
        if (pendingCliModel || pendingCliEffort) {
          await api.setConversationCliModel(
            id,
            pendingCliModel,
            pendingCliEffort,
          );
        }
      } catch (e) {
        console.error("[create-task] set backend failed", e);
      }
    }
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
      let cachedUnfaithful = false;
      if (cached && cached.length > 0) {
        chatStore.getState().hydrate(id, cached);
        cacheHit = true;
        cachedUnfaithful =
          !cached.some((m) => m.role === "user") ||
          renderStartsMidConversation(cached);
      }
      if (cacheHit && !cachedUnfaithful) {
        setDetailLoading(false);
        return;
      }
      try {
        const { messages } = await api.switchConversation(id);
        if (cancelled) return;
        // Keep the faithful cache render if we had one; pi history is the
        // lossy fallback (see onSelect / cold-start hydration). Exceptions
        // repaired from pi history: a legacy automation cache that dropped the
        // leading user prompt, and a cache a pre-fix auto-resume sweep
        // overwrote with just the resume-prompt tail.
        const repairFromHistory =
          cacheHit &&
          cachedUnfaithful &&
          !!messages?.some((m) => m.role === "user");
        if (!cacheHit || repairFromHistory)
          chatStore.getState().reset(id, messages);
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailId]);
  const useDetailActionsResult = useDetailActions({
    applyRuntimeSelection,
    maybeRunCodexCommand,
    maybeClearReview: (...args) => maybeClearReview(...args),
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
  });
  function deliverQueued(
    ...args: Parameters<typeof useDetailActionsResult.deliverQueued>
  ) {
    return useDetailActionsResult.deliverQueued(...args);
  }
  function onDetailSend(
    ...args: Parameters<typeof useDetailActionsResult.onDetailSend>
  ) {
    return useDetailActionsResult.onDetailSend(...args);
  }
  function onDetailAbort(
    ...args: Parameters<typeof useDetailActionsResult.onDetailAbort>
  ) {
    return useDetailActionsResult.onDetailAbort(...args);
  }
  function onDetailRetry(
    ...args: Parameters<typeof useDetailActionsResult.onDetailRetry>
  ) {
    return useDetailActionsResult.onDetailRetry(...args);
  }
  function steerQueuedDetail(
    ...args: Parameters<typeof useDetailActionsResult.steerQueuedDetail>
  ) {
    return useDetailActionsResult.steerQueuedDetail(...args);
  }
  function onDetailModelChange(
    ...args: Parameters<typeof useDetailActionsResult.onDetailModelChange>
  ) {
    return useDetailActionsResult.onDetailModelChange(...args);
  }
  function onDetailWorkspaceChange(
    ...args: Parameters<typeof useDetailActionsResult.onDetailWorkspaceChange>
  ) {
    return useDetailActionsResult.onDetailWorkspaceChange(...args);
  }
  const {
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
  } = useConversationActions({
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
  });

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
    setTemporaryWorkspaces((dirs) =>
      dirs.includes(conv.workspaceDir) ? dirs : [...dirs, conv.workspaceDir],
    );
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
  return renderHome({
    sidebarOpen,
    setSidebarOpen,
    paletteOpen,
    setPaletteOpen,
    conversations,
    activeId,
    modelChoice,
    setView,
    onSelect,
    onSettingsConversationsChanged,
    conversationsRef,
    setNewTaskOpen,
    onModelChange,
    setSettingsOpen,
    setHistoryQuery,
    setHistoryFrame,
    setHistoryOpen,
    detailId,
    setDetailId,
    detailLoading,
    detailModelChoice,
    onDetailModelChange,
    detailWorkspaceDir,
    defaultWorkspace,
    onDetailWorkspaceChange,
    onDetailSend,
    onDetailAbort,
    onFork,
    detailFocusToken,
    onDetailRetry,
    retrying,
    queued,
    enqueueMessage,
    detailConvBackend,
    steerQueuedDetail,
    removeQueued,
    view,
    chatArtifactsOpen,
    activeHasArtifacts,
    setChatArtifactsOpen,
    newTaskOpen,
    workspaceDir,
    onWorkspaceChange,
    pendingBackend,
    setPendingBackend,
    pendingCliModel,
    pendingCliEffort,
    onPendingTuningChange,
    onCreateTask,
    automationDialogOpen,
    setAutomationDialogOpen,
    editingAutomation,
    onSaveAutomation,
    settingsEverOpened,
    settingsOpen,
    closeSettings,
    storedProviders,
    onSettingsSaved,
    openHistoryFromSettings,
    historyOpen,
    historyQuery,
    historyFrame,
    activityIds,
    unreadCompletedIds,
    recentWorkspaces,
    temporaryWorkspaces,
    hiddenWorkspaces,
    collapsedWorkspaceDirs,
    expandedWorkspaceDirs,
    boardWorkspaceFilter,
    setBoardWorkspaceFilter,
    onSelectChat,
    onNew,
    onNewSidebar,
    onRevealWorkspace,
    onArchiveWorkspaceChats,
    onRemoveWorkspace,
    onReorderWorkspaces,
    toggleWorkspaceCollapsed,
    toggleWorkspaceExpanded,
    onArchive,
    onTogglePin,
    onRename,
    openSettings,
    updateReadyVersion,
    onRestartToUpdate,
    keyboardShortcuts,
    piReady,
    error,
    hasMessages,
    t,
    openWorkspacePanelLayout,
    automations,
    openNewAutomation,
    openEditAutomation,
    onToggleAutomation,
    onRunAutomation,
    onDeleteAutomation,
    onOpenDetail,
    onApproveReview,
    onRequestChanges,
    loadingChatId,
    sideWorkspace,
    activeConvBackend,
    onSend,
    onBash,
    onAbort,
    onRetry,
    activeConvInterrupted,
    onResumeInterrupted,
    onDismissInterrupted,
    activeIdRef,
    steerQueued,
    focusToken,
    backendSwitch,
    requestBackendSwitch,
    heroHeadline,
    isStreaming,
    renderWorkspaceDock,
  });
}
