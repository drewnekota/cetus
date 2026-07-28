"use client";
/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
 * genre: modern-minimal · macrostructure: Workbench · designed-as-app */
import { useEffect, useRef } from "react";
import { Pencil, Plus, Sparkles, SquareSlash } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";

/** One row in the slash menu: a user command (expands to a prompt) or a skill
 *  (inserts its `/name` token). Group headings distinguish the two kinds. */
export type SlashCommandItem = {
  kind: "command";
  id: string;
  name: string;
  description: string;
  prompt: string;
  /** Set only for Cetus-stored commands — the id `upsert_slash_command` takes.
   *  Runtime-reported commands have no local record and aren't editable. */
  commandId?: string;
};

export type SlashItem =
  | SlashCommandItem
  | { kind: "skill"; id: string; name: string; description: string };

interface Props {
  /** Filtered, ordered rows — commands first, then skills. */
  items: SlashItem[];
  /** Index of the highlighted row (clamped by the caller). */
  activeIndex: number;
  onSelect: (item: SlashItem) => void;
  onHover: (index: number) => void;
  /** Opens the "new slash command" dialog. Omit to hide the affordance. */
  onCreateCommand?: () => void;
  /** Opens the editor for a Cetus-stored command (rows with a `commandId`). */
  onEditCommand?: (item: SlashCommandItem) => void;
}

/** Claude's catalog tags a skill's origin by suffixing its description with
 *  "(user)" / "(project)" / … . That reads as noise mid-sentence, so it's
 *  lifted out of the text and shown as a scope tag on the row. */
const SCOPES = ["user", "project", "plugin", "builtin", "local"];

function splitScope(description: string): { text: string; scope: string | null } {
  const trimmed = description.trimEnd();
  for (const scope of SCOPES) {
    const suffix = `(${scope})`;
    if (trimmed.endsWith(suffix)) {
      return { text: trimmed.slice(0, -suffix.length).trimEnd(), scope };
    }
  }
  return { text: trimmed, scope: null };
}

/**
 * The `/`-triggered menu that floats above the composer. It's purely
 * presentational: detection, filtering and keyboard nav live in the Composer
 * (which keeps focus in the textarea), so this just renders the rows and reports
 * hover/click. Commands and skills are grouped under their own headings — the
 * two behave differently on pick (a command expands to a prompt, a skill hands
 * the runtime a token), so the split has to be visible before choosing.
 */
export function SlashMenu({
  items,
  activeIndex,
  onSelect,
  onHover,
  onCreateCommand,
  onEditCommand,
}: Props) {
  const { t } = useTranslation("chat");
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the highlighted row in view as the user arrows through. Hover moves
  // the same highlight, but scrolling then is wrong: pulling a half-visible row
  // into view slides the list under a stationary pointer, which drops a
  // different row under the cursor and can chase itself.
  const hoverDrivenRef = useRef(false);
  useEffect(() => {
    if (hoverDrivenRef.current) {
      hoverDrivenRef.current = false;
      return;
    }
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (items.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-80 w-full overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
      role="listbox"
    >
      {items.map((item, idx) => {
        // A heading opens each run of one kind. The caller sorts commands
        // first, but deriving the boundary from the rows themselves keeps the
        // labels honest whatever order arrives.
        const startsGroup = idx === 0 || items[idx - 1].kind !== item.kind;
        const active = idx === activeIndex;
        const { text, scope } = splitScope(item.description);
        // Only Cetus-stored commands can be edited; runtime commands and skills
        // live in the CLI's own files.
        const editable =
          item.kind === "command" && !!item.commandId && !!onEditCommand ? item : null;
        return (
          <div key={`${item.kind}-${item.id}`}>
            {startsGroup && (
              <Heading
                label={item.kind === "command" ? t("slash.commands") : t("slash.skills")}
                action={
                  item.kind === "command" && onCreateCommand ? (
                    <button
                      type="button"
                      // onMouseDown (not onClick) so the textarea never blurs
                      // before the dialog takes over focus.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        onCreateCommand();
                      }}
                      title={t("slash.newCommand")}
                      aria-label={t("slash.newCommand")}
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground motion-reduce:transition-none"
                    >
                      <Plus className="size-3" />
                      {t("slash.newCommand")}
                    </button>
                  ) : null
                }
              />
            )}
            <div className="group/row relative">
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
                onMouseMove={() => {
                  if (idx === activeIndex) return;
                  hoverDrivenRef.current = true;
                  onHover(idx);
                }}
                className={cn(
                  "flex w-full items-start gap-2 rounded-md px-3 py-1.5 text-left transition-colors motion-reduce:transition-none",
                  active ? "bg-muted text-foreground" : "hover:bg-muted/60",
                  editable && "pr-9",
                )}
              >
                {item.kind === "skill" ? (
                  <Sparkles className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                ) : (
                  <SquareSlash className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-baseline gap-1.5 font-mono text-xs font-medium">
                    <span className="flex min-w-0 items-baseline">
                      <span className="shrink-0 text-muted-foreground">/</span>
                      <span className="truncate font-sans">{item.name}</span>
                    </span>
                    {scope && (
                      <span className="shrink-0 rounded bg-muted-foreground/10 px-1 py-px font-sans text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                        {scope}
                      </span>
                    )}
                  </span>
                  {text && (
                    <span className="mt-0.5 line-clamp-1 block text-[11px] text-muted-foreground">
                      {text}
                    </span>
                  )}
                </span>
              </button>
              {editable && (
                // Sibling of the row (not a child — no nested buttons). Shown on
                // hover, and always on the keyboard-highlighted row so arrow-nav
                // users can see it exists.
                <button
                  type="button"
                  tabIndex={-1}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onEditCommand?.(editable);
                  }}
                  title={t("slash.editCommand")}
                  aria-label={t("slash.editCommand")}
                  className={cn(
                    // `fade-layer` (see globals.css): without the permanent
                    // compositor layer the hover fade's promote/demote
                    // re-rounds neighbouring content to the device-pixel grid
                    // and the row's leading icon twitches as hover moves
                    // between rows.
                    "fade-layer absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-opacity hover:bg-background hover:text-foreground motion-reduce:transition-none",
                    active ? "opacity-100" : "opacity-0 group-hover/row:opacity-100",
                  )}
                >
                  <Pencil className="size-3" />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Heading({ label, action }: { label: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 pb-1 pt-2">
      <span className="text-[10px] font-medium text-muted-foreground">{label}</span>
      {action}
    </div>
  );
}
