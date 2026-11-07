import { artifactsFromDetails } from "./artifact";
import type { RenderedBlock, RenderedMessage } from "./types";

export type ProcessBlock = Extract<RenderedBlock, { kind: "thinking" | "tool_use" | "text" }>;
export type AssistantSegment =
  | {
      type: "activity";
      key: string;
      steps: ProcessBlock[];
      stepKeys: string[];
      durationMs: number;
      startedAt: number;
      trailing: boolean;
    }
  | { type: "answer"; key: string; block: RenderedBlock };

/** A coordinator's successful thread_start / thread_send: shown as a thread
 *  card, never folded into steps. */
function isThreadCard(b: RenderedBlock): boolean {
  return b.kind === "tool_use" && (b.name === "thread_start" || b.name === "thread_send") &&
    !!b.result && !b.result.isError;
}

function isProcess(b: RenderedBlock): b is Extract<ProcessBlock, { kind: "thinking" | "tool_use" }> {
  return b.kind === "thinking" || (b.kind === "tool_use" && !isThreadCard(b) &&
    !(b.result && artifactsFromDetails(b.result.details).length > 0));
}

/** One display policy for pi, Claude Code, Codex and every ACP backend.
 * Explicit final-answer text is always retained. Without phase metadata,
 * keep the last text run and everything after it. Content chunks are not
 * necessarily separate answers, so adjacent text blocks stay together.
 * Failed and unfinished attempts fold like successful steps; every run
 * starts collapsed. Artifacts are barriers: folding must never reorder
 * activity across them. Keys follow source blocks, not live state. */
export function buildAssistantSegments(messages: RenderedMessage[], live: boolean): AssistantSegment[] {
  const flat = messages.flatMap((m) => m.blocks.flatMap((b, index) => {
    if ((b.kind === "thinking" || b.kind === "text") && !b.text.trim() && !b.streaming) return [];
    return [{ b, key: `${m.key}:${index}`, at: m.createdAt }];
  }));
  let boundary = -1;
  let hasProcess = false;
  let lastProcess = -1;
  for (let i = 0; i < flat.length; i++) {
    const b = flat[i].b;
    if (isProcess(b)) {
      hasProcess = true;
      lastProcess = i;
    }
    if (b.kind === "text" && b.text.trim()) boundary = i;
  }
  // Preserve a whole trailing text run, including providers that split a
  // reply into multiple blocks. Empty placeholders above were filtered out.
  while (boundary > 0 && flat[boundary - 1].b.kind === "text") boundary--;
  if (boundary < 0) {
    // Tool-only/image-only turns still show their latest useful item rather
    // than disappearing into a bare step count.
    boundary = Math.max(0, flat.length - 1);
  }

  const segments: AssistantSegment[] = [];
  let run: Extract<AssistantSegment, { type: "activity" }> | null = null;
  const closeRun = (at?: number) => {
    if (run && at !== undefined) run.durationMs = Math.max(run.durationMs, at - run.startedAt);
    run = null;
  };
  for (let i = 0; i < flat.length; i++) {
    const { b, key, at } = flat[i];
    const process = isProcess(b);
    const keepText = b.kind === "text" && b.phase === "final_answer";
    // Live: narration followed by more work folds into the one collapsed
    // group as soon as the next step starts; only text after the last step
    // stays out, since it may be the answer.
    const foldText = b.kind === "text" && !keepText && hasProcess &&
      (live ? i < lastProcess : i < boundary);
    if (!process && !foldText) {
      closeRun(at);
      segments.push({ type: "answer", key, block: b });
      continue;
    }
    // Every run starts collapsed; only visible content splits runs.
    if (!run) {
      run = { type: "activity", key, steps: [], stepKeys: [], startedAt: at, durationMs: 0, trailing: false };
      segments.push(run);
    }
    const end = Math.max(run.startedAt + run.durationMs, at);
    run.startedAt = Math.min(run.startedAt, at);
    run.durationMs = end - run.startedAt;
    run.steps.push(b as ProcessBlock);
    run.stepKeys.push(key);
  }
  const last = segments.at(-1);
  if (last?.type === "activity") last.trailing = true;
  return segments;
}
