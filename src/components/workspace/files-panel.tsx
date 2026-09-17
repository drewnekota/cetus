"use client";

import { useEffect, useCallback, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  File,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Link2,
  MoreHorizontal,
  Paperclip,
  Pencil,
  RefreshCw,
  Search,
  Terminal,
  Trash2,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatBytes } from "@/lib/artifact";
import { useTranslation } from "@/lib/i18n";
import { api } from "@/lib/tauri";
import type { WorkspaceFileEntry } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FilePreview } from "./file-preview";

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

export function FilesPanel({
  workspaceDir,
  onOpenTerminalCommand,
}: {
  workspaceDir: string;
  onOpenTerminalCommand?: (command: string) => void;
}) {
  const { t } = useTranslation("chat");
  const [directories, setDirectories] = useState<
    Record<string, DirectoryState>
  >({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<
    WorkspaceFileEntry[] | null
  >(null);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [isRemote, setIsRemote] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);

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

  const loadDirectory = useCallback(
    async (path: string, quiet = false) => {
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
          setSelectedPath(
            (current) =>
              current ??
              listing.entries.find((entry) => !entry.isDir)?.path ??
              listing.entries[0]?.path ??
              null,
          );
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
    },
    [workspaceDir],
  );

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
      api
        .searchWorkspaceFiles(workspaceDir, trimmed)
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
      return searchResults.map((entry) => ({
        entry,
        depth: 0,
        parentPath: parentFilesystemPath(entry.path),
      }));
    }
    const rows: VisibleFileRow[] = [];
    const visited = new Set<string>();
    const append = (parentPath: string, depth: number) => {
      if (visited.has(parentPath)) return;
      visited.add(parentPath);
      for (const entry of directories[parentPath]?.entries ?? []) {
        rows.push({ entry, depth, parentPath });
        if (entry.isDir && expanded.has(entry.path))
          append(entry.path, depth + 1);
      }
    };
    append(workspaceDir, 0);
    return rows;
  }, [directories, expanded, searchResults, workspaceDir]);

  const selectedRow =
    visibleRows.find((row) => row.entry.path === selectedPath) ?? null;
  const selected = selectedRow?.entry ?? null;

  const toggleDirectory = useCallback(
    (entry: WorkspaceFileEntry) => {
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
    },
    [directories, loadDirectory],
  );

  function refreshLoaded() {
    setActionError(null);
    for (const path of loadedDirectoryPaths.length
      ? loadedDirectoryPaths
      : [workspaceDir]) {
      void loadDirectory(path);
    }
  }

  function onTreeKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!visibleRows.length) return;
    const index = Math.max(
      0,
      visibleRows.findIndex((row) => row.entry.path === selectedPath),
    );
    const row = visibleRows[index];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setSelectedPath(
        visibleRows[
          Math.max(0, Math.min(visibleRows.length - 1, index + delta))
        ].entry.path,
      );
    } else if (event.key === "ArrowRight" && row.entry.isDir) {
      event.preventDefault();
      if (!expanded.has(row.entry.path)) toggleDirectory(row.entry);
      else if (visibleRows[index + 1]?.depth > row.depth)
        setSelectedPath(visibleRows[index + 1].entry.path);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (row.entry.isDir && expanded.has(row.entry.path))
        toggleDirectory(row.entry);
      else if (row.depth > 0) setSelectedPath(row.parentPath);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (row.entry.isDir) toggleDirectory(row.entry);
      else if (!isRemote) void api.openPath(row.entry.path);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setSelectedPath(
        visibleRows[event.key === "Home" ? 0 : visibleRows.length - 1].entry
          .path,
      );
    }
  }

  async function createEntry(isDir: boolean) {
    if (isRemote) return;
    const parent = selected?.isDir
      ? selected.path
      : (selectedRow?.parentPath ?? workspaceDir);
    const name = window.prompt(
      t(isDir ? "workspacePanel.folderName" : "workspacePanel.fileName"),
    );
    if (!name) return;
    try {
      const path = await api.createWorkspaceEntry(
        workspaceDir,
        parent,
        name,
        isDir,
      );
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
      const path = await api.renameWorkspaceEntry(
        workspaceDir,
        selected.path,
        name,
      );
      await loadDirectory(selectedRow?.parentPath ?? workspaceDir);
      setSelectedPath(path);
    } catch (error) {
      setActionError(String(error));
    }
  }

  async function trashSelected() {
    if (
      !selected ||
      isRemote ||
      !window.confirm(t("workspacePanel.confirmTrash", { name: selected.name }))
    )
      return;
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
        <p className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {workspaceDir}
        </p>
        {isRemote && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
            SSH
          </span>
        )}
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          onClick={refreshLoaded}
          aria-label={t("workspacePanel.refresh")}
        >
          {rootState?.loading ? (
            <Spinner className="size-3.5" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
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
        {searching && <Spinner className="size-3 text-muted-foreground" />}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={t("workspacePanel.fileActions")}
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem
              onSelect={() => void createEntry(false)}
              disabled={isRemote}
            >
              <FilePlus />
              {t("workspacePanel.newFile")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void createEntry(true)}
              disabled={isRemote}
            >
              <FolderPlus />
              {t("workspacePanel.newFolder")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!selected || selected.isDir}
              onSelect={() =>
                selected &&
                window.dispatchEvent(
                  new CustomEvent("cetus-insert-file-paths", {
                    detail: [selected.path],
                  }),
                )
              }
            >
              <Paperclip />
              {t("workspacePanel.addToChat")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!selected}
              onSelect={() =>
                selected &&
                void navigator.clipboard.writeText(selected.relativePath)
              }
            >
              <Copy />
              {t("workspacePanel.copyRelativePath")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!selected}
              onSelect={() =>
                selected && void navigator.clipboard.writeText(selected.path)
              }
            >
              <Copy />
              {t("workspacePanel.copyAbsolutePath")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!selected || isRemote}
              onSelect={() =>
                selected && void api.revealInFinder(selected.path)
              }
            >
              <ExternalLink />
              {t("workspacePanel.revealFinder")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!selected || !onOpenTerminalCommand}
              onSelect={() =>
                selected &&
                onOpenTerminalCommand?.(
                  `cd '${(selected.isDir ? selected.path : (selectedRow?.parentPath ?? workspaceDir)).replaceAll("'", "'\\''")}'`,
                )
              }
            >
              <Terminal />
              {t("workspacePanel.openTerminal")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!selected || isRemote}
              onSelect={() => void renameSelected()}
            >
              <Pencil />
              {t("workspacePanel.rename")}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              disabled={!selected || isRemote}
              onSelect={() => void trashSelected()}
            >
              <Trash2 />
              {t("workspacePanel.moveTrash")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div
        className={cn(
          actionError
            ? "border-b border-destructive/20 bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
            : "h-0",
        )}
      >
        {actionError}
      </div>
      <div className="grid min-h-0 grid-cols-[minmax(210px,36%)_1fr] overflow-hidden">
        <div
          className="min-h-0 min-w-0 overflow-y-auto border-r border-border py-1"
          role="tree"
          tabIndex={0}
          onKeyDown={onTreeKeyDown}
        >
          {!rootState && !searchResults ? (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              {t("workspacePanel.loading")}
            </div>
          ) : rootState?.error && !rootState.entries.length ? (
            <p className="px-3 py-3 text-xs text-destructive">
              {rootState.error}
            </p>
          ) : !visibleRows.length ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">
              {query
                ? t("workspacePanel.noMatches")
                : t("workspacePanel.noFiles")}
            </p>
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
            <p className="px-3 py-2 text-2xs text-amber-600 dark:text-amber-400">
              {t("workspacePanel.moreFiles")}
            </p>
          )}
        </div>
        <FilePreview
          file={selected?.isDir ? null : selected}
          workspaceDir={workspaceDir}
          isRemote={isRemote}
        />
      </div>
      {contextMenu && selected && (
        <div
          role="menu"
          className="fixed z-100 min-w-44 rounded-md bg-popover p-1 text-xs text-popover-foreground shadow-lg ring-1 ring-foreground/10"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {!selected.isDir && (
            <button
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-accent"
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent("cetus-insert-file-paths", {
                    detail: [selected.path],
                  }),
                );
                setContextMenu(null);
              }}
            >
              <Paperclip className="size-3.5" />
              {t("workspacePanel.addToChat")}
            </button>
          )}
          <button
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-accent"
            onClick={() => {
              void navigator.clipboard.writeText(selected.relativePath);
              setContextMenu(null);
            }}
          >
            <Copy className="size-3.5" />
            {t("workspacePanel.copyRelativePath")}
          </button>
          {!isRemote && (
            <button
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-accent"
              onClick={() => {
                void api.revealInFinder(selected.path);
                setContextMenu(null);
              }}
            >
              <ExternalLink className="size-3.5" />
              {t("workspacePanel.revealFinder")}
            </button>
          )}
          {!isRemote && <div className="my-1 h-px bg-border" />}
          {!isRemote && (
            <button
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-accent"
              onClick={() => {
                setContextMenu(null);
                void renameSelected();
              }}
            >
              <Pencil className="size-3.5" />
              {t("workspacePanel.rename")}
            </button>
          )}
          {!isRemote && (
            <button
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-destructive hover:bg-destructive/10"
              onClick={() => {
                setContextMenu(null);
                void trashSelected();
              }}
            >
              <Trash2 className="size-3.5" />
              {t("workspacePanel.moveTrash")}
            </button>
          )}
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
        onClick={() => {
          onSelect();
          if (entry.isDir) onToggle();
        }}
        onDoubleClick={() => {
          if (!entry.isDir && !isRemote) void api.openPath(entry.path);
        }}
        onContextMenu={onContextMenu}
        title={`${entry.path}${entry.symlinkTarget ? ` → ${entry.symlinkTarget}` : ""}`}
      >
        <span className="grid size-4 shrink-0 place-items-center text-muted-foreground">
          {entry.isDir ? (
            state?.loading ? (
              <Spinner className="size-3" />
            ) : expanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )
          ) : null}
        </span>
        {entry.isDir ? (
          expanded ? (
            <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="size-3.5 shrink-0 text-muted-foreground" />
          )
        ) : (
          <File className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        {entry.isSymlink && (
          <Link2 className="-ml-2 mt-2 size-2.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {entry.gitStatus && entry.gitStatus !== "ignored" && (
          <GitStatusBadge status={entry.gitStatus} />
        )}
        {!entry.isDir && entry.sizeBytes != null && (
          <span className="shrink-0 tabular-nums text-2xs text-muted-foreground">
            {formatBytes(entry.sizeBytes)}
          </span>
        )}
      </button>
      {expanded && state?.error && (
        <p
          className="py-1 pr-2 text-2xs text-destructive"
          style={{ paddingLeft: `${36 + (depth + 1) * 14}px` }}
        >
          {state.error}
        </p>
      )}
      {expanded && state?.truncated && (
        <p
          className="py-1 pr-2 text-2xs text-amber-600 dark:text-amber-400"
          style={{ paddingLeft: `${36 + (depth + 1) * 14}px` }}
        >
          {t("workspacePanel.firstEntries")}
        </p>
      )}
    </div>
  );
}

function GitStatusBadge({
  status,
}: {
  status: NonNullable<WorkspaceFileEntry["gitStatus"]>;
}) {
  const labels: Record<string, string> = {
    modified: "M",
    added: "A",
    deleted: "D",
    renamed: "R",
    untracked: "U",
    conflict: "!",
  };
  return (
    <span
      className={cn(
        "w-3 shrink-0 text-center text-2xs font-semibold",
        status === "conflict" || status === "deleted"
          ? "text-red-500"
          : status === "untracked" || status === "added"
            ? "text-emerald-500"
            : "text-amber-500",
      )}
    >
      {labels[status] ?? ""}
    </span>
  );
}
