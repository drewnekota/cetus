import AppKit
import SwiftUI

/// Settings, a full-window page as in Cetus's settings-page.tsx: 48px header
/// with Back, a 208px searchable rail, and one section at a time in a 768px column.
struct SettingsView: View {
    @Environment(AppState.self) private var app
    @State private var search = ""
    @FocusState private var searchFocused: Bool
    @State private var escMonitor: Any?

    struct Section { let name: String; let description: String; let keywords: [String] }

    /// The rail of settings-page.tsx (SECTION_GROUPS), in order.
    static let groups: [(String, [Section])] = [
        ("General", [
            Section(name: "General", description: "Language and app-level basics.", keywords: ["move active chats to top", "workspace", "data", "version", "update", "diagnostics", "startup"]),
            Section(name: "Runtimes", description: "Choose which coding agents appear in runtime pickers and arrange them in your preferred order.", keywords: ["claude code", "codex", "opencode", "enable", "order", "presets", "worktree"]),
            Section(name: "Remote access", description: "", keywords: ["remote", "phone", "pair", "tunnel"]),
            Section(name: "Appearance", description: "Set the theme used across cetus. Changes apply instantly.", keywords: ["theme", "dark", "light", "font size", "zoom", "wallpaper", "skin"]),
            Section(name: "Keyboard shortcuts", description: "Click a shortcut to record a new one. Esc cancels, Backspace clears.", keywords: ["shortcut", "hotkey", "accelerator", "keyboard"]),
            Section(name: "Notifications", description: "Choose when Cetus notifies you.", keywords: ["notify", "focused", "finished", "input"]),
            Section(name: "Permissions", description: "Control whether runtimes ask before using tools.", keywords: ["permission", "approvals", "bypass", "accessibility", "screen recording"]),
        ]),
        ("Intelligence", [
            Section(name: "API Keys", description: "", keywords: ["api", "key", "deepseek", "provider"]),
            Section(name: "Models", description: "", keywords: ["model", "custom", "provider", "openai", "compatible"]),
            Section(name: "Memory", description: "", keywords: ["memory", "remember"]),
            Section(name: "Skills", description: "", keywords: ["skill"]),
            Section(name: "Slash commands", description: "", keywords: ["slash", "command"]),
            Section(name: "MCP", description: "", keywords: ["mcp", "connector", "server", "discovery"]),
            Section(name: "Plugins", description: "", keywords: ["plugin", "extension"]),
        ]),
        ("Input & Capture", [
            Section(name: "Launcher", description: "", keywords: ["launcher", "quick", "hotkey"]),
            Section(name: "Voice", description: "", keywords: ["voice", "dictation", "speech", "asr"]),
            Section(name: "Screen context", description: "", keywords: ["screen", "ambient", "context", "history"]),
            Section(name: "Meetings", description: "", keywords: ["meeting", "transcript", "record"]),
        ]),
        ("Data", [
            Section(name: "Archived chats", description: "Restore or permanently delete archived chats.", keywords: ["archive", "restore", "delete", "auto archive", "auto delete"]),
        ]),
    ]

    private var visible: [(String, [Section])] {
        let q = search.lowercased().trimmingCharacters(in: .whitespaces)
        let match: (Section) -> Bool = { s in q.isEmpty || s.name.lowercased().contains(q) || s.keywords.contains { $0.contains(q) } }
        return Self.groups.map { ($0.0, $0.1.filter(match)) }.filter { !$0.1.isEmpty }
    }

    var body: some View {
        let visible = self.visible
        let current = Self.groups.flatMap(\.1).first { $0.name == app.settingsSection } ?? Self.groups[0].1[0]
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button { app.settings = false } label: {
                    HStack(spacing: 6) {
                        Glyph(name: "arrow-left", size: 16, color: Theme.foreground)
                        Text("Back")
                    }
                }
                .buttonStyle(CetusButtonStyle(variant: .ghost, height: 32, fontSize: 14))
                .testID("settings-close")
                Text("Settings").font(.system(size: 14, weight: .semibold))
                Spacer()
            }
            .padding(.leading, 80).padding(.trailing, 12)
            .frame(height: 48)
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
            HStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    searchField.padding(8)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            if visible.isEmpty {
                                Text("No matching settings").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
                                    .frame(maxWidth: .infinity).padding(.vertical, 24)
                            }
                            ForEach(visible, id: \.0) { g in
                                VStack(alignment: .leading, spacing: 0) {
                                    Text(g.0).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.mutedForeground).lineBox(16.2)
                                        .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 4)
                                    ForEach(g.1, id: \.name) { s in RailItem(title: s.name, active: current.name == s.name) { app.settingsSection = s.name } }
                                }
                            }
                        }
                        .padding(.horizontal, 8).padding(.bottom, 8)
                    }
                    .scrollIndicators(.never)
                }
                .frame(width: 208)
                .background(Theme.muted.opacity(0.2))
                .overlay(alignment: .trailing) { Rectangle().fill(Theme.border).frame(width: 1) }
                ScrollView {
                    // Each section draws its own header, like Cetus's section components.
                    section(current)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 24).padding(.vertical, 32)
                    .frame(maxWidth: 768, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
                .background(Theme.muted.opacity(0.1))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
        .contentShape(Rectangle())
        // Like Cetus, nothing is focused on open; Esc (capture phase there, a local
        // monitor here) closes an open select, then clears the search, then the page.
        .onAppear {
            escMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { e in
                guard e.keyCode == 53, app.settings, app.recorder == nil else { return e }
                if app.popup != nil { app.popup = nil; return nil }
                if !search.isEmpty { search = ""; searchFocused = true; return nil }
                app.settings = false
                return nil
            }
        }
        .onDisappear { if let m = escMonitor { NSEvent.removeMonitor(m); escMonitor = nil } }
        .testID("settings")
    }

    private var searchField: some View {
        HStack(spacing: 7) {
            Glyph(name: "search", size: 16)
            TextField("", text: $search, prompt: Text("Search settings…").foregroundStyle(Theme.mutedForeground))
                .textFieldStyle(.plain).font(.system(size: 14))
                .focused($searchFocused)
                .onSubmit {
                    if let first = visible.first?.1.first { app.settingsSection = first.name }
                }
                .testID("settings-search")
            if !search.isEmpty {
                GhostIconButton(icon: "x", box: 28, glyph: 14, hoverFill: Theme.muted) { search = "" }.padding(.trailing, -6)
            }
        }
        .padding(.leading, 10).padding(.trailing, 10)
        .frame(height: 36)
        .background(RoundedRectangle(cornerRadius: 8).fill(GTheme.fieldFill).shadow(color: .black.opacity(0.05), radius: 1, y: 1))
        .background(RoundedRectangle(cornerRadius: 8).strokeBorder(searchFocused ? Theme.primary : Theme.input, lineWidth: 1))
        .background(RoundedRectangle(cornerRadius: 8).strokeBorder(searchFocused ? Theme.primary.opacity(0.5) : .clear, lineWidth: 3).padding(-2))
    }

    /// One case per section; each owns its header (see `SettingsHeaded`).
    @ViewBuilder
    private func section(_ s: Section) -> some View {
        switch s.name {
        case "General": GeneralSettingsSection()
        case "Runtimes": RuntimesSettingsSection()
        case "Remote access": RemoteAccessSection()
        case "Appearance": AppearanceSettingsSection()
        case "Keyboard shortcuts": ShortcutsSettingsSection()
        case "Notifications": NotificationsSettingsSection()
        case "Permissions": PermissionsSettingsSection()
        case "API Keys": IntelApiKeysSection()
        case "Models": IntelModelsSection()
        case "Memory": IntelMemorySection()
        case "Skills": IntelSkillsSection()
        case "Slash commands": IntelSlashSection()
        case "MCP": IntelMcpSection()
        case "Plugins": IntelPluginsSection()
        case "Launcher": LauncherSection()
        case "Voice": VoiceSection()
        case "Screen context": ScreenContextSection()
        case "Meetings": MeetingsSettingsSection()
        case "Archived chats": ArchivedChatsSection()
        default: SettingsHeaded(s) { EmptyView() }
        }
    }
}

/// The interim shared header (h2 18/27 semibold + muted description, then a
/// 24px gap) for sections not yet ported to their own Cetus layout.
struct SettingsHeaded<Content: View>: View {
    let section: SettingsView.Section
    @ViewBuilder let content: Content
    init(_ section: SettingsView.Section, @ViewBuilder content: () -> Content) { self.section = section; self.content = content() }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text(section.name).font(.system(size: 18, weight: .semibold))
                if !section.description.isEmpty {
                    Text(section.description).font(.system(size: 14)).foregroundStyle(Theme.mutedForeground)
                }
            }
            VStack(alignment: .leading, spacing: 20) { content }.padding(.top, 24)
        }
    }
}

private struct RailItem: View {
    let title: String
    let active: Bool
    let action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            Text(title).font(.system(size: 14, weight: .medium))
                .foregroundStyle(active || hover ? Theme.foreground : Theme.mutedForeground)
                .padding(.horizontal, 12)
                .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8).fill(active ? Theme.accent : hover ? Theme.muted : .clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .testID("settings-\(title)")
    }
}

/// Label block (14/500 + 12px muted description) with a trailing control.
struct SettingRow<Trailing: View>: View {
    let title: String
    var detail: String? = nil
    var vertical: CGFloat = 12
    @ViewBuilder let trailing: Trailing
    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 14, weight: .medium))
                if let detail { Text(detail).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).fixedSize(horizontal: false, vertical: true) }
            }
            Spacer()
            trailing
        }
        .padding(.vertical, vertical)
    }
}

/// `ToggleRow`: label block + 32×18.4 switch.
private struct ToggleRow: View {
    let title: String
    var detail: String? = nil
    let value: Bool
    var testID: String? = nil
    let set: (Bool) -> Void
    var body: some View {
        SettingRow(title: title, detail: detail) {
            CetusSwitch(isOn: Binding(get: { value }, set: set), testID: testID)
        }
    }
}

/// `SettingsList`: rounded-lg bordered card with dividers between rows.
private struct Card<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .padding(.horizontal, 16)
            .background(RoundedRectangle(cornerRadius: 10).fill(Theme.card))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
    }
}

private struct RowDivider: View {
    var body: some View { Rectangle().fill(Theme.border).frame(height: 1).padding(.horizontal, -16) }
}

private struct ArchivedSection: View {
    @Environment(AppState.self) private var app
    @State private var confirmAll = false
    var body: some View {
        let archived = app.controller.archived
        if archived.isEmpty {
            Text("No archived chats.").font(.system(size: 14)).foregroundStyle(Theme.mutedForeground)
        } else {
            HStack {
                Text("\(archived.count) archived").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
                Spacer()
                Button(confirmAll ? "Click again to delete all" : "Delete all") {
                    if confirmAll { for c in archived { app.controller.delete(c.id) }; confirmAll = false } else { confirmAll = true }
                }
                .buttonStyle(CetusButtonStyle(variant: .destructive, height: 28, fontSize: 12))
            }
            Card {
                ForEach(Array(archived.enumerated()), id: \.element.id) { i, c in
                    if i > 0 { RowDivider() }
                    HStack(spacing: 10) {
                        RuntimeIcon(id: c.backend, size: 14)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(c.title).font(.system(size: 14, weight: .medium)).lineLimit(1)
                            Text("\(ComposerView.workspaceLabel(c.workspaceDir)) · archived \(Fmt.relative(c.archivedAt ?? c.updatedAt))").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
                        }
                        Spacer()
                        Button("Open") { app.controller.restore(c.id); app.settings = false; app.openChat(c.id) }.buttonStyle(CetusButtonStyle(variant: .ghost, height: 28, fontSize: 12))
                        Button("Restore") { app.controller.restore(c.id) }.buttonStyle(CetusButtonStyle(variant: .outline, height: 28, fontSize: 12)).testID("restore-\(c.id)")
                        GhostIconButton(icon: "trash-2", box: 28, glyph: 14, tip: "Delete") { app.controller.delete(c.id) }
                    }
                    .padding(.vertical, 10)
                }
            }
        }
    }
}
