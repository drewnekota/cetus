"use client";
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, CheckCircle2, AlertCircle } from "lucide-react";
import type { RenderedBlock } from "@/lib/types";
import { useTranslation } from "@/lib/i18n";
import { useDisclosure } from "@/lib/disclosure";
import { Spinner } from "@/components/ui/spinner";
import { ToolUseCard, summarizeArgs, subagentInfo } from "./tool-use-card";
import { ThinkingBlock } from "./thinking-block";
import { TextBlock } from "./message-blocks";

/** Steps foldable into the activity timeline: thinking, tool calls, and
 *  intermediate narration text the agent emitted between tool runs. */
type ProcessBlock = Extract<RenderedBlock, { kind: "thinking" | "tool_use" | "text" }>;

/** Render a run of the agent's work (thinking + tool calls + intermediate
 *  narration) as a single collapsible activity. Collapsed by default — while
 *  the agent is running the header updates in place to show a live elapsed
 *  timer and the current action (so the list doesn't grow a card per step);
 *  once the turn settles the whole run renders as `plain`: a bare
 *  "Worked for Xs" text line (no card chrome) that expands the full timeline
 *  in place. */
export function ActivityGroup({
  id,
  steps,
  durationMs,
  startedAt,
  active,
  plain = false,
}: {
  /** Stable id (conversation + turn) so the expanded state and the per-step
   *  expanders survive the virtualized list unmounting this turn. */
  id?: string;
  steps: ProcessBlock[];
  durationMs: number;
  /** Wall-clock start of the activity; drives the live elapsed timer. */
  startedAt?: number;
  /** The whole agent turn is still open and no answer has started after this
   *  activity. Individual tool blocks settle between calls, so their
   *  `streaming` flag alone is not a reliable indication of completion. */
  active: boolean;
  /** Settled whole-turn fold: render as a bare text disclosure line instead of
   *  the boxed live activity bar — no extra nesting chrome. */
  plain?: boolean;
}) {
  const { t } = useTranslation("chat");
  const [open, toggle] = useDisclosure(id);

  const running = active || steps.some((s) => s.kind !== "text" && s.streaming === true);

  // Live elapsed timer while running; freezes into `durationMs` on settle.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const liveDur = running && startedAt ? formatDuration(now - startedAt) : null;
  const hasError = steps.some((s) => s.kind === "tool_use" && s.result?.isError);
  const toolCount = steps.reduce((n, s) => (s.kind === "tool_use" ? n + 1 : n), 0);
  const dur = formatDuration(durationMs);

  // While running: surface what's happening right now in the header.
  const current = running ? currentAction(steps) : null;

  const timeline = steps.map((s, i) =>
    s.kind === "thinking" ? (
      <ThinkingBlock key={i} id={id ? `${id}:s${i}` : undefined} text={s.text} streaming={s.streaming} />
    ) : s.kind === "text" ? (
      // Intermediate narration between tool runs — full markdown, but
      // muted so the timeline still reads as process, not answer.
      <div key={i} className="px-2 py-1 text-muted-foreground">
        <TextBlock text={s.text} streaming={s.streaming} isUser={false} />
      </div>
    ) : (
      <ToolUseCard key={i} id={id ? `${id}:s${i}` : undefined} block={s} />
    ),
  );

  if (plain) {
    // Settled whole-turn fold: a bare "N steps · Xs" line, no card chrome —
    // expanding reveals the timeline inline, without adding a nesting level.
    const label =
      toolCount > 0
        ? t(toolCount === 1 ? "agent.step" : "agent.step_plural", { count: toolCount }) +
          (dur ? ` · ${dur}` : "")
        : dur
          ? t("activity.worked", { duration: dur })
          : t("activity.thought");
    return (
      <div className="w-full max-w-[88%]">
        <button
          onClick={toggle}
          className="flex items-center gap-1 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <span>{label}</span>
          {open ? (
            <ChevronDown className="h-3 w-3 shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0" />
          )}
        </button>
        {open && <div className="mt-1 space-y-0.5">{timeline}</div>}
      </div>
    );
  }

  return (
    <div className="w-full max-w-[88%] rounded-md border border-border/60 bg-muted/30">
      <button
        onClick={toggle}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        )}
        {running ? (
          <Spinner className="size-3.5 text-muted-foreground" />
        ) : hasError ? (
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-warning" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
        )}
        {running ? (
          <>
            <span className="shrink-0 font-medium text-foreground">{t("activity.working")}</span>
            {liveDur && <span className="shrink-0 tabular-nums">· {liveDur}</span>}
            {toolCount > 0 && (
              <span className="shrink-0">
                · {t(toolCount === 1 ? "agent.step" : "agent.step_plural", { count: toolCount })}
              </span>
            )}
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
        <div className="space-y-0.5 border-t border-border/40 px-1.5 py-1.5">{timeline}</div>
      )}
    </div>
  );
}

/** A short label for the step currently in flight (or the most recent one), used
 *  in the live header: a running tool shows its name + arg preview; thinking
 *  shows the "Thinking" label. */
function currentAction(steps: ProcessBlock[]): string {
  // Narration text is content, not an action — skip it when picking the label.
  const procs = steps.filter((s) => s.kind !== "text");
  const active = [...procs].reverse().find((s) => s.streaming === true) ?? procs[procs.length - 1];
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
