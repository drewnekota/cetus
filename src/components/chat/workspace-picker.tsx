"use client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Folder, FolderPlus, MessageSquare, Server } from "lucide-react";
import { api } from "@/lib/tauri";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
} from "@/components/ui/select";
import { useTranslation } from "@/lib/i18n";
import { workspaceName as shorten } from "@/lib/paths";
import {
  loadRecentWorkspaces,
  rememberRecentWorkspace,
} from "@/lib/recent-workspaces";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface Props {
  workspaceDir: string | null;
  defaultWorkspace: string;
  onChange: (dir: string) => void;
  disabled?: boolean;
  /** Hide the repository-free Chat workspace (used by task creation). */
  excludeDefault?: boolean;
  /** Fires true/false around the native "Add folder…" dialog. The quick panel
   *  uses it to suppress its blur-to-dismiss while the OS picker has focus. */
  onNativePick?: (active: boolean) => void;
  /** Optional context rendered after the folder name and before the chevron. */
  context?: ReactNode;
}

/** Sentinel value for the "Add folder…" row — handled in onValueChange instead
 *  of becoming the selected value. */
const ADD_FOLDER = "__add_folder__";
const ADD_REMOTE = "__add_remote__";

export function WorkspacePicker({
  workspaceDir,
  defaultWorkspace,
  onChange,
  disabled,
  excludeDefault = false,
  onNativePick,
  context,
}: Props) {
  const { t } = useTranslation("chat");
  // The default workspace surfaces as "Chat" (never its on-disk folder name) —
  // users aren't meant to perceive it as a folder.
  const { t: tSidebar } = useTranslation("sidebar");
  const displayName = (dir: string) =>
    dir === defaultWorkspace ? tSidebar("workspace.default") : shorten(dir);
  const [recent, setRecent] = useState<string[]>([]);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [remoteValue, setRemoteValue] = useState("");
  const selected = workspaceDir ?? defaultWorkspace;
  const current = excludeDefault && selected === defaultWorkspace ? "" : selected;

  useEffect(() => {
    setRecent(loadRecentWorkspaces());
  }, []);

  // Fold the active + default workspace into the list so they always appear and
  // the controlled <Select> always has a matching option.
  const options = useMemo(() => {
    const set = new Set<string>();
    if (current) set.add(current);
    if (defaultWorkspace && !excludeDefault) set.add(defaultWorkspace);
    for (const d of recent) {
      if (!excludeDefault || d !== defaultWorkspace) set.add(d);
    }
    return Array.from(set);
  }, [current, defaultWorkspace, excludeDefault, recent]);

  function remember(dir: string) {
    setRecent(rememberRecentWorkspace(dir));
  }

  async function handleChange(value: string) {
    if (value === ADD_FOLDER) {
      onNativePick?.(true);
      try {
        const dir = await api.pickWorkspaceDir();
        if (!dir) return;
        remember(dir);
        onChange(dir);
      } finally {
        onNativePick?.(false);
      }
      return;
    }
    if (value === ADD_REMOTE) {
      setRemoteValue("");
      setRemoteOpen(true);
      return;
    }
    remember(value);
    onChange(value);
  }

  function submitRemote() {
    const value = remoteValue.trim();
    if (!value) return;
    remember(value);
    onChange(value);
    setRemoteOpen(false);
  }

  // `current` is always a string (workspaceDir ?? defaultWorkspace), so pass it
  // straight to the Select. `|| undefined` would make it uncontrolled on the first
  // paint (before defaultWorkspace resolves) then flip to controlled — the React
  // warning. An empty string is a valid "nothing selected" yet still-controlled
  // value; the trigger renders its own placeholder text.
  return (
    <>
      <Select value={current} onValueChange={handleChange} disabled={disabled}>
        <SelectTrigger
          size="sm"
          title={current === defaultWorkspace ? undefined : current}
          className="h-7 max-w-52 gap-1.5 border-0 bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-muted hover:text-foreground focus-visible:ring-0 data-[size=sm]:h-7"
        >
          {current === defaultWorkspace && current ? (
            <MessageSquare className="size-3" />
          ) : current.startsWith("ssh://") || /^[^/:\s]+@?[^/:\s]+:/.test(current) ? (
            <Server className="size-3" />
          ) : (
            <Folder className="size-3" />
          )}
          <span className="truncate">{current ? displayName(current) : t("workspace.label")}</span>
          {context}
        </SelectTrigger>
        <SelectContent align="start" className="max-w-[22rem]">
          {options.map((dir) => (
            <SelectItem key={dir} value={dir} className="text-xs">
              {dir === defaultWorkspace ? (
                <MessageSquare className="size-4" />
              ) : dir.startsWith("ssh://") || /^[^/:\s]+@?[^/:\s]+:/.test(dir) ? (
                <Server className="size-4" />
              ) : (
                <Folder className="size-4" />
              )}
              <span
                className="truncate"
                title={dir === defaultWorkspace ? undefined : dir}
              >
                {displayName(dir)}
              </span>
            </SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value={ADD_REMOTE} className="text-xs text-muted-foreground">
            <Server className="size-4" />
            {t("workspace.addRemote")}
          </SelectItem>
          <SelectItem value={ADD_FOLDER} className="text-xs text-muted-foreground">
            <FolderPlus className="size-4" />
            {t("workspace.addFolder")}
          </SelectItem>
        </SelectContent>
      </Select>
      <Dialog open={remoteOpen} onOpenChange={setRemoteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("workspace.remoteTitle")}</DialogTitle>
          </DialogHeader>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submitRemote();
            }}
          >
            <Input
              value={remoteValue}
              onChange={(e) => setRemoteValue(e.target.value)}
              placeholder="ssh://user@host:2222/work/repo"
              autoFocus
            />
            <Button type="submit" size="sm">
              {t("workspace.remoteConnect")}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
