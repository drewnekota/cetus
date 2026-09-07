"use client";

import * as React from "react";

import { Input } from "@/components/ui/input";

type NumberInputProps = Omit<
  React.ComponentProps<typeof Input>,
  "type" | "value" | "onChange" | "defaultValue"
> & {
  value: number;
  /** Called with the clamped value when the user commits (blur / Enter),
   *  or immediately while typing when the draft already parses to a valid number. */
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  /** Value to fall back to when the field is committed empty or invalid.
   *  Defaults to the last valid value. */
  fallback?: number;
};

function clamp(n: number, min?: number, max?: number) {
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

/**
 * Number input that lets the user freely edit the text (including clearing it)
 * and only clamps / commits on blur or Enter. A controlled `<input type="number">`
 * that clamps on every keystroke makes it impossible to delete a digit before
 * typing a replacement, e.g. changing "1" to "3".
 */
function NumberInput({
  value,
  onValueChange,
  min,
  max,
  fallback,
  onBlur,
  onKeyDown,
  ...props
}: NumberInputProps) {
  const [draft, setDraft] = React.useState<string | null>(null);

  const commit = React.useCallback(
    (raw: string) => {
      const trimmed = raw.trim();
      const parsed = trimmed === "" ? NaN : Number(trimmed);
      const next = Number.isFinite(parsed)
        ? clamp(parsed, min, max)
        : clamp(fallback ?? value, min, max);
      setDraft(null);
      if (next !== value) onValueChange(next);
    },
    [fallback, max, min, onValueChange, value],
  );

  return (
    <Input
      {...props}
      type="number"
      min={min}
      max={max}
      value={draft ?? String(value)}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        // Propagate eagerly when the draft is already a valid in-range number,
        // so the rest of the UI stays live; otherwise wait for commit.
        const parsed = raw.trim() === "" ? NaN : Number(raw);
        if (Number.isFinite(parsed) && clamp(parsed, min, max) === parsed && parsed !== value) {
          onValueChange(parsed);
        }
      }}
      onBlur={(e) => {
        commit(e.target.value);
        onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit(e.currentTarget.value);
        }
        onKeyDown?.(e);
      }}
    />
  );
}

export { NumberInput };
