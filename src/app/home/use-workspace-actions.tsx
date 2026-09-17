"use client";

import type { Dispatch, SetStateAction, RefObject } from "react";
import {
  type ComposerAttachment,
  type ComposerRuntimeSelection,
} from "@/components/chat/composer";
import type { SidebarView } from "@/components/sidebar/view-toggle";
import {
  WorkspacePanel,
  createTerminalViewState,
  type WorkspaceTab,
  type WorkspaceTabKind,
  type WorkspaceLayout,
  type TerminalRunRequest,
  type TerminalViewState,
} from "@/components/workspace/workspace-panel";
import {
  createBrowserViewState,
  type BrowserViewState,
} from "@/components/browser/browser-view";
import {
  WorkspaceDocksByChatState,
  WorkspaceDocksState,
  WorkspaceDockState,
  NEW_CHAT_WORKSPACE_KEY,
  createInitialWorkspaceDocks,
} from "./home-utils";

export function useWorkspaceActions({
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
}: {
  t: (key: string, vars?: Record<string, string | number>) => string;
  activeIdRef: RefObject<string | null>;
  setWorkspaceDocksByChat: Dispatch<SetStateAction<WorkspaceDocksByChatState>>;
  workspaceDocksByChatRef: RefObject<WorkspaceDocksByChatState>;
  workspaceDocks: WorkspaceDocksState;
  sideWorkspacePresence: { mounted: boolean; hidden: boolean };
  bottomWorkspacePresence: { mounted: boolean; hidden: boolean };
  workspaceDir: string | null;
  defaultWorkspace: string;
  onSend: (
    text: string,
    attachments?: ComposerAttachment[],
    runtime?: ComposerRuntimeSelection,
  ) => Promise<void>;
  setView: Dispatch<SetStateAction<SidebarView>>;
}) {
  function workspaceTitle(kind: WorkspaceTabKind, index: number): string {
    if (kind === "files") {
      return index > 1
        ? t("workspacePanel.filesN", { index })
        : t("workspacePanel.files");
    }
    if (kind === "terminal") {
      return index > 1
        ? t("workspacePanel.terminalN", { index })
        : t("workspacePanel.terminal");
    }
    return index > 1
      ? t("workspacePanel.browserN", { index })
      : t("workspacePanel.browser");
  }

  function browserTitle(url: string, fallback: string): string {
    if (!url || url === "about:blank") return fallback;
    try {
      const parsed = new URL(url);
      return parsed.host || parsed.pathname || fallback;
    } catch {
      return url.length > 24 ? `${url.slice(0, 21)}...` : url;
    }
  }

  function normalizeVisibleBrowserUrl(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return "about:blank";
    if (/^(https?:|file:|about:)/i.test(trimmed)) return trimmed;
    if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(\/|$)/i.test(trimmed)) {
      return `http://${trimmed}`;
    }
    return `https://${trimmed}`;
  }

  function browserStateForUrl(url: string): BrowserViewState {
    return {
      ...createBrowserViewState(),
      address: url,
      url,
      history: [url],
      historyIndex: 0,
    };
  }

  function updateWorkspaceDock(
    layout: WorkspaceLayout,
    updater: (dock: WorkspaceDockState) => WorkspaceDockState,
    keyOverride?: string | null,
  ) {
    const key = keyOverride ?? activeIdRef.current ?? NEW_CHAT_WORKSPACE_KEY;
    setWorkspaceDocksByChat((current) => {
      const currentDocks = current[key] ?? createInitialWorkspaceDocks();
      return {
        ...current,
        [key]: {
          ...currentDocks,
          [layout]: updater(currentDocks[layout]),
        },
      };
    });
  }

  function workspaceRefs(layout: WorkspaceLayout, keyOverride?: string | null) {
    const key = keyOverride ?? activeIdRef.current ?? NEW_CHAT_WORKSPACE_KEY;
    const dock = (workspaceDocksByChatRef.current[key] ??
      createInitialWorkspaceDocks())[layout];
    return {
      ...dock,
      setTabs: (updater: (tabs: WorkspaceTab[]) => WorkspaceTab[]) =>
        updateWorkspaceDock(
          layout,
          (current) => ({
            ...current,
            tabs: updater(current.tabs),
          }),
          key,
        ),
      setActiveId: (activeId: string | null) =>
        updateWorkspaceDock(
          layout,
          (current) => ({ ...current, activeId }),
          key,
        ),
      setOpen: (open: boolean) =>
        updateWorkspaceDock(layout, (current) => ({ ...current, open }), key),
      update: (updater: (dock: WorkspaceDockState) => WorkspaceDockState) =>
        updateWorkspaceDock(layout, updater, key),
    };
  }

  function openWorkspaceTab(
    layout: WorkspaceLayout,
    kind: WorkspaceTabKind,
    alwaysNew = false,
  ) {
    const { tabs, update } = workspaceRefs(layout);
    const existing = !alwaysNew ? tabs.find((t) => t.kind === kind) : undefined;
    if (existing) {
      const terminalFocusRequest =
        kind === "terminal"
          ? `term-focus-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
          : undefined;
      update((current) => ({
        ...current,
        tabs: terminalFocusRequest
          ? current.tabs.map((tab) =>
              tab.id === existing.id ? { ...tab, terminalFocusRequest } : tab,
            )
          : current.tabs,
        activeId: existing.id,
        open: true,
      }));
      return;
    }
    const count = tabs.filter((t) => t.kind === kind).length + 1;
    const terminalFocusRequest =
      kind === "terminal"
        ? `term-focus-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        : undefined;
    const tab: WorkspaceTab = {
      id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind,
      title: workspaceTitle(kind, count),
      terminalState:
        kind === "terminal" ? createTerminalViewState() : undefined,
      terminalFocusRequest,
      browserState: kind === "browser" ? createBrowserViewState() : undefined,
    };
    update((current) => ({
      ...current,
      tabs: [...current.tabs, tab],
      activeId: tab.id,
      open: true,
    }));
  }

  function openTerminalTab() {
    const { tabs, activeId, update } = workspaceRefs("bottom");
    const focusRequest = `term-focus-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const activeTerminal = tabs.find(
      (tab) => tab.id === activeId && tab.kind === "terminal",
    );
    const target =
      activeTerminal ?? tabs.find((tab) => tab.kind === "terminal");
    if (target) {
      update((current) => ({
        ...current,
        tabs: current.tabs.map((tab) =>
          tab.id === target.id
            ? { ...tab, terminalFocusRequest: focusRequest }
            : tab,
        ),
        activeId: target.id,
        open: true,
      }));
      return;
    }

    const count = tabs.filter((tab) => tab.kind === "terminal").length + 1;
    const tab: WorkspaceTab = {
      id: `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: "terminal",
      title: workspaceTitle("terminal", count),
      terminalState: createTerminalViewState(),
      terminalFocusRequest: focusRequest,
    };
    update((current) => ({
      ...current,
      tabs: [...current.tabs, tab],
      activeId: tab.id,
      open: true,
    }));
  }

  function toggleTerminalPanel() {
    if (workspaceRefs("bottom").open) {
      workspaceRefs("bottom").setOpen(false);
      return;
    }
    openTerminalTab();
  }

  function toggleSideWorkspacePanel() {
    if (workspaceRefs("side").open) {
      workspaceRefs("side").setOpen(false);
      return;
    }
    openWorkspacePanelLayout("side");
  }

  function openWorkspacePanelLayout(layout: WorkspaceLayout) {
    const { tabs, setOpen } = workspaceRefs(layout);
    setOpen(true);
    if (tabs.length === 0) {
      openWorkspaceTab(layout, layout === "bottom" ? "terminal" : "files");
    }
  }

  function openTerminalWithCommand(commandRaw: string) {
    const command = commandRaw.trim();
    if (!command) return;
    const request: TerminalRunRequest = {
      id: `term-run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      command,
      autoRun: true,
    };
    const { tabs, activeId, update } = workspaceRefs("bottom");
    const activeTerminal = tabs.find(
      (tab) => tab.id === activeId && tab.kind === "terminal",
    );
    const target =
      activeTerminal ?? tabs.find((tab) => tab.kind === "terminal");
    if (target) {
      update((current) => ({
        ...current,
        tabs: current.tabs.map((tab) =>
          tab.id === target.id ? { ...tab, terminalRunRequest: request } : tab,
        ),
        activeId: target.id,
        open: true,
      }));
      return;
    }

    const count = tabs.filter((tab) => tab.kind === "terminal").length + 1;
    const tab: WorkspaceTab = {
      id: `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: "terminal",
      title: workspaceTitle("terminal", count),
      terminalState: createTerminalViewState(),
      terminalRunRequest: request,
    };
    update((current) => ({
      ...current,
      tabs: [...current.tabs, tab],
      activeId: tab.id,
      open: true,
    }));
  }

  function updateBrowserWorkspaceTab(
    layout: WorkspaceLayout,
    id: string,
    state: BrowserViewState,
  ) {
    const { setTabs } = workspaceRefs(layout);
    setTabs((tabs) =>
      tabs.map((tab) =>
        tab.id === id && tab.kind === "browser"
          ? {
              ...tab,
              title: browserTitle(state.url, tab.title),
              browserState: state,
            }
          : tab,
      ),
    );
  }

  function updateTerminalWorkspaceTab(
    layout: WorkspaceLayout,
    id: string,
    state: TerminalViewState,
  ) {
    const { setTabs } = workspaceRefs(layout);
    setTabs((tabs) =>
      tabs.map((tab) =>
        tab.id === id && tab.kind === "terminal"
          ? { ...tab, terminalState: state }
          : tab,
      ),
    );
  }

  function openVisibleBrowser(urlRaw: string, conversationId?: string | null) {
    const url = normalizeVisibleBrowserUrl(urlRaw);
    const { tabs, activeId, update } = workspaceRefs("side", conversationId);
    const activeBrowser = tabs.find(
      (tab) => tab.id === activeId && tab.kind === "browser",
    );
    const target = activeBrowser ?? tabs.find((tab) => tab.kind === "browser");
    if (target) {
      const state = browserStateForUrl(url);
      update((current) => ({
        ...current,
        tabs: current.tabs.map((tab) =>
          tab.id === target.id
            ? {
                ...tab,
                title: browserTitle(url, tab.title),
                browserState: state,
              }
            : tab,
        ),
        activeId: target.id,
        open: true,
      }));
      return;
    }

    const count = tabs.filter((tab) => tab.kind === "browser").length + 1;
    const tab: WorkspaceTab = {
      id: `browser-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: "browser",
      title: browserTitle(url, workspaceTitle("browser", count)),
      browserState: browserStateForUrl(url),
    };
    update((current) => ({
      ...current,
      tabs: [...current.tabs, tab],
      activeId: tab.id,
      open: true,
    }));
  }

  function closeWorkspaceTab(layout: WorkspaceLayout, id: string) {
    const { activeId, setTabs, setActiveId, setOpen } = workspaceRefs(layout);
    setTabs((tabs) => {
      const index = tabs.findIndex((t) => t.id === id);
      if (index === -1) return tabs;
      const next = tabs.filter((t) => t.id !== id);
      if (activeId === id) {
        const fallback = next[Math.min(index, next.length - 1)] ?? null;
        setActiveId(fallback?.id ?? null);
        if (!fallback) setOpen(false);
      }
      return next;
    });
  }

  function switchWorkspaceTab(layout: WorkspaceLayout, direction: 1 | -1) {
    const { tabs, activeId, setActiveId, setOpen } = workspaceRefs(layout);
    if (tabs.length < 2) return;
    const activeIndex = Math.max(
      0,
      tabs.findIndex((tab) => tab.id === activeId),
    );
    const nextIndex = (activeIndex + direction + tabs.length) % tabs.length;
    setActiveId(tabs[nextIndex].id);
    setOpen(true);
  }

  function renderWorkspaceDock(layout: WorkspaceLayout) {
    const dock = workspaceDocks[layout];
    const presence =
      layout === "side" ? sideWorkspacePresence : bottomWorkspacePresence;
    if (!presence.mounted) return null;
    return (
      <WorkspacePanel
        tabs={dock.tabs}
        activeId={dock.activeId}
        workspaceDir={workspaceDir}
        defaultWorkspace={defaultWorkspace}
        onSelect={(id) => {
          updateWorkspaceDock(layout, (current) => ({
            ...current,
            activeId: id,
            open: true,
          }));
        }}
        onClose={(id) => closeWorkspaceTab(layout, id)}
        onClosePanel={() => workspaceRefs(layout).setOpen(false)}
        onNewTab={(kind) => openWorkspaceTab(layout, kind, true)}
        layout={layout}
        onUpdateTerminalTab={(id, state) =>
          updateTerminalWorkspaceTab(layout, id, state)
        }
        onUpdateBrowserTab={(id, state) =>
          updateBrowserWorkspaceTab(layout, id, state)
        }
        motionState={dock.open ? "open" : "closed"}
        hidden={presence.hidden}
        onAnnotate={async (message) => {
          await onSend(message);
          setView("chat");
        }}
        onOpenTerminalCommand={openTerminalWithCommand}
      />
    );
  }
  return {
    switchWorkspaceTab,
    toggleSideWorkspacePanel,
    toggleTerminalPanel,
    openWorkspaceTab,
    closeWorkspaceTab,
    openVisibleBrowser,
    openTerminalWithCommand,
    openWorkspacePanelLayout,
    renderWorkspaceDock,
  };
}
