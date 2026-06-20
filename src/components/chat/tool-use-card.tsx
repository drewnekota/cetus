"use client";
import { memo, useState } from "react";
import { ChevronDown, ChevronRight, Wrench, AlertCircle, Loader2, CheckCircle2, CircleSlash } from "lucide-react";
import type { PiContentBlock, RenderedBlock } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";

type ToolUse = Extract<RenderedBlock, { kind: "tool_use" }>;

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
export const ToolUseCard = memo(function ToolUseCard({ block }: { block: ToolUse }) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const isError = block.result?.isError;
  const isRunning = block.streaming === true;
  // A settled (non-streaming) tool call that never got a result was interrupted
  // — the run was aborted or pi died before the tool returned. Show a terminal
  // "interrupted" state instead of a spinner that never resolves.
  const isIncomplete = !isRunning && !isError && block.result == null;
  const preview = summarizeArgs(block.args);

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded px-2 py-1 text-left transition-colors hover:bg-muted/60"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <Wrench className="h-3 w-3 shrink-0 text-muted-foreground" />
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
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : isIncomplete ? (
            <CircleSlash className="h-3 w-3 text-muted-foreground" />
          ) : (
            <CheckCircle2 className="h-3 w-3 text-success" />
          )}
        </span>
      </button>
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
