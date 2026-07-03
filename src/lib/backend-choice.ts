// The new-chat runtime choice (backend + CLI model/effort overrides) is sticky
// across sessions and shared between the main window's hero composer and the
// quick launcher via localStorage — the same pattern as model-choice.ts. This
// module is the single owner of the key; callers never touch localStorage
// directly.

import type { BackendId } from "./types";

const KEY = "cetus:lastBackendChoice";
const BACKEND_IDS: BackendId[] = ["pi", "claude-code", "codex"];

export interface BackendChoice {
  backend: BackendId;
  /** CLI backends' model override; "" = the CLI's own default. */
  cliModel: string;
  /** CLI backends' reasoning-effort override; "" = the CLI's default. */
  cliEffort: string;
}

/** The stored choice, or null when nothing (valid) is stored. */
export function loadBackendChoice(): BackendChoice | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<BackendChoice>;
    if (!v?.backend || !BACKEND_IDS.includes(v.backend)) return null;
    return {
      backend: v.backend,
      cliModel: typeof v.cliModel === "string" ? v.cliModel : "",
      cliEffort: typeof v.cliEffort === "string" ? v.cliEffort : "",
    };
  } catch {
    return null;
  }
}

export function saveBackendChoice(choice: BackendChoice) {
  try {
    localStorage.setItem(KEY, JSON.stringify(choice));
  } catch {}
}
