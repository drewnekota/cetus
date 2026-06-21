"use client";
import { useState } from "react";
import { Gauge, Sparkles, Zap } from "lucide-react";
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

/** A single user-facing preset that bundles model + reasoning depth (+ Ultra
 *  Code). The two-axis model/reasoning matrix is collapsed into these four so
 *  the composer reads as one clear choice instead of three controls. */
type PresetId = "daily" | "high" | "max" | "ultra";

const PRESETS: {
  id: PresetId;
  /** i18n key for the preset label (resolved at render). */
  labelKey: string;
  /** i18n key for the tooltip hint (resolved at render). */
  hintKey: string;
  icon: LucideIcon;
  model: DsModel;
  reasoning: ReasoningLevel;
  ultra: boolean;
}[] = [
  {
    id: "daily",
    labelKey: "model.daily",
    hintKey: "model.dailyHint",
    icon: Zap,
    model: "pro",
    reasoning: "non_think",
    ultra: false,
  },
  {
    id: "high",
    labelKey: "model.high",
    hintKey: "model.highHint",
    icon: Gauge,
    model: "pro",
    reasoning: "think_high",
    ultra: false,
  },
  {
    id: "max",
    labelKey: "model.max",
    hintKey: "model.maxHint",
    icon: Gauge,
    model: "pro",
    reasoning: "think_max",
    ultra: false,
  },
  {
    id: "ultra",
    labelKey: "model.ultra",
    hintKey: "model.ultraHint",
    icon: Sparkles,
    model: "pro",
    reasoning: "think_max",
    ultra: true,
  },
];

/** Resolve which preset the current (model, reasoning, ultra) maps to. Ultra
 *  wins; otherwise the first non-ultra preset whose reasoning matches (every
 *  preset is Pro now), with a sensible fallback so an off-grid combo still
 *  highlights something. */
function activePreset(value: ModelChoice, ultra: boolean): PresetId {
  if (ultra) return "ultra";
  const exact = PRESETS.find(
    (p) => !p.ultra && p.model === value.model && p.reasoning === value.reasoning,
  );
  if (exact) return exact.id;
  return "high";
}

interface Props {
  value: ModelChoice;
  onChange: (next: ModelChoice) => void;
  /** Ultra Code state + toggle. When omitted, the UltraCode preset is hidden. */
  ultra?: boolean;
  onUltraToggle?: () => void;
  /** Disable only the Ultra row (e.g. mid-stream) while the rest stay live. */
  lockUltra?: boolean;
  disabled?: boolean;
}

export function ModelPicker({ value, onChange, ultra, onUltraToggle, lockUltra, disabled }: Props) {
  const { t } = useTranslation("chat");
  const [hoveredPreset, setHoveredPreset] = useState<PresetId | null>(null);
  const active = activePreset(value, !!ultra);
  // Only offer UltraCode where the parent can actually drive the Ultra switch.
  const presets = onUltraToggle ? PRESETS : PRESETS.filter((p) => !p.ultra);
  const current = presets.find((p) => p.id === active) ?? presets[0];
  const TriggerIcon = current.icon;

  function select(id: string) {
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    // Ignore Ultra changes while it's locked (the trigger stays on the current
    // value since the radio item is disabled, but guard here as well).
    if (lockUltra && p.ultra !== !!ultra) return;
    onChange({ model: p.model, reasoning: p.reasoning });
    // onUltraToggle is a plain toggle — only fire it when the target differs.
    if (onUltraToggle && p.ultra !== !!ultra) onUltraToggle();
  }

  return (
    <Select
      value={active}
      onValueChange={select}
      onOpenChange={() => setHoveredPreset(null)}
      disabled={disabled}
    >
      <SelectTrigger
        size="sm"
        className="h-7 gap-1.5 border-0 bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-muted hover:text-foreground focus-visible:ring-0 data-[size=sm]:h-7"
      >
        <TriggerIcon className="size-3" />
        <span className="truncate">{t(current.labelKey)}</span>
      </SelectTrigger>
      <SelectContent align="start">
        {presets.map((p) => {
          const Icon = p.icon;
          return (
            <Tooltip key={p.id} open={hoveredPreset === p.id}>
              <TooltipTrigger asChild>
                <SelectItem
                  value={p.id}
                  disabled={lockUltra && p.ultra && !ultra}
                  onPointerEnter={() => setHoveredPreset(p.id)}
                  onPointerLeave={() => setHoveredPreset(null)}
                  className="text-xs"
                >
                  <Icon className="size-4" />
                  <span className="truncate">{t(p.labelKey)}</span>
                </SelectItem>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>
                {t(p.hintKey)}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </SelectContent>
    </Select>
  );
}
