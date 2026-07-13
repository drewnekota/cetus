// The new-chat runtime choice (backend + CLI model/effort overrides) is sticky
// across sessions and shared between the main window's hero composer and the
// quick launcher via localStorage — the same pattern as model-choice.ts. This
// module is the single owner of the key; callers never touch localStorage
// directly.

import type { BackendId } from "./types";

const KEY = "cetus:lastBackendChoice";
const BACKEND_IDS: BackendId[] = ["pi", "claude-code", "codex"];
type CliBackendId = Exclude<BackendId, "pi">;

interface CliTuningChoice {
  model: string;
  effort: string;
}

interface StoredBackendChoice extends Partial<BackendChoice> {
  /** Model/effort are remembered independently for each vendor runtime. */
  cliChoices?: Partial<Record<CliBackendId, CliTuningChoice>>;
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
  if (stored?.backend === backend) {
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
  const tuning =
    v.backend === "pi"
      ? { model: "", effort: "" }
      : loadCliTuningChoice(v.backend);
  return { backend: v.backend, cliModel: tuning.model, cliEffort: tuning.effort };
}

export function saveBackendChoice(choice: BackendChoice) {
  try {
    const previous = readStoredChoice();
    const cliChoices = { ...previous?.cliChoices };
    // Carry the legacy runtime's value forward the first time the v2 shape is
    // written, even when this save is switching to the other runtime.
    if (
      previous?.backend &&
      previous.backend !== "pi" &&
      !cliChoices[previous.backend]
    ) {
      cliChoices[previous.backend] = {
        model: typeof previous.cliModel === "string" ? previous.cliModel : "",
        effort: typeof previous.cliEffort === "string" ? previous.cliEffort : "",
      };
    }
    if (choice.backend !== "pi") {
      cliChoices[choice.backend] = {
        model: choice.cliModel,
        effort: choice.cliEffort,
      };
    }
    localStorage.setItem(KEY, JSON.stringify({ ...choice, cliChoices }));
  } catch {}
}

/** Update one runtime's remembered tuning without changing which runtime is
 * selected for the next new conversation. */
export function saveCliTuningChoice(
  backend: CliBackendId,
  tuning: CliTuningChoice,
) {
  const current = loadBackendChoice();
  saveBackendChoice({
    backend: current?.backend ?? "pi",
    cliModel: current?.cliModel ?? "",
    cliEffort: current?.cliEffort ?? "",
  });
  try {
    const stored = readStoredChoice();
    localStorage.setItem(KEY, JSON.stringify({
      ...stored,
      cliChoices: { ...stored?.cliChoices, [backend]: tuning },
    }));
  } catch {}
}
