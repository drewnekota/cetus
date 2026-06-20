"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  File,
  Folder,
  Globe,
  Loader2,
  PanelBottom,
  PanelRight,
  Plus,
  RefreshCw,
  Terminal,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

export interface WorkspaceTab {
  id: string;
  kind: WorkspaceTabKind;
  title: string;
  terminalRunRequest?: TerminalRunRequest;
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
  onLayoutChange: (layout: WorkspaceLayout) => void;
  onUpdateBrowserTab: (id: string, state: BrowserViewState) => void;
  onAnnotate: (message: string) => Promise<void>;
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
  onLayoutChange,
  onUpdateBrowserTab,
  onAnnotate,
}: Props) {
  const { t } = useTranslation("chat");
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0] ?? null;
  const cwd = workspaceDir || defaultWorkspace;

  return (
    <aside
      className={cn(
        "flex flex-col bg-background",
        layout === "side"
          ? "h-full w-[min(768px,48vw)] min-w-[420px] max-w-3xl border-l border-border"
          : "h-[32vh] min-h-56 w-full border-t border-border",
      )}
      data-testid="workspace-panel"
      data-layout={layout}
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <div className="min-w-0 flex-1 overflow-x-auto">
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
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            title={t("workspacePanel.newFiles")}
            aria-label={t("workspacePanel.newFiles")}
            data-testid="workspace-new-files"
            onClick={() => onNewTab("files")}
          >
            <Folder className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            title={t("workspacePanel.newTerminal")}
            aria-label={t("workspacePanel.newTerminal")}
            data-testid="workspace-new-terminal"
            onClick={() => onNewTab("terminal")}
          >
            <Terminal className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            title={t("workspacePanel.newBrowser")}
            aria-label={t("workspacePanel.newBrowser")}
            data-testid="workspace-new-browser"
            onClick={() => onNewTab("browser")}
          >
            <Plus className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            title={
              layout === "side"
                ? t("workspacePanel.moveBottom")
                : t("workspacePanel.moveSide")
            }
            aria-label={
              layout === "side"
                ? t("workspacePanel.moveBottom")
                : t("workspacePanel.moveSide")
            }
            data-testid="workspace-toggle-layout"
            onClick={() => onLayoutChange(layout === "side" ? "bottom" : "side")}
          >
            {layout === "side" ? (
              <PanelBottom className="size-3.5" />
            ) : (
              <PanelRight className="size-3.5" />
            )}
          </Button>
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
          <TerminalPanel workspaceDir={cwd} runRequest={active.terminalRunRequest} />
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

  async function load() {
    setError(null);
    try {
      setFiles(await api.listWorkspaceFiles(workspaceDir));
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
          files.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted"
              onClick={() => api.openPath(entry.path).catch(console.error)}
              title={entry.path}
            >
              {entry.isDir ? (
                <Folder className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <File className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              {!entry.isDir && (
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {formatBytes(entry.sizeBytes ?? 0)}
                </span>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function TerminalPanel({
  workspaceDir,
  runRequest,
}: {
  workspaceDir: string;
  runRequest?: TerminalRunRequest;
}) {
  const { t } = useTranslation("chat");
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<{ command: string; result: BashResult | null; error?: string }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastRunRequestRef = useRef<string | null>(null);

  async function runCommand(textRaw: string) {
    const text = textRaw.trim();
    if (!text || running) return;
    setCommand("");
    setRunning(true);
    const item = { command: text, result: null };
    setHistory((xs) => [...xs, item]);
    try {
      const result = await api.runBash(text, workspaceDir);
      setHistory((xs) => xs.map((x) => (x === item ? { ...x, result } : x)));
    } catch (err) {
      setHistory((xs) => xs.map((x) => (x === item ? { ...x, error: String(err) } : x)));
    } finally {
      setRunning(false);
    }
  }

  async function run(e: FormEvent) {
    e.preventDefault();
    await runCommand(command);
  }

  useEffect(() => {
    if (!runRequest || lastRunRequestRef.current === runRequest.id) return;
    lastRunRequestRef.current = runRequest.id;
    setCommand(runRequest.command);
    inputRef.current?.focus();
    if (runRequest.autoRun) void runCommand(runRequest.command);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runRequest?.id]);

  return (
    <div className="flex h-full flex-col bg-background text-foreground dark:bg-[#0f1011] dark:text-[#eeeeee]">
      <div className="border-b border-border bg-muted/20 px-3 py-2 font-mono text-[11px] text-muted-foreground dark:border-white/10 dark:bg-transparent dark:text-white/55">
        {workspaceDir}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-xs">
        {history.length === 0 ? (
          <p className="text-muted-foreground dark:text-white/45">
            {t("workspacePanel.noCommands")}
          </p>
        ) : (
          history.map((item, i) => (
            <TerminalHistoryItem key={`${item.command}-${i}`} item={item} />
          ))
        )}
      </div>
      <form
        onSubmit={run}
        className="flex shrink-0 items-center gap-2 border-t border-border bg-muted/20 p-2 dark:border-white/10 dark:bg-transparent"
      >
        <span className="font-mono text-xs text-emerald-700 dark:text-emerald-300">$</span>
        <Input
          ref={inputRef}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          disabled={running}
          className="h-8 border-border bg-background font-mono text-xs text-foreground placeholder:text-muted-foreground dark:border-white/10 dark:bg-white/5 dark:text-white dark:placeholder:text-white/35"
          placeholder={t("workspacePanel.commandPlaceholder")}
          spellCheck={false}
        />
      </form>
    </div>
  );
}

function TerminalHistoryItem({
  item,
}: {
  item: { command: string; result: BashResult | null; error?: string };
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
