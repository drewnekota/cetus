"use client";

import { useEffect, useState } from "react";

export type ShortcutId =
  | "commandPalette"
  | "newChat"
  | "newDefaultChat"
  | "archiveChat"
  | "openSettings"
  | "switchChats"
  | "switchBoard"
  | "switchAutomations"
  | "switchPlugins"
  | "runtimeCetus"
  | "runtimeClaudeCode"
  | "runtimeCodex"
  | "toggleWorkspace"
  | "toggleTerminal"
  | "openBrowserTab"
  | "openFilesTab"
  | "closeWorkspaceTab"
  | "previousWorkspaceTab"
  | "nextWorkspaceTab"
  | "previousChat"
  | "nextChat";

export interface ShortcutDefinition {
  id: ShortcutId;
  label: string;
  description: string;
  defaultAccelerator: string;
}

export type ShortcutMap = Record<ShortcutId, string>;

export const KEYBOARD_SHORTCUTS_STORAGE_KEY = "cetus:keyboardShortcuts";
export const KEYBOARD_SHORTCUTS_EVENT = "cetus-keyboard-shortcuts-changed";

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  {
    id: "commandPalette",
    label: "Command palette",
    description: "Open or close the command palette",
    defaultAccelerator: "Cmd+K",
  },
  {
    id: "newChat",
    label: "New chat",
    description: "Start a new chat, or create a board task from Kanban",
    defaultAccelerator: "Cmd+N",
  },
  {
    id: "newDefaultChat",
    label: "New chat in Chat",
    description: "Start a new chat in Chat, wherever you are",
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
    id: "switchPlugins",
    label: "Switch to plugins",
    description: "Show installed plugins",
    defaultAccelerator: "Cmd+4",
  },
  {
    id: "runtimeCetus",
    label: "Runtime: Cetus",
    description: "Switch the current chat to the Cetus runtime",
    defaultAccelerator: "Ctrl+1",
  },
  {
    id: "runtimeClaudeCode",
    label: "Runtime: Claude Code",
    description: "Switch the current chat to the Claude Code runtime",
    defaultAccelerator: "Ctrl+2",
  },
  {
    id: "runtimeCodex",
    label: "Runtime: Codex",
    description: "Switch the current chat to the Codex runtime",
    defaultAccelerator: "Ctrl+3",
  },
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
  },
  {
    id: "nextWorkspaceTab",
    label: "Next workspace tab",
    description: "Move to the next right workspace tab",
    defaultAccelerator: "Cmd+Alt+ArrowRight",
  },
  {
    id: "previousChat",
    label: "Previous chat",
    description: "Move to the previous chat in the sidebar",
    defaultAccelerator: "Cmd+Alt+ArrowUp",
  },
  {
    id: "nextChat",
    label: "Next chat",
    description: "Move to the next chat in the sidebar",
    defaultAccelerator: "Cmd+Alt+ArrowDown",
  },
];

const MOD_SYMBOL: Record<string, string> = {
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Cmd: "⌘",
};

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

export function defaultShortcutMap(): ShortcutMap {
  return Object.fromEntries(
    SHORTCUT_DEFINITIONS.map((s) => [s.id, s.defaultAccelerator]),
  ) as ShortcutMap;
}

export function readKeyboardShortcuts(): ShortcutMap {
  const defaults = defaultShortcutMap();
  if (typeof window === "undefined") return defaults;
  try {
    const raw = window.localStorage.getItem(KEYBOARD_SHORTCUTS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<Record<ShortcutId, unknown>>;
    const next = { ...defaults };
    for (const def of SHORTCUT_DEFINITIONS) {
      const value = parsed[def.id];
      if (typeof value === "string") next[def.id] = normalizeAccelerator(value);
    }
    return next;
  } catch {
    return defaults;
  }
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

export function shortcutChips(accelerator: string): string[] {
  const normalized = normalizeAccelerator(accelerator);
  if (!normalized) return [];
  return normalized.split("+").map((part) => MOD_SYMBOL[part] ?? KEY_LABEL[part] ?? part);
}

export function shortcutDisplay(accelerator: string): string {
  const chips = shortcutChips(accelerator);
  return chips.length ? chips.join("") : "Unassigned";
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
