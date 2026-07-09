"use client";
import { memo } from "react";
import { ChevronDown, ChevronRight, Brain } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";
import { useDisclosure } from "@/lib/disclosure";

/** One compact "thinking" step in the activity timeline. Borderless row that
 *  expands to reveal the raw chain-of-thought. Matches the tool-step styling so
 *  the two read as a single timeline. `id` persists the expanded state across
 *  the virtualized list unmounting this turn. */
export const ThinkingBlock = memo(function ThinkingBlock({ id, text, streaming }: { id?: string; text: string; streaming?: boolean }) {
  const { t } = useTranslation("chat");
  const [open, toggle] = useDisclosure(id);
  return (
    <div>
      <button
        onClick={toggle}
        className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <Brain className="h-3 w-3 shrink-0" />
        <span className="text-xs font-medium">{t("thinking.title")}</span>
        {streaming && <span className="animate-pulse text-[10px]">…</span>}
        <span className="ml-auto shrink-0 text-[10px] tabular-nums">
          {t("thinking.chars", { count: text.length })}
        </span>
      </button>
      {open && (
        <pre
          className={cn(
            "max-h-72 overflow-auto whitespace-pre-wrap break-words px-2 pb-2 pt-1 font-mono text-[11px] leading-relaxed text-muted-foreground",
          )}
        >
          {text}
        </pre>
      )}
    </div>
  );
});
