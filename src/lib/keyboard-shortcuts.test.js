import { describe, expect, test } from "bun:test";
import {
  defaultShortcutMap,
  matchesShortcut,
  mergeStoredShortcutMap,
  shortcutDisplay,
} from "./keyboard-shortcuts.ts";

describe("platform keyboard shortcuts", () => {
  test("Windows defaults use native conventions without conflicts", () => {
    const shortcuts = defaultShortcutMap("windows");
    expect(shortcuts.newChat).toBe("Ctrl+N");
    expect(shortcuts.navigateBack).toBe("Alt+ArrowLeft");
    expect(shortcuts.runtimeCetus).toBe("Alt+1");
    expect(shortcuts.previousWorkspaceTab).toBe("Ctrl+PageUp");
    expect(shortcuts.previousChat).toBe("Ctrl+Shift+ArrowUp");
    expect(new Set(Object.values(shortcuts)).size).toBe(
      Object.keys(shortcuts).length,
    );
  });

  test("macOS defaults and symbolic display stay unchanged", () => {
    const shortcuts = defaultShortcutMap("mac");
    expect(shortcuts.newChat).toBe("Cmd+N");
    expect(shortcuts.runtimeCetus).toBe("Ctrl+1");
    expect(shortcutDisplay(shortcuts.newDefaultChat, "mac")).toBe("⌥⌘N");
  });

  test("Windows display uses readable modifier names", () => {
    expect(shortcutDisplay("Ctrl+Alt+ArrowUp", "windows")).toBe(
      "Ctrl+Alt+↑",
    );
    expect(shortcutDisplay("Ctrl+PageDown", "windows")).toBe("Ctrl+PgDn");
  });

  test("legacy macOS defaults migrate on Windows but custom keys survive", () => {
    const migrated = mergeStoredShortcutMap(
      {
        commandPalette: "Cmd+K",
        runtimeCetus: "Ctrl+1",
        newChat: "Ctrl+Shift+N",
      },
      "windows",
    );
    expect(migrated.commandPalette).toBe("Ctrl+K");
    expect(migrated.runtimeCetus).toBe("Alt+1");
    expect(migrated.newChat).toBe("Ctrl+Shift+N");
  });

  test("Windows key events match the resolved accelerators", () => {
    const event = {
      code: "KeyN",
      key: "n",
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
    };
    expect(matchesShortcut(event, "Ctrl+N")).toBe(true);
    expect(matchesShortcut(event, "Cmd+N")).toBe(false);
  });
});
