"use client";
import { Check, ChevronsUpDown, LayoutGrid, MessageSquare, MessagesSquare } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useRef } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTranslation } from "@/lib/i18n";

/** How the conversations are laid out — the sidebar and main area follow it.
 *  A sticky preference, independent of which page is showing. */
export type ConversationMode = "chat" | "board" | "threads";

/** What the main area shows: one of the conversation modes, or the
 *  Automations page, which leaves the mode (and so the sidebar) untouched. */
export type SidebarView = ConversationMode | "automations";

export function isConversationMode(value: unknown): value is ConversationMode {
  return value === "chat" || value === "board" || value === "threads";
}

const MODES: {
  id: ConversationMode;
  labelKey: "view.chats" | "view.kanban" | "view.threads";
  icon: LucideIcon;
}[] = [
  { id: "chat", labelKey: "view.chats", icon: MessageSquare },
  { id: "board", labelKey: "view.kanban", icon: LayoutGrid },
  { id: "threads", labelKey: "view.threads", icon: MessagesSquare },
];

interface Props {
  mode: ConversationMode;
  onChange: (mode: ConversationMode) => void;
}

/** The sidebar's mode picker: one compact select instead of a segmented
 *  control, so the set of layouts can grow without crowding the sidebar. */
export function ModeSelect({ mode, onChange }: Props) {
  const { t } = useTranslation("sidebar");
  const current = MODES.find((m) => m.id === mode) ?? MODES[0];
  const CurrentIcon = current.icon;
  // Radix hands focus back to the trigger when the menu closes, and WebKit
  // treats that programmatic focus as :focus-visible — so a mouse pick left
  // the select ringed. Only return focus when the menu was opened by keyboard.
  const openedByPointer = useRef(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="mode-select"
          onPointerDown={() => {
            openedByPointer.current = true;
          }}
          onKeyDown={() => {
            openedByPointer.current = false;
          }}
          className="flex h-8 w-full items-center gap-2 rounded-lg border border-border bg-card px-2.5 text-left text-sm font-medium text-foreground shadow-[0px_1px_2px_0px_rgba(0,0,0,0.04)] outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-accent/50"
        >
          <CurrentIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{t(current.labelKey)}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="rounded-lg"
        onCloseAutoFocus={(e) => {
          if (openedByPointer.current) e.preventDefault();
        }}
      >
        {MODES.map((m) => {
          const Icon = m.icon;
          const active = m.id === mode;
          return (
            <DropdownMenuItem
              key={m.id}
              onSelect={() => onChange(m.id)}
              className="gap-2"
            >
              <Icon className="size-3.5 text-muted-foreground" />
              <span className="flex-1">{t(m.labelKey)}</span>
              {active && <Check className="size-3.5" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
