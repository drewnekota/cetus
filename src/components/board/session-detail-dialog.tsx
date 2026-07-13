"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Folder, MessageSquare, X, Inbox, PanelBottom, PanelRight } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ChatPane } from "@/components/chat/chat-pane";
import { useRuntimeShortcuts } from "@/components/chat/backend-picker";
import type { ComposerAttachment, QueuedMessage } from "@/components/chat/composer";
import {
  WorkspacePanel,
  createTerminalViewState,
  type TerminalRunRequest,
  type TerminalViewState,
  type WorkspaceLayout,
  type WorkspaceTab,
  type WorkspaceTabKind,
} from "@/components/workspace/workspace-panel";
import { createBrowserViewState, type BrowserViewState } from "@/components/browser/browser-view";
import { ArtifactsDialog } from "@/components/board/artifacts-dialog";
import { useChatStore, useIsStreaming } from "@/lib/chat-store";
import { isArtifactDetails } from "@/lib/artifact";
import { formatTimestamp } from "@/lib/format";
import { useTranslation } from "@/lib/i18n";
import { workspaceName } from "@/lib/paths";
import { useShallow } from "zustand/react/shallow";
import type { BackendId, Conversation, ModelChoice } from "@/lib/types";

interface Props {
  /** Conversation row used to seed the header (title / workspace / timestamps). */
  conversation: Conversation | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Switch the main chat view to this conversation and close the dialog. */
  onOpenInChat: (id: string) => void;
  /** Whether the parent has finished its lazy history fetch. */
  loading?: boolean;
  modelChoice: ModelChoice;
  onModelChange: (next: ModelChoice) => void;
  workspaceDir: string | null;
  defaultWorkspace: string;
  onWorkspaceChange: (dir: string) => void;
  onSend: (text: string, attachments: ComposerAttachment[]) => void;
  onAbort: () => void;
  onForkMessage?: (messageKey: string, messageIndex: number) => void;
  focusToken: number;
  /** Roll back + rerun the last turn (Regenerate action + error-row Retry). */
  onRetry?: () => void;
  retrying?: boolean;
  /** Follow-up queue for this conversation (typed while the agent is mid-run). */
  queued?: QueuedMessage[];
  onQueue?: (
    text: string,
    attachments: ComposerAttachment[],
    beforeIds?: string[],
  ) => void;
  onSteerQueued?: (id: string) => void;
  onRemoveQueued?: (id: string) => void;
  /** Ultra Code state + toggle, forwarded to the composer. */
  ultra?: boolean;
  onUltraToggle?: () => void;
}

export function SessionDetailDialog({
  conversation,
  open,
  onOpenChange,
  onOpenInChat,
  loading,
  modelChoice,
  onModelChange,
  workspaceDir,
  defaultWorkspace,
  onWorkspaceChange,
  onSend,
  onAbort,
  onForkMessage,
  focusToken,
  onRetry,
  retrying,
  queued,
  onQueue,
  onSteerQueued,
  onRemoveQueued,
  ultra,
  onUltraToggle,
}: Props) {
  const { t } = useTranslation("board");
  const { t: tc } = useTranslation("chat");
  const convId = conversation?.id ?? null;
  const isStreaming = useIsStreaming(convId);

  // ⌃1/⌃2/⌃3 + Tab runtime switching for the open conversation. page.tsx's
  // global handler is modal-guarded while this dialog is up, so the dialog owns
  // its own token machinery; the docked Composer's BackendPicker applies each
  // token once against the conversation's backend.
  const backendSwitchToken = useRef(0);
  const [backendSwitch, setBackendSwitch] = useState<{
    token: number;
    backend: BackendId;
  } | null>(null);
  const requestBackendSwitch = useCallback((backend: BackendId) => {
    backendSwitchToken.current += 1;
    setBackendSwitch({ token: backendSwitchToken.current, backend });
  }, []);
  useRuntimeShortcuts(requestBackendSwitch, open);
  const hasChatEntry = useChatStore((s) =>
    convId ? convId in s.chats : false,
  );
  // Stable-shallow: re-renders only when artifact count actually changes.
  const artifactCount = useChatStore(
    useShallow((s) => {
      if (!convId) return 0;
      const c = s.chats[convId];
      if (!c) return 0;
      let n = 0;
      for (const m of c.messages) {
        for (const b of m.blocks) {
          if (
            b.kind === "tool_use" &&
            b.name === "send_artifact" &&
            b.result &&
            isArtifactDetails(b.result.details)
          ) {
            n++;
          }
        }
      }
      return n;
    }),
  );
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceLayout, setWorkspaceLayout] = useState<WorkspaceLayout>("side");
  const [workspaceTabs, setWorkspaceTabs] = useState<WorkspaceTab[]>([
    { id: "detail-files-1", kind: "files", title: tc("workspacePanel.files") },
  ]);
  const [workspaceActiveId, setWorkspaceActiveId] = useState<string | null>("detail-files-1");
  const workspaceTabsRef = useRef<WorkspaceTab[]>(workspaceTabs);
  const workspaceActiveIdRef = useRef<string | null>(workspaceActiveId);
  workspaceTabsRef.current = workspaceTabs;
  workspaceActiveIdRef.current = workspaceActiveId;

  useEffect(() => {
    if (!open || !workspaceOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (
        e.metaKey &&
        e.altKey &&
        !e.ctrlKey &&
        !e.shiftKey &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight")
      ) {
        e.preventDefault();
        switchWorkspaceTab(e.key === "ArrowRight" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, workspaceOpen]);

  function workspaceTitle(kind: WorkspaceTabKind, index: number): string {
    if (kind === "files") {
      return index > 1
        ? tc("workspacePanel.filesN", { index })
        : tc("workspacePanel.files");
    }
    if (kind === "terminal") {
      return index > 1
        ? tc("workspacePanel.terminalN", { index })
        : tc("workspacePanel.terminal");
    }
    return index > 1
      ? tc("workspacePanel.browserN", { index })
      : tc("workspacePanel.browser");
  }

  function openWorkspacePanel(layout: WorkspaceLayout) {
    setWorkspaceLayout(layout);
    setWorkspaceOpen(true);
  }

  function openWorkspaceTab(kind: WorkspaceTabKind, alwaysNew = false) {
    const existing = !alwaysNew ? workspaceTabs.find((tab) => tab.kind === kind) : undefined;
    if (existing) {
      setWorkspaceActiveId(existing.id);
      setWorkspaceOpen(true);
      return;
    }
    const count = workspaceTabs.filter((tab) => tab.kind === kind).length + 1;
    const tab: WorkspaceTab = {
      id: `detail-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind,
      title: workspaceTitle(kind, count),
      terminalState: kind === "terminal" ? createTerminalViewState() : undefined,
      browserState: kind === "browser" ? createBrowserViewState() : undefined,
    };
    setWorkspaceTabs((tabs) => [...tabs, tab]);
    setWorkspaceActiveId(tab.id);
    setWorkspaceOpen(true);
  }

  function closeWorkspaceTab(id: string) {
    setWorkspaceTabs((tabs) => {
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index === -1) return tabs;
      const next = tabs.filter((tab) => tab.id !== id);
      if (workspaceActiveId === id) {
        const fallback = next[Math.min(index, next.length - 1)] ?? null;
        setWorkspaceActiveId(fallback?.id ?? null);
        if (!fallback) setWorkspaceOpen(false);
      }
      return next;
    });
  }

  function switchWorkspaceTab(direction: 1 | -1) {
    const tabs = workspaceTabsRef.current;
    if (tabs.length < 2) return;
    const activeIndex = Math.max(
      0,
      tabs.findIndex((tab) => tab.id === workspaceActiveIdRef.current),
    );
    const nextIndex = (activeIndex + direction + tabs.length) % tabs.length;
    setWorkspaceActiveId(tabs[nextIndex].id);
    setWorkspaceOpen(true);
  }

  function updateBrowserWorkspaceTab(id: string, state: BrowserViewState) {
    setWorkspaceTabs((tabs) =>
      tabs.map((tab) =>
        tab.id === id && tab.kind === "browser"
          ? { ...tab, title: browserTitle(state.url, tab.title), browserState: state }
          : tab,
      ),
    );
  }

  function updateTerminalWorkspaceTab(id: string, state: TerminalViewState) {
    setWorkspaceTabs((tabs) =>
      tabs.map((tab) =>
        tab.id === id && tab.kind === "terminal"
          ? { ...tab, terminalState: state }
          : tab,
      ),
    );
  }

  function openTerminalWithCommand(commandRaw: string) {
    const command = commandRaw.trim();
    if (!command) return;
    const request: TerminalRunRequest = {
      id: `detail-term-run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      command,
      autoRun: true,
    };
    const target =
      workspaceTabs.find(
        (tab) => tab.id === workspaceActiveId && tab.kind === "terminal",
      ) ?? workspaceTabs.find((tab) => tab.kind === "terminal");
    if (target) {
      setWorkspaceTabs((tabs) =>
        tabs.map((tab) =>
          tab.id === target.id ? { ...tab, terminalRunRequest: request } : tab,
        ),
      );
      setWorkspaceActiveId(target.id);
      setWorkspaceOpen(true);
      return;
    }
    const count = workspaceTabs.filter((tab) => tab.kind === "terminal").length + 1;
    const tab: WorkspaceTab = {
      id: `detail-terminal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: "terminal",
      title: workspaceTitle("terminal", count),
      terminalState: createTerminalViewState(),
      terminalRunRequest: request,
    };
    setWorkspaceTabs((tabs) => [...tabs, tab]);
    setWorkspaceActiveId(tab.id);
    setWorkspaceOpen(true);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        // Stronger animation: a 92vw / 90vh dialog scaling from 95% looks
        // basically static — slide-up from -8 and fade with a longer duration
        // makes it read as a deliberate "card came up" gesture.
        className="flex h-[calc(100svh/var(--zoom,1)-2rem)] w-[calc(100svw/var(--zoom,1)-2rem)] max-w-none flex-col gap-0 overflow-hidden bg-background p-0 duration-250 data-[state=open]:slide-in-from-bottom-8 data-[state=closed]:slide-out-to-bottom-8 sm:max-w-none"
      >
        <DialogTitle className="sr-only">
          {conversation?.title || t("session.untitledTask")}
        </DialogTitle>
        <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">
              {conversation?.title || t("session.untitled")}
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
              {conversation && (
                <>
                  {conversation.workspaceDir === defaultWorkspace ? (
                    <MessageSquare className="size-3" />
                  ) : (
                    <Folder className="size-3" />
                  )}
                  <span
                    className="truncate"
                    title={
                      conversation.workspaceDir === defaultWorkspace
                        ? undefined
                        : conversation.workspaceDir
                    }
                  >
                    {conversation.workspaceDir === defaultWorkspace
                      ? t("card.defaultWorkspace")
                      : workspaceName(conversation.workspaceDir)}
                  </span>
                  <span>·</span>
                  <span>{t("session.updated", { time: formatTimestamp(conversation.updatedAt) })}</span>
                </>
              )}
              {isStreaming && (
                <>
                  <span>·</span>
                  <span className="inline-flex items-center gap-1.5 text-warning">
                    <span className="size-1.5 animate-pulse rounded-full bg-warning" />
                    {t("session.streaming")}
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {artifactCount > 0 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setArtifactsOpen((v) => !v)}
                title={t("session.toggleArtifacts")}
              >
                <Inbox className="mr-1 size-3.5" />
                {t("session.artifacts")}
                <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">
                  {artifactCount}
                </span>
              </Button>
            )}
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={() => openWorkspacePanel("side")}
              title={tc("workspacePanel.openSide")}
              aria-label={tc("workspacePanel.openSide")}
            >
              <PanelRight className="size-4" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={() => openWorkspacePanel("bottom")}
              title={tc("workspacePanel.openBottom")}
              aria-label={tc("workspacePanel.openBottom")}
            >
              <PanelBottom className="size-4" />
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => conversation && onOpenInChat(conversation.id)}
              disabled={!conversation}
            >
              {t("session.openInChat")}
              <ArrowRight className="ml-1 size-3.5" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              title={t("session.close")}
            >
              <X className="size-4" />
            </Button>
          </div>
        </header>

        {/* Show a skeleton transcript only while we have no chat entry yet AND
            the parent says it's loading — once the entry exists, ChatPane's own
            empty/hero state takes over and avoids a flash. A shaped skeleton
            (vs a lone spinner) reads as "content is coming" and matches the
            chat layout the dialog is about to show. */}
        {loading && !hasChatEntry ? (
          <ChatSkeleton />
        ) : (
          <div
            className={
              workspaceOpen && workspaceLayout === "bottom"
                ? "flex min-h-0 flex-1 flex-col"
                : "flex min-h-0 flex-1 flex-row"
            }
          >
            <div className="flex min-w-0 flex-1 flex-col">
              <ChatPane
                convId={convId}
                modelChoice={modelChoice}
                onModelChange={onModelChange}
                workspaceDir={workspaceDir}
                defaultWorkspace={defaultWorkspace}
                onWorkspaceChange={onWorkspaceChange}
                onSend={onSend}
                onBash={openTerminalWithCommand}
                onAbort={onAbort}
                onRegenerate={retrying ? undefined : onRetry}
                onRetry={onRetry}
                retrying={retrying}
                onForkMessage={onForkMessage}
                queued={queued}
                onQueue={onQueue}
                onSteerQueued={onSteerQueued}
                onRemoveQueued={onRemoveQueued}
                ultra={ultra}
                onUltraToggle={onUltraToggle}
                backendSwitch={backendSwitch}
                onRequestBackendSwitch={requestBackendSwitch}
                focusToken={focusToken}
                disabled={!conversation}
              />
            </div>
            {workspaceOpen && (
              <WorkspacePanel
                tabs={workspaceTabs}
                activeId={workspaceActiveId}
                workspaceDir={workspaceDir}
                defaultWorkspace={defaultWorkspace}
                onSelect={(id) => {
                  setWorkspaceActiveId(id);
                  setWorkspaceOpen(true);
                }}
                onClose={closeWorkspaceTab}
                onClosePanel={() => setWorkspaceOpen(false)}
                onNewTab={(kind) => openWorkspaceTab(kind, true)}
                layout={workspaceLayout}
                onUpdateTerminalTab={updateTerminalWorkspaceTab}
                onUpdateBrowserTab={updateBrowserWorkspaceTab}
                onAnnotate={async (message) => {
                  await onSend(message, []);
                }}
              />
            )}
          </div>
        )}
        <ArtifactsDialog
          convId={convId}
          title={conversation?.title}
          // Gate on the parent `open` too so closing the detail dialog can't
          // leave a stale artifacts dialog queued for the next conversation.
          open={open && artifactsOpen && artifactCount > 0}
          onOpenChange={setArtifactsOpen}
        />
      </DialogContent>
    </Dialog>
  );
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

/** Skeleton transcript shown while a cold (never-opened-this-session) card's
 *  history loads — mirrors the user-right / assistant-left bubble rhythm. */
function ChatSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 py-6">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <div className="flex justify-end">
          <Skeleton className="h-10 w-2/5 rounded-2xl" />
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-2.5 w-14" />
          <Skeleton className="h-3 w-11/12" />
          <Skeleton className="h-3 w-4/5" />
          <Skeleton className="h-3 w-2/3" />
        </div>
        <div className="flex justify-end">
          <Skeleton className="h-10 w-1/3 rounded-2xl" />
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-2.5 w-14" />
          <Skeleton className="h-3 w-10/12" />
          <Skeleton className="h-3 w-3/5" />
        </div>
      </div>
    </div>
  );
}
