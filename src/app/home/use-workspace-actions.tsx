"use client";

import type { Dispatch, SetStateAction, RefObject, ReactNode } from "react";
import { MessageSquare, Plus, Terminal, Globe, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FilePreview } from "@/components/workspace/file-preview";
import { TerminalPanel } from "@/components/workspace/terminal-panel";
import { BrowserView } from "@/components/browser/browser-view";
import type { WorkspaceFileEntry } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  type ComposerAttachment,
  type ComposerRuntimeSelection,
} from "@/components/chat/composer";
import type { SidebarView } from "@/components/sidebar/view-toggle";
import {
  WorkspacePanel,
  TabIcon,
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
  type WorkspaceDockKey,
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
    layout: WorkspaceDockKey,
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
          [layout]: updater(currentDocks[layout] ?? emptyMainDock()),
        },
      };
    });
  }

  function workspaceRefs(
    layout: WorkspaceDockKey,
    keyOverride?: string | null,
  ) {
    const key = keyOverride ?? activeIdRef.current ?? NEW_CHAT_WORKSPACE_KEY;
    const dock =
      (workspaceDocksByChatRef.current[key] ?? createInitialWorkspaceDocks())[
        layout
      ] ?? emptyMainDock();
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
    layout: WorkspaceDockKey,
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
    layout: WorkspaceDockKey,
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
        onOpenFile={layout === "side" ? openFileTab : undefined}
      />
    );
  }

  // ── Main-area tabs ────────────────────────────────────────────────────
  // The chat is the implicit first tab (activeId null); files opened from the
  // side tree, terminals and browsers sit beside it.

  function newTabId(kind: string) {
    return `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  function openFileTab(entry: WorkspaceFileEntry, isRemote: boolean) {
    const { tabs, update } = workspaceRefs("main");
    const existing = tabs.find(
      (tab) => tab.kind === "file" && tab.file?.path === entry.path,
    );
    if (existing) {
      update((current) => ({ ...current, activeId: existing.id }));
      return;
    }
    const tab: WorkspaceTab = {
      id: newTabId("file"),
      kind: "file",
      title: entry.name,
      file: entry,
      fileRemote: isRemote,
    };
    update((current) => ({
      ...current,
      tabs: [...current.tabs, tab],
      activeId: tab.id,
    }));
  }

  function openMainTab(kind: "terminal" | "browser") {
    const { tabs, update } = workspaceRefs("main");
    const count = tabs.filter((tab) => tab.kind === kind).length + 1;
    const tab: WorkspaceTab = {
      id: newTabId(kind),
      kind,
      title: workspaceTitle(kind, count),
      terminalState:
        kind === "terminal" ? createTerminalViewState() : undefined,
      terminalFocusRequest:
        kind === "terminal" ? newTabId("term-focus") : undefined,
      browserState: kind === "browser" ? createBrowserViewState() : undefined,
    };
    update((current) => ({
      ...current,
      tabs: [...current.tabs, tab],
      activeId: tab.id,
    }));
  }

  function selectMainTab(id: string | null) {
    workspaceRefs("main").setActiveId(id);
  }

  function closeMainTab(id: string) {
    workspaceRefs("main").update((current) => {
      const index = current.tabs.findIndex((tab) => tab.id === id);
      if (index === -1) return current;
      const tabs = current.tabs.filter((tab) => tab.id !== id);
      if (current.activeId !== id) return { ...current, tabs };
      // Fall back to the left neighbour; the chat is left of the first tab.
      return { ...current, tabs, activeId: tabs[index - 1]?.id ?? null };
    });
  }

  function cycleMainTab(direction: 1 | -1): boolean {
    const { tabs, activeId, setActiveId } = workspaceRefs("main");
    if (!tabs.length) return false;
    const ids = [null, ...tabs.map((tab) => tab.id)];
    const index = Math.max(0, ids.indexOf(activeId));
    setActiveId(ids[(index + direction + ids.length) % ids.length]);
    return true;
  }

  function closeActiveMainTab(): boolean {
    const { activeId } = workspaceRefs("main");
    if (!activeId) return false;
    closeMainTab(activeId);
    return true;
  }

  const mainDock = workspaceDocks.main ?? emptyMainDock();
  const activeMainTab =
    mainDock.tabs.find((tab) => tab.id === mainDock.activeId) ?? null;

  function renderMainTabStrip(chatTitle: string) {
    if (!mainDock.tabs.length) return null;
    return (
      <div
        className="flex min-w-0 shrink items-center gap-1 overflow-x-auto"
        data-testid="main-tabs"
      >
        <MainTabButton
          icon={<MessageSquare className="size-3.5" />}
          title={chatTitle || t("workspacePanel.chat")}
          active={!activeMainTab}
          onSelect={() => selectMainTab(null)}
        />
        {mainDock.tabs.map((tab) => (
          <MainTabButton
            key={tab.id}
            icon={<TabIcon kind={tab.kind} />}
            title={tab.title}
            hint={tab.file?.relativePath}
            active={tab.id === activeMainTab?.id}
            onSelect={() => selectMainTab(tab.id)}
            onClose={() => closeMainTab(tab.id)}
            closeLabel={t("workspacePanel.closeTab", { title: tab.title })}
          />
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={t("workspacePanel.newTab")}
            >
              <Plus className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-40">
            <DropdownMenuItem onSelect={() => openMainTab("terminal")}>
              <Terminal />
              {t("workspacePanel.terminal")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openMainTab("browser")}>
              <Globe />
              {t("workspacePanel.browser")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }

  /** Wraps the chat content; non-chat tabs cover it so the transcript keeps
   * its layout and scroll position underneath. */
  function renderMainTabs(content: ReactNode) {
    if (!mainDock.tabs.length) return content;
    const cwd = workspaceDir || defaultWorkspace;
    return (
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          className="flex min-h-0 flex-1 flex-col"
          inert={activeMainTab != null}
        >
          {content}
        </div>
        {/* Terminals stay mounted so xterm keeps its screen across switches. */}
        {mainDock.tabs
          .filter((tab) => tab.kind === "terminal")
          .map((tab) => {
            const visible = tab.id === activeMainTab?.id;
            return (
              <div
                key={tab.id}
                className={cn(
                  "absolute inset-0 z-20 border-t border-border bg-background",
                  !visible && "hidden",
                )}
              >
                <TerminalPanel
                  sessionId={tab.id}
                  workspaceDir={cwd}
                  visible={visible}
                  runRequest={tab.terminalRunRequest}
                  focusRequest={tab.terminalFocusRequest}
                />
              </div>
            );
          })}
        {activeMainTab?.kind === "file" && activeMainTab.file && (
          <div className="absolute inset-0 z-20 border-t border-border bg-background">
            <FilePreview
              file={activeMainTab.file}
              workspaceDir={cwd}
              isRemote={!!activeMainTab.fileRemote}
            />
          </div>
        )}
        {activeMainTab?.kind === "browser" && (
          <div className="absolute inset-0 z-20 flex flex-col border-t border-border bg-background">
            <BrowserView
              key={activeMainTab.id}
              state={activeMainTab.browserState ?? createBrowserViewState()}
              onStateChange={(state) =>
                updateBrowserWorkspaceTab("main", activeMainTab.id, state)
              }
              onAnnotate={async (message) => {
                await onSend(message);
                selectMainTab(null);
              }}
              visible
            />
          </div>
        )}
      </div>
    );
  }

  return {
    openFileTab,
    cycleMainTab,
    closeActiveMainTab,
    renderMainTabStrip,
    renderMainTabs,
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

function emptyMainDock(): WorkspaceDockState {
  return { open: true, tabs: [], activeId: null };
}

function MainTabButton({
  icon,
  title,
  hint,
  active,
  onSelect,
  onClose,
  closeLabel,
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
  active: boolean;
  onSelect: () => void;
  onClose?: () => void;
  closeLabel?: string;
}) {
  return (
    <div
      data-active={active ? "true" : "false"}
      className={cn(
        "group inline-flex h-7 max-w-44 shrink-0 items-center rounded-md text-xs transition-colors",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
      )}
      title={hint ?? title}
      onAuxClick={(e) => {
        if (e.button === 1 && onClose) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "inline-flex min-w-0 flex-1 items-center gap-1.5 pl-2",
          onClose ? "pr-1" : "pr-2.5",
        )}
      >
        <span className="flex shrink-0">{icon}</span>
        <span className="truncate">{title}</span>
      </button>
      {onClose && (
        <button
          type="button"
          className="mr-1 grid size-4 shrink-0 place-items-center rounded opacity-0 group-hover:opacity-60 group-data-[active=true]:opacity-60 hover:bg-background hover:!opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label={closeLabel}
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}
