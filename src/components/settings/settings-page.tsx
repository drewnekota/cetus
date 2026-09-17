"use client";

/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
 * genre: modern-minimal · macrostructure: Workbench · designed-as-app */
// Full-window settings screen. Renders over the whole app (sidebar included)
// as a dedicated page rather than a modal dialog, with a left section rail and
// a scrollable content pane. Opened from the sidebar, the command palette, or
// ⌘, ; closed with Back or Esc.
import { memo, useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
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
  const [section, setSection] = useState<SectionId>(readSettingsSection);

  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_SECTION_KEY, section);
    } catch {}
  }, [section]);

  useEffect(() => {
    const showRuntimeSettings = () => setSection("runtimes");
    window.addEventListener(OPEN_RUNTIME_SETTINGS_EVENT, showRuntimeSettings);
    return () =>
      window.removeEventListener(
        OPEN_RUNTIME_SETTINGS_EVENT,
        showRuntimeSettings,
      );
  }, []);

  // Esc closes the page. Capture phase + stopPropagation keeps the shortcut
  // scoped to Settings instead of reaching the page underneath.
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
        <span className="text-sm font-semibold">{t("page.title")}</span>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav className="scrollbar-slim w-52 shrink-0 overflow-y-auto border-r border-border bg-muted/20 p-2">
          {SECTION_GROUPS.map((group) => (
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
