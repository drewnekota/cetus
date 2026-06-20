"use client";
import {
  memo,
  useCallback,
  useMemo,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Archive,
  ArchiveRestore,
  Clock,
  Folder,
  PlusCircle,
  Settings as SettingsIcon,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Kbd } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ViewToggle, type SidebarView } from "@/components/sidebar/view-toggle";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";
import { workspaceName } from "@/lib/paths";
import type { Conversation } from "@/lib/types";

interface Props {
  conversations: Conversation[];
  activeId: string | null;
  defaultWorkspace: string;
  view: SidebarView;
  onViewChange: (v: SidebarView) => void;
  workspaceFilter: string | null;
  onWorkspaceFilterChange: (dir: string | null) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onArchive: (c: Conversation) => void;
  onOpenSettings: () => void;
}

export const AppSidebar = memo(function AppSidebar({
  conversations,
  activeId,
  defaultWorkspace,
  view,
  onViewChange,
  workspaceFilter,
  onWorkspaceFilterChange,
  onSelect,
  onNew,
  onArchive,
  onOpenSettings,
}: Props) {
  const { t } = useTranslation("sidebar");
  const { width, startResize, resetWidth } = useSidebarWidth();
  const groups = useMemo(() => groupByWorkspace(conversations), [conversations]);
  const chatGroups = groups;
  const workspaceCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of conversations) m.set(c.workspaceDir, (m.get(c.workspaceDir) ?? 0) + 1);
    return m;
  }, [conversations]);

  // The top action is a conversations action: "New task" on the board, "New
  // chat" everywhere else. It stays "New chat" on the Automations destination —
  // automations are created from that page's own button.
  const newLabel = view === "board" ? t("new.task") : t("new.chat");

  return (
    <Sidebar
      collapsible="none"
      style={{ "--sidebar-width": `${width}px` } as CSSProperties}
      className={cn(
        // `relative` anchors the drag-to-resize handle pinned to the right edge.
        "relative",
        // Fully transparent: the sidebar IS the window's vibrancy (Arc-style
        // glass shell). No tint and no gradient, so the sidebar reads as exactly
        // the same frosted pane as the margins around the content card — one
        // continuous frost wrapping the opaque card, no seam. The card's own
        // border is what separates the two.
        "bg-transparent",
        // Trim the row scale a notch below shadcn's defaults: 13px text (vs
        // 14px) and 14px icons (vs 16px). Scoped to this sidebar via descendant
        // selectors + `!` so they win over the menu-button base styles without
        // forking the shared primitive.
        "[&_[data-slot=sidebar-menu-button]]:!text-[13px] [&_[data-slot=sidebar-menu-button]_svg]:!size-3.5",
        // The row archive action is a shared primitive that ships a 20px box +
        // 16px glyph — oversized next to the trimmed 14px row icons. Shrink both,
        // scoped to this sidebar so the primitive stays untouched elsewhere.
        "[&_[data-slot=sidebar-menu-action]]:!w-4 [&_[data-slot=sidebar-menu-action]_svg]:!size-3",
      )}
    >
      <SidebarHeader className="gap-2">
        {/* Clears the macOS traffic lights (overlay title bar) and doubles as a
            window drag handle, since there's no native title bar to grab. */}
        <div data-tauri-drag-region className="h-6 w-full shrink-0" />
        <SidebarMenu>
          <SidebarMenuItem>
            {/* Not a destination — it's just the brand mark, so render it as a
                plain row (no hover/active state, no pointer cursor). */}
            <SidebarMenuButton
              asChild
              className="data-[slot=sidebar-menu-button]:!p-1.5 cursor-default hover:bg-transparent hover:text-sidebar-foreground active:bg-transparent active:text-sidebar-foreground"
            >
              <div>
                <span className="font-serif text-sm font-semibold italic">
                  cetus
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <ViewToggle view={view} onChange={onViewChange} />
        {/* New chat + Automations are pinned with the header (logo + toggle) so
            they stay put while the conversation / workspace list scrolls. */}
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={newLabel}
              onClick={onNew}
              // Subtle elevated surface (lighter than the sidebar/background in
              // dark mode) rather than a bold primary fill — matches the calmer
              // selected-row treatment. Brightness hover keeps it reading as the
              // primary action in both themes.
              className="min-w-8 bg-sidebar-accent text-sidebar-accent-foreground transition-[filter] duration-200 ease-linear hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:brightness-110 active:brightness-95 dark:hover:brightness-125"
            >
              <PlusCircle />
              <span>{newLabel}</span>
              <Kbd className="ml-auto border-transparent bg-foreground/10 text-muted-foreground">
                ⌘N
              </Kbd>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {/* Automations is its own destination (a scheduled-prompt feature),
              not a layout of the conversations — so it lives as a nav row here
              rather than in the Chat/Kanban toggle. */}
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={t("nav.automations")}
              isActive={view === "automations"}
              onClick={() => onViewChange("automations")}
            >
              <Clock />
              <span>{t("nav.automations")}</span>
              <Kbd className="ml-auto border-transparent">⌘3</Kbd>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {view === "board" ? (
          <SidebarGroup>
            <SidebarGroupLabel>{t("section.workspaces")}</SidebarGroupLabel>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() => onWorkspaceFilterChange(null)}
                  isActive={workspaceFilter === null}
                >
                  <span className="truncate">{t("workspace.all")}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    {conversations.length}
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {groups.map((g) => (
                <SidebarMenuItem key={g.dir}>
                  <SidebarMenuButton
                    onClick={() => onWorkspaceFilterChange(g.dir)}
                    isActive={workspaceFilter === g.dir}
                  >
                    <Folder />
                    <span className="truncate">
                      {shorten(g.dir, defaultWorkspace, t("workspace.default"))}
                    </span>
                    <span
                      className={cn(
                        "ml-auto text-[11px]",
                        workspaceFilter === g.dir
                          ? "text-sidebar-accent-foreground/80"
                          : "text-muted-foreground",
                      )}
                    >
                      {workspaceCounts.get(g.dir) ?? 0}
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ) : chatGroups.length === 0 ? (
          <div className="px-3 py-6 text-xs text-muted-foreground">
            {t("chats.empty.prefix")}{" "}
            <Kbd className="border-border bg-muted">⌘N</Kbd>{" "}
            {t("chats.empty.suffix")}
          </div>
        ) : (
          chatGroups.map((g) => (
            <SidebarGroup key={g.dir}>
              <SidebarGroupLabel>
                <Folder className="mr-1.5 !size-3" />
                <span className="truncate">
                  {shorten(g.dir, defaultWorkspace, t("workspace.default"))}
                </span>
              </SidebarGroupLabel>
              <SidebarMenu>
                {g.items.map((c) => (
                  <ConversationRow
                    key={c.id}
                    conversation={c}
                    active={c.id === activeId}
                    onSelect={onSelect}
                    onArchive={onArchive}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroup>
          ))
        )}
      </SidebarContent>

      {/* Pinned below the scroll area so Settings is always reachable, even
          with a long conversation list. */}
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={onOpenSettings} tooltip={t("nav.settings")}>
              <SettingsIcon />
              <span>{t("nav.settings")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarResizeHandle onResizeStart={startResize} onReset={resetWidth} />
    </Sidebar>
  );
});

const SIDEBAR_WIDTH_KEY = "cetus.sidebar-width";
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_DEFAULT_WIDTH = 224; // 14rem, matches the prior fixed width

function clampWidth(w: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, w));
}

/** Drag-to-resize state for the sidebar, persisted to localStorage. Width is in
 *  px and clamped to [MIN, MAX]; double-click the handle to reset to default. */
function useSidebarWidth() {
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === "undefined") return SIDEBAR_DEFAULT_WIDTH;
    const saved = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return saved > 0 ? clampWidth(saved) : SIDEBAR_DEFAULT_WIDTH;
  });

  const persist = useCallback((w: number) => {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w));
    } catch {}
  }, []);

  const startResize = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      let startWidth = SIDEBAR_DEFAULT_WIDTH;
      let latest = startWidth;
      // Read the live width off the rendered sidebar so the drag starts from
      // wherever it currently sits, even mid-animation.
      const root = e.currentTarget.parentElement;
      if (root) startWidth = latest = root.getBoundingClientRect().width;

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (ev: PointerEvent) => {
        latest = clampWidth(startWidth + (ev.clientX - startX));
        setWidth(latest);
      };
      const onUp = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        persist(latest);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [persist],
  );

  const resetWidth = useCallback(() => {
    setWidth(SIDEBAR_DEFAULT_WIDTH);
    persist(SIDEBAR_DEFAULT_WIDTH);
  }, [persist]);

  return { width, startResize, resetWidth };
}

function SidebarResizeHandle({
  onResizeStart,
  onReset,
}: {
  onResizeStart: (e: ReactPointerEvent<HTMLElement>) => void;
  onReset: () => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onResizeStart}
      onDoubleClick={onReset}
      className="group/resize absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none select-none"
    >
      {/* 1px line straddling the edge; brightens on hover/drag for affordance. */}
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover/resize:bg-sidebar-border group-active/resize:bg-sidebar-border" />
    </div>
  );
}

/** Memoized so one conversation updating (auto-title landing, selection moving)
 *  doesn't reconcile every other row. Bites only because the parent passes
 *  identity-stable onSelect/onArchive (see page.tsx useCallback wrappers) and
 *  the `conversation` ref is stable unless that row actually changed. */
const ConversationRow = memo(function ConversationRow({
  conversation,
  active,
  onSelect,
  onArchive,
}: {
  conversation: Conversation;
  active: boolean;
  onSelect: (id: string) => void;
  onArchive: (c: Conversation) => void;
}) {
  const { t } = useTranslation("sidebar");
  const archived = !!conversation.archivedAt;
  const title = conversation.title || t("conversation.untitled");
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={() => onSelect(conversation.id)}
        isActive={active}
        // No `tooltip` prop: under collapsible="none" the SidebarMenuButton
        // tooltip is always `hidden` (state is "expanded"), so it never showed —
        // it just minted a dead Radix Tooltip per row. Dropped for the win.
        //
        // The archive button is an absolutely-positioned sibling of this row
        // button, so moving the cursor onto it drops the row button's own
        // `:hover` and the row would lose its highlight. Drive the highlight off
        // the menu-item group hover instead so it persists while the cursor is
        // anywhere in the row, including over the archive action.
        className={cn(
          !active &&
            "group-hover/menu-item:bg-sidebar-accent group-hover/menu-item:text-sidebar-accent-foreground",
        )}
      >
        {conversation.sourceAutomationId && (
          <Clock className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{title}</span>
      </SidebarMenuButton>
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarMenuAction
            showOnHover
            onClick={(e) => {
              e.stopPropagation();
              onArchive(conversation);
            }}
            className="rounded-sm text-muted-foreground"
          >
            {archived ? <ArchiveRestore /> : <Archive />}
            <span className="sr-only">
              {archived ? t("action.unarchive") : t("action.archive")}
            </span>
          </SidebarMenuAction>
        </TooltipTrigger>
        <TooltipContent side="right">
          {archived ? t("action.unarchive") : t("action.archive")}
        </TooltipContent>
      </Tooltip>
    </SidebarMenuItem>
  );
});

function groupByWorkspace(
  items: Conversation[],
): { dir: string; items: Conversation[] }[] {
  const order: string[] = [];
  const map = new Map<string, Conversation[]>();
  for (const c of items) {
    if (!map.has(c.workspaceDir)) {
      map.set(c.workspaceDir, []);
      order.push(c.workspaceDir);
    }
    map.get(c.workspaceDir)!.push(c);
  }
  return order.map((dir) => ({ dir, items: map.get(dir)! }));
}

function shorten(
  p: string,
  defaultWorkspace: string,
  defaultLabel: string,
): string {
  if (p === defaultWorkspace) return defaultLabel;
  return workspaceName(p);
}
