"use client";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react";
import type { ProcessBlock } from "@/lib/assistant-segments";
import { useTranslation } from "@/lib/i18n";
import { useDisclosure } from "@/lib/disclosure";
import { ToolUseCard, isCommandTool } from "./tool-use-card";
import { ThinkingBlock } from "./thinking-block";
import { TextBlock } from "./message-blocks";

/** A run of the agent's work (thinking, tool calls, narration between tool
 *  runs) folded into one summary line — "Ran 3 commands and used 2 other
 *  tools" — that expands the full timeline in place. Always collapsed by
 *  default, live or settled; the live "working" cue is the turn's
 *  WorkingIndicator, not this line. */
export function ActivityGroup({
  id,
  steps,
  relatedIds,
  stepIds,
  showTurnEnded = false,
}: {
  /** Stable id (conversation + turn) so the expanded state and the per-step
   *  expanders survive the virtualized list unmounting this turn. */
  id?: string;
  steps: ProcessBlock[];
  /** Source-stable ids preserve choices when adjacent groups merge. */
  relatedIds?: string[];
  stepIds?: string[];
  /** A tool/thinking tail is not a final reply; make the stopped turn explicit. */
  showTurnEnded?: boolean;
}) {
  const { t } = useTranslation("chat");
  const [open, toggle] = useDisclosure(id, false, relatedIds);

  let commands = 0;
  let tools = 0;
  let thinking = false;
  for (const s of steps) {
    if (s.kind === "thinking") thinking = true;
    if (s.kind !== "tool_use") continue;
    if (isCommandTool(s.name, s.args)) commands++;
    else tools++;
  }
  const plural = (key: string, count: number) => t(count === 1 ? key : `${key}_plural`, { count });
  const label =
    commands && tools
      ? t("activity.ranAndUsed", { commands: plural("activity.commands", commands), tools: plural("activity.otherTools", tools) })
      : commands
        ? t("activity.ran", { commands: plural("activity.commands", commands) })
        : tools
          ? t("activity.used", { tools: plural("activity.tools", tools) })
          : t(thinking ? "activity.thought" : "activity.updates");

  const timeline = steps.map((s, i) =>
    s.kind === "thinking" ? (
      <ThinkingBlock key={stepIds?.[i] ?? i} id={stepIds?.[i] ?? (id ? `${id}:s${i}` : undefined)} text={s.text} streaming={s.streaming} />
    ) : s.kind === "text" ? (
      // Intermediate narration between tool runs — full markdown, but
      // muted so the timeline still reads as process, not answer.
      <div key={stepIds?.[i] ?? i} className="px-2 py-1 text-muted-foreground">
        <TextBlock text={s.text} streaming={s.streaming} isUser={false} />
      </div>
    ) : (
      <ToolUseCard key={stepIds?.[i] ?? i} id={stepIds?.[i] ?? (id ? `${id}:s${i}` : undefined)} block={s} />
    ),
  );

  return (
    <div className="w-full max-w-[88%]">
      <button
        onClick={toggle}
        aria-expanded={open}
        className="group/activity flex items-center gap-2.5 py-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <Wrench className="size-3.5 shrink-0" />
        <span>
          {showTurnEnded ? `${t("activity.turnEnded")} · ` : ""}
          {label}
        </span>
        {open ? (
          <ChevronDown className="size-3.5 shrink-0" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover/activity:opacity-100" />
        )}
      </button>
      {open && <div className="mt-1 space-y-0.5">{timeline}</div>}
    </div>
  );
}

export { type ProcessBlock };
