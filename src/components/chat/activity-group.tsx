"use client";
import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import type { RenderedBlock } from "@/lib/types";
import { useTranslation } from "@/lib/i18n";
import { ToolUseCard, summarizeArgs, subagentInfo } from "./tool-use-card";
import { ThinkingBlock } from "./thinking-block";

type ProcessBlock = Extract<RenderedBlock, { kind: "thinking" | "tool_use" }>;

/** Render a run of consecutive process blocks (thinking + tool calls) as a
 *  single collapsible activity. Collapsed by default — while the agent is
 *  running the header updates in place to show the current action (so the list
 *  doesn't grow a card per step); once settled it shows a "Worked for Xs · N
 *  steps" summary that expands to the full timeline. */
export function ActivityGroup({
  steps,
  durationMs,
}: {
  steps: ProcessBlock[];
  durationMs: number;
}) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);

  const running = steps.some((s) => s.streaming === true);
  const hasError = steps.some((s) => s.kind === "tool_use" && s.result?.isError);
  const toolCount = steps.reduce((n, s) => (s.kind === "tool_use" ? n + 1 : n), 0);
  const dur = formatDuration(durationMs);

  // While running: surface what's happening right now in the header.
  const current = running ? currentAction(steps) : null;

  return (
    <div className="w-full rounded-md border border-border/60 bg-muted/30">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        )}
        {running ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        ) : hasError ? (
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-warning" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
        )}
        {running ? (
          <>
            <span className="shrink-0 font-medium text-foreground">{t("activity.working")}</span>
            {current && (
              <span className="min-w-0 truncate font-mono text-[11px]">· {current}</span>
            )}
          </>
        ) : (
          <span className="min-w-0 truncate">
            <span className="font-medium text-foreground">
              {toolCount > 0
                ? t(toolCount === 1 ? "agent.step" : "agent.step_plural", { count: toolCount })
                : t("activity.thought")}
            </span>
            {dur && <span> · {dur}</span>}
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-0.5 border-t border-border/40 px-1.5 py-1.5">
          {steps.map((s, i) =>
            s.kind === "thinking" ? (
              <ThinkingBlock key={i} text={s.text} streaming={s.streaming} />
            ) : (
              <ToolUseCard key={i} block={s} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** A short label for the step currently in flight (or the most recent one), used
 *  in the live header: a running tool shows its name + arg preview; thinking
 *  shows the "Thinking" label. */
function currentAction(steps: ProcessBlock[]): string {
  const active = [...steps].reverse().find((s) => s.streaming === true) ?? steps[steps.length - 1];
  if (!active) return "";
  if (active.kind === "thinking") return "thinking";
  // A running subagent (claude-code Task/Agent) streams its live status into
  // the card's result — surface that instead of the frozen launch args, so
  // the collapsed header tracks what the subagent is doing right now.
  const sub = subagentInfo(active.result?.details);
  if (sub) {
    const content = active.result?.content;
    const status =
      Array.isArray(content) && content[0]?.type === "text" ? content[0].text : "";
    const live = status || sub.description;
    return live ? `${active.name} ${live}` : active.name || "";
  }
  const preview = summarizeArgs(active.args);
  return preview ? `${active.name} ${preview}` : active.name || "";
}

function formatDuration(ms: number): string | null {
  if (!ms || ms < 1000) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

export { type ProcessBlock };
