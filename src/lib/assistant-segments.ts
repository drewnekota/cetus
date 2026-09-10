import { artifactsFromDetails } from "./artifact";
import { toolActivityStatus } from "./tool-status";
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
      defaultOpen: boolean;
    }
  | { type: "answer"; key: string; block: RenderedBlock };

function isProcess(b: RenderedBlock): b is Extract<ProcessBlock, { kind: "thinking" | "tool_use" }> {
  return b.kind === "thinking" || (b.kind === "tool_use" &&
    !(b.result && artifactsFromDetails(b.result.details).length > 0));
}

/** One display policy for pi, Claude Code, Codex and every ACP backend.
 * Explicit final-answer text is always retained. Without phase metadata,
 * keep the last text run and everything after it. Content chunks are not
 * necessarily separate answers, so adjacent text blocks stay together.
 * Failed attempts fold like successful steps. Artifacts and unfinished
 * tools are barriers: folding must never
 * reorder activity across them. Keys follow source blocks, not live state. */
export function buildAssistantSegments(messages: RenderedMessage[], live: boolean): AssistantSegment[] {
  const flat = messages.flatMap((m) => m.blocks.flatMap((b, index) => {
    if ((b.kind === "thinking" || b.kind === "text") && !b.text.trim() && !b.streaming) return [];
    return [{ b, key: `${m.key}:${index}`, at: m.createdAt }];
  }));
  let boundary = -1;
  let hasProcess = false;
  for (let i = 0; i < flat.length; i++) {
    const b = flat[i].b;
    if (isProcess(b)) hasProcess = true;
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
  type Mode = "history" | "tail" | "attention" | "live";
  let run: Extract<AssistantSegment, { type: "activity" }> | null = null;
  let runMode: Mode | null = null;
  const closeRun = (at?: number) => {
    if (run && at !== undefined) run.durationMs = Math.max(run.durationMs, at - run.startedAt);
    run = null;
    runMode = null;
  };
  for (let i = 0; i < flat.length; i++) {
    const { b, key, at } = flat[i];
    const process = isProcess(b);
    const status = b.kind === "tool_use" ? toolActivityStatus(b) : null;
    const attention = status === "running" || status === "incomplete";
    const keepText = b.kind === "text" && b.phase === "final_answer";
    const foldText = !live && hasProcess && i < boundary && b.kind === "text" && !keepText;
    if (!process && !foldText) {
      closeRun(at);
      segments.push({ type: "answer", key, block: b });
      continue;
    }
    const mode: Mode = live ? "live" : attention ? "attention" : i < boundary ? "history" : "tail";
    if (!run || runMode !== mode) {
      closeRun(at);
      run = {
        type: "activity", key, steps: [], stepKeys: [], startedAt: at,
        durationMs: 0, trailing: false,
        defaultOpen: !live && mode !== "history",
      };
      runMode = mode;
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
