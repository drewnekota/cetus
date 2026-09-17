"use client";

import type { Dispatch, SetStateAction, RefObject, JSX } from "react";
import type { ShortcutMap } from "@/lib/keyboard-shortcuts";
import dynamic from "next/dynamic";
import { Inbox, PanelBottom, PanelLeft, PanelRight } from "lucide-react";
import {
  Composer,
  type ComposerAttachment,
  type ComposerRuntimeSelection,
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
import { type WorkspaceLayout } from "@/components/workspace/workspace-panel";
import { SessionDetailDialog } from "@/components/board/session-detail-dialog";
import { ArtifactsDialog } from "@/components/board/artifacts-dialog";
import { DialogHost } from "@/components/extension-ui/dialog-host";
import { ZoomHud } from "@/components/zoom-hud";
import { TestHook } from "@/components/devtest/test-hook";
import { ScreenHistoryPage } from "@/components/screen-history/screen-history-page";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "sonner";
import { api, type Screenshot } from "@/lib/tauri";
import { tt } from "@/lib/i18n";
import {
  type Automation,
  type AutomationInput,
  type Conversation,
  type ModelChoice,
  type BackendId,
  backendSupportsSteer,
} from "@/lib/types";
import { type RuntimeSwitchTarget } from "@/components/chat/backend-picker";
import { shortcutDisplay, shortcutPlatform } from "@/lib/keyboard-shortcuts";
import {
  WorkspaceDockState,
  mergeConversation,
  ChatLoadingPane,
} from "./home-utils";

// The settings UI is a ~3900-line client component (plus react-markdown for the
// skill previews). Code-split it so its chunk only loads the first time the user
// opens Settings, keeping it out of the cold-start bundle. ssr:false is safe —
// this is a static-export Tauri SPA with no server render. Gated on
// `settingsEverOpened` below so the mount (and thus the chunk fetch) is deferred
// until first open; it then stays mounted so reopen is instant.
const SettingsPage = dynamic(
  () =>
    import("@/components/settings/settings-page").then((m) => m.SettingsPage),
  { ssr: false },
);

// First-run welcome + permission setup. Self-gating (a localStorage flag), so
// it's safe to always mount; renders nothing once dismissed. ssr:false for the
// same reason as SettingsPage — static-export SPA, no server render.
const Onboarding = dynamic(
  () => import("@/components/onboarding/onboarding").then((m) => m.Onboarding),
  { ssr: false },
);

export function renderHome({
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
}: {
  sidebarOpen: boolean;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  paletteOpen: boolean;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  conversations: Conversation[];
  activeId: string | null;
  modelChoice: ModelChoice;
  setView: Dispatch<SetStateAction<SidebarView>>;
  onSelect: (id: string) => Promise<void>;
  onSettingsConversationsChanged: (restored?: Conversation) => void;
  conversationsRef: RefObject<Conversation[]>;
  setNewTaskOpen: Dispatch<SetStateAction<boolean>>;
  onModelChange: (next: ModelChoice) => Promise<void>;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  setHistoryQuery: Dispatch<SetStateAction<string>>;
  setHistoryFrame: Dispatch<SetStateAction<Screenshot | null>>;
  setHistoryOpen: Dispatch<SetStateAction<boolean>>;
  detailId: string | null;
  setDetailId: Dispatch<SetStateAction<string | null>>;
  detailLoading: boolean;
  detailModelChoice: ModelChoice;
  onDetailModelChange: (next: ModelChoice) => Promise<void>;
  detailWorkspaceDir: string | null;
  defaultWorkspace: string;
  onDetailWorkspaceChange: (dir: string) => Promise<void>;
  onDetailSend: (
    text: string,
    attachments?: ComposerAttachment[],
    runtime?: ComposerRuntimeSelection,
  ) => Promise<void>;
  onDetailAbort: () => Promise<void>;
  onFork: (
    c: Conversation,
    messageKey?: string | null,
    messageIndex?: number | null,
  ) => Promise<void>;
  detailFocusToken: number;
  onDetailRetry: () => Promise<void>;
  retrying: boolean;
  queued: Record<string, QueuedMessage[]>;
  enqueueMessage: (
    convId: string,
    text: string,
    attachments: ComposerAttachment[],
    runtime: ComposerRuntimeSelection | undefined,
    beforeIds?: string[],
  ) => void;
  detailConvBackend: BackendId | null;
  steerQueuedDetail: (id: string) => void;
  removeQueued: (convId: string, id: string) => void;
  view: SidebarView;
  chatArtifactsOpen: boolean;
  activeHasArtifacts: boolean;
  setChatArtifactsOpen: Dispatch<SetStateAction<boolean>>;
  newTaskOpen: boolean;
  workspaceDir: string | null;
  onWorkspaceChange: (dir: string) => Promise<void>;
  pendingBackend: BackendId;
  setPendingBackend: Dispatch<SetStateAction<BackendId>>;
  pendingCliModel: string;
  pendingCliEffort: string;
  onPendingTuningChange: (model: string, effort: string) => void;
  onCreateTask: (
    text: string,
    attachments: ComposerAttachment[],
  ) => Promise<void>;
  automationDialogOpen: boolean;
  setAutomationDialogOpen: Dispatch<SetStateAction<boolean>>;
  editingAutomation: Automation | null;
  onSaveAutomation: (
    input: AutomationInput,
    id: string | null,
  ) => Promise<void>;
  settingsEverOpened: boolean;
  settingsOpen: boolean;
  closeSettings: () => void;
  storedProviders: string[];
  onSettingsSaved: () => void;
  openHistoryFromSettings: () => void;
  historyOpen: boolean;
  historyQuery: string;
  historyFrame: Screenshot | null;
  activityIds: Set<string>;
  unreadCompletedIds: Set<string>;
  recentWorkspaces: string[];
  temporaryWorkspaces: string[];
  hiddenWorkspaces: string[];
  collapsedWorkspaceDirs: Set<string>;
  expandedWorkspaceDirs: Set<string>;
  boardWorkspaceFilter: string | null;
  setBoardWorkspaceFilter: Dispatch<SetStateAction<string | null>>;
  onSelectChat: (id: string) => void;
  onNew: (nextWorkspaceDir?: string) => void;
  onNewSidebar: (nextWorkspaceDir?: string) => void;
  onRevealWorkspace: (dir: string) => Promise<void>;
  onArchiveWorkspaceChats: (dir: string) => Promise<void>;
  onRemoveWorkspace: (dir: string) => void;
  onReorderWorkspaces: (dirs: string[]) => void;
  toggleWorkspaceCollapsed: (dir: string) => void;
  toggleWorkspaceExpanded: (dir: string) => void;
  onArchive: (c: Conversation) => Promise<void>;
  onTogglePin: (c: Conversation) => Promise<void>;
  onRename: (c: Conversation, title: string) => Promise<void>;
  openSettings: () => void;
  updateReadyVersion: string | null;
  onRestartToUpdate: () => void;
  keyboardShortcuts: ShortcutMap;
  piReady: boolean;
  error: string | null;
  hasMessages: boolean;
  t: (key: string, vars?: Record<string, string | number>) => string;
  openWorkspacePanelLayout: (layout: WorkspaceLayout) => void;
  automations: Automation[];
  openNewAutomation: () => void;
  openEditAutomation: (a: Automation) => void;
  onToggleAutomation: (a: Automation, enabled: boolean) => Promise<void>;
  onRunAutomation: (a: Automation) => Promise<void>;
  onDeleteAutomation: (a: Automation) => Promise<void>;
  onOpenDetail: (id: string) => void;
  onApproveReview: (id: string) => Promise<void>;
  onRequestChanges: (c: Conversation) => void;
  loadingChatId: string | null;
  sideWorkspace: WorkspaceDockState;
  activeConvBackend: BackendId | null;
  onSend: (
    text: string,
    attachments?: ComposerAttachment[],
    runtime?: ComposerRuntimeSelection,
  ) => Promise<void>;
  onBash: (command: string) => void;
  onAbort: () => Promise<void>;
  onRetry: () => Promise<void>;
  activeConvInterrupted: boolean;
  onResumeInterrupted: () => void;
  onDismissInterrupted: () => void;
  activeIdRef: RefObject<string | null>;
  steerQueued: (convId: string, id: string) => void;
  focusToken: number;
  backendSwitch: ({ token: number } & RuntimeSwitchTarget) | null;
  requestBackendSwitch: (target: RuntimeSwitchTarget) => void;
  heroHeadline: string;
  isStreaming: boolean;
  renderWorkspaceDock: (layout: WorkspaceLayout) => JSX.Element | null;
}) {
  return (
    <SidebarProvider
      // Pin the shell to the window with `fixed inset-0` rather than a
      // viewport-height calc. CSS `zoom` (use-zoom) re-bases `svh` inside the
      // zoomed root on modern WebKit, so a `100svh/var(--zoom)` height would
      // double-compensate and drift as you ⌘+/⌘− — fixed insets fill the window
      // at any zoom. `!min-h-0` clears shadcn's `min-h-svh` so the sidebar's
      // `h-full` resolves against the window, not content. The shell background
      // also paints the gutter around the content card, so keep it tied to the
      // same sidebar token.
      className="fixed inset-0 !min-h-0 bg-sidebar"
      open={sidebarOpen}
      onOpenChange={setSidebarOpen}
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
      {paletteOpen && (
        <CommandPalette
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
          onSelectArchivedConversation={async (conv) => {
            setPaletteOpen(false);
            // Archived rows aren't in the sidebar list, so opening one means
            // restoring it first — the same path Settings › Archived uses —
            // then selecting it like any other chat. Push its metadata into
            // state directly so the pane doesn't wait on the next render of
            // `conversationsRef` (which onSelect reads after an await).
            try {
              const restored = await api.archiveConversation(conv.id, false);
              onSettingsConversationsChanged(restored);
              conversationsRef.current = mergeConversation(
                conversationsRef.current,
                restored,
              );
              setView("chat");
              onSelect(restored.id);
            } catch (e) {
              console.error("restore archived conversation failed", conv.id, e);
              toast.error(String(e));
            }
          }}
          onNewTask={() => {
            setPaletteOpen(false);
            setNewTaskOpen(true);
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
        />
      )}
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
        onForkMessage={(messageKey, messageIndex) => {
          const c = conversationsRef.current.find((x) => x.id === detailId);
          if (c) onFork(c, messageKey, messageIndex);
        }}
        focusToken={detailFocusToken}
        onRetry={onDetailRetry}
        retrying={retrying}
        queued={detailId ? queued[detailId] : undefined}
        onQueue={(text, atts, runtime, beforeIds) => {
          if (detailId)
            enqueueMessage(detailId, text, atts, runtime, beforeIds);
        }}
        onSteerQueued={
          detailConvBackend && !backendSupportsSteer(detailConvBackend)
            ? undefined
            : (id) => steerQueuedDetail(id)
        }
        onRemoveQueued={(id) => {
          if (detailId) removeQueued(detailId, id);
        }}
      />
      <ArtifactsDialog
        convId={activeId}
        title={conversations.find((c) => c.id === activeId)?.title}
        // Gate on chat view + a live artifact set so switching away (or a
        // conversation with no artifacts) can't leave a stale gallery open.
        open={view === "chat" && chatArtifactsOpen && activeHasArtifacts}
        onOpenChange={setChatArtifactsOpen}
      />
      <CreateTaskDialog
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        modelChoice={modelChoice}
        onModelChange={onModelChange}
        workspaceDir={workspaceDir}
        defaultWorkspace={defaultWorkspace}
        onWorkspaceChange={onWorkspaceChange}
        pendingBackend={pendingBackend}
        onPendingBackendChange={setPendingBackend}
        pendingCliModel={pendingCliModel}
        pendingCliEffort={pendingCliEffort}
        onPendingTuningChange={onPendingTuningChange}
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
          onSaved={onSettingsSaved}
          onConversationsChanged={onSettingsConversationsChanged}
          onOpenHistory={openHistoryFromSettings}
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
        streamingIds={activityIds}
        unreadCompletedIds={unreadCompletedIds}
        workspaceDirs={[...recentWorkspaces, ...temporaryWorkspaces]}
        hiddenWorkspaceDirs={hiddenWorkspaces.filter(
          (dir) => !temporaryWorkspaces.includes(dir),
        )}
        collapsedWorkspaceDirs={collapsedWorkspaceDirs}
        expandedWorkspaceDirs={expandedWorkspaceDirs}
        defaultWorkspace={defaultWorkspace}
        view={view}
        onViewChange={setView}
        workspaceFilter={boardWorkspaceFilter}
        onWorkspaceFilterChange={setBoardWorkspaceFilter}
        onSelect={onSelectChat}
        onNewTask={() => {
          if (view === "chat") {
            onNew();
          } else {
            setNewTaskOpen(true);
          }
        }}
        onNew={onNewSidebar}
        onRevealWorkspace={onRevealWorkspace}
        onArchiveWorkspaceChats={onArchiveWorkspaceChats}
        onRemoveWorkspace={onRemoveWorkspace}
        onReorderWorkspaces={onReorderWorkspaces}
        onToggleWorkspaceCollapsed={toggleWorkspaceCollapsed}
        onToggleWorkspaceExpanded={toggleWorkspaceExpanded}
        onArchive={onArchive}
        onTogglePin={onTogglePin}
        onRename={onRename}
        onOpenSettings={openSettings}
        updateReadyVersion={updateReadyVersion}
        onRestartToUpdate={onRestartToUpdate}
      />
      {/* Opaque card, no backdrop-filter: the shell root paints solid bg-sidebar,
          so a translucent+blurred card only re-blurred a flat color — at the cost
          of a full-window GPU recomposite on every repaint. */}
      <SidebarInset className="m-2 flex min-h-0 flex-col overflow-hidden rounded-xl border-[0.5px] border-border bg-background shadow-[inset_0_1px_0_rgb(255_255_255_/_0.45),0_3px_16px_rgb(0_0_0_/_0.045)] dark:shadow-[inset_0_1px_0_rgb(255_255_255_/_0.10),0_4px_18px_rgb(0_0_0_/_0.14)]">
        <div className="flex min-h-0 flex-1 flex-row">
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-10 items-center justify-end gap-3 px-4 text-xs text-muted-foreground">
              {/* With the sidebar collapsed, nothing else clears the macOS
                  traffic lights, so the content card takes over: a drag spacer
                  wide enough for the three lights, then the expand button in
                  the spot the sidebar's collapse button used to be. */}
              {!sidebarOpen && (
                <>
                  {shortcutPlatform() === "mac" && (
                    <div
                      data-tauri-drag-region
                      className="h-full w-14 shrink-0"
                    />
                  )}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        aria-label={tt("sidebar", "toggleSidebar")}
                        data-testid="sidebar-expand"
                        onClick={() => setSidebarOpen(true)}
                      >
                        <PanelLeft className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <span>{tt("sidebar", "toggleSidebar")}</span>
                      <Kbd>
                        {shortcutDisplay(keyboardShortcuts.toggleSidebar)}
                      </Kbd>
                    </TooltipContent>
                  </Tooltip>
                </>
              )}
              <div data-tauri-drag-region className="h-full flex-1" />
              {!piReady && (
                <span className="text-muted-foreground/70">○ connecting…</span>
              )}
              {/* With messages present, the failure surfaces inline at the end of
                the message list (see MessageError). Keep the header copy only as
                a fallback for errors that fire before any message exists
                (e.g. an attachment write failing on the very first send). */}
              {error && !hasMessages && (
                <span className="text-destructive">{error}</span>
              )}
              {view === "chat" && activeHasArtifacts && (
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  title={tt("board", "session.toggleArtifacts")}
                  aria-label={tt("board", "session.toggleArtifacts")}
                  onClick={() => setChatArtifactsOpen((v) => !v)}
                >
                  <Inbox className="size-3.5" />
                </Button>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={t("workspacePanel.openSide")}
                    data-testid="workspace-open-side"
                    onClick={() => openWorkspacePanelLayout("side")}
                  >
                    <PanelRight className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <span>{t("workspacePanel.openSide")}</span>
                  <Kbd>
                    {shortcutDisplay(keyboardShortcuts.toggleWorkspace)}
                  </Kbd>
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={t("workspacePanel.openBottom")}
                    data-testid="workspace-open-bottom"
                    onClick={() => openWorkspacePanelLayout("bottom")}
                  >
                    <PanelBottom className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <span>{t("workspacePanel.openBottom")}</span>
                  <Kbd>{shortcutDisplay(keyboardShortcuts.toggleTerminal)}</Kbd>
                </TooltipContent>
              </Tooltip>
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
                streamingIds={activityIds}
                onOpen={onOpenDetail}
                onArchive={onArchive}
                onApproveReview={onApproveReview}
                onRequestChanges={onRequestChanges}
              />
            ) : loadingChatId !== null &&
              loadingChatId === activeId &&
              !hasMessages ? (
              <ChatLoadingPane
                opticalCenter={sidebarOpen && !sideWorkspace.open}
              />
            ) : hasMessages ? (
              <ChatPane
                convId={activeId}
                backend={activeConvBackend ?? pendingBackend}
                opticalCenter={sidebarOpen && !sideWorkspace.open}
                draftKey={activeId ? `chat:${activeId}` : "chat:new"}
                modelChoice={modelChoice}
                onModelChange={onModelChange}
                workspaceDir={workspaceDir}
                defaultWorkspace={defaultWorkspace}
                onWorkspaceChange={onWorkspaceChange}
                onSend={onSend}
                onBash={onBash}
                onAbort={onAbort}
                onRetry={onRetry}
                interrupted={activeConvInterrupted}
                onResumeInterrupted={onResumeInterrupted}
                onDismissInterrupted={onDismissInterrupted}
                onForkMessage={(messageKey, messageIndex) => {
                  const c = conversationsRef.current.find(
                    (x) => x.id === activeIdRef.current,
                  );
                  if (c) onFork(c, messageKey, messageIndex);
                }}
                retrying={retrying}
                queued={activeId ? queued[activeId] : undefined}
                onQueue={(text, atts, runtime, beforeIds) => {
                  if (activeId)
                    enqueueMessage(activeId, text, atts, runtime, beforeIds);
                }}
                onSteerQueued={
                  // pi steers via RPC, claude-code over stdin, and codex uses
                  // Codex-app-style interrupt + resume. Hide this only for any
                  // future backend that lacks a running-turn steer path.
                  activeConvBackend && !backendSupportsSteer(activeConvBackend)
                    ? undefined
                    : (id) => {
                        if (activeId) steerQueued(activeId, id);
                      }
                }
                onRemoveQueued={(id) => {
                  if (activeId) removeQueued(activeId, id);
                }}
                focusToken={focusToken}
                disabled={!piReady}
                pendingBackend={pendingBackend}
                onPendingBackendChange={setPendingBackend}
                pendingCliModel={pendingCliModel}
                pendingCliEffort={pendingCliEffort}
                onPendingTuningChange={onPendingTuningChange}
                backendSwitch={backendSwitch}
                onRequestBackendSwitch={requestBackendSwitch}
              />
            ) : (
              <div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden px-6">
                <GlyphBackdrop />
                <div
                  className={`relative z-10 w-full max-w-2xl space-y-6 panel-motion transition-[translate] ${
                    !sidebarOpen || sideWorkspace.open
                      ? ""
                      : "xl:-translate-x-10 2xl:-translate-x-12"
                  }`}
                >
                  <h1 className="text-center font-serif text-4xl italic tracking-tight text-foreground">
                    {heroHeadline}
                  </h1>
                  <Composer
                    variant="hero"
                    focusToken={focusToken}
                    draftKey={activeId ? `chat:${activeId}` : "chat:new"}
                    disabled={!piReady}
                    streaming={isStreaming}
                    modelChoice={modelChoice}
                    onModelChange={onModelChange}
                    conversationId={activeId}
                    workspaceDir={workspaceDir}
                    defaultWorkspace={defaultWorkspace}
                    onWorkspaceChange={onWorkspaceChange}
                    onSend={onSend}
                    onBash={onBash}
                    onAbort={onAbort}
                    pendingBackend={pendingBackend}
                    onPendingBackendChange={setPendingBackend}
                    pendingCliModel={pendingCliModel}
                    pendingCliEffort={pendingCliEffort}
                    onPendingTuningChange={onPendingTuningChange}
                    backendSwitch={backendSwitch}
                    onRequestBackendSwitch={requestBackendSwitch}
                  />
                </div>
              </div>
            )}
          </div>
          {renderWorkspaceDock("side")}
        </div>
        {renderWorkspaceDock("bottom")}
      </SidebarInset>
    </SidebarProvider>
  );
}
