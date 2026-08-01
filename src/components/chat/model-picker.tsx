"use client";
import { useState } from "react";
import { Cpu, Gauge, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { DsModel, ModelChoice, ReasoningLevel } from "@/lib/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
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

const triggerClass =
  "inline-flex h-7 items-center gap-1 rounded-md border-0 bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-muted hover:text-foreground focus-visible:ring-0 data-[size=sm]:h-7";

export function ModelPicker({ value, onChange, disabled }: Props) {
  const { t } = useTranslation("chat");
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const curModel = MODELS.find((m) => m.id === value.model) ?? MODELS[1];
  const curEffort = EFFORTS.find((e) => e.id === value.reasoning) ?? EFFORTS[1];
  const ModelIcon = curModel.icon;

  function selectModel(model: DsModel) {
    onChange({ model, reasoning: value.reasoning });
  }

  function selectEffort(reasoning: ReasoningLevel) {
    onChange({ model: value.model, reasoning });
  }

  return (
    <>
      <Select
        value={value.model}
        onValueChange={(v) => selectModel(v as DsModel)}
        onOpenChange={(open) => !open && setHoveredKey(null)}
        disabled={disabled}
      >
        <SelectTrigger size="sm" className={triggerClass}>
          <ModelIcon className="size-3" />
          <span className="truncate">{t(curModel.labelKey)}</span>
        </SelectTrigger>
        <SelectContent align="start">
          {MODELS.map((m) => {
            const Icon = m.icon;
            return (
              <Tooltip key={m.id} open={hoveredKey === m.id}>
                <TooltipTrigger asChild>
                  <SelectItem
                    value={m.id}
                    onPointerEnter={() => setHoveredKey(m.id)}
                    onPointerLeave={() => setHoveredKey(null)}
                    className="text-xs"
                  >
                    <Icon className="size-4" />
                    <span className="truncate">{t(m.labelKey)}</span>
                  </SelectItem>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  {t(m.hintKey)}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </SelectContent>
      </Select>
      <Select
        value={value.reasoning}
        onValueChange={(v) => selectEffort(v as ReasoningLevel)}
        onOpenChange={(open) => !open && setHoveredKey(null)}
        disabled={disabled}
      >
        <SelectTrigger size="sm" className={triggerClass}>
          <Gauge className="size-3" />
          <span className="truncate">{t(curEffort.labelKey)}</span>
        </SelectTrigger>
        <SelectContent align="start">
          {EFFORTS.map((e) => (
            <Tooltip key={e.id} open={hoveredKey === e.id}>
              <TooltipTrigger asChild>
                <SelectItem
                  value={e.id}
                  onPointerEnter={() => setHoveredKey(e.id)}
                  onPointerLeave={() => setHoveredKey(null)}
                  className="text-xs"
                >
                  <span className="flex-1">{t(e.labelKey)}</span>
                </SelectItem>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>
                {t(e.hintKey)}
              </TooltipContent>
            </Tooltip>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}
