import type { CSSProperties } from "react";
import type { BackendId } from "./types";

/** One source of truth for runtime identity colors. Surfaces derive quieter
 * borders/backgrounds from the solid color instead of maintaining their own
 * Tailwind palettes. */
export const RUNTIME_THEME: Record<BackendId, { color: string }> = {
  pi: { color: "var(--runtime-pi)" },
  "claude-code": { color: "var(--runtime-claude)" },
  codex: { color: "var(--runtime-codex)" },
  opencode: { color: "var(--runtime-opencode)" },
  grok: { color: "var(--runtime-grok)" },
  kimi: { color: "var(--runtime-kimi)" },
  dsh: { color: "var(--runtime-dsh)" },
};

export type RuntimeThemeStyle = CSSProperties & {
  "--runtime-color": string;
};

export function runtimeThemeStyle(backend: BackendId): RuntimeThemeStyle {
  return { "--runtime-color": RUNTIME_THEME[backend].color };
}
