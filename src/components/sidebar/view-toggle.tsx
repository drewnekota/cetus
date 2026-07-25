"use client";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";
import {
  defaultShortcutMap,
  shortcutDisplay,
} from "@/lib/keyboard-shortcuts";

// "chat" and "board" are two layouts of the same data (conversations); the
// toggle switches between them. Automations and Plugins are separate
// destinations reached from sidebar nav rows, not this toggle — so they render
// with neither side active here.
export type SidebarView = "chat" | "board" | "automations" | "plugins";

interface Props {
  view: SidebarView;
  onChange: (v: SidebarView) => void;
  hints?: Partial<Record<ToggleId, string>>;
}

type ToggleId = Extract<SidebarView, "chat" | "board">;

const ITEMS: {
  id: ToggleId;
  labelKey: "view.chats" | "view.kanban";
}[] = [
  { id: "chat", labelKey: "view.chats" },
  { id: "board", labelKey: "view.kanban" },
];

export function ViewToggle({ view, onChange, hints }: Props) {
  const { t } = useTranslation("sidebar");
  const defaults = defaultShortcutMap();
  return (
    <div className="inline-flex w-full items-center rounded-full border border-border bg-card p-0.5 shadow-[0px_1px_2px_0px_rgba(0,0,0,0.04)]">
      {ITEMS.map((it) => {
        const active = view === it.id;
        const label = t(it.labelKey);
        const hint =
          hints?.[it.id] ??
          shortcutDisplay(
            it.id === "chat" ? defaults.switchChats : defaults.switchBoard,
          );
        return (
          <button
            key={it.id}
            type="button"
            onClick={() => onChange(it.id)}
            title={`${label} (${hint})`}
            className={cn(
              "inline-flex flex-1 items-center justify-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors",
              active
                ? "bg-[var(--brand)] text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
            {hint && (
              <kbd
                className={cn(
                  "font-sans text-[10px] leading-none tabular-nums",
                  active ? "text-primary-foreground/65" : "text-muted-foreground/60",
                )}
              >
                {hint}
              </kbd>
            )}
          </button>
        );
      })}
    </div>
  );
}
