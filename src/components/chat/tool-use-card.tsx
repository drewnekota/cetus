"use client";
import { memo } from "react";
import { ChevronDown, ChevronRight, Wrench, AlertCircle, CheckCircle2, CircleSlash, Bot, Check } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import type { PiContentBlock, RenderedBlock } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";
import { useDisclosure } from "@/lib/disclosure";

type ToolUse = Extract<RenderedBlock, { kind: "tool_use" }>;

interface SubagentStep {
  tool: string;
  detail: string;
  done: boolean;
}

interface SubagentInfo {
  type: string;
  description: string;
  status: string;
  steps: SubagentStep[];
}

/** Structured subagent progress a CLI backend (claude-code Task/Agent tool)
 *  attaches to the card's result details — the subagent's own tool calls,
 *  streamed as steps while it works. Null for ordinary tools. */
export function subagentInfo(details: unknown): SubagentInfo | null {
  if (!details || typeof details !== "object") return null;
  const sub = (details as { subagent?: unknown }).subagent;
  if (!sub || typeof sub !== "object") return null;
  const s = sub as { type?: unknown; description?: unknown; status?: unknown; steps?: unknown };
  return {
    type: typeof s.type === "string" ? s.type : "agent",
    description: typeof s.description === "string" ? s.description : "",
    status: typeof s.status === "string" ? s.status : "running",
    steps: Array.isArray(s.steps)
      ? s.steps.flatMap((x): SubagentStep[] => {
          if (!x || typeof x !== "object") return [];
          const step = x as { tool?: unknown; detail?: unknown; done?: unknown };
          return [
            {
              tool: typeof step.tool === "string" ? step.tool : "tool",
              detail: typeof step.detail === "string" ? step.detail : "",
              done: step.done === true,
            },
          ];
        })
      : [],
  };
}

function stringifyArgs(args: unknown): string {
  if (args == null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

/** A short, single-line preview of a tool's args — the most useful field
 *  flattened to one line (e.g. a bash command, a file path, a query). Shown
 *  dimmed next to the tool name so a collapsed step still says what it did. */
export function summarizeArgs(args: unknown): string {
  let value: unknown = args;
  if (typeof args === "string") {
    try {
      value = JSON.parse(args);
    } catch {
      value = args;
    }
  }
  if (value == null) return "";
  if (typeof value === "string") return collapseWhitespace(value);
  if (typeof value !== "object") return collapseWhitespace(String(value));
  const obj = value as Record<string, unknown>;
  // Prefer the fields that usually carry the "what" of a call.
  for (const k of ["command", "cmd", "path", "file", "file_path", "query", "url", "pattern", "name"]) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return collapseWhitespace(v);
  }
  // Fall back to the first stringy value.
  for (const v of Object.values(obj)) {
    if (typeof v === "string" && v.trim()) return collapseWhitespace(v);
  }
  return "";
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function flattenResultContent(content: PiContentBlock[] | undefined): string {
  if (!content) return "";
  return content
    .map((c) => {
      if (c.type === "text") return c.text;
      return `[${c.type}]`;
    })
    .join("\n");
}

/** One compact step in the activity timeline: a single hover-able line that
 *  expands to show args + result. Borderless on purpose — it lives inside the
 *  activity group's bordered panel. Memoized on `block`: a settled tool keeps
 *  its ref while a sibling streams, so it stops re-rendering once done. */
export const ToolUseCard = memo(function ToolUseCard({ id, block }: { id?: string; block: ToolUse }) {
  const { t } = useTranslation("chat");
  const [open, toggle] = useDisclosure(id);
  const isError = block.result?.isError;
  const subagent = subagentInfo(block.result?.details);
  // Codex child threads may outlive the root turn, so agent_end can clear the
  // generic streaming bit while the structured subagent state is still live.
  const isRunning = block.streaming === true || subagent?.status === "running";
  // A settled (non-streaming) tool call that never got a result was interrupted
  // — the run was aborted or pi died before the tool returned. Show a terminal
  // "interrupted" state instead of a spinner that never resolves.
  const isIncomplete = !isRunning && !isError && block.result == null;
  const preview = subagent
    ? [subagent.type, subagent.description].filter(Boolean).join(" — ")
    : summarizeArgs(block.args);
  // Subagent steps: keep the list glanceable while running — last few steps
  // inline, the full history behind the expander.
  const steps = subagent?.steps ?? [];
  const visibleSteps = open ? steps : steps.slice(-5);
  const hiddenSteps = steps.length - visibleSteps.length;

  return (
    <div>
      <button
        onClick={toggle}
        className="flex w-full items-center gap-2 rounded px-2 py-1 text-left transition-colors hover:bg-muted/60"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        {subagent ? (
          <Bot className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <Wrench className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <span className="shrink-0 font-mono text-xs font-medium">
          {block.name || <span className="italic text-muted-foreground">{t("tool.calling")}</span>}
        </span>
        {preview && (
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{preview}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
          {isError ? (
            <AlertCircle className="h-3 w-3 text-warning" />
          ) : isRunning ? (
            <Spinner className="size-3" />
          ) : isIncomplete ? (
            <CircleSlash className="h-3 w-3 text-muted-foreground" />
          ) : (
            <CheckCircle2 className="h-3 w-3 text-success" />
          )}
        </span>
      </button>
      {steps.length > 0 && (
        <div className="ml-[3.25rem] space-y-0.5 pb-1 pr-2">
          {hiddenSteps > 0 && (
            <div className="text-[10px] text-muted-foreground/70">
              {t("tool.earlierSteps", { count: hiddenSteps })}
            </div>
          )}
          {visibleSteps.map((s, i) => (
            <div key={hiddenSteps + i} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {s.done ? (
                <Check className="h-2.5 w-2.5 shrink-0 text-success/80" />
              ) : isRunning ? (
                <Spinner className="size-2.5" />
              ) : (
                <CircleSlash className="h-2.5 w-2.5 shrink-0" />
              )}
              <span className="shrink-0 font-mono">{s.tool}</span>
              {s.detail && <span className="min-w-0 truncate">{s.detail}</span>}
            </div>
          ))}
        </div>
      )}
      {open && (
        <div className="space-y-2 px-2 pb-2 pt-1">
          {block.args != null && (
            <section>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{t("tool.args")}</div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-background/60 px-2 py-1.5 font-mono text-[11px]">
                {stringifyArgs(block.args)}
              </pre>
            </section>
          )}
          {block.result && (
            <section>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{t("tool.result")}</div>
              <pre
                className={cn(
                  "max-h-72 overflow-auto whitespace-pre-wrap rounded bg-background/60 px-2 py-1.5 font-mono text-[11px]",
                  isError && "text-warning dark:text-warning",
                )}
              >
                {Array.isArray(block.result.content) ? flattenResultContent(block.result.content) : ""}
              </pre>
            </section>
          )}
        </div>
      )}
    </div>
  );
});
