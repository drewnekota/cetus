"use client";

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Archive,
  ArchiveRestore,
  Clock,
  Cpu,
  Folder,
  Gauge,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
} from "lucide-react";
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { BACKENDS } from "@/components/chat/backend-picker";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";
import { workspaceName } from "@/lib/paths";
import { formatDateTimeMinute } from "@/lib/format";
import { formatRelativeTime } from "@/lib/conversation-search";
import { useChatStore } from "@/lib/chat-store";
import type {
  BackendId,
  CliContextUsage,
  CliDefaults,
  CliRateLimitInfo,
  Conversation,
} from "@/lib/types";
import { RUNTIME_THEME } from "@/lib/runtime-theme";
import {
  CliBackendId,
  fetchSidebarCliDefaults,
} from "./sidebar-runtime-defaults";

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
    first = window.setTimeout(
      () => {
        first = undefined;
        tick();
        interval = window.setInterval(tick, 60_000);
      },
      60_000 - (Date.now() % 60_000),
    );
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

/** Memoized so one conversation updating (auto-title landing, selection moving)
 *  doesn't reconcile every other row. Bites only because the parent passes
 *  identity-stable onSelect/onArchive (see page.tsx useCallback wrappers) and
 *  the `conversation` ref is stable unless that row actually changed. */
function normalizedBackend(conversation: Conversation): BackendId {
  return BACKENDS.some((backend) => backend.id === conversation.backend)
    ? (conversation.backend as BackendId)
    : "pi";
}

function runtimeLabel(backend: BackendId): string {
  return BACKENDS.find((runtime) => runtime.id === backend)?.label ?? "Cetus";
}

function displayModelName(raw: string): string {
  const claude = raw.match(
    /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/i,
  );
  if (!claude) return raw;
  const family = claude[1][0].toUpperCase() + claude[1].slice(1).toLowerCase();
  const version = claude[3] ? `${claude[2]}.${claude[3]}` : claude[2];
  return `${family} ${version}`;
}

function runtimeTuning(
  conversation: Conversation,
  defaults: CliDefaults | null,
): { model: string; effort: string | null } {
  const backend = normalizedBackend(conversation);
  if (backend === "pi") {
    const efforts: Partial<Record<string, string>> = {
      off: "Quick",
      minimal: "Minimal",
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "XHigh",
      max: "Max",
    };
    const m = conversation.model.model;
    const model =
      m === "flash"
        ? "DeepSeek V4 Flash"
        : m === "pro"
          ? "DeepSeek V4 Pro"
          : // Custom "<provider-id>/<model-id>" — show the model id part.
            m.split("/").slice(1).join("/") || m;
    return { model, effort: efforts[conversation.model.reasoning] ?? null };
  }
  const model = conversation.cliModel || defaults?.model || "Default";
  const effort = conversation.cliEffort || defaults?.effort || null;
  return { model: displayModelName(model), effort };
}

/** Compact quota text for the row tooltip, phrased as remaining share
 * ("N% left") so it reads the same across runtimes: Codex reports used
 * percent on every heartbeat, Claude only near the warning threshold. A
 * healthy heartbeat without a utilization value stays quiet, matching the
 * runtime picker. */
function runtimeQuota(
  q: CliRateLimitInfo | undefined,
): { text: string; warn: boolean } | null {
  if (!q) return null;
  const left =
    q.utilization == null
      ? null
      : `${Math.max(0, Math.round((1 - q.utilization) * 100))}% left`;
  const reset = q.resetsAt
    ? new Date(q.resetsAt * 1000).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  const window = q.rateLimitType
    ?.replace("five_hour", "5h")
    .replace("seven_day", "7d");
  if (q.status === "rejected")
    return {
      text: [window, "limit reached", reset && `↻ ${reset}`]
        .filter(Boolean)
        .join(" · "),
      warn: true,
    };
  if (q.status === "allowed_warning")
    return {
      text: [window, left ?? "near limit", reset && `↻ ${reset}`]
        .filter(Boolean)
        .join(" · "),
      warn: true,
    };
  return left
    ? { text: [window, left].filter(Boolean).join(" · "), warn: false }
    : null;
}

function compactTokens(tokens: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: tokens < 10_000 ? 1 : 0,
  }).format(tokens);
}

function runtimeContext(usage: CliContextUsage | undefined): string | null {
  if (!usage || usage.contextWindow <= 0) return null;
  const pct = Math.min(
    100,
    Math.round((usage.usedTokens / usage.contextWindow) * 100),
  );
  const transcript =
    usage.transcriptBytes && usage.transcriptBytes > 0
      ? `Transcript ${formatBytes(usage.transcriptBytes)}`
      : null;
  return [
    `Context · ${pct}% · ${compactTokens(usage.usedTokens)} / ${compactTokens(usage.contextWindow)}`,
    transcript,
  ]
    .filter(Boolean)
    .join(" · ");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export const ConversationRow = memo(function ConversationRow({
  conversation,
  active,
  streaming,
  unreadCompleted,
  onSelect,
  onArchive,
  onTogglePin,
  onRename,
  archiveShortcut,
  inPinnedGroup,
}: {
  conversation: Conversation;
  active: boolean;
  streaming: boolean;
  unreadCompleted: boolean;
  onSelect: (id: string) => void;
  onArchive: (c: Conversation) => void;
  onTogglePin: (c: Conversation) => void;
  onRename: (c: Conversation, title: string) => void;
  archiveShortcut: string;
  /** Rendered inside the global "Pinned" section: drop the redundant pin glyph
   *  (the section label already says "pinned") so the row reads like any other
   *  chat. */
  inPinnedGroup?: boolean;
}) {
  const { t } = useTranslation("sidebar");
  // Read the minute clock here rather than as a prop, so a tick re-renders only
  // the rows — not the whole sidebar tree (see minuteClock above).
  const nowMs = useMinuteNow();
  const archived = !!conversation.archivedAt;
  const pinned = conversation.pinnedAt != null;
  const title = conversation.title || t("conversation.untitled");
  const relativeTime = formatRelativeTime(conversation.updatedAt, nowMs);
  const backend = normalizedBackend(conversation);
  const [resolvedDefaults, setResolvedDefaults] = useState<{
    backend: CliBackendId;
    value: CliDefaults;
  } | null>(null);
  const defaults =
    resolvedDefaults?.backend === backend ? resolvedDefaults.value : null;
  const tuning = runtimeTuning(conversation, defaults);
  const rateLimit = useChatStore((s) => s.cliRateLimits[backend]);
  const quota = runtimeQuota(rateLimit);
  const context = runtimeContext(
    useChatStore((s) => s.cliContextUsage[conversation.id]),
  );
  // Inline rename: the title swaps to an input in place. The ref mirrors the
  // state so the dropdown's onCloseAutoFocus (which fires after the menu item
  // starts the edit) can skip returning focus to the ⋯ trigger and leave it
  // on the input instead.
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const startRename = useCallback(() => {
    editingRef.current = true;
    setEditing(true);
  }, []);
  const finishRename = useCallback(
    (value: string | null) => {
      // Guarded by the ref: Enter commits, then the input unmounts and its
      // blur fires again — the second call must be a no-op.
      if (!editingRef.current) return;
      editingRef.current = false;
      setEditing(false);
      const next = value?.trim();
      if (next && next !== conversation.title) onRename(conversation, next);
    },
    [conversation, onRename],
  );
  // Right-clicking the row opens the same ⋯ dropdown, so the menu is
  // controlled: the row's onContextMenu sets it open, Radix closes it.
  const [menuOpen, setMenuOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const onDetailsOpenChange = useCallback(
    (open: boolean) => {
      setDetailsOpen(open);
      if (!open || backend === "pi" || resolvedDefaults?.backend === backend)
        return;
      fetchSidebarCliDefaults(backend).then((value) => {
        setResolvedDefaults({ backend, value });
      });
    },
    [backend, resolvedDefaults?.backend],
  );
  // A fast swipe off the window edge (the sidebar hugs the screen edge) can
  // outrun WebKit's trailing pointer events, so Radix never hears a close
  // signal and the details card latches open over other apps. While open,
  // watch the window-level exits that still fire — losing key status and the
  // document-level mouse-out — and force the card shut. Listeners exist only
  // while a card is open, so the row list adds no idle cost.
  useEffect(() => {
    if (!detailsOpen) return;
    const close = () => setDetailsOpen(false);
    const onMouseOut = (e: MouseEvent) => {
      if (!e.relatedTarget) close();
    };
    window.addEventListener("blur", close);
    document.addEventListener("mouseleave", close);
    document.addEventListener("mouseout", onMouseOut);
    return () => {
      window.removeEventListener("blur", close);
      document.removeEventListener("mouseleave", close);
      document.removeEventListener("mouseout", onMouseOut);
    };
  }, [detailsOpen]);
  return (
    // NB: no `content-visibility:auto` here. It broke under the sidebar's old
    // `backdrop-blur` ancestor (containing block defeated in-viewport
    // detection, blanking visible rows); the blur is gone now, but the
    // minute-clock scoping already removed the per-minute re-render cost, and
    // a long list would need a real virtualizer anyway.
    <SidebarMenuItem
      // Right-click anywhere on the row acts as the ⋯ more button: suppress
      // the native context menu and pop the row's dropdown instead. While the
      // inline rename input is up, leave the native menu (cut/copy/paste)
      // alone.
      onContextMenu={(e) => {
        if (editing) return;
        e.preventDefault();
        setDetailsOpen(false);
        setMenuOpen(true);
      }}
    >
      <Tooltip
        open={detailsOpen && !editing && !menuOpen}
        delayDuration={0}
        onOpenChange={onDetailsOpenChange}
      >
        <TooltipTrigger asChild>
          <SidebarMenuButton
            onClick={() => onSelect(conversation.id)}
            isActive={active}
            // The archive button is an absolutely-positioned sibling of this
            // row button, so moving onto it closes this details tooltip and
            // opens the archive action's own tooltip without nesting triggers.
            className={cn(
              // Clear only the absolutely positioned relative-time / unread
              // indicator (right-2 + w-7). The hover action cluster (⋯ +
              // archive) is wider than that, but it sits on a gradient scrim
              // (below) that fades the title tail out underneath it, so the
              // title gets the full row width while not hovered and the ⋯
              // never reads as part of the title text.
              "relative pr-10",
              !active &&
                "group-hover/menu-item:bg-sidebar-accent group-hover/menu-item:text-sidebar-accent-foreground",
            )}
          >
            {!inPinnedGroup && pinned && (
              <Pin className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            {conversation.sourceAutomationId && (
              <Clock className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            {editing ? (
              <input
                ref={renameInputRef}
                autoFocus
                defaultValue={conversation.title ?? ""}
                placeholder={t("conversation.untitled")}
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/50"
                onFocus={(e) => e.currentTarget.select()}
                // The input lives inside the row button; keep its clicks and
                // keystrokes from activating the row (select) or the app's
                // keyboard shortcuts.
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") finishRename(e.currentTarget.value);
                  else if (e.key === "Escape") finishRename(null);
                }}
                onBlur={(e) => finishRename(e.currentTarget.value)}
              />
            ) : (
              <span className="min-w-0 flex-1 truncate">{title}</span>
            )}
            <span
              className={cn(
                "fade-layer absolute inset-y-0 right-2 flex w-7 shrink-0 items-center justify-center font-mono text-xs tracking-tight tabular-nums text-muted-foreground/70 transition-opacity",
                "group-has-[:focus-visible]/menu-item:opacity-0 group-hover/menu-item:opacity-0",
                active && "text-sidebar-accent-foreground/70",
              )}
            >
              {streaming ? (
                <>
                  <Spinner className="size-3" />
                  <span className="sr-only">
                    {t("conversation.inProgress")}
                  </span>
                </>
              ) : unreadCompleted ? (
                <span className="block size-2 rounded-full bg-primary">
                  <span className="sr-only">Unread</span>
                </span>
              ) : (
                relativeTime
              )}
            </span>
          </SidebarMenuButton>
        </TooltipTrigger>
        <TooltipContent
          side="right"
          align="start"
          sideOffset={6}
          className="flex w-60 flex-col items-stretch gap-2 px-3 py-2.5"
        >
          <div className="flex min-w-0 items-center gap-2">
            {/* dsh's identity color is the foreground, which is exactly this
                inverted tooltip's background, so swap it for the one color
                that is guaranteed to contrast here. */}
            <span
              style={{
                backgroundColor:
                  backend === "dsh"
                    ? "var(--background)"
                    : RUNTIME_THEME[backend].color,
              }}
              className="size-1.5 shrink-0 rounded-full"
            />
            <span className="truncate font-medium">
              {runtimeLabel(backend)}
            </span>
            {streaming && (
              <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-background/70">
                <span className="size-1.5 animate-pulse rounded-full bg-current" />
                {t("conversation.inProgress")}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1 text-xs text-background/70">
            <div className="flex min-w-0 items-center gap-1.5">
              <Cpu className="size-3 shrink-0 opacity-60" />
              <span className="truncate">
                {tuning.model}
                {tuning.effort && ` · ${tuning.effort}`}
              </span>
            </div>
            <div className="flex min-w-0 items-center gap-1.5">
              <Folder className="size-3 shrink-0 opacity-60" />
              <span className="truncate">
                {workspaceName(conversation.workspaceDir)}
              </span>
            </div>
            {backend !== "pi" && context && (
              <div className="flex min-w-0 items-center gap-1.5 tabular-nums">
                <Gauge className="size-3 shrink-0 opacity-60" />
                <span className="truncate">{context}</span>
              </div>
            )}
            {/* The tooltip surface is inverted (bg-foreground), so the amber
                needs to flip with the theme too: light amber on the dark
                surface in light mode, dark amber on the light surface in dark
                mode. */}
            {quota && (
              <div
                className={cn(
                  "tabular-nums",
                  quota.warn
                    ? "text-amber-300 dark:text-amber-700"
                    : "text-background/60",
                )}
              >
                {quota.text}
              </div>
            )}
          </div>
          <div className="border-t border-background/15 pt-1.5 text-2xs tabular-nums text-background/50">
            {formatDateTimeMinute(conversation.createdAt)}
          </div>
        </TooltipContent>
      </Tooltip>
      {/* Scrim under the hover actions: same accent as the hovered/active row
          bg, fading leftwards, so a long title disappears into it instead of
          butting up against the ⋯. Sits between the row button and the action
          buttons in DOM order so it paints above the title but below the
          actions. Visibility mirrors the actions' showOnHover conditions
          (plus dropdown-open, which keeps the actions pinned visible). Keyed
          off `:has(:focus-visible)`, not `:focus-within`, for the same reason
          as ROW_ACCENT_CLASS: dismissing the ⋯ menu by mouse returns focus to
          the trigger, and focus-within would leave this scrim stuck on. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-24 rounded-r-md bg-linear-to-l from-sidebar-accent from-55% to-transparent transition-opacity group-has-[:focus-visible]/menu-item:opacity-100 group-hover/menu-item:opacity-100 group-has-[[data-state=open]]/menu-item:opacity-100 md:opacity-0"
      />
      {/* Hover actions, right-aligned over the time slot: [⋯ menu][archive].
          Both are absolutely-positioned siblings of the row button (see the
          archive comment above), spaced flush by the !right offsets. */}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction
            showOnHover
            onClick={(e) => e.stopPropagation()}
            className="!right-7 !top-1/2 !w-6 !-translate-y-1/2 rounded-sm !text-muted-foreground/80 hover:!bg-transparent hover:!text-muted-foreground data-[state=open]:!text-muted-foreground"
          >
            <MoreHorizontal />
            <span className="sr-only">{t("action.more")}</span>
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="right"
          align="start"
          className="w-40"
          // When Rename was picked, Radix would return focus to the ⋯ trigger
          // as the menu closes — yanking it off the just-mounted title input.
          // preventDefault alone leaves focus on <body> (the input's autoFocus
          // ran while the menu's FocusScope was still mounted), so hand focus
          // to the input explicitly once the menu has finished closing.
          onCloseAutoFocus={(e) => {
            if (!editingRef.current) return;
            e.preventDefault();
            renameInputRef.current?.focus();
          }}
        >
          <DropdownMenuItem onSelect={() => onTogglePin(conversation)}>
            {pinned ? <PinOff /> : <Pin />}
            <span>{pinned ? t("action.unpin") : t("action.pin")}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={startRename}>
            <Pencil />
            <span>{t("action.rename")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarMenuAction
            showOnHover
            onClick={(e) => {
              e.stopPropagation();
              onArchive(conversation);
            }}
            className="!right-1 !top-1/2 !w-6 !-translate-y-1/2 rounded-sm !text-muted-foreground/80 hover:!bg-transparent hover:!text-muted-foreground"
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
