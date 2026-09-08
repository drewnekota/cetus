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
    expect(shortcuts.toggleSidebar).toBe("Ctrl+B");
    expect(shortcuts.toggleWorkspace).toBe("Ctrl+Backslash");
    expect(shortcuts.navigateBack).toBe("Alt+ArrowLeft");
    expect(shortcuts.runtimeSlot1).toBe("Alt+1");
    expect(shortcuts.runtimeSlot6).toBe("Alt+6");
    expect(shortcuts.previousWorkspaceTab).toBe("Ctrl+PageUp");
    expect(shortcuts.previousChat).toBe("Ctrl+Shift+ArrowUp");
    expect(new Set(Object.values(shortcuts)).size).toBe(
      Object.keys(shortcuts).length,
    );
  });

  test("macOS defaults and symbolic display stay unchanged", () => {
    const shortcuts = defaultShortcutMap("mac");
    expect(shortcuts.newChat).toBe("Cmd+N");
    expect(shortcuts.toggleSidebar).toBe("Cmd+B");
    expect(shortcuts.toggleWorkspace).toBe("Cmd+Backslash");
    expect(shortcutDisplay(shortcuts.toggleWorkspace, "mac")).toBe("⌘\\");
    expect(shortcuts.runtimeSlot1).toBe("Ctrl+1");
    expect(shortcuts.runtimeSlot6).toBe("Ctrl+6");
    expect(shortcutDisplay(shortcuts.newDefaultChat, "mac")).toBe("⌥⌘N");
    // ⌃4…⌃6 are new with the positional runtime slots — keep them collision-free.
    expect(new Set(Object.values(shortcuts)).size).toBe(
      Object.keys(shortcuts).length,
    );
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
        runtimeSlot1: "Ctrl+1",
        newChat: "Ctrl+Shift+N",
      },
      "windows",
    );
    expect(migrated.commandPalette).toBe("Ctrl+K");
    expect(migrated.runtimeSlot1).toBe("Alt+1");
    expect(migrated.newChat).toBe("Ctrl+Shift+N");
  });

  test("runtime slots inherit the bindings they replaced, by position", () => {
    const migrated = mergeStoredShortcutMap(
      {
        // Pre-0.3.41 per-runtime ids, one of them rebound by the user.
        runtimeCetus: "Ctrl+1",
        runtimeClaudeCode: "Ctrl+Shift+2",
        runtimeCodex: "Ctrl+3",
      },
      "mac",
    );
    expect(migrated.runtimeSlot1).toBe("Ctrl+1");
    expect(migrated.runtimeSlot2).toBe("Ctrl+Shift+2");
    expect(migrated.runtimeSlot3).toBe("Ctrl+3");
    // Slots the old scheme never had fall back to their defaults.
    expect(migrated.runtimeSlot4).toBe("Ctrl+4");
    // An explicit new-style binding wins over the legacy one it replaced.
    expect(
      mergeStoredShortcutMap(
        { runtimeCetus: "Ctrl+9", runtimeSlot1: "Ctrl+1" },
        "mac",
      ).runtimeSlot1,
    ).toBe("Ctrl+1");
  });

  test("old sidebar defaults migrate while custom bindings survive", () => {
    for (const platform of ["mac", "windows"]) {
      const mod = platform === "mac" ? "Cmd" : "Ctrl";
      const migrated = mergeStoredShortcutMap({
        toggleSidebar: `Shift+${mod}+S`,
        toggleWorkspace: `${mod}+B`,
      }, platform);
      expect(migrated.toggleSidebar).toBe(`${mod}+B`);
      expect(migrated.toggleWorkspace).toBe(`${mod}+Backslash`);
      const custom = { toggleSidebar: `${mod}+9`, toggleWorkspace: `${mod}+8` };
      expect(mergeStoredShortcutMap(custom, platform)).toMatchObject(custom);
      const defaults = defaultShortcutMap(platform);
      expect(mergeStoredShortcutMap(defaults, platform)).toEqual(defaults);
    }
    expect(mergeStoredShortcutMap({
      toggleSidebar: "Shift+Cmd+S", toggleWorkspace: "Cmd+B",
    }, "windows")).toMatchObject({
      toggleSidebar: "Ctrl+B", toggleWorkspace: "Ctrl+Backslash",
    });
  });

  test("right sidebar matches the backslash key event", () => {
    expect(matchesShortcut({
      code: "Backslash", key: "\\", metaKey: true, ctrlKey: false,
      altKey: false, shiftKey: false,
    }, defaultShortcutMap("mac").toggleWorkspace)).toBe(true);
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
