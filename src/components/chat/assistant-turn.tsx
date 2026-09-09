"use client";
import { useCallback, useMemo } from "react";
import type { RenderedMessage } from "@/lib/types";
import { useMessagesByKeys } from "@/lib/chat-store";
import { buildAssistantSegments } from "@/lib/assistant-segments";
import { useTranslation } from "@/lib/i18n";
import { AnswerBlock, MessageActions } from "./message-blocks";
import { messageHoverProps } from "./hover-owner";
import { ActivityGroup } from "./activity-group";
import { MarkdownWorkspaceContext } from "@/lib/markdown";

interface Props {
  convId: string | null;
  workspaceDir?: string | null;
  /** Keys of the consecutive assistant (+tool) messages merged into this turn. */
  keys: string[];
  /** Copy this conversation through this assistant turn into a new conversation. */
  onFork?: () => void;
  /** This is the trailing assistant group of an agent turn that is still open. */
  active?: boolean;
}

function answerText(messages: RenderedMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.kind === "text") parts.push(b.text);
    }
  }
  return parts.join("\n\n").trim();
}

/** A whole assistant turn — one or more consecutive assistant messages rendered
 *  under a single ASSISTANT header. Tool calls + thinking collapse into compact
 *  activity widgets; the natural-language answer stays expanded below. */
export function AssistantGroup({ convId, workspaceDir, keys, onFork, active = false }: Props) {
  const { t } = useTranslation("chat");
  const messages = useMessagesByKeys(convId, keys);
  // Recompute segments only when the merged messages actually change (the array
  // ref is stable between unrelated parent re-renders thanks to useShallow).
  // Settled turns retain the last text and its following tool runs.
  const segments = useMemo(() => buildAssistantSegments(messages, active), [messages, active]);
  // Cheap, short-circuiting check for "is there any answer text" — replaces
  // joining the whole answer string on every render just to gate the copy button.
  const hasAnswerText = useMemo(
    () =>
      messages.some((m) =>
        m.blocks.some((b) => b.kind === "text" && b.text.trim().length > 0),
      ),
    [messages],
  );
  // Built only when the user actually copies (see MessageActions.getText).
  const getAnswerText = useCallback(() => answerText(messages), [messages]);
  if (messages.length === 0) return null;

  // No visible content yet: mid-run this is the gap between the message
  // opening and the first block streaming in — hold the shimmer instead of a
  // bare ASSISTANT header. A settled empty turn renders nothing at all.
  if (segments.length === 0) {
    if (!active) return null;
    return (
      <div className="flex w-full justify-start py-3">
        <div className="flex max-w-[88%] flex-col gap-2 items-start">
          <div className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
            {t("pane.assistant")}
          </div>
          <span className="animate-shimmer-text text-sm font-medium">
            {t("pane.thinking")}
          </span>
        </div>
      </div>
    );
  }

  const lastCreatedAt = messages[messages.length - 1].createdAt;

  return (
    <MarkdownWorkspaceContext.Provider value={workspaceDir ?? null}>
      <div className="flex w-full justify-start py-3">
        <div
          data-message-hover-target
          {...messageHoverProps}
          className="flex min-w-0 w-full flex-col gap-2 items-start"
        >
          <div className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
            {t("pane.assistant")}
          </div>
          <div className="flex min-w-0 w-full max-w-full flex-col gap-2">
            {segments.map((seg) =>
              seg.type === "activity" ? (
                <ActivityGroup
                  key={seg.key}
                  id={`${convId ?? ""}:activity:${seg.key}`}
                  relatedIds={seg.stepKeys.map((key) => `${convId ?? ""}:activity:${key}`)}
                  stepIds={seg.stepKeys.map((key) => `${convId ?? ""}:block:${key}`)}
                  steps={seg.steps}
                  durationMs={seg.durationMs}
                  startedAt={seg.startedAt}
                  active={active && seg.trailing}
                  plain={!active}
                  defaultOpen={seg.defaultOpen}
                  showTurnEnded={!active && seg.trailing}
                />
              ) : (
                // Answer content and activity bars share the same 88% reading
                // width so the assistant turn keeps a consistent right edge.
                <div key={seg.key} className="min-w-0 w-full max-w-[88%]">
                  <AnswerBlock block={seg.block} isUser={false} />
                </div>
              ),
            )}
          </div>
          <MessageActions
            getText={getAnswerText}
            hasText={hasAnswerText}
            createdAt={lastCreatedAt}
            isUser={false}
            onFork={onFork}
          />
        </div>
      </div>
    </MarkdownWorkspaceContext.Provider>
  );
}
