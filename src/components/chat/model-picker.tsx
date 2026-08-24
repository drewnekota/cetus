"use client";
import { useEffect, useState } from "react";
import { Check, ChevronDown, Cpu, Server, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { DsModel, ModelChoice, ReasoningLevel } from "@/lib/types";
import { api, type CustomProviderView } from "@/lib/tauri";
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

/** pi's full reasoning axis. The DeepSeek built-ins expose off/high/max
 *  (BUILTIN_LEVELS); custom models expose whichever levels their settings
 *  enable (Settings → Models). */
const EFFORTS: { id: ReasoningLevel; labelKey: string; hintKey: string }[] = [
  { id: "off", labelKey: "model.off", hintKey: "model.offHint" },
  { id: "minimal", labelKey: "model.minimal", hintKey: "model.minimalHint" },
  { id: "low", labelKey: "model.low", hintKey: "model.lowHint" },
  { id: "medium", labelKey: "model.medium", hintKey: "model.mediumHint" },
  { id: "high", labelKey: "model.high", hintKey: "model.highHint" },
  { id: "xhigh", labelKey: "model.xhigh", hintKey: "model.xhighHint" },
  { id: "max", labelKey: "model.max", hintKey: "model.maxHint" },
];

const BUILTIN_LEVELS: ReasoningLevel[] = ["off", "high", "max"];

/** One selectable custom model, flattened from the provider list. `value` is
 *  the persisted `"<provider-id>/<model-id>"` form. */
interface CustomEntry {
  value: string;
  label: string;
  providerName: string;
  /** The thinking levels this model enables; empty = no reasoning knob. */
  levels: ReasoningLevel[];
}

function flattenProviders(providers: CustomProviderView[]): CustomEntry[] {
  return providers.flatMap((p) =>
    p.models.map((m) => ({
      value: `${p.id}/${m.id}`,
      label: m.name || m.id,
      providerName: p.name,
      levels: m.reasoning
        ? EFFORTS.map((e) => e.id).filter((id) => id in m.thinkingLevels)
        : [],
    })),
  );
}

/** Mirror of the host-side clamp (up the axis first, then down) so the
 *  trigger shows the level that will actually be sent. */
function clampDisplayEffort(
  efforts: { id: ReasoningLevel; labelKey: string; hintKey: string }[],
  requested: ReasoningLevel,
) {
  const order = EFFORTS.map((e) => e.id);
  const idx = order.indexOf(requested);
  if (idx === -1) return undefined;
  const walk = [...order.slice(idx), ...order.slice(0, idx).reverse()];
  for (const id of walk) {
    const hit = efforts.find((e) => e.id === id);
    if (hit) return hit;
  }
  return undefined;
}

interface Props {
  value: ModelChoice;
  onChange: (next: ModelChoice) => void;
  disabled?: boolean;
}

/** Combined model + reasoning-effort menu for the built-in pi runtime, styled
 *  after CliTuningMenu (the claude-code/codex picker): one compact trigger
 *  ("Pro · High"), the reasoning levels flat on top (built-in tiers only), and
 *  the model catalog — built-in tiers plus the user's custom providers from
 *  Settings → Models — in a cascading submenu. */
export function ModelPicker({ value, onChange, disabled }: Props) {
  const { t } = useTranslation("chat");
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [custom, setCustom] = useState<CustomEntry[]>([]);

  useEffect(() => {
    api
      .listCustomProviders()
      .then((p) => setCustom(flattenProviders(p)))
      .catch(() => {});
  }, []);

  const builtin = MODELS.find((m) => m.id === value.model);
  const customCur = custom.find((c) => c.value === value.model);
  const rawEffort =
    EFFORTS.find((e) => e.id === value.reasoning) ??
    EFFORTS.find((e) => e.id === "high")!;
  // A custom model not in the fetched list (deleted, or the list hasn't
  // loaded yet) still shows its raw id rather than lying with "Pro".
  const modelLabel = builtin
    ? t(builtin.labelKey)
    : customCur?.label ?? value.model.split("/").slice(1).join("/") ?? value.model;
  const isBuiltin = Boolean(builtin);
  // Which reasoning rows apply to the current model: off/high/max for the
  // built-ins, the model's enabled set for custom, none otherwise.
  const efforts = isBuiltin
    ? EFFORTS.filter((e) => BUILTIN_LEVELS.includes(e.id))
    : EFFORTS.filter((e) => customCur?.levels.includes(e.id));
  const showEffort = efforts.length > 0;
  // A level the current model doesn't expose is clamped host-side
  // (model_bridge walks up then down the axis) — mirror that in the trigger
  // instead of showing a level that won't be used.
  const curEffort =
    efforts.find((e) => e.id === rawEffort.id) ??
    clampDisplayEffort(efforts, rawEffort.id) ??
    rawEffort;

  return (
    <DropdownMenu onOpenChange={(open) => !open && setHoveredKey(null)}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <span className="max-w-40 truncate">
            {showEffort ? `${modelLabel} · ${t(curEffort.labelKey)}` : modelLabel}
          </span>
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        {showEffort && (
          <>
            <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Reasoning
            </DropdownMenuLabel>
            {efforts.map((e) => (
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
          </>
        )}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="text-xs">
            {modelLabel}
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
                      {m.id === value.model && <Check className="size-3.5" />}
                    </DropdownMenuItem>
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8}>
                    {t(m.hintKey)}
                  </TooltipContent>
                </Tooltip>
              );
            })}
            {custom.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t("model.custom")}
                </DropdownMenuLabel>
                {custom.map((c) => (
                  <Tooltip key={c.value} open={hoveredKey === c.value}>
                    <TooltipTrigger asChild>
                      <DropdownMenuItem
                        className="text-xs"
                        onPointerEnter={() => setHoveredKey(c.value)}
                        onPointerLeave={() => setHoveredKey(null)}
                        onClick={() =>
                          onChange({ model: c.value, reasoning: value.reasoning })
                        }
                      >
                        <Server className="size-4" />
                        <span className="flex-1 truncate">{c.label}</span>
                        {c.value === value.model && <Check className="size-3.5" />}
                      </DropdownMenuItem>
                    </TooltipTrigger>
                    <TooltipContent side="right" sideOffset={8}>
                      {c.providerName}
                    </TooltipContent>
                  </Tooltip>
                ))}
              </>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
