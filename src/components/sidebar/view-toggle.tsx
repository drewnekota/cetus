"use client";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";

// "chat" and "board" are two layouts of the same data (conversations); the
// toggle switches between them. Automations and Plugins are separate
// destinations reached from sidebar nav rows, not this toggle — so they render
// with neither side active here.
export type SidebarView = "chat" | "board" | "automations" | "plugins";

interface Props {
  view: SidebarView;
  onChange: (v: SidebarView) => void;
}

type ToggleId = Extract<SidebarView, "chat" | "board">;

const ITEMS: {
  id: ToggleId;
  labelKey: "view.chats" | "view.kanban";
  hint: string;
}[] = [
  { id: "chat", labelKey: "view.chats", hint: "⌘1" },
  { id: "board", labelKey: "view.kanban", hint: "⌘2" },
];

export function ViewToggle({ view, onChange }: Props) {
  const { t } = useTranslation("sidebar");
  return (
    <div className="inline-flex w-full items-center rounded-full border border-border bg-card p-0.5 shadow-[0px_1px_2px_0px_rgba(0,0,0,0.04)]">
      {ITEMS.map((it) => {
        const active = view === it.id;
        const label = t(it.labelKey);
        return (
          <button
            key={it.id}
            type="button"
            onClick={() => onChange(it.id)}
            title={`${label} (${it.hint})`}
            className={cn(
              "inline-flex flex-1 items-center justify-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
            <kbd
              className={cn(
                "font-sans text-[10px] leading-none tabular-nums",
                active ? "text-primary-foreground/65" : "text-muted-foreground/60",
              )}
            >
              {it.hint}
            </kbd>
          </button>
        );
      })}
    </div>
  );
}
