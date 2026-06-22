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
  Code,
  ExternalLink,
  File,
  FileText,
  Folder,
  FolderOpen,
  Globe,
  ImageIcon,
  Loader2,
  Plus,
  RefreshCw,
  Table,
  Terminal,
  Video,
  X,
} from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import hljs from "highlight.js/lib/common";
import mammoth from "mammoth";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import * as XLSX from "xlsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import {
  BrowserView,
  createBrowserViewState,
  type BrowserViewState,
} from "@/components/browser/browser-view";
import { useTranslation } from "@/lib/i18n";
import { markdownComponents } from "@/lib/markdown";
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
            visible={!hidden && motionState !== "closed"}
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
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const tree = useMemo(() => buildWorkspaceTree(files ?? []), [files]);
  const selected = useMemo(
    () => files?.find((entry) => entry.path === selectedPath) ?? null,
    [files, selectedPath],
  );

  async function load() {
    setError(null);
    try {
      const nextFiles = await api.listWorkspaceFiles(workspaceDir);
      setFiles(nextFiles);
      setExpanded(defaultExpandedPaths(nextFiles));
      setSelectedPath((current) => {
        if (current && nextFiles.some((entry) => entry.path === current)) return current;
        return nextFiles.find((entry) => !entry.isDir)?.path ?? null;
      });
    } catch (e) {
      setFiles([]);
      setError(String(e));
      setSelectedPath(null);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceDir]);

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
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
      <div className="grid min-h-0 grid-cols-[minmax(180px,34%)_1fr] overflow-hidden">
        <div className="min-h-0 min-w-0 overflow-hidden border-r border-border">
          <div className="h-full min-h-0 overflow-y-auto py-1">
            {!files ? (
              <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {t("workspacePanel.loading")}
              </div>
            ) : files.length === 0 ? (
              <p className="px-3 py-3 text-xs text-muted-foreground">
                {t("workspacePanel.noFiles")}
              </p>
            ) : (
              <FileTree
                nodes={tree}
                expanded={expanded}
                selectedPath={selectedPath}
                onSelect={(entry) => {
                  if (!entry.isDir) setSelectedPath(entry.path);
                }}
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
        <FilePreview file={selected} />
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
  selectedPath,
  onSelect,
  onToggle,
  depth = 0,
}: {
  nodes: WorkspaceTreeNode[];
  expanded: Set<string>;
  selectedPath: string | null;
  onSelect: (entry: WorkspaceFileEntry) => void;
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
          selectedPath={selectedPath}
          onSelect={onSelect}
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
  selectedPath,
  onSelect,
  onToggle,
}: {
  node: WorkspaceTreeNode;
  depth: number;
  expanded: Set<string>;
  selectedPath: string | null;
  onSelect: (entry: WorkspaceFileEntry) => void;
  onToggle: (path: string) => void;
}) {
  const isExpanded = expanded.has(node.entry.relativePath);
  const hasChildren = node.children.length > 0;
  const isSelected = selectedPath === node.entry.path;

  return (
    <div>
      <button
        type="button"
        role="treeitem"
        aria-expanded={node.entry.isDir ? isExpanded : undefined}
        data-selected={isSelected ? "true" : "false"}
        className="flex h-7 w-full items-center gap-1.5 pr-3 text-left text-xs hover:bg-muted data-[selected=true]:bg-muted data-[selected=true]:text-foreground"
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={() => {
          if (node.entry.isDir) onToggle(node.entry.relativePath);
          else onSelect(node.entry);
        }}
        onDoubleClick={() => {
          api.openPath(node.entry.path).catch(console.error);
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
        <FileTree
          nodes={node.children}
          expanded={expanded}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onToggle={onToggle}
          depth={depth + 1}
        />
      )}
    </div>
  );
}

function FilePreview({ file }: { file: WorkspaceFileEntry | null }) {
  const { t } = useTranslation("chat");
  const [text, setText] = useState<string | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const [modeByPath, setModeByPath] = useState<Record<string, "preview" | "source">>({});
  const ext = file ? fileExtension(file.name) : "";
  const kind = file ? previewKind(file.name) : "empty";
  const assetUrl = file ? convertFileSrc(file.path) : "";
  const hasSourceMode = file ? canToggleSource(kind, ext) : false;
  const mode = file && hasSourceMode ? (modeByPath[file.path] ?? "preview") : "preview";

  useEffect(() => {
    let alive = true;
    setText(null);
    setTextError(null);
    if (!file || !needsText(kind, mode, ext)) return;
    api
      .readTextFile(file.path)
      .then((value) => {
        if (alive) setText(value);
      })
      .catch((err) => {
        if (alive) setTextError(String(err));
      });
    return () => {
      alive = false;
    };
  }, [file?.path, kind, mode, ext]);

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
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          onClick={() => api.openPath(file.path).catch(console.error)}
          title={t("artifact.openExternal")}
          aria-label={t("artifact.openExternal")}
        >
          <ExternalLink className="size-3.5" />
        </Button>
      </div>
      <div className={cn("min-h-0", (mode === "source" || kind === "text") ? "overflow-hidden" : "overflow-auto")}>
        {mode === "source" ? (
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
          <iframe title={file.name} src={assetUrl} className="h-full min-h-[480px] w-full" />
        ) : kind === "markdown" ? (
          <TextPreview text={text} error={textError}>
            {(value) => (
              <div className="prose prose-sm dark:prose-invert max-w-none px-5 py-4 prose-pre:bg-secondary prose-pre:text-foreground">
                <ReactMarkdown
                  remarkPlugins={[[remarkGfm, { singleTilde: false }], remarkCjkFriendly]}
                  components={markdownComponents}
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
          const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
          if (alive) setDocHtml(result.value);
          return;
        }
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
    window.requestAnimationFrame(() => inputRef.current?.focus());
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

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [state.history.length, state.running]);

  return (
    <div
      className="h-full bg-background text-foreground dark:bg-[#0f1011] dark:text-[#eeeeee]"
      onClick={focusInput}
    >
      <div ref={scrollRef} className="h-full overflow-y-auto px-3 py-2 font-mono text-xs">
        {state.history.map((item) => (
          <TerminalHistoryItem key={item.id} item={item} />
        ))}
        <form
          onSubmit={run}
          className="flex items-baseline gap-2"
        >
          <span className="font-mono text-xs text-emerald-700 dark:text-emerald-300">$</span>
          <Input
            ref={inputRef}
            value={state.command}
            onChange={(e) =>
              updateState((current) => ({ ...current, command: e.target.value }))
            }
            disabled={state.running}
            className="h-auto flex-1 border-0 bg-transparent p-0 font-mono text-xs text-foreground shadow-none outline-none placeholder:text-muted-foreground focus-visible:border-0 focus-visible:ring-0 disabled:cursor-default dark:bg-transparent dark:text-white dark:placeholder:text-white/35"
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
