import AppKit

/// Rebindable shortcuts with the same ids, labels and defaults as Cetus's
/// lib/keyboard-shortcuts.ts. Accelerators use Electron-style names
/// ("Alt+Cmd+1", "Cmd+BracketLeft"); overrides live in prefs.shortcuts.
struct ShortcutDef: Identifiable {
    let id: String
    let label: String
    let group: String
    let defaultAccelerator: String
}

enum Shortcuts {
    static let groups = ["General", "Navigation", "Runtimes", "Workspace", "Chats"]

    static let all: [ShortcutDef] = {
        var s: [ShortcutDef] = [
            .init(id: "commandPalette", label: "Command palette", group: "General", defaultAccelerator: "Cmd+K"),
            .init(id: "findInChat", label: "Find in conversation", group: "General", defaultAccelerator: "Cmd+F"),
            .init(id: "newChat", label: "New chat or task", group: "General", defaultAccelerator: "Cmd+N"),
            .init(id: "newDefaultChat", label: "New chat", group: "General", defaultAccelerator: "Alt+Cmd+N"),
            .init(id: "archiveChat", label: "Archive chat", group: "General", defaultAccelerator: "Cmd+D"),
            .init(id: "openSettings", label: "Open settings", group: "General", defaultAccelerator: "Cmd+Comma"),
            .init(id: "switchChats", label: "Switch to chats", group: "Navigation", defaultAccelerator: "Alt+Cmd+1"),
            .init(id: "switchBoard", label: "Switch to Kanban", group: "Navigation", defaultAccelerator: "Alt+Cmd+2"),
            .init(id: "switchAutomations", label: "Switch to automations", group: "Navigation", defaultAccelerator: "Alt+Cmd+3"),
            .init(id: "switchPreviousView", label: "Switch between recent chats", group: "Navigation", defaultAccelerator: "Ctrl+Tab"),
            .init(id: "navigateBack", label: "Go back", group: "Navigation", defaultAccelerator: "Cmd+BracketLeft"),
            .init(id: "navigateForward", label: "Go forward", group: "Navigation", defaultAccelerator: "Cmd+BracketRight"),
        ]
        for i in 1 ... 9 { s.append(.init(id: "runtime\(i)", label: "Runtime \(i)", group: "Runtimes", defaultAccelerator: "Ctrl+\(i)")) }
        s += [
            .init(id: "toggleSidebar", label: "Toggle sidebar", group: "Workspace", defaultAccelerator: "Cmd+B"),
            .init(id: "toggleWorkspace", label: "Toggle workspace", group: "Workspace", defaultAccelerator: "Cmd+Backslash"),
            .init(id: "toggleTerminal", label: "Toggle terminal", group: "Workspace", defaultAccelerator: "Cmd+J"),
            .init(id: "openBrowserTab", label: "Open browser tab", group: "Workspace", defaultAccelerator: "Cmd+T"),
            .init(id: "openFilesTab", label: "Open files tab", group: "Workspace", defaultAccelerator: "Cmd+P"),
            .init(id: "closeWorkspaceTab", label: "Close workspace tab", group: "Workspace", defaultAccelerator: "Cmd+W"),
            .init(id: "previousWorkspaceTab", label: "Previous workspace tab", group: "Workspace", defaultAccelerator: "Cmd+Alt+ArrowLeft"),
            .init(id: "nextWorkspaceTab", label: "Next workspace tab", group: "Workspace", defaultAccelerator: "Cmd+Alt+ArrowRight"),
            .init(id: "previousChat", label: "Previous chat", group: "Chats", defaultAccelerator: "Cmd+Alt+ArrowUp"),
            .init(id: "nextChat", label: "Next chat", group: "Chats", defaultAccelerator: "Cmd+Alt+ArrowDown"),
            .init(id: "previousChatAlternate", label: "Previous chat (alternate)", group: "Chats", defaultAccelerator: "Shift+Cmd+BracketLeft"),
            .init(id: "nextChatAlternate", label: "Next chat (alternate)", group: "Chats", defaultAccelerator: "Shift+Cmd+BracketRight"),
        ]
        for i in 1 ... 8 { s.append(.init(id: "chat\(i)", label: "Chat \(i)", group: "Chats", defaultAccelerator: "Cmd+\(i)")) }
        s.append(.init(id: "lastChat", label: "Last chat", group: "Chats", defaultAccelerator: "Cmd+9"))
        return s
    }()

    static func accelerator(_ id: String, _ overrides: [String: String]) -> String {
        overrides[id] ?? all.first { $0.id == id }?.defaultAccelerator ?? ""
    }

    /// Physical key names (ANSI layout) by macOS virtual key code.
    static let keyNames: [UInt16: String] = {
        var m: [UInt16: String] = [
            0: "A", 11: "B", 8: "C", 2: "D", 14: "E", 3: "F", 5: "G", 4: "H", 34: "I", 38: "J", 40: "K", 37: "L", 46: "M",
            45: "N", 31: "O", 35: "P", 12: "Q", 15: "R", 1: "S", 17: "T", 32: "U", 9: "V", 13: "W", 7: "X", 16: "Y", 6: "Z",
            29: "0", 18: "1", 19: "2", 20: "3", 21: "4", 23: "5", 22: "6", 26: "7", 28: "8", 25: "9",
            33: "BracketLeft", 30: "BracketRight", 43: "Comma", 47: "Period", 44: "Slash", 42: "Backslash",
            41: "Semicolon", 39: "Quote", 50: "Backquote", 27: "Minus", 24: "Equal",
            123: "ArrowLeft", 124: "ArrowRight", 125: "ArrowDown", 126: "ArrowUp",
            48: "Tab", 36: "Enter", 76: "Enter", 53: "Escape", 49: "Space", 51: "Backspace", 117: "Delete",
            115: "Home", 119: "End", 116: "PageUp", 121: "PageDown",
        ]
        for (i, code) in [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111].enumerated() { m[UInt16(code)] = "F\(i + 1)" }
        return m
    }()

    static let symbols: [String: String] = [
        "BracketLeft": "[", "BracketRight": "]", "Comma": ",", "Period": ".", "Slash": "/", "Backslash": "\\",
        "Semicolon": ";", "Quote": "'", "Backquote": "`", "Minus": "-", "Equal": "=",
        "ArrowLeft": "←", "ArrowRight": "→", "ArrowUp": "↑", "ArrowDown": "↓", "Tab": "⇥", "Enter": "↩",
        "Escape": "⎋", "Space": "Space", "Backspace": "⌫", "Delete": "⌦",
    ]

    /// Electron-style accelerator for a key event, e.g. "Alt+Cmd+1"; nil for bare modifiers.
    static func accelerator(for event: NSEvent) -> String? {
        guard let key = keyNames[event.keyCode] else { return nil }
        let f = event.modifierFlags
        var parts: [String] = []
        if f.contains(.control) { parts.append("Ctrl") }
        if f.contains(.option) { parts.append("Alt") }
        if f.contains(.shift) { parts.append("Shift") }
        if f.contains(.command) { parts.append("Cmd") }
        parts.append(key)
        return parts.joined(separator: "+")
    }

    /// Normalized form for comparison: modifiers sorted, aliases folded.
    static func normalize(_ accel: String) -> String {
        let aliases = ["Command": "Cmd", "CmdOrCtrl": "Cmd", "Control": "Ctrl", "Option": "Alt", "Return": "Enter", "Esc": "Escape", "Up": "ArrowUp", "Down": "ArrowDown", "Left": "ArrowLeft", "Right": "ArrowRight", "Plus": "Equal", "=": "Equal", "-": "Minus", ",": "Comma", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash"]
        let parts = accel.split(separator: "+").map { p -> String in
            let s = String(p)
            return aliases[s] ?? (s.count == 1 ? s.uppercased() : s)
        }
        let order = ["Ctrl", "Alt", "Shift", "Cmd"]
        let mods = order.filter { parts.contains($0) }
        let keys = parts.filter { !order.contains($0) }
        return (mods + keys).joined(separator: "+")
    }

    static func matches(_ event: NSEvent, _ accel: String) -> Bool {
        guard !accel.isEmpty, let a = accelerator(for: event) else { return false }
        return normalize(a) == normalize(accel)
    }

    /// "⌥⌘1" style display.
    static func format(_ accel: String) -> String {
        if accel.isEmpty { return "" }
        let parts = normalize(accel).split(separator: "+").map(String.init)
        var out = ""
        for p in parts {
            switch p {
            case "Ctrl": out += "⌃"
            case "Alt": out += "⌥"
            case "Shift": out += "⇧"
            case "Cmd": out += "⌘"
            default: out += symbols[p] ?? p
            }
        }
        return out
    }

    static func hint(_ id: String, _ prefs: Prefs) -> String { format(accelerator(id, prefs.shortcuts)) }

    /// Ids sharing an accelerator with another shortcut.
    static func conflicts(_ overrides: [String: String]) -> Set<String> {
        var seen: [String: [String]] = [:]
        for s in all {
            let a = normalize(accelerator(s.id, overrides))
            if !a.isEmpty { seen[a, default: []].append(s.id) }
        }
        return Set(seen.values.filter { $0.count > 1 }.flatMap { $0 })
    }
}
