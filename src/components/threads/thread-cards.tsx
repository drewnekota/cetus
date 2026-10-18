"use client";
import { ArrowUpRight, CornerDownRight } from "lucide-react";
import { BACKENDS } from "@/components/chat/backend-picker";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";
import { useChatStore } from "@/lib/chat-store";
import { openThread, parseReport, type ParsedReport } from "@/lib/coordinator";
import type { RenderedBlock } from "@/lib/types";

type ToolBlock = Extract<RenderedBlock, { kind: "tool_use" }>;

/** Coordinator tool calls that render as thread cards instead of folding
 *  into the turn's steps. */
export const THREAD_CARD_TOOLS = new Set(["thread_start", "thread_send"]);

function replyOf(block: ToolBlock): Record<string, unknown> | null {
  const first = block.result?.content?.[0];
  if (!first || first.type !== "text") return null;
  try {
    const v = JSON.parse(first.text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A successful thread_start / thread_send, with the thread it touched. */
export function threadCardInfo(block: RenderedBlock) {
  if (block.kind !== "tool_use" || !THREAD_CARD_TOOLS.has(block.name)) return null;
  if (!block.result || block.result.isError) return null;
  const reply = replyOf(block);
  if (!reply?.ok || typeof reply.thread_id !== "string") return null;
  const args = (block.args ?? {}) as Record<string, unknown>;
  return {
    kind: block.name as "thread_start" | "thread_send",
    id: reply.thread_id,
    title: String(reply.title || args.title || ""),
    runtime: String(reply.runtime || ""),
    message: String(args.message ?? args.task ?? ""),
  };
}

const RUNTIME_TO_BACKEND: Record<string, string> = { cetus: "pi" };

function RuntimeIcon({ runtime }: { runtime: string }) {
  const id = RUNTIME_TO_BACKEND[runtime] ?? runtime;
  const Icon = BACKENDS.find((b) => b.id === id)?.icon;
  return Icon ? <Icon className="size-3.5 shrink-0" /> : null;
}

/** Live status dot for a thread, same colors as the feed cards. */
function useThreadState(id: string) {
  return useChatStore((s) =>
    s.controlRequests[id]?.length
      ? "input"
      : s.streamingIds.has(id)
        ? "working"
        : s.chats[id]?.error
          ? "failed"
          : "done",
  );
}

const DOT: Record<string, string> = {
  input: "bg-[var(--brand)] animate-pulse",
  working: "bg-warning animate-pulse",
  failed: "bg-destructive",
  done: "bg-success",
};

export function ThreadToolCard({ block }: { block: RenderedBlock }) {
  const { t } = useTranslation("board");
  const info = threadCardInfo(block);
  const state = useThreadState(info?.id ?? "");
  if (!info) return null;
  if (info.kind === "thread_send") {
    return (
      <button
        type="button"
        onClick={() => openThread(info.id)}
        className="flex max-w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <CornerDownRight className="size-3 shrink-0" />
        <span className="truncate">{info.title || info.id}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => openThread(info.id)}
      title={t("coordinator.openThread")}
      className="group flex w-full max-w-md items-center gap-2.5 rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-left transition-colors hover:bg-muted/60"
    >
      <RuntimeIcon runtime={info.runtime} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {info.title || info.message.slice(0, 80)}
      </span>
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span className={cn("size-1.5 rounded-full", DOT[state])} />
        {t(
          state === "input"
            ? "threads.status.input"
            : state === "working"
              ? "threads.status.working"
              : state === "failed"
                ? "threads.status.failed"
                : "threads.status.unread",
        )}
      </span>
      <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
    </button>
  );
}

const REPORT_DOT: Record<string, string> = {
  finished: "bg-success",
  needs_input: "bg-[var(--brand)]",
  error: "bg-destructive",
};

/** One line of plain text from a markdown reply: fence lines, heading /
 *  list / quote markers, emphasis and inline-code ticks dropped (code itself
 *  stays — a reply can be nothing but a code block). */
export function plainPreview(md: string): string {
  return md
    .replace(/^\s*```.*$/gm, " ")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The user's own message, sent from Cetus's composer straight to the runtime
 *  they picked: their words, on the user side, with where they went. */
export function StartedThreadCard({ report }: { report: ParsedReport }) {
  const { t } = useTranslation("board");
  const backend = RUNTIME_TO_BACKEND[report.runtime] ?? report.runtime;
  const label = BACKENDS.find((b) => b.id === backend)?.label ?? report.runtime;
  return (
    <button
      type="button"
      onClick={() => report.id && openThread(report.id)}
      className="group flex max-w-[85%] flex-col items-end gap-1 text-right"
    >
      <span className="whitespace-pre-wrap rounded-2xl bg-muted px-3.5 py-2 text-left text-sm leading-6 text-foreground">
        {report.body.trim()}
      </span>
      <span className="flex items-center gap-1 text-xs text-muted-foreground group-hover:text-foreground">
        <CornerDownRight className="size-3" />
        {t("coordinator.sentTo")}
        <RuntimeIcon runtime={report.runtime} />
        <span className="font-medium">{label}</span>
        <ArrowUpRight className="size-3" />
      </span>
    </button>
  );
}

/** A <thread-report> Cetus posted into the coordinator, as a compact card
 *  instead of a raw user bubble. */
export function ThreadReportCard({ report }: { report: ParsedReport }) {
  const { t } = useTranslation("board");
  // A follow-up report leads with the request; the card previews the reply.
  const reply = report.body.split("\nReply:\n").pop() ?? report.body;
  const preview = plainPreview(reply);
  return (
    <button
      type="button"
      onClick={() => report.id && openThread(report.id)}
      className="flex w-full max-w-md flex-col gap-1 rounded-lg border border-border/70 bg-background px-3 py-2 text-left transition-colors hover:bg-muted/50"
    >
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span className={cn("size-1.5 shrink-0 rounded-full", REPORT_DOT[report.status] ?? "bg-muted-foreground")} />
        <span className="shrink-0">
          {REPORT_DOT[report.status]
            ? t(`coordinator.report.${report.status}`)
            : t("coordinator.report")}
        </span>
        <span className="shrink-0">·</span>
        <RuntimeIcon runtime={report.runtime} />
        <span className="min-w-0 truncate font-medium text-foreground">{report.title}</span>
      </span>
      {preview && (
        <span className="line-clamp-3 text-xs leading-5 text-muted-foreground">{preview}</span>
      )}
    </button>
  );
}

export function reportFromText(text: string): ParsedReport | null {
  return text.trimStart().startsWith("<thread-report") ? parseReport(text) : null;
}
