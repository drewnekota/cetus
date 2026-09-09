"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Settings2 } from "lucide-react";
import { api } from "@/lib/tauri";
import { useChatStore } from "@/lib/chat-store";
import type {
  BackendId,
  CliDefaults,
  CliRateLimitInfo,
  RuntimePreset,
} from "@/lib/types";
import {
  CetusIcon,
  ClaudeCodeIcon,
  CodexIcon,
  DshIcon,
  GrokIcon,
  KimiIcon,
  OpenCodeIcon,
  type AppIcon,
} from "@/components/brand-icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";
import { loadCliTuningChoice, saveCliTuningChoice } from "@/lib/backend-choice";
import {
  openRuntimeSettings,
  runtimeSlotDisplay,
  runtimeSlots,
  useRuntimePreferences,
  type RuntimeEntry,
} from "@/lib/runtime-settings";
import {
  matchesShortcut,
  RUNTIME_SLOT_SHORTCUT_IDS,
  useKeyboardShortcuts,
  type ShortcutMap,
} from "@/lib/keyboard-shortcuts";
import { runtimeThemeStyle } from "@/lib/runtime-theme";

export const BACKENDS: { id: BackendId; label: string; icon: AppIcon }[] = [
  { id: "pi", label: "Cetus", icon: CetusIcon },
  { id: "claude-code", label: "Claude Code", icon: ClaudeCodeIcon },
  { id: "codex", label: "Codex", icon: CodexIcon },
  { id: "opencode", label: "OpenCode", icon: OpenCodeIcon },
  { id: "grok", label: "Grok Build", icon: GrokIcon },
  { id: "kimi", label: "Kimi CLI", icon: KimiIcon },
  { id: "dsh", label: "DeepSeek Harness", icon: DshIcon },
];

export function useRuntimeCatalog() {
  const { order, entries, enabledBackendIds } = useRuntimePreferences();
  const orderedBackends = useMemo(() => {
    const byId = new Map(BACKENDS.map((backend) => [backend.id, backend]));
    return order.flatMap((id) => {
      const backend = byId.get(id);
      return backend ? [backend] : [];
    });
  }, [order]);
  return { orderedBackends, entries, enabledBackendIds };
}

export type TunableBackendId = "claude-code" | "codex" | "grok" | "dsh";

export function backendSupportsTuning(
  backend: BackendId,
): backend is TunableBackendId {
  return (
    backend === "claude-code" ||
    backend === "codex" ||
    backend === "grok" ||
    backend === "dsh"
  );
}

/** The next runtime in the user's picker order, wrapping around. Bound to Tab
 *  across the new-chat surfaces. Disabled runtimes are omitted. */
export function nextBackend(
  current: BackendId,
  enabled?: ReadonlySet<BackendId>,
): BackendId {
  const choices = enabled
    ? Array.from(enabled).flatMap((id) => {
        const backend = BACKENDS.find((candidate) => candidate.id === id);
        return backend ? [backend] : [];
      })
    : BACKENDS;
  const i = choices.findIndex((b) => b.id === current);
  return choices[(i + 1 + choices.length) % choices.length].id;
}

/** What a positional runtime shortcut applies: a runtime, plus the fixed
 *  model/effort when the slot addressed a preset. `model`/`effort` undefined
 *  means "keep the runtime's own sticky tuning". */
export interface RuntimeSwitchTarget {
  backend: BackendId;
  model?: string;
  effort?: string;
}

export function runtimeSwitchTarget(entry: RuntimeEntry): RuntimeSwitchTarget {
  return entry.kind === "backend"
    ? { backend: entry.id }
    : {
        backend: entry.preset.backend,
        model: entry.preset.model,
        effort: entry.preset.effort,
      };
}

/** The next row in the picker order — runtimes and presets alike — wrapping
 *  around, so Tab walks exactly the rows the dropdown (and ⌃1…⌃9) shows.
 *  The current row is the preset whose fixed tuning matches the shown
 *  selection, else the plain runtime row; a preset target carries its fixed
 *  model/effort, a runtime target keeps the runtime's own sticky tuning. */
export function nextRuntimeTarget(
  entries: readonly RuntimeEntry[],
  enabled: ReadonlySet<BackendId>,
  current: { backend: BackendId; model?: string; effort?: string },
): RuntimeSwitchTarget {
  const rows = entries.filter((entry) =>
    entry.kind === "backend"
      ? enabled.has(entry.id)
      : enabled.has(entry.preset.backend),
  );
  if (rows.length === 0) return { backend: current.backend };
  const presetIdx = rows.findIndex(
    (entry) =>
      entry.kind === "preset" &&
      entry.preset.backend === current.backend &&
      entry.preset.model === (current.model ?? "") &&
      entry.preset.effort === (current.effort ?? ""),
  );
  const idx =
    presetIdx >= 0
      ? presetIdx
      : rows.findIndex(
          (entry) => entry.kind === "backend" && entry.id === current.backend,
        );
  return runtimeSwitchTarget(rows[(idx + 1 + rows.length) % rows.length]);
}

/** Live view of [`runtimeSlots`] — what ⌃1…⌃9 currently address. */
export function useRuntimeSlots(): RuntimeEntry[] {
  const { settings } = useRuntimePreferences();
  return useMemo(() => runtimeSlots(settings), [settings]);
}

/** The row a positional shortcut selects, or null when that slot is past the
 *  end of the enabled list. */
export function runtimeForShortcut(
  event: KeyboardEvent,
  shortcuts: ShortcutMap,
  slots: readonly RuntimeEntry[],
): RuntimeEntry | null | undefined {
  const slot = RUNTIME_SLOT_SHORTCUT_IDS.findIndex((id) =>
    matchesShortcut(event, shortcuts[id]),
  );
  // undefined: not a runtime shortcut at all. null: bound, but nothing in that
  // slot — swallow the key rather than letting it fall through.
  if (slot < 0) return undefined;
  return slots[slot] ?? null;
}

/** Window keydown → runtime switch, matched against the user's (editable)
 *  shortcut map. For surfaces that own their backend state directly — the
 *  quick launcher and the task/automation dialogs. The main composer instead
 *  routes through page.tsx's modal-guarded handler, so don't enable this
 *  where that handler is already live. */
export function useRuntimeShortcuts(
  onSwitch: (target: RuntimeSwitchTarget) => void,
  enabled: boolean = true,
) {
  const shortcuts = useKeyboardShortcuts();
  const slots = useRuntimeSlots();
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const entry = runtimeForShortcut(e, shortcuts, slots);
      if (entry === undefined) return;
      e.preventDefault();
      if (entry) onSwitch(runtimeSwitchTarget(entry));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, shortcuts, onSwitch, slots]);
}

/** Right-aligned shortcut hint inside a runtime/preset SelectItem (e.g. "⌃2").
 *  Follows the row's position in the enabled order, so reordering in Settings
 *  relabels the menu. Renders nothing when unassigned or out of slots. */
export function RuntimeShortcutHint({ entryId }: { entryId: string }) {
  const shortcuts = useKeyboardShortcuts();
  const { settings } = useRuntimePreferences();
  const display = runtimeSlotDisplay(entryId, settings, shortcuts);
  if (!display) return null;
  return (
    <span className="ml-auto pl-3 text-2xs tracking-wide text-muted-foreground/70">
      {display}
    </span>
  );
}

/** Model overrides offered per CLI backend. Ids are passed straight through to
 *  `claude --model` / `codex -m`. A persisted "" (legacy, or nothing chosen
 *  yet) means no flag: the CLI's own configured default launches, and the menu
 *  shows that resolved model checked rather than a separate "Default" row.
 *  Claude ids are the CLI's aliases (always resolve to the latest of each
 *  tier). The codex list is only the fallback when its models_cache.json can't
 *  be read — normally the live catalog from `api.getCliDefaults` replaces it. */
export const CLI_MODELS: Record<
  TunableBackendId,
  { id: string; label: string }[]
> = {
  "claude-code": [
    { id: "fable", label: "Fable" },
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
    { id: "haiku", label: "Haiku" },
  ],
  codex: [
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.4-mini", label: "GPT-5.4-Mini" },
    { id: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" },
  ],
  grok: [
    { id: "grok-4.5", label: "Grok 4.5" },
  ],
  dsh: [
    { id: "deepseek-v4-flash", label: "DeepSeek-V4-Flash" },
    { id: "deepseek-v4-pro", label: "DeepSeek-V4-Pro" },
    { id: "deepseek-v4-flash-vision-exp", label: "DeepSeek-V4-Flash-Vision-Exp" },
  ],
};

/** Reasoning-effort levels per CLI backend, matching what each CLI accepts
 *  natively: `claude --effort` (low…max) / codex `model_reasoning_effort`
 *  (low…xhigh). A persisted "" means no flag (the CLI's configured default);
 *  the menu checks that level when the CLI reports it. */
export const CLI_EFFORTS: Record<
  TunableBackendId,
  { id: string; label: string }[]
> = {
  "claude-code": [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
    { id: "xhigh", label: "XHigh" },
    { id: "max", label: "Max" },
  ],
  codex: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
    { id: "xhigh", label: "XHigh" },
  ],
  grok: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
  ],
  // dsh's ACP `reasoning_effort` option: off / low / high / max (no medium).
  dsh: [
    { id: "off", label: "Off" },
    { id: "low", label: "Low" },
    { id: "high", label: "High" },
    { id: "max", label: "Max" },
  ],
};

/** Display label for a preset row, resolved against the static catalogs
 *  ("Fable · Medium"). Ids missing from the catalog (renamed models, live
 *  codex ids) fall back to the raw string rather than hiding the row; a legacy
 *  preset with no pinned effort shows the model alone. */
export function runtimePresetLabel(preset: RuntimePreset): string {
  const none: { id: string; label: string }[] = [];
  const models = backendSupportsTuning(preset.backend)
    ? CLI_MODELS[preset.backend]
    : none;
  const efforts = backendSupportsTuning(preset.backend)
    ? CLI_EFFORTS[preset.backend]
    : none;
  const model =
    models.find((m) => m.id === preset.model)?.label ||
    preset.model ||
    "Default";
  const effort =
    efforts.find((e) => e.id === preset.effort)?.label || preset.effort;
  return effort ? `${model} · ${effort}` : model;
}

/** One fetch of a backend's on-disk defaults per app session, shared by every
 *  tuning menu instance (composer, quick panel, dialogs). */
const defaultsCache = new Map<string, Promise<CliDefaults>>();
function fetchCliDefaults(backend: string): Promise<CliDefaults> {
  let p = defaultsCache.get(backend);
  if (!p) {
    p = api.getCliDefaults(backend).catch(() => ({
      model: null,
      effort: null,
      models: null,
    }));
    defaultsCache.set(backend, p);
  }
  return p;
}

/** Backend's on-disk defaults, fetched once per app session and shared by
 *  every tuning surface. `null` until the first fetch resolves. */
export function useCliDefaults(backend: TunableBackendId): CliDefaults | null {
  // Keyed by backend: while a switch is in flight the previous runtime's
  // defaults must read as "not loaded" rather than leak through. The
  // migration effect below acts on whatever defaults it sees, and one render
  // of codex paired with claude's defaults was enough to rewrite codex's
  // sticky "" into claude's model id.
  const [state, setState] = useState<{
    backend: TunableBackendId;
    defaults: CliDefaults;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchCliDefaults(backend).then((defaults) => {
      if (!cancelled) setState({ backend, defaults });
    });
    return () => {
      cancelled = true;
    };
  }, [backend]);
  return state?.backend === backend ? state.defaults : null;
}

/** Model catalog to offer for a backend: the live list the CLI reports
 *  (codex's models_cache.json, claude's initialize handshake), or the static
 *  fallback until it loads / when it can't be read. Every picker (composer,
 *  quick panel, preset form) must go through this so they all agree on what's
 *  selectable. */
export function cliModelCatalog(
  backend: TunableBackendId,
  defaults: CliDefaults | null,
) {
  return defaults?.models ?? CLI_MODELS[backend];
}

/** The catalog row a persisted override selects. Exact id first, then the
 *  family match (a stale pinned Claude id vs. the live catalog), and when
 *  nothing is persisted ("" = no flag) the row the CLI itself reports as its
 *  configured default. `undefined` when even that can't be resolved (catalog
 *  still loading, or an older CLI that doesn't report one). */
export function resolveCliModel(
  selected: string,
  catalog: { id: string; label: string }[],
  defaults: CliDefaults | null,
) {
  return (
    findCatalogModel(selected, catalog) ??
    resolveDefaultEntry(defaults?.model, catalog)
  );
}

/** Effort row a persisted override selects, falling back to the level the
 *  CLI reports as its default. `undefined` when the CLI doesn't say (Claude
 *  with no `effortLevel` set), in which case no row is checked and the trigger
 *  shows the model alone. */
export function resolveCliEffort(
  selected: string,
  catalog: { id: string; label: string }[],
  defaults: CliDefaults | null,
) {
  return (
    catalog.find((e) => e.id === selected) ??
    resolveDefaultEntry(defaults?.effort, catalog)
  );
}

/** Catalog row for a raw configured default: exact id first, then substring
 *  (claude reports full ids like "claude-opus-4-8[1m]" while the catalog
 *  carries aliases like "opus[1m]"). */
function resolveDefaultEntry(
  raw: string | null | undefined,
  catalog: { id: string; label: string }[],
) {
  if (!raw) return undefined;
  const exact = catalog.find((m) => m.id && m.id === raw);
  if (exact) return exact;
  return catalog.find((m) => {
    const family = m.id.split("[")[0];
    return family && raw.includes(family);
  });
}

/** Keep persisted Claude aliases (for example `fable`) selected when a newer
 * live catalog reports the same choice as `claude-fable-5[1m]`. */
function findCatalogModel(
  selected: string,
  catalog: { id: string; label: string }[],
) {
  const exact = catalog.find((model) => model.id === selected);
  if (exact || !selected) return exact;
  const family = selected.split("[")[0].toLowerCase();
  return catalog.find((model) => {
    const id = model.id.split("[")[0].toLowerCase();
    const label = model.label.toLowerCase();
    return id.includes(family) || family.includes(label);
  });
}

/** Whether a persisted model override is a pinned full id that can fall
 *  behind the live catalog. Only Claude reports versioned full ids
 *  ("claude-fable-5-1[1m]"); bare aliases and other runtimes' ids are never
 *  rewritten. */
function isStaleCandidate(backend: TunableBackendId, model: string): boolean {
  return backend === "claude-code" && model.startsWith("claude-");
}

/** A full Claude id stored for a runtime that can't run Claude models. */
function isForeignModel(backend: TunableBackendId, model: string): boolean {
  return backend !== "claude-code" && model.startsWith("claude-");
}

/** Combined model + reasoning-effort menu for a CLI backend, styled after
 *  the native codex picker: one compact trigger ("Fable · Max"), a flat list
 *  of reasoning levels on top, and the model catalog in a submenu. "" always
 *  means "the CLI's own default". */
export function CliTuningMenu({
  backend,
  model,
  effort,
  onModelChange,
  onEffortChange,
  onMigrate,
  disabled,
  className,
  open,
  onOpenChange,
}: {
  backend: TunableBackendId;
  model: string;
  effort: string;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string) => void;
  /** Receives concrete ids to persist in place of what's stored when the
   *  stored tuning can't be shown as-is: a legacy "" (the retired "Default"
   *  row) becomes the model/effort the CLI reports as its default, and a
   *  stale full Claude id becomes the live catalog id of the same family (see
   *  the migration effect). Omit to disable the migration — e.g. while a
   *  preset's fixed tuning is what's selected, since rewriting it would move
   *  the selection off the preset row and leak the preset's model into the
   *  runtime's own sticky choice. */
  onMigrate?: (model: string, effort: string) => void;
  disabled?: boolean;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  // On-disk defaults (and codex's live model catalog): with nothing persisted
  // the row the CLI would launch anyway is the one shown checked. Until they
  // load, an unresolved selection renders its raw id.
  const defaults = useCliDefaults(backend);
  const models = cliModelCatalog(backend, defaults);
  const efforts = CLI_EFFORTS[backend];
  const curModel = resolveCliModel(model, models, defaults);
  const curEffort = resolveCliEffort(effort, efforts, defaults);
  // Two stored shapes can't be shown as-is and get rewritten to what's
  // checked, so the menu and the running session agree:
  //
  // 1. "" — the retired "Default" row, still persisted for users who picked it
  //    before it was removed. Once the CLI's own default resolves against the
  //    catalog, that concrete id is stored instead (the client, not the CLI's
  //    config, owns the choice from then on). Left alone while unresolved so
  //    the CLI default keeps launching.
  // 2. A persisted full Claude id gone stale when the CLI reports a newer
  //    release of the same family ("claude-fable-5[1m]" →
  //    "claude-fable-5-1[1m]"): the family match keeps the new row checked
  //    while the stale id spawns, so store the live catalog id. Only full ids
  //    can go stale — floating aliases ("opus", "fable") always resolve to the
  //    current release inside the CLI, and the family match would otherwise
  //    "migrate" them to a different row ("opus" → "opus[1m]"), changing what
  //    they mean. Only the live catalog is trusted for this one.
  useEffect(() => {
    if (!onMigrate || !defaults) return;
    let nextModel = model;
    if (!model) {
      nextModel = curModel?.id ?? model;
    } else if (defaults.models && isStaleCandidate(backend, model)) {
      nextModel = findCatalogModel(model, defaults.models)?.id ?? model;
    } else if (isForeignModel(backend, model)) {
      // 3. A Claude id persisted for another runtime (the leak the keyed
      //    useCliDefaults above now prevents). It can't launch there, so fall
      //    back to that runtime's own default, or "" (no flag) when unknown.
      nextModel = curModel?.id ?? "";
    }
    const nextEffort = effort ? effort : (curEffort?.id ?? effort);
    if (nextModel !== model || nextEffort !== effort) {
      onMigrate(nextModel, nextEffort);
    }
  }, [backend, defaults, model, effort, curModel, curEffort, onMigrate]);
  // Raw ids stand in while the catalog is loading or when the CLI reports a
  // default the catalog doesn't carry; "Model" only when nothing is known.
  const shownModel = curModel?.label || model || defaults?.model || "Model";
  const shownEffort = curEffort?.label || effort || defaults?.effort || null;
  const label = shownEffort ? `${shownModel} · ${shownEffort}` : shownModel;
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          className={cn(
            "inline-flex h-7 min-w-0 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50",
            className,
          )}
        >
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuLabel className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Reasoning
        </DropdownMenuLabel>
        {efforts.map((e) => (
          <DropdownMenuItem
            key={e.id}
            className="text-xs"
            onClick={() => onEffortChange(e.id)}
          >
            <span className="flex-1">{e.label}</span>
            {e.id === curEffort?.id && <Check className="size-3.5" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="text-xs">
            {shownModel}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-44">
            <DropdownMenuLabel className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Model
            </DropdownMenuLabel>
            {models.map((m) => (
              <DropdownMenuItem
                key={m.id}
                className="text-xs"
                onClick={() => onModelChange(m.id)}
              >
                <span className="flex-1">{m.label}</span>
                {m.id === curModel?.id && <Check className="size-3.5" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "14:30" for a reset within 24h, "Sat 14:30" beyond that (weekly windows). */
function formatReset(resetsAt: number): string {
  const d = new Date(resetsAt * 1000);
  const opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
  if (d.getTime() - Date.now() >= 24 * 60 * 60 * 1000) opts.weekday = "short";
  return d.toLocaleString(undefined, opts);
}

/** Quota line for a runtime row in the picker dropdown, phrased as the
 *  remaining share ("N% left") to match the sidebar tooltip. Deliberately quiet:
 *  a healthy account (status "allowed", no utilization reported) renders
 *  nothing at all — the line appears only when there's something to say. */
function quotaLabel(
  q: CliRateLimitInfo | undefined,
): { text: string; warn: boolean } | null {
  if (!q) return null;
  const pct =
    q.utilization !== undefined
      ? `${Math.max(0, Math.round((1 - q.utilization) * 100))}% left`
      : null;
  const window = q.rateLimitType?.replace("five_hour", "5h").replace("seven_day", "7d");
  const reset = q.resetsAt ? `resets ${formatReset(q.resetsAt)}` : null;
  if (q.status === "rejected")
    return { text: [window, "limit reached", reset].filter(Boolean).join(" · "), warn: true };
  if (q.status === "allowed_warning")
    return {
      text: [window, pct ?? "near limit", reset].filter(Boolean).join(" · "),
      warn: true,
    };
  return pct ? { text: [window, pct].filter(Boolean).join(" · "), warn: false } : null;
}

/** Self-contained picker: reads the conversation's current backend and holds a
 *  pending selection for the composer's next delivered message. Rendered next
 *  to the model picker in the composer.
 *  `onBackendChange` reports both the loaded value and user switches so the
 *  composer can gate pi-only affordances (model picker) per backend.
 *
 *  With no conversation yet (the hero composer), the picker runs in "pending"
 *  mode when `pendingValue` is provided: the choice is held by the parent and
 *  applied to the conversation minted on first send. Without `pendingValue`
 *  it renders nothing (ephemeral composers like dialogs). */
export function BackendPicker({
  conversationId,
  disabled,
  onBackendChange,
  pendingValue,
  pendingModel,
  pendingEffort,
  onPendingTuningChange,
  onTuningChange,
  backendSwitch,
  tuningMenuOpen,
  onTuningMenuOpenChange,
}: {
  conversationId: string | null;
  disabled?: boolean;
  onBackendChange?: (backend: BackendId) => void;
  pendingValue?: BackendId;
  /** Pending-mode model/effort overrides (hero composer), held by the parent
   *  and applied to the conversation minted on first send. */
  pendingModel?: string;
  pendingEffort?: string;
  onPendingTuningChange?: (model: string, effort: string) => void;
  /** Reports the tuning shown for an existing conversation so the composer can
   *  commit it together with the selected runtime when a message is sent. */
  onTuningChange?: (model: string, effort: string) => void;
  /** Keyboard runtime-switch request (⌃1…⌃9). Token-keyed so each press
   *  applies exactly once; a stale value from before this picker mounted is
   *  ignored. Carries fixed model/effort when the slot addressed a preset. */
  backendSwitch?: ({ token: number } & RuntimeSwitchTarget) | null;
  /** Lets composer slash commands such as Codex `/model` and `/reasoning`
   *  open the same native tuning surface as the footer trigger. */
  tuningMenuOpen?: boolean;
  onTuningMenuOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation("chat");
  const [backend, setBackendState] = useState<BackendId>("pi");
  const [cliModel, setCliModel] = useState("");
  const [cliEffort, setCliEffort] = useState("");
  // Account-level quota snapshots (backend id → rate_limit_info), fed by the
  // CLI's rate_limit_event heartbeat. Shown only inside the dropdown.
  const cliRateLimits = useChatStore((s) => s.cliRateLimits);
  const { entries, enabledBackendIds } = useRuntimeCatalog();
  const availableEntries = entries.filter((entry) =>
    entry.kind === "backend"
      ? enabledBackendIds.has(entry.id) ||
        (conversationId !== null && entry.id === backend)
      : enabledBackendIds.has(entry.preset.backend),
  );

  function setBackend(b: BackendId) {
    setBackendState(b);
    onBackendChange?.(b);
  }

  useEffect(() => {
    if (conversationId || enabledBackendIds.has(pendingValue ?? "pi")) return;
    setBackend("pi");
    onPendingTuningChange?.("", "");
  }, [
    conversationId,
    enabledBackendIds,
    pendingValue,
    onPendingTuningChange,
  ]);

  useEffect(() => {
    let cancelled = false;
    if (!conversationId) {
      setBackend(pendingValue ?? "pi");
      setCliModel("");
      setCliEffort("");
      return;
    }
    api
      .getConversation(conversationId)
      .then((c) => {
        if (!cancelled && c) {
          setBackend(((c.backend as BackendId | undefined) ?? "pi"));
          setCliModel(c.cliModel ?? "");
          setCliEffort(c.cliEffort ?? "");
          onTuningChange?.(c.cliModel ?? "", c.cliEffort ?? "");
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, pendingValue, onTuningChange]);

  // Apply a keyboard runtime-switch (⌃1…⌃9) exactly once per token. The
  // ref starts at the mount-time token so a request fired before this picker
  // mounted doesn't replay on it (e.g. after switching conversations).
  const handledSwitchToken = useRef(backendSwitch?.token ?? 0);
  useEffect(() => {
    if (!backendSwitch || backendSwitch.token === handledSwitchToken.current) return;
    handledSwitchToken.current = backendSwitch.token;
    // A preset slot always applies its fixed tuning — even on the runtime
    // that's already selected, since the tuning may differ.
    if (backendSwitch.model !== undefined || backendSwitch.effort !== undefined) {
      applySwitchTarget(backendSwitch);
      return;
    }
    const shownNow = conversationId ? backend : (pendingValue ?? "pi");
    // Same runtime again is a no-op — don't reset the model/effort overrides.
    // Unless the current selection sits on a preset row: switching from a
    // preset to its plain runtime row must land there (sticky tuning) instead
    // of silently keeping the preset's fixed tuning.
    const tuningNow = conversationId
      ? { model: cliModel, effort: cliEffort }
      : { model: pendingModel ?? "", effort: pendingEffort ?? "" };
    const onPresetRow = entries.some(
      (entry) =>
        entry.kind === "preset" &&
        entry.preset.backend === shownNow &&
        entry.preset.model === tuningNow.model &&
        entry.preset.effort === tuningNow.effort,
    );
    if (backendSwitch.backend === shownNow && !onPresetRow) return;
    select(backendSwitch.backend);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendSwitch]);

  if (!conversationId && pendingValue === undefined) return null;

  const shown = conversationId ? backend : (pendingValue ?? "pi");
  const current = BACKENDS.find((b) => b.id === shown) ?? BACKENDS[0];
  const TriggerIcon = current.icon;

  // Presets are separate rows from their runtime: when the current selection
  // exactly matches a preset's fixed tuning, the checkmark belongs on the
  // preset row, not on the runtime it happens to run.
  const shownTuning = conversationId
    ? { model: cliModel, effort: cliEffort }
    : { model: pendingModel ?? "", effort: pendingEffort ?? "" };
  const matchedPreset = availableEntries.find(
    (entry) =>
      entry.kind === "preset" &&
      entry.preset.backend === shown &&
      entry.preset.model === shownTuning.model &&
      entry.preset.effort === shownTuning.effort,
  );
  const selectValue = matchedPreset ? matchedPreset.id : shown;

  /** Preset-style switch: set the runtime and its fixed tuning without
   *  reading or writing the runtime's sticky tuning. */
  function applySwitchTarget(target: RuntimeSwitchTarget) {
    if (!BACKENDS.some((x) => x.id === target.backend)) return;
    const model = target.model ?? "";
    const effort = target.effort ?? "";
    setBackend(target.backend);
    setCliModel(model);
    setCliEffort(effort);
    onTuningChange?.(model, effort);
    if (!conversationId) onPendingTuningChange?.(model, effort);
  }

  function select(id: string) {
    if (id === "__runtime_settings") {
      openRuntimeSettings();
      return;
    }
    // A preset applies its runtime plus its fixed model/effort. It bypasses
    // the sticky per-runtime tuning entirely — selecting one neither reads nor
    // writes it, so the preset always means the same thing.
    const presetEntry = entries.find(
      (entry) => entry.kind === "preset" && entry.id === id,
    );
    if (presetEntry && presetEntry.kind === "preset") {
      applySwitchTarget(runtimeSwitchTarget(presetEntry));
      return;
    }
    const b = BACKENDS.find((x) => x.id === id);
    if (!b) return;
    const tuning = backendSupportsTuning(b.id)
      ? loadCliTuningChoice(b.id)
      : { model: "", effort: "" };
    setBackend(b.id);
    setCliModel(tuning.model);
    setCliEffort(tuning.effort);
    onTuningChange?.(tuning.model, tuning.effort);
    if (backendSupportsTuning(b.id)) saveCliTuningChoice(b.id, tuning);
    if (!conversationId) {
      onPendingTuningChange?.(tuning.model, tuning.effort);
    }
  }

  function selectTuning(model: string, effort: string) {
    setCliModel(model);
    setCliEffort(effort);
    saveCliTuningChoice(shown as TunableBackendId, { model, effort });
    onTuningChange?.(model, effort);
  }

  function selectModel(model: string) {
    selectTuning(model, cliEffort);
  }

  function selectEffort(effort: string) {
    selectTuning(cliModel, effort);
  }

  return (
    <>
      <Select value={selectValue} onValueChange={select} disabled={disabled}>
        <SelectTrigger
          data-testid="runtime-picker-trigger"
          size="sm"
          style={{ ...runtimeThemeStyle(shown), color: "var(--runtime-color)" }}
          className="h-7 min-w-0 gap-1.5 border-0 bg-transparent px-2 text-xs shadow-none hover:bg-muted focus-visible:ring-0 data-[size=sm]:h-7"
        >
          <TriggerIcon className="size-3" />
          <span className="truncate">{current.label}</span>
        </SelectTrigger>
        <SelectContent align="start">
          {availableEntries.map((entry) => {
            if (entry.kind === "preset") {
              const { preset } = entry;
              const PresetIcon =
                BACKENDS.find((x) => x.id === preset.backend)?.icon ??
                CetusIcon;
              return (
                <SelectItem
                  key={entry.id}
                  value={entry.id}
                  className="text-xs *:[span]:last:w-full"
                  data-testid={`runtime-option-${entry.id}`}
                >
                  <PresetIcon className="size-4" />
                  <span className="truncate">{runtimePresetLabel(preset)}</span>
                  <RuntimeShortcutHint entryId={entry.id} />
                </SelectItem>
              );
            }
            const b = BACKENDS.find((x) => x.id === entry.id);
            if (!b) return null;
            const Icon = b.icon;
            const quota = quotaLabel(cliRateLimits[b.id]);
            return (
              <SelectItem
                key={b.id}
                value={b.id}
                // The shortcut hint is `ml-auto`; Radix wraps the children in a
                // shrink-to-fit span, so it needs to span the row to right-align.
                className="text-xs *:[span]:last:w-full"
                data-testid={`runtime-option-${b.id}`}
              >
                <Icon className="size-4" />
                <span className="truncate">{b.label}</span>
                {quota && (
                  <span
                    className={cn(
                      "ml-1 whitespace-nowrap text-2xs",
                      quota.warn
                        ? "text-amber-600 dark:text-amber-500"
                        : "text-muted-foreground/70",
                    )}
                  >
                    {quota.text}
                  </span>
                )}
                <RuntimeShortcutHint entryId={b.id} />
              </SelectItem>
            );
          })}
          <SelectItem
            value="__runtime_settings"
            className="text-xs"
            data-testid="runtime-settings-item"
          >
            <Settings2 className="size-4" />
            <span className="truncate">{t("runtime.settings")}</span>
          </SelectItem>
        </SelectContent>
      </Select>
      {backendSupportsTuning(shown) &&
        (conversationId ? (
          <CliTuningMenu
            backend={shown}
            model={cliModel}
            effort={cliEffort}
            onModelChange={selectModel}
            onEffortChange={selectEffort}
            onMigrate={matchedPreset ? undefined : selectTuning}
            disabled={disabled}
            open={tuningMenuOpen}
            onOpenChange={onTuningMenuOpenChange}
          />
        ) : onPendingTuningChange ? (
          <CliTuningMenu
            backend={shown}
            model={pendingModel ?? ""}
            effort={pendingEffort ?? ""}
            onModelChange={(m) => onPendingTuningChange(m, pendingEffort ?? "")}
            onEffortChange={(e) => onPendingTuningChange(pendingModel ?? "", e)}
            onMigrate={matchedPreset ? undefined : onPendingTuningChange}
            disabled={disabled}
            open={tuningMenuOpen}
            onOpenChange={onTuningMenuOpenChange}
          />
        ) : null)}
    </>
  );
}
