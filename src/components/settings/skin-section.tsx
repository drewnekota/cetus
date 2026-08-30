"use client";
// Skin picker for the Appearance settings section: a row of preset cards, then
// a per-variant editor for the seed colors + contrast. Everything applies live
// (theme-prefs re-derives the variant and writes inline vars on <html>).

import { useEffect, useMemo, useState } from "react";
import { Check, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";
import {
  SEED_COLOR_KEYS,
  SKIN_PRESETS,
  applySkin,
  getSkinPreference,
  getSkinPreset,
  isCustomized,
  normalizeHex,
  saveSkinPreference,
  seedsEqual,
  skinFromPreset,
  type SeedColorKey,
  type SkinPreference,
  type SkinPreset,
  type SkinSeeds,
  type SkinVariant,
} from "@/lib/skin-prefs";
import { getThemePreference, resolveTheme } from "@/lib/theme-prefs";

const SEED_LABEL_KEYS: Record<SeedColorKey, string> = {
  surface: "appearance.skin.seed.surface",
  ink: "appearance.skin.seed.ink",
  accent: "appearance.skin.seed.accent",
  diffAdded: "appearance.skin.seed.diffAdded",
  diffRemoved: "appearance.skin.seed.diffRemoved",
  skill: "appearance.skin.seed.skill",
};

export function SkinSection() {
  const { t } = useTranslation("settings");
  const [pref, setPref] = useState<SkinPreference>(() => skinFromPreset("cetus"));
  const [variant, setVariant] = useState<SkinVariant>("light");
  const [loaded, setLoaded] = useState(false);

  // Reflect the persisted skin once we're in the browser (localStorage), and
  // open the editor on whichever variant is on screen right now.
  useEffect(() => {
    setPref(getSkinPreference());
    setVariant(resolveTheme(getThemePreference()));
    setLoaded(true);
  }, []);

  function commit(next: SkinPreference) {
    setPref(next);
    saveSkinPreference(next);
    applySkin(next, resolveTheme(getThemePreference()));
  }

  function choosePreset(id: string) {
    commit(skinFromPreset(id));
  }

  function updateSeed(patch: Partial<SkinSeeds>) {
    commit({ ...pref, [variant]: { ...pref[variant], ...patch } });
  }

  function resetVariant() {
    const base = getSkinPreset(pref.presetId);
    commit({ ...pref, [variant]: { ...base[variant] } });
  }

  const base = getSkinPreset(pref.presetId);
  const variantDirty = !seedsEqual(pref[variant], base[variant]);
  const customized = isCustomized(pref);

  return (
    <div className="space-y-5">
      <div className="space-y-0.5">
        <Label className="font-medium">{t("appearance.skin.label")}</Label>
        <p className="text-xs text-muted-foreground">
          {t("appearance.skin.description")}
        </p>
      </div>

      <div
        role="radiogroup"
        aria-label={t("appearance.skin.label")}
        className="grid grid-cols-2 gap-2 sm:grid-cols-4"
      >
        {SKIN_PRESETS.map((p) => (
          <PresetCard
            key={p.id}
            preset={p}
            selected={loaded && pref.presetId === p.id}
            customized={loaded && pref.presetId === p.id && customized}
            onSelect={() => choosePreset(p.id)}
            customizedLabel={t("appearance.skin.customized")}
          />
        ))}
      </div>

      <div className="rounded-lg border border-border">
        <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
          <div className="flex items-center gap-1 rounded-md bg-muted p-0.5">
            {(["light", "dark"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setVariant(v)}
                className={cn(
                  "rounded px-2.5 py-1 text-xs font-medium transition-colors",
                  variant === v
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t(`appearance.skin.variant.${v}`)}
              </button>
            ))}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            disabled={!variantDirty}
            onClick={resetVariant}
          >
            <RotateCcw className="size-3.5" />
            {t("appearance.skin.reset", { preset: base.name })}
          </Button>
        </div>

        <div className="grid gap-x-6 gap-y-3 p-3 sm:grid-cols-2">
          {SEED_COLOR_KEYS.map((key) => (
            <SeedColorRow
              key={`${variant}-${key}`}
              label={t(SEED_LABEL_KEYS[key])}
              value={pref[variant][key]}
              onChange={(hex) => updateSeed({ [key]: hex })}
            />
          ))}
          <div className="flex items-center justify-between gap-3 sm:col-span-2">
            <Label
              htmlFor={`skin-contrast-${variant}`}
              className="text-xs font-normal text-foreground"
            >
              {t("appearance.skin.seed.contrast")}
            </Label>
            <div className="flex items-center gap-3">
              <input
                id={`skin-contrast-${variant}`}
                type="range"
                min={0}
                max={100}
                step={5}
                value={pref[variant].contrast}
                onChange={(e) =>
                  updateSeed({ contrast: Number(e.target.value) })
                }
                className="h-1.5 w-40 cursor-pointer accent-primary"
              />
              <span className="w-8 text-right font-mono text-xs tabular-nums text-muted-foreground">
                {pref[variant].contrast}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PresetCard({
  preset,
  selected,
  customized,
  customizedLabel,
  onSelect,
}: {
  preset: SkinPreset;
  selected: boolean;
  customized: boolean;
  customizedLabel: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "group relative overflow-hidden rounded-lg border text-left transition-colors",
        selected
          ? "border-primary ring-1 ring-primary"
          : "border-border hover:border-foreground/25",
      )}
    >
      <div className="flex h-14">
        <Swatch seeds={preset.light} />
        <Swatch seeds={preset.dark} />
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border px-2.5 py-1.5">
        <span className="truncate text-xs font-medium">
          {preset.name}
          {customized ? (
            <span className="ml-1 font-normal text-muted-foreground">
              · {customizedLabel}
            </span>
          ) : null}
        </span>
        {selected ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
      </div>
    </button>
  );
}

/** A miniature of one variant: surface background, ink text, accent chip. */
function Swatch({ seeds }: { seeds: SkinSeeds }) {
  return (
    <div
      className="flex flex-1 flex-col justify-between p-2"
      style={{ background: seeds.surface, color: seeds.ink }}
    >
      <span className="text-sm font-semibold leading-none">Aa</span>
      <div className="flex items-center gap-1">
        <span
          className="size-3 rounded-full"
          style={{ background: seeds.accent }}
        />
        <span
          className="size-2 rounded-full"
          style={{ background: seeds.diffAdded }}
        />
        <span
          className="size-2 rounded-full"
          style={{ background: seeds.diffRemoved }}
        />
        <span
          className="size-2 rounded-full"
          style={{ background: seeds.skill }}
        />
      </div>
    </div>
  );
}

function SeedColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  // Local text state so partially typed hex doesn't get rejected mid-keystroke;
  // committed on blur / Enter, or immediately when it's already valid.
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const id = useMemo(() => `skin-seed-${label.replace(/\s+/g, "-")}`, [label]);

  function commitText() {
    const hex = normalizeHex(text);
    if (hex && hex !== value) onChange(hex);
    else setText(value);
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id} className="text-xs font-normal text-foreground">
        {label}
      </Label>
      <div className="flex items-center gap-2">
        <label
          className="relative size-6 shrink-0 cursor-pointer overflow-hidden rounded-md border border-border"
          style={{ background: value }}
          aria-label={label}
        >
          <input
            type="color"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
          />
        </label>
        <Input
          id={id}
          value={text}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            const hex = normalizeHex(e.target.value);
            if (hex && /^#[0-9a-fA-F]{6}$/.test(e.target.value.trim())) {
              onChange(hex);
            }
          }}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="h-7 w-24 font-mono text-xs"
        />
      </div>
    </div>
  );
}
