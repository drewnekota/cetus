"use client";

import { useEffect, useMemo, useState } from "react";
import { api, onCliAgentSettingsChanged } from "./tauri";
import {
  RUNTIME_SLOT_SHORTCUT_IDS,
  shortcutDisplay,
  type ShortcutMap,
} from "./keyboard-shortcuts";
import type { BackendId, CliAgentSettings } from "./types";

export const DEFAULT_CLI_AGENT_SETTINGS: CliAgentSettings = {
  bypassApprovals: true,
  isolateInWorktree: false,
  claudeCodeEnabled: true,
  codexEnabled: true,
  opencodeEnabled: true,
  grokEnabled: true,
  kimiEnabled: true,
  runtimeOrder: ["pi", "claude-code", "codex", "opencode", "grok", "kimi"],
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

export function useRuntimePreferences(): {
  settings: CliAgentSettings;
  order: BackendId[];
  enabledBackendIds: ReadonlySet<BackendId>;
} {
  const settings = useCliAgentSettings();
  return useMemo(() => {
    const order = normalizeRuntimeOrder(settings.runtimeOrder);
    return {
      settings,
      order,
      enabledBackendIds: new Set(
        order.filter((id) => isBackendEnabled(id, settings)),
      ),
    };
  }, [settings]);
}

export function useEnabledBackendIds(): ReadonlySet<BackendId> {
  return useRuntimePreferences().enabledBackendIds;
}

/** The runtimes ⌃1…⌃6 address. Cetus is pinned to the first slot — it's the one
 *  runtime that can't be switched off, so it always keeps a key. The rest fill
 *  ⌃2 upward in the configured order, and disabling one closes its gap, so the
 *  keys always match what's in the picker. Pure so the Runtimes settings page
 *  can label its rows from its own optimistic state. */
export function runtimeSlots(settings: CliAgentSettings): BackendId[] {
  return (["pi"] as BackendId[])
    .concat(
      normalizeRuntimeOrder(settings.runtimeOrder).filter(
        (id) => id !== "pi" && isBackendEnabled(id, settings),
      ),
    )
    .slice(0, RUNTIME_SLOT_SHORTCUT_IDS.length);
}

/** The accelerator that selects `backend`, or null when it's past the last
 *  slot. Display-ready (e.g. "⌃2"). */
export function runtimeSlotDisplay(
  backend: BackendId,
  settings: CliAgentSettings,
  shortcuts: ShortcutMap,
): string | null {
  const id = RUNTIME_SLOT_SHORTCUT_IDS[runtimeSlots(settings).indexOf(backend)];
  const display = id ? shortcutDisplay(shortcuts[id]) : null;
  return !display || display === "Unassigned" ? null : display;
}

export function openRuntimeSettings() {
  try {
    window.localStorage.setItem("cetus:settingsSection", "runtimes");
  } catch {}
  window.dispatchEvent(new Event(OPEN_RUNTIME_SETTINGS_EVENT));
}
