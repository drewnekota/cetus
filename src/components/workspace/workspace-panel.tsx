"use client";

import {
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  Code,
  Copy,
  ExternalLink,
  File,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Globe,
  ImageIcon,
  Link2,
  Loader2,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Table,
  Terminal,
  Trash2,
  Video,
  X,
} from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTermTerminal, type ITheme } from "@xterm/xterm";
import hljs from "highlight.js/lib/common";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  BrowserView,
  createBrowserViewState,
  type BrowserViewState,
} from "@/components/browser/browser-view";
import { formatBytes } from "@/lib/artifact";
import { useTranslation } from "@/lib/i18n";
import { markdownComponents, markdownUrlTransform } from "@/lib/markdown";
import { api } from "@/lib/tauri";
import type { WorkspaceFileEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

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
        "flex flex-col bg-background",
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
      <div className="relative min-h-0 flex-1">
        {/* Keep every Terminal tab mounted while this workspace is alive. The
            PTY continues in Rust either way; retaining xterm here also keeps
            its screen/scrollback exact while the user switches tabs. */}
        {tabs
          .filter((tab) => tab.kind === "terminal")
          .map((tab) => {
            const visible = tab.id === active?.id;
            return (
              <div key={tab.id} className={cn("absolute inset-0", !visible && "hidden")}>
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
          <FilesPanel workspaceDir={cwd} onOpenTerminalCommand={onOpenTerminalCommand} />
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

interface DirectoryState {
  entries: WorkspaceFileEntry[];
  truncated: boolean;
  loading: boolean;
  error: string | null;
}

interface VisibleFileRow {
  entry: WorkspaceFileEntry;
  depth: number;
  parentPath: string;
}

function FilesPanel({
  workspaceDir,
  onOpenTerminalCommand,
}: {
  workspaceDir: string;
  onOpenTerminalCommand?: (command: string) => void;
}) {
  const { t } = useTranslation("chat");
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<WorkspaceFileEntry[] | null>(null);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [isRemote, setIsRemote] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);

  const loadDirectory = useCallback(async (path: string, quiet = false) => {
    if (!quiet) {
      setDirectories((current) => ({
        ...current,
        [path]: {
          entries: current[path]?.entries ?? [],
          truncated: current[path]?.truncated ?? false,
          loading: true,
          error: null,
        },
      }));
    }
    try {
      const listing = await api.listWorkspaceDirectory(workspaceDir, path);
      setIsRemote(listing.isRemote);
      setDirectories((current) => ({
        ...current,
        [path]: {
          entries: listing.entries,
          truncated: listing.truncated,
          loading: false,
          error: null,
        },
      }));
      if (path === workspaceDir) {
        setSelectedPath((current) => current ?? listing.entries.find((entry) => !entry.isDir)?.path ?? listing.entries[0]?.path ?? null);
      }
    } catch (error) {
      setDirectories((current) => ({
        ...current,
        [path]: {
          entries: current[path]?.entries ?? [],
          truncated: current[path]?.truncated ?? false,
          loading: false,
          error: String(error),
        },
      }));
    }
  }, [workspaceDir]);

  useEffect(() => {
    setDirectories({});
    setExpanded(new Set());
    setSelectedPath(null);
    setQuery("");
    setSearchResults(null);
    void loadDirectory(workspaceDir);
  }, [workspaceDir, loadDirectory]);

  const loadedDirectoryPaths = Object.keys(directories);
  const loadedDirectoryKey = loadedDirectoryPaths.sort().join("\n");
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      for (const path of loadedDirectoryPaths) void loadDirectory(path, true);
    }, 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedDirectoryKey, loadDirectory]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchResults(null);
      setSearchTruncated(false);
      setSearching(false);
      return;
    }
    let alive = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      api.searchWorkspaceFiles(workspaceDir, trimmed)
        .then((listing) => {
          if (!alive) return;
          setSearchResults(listing.entries);
          setSearchTruncated(listing.truncated);
          setSearching(false);
        })
        .catch((error) => {
          if (!alive) return;
          setActionError(String(error));
          setSearchResults([]);
          setSearching(false);
        });
    }, 180);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [query, workspaceDir]);

  const visibleRows = useMemo(() => {
    if (searchResults) {
      return searchResults.map((entry) => ({ entry, depth: 0, parentPath: parentFilesystemPath(entry.path) }));
    }
    const rows: VisibleFileRow[] = [];
    const visited = new Set<string>();
    const append = (parentPath: string, depth: number) => {
      if (visited.has(parentPath)) return;
      visited.add(parentPath);
      for (const entry of directories[parentPath]?.entries ?? []) {
        rows.push({ entry, depth, parentPath });
        if (entry.isDir && expanded.has(entry.path)) append(entry.path, depth + 1);
      }
    };
    append(workspaceDir, 0);
    return rows;
  }, [directories, expanded, searchResults, workspaceDir]);

  const selectedRow = visibleRows.find((row) => row.entry.path === selectedPath) ?? null;
  const selected = selectedRow?.entry ?? null;

  const toggleDirectory = useCallback((entry: WorkspaceFileEntry) => {
    if (!entry.isDir) return;
    setSelectedPath(entry.path);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(entry.path)) next.delete(entry.path);
      else {
        next.add(entry.path);
        if (!directories[entry.path]) void loadDirectory(entry.path);
      }
      return next;
    });
  }, [directories, loadDirectory]);

  function refreshLoaded() {
    setActionError(null);
    for (const path of loadedDirectoryPaths.length ? loadedDirectoryPaths : [workspaceDir]) {
      void loadDirectory(path);
    }
  }

  function onTreeKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!visibleRows.length) return;
    const index = Math.max(0, visibleRows.findIndex((row) => row.entry.path === selectedPath));
    const row = visibleRows[index];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setSelectedPath(visibleRows[Math.max(0, Math.min(visibleRows.length - 1, index + delta))].entry.path);
    } else if (event.key === "ArrowRight" && row.entry.isDir) {
      event.preventDefault();
      if (!expanded.has(row.entry.path)) toggleDirectory(row.entry);
      else if (visibleRows[index + 1]?.depth > row.depth) setSelectedPath(visibleRows[index + 1].entry.path);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (row.entry.isDir && expanded.has(row.entry.path)) toggleDirectory(row.entry);
      else if (row.depth > 0) setSelectedPath(row.parentPath);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (row.entry.isDir) toggleDirectory(row.entry);
      else if (!isRemote) void api.openPath(row.entry.path);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setSelectedPath(visibleRows[event.key === "Home" ? 0 : visibleRows.length - 1].entry.path);
    }
  }

  async function createEntry(isDir: boolean) {
    if (isRemote) return;
    const parent = selected?.isDir ? selected.path : selectedRow?.parentPath ?? workspaceDir;
    const name = window.prompt(t(isDir ? "workspacePanel.folderName" : "workspacePanel.fileName"));
    if (!name) return;
    try {
      const path = await api.createWorkspaceEntry(workspaceDir, parent, name, isDir);
      await loadDirectory(parent);
      setSelectedPath(path);
    } catch (error) {
      setActionError(String(error));
    }
  }

  async function renameSelected() {
    if (!selected || isRemote) return;
    const name = window.prompt(t("workspacePanel.newName"), selected.name);
    if (!name || name === selected.name) return;
    try {
      const path = await api.renameWorkspaceEntry(workspaceDir, selected.path, name);
      await loadDirectory(selectedRow?.parentPath ?? workspaceDir);
      setSelectedPath(path);
    } catch (error) {
      setActionError(String(error));
    }
  }

  async function trashSelected() {
    if (!selected || isRemote || !window.confirm(t("workspacePanel.confirmTrash", { name: selected.name }))) return;
    try {
      await api.trashWorkspaceEntry(workspaceDir, selected.path);
      await loadDirectory(selectedRow?.parentPath ?? workspaceDir);
      setSelectedPath(null);
    } catch (error) {
      setActionError(String(error));
    }
  }

  const rootState = directories[workspaceDir];
  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_auto_auto_minmax(0,1fr)] overflow-hidden">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{workspaceDir}</p>
        {isRemote && <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">SSH</span>}
        <Button type="button" size="icon-xs" variant="ghost" onClick={refreshLoaded} aria-label={t("workspacePanel.refresh")}>
          <RefreshCw className={cn("size-3.5", rootState?.loading && "animate-spin")} />
        </Button>
      </div>
      <div className="flex h-9 items-center gap-1 border-b border-border px-2">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("workspacePanel.searchFiles")}
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          aria-label={t("workspacePanel.searchFiles")}
        />
        {searching && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="icon-xs" variant="ghost" aria-label={t("workspacePanel.fileActions")}><MoreHorizontal className="size-3.5" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={() => void createEntry(false)} disabled={isRemote}><FilePlus />{t("workspacePanel.newFile")}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void createEntry(true)} disabled={isRemote}><FolderPlus />{t("workspacePanel.newFolder")}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!selected || selected.isDir}
              onSelect={() => selected && window.dispatchEvent(new CustomEvent("cetus-insert-file-paths", { detail: [selected.path] }))}
            ><Paperclip />{t("workspacePanel.addToChat")}</DropdownMenuItem>
            <DropdownMenuItem disabled={!selected} onSelect={() => selected && void navigator.clipboard.writeText(selected.relativePath)}><Copy />{t("workspacePanel.copyRelativePath")}</DropdownMenuItem>
            <DropdownMenuItem disabled={!selected} onSelect={() => selected && void navigator.clipboard.writeText(selected.path)}><Copy />{t("workspacePanel.copyAbsolutePath")}</DropdownMenuItem>
            <DropdownMenuItem disabled={!selected || isRemote} onSelect={() => selected && void api.revealInFinder(selected.path)}><ExternalLink />{t("workspacePanel.revealFinder")}</DropdownMenuItem>
            <DropdownMenuItem
              disabled={!selected || !onOpenTerminalCommand}
              onSelect={() => selected && onOpenTerminalCommand?.(`cd '${(selected.isDir ? selected.path : selectedRow?.parentPath ?? workspaceDir).replaceAll("'", "'\\''")}'`)}
            ><Terminal />{t("workspacePanel.openTerminal")}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!selected || isRemote} onSelect={() => void renameSelected()}><Pencil />{t("workspacePanel.rename")}</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" disabled={!selected || isRemote} onSelect={() => void trashSelected()}><Trash2 />{t("workspacePanel.moveTrash")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className={cn(actionError ? "border-b border-destructive/20 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive" : "h-0")}>
        {actionError}
      </div>
      <div className="grid min-h-0 grid-cols-[minmax(210px,36%)_1fr] overflow-hidden">
        <div className="min-h-0 min-w-0 overflow-y-auto border-r border-border py-1" role="tree" tabIndex={0} onKeyDown={onTreeKeyDown}>
          {!rootState && !searchResults ? (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{t("workspacePanel.loading")}</div>
          ) : rootState?.error && !rootState.entries.length ? (
            <p className="px-3 py-3 text-xs text-destructive">{rootState.error}</p>
          ) : !visibleRows.length ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">{query ? t("workspacePanel.noMatches") : t("workspacePanel.noFiles")}</p>
          ) : (
            visibleRows.map((row) => (
              <FileTreeRow
                key={row.entry.path}
                row={row}
                selected={row.entry.path === selectedPath}
                expanded={expanded.has(row.entry.path)}
                state={directories[row.entry.path]}
                onSelect={() => setSelectedPath(row.entry.path)}
                onToggle={() => toggleDirectory(row.entry)}
                isRemote={isRemote}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setSelectedPath(row.entry.path);
                  setContextMenu({ x: event.clientX, y: event.clientY });
                }}
              />
            ))
          )}
          {(searchResults ? searchTruncated : rootState?.truncated) && (
            <p className="px-3 py-2 text-[10px] text-amber-600 dark:text-amber-400">{t("workspacePanel.moreFiles")}</p>
          )}
        </div>
        <FilePreview file={selected?.isDir ? null : selected} workspaceDir={workspaceDir} isRemote={isRemote} />
      </div>
      {contextMenu && selected && (
        <div
          role="menu"
          className="fixed z-100 min-w-44 rounded-md bg-popover p-1 text-xs text-popover-foreground shadow-lg ring-1 ring-foreground/10"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {!selected.isDir && (
            <button className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-accent" onClick={() => { window.dispatchEvent(new CustomEvent("cetus-insert-file-paths", { detail: [selected.path] })); setContextMenu(null); }}><Paperclip className="size-3.5" />{t("workspacePanel.addToChat")}</button>
          )}
          <button className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-accent" onClick={() => { void navigator.clipboard.writeText(selected.relativePath); setContextMenu(null); }}><Copy className="size-3.5" />{t("workspacePanel.copyRelativePath")}</button>
          {!isRemote && <button className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-accent" onClick={() => { void api.revealInFinder(selected.path); setContextMenu(null); }}><ExternalLink className="size-3.5" />{t("workspacePanel.revealFinder")}</button>}
          {!isRemote && <div className="my-1 h-px bg-border" />}
          {!isRemote && <button className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-accent" onClick={() => { setContextMenu(null); void renameSelected(); }}><Pencil className="size-3.5" />{t("workspacePanel.rename")}</button>}
          {!isRemote && <button className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-destructive hover:bg-destructive/10" onClick={() => { setContextMenu(null); void trashSelected(); }}><Trash2 className="size-3.5" />{t("workspacePanel.moveTrash")}</button>}
        </div>
      )}
    </div>
  );
}

function parentFilesystemPath(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (slash <= 0) return path;
  return path.slice(0, slash);
}

function FileTreeRow({
  row,
  selected,
  expanded,
  state,
  onSelect,
  onToggle,
  isRemote,
  onContextMenu,
}: {
  row: VisibleFileRow;
  selected: boolean;
  expanded: boolean;
  state?: DirectoryState;
  onSelect: () => void;
  onToggle: () => void;
  isRemote: boolean;
  onContextMenu: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const { t } = useTranslation("chat");
  const { entry, depth } = row;
  return (
    <div>
      <button
        type="button"
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={entry.isDir ? expanded : undefined}
        data-selected={selected ? "true" : "false"}
        className={cn(
          "flex h-7 w-full items-center gap-1.5 pr-2 text-left text-xs hover:bg-muted data-[selected=true]:bg-muted data-[selected=true]:text-foreground",
          entry.isIgnored && "text-muted-foreground/50",
        )}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={() => { onSelect(); if (entry.isDir) onToggle(); }}
        onDoubleClick={() => { if (!entry.isDir && !isRemote) void api.openPath(entry.path); }}
        onContextMenu={onContextMenu}
        title={`${entry.path}${entry.symlinkTarget ? ` → ${entry.symlinkTarget}` : ""}`}
      >
        <span className="grid size-4 shrink-0 place-items-center text-muted-foreground">
          {entry.isDir ? state?.loading ? <Loader2 className="size-3 animate-spin" /> : expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" /> : null}
        </span>
        {entry.isDir ? expanded ? <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" /> : <Folder className="size-3.5 shrink-0 text-muted-foreground" /> : <File className="size-3.5 shrink-0 text-muted-foreground" />}
        {entry.isSymlink && <Link2 className="-ml-2 mt-2 size-2.5 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {entry.gitStatus && entry.gitStatus !== "ignored" && <GitStatusBadge status={entry.gitStatus} />}
        {!entry.isDir && entry.sizeBytes != null && <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">{formatBytes(entry.sizeBytes)}</span>}
      </button>
      {expanded && state?.error && (
        <p className="py-1 pr-2 text-[10px] text-destructive" style={{ paddingLeft: `${36 + (depth + 1) * 14}px` }}>{state.error}</p>
      )}
      {expanded && state?.truncated && (
        <p className="py-1 pr-2 text-[10px] text-amber-600 dark:text-amber-400" style={{ paddingLeft: `${36 + (depth + 1) * 14}px` }}>{t("workspacePanel.firstEntries")}</p>
      )}
    </div>
  );
}

function GitStatusBadge({ status }: { status: NonNullable<WorkspaceFileEntry["gitStatus"]> }) {
  const labels: Record<string, string> = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U", conflict: "!" };
  return <span className={cn("w-3 shrink-0 text-center text-[10px] font-semibold", status === "conflict" || status === "deleted" ? "text-red-500" : status === "untracked" || status === "added" ? "text-emerald-500" : "text-amber-500")}>{labels[status] ?? ""}</span>;
}

function FilePreview({
  file,
  workspaceDir,
  isRemote,
}: {
  file: WorkspaceFileEntry | null;
  workspaceDir: string;
  isRemote: boolean;
}) {
  const { t } = useTranslation("chat");
  const [text, setText] = useState<string | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const [textTruncated, setTextTruncated] = useState<number | null>(null);
  const [modeByPath, setModeByPath] = useState<Record<string, "preview" | "source">>({});
  const ext = file ? fileExtension(file.name) : "";
  const kind = file ? previewKind(file.name) : "empty";
  const assetUrl = file && !isRemote ? convertFileSrc(file.path) : "";
  const hasSourceMode = file ? canToggleSource(kind, ext) : false;
  const mode = file && hasSourceMode ? (modeByPath[file.path] ?? "preview") : "preview";

  useEffect(() => {
    let alive = true;
    setText(null);
    setTextError(null);
    setTextTruncated(null);
    if (!file || !needsText(kind, mode, ext)) return;
    api
      .readWorkspaceTextFile(workspaceDir, file.path)
      .then((value) => {
        if (alive) {
          setText(value.text);
          setTextTruncated(value.truncated ? value.totalBytes : null);
        }
      })
      .catch((err) => {
        if (alive) setTextError(String(err));
      });
    return () => {
      alive = false;
    };
  }, [file?.path, kind, mode, ext, workspaceDir]);

  if (!file) {
    return (
      <div className="grid h-full place-items-center px-6 text-center text-xs text-muted-foreground">
        Select a file to preview
      </div>
    );
  }

  return (
    <section className="grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <FilePreviewIcon kind={kind} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium" title={file.path}>
            {file.name}
          </p>
          <p className="truncate font-mono text-[10px] text-muted-foreground">
            {file.relativePath}
          </p>
        </div>
        {hasSourceMode && (
          <div className="flex h-6 shrink-0 items-center rounded-md border border-border bg-background p-0.5">
            <button
              type="button"
              data-active={mode === "preview" ? "true" : "false"}
              className="h-5 rounded-sm px-1.5 text-[10px] text-muted-foreground data-[active=true]:bg-muted data-[active=true]:text-foreground"
              onClick={() =>
                setModeByPath((current) => ({ ...current, [file.path]: "preview" }))
              }
            >
              Preview
            </button>
            <button
              type="button"
              data-active={mode === "source" ? "true" : "false"}
              className="h-5 rounded-sm px-1.5 text-[10px] text-muted-foreground data-[active=true]:bg-muted data-[active=true]:text-foreground"
              onClick={() =>
                setModeByPath((current) => ({ ...current, [file.path]: "source" }))
              }
            >
              Source
            </button>
          </div>
        )}
        {textTruncated != null && (
          <span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] text-amber-700 dark:text-amber-300">
            {t("workspacePanel.previewTruncated", { size: formatBytes(textTruncated) })}
          </span>
        )}
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          disabled={isRemote}
          onClick={() => api.openPath(file.path).catch(console.error)}
          title={t("artifact.openExternal")}
          aria-label={t("artifact.openExternal")}
        >
          <ExternalLink className="size-3.5" />
        </Button>
      </div>
      <div className={cn("min-h-0", (mode === "source" || kind === "text") ? "overflow-hidden" : "overflow-auto")}>
        {isRemote && !needsText(kind, mode, ext) ? (
          <FileDetails file={file} ext={ext} kind={kind} />
        ) : mode === "source" ? (
          <TextPreview text={text} error={textError}>
            {(value) => <SourcePreview text={value} ext={ext} />}
          </TextPreview>
        ) : kind === "image" ? (
          <div className="grid min-h-full place-items-center bg-muted/20 p-4">
            <img src={assetUrl} alt={file.name} className="max-h-full max-w-full object-contain" />
          </div>
        ) : kind === "video" ? (
          <div className="grid min-h-full place-items-center bg-black p-4">
            <video src={assetUrl} controls className="max-h-full max-w-full" />
          </div>
        ) : kind === "audio" ? (
          <div className="grid min-h-full place-items-center p-6">
            <audio src={assetUrl} controls className="w-full max-w-xl" />
          </div>
        ) : kind === "html" || kind === "pdf" ? (
          <iframe
            title={file.name}
            src={assetUrl}
            sandbox={kind === "html" ? "" : undefined}
            className="h-full min-h-[480px] w-full"
          />
        ) : kind === "markdown" ? (
          <TextPreview text={text} error={textError}>
            {(value) => (
              <div className="prose prose-sm dark:prose-invert max-w-none px-5 py-4 prose-pre:bg-secondary prose-pre:text-foreground">
                <ReactMarkdown
                  remarkPlugins={[[remarkGfm, { singleTilde: false }], remarkCjkFriendly]}
                  components={markdownComponents}
                  urlTransform={markdownUrlTransform}
                >
                  {value}
                </ReactMarkdown>
              </div>
            )}
          </TextPreview>
        ) : kind === "csv" ? (
          <TextPreview text={text} error={textError}>
            {(value) => <CsvPreview text={value} />}
          </TextPreview>
        ) : kind === "text" ? (
          <TextPreview text={text} error={textError}>
            {(value) => <SourcePreview text={value} ext={ext} />}
          </TextPreview>
        ) : kind === "office" && canPreviewOffice(ext) ? (
          <OfficePreview file={file} assetUrl={assetUrl} ext={ext} />
        ) : (
          <FileDetails file={file} ext={ext} kind={kind} />
        )}
      </div>
    </section>
  );
}

function SourcePreview({ text, ext }: { text: string; ext: string }) {
  const html = useMemo(() => highlightSource(text, ext), [text, ext]);
  return (
    <div
      className={cn(
        "h-full min-h-0 overflow-auto bg-white text-[#24292f] dark:bg-[#0d1117] dark:text-[#c9d1d9]",
        "[&_.hljs-comment]:text-[#6e7781] dark:[&_.hljs-comment]:text-[#8b949e]",
        "[&_.hljs-quote]:text-[#6e7781] dark:[&_.hljs-quote]:text-[#8b949e]",
        "[&_.hljs-keyword]:text-[#cf222e] dark:[&_.hljs-keyword]:text-[#ff7b72]",
        "[&_.hljs-selector-tag]:text-[#cf222e] dark:[&_.hljs-selector-tag]:text-[#ff7b72]",
        "[&_.hljs-subst]:text-[#24292f] dark:[&_.hljs-subst]:text-[#c9d1d9]",
        "[&_.hljs-number]:text-[#0550ae] dark:[&_.hljs-number]:text-[#79c0ff]",
        "[&_.hljs-literal]:text-[#0550ae] dark:[&_.hljs-literal]:text-[#79c0ff]",
        "[&_.hljs-variable]:text-[#953800] dark:[&_.hljs-variable]:text-[#ffa657]",
        "[&_.hljs-template-variable]:text-[#953800] dark:[&_.hljs-template-variable]:text-[#ffa657]",
        "[&_.hljs-string]:text-[#0a3069] dark:[&_.hljs-string]:text-[#a5d6ff]",
        "[&_.hljs-doctag]:text-[#0a3069] dark:[&_.hljs-doctag]:text-[#a5d6ff]",
        "[&_.hljs-title]:text-[#8250df] dark:[&_.hljs-title]:text-[#d2a8ff]",
        "[&_.hljs-section]:text-[#8250df] dark:[&_.hljs-section]:text-[#d2a8ff]",
        "[&_.hljs-selector-id]:text-[#8250df] dark:[&_.hljs-selector-id]:text-[#d2a8ff]",
        "[&_.hljs-type]:text-[#953800] dark:[&_.hljs-type]:text-[#ffa657]",
        "[&_.hljs-class_.hljs-title]:text-[#953800] dark:[&_.hljs-class_.hljs-title]:text-[#ffa657]",
        "[&_.hljs-tag]:text-[#116329] dark:[&_.hljs-tag]:text-[#7ee787]",
        "[&_.hljs-name]:text-[#116329] dark:[&_.hljs-name]:text-[#7ee787]",
        "[&_.hljs-attribute]:text-[#0550ae] dark:[&_.hljs-attribute]:text-[#79c0ff]",
        "[&_.hljs-regexp]:text-[#0a3069] dark:[&_.hljs-regexp]:text-[#a5d6ff]",
        "[&_.hljs-symbol]:text-[#0a3069] dark:[&_.hljs-symbol]:text-[#a5d6ff]",
        "[&_.hljs-bullet]:text-[#0a3069] dark:[&_.hljs-bullet]:text-[#a5d6ff]",
        "[&_.hljs-built_in]:text-[#953800] dark:[&_.hljs-built_in]:text-[#ffa657]",
        "[&_.hljs-builtin-name]:text-[#953800] dark:[&_.hljs-builtin-name]:text-[#ffa657]",
        "[&_.hljs-meta]:text-[#6e7781] dark:[&_.hljs-meta]:text-[#8b949e]",
        "[&_.hljs-deletion]:bg-[#ffebe9] [&_.hljs-deletion]:text-[#82071e] dark:[&_.hljs-deletion]:bg-[#490202] dark:[&_.hljs-deletion]:text-[#ffdcd7]",
        "[&_.hljs-addition]:bg-[#dafbe1] [&_.hljs-addition]:text-[#116329] dark:[&_.hljs-addition]:bg-[#033a16] dark:[&_.hljs-addition]:text-[#aff5b4]",
        "[&_.hljs-emphasis]:italic [&_.hljs-strong]:font-semibold",
      )}
    >
      <pre className="min-h-full w-max min-w-full px-4 py-3 font-mono text-xs leading-relaxed">
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

function TextPreview({
  text,
  error,
  children,
}: {
  text: string | null;
  error: string | null;
  children: (text: string) => ReactNode;
}) {
  const { t } = useTranslation("chat");
  if (error) {
    return <div className="px-5 py-4 text-xs text-destructive">{t("artifact.readFailed", { error })}</div>;
  }
  if (text == null) {
    return (
      <div className="flex items-center gap-2 px-5 py-4 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        {t("artifact.loading")}
      </div>
    );
  }
  return <div className="h-full min-h-0 overflow-hidden">{children(text)}</div>;
}

function CsvPreview({ text }: { text: string }) {
  const rows = parseCsvPreview(text).slice(0, 80);
  return (
    <div className="p-4">
      <div className="overflow-auto rounded-md border border-border">
        <table className="w-full border-collapse text-xs">
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className={rowIndex === 0 ? "bg-muted/70 font-medium" : undefined}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="max-w-64 border-b border-r border-border px-2 py-1 align-top">
                    <span className="line-clamp-3 break-words">{cell}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function OfficePreview({
  file,
  assetUrl,
  ext,
}: {
  file: WorkspaceFileEntry;
  assetUrl: string;
  ext: string;
}) {
  const { t } = useTranslation("chat");
  const [docHtml, setDocHtml] = useState<string | null>(null);
  const [sheetRows, setSheetRows] = useState<string[][] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDocHtml(null);
    setSheetRows(null);
    setError(null);
    fetch(assetUrl)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then(async (buffer) => {
        if (isWordExt(ext)) {
          // mammoth/xlsx are ~2MB combined; load them only when an Office file is previewed.
          const { default: mammoth } = await import("mammoth");
          const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
          if (alive) setDocHtml(result.value);
          return;
        }
        const XLSX = await import("xlsx");
        const workbook = XLSX.read(buffer, { type: "array" });
        const firstSheetName = workbook.SheetNames[0];
        const firstSheet = firstSheetName ? workbook.Sheets[firstSheetName] : null;
        const rows = firstSheet
          ? (XLSX.utils.sheet_to_json(firstSheet, {
              header: 1,
              blankrows: false,
              defval: "",
            }) as unknown[][])
          : [];
        if (alive) setSheetRows(rows.slice(0, 120).map((row) => row.slice(0, 32).map(String)));
      })
      .catch((err) => {
        if (alive) setError(String(err));
      });
    return () => {
      alive = false;
    };
  }, [assetUrl, ext]);

  if (error) {
    return (
      <div className="p-5">
        <p className="mb-4 text-xs text-destructive">{t("artifact.readFailed", { error })}</p>
        <FileDetails file={file} ext={ext} kind="office" />
      </div>
    );
  }

  if (isWordExt(ext)) {
    if (docHtml == null) return <OfficeLoading />;
    return (
      <iframe
        title={file.name}
        sandbox=""
        className="h-full min-h-[520px] w-full bg-white"
        srcDoc={`<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.5;padding:24px;color:#1f2328}img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid #d0d7de;padding:4px 6px}</style></head><body>${docHtml}</body></html>`}
      />
    );
  }

  if (sheetRows == null) return <OfficeLoading />;
  return <SheetPreview rows={sheetRows} />;
}

function OfficeLoading() {
  const { t } = useTranslation("chat");
  return (
    <div className="flex items-center gap-2 px-5 py-4 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" />
      {t("artifact.loading")}
    </div>
  );
}

function SheetPreview({ rows }: { rows: string[][] }) {
  if (rows.length === 0) {
    return <p className="px-5 py-4 text-xs text-muted-foreground">No rows</p>;
  }
  return (
    <div className="p-4">
      <div className="overflow-auto rounded-md border border-border">
        <table className="w-full border-collapse text-xs">
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className={rowIndex === 0 ? "bg-muted/70 font-medium" : undefined}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="max-w-64 border-b border-r border-border px-2 py-1 align-top">
                    <span className="line-clamp-4 break-words">{cell}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FileDetails({
  file,
  ext,
  kind,
}: {
  file: WorkspaceFileEntry;
  ext: string;
  kind: PreviewKind;
}) {
  return (
    <div className="p-5">
      <div className="max-w-xl rounded-md border border-border p-4">
        <div className="mb-4 flex items-center gap-3">
          <FilePreviewIcon kind={kind} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{file.name}</p>
            <p className="text-xs text-muted-foreground">
              {ext ? ext.toUpperCase() : "File"}
            </p>
          </div>
        </div>
        <dl className="grid grid-cols-[84px_1fr] gap-x-3 gap-y-2 text-xs">
          <dt className="text-muted-foreground">Path</dt>
          <dd className="break-all font-mono">{file.path}</dd>
          <dt className="text-muted-foreground">Size</dt>
          <dd>{formatBytes(file.sizeBytes ?? 0)}</dd>
          <dt className="text-muted-foreground">Modified</dt>
          <dd>{file.modifiedMs ? new Date(file.modifiedMs).toLocaleString() : "-"}</dd>
          {file.symlinkTarget && (
            <>
              <dt className="text-muted-foreground">Link target</dt>
              <dd className="break-all font-mono">{file.symlinkTarget}</dd>
            </>
          )}
          {file.gitStatus && (
            <>
              <dt className="text-muted-foreground">Git status</dt>
              <dd className="capitalize">{file.gitStatus}</dd>
            </>
          )}
        </dl>
      </div>
    </div>
  );
}

type PreviewKind =
  | "empty"
  | "image"
  | "video"
  | "audio"
  | "html"
  | "pdf"
  | "markdown"
  | "csv"
  | "text"
  | "office"
  | "binary";

function FilePreviewIcon({ kind }: { kind: PreviewKind }) {
  if (kind === "image") return <ImageIcon className="size-4 shrink-0 text-muted-foreground" />;
  if (kind === "video" || kind === "audio") return <Video className="size-4 shrink-0 text-muted-foreground" />;
  if (kind === "csv" || kind === "office") return <Table className="size-4 shrink-0 text-muted-foreground" />;
  if (kind === "html" || kind === "text") return <Code className="size-4 shrink-0 text-muted-foreground" />;
  return <FileText className="size-4 shrink-0 text-muted-foreground" />;
}

function previewKind(name: string): PreviewKind {
  const ext = fileExtension(name);
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg"].includes(ext)) return "image";
  if (["mp4", "webm", "mov", "m4v", "ogv"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "m4a", "flac"].includes(ext)) return "audio";
  if (["html", "htm"].includes(ext)) return "html";
  if (ext === "pdf") return "pdf";
  if (["md", "markdown", "mdx"].includes(ext)) return "markdown";
  if (["csv", "tsv"].includes(ext)) return "csv";
  if (["doc", "docx", "xls", "xlsx", "ppt", "pptx", "numbers", "pages", "key"].includes(ext)) return "office";
  if (
    [
      "txt",
      "json",
      "jsonl",
      "js",
      "jsx",
      "ts",
      "tsx",
      "css",
      "scss",
      "xml",
      "yml",
      "yaml",
      "toml",
      "rs",
      "py",
      "go",
      "java",
      "c",
      "cc",
      "cpp",
      "h",
      "hpp",
      "sh",
      "zsh",
      "bash",
      "sql",
      "log",
    ].includes(ext)
  ) {
    return "text";
  }
  return "binary";
}

function canToggleSource(kind: PreviewKind, ext: string): boolean {
  return kind === "markdown" || kind === "html" || ext === "svg";
}

function needsText(kind: PreviewKind, mode: "preview" | "source", ext: string): boolean {
  return kind === "markdown" || kind === "text" || kind === "csv" || (mode === "source" && canToggleSource(kind, ext));
}

function fileExtension(name: string): string {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1).toLowerCase() : "";
}

function highlightSource(text: string, ext: string): string {
  const language = languageForExtension(ext);
  try {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(text, { language, ignoreIllegals: true }).value;
    }
    return hljs.highlightAuto(text).value;
  } catch {
    return escapeHtml(text);
  }
}

function languageForExtension(ext: string): string | null {
  const languages: Record<string, string> = {
    bash: "bash",
    c: "c",
    cc: "cpp",
    cpp: "cpp",
    css: "css",
    go: "go",
    h: "cpp",
    hpp: "cpp",
    html: "xml",
    htm: "xml",
    java: "java",
    js: "javascript",
    json: "json",
    jsx: "javascript",
    log: "plaintext",
    md: "markdown",
    markdown: "markdown",
    mdx: "markdown",
    py: "python",
    rs: "rust",
    scss: "scss",
    sh: "bash",
    sql: "sql",
    svg: "xml",
    ts: "typescript",
    tsx: "typescript",
    toml: "ini",
    txt: "plaintext",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    zsh: "bash",
  };
  return languages[ext] ?? null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function canPreviewOffice(ext: string): boolean {
  return isWordExt(ext) || isSpreadsheetExt(ext);
}

function isWordExt(ext: string): boolean {
  return ext === "docx";
}

function isSpreadsheetExt(ext: string): boolean {
  return ext === "xlsx" || ext === "xls";
}

function parseCsvPreview(text: string): string[][] {
  const delimiter = text.includes("\t") ? "\t" : ",";
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => line.split(delimiter).slice(0, 24));
}

function TerminalPanel({
  sessionId,
  workspaceDir,
  visible,
  runRequest,
  focusRequest,
}: {
  sessionId: string;
  workspaceDir: string;
  visible: boolean;
  runRequest?: TerminalRunRequest;
  focusRequest?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTermTerminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const readyRef = useRef<Promise<void>>(Promise.resolve());
  const lastRunRequestRef = useRef<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new XTermTerminal({
      allowProposedApi: false,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 10_000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fit;

    let cancelled = false;
    let unlistenOutput: UnlistenFn | undefined;
    let unlistenExit: UnlistenFn | undefined;

    const ready = (async () => {
      [unlistenOutput, unlistenExit] = await Promise.all([
        listen<TerminalOutputEvent>("terminal-output", (event) => {
          if (event.payload.sessionId !== sessionId) return;
          terminal.write(base64ToBytes(event.payload.dataBase64));
        }),
        listen<TerminalExitEvent>("terminal-exit", (event) => {
          if (event.payload.sessionId !== sessionId) return;
          const { exitCode, signal } = event.payload;
          terminal.writeln(
            `\r\n\x1b[90m[process exited${signal ? `: ${signal}` : ` with code ${exitCode}`}]\x1b[0m`,
          );
        }),
      ]);
      if (cancelled) {
        unlistenOutput();
        unlistenExit();
        return;
      }
      if (host.offsetWidth && host.offsetHeight) fit.fit();
      await api.terminalStart(sessionId, workspaceDir, terminal.cols, terminal.rows);
    })().catch((error) => {
      if (!cancelled) {
        terminal.writeln(`\r\n\x1b[31mFailed to start terminal: ${String(error)}\x1b[0m`);
      }
    });
    readyRef.current = ready;

    const inputDisposable = terminal.onData((data) => {
      void api
        .terminalWrite(sessionId, bytesToBase64(new TextEncoder().encode(data)))
        .catch(() => {});
    });
    const binaryDisposable = terminal.onBinary((data) => {
      const bytes = Uint8Array.from(data, (char) => char.charCodeAt(0));
      void api.terminalWrite(sessionId, bytesToBase64(bytes)).catch(() => {});
    });
    const resizeObserver = new ResizeObserver(() => {
      if (!host.offsetWidth || !host.offsetHeight) return;
      fit.fit();
      void ready
        .then(() => api.terminalResize(sessionId, terminal.cols, terminal.rows))
        .catch(() => {});
    });
    resizeObserver.observe(host);

    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = terminalTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      themeObserver.disconnect();
      inputDisposable.dispose();
      binaryDisposable.dispose();
      unlistenOutput?.();
      unlistenExit?.();
      terminalRef.current = null;
      fitRef.current = null;
      terminal.dispose();
      void api.terminalStop(sessionId).catch(() => {});
    };
  }, [sessionId, workspaceDir]);

  useEffect(() => {
    if (!visible) return;
    window.requestAnimationFrame(() => {
      fitRef.current?.fit();
      const terminal = terminalRef.current;
      if (terminal) {
        void readyRef.current
          .then(() => api.terminalResize(sessionId, terminal.cols, terminal.rows))
          .catch(() => {});
        terminal.focus();
      }
    });
  }, [visible, focusRequest, sessionId]);

  useEffect(() => {
    if (!runRequest || lastRunRequestRef.current === runRequest.id) return;
    lastRunRequestRef.current = runRequest.id;
    if (!runRequest.autoRun) return;
    void readyRef.current
      .then(() =>
        api.terminalWrite(
          sessionId,
          bytesToBase64(new TextEncoder().encode(`${runRequest.command}\r`)),
        ),
      )
      .catch(() => {});
  }, [runRequest, sessionId]);

  return (
    <div
      ref={hostRef}
      className="h-full w-full bg-[#fcfcfd] px-2 py-1 dark:bg-[#0f0f11]"
      onClick={() => terminalRef.current?.focus()}
    />
  );
}

interface TerminalOutputEvent {
  sessionId: string;
  dataBase64: string;
}

interface TerminalExitEvent {
  sessionId: string;
  exitCode: number;
  signal?: string | null;
}

function terminalTheme(): ITheme {
  const dark = document.documentElement.classList.contains("dark");
  return dark
    ? {
        background: "#0f0f11",
        foreground: "#e3e4e6",
        cursor: "#e3e4e6",
        selectionBackground: "#3f3c70",
      }
    : {
        background: "#fcfcfd",
        foreground: "#1b1b1b",
        cursor: "#1b1b1b",
        selectionBackground: "#dcd9fa",
      };
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(window.atob(value), (char) => char.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return window.btoa(binary);
}
