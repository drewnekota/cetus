"use client";
import { useState } from "react";
import { Globe, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { contextSummary } from "@/lib/quick-context";

/** Read-only chip for the ambient context the quick launcher attached to a
 *  prompt (frontmost app, browser URL/title, selected text). Collapsed to a
 *  one-line summary by default; click to expand the captured fields. */
export function ContextCard({ inner, isUser }: { inner: string; isUser: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("w-fit max-w-full", isUser && "self-end")}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
          isUser
            ? "bg-primary-foreground/15 text-primary-foreground/90 hover:bg-primary-foreground/25"
            : "bg-muted/60 text-muted-foreground hover:bg-muted",
        )}
      >
        <Globe className="size-3 shrink-0 opacity-80" />
        <span className="truncate">{contextSummary(inner)}</span>
        <ChevronRight
          className={cn("size-3 shrink-0 opacity-60 transition-transform", open && "rotate-90")}
        />
      </button>
      {open && (
        <pre
          className={cn(
            "mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-[11px] leading-relaxed",
            isUser
              ? "bg-primary-foreground/10 text-primary-foreground/85"
              : "bg-muted/50 text-muted-foreground",
          )}
        >
          {inner}
        </pre>
      )}
    </div>
  );
}
