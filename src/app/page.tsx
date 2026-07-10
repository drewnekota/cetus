"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Inbox, PanelBottom, PanelRight } from "lucide-react";
import {
  Composer,
  type ComposerAttachment,
  type FileAttachment,
  type ImageAttachment,
  type QueuedMessage,
} from "@/components/chat/composer";
import { ChatPane } from "@/components/chat/chat-pane";
import { GlyphBackdrop } from "@/components/chat/glyph-backdrop";
import { CommandPalette } from "@/components/command-palette";
import { AppSidebar, groupByWorkspace } from "@/components/sidebar/app-sidebar";
import type { SidebarView } from "@/components/sidebar/view-toggle";
import { BoardView } from "@/components/board/board-view";
import { CreateTaskDialog } from "@/components/board/create-task-dialog";
import { AutomationsView } from "@/components/automation/automations-view";
import { AutomationDialog } from "@/components/automation/automation-dialog";
import { PluginsView } from "@/components/plugins/plugins-view";
import {
  WorkspacePanel,
  createTerminalViewState,
  type WorkspaceTab,
  type WorkspaceTabKind,
  type WorkspaceLayout,
  type TerminalRunRequest,
  type TerminalViewState,
} from "@/components/workspace/workspace-panel";
import {
  createBrowserViewState,
  type BrowserViewState,
} from "@/components/browser/browser-view";
import { SessionDetailDialog } from "@/components/board/session-detail-dialog";
import { ArtifactsDialog } from "@/components/board/artifacts-dialog";
import { REVIEW_TOOL_NAME } from "@/lib/review";
import { DialogHost } from "@/components/extension-ui/dialog-host";
import { ZoomHud } from "@/components/zoom-hud";
import { TestHook } from "@/components/devtest/test-hook";
import { ScreenHistoryPage } from "@/components/screen-history/screen-history-page";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import {
  api,
  onAppEvent,
  onUpdateAvailable,
  onUpdateDownloadProgress,
  onUpdateReady,
  type Screenshot,
} from "@/lib/tauri";
import {
  useChatStore,
  useChatError,
  useIsStreaming,
  useHasArtifacts,
  useHasMessages,
  useStreamingIds,
  copyCachedMessages,
  installChatPersistence,
  loadCachedMessages,
  loadLastActive,
  saveLastActive,
} from "@/lib/chat-store";
import { useZoom } from "@/hooks/use-zoom";
import { dispatchNotification, refreshPermission } from "@/lib/notifications";
import { tt, useLocale, useTranslation } from "@/lib/i18n";
import { flavorHeadline } from "@/lib/chat-flavor";
import { buildAttachmentRefs } from "@/lib/attachments";
import {
  DEFAULT_MODEL_CHOICE,
  type AppEvent,
  type Automation,
  type AutomationInput,
  type CliControlRequest,
  type Conversation,
  type ExtensionUIRequest,
  type ModelChoice,
  type PiEvent,
  type PiMessage,
  type QuickLaunchPayload,
  type BackendId,
  backendSupportsSteer,
} from "@/lib/types";
import { mergeStoredModelChoice, saveModelChoice } from "@/lib/model-choice";
import { loadBackendChoice, saveBackendChoice } from "@/lib/backend-choice";
import { composeWithContext } from "@/lib/quick-context";
import {
  KEYBOARD_SHORTCUTS_EVENT,
  KEYBOARD_SHORTCUTS_STORAGE_KEY,
  matchesShortcut,
  readKeyboardShortcuts,
} from "@/lib/keyboard-shortcuts";
import {
  HIDDEN_WORKSPACES_STORAGE_KEY,
  hideWorkspace,
  loadHiddenWorkspaces,
  loadRecentWorkspaces,
  RECENT_WORKSPACES_CHANGED,
  RECENT_WORKSPACES_STORAGE_KEY,
  reorderRecentWorkspaces,
} from "@/lib/recent-workspaces";

// The settings UI is a ~3900-line client component (plus react-markdown for the
// skill previews). Code-split it so its chunk only loads the first time the user
// opens Settings, keeping it out of the cold-start bundle. ssr:false is safe —
// this is a static-export Tauri SPA with no server render. Gated on
// `settingsEverOpened` below so the mount (and thus the chunk fetch) is deferred
// until first open; it then stays mounted so reopen is instant.
const SettingsPage = dynamic(
  () => import("@/components/settings/settings-page").then((m) => m.SettingsPage),
  { ssr: false },
);

// First-run welcome + permission setup. Self-gating (a localStorage flag), so
// it's safe to always mount; renders nothing once dismissed. ssr:false for the
// same reason as SettingsPage — static-export SPA, no server render.
const Onboarding = dynamic(
  () => import("@/components/onboarding/onboarding").then((m) => m.Onboarding),
  { ssr: false },
);

const APP_VIEW_STATE_KEY = "cetus:viewState";

interface PersistedAppViewState {
  view?: SidebarView;
  settingsOpen?: boolean;
  historyOpen?: boolean;
  detailId?: string | null;
  boardWorkspaceFilter?: string | null;
}

function isSidebarView(value: unknown): value is SidebarView {
  return (
    value === "chat" ||
    value === "board" ||
    value === "automations" ||
    value === "plugins"
  );
}

function readAppViewState(): PersistedAppViewState {
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
      settingsOpen: typeof parsed.settingsOpen === "boolean" ? parsed.settingsOpen : undefined,
      historyOpen: typeof parsed.historyOpen === "boolean" ? parsed.historyOpen : undefined,
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
function mergeAutomation(list: Automation[], a: Automation): Automation[] {
  return list.some((x) => x.id === a.id)
    ? list.map((x) => (x.id === a.id ? a : x))
    : [a, ...list];
}

/** Replace a conversation by id, or prepend if new (a freshly-fired run). */
function mergeConversation(list: Conversation[], c: Conversation): Conversation[] {
  return list.some((x) => x.id === c.id)
    ? list.map((x) => (x.id === c.id ? c : x))
    : [c, ...list];
}

/** True when retry_last_turn failed only because the backend session has no
 *  user turn to fork from (the send never committed). Lets onRetry fall back to
 *  resubmitting the optimistic bubble instead of surfacing the raw error. */
function isNothingToRetry(e: unknown): boolean {
  return String(e).includes("nothing to retry");
}

/** Concatenated text of the most recent user message in the rendered store, or
 *  null if there isn't one. Used as the resubmit source when the backend has
 *  nothing to fork. */
function lastUserText(convId: string): string | null {
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

interface BrowserAnnotationEvent {
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

interface BrowserControlEvent {
  conversationId?: string;
  op: "open";
  url: string;
}

function browserAnnotationMessage(p: BrowserAnnotationEvent): string {
  const lines = [
    "@Browser 页面批注",
    "",
    `URL: ${p.url}`,
  ];
  if (p.title) lines.push(`页面标题: ${p.title}`);
  if (p.selector || p.element) lines.push(`页面元素: ${p.selector || p.element}`);
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

interface Outgoing {
  /** Image previews for the user bubble (data URLs). */
  localImages: { dataUrl: string; name?: string }[];
  /** Non-image attachments written to disk — chips for the bubble. */
  savedFiles: { name: string; path: string; mimeType: string; sizeBytes: number }[];
  /** ImageContent blocks for pi's `images` channel. */
  piImages: { type: "image"; data: string; mimeType: string }[];
  /** Prompt text sent to pi, with the read_document path block appended. */
  piMessage: string;
}

/** Split composer attachments into the image channel (→ pi images / vision-bridge)
 *  and on-disk files (→ read_document), writing the files out. Shared by every
 *  send path (main chat, create-task, detail dialog). */
async function prepareOutgoing(
  convId: string,
  text: string,
  attachments: ComposerAttachment[],
): Promise<Outgoing> {
  const images = attachments.filter((a): a is ImageAttachment => a.type === "image");
  const files = attachments.filter((a): a is FileAttachment => a.type === "file");
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
  return { localImages, savedFiles, piImages, piMessage: text + buildAttachmentRefs(savedFiles) };
}

function usePanelPresence(open: boolean, delayMs = 110) {
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

interface WorkspaceDockState {
  open: boolean;
  tabs: WorkspaceTab[];
  activeId: string | null;
}

type WorkspaceDocksState = Record<WorkspaceLayout, WorkspaceDockState>;
type WorkspaceDocksByChatState = Record<string, WorkspaceDocksState>;

const NEW_CHAT_WORKSPACE_KEY = "__new_chat__";

function createInitialWorkspaceDocks(): WorkspaceDocksState {
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

function createInitialWorkspaceDocksByChat(): WorkspaceDocksByChatState {
  return { [NEW_CHAT_WORKSPACE_KEY]: createInitialWorkspaceDocks() };
}

export default function Home() {
  useZoom();
  const initialViewStateRef = useRef<PersistedAppViewState | null>(null);
  if (initialViewStateRef.current === null) {
    initialViewStateRef.current = readAppViewState();
  }
  const initialViewState = initialViewStateRef.current;
  const { t } = useTranslation("chat");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsLoaded, setConversationsLoaded] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(() =>
    initialViewState.view === "chat" ? loadLastActive() : null,
  );
  const [piReady, setPiReady] = useState(false);
  // Store actions are pulled via getState() inside callbacks so we never
  // subscribe page.tsx to chat-store ticks.
  const chatStore = useChatStore;
  const error = useChatError(activeId);
  const isStreaming = useIsStreaming(activeId);
  const hasMessages = useHasMessages(activeId);
  // Aggregated artifacts gallery for the active chat — parity with the board
  // detail dialog's Artifacts button (opens the same ArtifactsDialog).
  const activeHasArtifacts = useHasArtifacts(activeId);
  const [chatArtifactsOpen, setChatArtifactsOpen] = useState(false);
  // Backend serving the active conversation (null for a not-yet-persisted new
  // chat). Drives steer-capability gating for the follow-up queue.
  const activeConvBackend = useMemo<BackendId | null>(
    () =>
      (conversations.find((c) => c.id === activeId)?.backend as
        | BackendId
        | undefined) ?? null,
    [conversations, activeId],
  );
  const streamingIds = useStreamingIds();
  const [unreadCompletedIds, setUnreadCompletedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [modelChoice, setModelChoice] = useState<ModelChoice>(DEFAULT_MODEL_CHOICE);
  // Backend + CLI model/effort chosen on the hero composer before a
  // conversation exists; applied to the conversation minted on first send.
  // Sticky across sessions (shared with the quick launcher) via
  // "cetus:lastBackendChoice".
  const [pendingBackend, setPendingBackend] = useState<BackendId>("pi");
  const [pendingCliModel, setPendingCliModel] = useState("");
  const [pendingCliEffort, setPendingCliEffort] = useState("");
  const onPendingTuningChange = useCallback((model: string, effort: string) => {
    setPendingCliModel(model);
    setPendingCliEffort(effort);
  }, []);
  // ⌃1/⌃2/⌃3 runtime switching: the request rides a token down to the
  // BackendPicker (which owns the switch logic + its own state), same pattern
  // as focusToken/quoteRequest.
  const [backendSwitch, setBackendSwitch] = useState<{
    token: number;
    backend: BackendId;
  } | null>(null);
  const backendSwitchToken = useRef(0);
  const requestBackendSwitch = useCallback((backend: BackendId) => {
    backendSwitchToken.current += 1;
    setBackendSwitch({ token: backendSwitchToken.current, backend });
  }, []);
  useEffect(() => {
    setModelChoice(mergeStoredModelChoice);
    const savedBackend = loadBackendChoice();
    if (savedBackend) {
      setPendingBackend(savedBackend.backend);
      setPendingCliModel(savedBackend.cliModel);
      setPendingCliEffort(savedBackend.cliEffort);
    }
  }, []);
  // Persist the new-chat runtime choice on every change past hydration (the
  // same skip-first-run dance as modelChoice below).
  const backendChoiceHydrated = useRef(false);
  useEffect(() => {
    if (!backendChoiceHydrated.current) {
      backendChoiceHydrated.current = true;
      return;
    }
    saveBackendChoice({
      backend: pendingBackend,
      cliModel: pendingCliModel,
      cliEffort: pendingCliEffort,
    });
  }, [pendingBackend, pendingCliModel, pendingCliEffort]);
  // Persist the active model/reasoning choice on *every* change — manual picker,
  // launcher adopt, and conversation switch alike — so the quick launcher (which
  // reads "cetus:lastModelChoice") always mirrors what the main composer shows.
  // Skip the very first run: that's the initial DEFAULT, before the load effect
  // above has hydrated state, and writing it would clobber the stored value.
  const modelChoiceHydrated = useRef(false);
  useEffect(() => {
    if (!modelChoiceHydrated.current) {
      modelChoiceHydrated.current = true;
      return;
    }
    saveModelChoice(modelChoice);
  }, [modelChoice]);
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null);
  const [defaultWorkspace, setDefaultWorkspace] = useState<string>("");
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>([]);
  const [hiddenWorkspaces, setHiddenWorkspaces] = useState<string[]>([]);
  const [storedProviders, setStoredProviders] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(
    initialViewState.settingsOpen === true,
  );
  // Latches true on first open so the code-split SettingsPage mounts (and its
  // chunk loads) lazily, then stays mounted for instant reopen.
  const [settingsEverOpened, setSettingsEverOpened] = useState(
    initialViewState.settingsOpen === true,
  );
  useEffect(() => {
    if (settingsOpen) setSettingsEverOpened(true);
  }, [settingsOpen]);
  const [historyOpen, setHistoryOpen] = useState(
    initialViewState.historyOpen === true,
  );
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyFrame, setHistoryFrame] = useState<Screenshot | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** Bumped on every "New chat" click; threaded into Composer so it can pull
   *  focus back even when the hero is already on screen and nothing remounts. */
  const [focusToken, setFocusToken] = useState(0);
  // Random greeting for the landing hero, re-rolled per new chat (focusToken
  // bumps on "New chat") + on language switch. Stays put across keystrokes.
  const { locale } = useLocale();
  const heroHeadline = useMemo(
    () => flavorHeadline(locale),
    [locale, focusToken],
  );
  // Restore the last sidebar view across reloads (⌘R). Lazy initializer (guarded
  // for the static-export prerender, where window is absent) so a reload paints
  // the right page straight away instead of flashing the chat hero first.
  const [view, setView] = useState<SidebarView>(() => {
    if (initialViewState.view) return initialViewState.view;
    if (typeof window === "undefined") return "chat";
    try {
      const v = localStorage.getItem("cetus:lastView");
      if (v === "chat" || v === "board" || v === "automations" || v === "plugins") return v;
    } catch {}
    return "chat";
  });
  const [keyboardShortcuts, setKeyboardShortcuts] = useState(readKeyboardShortcuts);
  useEffect(() => {
    const reload = () => setKeyboardShortcuts(readKeyboardShortcuts());
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === KEYBOARD_SHORTCUTS_STORAGE_KEY) reload();
    };
    window.addEventListener(KEYBOARD_SHORTCUTS_EVENT, reload);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(KEYBOARD_SHORTCUTS_EVENT, reload);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("cetus:lastView", view);
    } catch {}
  }, [view]);
  // Browser-style page history for ⌘[ / ⌘]. A "page" is the sidebar view, the
  // active chat within it, plus whether Settings covers it; every change lands
  // on the stack, and applying an entry sets navApplyingRef so the recorder
  // effect below doesn't re-push the state it just restored.
  type NavEntry = { view: SidebarView; activeId: string | null; settings: boolean };
  const currentNavEntry = useCallback(
    (): NavEntry => ({
      view,
      // A chat is only a distinct page inside the chat view; elsewhere the
      // active chat is incidental, so collapse it to null to avoid spurious
      // page switches.
      activeId: view === "chat" ? activeId : null,
      settings: settingsOpen,
    }),
    [view, activeId, settingsOpen],
  );
  const sameNavEntry = (a: NavEntry | null | undefined, b: NavEntry) =>
    !!a && a.view === b.view && a.activeId === b.activeId && a.settings === b.settings;
  // Ctrl+Tab is MRU page switching: it toggles the last complete page, not just
  // the last sidebar view. That makes separate chats and Settings participate.
  const previousPageRef = useRef<NavEntry | null>(null);
  const committedPageRef = useRef<NavEntry>(currentNavEntry());
  useEffect(() => {
    const next = currentNavEntry();
    if (!sameNavEntry(committedPageRef.current, next)) {
      previousPageRef.current = committedPageRef.current;
      committedPageRef.current = next;
    }
  }, [currentNavEntry]);
  const navHistoryRef = useRef<NavEntry[]>([]);
  const navIndexRef = useRef(0);
  const navApplyingRef = useRef(false);
  useEffect(() => {
    if (navApplyingRef.current) {
      navApplyingRef.current = false;
      return;
    }
    const hist = navHistoryRef.current;
    const current = hist[navIndexRef.current];
    const entry = currentNavEntry();
    if (sameNavEntry(current, entry))
      return;
    // A new page after going back forks the timeline: drop the forward entries.
    hist.splice(navIndexRef.current + 1);
    hist.push(entry);
    if (hist.length > 100) hist.splice(0, hist.length - 100);
    navIndexRef.current = hist.length - 1;
  }, [currentNavEntry]);
  const applyNavEntry = useCallback((entry: NavEntry) => {
    navApplyingRef.current = true;
    setView(entry.view);
    if (entry.view === "chat") setActiveId(entry.activeId);
    setSettingsOpen(entry.settings);
  }, []);
  const switchToPreviousPage = useCallback(() => {
    const prev = previousPageRef.current;
    if (prev && !sameNavEntry(committedPageRef.current, prev)) applyNavEntry(prev);
  }, [applyNavEntry]);
  const navigateBack = useCallback(() => {
    if (navIndexRef.current <= 0) return;
    navIndexRef.current -= 1;
    applyNavEntry(navHistoryRef.current[navIndexRef.current]);
  }, [applyNavEntry]);
  const navigateForward = useCallback(() => {
    if (navIndexRef.current >= navHistoryRef.current.length - 1) return;
    navIndexRef.current += 1;
    applyNavEntry(navHistoryRef.current[navIndexRef.current]);
  }, [applyNavEntry]);
  const [workspaceDocksByChat, setWorkspaceDocksByChat] =
    useState<WorkspaceDocksByChatState>(
      createInitialWorkspaceDocksByChat,
    );
  const workspaceDocksByChatRef =
    useRef<WorkspaceDocksByChatState>(workspaceDocksByChat);
  const workspaceKey = activeId ?? NEW_CHAT_WORKSPACE_KEY;
  const workspaceDocks =
    workspaceDocksByChat[workspaceKey] ?? createInitialWorkspaceDocks();
  const sideWorkspace = workspaceDocks.side;
  const bottomWorkspace = workspaceDocks.bottom;
  const sideWorkspacePresence = usePanelPresence(sideWorkspace.open);
  const bottomWorkspacePresence = usePanelPresence(bottomWorkspace.open);
  const [boardWorkspaceFilter, setBoardWorkspaceFilter] = useState<string | null>(
    initialViewState.boardWorkspaceFilter ?? null,
  );
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(
    initialViewState.detailId ?? null,
  );
  useEffect(() => {
    try {
      localStorage.setItem(
        APP_VIEW_STATE_KEY,
        JSON.stringify({
          view,
          settingsOpen,
          historyOpen,
          detailId,
          boardWorkspaceFilter,
        } satisfies PersistedAppViewState),
      );
    } catch {}
  }, [view, settingsOpen, historyOpen, detailId, boardWorkspaceFilter]);
  /** Ultra Code master switch, surfaced as a toggle in the composer. */
  const [ultraEnabled, setUltraEnabled] = useState(false);
  const [detailModelChoice, setDetailModelChoice] = useState<ModelChoice>(DEFAULT_MODEL_CHOICE);
  const [detailWorkspaceDir, setDetailWorkspaceDir] = useState<string | null>(null);
  const [detailFocusToken, setDetailFocusToken] = useState(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [automationDialogOpen, setAutomationDialogOpen] = useState(false);
  const [editingAutomation, setEditingAutomation] = useState<Automation | null>(null);
  /** Per-conversation follow-up queue: messages typed while the agent is mid-run.
   *  They sit above the composer and are delivered one-at-a-time as the run ends
   *  (follow-up), unless the user promotes one to a steer ("Steer now"). */
  const [queued, setQueued] = useState<Record<string, QueuedMessage[]>>({});
  /** True while a retry (fork + resubmit) is in flight, to disable the button. */
  const [retrying, setRetrying] = useState(false);
  /** Synchronous reentrancy guard. The `retrying` useState value is captured in
   *  onRetry's closure and stays stale across a rapid double-fire (two clicks, or
   *  a re-render that re-invokes onRetry before setRetrying commits), which would
   *  let a second retry fork away the message the first just re-sent and then hit
   *  "nothing to retry". This ref flips synchronously, so the second call bails. */
  const retryingRef = useRef(false);

  // Refs that mirror state for the global app-event handler. That handler
  // subscribes once (deps: [chatStore]) and would otherwise close over stale
  // values — refs keep notification decisions reading the live state.
  const conversationsRef = useRef<Conversation[]>([]);
  const activeIdRef = useRef<string | null>(null);
  /** Latest conversation the user *intends* to view. Captured synchronously on
   *  click (before any await) so a slower in-flight select for a previous chat
   *  can't clobber the newer one's state when its async work resolves late. */
  const pendingSelectRef = useRef<string | null>(null);
  const viewRef = useRef<SidebarView>("chat");
  /** Per-conversation run state, so the trailing agent_end can tell a clean
   *  finish from a failed/aborted one. `running` gates the whole thing so
   *  out-of-order or orphan events can't fire a spurious/double notification:
   *  an agent_end with no live run is ignored, a late stderr pi_error can't
   *  corrupt the next run's outcome, and a crash (pi_exited) closes the run so
   *  a trailing agent_end stays quiet. */
  const runStatusRef = useRef<
    Record<string, { running: boolean; outcome: "ok" | "errored" | "aborted" }>
  >({});
  conversationsRef.current = conversations;
  activeIdRef.current = activeId;
  viewRef.current = view;
  workspaceDocksByChatRef.current = workspaceDocksByChat;
  // Chat ids in the sidebar's visual order (workspace groups flattened),
  // mirrored into a ref so the identity-stable switchChat handler reads the
  // live order.
  const orderedChatIds = useMemo(
    () =>
      groupByWorkspace(
        conversations,
        recentWorkspaces,
        hiddenWorkspaces,
        defaultWorkspace,
      ).flatMap((g) => g.items.map((c) => c.id)),
    [conversations, recentWorkspaces, hiddenWorkspaces, defaultWorkspace],
  );
  const orderedChatIdsRef = useRef<string[]>([]);
  orderedChatIdsRef.current = orderedChatIds;

  // Mirror the live queue + send fn so the flush effect (deps: streaming sig
  // only) never reads stale closures. onSend is a hoisted function declaration.
  const queuedRef = useRef(queued);
  queuedRef.current = queued;
  const onSendRef = useRef<typeof onSend>(undefined as unknown as typeof onSend);
  onSendRef.current = onSend; // onSend is hoisted (function declaration)
  const deliverQueuedRef = useRef<typeof deliverQueued>(
    undefined as unknown as typeof deliverQueued,
  );
  deliverQueuedRef.current = deliverQueued; // hoisted function declaration

  // Comma-joined ids of every conversation whose run is live. Object.is over the
  // string means this only re-renders when the *set* of streaming runs changes,
  // and the flush effect below re-runs on exactly those boundaries.
  const streamingSig = useChatStore((s) => {
    let sig = "";
    for (const id in s.chats) if (s.chats[id]?.isStreaming) sig += `${id},`;
    return sig;
  });

  // Deliver the next queued follow-up whenever ANY conversation's run ends —
  // active chat, detail dialog, or a background run the user has navigated away
  // from. Keying off the store (not the active/detail conversation) is what lets
  // a queue survive a chat switch: the old per-surface effects only observed the
  // mounted conversation, so a run that finished in the background stranded its
  // queue. One flush per true→false transition → items go out sequentially, each
  // waiting for the turn it just started to finish.
  const prevStreamingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const current = new Set(
      streamingSig ? streamingSig.split(",").filter(Boolean) : [],
    );
    const prev = prevStreamingRef.current;
    prevStreamingRef.current = current;
    for (const id of prev) {
      if (current.has(id)) continue; // still running — not a run boundary
      const q = queuedRef.current[id];
      if (!q || q.length === 0) continue;
      const [next, ...rest] = q;
      setQueued((cur) => ({ ...cur, [id]: rest }));
      void deliverQueuedRef.current(id, next.text, next.attachments);
    }
  }, [streamingSig]);

  // Backend serving the detail-dialog conversation, for steer-capability gating.
  const detailConvBackend = useMemo<BackendId | null>(
    () =>
      (conversations.find((c) => c.id === detailId)?.backend as
        | BackendId
        | undefined) ?? null,
    [conversations, detailId],
  );

  /** Park a message in the follow-up queue (typed while the agent is mid-run). */
  function enqueueMessage(
    convId: string,
    text: string,
    attachments: ComposerAttachment[],
  ) {
    const id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `q-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    setQueued((q) => ({
      ...q,
      [convId]: [...(q[convId] ?? []), { id, text, attachments }],
    }));
  }

  function removeQueued(convId: string, id: string) {
    setQueued((q) => ({
      ...q,
      [convId]: (q[convId] ?? []).filter((m) => m.id !== id),
    }));
  }

  /** Rewrite a queued message's text in place (attachments are kept as-is). */
  function editQueued(convId: string, id: string, text: string) {
    setQueued((q) => ({
      ...q,
      [convId]: (q[convId] ?? []).map((m) => (m.id === id ? { ...m, text } : m)),
    }));
  }

  /** Promote a queued message to a steer: deliver it now. pi/claude-code inject
   *  into the current run; codex interrupts the run and resumes the thread. */
  function steerQueued(convId: string, id: string) {
    const item = (queuedRef.current[convId] ?? []).find((m) => m.id === id);
    if (!item) return;
    removeQueued(convId, id);
    void onSend(item.text, item.attachments);
  }

  // Install the IDB write-through cache exactly once.
  useEffect(() => {
    installChatPersistence();
  }, []);

  // Populate the cached OS notification permission without prompting. The
  // prompt itself is deferred to the first real notification or the settings
  // page, so launch stays quiet.
  useEffect(() => {
    refreshPermission().catch(() => {});
  }, []);

  // Stable so the Settings page's Esc-listener effect doesn't re-register on
  // every parent render.
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  /** Merge a Conversation row returned by a review-state mutation. Guarded two
   *  ways vs the plain mergeConversation: (1) only updates a row still in the
   *  list, so a response that resolves after the card was archived can't
   *  resurrect it; (2) never replaces a row with an older snapshot, so a stale
   *  response can't clobber a fresher touch / auto-title. The DB stays
   *  authoritative — a skipped update self-heals on the next refreshList. */
  const applyReviewedRow = useCallback((u: Conversation) => {
    setConversations((cs) =>
      cs.map((x) => (x.id === u.id && u.updatedAt >= x.updatedAt ? u : x)),
    );
  }, []);

  const refreshKeys = useCallback(async () => {
    const keys = await api.listApiKeys();
    setStoredProviders(keys);
    return keys;
  }, []);

  useEffect(() => {
    refreshKeys()
      .then((keys) => {
        if (keys.length === 0) setSettingsOpen(true);
      })
      .catch(console.error);
    api.defaultWorkspace().then(setDefaultWorkspace).catch(console.error);
  }, [refreshKeys]);

  useEffect(() => {
    const refresh = () => {
      setRecentWorkspaces(loadRecentWorkspaces());
      setHiddenWorkspaces(loadHiddenWorkspaces());
    };
    refresh();
    const onStorage = (e: StorageEvent) => {
      if (
        e.key === RECENT_WORKSPACES_STORAGE_KEY ||
        e.key === HIDDEN_WORKSPACES_STORAGE_KEY ||
        e.key === null
      ) {
        refresh();
      }
    };
    window.addEventListener(RECENT_WORKSPACES_CHANGED, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(RECENT_WORKSPACES_CHANGED, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // Sync the Ultra Code master switch on mount and whenever the settings page
  // closes (where it can be toggled), so the composer toggle seeds correctly.
  useEffect(() => {
    if (settingsOpen) return;
    api
      .getUltraSettings()
      .then((s) => setUltraEnabled(s.enabled))
      .catch(() => {});
  }, [settingsOpen]);

  /** Flip Ultra Code right from the composer. Persists the global switch; the
   *  backend recycles idle pis so the change applies on the next turn. */
  const onUltraToggle = useCallback(() => {
    setUltraEnabled((v) => {
      const next = !v;
      api.setUltraSettings({ enabled: next }).catch(() => {});
      return next;
    });
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      api.piPing().then((ok) => ok && setPiReady(true)).catch(console.error);

      const convTitle = (cid: string) =>
        conversationsRef.current.find((c) => c.id === cid)?.title?.trim() ||
        "Untitled";
      // When the window is focused and the event belongs to the chat the user
      // is already watching, an OS banner is just noise — suppress it there.
      const watchingNow = (cid: string) =>
        cid === activeIdRef.current && viewRef.current === "chat";

      const notifyForPiEvent = (
        cid: string,
        pe: PiEvent | ExtensionUIRequest,
      ) => {
        switch (pe.type) {
          case "agent_start":
            runStatusRef.current[cid] = { running: true, outcome: "ok" };
            setUnreadCompletedIds((ids) => {
              if (!ids.has(cid)) return ids;
              const next = new Set(ids);
              next.delete(cid);
              return next;
            });
            break;
          case "message_update": {
            const r = runStatusRef.current[cid];
            if (r?.running && pe.assistantMessageEvent.type === "error") {
              r.outcome =
                pe.assistantMessageEvent.reason === "aborted"
                  ? "aborted"
                  : "errored";
            }
            break;
          }
          case "agent_end": {
            const r = runStatusRef.current[cid];
            // Ignore an agent_end with no live run behind it (orphan or
            // replayed event) — only runs we saw start should notify.
            if (!r || !r.running) break;
            r.running = false;
            if (r.outcome === "aborted") break; // user aborted — stay quiet
            // A queued follow-up is about to auto-deliver (the flush effect
            // consumes the queue after this handler), so the conversation isn't
            // really done — stay quiet and let the final run notify.
            if ((queuedRef.current[cid]?.length ?? 0) > 0) break;
            // One notification for any finished run (interactive reply, board
            // task, or automation — they're all just chats); the body carries
            // success vs error.
            dispatchNotification("task_finished", {
              title: convTitle(cid),
              body:
                r.outcome === "errored"
                  ? "Finished with an error."
                  : "Your task is ready.",
              suppressWhenFocused: watchingNow(cid),
              conversationId: cid,
            });
            setUnreadCompletedIds((ids) => {
              const next = new Set(ids);
              if (watchingNow(cid)) next.delete(cid);
              else next.add(cid);
              return next.size === ids.size && next.has(cid) === ids.has(cid)
                ? ids
                : next;
            });
            break;
          }
        }
      };

      const u = await onAppEvent((evt: AppEvent) => {
        const store = chatStore.getState();
        switch (evt.type) {
          case "pi_ready":
            setPiReady(true);
            break;
          case "pi_error": {
            if (evt.conversationId) {
              store.setError(evt.conversationId, evt.message);
              // Mark the *active* run as failed so the trailing agent_end
              // notifies as an error. Guarding on `running` keeps a late stderr
              // line from a finished run from corrupting the next run's
              // outcome. We don't notify here: pi_error also fires for benign
              // stderr lines and would be far too noisy.
              const r = runStatusRef.current[evt.conversationId];
              if (r?.running) r.outcome = "errored";
            }
            break;
          }
          case "pi_exited": {
            if (evt.conversationId) {
              const r = runStatusRef.current[evt.conversationId];
              const liveInStore = store.streamingIds.has(evt.conversationId);
              // macOS sleep/resume can leave us with a late sidecar-exit event
              // for a conversation whose run had already settled. Do not poison
              // that transcript with a Retry state unless the frontend still
              // believes this conversation has a live run.
              if (!r?.running && !liveInStore) break;
              store.setError(
                evt.conversationId,
                `pi exited (code ${evt.code ?? "n/a"})`,
              );
              // The child is gone; any control request it was waiting on can
              // never be answered, so drop the card.
              store.clearControlRequest(evt.conversationId);
              // Close out any live run so a trailing agent_end can't double-fire.
              if (r) r.running = false;
              dispatchNotification("task_finished", {
                title: convTitle(evt.conversationId),
                body: `Agent process exited (code ${evt.code ?? "n/a"}).`,
                conversationId: evt.conversationId,
              });
            }
            break;
          }
          case "pi_event": {
            const cid = evt.conversationId;
            // extension_ui_request → DialogHost; cli_control_request → the
            // CliControlCard in the chat pane. Neither belongs in the reducer.
            const eventType = evt.event.type as string;
            if (
              evt.event.type !== "extension_ui_request" &&
              eventType !== "cli_control_request" &&
              cid
            ) {
              store.piEvent(cid, evt.event);
            }
            // A claude-code control request (permission prompt / AskUserQuestion)
            // is parked in the store — captured here in the app's single
            // always-mounted listener so it survives conversation switches and
            // can't be dropped by a per-card listener's async registration. The
            // card reads it back; agent_end clears any that went unanswered
            // (the child is gone, so there's nothing left to answer).
            if (cid && eventType === "cli_control_request") {
              const req = evt.event as unknown as CliControlRequest;
              store.pushControlRequest(cid, req);
              dispatchNotification("awaiting_input", {
                title: t("cliControl.notifyTitle"),
                body:
                  req.toolName === "AskUserQuestion"
                    ? req.input.questions?.[0]?.question ?? req.toolName
                    : req.toolName,
                suppressWhenFocused: true,
                conversationId: cid,
              });
            }
            if (cid && eventType === "agent_end") {
              store.clearControlRequest(cid);
            }
            // The agent called request_review → park this conversation in the
            // board's "Needs review" column. pi tools can't write our DB, so the
            // frontend persists the state on observing the tool's completion
            // (mirrors how parallel-task status is driven from here).
            if (
              cid &&
              evt.event.type === "tool_execution_end" &&
              evt.event.toolName === REVIEW_TOOL_NAME &&
              !evt.event.isError
            ) {
              api
                .setReviewState(cid, "pending")
                .then(applyReviewedRow)
                .catch(() => {});
            }
            if (cid) notifyForPiEvent(cid, evt.event);
            break;
          }
          case "conversation_updated": {
            // Async auto-title (or other out-of-band change) landed — merge the
            // fresh row into the sidebar list in place. If it just got archived
            // (e.g. by the auto-archive sweep), drop it from the active list.
            const updated = evt.conversation;
            setConversations((cs) =>
              updated.archivedAt != null
                ? cs.filter((c) => c.id !== updated.id)
                : cs.map((c) => (c.id === updated.id ? updated : c)),
            );
            break;
          }
          case "automation_updated":
            setAutomations((as) => mergeAutomation(as, evt.automation));
            break;
          case "automation_fired":
            // An automation minted a fresh conversation and started streaming.
            setAutomations((as) => mergeAutomation(as, evt.automation));
            setConversations((cs) => mergeConversation(cs, evt.conversation));
            break;
          case "meeting_event": {
            // Meeting capture lifecycle → localized OS notification. "started"
            // doubles as the consent surface (you should always know cetus is
            // transcribing), "saved" carries the generated title when one ran.
            const started = evt.kind === "started";
            dispatchNotification("meeting", {
              title: tt(
                "meeting",
                started ? "notify.started.title" : "notify.saved.title",
              ),
              body:
                (!started && evt.title) ||
                tt(
                  "meeting",
                  started ? "notify.started.body" : "notify.saved.body",
                ),
            });
            break;
          }
        }
      });
      if (cancelled) u();
      else unlisten = u;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [chatStore]);

  const refreshList = useCallback(async () => {
    const list = await api.listConversations(false);
    // Reconcile against current rows instead of swapping in all-new objects:
    // every rendered field bumps updated_at server-side, so id+updatedAt equal
    // → the old object is still accurate and keeping its reference preserves
    // the memo() on each sidebar row / board card. Without this, the trailing
    // refresh after every send/archive re-rendered the entire list for rows
    // that hadn't changed.
    setConversations((prev) => {
      const byId = new Map(prev.map((c) => [c.id, c]));
      let identical = prev.length === list.length;
      const next = list.map((c, i) => {
        const old = byId.get(c.id);
        const keep = old && old.updatedAt === c.updatedAt ? old : c;
        if (identical && keep !== prev[i]) identical = false;
        return keep;
      });
      return identical ? prev : next;
    });
    setConversationsLoaded(true);
    return list;
  }, []);

  // Identity-stable SettingsPage props — the panel stays mounted after first
  // open and is memoized, so unstable inline callbacks here would defeat that.
  const onSettingsSaved = useCallback(() => {
    refreshKeys().catch(console.error);
  }, [refreshKeys]);
  const onSettingsConversationsChanged = useCallback(() => {
    refreshList().catch(console.error);
  }, [refreshList]);
  const openHistoryFromSettings = useCallback(() => {
    closeSettings();
    setHistoryQuery("");
    setHistoryFrame(null);
    setHistoryOpen(true);
  }, [closeSettings]);

  const archiveConversation = useCallback(
    async (c: Conversation) => {
      await api.archiveConversation(c.id, !c.archivedAt);
      await refreshList();
      chatStore.getState().drop(c.id);
      if (c.id === activeIdRef.current) {
        saveLastActive(null);
        setActiveId(null);
      }
    },
    [refreshList, chatStore],
  );

  useEffect(() => {
    refreshList().catch(console.error);
  }, [refreshList]);

  useEffect(() => {
    if (!detailId) return;
    if (!conversationsLoaded) return;
    if (conversations.some((c) => c.id === detailId)) return;
    setDetailId(null);
  }, [conversations, conversationsLoaded, detailId]);

  const refreshAutomations = useCallback(async () => {
    const list = await api.listAutomations();
    setAutomations(list);
    return list;
  }, []);

  useEffect(() => {
    refreshAutomations().catch(console.error);
  }, [refreshAutomations]);

  // Restore the last active chat on cold start / ⌘R. Flip activeId
  // synchronously so a reload on a chat stays on that chat even when the IDB
  // render cache is empty; the cache and backend history fill in afterward.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const lastId = loadLastActive();
      if (!lastId) return;
      if (viewRef.current !== "chat") return;
      pendingSelectRef.current = lastId;
      const isStale = () => pendingSelectRef.current !== lastId;
      setActiveId(lastId);
      const cached = await loadCachedMessages(lastId);
      if (cancelled) return;
      let cachedLacksUser = false;
      if (cached && cached.length > 0) {
        chatStore.getState().hydrate(lastId, cached);
        cachedLacksUser = !cached.some((m) => m.role === "user");
      }
      const row = conversationsRef.current.find((c) => c.id === lastId);
      if (row) {
        setModelChoice(row.model);
        setWorkspaceDir(row.workspaceDir);
      }
      // A reload does not stop a running pi; it only remounts this webview.
      // During a turn, get_messages cannot reply until the run completes, so
      // calling switchConversation here can time out and falsely kick the UI
      // back to a new chat. If IDB has a faithful render, keep it and let the
      // existing app-event stream continue updating this conversation.
      if (cached && cached.length > 0 && !cachedLacksUser) return;
      // Attach pi and pull the canonical conversation row for model/workspace.
      // We deliberately DON'T `reset` from pi's history when the cache is
      // faithful: that history is lossy for image turns, so IDB is the better
      // render. If there is no cache, or a legacy cache dropped the user prompt,
      // fall back to pi history.
      api
        .switchConversation(lastId)
        .then(({ conversation, messages }) => {
          if (cancelled || isStale()) return;
          setModelChoice(conversation.model);
          setWorkspaceDir(conversation.workspaceDir);
          if (
            (!cached || cached.length === 0 || cachedLacksUser) &&
            messages?.some((m) => m.role === "user")
          ) {
            chatStore.getState().reset(lastId, messages);
          }
        })
        .catch((e) => {
          console.error("restore last active failed", lastId, e);
          if (!cancelled && !isStale() && !cached?.length) setActiveId(null);
        });
    })();
    return () => {
      cancelled = true;
    };
  }, [chatStore]);

  // Persist last-active id whenever it changes, so the *next* cold start
  // knows what to hydrate.
  useEffect(() => {
    if (activeId) saveLastActive(activeId);
  }, [activeId]);

  // Tell the backend which conversation is actually visible in the chat pane.
  // Auto-archive uses this to avoid removing a stale-but-open chat while the
  // user is reading it. Other surfaces clear the marker so old chats can still
  // archive once they are no longer foregrounded.
  useEffect(() => {
    api
      .setActiveConversation(view === "chat" ? activeId : null)
      .catch(console.error);
  }, [activeId, view]);

  useEffect(() => {
    if (view !== "chat" || !activeId) return;
    setUnreadCompletedIds((ids) => {
      if (!ids.has(activeId)) return ids;
      const next = new Set(ids);
      next.delete(activeId);
      return next;
    });
  }, [activeId, view]);

  // Global keyboard shortcuts (parallels macOS app conventions). App-level
  // shortcuts are user-configurable in Settings; Cmd/Ctrl+R remains fixed as a
  // recovery escape hatch.
  //   ⌘R    — reload the webview (works even behind a modal)
  //   ⌘K    — command palette
  //   ⌘N    — new chat / new board task
  //   ⌘D    — archive current conversation
  //   ⌘,    — open settings
  //   ⌘1…⌘4 — switch sidebar view
  //   ⌘[/⌘] — go back / forward through the page history (views + settings)
  //   ⌃⇥    — switch to the most recently used page (including chats/settings)
  //   ⌃1…⌃3 — switch the current chat's runtime (Cetus / Claude Code / Codex)
  //   ⌘B    — toggle workspace
  //   ⌘J    — toggle Terminal in the workspace
  //   ⌘T    — open a Browser tab in the right workspace
  //   ⌘P    — open a Files tab in the right workspace
  //   ⌘W    — close the active right-workspace tab when that panel is open
  //   ⌥⌘←/→ — switch right-workspace tabs when that panel is open
  //   ⌥⌘↑/↓ — switch to the previous / next chat
  //   ⌘⇧A   — toggle artifacts panel (chat view, when artifacts exist)
  //   Esc   — close artifacts panel, else abort current stream (palette closed)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const shortcut = (id: keyof typeof keyboardShortcuts) =>
        matchesShortcut(e, keyboardShortcuts[id]);
      // ⌘R / Ctrl+R — reload the webview. Tauri binds no reload shortcut and
      // cetus has no app menu, so wire it here (focus-scoped to this window, so
      // it doesn't hijack ⌘R system-wide the way a global shortcut would).
      // Handled before the modal guard so it's a true escape hatch even with a
      // dialog open; reloading also clears in-memory store state, which is
      // sometimes the only way out of a wedged render.
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "r"
      ) {
        e.preventDefault();
        window.location.reload();
        return;
      }
      // ⌘K / Ctrl+K — the command palette is a global launcher: openable from
      // anywhere. Handled before the modal guard (like ⌘R) so an open dialog
      // doesn't swallow it; it stacks over whatever's showing and owns its own
      // Esc to close. Toggles, so a second ⌘K dismisses it.
      if (shortcut("commandPalette")) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      // ⌘[ / ⌘] — walk the page history (sidebar views + Settings) like a
      // browser. Handled before the modal guard so Back can close Settings,
      // but the true dialogs below keep owning the keyboard.
      if (shortcut("navigateBack") || shortcut("navigateForward")) {
        if (automationDialogOpen || newTaskOpen || detailId !== null) return;
        e.preventDefault();
        if (shortcut("navigateBack")) navigateBack();
        else navigateForward();
        return;
      }
      // Ctrl+Tab — MRU page switch. It needs to run before the Settings guard
      // so Settings can toggle back to the page that opened it.
      if (shortcut("switchPreviousView")) {
        if (automationDialogOpen || newTaskOpen || detailId !== null) return;
        e.preventDefault();
        switchToPreviousPage();
        return;
      }
      // A modal owns the keyboard while open — don't fire app shortcuts (or
      // Esc-abort) behind it. Settings closes itself on Esc via a capture-phase
      // listener; the dialogs handle their own ⌘↵/Esc.
      if (
        settingsOpen ||
        automationDialogOpen ||
        newTaskOpen ||
        detailId !== null
      )
        return;
      const mod = e.metaKey || e.ctrlKey;
      // Esc — abort the current stream. (No mod key; palette owns its own Esc.)
      // Through onAbort, not a bare api.abort: the local endStream there flags
      // the run aborted. pi echoes an "aborted" error event that does the same,
      // but the CLI backends (claude-code / codex) don't — their trailing
      // agent_end would misread a thinking-only turn as an empty completion
      // and surface a spurious "model returned an empty response" error.
      if (e.key === "Escape" && !mod && !paletteOpen) {
        if (isStreaming && activeId) {
          e.preventDefault();
          onAbort().catch(console.error);
          return;
        }
      }
      if (sideWorkspace.open && shortcut("previousWorkspaceTab")) {
        e.preventDefault();
        switchWorkspaceTab("side", -1);
        return;
      }
      if (sideWorkspace.open && shortcut("nextWorkspaceTab")) {
        e.preventDefault();
        switchWorkspaceTab("side", 1);
        return;
      }
      if (shortcut("previousChat")) {
        e.preventDefault();
        switchChat(-1);
        return;
      }
      if (shortcut("nextChat")) {
        e.preventDefault();
        switchChat(1);
        return;
      }
      if (shortcut("toggleWorkspace")) {
        e.preventDefault();
        toggleSideWorkspacePanel();
      } else if (shortcut("toggleTerminal")) {
        e.preventDefault();
        toggleTerminalPanel();
      } else if (shortcut("openBrowserTab")) {
        e.preventDefault();
        openWorkspaceTab("side", "browser", true);
      } else if (shortcut("openFilesTab")) {
        e.preventDefault();
        openWorkspaceTab("side", "files");
      } else if (
        shortcut("closeWorkspaceTab") &&
        sideWorkspace.open &&
        sideWorkspace.tabs.length > 0
      ) {
        e.preventDefault();
        closeWorkspaceTab(
          "side",
          sideWorkspace.activeId ?? sideWorkspace.tabs[0].id,
        );
      } else if (shortcut("newChat")) {
        e.preventDefault();
        if (view === "board") {
          setNewTaskOpen(true);
        } else {
          // Non-board destinations start a new chat; Automations creates
          // schedules from its own button.
          onNew();
        }
      } else if (shortcut("newDefaultChat")) {
        e.preventDefault();
        // ⌥⌘N always lands a new chat in Chat (the default workspace), even
        // from the board or with another folder selected.
        onNew(defaultWorkspace || undefined);
      } else if (shortcut("archiveChat")) {
        const c = conversationsRef.current.find((x) => x.id === activeIdRef.current);
        if (c) {
          e.preventDefault();
          archiveConversation(c).catch((err) => {
            console.error("archiveConversation failed", err);
            toast.error("Couldn't archive that conversation.");
          });
        }
      } else if (shortcut("openSettings")) {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (
        view === "chat" &&
        (shortcut("runtimeCetus") ||
          shortcut("runtimeClaudeCode") ||
          shortcut("runtimeCodex"))
      ) {
        e.preventDefault();
        requestBackendSwitch(
          shortcut("runtimeCetus")
            ? "pi"
            : shortcut("runtimeClaudeCode")
              ? "claude-code"
              : "codex",
        );
      } else if (shortcut("switchChats")) {
        e.preventDefault();
        setView("chat");
      } else if (shortcut("switchBoard")) {
        e.preventDefault();
        setView("board");
      } else if (shortcut("switchAutomations")) {
        e.preventDefault();
        setView("automations");
      } else if (shortcut("switchPlugins")) {
        e.preventDefault();
        setView("plugins");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    view,
    paletteOpen,
    isStreaming,
    activeId,
    settingsOpen,
    automationDialogOpen,
    newTaskOpen,
    detailId,
    sideWorkspace.open,
    sideWorkspace.activeId,
    sideWorkspace.tabs,
    archiveConversation,
    keyboardShortcuts,
    defaultWorkspace,
    requestBackendSwitch,
    switchToPreviousPage,
    navigateBack,
    navigateForward,
  ]);

  function workspaceTitle(kind: WorkspaceTabKind, index: number): string {
    if (kind === "files") {
      return index > 1
        ? t("workspacePanel.filesN", { index })
        : t("workspacePanel.files");
    }
    if (kind === "terminal") {
      return index > 1
        ? t("workspacePanel.terminalN", { index })
        : t("workspacePanel.terminal");
    }
    return index > 1
      ? t("workspacePanel.browserN", { index })
      : t("workspacePanel.browser");
  }

  function browserTitle(url: string, fallback: string): string {
    if (!url || url === "about:blank") return fallback;
    try {
      const parsed = new URL(url);
      return parsed.host || parsed.pathname || fallback;
    } catch {
      return url.length > 24 ? `${url.slice(0, 21)}...` : url;
    }
  }

  function normalizeVisibleBrowserUrl(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return "about:blank";
    if (/^(https?:|file:|about:)/i.test(trimmed)) return trimmed;
    if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(\/|$)/i.test(trimmed)) {
      return `http://${trimmed}`;
    }
    return `https://${trimmed}`;
  }

  function browserStateForUrl(url: string): BrowserViewState {
    return {
      ...createBrowserViewState(),
      address: url,
      url,
      history: [url],
      historyIndex: 0,
    };
  }

  function updateWorkspaceDock(
    layout: WorkspaceLayout,
    updater: (dock: WorkspaceDockState) => WorkspaceDockState,
    keyOverride?: string | null,
  ) {
    const key = keyOverride ?? activeIdRef.current ?? NEW_CHAT_WORKSPACE_KEY;
    setWorkspaceDocksByChat((current) => {
      const currentDocks = current[key] ?? createInitialWorkspaceDocks();
      return {
        ...current,
        [key]: {
          ...currentDocks,
          [layout]: updater(currentDocks[layout]),
        },
      };
    });
  }

  function workspaceRefs(layout: WorkspaceLayout, keyOverride?: string | null) {
    const key = keyOverride ?? activeIdRef.current ?? NEW_CHAT_WORKSPACE_KEY;
    const dock =
      (workspaceDocksByChatRef.current[key] ?? createInitialWorkspaceDocks())[
        layout
      ];
    return {
      ...dock,
      setTabs: (updater: (tabs: WorkspaceTab[]) => WorkspaceTab[]) =>
        updateWorkspaceDock(
          layout,
          (current) => ({
            ...current,
            tabs: updater(current.tabs),
          }),
          key,
        ),
      setActiveId: (activeId: string | null) =>
        updateWorkspaceDock(
          layout,
          (current) => ({ ...current, activeId }),
          key,
        ),
      setOpen: (open: boolean) =>
        updateWorkspaceDock(layout, (current) => ({ ...current, open }), key),
      update: (updater: (dock: WorkspaceDockState) => WorkspaceDockState) =>
        updateWorkspaceDock(layout, updater, key),
    };
  }

  function openWorkspaceTab(
    layout: WorkspaceLayout,
    kind: WorkspaceTabKind,
    alwaysNew = false,
  ) {
    const { tabs, update } = workspaceRefs(layout);
    const existing = !alwaysNew ? tabs.find((t) => t.kind === kind) : undefined;
    if (existing) {
      const terminalFocusRequest =
        kind === "terminal"
          ? `term-focus-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
          : undefined;
      update((current) => ({
        ...current,
        tabs: terminalFocusRequest
          ? current.tabs.map((tab) =>
              tab.id === existing.id
                ? { ...tab, terminalFocusRequest }
                : tab,
            )
          : current.tabs,
        activeId: existing.id,
        open: true,
      }));
      return;
    }
    const count = tabs.filter((t) => t.kind === kind).length + 1;
    const terminalFocusRequest =
      kind === "terminal"
        ? `term-focus-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        : undefined;
    const tab: WorkspaceTab = {
      id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind,
      title: workspaceTitle(kind, count),
      terminalState: kind === "terminal" ? createTerminalViewState() : undefined,
      terminalFocusRequest,
      browserState: kind === "browser" ? createBrowserViewState() : undefined,
    };
    update((current) => ({
      ...current,
      tabs: [...current.tabs, tab],
      activeId: tab.id,
      open: true,
    }));
  }

  function openTerminalTab() {
    const { tabs, activeId, update } = workspaceRefs("bottom");
    const focusRequest = `term-focus-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const activeTerminal = tabs.find(
      (tab) => tab.id === activeId && tab.kind === "terminal",
    );
    const target = activeTerminal ?? tabs.find((tab) => tab.kind === "terminal");
    if (target) {
      update((current) => ({
        ...current,
        tabs: current.tabs.map((tab) =>
          tab.id === target.id ? { ...tab, terminalFocusRequest: focusRequest } : tab,
        ),
        activeId: target.id,
        open: true,
      }));
      return;
    }

    const count = tabs.filter((tab) => tab.kind === "terminal").length + 1;
    const tab: WorkspaceTab = {
      id: `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: "terminal",
      title: workspaceTitle("terminal", count),
      terminalState: createTerminalViewState(),
      terminalFocusRequest: focusRequest,
    };
    update((current) => ({
      ...current,
      tabs: [...current.tabs, tab],
      activeId: tab.id,
      open: true,
    }));
  }

  function toggleTerminalPanel() {
    if (workspaceRefs("bottom").open) {
      workspaceRefs("bottom").setOpen(false);
      return;
    }
    openTerminalTab();
  }

  function toggleSideWorkspacePanel() {
    if (workspaceRefs("side").open) {
      workspaceRefs("side").setOpen(false);
      return;
    }
    openWorkspacePanelLayout("side");
  }

  function openWorkspacePanelLayout(layout: WorkspaceLayout) {
    const { tabs, setOpen } = workspaceRefs(layout);
    setOpen(true);
    if (tabs.length === 0) {
      openWorkspaceTab(layout, layout === "bottom" ? "terminal" : "files");
    }
  }

  function openTerminalWithCommand(commandRaw: string) {
    const command = commandRaw.trim();
    if (!command) return;
    const request: TerminalRunRequest = {
      id: `term-run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      command,
      autoRun: true,
    };
    const { tabs, activeId, update } = workspaceRefs("bottom");
    const activeTerminal = tabs.find(
      (tab) => tab.id === activeId && tab.kind === "terminal",
    );
    const target = activeTerminal ?? tabs.find((tab) => tab.kind === "terminal");
    if (target) {
      update((current) => ({
        ...current,
        tabs: current.tabs.map((tab) =>
          tab.id === target.id ? { ...tab, terminalRunRequest: request } : tab,
        ),
        activeId: target.id,
        open: true,
      }));
      return;
    }

    const count = tabs.filter((tab) => tab.kind === "terminal").length + 1;
    const tab: WorkspaceTab = {
      id: `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: "terminal",
      title: workspaceTitle("terminal", count),
      terminalState: createTerminalViewState(),
      terminalRunRequest: request,
    };
    update((current) => ({
      ...current,
      tabs: [...current.tabs, tab],
      activeId: tab.id,
      open: true,
    }));
  }

  function updateBrowserWorkspaceTab(layout: WorkspaceLayout, id: string, state: BrowserViewState) {
    const { setTabs } = workspaceRefs(layout);
    setTabs((tabs) =>
      tabs.map((tab) =>
        tab.id === id && tab.kind === "browser"
          ? {
              ...tab,
              title: browserTitle(state.url, tab.title),
              browserState: state,
            }
          : tab,
      ),
    );
  }

  function updateTerminalWorkspaceTab(
    layout: WorkspaceLayout,
    id: string,
    state: TerminalViewState,
  ) {
    const { setTabs } = workspaceRefs(layout);
    setTabs((tabs) =>
      tabs.map((tab) =>
        tab.id === id && tab.kind === "terminal"
          ? { ...tab, terminalState: state }
          : tab,
      ),
    );
  }

  function openVisibleBrowser(urlRaw: string, conversationId?: string | null) {
    const url = normalizeVisibleBrowserUrl(urlRaw);
    const { tabs, activeId, update } = workspaceRefs("side", conversationId);
    const activeBrowser = tabs.find(
      (tab) => tab.id === activeId && tab.kind === "browser",
    );
    const target = activeBrowser ?? tabs.find((tab) => tab.kind === "browser");
    if (target) {
      const state = browserStateForUrl(url);
      update((current) => ({
        ...current,
        tabs: current.tabs.map((tab) =>
          tab.id === target.id
            ? { ...tab, title: browserTitle(url, tab.title), browserState: state }
            : tab,
        ),
        activeId: target.id,
        open: true,
      }));
      return;
    }

    const count = tabs.filter((tab) => tab.kind === "browser").length + 1;
    const tab: WorkspaceTab = {
      id: `browser-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: "browser",
      title: browserTitle(url, workspaceTitle("browser", count)),
      browserState: browserStateForUrl(url),
    };
    update((current) => ({
      ...current,
      tabs: [...current.tabs, tab],
      activeId: tab.id,
      open: true,
    }));
  }

  function closeWorkspaceTab(layout: WorkspaceLayout, id: string) {
    const { activeId, setTabs, setActiveId, setOpen } = workspaceRefs(layout);
    setTabs((tabs) => {
      const index = tabs.findIndex((t) => t.id === id);
      if (index === -1) return tabs;
      const next = tabs.filter((t) => t.id !== id);
      if (activeId === id) {
        const fallback = next[Math.min(index, next.length - 1)] ?? null;
        setActiveId(fallback?.id ?? null);
        if (!fallback) setOpen(false);
      }
      return next;
    });
  }

  function switchWorkspaceTab(layout: WorkspaceLayout, direction: 1 | -1) {
    const { tabs, activeId, setActiveId, setOpen } = workspaceRefs(layout);
    if (tabs.length < 2) return;
    const activeIndex = Math.max(
      0,
      tabs.findIndex((tab) => tab.id === activeId),
    );
    const nextIndex = (activeIndex + direction + tabs.length) % tabs.length;
    setActiveId(tabs[nextIndex].id);
    setOpen(true);
  }

  function renderWorkspaceDock(layout: WorkspaceLayout) {
    const dock = workspaceDocks[layout];
    const presence =
      layout === "side" ? sideWorkspacePresence : bottomWorkspacePresence;
    if (!presence.mounted) return null;
    return (
      <WorkspacePanel
        tabs={dock.tabs}
        activeId={dock.activeId}
        workspaceDir={workspaceDir}
        defaultWorkspace={defaultWorkspace}
        onSelect={(id) => {
          updateWorkspaceDock(layout, (current) => ({
            ...current,
            activeId: id,
            open: true,
          }));
        }}
        onClose={(id) => closeWorkspaceTab(layout, id)}
        onClosePanel={() => workspaceRefs(layout).setOpen(false)}
        onNewTab={(kind) => openWorkspaceTab(layout, kind, true)}
        layout={layout}
        onUpdateTerminalTab={(id, state) =>
          updateTerminalWorkspaceTab(layout, id, state)
        }
        onUpdateBrowserTab={(id, state) =>
          updateBrowserWorkspaceTab(layout, id, state)
        }
        motionState={dock.open ? "open" : "closed"}
        hidden={presence.hidden}
        onAnnotate={async (message) => {
          await onSend(message);
          setView("chat");
        }}
      />
    );
  }

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<BrowserControlEvent>("browser-control-request", (e) => {
      const payload = e.payload;
      if (payload?.op !== "open" || !payload.url) return;
      openVisibleBrowser(payload.url, payload.conversationId);
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // openVisibleBrowser reads live tab state through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** "New chat" only resets the local view to the hero — the backend
   *  conversation row is created lazily on the first send. This way clicking
   *  New chat multiple times never spawns orphan Untitled rows in the
   *  sidebar. Focus is yanked back to the textarea on every click. */
  function onNew(nextWorkspaceDir?: string) {
    // "New chat" is a conversations action — land on the chat hero even when
    // triggered from the Automations destination.
    setView("chat");
    if (nextWorkspaceDir) {
      setWorkspaceDir(nextWorkspaceDir);
    }
    saveLastActive(null);
    setActiveId(null);
    setFocusToken((t) => t + 1);
  }

  const onSelect = useCallback(
    async (id: string) => {
      if (id === activeIdRef.current) return;
      // Mark this as the latest intent *before* any await. If the user clicks a
      // different chat while our async work is in flight, this ref moves on and
      // every guard below bails — so a slow select can't land its state on top
      // of a newer one (the "clicked A, landed on B" / stutter bug).
      pendingSelectRef.current = id;
      const isStale = () => pendingSelectRef.current !== id;
      // Flip the active chat *synchronously*, before any await. The highlight
      // and pane switch must not wait on the backend round-trip — `pi_for`
      // serializes on a global lock and lazy-spawns a pi process on first open,
      // so a cold switch can take hundreds of ms. Blocking the visual switch on
      // it makes rapid clicks feel like they do nothing. Messages stream in
      // once the cache/backend resolves below (guarded by `isStale`).
      setActiveId(id);
      // Capture liveness *before* we touch the store, so a background stream
      // for this conv can't be clobbered by a cache hydrate + reset.
      const liveState = chatStore.getState().chats[id];
      const hasLiveState = !!liveState && liveState.messages.length > 0;
      // A *settled* render with no user bubble at all is a stale, lossy render
      // — e.g. an automation that streamed under older code which dropped the
      // user prompt. Don't take the client-side fast path for it; fall through
      // to fetch pi history and repair below. Guarded on !isStreaming so we
      // never clobber an in-flight turn or hit get_messages' mid-run stall.
      const liveNeedsRepair =
        hasLiveState &&
        !liveState!.isStreaming &&
        !liveState!.messages.some((m) => m.role === "user");
      // We already hold this conversation's messages live in memory (opened or
      // streamed earlier this session) and its pi is attached. Switch purely
      // client-side and SKIP the backend round-trip: `switch_conversation` calls
      // `pi.get_messages()`, which blocks up to the 30s request timeout when the
      // pi is mid-run — it doesn't service control requests while an agent turn
      // streams. That timeout is spurious (the turn itself replies fine over the
      // event stream), but it stalls the metadata refresh and logs a scary
      // error. Metadata comes from the conversation row we already have.
      if (hasLiveState && !liveNeedsRepair) {
        const row = conversationsRef.current.find((c) => c.id === id);
        if (row) {
          setModelChoice(row.model);
          setWorkspaceDir(row.workspaceDir);
        }
        return;
      }
      let cacheHit = false;
      let cachedLacksUser = false;
      let cachedLen = 0;
      if (!hasLiveState) {
        // Optimistic: hydrate from IDB cache before the backend roundtrip so
        // the bubbles paint immediately.
        const cached = await loadCachedMessages(id);
        if (isStale()) return;
        if (cached && cached.length > 0) {
          chatStore.getState().hydrate(id, cached);
          cacheHit = true;
          cachedLen = cached.length;
          // Caches written before automation runs rendered their prompt are
          // assistant-only. Such a render is strictly less faithful than pi
          // history, so flag it to fall back below.
          cachedLacksUser = !cached.some((m) => m.role === "user");
        }
      }
      if (cacheHit && !cachedLacksUser) {
        const row = conversationsRef.current.find((c) => c.id === id);
        if (row) {
          setModelChoice(row.model);
          setWorkspaceDir(row.workspaceDir);
        }
        return;
      }
      let conversation: Conversation;
      let messages: PiMessage[];
      try {
        ({ conversation, messages } = await api.switchConversation(id));
      } catch (e) {
        // A failed round-trip must not leave the click in limbo: the UI already
        // flipped to `id` optimistically, so log and bail rather than letting
        // the rejection silently abort the rest of the handler.
        console.error("switchConversation failed", id, e);
        return;
      }
      if (isStale()) return;
      setModelChoice(conversation.model);
      setWorkspaceDir(conversation.workspaceDir);
      // Seed from pi only when we have neither live state nor a cache hit. The
      // cache is the faithful render (pi history is lossy for image turns), so
      // we don't overwrite it; pi history is the fallback for conversations
      // this client has never rendered. Exception: a cache that dropped the
      // leading user prompt (legacy automation renders) is repaired from pi
      // history, which still carries the prompt.
      // pi history is authoritative for message COUNT. A cache thinner than
      // history means it missed turns — e.g. an interrupted run that never hit
      // agent_end, so only the user bubble (or a partial render) was cached.
      // Compare against pi's non-toolResult messages, since the cache folds
      // tool results into their tool_use blocks rather than keeping them as
      // separate entries. When history has more, repair from it.
      const piTurnCount =
        messages?.filter((m) => m.role !== "toolResult").length ?? 0;
      const cacheTooThin = cacheHit && piTurnCount > cachedLen;
      const repairFromHistory =
        !!messages?.some((m) => m.role === "user") &&
        ((cacheHit && (cachedLacksUser || cacheTooThin)) || liveNeedsRepair);
      if ((!hasLiveState && !cacheHit) || repairFromHistory) {
        chatStore.getState().reset(conversation.id, messages);
      }
    },
    // Reads activeIdRef (not activeId) so this keeps a stable identity across
    // selections — required for the memoized sidebar rows / board cards to skip
    // re-rendering when only the active highlight moves.
    [chatStore],
  );

  // Identity-stable handlers handed to the memoized AppSidebar / BoardView /
  // ConversationRow / Card. They read the live view via viewRef so none of them
  // need a `view` dependency that would break memoization on every view switch.
  const onSelectChat = useCallback(
    (id: string) => {
      setUnreadCompletedIds((ids) => {
        if (!ids.has(id)) return ids;
        const next = new Set(ids);
        next.delete(id);
        return next;
      });
      setView("chat");
      onSelect(id);
    },
    [onSelect],
  );
  const switchChat = useCallback(
    (direction: 1 | -1) => {
      // Walk the sidebar's visual order (grouped by workspace), not the raw
      // recency-sorted list — otherwise ⌥⌘↑/↓ jumps across folders in an order
      // the user can't see.
      const ids = orderedChatIdsRef.current;
      if (ids.length === 0) return;
      const activeIndex = ids.indexOf(activeIdRef.current ?? "");
      const currentIndex = activeIndex >= 0 ? activeIndex : direction > 0 ? -1 : 0;
      const nextIndex = (currentIndex + direction + ids.length) % ids.length;
      onSelectChat(ids[nextIndex]);
    },
    [onSelectChat],
  );
  const onNewSidebar = useCallback((nextWorkspaceDir?: string) => {
    if (viewRef.current === "board") {
      if (nextWorkspaceDir) {
        setWorkspaceDir(nextWorkspaceDir);
      }
      setNewTaskOpen(true);
    } else {
      onNew(nextWorkspaceDir);
    }
  }, []);

  // Open the conversation a clicked OS notification points at. notify.rs brings
  // the window forward and emits this with the conversation id. Archived → it's
  // not in the active list, so unarchive (which doubles as an existence check)
  // and reload; deleted → the unarchive throws and we surface a toast instead.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<{ conversationId: string | null }>(
      "notification-activate",
      async (e) => {
        const cid = e.payload?.conversationId;
        if (!cid) return;
        if (conversationsRef.current.some((c) => c.id === cid)) {
          onSelectChat(cid);
          return;
        }
        try {
          await api.archiveConversation(cid, false);
          await refreshList();
          onSelectChat(cid);
        } catch {
          toast.error("That conversation no longer exists.");
        }
      },
    ).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [onSelectChat, refreshList]);

  // Browser WebView annotations are emitted by a separate top-level window.
  // Route them through the same send path as normal user feedback so the active
  // conversation receives URL + selected element context.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<BrowserAnnotationEvent>("browser-annotation", async (e) => {
      const payload = e.payload;
      if (!payload?.url || !payload.note) return;
      setView("chat");
      await onSendRef.current(browserAnnotationMessage(payload));
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Passive "update available" toast: fired only when auto-update is off and a
  // background check finds a (not-yet-dismissed) newer version. Install applies
  // on next launch; Ignore remembers this version so it won't re-prompt.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    onUpdateAvailable((u) => {
      toast(tt("settings", "update.toast.title", { version: u.version }), {
        description: tt("settings", "update.toast.body"),
        duration: Infinity,
        action: {
          label: tt("settings", "update.toast.install"),
          onClick: async () => {
            const id = toast.loading(tt("settings", "update.installing"));
            let unlistenProgress: (() => void) | undefined;
            try {
              unlistenProgress = await onUpdateDownloadProgress((progress) => {
                const percent =
                  progress.total && progress.total > 0
                    ? Math.max(
                        0,
                        Math.min(
                          100,
                          Math.round((progress.downloaded / progress.total) * 100),
                        ),
                      )
                    : null;
                toast.loading(tt("settings", "update.installing"), {
                  id,
                  description: percent == null ? undefined : `${percent}%`,
                });
              });
              await api.installUpdate();
              toast.success(tt("settings", "update.installed"), { id });
            } catch {
              toast.error(tt("settings", "update.failed"), { id });
            } finally {
              unlistenProgress?.();
            }
          },
        },
        cancel: {
          label: tt("settings", "update.toast.ignore"),
          onClick: () => {
            void api.ignoreUpdateVersion(u.version);
          },
        },
      });
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
  // A downloaded-but-not-yet-applied update. Set when the backend reports the
  // swap is on disk (silent auto-install, or a manual install); drives the
  // sidebar's persistent "Restart to update" button.
  const [updateReadyVersion, setUpdateReadyVersion] = useState<string | null>(
    null,
  );
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    api
      .pendingUpdateVersion()
      .then((version) => {
        if (!cancelled && version) setUpdateReadyVersion(version);
      })
      .catch(() => {});
    onUpdateReady((u) => setUpdateReadyVersion(u.version)).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
  const onRestartToUpdate = useCallback(() => {
    api.relaunchApp().catch(console.error);
  }, []);

  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const onOpenDetail = useCallback((id: string) => setDetailId(id), []);

  async function onModelChange(next: ModelChoice) {
    // The [modelChoice] effect mirrors this into localStorage; here we only need
    // to update state and the per-conversation backend record.
    setModelChoice(next);
    if (activeId) {
      api.setModelChoice(activeId, next).catch(console.error);
    }
  }

  async function onWorkspaceChange(dir: string) {
    setWorkspaceDir(dir);
    if (activeId) {
      const updated = await api.setWorkspace(activeId, dir);
      setConversations((cs) => cs.map((c) => (c.id === updated.id ? updated : c)));
    }
  }

  async function onSend(text: string, attachments: ComposerAttachment[] = []) {
    let id = activeId;
    if (!id) {
      const c = await api.newConversation(workspaceDir ?? undefined);
      id = c.id;
      // Apply the backend chosen on the hero composer before the first prompt
      // goes out, so it already routes through Claude Code / Codex.
      if (pendingBackend !== "pi") {
        try {
          await api.setConversationBackend(id, pendingBackend);
          if (pendingCliModel || pendingCliEffort) {
            await api.setConversationCliModel(id, pendingCliModel, pendingCliEffort);
          }
        } catch (e) {
          console.error("[send] set backend failed", e);
        }
      }
      // Insert the freshly-minted row locally instead of refetching the whole
      // list over IPC — we already hold it. The trailing refreshList() after
      // sendPrompt re-sorts by updated_at.
      setConversations((cs) => mergeConversation(cs, c));
      setActiveId(id);
      setWorkspaceDir(c.workspaceDir);
      api.setModelChoice(id, modelChoice).catch(console.error);
    }
    const convId = id;
    // A new prompt to a task that was waiting on review means we're moving on —
    // drop it out of "Needs review".
    maybeClearReview(convId);
    const store = chatStore.getState();
    store.ensure(convId);
    let out: Outgoing;
    try {
      out = await prepareOutgoing(convId, text, attachments);
    } catch (e) {
      chatStore.getState().setError(convId, `attachment failed: ${e}`);
      return;
    }
    store.userSent(convId, text, out.localImages, out.savedFiles);
    // Reclaim focus so the next prompt is one keystroke away — Tauri's
    // webview steals focus away from the textarea after a submit on macOS.
    setFocusToken((t) => t + 1);
    try {
      await api.sendPrompt(convId, out.piMessage, out.piImages);
    } catch (e) {
      chatStore.getState().setError(convId, String(e));
    }
    refreshList().catch(() => {});
  }

  /** Main-chat bash entry: `!cmd` is a Terminal surface shortcut, not a chat
   *  message. Open/focus the right Terminal tab and run the command there. */
  function onBash(command: string) {
    setFocusToken((t) => t + 1);
    openTerminalWithCommand(command);
  }

  /** True when `id` runs on a CLI backend (claude-code / codex). Their runner
   *  persists a stopped turn's partial messages, so an abort keeps what
   *  streamed on screen instead of dropping the in-flight turn (pi's
   *  semantics — see end_stream's keepPartial). */
  function isCliConv(id: string | null): boolean {
    const b = conversationsRef.current.find((c) => c.id === id)?.backend;
    return b === "claude-code" || b === "codex";
  }

  async function onAbort() {
    if (!activeId) return;
    // Bailing out of the run: drop anything parked for it rather than
    // auto-delivering the queue after the abort lands.
    setQueued((q) => ({ ...q, [activeId]: [] }));
    // pi.abort() stops the model but emits no agent_end, so end the run locally:
    // flips isStreaming false → the write-through cache flushes the rendered turn
    // and the run no longer looks "active" (which would stall get_messages on the
    // next reopen and leave only the user bubble).
    chatStore.getState().endStream(activeId, isCliConv(activeId));
    await api.abort(activeId);
  }

  /** ChatGPT-style "regenerate": roll the last turn out of history (so a
   *  failed/empty turn can't poison future sends), then resubmit the last user
   *  message. Drives both the header "Retry" button (on error) and the
   *  per-message "Regenerate" action on the final assistant turn. */
  function onRetry() {
    return retryConversation(activeId, onSend);
  }

  /** ChatGPT-style "regenerate" for an arbitrary conversation: roll the last
   *  turn out of history (so a failed/empty turn can't poison future sends),
   *  then resubmit the last user message through `send` (onSend for the main
   *  chat, onDetailSend for the board detail dialog — each re-adds the user
   *  bubble on its own surface). */
  async function retryConversation(
    id: string | null,
    send: (text: string, attachments?: ComposerAttachment[]) => Promise<void>,
  ) {
    if (!id || retryingRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    try {
      // The optimistic user bubble that's already on screen. If the backend has
      // nothing to fork (the original send died before committing the turn —
      // e.g. a pi gone stale after a long idle), this is the message the user
      // wants resent. Capture it before we touch the store.
      const pendingText = lastUserText(id);
      let text: string;
      try {
        const res = await api.retryLastTurn(id);
        text = res.text;
        // Truncated history — the failed/poisoned turn was forked away.
        chatStore.getState().reset(id, res.messages);
      } catch (e) {
        // No committed user turn to roll back to: the send never reached the
        // session, so there's nothing to fork. Fall back to resubmitting the
        // optimistic bubble rather than dead-ending on the raw backend error.
        if (!isNothingToRetry(e) || !pendingText) throw e;
        text = pendingText;
        chatStore.getState().reset(id, []); // drop the stranded bubble + error
      }
      chatStore.getState().setError(id, null);
      await send(text); // re-adds the user bubble + reruns the turn
    } catch (e) {
      console.error("[retry] error", e);
      chatStore.getState().setError(id, String(e));
    } finally {
      retryingRef.current = false;
      setRetrying(false);
    }
  }

  // --- Global quick launcher (separate frameless window) ------------------
  // The launcher gathers a prompt + optional screenshot and fires
  // "quick-launch" at the main window. We own conversation create/reuse and the
  // optimistic user bubble, so route the payload through the normal send path.
  async function quickLaunch(p: QuickLaunchPayload) {
    setView("chat");
    const localImages = p.image
      ? [{ dataUrl: `data:${p.image.mimeType};base64,${p.image.data}`, name: "Screenshot.jpg" }]
      : [];
    const images = p.image
      ? [{ type: "image" as const, data: p.image.data, mimeType: p.image.mimeType }]
      : [];

    // Adopt the model + Ultra choice the launcher made so the composer and the
    // launched conversation agree. Ultra is a global switch the launcher already
    // persisted backend-side; mirror it into the main window's state too.
    const launchedModel: ModelChoice = { model: p.model, reasoning: p.reasoning };
    // The [modelChoice] effect persists this to localStorage.
    setModelChoice(launchedModel);
    setUltraEnabled(p.ultra);

    let target: string | null = null;
    if (p.sessionMode === "last") {
      // The open conversation, else the most-recently-updated one.
      target = activeId ?? conversations[0]?.id ?? null;
      if (target && target !== activeId) await onSelect(target);
    }
    if (!target) {
      // Honor the repo chosen in the launcher. A null workspaceDir means the
      // launcher's visible "Chat" default, not the main window's current repo.
      const c = await api.newConversation(p.workspaceDir ?? undefined);
      target = c.id;
      // Coding-agent runtime chosen in the launcher (Cetus / Claude Code /
      // Codex). Applied to fresh conversations only — reusing "last" keeps
      // that conversation's own backend. Awaited so the first send_prompt
      // already routes through the chosen backend.
      if (p.backend && p.backend !== "pi") {
        try {
          await api.setConversationBackend(c.id, p.backend);
          if (p.cliModel || p.cliEffort) {
            await api.setConversationCliModel(c.id, p.cliModel ?? "", p.cliEffort ?? "");
          }
        } catch (e) {
          console.error("[quick-launch] set backend failed", e);
        }
      }
      // Local insert instead of a full refetch; trailing refreshList re-sorts.
      setConversations((cs) => mergeConversation(cs, c));
      setActiveId(target);
      setWorkspaceDir(c.workspaceDir);
    } else if (target !== activeId) {
      setActiveId(target);
    }
    const convId = target;
    // Apply the launcher's model to the target (new or reused) before sending.
    api.setModelChoice(convId, launchedModel).catch(console.error);
    // Continuing an existing task from the launcher (sessionMode "last") is the
    // same "moving on" signal as the other send paths — drop it out of review.
    maybeClearReview(convId);
    const store = chatStore.getState();
    store.ensure(convId);
    // Fold any ambient context into a fenced block ahead of the prompt — the
    // model reads it as environment data, the bubble renders it as a chip. One
    // composed string drives both the optimistic render and the model send.
    const composed = composeWithContext(p.text, p.context);
    store.userSent(convId, composed, localImages);
    setFocusToken((t) => t + 1);
    try {
      await api.sendPrompt(convId, composed, images);
    } catch (e) {
      chatStore.getState().setError(convId, String(e));
    }
    refreshList().catch(() => {});
  }
  // Keep a live ref so the mount-once listener always calls the latest closure
  // (quickLaunch closes over activeId / conversations / workspaceDir).
  const quickLaunchRef = useRef(quickLaunch);
  quickLaunchRef.current = quickLaunch;
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<QuickLaunchPayload>("quick-launch", (e) => {
          void quickLaunchRef.current(e.payload);
        }),
      )
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Tray "Settings" item opens the settings screen (the window is shown natively
  // by the tray handler before this fires).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen("open-settings", () => setSettingsOpen(true)),
      )
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  /** Create-task dialog handler: mint a conversation, optimistically seed the
   *  user bubble, fire-and-forget sendPrompt (the agent streams asynchronously
   *  and shows up as a card on the kanban with a streaming dot). */
  async function onCreateTask(
    text: string,
    attachments: ComposerAttachment[],
  ) {
    const c = await api.newConversation(workspaceDir ?? undefined);
    const id = c.id;
    // Runtime chosen in the dialog — the shared pending state (same one the chat
    // hero + quick launcher use). Applied before the first prompt goes out so it
    // already routes through Claude Code / Codex.
    if (pendingBackend !== "pi") {
      try {
        await api.setConversationBackend(id, pendingBackend);
        if (pendingCliModel || pendingCliEffort) {
          await api.setConversationCliModel(id, pendingCliModel, pendingCliEffort);
        }
      } catch (e) {
        console.error("[create-task] set backend failed", e);
      }
    }
    // Show the new card immediately via a local insert (no IPC); the .finally
    // refreshList below re-sorts once the run starts bumping updated_at.
    setConversations((cs) => mergeConversation(cs, c));
    api.setModelChoice(id, modelChoice).catch(console.error);
    const store = chatStore.getState();
    store.ensure(id);
    let out: Outgoing;
    try {
      out = await prepareOutgoing(id, text, attachments);
    } catch (e) {
      chatStore.getState().setError(id, `attachment failed: ${e}`);
      return;
    }
    store.userSent(id, text, out.localImages, out.savedFiles);
    // Don't await — let the agent stream in the background. The kanban card
    // shows a live "streaming" dot via streamingIds.
    api
      .sendPrompt(id, out.piMessage, out.piImages)
      .catch((e) => chatStore.getState().setError(id, String(e)))
      .finally(() => refreshList().catch(() => {}));
  }

  // --- Detail dialog (board card peek that supports chat) -----------------
  useEffect(() => {
    if (!detailId) return;
    const conv = conversations.find((c) => c.id === detailId);
    if (conv) {
      setDetailModelChoice(conv.model);
      setDetailWorkspaceDir(conv.workspaceDir);
    }
    setDetailFocusToken((t) => t + 1);
    const id = detailId;
    let cancelled = false;
    (async () => {
      // Snapshot liveness before any await so a streaming conv can't get
      // clobbered by a late cache hydrate + reset.
      const hasLiveState = (() => {
        const c = chatStore.getState().chats[id];
        return !!c && c.messages.length > 0;
      })();
      if (hasLiveState) return; // nothing to do; reducer owns state
      // Flip loading on synchronously, BEFORE the first await, so the dialog
      // paints its skeleton immediately instead of flashing ChatPane's empty
      // hero while the cache + history round-trips resolve. (Once a cache hit
      // hydrates the store, the dialog's hasChatEntry gate hides the skeleton.)
      setDetailLoading(true);
      const cached = await loadCachedMessages(id);
      if (cancelled) return;
      let cacheHit = false;
      let cachedLacksUser = false;
      if (cached && cached.length > 0) {
        chatStore.getState().hydrate(id, cached);
        cacheHit = true;
        cachedLacksUser = !cached.some((m) => m.role === "user");
      }
      if (cacheHit && !cachedLacksUser) {
        setDetailLoading(false);
        return;
      }
      try {
        const { messages } = await api.switchConversation(id);
        if (cancelled) return;
        // Keep the faithful cache render if we had one; pi history is the
        // lossy fallback (see onSelect / cold-start hydration). Exception: a
        // legacy automation cache that dropped the leading user prompt is
        // repaired from pi history, which still carries it.
        const repairFromHistory =
          cacheHit && cachedLacksUser && !!messages?.some((m) => m.role === "user");
        if (!cacheHit || repairFromHistory) chatStore.getState().reset(id, messages);
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailId]);

  /** Deliver a queued follow-up to `convId`, regardless of which surface (if
   *  any) currently has it open. Mirrors the core of onSend/onDetailSend without
   *  the surface-specific focus handling, so the store-driven flush can send to
   *  a background conversation the user has navigated away from. */
  async function deliverQueued(
    convId: string,
    text: string,
    attachments: ComposerAttachment[] = [],
  ) {
    maybeClearReview(convId);
    const store = chatStore.getState();
    store.ensure(convId);
    let out: Outgoing;
    try {
      out = await prepareOutgoing(convId, text, attachments);
    } catch (e) {
      chatStore.getState().setError(convId, `attachment failed: ${e}`);
      return;
    }
    store.userSent(convId, text, out.localImages, out.savedFiles);
    try {
      await api.sendPrompt(convId, out.piMessage, out.piImages);
    } catch (e) {
      chatStore.getState().setError(convId, String(e));
    }
    refreshList().catch(() => {});
  }

  async function onDetailSend(text: string, attachments: ComposerAttachment[] = []) {
    if (!detailId) return;
    const id = detailId;
    // Sending feedback from the review surface clears the "Needs review" flag.
    maybeClearReview(id);
    const store = chatStore.getState();
    store.ensure(id);
    let out: Outgoing;
    try {
      out = await prepareOutgoing(id, text, attachments);
    } catch (e) {
      chatStore.getState().setError(id, `attachment failed: ${e}`);
      return;
    }
    store.userSent(id, text, out.localImages, out.savedFiles);
    setDetailFocusToken((t) => t + 1);
    try {
      await api.sendPrompt(id, out.piMessage, out.piImages);
    } catch (e) {
      chatStore.getState().setError(id, String(e));
    }
    refreshList().catch(() => {});
  }

  async function onDetailAbort() {
    if (!detailId) return;
    // Bailing out: drop anything parked for this conversation rather than
    // auto-delivering the queue after the abort lands (mirrors onAbort).
    setQueued((q) => ({ ...q, [detailId]: [] }));
    chatStore.getState().endStream(detailId, isCliConv(detailId));
    await api.abort(detailId);
  }

  /** Roll back + rerun the last turn from the detail dialog. */
  function onDetailRetry() {
    return retryConversation(detailId, onDetailSend);
  }

  /** Promote a queued follow-up to an immediate send from the detail dialog.
   *  Routes through onDetailSend so the delivery lands on `detailId` (not the
   *  main chat's activeId). */
  function steerQueuedDetail(id: string) {
    if (!detailId) return;
    const item = (queuedRef.current[detailId] ?? []).find((m) => m.id === id);
    if (!item) return;
    removeQueued(detailId, id);
    void onDetailSend(item.text, item.attachments);
  }

  async function onDetailModelChange(next: ModelChoice) {
    setDetailModelChoice(next);
    if (detailId) {
      api.setModelChoice(detailId, next).catch(console.error);
    }
  }

  async function onDetailWorkspaceChange(dir: string) {
    setDetailWorkspaceDir(dir);
    if (detailId) {
      const updated = await api.setWorkspace(detailId, dir);
      setConversations((cs) => cs.map((c) => (c.id === updated.id ? updated : c)));
    }
  }

  const onArchive = useCallback(
    async (c: Conversation) => {
      await archiveConversation(c);
    },
    [archiveConversation],
  );

  const onRevealWorkspace = useCallback(async (dir: string) => {
    try {
      await api.openPath(dir);
    } catch (e) {
      console.error("reveal workspace failed", dir, e);
      toast.error("Couldn't reveal that folder.");
    }
  }, []);

  const onArchiveWorkspaceChats = useCallback(
    async (dir: string) => {
      const targets = conversationsRef.current.filter(
        (c) => c.workspaceDir === dir && !c.archivedAt,
      );
      if (targets.length === 0) return;
      try {
        await Promise.all(
          targets.map((c) => api.archiveConversation(c.id, true)),
        );
        const store = chatStore.getState();
        for (const c of targets) store.drop(c.id);
        await refreshList();
        setDetailId((id) =>
          id && targets.some((c) => c.id === id) ? null : id,
        );
        if (targets.some((c) => c.id === activeIdRef.current)) {
          saveLastActive(null);
          setActiveId(null);
        }
        setBoardWorkspaceFilter((filter) => (filter === dir ? null : filter));
      } catch (e) {
        console.error("archive workspace chats failed", dir, e);
        toast.error("Couldn't archive those chats.");
      }
    },
    [chatStore, refreshList],
  );

  const onRemoveWorkspace = useCallback(
    (dir: string) => {
      const next = hideWorkspace(dir);
      setRecentWorkspaces(next.recent);
      setHiddenWorkspaces(next.hidden);
      setBoardWorkspaceFilter((filter) => (filter === dir ? null : filter));
      setWorkspaceDir((current) =>
        current === dir ? (defaultWorkspace || null) : current,
      );
      const active = conversationsRef.current.find(
        (c) => c.id === activeIdRef.current,
      );
      if (active?.workspaceDir === dir) {
        saveLastActive(null);
        setActiveId(null);
      }
    },
    [defaultWorkspace],
  );

  const onReorderWorkspaces = useCallback((dirs: string[]) => {
    setRecentWorkspaces(reorderRecentWorkspaces(dirs));
  }, []);

  const onFork = useCallback(
    async (c: Conversation, messageKey?: string | null, messageIndex?: number | null) => {
      const store = chatStore.getState();
      if (store.chats[c.id]?.isStreaming) {
        toast.error("Wait for the current run to finish before forking.");
        return;
      }
      try {
        const { conversation, messages } = await api.forkConversation(
          c.id,
          messageKey,
          messageIndex,
        );
        setConversations((cs) => mergeConversation(cs, conversation));

        const liveCopy = store.cloneRendered(c.id, conversation.id, messageKey);
        if (!liveCopy) {
          const cached = await copyCachedMessages(c.id, conversation.id);
          if (cached && cached.length > 0) {
            chatStore.getState().hydrate(conversation.id, cached);
          } else {
            chatStore.getState().reset(conversation.id, messages);
          }
        }

        pendingSelectRef.current = conversation.id;
        setView("chat");
        setActiveId(conversation.id);
        setModelChoice(conversation.model);
        setWorkspaceDir(conversation.workspaceDir);
        setFocusToken((t) => t + 1);
      } catch (e) {
        console.error("forkConversation failed", e);
        toast.error("Couldn't fork that conversation.");
      }
    },
    [chatStore],
  );

  // --- Human-in-the-loop review (request_review tool → "Needs review") ------

  /** Approve a pending-review task → it leaves "Needs review" for "Done". */
  const onApproveReview = useCallback(
    async (id: string) => {
      try {
        const updated = await api.setReviewState(id, "approved");
        applyReviewedRow(updated);
      } catch (e) {
        console.error(e);
      }
    },
    [applyReviewedRow],
  );

  /** "Request changes": open the conversation so the user can type feedback.
   *  The pending flag is cleared when they actually send (see maybeClearReview),
   *  so a card they merely peek at stays in "Needs review". */
  const onRequestChanges = useCallback((c: Conversation) => {
    setDetailId(c.id);
  }, []);

  /** Clear a conversation's review flag once the user sends it a fresh prompt —
   *  giving feedback (or just continuing) means it's no longer waiting on review.
   *  Reads the live conversations list via a ref so it stays cheap on every send. */
  const maybeClearReview = useCallback(
    (id: string) => {
      const c = conversationsRef.current.find((x) => x.id === id);
      if (c && c.reviewState !== "none") {
        api.setReviewState(id, "none").then(applyReviewedRow).catch(() => {});
      }
    },
    [applyReviewedRow],
  );

  // --- Automations --------------------------------------------------------
  function openNewAutomation() {
    setEditingAutomation(null);
    setAutomationDialogOpen(true);
  }
  function openEditAutomation(a: Automation) {
    setEditingAutomation(a);
    setAutomationDialogOpen(true);
  }
  /** Create or update; the dialog awaits this and surfaces any thrown error. */
  async function onSaveAutomation(input: AutomationInput, id: string | null) {
    const saved = id
      ? await api.updateAutomation(id, input)
      : await api.createAutomation(input);
    setAutomations((as) => mergeAutomation(as, saved));
  }
  async function onToggleAutomation(a: Automation, enabled: boolean) {
    // Optimistically flip only `enabled`, preserving any fresher fields a
    // concurrent automation event may have merged into the row.
    setAutomations((as) =>
      as.map((x) => (x.id === a.id ? { ...x, enabled } : x)),
    );
    try {
      const updated = await api.setAutomationEnabled(a.id, enabled);
      setAutomations((as) => mergeAutomation(as, updated));
    } catch (e) {
      console.error(e);
      // Revert just the flag on the current row — don't clobber newer state.
      setAutomations((as) =>
        as.map((x) => (x.id === a.id ? { ...x, enabled: !enabled } : x)),
      );
    }
  }
  async function onRunAutomation(a: Automation) {
    // Run-now mints a fresh conversation and starts streaming it; jump straight
    // into that chat so the click feels direct (like "View last run"), rather
    // than leaving the user parked on the Automations list waiting for the
    // `automation_fired` event to quietly add a row.
    let conv: Conversation;
    try {
      conv = await api.runAutomationNow(a.id);
    } catch (e) {
      console.error(e);
      return;
    }
    setConversations((cs) => mergeConversation(cs, conv));
    setModelChoice(conv.model);
    setWorkspaceDir(conv.workspaceDir);
    // Seed the prompt bubble so onSelect takes the client-side fast path and
    // doesn't block the jump on a get_messages round-trip while pi is mid-run.
    // Skip if streaming already populated the chat (pi echoes the prompt at the
    // head of the turn), to avoid a stray user bubble after assistant output.
    const existing = chatStore.getState().chats[conv.id];
    if (!existing || existing.messages.length === 0) {
      chatStore.getState().userSent(conv.id, a.prompt, [], []);
    }
    setView("chat");
    onSelect(conv.id);
  }
  async function onDeleteAutomation(a: Automation) {
    await api.deleteAutomation(a.id);
    setAutomations((as) => as.filter((x) => x.id !== a.id));
  }

  return (
    <SidebarProvider
      // Pin the shell to the window with `fixed inset-0` rather than a
      // viewport-height calc. CSS `zoom` (use-zoom) re-bases `svh` inside the
      // zoomed root on modern WebKit, so a `100svh/var(--zoom)` height would
      // double-compensate and drift as you ⌘+/⌘− — fixed insets fill the window
      // at any zoom. `!min-h-0` clears shadcn's `min-h-svh` so the sidebar's
      // `h-full` resolves against the window, not content. The shell background
      // also paints the gutter around the content card, so keep it tied to the
      // same sidebar token.
      className="fixed inset-0 !min-h-0 bg-sidebar"
    >
      <DialogHost />
      <ZoomHud />
      <Onboarding />
      {/* DEV-ONLY eval bridge — no-ops unless NEXT_PUBLIC_CETUS_DEVTEST === "1"
          (gated both here and internally). Always-mounted host. */}
      {process.env.NEXT_PUBLIC_CETUS_DEVTEST === "1" && <TestHook />}
      {/* cmdk's internal store has a race on first render with Turbopack +
          React 19: even though Radix Dialog hides DialogContent when closed,
          CommandPalette's CommandInput still ends up reaching for a null
          context (`o.subscribe` crash). Lazy-mount the palette so it's
          rendered only after the user actually opens it. */}
      {paletteOpen && <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        conversations={conversations}
        activeId={activeId}
        modelChoice={modelChoice}
        onSelectConversation={(id) => {
          setView("chat");
          setPaletteOpen(false);
          onSelect(id);
        }}
        onNewChat={() => {
          setPaletteOpen(false);
          if (view === "board") setNewTaskOpen(true);
          else onNew();
        }}
        onModelChange={(m) => {
          setPaletteOpen(false);
          onModelChange(m);
        }}
        onOpenSettings={() => {
          setPaletteOpen(false);
          setSettingsOpen(true);
        }}
        onViewChange={(v) => {
          setPaletteOpen(false);
          setView(v);
        }}
        onOpenScreenHistory={(q, frame) => {
          setPaletteOpen(false);
          setHistoryQuery(q ?? "");
          setHistoryFrame(frame ?? null);
          setHistoryOpen(true);
        }}
      />}
      <SessionDetailDialog
        conversation={conversations.find((c) => c.id === detailId) ?? null}
        open={detailId !== null}
        onOpenChange={(o) => {
          if (!o) setDetailId(null);
        }}
        onOpenInChat={(id) => {
          setDetailId(null);
          setView("chat");
          onSelect(id);
        }}
        loading={detailLoading}
        modelChoice={detailModelChoice}
        onModelChange={onDetailModelChange}
        workspaceDir={detailWorkspaceDir}
        defaultWorkspace={defaultWorkspace}
        onWorkspaceChange={onDetailWorkspaceChange}
        onSend={onDetailSend}
        onAbort={onDetailAbort}
        onForkMessage={(messageKey, messageIndex) => {
          const c = conversationsRef.current.find((x) => x.id === detailId);
          if (c) onFork(c, messageKey, messageIndex);
        }}
        focusToken={detailFocusToken}
        onRetry={onDetailRetry}
        retrying={retrying}
        queued={detailId ? queued[detailId] : undefined}
        onQueue={(text, atts) => {
          if (detailId) enqueueMessage(detailId, text, atts);
        }}
        onSteerQueued={
          detailConvBackend && !backendSupportsSteer(detailConvBackend)
            ? undefined
            : (id) => steerQueuedDetail(id)
        }
        onEditQueued={(id, text) => {
          if (detailId) editQueued(detailId, id, text);
        }}
        onRemoveQueued={(id) => {
          if (detailId) removeQueued(detailId, id);
        }}
        ultra={ultraEnabled}
        onUltraToggle={onUltraToggle}
      />
      <ArtifactsDialog
        convId={activeId}
        title={conversations.find((c) => c.id === activeId)?.title}
        // Gate on chat view + a live artifact set so switching away (or a
        // conversation with no artifacts) can't leave a stale gallery open.
        open={view === "chat" && chatArtifactsOpen && activeHasArtifacts}
        onOpenChange={setChatArtifactsOpen}
      />
      <CreateTaskDialog
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        modelChoice={modelChoice}
        onModelChange={onModelChange}
        workspaceDir={workspaceDir}
        defaultWorkspace={defaultWorkspace}
        onWorkspaceChange={onWorkspaceChange}
        ultra={ultraEnabled}
        onUltraToggle={onUltraToggle}
        pendingBackend={pendingBackend}
        onPendingBackendChange={setPendingBackend}
        pendingCliModel={pendingCliModel}
        pendingCliEffort={pendingCliEffort}
        onPendingTuningChange={onPendingTuningChange}
        onSubmit={onCreateTask}
      />
      <AutomationDialog
        open={automationDialogOpen}
        onOpenChange={setAutomationDialogOpen}
        automation={editingAutomation}
        defaultModel={modelChoice}
        defaultWorkspace={defaultWorkspace}
        onSubmit={onSaveAutomation}
      />
      {settingsEverOpened && (
        <SettingsPage
          open={settingsOpen}
          onClose={closeSettings}
          storedProviders={storedProviders}
          onSaved={onSettingsSaved}
          onConversationsChanged={onSettingsConversationsChanged}
          onOpenHistory={openHistoryFromSettings}
        />
      )}
      <ScreenHistoryPage
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        initialQuery={historyQuery}
        initialFrame={historyFrame}
      />
      <AppSidebar
        conversations={conversations}
        activeId={activeId}
        streamingIds={streamingIds}
        unreadCompletedIds={unreadCompletedIds}
        workspaceDirs={recentWorkspaces}
        hiddenWorkspaceDirs={hiddenWorkspaces}
        defaultWorkspace={defaultWorkspace}
        view={view}
        onViewChange={setView}
        workspaceFilter={boardWorkspaceFilter}
        onWorkspaceFilterChange={setBoardWorkspaceFilter}
        onSelect={onSelectChat}
        onNew={onNewSidebar}
        onRevealWorkspace={onRevealWorkspace}
        onArchiveWorkspaceChats={onArchiveWorkspaceChats}
        onRemoveWorkspace={onRemoveWorkspace}
        onReorderWorkspaces={onReorderWorkspaces}
        onArchive={onArchive}
        onOpenSettings={openSettings}
        updateReadyVersion={updateReadyVersion}
        onRestartToUpdate={onRestartToUpdate}
      />
      {/* Opaque card, no backdrop-filter: the shell root paints solid bg-sidebar,
          so a translucent+blurred card only re-blurred a flat color — at the cost
          of a full-window GPU recomposite on every repaint. */}
      <SidebarInset
        className="m-2 flex min-h-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-background shadow-[inset_0_1px_0_rgb(255_255_255_/_0.45),0_3px_16px_rgb(0_0_0_/_0.045)] dark:shadow-[inset_0_1px_0_rgb(255_255_255_/_0.10),0_4px_18px_rgb(0_0_0_/_0.14)]"
      >
        <div className="flex min-h-0 flex-1 flex-row">
          <div className="flex min-w-0 flex-1 flex-col">
            <header
              className="flex h-10 items-center justify-end gap-3 px-4 text-xs text-muted-foreground"
            >
              <div data-tauri-drag-region className="h-full flex-1" />
              {!piReady && <span className="text-muted-foreground/70">○ connecting…</span>}
              {/* With messages present, the failure surfaces inline at the end of
                the message list (see MessageError). Keep the header copy only as
                a fallback for errors that fire before any message exists
                (e.g. an attachment write failing on the very first send). */}
              {error && !hasMessages && (
                <span className="text-destructive">{error}</span>
              )}
              {view === "chat" && activeHasArtifacts && (
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  title={tt("board", "session.toggleArtifacts")}
                  aria-label={tt("board", "session.toggleArtifacts")}
                  onClick={() => setChatArtifactsOpen((v) => !v)}
                >
                  <Inbox className="size-3.5" />
                </Button>
              )}
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                title={t("workspacePanel.openSide")}
                aria-label={t("workspacePanel.openSide")}
                data-testid="workspace-open-side"
                onClick={() => openWorkspacePanelLayout("side")}
              >
                <PanelRight className="size-3.5" />
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                title={t("workspacePanel.openBottom")}
                aria-label={t("workspacePanel.openBottom")}
                data-testid="workspace-open-bottom"
                onClick={() => openWorkspacePanelLayout("bottom")}
              >
                <PanelBottom className="size-3.5" />
              </Button>
            </header>
            {view === "automations" ? (
              <AutomationsView
                automations={automations}
                defaultWorkspace={defaultWorkspace}
                onNew={openNewAutomation}
                onEdit={openEditAutomation}
                onToggle={onToggleAutomation}
                onRunNow={onRunAutomation}
                onDelete={onDeleteAutomation}
                onOpenConversation={(id) => {
                  setView("chat");
                  onSelect(id);
                }}
              />
            ) : view === "plugins" ? (
              <PluginsView />
            ) : view === "board" ? (
              <BoardView
                conversations={conversations}
                workspaceFilter={boardWorkspaceFilter}
                defaultWorkspace={defaultWorkspace}
                streamingIds={streamingIds}
                onOpen={onOpenDetail}
                onArchive={onArchive}
                onApproveReview={onApproveReview}
                onRequestChanges={onRequestChanges}
              />
            ) : hasMessages ? (
              <ChatPane
                convId={activeId}
                draftKey={activeId ? `chat:${activeId}` : "chat:new"}
                modelChoice={modelChoice}
                onModelChange={onModelChange}
                workspaceDir={workspaceDir}
                defaultWorkspace={defaultWorkspace}
                onWorkspaceChange={onWorkspaceChange}
                onSend={onSend}
                onBash={onBash}
                onAbort={onAbort}
                onRegenerate={retrying ? undefined : onRetry}
                onRetry={onRetry}
                onForkMessage={(messageKey, messageIndex) => {
                  const c = conversationsRef.current.find(
                    (x) => x.id === activeIdRef.current,
                  );
                  if (c) onFork(c, messageKey, messageIndex);
                }}
                retrying={retrying}
                queued={activeId ? queued[activeId] : undefined}
                onQueue={(text, atts) => {
                  if (activeId) enqueueMessage(activeId, text, atts);
                }}
                onSteerQueued={
                  // pi steers via RPC, claude-code over stdin, and codex uses
                  // Codex-app-style interrupt + resume. Hide this only for any
                  // future backend that lacks a running-turn steer path.
                  activeConvBackend && !backendSupportsSteer(activeConvBackend)
                    ? undefined
                    : (id) => {
                        if (activeId) steerQueued(activeId, id);
                      }
                }
                onEditQueued={(id, text) => {
                  if (activeId) editQueued(activeId, id, text);
                }}
                onRemoveQueued={(id) => {
                  if (activeId) removeQueued(activeId, id);
                }}
                ultra={ultraEnabled}
                onUltraToggle={onUltraToggle}
                focusToken={focusToken}
                disabled={!piReady}
                pendingBackend={pendingBackend}
                onPendingBackendChange={setPendingBackend}
                pendingCliModel={pendingCliModel}
                pendingCliEffort={pendingCliEffort}
                onPendingTuningChange={onPendingTuningChange}
                backendSwitch={backendSwitch}
                onRequestBackendSwitch={requestBackendSwitch}
              />
            ) : (
              <div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden px-6">
                <GlyphBackdrop />
                <div className="relative z-10 w-full max-w-2xl space-y-6">
                  <h1 className="text-center font-serif text-4xl italic tracking-tight text-foreground">
                    {heroHeadline}
                  </h1>
                  <Composer
                    variant="hero"
                    focusToken={focusToken}
                    draftKey={activeId ? `chat:${activeId}` : "chat:new"}
                    disabled={!piReady}
                    streaming={isStreaming}
                    modelChoice={modelChoice}
                    onModelChange={onModelChange}
                    conversationId={activeId}
                    workspaceDir={workspaceDir}
                    defaultWorkspace={defaultWorkspace}
                    onWorkspaceChange={onWorkspaceChange}
                    onSend={onSend}
                    onBash={onBash}
                    onAbort={onAbort}
                    ultra={ultraEnabled}
                    onUltraToggle={onUltraToggle}
                    pendingBackend={pendingBackend}
                    onPendingBackendChange={setPendingBackend}
                    pendingCliModel={pendingCliModel}
                    pendingCliEffort={pendingCliEffort}
                    onPendingTuningChange={onPendingTuningChange}
                    backendSwitch={backendSwitch}
                    onRequestBackendSwitch={requestBackendSwitch}
                  />
                </div>
              </div>
            )}
          </div>
          {renderWorkspaceDock("side")}
        </div>
        {renderWorkspaceDock("bottom")}
      </SidebarInset>
    </SidebarProvider>
  );
}
