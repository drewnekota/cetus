"use client";

import { useEffect, useState } from "react";

export type ShortcutId =
  | "commandPalette"
  | "findInChat"
  | "newChat"
  | "newDefaultChat"
  | "archiveChat"
  | "openSettings"
  | "switchChats"
  | "switchBoard"
  | "switchAutomations"
  | "switchPreviousView"
  | "navigateBack"
  | "navigateForward"
  | "runtimeSlot1"
  | "runtimeSlot2"
  | "runtimeSlot3"
  | "runtimeSlot4"
  | "runtimeSlot5"
  | "runtimeSlot6"
  | "runtimeSlot7"
  | "toggleWorkspace"
  | "toggleTerminal"
  | "openBrowserTab"
  | "openFilesTab"
  | "closeWorkspaceTab"
  | "previousWorkspaceTab"
  | "nextWorkspaceTab"
  | "previousChat"
  | "nextChat"
  | "lastChat";

export interface ShortcutDefinition {
  id: ShortcutId;
  label: string;
  description: string;
  defaultAccelerator: string;
  /** Windows/Linux override when the platform convention or a Ctrl collision
   *  makes the macOS accelerator unsuitable. Cmd defaults automatically become
   *  Ctrl off macOS, so this is only needed for genuine differences. */
  windowsAccelerator?: string;
}

export type ShortcutMap = Record<ShortcutId, string>;

export const KEYBOARD_SHORTCUTS_STORAGE_KEY = "cetus:keyboardShortcuts";
export const KEYBOARD_SHORTCUTS_EVENT = "cetus-keyboard-shortcuts-changed";

/** ⌃1…⌃7 are positional: they select the 1st…7th *enabled* runtime in the
 *  order set in Settings › Runtimes, rather than being pinned to one runtime.
 *  Length matches the number of runtimes Cetus ships. */
export const RUNTIME_SLOT_SHORTCUT_IDS = [
  "runtimeSlot1",
  "runtimeSlot2",
  "runtimeSlot3",
  "runtimeSlot4",
  "runtimeSlot5",
  "runtimeSlot6",
  "runtimeSlot7",
] as const satisfies readonly ShortcutId[];

/** Bindings replaced by the positional slots in 0.3.41. Carried over by index
 *  so a user who rebound "Runtime: Codex" keeps that key on slot 3. */
const LEGACY_RUNTIME_SHORTCUT_IDS = [
  "runtimeCetus",
  "runtimeClaudeCode",
  "runtimeCodex",
] as const;

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  {
    id: "commandPalette",
    label: "Command palette",
    description: "Open or close the command palette",
    defaultAccelerator: "Cmd+K",
  },
  {
    id: "findInChat",
    label: "Find in conversation",
    description: "Search the open conversation and step through the matches",
    defaultAccelerator: "Cmd+F",
  },
  {
    id: "newChat",
    label: "New chat or task",
    description:
      "Start a task in the selected folder, or open a new chat without one",
    defaultAccelerator: "Cmd+N",
  },
  {
    id: "newDefaultChat",
    label: "New chat",
    description: "Start a repository-free chat, wherever you are",
    defaultAccelerator: "Alt+Cmd+N",
  },
  {
    id: "archiveChat",
    label: "Archive chat",
    description: "Archive the current chat",
    defaultAccelerator: "Cmd+D",
  },
  {
    id: "openSettings",
    label: "Open settings",
    description: "Open the settings page",
    defaultAccelerator: "Cmd+Comma",
  },
  {
    id: "switchChats",
    label: "Switch to chats",
    description: "Show the chat list",
    defaultAccelerator: "Cmd+1",
  },
  {
    id: "switchBoard",
    label: "Switch to Kanban",
    description: "Show the Kanban board",
    defaultAccelerator: "Cmd+2",
  },
  {
    id: "switchAutomations",
    label: "Switch to automations",
    description: "Show scheduled automations",
    defaultAccelerator: "Cmd+3",
  },
  {
    id: "switchPreviousView",
    label: "Switch to previous page",
    description: "Toggle back to the page you were on before",
    defaultAccelerator: "Ctrl+Tab",
  },
  {
    id: "navigateBack",
    label: "Go back",
    description: "Go back to the previous page (views and settings)",
    defaultAccelerator: "Cmd+BracketLeft",
    windowsAccelerator: "Alt+ArrowLeft",
  },
  {
    id: "navigateForward",
    label: "Go forward",
    description: "Go forward to the next page after going back",
    defaultAccelerator: "Cmd+BracketRight",
    windowsAccelerator: "Alt+ArrowRight",
  },
  ...RUNTIME_SLOT_SHORTCUT_IDS.map((id, index) => ({
    id,
    label: `Runtime ${index + 1}`,
    description: `Switch the current chat to runtime ${index + 1} in Settings › Runtimes`,
    defaultAccelerator: `Ctrl+${index + 1}`,
    windowsAccelerator: `Alt+${index + 1}`,
  })),
  {
    id: "toggleWorkspace",
    label: "Toggle workspace",
    description: "Open or close the right workspace panel",
    defaultAccelerator: "Cmd+B",
  },
  {
    id: "toggleTerminal",
    label: "Toggle terminal",
    description: "Open or focus the terminal tab",
    defaultAccelerator: "Cmd+J",
  },
  {
    id: "openBrowserTab",
    label: "Open browser tab",
    description: "Open or focus a browser tab in the workspace",
    defaultAccelerator: "Cmd+T",
  },
  {
    id: "openFilesTab",
    label: "Open files tab",
    description: "Open or focus the files tab in the workspace",
    defaultAccelerator: "Cmd+P",
  },
  {
    id: "closeWorkspaceTab",
    label: "Close workspace tab",
    description: "Close the active right workspace tab",
    defaultAccelerator: "Cmd+W",
  },
  {
    id: "previousWorkspaceTab",
    label: "Previous workspace tab",
    description: "Move to the previous right workspace tab",
    defaultAccelerator: "Cmd+Alt+ArrowLeft",
    windowsAccelerator: "Ctrl+PageUp",
  },
  {
    id: "nextWorkspaceTab",
    label: "Next workspace tab",
    description: "Move to the next right workspace tab",
    defaultAccelerator: "Cmd+Alt+ArrowRight",
    windowsAccelerator: "Ctrl+PageDown",
  },
  {
    id: "previousChat",
    label: "Previous chat",
    description: "Move to the previous chat in the sidebar",
    defaultAccelerator: "Cmd+Alt+ArrowUp",
    // Avoid Windows' long-standing Ctrl+Alt+Arrow display-rotation chord.
    windowsAccelerator: "Ctrl+Shift+ArrowUp",
  },
  {
    id: "nextChat",
    label: "Next chat",
    description: "Move to the next chat in the sidebar",
    defaultAccelerator: "Cmd+Alt+ArrowDown",
    windowsAccelerator: "Ctrl+Shift+ArrowDown",
  },
  {
    id: "lastChat",
    label: "Last chat",
    description: "Open the last chat in the sidebar",
    defaultAccelerator: "Cmd+9",
  },
];

export type ShortcutPlatform = "mac" | "windows";

/** Synchronous on purpose: shortcuts are consumed by keydown handlers before
 *  any async Tauri OS query could resolve. Tauri's Windows WebView reports
 *  Win32 in navigator.platform and macOS reports MacIntel. */
export function shortcutPlatform(): ShortcutPlatform {
  if (typeof navigator === "undefined") return "mac";
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const raw = `${nav.userAgentData?.platform ?? ""} ${navigator.platform ?? ""} ${
    navigator.userAgent ?? ""
  }`;
  return /mac|iphone|ipad|ipod/i.test(raw) ? "mac" : "windows";
}

const MAC_MOD_LABEL: Record<string, string> = {
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Cmd: "⌘",
};

const WINDOWS_MOD_LABEL: Record<string, string> = {
  Ctrl: "Ctrl",
  Alt: "Alt",
  Shift: "Shift",
  Cmd: "Win",
};

const KEY_LABEL: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Enter: "⏎",
  Space: "Space",
  Tab: "⇥",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Backspace: "⌫",
  Delete: "⌦",
  Escape: "Esc",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

const KEY_TO_CODE: Record<string, string> = {
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  ";": "Semicolon",
  "'": "Quote",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  "-": "Minus",
  "=": "Equal",
  "`": "Backquote",
  " ": "Space",
};

function platformDefault(
  definition: ShortcutDefinition,
  platform: ShortcutPlatform,
): string {
  if (platform === "windows" && definition.windowsAccelerator) {
    return normalizeAccelerator(definition.windowsAccelerator);
  }
  const accelerator =
    platform === "windows"
      ? definition.defaultAccelerator.replaceAll("Cmd", "Ctrl")
      : definition.defaultAccelerator;
  return normalizeAccelerator(accelerator);
}

export function defaultShortcutMap(
  platform: ShortcutPlatform = shortcutPlatform(),
): ShortcutMap {
  return Object.fromEntries(
    SHORTCUT_DEFINITIONS.map((s) => [s.id, platformDefault(s, platform)]),
  ) as ShortcutMap;
}

export function readKeyboardShortcuts(): ShortcutMap {
  const platform = shortcutPlatform();
  if (typeof window === "undefined") return defaultShortcutMap(platform);
  try {
    const raw = window.localStorage.getItem(KEYBOARD_SHORTCUTS_STORAGE_KEY);
    if (!raw) return defaultShortcutMap(platform);
    const parsed = JSON.parse(raw) as Partial<Record<ShortcutId, unknown>>;
    return mergeStoredShortcutMap(parsed, platform);
  } catch {
    return defaultShortcutMap(platform);
  }
}

/** Merge a persisted partial map with current platform defaults. Exported so
 *  platform migration remains covered without mocking browser localStorage. */
export function mergeStoredShortcutMap(
  parsed: Partial<Record<ShortcutId, unknown>>,
  platform: ShortcutPlatform,
): ShortcutMap {
  const defaults = defaultShortcutMap(platform);
  const next = { ...defaults };
  const legacy = parsed as Record<string, unknown>;
  for (const def of SHORTCUT_DEFINITIONS) {
    const slot = RUNTIME_SLOT_SHORTCUT_IDS.indexOf(
      def.id as (typeof RUNTIME_SLOT_SHORTCUT_IDS)[number],
    );
    const value =
      parsed[def.id] ??
      (slot >= 0 ? legacy[LEGACY_RUNTIME_SHORTCUT_IDS[slot] ?? ""] : undefined);
    if (typeof value !== "string") continue;
    const normalized = normalizeAccelerator(value);
    // Releases before 0.3.40 wrote the macOS defaults verbatim on Windows.
    // Migrate only values that still equal that old default; genuinely custom
    // bindings survive untouched.
    const legacyDefault = normalizeAccelerator(def.defaultAccelerator);
    next[def.id] =
      platform === "windows" && normalized === legacyDefault
        ? defaults[def.id]
        : normalized;
  }
  return next;
}

export function useKeyboardShortcuts(): ShortcutMap {
  const [shortcuts, setShortcuts] = useState(readKeyboardShortcuts);
  useEffect(() => {
    const reload = () => setShortcuts(readKeyboardShortcuts());
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === KEYBOARD_SHORTCUTS_STORAGE_KEY) reload();
    };
    window.addEventListener(KEYBOARD_SHORTCUTS_EVENT, reload);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(KEYBOARD_SHORTCUTS_EVENT, reload);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return shortcuts;
}

export function writeKeyboardShortcuts(shortcuts: ShortcutMap) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEYBOARD_SHORTCUTS_STORAGE_KEY, JSON.stringify(shortcuts));
  window.dispatchEvent(new CustomEvent(KEYBOARD_SHORTCUTS_EVENT));
}

export function resetKeyboardShortcuts() {
  writeKeyboardShortcuts(defaultShortcutMap());
}

export function keyToken(code: string, key?: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^(Meta|Control|Alt|Shift)(Left|Right)$/.test(code)) return null;
  if (code === "NumpadEnter") return "Enter";
  if (/^Numpad\d$/.test(code)) return code.slice(6);
  if (code) return code;
  if (!key) return null;
  if (/^[a-z]$/i.test(key)) return key.toUpperCase();
  if (/^\d$/.test(key)) return key;
  return KEY_TO_CODE[key] ?? key;
}

export function acceleratorFromEvent(
  e: Pick<
    KeyboardEvent,
    "code" | "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
  >,
): string | null {
  const key = keyToken(e.code, e.key);
  if (!key) return null;
  if (!e.metaKey && !e.ctrlKey && !e.altKey) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Cmd");
  return [...mods, key].join("+");
}

export function normalizeAccelerator(accelerator: string): string {
  const parts = accelerator
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const key = [...parts].reverse().find((p) => !isModifier(p));
  if (!key) return "";
  const mods = new Set(parts.filter(isModifier).map(normalizeModifier));
  const orderedMods = ["Ctrl", "Alt", "Shift", "Cmd"].filter((m) => mods.has(m));
  return [...orderedMods, normalizeKey(key)].join("+");
}

export function shortcutChips(
  accelerator: string,
  platform: ShortcutPlatform = shortcutPlatform(),
): string[] {
  const normalized = normalizeAccelerator(accelerator);
  if (!normalized) return [];
  const modifierLabels =
    platform === "mac" ? MAC_MOD_LABEL : WINDOWS_MOD_LABEL;
  return normalized
    .split("+")
    .map((part) => modifierLabels[part] ?? KEY_LABEL[part] ?? part);
}

export function shortcutDisplay(
  accelerator: string,
  platform: ShortcutPlatform = shortcutPlatform(),
): string {
  const chips = shortcutChips(accelerator, platform);
  return chips.length
    ? chips.join(platform === "mac" ? "" : "+")
    : "Unassigned";
}

/** Non-configurable UI chords (for example submit-with-modifier) should still
 *  use the platform's primary modifier and the same visual language as the
 *  configurable shortcut system. */
export function primaryAccelerator(
  key: string,
  platform: ShortcutPlatform = shortcutPlatform(),
): string {
  return `${platform === "mac" ? "Cmd" : "Ctrl"}+${key}`;
}

export function matchesShortcut(e: KeyboardEvent, accelerator: string): boolean {
  const normalized = normalizeAccelerator(accelerator);
  if (!normalized) return false;
  return acceleratorFromEvent(e) === normalized;
}

function isModifier(part: string): boolean {
  return /^(cmd|command|meta|ctrl|control|alt|option|shift|⌘|⌃|⌥|⇧)$/i.test(part);
}

function normalizeModifier(part: string): string {
  const p = part.toLowerCase();
  if (p === "cmd" || p === "command" || p === "meta" || part === "⌘") return "Cmd";
  if (p === "ctrl" || p === "control" || part === "⌃") return "Ctrl";
  if (p === "alt" || p === "option" || part === "⌥") return "Alt";
  return "Shift";
}

function normalizeKey(part: string): string {
  if (/^[a-z]$/i.test(part)) return part.toUpperCase();
  if (/^\d$/.test(part)) return part;
  return KEY_TO_CODE[part] ?? part;
}
