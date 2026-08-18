// The new-chat runtime choice (backend + CLI model/effort overrides) is sticky
// across sessions and shared between the main window's hero composer and the
// quick launcher via localStorage — the same pattern as model-choice.ts. This
// module is the single owner of the key; callers never touch localStorage
// directly.

import type { BackendId } from "./types";

const KEY = "cetus:lastBackendChoice";
const BACKEND_IDS: BackendId[] = [
  "pi",
  "claude-code",
  "codex",
  "opencode",
  "grok",
  "kimi",
  "dsh",
];
type CliBackendId = Exclude<BackendId, "pi">;

interface CliTuningChoice {
  model: string;
  effort: string;
}

interface StoredBackendChoice extends Partial<BackendChoice> {
  /** Model/effort are remembered independently for each vendor runtime. */
  cliChoices?: Partial<Record<CliBackendId, CliTuningChoice>>;
  /** Set when the selection is a preset row: the top-level cliModel/cliEffort
   * are the preset's fixed tuning, and the runtime's own sticky tuning in
   * `cliChoices` is deliberately left untouched. */
  presetId?: string;
}

export interface BackendChoice {
  backend: BackendId;
  /** CLI backends' model override; "" = the CLI's own default. */
  cliModel: string;
  /** CLI backends' reasoning-effort override; "" = the CLI's default. */
  cliEffort: string;
}

function readStoredChoice(): StoredBackendChoice | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as StoredBackendChoice) : null;
  } catch {
    return null;
  }
}

function validTuning(value: unknown): CliTuningChoice | null {
  if (!value || typeof value !== "object") return null;
  const choice = value as Partial<CliTuningChoice>;
  if (typeof choice.model !== "string" || typeof choice.effort !== "string") {
    return null;
  }
  return { model: choice.model, effort: choice.effort };
}

/** The last explicit model/effort choice for one CLI runtime. Empty strings
 * are a real remembered choice: the user selected the vendor's Default row. */
export function loadCliTuningChoice(backend: CliBackendId): CliTuningChoice {
  const stored = readStoredChoice();
  const perBackend = validTuning(stored?.cliChoices?.[backend]);
  if (perBackend) return perBackend;

  // Backward compatibility with the original single-runtime storage shape.
  // Not when a preset is selected: the top-level values are the preset's
  // fixed tuning, not this runtime's own choice.
  if (stored?.backend === backend && !stored.presetId) {
    return {
      model: typeof stored.cliModel === "string" ? stored.cliModel : "",
      effort: typeof stored.cliEffort === "string" ? stored.cliEffort : "",
    };
  }
  return { model: "", effort: "" };
}

/** The stored choice, or null when nothing (valid) is stored. */
export function loadBackendChoice(): BackendChoice | null {
  const v = readStoredChoice();
  if (!v?.backend || !BACKEND_IDS.includes(v.backend)) return null;
  // A preset selection restores its fixed tuning from the top-level fields;
  // the runtime's own sticky tuning in cliChoices is not what was selected.
  if (v.presetId && v.backend !== "pi") {
    return {
      backend: v.backend,
      cliModel: typeof v.cliModel === "string" ? v.cliModel : "",
      cliEffort: typeof v.cliEffort === "string" ? v.cliEffort : "",
    };
  }
  const tuning =
    v.backend === "pi"
      ? { model: "", effort: "" }
      : loadCliTuningChoice(v.backend);
  return { backend: v.backend, cliModel: tuning.model, cliEffort: tuning.effort };
}

/** Persist the new-chat selection. Pass `presetId` when the selection is a
 * preset row: the choice is stored as that preset, and the runtime's own
 * sticky tuning is left alone — a preset always means the same thing and
 * never leaks into the plain runtime row. */
export function saveBackendChoice(choice: BackendChoice, presetId?: string) {
  try {
    const previous = readStoredChoice();
    const cliChoices = { ...previous?.cliChoices };
    // Carry the legacy runtime's value forward the first time the v2 shape is
    // written, even when this save is switching to the other runtime. Skip
    // preset selections: their top-level tuning isn't the runtime's own.
    if (
      previous?.backend &&
      previous.backend !== "pi" &&
      !previous.presetId &&
      !cliChoices[previous.backend]
    ) {
      cliChoices[previous.backend] = {
        model: typeof previous.cliModel === "string" ? previous.cliModel : "",
        effort: typeof previous.cliEffort === "string" ? previous.cliEffort : "",
      };
    }
    if (choice.backend !== "pi" && !presetId) {
      cliChoices[choice.backend] = {
        model: choice.cliModel,
        effort: choice.cliEffort,
      };
    }
    localStorage.setItem(
      KEY,
      JSON.stringify({
        ...choice,
        ...(presetId ? { presetId } : {}),
        cliChoices,
      }),
    );
  } catch {}
}

/** Update one runtime's remembered tuning without changing which runtime (or
 * preset) is selected for the next new conversation. */
export function saveCliTuningChoice(
  backend: CliBackendId,
  tuning: CliTuningChoice,
) {
  try {
    const stored = readStoredChoice();
    localStorage.setItem(KEY, JSON.stringify({
      ...stored,
      cliChoices: { ...stored?.cliChoices, [backend]: tuning },
    }));
  } catch {}
}
