"use client";
import { useEffect, useRef, useState } from "react";
import { Bot, Check, ChevronDown, Cpu, SquareTerminal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api } from "@/lib/tauri";
import type { BackendId, CliDefaults } from "@/lib/types";
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
import {
  matchesShortcut,
  shortcutDisplay,
  useKeyboardShortcuts,
  type ShortcutId,
} from "@/lib/keyboard-shortcuts";

export const BACKENDS: { id: BackendId; label: string; icon: LucideIcon }[] = [
  { id: "pi", label: "Cetus", icon: Bot },
  { id: "claude-code", label: "Claude Code", icon: Cpu },
  { id: "codex", label: "Codex", icon: SquareTerminal },
];

/** The user-editable shortcut bound to each runtime (⌃1/⌃2/⌃3 by default). */
export const RUNTIME_SHORTCUT_IDS: Record<BackendId, ShortcutId> = {
  pi: "runtimeCetus",
  "claude-code": "runtimeClaudeCode",
  codex: "runtimeCodex",
};

/** Window keydown → runtime switch, matched against the user's (editable)
 *  shortcut map. For surfaces that own their backend state directly — the
 *  quick launcher and the task/automation dialogs. The main composer instead
 *  routes through page.tsx's modal-guarded handler, so don't enable this
 *  where that handler is already live. */
export function useRuntimeShortcuts(
  onSwitch: (backend: BackendId) => void,
  enabled: boolean = true,
) {
  const shortcuts = useKeyboardShortcuts();
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const target: BackendId | null = matchesShortcut(e, shortcuts.runtimeCetus)
        ? "pi"
        : matchesShortcut(e, shortcuts.runtimeClaudeCode)
          ? "claude-code"
          : matchesShortcut(e, shortcuts.runtimeCodex)
            ? "codex"
            : null;
      if (!target) return;
      e.preventDefault();
      onSwitch(target);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, shortcuts, onSwitch]);
}

/** Right-aligned shortcut hint inside a runtime SelectItem (e.g. "⌃2").
 *  Live-updates when the user rebinds the shortcut; renders nothing when
 *  unassigned. */
export function RuntimeShortcutHint({ backend }: { backend: BackendId }) {
  const shortcuts = useKeyboardShortcuts();
  const display = shortcutDisplay(shortcuts[RUNTIME_SHORTCUT_IDS[backend]]);
  if (!display || display === "Unassigned") return null;
  return (
    <span className="ml-auto pl-3 text-[10px] tracking-wide text-muted-foreground/70">
      {display}
    </span>
  );
}

/** Model overrides offered per CLI backend. Ids are passed straight through to
 *  `claude --model` / `codex -m`; "" keeps the CLI's own configured default
 *  (also the graceful fallback if a vendor renames a model — a stale id fails
 *  that one turn with a visible error, nothing sticks). Claude ids are the
 *  CLI's aliases (always resolve to the latest of each tier). The codex list
 *  is only the fallback when its models_cache.json can't be read — normally
 *  the live catalog from `api.getCliDefaults` replaces it. */
export const CLI_MODELS: Record<
  Exclude<BackendId, "pi">,
  { id: string; label: string }[]
> = {
  "claude-code": [
    { id: "", label: "Default" },
    { id: "fable", label: "Fable" },
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
    { id: "haiku", label: "Haiku" },
  ],
  codex: [
    { id: "", label: "Default" },
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.4-mini", label: "GPT-5.4-Mini" },
    { id: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" },
  ],
};

/** Reasoning-effort levels per CLI backend, matching what each CLI accepts
 *  natively: `claude --effort` (low…max) / codex `model_reasoning_effort`
 *  (low…xhigh). "" keeps the CLI's configured default. */
export const CLI_EFFORTS: Record<
  Exclude<BackendId, "pi">,
  { id: string; label: string }[]
> = {
  "claude-code": [
    { id: "", label: "Default" },
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
    { id: "xhigh", label: "XHigh" },
    { id: "max", label: "Max" },
  ],
  codex: [
    { id: "", label: "Default" },
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
    { id: "xhigh", label: "XHigh" },
  ],
};

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

/** Human label for a raw configured default: exact catalog id first, then
 *  substring (claude configs hold full ids like "claude-fable-5[1m]" while the
 *  catalog carries aliases like "fable"), else the raw string as-is. */
function resolveDefaultLabel(
  raw: string | null | undefined,
  catalog: { id: string; label: string }[],
): string | null {
  if (!raw) return null;
  const exact = catalog.find((m) => m.id && m.id === raw);
  if (exact) return exact.label;
  const sub = catalog.find((m) => m.id && raw.includes(m.id));
  return sub ? sub.label : raw;
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
  disabled,
  className,
}: {
  backend: Exclude<BackendId, "pi">;
  model: string;
  effort: string;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  // On-disk defaults (and codex's live model catalog) so "Default" echoes what
  // it actually resolves to; until they load, plain "Default" renders.
  const [defaults, setDefaults] = useState<CliDefaults | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchCliDefaults(backend).then((d) => {
      if (!cancelled) setDefaults(d);
    });
    return () => {
      cancelled = true;
    };
  }, [backend]);

  const models = defaults?.models
    ? [{ id: "", label: "Default" }, ...defaults.models]
    : CLI_MODELS[backend];
  const efforts = CLI_EFFORTS[backend];
  const curModel = models.find((m) => m.id === model) ?? models[0];
  const curEffort = efforts.find((e) => e.id === effort) ?? efforts[0];
  const defaultModelLabel = resolveDefaultLabel(defaults?.model, models);
  const defaultEffortLabel = resolveDefaultLabel(defaults?.effort, efforts);
  // Menu rows spell the resolution out ("Default (Fable)"); the compact
  // trigger shows the resolved name directly.
  const modelRowLabel = (m: { id: string; label: string }) =>
    m.id === "" && defaultModelLabel ? `Default (${defaultModelLabel})` : m.label;
  const effortRowLabel = (e: { id: string; label: string }) =>
    e.id === "" && defaultEffortLabel ? `Default (${defaultEffortLabel})` : e.label;
  const shownModel =
    curModel.id === "" ? (defaultModelLabel ?? curModel.label) : curModel.label;
  const shownEffort =
    curEffort.id === "" ? defaultEffortLabel : curEffort.label;
  const label = shownEffort ? `${shownModel} · ${shownEffort}` : shownModel;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50",
            className,
          )}
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Reasoning
        </DropdownMenuLabel>
        {efforts.map((e) => (
          <DropdownMenuItem
            key={e.id || "default"}
            className="text-xs"
            onClick={() => onEffortChange(e.id)}
          >
            <span className="flex-1">{effortRowLabel(e)}</span>
            {e.id === curEffort.id && <Check className="size-3.5" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="text-xs">
            {modelRowLabel(curModel)}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-44">
            <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Model
            </DropdownMenuLabel>
            {models.map((m) => (
              <DropdownMenuItem
                key={m.id || "default"}
                className="text-xs"
                onClick={() => onModelChange(m.id)}
              >
                <span className="flex-1">{modelRowLabel(m)}</span>
                {m.id === curModel.id && <Check className="size-3.5" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Self-contained picker: reads the conversation's current backend and switches
 *  it via the API. Rendered next to the model picker in the composer.
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
  backendSwitch,
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
  /** Keyboard runtime-switch request (⌃1/⌃2/⌃3). Token-keyed so each press
   *  applies exactly once; a stale value from before this picker mounted is
   *  ignored. */
  backendSwitch?: { token: number; backend: BackendId } | null;
}) {
  const [backend, setBackendState] = useState<BackendId>("pi");
  const [cliModel, setCliModel] = useState("");
  const [cliEffort, setCliEffort] = useState("");

  function setBackend(b: BackendId) {
    setBackendState(b);
    onBackendChange?.(b);
  }

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
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, pendingValue]);

  // Apply a keyboard runtime-switch (⌃1/⌃2/⌃3) exactly once per token. The
  // ref starts at the mount-time token so a request fired before this picker
  // mounted doesn't replay on it (e.g. after switching conversations).
  const handledSwitchToken = useRef(backendSwitch?.token ?? 0);
  useEffect(() => {
    if (!backendSwitch || backendSwitch.token === handledSwitchToken.current) return;
    handledSwitchToken.current = backendSwitch.token;
    const shownNow = conversationId ? backend : (pendingValue ?? "pi");
    // Same runtime again is a no-op — don't reset the model/effort overrides.
    if (backendSwitch.backend === shownNow) return;
    select(backendSwitch.backend);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendSwitch]);

  if (!conversationId && pendingValue === undefined) return null;

  const shown = conversationId ? backend : (pendingValue ?? "pi");
  const current = BACKENDS.find((b) => b.id === shown) ?? BACKENDS[0];
  const TriggerIcon = current.icon;

  function select(id: string) {
    const b = BACKENDS.find((x) => x.id === id);
    if (!b) return;
    setBackend(b.id);
    // Model/effort overrides belong to one backend's catalog; switching
    // backends resets both to that CLI's defaults. Only here (a user pick) —
    // resetting on the load path would clobber a hydrated pending choice.
    setCliModel("");
    setCliEffort("");
    if (conversationId) {
      api.setConversationBackend(conversationId, b.id).catch(() => {});
      api.setConversationCliModel(conversationId, "", "").catch(() => {});
    } else {
      onPendingTuningChange?.("", "");
    }
  }

  function selectModel(model: string) {
    setCliModel(model);
    if (conversationId) {
      api.setConversationCliModel(conversationId, model, cliEffort).catch(() => {});
    }
  }

  function selectEffort(effort: string) {
    setCliEffort(effort);
    if (conversationId) {
      api.setConversationCliModel(conversationId, cliModel, effort).catch(() => {});
    }
  }

  return (
    <>
      <Select value={shown} onValueChange={select} disabled={disabled}>
        <SelectTrigger
          size="sm"
          className={
            "h-7 gap-1.5 border-0 bg-transparent px-2 text-xs shadow-none hover:bg-muted focus-visible:ring-0 data-[size=sm]:h-7 " +
            // Echo the composer frame's runtime tint on the trigger label.
            (shown === "claude-code"
              ? "text-[#d97757] hover:text-[#d97757]"
              : shown === "codex"
                ? "text-[#10a37f] hover:text-[#10a37f]"
                : "text-muted-foreground hover:text-foreground")
          }
        >
          <TriggerIcon className="size-3" />
          <span className="truncate">{current.label}</span>
        </SelectTrigger>
        <SelectContent align="start">
          {BACKENDS.map((b) => {
            const Icon = b.icon;
            return (
              <SelectItem key={b.id} value={b.id} className="text-xs">
                <Icon className="size-4" />
                <span className="truncate">{b.label}</span>
                <RuntimeShortcutHint backend={b.id} />
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      {shown !== "pi" &&
        (conversationId ? (
          <CliTuningMenu
            backend={shown}
            model={cliModel}
            effort={cliEffort}
            onModelChange={selectModel}
            onEffortChange={selectEffort}
            disabled={disabled}
          />
        ) : onPendingTuningChange ? (
          <CliTuningMenu
            backend={shown}
            model={pendingModel ?? ""}
            effort={pendingEffort ?? ""}
            onModelChange={(m) => onPendingTuningChange(m, pendingEffort ?? "")}
            onEffortChange={(e) => onPendingTuningChange(pendingModel ?? "", e)}
            disabled={disabled}
          />
        ) : null)}
    </>
  );
}
