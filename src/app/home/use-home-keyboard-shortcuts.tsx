"use client";

import type { RuntimeEntry } from "@/lib/runtime-settings";
import type { Dispatch, SetStateAction, RefObject } from "react";
import type { ShortcutMap } from "@/lib/keyboard-shortcuts";
import { useEffect, useRef } from "react";
import { FIND_IN_CHAT_EVENT } from "@/components/chat/find-highlight";
import type {
  ConversationMode,
  SidebarView,
} from "@/components/sidebar/view-toggle";
import {
  type WorkspaceTabKind,
  type WorkspaceLayout,
} from "@/components/workspace/workspace-panel";
import { toast } from "sonner";
import { type Conversation } from "@/lib/types";
import {
  runtimeForShortcut,
  runtimeSwitchTarget,
  type RuntimeSwitchTarget,
} from "@/components/chat/backend-picker";
import {
  CHAT_SLOT_SHORTCUT_IDS,
  acceleratorModifiers,
  heldModifiers,
  keyToken,
  matchesShortcut,
  normalizeAccelerator,
} from "@/lib/keyboard-shortcuts";
import { WorkspaceDockState } from "./home-utils";

export function useHomeKeyboardShortcuts({
  keyboardShortcuts,
  setPaletteOpen,
  automationDialogOpen,
  newTaskOpen,
  detailId,
  onNewThread,
  openNewTask,
  mode,
  stepThread,
  archiveThread,
  stepWorkspace,
  selectWorkspaceSlot,
  navigateBack,
  navigateForward,
  chatSwitcherOpen,
  stepChatSwitcher,
  commitChatSwitcher,
  closeChatSwitcher,
  settingsOpen,
  view,
  historyOpen,
  sideWorkspace,
  switchWorkspaceTab,
  switchChat,
  orderedChatIdsRef,
  onSelectChat,
  setSidebarOpen,
  toggleSideWorkspacePanel,
  toggleTerminalPanel,
  openWorkspaceTab,
  closeWorkspaceTab,
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
}: {
  keyboardShortcuts: ShortcutMap;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  automationDialogOpen: boolean;
  newTaskOpen: boolean;
  detailId: string | null;
  onNewThread: () => void;
  /** Kanban's create-task dialog, seeded with the board's folder. */
  openNewTask: () => void;
  mode: ConversationMode;
  stepThread: (direction: 1 | -1) => void;
  stepWorkspace: (direction: 1 | -1) => void;
  /** Open the Nth workspace's feed; -1 = the last one. */
  selectWorkspaceSlot: (index: number) => void;
  /** Archive the Threads view's open thread; false when none is open. */
  archiveThread: () => boolean;
  navigateBack: () => void;
  navigateForward: () => void;
  chatSwitcherOpen: boolean;
  stepChatSwitcher: (delta: 1 | -1, stillHeld: () => boolean) => void;
  commitChatSwitcher: () => void;
  closeChatSwitcher: (entry: null) => void;
  settingsOpen: boolean;
  view: SidebarView;
  historyOpen: boolean;
  sideWorkspace: WorkspaceDockState;
  switchWorkspaceTab: (layout: WorkspaceLayout, direction: 1 | -1) => void;
  switchChat: (direction: 1 | -1) => void;
  orderedChatIdsRef: RefObject<string[]>;
  onSelectChat: (id: string) => void;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  toggleSideWorkspacePanel: () => void;
  toggleTerminalPanel: () => void;
  openWorkspaceTab: (
    layout: WorkspaceLayout,
    kind: WorkspaceTabKind,
    alwaysNew?: boolean,
  ) => void;
  closeWorkspaceTab: (layout: WorkspaceLayout, id: string) => void;
  boardWorkspaceFilter: string | null;
  defaultWorkspace: string;
  setWorkspaceDir: Dispatch<SetStateAction<string | null>>;
  setNewTaskOpen: Dispatch<SetStateAction<boolean>>;
  onNew: (nextWorkspaceDir?: string) => void;
  conversationsRef: RefObject<Conversation[]>;
  activeIdRef: RefObject<string | null>;
  archiveConversation: (c: Conversation) => Promise<void>;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  runtimeSlotsRef: RefObject<RuntimeEntry[]>;
  requestBackendSwitch: (target: RuntimeSwitchTarget) => void;
  setView: Dispatch<SetStateAction<SidebarView>>;
}) {
  // Global keyboard shortcuts (parallels macOS app conventions).
  //   ⌘K    — command palette
  //   ⌘N    — new chat / new board task
  //   ⌘D    — archive current conversation
  //   ⌘,    — open settings
  //   ⌥⌘1…⌥⌘3 — switch sidebar view (Chats / Kanban / Automations)
  //   ⌘[/⌘] — go back / forward through the page history (views + settings)
  //   ⌃⇥    — tap: previous chat; hold ⌃: MRU switcher over recent chats
  //           (⇥ / ⇧⇥ step, release ⌃ to switch, esc to cancel)
  //   ⌃1…⌃3 — switch the current chat's runtime (Cetus / Claude Code / Codex)
  //   ⌘⇧S   — collapse / expand the left sidebar
  //   ⌘B    — toggle workspace
  //   ⌘J    — toggle Terminal in the workspace
  //   ⌘T    — open a Browser tab in the right workspace
  //   ⌘P    — open a Files tab in the right workspace
  //   ⌘W    — close the active right-workspace tab when that panel is open
  //   ⌥⌘←/→ — switch right-workspace tabs when that panel is open
  //   ⌥⌘↑/↓, ⇧⌘[/] — switch to the previous / next chat
  //   ⌘1…⌘8 — open the nth visible chat in the sidebar (hold ⌘ to see them)
  //   ⌘9    — switch to the last chat in the sidebar
  //   ⌘⇧A   — toggle artifacts panel (chat view, when artifacts exist)
  // Live modifier state, so the switcher can tell a tap from a hold once its
  // reveal delay is up.
  const heldModifiersRef = useRef("");
  useEffect(() => {
    const track = (e: KeyboardEvent) => {
      heldModifiersRef.current = heldModifiers(e);
    };
    const clear = () => {
      heldModifiersRef.current = "";
    };
    window.addEventListener("keydown", track, true);
    window.addEventListener("keyup", track, true);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", track, true);
      window.removeEventListener("keyup", track, true);
      window.removeEventListener("blur", clear);
    };
  }, []);
  // While the switcher is up it owns the keyboard (capture phase, ahead of the
  // composer): ⇥ / arrows step, ↩ commits, esc cancels, and releasing the
  // switcher's modifier — or the window losing focus — commits the selection.
  useEffect(() => {
    if (!chatSwitcherOpen) return;
    const holdMods = acceleratorModifiers(
      keyboardShortcuts.switchPreviousView,
    ).split("+");
    const onKeyDown = (e: KeyboardEvent) => {
      if (keyToken(e.code, e.key) === null) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") closeChatSwitcher(null);
      else if (e.key === "Enter") commitChatSwitcher();
      else if (e.key === "Tab") stepChatSwitcher(e.shiftKey ? -1 : 1, () => true);
      else if (e.key === "ArrowDown" || e.key === "ArrowRight")
        stepChatSwitcher(1, () => true);
      else if (e.key === "ArrowUp" || e.key === "ArrowLeft")
        stepChatSwitcher(-1, () => true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const held = heldModifiers(e);
      if (!holdMods.every((m) => held.includes(m))) commitChatSwitcher();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", commitChatSwitcher);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", commitChatSwitcher);
    };
  }, [
    chatSwitcherOpen,
    keyboardShortcuts.switchPreviousView,
    stepChatSwitcher,
    commitChatSwitcher,
    closeChatSwitcher,
  ]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const shortcut = (id: keyof typeof keyboardShortcuts) =>
        matchesShortcut(e, keyboardShortcuts[id]);
      // ⌘K / Ctrl+K — the command palette is a global launcher: openable from
      // anywhere. Handled before the modal guard so an open dialog doesn't
      // swallow it; it stacks over whatever's showing and owns its own Esc to
      // close. Toggles, so a second ⌘K dismisses it.
      if (shortcut("commandPalette")) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      // ⌘[ / ⌘] — walk the page history (sidebar views + Settings) like a
      // browser. Handled before the modal guard so Back can close Settings,
      // but the true dialogs below keep owning the keyboard.
      if (shortcut("navigateBack") || shortcut("navigateForward")) {
        if (automationDialogOpen || newTaskOpen || detailId !== null) return;
        e.preventDefault();
        if (shortcut("navigateBack")) navigateBack();
        else navigateForward();
        return;
      }
      // Ctrl+Tab — MRU chat switch. It runs before the Settings guard so a
      // chat can be picked straight from Settings. The reverse step is the
      // same chord plus Shift.
      const switcherAccel = keyboardShortcuts.switchPreviousView;
      const reverseSwitch =
        !!switcherAccel &&
        !normalizeAccelerator(switcherAccel).includes("Shift") &&
        matchesShortcut(e, `${switcherAccel}+Shift`);
      if (shortcut("switchPreviousView") || reverseSwitch) {
        if (automationDialogOpen || newTaskOpen || detailId !== null) return;
        e.preventDefault();
        const holdMods = acceleratorModifiers(switcherAccel).split("+");
        stepChatSwitcher(reverseSwitch ? -1 : 1, () =>
          holdMods.every((m) => heldModifiersRef.current.includes(m)),
        );
        return;
      }
      // A modal owns the keyboard while open — don't fire app shortcuts behind
      // it. Settings and dialogs handle their own ⌘↵/Esc.
      if (
        settingsOpen ||
        automationDialogOpen ||
        newTaskOpen ||
        detailId !== null
      )
        return;
      // ⌘F — find inside the open conversation. Only meaningful on the chat
      // view, and only past the modal guard above; the message list owns the
      // bar's state, so this just hands it the key.
      if (shortcut("findInChat")) {
        if (view !== "chat" || historyOpen) return;
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(FIND_IN_CHAT_EVENT));
        return;
      }
      if (sideWorkspace.open && shortcut("previousWorkspaceTab")) {
        e.preventDefault();
        switchWorkspaceTab("side", -1);
        return;
      }
      if (sideWorkspace.open && shortcut("nextWorkspaceTab")) {
        e.preventDefault();
        switchWorkspaceTab("side", 1);
        return;
      }
      // Threads view: the feed is one folder, so the chat-walking keys walk
      // folders instead (⌘1…⌘9 by position, ⌥⌘↑/↓ step), and the threads
      // inside it get their own pair — ⌃K/⌃J, or bare K/J outside a field.
      if (view === "threads") {
        if (shortcut("previousChat") || shortcut("previousChatAlternate")) {
          e.preventDefault();
          stepWorkspace(-1);
          return;
        }
        if (shortcut("nextChat") || shortcut("nextChatAlternate")) {
          e.preventDefault();
          stepWorkspace(1);
          return;
        }
        const slot = CHAT_SLOT_SHORTCUT_IDS.findIndex((id) => shortcut(id));
        if (slot >= 0 || shortcut("lastChat")) {
          e.preventDefault();
          selectWorkspaceSlot(slot >= 0 ? slot : -1);
          return;
        }
        const bare =
          !e.metaKey &&
          !e.ctrlKey &&
          !e.altKey &&
          !e.shiftKey &&
          !isEditableTarget(e.target);
        if (shortcut("previousThread") || (bare && e.key === "k")) {
          e.preventDefault();
          stepThread(-1);
          return;
        }
        if (shortcut("nextThread") || (bare && e.key === "j")) {
          e.preventDefault();
          stepThread(1);
          return;
        }
      }
      if (shortcut("previousChat") || shortcut("previousChatAlternate")) {
        e.preventDefault();
        switchChat(-1);
        return;
      }
      if (shortcut("nextChat") || shortcut("nextChatAlternate")) {
        e.preventDefault();
        switchChat(1);
        return;
      }
      const chatSlot = CHAT_SLOT_SHORTCUT_IDS.findIndex((id) => shortcut(id));
      if (chatSlot >= 0) {
        e.preventDefault();
        const id = orderedChatIdsRef.current.at(chatSlot);
        if (id) onSelectChat(id);
        return;
      }
      if (shortcut("lastChat")) {
        e.preventDefault();
        const lastId = orderedChatIdsRef.current.at(-1);
        if (lastId) onSelectChat(lastId);
        return;
      }
      if (shortcut("toggleSidebar")) {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      } else if (shortcut("toggleWorkspace")) {
        e.preventDefault();
        toggleSideWorkspacePanel();
      } else if (shortcut("toggleTerminal")) {
        e.preventDefault();
        toggleTerminalPanel();
      } else if (shortcut("openBrowserTab")) {
        e.preventDefault();
        openWorkspaceTab("side", "browser", true);
      } else if (shortcut("openFilesTab")) {
        e.preventDefault();
        openWorkspaceTab("side", "files");
      } else if (
        shortcut("closeWorkspaceTab") &&
        sideWorkspace.open &&
        sideWorkspace.tabs.length > 0
      ) {
        e.preventDefault();
        closeWorkspaceTab(
          "side",
          sideWorkspace.activeId ?? sideWorkspace.tabs[0].id,
        );
      } else if (shortcut("newChat")) {
        e.preventDefault();
        // ⌘N follows the mode, even from the Automations page: a thread in
        // Threads, a task card on Kanban, a chat otherwise.
        if (mode === "threads") {
          setView("threads");
          onNewThread();
        } else if (mode === "board") {
          openNewTask();
        } else {
          onNew();
        }
      } else if (shortcut("newDefaultChat")) {
        e.preventDefault();
        // ⌥⌘N always lands a new chat in Chat (the default workspace), even
        // from the board or with another folder selected.
        onNew(defaultWorkspace || undefined);
      } else if (shortcut("archiveChat") && view === "threads") {
        if (archiveThread()) e.preventDefault();
      } else if (shortcut("archiveChat")) {
        const c = conversationsRef.current.find(
          (x) => x.id === activeIdRef.current,
        );
        if (c) {
          e.preventDefault();
          archiveConversation(c).catch((err) => {
            console.error("archiveConversation failed", err);
            toast.error("Couldn't archive that conversation.");
          });
        }
      } else if (shortcut("openSettings")) {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (
        (view === "chat" || view === "threads") &&
        runtimeForShortcut(e, keyboardShortcuts, runtimeSlotsRef.current) !==
          undefined
      ) {
        // ⌃1…⌃9 address runtimes and presets by position, so the key set
        // follows Settings › Runtimes. An empty slot still swallows the key
        // instead of falling through to whatever else is bound to it.
        e.preventDefault();
        const entry = runtimeForShortcut(
          e,
          keyboardShortcuts,
          runtimeSlotsRef.current,
        );
        if (entry) requestBackendSwitch(runtimeSwitchTarget(entry));
      } else if (shortcut("switchChats")) {
        e.preventDefault();
        setView("chat");
      } else if (shortcut("switchBoard")) {
        e.preventDefault();
        setView("board");
      } else if (shortcut("switchAutomations")) {
        e.preventDefault();
        setView("automations");
      } else if (shortcut("switchThreads")) {
        e.preventDefault();
        setView("threads");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    view,
    settingsOpen,
    automationDialogOpen,
    newTaskOpen,
    historyOpen,
    detailId,
    sideWorkspace.open,
    sideWorkspace.activeId,
    sideWorkspace.tabs,
    archiveConversation,
    keyboardShortcuts,
    defaultWorkspace,
    boardWorkspaceFilter,
    mode,
    requestBackendSwitch,
    stepChatSwitcher,
    navigateBack,
    navigateForward,
  ]);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}
