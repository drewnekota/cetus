"use client";
// Smart-routing chip for entry composers — the pre-send confirmation surface:
// it shows where the message will land and, on click, lists every destination
// (auto / new chat per workspace / recent conversations) so a wrong guess is
// one click to fix. The feature itself is toggled in Settings → General.

import { useMemo } from "react";
import { Check, CornerDownRight, MessageSquarePlus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { workspaceShortName, type RouteCandidate } from "@/lib/smart-route";
import type { SmartRouteTarget } from "@/lib/types";

/** Destinations shown in the override menu. */
const MENU_SESSIONS = 8;
const MENU_WORKSPACES = 6;

export function SmartRouteControl({
  decision,
  override,
  onOverride,
  candidates,
  workspaces,
  defaultWorkspace,
  fallbackWorkspaceDir,
  disabled,
}: {
  /** The model's current suggestion (already validated). */
  decision: SmartRouteTarget | null;
  /** User override; wins over `decision` until the draft is cleared. */
  override: SmartRouteTarget | null;
  onOverride: (route: SmartRouteTarget | null) => void;
  candidates: RouteCandidate[];
  workspaces: string[];
  defaultWorkspace: string;
  /** The surface's current workspace selection — what a "new" route with a
   *  null workspaceDir actually falls back to, so the chip label stays honest. */
  fallbackWorkspaceDir?: string | null;
  disabled?: boolean;
}) {
  const effective = override ?? decision;
  const label = useMemo(() => {
    if (!effective) return null;
    if (effective.action === "continue") {
      const title = candidates.find((c) => c.id === effective.sessionId)?.title;
      return title || "Continue last chat";
    }
    return `New in ${workspaceShortName(effective.workspaceDir ?? fallbackWorkspaceDir ?? null, defaultWorkspace)}`;
  }, [effective, candidates, defaultWorkspace, fallbackWorkspaceDir]);

  const menuWorkspaces = useMemo(
    () =>
      workspaces
        .filter((w) => w && w !== defaultWorkspace)
        .slice(0, MENU_WORKSPACES),
    [workspaces, defaultWorkspace],
  );

  if (!label) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          title="Where this message will go — click to change"
          className={cn(
            "flex min-w-0 max-w-44 items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors",
            "text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/[0.08]",
            override && "text-foreground",
          )}
        >
          {effective?.action === "continue" ? (
            <CornerDownRight className="size-3 shrink-0 text-primary" />
          ) : (
            <MessageSquarePlus className="size-3 shrink-0 text-primary" />
          )}
          <span className="truncate">{label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-72">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Send to
        </DropdownMenuLabel>
        {override && (
          <DropdownMenuItem onSelect={() => onOverride(null)}>
            Auto (suggested)
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onSelect={() =>
            onOverride({
              action: "new",
              sessionId: null,
              workspaceDir: defaultWorkspace || null,
            })
          }
        >
          <MessageSquarePlus className="size-3.5" />
          <span className="truncate">New chat — Chat</span>
          {effective?.action === "new" &&
            (!(effective.workspaceDir ?? fallbackWorkspaceDir) ||
              (effective.workspaceDir ?? fallbackWorkspaceDir) ===
                defaultWorkspace) && <Check className="ml-auto size-3.5" />}
        </DropdownMenuItem>
        {menuWorkspaces.map((dir) => (
          <DropdownMenuItem
            key={dir}
            onSelect={() =>
              onOverride({ action: "new", sessionId: null, workspaceDir: dir })
            }
          >
            <MessageSquarePlus className="size-3.5" />
            <span className="truncate">
              New chat — {workspaceShortName(dir, defaultWorkspace)}
            </span>
            {effective?.action === "new" && effective.workspaceDir === dir && (
              <Check className="ml-auto size-3.5" />
            )}
          </DropdownMenuItem>
        ))}
        {candidates.length > 0 && <DropdownMenuSeparator />}
        {candidates.slice(0, MENU_SESSIONS).map((c) => (
          <DropdownMenuItem
            key={c.id}
            onSelect={() =>
              onOverride({
                action: "continue",
                sessionId: c.id,
                workspaceDir: c.workspaceDir,
              })
            }
          >
            <CornerDownRight className="size-3.5" />
            <span className="truncate">{c.title || "(untitled)"}</span>
            {effective?.action === "continue" && effective.sessionId === c.id && (
              <Check className="ml-auto size-3.5" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
