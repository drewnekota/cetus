"use client";
import { memo, useMemo } from "react";
import { ChevronDown, ChevronRight, Wrench, AlertCircle, CheckCircle2, CircleSlash, Bot, Check, FileDiff, FileText } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Spinner } from "@/components/ui/spinner";
import { AnsiText } from "@/components/ui/ansi-text";
import { fileExtension, highlightSource, HLJS_THEME_CLASS, languageForExtension } from "@/lib/highlight";
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

interface ToolOutputInfo {
  truncated: boolean;
  totalBytes: number;
  path?: string;
}

function toolOutputInfo(details: unknown): ToolOutputInfo | null {
  if (!details || typeof details !== "object") return null;
  const value = (details as { toolOutput?: unknown }).toolOutput;
  if (!value || typeof value !== "object") return null;
  const info = value as { truncated?: unknown; totalBytes?: unknown; path?: unknown };
  return {
    truncated: info.truncated === true,
    totalBytes: typeof info.totalBytes === "number" ? info.totalBytes : 0,
    path: typeof info.path === "string" ? info.path : undefined,
  };
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
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

/** Parsed file-tool (read/write) call: path plus optional paging args, and
 *  the written content for write calls. */
interface FileMeta {
  path: string | null;
  offset?: number;
  limit?: number;
  /** The `content` arg (write tool) — rendered as the card body. */
  content?: string;
}

/** Extract { path, offset, limit, content } from a read/write tool call (args
 *  may be an object or stringified JSON). */
function parseFileMeta(args: unknown): FileMeta {
  let value: unknown = args;
  if (typeof args === "string") {
    try {
      value = JSON.parse(args);
    } catch {
      value = args;
    }
  }
  const meta: FileMeta = { path: null };
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const k of ["path", "file", "file_path", "filename"]) {
      const v = obj[k];
      if (typeof v === "string" && v.trim()) {
        meta.path = v.trim();
        break;
      }
    }
    const num = (v: unknown): number | undefined => {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
      return undefined;
    };
    meta.offset = num(obj.offset);
    meta.limit = num(obj.limit);
    if (typeof obj.content === "string") meta.content = obj.content;
  }
  return meta;
}

/** One oldText→newText replacement inside an edit tool call. */
interface EditSpec {
  oldText: string;
  newText: string;
}

/** A single line of a computed diff. */
interface DiffLine {
  type: "add" | "del" | "same";
  text: string;
}

interface EditInfo {
  path: string | null;
  edits: EditSpec[];
}

/** Extract the replacement pairs from an edit-style tool call (an `edits`
 *  array, or a bare { oldText, newText } pair — possibly stringified JSON).
 *  Null when there's nothing diff-shaped to show. */
function editChanges(args: unknown): EditInfo | null {
  let value: unknown = args;
  if (typeof args === "string") {
    try {
      value = JSON.parse(args);
    } catch {
      value = args;
    }
  }
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  let path: string | null = null;
  for (const k of ["path", "file", "file_path", "filename"]) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) {
      path = v.trim();
      break;
    }
  }
  const edits: EditSpec[] = [];
  const push = (e: Record<string, unknown>) => {
    const oldText = typeof e.oldText === "string" ? e.oldText : "";
    const newText = typeof e.newText === "string" ? e.newText : "";
    if (oldText || newText) edits.push({ oldText, newText });
  };
  if (Array.isArray(obj.edits)) {
    for (const e of obj.edits) {
      if (e && typeof e === "object") push(e as Record<string, unknown>);
    }
  } else if (obj.edits && typeof obj.edits === "object") {
    push(obj.edits as Record<string, unknown>);
  } else if (typeof obj.oldText === "string" || typeof obj.newText === "string") {
    push(obj);
  }
  return edits.length > 0 ? { path, edits } : null;
}

// Guard against pathological oldText/newText sizes that would make the LCS
// table explode — beyond this cap, fall back to a straight "removals then
// additions" dump (still correct, just not minimal).
const MAX_DIFF_LINES = 800;

/** Line diff of two strings via LCS. Empty old/new sides produce pure
 *  additions / deletions. */
function diffLines(oldText: string, newText: string): DiffLine[] {
  if (oldText === "") return newText.split("\n").map((text) => ({ type: "add" as const, text }));
  if (newText === "") return oldText.split("\n").map((text) => ({ type: "del" as const, text }));
  const a = oldText.split("\n");
  const b = newText.split("\n");
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return [
      ...a.map((text) => ({ type: "del" as const, text })),
      ...b.map((text) => ({ type: "add" as const, text })),
    ];
  }
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i..] and b[j..] — walking backwards keeps the
  // reconstruction (which only ever looks at dp[i+1] / dp[i][j+1]) in one pass.
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i] });
      i++;
    } else {
      out.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}

/** GitHub-style red/green line colors for a unified diff. */
const DIFF_ADD_CLASS = "bg-[#dafbe1]/40 text-[#116329] dark:bg-[#033a16]/40 dark:text-[#aff5b4]";
const DIFF_DEL_CLASS = "bg-[#ffebe9]/40 text-[#82071e] dark:bg-[#490202]/40 dark:text-[#ffdcd7]";

function countDiff(diffs: DiffLine[][]): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const d of diffs) {
    for (const l of d) {
      if (l.type === "add") adds++;
      else if (l.type === "del") dels++;
    }
  }
  return { adds, dels };
}

/** Terminal-ish unified diff for one edit tool call: file header with a
 *  diffstat, then `-`/`+` lines colored like git. Diffs are computed once by
 *  the parent (memoized on the args) and passed in. */
function EditDiffView({
  path,
  edits,
  diffs,
  stat,
}: {
  path: string | null;
  edits: EditSpec[];
  diffs: DiffLine[][];
  stat: { adds: number; dels: number };
}) {
  return (
    <div className="overflow-hidden rounded bg-background/60">
      {path && (
        <div className="flex items-center gap-1.5 border-b border-border/40 bg-muted/40 px-2 py-1 font-mono text-[10px] text-muted-foreground">
          <FileDiff className="h-3 w-3 shrink-0" />
          <span className="min-w-0 truncate" title={path}>
            {path}
          </span>
          <span className="ml-auto shrink-0 text-success">+{stat.adds}</span>
          <span className="shrink-0 text-destructive">-{stat.dels}</span>
        </div>
      )}
      <div className="max-h-64 overflow-auto">
        {diffs.map((d, i) => (
          <div key={i}>
            {edits.length > 1 && (
              <div className="border-y border-border/30 bg-muted/30 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                {i + 1} / {edits.length}
              </div>
            )}
            <pre className="px-2 py-1 font-mono text-[11px] leading-relaxed">
              {d.map((line, j) => (
                <div
                  key={j}
                  className={cn(
                    "flex whitespace-pre-wrap break-words",
                    line.type === "add"
                      ? DIFF_ADD_CLASS
                      : line.type === "del"
                        ? DIFF_DEL_CLASS
                        : "text-muted-foreground",
                  )}
                >
                  <span className="w-4 shrink-0 select-none text-center">
                    {line.type === "add" ? "+" : line.type === "del" ? "-" : ""}
                  </span>
                  <span className="min-w-0">{line.text || " "}</span>
                </div>
              ))}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Extract the shell command from a bash-style tool call — the tool name
 *  mentions bash, or the args carry a `command`/`cmd` field (a command runner
 *  by any name). Handles both object args ({ command: "…" }) and stringified
 *  JSON. Returns null when there's nothing command-shaped to show; the caller
 *  then falls back to the raw JSON args. */
function bashCommand(name: string, args: unknown): string | null {
  let value: unknown = args;
  if (typeof args === "string") {
    try {
      value = JSON.parse(args);
    } catch {
      value = args;
    }
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const k of ["command", "cmd"]) {
      const v = obj[k];
      if (typeof v === "string" && v.trim()) return v;
    }
  }
  // A bare-string arg on a bash-named tool is the command itself.
  if (typeof value === "string" && value.trim() && /bash/i.test(name)) return value;
  return null;
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
  // Read-style tools surface file contents; highlight the result by the file's
  // extension when we can pin a language, so a settled `read` shows colored
  // code instead of a plain dump. Skipped on errors (keep the warning tint).
  const resultText = block.result
    ? Array.isArray(block.result.content)
      ? flattenResultContent(block.result.content)
      : ""
    : "";
  // Only treat the built-in file tools as read/write cards. Prefix matching
  // also catches unrelated tools such as read_mcp_resource and write_stdin,
  // hiding their args and (for writes without `content`) their result body.
  const normalizedToolName = block.name.trim().toLowerCase();
  const isReadTool = normalizedToolName === "read" || normalizedToolName === "read_file";
  const isWriteTool = normalizedToolName === "write" || normalizedToolName === "write_file";
  const isFileTool = isReadTool || isWriteTool;
  const fileMeta = useMemo(() => (isFileTool ? parseFileMeta(block.args) : null), [isFileTool, block.args]);
  const filePath = fileMeta?.path ?? null;
  const fileExt = filePath ? fileExtension(filePath) : "";
  // What the card displays as the body: read → the result text (the file
  // contents the model saw); write → the `content` arg itself (the result is
  // only a confirmation string). On errors, fall back to the result text so an
  // error message still shows with the warning tint.
  const bodyText =
    isReadTool || (isWriteTool && isError)
      ? resultText
      : isWriteTool
        ? (fileMeta?.content ?? "")
        : resultText;
  // Highlight the body by file extension when a language can be pinned and
  // there's something to highlight. Skipped on errors (keep the warning tint).
  const highlighted = useMemo(
    () =>
      !isError && filePath !== null && bodyText !== "" && languageForExtension(fileExt)
        ? highlightSource(bodyText, fileExt)
        : null,
    [isError, filePath, fileExt, bodyText],
  );
  const subagent = subagentInfo(block.result?.details);
  const outputInfo = toolOutputInfo(block.result?.details);
  // Codex child threads may outlive the root turn, so agent_end can clear the
  // generic streaming bit while the structured subagent state is still live.
  const isRunning = block.streaming === true || subagent?.status === "running";
  // A settled (non-streaming) tool call that never got a result was interrupted
  // — the run was aborted or pi died before the tool returned. Show a terminal
  // "interrupted" state instead of a spinner that never resolves.
  const isIncomplete = !isRunning && !isError && block.result == null;
  const cmd = useMemo(() => bashCommand(block.name, block.args), [block.name, block.args]);
  const editInfo = useMemo(() => editChanges(block.args), [block.args]);
  const editDiffs = useMemo(
    () => (editInfo ? editInfo.edits.map((e) => diffLines(e.oldText, e.newText)) : null),
    [editInfo],
  );
  const editStat = useMemo(() => (editDiffs ? countDiff(editDiffs) : null), [editDiffs]);
  // Trailing meta for the file header (read: offset/limit, write: size).
  const fileMetaParts = useMemo(() => {
    const parts: string[] = [];
    if (fileMeta?.offset != null) parts.push(`offset ${fileMeta.offset}`);
    if (fileMeta?.limit != null) parts.push(`limit ${fileMeta.limit}`);
    if (fileMeta?.content != null) parts.push(formatBytes(fileMeta.content.length));
    return parts;
  }, [fileMeta]);
  const preview = subagent
    ? [subagent.type, subagent.description].filter(Boolean).join(" — ")
    : editInfo !== null && editStat !== null
      ? `${editInfo.path ?? "edit"} · +${editStat.adds} -${editStat.dels}`
      : cmd !== null
        ? `$ ${cmd}`
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
          {/* File tools (read/write) skip the raw JSON args entirely — the
              path and paging/size args surface as a header on the result. */}
          {block.args != null && !isFileTool && (
            <section>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                {editInfo !== null ? t("tool.diff") : cmd !== null ? t("tool.command") : t("tool.args")}
              </div>
              {editInfo !== null && editDiffs !== null && editStat !== null ? (
                <EditDiffView path={editInfo.path} edits={editInfo.edits} diffs={editDiffs} stat={editStat} />
              ) : cmd !== null ? (
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed">
                  <span className="select-none text-muted-foreground">$ </span>
                  {cmd}
                </pre>
              ) : (
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-background/60 px-2 py-1.5 font-mono text-[11px]">
                  {stringifyArgs(block.args)}
                </pre>
              )}
            </section>
          )}
          {block.result && (
            <section>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{t("tool.result")}</div>
              {filePath !== null && (
                <div className="mb-1 flex items-center gap-1.5 rounded bg-background/60 px-2 py-1 font-mono text-[10px] text-muted-foreground">
                  <FileText className="h-3 w-3 shrink-0" />
                  <span className="min-w-0 truncate" title={filePath}>
                    {filePath}
                  </span>
                  {fileMetaParts.length > 0 && (
                    <span className="ml-auto shrink-0">{fileMetaParts.join(" · ")}</span>
                  )}
                </div>
              )}
              {highlighted !== null ? (
                <pre
                  className={cn(
                    "max-h-72 overflow-auto rounded bg-background/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed",
                    HLJS_THEME_CLASS,
                  )}
                >
                  <code dangerouslySetInnerHTML={{ __html: highlighted }} />
                </pre>
              ) : (
                <pre
                  className={cn(
                    "max-h-72 overflow-auto whitespace-pre-wrap rounded bg-background/60 px-2 py-1.5 font-mono text-[11px]",
                    isError && "text-warning dark:text-warning",
                  )}
                >
                  <AnsiText>{bodyText}</AnsiText>
                </pre>
              )}
              {outputInfo?.truncated && (
                <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                  <span>{t("tool.outputTruncated", { size: formatBytes(outputInfo.totalBytes) })}</span>
                  {outputInfo.path && (
                    <button
                      type="button"
                      className="shrink-0 underline underline-offset-2 hover:text-foreground"
                      onClick={() => invoke("open_path", { path: outputInfo.path }).catch(console.error)}
                    >
                      {t("tool.openFullOutput")}
                    </button>
                  )}
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
});
