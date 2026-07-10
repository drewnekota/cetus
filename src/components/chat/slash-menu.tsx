"use client";
/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
 * genre: modern-minimal · macrostructure: Workbench · designed-as-app */
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";

/** One row in the slash menu: a user command (expands to a prompt) or a skill
 *  (inserts its `/name` token). Group headings distinguish the two kinds. */
export type SlashItem =
  | { kind: "command"; id: string; name: string; description: string; prompt: string }
  | { kind: "skill"; id: string; name: string; description: string };

interface Props {
  /** Filtered, ordered rows — commands first, then skills. */
  items: SlashItem[];
  /** Index of the highlighted row (clamped by the caller). */
  activeIndex: number;
  onSelect: (item: SlashItem) => void;
  onHover: (index: number) => void;
}

/**
 * The `/`-triggered menu that floats above the composer. It's purely
 * presentational: detection, filtering and keyboard nav live in the Composer
 * (which keeps focus in the textarea), so this just renders the rows and reports
 * hover/click. Commands and skills are grouped by heading; the trigger text is
 * the visual anchor, so repeated decorative icons are deliberately omitted.
 */
export function SlashMenu({ items, activeIndex, onSelect, onHover }: Props) {
  const { t } = useTranslation("chat");
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the highlighted row in view as the user arrows through.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (items.length === 0) return null;

  // Index of the first skill row → where the "Skills" heading goes.
  const firstSkill = items.findIndex((i) => i.kind === "skill");
  const hasCommands = items.some((i) => i.kind === "command");

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 z-20 mb-2 max-h-80 w-[min(40rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
      role="listbox"
    >
      {items.map((item, idx) => {
        const heading =
          idx === 0 && hasCommands ? (
            <Heading key="h-cmd" label={t("slash.commands")} />
          ) : idx === firstSkill && firstSkill >= 0 ? (
            <Heading key="h-skill" label={t("slash.skills")} />
          ) : null;
        const active = idx === activeIndex;
        return (
          <div key={`${item.kind}-${item.id}`}>
            {heading}
            <button
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
                "flex w-full items-start rounded-md px-3 py-2 text-left transition-colors motion-reduce:transition-none",
                active ? "bg-muted text-foreground" : "hover:bg-muted/60",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-baseline font-mono text-sm font-medium">
                  <span className="shrink-0 text-muted-foreground">/</span>
                  <span className="truncate font-sans">{item.name}</span>
                </span>
                {item.description && (
                  <span className="mt-0.5 line-clamp-1 block text-xs text-muted-foreground">
                    {item.description}
                  </span>
                )}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

function Heading({ label }: { label: string }) {
  return (
    <div className="px-3 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">
      {label}
    </div>
  );
}
