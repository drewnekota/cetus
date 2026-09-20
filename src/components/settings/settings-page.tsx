"use client";

/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
 * genre: modern-minimal · macrostructure: Workbench · designed-as-app */
// Full-window settings screen. Renders over the whole app (sidebar included)
// as a dedicated page rather than a modal dialog, with a left section rail and
// a scrollable content pane. Opened from the sidebar, the command palette, or
// ⌘, ; closed with Back or Esc.
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { meeting } from "@/lib/i18n/messages/meeting";
import { en as settingsEnglish } from "@/lib/i18n/messages/settings/en";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import type { Conversation } from "@/lib/types";
import { cn } from "@/lib/utils";
import { OPEN_RUNTIME_SETTINGS_EVENT } from "@/lib/runtime-settings";
import { GeneralSection } from "./sections/general";
import { RuntimesSection } from "./sections/runtimes";
import { RemoteSection } from "./sections/remote";
import { ApiKeysSection } from "./sections/api-keys";
import { ModelsSection } from "./sections/models";
import { MemorySection } from "./sections/memory";
import { SkillsSection } from "./sections/skills";
import { SlashCommandsSection } from "./sections/slash-commands";
import { ConnectorsSection } from "./sections/connectors";
import { PluginsSection } from "./sections/plugins";
import { NotificationsSection } from "./sections/notifications";
import { PermissionsSection } from "./sections/permissions";
import { AppearanceSection } from "./sections/appearance";
import { KeyboardShortcutsSection } from "./sections/keyboard-shortcuts";
import { LauncherSection } from "./sections/launcher";
import { VoiceSection } from "./sections/voice";
import { MeetingsSection } from "./sections/meetings";
import { ArchivedChatsSection } from "./sections/archived-chats";
import { ScreenContextSection } from "./sections/screen-context";
import { AmbientContextSection } from "./sections/ambient-context";

type SectionId =
  | "general"
  | "runtimes"
  | "remote"
  | "api-keys"
  | "models"
  | "memory"
  | "skills"
  | "slash-commands"
  | "connectors"
  | "plugins"
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
};

// The rail is grouped into a few labelled clusters so a dozen flat entries
// don't read as one long list. Order within a group is intentional.
// `labelKey` values are settings-namespace i18n keys resolved at render.
const SECTION_GROUPS: { labelKey: string; sections: Section[] }[] = [
  {
    labelKey: "group.general",
    sections: [
      { id: "general", labelKey: "nav.general" },
      { id: "runtimes", labelKey: "nav.runtimes" },
      { id: "remote", labelKey: "nav.remote" },
      { id: "appearance", labelKey: "nav.appearance" },
      { id: "keyboard-shortcuts", labelKey: "nav.keyboard-shortcuts" },
      { id: "notifications", labelKey: "nav.notifications" },
      { id: "permissions", labelKey: "nav.permissions" },
    ],
  },
  {
    labelKey: "group.intelligence",
    sections: [
      { id: "api-keys", labelKey: "nav.api-keys" },
      { id: "models", labelKey: "nav.models" },
      { id: "memory", labelKey: "nav.memory" },
      { id: "skills", labelKey: "nav.skills" },
      { id: "slash-commands", labelKey: "nav.slash-commands" },
      { id: "connectors", labelKey: "nav.connectors" },
      { id: "plugins", labelKey: "nav.plugins" },
    ],
  },
  {
    labelKey: "group.inputCapture",
    sections: [
      { id: "launcher", labelKey: "nav.launcher" },
      { id: "voice", labelKey: "nav.voice" },
      { id: "screen", labelKey: "nav.screen" },
      { id: "meetings", labelKey: "nav.meetings" },
    ],
  },
  {
    labelKey: "group.data",
    sections: [{ id: "archived", labelKey: "nav.archived" }],
  },
];

// Search static labels without mounting sections or loading their private data.
const SEARCH_PREFIXES: Partial<Record<SectionId, string[]>> = {
  general: ["general.", "update.", "diagnostics.", "launcher.startup."],
  runtimes: ["runtimes.", "general.cli"],
  "api-keys": ["apiKeys."],
  "slash-commands": ["slashCmd."],
  connectors: ["connectors.", "discovery."],
  "keyboard-shortcuts": ["keyboard."],
  screen: ["screen.", "ambient."],
  archived: ["archived.", "autoArchive.", "autoDelete."],
};
const SEARCH_KEYS = Object.keys(settingsEnglish).filter((key) =>
  /\.(label|title)$/.test(key),
);

const SETTINGS_SECTION_KEY = "cetus:settingsSection";

const SECTION_IDS = new Set<SectionId>(
  SECTION_GROUPS.flatMap((group) =>
    group.sections.map((section) => section.id),
  ),
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
  /** Called after archived chats are deleted/restored so the sidebar refreshes.
   *  Restores include the fresh row so a hidden automation workspace can be
   *  surfaced again immediately. */
  onConversationsChanged?: (restored?: Conversation) => void;
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
  const { t: tm } = useTranslation("meeting");
  const [section, setSection] = useState<SectionId>(readSettingsSection);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const searchIndex = useMemo(() => new Map(
    SECTION_GROUPS.flatMap((group) => group.sections.map((item) => {
      const prefixes = SEARCH_PREFIXES[item.id] ?? [`${item.id}.`];
      const keys = SEARCH_KEYS.filter((key) =>
        prefixes.some((prefix) => key.startsWith(prefix)) &&
        !(item.id === "general" && key.startsWith("general.cli")),
      );
      const meetingLabels = item.id === "meetings"
        ? Object.entries(meeting.en).filter(([key]) => /\.(label|title)$/.test(key))
            .flatMap(([key, value]) => [tm(key), value])
        : [];
      const text = [...meetingLabels, item.id, t(item.labelKey), settingsEnglish[item.labelKey as keyof typeof settingsEnglish],
        ...keys.flatMap((key) => [t(key), settingsEnglish[key as keyof typeof settingsEnglish]])]
        .join(" ").normalize("NFKC").toLowerCase();
      return [item.id, text] as const;
    })),
  ), [t, tm]);
  const terms = search.normalize("NFKC").toLowerCase().trim().split(/\s+/).filter(Boolean);
  const filteredGroups = SECTION_GROUPS.map((group) => ({
    ...group,
    sections: group.sections.filter((item) =>
      terms.every((term) => searchIndex.get(item.id)?.includes(term)),
    ),
  })).filter((group) => group.sections.length > 0);

  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_SECTION_KEY, section);
    } catch {}
  }, [section]);

  useEffect(() => {
    const showRuntimeSettings = () => {
      setSearch("");
      setSection("runtimes");
    };
    window.addEventListener(OPEN_RUNTIME_SETTINGS_EVENT, showRuntimeSettings);
    return () =>
      window.removeEventListener(
        OPEN_RUNTIME_SETTINGS_EVENT,
        showRuntimeSettings,
      );
  }, []);

  // Esc clears the search first, then closes the page. Capture phase keeps it
  // scoped to Settings instead of reaching the page underneath.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (document.documentElement.dataset.hotkeyRecording === "true") return;
        e.preventDefault();
        e.stopPropagation();
        if (search) {
          setSearch("");
          searchRef.current?.focus();
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose, search]);

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
        <span className="text-sm font-semibold">{t("page.title")}</span>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label={t("page.title")} className="flex w-52 shrink-0 flex-col border-r border-border bg-muted/20">
          <div className="relative m-2 shrink-0">
            <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("search.placeholder")}
              aria-label={t("search.placeholder")}
              className="pl-8 pr-8"
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  const first = filteredGroups[0]?.sections[0];
                  if (first) setSection(first.id);
                }
              }}
            />
            {search && (
              <button type="button" aria-label={t("search.clear")}
                className="absolute right-1 top-1 flex size-7 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-ring"
                onClick={() => { setSearch(""); searchRef.current?.focus(); }}>
                <X aria-hidden="true" className="size-3.5" />
              </button>
            )}
          </div>
          <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {filteredGroups.length === 0 && (
              <p role="status" className="px-3 py-6 text-center text-xs text-muted-foreground">{t("search.empty")}</p>
            )}
            {filteredGroups.map((group) => (
              <div key={group.labelKey} className="mb-3 last:mb-0">
                <div className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">
                  {t(group.labelKey)}
                </div>
                {group.sections.map((s) => {
                  const active = section === s.id;
                  return (
                    <button
                      key={s.id}
                      data-testid={`nav-${s.id}`}
                      aria-current={active ? "page" : undefined}
                      type="button"
                      onClick={() => setSection(s.id)}
                      className={cn(
                        "flex w-full items-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors motion-reduce:transition-none",
                        active
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      {t(s.labelKey)}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </nav>
        <main className="scrollbar-slim min-w-0 flex-1 overflow-y-auto bg-muted/10">
          <div className="mx-auto w-full max-w-3xl px-6 py-8">
            {section === "general" ? (
              <GeneralSection />
            ) : section === "runtimes" ? (
              <RuntimesSection />
            ) : section === "remote" ? (
              <RemoteSection />
            ) : section === "api-keys" ? (
              <ApiKeysSection
                storedProviders={storedProviders}
                onSaved={onSaved}
              />
            ) : section === "models" ? (
              <ModelsSection open={open} />
            ) : section === "memory" ? (
              <MemorySection open={open} />
            ) : section === "skills" ? (
              <SkillsSection open={open} />
            ) : section === "slash-commands" ? (
              <SlashCommandsSection open={open} />
            ) : section === "connectors" ? (
              <ConnectorsSection open={open} />
            ) : section === "plugins" ? (
              <PluginsSection open={open} />
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
              <>
                <ScreenContextSection onOpenHistory={onOpenHistory} />
                <div className="mt-10">
                  <AmbientContextSection />
                </div>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
});

export { updateDownloadPercent } from "./update-progress";
