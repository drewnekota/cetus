"use client";

import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Folder, Globe, Plus, Terminal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  BrowserView,
  createBrowserViewState,
  type BrowserViewState,
} from "@/components/browser/browser-view";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  shortcutDisplay,
  useKeyboardShortcuts,
} from "@/lib/keyboard-shortcuts";
import { TerminalPanel } from "./terminal-panel";
import { FilesPanel } from "./files-panel";

export type WorkspaceTabKind = "files" | "terminal" | "browser";

export type WorkspaceLayout = "side" | "bottom";

export interface TerminalRunRequest {
  id: string;
  command: string;
  autoRun?: boolean;
}

export type TerminalViewState = Record<string, never>;

export function createTerminalViewState(): TerminalViewState {
  return {};
}

export interface WorkspaceTab {
  id: string;
  kind: WorkspaceTabKind;
  title: string;
  terminalFocusRequest?: string;
  terminalRunRequest?: TerminalRunRequest;
  terminalState?: TerminalViewState;
  browserState?: BrowserViewState;
}

/** Matches the panel's `min-h-56` (14rem) floor. */
const BOTTOM_PANEL_MIN_HEIGHT = 224;

const BOTTOM_PANEL_HEIGHT_KEY = "cetus:workspace-bottom-height";

function loadBottomPanelHeight(): number | null {
  if (typeof window === "undefined") return null;
  const raw = Number(window.localStorage.getItem(BOTTOM_PANEL_HEIGHT_KEY));
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
}

function maxBottomPanelHeight(): number {
  return Math.max(
    BOTTOM_PANEL_MIN_HEIGHT,
    Math.round(window.innerHeight * 0.8),
  );
}

interface Props {
  tabs: WorkspaceTab[];
  activeId: string | null;
  workspaceDir: string | null;
  defaultWorkspace: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onClosePanel: () => void;
  onNewTab: (kind: WorkspaceTabKind) => void;
  layout: WorkspaceLayout;
  onUpdateTerminalTab: (id: string, state: TerminalViewState) => void;
  onUpdateBrowserTab: (id: string, state: BrowserViewState) => void;
  onAnnotate: (message: string) => Promise<void>;
  onOpenTerminalCommand?: (command: string) => void;
  motionState?: "open" | "closed";
  hidden?: boolean;
}

export function WorkspacePanel({
  tabs,
  activeId,
  workspaceDir,
  defaultWorkspace,
  onSelect,
  onClose,
  onClosePanel,
  onNewTab,
  layout,
  onUpdateTerminalTab,
  onUpdateBrowserTab,
  onAnnotate,
  onOpenTerminalCommand,
  motionState,
  hidden,
}: Props) {
  const { t } = useTranslation("chat");
  const shortcuts = useKeyboardShortcuts();
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0] ?? null;
  const cwd = workspaceDir || defaultWorkspace;
  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false);
  const newTabMenuCloseTimerRef = useRef<number | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [bottomHeight, setBottomHeight] = useState<number | null>(
    loadBottomPanelHeight,
  );
  const [resizing, setResizing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (motionState !== "open") {
      setExpanded(false);
      return;
    }
    // Give a newly mounted dock a collapsed frame before expanding it.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setExpanded(true));
    });
    return () => cancelAnimationFrame(frame);
  }, [motionState]);
  const resizeDragRef = useRef<{
    pointerId: number;
    panelBottom: number;
    maxHeight: number;
    height: number;
  } | null>(null);

  function onResizeHandlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || !panelRef.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeDragRef.current = {
      pointerId: e.pointerId,
      panelBottom: panelRef.current.getBoundingClientRect().bottom,
      maxHeight: maxBottomPanelHeight(),
      height: panelRef.current.getBoundingClientRect().height,
    };
    setResizing(true);
  }

  function onResizeHandlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = resizeDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const next = Math.min(
      drag.maxHeight,
      Math.max(
        BOTTOM_PANEL_MIN_HEIGHT,
        Math.round(drag.panelBottom - e.clientY),
      ),
    );
    drag.height = next;
    setBottomHeight(next);
  }

  function onResizeHandlePointerEnd(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = resizeDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    resizeDragRef.current = null;
    setResizing(false);
    window.localStorage.setItem(BOTTOM_PANEL_HEIGHT_KEY, String(drag.height));
  }

  function resetBottomHeight() {
    resizeDragRef.current = null;
    setResizing(false);
    setBottomHeight(null);
    window.localStorage.removeItem(BOTTOM_PANEL_HEIGHT_KEY);
  }

  function clearNewTabMenuCloseTimer() {
    if (newTabMenuCloseTimerRef.current == null) return;
    window.clearTimeout(newTabMenuCloseTimerRef.current);
    newTabMenuCloseTimerRef.current = null;
  }

  function openNewTabMenu() {
    clearNewTabMenuCloseTimer();
    setNewTabMenuOpen(true);
  }

  function scheduleCloseNewTabMenu() {
    clearNewTabMenuCloseTimer();
    newTabMenuCloseTimerRef.current = window.setTimeout(() => {
      setNewTabMenuOpen(false);
      newTabMenuCloseTimerRef.current = null;
    }, 120);
  }

  function createTab(kind: WorkspaceTabKind) {
    clearNewTabMenuCloseTimer();
    onNewTab(kind);
    setNewTabMenuOpen(false);
  }

  useEffect(() => () => clearNewTabMenuCloseTimer(), []);

  return (
    <aside
      ref={panelRef}
      style={
        layout === "bottom" && bottomHeight != null
          ? { height: bottomHeight }
          : undefined
      }
      className={cn(
        "flex flex-col bg-background",
        hidden && (layout === "side" ? "invisible" : "hidden"),
        layout === "side"
          ? "workspace-side-panel panel-motion h-full shrink-0 overflow-hidden border-border"
          : "relative h-[32vh] max-h-[80vh] min-h-56 w-full border-t border-border",
        layout === "bottom" &&
          motionState === "open" &&
          "animate-in fade-in-0 slide-in-from-bottom-6 panel-animation",
        layout === "bottom" &&
          motionState === "closed" &&
          "animate-out fade-out-0 slide-out-to-bottom-4 panel-animation",
      )}
      data-testid="workspace-panel"
      data-layout={layout}
      data-expanded={expanded}
      inert={motionState === "closed"}
      data-state={motionState}
    >
      {layout === "bottom" && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("workspacePanel.resize")}
          data-testid="workspace-resize-handle"
          data-resizing={resizing ? "true" : "false"}
          className="group/resize absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize touch-none select-none"
          onPointerDown={onResizeHandlePointerDown}
          onPointerMove={onResizeHandlePointerMove}
          onPointerUp={onResizeHandlePointerEnd}
          onPointerCancel={onResizeHandlePointerEnd}
          onDoubleClick={resetBottomHeight}
        >
          <div
            className={cn(
              "absolute inset-x-0 top-1 h-0.5 transition-colors group-hover/resize:bg-primary/40",
              resizing && "bg-primary/60",
            )}
          />
        </div>
      )}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <div className="min-w-0 overflow-x-auto">
            <div className="flex min-w-max items-center gap-1">
              {tabs.map((tab) => (
                <div
                  key={tab.id}
                  data-testid={`workspace-tab-${tab.kind}`}
                  data-active={tab.id === active?.id ? "true" : "false"}
                  className={cn(
                    "group inline-flex h-7 max-w-36 items-center rounded-md text-xs transition-colors",
                    tab.id === active?.id
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                  )}
                  title={tab.title}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(tab.id)}
                    className="inline-flex min-w-0 flex-1 items-center gap-1.5 px-2"
                  >
                    <TabIcon kind={tab.kind} />
                    <span className="truncate">{tab.title}</span>
                  </button>
                  <button
                    type="button"
                    className="mr-1 grid size-4 shrink-0 place-items-center rounded opacity-60 hover:bg-background hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose(tab.id);
                    }}
                    aria-label={t("workspacePanel.closeTab", {
                      title: tab.title,
                    })}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
          <div
            className="relative shrink-0"
            onPointerEnter={openNewTabMenu}
            onPointerLeave={scheduleCloseNewTabMenu}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget)) {
                setNewTabMenuOpen(false);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setNewTabMenuOpen(false);
            }}
          >
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              title={t("workspacePanel.newTerminal")}
              aria-label={t("workspacePanel.newTerminal")}
              data-testid="workspace-new-tab"
              onFocus={openNewTabMenu}
              onClick={openNewTabMenu}
            >
              <Plus className="size-3.5" />
            </Button>
            {newTabMenuOpen && (
              <div className="absolute top-full left-0 z-50 mt-1 w-36 rounded-md bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 animate-in fade-in-0 zoom-in-95 duration-100">
                <NewTabMenuItem
                  icon={<Terminal className="size-3.5 text-muted-foreground" />}
                  label={t("workspacePanel.terminal")}
                  shortcut={shortcutDisplay(shortcuts.toggleTerminal)}
                  onSelect={() => createTab("terminal")}
                  data-testid="workspace-new-terminal"
                />
                <NewTabMenuItem
                  icon={<Globe className="size-3.5 text-muted-foreground" />}
                  label={t("workspacePanel.browser")}
                  shortcut={shortcutDisplay(shortcuts.openBrowserTab)}
                  onSelect={() => createTab("browser")}
                  data-testid="workspace-new-browser"
                />
                <NewTabMenuItem
                  icon={<Folder className="size-3.5 text-muted-foreground" />}
                  label={t("workspacePanel.files")}
                  shortcut={shortcutDisplay(shortcuts.openFilesTab)}
                  onSelect={() => createTab("files")}
                  data-testid="workspace-new-files"
                />
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            title={t("workspacePanel.hide")}
            aria-label={t("workspacePanel.hide")}
            data-testid="workspace-hide-panel"
            onClick={onClosePanel}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {/* Keep every Terminal tab mounted while this workspace is alive. The
            PTY continues in Rust either way; retaining xterm here also keeps
            its screen/scrollback exact while the user switches tabs. */}
        {tabs
          .filter((tab) => tab.kind === "terminal")
          .map((tab) => {
            const visible = tab.id === active?.id;
            return (
              <div
                key={tab.id}
                className={cn("absolute inset-0", !visible && "hidden")}
              >
                <TerminalPanel
                  sessionId={tab.id}
                  workspaceDir={cwd}
                  visible={visible && !hidden && motionState !== "closed"}
                  runRequest={tab.terminalRunRequest}
                  focusRequest={tab.terminalFocusRequest}
                />
              </div>
            );
          })}
        {!active ? (
          <EmptyPanel onNewTab={onNewTab} />
        ) : active.kind === "files" ? (
          <FilesPanel
            workspaceDir={cwd}
            onOpenTerminalCommand={onOpenTerminalCommand}
          />
        ) : active.kind === "browser" ? (
          <BrowserView
            key={active.id}
            state={active.browserState ?? createBrowserViewState()}
            onStateChange={(state) => onUpdateBrowserTab(active.id, state)}
            onAnnotate={onAnnotate}
            visible={!hidden && motionState !== "closed"}
          />
        ) : null}
      </div>
    </aside>
  );
}

function NewTabMenuItem({
  icon,
  label,
  shortcut,
  onSelect,
  ...props
}: {
  icon: ReactNode;
  label: string;
  shortcut: string;
  onSelect: () => void;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-xs outline-hidden hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
      onClick={onSelect}
      {...props}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Kbd className="h-3.5 px-0.5 text-2xs">{shortcut}</Kbd>
    </button>
  );
}

function TabIcon({ kind }: { kind: WorkspaceTabKind }) {
  if (kind === "files") return <Folder className="size-3.5" />;
  if (kind === "terminal") return <Terminal className="size-3.5" />;
  return <Globe className="size-3.5" />;
}

function EmptyPanel({
  onNewTab,
}: {
  onNewTab: (kind: WorkspaceTabKind) => void;
}) {
  const { t } = useTranslation("chat");
  return (
    <div className="grid h-full place-items-center px-6 text-center">
      <div>
        <div className="mx-auto grid size-12 place-items-center rounded-md border border-border bg-muted/40">
          <Plus className="size-5 text-muted-foreground" />
        </div>
        <div className="mt-4 flex justify-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onNewTab("files")}
          >
            <Folder className="size-3.5" />
            {t("workspacePanel.files")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onNewTab("terminal")}
          >
            <Terminal className="size-3.5" />
            {t("workspacePanel.terminal")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onNewTab("browser")}
          >
            <Globe className="size-3.5" />
            {t("workspacePanel.browser")}
          </Button>
        </div>
      </div>
    </div>
  );
}
