"use client";
import { useState } from "react";
import { ArrowRight, Folder, X, Inbox } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ChatPane } from "@/components/chat/chat-pane";
import type { ComposerAttachment } from "@/components/chat/composer";
import { ArtifactsDialog } from "@/components/board/artifacts-dialog";
import { useChatStore, useIsStreaming } from "@/lib/chat-store";
import { isArtifactDetails } from "@/lib/artifact";
import { formatTimestamp } from "@/lib/format";
import { useTranslation } from "@/lib/i18n";
import { workspaceName } from "@/lib/paths";
import { useShallow } from "zustand/react/shallow";
import type { Conversation, ModelChoice } from "@/lib/types";

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
  /** Run a local `!` bash-mode command in this conversation's workspace. */
  onBash?: (command: string) => void;
  onAbort: () => void;
  focusToken: number;
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
  onBash,
  onAbort,
  focusToken,
}: Props) {
  const { t } = useTranslation("board");
  const convId = conversation?.id ?? null;
  const isStreaming = useIsStreaming(convId);
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
                  <Folder className="size-3" />
                  <span className="truncate" title={conversation.workspaceDir}>
                    {workspaceName(conversation.workspaceDir)}
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
          <div className="flex min-h-0 flex-1 flex-col">
            <ChatPane
              convId={convId}
              modelChoice={modelChoice}
              onModelChange={onModelChange}
              workspaceDir={workspaceDir}
              defaultWorkspace={defaultWorkspace}
              onWorkspaceChange={onWorkspaceChange}
              onSend={onSend}
              onBash={onBash}
              onAbort={onAbort}
              focusToken={focusToken}
              disabled={!conversation}
            />
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
