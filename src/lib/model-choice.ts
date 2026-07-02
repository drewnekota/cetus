// The active model/reasoning choice is shared across windows (main composer +
// quick launcher) via localStorage. This is the single owner of that key —
// callers never touch localStorage directly, so the merge/parse semantics
// can't drift between windows.

import type { ModelChoice } from "./types";

const KEY = "cetus:lastModelChoice";

/** Merge the stored choice over `current` — a state updater-compatible shape:
 *  `setModelChoice(mergeStoredModelChoice)`. Returns `current` untouched when
 *  nothing is stored or parsing fails. */
export function mergeStoredModelChoice(current: ModelChoice): ModelChoice {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...current, ...JSON.parse(raw) } as ModelChoice;
  } catch {}
  return current;
}

export function saveModelChoice(choice: ModelChoice) {
  try {
    localStorage.setItem(KEY, JSON.stringify(choice));
  } catch {}
}
