"use client";
import { useCallback, useMemo } from "react";
import type { RenderedBlock, RenderedMessage } from "@/lib/types";
import { useIsStreaming, useMessagesByKeys } from "@/lib/chat-store";
import { isArtifactDetails } from "@/lib/artifact";
import { useTranslation } from "@/lib/i18n";
import { AnswerBlock, MessageActions } from "./message-blocks";
import { ActivityGroup, type ProcessBlock } from "./activity-group";

interface Props {
  convId: string | null;
  /** Keys of the consecutive assistant (+tool) messages merged into this turn. */
  keys: string[];
  /** Wired only on the final group, once settled — shows Regenerate. */
  onRegenerate?: () => void;
  /** Copy this conversation through this assistant turn into a new conversation. */
  onFork?: () => void;
}

type Segment =
  | { type: "activity"; steps: ProcessBlock[]; durationMs: number }
  | { type: "answer"; block: RenderedBlock };

/** Is this block part of the agent's "process" (folded into the activity
 *  timeline) rather than the answer? send_artifact renders as a rich preview, so
 *  it counts as answer even though it rides the tool-call plumbing. */
function isProcessBlock(b: RenderedBlock): b is ProcessBlock {
  if (b.kind === "thinking") return true;
  if (b.kind === "tool_use") {
    if (b.name === "send_artifact" && b.result && isArtifactDetails(b.result.details)) return false;
    return true;
  }
  return false;
}

/** Walk every block across the merged messages in order, collapsing each run of
 *  consecutive process blocks into one activity segment and leaving answer
 *  blocks inline. Order is preserved, so an answer that lands between two tool
 *  runs splits the activity exactly where it occurred. */
function buildSegments(messages: RenderedMessage[]): Segment[] {
  const segments: Segment[] = [];
  let run: { steps: ProcessBlock[]; min: number; max: number } | null = null;
  const flush = () => {
    if (run) {
      segments.push({ type: "activity", steps: run.steps, durationMs: run.max - run.min });
      run = null;
    }
  };
  for (const m of messages) {
    for (const b of m.blocks) {
      if (isProcessBlock(b)) {
        if (!run) run = { steps: [], min: m.createdAt, max: m.createdAt };
        run.steps.push(b);
        run.min = Math.min(run.min, m.createdAt);
        run.max = Math.max(run.max, m.createdAt);
      } else {
        flush();
        segments.push({ type: "answer", block: b });
      }
    }
  }
  flush();
  return segments;
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
export function AssistantGroup({ convId, keys, onRegenerate, onFork }: Props) {
  const { t } = useTranslation("chat");
  const messages = useMessagesByKeys(convId, keys);
  // Recompute segments only when the merged messages actually change (the array
  // ref is stable between unrelated parent re-renders thanks to useShallow).
  const segments = useMemo(() => buildSegments(messages), [messages]);
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
  const isStreaming = useIsStreaming(convId);
  if (messages.length === 0) return null;

  // No visible content yet: mid-run this is the gap between the message
  // opening and the first block streaming in — hold the shimmer instead of a
  // bare ASSISTANT header. A settled empty turn renders nothing at all.
  if (segments.length === 0) {
    if (!isStreaming) return null;
    return (
      <div className="flex w-full justify-start py-3">
        <div className="flex max-w-[88%] flex-col gap-2 items-start">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
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
    <div className="group/msg flex w-full justify-start py-3">
      <div className="flex w-full max-w-[88%] flex-col gap-2 items-start">
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {t("pane.assistant")}
        </div>
        <div className="flex w-full max-w-full flex-col gap-2">
          {segments.map((seg, i) =>
            seg.type === "activity" ? (
              <ActivityGroup
                key={i}
                id={`${convId ?? ""}:${keys[0]}:a${i}`}
                steps={seg.steps}
                durationMs={seg.durationMs}
              />
            ) : (
              <AnswerBlock key={i} block={seg.block} isUser={false} />
            ),
          )}
        </div>
        <MessageActions
          getText={getAnswerText}
          hasText={hasAnswerText}
          createdAt={lastCreatedAt}
          isUser={false}
          onRegenerate={onRegenerate}
          onFork={onFork}
        />
      </div>
    </div>
  );
}
