"use client";
// A "press keys to record" field for the global summon hotkey, à la
// Raycast/Alfred. Click to arm, press a combo (one of ⌘/⌃/⌥ plus a key), and it
// commits a Tauri accelerator string ("Cmd+Shift+K") the backend can register.
// The ✕ clears it; Esc cancels recording without changing anything.

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const MOD_SYMBOL: Record<string, string> = {
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Cmd: "⌘",
};

// Friendlier glyphs for the non-modifier key; anything not listed shows as-is
// (letters/digits are already single chars, F-keys read fine literally).
const KEY_LABEL: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Enter: "⏎",
  Space: "Space",
  Tab: "⇥",
  Backspace: "⌫",
  Delete: "⌦",
  Escape: "Esc",
};

/** Map a KeyboardEvent's physical `code` to a token the Rust `global-hotkey`
 *  accelerator parser understands (case-insensitive). Returns null for pure
 *  modifier keys, which can't stand alone. */
function keyToken(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3); // KeyK → K
  if (/^Digit\d$/.test(code)) return code.slice(5); // Digit1 → 1
  if (/^(Meta|Control|Alt|Shift)(Left|Right)$/.test(code)) return null;
  // Standard codes (Space, Enter, Tab, ArrowUp, Comma, Minus, F1, Numpad1, …)
  // all match the parser's code-name branch as-is.
  return code;
}

/** Build a canonical accelerator string from a keydown, or null if it isn't a
 *  valid global combo (needs a non-modifier key + at least one of ⌘/⌃/⌥). */
function acceleratorFrom(e: KeyboardEvent): string | null {
  const key = keyToken(e.code);
  if (!key) return null;
  if (!e.metaKey && !e.ctrlKey && !e.altKey) return null; // Shift alone is weak
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Cmd");
  return [...mods, key].join("+");
}

/** Render an accelerator string as display chips (["⌘", "⇧", "K"]). */
function chips(accelerator: string): string[] {
  return accelerator.split("+").map((part) => {
    if (MOD_SYMBOL[part]) return MOD_SYMBOL[part];
    return KEY_LABEL[part] ?? part;
  });
}

export function HotkeyRecorder({
  value,
  onChange,
  placeholder,
  recordingLabel,
  clearLabel,
  disabled,
}: {
  value: string;
  onChange: (accelerator: string) => void;
  placeholder: string;
  recordingLabel: string;
  clearLabel: string;
  disabled?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const recordingRef = useRef(recording);
  recordingRef.current = recording;

  const stop = useCallback(() => setRecording(false), []);

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // Swallow the chord so it can't fire an app shortcut while recording.
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        stop();
        return;
      }
      const accel = acceleratorFrom(e);
      if (accel) {
        onChange(accel);
        stop();
      }
    };
    // Capture phase so we win over any app-level key handlers.
    window.addEventListener("keydown", onKeyDown, true);
    // Bailing out if focus leaves keeps a half-recorded field from getting stuck.
    const onBlur = () => stop();
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [recording, onChange, stop]);

  const parts = value ? chips(value) : [];

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setRecording((r) => !r)}
        className={cn(
          "flex h-8 min-w-[7rem] items-center justify-center gap-1 rounded-md border px-2.5 text-xs font-medium transition-colors",
          recording
            ? "border-primary bg-primary/10 text-primary"
            : "border-border bg-muted text-foreground hover:bg-muted/70",
          disabled && "cursor-not-allowed opacity-50",
        )}
      >
        {recording ? (
          <span className="text-muted-foreground">{recordingLabel}</span>
        ) : parts.length > 0 ? (
          parts.map((p, i) => (
            <kbd
              key={i}
              className="rounded bg-background px-1.5 py-0.5 font-sans text-[11px] leading-none shadow-sm"
            >
              {p}
            </kbd>
          ))
        ) : (
          <span className="text-muted-foreground">{placeholder}</span>
        )}
      </button>
      {value && !recording && (
        <button
          type="button"
          disabled={disabled}
          aria-label={clearLabel}
          title={clearLabel}
          onClick={() => onChange("")}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
