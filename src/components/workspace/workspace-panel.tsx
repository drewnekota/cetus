"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  Globe,
  Loader2,
  Plus,
  RefreshCw,
  Terminal,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  BrowserView,
  createBrowserViewState,
  type BrowserViewState,
} from "@/components/browser/browser-view";
import { useTranslation } from "@/lib/i18n";
import { api } from "@/lib/tauri";
import type { BashResult, WorkspaceFileEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

export type WorkspaceTabKind = "files" | "terminal" | "browser";
export type WorkspaceLayout = "side" | "bottom";

export interface TerminalRunRequest {
  id: string;
  command: string;
  autoRun?: boolean;
}

export interface TerminalHistoryEntry {
  id: string;
  command: string;
  result: BashResult | null;
  error?: string;
}

export interface TerminalViewState {
  command: string;
  running: boolean;
  history: TerminalHistoryEntry[];
}

export function createTerminalViewState(): TerminalViewState {
  return { command: "", running: false, history: [] };
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
  motionState,
  hidden,
}: Props) {
  const { t } = useTranslation("chat");
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0] ?? null;
  const cwd = workspaceDir || defaultWorkspace;
  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false);
  const newTabMenuCloseTimerRef = useRef<number | null>(null);

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
      className={cn(
        "flex flex-col bg-background/48 shadow-[inset_1px_0_0_rgb(255_255_255_/_0.22)] backdrop-blur-2xl backdrop-saturate-200 dark:bg-background/52 dark:shadow-[inset_1px_0_0_rgb(255_255_255_/_0.08)]",
        hidden && "hidden",
        layout === "side"
          ? "h-full w-1/2 min-w-[min(420px,50%)] max-w-3xl border-l border-border"
          : "h-[32vh] min-h-56 w-full border-t border-border",
        motionState === "open" &&
          (layout === "side"
            ? "animate-in fade-in-0 slide-in-from-right-6 duration-120 ease-out"
            : "animate-in fade-in-0 slide-in-from-bottom-6 duration-120 ease-out"),
        motionState === "closed" &&
          (layout === "side"
            ? "animate-out fade-out-0 slide-out-to-right-4 duration-100 ease-in"
            : "animate-out fade-out-0 slide-out-to-bottom-4 duration-100 ease-in"),
      )}
      data-testid="workspace-panel"
      data-layout={layout}
      data-state={motionState}
    >
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
                    aria-label={t("workspacePanel.closeTab", { title: tab.title })}
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
                  shortcut="⌘J"
                  onSelect={() => createTab("terminal")}
                  data-testid="workspace-new-terminal"
                />
                <NewTabMenuItem
                  icon={<Globe className="size-3.5 text-muted-foreground" />}
                  label={t("workspacePanel.browser")}
                  shortcut="⌘T"
                  onSelect={() => createTab("browser")}
                  data-testid="workspace-new-browser"
                />
                <NewTabMenuItem
                  icon={<Folder className="size-3.5 text-muted-foreground" />}
                  label={t("workspacePanel.files")}
                  shortcut="⌘P"
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
      <div className="min-h-0 flex-1">
        {!active ? (
          <EmptyPanel onNewTab={onNewTab} />
        ) : active.kind === "files" ? (
          <FilesPanel workspaceDir={cwd} />
        ) : active.kind === "terminal" ? (
          <TerminalPanel
            workspaceDir={cwd}
            state={active.terminalState ?? createTerminalViewState()}
            onStateChange={(state) => onUpdateTerminalTab(active.id, state)}
            runRequest={active.terminalRunRequest}
            focusRequest={active.terminalFocusRequest}
          />
        ) : (
          <BrowserView
            key={active.id}
            state={active.browserState ?? createBrowserViewState()}
            onStateChange={(state) => onUpdateBrowserTab(active.id, state)}
            onAnnotate={onAnnotate}
          />
        )}
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
      <Kbd className="h-3.5 px-0.5 text-[9px]">{shortcut}</Kbd>
    </button>
  );
}

function TabIcon({ kind }: { kind: WorkspaceTabKind }) {
  if (kind === "files") return <Folder className="size-3.5" />;
  if (kind === "terminal") return <Terminal className="size-3.5" />;
  return <Globe className="size-3.5" />;
}

function EmptyPanel({ onNewTab }: { onNewTab: (kind: WorkspaceTabKind) => void }) {
  const { t } = useTranslation("chat");
  return (
    <div className="grid h-full place-items-center px-6 text-center">
      <div>
        <div className="mx-auto grid size-12 place-items-center rounded-md border border-border bg-muted/40">
          <Plus className="size-5 text-muted-foreground" />
        </div>
        <div className="mt-4 flex justify-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => onNewTab("files")}>
            <Folder className="size-3.5" />
            {t("workspacePanel.files")}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => onNewTab("terminal")}>
            <Terminal className="size-3.5" />
            {t("workspacePanel.terminal")}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => onNewTab("browser")}>
            <Globe className="size-3.5" />
            {t("workspacePanel.browser")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function FilesPanel({ workspaceDir }: { workspaceDir: string }) {
  const { t } = useTranslation("chat");
  const [files, setFiles] = useState<WorkspaceFileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildWorkspaceTree(files ?? []), [files]);

  async function load() {
    setError(null);
    try {
      const nextFiles = await api.listWorkspaceFiles(workspaceDir);
      setFiles(nextFiles);
      setExpanded(defaultExpandedPaths(nextFiles));
    } catch (e) {
      setFiles([]);
      setError(String(e));
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceDir]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {workspaceDir}
        </p>
        <Button type="button" size="icon-xs" variant="ghost" onClick={load} aria-label={t("workspacePanel.refresh")}>
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
      {error && (
        <p className="m-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {!files ? (
          <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {t("workspacePanel.loading")}
          </div>
        ) : files.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">{t("workspacePanel.noFiles")}</p>
        ) : (
          <FileTree
            nodes={tree}
            expanded={expanded}
            onToggle={(path) =>
              setExpanded((current) => {
                const next = new Set(current);
                if (next.has(path)) next.delete(path);
                else next.add(path);
                return next;
              })
            }
          />
        )}
      </div>
    </div>
  );
}

interface WorkspaceTreeNode {
  entry: WorkspaceFileEntry;
  children: WorkspaceTreeNode[];
}

function buildWorkspaceTree(entries: WorkspaceFileEntry[]): WorkspaceTreeNode[] {
  const roots: WorkspaceTreeNode[] = [];
  const byPath = new Map<string, WorkspaceTreeNode>();

  for (const entry of entries) {
    byPath.set(entry.relativePath, { entry, children: [] });
  }

  for (const node of byPath.values()) {
    const parentPath = parentRelativePath(node.entry.relativePath);
    const parent = parentPath ? byPath.get(parentPath) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  sortTreeNodes(roots);
  return roots;
}

function sortTreeNodes(nodes: WorkspaceTreeNode[]) {
  nodes.sort((a, b) => {
    if (a.entry.isDir !== b.entry.isDir) return a.entry.isDir ? -1 : 1;
    return a.entry.name.localeCompare(b.entry.name, undefined, { sensitivity: "base" });
  });
  for (const node of nodes) sortTreeNodes(node.children);
}

function parentRelativePath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : null;
}

function defaultExpandedPaths(entries: WorkspaceFileEntry[]): Set<string> {
  const expanded = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDir) continue;
    const depth = entry.relativePath.split(/[\\/]/).length - 1;
    if (depth <= 1) expanded.add(entry.relativePath);
  }
  return expanded;
}

function FileTree({
  nodes,
  expanded,
  onToggle,
  depth = 0,
}: {
  nodes: WorkspaceTreeNode[];
  expanded: Set<string>;
  onToggle: (path: string) => void;
  depth?: number;
}) {
  return (
    <div role={depth === 0 ? "tree" : "group"}>
      {nodes.map((node) => (
        <FileTreeNode
          key={node.entry.path}
          node={node}
          depth={depth}
          expanded={expanded}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

function FileTreeNode({
  node,
  depth,
  expanded,
  onToggle,
}: {
  node: WorkspaceTreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
}) {
  const isExpanded = expanded.has(node.entry.relativePath);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <button
        type="button"
        role="treeitem"
        aria-expanded={node.entry.isDir ? isExpanded : undefined}
        className="flex h-7 w-full items-center gap-1.5 pr-3 text-left text-xs hover:bg-muted"
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={() => {
          if (node.entry.isDir) onToggle(node.entry.relativePath);
          else api.openPath(node.entry.path).catch(console.error);
        }}
        onDoubleClick={() => {
          if (node.entry.isDir) api.openPath(node.entry.path).catch(console.error);
        }}
        title={node.entry.path}
      >
        <span className="grid size-4 shrink-0 place-items-center text-muted-foreground">
          {node.entry.isDir && hasChildren ? (
            isExpanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )
          ) : null}
        </span>
        {node.entry.isDir ? (
          isExpanded ? (
            <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="size-3.5 shrink-0 text-muted-foreground" />
          )
        ) : (
          <File className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate">{node.entry.name}</span>
        {!node.entry.isDir && (
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {formatBytes(node.entry.sizeBytes ?? 0)}
          </span>
        )}
      </button>
      {node.entry.isDir && isExpanded && hasChildren && (
        <FileTree nodes={node.children} expanded={expanded} onToggle={onToggle} depth={depth + 1} />
      )}
    </div>
  );
}

function TerminalPanel({
  workspaceDir,
  state,
  onStateChange,
  runRequest,
  focusRequest,
}: {
  workspaceDir: string;
  state: TerminalViewState;
  onStateChange: (state: TerminalViewState) => void;
  runRequest?: TerminalRunRequest;
  focusRequest?: string;
}) {
  const { t } = useTranslation("chat");
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastRunRequestRef = useRef<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  function focusInput() {
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    });
  }

  function updateState(updater: (current: TerminalViewState) => TerminalViewState) {
    const next = updater(stateRef.current);
    stateRef.current = next;
    onStateChange(next);
  }

  async function runCommand(textRaw: string) {
    const text = textRaw.trim();
    if (!text || stateRef.current.running) return;
    const item: TerminalHistoryEntry = {
      id:
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `terminal-history-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      command: text,
      result: null,
    };
    updateState((current) => ({
      ...current,
      command: "",
      running: true,
      history: [...current.history, item],
    }));
    try {
      const result = await api.runBash(text, workspaceDir);
      updateState((current) => ({
        ...current,
        history: current.history.map((x) => (x.id === item.id ? { ...x, result } : x)),
      }));
    } catch (err) {
      updateState((current) => ({
        ...current,
        history: current.history.map((x) =>
          x.id === item.id ? { ...x, error: String(err) } : x,
        ),
      }));
    } finally {
      updateState((current) => ({ ...current, running: false }));
      focusInput();
    }
  }

  async function run(e: FormEvent) {
    e.preventDefault();
    await runCommand(state.command);
  }

  useEffect(() => {
    if (!runRequest || lastRunRequestRef.current === runRequest.id) return;
    lastRunRequestRef.current = runRequest.id;
    updateState((current) => ({ ...current, command: runRequest.command }));
    focusInput();
    if (runRequest.autoRun) void runCommand(runRequest.command);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runRequest?.id]);

  useEffect(() => {
    if (!focusRequest) return;
    focusInput();
  }, [focusRequest]);

  return (
    <div
      className="h-full bg-transparent text-foreground dark:text-[#eeeeee]"
      onMouseDown={(e) => {
        if (e.target !== inputRef.current) focusInput();
      }}
    >
      <div
        ref={scrollRef}
        className="h-full overflow-y-auto px-3 py-2 font-mono text-xs"
      >
        {state.history.length === 0 ? (
          <p className="mb-2 text-muted-foreground dark:text-white/45">
            {t("workspacePanel.noCommands")}
          </p>
        ) : (
          state.history.map((item) => (
            <TerminalHistoryItem key={item.id} item={item} />
          ))
        )}
        <form onSubmit={run} className="flex items-baseline gap-2">
          <span className="shrink-0 text-emerald-700 dark:text-emerald-300">$</span>
          <input
            ref={inputRef}
            value={state.command}
            onChange={(e) =>
              updateState((current) => ({ ...current, command: e.target.value }))
            }
            disabled={state.running}
            className="min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60 dark:text-white dark:placeholder:text-white/35"
            placeholder={t("workspacePanel.commandPlaceholder")}
            spellCheck={false}
          />
        </form>
      </div>
    </div>
  );
}

function TerminalHistoryItem({
  item,
}: {
  item: TerminalHistoryEntry;
}) {
  const { t } = useTranslation("chat");
  const result = item.result;
  return (
    <div className="mb-4">
      <p className="text-emerald-700 dark:text-emerald-300">$ {item.command}</p>
      {!result && !item.error ? (
        <p className="text-muted-foreground dark:text-white/45">
          {t("workspacePanel.running")}
        </p>
      ) : item.error ? (
        <pre className="mt-1 whitespace-pre-wrap text-destructive dark:text-red-300">
          {item.error}
        </pre>
      ) : result ? (
        <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap text-foreground/80 dark:text-white/80">
          {[result.stdout, result.stderr].filter(Boolean).join("\n") || `(exit ${result.exitCode})`}
        </pre>
      ) : null}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
