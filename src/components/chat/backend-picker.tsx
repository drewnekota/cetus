"use client";
import { useEffect, useState } from "react";
import { Bot, Check, ChevronDown, Cpu, SquareTerminal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api } from "@/lib/tauri";
import type { BackendId } from "@/lib/types";
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

export const BACKENDS: { id: BackendId; label: string; icon: LucideIcon }[] = [
  { id: "pi", label: "Cetus", icon: Bot },
  { id: "claude-code", label: "Claude Code", icon: Cpu },
  { id: "codex", label: "Codex", icon: SquareTerminal },
];

/** Model overrides offered per CLI backend. Ids are passed straight through to
 *  `claude --model` / `codex -m`; "" keeps the CLI's own configured default
 *  (also the graceful fallback if a vendor renames a model — a stale id fails
 *  that one turn with a visible error, nothing sticks). Claude ids are the
 *  CLI's aliases (always resolve to the latest of each tier). */
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
    { id: "gpt-5.5-codex", label: "GPT-5.5 Codex" },
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.5-codex-mini", label: "GPT-5.5 Codex Mini" },
  ],
};

/** Reasoning-effort levels per CLI backend, matching what each CLI accepts
 *  natively: `claude --effort` (low…max) / codex `model_reasoning_effort`
 *  (minimal…xhigh). "" keeps the CLI's configured default. */
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
    { id: "minimal", label: "Minimal" },
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
    { id: "xhigh", label: "XHigh" },
  ],
};

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
  const models = CLI_MODELS[backend];
  const efforts = CLI_EFFORTS[backend];
  const curModel = models.find((m) => m.id === model) ?? models[0];
  const curEffort = efforts.find((e) => e.id === effort) ?? efforts[0];
  const label =
    curEffort.id === ""
      ? curModel.label
      : `${curModel.label} · ${curEffort.label}`;
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
            <span className="flex-1">{e.label}</span>
            {e.id === curEffort.id && <Check className="size-3.5" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="text-xs">
            {curModel.label}
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
                <span className="flex-1">{m.label}</span>
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

  if (!conversationId && pendingValue === undefined) return null;

  const shown = conversationId ? backend : (pendingValue ?? "pi");
  const current = BACKENDS.find((b) => b.id === shown) ?? BACKENDS[0];
  const TriggerIcon = current.icon;

  function select(id: string) {
    const b = BACKENDS.find((x) => x.id === id);
    if (!b) return;
    setBackend(b.id);
    // Model/effort overrides belong to one backend's catalog; switching
    // backends resets both to that CLI's defaults.
    setCliModel("");
    setCliEffort("");
    if (conversationId) {
      api.setConversationBackend(conversationId, b.id).catch(() => {});
      api.setConversationCliModel(conversationId, "", "").catch(() => {});
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
