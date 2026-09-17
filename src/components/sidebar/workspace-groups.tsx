"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  MessageSquare,
  MoreHorizontal,
  Pin,
  SquarePen,
  X,
} from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";
import {
  visibleGroupItems,
  WORKSPACE_VISIBLE_LIMIT,
} from "@/lib/collapsed-workspaces";
import type { Conversation } from "@/lib/types";
import { PINNED_GROUP_DIR } from "./workspace-grouping";
import { ConversationRow } from "./conversation-row";

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
  "fade-layer flex size-4 items-center justify-center rounded-sm text-muted-foreground opacity-0 outline-hidden transition-opacity " +
  "hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring " +
  "group-hover/project-row:opacity-100 group-has-[[data-state=open]]/project-row:opacity-100 group-has-[:focus-visible]/project-row:opacity-100";

/** The global "Pinned" section: a collapsible label (no folder actions) over
 *  the pinned chats, newest pin first. Rendered inside a <SidebarGroup> by the
 *  caller, and only when something is pinned. */
export function PinnedGroupView({
  items,
  collapsed,
  onToggleCollapse,
  expanded,
  onToggleExpanded,
  activeId,
  streamingIds,
  unreadCompletedIds,
  archiveShortcut,
  onSelect,
  onArchive,
  onTogglePin,
  onRename,
}: {
  items: Conversation[];
  collapsed: boolean;
  onToggleCollapse: (dir: string) => void;
  expanded: boolean;
  onToggleExpanded: (dir: string) => void;
  activeId: string | null;
  streamingIds: Set<string>;
  unreadCompletedIds: Set<string>;
  archiveShortcut: string;
  onSelect: (id: string) => void;
  onArchive: (c: Conversation) => void;
  onTogglePin: (c: Conversation) => void;
  onRename: (c: Conversation, title: string) => void;
}) {
  const { t } = useTranslation("sidebar");
  return (
    <>
      <div className="group/project-row relative">
        <SidebarGroupLabel
          role="button"
          tabIndex={0}
          aria-expanded={!collapsed}
          onClick={() => onToggleCollapse(PINNED_GROUP_DIR)}
          onKeyDown={(e: ReactKeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggleCollapse(PINNED_GROUP_DIR);
            }
          }}
          className={cn("cursor-pointer select-none", ROW_ACCENT_CLASS)}
        >
          {/* Same affordance as a workspace header: folded keeps the chevron
              visible, expanded swaps the pin glyph for one on hover. */}
          {collapsed ? (
            <ChevronRight className="mr-1.5 !size-3" />
          ) : (
            <>
              <Pin className="mr-1.5 !size-3 group-hover/project-row:hidden" />
              <ChevronDown className="mr-1.5 hidden !size-3 group-hover/project-row:block" />
            </>
          )}
          <span className="truncate">{t("section.pinned")}</span>
        </SidebarGroupLabel>
      </div>
      {!collapsed && (
        <SidebarMenu>
          {visibleGroupItems(items, expanded).map((c) => (
            <ConversationRow
              key={c.id}
              conversation={c}
              active={c.id === activeId}
              streaming={streamingIds.has(c.id)}
              unreadCompleted={unreadCompletedIds.has(c.id)}
              onSelect={onSelect}
              onArchive={onArchive}
              onTogglePin={onTogglePin}
              onRename={onRename}
              archiveShortcut={archiveShortcut}
              inPinnedGroup
            />
          ))}
          {items.length > WORKSPACE_VISIBLE_LIMIT && (
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => onToggleExpanded(PINNED_GROUP_DIR)}
                className="text-muted-foreground hover:text-foreground"
              >
                {expanded ? (
                  <ChevronDown className="rotate-180" />
                ) : (
                  <ChevronDown />
                )}
                <span>
                  {expanded
                    ? t("chats.showLess")
                    : t("chats.showMore", {
                        count: items.length - WORKSPACE_VISIBLE_LIMIT,
                      })}
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      )}
    </>
  );
}

interface WorkspaceGroupViewProps {
  group: { dir: string; items: Conversation[] };
  label: string;
  /** The standalone "Chat" section: chat icon instead of a folder, and no
   *  folder-ish actions (reveal / remove) — it shouldn't read as a folder. */
  isDefault?: boolean;
  /** Drag-handle props (attributes + listeners) from useSortable. */
  handleProps?: Record<string, unknown>;
  collapsed: boolean;
  onToggleCollapse: (dir: string) => void;
  /** Whether the group's list shows past WORKSPACE_VISIBLE_LIMIT rows. */
  expanded: boolean;
  onToggleExpanded: (dir: string) => void;
  activeId: string | null;
  streamingIds: Set<string>;
  unreadCompletedIds: Set<string>;
  archiveShortcut: string;
  onNew: (workspaceDir?: string) => void;
  onSelect: (id: string) => void;
  onArchive: (c: Conversation) => void;
  onTogglePin: (c: Conversation) => void;
  onRename: (c: Conversation, title: string) => void;
  onRevealWorkspace: (dir: string) => void;
  onArchiveWorkspaceChats: (dir: string) => void;
  onRemoveWorkspace: (dir: string) => void;
}

/** The contents of one workspace group: a folder header (the drag handle), its
 *  hover actions, and the conversation rows. Rendered inside a <SidebarGroup> by
 *  the caller. */
export function WorkspaceGroupView({
  group,
  label,
  isDefault,
  handleProps,
  collapsed,
  onToggleCollapse,
  expanded,
  onToggleExpanded,
  activeId,
  streamingIds,
  unreadCompletedIds,
  archiveShortcut,
  onNew,
  onSelect,
  onArchive,
  onTogglePin,
  onRename,
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
          // The header is both the collapse toggle (click) and, for real
          // folders, the reorder handle (250ms hold — see the PointerSensor
          // activation constraint). The default section has no handleProps, so
          // it needs its own role/tabIndex to stay keyboard-toggleable.
          role="button"
          tabIndex={0}
          aria-expanded={!collapsed}
          onClick={() => onToggleCollapse(group.dir)}
          onKeyDown={(e: ReactKeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggleCollapse(group.dir);
            }
          }}
          className={cn(
            "cursor-pointer pr-16 select-none",
            ROW_ACCENT_CLASS,
            handleProps && "touch-none active:cursor-grabbing",
          )}
        >
          {/* Folded groups always show the chevron (the visible cue that rows
              are hidden); expanded ones keep their glyph and swap to a chevron
              on hover, when the toggle affordance matters. */}
          {collapsed ? (
            <ChevronRight className="mr-1.5 !size-3" />
          ) : (
            <>
              {isDefault ? (
                <MessageSquare className="mr-1.5 !size-3 group-hover/project-row:hidden" />
              ) : (
                <Folder className="mr-1.5 !size-3 group-hover/project-row:hidden" />
              )}
              <ChevronDown className="mr-1.5 hidden !size-3 group-hover/project-row:block" />
            </>
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
      {!collapsed && (
        <SidebarMenu>
          {group.items.length === 0 ? (
            <SidebarMenuItem>
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                {t("chats.empty.group")}
              </div>
            </SidebarMenuItem>
          ) : (
            <>
              {visibleGroupItems(group.items, expanded).map((c) => (
                <ConversationRow
                  key={c.id}
                  conversation={c}
                  active={c.id === activeId}
                  streaming={streamingIds.has(c.id)}
                  unreadCompleted={unreadCompletedIds.has(c.id)}
                  onSelect={onSelect}
                  onArchive={onArchive}
                  onTogglePin={onTogglePin}
                  onRename={onRename}
                  archiveShortcut={archiveShortcut}
                />
              ))}
              {group.items.length > WORKSPACE_VISIBLE_LIMIT && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    onClick={() => onToggleExpanded(group.dir)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    {expanded ? (
                      <ChevronDown className="rotate-180" />
                    ) : (
                      <ChevronDown />
                    )}
                    <span>
                      {expanded
                        ? t("chats.showLess")
                        : t("chats.showMore", {
                            count: group.items.length - WORKSPACE_VISIBLE_LIMIT,
                          })}
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </>
          )}
        </SidebarMenu>
      )}
    </>
  );
}

/** A workspace group wired into dnd-kit's sortable list: the whole group slides
 *  with a GPU transform while dragging, and the folder header is the handle. */
export function SortableWorkspaceGroup(
  props: Omit<WorkspaceGroupViewProps, "handleProps">,
) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.group.dir });
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
export function WorkspaceFilterButton({
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
      className={cn(
        handleProps &&
          "cursor-grab touch-none select-none active:cursor-grabbing",
      )}
    >
      {icon ?? <Folder />}
      <span className="truncate">{label}</span>
      <span
        className={cn(
          "ml-auto text-xs",
          active
            ? "text-sidebar-accent-foreground/80"
            : "text-muted-foreground",
        )}
      >
        {count}
      </span>
    </SidebarMenuButton>
  );
}

/** A board-view filter row wired into dnd-kit's sortable list. A 250ms hold
 *  starts a drag; a plain click still filters. */
export function SortableWorkspaceFilterRow({
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
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: dir });
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
export function WorkspaceDragGhost({ label }: { label: string }) {
  return (
    <div className="flex h-8 cursor-grabbing items-center rounded-md bg-sidebar px-2 text-xs font-medium text-sidebar-accent-foreground shadow-lg ring-1 ring-sidebar-border">
      <Folder className="mr-1.5 !size-3" />
      <span className="truncate">{label}</span>
    </div>
  );
}
