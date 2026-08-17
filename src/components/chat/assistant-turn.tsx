"use client";
import { useCallback, useMemo } from "react";
import type { RenderedBlock, RenderedMessage } from "@/lib/types";
import { useMessagesByKeys } from "@/lib/chat-store";
import { artifactsFromDetails } from "@/lib/artifact";
import { useTranslation } from "@/lib/i18n";
import { AnswerBlock, MessageActions } from "./message-blocks";
import { messageHoverProps } from "./hover-owner";
import { ActivityGroup, type ProcessBlock } from "./activity-group";
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

type Segment =
  | {
      type: "activity";
      steps: ProcessBlock[];
      durationMs: number;
      /** Wall-clock start of the activity, for the live elapsed ticker. */
      startedAt: number;
      /** No answer content follows the activity yet — the turn is still all
       *  process, so the bar may show the running (spinner + ticker) state. */
      trailing: boolean;
    }
  | { type: "answer"; block: RenderedBlock };

/** Is this block part of the agent's "process" (folded into the activity
 *  timeline) rather than the answer? send_artifact renders as a rich preview, so
 *  it counts as answer even though it rides the tool-call plumbing. */
function isProcessBlock(b: RenderedBlock): b is Extract<ProcessBlock, { kind: "thinking" | "tool_use" }> {
  if (b.kind === "thinking") return true;
  if (b.kind === "tool_use")
    return !(b.result && artifactsFromDetails(b.result.details).length > 0);
  return false;
}

/** Segment the turn's blocks for display.
 *
 *  While the turn is LIVE, nothing extra folds: intermediate narration renders
 *  inline as it streams, and only consecutive thinking/tool runs group into
 *  small live activity bars — the same in-progress view as always.
 *
 *  Once the turn SETTLES, the whole work run (thinking + tool calls +
 *  intermediate narration, up to and including the last process block) folds
 *  into a single outer activity segment (codex-style); only what follows it
 *  (the final answer, artifact previews) stays expanded. Non-foldable blocks
 *  (artifacts, attachments) never fold regardless of position. */
function buildSegments(messages: RenderedMessage[], live: boolean): Segment[] {
  type Flat = { b: RenderedBlock; at: number };
  const flat: Flat[] = [];
  for (const m of messages) {
    for (const b of m.blocks) {
      // Settled empty thinking: transcripts persisted before the CLI opted
      // into a thinking display carry signature-only blocks with no text —
      // an empty "Thinking" step says nothing, drop it. A live empty block
      // (streaming) stays: its text is still arriving.
      if (b.kind === "thinking" && !b.text && !b.streaming) continue;
      flat.push({ b, at: m.createdAt });
    }
  }

  if (live) {
    // In-progress: narration stays inline; each run of consecutive process
    // blocks becomes its own live activity bar, exactly where it occurred.
    const segments: Segment[] = [];
    let run: { steps: ProcessBlock[]; min: number; max: number } | null = null;
    const flush = () => {
      if (run) {
        segments.push({
          type: "activity",
          steps: run.steps,
          durationMs: run.max - run.min,
          startedAt: run.min,
          trailing: false,
        });
        run = null;
      }
    };
    for (const { b, at } of flat) {
      if (isProcessBlock(b)) {
        if (!run) run = { steps: [], min: at, max: at };
        run.steps.push(b);
        run.min = Math.min(run.min, at);
        run.max = Math.max(run.max, at);
      } else {
        flush();
        segments.push({ type: "answer", block: b });
      }
    }
    flush();
    // Only a trailing activity (no answer after it yet) may show the running
    // spinner + live ticker state.
    const last = segments[segments.length - 1];
    if (last?.type === "activity") last.trailing = true;
    return segments;
  }

  let lastProc = -1;
  for (let i = 0; i < flat.length; i++) if (isProcessBlock(flat[i].b)) lastProc = i;

  // No process at all (plain text reply): no activity bar.
  if (lastProc === -1) return flat.map((f) => ({ type: "answer", block: f.b }));

  const segments: Segment[] = [];
  const steps: ProcessBlock[] = [];
  let min = Infinity;
  // The activity "ends" when the first post-process block (the answer) begins,
  // so the settled duration lands where the live ticker stopped instead of
  // jumping back to the last tool call's timestamp.
  let endAt = -Infinity;
  let activityIdx = -1;
  for (let i = 0; i < flat.length; i++) {
    const { b, at } = flat[i];
    const folds = i <= lastProc && (isProcessBlock(b) || b.kind === "text");
    if (folds) {
      if (activityIdx === -1) {
        activityIdx = segments.length;
        segments.push({ type: "activity", steps, durationMs: 0, startedAt: 0, trailing: false });
      }
      steps.push(b as ProcessBlock);
      min = Math.min(min, at);
      endAt = Math.max(endAt, at);
    } else {
      if (i === lastProc + 1) endAt = Math.max(endAt, at);
      segments.push({ type: "answer", block: b });
    }
  }
  segments[activityIdx] = {
    type: "activity",
    steps,
    durationMs: endAt - min,
    startedAt: min,
    trailing: lastProc === flat.length - 1,
  };
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
export function AssistantGroup({ convId, workspaceDir, keys, onFork, active = false }: Props) {
  const { t } = useTranslation("chat");
  const messages = useMessagesByKeys(convId, keys);
  // Recompute segments only when the merged messages actually change (the array
  // ref is stable between unrelated parent re-renders thanks to useShallow).
  // `active` flips once at settle, re-folding the live view into the single
  // collapsed activity.
  const segments = useMemo(() => buildSegments(messages, active), [messages, active]);
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
    <MarkdownWorkspaceContext.Provider value={workspaceDir ?? null}>
      <div className="flex w-full justify-start py-3">
        <div
          data-message-hover-target
          {...messageHoverProps}
          className="flex min-w-0 w-full flex-col gap-2 items-start"
        >
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("pane.assistant")}
          </div>
          <div className="flex min-w-0 w-full max-w-full flex-col gap-2">
            {segments.map((seg, i) =>
              seg.type === "activity" ? (
                <ActivityGroup
                  key={i}
                  // Live bars get positional ids; the settled whole-turn fold
                  // gets a fresh id so it starts collapsed regardless of what
                  // was toggled open mid-run.
                  id={`${convId ?? ""}:${keys[0]}:${active ? `a${i}` : "activity"}`}
                  steps={seg.steps}
                  durationMs={seg.durationMs}
                  startedAt={seg.startedAt}
                  active={active && seg.trailing}
                  plain={!active}
                />
              ) : (
                // Answer content and activity bars share the same 88% reading
                // width so the assistant turn keeps a consistent right edge.
                <div key={i} className="min-w-0 w-full max-w-[88%]">
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
