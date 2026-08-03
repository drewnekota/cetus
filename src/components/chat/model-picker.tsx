"use client";
import { useState } from "react";
import { Check, ChevronDown, Cpu, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { DsModel, ModelChoice, ReasoningLevel } from "@/lib/types";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTranslation } from "@/lib/i18n";

/** Model tiers offered for the built-in DeepSeek runtime. Ids are the persisted
 *  `ds_model` values, passed straight through to the pi RPC `set_model`. */
const MODELS: { id: DsModel; labelKey: string; hintKey: string; icon: LucideIcon }[] = [
  {
    id: "flash",
    labelKey: "model.flash",
    hintKey: "model.flashHint",
    icon: Zap,
  },
  {
    id: "pro",
    labelKey: "model.pro",
    hintKey: "model.proHint",
    icon: Cpu,
  },
];

/** Reasoning-effort levels, matching the DeepSeek V4 thinkingLevelMap exactly
 *  (off / high / max — the levels the bundled pi runtime accepts). */
const EFFORTS: { id: ReasoningLevel; labelKey: string; hintKey: string }[] = [
  { id: "non_think", labelKey: "model.off", hintKey: "model.offHint" },
  { id: "think_high", labelKey: "model.high", hintKey: "model.highHint" },
  { id: "think_max", labelKey: "model.max", hintKey: "model.maxHint" },
];

interface Props {
  value: ModelChoice;
  onChange: (next: ModelChoice) => void;
  disabled?: boolean;
}

/** Combined model + reasoning-effort menu for the built-in pi runtime, styled
 *  after CliTuningMenu (the claude-code/codex picker): one compact trigger
 *  ("Pro · High"), the reasoning levels flat on top, and the model catalog in
 *  a cascading submenu. */
export function ModelPicker({ value, onChange, disabled }: Props) {
  const { t } = useTranslation("chat");
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const curModel = MODELS.find((m) => m.id === value.model) ?? MODELS[1];
  const curEffort = EFFORTS.find((e) => e.id === value.reasoning) ?? EFFORTS[1];

  return (
    <DropdownMenu onOpenChange={(open) => !open && setHoveredKey(null)}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <span className="truncate">
            {t(curModel.labelKey)} · {t(curEffort.labelKey)}
          </span>
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Reasoning
        </DropdownMenuLabel>
        {EFFORTS.map((e) => (
          <Tooltip key={e.id} open={hoveredKey === e.id}>
            <TooltipTrigger asChild>
              <DropdownMenuItem
                className="text-xs"
                onPointerEnter={() => setHoveredKey(e.id)}
                onPointerLeave={() => setHoveredKey(null)}
                onClick={() => onChange({ model: value.model, reasoning: e.id })}
              >
                <span className="flex-1">{t(e.labelKey)}</span>
                {e.id === curEffort.id && <Check className="size-3.5" />}
              </DropdownMenuItem>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              {t(e.hintKey)}
            </TooltipContent>
          </Tooltip>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="text-xs">
            {t(curModel.labelKey)}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-44">
            <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Model
            </DropdownMenuLabel>
            {MODELS.map((m) => {
              const Icon = m.icon;
              return (
                <Tooltip key={m.id} open={hoveredKey === m.id}>
                  <TooltipTrigger asChild>
                    <DropdownMenuItem
                      className="text-xs"
                      onPointerEnter={() => setHoveredKey(m.id)}
                      onPointerLeave={() => setHoveredKey(null)}
                      onClick={() =>
                        onChange({ model: m.id, reasoning: value.reasoning })
                      }
                    >
                      <Icon className="size-4" />
                      <span className="flex-1 truncate">{t(m.labelKey)}</span>
                      {m.id === curModel.id && <Check className="size-3.5" />}
                    </DropdownMenuItem>
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8}>
                    {t(m.hintKey)}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
