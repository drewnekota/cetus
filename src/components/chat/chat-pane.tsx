"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { ArtifactNavProvider } from "@/components/chat/artifact-view";
import type { RuntimeSwitchTarget } from "@/components/chat/backend-picker";
import { MessageListBoundary } from "@/components/chat/message-list-boundary";
import { AgentControlCard } from "@/components/chat/agent-control-card";
import { CliControlCard } from "@/components/chat/cli-control-card";
import { WallpaperFrame } from "@/components/chat/wallpaper-frame";
import { GlyphBackdrop } from "@/components/chat/glyph-backdrop";
import { Bot } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import {
  Composer,
  type ComposerAttachment,
  type ComposerDraftRequest,
  type ComposerRuntimeSelection,
  type QuoteRequest,
  type QueuedMessage,
} from "@/components/chat/composer";
import {
  useBackgroundTasks,
  useCompaction,
  useHasMessages,
  useIsStreaming,
  useRunningSubagents,
} from "@/lib/chat-store";
import { useTranslation } from "@/lib/i18n";
import { flavorHeadline } from "@/lib/chat-flavor";
import type { BackendId, ModelChoice } from "@/lib/types";
import { runtimeThemeStyle } from "@/lib/runtime-theme";
import { MessageList } from "./message-list";
import { QueuedMessages } from "./chat-status";

interface Props {
  /** Conversation id to subscribe to. Null means "new chat" — shows hero. */
  convId: string | null;
  /** Runtime currently serving this conversation. Drives status semantics and
   *  color only; the normalized turn/task events remain runtime-agnostic. */
  backend?: BackendId;
  modelChoice: ModelChoice;
  onModelChange: (next: ModelChoice) => void;
  workspaceDir: string | null;
  defaultWorkspace: string;
  onWorkspaceChange: (dir: string) => void;
  onSend: (
    text: string,
    attachments: ComposerAttachment[],
    runtime?: ComposerRuntimeSelection,
  ) => void;
  /** Route a leading-`!` command from the Composer to the Terminal surface. */
  onBash?: (command: string) => void;
  onAbort: () => void;
  /** Roll back + rerun the last failed turn — drives the inline error row's Retry button. */
  onRetry?: () => void;
  /** Copy the current conversation through a specific message into a new chat. */
  onForkMessage?: (messageKey: string, messageIndex: number) => void;
  /** Whether a retry is currently in flight (disables/animates the button). */
  retrying?: boolean;
  /** Follow-up queue (messages typed while the agent is mid-run). When omitted,
   *  the composer falls back to immediate steer while streaming. */
  queued?: QueuedMessage[];
  onQueue?: (
    text: string,
    attachments: ComposerAttachment[],
    runtime?: ComposerRuntimeSelection,
    beforeIds?: string[],
  ) => void;
  onSteerQueued?: (id: string) => void;
  onRemoveQueued?: (id: string) => void;
  focusToken: number;
  /** Persist the composer's unsent draft under this key (forwarded to Composer).
   *  Omit to keep the draft ephemeral (e.g. the detail dialog). */
  draftKey?: string;
  /** Headline shown above the composer when no messages exist yet. */
  emptyHeadline?: string;
  /** Visually pause the composer (e.g. detail dialog before history loads). */
  disabled?: boolean;
  /** Backend choice for the not-yet-created conversation (hero composer);
   *  forwarded to the Composer. See Composer's prop docs. */
  pendingBackend?: BackendId;
  onPendingBackendChange?: (backend: BackendId) => void;
  pendingCliModel?: string;
  pendingCliEffort?: string;
  onPendingTuningChange?: (model: string, effort: string) => void;
  /** Keyboard runtime-switch request (token-keyed), forwarded to the Composer. */
  backendSwitch?: ({ token: number } & RuntimeSwitchTarget) | null;
  /** Tab-to-cycle-runtime request, forwarded to the Composer. */
  onRequestBackendSwitch?: (target: RuntimeSwitchTarget) => void;
  /** Nudge the reading column toward the sidebar on wide desktop layouts.
   *  The main shell enables this only while the right workspace dock is closed;
   *  embedded/detail chat surfaces keep true geometric centering. */
  opticalCenter?: boolean;
  /** The last turn was cut down mid-run (app quit / update restart / crash) —
   *  show the resume banner above the composer. Hidden while streaming. */
  interrupted?: boolean;
  /** Resume the interrupted turn (sends a continuation prompt). */
  onResumeInterrupted?: () => void;
  /** Dismiss the interrupted-run banner without resuming. */
  onDismissInterrupted?: () => void;
}

/** The shared "chat experience" body — messages list + composer with
 *  workspace/model pickers. Used by the main chat view, the new-task dialog,
 *  and the session detail dialog so each one feels identical to compose in.
 *  Sticks to the bottom while streaming, releases stick when the user scrolls
 *  up (so reading older context doesn't fight live updates). */
export function ChatPane({
  convId,
  backend = "pi",
  modelChoice,
  onModelChange,
  workspaceDir,
  defaultWorkspace,
  onWorkspaceChange,
  onSend,
  onBash,
  onAbort,
  onRetry,
  onForkMessage,
  retrying,
  queued,
  onQueue,
  onSteerQueued,
  onRemoveQueued,
  focusToken,
  draftKey,
  emptyHeadline,
  disabled,
  pendingBackend,
  onPendingBackendChange,
  pendingCliModel,
  pendingCliEffort,
  onPendingTuningChange,
  backendSwitch,
  onRequestBackendSwitch,
  opticalCenter = false,
  interrupted,
  onResumeInterrupted,
  onDismissInterrupted,
}: Props) {
  const { locale } = useTranslation("chat");
  const hasMessages = useHasMessages(convId);
  const isStreaming = useIsStreaming(convId);
  const compaction = useCompaction(convId);
  const [quoteRequest, setQuoteRequest] = useState<QuoteRequest | null>(null);
  const [queuedDrafts, setQueuedDrafts] = useState<
    Record<string, { request: ComposerDraftRequest; beforeIds: string[] }>
  >({});
  const queuedDraftKey = convId ?? "new";
  const queuedDraft = queuedDrafts[queuedDraftKey] ?? null;
  const quoteIdRef = useRef(0);
  const queuedDraftIdRef = useRef(0);
  // A fresh greeting per new chat. Keyed on focusToken (bumped when "New chat"
  // is clicked) + convId + locale so it re-rolls on a new chat but stays put
  // across keystrokes/re-renders. An explicit emptyHeadline prop still wins.
  const randomHeadline = useMemo(
    () => flavorHeadline(locale),
    [locale, convId, focusToken],
  );
  const headline = emptyHeadline ?? randomHeadline;
  const addQuote = useCallback((text: string) => {
    quoteIdRef.current += 1;
    setQuoteRequest({ id: quoteIdRef.current, text });
  }, []);
  const editQueued = useCallback(
    (id: string) => {
      const index = (queued ?? []).findIndex((item) => item.id === id);
      if (index < 0) return;
      const item = queued![index];
      queuedDraftIdRef.current += 1;
      setQueuedDrafts((drafts) => ({
        ...drafts,
        [queuedDraftKey]: {
          request: {
            id: queuedDraftIdRef.current,
            text: item.text,
            attachments: item.attachments,
          },
          // Reinsert before the first successor that still exists when the
          // edited draft is submitted. This preserves FIFO order even if
          // earlier queued turns finish while the user is editing.
          beforeIds: queued!.slice(index + 1).map((successor) => successor.id),
        },
      }));
      onRemoveQueued?.(id);
    },
    [onRemoveQueued, queued, queuedDraftKey],
  );
  const queueFromComposer = useCallback(
    (
      text: string,
      attachments: ComposerAttachment[],
      runtime?: ComposerRuntimeSelection,
    ) => {
      onQueue?.(text, attachments, runtime, queuedDraft?.beforeIds);
      setQueuedDrafts((drafts) => {
        const { [queuedDraftKey]: _submitted, ...rest } = drafts;
        return rest;
      });
    },
    [onQueue, queuedDraft, queuedDraftKey],
  );
  const sendFromComposer = useCallback(
    (
      text: string,
      attachments: ComposerAttachment[],
      runtime?: ComposerRuntimeSelection,
    ) => {
      onSend(text, attachments, runtime);
      setQueuedDrafts((drafts) => {
        const { [queuedDraftKey]: _submitted, ...rest } = drafts;
        return rest;
      });
    },
    [onSend, queuedDraftKey],
  );

  if (!hasMessages) {
    return (
      <WallpaperFrame className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-6">
        <GlyphBackdrop />
        <div
          className={`relative z-10 w-full max-w-2xl space-y-5 panel-motion transition-[translate] ${
            opticalCenter ? "xl:-translate-x-10 2xl:-translate-x-12" : ""
          }`}
        >
          <h2 className="text-center font-serif text-3xl italic tracking-tight text-foreground">
            {headline}
          </h2>
          <Composer
            variant="hero"
            focusToken={focusToken}
            draftKey={draftKey}
            disabled={disabled}
            streaming={isStreaming}
            modelChoice={modelChoice}
            conversationId={convId}
            onModelChange={onModelChange}
            workspaceDir={workspaceDir}
            defaultWorkspace={defaultWorkspace}
            onWorkspaceChange={onWorkspaceChange}
            onSend={onSend}
            onBash={onBash}
            onAbort={onAbort}
            quoteRequest={quoteRequest}
            pendingBackend={pendingBackend}
            onPendingBackendChange={onPendingBackendChange}
            pendingCliModel={pendingCliModel}
            pendingCliEffort={pendingCliEffort}
            onPendingTuningChange={onPendingTuningChange}
            backendSwitch={backendSwitch}
            onRequestBackendSwitch={onRequestBackendSwitch}
          />
        </div>
      </WallpaperFrame>
    );
  }

  return (
    <WallpaperFrame className="flex min-h-0 flex-1 flex-col bg-background">
      <ArtifactNavProvider convId={convId}>
        <MessageListBoundary key={convId ?? "new"}>
          <MessageList
            convId={convId}
            workspaceDir={workspaceDir}
            isStreaming={isStreaming}
            onRetry={onRetry}
            onForkMessage={onForkMessage}
            retrying={retrying}
            onQuote={addQuote}
            opticalCenter={opticalCenter}
          />
        </MessageListBoundary>
      </ArtifactNavProvider>
      <div className="chat-composer-dock relative z-10 bg-background px-4 pb-3 pt-2">
        <div
          className={`mx-auto max-w-3xl space-y-2 panel-motion transition-[translate] ${
            opticalCenter ? "xl:-translate-x-10 2xl:-translate-x-12" : ""
          }`}
        >
          {convId ? (
            <BackgroundAgentsBar convId={convId} backend={backend} />
          ) : null}
          {interrupted && !isStreaming ? (
            <InterruptedBar
              onResume={onResumeInterrupted}
              onDismiss={onDismissInterrupted}
            />
          ) : null}
          {compaction.active ? (
            <CompactionBar reason={compaction.reason} />
          ) : null}
          {convId ? <CliControlCard convId={convId} /> : null}
          {convId ? <AgentControlCard conversationId={convId} /> : null}
          <QueuedMessages
            items={queued ?? []}
            onSteer={onSteerQueued}
            // Only one queue item can own the composer at a time. A second edit
            // would otherwise overwrite the first removed item's only draft.
            onEdit={onRemoveQueued && !queuedDraft ? editQueued : undefined}
            onRemove={onRemoveQueued}
          />
          <Composer
            variant="docked"
            focusToken={focusToken}
            draftKey={draftKey}
            disabled={disabled}
            streaming={isStreaming}
            modelChoice={modelChoice}
            conversationId={convId}
            onModelChange={onModelChange}
            workspaceDir={workspaceDir}
            defaultWorkspace={defaultWorkspace}
            onWorkspaceChange={onWorkspaceChange}
            onSend={sendFromComposer}
            onQueue={onQueue ? queueFromComposer : undefined}
            onSendFirstQueued={
              queued?.[0] && onSteerQueued
                ? () => onSteerQueued(queued[0].id)
                : undefined
            }
            onBash={onBash}
            onAbort={onAbort}
            draftRequest={queuedDraft?.request}
            quoteRequest={quoteRequest}
            backendSwitch={backendSwitch}
            onRequestBackendSwitch={onRequestBackendSwitch}
          />
        </div>
      </div>
    </WallpaperFrame>
  );
}

function CompactionBar({ reason }: { reason: string | null }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-sky-500/25 bg-sky-500/5 px-2.5 py-1.5 text-xs text-muted-foreground">
      <Spinner className="size-3 text-sky-600" />
      <span className="font-medium text-foreground">Compacting context…</span>
      {reason ? <span className="truncate">{reason}</span> : null}
    </div>
  );
}

/** Offer to pick an interrupted turn back up. Shown when the conversation's
 *  persisted run_state is "interrupted" — its last turn died mid-run (app
 *  quit, update restart, or crash) instead of settling. The boot sweep
 *  normally auto-resumes an interrupted run once, so reaching this banner
 *  means that automatic retry was already spent (the resumed run got cut
 *  down again) — the user decides whether to try once more. Resume continues
 *  the original task via the conversation's resumed session; dismiss just
 *  clears the marker. */
function InterruptedBar({
  onResume,
  onDismiss,
}: {
  onResume?: () => void;
  onDismiss?: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-2.5 py-1.5 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">Run interrupted</span>
      <span className="min-w-0 truncate">
        The last run was cut short by a restart.
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {onResume ? (
          <button
            type="button"
            onClick={onResume}
            className="rounded-md bg-foreground px-2 py-0.5 font-medium text-background transition-opacity hover:opacity-85"
          >
            Resume
          </button>
        ) : null}
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md border border-border px-2 py-0.5 font-medium text-foreground transition-colors hover:bg-muted"
          >
            Dismiss
          </button>
        ) : null}
      </span>
    </div>
  );
}

/** Awareness strip for background work owned by this conversation: subagents
 *  (for example, a CLI backend's run_in_background Agent/Task) and
 *  session-scoped tasks (Monitors, background Bash) that outlive model turns.
 *  Without it the composer just says "Agent is running…" with no hint of
 *  *what* — or, worse, the conversation looks idle while a Monitor is watching
 *  something and will wake the agent later. Two sources, merged: the bridge's
 *  live task registry (`cli_background_tasks` snapshots — authoritative for
 *  CLI backends, cleared when the session process exits) and the rendered
 *  cards' running-subagent details (covers pi-backend runs). Renders nothing
 *  when both are empty. */
function BackgroundAgentsBar({
  convId,
  backend,
}: {
  convId: string;
  backend: BackendId;
}) {
  const { t } = useTranslation("chat");
  const agents = useRunningSubagents(convId);
  const tasks = useBackgroundTasks(convId);
  if (agents.length === 0 && tasks.length === 0) return null;
  // Prefer the human task description; fall back to the agent/task type.
  const seen = new Set(tasks.map((task) => `${task.kind}|${task.description}`));
  const labels = [
    ...tasks.map((task) => task.description || task.kind),
    ...agents
      .filter((a) => !seen.has(`${a.type}|${a.description}`))
      .map((a) => a.description || a.type),
  ].filter(Boolean);
  const shown = labels.slice(0, 3).join(", ");
  const extra = labels.length - Math.min(labels.length, 3);
  return (
    <div
      style={{
        ...runtimeThemeStyle(backend),
        borderColor:
          "color-mix(in oklab, var(--runtime-color) 30%, transparent)",
        backgroundColor:
          "color-mix(in oklab, var(--runtime-color) 6%, transparent)",
      }}
      className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs text-muted-foreground"
    >
      <Bot className="size-3.5 shrink-0 text-[var(--runtime-color)]" />
      <Spinner className="size-3 text-[var(--runtime-color)]" />
      <span className="shrink-0 font-medium text-foreground">
        {t("pane.backgroundAgents.title", { count: labels.length })}
      </span>
      {shown ? (
        <span className="truncate">
          {shown}
          {extra > 0 ? t("pane.backgroundAgents.more", { count: extra }) : ""}
        </span>
      ) : null}
    </div>
  );
}
