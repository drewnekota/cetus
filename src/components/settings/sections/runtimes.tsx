"use client";

/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
 * genre: modern-minimal · macrostructure: Workbench · designed-as-app */
// Full-window settings screen. Renders over the whole app (sidebar included)
// as a dedicated page rather than a modal dialog, with a left section rail and
// a scrollable content pane. Opened from the sidebar, the command palette, or
// ⌘, ; closed with Back or Esc.
import { useEffect, useState } from "react";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  BACKENDS,
  CLI_EFFORTS,
  backendSupportsTuning,
  cliModelCatalog,
  resolveCliEffort,
  resolveCliModel,
  runtimePresetLabel,
  useCliDefaults,
  type TunableBackendId,
} from "@/components/chat/backend-picker";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { runtimeThemeStyle } from "@/lib/runtime-theme";
import { useTranslation } from "@/lib/i18n";
import { api } from "@/lib/tauri";
import {
  type BackendId,
  type CliAgentSettings,
  type RuntimePreset,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  DEFAULT_CLI_AGENT_SETTINGS,
  isBackendEnabled,
  normalizeRuntimeEntryOrder,
  runtimeEntries,
  runtimeSlotDisplay,
} from "@/lib/runtime-settings";
import { useKeyboardShortcuts } from "@/lib/keyboard-shortcuts";
import { SectionHeading, SettingsList, ToggleRow } from "../settings-controls";

// =============================================================================
// Runtimes
// =============================================================================

const RUNTIME_COMMANDS: Record<BackendId, string> = {
  pi: "Built into Cetus",
  "claude-code": "claude --output-format stream-json",
  codex: "codex app-server",
  opencode: "opencode acp",
  grok: "grok agent stdio",
  kimi: "kimi acp",
  dsh: "dsh web + Cetus bridge",
};

function runtimeEnabledPatch(
  backend: BackendId,
  enabled: boolean,
): Partial<CliAgentSettings> {
  switch (backend) {
    case "claude-code":
      return { claudeCodeEnabled: enabled };
    case "codex":
      return { codexEnabled: enabled };
    case "opencode":
      return { opencodeEnabled: enabled };
    case "grok":
      return { grokEnabled: enabled };
    case "kimi":
      return { kimiEnabled: enabled };
    case "dsh":
      return { dshEnabled: enabled };
    case "pi":
      return {};
  }
}

/** A runtime row wired into dnd-kit's sortable list. The grip on the left edge
 *  is the drag handle; the rest of the row keeps its clicks (switch, delete). */
function SortableRuntimeRow({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation("settings");
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid={`runtime-settings-row-${id}`}
      className={cn(
        "flex items-center gap-3 bg-card px-4 py-3",
        // Lift the dragged row above its siblings so it slides over them.
        isDragging && "relative z-10 shadow-lg",
      )}
    >
      <button
        type="button"
        data-testid={`runtime-drag-${id}`}
        aria-label={t("runtimes.dragToReorder")}
        title={t("runtimes.dragToReorder")}
        {...attributes}
        {...listeners}
        className="flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground/60 hover:bg-muted hover:text-foreground active:cursor-grabbing"
      >
        <GripVertical className="size-4" />
      </button>
      {children}
    </div>
  );
}

export function RuntimesSection() {
  const { t } = useTranslation("settings");
  const [settings, setSettings] = useState<CliAgentSettings>(
    DEFAULT_CLI_AGENT_SETTINGS,
  );
  const [runtimeStatus, setRuntimeStatus] = useState<Awaited<
    ReturnType<typeof api.getCliRuntimeStatus>
  > | null>(null);
  const shortcuts = useKeyboardShortcuts();
  // A few px of travel before a drag starts, so the grip still takes clicks.
  const dragSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  useEffect(() => {
    api
      .getCliAgentSettings()
      .then((value) => setSettings({ ...DEFAULT_CLI_AGENT_SETTINGS, ...value }))
      .catch(() => {});
    api
      .getCliRuntimeStatus()
      .then(setRuntimeStatus)
      .catch(() => {});
  }, []);

  function save(next: CliAgentSettings) {
    setSettings(next);
    api.setCliAgentSettings(next).catch(() => {});
  }

  function update(patch: Partial<CliAgentSettings>) {
    save({ ...settings, ...patch });
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const order = normalizeRuntimeEntryOrder(
      settings.runtimeOrder,
      settings.runtimePresets,
    );
    const from = order.indexOf(String(active.id));
    const to = order.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    update({ runtimeOrder: arrayMove(order, from, to) });
  }

  function addPreset(preset: RuntimePreset) {
    save({
      ...settings,
      runtimePresets: [...settings.runtimePresets, preset],
      runtimeOrder: [
        ...normalizeRuntimeEntryOrder(
          settings.runtimeOrder,
          settings.runtimePresets,
        ),
        preset.id,
      ],
    });
  }

  function deletePreset(id: string) {
    save({
      ...settings,
      runtimePresets: settings.runtimePresets.filter(
        (preset) => preset.id !== id,
      ),
      runtimeOrder: settings.runtimeOrder.filter((entry) => entry !== id),
    });
  }

  const entries = runtimeEntries(settings);
  const byId = new Map(BACKENDS.map((backend) => [backend.id, backend]));
  const isInstalled = (id: BackendId) => {
    if (id === "pi") return true;
    if (!runtimeStatus) return null;
    if (id === "claude-code") return runtimeStatus.claudeCode;
    return runtimeStatus[id];
  };

  return (
    <section>
      <SectionHeading
        title={t("runtimes.title")}
        description={t("runtimes.description")}
      />

      <DndContext
        sensors={dragSensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={entries.map((entry) => entry.id)}
          strategy={verticalListSortingStrategy}
        >
          <SettingsList className="mt-6">
            {entries.map((entry) => {
              if (entry.kind === "preset") {
                const { preset } = entry;
                const presetRuntime = byId.get(preset.backend);
                const PresetIcon = presetRuntime?.icon;
                const presetSlotKey = runtimeSlotDisplay(
                  entry.id,
                  settings,
                  shortcuts,
                );
                return (
                  <SortableRuntimeRow key={entry.id} id={entry.id}>
                    <div
                      style={{
                        ...runtimeThemeStyle(preset.backend),
                        color: "var(--runtime-color)",
                        backgroundColor:
                          "color-mix(in oklab, var(--runtime-color) 10%, transparent)",
                      }}
                      className="flex size-9 shrink-0 items-center justify-center rounded-lg"
                    >
                      {PresetIcon && <PresetIcon className="size-4" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">
                          {runtimePresetLabel(preset)}
                        </span>
                        {presetSlotKey && (
                          <span
                            className="rounded border border-border px-1.5 py-0.5 font-mono text-2xs text-muted-foreground"
                            title={t("runtimes.shortcutHint")}
                          >
                            {presetSlotKey}
                          </span>
                        )}
                        <span className="rounded-full bg-muted px-2 py-0.5 text-2xs text-muted-foreground">
                          {t("runtimes.preset")}
                        </span>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {presetRuntime?.label ?? preset.backend}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      data-testid={`runtime-preset-delete-${entry.id}`}
                      aria-label={t("runtimes.presets.delete")}
                      title={t("runtimes.presets.delete")}
                      onClick={() => deletePreset(entry.id)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </SortableRuntimeRow>
                );
              }
              const id = entry.id;
              const runtime = byId.get(id);
              if (!runtime) return null;
              const Icon = runtime.icon;
              const enabled = isBackendEnabled(id, settings);
              const installed = isInstalled(id);
              // Read off the section's own state so the chip moves with the
              // row the instant it's reordered, not a save round-trip later.
              const slotKey = runtimeSlotDisplay(id, settings, shortcuts);
              return (
                <SortableRuntimeRow key={id} id={id}>
                  <div
                    style={{
                      ...runtimeThemeStyle(id),
                      color: "var(--runtime-color)",
                      backgroundColor:
                        "color-mix(in oklab, var(--runtime-color) 10%, transparent)",
                    }}
                    className="flex size-9 shrink-0 items-center justify-center rounded-lg"
                  >
                    <Icon className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {runtime.label}
                      </span>
                      {slotKey && (
                        <span
                          className="rounded border border-border px-1.5 py-0.5 font-mono text-2xs text-muted-foreground"
                          title={t("runtimes.shortcutHint")}
                        >
                          {slotKey}
                        </span>
                      )}
                      {id === "pi" ? (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-2xs text-muted-foreground">
                          {t("runtimes.builtIn")}
                        </span>
                      ) : installed !== null ? (
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-2xs",
                            installed
                              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                              : "bg-muted text-muted-foreground",
                          )}
                        >
                          {installed
                            ? t("runtimes.installed")
                            : t("runtimes.notInstalled")}
                        </span>
                      ) : null}
                      {id === "codex" &&
                        runtimeStatus?.codexLoggedIn === false && (
                          <span
                            className="rounded-full bg-amber-500/10 px-2 py-0.5 text-2xs text-amber-600 dark:text-amber-400"
                            title={t("runtimes.codexNotSignedIn.hint")}
                          >
                            {t("runtimes.codexNotSignedIn")}
                          </span>
                        )}
                    </div>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {RUNTIME_COMMANDS[id]}
                    </p>
                  </div>
                  <Switch
                    id={`runtime-enabled-${id}`}
                    data-testid={`runtime-enabled-${id}`}
                    checked={enabled}
                    disabled={id === "pi"}
                    aria-label={t("runtimes.enabled", {
                      runtime: runtime.label,
                    })}
                    onCheckedChange={(value) =>
                      update(runtimeEnabledPatch(id, value))
                    }
                  />
                </SortableRuntimeRow>
              );
            })}
          </SettingsList>
        </SortableContext>
      </DndContext>

      <div className="mt-8">
        <h3 className="text-sm font-semibold">{t("runtimes.presets.title")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("runtimes.presets.description")}
        </p>
        <AddPresetForm onAdd={addPreset} />
      </div>

      <div className="mt-8">
        <h3 className="text-sm font-semibold">
          {t("runtimes.behavior.title")}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("runtimes.behavior.description")}
        </p>
        <div className="mt-2">
          <ToggleRow
            id="cli-agents-bypass"
            label={t("general.cliAgents.label")}
            description={t("general.cliAgents.description")}
            checked={settings.bypassApprovals}
            onCheckedChange={(value) => update({ bypassApprovals: value })}
          />
          <ToggleRow
            id="cli-agents-worktree"
            label={t("general.cliWorktree.label")}
            description={t("general.cliWorktree.description")}
            checked={settings.isolateInWorktree}
            onCheckedChange={(value) => update({ isolateInWorktree: value })}
          />
        </div>
      </div>
    </section>
  );
}

/** Composer for a new runtime preset: pick a tunable runtime plus the fixed
 *  model/effort it should always launch with. Local state only — nothing is
 *  saved until Add. */
function AddPresetForm({ onAdd }: { onAdd: (preset: RuntimePreset) => void }) {
  const { t } = useTranslation("settings");
  const [backend, setBackend] = useState<TunableBackendId>("claude-code");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  // Same live catalog the composer menu offers, so a preset can pin any model
  // the CLI currently reports rather than only the static fallback list. With
  // nothing picked yet the form pre-selects what the CLI would launch anyway;
  // a preset pins an explicit id, so that resolution is what gets saved.
  const defaults = useCliDefaults(backend);
  const models = cliModelCatalog(backend, defaults);
  const efforts = CLI_EFFORTS[backend];
  const curModel = resolveCliModel(model, models, defaults) ?? models[0];
  const curEffort = resolveCliEffort(effort, efforts, defaults);
  const tunableBackends = BACKENDS.filter((runtime) =>
    backendSupportsTuning(runtime.id),
  );

  function selectBackend(next: string) {
    setBackend(next as TunableBackendId);
    // Catalogs differ per runtime; a stale id would silently pin the wrong
    // thing, so re-resolve from that runtime's own default.
    setModel("");
    setEffort("");
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Select value={backend} onValueChange={selectBackend}>
        <SelectTrigger
          size="sm"
          className="w-40 text-xs"
          aria-label={t("runtimes.presets.runtime")}
          data-testid="runtime-preset-backend"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {tunableBackends.map((runtime) => (
            <SelectItem key={runtime.id} value={runtime.id} className="text-xs">
              <runtime.icon className="size-4" />
              {runtime.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={curModel.id} onValueChange={setModel}>
        <SelectTrigger
          size="sm"
          className="w-44 text-xs"
          aria-label={t("runtimes.presets.model")}
          data-testid="runtime-preset-model"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {models.map((m) => (
            <SelectItem key={m.id} value={m.id} className="text-xs">
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={curEffort?.id ?? ""} onValueChange={setEffort}>
        <SelectTrigger
          size="sm"
          className="w-32 text-xs"
          aria-label={t("runtimes.presets.reasoning")}
          data-testid="runtime-preset-effort"
        >
          <SelectValue placeholder={t("runtimes.presets.reasoning")} />
        </SelectTrigger>
        <SelectContent>
          {efforts.map((e) => (
            <SelectItem key={e.id} value={e.id} className="text-xs">
              {e.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="runtime-preset-add"
        onClick={() =>
          onAdd({
            id: `preset-${crypto.randomUUID()}`,
            backend,
            model: curModel.id,
            effort: curEffort?.id ?? "",
          })
        }
      >
        <Plus className="size-3.5" />
        {t("runtimes.presets.add")}
      </Button>
    </div>
  );
}
