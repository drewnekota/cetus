"use client";

import { countActivity, useInputIds } from "@/lib/session-activity";
import { ActivityBadges } from "@/components/threads/activity-badges";
import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { ResourcesPopover } from "@/components/sidebar/resources-popover";
import {
  Clock,
  MessageSquare,
  PanelLeft,
  PlusCircle,
  RefreshCw,
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
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Kbd } from "@/components/ui/kbd";
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
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  ModeSelect,
  type ConversationMode,
  type SidebarView,
} from "@/components/sidebar/view-toggle";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";
import {
  shortcutDisplay,
  useKeyboardShortcuts,
} from "@/lib/keyboard-shortcuts";
import { workspaceName } from "@/lib/paths";
import { useConversationAutoSort } from "@/lib/conversation-order";
import type { Conversation } from "@/lib/types";
import { useSidebarWidth, SidebarResizeHandle } from "./sidebar-width";
import {
  groupByWorkspace,
  PINNED_GROUP_DIR,
  threadWorkspaceOrder,
} from "./workspace-grouping";
import { visibleConversationIds } from "@/lib/collapsed-workspaces";
import { ChatSlotHintsProvider, useChatSlotHints } from "./chat-slot-hints";
import {
  WorkspaceFilterButton,
  SortableWorkspaceFilterRow,
  WorkspaceDragGhost,
  PinnedGroupView,
  WorkspaceGroupView,
  SortableWorkspaceGroup,
} from "./workspace-groups";

interface Props {
  conversations: Conversation[];
  activeId: string | null;
  streamingIds: Set<string>;
  unreadCompletedIds: Set<string>;
  workspaceDirs: string[];
  hiddenWorkspaceDirs: string[];
  collapsedWorkspaceDirs: ReadonlySet<string>;
  /** Workspaces whose chat list is expanded past WORKSPACE_VISIBLE_LIMIT. */
  expandedWorkspaceDirs: ReadonlySet<string>;
  /** The backend's default workspace dir. Rendered as the standalone "Chat"
   *  section rather than a folder — users shouldn't perceive it as one. */
  defaultWorkspace: string;
  /** The page showing — a conversation mode, or Automations. */
  view: SidebarView;
  /** The conversation mode the sidebar's list follows; kept while the
   *  Automations page is up. */
  mode: ConversationMode;
  onViewChange: (v: SidebarView) => void;
  workspaceFilter: string | null;
  onWorkspaceFilterChange: (dir: string | null) => void;
  onSelect: (id: string) => void;
  onNewTask: () => void;
  onNew: (workspaceDir?: string) => void;
  onRevealWorkspace: (dir: string) => void;
  onArchiveWorkspaceChats: (dir: string) => void;
  onRemoveWorkspace: (dir: string) => void;
  /** Persist a drag-reordered list of the non-default workspace folders. */
  onReorderWorkspaces: (dirs: string[]) => void;
  onToggleWorkspaceCollapsed: (dir: string) => void;
  onToggleWorkspaceExpanded: (dir: string) => void;
  onArchive: (c: Conversation) => void;
  onTogglePin: (c: Conversation) => void;
  onRename: (c: Conversation, title: string) => void;
  onOpenSettings: () => void;
  /** Version of a downloaded-but-not-yet-applied update, or null. When set, a
   *  "Restart to update" button appears above Settings. */
  updateReadyVersion?: string | null;
  onRestartToUpdate?: () => void;
}

export const AppSidebar = memo(function AppSidebar({
  conversations,
  activeId,
  streamingIds,
  unreadCompletedIds,
  workspaceDirs,
  hiddenWorkspaceDirs,
  collapsedWorkspaceDirs,
  expandedWorkspaceDirs,
  defaultWorkspace,
  view,
  mode,
  onViewChange,
  workspaceFilter,
  onWorkspaceFilterChange,
  onSelect,
  onNewTask,
  onNew,
  onRevealWorkspace,
  onArchiveWorkspaceChats,
  onRemoveWorkspace,
  onReorderWorkspaces,
  onToggleWorkspaceCollapsed,
  onToggleWorkspaceExpanded,
  onArchive,
  onTogglePin,
  onRename,
  onOpenSettings,
  updateReadyVersion,
  onRestartToUpdate,
}: Props) {
  const { t } = useTranslation("sidebar");
  const shortcuts = useKeyboardShortcuts();
  // The list keeps the mode's shape under Automations, but nothing in it is
  // the page being shown, so no row reads as selected.
  const onAutomations = view === "automations";
  const shortcutLabels = useMemo(
    () => ({
      newChat: shortcutDisplay(shortcuts.newChat),
      newDefaultChat: shortcutDisplay(shortcuts.newDefaultChat),
      archiveChat: shortcutDisplay(shortcuts.archiveChat),
      toggleSidebar: shortcutDisplay(shortcuts.toggleSidebar),
    }),
    [shortcuts],
  );
  const { width, startResize, resetWidth } = useSidebarWidth();
  const { open: sidebarOpen, setOpen: setSidebarOpen } = useSidebar();
  const autoSortConversations = useConversationAutoSort();
  const groups = useMemo(
    () =>
      groupByWorkspace(
        conversations,
        workspaceDirs,
        hiddenWorkspaceDirs,
        defaultWorkspace,
        autoSortConversations,
      ),
    [
      conversations,
      workspaceDirs,
      hiddenWorkspaceDirs,
      defaultWorkspace,
      autoSortConversations,
    ],
  );
  // The default workspace surfaces as the standalone "Chat" section, pinned
  // first; only the real workspace folders below it are draggable. Keep a
  // synthetic empty group during the first paint while the backend's default
  // directory is still resolving, so the Chat section never disappears.
  const defaultGroup = useMemo(
    () =>
      groups.find((g) => g.dir === defaultWorkspace) ?? {
        dir: defaultWorkspace,
        items: [],
      },
    [groups, defaultWorkspace],
  );
  // Global pinned chats surface as their own section above everything; the
  // group exists only while something is pinned (see groupByWorkspace).
  const pinnedGroup = useMemo(
    () => groups.find((g) => g.dir === PINNED_GROUP_DIR) ?? null,
    [groups],
  );
  const folderGroups = useMemo(
    () =>
      groups.filter(
        (g) => g.dir !== defaultWorkspace && g.dir !== PINNED_GROUP_DIR,
      ),
    [groups, defaultWorkspace],
  );
  // Same visual order the ⌘1…⌘9 handler walks (see use-home-state).
  const visibleChatIds = useMemo(
    () =>
      visibleConversationIds(
        groups,
        collapsedWorkspaceDirs,
        expandedWorkspaceDirs,
      ),
    [groups, collapsedWorkspaceDirs, expandedWorkspaceDirs],
  );
  const chatSlotHints = useChatSlotHints(visibleChatIds, shortcuts);
  // In Threads, ⌘1…⌘9 open folders instead of chats (see use-home-keyboard-
  // shortcuts); the same held-modifier reveal labels the folder rows.
  const threadWorkspaceDirs = useMemo(
    () =>
      mode === "threads"
        ? threadWorkspaceOrder(
            groups.map((g) => g.dir),
            defaultWorkspace,
          )
        : [],
    [mode, groups, defaultWorkspace],
  );
  const workspaceSlotHints = useChatSlotHints(threadWorkspaceDirs, shortcuts);
  const sortableIds = useMemo(
    () => folderGroups.map((g) => g.dir),
    [folderGroups],
  );
  // A short hold before a press becomes a drag, so clicks/scrolls on a folder
  // header don't start a reorder. The tolerance lets a tiny jitter through.
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { delay: 250, tolerance: 8 },
    }),
  );
  const [activeDragDir, setActiveDragDir] = useState<string | null>(null);
  // Releasing a reorder drag fires a click on the folder header (it's both the
  // drag handle and the collapse toggle), which would fold the group you just
  // dropped. Stamp drag-end and swallow toggles that land right after it.
  const lastDragEndAtRef = useRef(0);
  const toggleCollapsed = useCallback(
    (dir: string) => {
      if (Date.now() - lastDragEndAtRef.current < 250) return;
      onToggleWorkspaceCollapsed(dir);
    },
    [onToggleWorkspaceCollapsed],
  );
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragDir(null);
      lastDragEndAtRef.current = Date.now();
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
  const inputIds = useInputIds();
  const workspaceActivity = useMemo(
    () =>
      countActivity(conversations, streamingIds, unreadCompletedIds, inputIds),
    [conversations, streamingIds, unreadCompletedIds, inputIds],
  );

  return (
    <Sidebar
      collapsible="none"
      style={{ "--sidebar-width": `${width}px` } as CSSProperties}
      className={cn(
        // `relative` anchors the drag-to-resize handle pinned to the right edge.
        "relative",
        // Collapsed = focus mode. Hide rather than unmount so the list keeps
        // its scroll position and the dnd/resize state survives a round trip.
        !sidebarOpen && "hidden",
        // Solid sidebar token, no backdrop-filter: the shell root already paints
        // opaque bg-sidebar, so the old translucent+blurred surface only blurred
        // a flat color while forcing a GPU recomposite of the whole strip on
        // every repaint (and it compounded with a long conversation list into
        // scroll jank).
        "bg-sidebar",
        // The sidebar sits one notch under the UI text (13px at the default
        // size) so it doesn't outweigh the chat body: everything in here that
        // reads text-sm resolves to text-md instead, still following the
        // "Interface font size" setting. Portaled menus keep 14px.
        "[--text-sm:var(--text-md)] [--text-sm--line-height:var(--text-md--line-height)]",
        // The row archive action is a shared primitive that ships a 20px box +
        // 16px glyph; trim it a notch so the hover cluster stays lighter than
        // the row's own leading icon. Scoped to this sidebar.
        "[&_[data-slot=sidebar-menu-action]]:w-4! [&_[data-slot=sidebar-menu-action]_svg]:size-3.5!",
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
              className="data-[slot=sidebar-menu-button]:gap-1! data-[slot=sidebar-menu-button]:p-1.5! cursor-default hover:bg-transparent hover:text-sidebar-foreground active:bg-transparent active:text-sidebar-foreground"
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
                {/* Collapse lives at the sidebar's top-right; when hidden, the
                    matching expand button appears at the content card's
                    top-left (page.tsx header). */}
                <span className="ml-auto">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => setSidebarOpen(false)}
                        data-testid="sidebar-collapse"
                        className={cn(
                          "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-hidden transition-colors",
                          "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                          "focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                        )}
                      >
                        <PanelLeft className="size-3.5" />
                        <span className="sr-only">{t("toggleSidebar")}</span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      <span>{t("toggleSidebar")}</span>
                      <Kbd>{shortcutLabels.toggleSidebar}</Kbd>
                    </TooltipContent>
                  </Tooltip>
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <ModeSelect mode={mode} onChange={onViewChange} />
        {/* Automations is its own page (scheduled prompts), not a layout of
            the conversations: it swaps the main area and leaves the mode —
            and so the list below — alone. New task follows as an action;
            Threads has none, its feed's composer is where threads start. */}
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={t("nav.automations")}
              isActive={view === "automations"}
              onClick={() => onViewChange("automations")}
            >
              <Clock />
              <span>{t("nav.automations")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {mode !== "threads" && (
            <SidebarMenuItem>
              <Tooltip>
                <TooltipTrigger asChild>
                  <SidebarMenuButton
                    onClick={onNewTask}
                    // Plain nav row (no standalone fill) so it sits flush with the
                    // other sidebar actions; the hover/active states come from the
                    // default SidebarMenuButton treatment.
                    className="min-w-8"
                  >
                    <PlusCircle />
                    <span>{t("new.task")}</span>
                    <Kbd className="ml-auto border-transparent">
                      {shortcutLabels.newChat}
                    </Kbd>
                  </SidebarMenuButton>
                </TooltipTrigger>
                <TooltipContent side="right">
                  <span>{t("new.chat")}</span>
                  <Kbd>{shortcutLabels.newDefaultChat}</Kbd>
                </TooltipContent>
              </Tooltip>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {mode === "board" || mode === "threads" ? (
          <SidebarGroup>
            <SidebarGroupLabel>{t("section.workspaces")}</SidebarGroupLabel>
            <SidebarMenu>
              {/* "All workspaces" is a pseudo-filter (null), pinned at the very
                  top and never reorderable. Kanban only — a Threads feed is
                  always one folder. */}
              {mode === "board" && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    onClick={() => onWorkspaceFilterChange(null)}
                    isActive={!onAutomations && workspaceFilter === null}
                  >
                    <span className="truncate">{t("workspace.all")}</span>
                    <ActivityBadges
                      hideWorking
                      counts={workspaceActivity.get(null)}
                      className="ml-auto text-muted-foreground"
                    />
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
              {/* "Chat" (the default workspace) is pinned below "All" and never
                  reorderable — it isn't a folder to the user. */}
              <SidebarMenuItem>
                <WorkspaceFilterButton
                  label={t("workspace.default")}
                  icon={<MessageSquare />}
                  activity={workspaceActivity.get(defaultGroup.dir)}
                  hint={workspaceSlotHints?.get(defaultGroup.dir)}
                  active={!onAutomations && workspaceFilter === defaultGroup.dir}
                  onSelect={() => onWorkspaceFilterChange(defaultGroup.dir)}
                />
              </SidebarMenuItem>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={(e) => setActiveDragDir(String(e.active.id))}
                onDragCancel={() => setActiveDragDir(null)}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={sortableIds}
                  strategy={verticalListSortingStrategy}
                >
                  {folderGroups.map((g) => (
                    <SortableWorkspaceFilterRow
                      key={g.dir}
                      dir={g.dir}
                      label={workspaceName(g.dir)}
                      activity={workspaceActivity.get(g.dir)}
                      hint={workspaceSlotHints?.get(g.dir)}
                      active={!onAutomations && workspaceFilter === g.dir}
                      onSelect={() => onWorkspaceFilterChange(g.dir)}
                    />
                  ))}
                </SortableContext>
                {typeof document !== "undefined" &&
                  createPortal(
                    <DragOverlay dropAnimation={null}>
                      {activeDragDir ? (
                        <WorkspaceDragGhost
                          label={workspaceName(activeDragDir)}
                        />
                      ) : null}
                    </DragOverlay>,
                    document.body,
                  )}
              </DndContext>
            </SidebarMenu>
          </SidebarGroup>
        ) : (
          <ChatSlotHintsProvider value={chatSlotHints}>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={(e) => setActiveDragDir(String(e.active.id))}
              onDragCancel={() => setActiveDragDir(null)}
              onDragEnd={handleDragEnd}
            >
              {/* Global "Pinned" section — only exists while something is
                  pinned, and always sits above every workspace group. */}
              {pinnedGroup && (
                <SidebarGroup>
                  <PinnedGroupView
                    items={pinnedGroup.items}
                    collapsed={collapsedWorkspaceDirs.has(PINNED_GROUP_DIR)}
                    onToggleCollapse={toggleCollapsed}
                    expanded={expandedWorkspaceDirs.has(PINNED_GROUP_DIR)}
                    onToggleExpanded={onToggleWorkspaceExpanded}
                    activeId={activeId}
                    streamingIds={streamingIds}
                    unreadCompletedIds={unreadCompletedIds}
                    archiveShortcut={shortcutLabels.archiveChat}
                    onSelect={onSelect}
                    onArchive={onArchive}
                    onTogglePin={onTogglePin}
                    onRename={onRename}
                  />
                </SidebarGroup>
              )}
              {/* "Chat" (the default workspace) is pinned first, outside the
                  sortable list — it reads as a plain section, not a folder. */}
              <SidebarGroup>
                <WorkspaceGroupView
                  group={defaultGroup}
                  label={t("workspace.default")}
                  isDefault
                  collapsed={collapsedWorkspaceDirs.has(defaultGroup.dir)}
                  onToggleCollapse={toggleCollapsed}
                  expanded={expandedWorkspaceDirs.has(defaultGroup.dir)}
                  onToggleExpanded={onToggleWorkspaceExpanded}
                  activeId={activeId}
                  streamingIds={streamingIds}
                  unreadCompletedIds={unreadCompletedIds}
                  archiveShortcut={shortcutLabels.archiveChat}
                  onNew={onNew}
                  onSelect={onSelect}
                  onArchive={onArchive}
                  onTogglePin={onTogglePin}
                  onRename={onRename}
                  onRevealWorkspace={onRevealWorkspace}
                  onArchiveWorkspaceChats={onArchiveWorkspaceChats}
                  onRemoveWorkspace={onRemoveWorkspace}
                />
              </SidebarGroup>
              <SortableContext
                items={sortableIds}
                strategy={verticalListSortingStrategy}
              >
                {folderGroups.map((g) => (
                  <SortableWorkspaceGroup
                    key={g.dir}
                    group={g}
                    label={workspaceName(g.dir)}
                    collapsed={collapsedWorkspaceDirs.has(g.dir)}
                    onToggleCollapse={toggleCollapsed}
                    expanded={expandedWorkspaceDirs.has(g.dir)}
                    onToggleExpanded={onToggleWorkspaceExpanded}
                    activeId={activeId}
                    streamingIds={streamingIds}
                    unreadCompletedIds={unreadCompletedIds}
                    archiveShortcut={shortcutLabels.archiveChat}
                    onNew={onNew}
                    onSelect={onSelect}
                    onArchive={onArchive}
                    onTogglePin={onTogglePin}
                    onRename={onRename}
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
          </ChatSlotHintsProvider>
        )}
      </SidebarContent>

      {/* Pinned below the scroll area so Settings is always reachable, even
          with a long conversation list. */}
      <SidebarFooter>
        <SidebarMenu>
          {/* Appears only once an update is downloaded and waiting — a one-click
              relaunch to apply it, pinned right above Settings. */}
          {updateReadyVersion && (
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={onRestartToUpdate}
                tooltip={t("update.restart.tooltip", {
                  version: updateReadyVersion,
                })}
                className="bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary active:bg-primary/15 active:text-primary"
              >
                <RefreshCw />
                <span>{t("update.restart.label")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          <SidebarMenuItem className="flex items-center gap-1">
            <SidebarMenuButton
              onClick={onOpenSettings}
              tooltip={t("nav.settings")}
              className="min-w-0 flex-1"
            >
              <SettingsIcon />
              <span>{t("nav.settings")}</span>
            </SidebarMenuButton>
            {/* Resources sits beside Settings as an icon-only monitor — it's
                a status readout, not a nav destination. */}
            <ResourcesPopover onSelectConversation={onSelect} />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarResizeHandle onResizeStart={startResize} onReset={resetWidth} />
    </Sidebar>
  );
});

export { PINNED_GROUP_DIR } from "./workspace-grouping";

export { groupByWorkspace } from "./workspace-grouping";
