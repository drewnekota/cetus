"use client";
// The ⌘F find bar: a floating strip over the top-right of the message list,
// modelled on a browser's find rather than on the command palette — it never
// takes the screen, and the conversation stays readable behind it.
//
// Purely presentational: every scroll, highlight and match decision lives in
// MessageList (chat-pane.tsx), which owns the virtualised list this searches.

import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useTranslation } from "@/lib/i18n";

export function FindBar({
  query,
  onQueryChange,
  total,
  active,
  onStep,
  onClose,
  opticalCenter,
  focusTick,
}: {
  query: string;
  onQueryChange: (next: string) => void;
  total: number;
  /** 0-based index of the current occurrence; displayed 1-based. */
  active: number;
  onStep: (delta: number) => void;
  onClose: () => void;
  opticalCenter: boolean;
  /** Bumped by the parent on every ⌘F, including while the bar is already open. */
  focusTick: number;
}) {
  const { t } = useTranslation("chat");
  const inputRef = useRef<HTMLInputElement>(null);

  // Opening the bar hands it the keyboard, and a second ⌘F while it is already
  // open re-selects the query so the next thing typed replaces it — both the
  // browser convention. The bar does not remount for that second press, hence
  // the tick.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusTick]);

  const noHits = query.trim().length > 0 && total === 0;

  return (
    <div
      className={`absolute right-[max(1rem,calc((100%-48rem)/2))] top-3 z-30 flex items-center gap-1 rounded-lg border border-border bg-popover/95 px-1.5 py-1 shadow-[0_4px_14px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.08)] backdrop-blur ${
        opticalCenter ? "xl:-translate-x-10 2xl:-translate-x-12" : ""
      }`}
      // The list below owns ⌘F/Esc globally; keep ordinary typing (and the
      // composer's "/" focus shortcut) from leaking out of the field.
      onKeyDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          // The wrapper stops keys from leaking to the app's global handler,
          // so the repeat-⌘F select-all is handled here rather than travelling
          // out and back.
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
            e.preventDefault();
            e.currentTarget.select();
          } else if (e.key === "Enter") {
            e.preventDefault();
            onStep(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder={t("find.placeholder")}
        aria-label={t("find.placeholder")}
        spellCheck={false}
        className={`h-7 w-44 rounded-md bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground ${
          noHits ? "text-destructive" : "text-foreground"
        }`}
      />
      <span className="min-w-14 shrink-0 text-center text-xs tabular-nums text-muted-foreground">
        {query.trim().length === 0
          ? ""
          : total === 0
            ? t("find.noResults")
            : t("find.count", { current: active + 1, total })}
      </span>
      <button
        type="button"
        aria-label={t("find.previous")}
        title={t("find.previous")}
        disabled={total === 0}
        onClick={() => onStep(-1)}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        <ChevronUp className="size-4" />
      </button>
      <button
        type="button"
        aria-label={t("find.next")}
        title={t("find.next")}
        disabled={total === 0}
        onClick={() => onStep(1)}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        <ChevronDown className="size-4" />
      </button>
      <button
        type="button"
        aria-label={t("find.close")}
        title={t("find.close")}
        onClick={onClose}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
