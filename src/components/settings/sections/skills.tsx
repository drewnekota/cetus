"use client";

/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
 * genre: modern-minimal · macrostructure: Workbench · designed-as-app */
// Full-window settings screen. Renders over the whole app (sidebar included)
// as a dedicated page rather than a modal dialog, with a left section rail and
// a scrollable content pane. Opened from the sidebar, the command palette, or
// ⌘, ; closed with Back or Esc.
import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  markdownComponents,
  markdownUrlTransform,
  remarkTrimAutolinkCjk,
} from "@/lib/markdown";
import {
  ChevronDown,
  ExternalLink,
  FileText,
  FolderOpen,
  Plus,
  Trash2,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useTranslation } from "@/lib/i18n";
import { api, onAppEvent } from "@/lib/tauri";
import type {
  DiscoverySettings,
  SkillEntry,
  SkillState,
  DiscoveredSkill,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  SectionHeading,
  ToggleRow,
  SettingsRowsSkeleton,
  SettingsList,
} from "../settings-controls";

// =============================================================================
// Skills (Agent Skills standard)
// =============================================================================

export function SkillsSection({ open }: { open: boolean }) {
  const { t } = useTranslation("settings");
  const [store, setStore] = useState<SkillState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const load = useCallback(async () => {
    setError(null);
    try {
      setStore(await api.listSkills());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  // Live-refresh when the agent's manage_skill tool changes the library (it
  // writes it directly, so it emits a dedicated app-event).
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    onAppEvent((e) => {
      if (e.type === "skills_updated") load();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [load]);

  async function toggleMaster(v: boolean) {
    setStore((s) => (s ? { ...s, enabled: v } : s));
    setError(null);
    try {
      await api.setSkillsEnabled(v);
    } catch (e) {
      setError(String(e));
      load();
    }
  }

  async function importFolder() {
    setError(null);
    let path: string | null = null;
    try {
      path = await api.pickWorkspaceDir();
    } catch (e) {
      setError(String(e));
      return;
    }
    if (!path) return;
    setBusy(true);
    try {
      await api.importSkill(path);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleRow(id: string, enabled: boolean) {
    setStore((s) =>
      s
        ? {
            ...s,
            entries: s.entries.map((m) =>
              m.id === id ? { ...m, enabled } : m,
            ),
          }
        : s,
    );
    setError(null);
    try {
      await api.setSkillEnabled(id, enabled);
    } catch (e) {
      setError(String(e));
      load();
    }
  }

  async function removeRow(id: string) {
    setStore((s) =>
      s ? { ...s, entries: s.entries.filter((m) => m.id !== id) } : s,
    );
    setError(null);
    try {
      await api.deleteSkill(id);
    } catch (e) {
      setError(String(e));
      load();
    }
  }

  const sorted = useMemo(
    () => [...(store?.entries ?? [])].sort((a, b) => b.updatedAt - a.updatedAt),
    [store?.entries],
  );
  const masterOn = store?.enabled ?? true;

  return (
    <section>
      <SectionHeading
        title={t("skills.title")}
        description={t("skills.description")}
      />

      <div className="mt-6 space-y-1">
        <ToggleRow
          id="skills-enabled"
          label={t("skills.enable.label")}
          description={t("skills.enable.description")}
          checked={masterOn}
          onCheckedChange={toggleMaster}
        />
      </div>

      <div
        className={cn(
          "mt-4 flex flex-wrap items-center gap-2",
          !masterOn && "opacity-60",
        )}
      >
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={importFolder}
          disabled={busy}
        >
          <FolderOpen className="size-3.5" />
          {busy ? t("skills.importing") : t("skills.import")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={() => setWriting((w) => !w)}
        >
          <Plus className="size-3.5" />
          {t("skills.write")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="gap-1.5 text-muted-foreground"
          onClick={() =>
            api.openExternal("https://agentskills.io").catch(() => {})
          }
        >
          <ExternalLink className="size-3.5" />
          {t("skills.learn")}
        </Button>
      </div>

      {writing && (
        <SkillEditor
          onCancel={() => setWriting(false)}
          onSaved={async () => {
            setWriting(false);
            await load();
          }}
          onError={setError}
        />
      )}

      <div className="mt-6">
        <h3 className="text-xs font-medium text-muted-foreground">
          {store === null
            ? t("skills.loading")
            : sorted.length === 0
              ? t("skills.empty")
              : sorted.length === 1
                ? t("skills.count.one", { count: sorted.length })
                : t("skills.count.other", { count: sorted.length })}
        </h3>

        {store === null && <SettingsRowsSkeleton />}
        {sorted.length > 0 && (
          <SettingsList className="mt-3">
            {sorted.map((s) => (
              <SkillRow
                key={s.id}
                entry={s}
                onToggle={toggleRow}
                onReveal={(id) =>
                  api.revealSkill(id).catch((e) => setError(String(e)))
                }
                onDelete={removeRow}
              />
            ))}
          </SettingsList>
        )}
      </div>

      <DiscoveredSkillsSection open={open} />

      {error && <div className="mt-4 text-xs text-destructive">{error}</div>}
    </section>
  );
}

/** Skills pi auto-loads from the global `~/.agents/skills` dir (installed via the
 *  `skills` CLI). cetus didn't write these, so they're surfaced read-only: view
 *  the rendered SKILL.md and open the folder; managing them stays with the CLI. */
function DiscoveredSkillsSection({ open }: { open: boolean }) {
  const { t } = useTranslation("settings");
  const [skills, setSkills] = useState<DiscoveredSkill[] | null>(null);
  const [discovery, setDiscovery] = useState<DiscoverySettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const repoSkills = skills?.filter((s) => s.scope === "repo") ?? [];
  const userSkills = skills?.filter((s) => s.scope !== "repo") ?? [];
  const userGroups = Array.from(
    userSkills.reduce((groups, skill) => {
      const group = groups.get(skill.root) ?? [];
      group.push(skill);
      groups.set(skill.root, group);
      return groups;
    }, new Map<string, DiscoveredSkill[]>()),
  );
  const repoGroups = Array.from(
    repoSkills.reduce((groups, skill) => {
      const group = groups.get(skill.root) ?? [];
      group.push(skill);
      groups.set(skill.root, group);
      return groups;
    }, new Map<string, DiscoveredSkill[]>()),
  );

  const reload = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([
        api.listDiscoveredSkills(),
        api.getDiscoverySettings(),
      ]);
      setSkills(s);
      setDiscovery(d);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (open) reload();
  }, [open, reload]);

  async function saveDiscovery(next: DiscoverySettings) {
    setDiscovery(next);
    try {
      await api.setDiscoverySettings(next);
      // Folder/toggle changed → the loaded list may differ; refresh it.
      setSkills(await api.listDiscoveredSkills());
    } catch (e) {
      setError(String(e));
      reload();
    }
  }

  async function pickFolder() {
    if (!discovery) return;
    try {
      const dir = await api.pickWorkspaceDir();
      if (dir) await saveDiscovery({ ...discovery, skillsFolder: dir });
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="mt-8 border-t border-border pt-6">
      <h3 className="text-sm font-medium">{t("skills.discovered.title")}</h3>
      <p className="mt-1 text-xs leading-snug text-muted-foreground">
        {t("skills.discovered.description")}
      </p>

      <div className="mt-4 space-y-3 rounded-lg border border-border p-3">
        <ToggleRow
          id="skills-load-discovered"
          label={t("skills.discovered.loadLabel")}
          description={t("skills.discovered.loadDesc")}
          checked={discovery?.skillsLoadDiscovered ?? false}
          onCheckedChange={(v) =>
            discovery &&
            saveDiscovery({ ...discovery, skillsLoadDiscovered: v })
          }
          disabled={!discovery}
        />
        <div className="flex items-center gap-2">
          <Input
            readOnly
            value={discovery?.skillsFolder ?? ""}
            className="font-mono text-xs"
          />
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 gap-1.5"
            onClick={pickFolder}
            disabled={!discovery}
          >
            <FolderOpen className="size-3.5" />
            {t("skills.discovered.chooseFolder")}
          </Button>
        </div>
      </div>

      <div className="mt-4">
        <h4 className="text-xs font-medium text-muted-foreground">
          {skills === null
            ? t("skills.loading")
            : skills.length === 1
              ? t("skills.discovered.count.one", { count: skills.length })
              : t("skills.discovered.count.other", { count: skills.length })}
        </h4>

        {skills && skills.length > 0 && (
          <div className="mt-3 space-y-5">
            {repoGroups.map(([root, group]) => (
              <DiscoveredSkillGroup
                key={root}
                title={t("skills.discovered.repoTitle")}
                root={root}
                skills={group}
                onReveal={(id) =>
                  api
                    .revealDiscoveredSkill(id)
                    .catch((e) => setError(String(e)))
                }
              />
            ))}
            {userGroups.map(([root, group]) => (
              <DiscoveredSkillGroup
                key={root}
                title={t("skills.discovered.userTitle")}
                root={root}
                skills={group}
                onReveal={(id) =>
                  api
                    .revealDiscoveredSkill(id)
                    .catch((e) => setError(String(e)))
                }
              />
            ))}
          </div>
        )}
      </div>

      {error && <div className="mt-3 text-xs text-destructive">{error}</div>}
    </div>
  );
}

function DiscoveredSkillGroup({
  title,
  root,
  skills,
  onReveal,
}: {
  title: string;
  root?: string;
  skills: DiscoveredSkill[];
  onReveal: (id: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex min-w-0 items-baseline gap-2">
        <h5 className="shrink-0 text-xs font-medium text-foreground">
          {title}
        </h5>
        {root && (
          <span className="truncate font-mono text-xs text-muted-foreground">
            {root}
          </span>
        )}
      </div>
      <SettingsList>
        {skills.map((s) => (
          <DiscoveredSkillRow key={s.id} skill={s} onReveal={onReveal} />
        ))}
      </SettingsList>
    </div>
  );
}

function DiscoveredSkillRow({
  skill,
  onReveal,
}: {
  skill: DiscoveredSkill;
  onReveal: (id: string) => void;
}) {
  const { t } = useTranslation("settings");
  const [expanded, setExpanded] = useState(false);
  const [body, setBody] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Lazy-load the SKILL.md only on first expand — 30+ skills shouldn't all parse
  // up front.
  async function toggleExpand() {
    const next = !expanded;
    setExpanded(next);
    if (next && body === null && loadError === null) {
      try {
        setBody(await api.readDiscoveredSkill(skill.id));
      } catch (e) {
        setLoadError(String(e));
      }
    }
  }

  return (
    <div className="min-w-0 bg-card">
      <div className="flex items-start gap-3 px-4 py-3">
        <button
          type="button"
          onClick={toggleExpand}
          className="min-w-0 flex-1 space-y-1 text-left"
          aria-expanded={expanded}
        >
          <p className="truncate text-sm font-medium">{skill.name}</p>
          {skill.description && (
            <p
              className={cn(
                "text-xs leading-snug text-muted-foreground",
                !expanded && "line-clamp-2",
              )}
            >
              {skill.description}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="rounded bg-muted px-1.5 py-0.5 font-medium">
              {skill.scope === "repo"
                ? t("skills.discovered.repoBadge")
                : t("skills.discovered.userBadge")}
            </span>
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            size="icon"
            variant="ghost"
            className="size-8 text-muted-foreground"
            onClick={toggleExpand}
            aria-label={t("skills.discovered.viewAria")}
          >
            <ChevronDown
              className={cn(
                "size-4 transition-transform",
                expanded && "rotate-180",
              )}
            />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-8 text-muted-foreground"
            onClick={() => onReveal(skill.id)}
            aria-label={t("skills.openFolderAria")}
          >
            <FolderOpen className="size-3.5" />
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border bg-muted/20 px-4 py-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <FileText className="size-3" />
            <span className="truncate font-mono">{skill.path}</span>
          </div>
          {loadError ? (
            <div className="text-xs text-destructive">{loadError}</div>
          ) : body === null ? (
            <div className="text-xs text-muted-foreground">
              {t("skills.loading")}
            </div>
          ) : (
            <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-2 prose-pre:my-2 prose-ul:my-2 prose-ol:my-2 prose-headings:my-3 prose-pre:bg-secondary prose-pre:text-foreground prose-code:rounded prose-code:bg-secondary prose-code:px-1 prose-code:py-0.5 prose-code:before:content-none prose-code:after:content-none">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkTrimAutolinkCjk]}
                components={markdownComponents}
                urlTransform={markdownUrlTransform}
              >
                {stripFrontmatter(body)}
              </ReactMarkdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Drop a leading `---`…`---` YAML frontmatter block so the rendered body doesn't
 *  repeat the name/description already shown in the row header. */
function stripFrontmatter(md: string): string {
  const s = md.replace(/^﻿/, "");
  if (!s.startsWith("---")) return s;
  const end = s.indexOf("\n---", 3);
  if (end === -1) return s;
  const after = s.indexOf("\n", end + 1);
  return after === -1 ? "" : s.slice(after + 1).replace(/^\s+/, "");
}

function SkillRow({
  entry,
  onToggle,
  onReveal,
  onDelete,
}: {
  entry: SkillEntry;
  onToggle: (id: string, enabled: boolean) => void;
  onReveal: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation("common");
  const [confirming, setConfirming] = useState(false);
  return (
    <div
      className={cn("group min-w-0 px-4 py-3", !entry.enabled && "opacity-50")}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="truncate text-sm font-medium">{entry.name}</p>
          {entry.description && (
            <p className="text-xs leading-snug text-muted-foreground">
              {entry.description}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span
              className={cn(
                "rounded px-1.5 py-0.5 font-medium",
                entry.source === "agent"
                  ? "bg-skill/10 text-skill dark:text-skill"
                  : "bg-muted",
              )}
            >
              {entry.source === "agent"
                ? entry.enabled
                  ? t("skills.source.byAgent")
                  : t("skills.source.proposed")
                : entry.source === "created"
                  ? t("skills.source.written")
                  : t("skills.source.imported")}
            </span>
            <span>
              {t("skills.updatedOn", {
                date: new Date(entry.updatedAt).toLocaleDateString(),
              })}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Switch
            checked={entry.enabled}
            onCheckedChange={(v) => onToggle(entry.id, v)}
            aria-label={
              entry.enabled ? t("skills.disableAria") : t("skills.enableAria")
            }
          />
          <Button
            size="icon"
            variant="ghost"
            className="size-8 text-muted-foreground"
            onClick={() => onReveal(entry.id)}
            aria-label={t("skills.openFolderAria")}
          >
            <FolderOpen className="size-3.5" />
          </Button>
          {confirming ? (
            <>
              <Button
                size="sm"
                variant="destructive"
                className="h-8"
                onClick={() => onDelete(entry.id)}
              >
                {t("skills.delete")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 text-muted-foreground"
                onClick={() => setConfirming(false)}
              >
                {tc("action.cancel")}
              </Button>
            </>
          ) : (
            <Button
              size="icon"
              variant="ghost"
              className="size-8 text-muted-foreground hover:text-destructive"
              onClick={() => setConfirming(true)}
              aria-label={t("skills.uninstallAria")}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function SkillEditor({
  onCancel,
  onSaved,
  onError,
}: {
  onCancel: () => void;
  onSaved: () => void;
  onError: (e: string) => void;
}) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation("common");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.createSkill(name.trim(), description.trim(), body);
      onSaved();
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-4 space-y-2 rounded-lg border border-border bg-muted/30 p-3">
      <Label className="text-xs font-medium text-muted-foreground">
        {t("skills.editor.title")}
      </Label>
      <Input
        placeholder={t("skills.editor.namePlaceholder")}
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />
      <Input
        placeholder={t("skills.editor.descPlaceholder")}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <Textarea
        placeholder={t("skills.editor.bodyPlaceholder")}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={6}
        className="font-mono text-xs"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={!name.trim() || saving}>
          {saving ? t("skills.editor.saving") : t("skills.editor.create")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onCancel}
          disabled={saving}
        >
          {tc("action.cancel")}
        </Button>
      </div>
    </div>
  );
}
