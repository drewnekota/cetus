"use client";
import { useEffect, useRef, type ReactNode } from "react";
import {
  Archive,
  CalendarClock,
  File as FileIcon,
  Folder,
  MessageSquare,
  Package,
  Target,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";
import { MENTION_KINDS, type MentionItem, type MentionKind } from "@/lib/mentions";

/** The active tab: one kind, or the aggregated "all" view. */
export type MentionTab = "all" | MentionKind;

export const MENTION_TABS: MentionTab[] = ["all", ...MENTION_KINDS];

export function nextMentionTab(current: MentionTab, delta: 1 | -1): MentionTab {
  const i = MENTION_TABS.indexOf(current);
  return MENTION_TABS[(i + delta + MENTION_TABS.length) % MENTION_TABS.length];
}

interface Props {
  tab: MentionTab;
  onTabChange: (tab: MentionTab) => void;
  /** Filtered, ordered rows for the active tab. In the "all" tab they're
   *  grouped by kind in MENTION_KINDS order; the menu draws a heading at each
   *  kind boundary. */
  items: MentionItem[];
  /** Index of the highlighted row (clamped by the caller). */
  activeIndex: number;
  /** A remote source (file search) is still answering. */
  loading?: boolean;
  onSelect: (item: MentionItem) => void;
  onHover: (index: number) => void;
}

const KIND_LABEL_KEY: Record<MentionTab, string> = {
  all: "mention.tab.all",
  function: "mention.tab.functions",
  automation: "mention.tab.automations",
  artifact: "mention.tab.artifacts",
  file: "mention.tab.files",
  conversation: "mention.tab.conversations",
};

function KindIcon({ item }: { item: MentionItem }) {
  const cls = "mt-0.5 size-4 shrink-0";
  switch (item.kind) {
    case "function":
      return <Target className={cn(cls, "text-primary")} />;
    case "automation":
      return <CalendarClock className={cn(cls, "text-muted-foreground")} />;
    case "artifact":
      return <Package className={cn(cls, "text-muted-foreground")} />;
    case "file":
      return item.isDir ? (
        <Folder className={cn(cls, "text-muted-foreground")} />
      ) : (
        <FileIcon className={cn(cls, "text-muted-foreground")} />
      );
    case "conversation":
      return item.archived ? (
        <Archive className={cn(cls, "text-muted-foreground/70")} />
      ) : (
        <MessageSquare className={cn(cls, "text-muted-foreground")} />
      );
  }
}

/**
 * The `@`-triggered menu that floats above the composer. Like {@link SlashMenu}
 * it's purely presentational: detection, filtering, data loading and keyboard
 * nav live in the Composer (which keeps focus in the textarea). Tab / ⇧Tab
 * move between the kind tabs; ↑/↓ move between rows; ⏎ picks.
 */
export function MentionMenu({
  tab,
  onTabChange,
  items,
  activeIndex,
  loading,
  onSelect,
  onHover,
}: Props) {
  const { t } = useTranslation("chat");
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the highlighted row in view as the user arrows through.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const rows: ReactNode[] = [];
  let lastKind: MentionKind | null = null;
  items.forEach((item, idx) => {
    if (tab === "all" && item.kind !== lastKind) {
      lastKind = item.kind;
      rows.push(
        <div
          key={`h-${item.kind}`}
          className={cn(
            "px-2 pb-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground",
            idx === 0 ? "pt-1.5" : "pt-2.5",
          )}
        >
          {t(KIND_LABEL_KEY[item.kind])}
        </div>,
      );
    }
    const active = idx === activeIndex;
    rows.push(
      <button
        key={`${item.kind}:${item.id}`}
        type="button"
        data-idx={idx}
        role="option"
        aria-selected={active}
        // onMouseDown (not onClick) so the textarea never loses focus.
        onMouseDown={(e) => {
          e.preventDefault();
          onSelect(item);
        }}
        onMouseMove={() => onHover(idx)}
        className={cn(
          "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left",
          active ? "bg-accent" : "hover:bg-accent/50",
          item.archived && "opacity-70",
        )}
      >
        <KindIcon item={item} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium">
              {item.kind === "function" ? `@${item.title}` : item.title}
            </span>
            {item.archived && (
              <span className="shrink-0 text-2xs uppercase tracking-wide text-muted-foreground">
                {t("mention.archived")}
              </span>
            )}
          </span>
          {item.subtitle && (
            <span className="mt-0.5 line-clamp-1 block break-all text-xs text-muted-foreground">
              {item.subtitle}
            </span>
          )}
        </span>
      </button>,
    );
  });

  return (
    <div
      className="absolute bottom-full left-0 right-0 z-20 mb-2 flex h-80 flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-lg"
      role="listbox"
    >
      <div className="flex shrink-0 items-center gap-0.5 border-b border-border px-1.5 pt-1">
        {MENTION_TABS.map((k) => {
          const on = k === tab;
          return (
            <button
              key={k}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onTabChange(k);
              }}
              className={cn(
                "-mb-px whitespace-nowrap border-b-2 px-2 pb-1.5 pt-1 text-xs font-medium transition-colors",
                on
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t(KIND_LABEL_KEY[k])}
            </button>
          );
        })}
        <span className="ml-auto shrink-0 pb-1.5 pl-3 pr-1 pt-1 text-2xs text-muted-foreground/80">
          {t("mention.tabHint")}
        </span>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {rows}
        {items.length === 0 && (
          <div className="px-2.5 py-3 text-center text-xs text-muted-foreground">
            {loading ? t("mention.searching") : t("mention.empty")}
          </div>
        )}
        {items.length > 0 && loading && (
          <div className="px-2.5 pb-1 pt-2 text-2xs text-muted-foreground">
            {t("mention.searching")}
          </div>
        )}
      </div>
    </div>
  );
}
