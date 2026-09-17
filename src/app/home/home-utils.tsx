"use client";

import { useEffect, useState } from "react";
import {
  type ComposerAttachment,
  type FileAttachment,
  type ImageAttachment,
} from "@/components/chat/composer";
import type { SidebarView } from "@/components/sidebar/view-toggle";
import {
  createTerminalViewState,
  type WorkspaceTab,
  type WorkspaceLayout,
} from "@/components/workspace/workspace-panel";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/tauri";
import { useChatStore } from "@/lib/chat-store";
import { buildAttachmentRefs } from "@/lib/attachments";
import { type Automation, type Conversation } from "@/lib/types";

export const APP_VIEW_STATE_KEY = "cetus:viewState";

export const SIDEBAR_OPEN_KEY = "cetus:sidebarOpen";

export interface PersistedAppViewState {
  view?: SidebarView;
  settingsOpen?: boolean;
  historyOpen?: boolean;
  detailId?: string | null;
  boardWorkspaceFilter?: string | null;
}

/** Stable transcript-shaped placeholder for a cold conversation switch. It
 * mirrors ChatPane's message/composer split so hydration changes content, not
 * the page's overall geometry. */
export function ChatLoadingPane({ opticalCenter }: { opticalCenter: boolean }) {
  const columnShift = opticalCenter
    ? "xl:-translate-x-10 2xl:-translate-x-12"
    : "";
  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      aria-busy="true"
      aria-label="Loading conversation"
    >
      <div className="min-h-0 flex-1 overflow-hidden px-4 pt-4">
        <div
          className={`mx-auto flex w-full max-w-3xl flex-col gap-6 panel-motion transition-[translate] ${columnShift}`}
        >
          <div className="flex justify-end">
            <Skeleton className="h-10 w-2/5 rounded-2xl" />
          </div>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-2.5 w-14" />
            <Skeleton className="h-3 w-11/12" />
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-2/3" />
          </div>
          <div className="flex justify-end">
            <Skeleton className="h-10 w-1/3 rounded-2xl" />
          </div>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-2.5 w-14" />
            <Skeleton className="h-3 w-10/12" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        </div>
      </div>
      <div className="shrink-0 bg-background px-4 pb-3 pt-2">
        <div
          className={`mx-auto w-full max-w-3xl panel-motion transition-[translate] ${columnShift}`}
        >
          <Skeleton className="h-[92px] w-full rounded-2xl" />
        </div>
      </div>
    </div>
  );
}

function isSidebarView(value: unknown): value is SidebarView {
  return value === "chat" || value === "board" || value === "automations";
}

export function readAppViewState(): PersistedAppViewState {
  if (typeof window === "undefined") return {};
  const readLegacyView = (): SidebarView | undefined => {
    try {
      const v = window.localStorage.getItem("cetus:lastView");
      return isSidebarView(v) ? v : undefined;
    } catch {
      return undefined;
    }
  };
  try {
    const raw = window.localStorage.getItem(APP_VIEW_STATE_KEY);
    if (!raw) return { view: readLegacyView() };
    const parsed = JSON.parse(raw) as PersistedAppViewState;
    return {
      view: isSidebarView(parsed.view) ? parsed.view : readLegacyView(),
      settingsOpen:
        typeof parsed.settingsOpen === "boolean"
          ? parsed.settingsOpen
          : undefined,
      historyOpen:
        typeof parsed.historyOpen === "boolean"
          ? parsed.historyOpen
          : undefined,
      detailId:
        typeof parsed.detailId === "string" || parsed.detailId === null
          ? parsed.detailId
          : undefined,
      boardWorkspaceFilter:
        typeof parsed.boardWorkspaceFilter === "string" ||
        parsed.boardWorkspaceFilter === null
          ? parsed.boardWorkspaceFilter
          : undefined,
    };
  } catch {
    return { view: readLegacyView() };
  }
}

/** Replace an automation by id, or prepend if new. Keeps server ordering. */
export function mergeAutomation(
  list: Automation[],
  a: Automation,
): Automation[] {
  return list.some((x) => x.id === a.id)
    ? list.map((x) => (x.id === a.id ? a : x))
    : [a, ...list];
}

/** Replace a conversation by id, or prepend if new (a freshly-fired run). */
export function mergeConversation(
  list: Conversation[],
  c: Conversation,
): Conversation[] {
  return list.some((x) => x.id === c.id)
    ? list.map((x) => (x.id === c.id ? c : x))
    : [c, ...list];
}

/** True when retry_last_turn failed only because the backend session has no
 *  user turn to fork from (the send never committed). Lets onRetry fall back to
 *  resubmitting the optimistic bubble instead of surfacing the raw error. */
export function isNothingToRetry(e: unknown): boolean {
  return String(e).includes("nothing to retry");
}

/** Concatenated text of the most recent user message in the rendered store, or
 *  null if there isn't one. Used as the resubmit source when the backend has
 *  nothing to fork. */
export function lastUserText(convId: string): string | null {
  const msgs = useChatStore.getState().chats[convId]?.messages;
  if (!msgs) return null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== "user") continue;
    const text = msgs[i].blocks
      .map((b) => ("text" in b ? b.text : ""))
      .join("")
      .trim();
    return text || null;
  }
  return null;
}

export interface BrowserAnnotationEvent {
  url: string;
  title?: string;
  xPct?: number;
  yPct?: number;
  note: string;
  selector?: string | null;
  element?: string | null;
  text?: string | null;
  rect?: { x: number; y: number; width: number; height: number } | null;
}

export interface BrowserControlEvent {
  conversationId?: string;
  op: "open";
  url: string;
}

export function browserAnnotationMessage(p: BrowserAnnotationEvent): string {
  const lines = ["@Browser 页面批注", "", `URL: ${p.url}`];
  if (p.title) lines.push(`页面标题: ${p.title}`);
  if (p.selector || p.element)
    lines.push(`页面元素: ${p.selector || p.element}`);
  if (p.text) lines.push(`元素文本: ${p.text}`);
  if (p.rect) {
    lines.push(
      `元素区域: ${Math.round(p.rect.width)}×${Math.round(p.rect.height)} at (${Math.round(p.rect.x)}, ${Math.round(p.rect.y)})`,
    );
  } else if (typeof p.xPct === "number" && typeof p.yPct === "number") {
    lines.push(`位置: x=${p.xPct.toFixed(1)}%, y=${p.yPct.toFixed(1)}%`);
  }
  lines.push("", p.note);
  return lines.join("\n");
}

export interface Outgoing {
  /** Image previews for the user bubble (data URLs). */
  localImages: { dataUrl: string; name?: string }[];
  /** Non-image attachments written to disk — chips for the bubble. */
  savedFiles: {
    name: string;
    path: string;
    mimeType: string;
    sizeBytes: number;
  }[];
  /** ImageContent blocks for pi's `images` channel. */
  piImages: { type: "image"; data: string; mimeType: string }[];
  /** Prompt text sent to pi, with the local file-reading path block appended. */
  piMessage: string;
}

/** Base64 of a UTF-8 string (bare, no `data:` prefix), matching what
 *  `saveAttachment` expects for file attachments. */
export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Split composer attachments into the image channel (→ pi images)
 *  and on-disk files (→ local file-reading), writing the files out. Shared by every
 *  send path (main chat, create-task, detail dialog). */
export async function prepareOutgoing(
  convId: string,
  text: string,
  attachments: ComposerAttachment[],
): Promise<Outgoing> {
  const images = attachments.filter(
    (a): a is ImageAttachment => a.type === "image",
  );
  const files = attachments.filter(
    (a): a is FileAttachment => a.type === "file",
  );
  const localImages = images.map((a) => ({
    dataUrl: `data:${a.mimeType};base64,${a.data}`,
    name: a.name,
  }));
  const savedFiles = await Promise.all(
    files.map(async (f) => ({
      name: f.name,
      path: await api.saveAttachment(convId, f.name, f.data),
      mimeType: f.mimeType,
      sizeBytes: f.sizeBytes,
    })),
  );
  const piImages = images.map((a) => ({
    type: "image" as const,
    data: a.data,
    mimeType: a.mimeType,
  }));
  return {
    localImages,
    savedFiles,
    piImages,
    piMessage: text + buildAttachmentRefs(savedFiles),
  };
}

export function usePanelPresence(open: boolean, delayMs = 220) {
  const [mounted, setMounted] = useState(open);
  const [hidden, setHidden] = useState(!open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      setHidden(false);
      return;
    }
    if (!mounted) {
      setHidden(true);
      return;
    }
    const timer = window.setTimeout(() => setHidden(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [open, delayMs, mounted]);
  return { mounted, hidden };
}

export interface WorkspaceDockState {
  open: boolean;
  tabs: WorkspaceTab[];
  activeId: string | null;
}

export type WorkspaceDocksState = Record<WorkspaceLayout, WorkspaceDockState>;

export type WorkspaceDocksByChatState = Record<string, WorkspaceDocksState>;

export const NEW_CHAT_WORKSPACE_KEY = "__new_chat__";

export function createInitialWorkspaceDocks(): WorkspaceDocksState {
  return {
    side: {
      open: false,
      tabs: [{ id: "files-1", kind: "files", title: "Files" }],
      activeId: "files-1",
    },
    bottom: {
      open: false,
      tabs: [
        {
          id: "terminal-1",
          kind: "terminal",
          title: "Terminal",
          terminalState: createTerminalViewState(),
        },
      ],
      activeId: "terminal-1",
    },
  };
}

export function createInitialWorkspaceDocksByChat(): WorkspaceDocksByChatState {
  return { [NEW_CHAT_WORKSPACE_KEY]: createInitialWorkspaceDocks() };
}
