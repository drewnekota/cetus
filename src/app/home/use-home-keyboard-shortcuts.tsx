"use client";

import type { RuntimeEntry } from "@/lib/runtime-settings";
import type { Dispatch, SetStateAction, RefObject } from "react";
import type { ShortcutMap } from "@/lib/keyboard-shortcuts";
import { useEffect } from "react";
import { FIND_IN_CHAT_EVENT } from "@/components/chat/find-highlight";
import type { SidebarView } from "@/components/sidebar/view-toggle";
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
import { matchesShortcut } from "@/lib/keyboard-shortcuts";
import { WorkspaceDockState } from "./home-utils";

export function useHomeKeyboardShortcuts({
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
  navigateBack: () => void;
  navigateForward: () => void;
  switchToPreviousPage: () => void;
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
  //   ⌘1…⌘3 — switch sidebar view (⌘1 again opens the first chat)
  //   ⌘[/⌘] — go back / forward through the page history (views + settings)
  //   ⌃⇥    — switch to the most recently used page (including chats/settings)
  //   ⌃1…⌃3 — switch the current chat's runtime (Cetus / Claude Code / Codex)
  //   ⌘⇧S   — collapse / expand the left sidebar
  //   ⌘B    — toggle workspace
  //   ⌘J    — toggle Terminal in the workspace
  //   ⌘T    — open a Browser tab in the right workspace
  //   ⌘P    — open a Files tab in the right workspace
  //   ⌘W    — close the active right-workspace tab when that panel is open
  //   ⌥⌘←/→ — switch right-workspace tabs when that panel is open
  //   ⌥⌘↑/↓ — switch to the previous / next chat
  //   ⌘9    — switch to the last chat in the sidebar
  //   ⌘⇧A   — toggle artifacts panel (chat view, when artifacts exist)
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
      // Ctrl+Tab — MRU page switch. It needs to run before the Settings guard
      // so Settings can toggle back to the page that opened it.
      if (shortcut("switchPreviousView")) {
        if (automationDialogOpen || newTaskOpen || detailId !== null) return;
        e.preventDefault();
        switchToPreviousPage();
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
      if (shortcut("previousChat")) {
        e.preventDefault();
        switchChat(-1);
        return;
      }
      if (shortcut("nextChat")) {
        e.preventDefault();
        switchChat(1);
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
        // Cmd+N is contextual on Kanban: a concrete folder creates a task in
        // that workspace; "All workspaces", Chat, or no selection opens the
        // repository-free new-chat page. Use the board filter, not workspaceDir
        // (which may still point at a previously opened conversation).
        const taskWorkspace =
          view === "board" &&
          boardWorkspaceFilter &&
          boardWorkspaceFilter !== defaultWorkspace
            ? boardWorkspaceFilter
            : null;
        if (taskWorkspace) {
          setWorkspaceDir(taskWorkspace);
          setNewTaskOpen(true);
        } else {
          onNew(view === "board" ? defaultWorkspace || undefined : undefined);
        }
      } else if (shortcut("newDefaultChat")) {
        e.preventDefault();
        // ⌥⌘N always lands a new chat in Chat (the default workspace), even
        // from the board or with another folder selected.
        onNew(defaultWorkspace || undefined);
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
        view === "chat" &&
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
        if (view === "chat") {
          const firstId = orderedChatIdsRef.current.at(0);
          if (firstId) onSelectChat(firstId);
        } else {
          setView("chat");
        }
      } else if (shortcut("switchBoard")) {
        e.preventDefault();
        setView("board");
      } else if (shortcut("switchAutomations")) {
        e.preventDefault();
        setView("automations");
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
    requestBackendSwitch,
    switchToPreviousPage,
    navigateBack,
    navigateForward,
  ]);
}
