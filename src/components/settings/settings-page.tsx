"use client";
// Full-window settings screen. Renders over the whole app (sidebar included)
// as a dedicated page rather than a modal dialog, with a left section rail and
// a scrollable content pane. Opened from the sidebar, the command palette, or
// ⌘, ; closed with Back or Esc.

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownComponents } from "@/lib/markdown";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  AudioLines,
  Bell,
  Brain,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  FileText,
  FolderOpen,
  KeyRound,
  Keyboard,
  Mic,
  Monitor,
  Moon,
  Pencil,
  Plus,
  RotateCw,
  ServerCog,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  SquareSlash,
  Trash2,
  Type,
  X,
  Zap,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DEFAULT_THEME,
  THEME_OPTIONS,
  getThemePreference,
  setThemePreference,
  type ThemePreference,
} from "@/lib/theme-prefs";
import {
  LOCALE_NATIVE_NAMES,
  LOCALES,
  useLocale,
  useTranslation,
  type LocalePreference,
} from "@/lib/i18n";
import { formatElapsed } from "@/lib/format";
import {
  api,
  onAppEvent,
  onPiEvent,
  type CaptureSettings,
  type Meeting,
  type MeetingSettings,
  type MeetingStatus,
} from "@/lib/tauri";
import { toast } from "sonner";
import type {
  AutoArchiveSettings,
  Conversation,
  DiscoverySettings,
  DreamSettings,
  McpConnector,
  McpConnectorInput,
  McpImportEntry,
  McpImportSource,
  McpTestResult,
  McpToolInfo,
  McpTransport,
  MemoryEntry,
  MemoryState,
  SkillEntry,
  SkillReviewSettings,
  SkillState,
  DiscoveredSkill,
  SlashCommand,
  UpdateMeta,
} from "@/lib/types";
import {
  DEFAULT_AUTO_ARCHIVE_SETTINGS,
  DEFAULT_DREAM_SETTINGS,
  DEFAULT_SKILL_REVIEW_SETTINGS,
} from "@/lib/types";
import {
  NOTIFY_EVENTS,
  ensurePermission,
  refreshPermission,
  useNotificationPrefs,
} from "@/lib/notifications";
import {
  DEFAULT_QUICK_SETTINGS,
  type QuickGesture,
  type QuickSessionMode,
  type QuickSettings,
  type CliAgentSettings,
  type TranscriptState,
  type VoiceAsrEngine,
  type VoiceGesture,
  type VoicePermissions,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { HotkeyRecorder } from "./hotkey-recorder";
import {
  SHORTCUT_DEFINITIONS,
  defaultShortcutMap,
  readKeyboardShortcuts,
  resetKeyboardShortcuts,
  shortcutDisplay,
  writeKeyboardShortcuts,
  type ShortcutId,
  type ShortcutMap,
} from "@/lib/keyboard-shortcuts";
import {
  APPLICABLE_PERMISSIONS,
  PermissionRow,
  usePermissionStatuses,
} from "./permission-row";

// cetus is a DeepSeek-only desktop client; keep the key surface minimal.
// `labelKey` is a settings-namespace i18n key resolved at render (hooks can't
// run at module level); `envHint` is a literal env-var name, never translated.
const PROVIDERS: { id: string; labelKey: string; envHint: string }[] = [
  { id: "deepseek", labelKey: "providers.deepseek", envHint: "DEEPSEEK_API_KEY" },
  // Optional. When set, web_search prefers Exa over Tavily.
  { id: "exa", labelKey: "providers.exa", envHint: "EXA_API_KEY" },
  // Optional. Fallback provider for web_search/web_fetch extraction.
  { id: "tavily", labelKey: "providers.tavily", envHint: "TAVILY_API_KEY" },
  // Doubao (Volcano Engine) real-time streaming ASR — the voice-dictation engine
  // (new-console X-Api-Key). Fast (~90ms), live partials, great zh/en, CN-native.
  { id: "doubao", labelKey: "providers.doubao", envHint: "DOUBAO_API_KEY" },
  // Volcano Ark LLM key — fast dictation cleanup/rewrite (Doubao flash). Separate
  // from the Doubao speech key above; get it from the Ark console (火山方舟).
  { id: "volc_ark", labelKey: "providers.volcArk", envHint: "ARK_API_KEY" },
  // Vision + PDFs: the vision bridge transcribes attached images via Gemini
  // (gemini-3.5-flash) so the text-only DeepSeek model can read them.
  { id: "gemini", labelKey: "providers.gemini", envHint: "GEMINI_API_KEY" },
];

type SectionId =
  | "general"
  | "api-keys"
  | "memory"
  | "dreaming"
  | "skills"
  | "slash-commands"
  | "connectors"
  | "notifications"
  | "permissions"
  | "appearance"
  | "keyboard-shortcuts"
  | "launcher"
  | "voice"
  | "screen"
  | "meetings"
  | "archived";

type Section = {
  id: SectionId;
  // i18n key (settings namespace), resolved at render. The section id doubles
  // as the key suffix: `nav.<id>`.
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
};

// The rail is grouped into a few labelled clusters so a dozen flat entries
// don't read as one long list. Order within a group is intentional.
// `labelKey` values are settings-namespace i18n keys resolved at render.
const SECTION_GROUPS: { labelKey: string; sections: Section[] }[] = [
  {
    labelKey: "group.general",
    sections: [
      { id: "general", labelKey: "nav.general", icon: SlidersHorizontal },
      { id: "appearance", labelKey: "nav.appearance", icon: Type },
      { id: "keyboard-shortcuts", labelKey: "nav.keyboard-shortcuts", icon: Keyboard },
      { id: "notifications", labelKey: "nav.notifications", icon: Bell },
      { id: "permissions", labelKey: "nav.permissions", icon: ShieldCheck },
    ],
  },
  {
    labelKey: "group.intelligence",
    sections: [
      { id: "api-keys", labelKey: "nav.api-keys", icon: KeyRound },
      { id: "memory", labelKey: "nav.memory", icon: Brain },
      { id: "dreaming", labelKey: "nav.dreaming", icon: Moon },
      { id: "skills", labelKey: "nav.skills", icon: Sparkles },
      { id: "slash-commands", labelKey: "nav.slash-commands", icon: SquareSlash },
      { id: "connectors", labelKey: "nav.connectors", icon: ServerCog },
    ],
  },
  {
    labelKey: "group.inputCapture",
    sections: [
      { id: "launcher", labelKey: "nav.launcher", icon: Zap },
      { id: "voice", labelKey: "nav.voice", icon: Mic },
      { id: "screen", labelKey: "nav.screen", icon: Monitor },
      { id: "meetings", labelKey: "nav.meetings", icon: AudioLines },
    ],
  },
  {
    labelKey: "group.data",
    sections: [
      { id: "archived", labelKey: "nav.archived", icon: Archive },
    ],
  },
];

const SETTINGS_SECTION_KEY = "cetus:settingsSection";
const SECTION_IDS = new Set<SectionId>(
  SECTION_GROUPS.flatMap((group) => group.sections.map((section) => section.id)),
);

function readSettingsSection(): SectionId {
  if (typeof window === "undefined") return "general";
  try {
    const saved = window.localStorage.getItem(SETTINGS_SECTION_KEY);
    if (SECTION_IDS.has(saved as SectionId)) return saved as SectionId;
  } catch {}
  return "general";
}

type Props = {
  open: boolean;
  onClose: () => void;
  /** Providers that already have a key stored — fetched from the keychain. */
  storedProviders: string[];
  onSaved: () => void;
  /** Open the full-screen Screen history viewer (closes settings first). */
  onOpenHistory: () => void;
  /** Called after archived chats are deleted/restored so the sidebar refreshes. */
  onConversationsChanged?: () => void;
};

// Memoized because the panel latches mounted after first open (hidden via CSS)
// inside the frequently-re-rendering Home component — without memo this whole
// ~5k-line subtree reconciles on every unrelated Home state change.
export const SettingsPage = memo(function SettingsPage({
  open,
  onClose,
  storedProviders,
  onSaved,
  onOpenHistory,
  onConversationsChanged,
}: Props) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation("common");
  const [section, setSection] = useState<SectionId>(readSettingsSection);

  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_SECTION_KEY, section);
    } catch {}
  }, [section]);

  // Esc closes the page. Capture phase + stopPropagation so it wins over the
  // app-level Esc handler (which also aborts streams).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (document.documentElement.dataset.hotkeyRecording === "true") return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  // Keep the panel mounted across close/reopen (hidden via CSS) instead of
  // unmounting. Section selection, scroll position, and already-loaded data all
  // persist, so reopening shows the last view instantly while the per-section
  // [open, load] effects silently refresh in the background — no null flash.
  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex flex-col bg-background",
        !open && "hidden",
      )}
    >
      {/* `pl-20` clears the macOS traffic lights (Overlay title bar floats them
          over the top-left); the bar also doubles as a window drag handle. */}
      <header
        data-tauri-drag-region
        className="flex h-12 shrink-0 items-center gap-2 border-b border-border pl-20 pr-3"
      >
        <Button variant="ghost" size="sm" onClick={onClose} className="gap-1.5">
          <ArrowLeft className="size-4" />
          {tc("action.back")}
        </Button>
        <span className="font-serif text-base font-semibold italic">
          {t("page.title")}
        </span>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav className="scrollbar-slim w-52 shrink-0 overflow-y-auto border-r border-border bg-muted/20 p-2">
          {SECTION_GROUPS.map((group) => (
            <div key={group.labelKey} className="mb-3 last:mb-0">
              <div className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t(group.labelKey)}
              </div>
              {group.sections.map((s) => {
                const Icon = s.icon;
                const active = section === s.id;
                return (
                  <button
                    key={s.id}
                    data-testid={`nav-${s.id}`}
                    type="button"
                    onClick={() => setSection(s.id)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                      active
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <Icon className="size-3.5 shrink-0" />
                    {t(s.labelKey)}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <main className="scrollbar-slim min-w-0 flex-1 overflow-y-auto bg-muted/10">
          <div className="mx-auto w-full max-w-5xl px-6 py-8">
            {section === "general" ? (
              <GeneralSection />
            ) : section === "api-keys" ? (
              <ApiKeysSection
                storedProviders={storedProviders}
                onSaved={onSaved}
              />
            ) : section === "memory" ? (
              <MemorySection open={open} />
            ) : section === "dreaming" ? (
              <DreamingSection />
            ) : section === "skills" ? (
              <SkillsSection open={open} />
            ) : section === "slash-commands" ? (
              <SlashCommandsSection open={open} />
            ) : section === "connectors" ? (
              <ConnectorsSection open={open} />
            ) : section === "notifications" ? (
              <NotificationsSection />
            ) : section === "permissions" ? (
              <PermissionsSection open={open} />
            ) : section === "appearance" ? (
              <AppearanceSection />
            ) : section === "keyboard-shortcuts" ? (
              <KeyboardShortcutsSection />
            ) : section === "launcher" ? (
              <LauncherSection />
            ) : section === "voice" ? (
              <VoiceSection />
            ) : section === "meetings" ? (
              <MeetingsSection open={open} />
            ) : section === "archived" ? (
              <ArchivedChatsSection
                open={open}
                onConversationsChanged={onConversationsChanged}
              />
            ) : (
              <ScreenContextSection onOpenHistory={onOpenHistory} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
});

/** A few placeholder rows for a list section's cold load — shown while the
 *  section's data is still null, so the body doesn't flash empty then snap in
 *  (the heading already shows its own "Loading…" label). */
function SettingsRowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <SettingsCardGrid className="mt-3">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-14 w-full rounded-lg" />
      ))}
    </SettingsCardGrid>
  );
}

function SettingsCardGrid({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid min-w-0 gap-3 lg:grid-cols-2", className)}>
      {children}
    </div>
  );
}

// =============================================================================
// General
// =============================================================================

// App-level basics: the display language and OS launch-on-startup. Language is a
// common-namespace pref (localStorage via useLocale); launch-on-startup is a
// QuickSettings field (the launcher also re-fetches QuickSettings on open, so
// the two editors don't drift within a session).
function GeneralSection() {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation("common");
  const { preference: localePref, setPreference: setLocalePref } = useLocale();
  const [settings, setSettings] = useState<QuickSettings>(DEFAULT_QUICK_SETTINGS);
  const [cliSettings, setCliSettings] = useState<CliAgentSettings>({
    bypassApprovals: true,
  });
  const [appVersion, setAppVersion] = useState("");
  const [checkState, setCheckState] = useState<
    "idle" | "checking" | "upToDate" | "available" | "installing" | "failed"
  >("idle");
  const [pending, setPending] = useState<UpdateMeta | null>(null);

  useEffect(() => {
    api.getQuickSettings().then(setSettings).catch(() => {});
    api.getCliAgentSettings().then(setCliSettings).catch(() => {});
    import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  function update(patch: Partial<QuickSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    api.setQuickSettings(next).catch(() => {});
  }

  function updateCli(patch: Partial<CliAgentSettings>) {
    const next = { ...cliSettings, ...patch };
    setCliSettings(next);
    api.setCliAgentSettings(next).catch(() => {});
  }

  async function checkUpdates() {
    setCheckState("checking");
    try {
      const u = await api.checkForUpdate();
      if (u) {
        setPending(u);
        setCheckState("available");
      } else {
        setCheckState("upToDate");
      }
    } catch {
      setCheckState("failed");
    }
  }

  async function installNow() {
    setCheckState("installing");
    try {
      await api.installUpdate();
      setPending(null);
      setCheckState("idle");
      toast.success(t("update.installed"));
    } catch {
      setCheckState("failed");
    }
  }

  return (
    <section>
      <SectionHeading
        title={t("general.title")}
        description={t("general.description")}
      />

      <div className="mt-6 space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <Label className="font-medium">{tc("language.label")}</Label>
            <p className="text-xs text-muted-foreground">
              {tc("language.description")}
            </p>
          </div>
          <Select
            value={localePref}
            onValueChange={(v) => setLocalePref(v as LocalePreference)}
          >
            <SelectTrigger className="w-52 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">{tc("language.system")}</SelectItem>
              {LOCALES.map((loc) => (
                <SelectItem key={loc} value={loc}>
                  {LOCALE_NATIVE_NAMES[loc]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mt-2">
        <ToggleRow
          id="launch-on-startup"
          label={t("launcher.startup.label")}
          description={t("launcher.startup.description")}
          checked={settings.launchOnStartup}
          onCheckedChange={(v) => update({ launchOnStartup: v })}
        />
        <ToggleRow
          id="auto-update"
          label={t("general.autoUpdate.label")}
          description={t("general.autoUpdate.description")}
          checked={settings.autoUpdate}
          onCheckedChange={(v) => update({ autoUpdate: v })}
        />
        <ToggleRow
          id="cli-agents-bypass"
          label={t("general.cliAgents.label")}
          description={t("general.cliAgents.description")}
          checked={cliSettings.bypassApprovals}
          onCheckedChange={(v) => updateCli({ bypassApprovals: v })}
        />
        <div className="flex items-center justify-between gap-4 pt-1">
          <div className="min-w-0 space-y-0.5">
            <Label className="font-medium">{t("update.check.label")}</Label>
            <p className="text-xs text-muted-foreground">
              {checkState === "checking"
                ? t("update.check.checking")
                : checkState === "upToDate"
                  ? t("update.check.upToDate")
                  : checkState === "available" && pending
                    ? t("update.check.available", { version: pending.version })
                    : checkState === "failed"
                      ? t("update.failed")
                      : appVersion
                        ? t("update.check.current", { version: appVersion })
                        : ""}
            </p>
          </div>
          {checkState === "available" || checkState === "installing" ? (
            <Button
              size="sm"
              className="shrink-0"
              disabled={checkState === "installing"}
              onClick={installNow}
            >
              {checkState === "installing"
                ? t("update.installing")
                : t("update.check.install")}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={checkState === "checking"}
              onClick={checkUpdates}
            >
              {checkState === "checking"
                ? t("update.check.checking")
                : t("update.check.button")}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

// =============================================================================
// API keys
// =============================================================================

interface RowState {
  pending: string | null;
}

function ApiKeysSection({
  storedProviders,
  onSaved,
}: {
  storedProviders: string[];
  onSaved: () => void;
}) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation("common");
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [masked, setMasked] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Custom DeepSeek base URL. `dsUrl` is the live field; `dsUrlSaved` is what's
  // persisted, so the Save button only lights up on a real change.
  const [dsUrl, setDsUrl] = useState("");
  const [dsUrlSaved, setDsUrlSaved] = useState("");
  const [dsUrlBusy, setDsUrlBusy] = useState(false);

  useEffect(() => {
    setRows({});
    setError(null);
    api
      .listApiKeysMasked()
      .then(setMasked)
      .catch((e) => setError(String(e)));
  }, [storedProviders]);

  useEffect(() => {
    api
      .getDeepseekBaseUrl()
      .then((u) => {
        setDsUrl(u);
        setDsUrlSaved(u);
      })
      .catch(() => {});
  }, []);

  async function saveDsUrl() {
    setDsUrlBusy(true);
    setError(null);
    try {
      const v = dsUrl.trim();
      await api.setDeepseekBaseUrl(v);
      setDsUrl(v);
      setDsUrlSaved(v);
    } catch (e) {
      setError(String(e));
    } finally {
      setDsUrlBusy(false);
    }
  }

  async function copy(provider: string) {
    setError(null);
    try {
      const key = await api.revealApiKey(provider);
      if (!key) return;
      await navigator.clipboard.writeText(key);
      setCopied(provider);
      window.setTimeout(
        () => setCopied((c) => (c === provider ? null : c)),
        1500,
      );
    } catch (e) {
      setError(String(e));
    }
  }

  function startEdit(provider: string) {
    setRows((s) => ({ ...s, [provider]: { pending: "" } }));
  }

  function cancelEdit(provider: string) {
    setRows((s) => {
      const next = { ...s };
      delete next[provider];
      return next;
    });
  }

  function setPending(provider: string, value: string) {
    setRows((s) => ({ ...s, [provider]: { pending: value } }));
  }

  async function save(provider: string) {
    const v = rows[provider]?.pending?.trim() ?? "";
    if (!v) return;
    setSaving(provider);
    setError(null);
    try {
      await api.setApiKey(provider, v);
      const next = await api.listApiKeysMasked().catch(() => masked);
      setMasked(next);
      cancelEdit(provider);
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(null);
    }
  }

  async function remove(provider: string) {
    setSaving(provider);
    setError(null);
    try {
      await api.deleteApiKey(provider);
      setMasked((m) => {
        const next = { ...m };
        delete next[provider];
        return next;
      });
      cancelEdit(provider);
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(null);
    }
  }

  return (
    <section>
      <SectionHeading
        title={t("apiKeys.title")}
        description={t("apiKeys.description")}
      />
      <div className="mt-6 space-y-5">
        {PROVIDERS.map((p) => {
          const stored = storedProviders.includes(p.id) || masked[p.id] != null;
          const row = rows[p.id];
          const editing = row != null;
          const busy = saving === p.id;
          const pending = row?.pending ?? "";

          function onInputKey(e: React.KeyboardEvent) {
            if (e.key === "Enter" && pending.trim()) {
              e.preventDefault();
              save(p.id);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              cancelEdit(p.id);
            }
          }

          return (
            <div key={p.id} className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <label htmlFor={`key-${p.id}`} className="font-medium">
                  {t(p.labelKey)}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {p.envHint}
                  </span>
                </label>
                {stored && !editing && (
                  <span className="text-xs text-success">
                    {t("apiKeys.stored")}
                  </span>
                )}
                {editing && (
                  <span className="text-xs text-warning">
                    {t("apiKeys.unsaved")}
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                {stored && !editing ? (
                  <>
                    <div className="flex h-9 flex-1 items-center px-3 font-mono text-sm text-muted-foreground">
                      {masked[p.id] ?? "•••"}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => copy(p.id)}
                      disabled={busy}
                      className="gap-1.5"
                    >
                      {copied === p.id ? (
                        <>
                          <Check className="size-3.5" />
                          {tc("action.copied")}
                        </>
                      ) : (
                        <>
                          <Copy className="size-3.5" />
                          {tc("action.copy")}
                        </>
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => startEdit(p.id)}
                      disabled={busy}
                    >
                      {t("apiKeys.replace")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => remove(p.id)}
                      disabled={busy}
                    >
                      {tc("action.remove")}
                    </Button>
                  </>
                ) : (
                  <>
                    <Input
                      id={`key-${p.id}`}
                      type={stored ? "password" : "text"}
                      placeholder="sk-…"
                      value={pending}
                      autoFocus={editing}
                      onKeyDown={onInputKey}
                      onChange={(e) => setPending(p.id, e.target.value)}
                      disabled={busy}
                      className="font-mono"
                    />
                    {pending.trim().length > 0 && (
                      <Button
                        size="sm"
                        onClick={() => save(p.id)}
                        disabled={busy}
                      >
                        {tc("action.save")}
                      </Button>
                    )}
                    {stored && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => cancelEdit(p.id)}
                        disabled={busy}
                      >
                        {tc("action.cancel")}
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}

        {/* Custom DeepSeek endpoint — redirects every DeepSeek call (the main
            agent plus titling / dream / skill review / meeting minutes) to an
            OpenAI-compatible base URL. Blank = stock api.deepseek.com. */}
        <div className="space-y-1.5 border-t border-border pt-5">
          <div className="flex items-center justify-between text-sm">
            <label htmlFor="deepseek-base-url" className="font-medium">
              {t("apiKeys.deepseekUrl.label")}
            </label>
            {dsUrl.trim() !== dsUrlSaved && (
              <span className="text-xs text-warning">{t("apiKeys.unsaved")}</span>
            )}
          </div>
          <div className="flex gap-2">
            <Input
              id="deepseek-base-url"
              type="text"
              placeholder="https://api.deepseek.com"
              value={dsUrl}
              onKeyDown={(e) => {
                if (e.key === "Enter" && dsUrl.trim() !== dsUrlSaved) {
                  e.preventDefault();
                  saveDsUrl();
                }
              }}
              onChange={(e) => setDsUrl(e.target.value)}
              disabled={dsUrlBusy}
              className="font-mono"
            />
            {dsUrl.trim() !== dsUrlSaved && (
              <Button size="sm" onClick={saveDsUrl} disabled={dsUrlBusy}>
                {tc("action.save")}
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {t("apiKeys.deepseekUrl.hint")}
          </p>
        </div>
      </div>
      {error && <div className="mt-4 text-xs text-destructive">{error}</div>}
    </section>
  );
}

// =============================================================================
// Notifications
// =============================================================================

function NotificationsSection() {
  const { t } = useTranslation("settings");
  const {
    enabled,
    muteWhenFocused,
    events,
    permissionGranted,
    setEnabled,
    setMuteWhenFocused,
    setEvent,
  } = useNotificationPrefs();

  // Sync the cached permission state when the section opens.
  useEffect(() => {
    refreshPermission().catch(() => {});
  }, []);

  async function onToggleEnabled(v: boolean) {
    setEnabled(v);
    // Turning it on is the natural moment to ask for OS permission.
    if (v) await ensurePermission();
  }

  const blocked = enabled && permissionGranted === false;

  return (
    <section>
      <SectionHeading
        title={t("notifications.title")}
        description={t("notifications.description")}
      />

      <div className="mt-6 space-y-1">
        <ToggleRow
          id="notif-enabled"
          label={t("notifications.enable.label")}
          description={t("notifications.enable.description")}
          checked={enabled}
          onCheckedChange={onToggleEnabled}
        />
      </div>

      {blocked && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-warning/50 bg-warning/5 px-3 py-2 text-xs text-warning">
          <span>{t("notifications.blocked")}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => ensurePermission()}
          >
            {t("notifications.recheck")}
          </Button>
        </div>
      )}

      <div className="mt-6">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("notifications.notifyAbout")}
        </h3>
        <div
          className={cn(
            "mt-2 divide-y divide-border rounded-lg border border-border",
            !enabled && "pointer-events-none opacity-50",
          )}
        >
          {NOTIFY_EVENTS.map((evt) => (
            <ToggleRow
              key={evt.id}
              id={`notif-${evt.id}`}
              label={t(evt.labelKey)}
              description={t(evt.descriptionKey)}
              checked={events[evt.id]}
              onCheckedChange={(v) => setEvent(evt.id, v)}
              disabled={!enabled}
              boxed
            />
          ))}
        </div>
      </div>

      <div className="mt-6">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("notifications.behavior")}
        </h3>
        <div
          className={cn(
            "mt-2 rounded-lg border border-border",
            !enabled && "pointer-events-none opacity-50",
          )}
        >
          <ToggleRow
            id="notif-mute-focused"
            label={t("notifications.mute.label")}
            description={t("notifications.mute.description")}
            checked={muteWhenFocused}
            onCheckedChange={setMuteWhenFocused}
            disabled={!enabled}
            boxed
          />
        </div>
      </div>
    </section>
  );
}

// =============================================================================
// Permissions
// =============================================================================

// One place to see every OS permission cetus uses, what each unlocks, and its
// live status — instead of hunting across the Launcher / Voice / Screen /
// Meetings sections. Rows are shared with the first-run onboarding.
function PermissionsSection({ open }: { open: boolean }) {
  const { t } = useTranslation("settings");
  const { statuses, reload, onChanged } = usePermissionStatuses(open);

  return (
    <section>
      <SectionHeading
        title={t("permissions.title")}
        description={t("permissions.description")}
      />

      <div className="mt-6 divide-y divide-border rounded-lg border border-border">
        {APPLICABLE_PERMISSIONS.map((p) => (
          <PermissionRow
            key={p.id}
            meta={p}
            status={statuses[p.id]}
            onChanged={onChanged}
          />
        ))}
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        {t("permissions.note")}
      </p>

      <div className="mt-4">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => reload().catch(() => {})}
        >
          <RotateCw className="size-3.5" />
          {t("permissions.recheck")}
        </Button>
      </div>
    </section>
  );
}

// =============================================================================
// Launcher
// =============================================================================

function LauncherSection() {
  const { t } = useTranslation("settings");
  const [settings, setSettings] = useState<QuickSettings>(DEFAULT_QUICK_SETTINGS);
  const [trusted, setTrusted] = useState<boolean | null>(null);
  const [screenRec, setScreenRec] = useState<boolean | null>(null);
  const isMac =
    typeof navigator !== "undefined" &&
    /mac/i.test(navigator.platform || navigator.userAgent || "");

  useEffect(() => {
    api.getQuickSettings().then(setSettings).catch(() => {});
    api.accessibilityTrusted().then(setTrusted).catch(() => {});
    api.screenRecordingTrusted().then(setScreenRec).catch(() => {});
  }, []);

  function update(patch: Partial<QuickSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    api.setQuickSettings(next).catch(() => {});
  }

  async function onGrant() {
    const ok = await api.requestAccessibility().catch(() => false);
    setTrusted(ok);
  }

  async function onGrantScreen() {
    const ok = await api.requestScreenRecording().catch(() => false);
    setScreenRec(ok);
  }

  const gestureName = (g: QuickGesture) =>
    g === "off"
      ? t("launcher.gesture.opt.off")
      : g === "double_cmd"
        ? t("launcher.gesture.opt.double")
        : g === "double_opt"
          ? t("launcher.gesture.opt.doubleOpt")
          : g === "both_opt"
            ? t("launcher.gesture.opt.bothOpt")
            : t("launcher.gesture.opt.both");

  // Selectable triggers for each function. The picker for one function hides the
  // gesture already taken by the other so the two can't collide.
  const GESTURE_OPTS: QuickGesture[] = [
    "off",
    "both_cmd",
    "both_opt",
    "double_cmd",
    "double_opt",
  ];

  // The no-screenshot launcher is the "primary" one shown in the enable hint;
  // fall back to the screenshot one if it's off.
  const gestureLabel = gestureName(
    settings.gesturePlain !== "off" ? settings.gesturePlain : settings.gestureShot,
  );

  // Only the with-screenshot function needs Screen Recording permission.
  const wantsScreenshot = settings.gestureShot !== "off";

  return (
    <section>
      <SectionHeading
        title={t("launcher.title")}
        description={t("launcher.description")}
      />

      {isMac && trusted === false && (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-md border border-warning/50 bg-warning/5 px-3 py-2 text-xs text-warning">
          <span>{t("launcher.needAccessibility")}</span>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" onClick={onGrant}>
              {t("launcher.grantAccess")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => api.openAccessibilitySettings().catch(() => {})}
            >
              {t("launcher.openSettings")}
            </Button>
          </div>
        </div>
      )}
      {isMac && trusted === true && (
        <p className="mt-3 text-xs text-success">
          {t("launcher.accessibilityGranted")}
        </p>
      )}
      {isMac && wantsScreenshot && screenRec === false && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-warning/50 bg-warning/5 px-3 py-2 text-xs text-warning">
          <span>{t("launcher.needScreenRecording")}</span>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" onClick={onGrantScreen}>
              {t("launcher.grantAccess")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => api.openScreenRecordingSettings().catch(() => {})}
            >
              {t("launcher.openSettings")}
            </Button>
          </div>
        </div>
      )}
      {isMac && wantsScreenshot && screenRec === true && (
        <p className="mt-2 text-xs text-success">
          {t("launcher.screenRecordingGranted")}
        </p>
      )}
      {!isMac && (
        <p className="mt-3 text-xs text-muted-foreground">
          {t("launcher.macOnly")}
        </p>
      )}

      <div className="mt-6 space-y-1">
        <ToggleRow
          id="quick-enabled"
          label={t("launcher.enable.label")}
          description={t("launcher.enable.description", { gesture: gestureLabel })}
          checked={settings.enabled}
          onCheckedChange={(v) => update({ enabled: v })}
        />
      </div>

      <div
        className={cn(
          "mt-4 space-y-5",
          !settings.enabled && "pointer-events-none opacity-50",
        )}
      >
        {/* Two launchers, organized by function: each opens the same panel, one
            with a screenshot attached and one without — assign any gesture (or
            Off) to each. */}
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <Label className="font-medium">{t("launcher.fn.plain.label")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("launcher.fn.plain.description")}
            </p>
          </div>
          <Select
            value={settings.gesturePlain}
            onValueChange={(v) => update({ gesturePlain: v as QuickGesture })}
          >
            <SelectTrigger className="w-52 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GESTURE_OPTS.filter(
                (g) =>
                  g === "off" ||
                  g === settings.gesturePlain ||
                  g !== settings.gestureShot,
              ).map((g) => (
                <SelectItem key={g} value={g}>
                  {gestureName(g)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <Label className="font-medium">{t("launcher.fn.shot.label")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("launcher.fn.shot.description")}
            </p>
          </div>
          <Select
            value={settings.gestureShot}
            onValueChange={(v) => update({ gestureShot: v as QuickGesture })}
          >
            <SelectTrigger className="w-52 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GESTURE_OPTS.filter(
                (g) =>
                  g === "off" ||
                  g === settings.gestureShot ||
                  g !== settings.gesturePlain,
              ).map((g) => (
                <SelectItem key={g} value={g}>
                  {gestureName(g)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {isMac && (
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 space-y-0.5">
              <Label className="font-medium">{t("launcher.summon.label")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("launcher.summon.description")}
              </p>
            </div>
            <HotkeyRecorder
              value={settings.summonHotkey}
              onChange={(v) => update({ summonHotkey: v })}
              placeholder={t("launcher.summon.placeholder")}
              recordingLabel={t("launcher.summon.recording")}
              clearLabel={t("launcher.summon.clear")}
            />
          </div>
        )}

        <SegmentRow
          label={t("launcher.session.label")}
          description={t("launcher.session.description")}
          value={settings.sessionMode}
          onChange={(v) => update({ sessionMode: v as QuickSessionMode })}
          options={[
            { value: "new", label: t("launcher.session.opt.new") },
            { value: "last", label: t("launcher.session.opt.last") },
          ]}
        />

      </div>
    </section>
  );
}

// =============================================================================
// Appearance (theme)
// =============================================================================

function AppearanceSection() {
  const [theme, setThemeState] = useState<ThemePreference>(DEFAULT_THEME);
  const { t } = useTranslation("settings");

  // Reflect the persisted choice once we're in the browser (localStorage).
  useEffect(() => {
    setThemeState(getThemePreference());
  }, []);

  function chooseTheme(pref: ThemePreference) {
    setThemePreference(pref); // persists + toggles `.dark` live
    setThemeState(pref);
  }

  return (
    <section>
      <SectionHeading
        title={t("appearance.title")}
        description={t("appearance.description")}
      />

      <div className="mt-6 space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <Label className="font-medium">{t("appearance.theme.label")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("appearance.theme.description")}
            </p>
          </div>
          <Select
            value={theme}
            onValueChange={(v) => chooseTheme(v as ThemePreference)}
          >
            <SelectTrigger className="w-52 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THEME_OPTIONS.map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

    </section>
  );
}

// =============================================================================
// Keyboard shortcuts
// =============================================================================

function KeyboardShortcutsSection() {
  const { t } = useTranslation("settings");
  const [query, setQuery] = useState("");
  const [shortcuts, setShortcuts] = useState<ShortcutMap>(readKeyboardShortcuts);
  const defaults = defaultShortcutMap();

  const conflictById = useMemo(() => {
    const byAccelerator = new Map<string, ShortcutId[]>();
    for (const def of SHORTCUT_DEFINITIONS) {
      const value = shortcuts[def.id];
      if (!value) continue;
      byAccelerator.set(value, [...(byAccelerator.get(value) ?? []), def.id]);
    }
    const conflicts = new Map<ShortcutId, ShortcutId[]>();
    for (const ids of byAccelerator.values()) {
      if (ids.length < 2) continue;
      for (const id of ids) conflicts.set(id, ids.filter((other) => other !== id));
    }
    return conflicts;
  }, [shortcuts]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SHORTCUT_DEFINITIONS;
    return SHORTCUT_DEFINITIONS.filter((shortcut) => {
      const haystack = `${shortcut.label} ${shortcut.description} ${shortcutDisplay(
        shortcuts[shortcut.id],
      )}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [query, shortcuts]);

  function save(next: ShortcutMap) {
    setShortcuts(next);
    writeKeyboardShortcuts(next);
  }

  function update(id: ShortcutId, accelerator: string) {
    save({ ...shortcuts, [id]: accelerator });
  }

  function resetOne(id: ShortcutId) {
    update(id, defaults[id]);
  }

  function resetAll() {
    const next = defaultShortcutMap();
    setShortcuts(next);
    resetKeyboardShortcuts();
  }

  return (
    <section>
      <SectionHeading
        title={t("keyboard.title")}
        description={t("keyboard.description")}
      />

      <div className="mt-6 flex items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("keyboard.search")}
          className="max-w-sm bg-background"
        />
        <Button variant="outline" size="sm" className="gap-1.5" onClick={resetAll}>
          <RotateCw className="size-3.5" />
          {t("keyboard.resetAll")}
        </Button>
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border border-border bg-background">
        <div className="grid grid-cols-[minmax(0,1fr)_18rem] border-b border-border bg-muted/30 px-4 py-2 text-xs font-medium text-muted-foreground">
          <span>{t("keyboard.column.command")}</span>
          <span>{t("keyboard.column.keybinding")}</span>
        </div>
        {filtered.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            {t("keyboard.empty")}
          </p>
        ) : (
          filtered.map((shortcut) => {
            const value = shortcuts[shortcut.id];
            const conflictIds = conflictById.get(shortcut.id) ?? [];
            const conflictText = conflictIds
              .map((id) => SHORTCUT_DEFINITIONS.find((def) => def.id === id)?.label)
              .filter(Boolean)
              .join(", ");
            return (
              <div
                key={shortcut.id}
                className="grid grid-cols-[minmax(0,1fr)_18rem] items-center gap-4 border-b border-border px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{shortcut.label}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {shortcut.description}
                  </p>
                  {conflictText && (
                    <p className="mt-1 text-xs text-destructive">
                      {t("keyboard.conflict", { commands: conflictText })}
                    </p>
                  )}
                </div>
                <div className="flex min-w-0 items-center justify-end gap-1.5">
                  <HotkeyRecorder
                    value={value}
                    onChange={(v) => update(shortcut.id, v)}
                    placeholder={t("keyboard.unassigned")}
                    recordingLabel={t("launcher.summon.recording")}
                    clearLabel={t("keyboard.clear")}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground"
                    title={t("keyboard.reset")}
                    aria-label={t("keyboard.reset")}
                    disabled={value === defaults[shortcut.id]}
                    onClick={() => resetOne(shortcut.id)}
                  >
                    <RotateCw className="size-3.5" />
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

// =============================================================================
// Voice dictation
// =============================================================================

function VoiceSection() {
  const { t } = useTranslation("settings");
  const [settings, setSettings] = useState<QuickSettings>(DEFAULT_QUICK_SETTINGS);
  const [perms, setPerms] = useState<VoicePermissions | null>(null);
  const [trusted, setTrusted] = useState<boolean | null>(null);
  const isMac =
    typeof navigator !== "undefined" &&
    /mac/i.test(navigator.platform || navigator.userAgent || "");

  useEffect(() => {
    api
      .getQuickSettings()
      .then((s) =>
        setSettings({
          ...s,
          voiceInsertMode: "type",
          voiceCleanup: true,
          voiceCleanupModel: "",
          voiceBoostingTableId: "",
        }),
      )
      .catch(() => {});
    api.voicePermissions().then(setPerms).catch(() => {});
    api.accessibilityTrusted().then(setTrusted).catch(() => {});
  }, []);

  function update(patch: Partial<QuickSettings>) {
    const next = {
      ...settings,
      ...patch,
      voiceInsertMode: "type" as const,
      voiceCleanup: true,
      voiceCleanupModel: "",
      voiceBoostingTableId: "",
    };
    setSettings(next);
    api.setQuickSettings(next).catch(() => {});
  }

  // Dictation history (voice context) — opt-in store both the user and the agent
  // (via the recall_dictation tool) can read.
  const [transcripts, setTranscripts] = useState<TranscriptState>({
    enabled: false,
    entries: [],
  });
  useEffect(() => {
    api.listTranscripts().then(setTranscripts).catch(() => {});
  }, []);
  function setHistoryEnabled(enabled: boolean) {
    setTranscripts((t) => ({ ...t, enabled }));
    api.setTranscriptsEnabled(enabled).catch(() => {});
  }
  function clearHistory() {
    setTranscripts((t) => ({ ...t, entries: [] }));
    api.clearTranscripts().catch(() => {});
  }

  async function onGrantVoice() {
    const next = await api.requestVoicePermissions().catch(() => null);
    if (next) setPerms(next);
  }

  async function onGrantAx() {
    const ok = await api.requestAccessibility().catch(() => false);
    setTrusted(ok);
  }

  const micOk = perms?.mic === "authorized";
  const speechOk = perms?.speech === "authorized";
  const voiceReady = micOk && speechOk;

  const gestureLabel =
    settings.voiceGesture === "right_option"
      ? t("voice.gesture.rightOption")
      : settings.voiceGesture === "fn"
        ? t("voice.gesture.fn")
        : settings.voiceGesture === "caps_lock"
          ? t("voice.triggerKey.opt.capsLock")
          : t("voice.gesture.rightCmd");

  return (
    <section>
      <SectionHeading
        title={t("voice.title")}
        description={t("voice.description")}
      />

      {!isMac && (
        <p className="mt-3 text-xs text-muted-foreground">
          {t("voice.macOnly")}
        </p>
      )}

      {isMac && perms && !voiceReady && (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-md border border-warning/50 bg-warning/5 px-3 py-2 text-xs text-warning">
          <span>{t("voice.needPerms")}</span>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" onClick={onGrantVoice}>
              {t("voice.grantAccess")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => api.openMicrophoneSettings().catch(() => {})}
            >
              {t("voice.openSettings")}
            </Button>
          </div>
        </div>
      )}
      {isMac && voiceReady && (
        <p className="mt-3 text-xs text-success">
          {t("voice.permsGranted")}
        </p>
      )}

      {isMac && (
        <div className="mt-6">
          <SegmentRow
            label={t("voice.engine.label")}
            description={
              settings.voiceAsrEngine === "doubao"
                ? t("voice.engine.doubaoDesc")
                : t("voice.engine.appleDesc")
            }
            value={settings.voiceAsrEngine === "apple" ? "apple" : "doubao"}
            onChange={(v) => update({ voiceAsrEngine: v as VoiceAsrEngine })}
            options={[
              { value: "doubao", label: t("voice.engine.opt.doubao") },
              { value: "apple", label: t("voice.engine.opt.apple") },
            ]}
          />
        </div>
      )}

      <div className="mt-6 space-y-1">
        <ToggleRow
          id="voice-enabled"
          label={t("voice.enable.label")}
          description={t("voice.enable.description", { gesture: gestureLabel })}
          checked={settings.voiceEnabled}
          onCheckedChange={(v) => update({ voiceEnabled: v })}
        />
      </div>

      {isMac && settings.voiceEnabled && trusted === false && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-warning/50 bg-warning/5 px-3 py-2 text-xs text-warning">
          <span>{t("voice.needAccessibility")}</span>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" onClick={onGrantAx}>
              {t("voice.grantAccess")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => api.openAccessibilitySettings().catch(() => {})}
            >
              {t("voice.openSettings")}
            </Button>
          </div>
        </div>
      )}

      <div
        className={cn(
          "mt-4 space-y-5",
          !settings.voiceEnabled && "pointer-events-none opacity-50",
        )}
      >
        <div>
          <SegmentRow
            label={t("voice.triggerKey.label")}
            description={t("voice.triggerKey.holdDesc")}
            value={settings.voiceGesture}
            onChange={(v) => update({ voiceGesture: v as VoiceGesture })}
            options={[
              { value: "right_cmd", label: t("voice.triggerKey.opt.rightCmd") },
              {
                value: "right_option",
                label: t("voice.triggerKey.opt.rightOption"),
              },
              { value: "fn", label: t("voice.triggerKey.opt.fn") },
              { value: "caps_lock", label: t("voice.triggerKey.opt.capsLock") },
            ]}
          />
          {settings.voiceGesture === "caps_lock" && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t("voice.triggerKey.capsNote")}
            </p>
          )}
        </div>

        <div className="rounded-lg border border-border">
          <ToggleRow
            id="voice-start-sound"
            label={t("voice.startSound.label")}
            description={t("voice.startSound.description")}
            checked={settings.voiceStartSound}
            onCheckedChange={(v) => update({ voiceStartSound: v })}
            boxed
          />
        </div>

        {settings.voiceAsrEngine === "doubao" && (
          <div className="rounded-lg border border-border">
            <ToggleRow
              id="voice-context-biasing"
              label={t("voice.biasing.label")}
              description={t("voice.biasing.description")}
              checked={settings.voiceContextBiasing}
              onCheckedChange={(v) => update({ voiceContextBiasing: v })}
              boxed
            />
            {settings.voiceContextBiasing && (
              <div className="space-y-2 border-t border-border px-3 py-2.5">
                <Label htmlFor="voice-hotwords" className="text-xs font-medium">
                  {t("voice.biasing.hotwordsLabel")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("voice.biasing.hotwordsHint")}
                </p>
                <Textarea
                  id="voice-hotwords"
                  value={settings.voiceHotwords}
                  onChange={(e) => update({ voiceHotwords: e.target.value })}
                  placeholder={t("voice.biasing.hotwordsPlaceholder")}
                  rows={4}
                  className="text-xs"
                />
              </div>
            )}
          </div>
        )}
      </div>

      {isMac && (
        <div className="mt-6 rounded-lg border border-border">
          <ToggleRow
            id="dictation-history"
            label={t("voice.history.label")}
            description={t("voice.history.description")}
            checked={transcripts.enabled}
            onCheckedChange={setHistoryEnabled}
            boxed
          />
          {transcripts.enabled && (
            <div className="border-t border-border px-3 py-2.5">
              {transcripts.entries.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("voice.history.empty")}
                </p>
              ) : (
                <>
                  <div className="max-h-40 space-y-1 overflow-y-auto">
                    {[...transcripts.entries]
                      .reverse()
                      .slice(0, 50)
                      .map((e) => (
                        <p
                          key={e.id}
                          className="truncate text-xs text-muted-foreground"
                          title={e.text}
                        >
                          {e.text}
                        </p>
                      ))}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="mt-2 h-7 px-2 text-xs text-muted-foreground"
                    onClick={clearHistory}
                  >
                    {t("voice.history.clear", { n: transcripts.entries.length })}
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// =============================================================================
// Screen context (Rewind-like collection)
// =============================================================================

function ScreenContextSection({ onOpenHistory }: { onOpenHistory: () => void }) {
  const { t } = useTranslation("settings");
  const [settings, setSettings] = useState<CaptureSettings | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [excludedText, setExcludedText] = useState("");
  const isMac =
    typeof navigator !== "undefined" &&
    /mac/i.test(navigator.platform || navigator.userAgent || "");

  useEffect(() => {
    api
      .getCaptureSettings()
      .then((s) => {
        setSettings(s);
        setExcludedText(s.excludedApps.join(", "));
      })
      .catch(() => {});
    api.captureStats().then((st) => setCount(st.count)).catch(() => {});
  }, []);

  function update(patch: Partial<CaptureSettings>) {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      api.setCaptureSettings(next).catch(() => {});
      return next;
    });
  }

  function commitExcluded() {
    const apps = excludedText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    update({ excludedApps: apps });
  }

  if (!settings) return null;

  return (
    <section>
      <SectionHeading
        title={t("screen.title")}
        description={t("screen.description")}
      />

      {!isMac && (
        <p className="mt-3 text-xs text-muted-foreground">
          {t("screen.macOnly")}
        </p>
      )}

      <div className="mt-4">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={onOpenHistory}
        >
          <Monitor className="size-3.5" />
          {t("screen.browse")}
        </Button>
      </div>

      <div className="mt-6 space-y-1">
        <ToggleRow
          id="capture-enabled"
          label={t("screen.enable.label")}
          description={t("screen.enable.description")}
          checked={settings.enabled}
          onCheckedChange={(v) => update({ enabled: v })}
        />
      </div>

      <div
        className={cn(
          "mt-4 space-y-5",
          !settings.enabled && "pointer-events-none opacity-50",
        )}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <Label htmlFor="capture-interval" className="font-medium">
              {t("screen.interval.label")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("screen.interval.description")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Input
              id="capture-interval"
              type="number"
              min={2}
              className="w-20"
              value={settings.intervalSeconds}
              onChange={(e) =>
                update({
                  intervalSeconds: Math.max(2, Number(e.target.value) || 8),
                })
              }
            />
            <span className="text-xs text-muted-foreground">
              {t("screen.interval.unit")}
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <Label htmlFor="capture-retention" className="font-medium">
              {t("screen.retention.label")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("screen.retention.description")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Input
              id="capture-retention"
              type="number"
              min={0}
              className="w-20"
              value={settings.retentionDays}
              onChange={(e) =>
                update({
                  retentionDays: Math.max(0, Number(e.target.value) || 0),
                })
              }
            />
            <span className="text-xs text-muted-foreground">
              {t("screen.retention.unit")}
            </span>
          </div>
        </div>

        <div className="rounded-lg border border-border">
          <ToggleRow
            id="capture-ocr"
            label={t("screen.ocr.label")}
            description={t("screen.ocr.description")}
            checked={settings.ocrEnabled}
            onCheckedChange={(v) => update({ ocrEnabled: v })}
            boxed
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="capture-excluded" className="font-medium">
            {t("screen.excluded.label")}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t("screen.excluded.description")}
          </p>
          <Input
            id="capture-excluded"
            placeholder="1Password, Messages, com.apple.keychainaccess"
            value={excludedText}
            onChange={(e) => setExcludedText(e.target.value)}
            onBlur={commitExcluded}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitExcluded();
              }
            }}
          />
        </div>
      </div>

      {count !== null && (
        <p className="mt-6 text-xs text-muted-foreground">
          {count === 1
            ? t("screen.frames.one", { count: count.toLocaleString() })
            : t("screen.frames.other", { count: count.toLocaleString() })}
        </p>
      )}
    </section>
  );
}

// =============================================================================
// Meetings (ambient audio transcription)
// =============================================================================

function MeetingsSection({ open }: { open: boolean }) {
  const { t } = useTranslation("meeting");
  // The hotkey recorder reuses the summon shortcut's generic strings.
  const { t: tSettings } = useTranslation("settings");
  const [settings, setSettings] = useState<MeetingSettings | null>(null);
  const [status, setStatus] = useState<MeetingStatus | null>(null);
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Re-render tick that drives the live elapsed-time readout while recording.
  const [, setClock] = useState(0);
  const isMac =
    typeof navigator !== "undefined" &&
    /mac/i.test(navigator.platform || navigator.userAgent || "");

  const reload = useCallback(() => {
    api.listMeetings(50).then(setMeetings).catch(() => {});
    api.meetingStatus().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    api
      .getMeetingSettings()
      .then(setSettings)
      .catch(() => {});
    reload();
  }, [open, reload]);

  // While the section is visible, poll the live session (it can start/stop
  // underneath us via auto-detect or the hotkey) and tick the elapsed clock.
  // Idle polls keep the previous status reference (and skip the clock tick) so
  // they don't force a whole-section re-render every 2s when nothing changed.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => {
      api
        .meetingStatus()
        .then((next) => {
          setStatus((prev) =>
            prev &&
            prev.recording === next.recording &&
            prev.startedTs === next.startedTs &&
            prev.auto === next.auto &&
            prev.appHint === next.appHint &&
            prev.segments === next.segments
              ? prev
              : next,
          );
          if (next.recording) setClock((c) => c + 1);
        })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [open]);

  // A finished session lands its row (and, a beat later, its summary)
  // asynchronously — refresh the list when the backend says it saved.
  useEffect(() => {
    if (!open) return;
    let unlisten: (() => void) | undefined;
    onAppEvent((e) => {
      if (e.type === "meeting_event") reload();
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, [open, reload]);

  function update(patch: Partial<MeetingSettings>) {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      api.setMeetingSettings(next).catch(() => {});
      return next;
    });
  }

  async function onStart() {
    try {
      await api.meetingStart();
    } catch {
      // surfaced via status staying idle
    }
    api.meetingStatus().then(setStatus).catch(() => {});
  }

  async function onStop() {
    try {
      await api.meetingStop();
    } catch {
      // ignore; poll reconciles
    }
    reload();
  }

  if (!settings) return null;

  const recording = status?.recording ?? false;

  return (
    <section>
      <SectionHeading title={t("title")} description={t("description")} />

      {!isMac && (
        <p className="mt-3 text-xs text-muted-foreground">{t("macOnly")}</p>
      )}

      {/* Live session / manual control */}
      <div className="mt-4 flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-3">
        {recording && status?.startedTs ? (
          <>
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="relative flex size-2.5 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-60" />
                <span className="relative inline-flex size-2.5 rounded-full bg-destructive" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {t("status.recording")} {formatElapsed(status.startedTs)}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {status.auto
                    ? `${t("status.auto")}${status.appHint ? ` · ${status.appHint}` : ""}`
                    : t("status.manual")}
                  {" · "}
                  {t("status.segments", { count: String(status.segments) })}
                </p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={onStop}>
              {t("action.stop")}
            </Button>
          </>
        ) : (
          <>
            <div />
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={onStart}
              disabled={!settings.enabled || !isMac}
            >
              <AudioLines className="size-3.5" />
              {t("action.start")}
            </Button>
          </>
        )}
      </div>

      <div className="mt-6 space-y-1">
        <ToggleRow
          id="meeting-enabled"
          label={t("enable.label")}
          description={t("enable.description")}
          checked={settings.enabled}
          onCheckedChange={(v) => update({ enabled: v })}
        />
      </div>

      <div
        className={cn(
          "mt-4 space-y-5",
          !settings.enabled && "pointer-events-none opacity-50",
        )}
      >
        <div className="rounded-lg border border-border">
          <ToggleRow
            id="meeting-auto-detect"
            label={t("autoDetect.label")}
            description={t("autoDetect.description")}
            checked={settings.autoDetect}
            onCheckedChange={(v) => update({ autoDetect: v })}
            boxed
          />
          <div className="border-t border-border" />
          <ToggleRow
            id="meeting-system-audio"
            label={t("systemAudio.label")}
            description={t("systemAudio.description")}
            checked={settings.systemAudio}
            onCheckedChange={(v) => update({ systemAudio: v })}
            boxed
          />
          <div className="border-t border-border" />
          <ToggleRow
            id="meeting-summarize"
            label={t("summarize.label")}
            description={t("summarize.description")}
            checked={settings.summarize}
            onCheckedChange={(v) => update({ summarize: v })}
            boxed
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <Label htmlFor="meeting-retention" className="font-medium">
              {t("retention.label")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("retention.description")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Input
              id="meeting-retention"
              type="number"
              min={0}
              className="w-20"
              value={settings.retentionDays}
              onChange={(e) =>
                update({ retentionDays: Math.max(0, Number(e.target.value) || 0) })
              }
            />
            <span className="text-xs text-muted-foreground">
              {t("retention.unit")}
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <Label className="font-medium">{t("hotkey.label")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("hotkey.description")}
            </p>
          </div>
          <HotkeyRecorder
            value={settings.toggleHotkey}
            onChange={(v) => update({ toggleHotkey: v })}
            placeholder={tSettings("launcher.summon.placeholder")}
            recordingLabel={tSettings("launcher.summon.recording")}
            clearLabel={tSettings("launcher.summon.clear")}
          />
        </div>
      </div>

      {/* Recent meetings */}
      <div className="mt-8">
        <h3 className="text-sm font-semibold">{t("recent.title")}</h3>
        {meetings === null ? (
          <SettingsRowsSkeleton rows={2} />
        ) : meetings.length === 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">{t("recent.empty")}</p>
        ) : (
          <div className="mt-3 space-y-2">
            {meetings.map((m) => {
              const expanded = expandedId === m.id;
              const mins =
                m.endedTs != null
                  ? Math.max(1, Math.round((m.endedTs - m.startedTs) / 60_000))
                  : null;
              const when = new Date(m.startedTs).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              });
              return (
                <div key={m.id} className="rounded-lg border border-border">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left"
                    onClick={() => setExpandedId(expanded ? null : m.id)}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {m.title || t("untitled")}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {when}
                        {mins != null && ` · ${mins} min`}
                        {" · "}
                        {t("status.segments", {
                          count: String(m.segmentCount),
                        })}
                        {m.appName && ` · ${m.appName}`}
                      </p>
                    </div>
                    <ChevronDown
                      className={cn(
                        "size-4 shrink-0 text-muted-foreground transition-transform",
                        expanded && "rotate-180",
                      )}
                    />
                  </button>
                  {expanded && (
                    <div className="border-t border-border px-3 py-3">
                      {m.summary ? (
                        <div className="prose prose-sm dark:prose-invert max-w-none text-sm">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={markdownComponents}
                          >
                            {m.summary}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          {t("noSummary")}
                        </p>
                      )}
                      <div className="mt-2 flex justify-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="gap-1.5 text-muted-foreground hover:text-destructive"
                          onClick={() => {
                            api
                              .deleteMeeting(m.id)
                              .then(reload)
                              .catch(() => {});
                          }}
                        >
                          <Trash2 className="size-3.5" />
                          {t("delete.label")}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

// =============================================================================
// Archived chats
// =============================================================================

/** Opt-in auto-archive controls, shown atop the Archived chats page. */
function AutoArchiveSettingsBlock() {
  const { t } = useTranslation("settings");
  const [settings, setSettings] = useState<AutoArchiveSettings>(
    DEFAULT_AUTO_ARCHIVE_SETTINGS,
  );

  useEffect(() => {
    api.getAutoArchiveSettings().then(setSettings).catch(() => {});
  }, []);

  function update(patch: Partial<AutoArchiveSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    api.setAutoArchiveSettings(next).catch(() => {});
  }

  return (
    <div className="mt-6 rounded-lg border border-border p-4">
      <ToggleRow
        id="auto-archive-enabled"
        label={t("autoArchive.enable.label")}
        description={t("autoArchive.enable.description")}
        checked={settings.enabled}
        onCheckedChange={(v) => update({ enabled: v })}
      />

      <div
        className={cn(
          "mt-4 flex items-center justify-between gap-4",
          !settings.enabled && "pointer-events-none opacity-50",
        )}
      >
        <div className="min-w-0 space-y-0.5">
          <Label htmlFor="auto-archive-value" className="font-medium">
            {t("autoArchive.threshold.label")}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t("autoArchive.threshold.description")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Input
            id="auto-archive-value"
            type="number"
            min={1}
            className="w-20"
            value={settings.value}
            onChange={(e) =>
              update({ value: Math.max(1, Number(e.target.value) || 1) })
            }
          />
          <Select
            value={settings.unit}
            onValueChange={(v) =>
              update({ unit: v as AutoArchiveSettings["unit"] })
            }
          >
            <SelectTrigger className="w-24" id="auto-archive-unit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="hours">
                {t("autoArchive.unit.hours")}
              </SelectItem>
              <SelectItem value="days">
                {t("autoArchive.unit.days")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}

function ArchivedChatsSection({
  open,
  onConversationsChanged,
}: {
  open: boolean;
  onConversationsChanged?: () => void;
}) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation("common");
  const [chats, setChats] = useState<Conversation[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const all = await api.listConversations(true);
      const archived = all
        .filter((c) => c.archivedAt != null)
        .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
      setChats(archived);
    } catch (e) {
      setError(String(e));
    }
  }

  // (Re)load whenever the page is opened, so the list is fresh each visit.
  useEffect(() => {
    if (open) load();
  }, [open]);

  async function restore(c: Conversation) {
    setBusy(c.id);
    setError(null);
    try {
      await api.archiveConversation(c.id, false);
      setChats((cs) => (cs ? cs.filter((x) => x.id !== c.id) : cs));
      onConversationsChanged?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(c: Conversation) {
    setBusy(c.id);
    setError(null);
    try {
      await api.deleteConversation(c.id);
      setChats((cs) => (cs ? cs.filter((x) => x.id !== c.id) : cs));
      onConversationsChanged?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function deleteAll() {
    if (!chats?.length) return;
    setBusy("__all__");
    setError(null);
    try {
      await Promise.all(chats.map((c) => api.deleteConversation(c.id)));
      setChats([]);
      onConversationsChanged?.();
    } catch (e) {
      setError(String(e));
      // Reconcile against the backend — some may have been deleted.
      load();
    } finally {
      setBusy(null);
      setConfirmingAll(false);
    }
  }

  const count = chats?.length ?? 0;
  const deletingAll = busy === "__all__";

  return (
    <section>
      <SectionHeading
        title={t("archived.title")}
        description={t("archived.description")}
      />

      <AutoArchiveSettingsBlock />

      <div className="mt-6 flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          {chats === null
            ? t("archived.loading")
            : count === 0
              ? t("archived.empty")
              : count === 1
                ? t("archived.count.one", { count })
                : t("archived.count.other", { count })}
        </p>
        {count > 0 &&
          (confirmingAll ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {t("archived.deleteAllPrompt", { count })}
              </span>
              <Button
                size="sm"
                variant="destructive"
                onClick={deleteAll}
                disabled={deletingAll}
              >
                {deletingAll ? t("archived.deleting") : tc("action.confirm")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirmingAll(false)}
                disabled={deletingAll}
              >
                {tc("action.cancel")}
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 text-destructive hover:text-destructive"
              onClick={() => setConfirmingAll(true)}
            >
              <Trash2 className="size-3.5" />
              {t("archived.deleteAll")}
            </Button>
          ))}
      </div>

      {chats === null && <SettingsRowsSkeleton />}
      {count > 0 && (
        <div className="mt-4 divide-y divide-border rounded-lg border border-border">
          {chats!.map((c) => {
            const rowBusy = busy === c.id || deletingAll;
            return (
              <div
                key={c.id}
                className="flex items-center justify-between gap-3 px-3 py-2.5"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate text-sm font-medium">
                    {c.title || t("archived.untitled")}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {c.archivedAt
                      ? t("archived.archivedOn", {
                          date: new Date(c.archivedAt).toLocaleDateString(),
                        })
                      : null}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1.5"
                    onClick={() => restore(c)}
                    disabled={rowBusy}
                  >
                    <ArchiveRestore className="size-3.5" />
                    {t("archived.restore")}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => remove(c)}
                    disabled={rowBusy}
                    aria-label={t("archived.deleteAria")}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {error && <div className="mt-4 text-xs text-destructive">{error}</div>}
    </section>
  );
}

// =============================================================================
// Dreaming (idle-time memory consolidation)
// =============================================================================

function DreamingSection() {
  const { t } = useTranslation("settings");
  const [settings, setSettings] = useState<DreamSettings>(
    DEFAULT_DREAM_SETTINGS,
  );

  useEffect(() => {
    api.getDreamSettings().then(setSettings).catch(() => {});
  }, []);

  function update(patch: Partial<DreamSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    api.setDreamSettings(next).catch(() => {});
  }

  return (
    <section>
      <SectionHeading
        title={t("dreaming.title")}
        description={t("dreaming.description")}
      />

      <div className="mt-6 space-y-1">
        <ToggleRow
          id="dream-enabled"
          label={t("dreaming.enable.label")}
          description={t("dreaming.enable.description")}
          checked={settings.enabled}
          onCheckedChange={(v) => update({ enabled: v })}
        />
      </div>

      <div
        className={cn(
          "mt-4 space-y-5",
          !settings.enabled && "pointer-events-none opacity-50",
        )}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <Label htmlFor="dream-idle" className="font-medium">
              {t("dreaming.quiet.label")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("dreaming.quiet.description")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Input
              id="dream-idle"
              type="number"
              min={1}
              className="w-20"
              value={settings.idleMinutes}
              onChange={(e) =>
                update({
                  idleMinutes: Math.max(1, Number(e.target.value) || 15),
                })
              }
            />
            <span className="text-xs text-muted-foreground">
              {t("dreaming.quiet.unit")}
            </span>
          </div>
        </div>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        {t("dreaming.footnotePrefix")}
        <span className="rounded bg-skill/10 px-1 py-0.5 font-medium text-skill dark:text-skill">
          {t("dreaming.tagAgent")}
        </span>
        {t("dreaming.footnoteSuffix")}
      </p>
    </section>
  );
}

// =============================================================================
// Memory
// =============================================================================

function MemorySection({ open }: { open: boolean }) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation("common");
  const [store, setStore] = useState<MemoryState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [draftCategory, setDraftCategory] = useState("");
  const [adding, setAdding] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);

  const load = useCallback(async () => {
    try {
      setStore(await api.listMemories());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // (Re)load whenever the page is opened so edits made elsewhere are fresh.
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  // Live-refresh when memory changes underneath us: the agent's manage_memory
  // tool (rides the pi event stream) OR the dreaming pass (emits a dedicated
  // app-event, since it writes memory.json directly without a pi tool call).
  useEffect(() => {
    const unlisten: Array<() => void> = [];
    let cancelled = false;
    const track = (p: Promise<() => void>) =>
      p.then((fn) => {
        if (cancelled) fn();
        else unlisten.push(fn);
      });
    track(
      onPiEvent((e) => {
        if (
          e.type === "tool_execution_end" &&
          e.toolName === "manage_memory" &&
          !e.isError
        ) {
          load();
        }
      }),
    );
    track(
      onAppEvent((e) => {
        if (e.type === "memory_updated") load();
      }),
    );
    return () => {
      cancelled = true;
      unlisten.forEach((fn) => fn());
    };
  }, [load]);

  async function toggleMaster(v: boolean) {
    setStore((s) => (s ? { ...s, enabled: v } : s));
    setError(null);
    try {
      await api.setMemoryEnabled(v);
    } catch (e) {
      setError(String(e));
      load();
    }
  }

  async function add() {
    const content = draft.trim();
    if (!content) return;
    setAdding(true);
    setError(null);
    try {
      await api.createMemory(content, draftCategory.trim() || null);
      setDraft("");
      setDraftCategory("");
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  }

  async function saveRow(id: string, content: string, category: string) {
    setError(null);
    try {
      await api.updateMemory(id, { content, category });
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function toggleRow(id: string, enabled: boolean) {
    // Optimistic flip so the switch feels instant.
    setStore((s) =>
      s
        ? { ...s, entries: s.entries.map((m) => (m.id === id ? { ...m, enabled } : m)) }
        : s,
    );
    setError(null);
    try {
      await api.updateMemory(id, { enabled });
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
      await api.deleteMemory(id);
    } catch (e) {
      setError(String(e));
      load();
    }
  }

  async function clearAll() {
    setError(null);
    try {
      await api.clearMemories();
      setStore((s) => (s ? { ...s, entries: [] } : s));
    } catch (e) {
      setError(String(e));
      load();
    } finally {
      setConfirmingClear(false);
    }
  }

  // Newest first — most recently touched memories at the top.
  const sorted = useMemo(
    () => [...(store?.entries ?? [])].sort((a, b) => b.updatedAt - a.updatedAt),
    [store?.entries],
  );
  const masterOn = store?.enabled ?? true;

  return (
    <section>
      <SectionHeading
        title={t("memory.title")}
        description={t("memory.description")}
      />

      <div className="mt-6 space-y-1">
        <ToggleRow
          id="memory-enabled"
          label={t("memory.enable.label")}
          description={t("memory.enable.description")}
          checked={masterOn}
          onCheckedChange={toggleMaster}
        />
      </div>

      {/* Add a memory */}
      <div
        className={cn(
          "mt-4 space-y-2 rounded-lg border border-border p-3",
          !masterOn && "opacity-60",
        )}
      >
        <Label htmlFor="memory-add" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("memory.add.label")}
        </Label>
        <Textarea
          id="memory-add"
          placeholder={t("memory.add.placeholder")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <div className="flex items-center gap-2">
          <Input
            placeholder={t("memory.category.placeholder")}
            value={draftCategory}
            onChange={(e) => setDraftCategory(e.target.value)}
            className="h-8 flex-1 text-sm"
          />
          <Button
            size="sm"
            className="gap-1.5"
            onClick={add}
            disabled={!draft.trim() || adding}
          >
            <Plus className="size-3.5" />
            {adding ? t("memory.adding") : t("memory.add.button")}
          </Button>
        </div>
      </div>

      {/* Existing memories */}
      <div className="mt-6 flex items-center justify-between gap-4">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {store === null
            ? t("memory.loading")
            : sorted.length === 0
              ? t("memory.empty")
              : sorted.length === 1
                ? t("memory.count.one", { count: sorted.length })
                : t("memory.count.other", { count: sorted.length })}
        </h3>
        {sorted.length > 0 &&
          (confirmingClear ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {t("memory.deleteAllPrompt")}
              </span>
              <Button size="sm" variant="destructive" onClick={clearAll}>
                {tc("action.confirm")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirmingClear(false)}
              >
                {tc("action.cancel")}
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 text-destructive hover:text-destructive"
              onClick={() => setConfirmingClear(true)}
            >
              <Trash2 className="size-3.5" />
              {t("memory.clearAll")}
            </Button>
          ))}
      </div>

      {store === null && <SettingsRowsSkeleton />}
      {sorted.length > 0 && (
        <SettingsCardGrid className="mt-3">
          {sorted.map((m) => (
            <MemoryRow
              key={m.id}
              entry={m}
              onSave={saveRow}
              onToggle={toggleRow}
              onDelete={removeRow}
            />
          ))}
        </SettingsCardGrid>
      )}

      {error && <div className="mt-4 text-xs text-destructive">{error}</div>}
    </section>
  );
}

function MemoryRow({
  entry,
  onSave,
  onToggle,
  onDelete,
}: {
  entry: MemoryEntry;
  onSave: (id: string, content: string, category: string) => Promise<void>;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation("common");
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(entry.content);
  const [category, setCategory] = useState(entry.category ?? "");
  const [busy, setBusy] = useState(false);

  // Re-sync buffers when the entry changes underneath us (live refresh), but
  // never clobber an in-progress edit.
  useEffect(() => {
    if (!editing) {
      setContent(entry.content);
      setCategory(entry.category ?? "");
    }
  }, [entry, editing]);

  async function save() {
    const c = content.trim();
    if (!c) return;
    setBusy(true);
    await onSave(entry.id, c, category.trim());
    setBusy(false);
    setEditing(false);
  }

  function cancel() {
    setContent(entry.content);
    setCategory(entry.category ?? "");
    setEditing(false);
  }

  const agentAuthored = entry.source === "agent";

  if (editing) {
    return (
      <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={2}
          autoFocus
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              cancel();
            }
          }}
        />
        <div className="flex items-center gap-2">
          <Input
            placeholder={t("memory.category.placeholder")}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="h-8 flex-1 text-sm"
          />
          <Button size="sm" onClick={save} disabled={!content.trim() || busy}>
            {busy ? t("memory.saving") : t("memory.save")}
          </Button>
          <Button size="sm" variant="outline" onClick={cancel} disabled={busy}>
            {tc("action.cancel")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group min-w-0 overflow-hidden rounded-lg border border-border bg-card px-3 py-2.5",
        !entry.enabled && "opacity-50",
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="break-words text-sm leading-snug">{entry.content}</p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span
              className={cn(
                "rounded px-1.5 py-0.5 font-medium",
                agentAuthored
                  ? "bg-skill/10 text-skill dark:text-skill"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {agentAuthored ? t("memory.tag.agent") : t("memory.tag.you")}
            </span>
            {entry.category && (
              <span className="rounded bg-muted px-1.5 py-0.5">
                {entry.category}
              </span>
            )}
            <span>
              {t("memory.editedOn", {
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
              entry.enabled ? t("memory.muteAria") : t("memory.enableAria")
            }
          />
          <Button
            size="icon"
            variant="ghost"
            className="size-8 text-muted-foreground"
            onClick={() => setEditing(true)}
            aria-label={t("memory.editAria")}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-8 text-muted-foreground hover:text-destructive"
            onClick={() => onDelete(entry.id)}
            aria-label={t("memory.deleteAria")}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Skills (Agent Skills standard)
// =============================================================================

function SkillsSection({ open }: { open: boolean }) {
  const { t } = useTranslation("settings");
  const [store, setStore] = useState<SkillState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const [review, setReview] = useState<SkillReviewSettings>(
    DEFAULT_SKILL_REVIEW_SETTINGS,
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      setStore(await api.listSkills());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (open) {
      load();
      api.getSkillReviewSettings().then(setReview).catch(() => {});
    }
  }, [open, load]);

  // Live-refresh when the background skill-review pass proposes new skills (it
  // writes the library directly, so it emits a dedicated app-event).
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

  function updateReview(patch: Partial<SkillReviewSettings>) {
    const next = { ...review, ...patch };
    setReview(next);
    api.setSkillReviewSettings(next).catch(() => {});
  }

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
        ? { ...s, entries: s.entries.map((m) => (m.id === id ? { ...m, enabled } : m)) }
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
    setStore((s) => (s ? { ...s, entries: s.entries.filter((m) => m.id !== id) } : s));
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
        <ToggleRow
          id="skills-review-enabled"
          label={t("skills.review.label")}
          description={t("skills.review.description")}
          checked={review.enabled}
          onCheckedChange={(v) => updateReview({ enabled: v })}
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
          onClick={() => api.openExternal("https://agentskills.io").catch(() => {})}
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
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
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
          <SettingsCardGrid className="mt-3">
            {sorted.map((s) => (
              <SkillRow
                key={s.id}
                entry={s}
                onToggle={toggleRow}
                onReveal={(id) => api.revealSkill(id).catch((e) => setError(String(e)))}
                onDelete={removeRow}
              />
            ))}
          </SettingsCardGrid>
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
            discovery && saveDiscovery({ ...discovery, skillsLoadDiscovered: v })
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
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
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
                  api.revealDiscoveredSkill(id).catch((e) => setError(String(e)))
                }
              />
            ))}
            {userSkills.length > 0 && (
              <DiscoveredSkillGroup
                title={t("skills.discovered.userTitle")}
                root={discovery?.skillsFolder}
                skills={userSkills}
                onReveal={(id) =>
                  api.revealDiscoveredSkill(id).catch((e) => setError(String(e)))
                }
              />
            )}
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
        <h5 className="shrink-0 text-xs font-medium text-foreground">{title}</h5>
        {root && (
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {root}
          </span>
        )}
      </div>
      <SettingsCardGrid>
        {skills.map((s) => (
          <DiscoveredSkillRow key={s.id} skill={s} onReveal={onReveal} />
        ))}
      </SettingsCardGrid>
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
    <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-start gap-3 px-3 py-2.5">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
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
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
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
              className={cn("size-4 transition-transform", expanded && "rotate-180")}
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
        <div className="border-t border-border px-3 py-3">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <FileText className="size-3" />
            <span className="truncate font-mono">{skill.path}</span>
          </div>
          {loadError ? (
            <div className="text-xs text-destructive">{loadError}</div>
          ) : body === null ? (
            <div className="text-xs text-muted-foreground">{t("skills.loading")}</div>
          ) : (
            <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-2 prose-pre:my-2 prose-ul:my-2 prose-ol:my-2 prose-headings:my-3 prose-pre:bg-secondary prose-pre:text-foreground prose-code:rounded prose-code:bg-secondary prose-code:px-1 prose-code:py-0.5 prose-code:before:content-none prose-code:after:content-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
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
      className={cn(
        "group min-w-0 overflow-hidden rounded-lg border border-border bg-card px-3 py-2.5",
        !entry.enabled && "opacity-50",
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="truncate text-sm font-medium">{entry.name}</p>
          {entry.description && (
            <p className="text-xs leading-snug text-muted-foreground">
              {entry.description}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
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
      <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
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
        <Button size="sm" variant="outline" onClick={onCancel} disabled={saving}>
          {tc("action.cancel")}
        </Button>
      </div>
    </div>
  );
}

// =============================================================================
// Slash commands (local prompt snippets)
// =============================================================================

/** Manage user-defined slash commands — reusable prompt snippets triggered by
 *  typing `/<name>` in the composer. Stored locally; they sit alongside skills in
 *  the composer's slash menu (distinct icon). Create/edit/delete here. */
function SlashCommandsSection({ open }: { open: boolean }) {
  const { t } = useTranslation("settings");
  const [commands, setCommands] = useState<SlashCommand[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null = closed; "new" = creating; a command = editing it.
  const [editing, setEditing] = useState<SlashCommand | "new" | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setCommands(await api.listSlashCommands());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  async function removeRow(id: string) {
    setCommands((cs) => (cs ? cs.filter((c) => c.id !== id) : cs));
    setError(null);
    try {
      await api.deleteSlashCommand(id);
    } catch (e) {
      setError(String(e));
      load();
    }
  }

  const sorted = useMemo(
    () => [...(commands ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [commands],
  );

  return (
    <section>
      <SectionHeading
        title={t("slashCmd.title")}
        description={t("slashCmd.description")}
      />

      <div className="mt-6">
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={() => setEditing("new")}
        >
          <Plus className="size-3.5" />
          {t("slashCmd.new")}
        </Button>
      </div>

      {editing && (
        <SlashCommandEditor
          command={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
          onError={setError}
        />
      )}

      <div className="mt-6">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {commands === null
            ? t("slashCmd.loading")
            : sorted.length === 0
              ? t("slashCmd.empty")
              : sorted.length === 1
                ? t("slashCmd.count.one", { count: sorted.length })
                : t("slashCmd.count.other", { count: sorted.length })}
        </h3>

        {commands === null && <SettingsRowsSkeleton />}
        {sorted.length > 0 && (
          <SettingsCardGrid className="mt-3">
            {sorted.map((c) => (
              <SlashCommandRow
                key={c.id}
                command={c}
                onEdit={() => setEditing(c)}
                onDelete={removeRow}
              />
            ))}
          </SettingsCardGrid>
        )}
      </div>

      {error && <div className="mt-4 text-xs text-destructive">{error}</div>}
    </section>
  );
}

function SlashCommandRow({
  command,
  onEdit,
  onDelete,
}: {
  command: SlashCommand;
  onEdit: () => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation("common");
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="group min-w-0 overflow-hidden rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="flex min-w-0 items-start gap-3">
        <SquareSlash className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="truncate text-sm font-medium">/{command.name}</p>
          {command.description && (
            <p className="text-xs leading-snug text-muted-foreground">
              {command.description}
            </p>
          )}
          <p className="line-clamp-2 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-muted-foreground/80">
            {command.prompt}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            size="icon"
            variant="ghost"
            className="size-8 text-muted-foreground"
            onClick={onEdit}
            aria-label={t("slashCmd.editAria")}
          >
            <Pencil className="size-3.5" />
          </Button>
          {confirming ? (
            <>
              <Button
                size="sm"
                variant="destructive"
                className="h-8"
                onClick={() => onDelete(command.id)}
              >
                {t("slashCmd.delete")}
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
              aria-label={t("slashCmd.deleteAria")}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function SlashCommandEditor({
  command,
  onCancel,
  onSaved,
  onError,
}: {
  command: SlashCommand | null;
  onCancel: () => void;
  onSaved: () => void;
  onError: (e: string) => void;
}) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation("common");
  const [name, setName] = useState(command?.name ?? "");
  const [description, setDescription] = useState(command?.description ?? "");
  const [prompt, setPrompt] = useState(command?.prompt ?? "");
  const [saving, setSaving] = useState(false);

  const valid = name.trim().length > 0 && prompt.trim().length > 0;

  async function save() {
    if (!valid) return;
    setSaving(true);
    try {
      await api.upsertSlashCommand({
        id: command?.id,
        name: name.trim(),
        description: description.trim(),
        prompt,
      });
      onSaved();
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-4 space-y-2 rounded-lg border border-border bg-muted/30 p-3">
      <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {command ? t("slashCmd.editor.editTitle") : t("slashCmd.editor.newTitle")}
      </Label>
      <div className="flex items-center gap-1.5 rounded-md border border-border bg-background pl-2.5">
        <span className="text-sm text-muted-foreground">/</span>
        <Input
          placeholder={t("slashCmd.editor.namePlaceholder")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          className="border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
        />
      </div>
      <Input
        placeholder={t("slashCmd.editor.descPlaceholder")}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <Textarea
        placeholder={t("slashCmd.editor.promptPlaceholder")}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={5}
        className="text-sm"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={!valid || saving}>
          {saving ? t("slashCmd.editor.saving") : t("slashCmd.editor.save")}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={saving}>
          {tc("action.cancel")}
        </Button>
      </div>
    </div>
  );
}

// =============================================================================
// MCP servers
// =============================================================================

function ConnectorsSection({ open }: { open: boolean }) {
  const { t } = useTranslation("settings");
  const [list, setList] = useState<McpConnector[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // id | "new" | null

  const load = useCallback(async () => {
    setError(null);
    try {
      setList(await api.listConnectors());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    onAppEvent((e) => {
      if (e.type === "mcp_updated") load();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [load]);

  async function toggle(id: string, enabled: boolean) {
    setList((cs) => (cs ? cs.map((c) => (c.id === id ? { ...c, enabled } : c)) : cs));
    setError(null);
    try {
      await api.setConnectorEnabled(id, enabled);
    } catch (e) {
      setError(String(e));
      load();
    }
  }

  async function remove(id: string) {
    setList((cs) => (cs ? cs.filter((c) => c.id !== id) : cs));
    setError(null);
    try {
      await api.removeConnector(id);
    } catch (e) {
      setError(String(e));
      load();
    }
  }

  const connectors = list ?? [];

  return (
    <section>
      <SectionHeading
        title={t("connectors.title")}
        description={t("connectors.description")}
      />

      <div className="mt-6 flex items-center justify-between gap-4">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {list === null
            ? t("connectors.loading")
            : connectors.length === 0
              ? t("connectors.empty")
              : connectors.length === 1
                ? t("connectors.count.one", { count: connectors.length })
                : t("connectors.count.other", { count: connectors.length })}
        </h3>
        {editing !== "new" && (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => setEditing("new")}
          >
            <Plus className="size-3.5" />
            {t("connectors.add")}
          </Button>
        )}
      </div>

      {editing === "new" && (
        <ConnectorEditor
          initial={null}
          onCancel={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
          onError={setError}
        />
      )}

      {list === null && <SettingsRowsSkeleton />}
      {connectors.length > 0 && (
        <SettingsCardGrid className="mt-3">
          {connectors.map((c) =>
            editing === c.id ? (
              <ConnectorEditor
                key={c.id}
                initial={c}
                onCancel={() => setEditing(null)}
                onSaved={async () => {
                  setEditing(null);
                  await load();
                }}
                onError={setError}
              />
            ) : (
              <ConnectorRow
                key={c.id}
                connector={c}
                onToggle={toggle}
                onEdit={() => setEditing(c.id)}
                onRemove={remove}
              />
            ),
          )}
        </SettingsCardGrid>
      )}

      <DiscoveredMcpCard open={open} onError={setError} />

      {error && <div className="mt-4 text-xs text-destructive">{error}</div>}
    </section>
  );
}

/** mcporter `imports` sources, with the user-facing label. */
const MCP_IMPORT_SOURCES: { id: McpImportSource; label: string }[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "claude-desktop", label: "Claude Desktop" },
  { id: "cursor", label: "Cursor" },
  { id: "vscode", label: "VS Code" },
  { id: "windsurf", label: "Windsurf" },
  { id: "codex", label: "Codex" },
  { id: "opencode", label: "opencode" },
];

/**
 * Opt-in import of MCP servers configured in other apps. mcporter can only pull
 * from these named editor configs (not an arbitrary folder). Changes only reach
 * conversations created afterward (per-conversation freeze).
 */
function DiscoveredMcpCard({
  open,
  onError,
}: {
  open: boolean;
  onError: (e: string | null) => void;
}) {
  const { t } = useTranslation("settings");
  const [settings, setSettings] = useState<DiscoverySettings | null>(null);
  // Imported servers per source, fetched on demand: undefined = not yet loaded.
  const [imports, setImports] = useState<
    Record<string, McpImportEntry[] | "loading">
  >({});

  const fetchImport = useCallback(async (id: McpImportSource) => {
    setImports((m) => ({ ...m, [id]: "loading" }));
    try {
      const entries = await api.previewMcpImport(id);
      setImports((m) => ({ ...m, [id]: entries }));
    } catch {
      setImports((m) => ({ ...m, [id]: [] }));
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const s = await api.getDiscoverySettings();
      setSettings(s);
      s.mcpImports.forEach(fetchImport);
    } catch (e) {
      onError(String(e));
    }
  }, [onError, fetchImport]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  async function toggleSource(id: McpImportSource, on: boolean) {
    if (!settings) return;
    const mcpImports = on
      ? [...settings.mcpImports, id]
      : settings.mcpImports.filter((s) => s !== id);
    const next = { ...settings, mcpImports };
    setSettings(next);
    if (on) fetchImport(id);
    try {
      await api.setDiscoverySettings(next);
    } catch (e) {
      onError(String(e));
      load();
    }
  }

  const enabled = settings?.mcpImports ?? [];

  return (
    <div className="mt-6 overflow-hidden rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-medium">{t("discovery.mcp.title")}</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("discovery.mcp.description")}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {MCP_IMPORT_SOURCES.map((src) => {
          const on = enabled.includes(src.id);
          return (
            <button
              key={src.id}
              type="button"
              disabled={!settings}
              onClick={() => toggleSource(src.id, !on)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                on
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {src.label}
            </button>
          );
        })}
      </div>

      {enabled.length > 0 && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          {enabled.map((id) => {
            const label =
              MCP_IMPORT_SOURCES.find((s) => s.id === id)?.label ?? id;
            const entries = imports[id];
            return (
              <div key={id} className="text-xs">
                <p className="font-medium text-muted-foreground">{label}</p>
                {entries === "loading" || entries === undefined ? (
                  <p className="text-muted-foreground">
                    {t("connectors.details.loading")}
                  </p>
                ) : entries.length === 0 ? (
                  <p className="text-muted-foreground">
                    {t("discovery.mcp.none")}
                  </p>
                ) : (
                  <ul className="mt-0.5 space-y-0.5">
                    {entries.map((e) => (
                      <li key={e.name} className="leading-snug">
                        <span className="font-mono text-foreground">
                          {e.name}
                        </span>
                        {e.detail ? (
                          <span className="text-muted-foreground">
                            {" — "}
                            {e.detail}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ConnectorRow({
  connector,
  onToggle,
  onEdit,
  onRemove,
}: {
  connector: McpConnector;
  onToggle: (id: string, enabled: boolean) => void;
  onEdit: () => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation("common");
  const [confirming, setConfirming] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const summary =
    connector.transport === "http"
      ? connector.url
      : [connector.command, ...connector.args].join(" ");
  return (
    <div
      className={cn(
        "min-w-0 overflow-hidden rounded-lg border border-border bg-card",
        !connector.enabled && "opacity-50",
      )}
    >
      <div className="flex items-start gap-3 px-3 py-2.5">
        <ServerCog className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium">{connector.name}</p>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              {connector.transport === "http" ? "HTTP" : "stdio"}
            </span>
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {summary || "—"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            size="icon"
            variant="ghost"
            className="size-8 text-muted-foreground"
            onClick={() => setExpanded((v) => !v)}
            aria-label={t("connectors.details.toggleAria")}
            aria-expanded={expanded}
          >
            <ChevronDown
              className={cn(
                "size-4 transition-transform",
                expanded && "rotate-180",
              )}
            />
          </Button>
          <Switch
            checked={connector.enabled}
            onCheckedChange={(v) => onToggle(connector.id, v)}
            aria-label={
              connector.enabled
                ? t("connectors.disableAria")
                : t("connectors.enableAria")
            }
          />
          <Button
            size="icon"
            variant="ghost"
            className="size-8 text-muted-foreground"
            onClick={onEdit}
            aria-label={t("connectors.editAria")}
          >
            <Pencil className="size-3.5" />
          </Button>
          {confirming ? (
            <>
              <Button
                size="sm"
                variant="destructive"
                className="h-8"
                onClick={() => onRemove(connector.id)}
              >
                {tc("action.remove")}
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
              aria-label={t("connectors.removeAria")}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
      {expanded && <ConnectorDetails connector={connector} />}
    </div>
  );
}

/**
 * The expandable detail panel under a saved MCP server: runs a live handshake
 * (initialize + tools/list) on open and lists the server identity and the tools
 * it exposes (name + description). Re-probes when the MCP server changes.
 */
function ConnectorDetails({ connector }: { connector: McpConnector }) {
  const { t } = useTranslation("settings");
  const [result, setResult] = useState<McpTestResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [authorizing, setAuthorizing] = useState(false);
  const [authMsg, setAuthMsg] = useState<string | null>(null);
  const isOauth = connector.auth === "oauth";

  const probe = useCallback(async () => {
    setLoading(true);
    setResult(null);
    try {
      setResult(await api.testConnector(connectorToInput(connector)));
    } catch (e) {
      setResult({
        ok: false,
        serverName: null,
        serverVersion: null,
        protocolVersion: null,
        tools: [],
        error: String(e),
      });
    } finally {
      setLoading(false);
    }
  }, [connector]);

  useEffect(() => {
    probe();
  }, [probe]);

  async function authorize() {
    setAuthorizing(true);
    setAuthMsg(null);
    try {
      await api.authorizeConnector(connectorToInput(connector));
      setAuthMsg(t("connectors.oauth.authorized"));
      await probe();
    } catch (e) {
      setAuthMsg(String(e));
    } finally {
      setAuthorizing(false);
    }
  }

  return (
    <div className="space-y-2 border-t border-border px-3 py-2.5 text-xs">
      {isOauth && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={authorize}
            disabled={authorizing}
          >
            <KeyRound
              className={cn("size-3.5", authorizing && "animate-pulse")}
            />
            {authorizing
              ? t("connectors.oauth.authorizing")
              : t("connectors.oauth.authorize")}
          </Button>
          {authMsg && (
            <span className="text-muted-foreground">{authMsg}</span>
          )}
        </div>
      )}
      {loading ? (
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <RotateCw className="size-3.5 animate-spin" />
          {t("connectors.details.loading")}
        </div>
      ) : result && result.ok ? (
        <div className="space-y-2">
          <p className="text-muted-foreground">
            {result.serverName ? (
              <span className="font-medium text-foreground">
                {result.serverName}
                {result.serverVersion ? ` v${result.serverVersion}` : ""}
              </span>
            ) : (
              t("connectors.details.connected")
            )}
            {result.protocolVersion ? ` · MCP ${result.protocolVersion}` : ""}
          </p>
          {result.tools.length > 0 ? (
            <div className="space-y-1.5">
              <p className="font-medium text-foreground">
                {result.tools.length === 1
                  ? t("connectors.details.toolCount.one", {
                      count: result.tools.length,
                    })
                  : t("connectors.details.toolCount.other", {
                      count: result.tools.length,
                    })}
              </p>
              <ul className="space-y-1">
                {result.tools.map((tool) => (
                  <li key={tool.name} className="leading-snug">
                    <span className="font-mono text-foreground">
                      {tool.name}
                    </span>
                    {tool.description ? (
                      <span className="text-muted-foreground">
                        {" — "}
                        {tool.description}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-muted-foreground">
              {t("connectors.test.noTools")}
            </p>
          )}
        </div>
      ) : (
        <p className="text-destructive">
          {result?.error ?? t("connectors.test.failed")}
        </p>
      )}
    </div>
  );
}

/** One editable key/value pair (an env var or a request header). */
type KeyValuePair = { key: string; value: string };

function recordToPairs(rec: Record<string, string>): KeyValuePair[] {
  return Object.entries(rec).map(([key, value]) => ({ key, value }));
}

/** Collapse the editor rows back into a record, dropping rows with no key. */
function pairsToRecord(pairs: KeyValuePair[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of pairs) {
    const k = key.trim();
    if (k) out[k] = value.trim();
  }
  return out;
}

/** Comma-joined first 8 tool names, with an ellipsis when there are more. */
function toolNamesPreview(tools: McpToolInfo[]): string {
  const names = tools
    .slice(0, 8)
    .map((tool) => tool.name)
    .join(", ");
  return tools.length > 8 ? `${names}…` : names;
}

function connectorToInput(c: McpConnector): McpConnectorInput {
  return {
    name: c.name,
    transport: c.transport,
    command: c.command,
    args: c.args,
    env: c.env,
    url: c.url,
    headers: c.headers,
    auth: c.auth,
    oauthClientId: c.oauthClientId,
    oauthScope: c.oauthScope,
    enabled: c.enabled,
  };
}

/**
 * A small editor for a list of key/value pairs (env vars, request headers): one
 * row per pair with separate Name and Value inputs, an X to drop a row, and an
 * Add button to append a blank one. Replaces the old "KEY: value, one per line"
 * textarea so users don't have to know the separator.
 */
function KeyValueRows({
  pairs,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  removeAria,
}: {
  pairs: KeyValuePair[];
  onChange: (next: KeyValuePair[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
  removeAria: string;
}) {
  return (
    <div className="space-y-1.5">
      {pairs.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            placeholder={keyPlaceholder}
            value={p.key}
            onChange={(e) =>
              onChange(
                pairs.map((q, idx) =>
                  idx === i ? { ...q, key: e.target.value } : q,
                ),
              )
            }
            className="font-mono text-xs"
          />
          <Input
            placeholder={valuePlaceholder}
            value={p.value}
            onChange={(e) =>
              onChange(
                pairs.map((q, idx) =>
                  idx === i ? { ...q, value: e.target.value } : q,
                ),
              )
            }
            className="font-mono text-xs"
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={() => onChange(pairs.filter((_, idx) => idx !== i))}
            aria-label={removeAria}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="gap-1.5"
        onClick={() => onChange([...pairs, { key: "", value: "" }])}
      >
        <Plus className="size-3.5" />
        {addLabel}
      </Button>
    </div>
  );
}

function ConnectorEditor({
  initial,
  onCancel,
  onSaved,
  onError,
}: {
  initial: McpConnector | null;
  onCancel: () => void;
  onSaved: () => void;
  onError: (e: string) => void;
}) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation("common");
  const [name, setName] = useState(initial?.name ?? "");
  const [transport, setTransport] = useState<McpTransport>(
    initial?.transport ?? "stdio",
  );
  const [command, setCommand] = useState(initial?.command ?? "");
  const [argsText, setArgsText] = useState((initial?.args ?? []).join("\n"));
  const [envPairs, setEnvPairs] = useState<KeyValuePair[]>(
    recordToPairs(initial?.env ?? {}),
  );
  const [url, setUrl] = useState(initial?.url ?? "");
  const [headerPairs, setHeaderPairs] = useState<KeyValuePair[]>(
    recordToPairs(initial?.headers ?? {}),
  );
  const [auth, setAuth] = useState(initial?.auth === "oauth" ? "oauth" : "none");
  const [oauthClientId, setOauthClientId] = useState(initial?.oauthClientId ?? "");
  const [oauthScope, setOauthScope] = useState(initial?.oauthScope ?? "");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);

  function buildInput(): McpConnectorInput {
    return {
      name: name.trim(),
      transport,
      command: command.trim(),
      args: argsText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      env: pairsToRecord(envPairs),
      url: url.trim(),
      headers: pairsToRecord(headerPairs),
      auth: transport === "http" && auth === "oauth" ? "oauth" : "",
      oauthClientId: oauthClientId.trim(),
      oauthScope: oauthScope.trim(),
      enabled: initial?.enabled ?? true,
    };
  }

  async function save() {
    setSaving(true);
    onError("");
    try {
      const input = buildInput();
      if (initial) await api.updateConnector(initial.id, input);
      else await api.addConnector(input);
      onSaved();
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.testConnector(buildInput()));
    } catch (e) {
      setTestResult({
        ok: false,
        serverName: null,
        serverVersion: null,
        protocolVersion: null,
        tools: [],
        error: String(e),
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-border bg-muted/30 p-3">
      <div className="space-y-1.5">
        <Label className="text-xs font-medium">{t("connectors.editor.name")}</Label>
        <Input
          placeholder={t("connectors.editor.namePlaceholder")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
      </div>

      <SegmentRow
        label={t("connectors.editor.transport")}
        description={t("connectors.editor.transportDesc")}
        value={transport}
        onChange={(v) => setTransport(v as McpTransport)}
        options={[
          { value: "stdio", label: "stdio" },
          { value: "http", label: "HTTP" },
        ]}
      />

      {transport === "stdio" ? (
        <>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">
              {t("connectors.editor.command")}
            </Label>
            <Input
              placeholder={t("connectors.editor.commandPlaceholder")}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">
              {t("connectors.editor.args")}
              <span className="ml-2 font-normal text-muted-foreground">
                {t("connectors.editor.argsHint")}
              </span>
            </Label>
            <Textarea
              placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/path/to/dir"}
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              rows={3}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">
              {t("connectors.editor.env")}
              <span className="ml-2 font-normal text-muted-foreground">
                {t("connectors.editor.envHint")}
              </span>
            </Label>
            <KeyValueRows
              pairs={envPairs}
              onChange={setEnvPairs}
              keyPlaceholder={t("connectors.editor.envName")}
              valuePlaceholder={t("connectors.editor.envValue")}
              addLabel={t("connectors.editor.addEnv")}
              removeAria={t("connectors.editor.removeRow")}
            />
          </div>
        </>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">
              {t("connectors.editor.url")}
            </Label>
            <Input
              placeholder="https://example.com/mcp"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">
              {t("connectors.editor.headers")}
              <span className="ml-2 font-normal text-muted-foreground">
                {t("connectors.editor.headersHint")}
              </span>
            </Label>
            <KeyValueRows
              pairs={headerPairs}
              onChange={setHeaderPairs}
              keyPlaceholder={t("connectors.editor.headerName")}
              valuePlaceholder={t("connectors.editor.headerValue")}
              addLabel={t("connectors.editor.addHeader")}
              removeAria={t("connectors.editor.removeRow")}
            />
          </div>

          <SegmentRow
            label={t("connectors.oauth.auth")}
            description={t("connectors.oauth.authDesc")}
            value={auth}
            onChange={setAuth}
            options={[
              { value: "none", label: t("connectors.oauth.none") },
              { value: "oauth", label: "OAuth" },
            ]}
          />

          {auth === "oauth" && (
            <div className="space-y-3 rounded-md border border-border bg-background/60 p-3">
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">
                    {t("connectors.oauth.clientId")}
                    <span className="ml-2 font-normal text-muted-foreground">
                      {t("connectors.oauth.optional")}
                    </span>
                  </Label>
                  <Input
                    placeholder={t("connectors.oauth.clientIdPlaceholder")}
                    value={oauthClientId}
                    onChange={(e) => setOauthClientId(e.target.value)}
                    className="font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">
                    {t("connectors.oauth.scope")}
                    <span className="ml-2 font-normal text-muted-foreground">
                      {t("connectors.oauth.optional")}
                    </span>
                  </Label>
                  <Input
                    placeholder="read write"
                    value={oauthScope}
                    onChange={(e) => setOauthScope(e.target.value)}
                    className="font-mono text-xs"
                  />
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t("connectors.oauth.saveHint")}
              </p>
            </div>
          )}
        </>
      )}

      {testResult && (
        <div
          className={cn(
            "rounded-md border px-3 py-2 text-xs",
            testResult.ok
              ? "border-success/40 bg-success/5 text-success"
              : "border-destructive/40 bg-destructive/5 text-destructive",
          )}
        >
          {testResult.ok ? (
            <>
              <p className="font-medium">
                {t("connectors.test.connected")}
                {testResult.serverName ? ` — ${testResult.serverName}` : ""}
                {testResult.serverVersion ? ` v${testResult.serverVersion}` : ""}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {testResult.tools.length > 0
                  ? (testResult.tools.length === 1
                      ? t("connectors.test.tools.one", {
                          count: testResult.tools.length,
                          names: toolNamesPreview(testResult.tools),
                        })
                      : t("connectors.test.tools.other", {
                          count: testResult.tools.length,
                          names: toolNamesPreview(testResult.tools),
                        }))
                  : t("connectors.test.noTools")}
              </p>
            </>
          ) : (
            <p>{testResult.error ?? t("connectors.test.failed")}</p>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving
            ? t("connectors.editor.saving")
            : initial
              ? tc("action.save")
              : tc("action.add")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={test}
          disabled={testing}
        >
          <RotateCw className={cn("size-3.5", testing && "animate-spin")} />
          {testing ? t("connectors.testing") : t("connectors.test.button")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          {tc("action.cancel")}
        </Button>
      </div>
    </div>
  );
}

// =============================================================================
// Shared bits
// =============================================================================

function SectionHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="space-y-1">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function SegmentRow<T extends string>({
  label,
  description,
  value,
  onChange,
  options,
}: {
  label: string;
  description: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0 space-y-0.5">
        <Label className="font-medium">{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex shrink-0 items-center rounded-md border border-border bg-muted p-0.5 text-xs">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded px-2.5 py-1 font-medium transition-colors",
              value === o.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ToggleRow({
  id,
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
  boxed,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  boxed?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 py-3",
        boxed && "px-3",
      )}
    >
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={id} className="font-medium">
          {label}
        </Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
      />
    </div>
  );
}
