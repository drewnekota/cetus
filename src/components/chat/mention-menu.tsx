"use client";
import { useEffect, useRef } from "react";
import { Target } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";

/** One row in the `@`-mention menu. Today the only kind is `goal`, but the type
 *  is deliberately generic so future context mentions (e.g. `@file`, `@task`)
 *  can be added to the same list. */
export interface MentionItem {
  id: string;
  /** Bare token name, inserted as `@<name> `. */
  name: string;
  description: string;
}

interface Props {
  /** Filtered, ordered rows. */
  items: MentionItem[];
  /** Index of the highlighted row (clamped by the caller). */
  activeIndex: number;
  onSelect: (item: MentionItem) => void;
  onHover: (index: number) => void;
}

/**
 * The `@`-triggered menu that floats above the composer. Like {@link SlashMenu}
 * it's purely presentational: detection, filtering and keyboard nav live in the
 * Composer (which keeps focus in the textarea), so this just renders rows and
 * reports hover/click.
 */
export function MentionMenu({ items, activeIndex, onSelect, onHover }: Props) {
  const { t } = useTranslation("chat");
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the highlighted row in view as the user arrows through.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (items.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-72 overflow-y-auto rounded-xl border border-border bg-popover p-1.5 shadow-lg"
      role="listbox"
    >
      <div className="px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {t("mention.title")}
      </div>
      {items.map((item, idx) => {
        const active = idx === activeIndex;
        return (
          <button
            key={item.id}
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
            )}
          >
            <Target className="mt-0.5 size-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="truncate text-sm font-medium">@{item.name}</span>
              </span>
              {item.description && (
                <span className="mt-0.5 line-clamp-1 block text-xs text-muted-foreground">
                  {item.description}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
