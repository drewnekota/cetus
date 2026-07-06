"use client";
import {
  memo,
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ResourcesPopover } from "@/components/sidebar/resources-popover";
import {
  Archive,
  ArchiveRestore,
  Blocks,
  Clock,
  Folder,
  FolderOpen,
  MessageSquare,
  MoreHorizontal,
  PlusCircle,
  Settings as SettingsIcon,
  SquarePen,
  X,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ViewToggle, type SidebarView } from "@/components/sidebar/view-toggle";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";
import { shortcutDisplay, useKeyboardShortcuts } from "@/lib/keyboard-shortcuts";
import { workspaceName } from "@/lib/paths";
import { formatFullDateTime } from "@/lib/format";
import { formatRelativeTime } from "@/lib/conversation-search";
import type { Conversation } from "@/lib/types";

interface Props {
  conversations: Conversation[];
  activeId: string | null;
  streamingIds: Set<string>;
  unreadCompletedIds: Set<string>;
  workspaceDirs: string[];
  hiddenWorkspaceDirs: string[];
  /** The backend's default workspace dir. Rendered as the standalone "Chat"
   *  section rather than a folder — users shouldn't perceive it as one. */
  defaultWorkspace: string;
  view: SidebarView;
  onViewChange: (v: SidebarView) => void;
  workspaceFilter: string | null;
  onWorkspaceFilterChange: (dir: string | null) => void;
  onSelect: (id: string) => void;
  onNew: (workspaceDir?: string) => void;
  onRevealWorkspace: (dir: string) => void;
  onArchiveWorkspaceChats: (dir: string) => void;
  onRemoveWorkspace: (dir: string) => void;
  /** Persist a drag-reordered list of the non-default workspace folders. */
  onReorderWorkspaces: (dirs: string[]) => void;
  onArchive: (c: Conversation) => void;
  onOpenSettings: () => void;
}

export const AppSidebar = memo(function AppSidebar({
  conversations,
  activeId,
  streamingIds,
  unreadCompletedIds,
  workspaceDirs,
  hiddenWorkspaceDirs,
  defaultWorkspace,
  view,
  onViewChange,
  workspaceFilter,
  onWorkspaceFilterChange,
  onSelect,
  onNew,
  onRevealWorkspace,
  onArchiveWorkspaceChats,
  onRemoveWorkspace,
  onReorderWorkspaces,
  onArchive,
  onOpenSettings,
}: Props) {
  const { t } = useTranslation("sidebar");
  const shortcuts = useKeyboardShortcuts();
  const shortcutLabels = useMemo(
    () => ({
      newChat: shortcutDisplay(shortcuts.newChat),
      archiveChat: shortcutDisplay(shortcuts.archiveChat),
      switchChats: shortcutDisplay(shortcuts.switchChats),
      switchBoard: shortcutDisplay(shortcuts.switchBoard),
      switchAutomations: shortcutDisplay(shortcuts.switchAutomations),
      switchPlugins: shortcutDisplay(shortcuts.switchPlugins),
    }),
    [shortcuts],
  );
  const { width, startResize, resetWidth } = useSidebarWidth();
  const groups = useMemo(
    () =>
      groupByWorkspace(
        conversations,
        workspaceDirs,
        hiddenWorkspaceDirs,
        defaultWorkspace,
      ),
    [conversations, workspaceDirs, hiddenWorkspaceDirs, defaultWorkspace],
  );
  const chatGroups = groups;
  // The default workspace surfaces as the standalone "Chat" section, pinned
  // first; only the real workspace folders below it are draggable.
  const defaultGroup = useMemo(
    () => groups.find((g) => g.dir === defaultWorkspace) ?? null,
    [groups, defaultWorkspace],
  );
  const folderGroups = useMemo(
    () => groups.filter((g) => g.dir !== defaultWorkspace),
    [groups, defaultWorkspace],
  );
  const sortableIds = useMemo(() => folderGroups.map((g) => g.dir), [folderGroups]);
  // A short hold before a press becomes a drag, so clicks/scrolls on a folder
  // header don't start a reorder. The tolerance lets a tiny jitter through.
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { delay: 250, tolerance: 8 },
    }),
  );
  const [activeDragDir, setActiveDragDir] = useState<string | null>(null);
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragDir(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const from = sortableIds.indexOf(String(active.id));
      const to = sortableIds.indexOf(String(over.id));
      if (from === -1 || to === -1) return;
      const next = sortableIds.slice();
      next.splice(from, 1);
      next.splice(to, 0, String(active.id));
      onReorderWorkspaces(next);
    },
    [sortableIds, onReorderWorkspaces],
  );
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
        // Solid sidebar token, no backdrop-filter: the shell root already paints
        // opaque bg-sidebar, so the old translucent+blurred surface only blurred
        // a flat color while forcing a GPU recomposite of the whole strip on
        // every repaint (and it compounded with a long conversation list into
        // scroll jank).
        "bg-sidebar",
        // Trim the row scale a notch below shadcn's defaults: 13px text (vs
        // 14px) and 14px icons (vs 16px). Scoped to this sidebar via descendant
        // selectors + `!` so they win over the menu-button base styles without
        // forking the shared primitive.
        "[&_[data-slot=sidebar-menu-button]]:!text-[13px] [&_[data-slot=sidebar-menu-button]_svg]:!size-3.5",
        // The row archive action is a shared primitive that ships a 20px box +
        // 16px glyph — oversized next to the trimmed 14px row icons. Shrink both,
        // scoped to this sidebar so the primitive stays untouched elsewhere.
        "[&_[data-slot=sidebar-menu-action]]:!w-3.5 [&_[data-slot=sidebar-menu-action]_svg]:!size-3",
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
              className="data-[slot=sidebar-menu-button]:!gap-1 data-[slot=sidebar-menu-button]:!p-1.5 cursor-default hover:bg-transparent hover:text-sidebar-foreground active:bg-transparent active:text-sidebar-foreground"
            >
              <div>
                <img
                  src="/icon.png"
                  alt=""
                  aria-hidden="true"
                  className="size-5 shrink-0 rounded-[5px]"
                />
                <span className="translate-y-px font-serif text-sm font-bold italic">
                  Cetus
                </span>
                {/* Resources lives at the sidebar's top-right as an icon-only
                    affordance — it's a monitor, not a nav destination. */}
                <span className="ml-auto">
                  <ResourcesPopover />
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <ViewToggle
          view={view}
          onChange={onViewChange}
          hints={{
            chat: shortcutLabels.switchChats,
            board: shortcutLabels.switchBoard,
          }}
        />
        {/* New chat + Automations are pinned with the header (logo + toggle) so
            they stay put while the conversation / workspace list scrolls. */}
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={newLabel}
              onClick={() => onNew()}
              // Plain nav row (no standalone fill) so it sits flush with the
              // other sidebar actions; the hover/active states come from the
              // default SidebarMenuButton treatment.
              className="min-w-8"
            >
              <PlusCircle />
              <span>{newLabel}</span>
              <Kbd className="ml-auto border-transparent">{shortcutLabels.newChat}</Kbd>
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
              <Kbd className="ml-auto border-transparent">
                {shortcutLabels.switchAutomations}
              </Kbd>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={t("nav.plugins")}
              isActive={view === "plugins"}
              onClick={() => onViewChange("plugins")}
            >
              <Blocks />
              <span>{t("nav.plugins")}</span>
              <Kbd className="ml-auto border-transparent">
                {shortcutLabels.switchPlugins}
              </Kbd>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {view === "board" ? (
          <SidebarGroup>
            <SidebarGroupLabel>{t("section.workspaces")}</SidebarGroupLabel>
            <SidebarMenu>
              {/* "All workspaces" is a pseudo-filter (null), pinned at the very
                  top and never reorderable. */}
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
              {/* "Chat" (the default workspace) is pinned below "All" and never
                  reorderable — it isn't a folder to the user. */}
              {defaultGroup && (
                <SidebarMenuItem>
                  <WorkspaceFilterButton
                    label={t("workspace.default")}
                    icon={<MessageSquare />}
                    count={workspaceCounts.get(defaultGroup.dir) ?? 0}
                    active={workspaceFilter === defaultGroup.dir}
                    onSelect={() => onWorkspaceFilterChange(defaultGroup.dir)}
                  />
                </SidebarMenuItem>
              )}
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={(e) => setActiveDragDir(String(e.active.id))}
                onDragCancel={() => setActiveDragDir(null)}
                onDragEnd={handleDragEnd}
              >
                <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
                  {folderGroups.map((g) => (
                    <SortableWorkspaceFilterRow
                      key={g.dir}
                      dir={g.dir}
                      label={workspaceName(g.dir)}
                      count={workspaceCounts.get(g.dir) ?? 0}
                      active={workspaceFilter === g.dir}
                      onSelect={() => onWorkspaceFilterChange(g.dir)}
                    />
                  ))}
                </SortableContext>
                {typeof document !== "undefined" &&
                  createPortal(
                    <DragOverlay dropAnimation={null}>
                      {activeDragDir ? (
                        <WorkspaceDragGhost label={workspaceName(activeDragDir)} />
                      ) : null}
                    </DragOverlay>,
                    document.body,
                  )}
              </DndContext>
            </SidebarMenu>
          </SidebarGroup>
        ) : chatGroups.length === 0 ? (
          <div className="px-3 py-6 text-xs text-muted-foreground">
            {t("chats.empty.prefix")}{" "}
            <Kbd className="border-border bg-muted">{shortcutLabels.newChat}</Kbd>{" "}
            {t("chats.empty.suffix")}
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={(e) => setActiveDragDir(String(e.active.id))}
            onDragCancel={() => setActiveDragDir(null)}
            onDragEnd={handleDragEnd}
          >
            {/* "Chat" (the default workspace) is pinned first, outside the
                sortable list — it reads as a plain section, not a folder. */}
            {defaultGroup && (
              <SidebarGroup>
                <WorkspaceGroupView
                  group={defaultGroup}
                  label={t("workspace.default")}
                  isDefault
                  activeId={activeId}
                  streamingIds={streamingIds}
                  unreadCompletedIds={unreadCompletedIds}
                  archiveShortcut={shortcutLabels.archiveChat}
                  onNew={onNew}
                  onSelect={onSelect}
                  onArchive={onArchive}
                  onRevealWorkspace={onRevealWorkspace}
                  onArchiveWorkspaceChats={onArchiveWorkspaceChats}
                  onRemoveWorkspace={onRemoveWorkspace}
                />
              </SidebarGroup>
            )}
            <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
              {folderGroups.map((g) => (
                <SortableWorkspaceGroup
                  key={g.dir}
                  group={g}
                  label={workspaceName(g.dir)}
                  activeId={activeId}
                  streamingIds={streamingIds}
                  unreadCompletedIds={unreadCompletedIds}
                  archiveShortcut={shortcutLabels.archiveChat}
                  onNew={onNew}
                  onSelect={onSelect}
                  onArchive={onArchive}
                  onRevealWorkspace={onRevealWorkspace}
                  onArchiveWorkspaceChats={onArchiveWorkspaceChats}
                  onRemoveWorkspace={onRemoveWorkspace}
                />
              ))}
            </SortableContext>
            {typeof document !== "undefined" &&
              createPortal(
                <DragOverlay dropAnimation={null}>
                  {activeDragDir ? (
                    <WorkspaceDragGhost label={workspaceName(activeDragDir)} />
                  ) : null}
                </DragOverlay>,
                document.body,
              )}
          </DndContext>
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

// The folder row's "active" look (accent header + revealed action icons) shows
// on hover, while its dropdown is open, or under *keyboard* focus. We key off
// `:has(:focus-visible)` rather than `:focus-within` on purpose: when a menu is
// dismissed by mouse, Radix returns focus to the trigger, and `:focus-within`
// would leave the whole row stuck in its hover state until you clicked away.
const ROW_ACCENT_CLASS =
  "group-hover/project-row:bg-sidebar-accent group-hover/project-row:text-sidebar-accent-foreground " +
  "group-has-[[data-state=open]]/project-row:bg-sidebar-accent group-has-[[data-state=open]]/project-row:text-sidebar-accent-foreground " +
  "group-has-[:focus-visible]/project-row:bg-sidebar-accent group-has-[:focus-visible]/project-row:text-sidebar-accent-foreground";

const ROW_ACTION_CLASS =
  "flex size-4 items-center justify-center rounded-sm text-muted-foreground opacity-0 outline-hidden transition-opacity " +
  "hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring " +
  "group-hover/project-row:opacity-100 group-has-[[data-state=open]]/project-row:opacity-100 group-has-[:focus-visible]/project-row:opacity-100";

interface WorkspaceGroupViewProps {
  group: { dir: string; items: Conversation[] };
  label: string;
  /** The standalone "Chat" section: chat icon instead of a folder, and no
   *  folder-ish actions (reveal / remove) — it shouldn't read as a folder. */
  isDefault?: boolean;
  /** Drag-handle props (attributes + listeners) from useSortable. */
  handleProps?: Record<string, unknown>;
  activeId: string | null;
  streamingIds: Set<string>;
  unreadCompletedIds: Set<string>;
  archiveShortcut: string;
  onNew: (workspaceDir?: string) => void;
  onSelect: (id: string) => void;
  onArchive: (c: Conversation) => void;
  onRevealWorkspace: (dir: string) => void;
  onArchiveWorkspaceChats: (dir: string) => void;
  onRemoveWorkspace: (dir: string) => void;
}

/** The contents of one workspace group: a folder header (the drag handle), its
 *  hover actions, and the conversation rows. Rendered inside a <SidebarGroup> by
 *  the caller. */
function WorkspaceGroupView({
  group,
  label,
  isDefault,
  handleProps,
  activeId,
  streamingIds,
  unreadCompletedIds,
  archiveShortcut,
  onNew,
  onSelect,
  onArchive,
  onRevealWorkspace,
  onArchiveWorkspaceChats,
  onRemoveWorkspace,
}: WorkspaceGroupViewProps) {
  const { t } = useTranslation("sidebar");
  return (
    <>
      <div className="group/project-row relative">
        <SidebarGroupLabel
          {...handleProps}
          className={cn(
            "pr-16",
            ROW_ACCENT_CLASS,
            handleProps && "cursor-grab touch-none select-none active:cursor-grabbing",
          )}
        >
          {isDefault ? (
            <MessageSquare className="mr-1.5 !size-3" />
          ) : (
            <Folder className="mr-1.5 !size-3" />
          )}
          <span className="truncate">{label}</span>
        </SidebarGroupLabel>
        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-2">
          <button
            type="button"
            onClick={() => onNew(group.dir)}
            className={ROW_ACTION_CLASS}
          >
            <SquarePen className="size-3" />
            <span className="sr-only">
              {t("action.newChatIn", { workspace: label })}
            </span>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className={ROW_ACTION_CLASS}>
                <MoreHorizontal className="size-3" />
                <span className="sr-only">{t("action.more")}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="start" className="w-52">
              {/* Reveal / Remove are folder actions — the standalone Chat
                  section keeps only Archive so it never reads as a folder. */}
              {!isDefault && (
                <DropdownMenuItem onSelect={() => onRevealWorkspace(group.dir)}>
                  <FolderOpen />
                  <span>{t("action.reveal")}</span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                disabled={group.items.length === 0}
                onSelect={() => onArchiveWorkspaceChats(group.dir)}
              >
                <Archive />
                <span>{t("action.archiveChats")}</span>
              </DropdownMenuItem>
              {!isDefault && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => onRemoveWorkspace(group.dir)}
                  >
                    <X />
                    <span>{t("action.remove")}</span>
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <SidebarMenu>
        {group.items.length === 0 ? (
          <SidebarMenuItem>
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              {t("chats.empty.group")}
            </div>
          </SidebarMenuItem>
        ) : (
          group.items.map((c) => (
            <ConversationRow
              key={c.id}
              conversation={c}
              active={c.id === activeId}
              streaming={streamingIds.has(c.id)}
              unreadCompleted={unreadCompletedIds.has(c.id)}
              onSelect={onSelect}
              onArchive={onArchive}
              archiveShortcut={archiveShortcut}
            />
          ))
        )}
      </SidebarMenu>
    </>
  );
}

/** A workspace group wired into dnd-kit's sortable list: the whole group slides
 *  with a GPU transform while dragging, and the folder header is the handle. */
function SortableWorkspaceGroup(props: Omit<WorkspaceGroupViewProps, "handleProps">) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: props.group.dir });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      // Hide the source while its ghost rides under the cursor in the overlay.
      className={cn(isDragging && "opacity-0")}
    >
      <SidebarGroup>
        <WorkspaceGroupView
          {...props}
          handleProps={{ ...attributes, ...listeners }}
        />
      </SidebarGroup>
    </div>
  );
}

/** A workspace row in the board view's filter list. The whole row doubles as a
 *  click-to-filter button and (when `handleProps` is supplied) a drag handle. */
function WorkspaceFilterButton({
  label,
  count,
  active,
  onSelect,
  handleProps,
  icon,
}: {
  label: string;
  count: number;
  active: boolean;
  onSelect: () => void;
  handleProps?: Record<string, unknown>;
  /** Overrides the folder glyph — the pinned "Chat" row shows a chat icon. */
  icon?: ReactNode;
}) {
  return (
    <SidebarMenuButton
      {...handleProps}
      onClick={onSelect}
      isActive={active}
      className={cn(handleProps && "cursor-grab touch-none select-none active:cursor-grabbing")}
    >
      {icon ?? <Folder />}
      <span className="truncate">{label}</span>
      <span
        className={cn(
          "ml-auto text-[11px]",
          active ? "text-sidebar-accent-foreground/80" : "text-muted-foreground",
        )}
      >
        {count}
      </span>
    </SidebarMenuButton>
  );
}

/** A board-view filter row wired into dnd-kit's sortable list. A 250ms hold
 *  starts a drag; a plain click still filters. */
function SortableWorkspaceFilterRow({
  dir,
  label,
  count,
  active,
  onSelect,
}: {
  dir: string;
  label: string;
  count: number;
  active: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: dir });
  return (
    <SidebarMenuItem
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && "opacity-0")}
    >
      <WorkspaceFilterButton
        label={label}
        count={count}
        active={active}
        onSelect={onSelect}
        handleProps={{ ...attributes, ...listeners }}
      />
    </SidebarMenuItem>
  );
}

/** The folder header that floats under the cursor while dragging (rendered in
 *  dnd-kit's DragOverlay, so it tracks the pointer at 60fps). */
function WorkspaceDragGhost({ label }: { label: string }) {
  return (
    <div className="flex h-8 cursor-grabbing items-center rounded-md bg-sidebar px-2 text-xs font-medium text-sidebar-accent-foreground shadow-lg ring-1 ring-sidebar-border">
      <Folder className="mr-1.5 !size-3" />
      <span className="truncate">{label}</span>
    </div>
  );
}

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

// A single app-wide minute clock. Rows subscribe individually via
// useSyncExternalStore, so a tick re-renders only the conversation rows (whose
// relative-time label can change) — not the whole sidebar, the dnd context, or
// the workspace groups, the way prop-drilling a `nowMs` down the tree did.
// Offscreen rows that re-render are skipped at layout/paint by
// `content-visibility:auto`, so the per-minute cost stays flat no matter how
// many conversations exist. The interval runs only while at least one row is
// mounted, aligned to the wall-clock minute boundary.
const minuteClock = (() => {
  let now = Date.now();
  const listeners = new Set<() => void>();
  let first: number | undefined;
  let interval: number | undefined;
  const tick = () => {
    now = Date.now();
    for (const l of listeners) l();
  };
  const ensureRunning = () => {
    if (first !== undefined || interval !== undefined) return;
    first = window.setTimeout(() => {
      first = undefined;
      tick();
      interval = window.setInterval(tick, 60_000);
    }, 60_000 - (Date.now() % 60_000));
  };
  const stop = () => {
    if (first !== undefined) window.clearTimeout(first);
    if (interval !== undefined) window.clearInterval(interval);
    first = undefined;
    interval = undefined;
  };
  return {
    subscribe(cb: () => void) {
      listeners.add(cb);
      ensureRunning();
      return () => {
        listeners.delete(cb);
        if (listeners.size === 0) stop();
      };
    },
    get: () => now,
  };
})();

function useMinuteNow(): number {
  return useSyncExternalStore(
    minuteClock.subscribe,
    minuteClock.get,
    minuteClock.get,
  );
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
  streaming,
  unreadCompleted,
  onSelect,
  onArchive,
  archiveShortcut,
}: {
  conversation: Conversation;
  active: boolean;
  streaming: boolean;
  unreadCompleted: boolean;
  onSelect: (id: string) => void;
  onArchive: (c: Conversation) => void;
  archiveShortcut: string;
}) {
  const { t } = useTranslation("sidebar");
  // Read the minute clock here rather than as a prop, so a tick re-renders only
  // the rows — not the whole sidebar tree (see minuteClock above).
  const nowMs = useMinuteNow();
  const archived = !!conversation.archivedAt;
  const title = conversation.title || t("conversation.untitled");
  const relativeTime = formatRelativeTime(conversation.updatedAt, nowMs);
  return (
    // NB: no `content-visibility:auto` here. It broke under the sidebar's old
    // `backdrop-blur` ancestor (containing block defeated in-viewport
    // detection, blanking visible rows); the blur is gone now, but the
    // minute-clock scoping already removed the per-minute re-render cost, and
    // a long list would need a real virtualizer anyway.
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
          "relative pr-10",
          !active &&
            "group-hover/menu-item:bg-sidebar-accent group-hover/menu-item:text-sidebar-accent-foreground",
        )}
      >
        {conversation.sourceAutomationId && (
          <Clock className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span
          title={streaming ? t("conversation.inProgress") : formatFullDateTime(conversation.updatedAt)}
          className={cn(
            "absolute right-2 flex w-7 shrink-0 items-center justify-center text-[11px] tabular-nums text-muted-foreground/70 transition-opacity",
            "group-focus-within/menu-item:opacity-0 group-hover/menu-item:opacity-0",
            active && "text-sidebar-accent-foreground/70",
          )}
        >
          {streaming ? (
            <span
              aria-label={t("conversation.inProgress")}
              className="block size-3 animate-spin rounded-full border-2 border-current/35 border-t-current"
            />
          ) : unreadCompleted ? (
            <span className="block size-2 rounded-full bg-primary">
              <span className="sr-only">Unread</span>
            </span>
          ) : (
            relativeTime
          )}
        </span>
      </SidebarMenuButton>
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarMenuAction
            showOnHover
            onClick={(e) => {
              e.stopPropagation();
              onArchive(conversation);
            }}
            className="!right-2 !top-1/2 !w-7 !-translate-y-1/2 rounded-sm !text-muted-foreground/60 hover:!bg-transparent hover:!text-muted-foreground"
          >
            {archived ? <ArchiveRestore /> : <Archive />}
            <span className="sr-only">
              {archived ? t("action.unarchive") : t("action.archive")}
            </span>
          </SidebarMenuAction>
        </TooltipTrigger>
        <TooltipContent side="right">
          <span>{archived ? t("action.unarchive") : t("action.archive")}</span>
          <Kbd>{archiveShortcut}</Kbd>
        </TooltipContent>
      </Tooltip>
    </SidebarMenuItem>
  );
});

function groupByWorkspace(
  items: Conversation[],
  workspaceDirs: string[],
  hiddenWorkspaceDirs: string[],
  defaultWorkspace: string,
): { dir: string; items: Conversation[] }[] {
  const order: string[] = [];
  const map = new Map<string, Conversation[]>();
  const hidden = new Set(hiddenWorkspaceDirs);
  // The default workspace ("Chat") always exists and sits first — even with no
  // conversations yet, and regardless of any stale hidden entry.
  hidden.delete(defaultWorkspace);
  const ensure = (dir: string) => {
    if (hidden.has(dir)) return;
    if (!dir || map.has(dir)) return;
    map.set(dir, []);
    order.push(dir);
  };
  ensure(defaultWorkspace);
  for (const dir of workspaceDirs) ensure(dir);
  for (const c of items) {
    ensure(c.workspaceDir);
    map.get(c.workspaceDir)?.push(c);
  }
  return order.map((dir) => ({ dir, items: map.get(dir)! }));
}
