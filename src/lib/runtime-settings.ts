"use client";

import { useEffect, useMemo, useState } from "react";
import { api, onCliAgentSettingsChanged } from "./tauri";
import {
  RUNTIME_SLOT_SHORTCUT_IDS,
  shortcutDisplay,
  type ShortcutMap,
} from "./keyboard-shortcuts";
import type { BackendId, CliAgentSettings, RuntimePreset } from "./types";

export const DEFAULT_CLI_AGENT_SETTINGS: CliAgentSettings = {
  bypassApprovals: true,
  isolateInWorktree: false,
  claudeCodeEnabled: true,
  codexEnabled: true,
  opencodeEnabled: true,
  grokEnabled: true,
  kimiEnabled: true,
  dshEnabled: true,
  runtimeOrder: ["pi", "claude-code", "codex", "opencode", "grok", "kimi", "dsh"],
  runtimePresets: [],
};

export const OPEN_RUNTIME_SETTINGS_EVENT = "cetus-open-runtime-settings";

export function isBackendEnabled(
  backend: BackendId,
  settings: CliAgentSettings,
): boolean {
  switch (backend) {
    case "claude-code":
      return settings.claudeCodeEnabled;
    case "codex":
      return settings.codexEnabled;
    case "opencode":
      return settings.opencodeEnabled;
    case "grok":
      return settings.grokEnabled;
    case "kimi":
      return settings.kimiEnabled;
    case "dsh":
      return settings.dshEnabled;
    default:
      return true;
  }
}

/** Live settings shared across every runtime picker, including the quick
 * launcher window. Rust broadcasts saves to all webviews. */
export function useCliAgentSettings(): CliAgentSettings {
  const [settings, setSettings] = useState(DEFAULT_CLI_AGENT_SETTINGS);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    api
      .getCliAgentSettings()
      .then((value) => {
        if (!cancelled) setSettings({ ...DEFAULT_CLI_AGENT_SETTINGS, ...value });
      })
      .catch(() => {});
    onCliAgentSettingsChanged((value) => {
      setSettings({ ...DEFAULT_CLI_AGENT_SETTINGS, ...value });
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return settings;
}

export function normalizeRuntimeOrder(order: readonly string[]): BackendId[] {
  const known = DEFAULT_CLI_AGENT_SETTINGS.runtimeOrder;
  const seen = new Set<BackendId>();
  const normalized: BackendId[] = [];
  for (const id of [...order, ...known]) {
    if (known.includes(id as BackendId) && !seen.has(id as BackendId)) {
      seen.add(id as BackendId);
      normalized.push(id as BackendId);
    }
  }
  return normalized;
}

/** One row in the unified runtime/preset order: either a plain runtime or a
 *  user-defined preset (a runtime pinned to one model/effort combination). */
export type RuntimeEntry =
  | { kind: "backend"; id: BackendId }
  | { kind: "preset"; id: string; preset: RuntimePreset };

/** The full picker order — runtime ids and preset ids interleaved, deduped,
 *  with anything missing appended (mirrors the Rust normalization). */
export function normalizeRuntimeEntryOrder(
  order: readonly string[],
  presets: readonly RuntimePreset[],
): string[] {
  const known = DEFAULT_CLI_AGENT_SETTINGS.runtimeOrder;
  const presetIds = presets.map((preset) => preset.id);
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const id of [...order, ...known, ...presetIds]) {
    if ((known.includes(id) || presetIds.includes(id)) && !seen.has(id)) {
      seen.add(id);
      normalized.push(id);
    }
  }
  return normalized;
}

/** The ordered rows for pickers and the Runtimes settings page. */
export function runtimeEntries(settings: CliAgentSettings): RuntimeEntry[] {
  const presetsById = new Map(
    settings.runtimePresets.map((preset) => [preset.id, preset]),
  );
  return normalizeRuntimeEntryOrder(
    settings.runtimeOrder,
    settings.runtimePresets,
  ).map((id) => {
    const preset = presetsById.get(id);
    return preset
      ? { kind: "preset", id, preset }
      : { kind: "backend", id: id as BackendId };
  });
}

export function useRuntimePreferences(): {
  settings: CliAgentSettings;
  order: BackendId[];
  entries: RuntimeEntry[];
  enabledBackendIds: ReadonlySet<BackendId>;
} {
  const settings = useCliAgentSettings();
  return useMemo(() => {
    const order = normalizeRuntimeOrder(settings.runtimeOrder);
    return {
      settings,
      order,
      entries: runtimeEntries(settings),
      enabledBackendIds: new Set(
        order.filter((id) => isBackendEnabled(id, settings)),
      ),
    };
  }, [settings]);
}

export function useEnabledBackendIds(): ReadonlySet<BackendId> {
  return useRuntimePreferences().enabledBackendIds;
}

/** The rows ⌃1…⌃9 address: the *enabled* runtimes and presets in the unified
 *  order set in Settings › Runtimes — whoever is on top gets ⌃1. Disabling a
 *  runtime closes its gap (and hides its presets), so the keys always match
 *  what's in the picker. Pure so the Runtimes settings page can label its rows
 *  from its own optimistic state. */
export function runtimeSlots(settings: CliAgentSettings): RuntimeEntry[] {
  return runtimeEntries(settings)
    .filter((entry) =>
      isBackendEnabled(
        entry.kind === "backend" ? entry.id : entry.preset.backend,
        settings,
      ),
    )
    .slice(0, RUNTIME_SLOT_SHORTCUT_IDS.length);
}

/** The accelerator that selects the row `entryId` (a runtime or preset id),
 *  or null when it's past the last slot. Display-ready (e.g. "⌃2"). */
export function runtimeSlotDisplay(
  entryId: string,
  settings: CliAgentSettings,
  shortcuts: ShortcutMap,
): string | null {
  const slot = runtimeSlots(settings).findIndex(
    (entry) => entry.id === entryId,
  );
  const id = slot >= 0 ? RUNTIME_SLOT_SHORTCUT_IDS[slot] : undefined;
  const display = id ? shortcutDisplay(shortcuts[id]) : null;
  return !display || display === "Unassigned" ? null : display;
}

/** The preset whose runtime and fixed tuning exactly match the given
 *  selection, if any — the same value-match the picker uses to place its
 *  checkmark on the preset row instead of the plain runtime. */
export function matchRuntimePreset(
  presets: readonly RuntimePreset[],
  backend: BackendId,
  model: string,
  effort: string,
): RuntimePreset | undefined {
  return presets.find(
    (preset) =>
      preset.backend === backend &&
      preset.model === model &&
      preset.effort === effort,
  );
}

export function openRuntimeSettings() {
  try {
    window.localStorage.setItem("cetus:settingsSection", "runtimes");
  } catch {}
  window.dispatchEvent(new Event(OPEN_RUNTIME_SETTINGS_EVENT));
}
