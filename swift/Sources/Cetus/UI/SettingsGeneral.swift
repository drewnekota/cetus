import AppKit
import AVFoundation
import Speech
import SwiftUI
import UserNotifications

// Settings → "General" group (General, Runtimes, Remote access, Appearance,
// Keyboard shortcuts, Notifications, Permissions), ported from Cetus's
// components/settings/sections/*.tsx, plus the shadcn building blocks they use
// (prefixed `G` so other settings sections can reuse them).

// MARK: - Tokens not in Theme

enum GTheme {
    static func dyn(_ light: UInt32, _ dark: UInt32, _ la: CGFloat = 1, _ da: CGFloat = 1) -> Color {
        Color(nsColor: NSColor(name: nil) { a in
            a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(hex: dark, alpha: da) : NSColor(hex: light, alpha: la)
        })
    }

    /// emerald-600 / dark:emerald-400 text, emerald-500/10 fill.
    static let emeraldText = dyn(0x009966, 0x00D492)
    static let emeraldFill = Color(nsColor: NSColor(hex: 0x00BC7D, alpha: 0.1))
    /// amber-600 / dark:amber-400 text, amber-500/10 fill.
    static let amberText = dyn(0xE17100, 0xFFB900)
    static let amberFill = Color(nsColor: NSColor(hex: 0xFE9A00, alpha: 0.1))
    /// amber-600 / dark:amber-500.
    static let amberHint = dyn(0xE17100, 0xFE9A00)
    /// Outline button / input fill: bg-background, dark:bg-input/30.
    static let fieldFill = dyn(0xFCFCFD, 0x2E2F31, 1, 0.3)
    static let fieldFillHover = dyn(0xEFEFF0, 0x2E2F31, 1, 0.5)
    /// Outline button border: border-border, dark:border-input.
    static let outlineBorder = dyn(0xE5E5E6, 0x2E2F31)
    /// Switch: unchecked bg-input, dark:bg-input/80; thumb bg-background, dark: foreground / primary-foreground.
    static let switchOff = dyn(0xDDDDDE, 0x2E2F31, 1, 0.8)
    static let thumbOff = dyn(0xFCFCFD, 0xE3E4E6)
    static let thumbOn = dyn(0xFCFCFD, 0xE3E4E6)
    /// ghost hover: bg-muted, dark:bg-muted/50.
    static let ghostHover = dyn(0xEFEFF0, 0x252528, 1, 0.5)
}

// MARK: - CSS line boxes

private func gNatural(_ size: CGFloat, _ weight: NSFont.Weight = .regular, mono: Bool = false) -> CGFloat {
    let f = mono ? NSFont.monospacedSystemFont(ofSize: size, weight: weight) : NSFont.systemFont(ofSize: size, weight: weight)
    // SwiftUI's wrapped lines measure ~0.1pt taller than the layout manager's default (measured at 12 and 14pt).
    return NSLayoutManager().defaultLineHeight(for: f) + 0.1
}

extension View {
    /// Multi-line text laid out on a CSS `line-height` grid (half-leading above and below each line).
    func gLines(_ size: CGFloat, _ lineHeight: CGFloat, mono: Bool = false) -> some View {
        let extra = lineHeight - gNatural(size, mono: mono)
        return lineSpacing(max(0, extra)).padding(.vertical, extra / 2)
    }
}

/// `<p class="text-xs text-muted-foreground">`: wrapping 12/16.2 muted text.
struct GDetail: View {
    let text: String
    var size: CGFloat = 12
    var lineHeight: CGFloat = 16.2
    var color: Color = Theme.mutedForeground
    var body: some View {
        Text(text).font(.system(size: size)).foregroundStyle(color)
            .gLines(size, lineHeight)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// `SectionHeading`: h2 18/27 semibold, then (space-y-1) the 14/20 muted description.
struct GSectionHeading: View {
    let title: String
    let description: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.system(size: 18, weight: .semibold)).foregroundStyle(Theme.foreground).lineBox(27)
            GDetail(text: description, size: 14, lineHeight: 20.02)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// `<h3 class="text-sm font-semibold">` + `<p class="mt-1 text-xs text-muted-foreground">`.
struct GSubheading: View {
    let title: String
    let description: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.foreground).lineBox(20.02)
            GDetail(text: description)
        }
    }
}

/// Label (14/500, leading-none) + `space-y-0.5` + 12/16.2 muted description.
struct GLabelBlock: View {
    let title: String
    var detail: String? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.foreground).lineBox(14)
            if let detail { GDetail(text: detail) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Controls

/// shadcn Switch: 32×18.4, 1px transparent border, 16px thumb, shadow-xs; disabled = 50%.
struct GSwitch: View {
    let isOn: Bool
    var disabled = false
    var testID: String? = nil
    let set: (Bool) -> Void
    var body: some View {
        Button { set(!isOn) } label: {
            ZStack(alignment: .leading) {
                Capsule().fill(isOn ? Theme.primary : GTheme.switchOff)
                Circle().fill(isOn ? GTheme.thumbOn : GTheme.thumbOff).frame(width: 16, height: 16)
                    .offset(x: isOn ? 15 : 1)
            }
            .frame(width: 32, height: 18.4)
            .shadow(color: .black.opacity(0.05), radius: 1, y: 1)
            .compositingGroup()
            .opacity(disabled ? 0.5 : 1)
            .animation(.easeOut(duration: 0.15), value: isOn)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .testID(testID)
    }
}

/// `ToggleRow` (settings-controls.tsx): py-3 label block + switch; `boxed` adds px-3.
struct GToggleRow: View {
    let title: String
    let detail: String
    let isOn: Bool
    var boxed = false
    var disabled = false
    var testID: String? = nil
    let set: (Bool) -> Void
    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            GLabelBlock(title: title, detail: detail)
            GSwitch(isOn: isOn, disabled: disabled, testID: testID, set: set)
        }
        .padding(.vertical, 12)
        .padding(.horizontal, boxed ? 12 : 0)
    }
}

/// shadcn Button, size sm (h-8 px-2.5, radius 8, 14/500), icons 14.
struct GButton: View {
    enum Variant { case primary, outline, ghost }
    let title: String
    var icon: String? = nil
    var variant: Variant = .outline
    var height: CGFloat = 32
    var fontSize: CGFloat = 14
    var gap: CGFloat = 6
    var muted = false
    var disabled = false
    var testID: String? = nil
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: gap) {
                if let icon { Glyph(name: icon, size: 14, color: fg) }
                Text(title).font(.system(size: fontSize, weight: .medium)).foregroundStyle(fg).lineBox(fontSize == 12 ? 16.2 : 20.02)
            }
            .padding(.horizontal, 11)
            .frame(height: height)
            .background(RoundedRectangle(cornerRadius: 7).fill(bg).padding(1))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(variant == .outline ? GTheme.outlineBorder : .clear, lineWidth: 1))
            .shadow(color: variant == .outline ? .black.opacity(0.05) : .clear, radius: 1, y: 1)
            .compositingGroup()
            .opacity(disabled ? 0.5 : 1)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressDownStyle())
        .disabled(disabled)
        .onHover { hover = $0 && !disabled }
        .fixedSize()
        .testID(testID)
    }

    private var fg: Color {
        switch variant {
        case .primary: Theme.primaryForeground
        case .ghost: muted && !hover ? Theme.mutedForeground : Theme.foreground
        case .outline: Theme.foreground
        }
    }

    private var bg: Color {
        switch variant {
        case .primary: Theme.primary.opacity(hover ? 0.8 : 1)
        case .outline: hover ? GTheme.fieldFillHover : GTheme.fieldFill
        case .ghost: hover ? GTheme.ghostHover : .clear
        }
    }
}

/// shadcn ghost icon button (`size-7`/`size-8`), muted glyph.
struct GIconButton: View {
    let icon: String
    var box: CGFloat = 28
    var glyph: CGFloat = 14
    var tip = ""
    var disabled = false
    var testID: String? = nil
    let action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            Glyph(name: icon, size: glyph, color: hover ? Theme.foreground : Theme.mutedForeground)
                .frame(width: box, height: box)
                .background(RoundedRectangle(cornerRadius: 7).fill(hover ? GTheme.ghostHover : .clear).padding(1))
                .compositingGroup()
                .opacity(disabled ? 0.5 : 1)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressDownStyle())
        .disabled(disabled)
        .onHover { hover = $0 && !disabled }
        .if(!tip.isEmpty) { $0.help(tip) }
        .testID(testID)
    }
}

/// One option of a `GSelect`.
struct GOption: Identifiable {
    let id: String
    let label: String
    var icon: AnyView? = nil
}

/// shadcn Select: bordered trigger (h-9 or h-8 `size="sm"`, px-3, chevron 16 @50%)
/// and a popper list below it (4px gap, trigger-wide, 32px rows, check on the right).
struct GSelect: View {
    let id: String
    let value: String
    let options: [GOption]
    var width: CGFloat = 208
    var height: CGFloat = 36
    var fontSize: CGFloat = 14
    var testID: String? = nil
    let set: (String) -> Void
    @Environment(AppState.self) private var app
    @State private var frame: CGRect = .zero

    var body: some View {
        let current = options.first { $0.id == value }
        Button {
            if app.popup?.id == id { app.popup = nil; return }
            app.popup = PopupSpec(id: id, anchor: frame, style: .select,
                                  content: AnyView(GSelectList(options: options, value: value, width: width, fontSize: fontSize) { v in
                                      app.popup = nil
                                      set(v)
                                  }))
        } label: {
            HStack(spacing: 8) {
                if let icon = current?.icon { icon.frame(width: 16, height: 16) }
                Text(current?.label ?? "").font(.system(size: fontSize)).foregroundStyle(Theme.foreground).lineLimit(1)
                    .lineBox(fontSize == 12 ? 16.2 : 20.02)
                Spacer(minLength: 0)
                Glyph(name: "chevron-down", size: 16, color: Theme.mutedForeground).opacity(0.5)
            }
            .padding(.horizontal, 13)
            .frame(width: width, height: height)
            .background(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.input, lineWidth: 1))
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.clear).shadow(color: .black.opacity(0.05), radius: 1, y: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .readFrame($frame)
        .testID(testID ?? id)
    }
}

private struct GSelectList: View {
    let options: [GOption]
    let value: String
    let width: CGFloat
    let fontSize: CGFloat
    let pick: (String) -> Void
    @State private var hovered: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(options) { o in
                Button { pick(o.id) } label: {
                    HStack(spacing: 8) {
                        if let icon = o.icon { icon.frame(width: 16, height: 16) }
                        Text(o.label).font(.system(size: fontSize)).foregroundStyle(Theme.foreground).lineLimit(1)
                            .lineBox(fontSize == 12 ? 16.2 : 20.02)
                        Spacer(minLength: 0)
                    }
                    .padding(.leading, 8).padding(.trailing, 32).padding(.vertical, 6)
                    .overlay(alignment: .trailing) {
                        if o.id == value { Glyph(name: "check", size: 16, color: Theme.mutedForeground).padding(.trailing, 7) }
                    }
                    .background(RoundedRectangle(cornerRadius: 6).fill((hovered ?? value) == o.id ? Theme.accent : .clear))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .onHover { if $0 { hovered = o.id } }
                .testID("option-\(o.id)")
            }
        }
        .padding(4)
        .padding(1)
        .frame(minWidth: width + 2, alignment: .leading)
        .fixedSize()
    }
}

/// shadcn Input look (h-9, radius 8, border-input, dark:bg-input/30, shadow-xs) around a plain TextField.
struct GInput: View {
    let placeholder: String
    @Binding var text: String
    var width: CGFloat? = nil
    var height: CGFloat = 36
    var fill: Color = GTheme.fieldFill
    var mono = false
    var fontSize: CGFloat = 14
    var leading: CGFloat = 11
    var testID: String? = nil
    var onCommit: () -> Void = {}
    @FocusState private var focused: Bool
    var body: some View {
        TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(Theme.mutedForeground))
            .textFieldStyle(.plain)
            .font(mono ? .system(size: fontSize, design: .monospaced) : .system(size: fontSize))
            .foregroundStyle(Theme.foreground)
            .focused($focused)
            .onSubmit(onCommit)
            .padding(.leading, leading).padding(.trailing, 11)
            .frame(width: width, height: height)
            .background(RoundedRectangle(cornerRadius: 8).fill(fill))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(focused ? Theme.primary : Theme.input, lineWidth: 1))
            .overlay(RoundedRectangle(cornerRadius: 9.5).strokeBorder(focused ? Theme.primary.opacity(0.5) : .clear, lineWidth: 3).padding(-3))
            .shadow(color: .black.opacity(0.05), radius: 1, y: 1)
            .onChange(of: focused) { _, f in if !f { onCommit() } }
            .testID(testID)
    }
}

/// `rounded-full px-2 py-0.5 text-2xs` badge.
private struct GBadge: View {
    let text: String
    var fg: Color = Theme.mutedForeground
    var bg: Color = Theme.muted
    var body: some View {
        Text(text).font(.system(size: 11)).foregroundStyle(fg).lineBox(15.4)
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(Capsule().fill(bg))
    }
}

/// `rounded border border-border px-1.5 py-0.5 font-mono text-2xs` slot chip.
private struct GSlotChip: View {
    let text: String
    var body: some View {
        Text(text).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.mutedForeground).lineBox(15.4)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Theme.border, lineWidth: 1))
    }
}

/// Local, non-shared settings persisted in UserDefaults under "settings." keys.
@MainActor
enum GStore {
    static let defaults = UserDefaults.standard
    static func bool(_ key: String, _ def: Bool) -> Bool { defaults.object(forKey: "settings.\(key)") as? Bool ?? def }
    static func setBool(_ key: String, _ v: Bool) { defaults.set(v, forKey: "settings.\(key)") }
}

// MARK: - General

struct GeneralSettingsSection: View {
    @Environment(AppState.self) private var app
    @AppStorage("settings.language") private var language = "system"
    @AppStorage("settings.launchOnStartup") private var launchOnStartup = true
    @AppStorage("settings.autoUpdate") private var autoUpdate = true
    @AppStorage("settings.confirmQuit") private var confirmQuit = true
    @AppStorage("settings.keepAwakeWhileWorking") private var keepAwake = true
    @State private var diag = "idle"

    static let locales: [(String, String)] = [("en", "English"), ("zh", "简体中文"), ("ja", "日本語"), ("ko", "한국어"), ("es", "Español"),
                                               ("pt", "Português"), ("fr", "Français"), ("de", "Deutsch"), ("it", "Italiano"), ("ru", "Русский")]
    static var version: String { CLIServer.version }

    var body: some View {
        let p = app.prefs
        VStack(alignment: .leading, spacing: 0) {
            GSectionHeading(title: "General", description: "Language and app-level basics.")
            HStack(spacing: 16) {
                GLabelBlock(title: "Language", detail: "Choose the display language, or follow your system setting.")
                GSelect(id: "settings-language", value: language,
                        options: [GOption(id: "system", label: "System")] + Self.locales.map { GOption(id: $0.0, label: $0.1) }) { language = $0 }
            }
            .padding(.top, 24)
            VStack(alignment: .leading, spacing: 0) {
                GToggleRow(title: "Move active chats to the top",
                           detail: "Reorder chats when they receive new messages. Turn this off to keep chats in creation order, with newly created chats at the top.",
                           isOn: p.moveActiveToTop, testID: "toggle-auto-sort") { v in app.controller.setPrefs { $0.moveActiveToTop = v } }
                GToggleRow(title: "Launch on startup", detail: "Start Cetus in the tray automatically when you log in.", isOn: launchOnStartup) { launchOnStartup = $0 }
                GToggleRow(title: "Automatic updates", detail: "Check for and install updates in the background. Applied the next time you open Cetus.", isOn: autoUpdate) { autoUpdate = $0 }
                GToggleRow(title: "Confirm before quitting", detail: "Ask before Cmd+Q closes Cetus, so a slip of the hand doesn't interrupt running agents.", isOn: confirmQuit) { confirmQuit = $0 }
                GToggleRow(title: "Keep Mac awake while working",
                           detail: "Hold off system sleep while an agent turn or meeting recording is running. The display still sleeps and locks; closing the lid still sleeps.",
                           isOn: keepAwake) { keepAwake = $0 }
                HStack(spacing: 16) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 8) {
                            Text("Updates").font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.foreground).lineBox(14)
                            Text("v\(Self.version)").font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.mutedForeground).lineBox(16.2)
                        }
                        if !AppShellUpdater.enabled { GDetail(text: "Development build: updates are off.") }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    GButton(title: "Check for updates", disabled: !AppShellUpdater.enabled) { AppShellUpdater.checkForUpdates() }
                }
                .padding(.vertical, 12)
                HStack(spacing: 16) {
                    GLabelBlock(title: "Diagnostics", detail: "Copy a sanitized report (versions, PATH, runtime status, recent log) to attach when reporting a bug.")
                    GButton(title: diag == "copied" ? "Copied" : "Copy report", disabled: diag == "busy") {
                        diag = "busy"
                        DispatchQueue.global().async {
                            let report = AppShellDiagnostics.export()
                            DispatchQueue.main.async {
                                System.copy(report)
                                diag = "copied"
                                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { diag = "idle" }
                            }
                        }
                    }
                }
                .padding(.vertical, 12)
            }
            .padding(.top, 8)
        }
    }

    static func diagnostics(_ p: Prefs) -> String {
        let path = Env.shell["PATH"] ?? ""
        var lines = ["Cetus (Swift) v\(version)", "macOS \(ProcessInfo.processInfo.operatingSystemVersionString)",
                     "Agent host: \(AgentHost.binaryPath().map(Env.tildify) ?? "not found")", "PATH: \(path.replacingOccurrences(of: Env.home, with: "~"))", "Runtimes:"]
        for r in Runtimes.all where r.id != "pi" {
            lines.append("  \(r.id): \(RuntimeStatus.installed(r.id) ? "installed" : "not installed")\(p.disabledRuntimes.contains(r.id) ? " (disabled)" : "")")
        }
        return lines.joined(separator: "\n")
    }
}

// MARK: - Runtimes

/// `get_cli_runtime_status`: a runtime is installed when its CLI is a file on PATH.
enum RuntimeStatus {
    static let binaries = ["claude-code": "claude", "codex": "codex", "opencode": "opencode", "grok": "grok", "kimi": "kimi", "dsh": "dsh"]
    static func installed(_ id: String) -> Bool {
        guard let name = binaries[id] else { return true }
        let path = Env.shell["PATH"] ?? Env.process["PATH"] ?? ""
        var dir: ObjCBool = false
        return path.split(separator: ":").contains { d in
            let p = "\(d)/\(name)"
            return FileManager.default.fileExists(atPath: p, isDirectory: &dir) && !dir.boolValue
        }
    }
    static func codexLoggedIn() -> Bool {
        FileManager.default.fileExists(atPath: "\(Env.home)/.codex/auth.json") || !(Env.shell["OPENAI_API_KEY"] ?? "").trimmingCharacters(in: .whitespaces).isEmpty
    }
}

/// A runtime preset (RuntimePreset): a tunable runtime pinned to a model and effort.
struct GRuntimePreset: Codable, Equatable, Identifiable {
    var id: String
    var backend: String
    var model: String
    var effort: String

    var label: String {
        let r = Runtimes.byId(backend)
        let model = r.models.first { $0.id == self.model }?.label ?? (self.model.isEmpty ? "Default" : self.model)
        let effort = r.efforts.first { $0.id == self.effort }?.label ?? self.effort
        return effort.isEmpty ? model : "\(model) · \(effort)"
    }

    static func load() -> [GRuntimePreset] {
        guard let d = UserDefaults.standard.data(forKey: "settings.runtimePresets") else { return [] }
        return (try? JSONDecoder().decode([GRuntimePreset].self, from: d)) ?? []
    }
    static func save(_ v: [GRuntimePreset]) {
        UserDefaults.standard.set(try? JSONEncoder().encode(v), forKey: "settings.runtimePresets")
    }
}

struct RuntimesSettingsSection: View {
    @Environment(AppState.self) private var app
    @AppStorage("settings.isolateInWorktree") private var isolateInWorktree = false
    @State private var presets = GRuntimePreset.load()
    @State private var status: [String: Bool] = [:]
    @State private var codexLoggedIn = true
    @State private var dragging: String?
    @State private var dragY: CGFloat = 0
    private let rowHeight: CGFloat = 62.6

    static let commands = ["pi": "Built into Cetus", "claude-code": "claude --output-format stream-json", "codex": "codex app-server",
                           "opencode": "opencode acp", "grok": "grok agent stdio", "kimi": "kimi acp", "dsh": "dsh web + Cetus bridge"]

    /// normalizeRuntimeEntryOrder: saved order, then missing runtimes, then missing presets.
    private func entries(_ p: Prefs) -> [String] {
        let known = Runtimes.all.map(\.id)
        let presetIds = presets.map(\.id)
        var out: [String] = []
        for id in p.runtimeOrder + known + presetIds where (known.contains(id) || presetIds.contains(id)) && !out.contains(id) { out.append(id) }
        return out
    }

    private func backend(of id: String) -> String { presets.first { $0.id == id }?.backend ?? id }

    var body: some View {
        let p = app.prefs
        let order = entries(p)
        let slots = order.filter { !p.disabledRuntimes.contains(backend(of: $0)) }.prefix(9)
        VStack(alignment: .leading, spacing: 0) {
            GSectionHeading(title: "Runtimes",
                            description: "Choose which coding agents appear in runtime pickers and arrange them in your preferred order. The order also sets the ⌃1…⌃9 keyboard shortcuts: whoever is on top gets the first key, presets included.")
            VStack(spacing: 0) {
                ForEach(Array(order.enumerated()), id: \.element) { i, id in
                    row(id, slot: slots.firstIndex(of: id), p: p)
                        .overlay(alignment: .bottom) { if i < order.count - 1 { Rectangle().fill(Theme.border).frame(height: 1) } }
                        .padding(.bottom, i < order.count - 1 ? 1 : 0)
                        .background(Theme.card)
                        .shadow(color: .black.opacity(dragging == id ? 0.1 : 0), radius: 7.5, y: 10)
                        .offset(y: offset(id, i, order))
                        .zIndex(dragging == id ? 1 : 0)
                }
            }
            .padding(1)
            .background(RoundedRectangle(cornerRadius: 10).fill(Theme.card))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
            .padding(.top, 24)

            VStack(alignment: .leading, spacing: 0) {
                GSubheading(title: "Presets", description: "Pin a runtime to a fixed model and reasoning effort. Presets appear in runtime pickers alongside the runtimes above and never change what they launch.")
                GPresetForm { add($0) }.padding(.top, 12)
            }
            .padding(.top, 32)

            VStack(alignment: .leading, spacing: 0) {
                GSubheading(title: "Runtime behavior", description: "Shared execution settings for external CLI and ACP runtimes.")
                VStack(spacing: 0) {
                    GToggleRow(title: "CLI agents: skip permission prompts",
                               detail: "Let external runtimes run without approval prompts. Off = tool calls ask first through approval cards in the chat.",
                               isOn: p.bypassApprovals, testID: "toggle-bypass") { v in app.controller.setPrefs { $0.bypassApprovals = v } }
                    GToggleRow(title: "CLI agents: isolate in git worktrees",
                               detail: "Run each conversation on its own branch in a separate git worktree, so agents never touch your checked-out files. Off = agents edit the workspace directly, like running the CLI in a terminal. Conversations that already have a worktree keep it.",
                               isOn: isolateInWorktree, testID: "toggle-worktree") { isolateInWorktree = $0 }
                }
                .padding(.top, 8)
            }
            .padding(.top, 32)
        }
        .onAppear {
            for r in Runtimes.all { status[r.id] = RuntimeStatus.installed(r.id) }
            codexLoggedIn = RuntimeStatus.codexLoggedIn()
        }
    }

    /// dnd-kit's vertical list strategy: the dragged row follows the pointer, rows it passes slide by one slot.
    private func offset(_ id: String, _ i: Int, _ order: [String]) -> CGFloat {
        guard let d = dragging, let from = order.firstIndex(of: d) else { return 0 }
        if id == d { return dragY }
        let to = target(from, order.count)
        if from < to, i > from, i <= to { return -rowHeight }
        if from > to, i < from, i >= to { return rowHeight }
        return 0
    }

    private func target(_ from: Int, _ count: Int) -> Int {
        max(0, min(count - 1, from + Int((dragY / rowHeight).rounded())))
    }

    private func drag(_ id: String, _ order: [String]) -> some Gesture {
        DragGesture(minimumDistance: 5, coordinateSpace: .global)
            .onChanged { g in
                dragging = id
                dragY = g.translation.height
            }
            .onEnded { _ in
                if let from = order.firstIndex(of: id) {
                    let to = target(from, order.count)
                    if to != from {
                        var o = order
                        o.insert(o.remove(at: from), at: to)
                        app.controller.setPrefs { $0.runtimeOrder = o }
                    }
                }
                withAnimation(.easeOut(duration: 0.2)) { dragging = nil; dragY = 0 }
            }
    }

    @ViewBuilder
    private func row(_ id: String, slot: Int?, p: Prefs) -> some View {
        let preset = presets.first { $0.id == id }
        let rid = preset?.backend ?? id
        let r = Runtimes.byId(rid)
        HStack(spacing: 12) {
            GripHandle(id: id).gesture(drag(id, entries(p)))
            ZStack {
                RoundedRectangle(cornerRadius: 10).fill(Theme.runtimeColor(rid).opacity(0.1))
                RuntimeIcon(id: rid, size: 16)
            }
            .frame(width: 36, height: 36)
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    Text(preset?.label ?? r.label).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.foreground).lineBox(20.02)
                    if let slot { GSlotChip(text: Shortcuts.hint("runtime\(slot + 1)", p)).help("Keyboard shortcut for this position — reordering moves it") }
                    if preset != nil {
                        GBadge(text: "Preset")
                    } else if id == "pi" {
                        GBadge(text: "Always available")
                    } else if let installed = status[id] {
                        GBadge(text: installed ? "Installed" : "Not installed", fg: installed ? GTheme.emeraldText : Theme.mutedForeground,
                               bg: installed ? GTheme.emeraldFill : Theme.muted)
                    }
                    if id == "codex", status["codex"] == true, !codexLoggedIn {
                        GBadge(text: "Not signed in", fg: GTheme.amberText, bg: GTheme.amberFill)
                            .help("Codex is installed but has no credentials — run `codex login` in a terminal, or sessions will fail with a missing OPENAI_API_KEY error. Signing in to the Codex desktop app is not enough; the CLI keeps its own login.")
                    }
                }
                .frame(height: 21.4)
                Text(preset != nil ? r.label : Self.commands[id] ?? "")
                    .font(preset != nil ? .system(size: 12) : .system(size: 12, design: .monospaced))
                    .foregroundStyle(Theme.mutedForeground).lineLimit(1).truncationMode(.tail).lineBox(16.2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if preset != nil {
                GIconButton(icon: "trash-2", box: 32, glyph: 14, tip: "Delete preset", testID: "runtime-preset-delete-\(id)") { delete(id) }
            } else {
                GSwitch(isOn: !p.disabledRuntimes.contains(id), disabled: id == "pi", testID: "runtime-enabled-\(id)") { v in
                    app.controller.setPrefs { pr in
                        if v { pr.disabledRuntimes.removeAll { $0 == id } } else if !pr.disabledRuntimes.contains(id) { pr.disabledRuntimes.append(id) }
                    }
                }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .frame(height: 61.6)
        .testID("runtime-settings-row-\(id)")
    }

    private func add(_ preset: GRuntimePreset) {
        let order = entries(app.prefs)
        presets.append(preset)
        GRuntimePreset.save(presets)
        app.controller.setPrefs { $0.runtimeOrder = order + [preset.id] }
    }

    private func delete(_ id: String) {
        presets.removeAll { $0.id == id }
        GRuntimePreset.save(presets)
        app.controller.setPrefs { $0.runtimeOrder.removeAll { $0 == id } }
    }
}

private struct GripHandle: View {
    let id: String
    @State private var hover = false
    var body: some View {
        Glyph(name: "grip-vertical", size: 16, color: hover ? Theme.foreground : Theme.mutedForeground.opacity(0.6))
            .frame(width: 28, height: 28)
            .background(RoundedRectangle(cornerRadius: 8).fill(hover ? Theme.muted : .clear))
            .contentShape(Rectangle())
            .onHover { h in
                hover = h
                if h { NSCursor.openHand.push() } else { NSCursor.pop() }
            }
            .help("Drag to reorder")
            .testID("runtime-drag-\(id)")
    }
}

/// AddPresetForm: runtime / model / reasoning selects (size sm, text-xs) and "Add preset".
private struct GPresetForm: View {
    @Environment(AppState.self) private var app
    let onAdd: (GRuntimePreset) -> Void
    @State private var backend = "claude-code"
    @State private var model = ""
    @State private var effort = ""

    var body: some View {
        let r = Runtimes.byId(backend)
        let defaults = app.controller.cliDefaults[backend]
        let models = defaults?.catalog(r) ?? r.models
        let curModel = CliDefaults.resolve(model, models, defaults) ?? (model.isEmpty ? models.first : nil)
        let curEffort = r.efforts.first { $0.id == effort } ?? CliDefaults.resolveDefault(defaults?.effort, r.efforts)
        HStack(spacing: 8) {
            GSelect(id: "runtime-preset-backend", value: backend,
                    options: Runtimes.all.filter { Runtimes.tunable($0.id) }.map { GOption(id: $0.id, label: $0.label, icon: AnyView(RuntimeIcon(id: $0.id, size: 16))) },
                    width: 160, height: 32, fontSize: 12) { v in backend = v; model = ""; effort = ""; app.controller.loadCliDefaults(v) }
            GSelect(id: "runtime-preset-model", value: curModel?.id ?? "", options: models.map { GOption(id: $0.id, label: $0.label) },
                    width: 176, height: 32, fontSize: 12) { model = $0 }
            GSelect(id: "runtime-preset-effort", value: curEffort?.id ?? "", options: r.efforts.map { GOption(id: $0.id, label: $0.label) },
                    width: 128, height: 32, fontSize: 12) { effort = $0 }
            GButton(title: "Add preset", icon: "plus", gap: 4, testID: "runtime-preset-add") {
                onAdd(GRuntimePreset(id: "preset-\(UUID().uuidString.lowercased())", backend: backend, model: curModel?.id ?? "", effort: curEffort?.id ?? ""))
            }
        }
        .onAppear { app.controller.loadCliDefaults(backend) }
    }
}

// MARK: - Remote access

struct RemoteSettingsSection: View {
    @AppStorage("settings.remoteEnabled") private var enabled = false
    @AppStorage("settings.remoteKeepAwake") private var keepAwake = false
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            GSectionHeading(title: "Remote access", description: "Continue Cetus conversations securely from your phone through Tailscale.")
            HStack(spacing: 20) {
                HStack(alignment: .top, spacing: 12) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 10).fill(Theme.primary.opacity(0.1))
                        RoundedRectangle(cornerRadius: 11).strokeBorder(Theme.primary.opacity(0.2), lineWidth: 1).padding(-1)
                        Glyph(name: "cloud", size: 16, color: Theme.primary)
                    }
                    .frame(width: 36, height: 36)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Enable mobile companion").font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.foreground).lineBox(14)
                        GDetail(text: "Starts a localhost-only server and configures Tailscale Serve when available.", lineHeight: 19.5)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                GSwitch(isOn: enabled, testID: "toggle-remote") { enabled = $0 }
            }
            .padding(17)
            .background(RoundedRectangle(cornerRadius: 14).fill(Theme.card))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.border, lineWidth: 1))
            .padding(.top, 24)
            GToggleRow(title: "Keep this Mac awake for remote access",
                       detail: "While the mobile companion is on, hold off system sleep so your phone can always reach this Mac. The display still sleeps and locks.",
                       isOn: keepAwake) { keepAwake = $0 }
                .padding(.top, 8)
            GDetail(text: "Only conversation features are exposed. API keys, terminal control, local file browsing and Cetus settings stay on this Mac.", lineHeight: 19.5)
                .padding(.top, 16)
        }
    }
}

// MARK: - Appearance

struct GSkinSeeds: Codable, Equatable {
    var surface: String, ink: String, accent: String, diffAdded: String, diffRemoved: String, skill: String
    var contrast: Int
}

struct GSkinPreset {
    let id: String, name: String, light: GSkinSeeds, dark: GSkinSeeds

    static let all: [GSkinPreset] = {
        func s(_ surface: String, _ ink: String, _ accent: String, _ c: Int, _ a: String, _ r: String, _ k: String) -> GSkinSeeds {
            GSkinSeeds(surface: surface, ink: ink, accent: accent, diffAdded: a, diffRemoved: r, skill: k, contrast: c)
        }
        let cl = ("#00a240", "#ba2623", "#924ff7"), cd = ("#40c977", "#fa423e", "#ad7bf9")
        return [
            .init(id: "cetus", name: "Cetus", light: s("#fcfcfd", "#1b1b1b", "#827be6", 50, "#52a450", "#c94446", "#8160d8"),
                  dark: s("#0f0f11", "#e3e4e6", "#827be6", 50, "#69c967", "#ff7e78", "#c2a1ff")),
            .init(id: "codex", name: "Codex", light: s("#ffffff", "#1a1c1f", "#339cff", 50, cl.0, cl.1, cl.2),
                  dark: s("#181818", "#ffffff", "#339cff", 50, cd.0, cd.1, cd.2)),
            .init(id: "linear", name: "Linear", light: s("#fcfcfd", "#1b1b1b", "#5e6ad2", 45, "#52a450", "#c94446", "#8160d8"),
                  dark: s("#0f0f11", "#e3e4e6", "#606acc", 50, "#69c967", "#ff7e78", "#c2a1ff")),
            .init(id: "vercel", name: "Vercel", light: s("#ffffff", "#171717", "#006aff", 45, "#28a948", "#eb001d", "#a100f8"),
                  dark: s("#000000", "#ededed", "#006efe", 40, "#00ad3a", "#f13342", "#9540d5")),
            .init(id: "raycast", name: "Raycast", light: s("#ffffff", "#030303", "#ff6363", 50, cl.0, cl.1, cl.2),
                  dark: s("#101010", "#fefefe", "#ff6363", 50, cd.0, cd.1, cd.2)),
            .init(id: "xcode", name: "Xcode", light: s("#ffffff", "#000000", "#0e0eff", 50, cl.0, cl.1, cl.2),
                  dark: s("#1f1f24", "#dddde0", "#5482ff", 50, cd.0, cd.1, cd.2)),
            .init(id: "paper", name: "Paper", light: s("#f5f3ed", "#2a2622", "#b5573a", 55, "#4f8a3c", "#b8433a", "#7b5ea7"),
                  dark: s("#1c1a17", "#e8e2d6", "#d9825f", 55, "#8fc27a", "#ef8a7e", "#c4a6f0")),
            .init(id: "mono", name: "Mono", light: s("#ffffff", "#000000", "#000000", 60, "#2e7d32", "#c62828", "#555555"),
                  dark: s("#000000", "#ffffff", "#ffffff", 60, "#81c784", "#ef9a9a", "#bbbbbb")),
        ]
    }()

    static func byId(_ id: String) -> GSkinPreset { all.first { $0.id == id } ?? all[0] }
}

struct GSkinPreference: Codable, Equatable {
    var presetId: String
    var light: GSkinSeeds
    var dark: GSkinSeeds

    static func from(_ p: GSkinPreset) -> GSkinPreference { .init(presetId: p.id, light: p.light, dark: p.dark) }
    static func load() -> GSkinPreference {
        guard let d = UserDefaults.standard.data(forKey: "settings.skin"), let v = try? JSONDecoder().decode(GSkinPreference.self, from: d) else {
            return from(GSkinPreset.all[0])
        }
        return v
    }
    @MainActor func save() {
        UserDefaults.standard.set(try? JSONEncoder().encode(self), forKey: "settings.skin")
        Skin.apply(self)
    }
}

private func gHex(_ s: String) -> Color {
    let h = s.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
    return Color(nsColor: NSColor(hex: UInt32(h, radix: 16) ?? 0))
}

struct AppearanceSettingsSection: View {
    @Environment(AppState.self) private var app
    var body: some View {
        let p = app.prefs
        VStack(alignment: .leading, spacing: 0) {
            GSectionHeading(title: "Appearance", description: "Set the theme used across cetus. Changes apply instantly.")
            VStack(alignment: .leading, spacing: 20) {
                selectRow("Theme", "Follow the system appearance, or lock to light or dark.", id: "settings-theme", value: p.theme.rawValue,
                          options: [GOption(id: "system", label: "System"), GOption(id: "light", label: "Light"), GOption(id: "dark", label: "Dark")]) { v in
                    app.controller.setPrefs { $0.theme = ThemePreference(rawValue: v) ?? .system }
                }
                selectRow("Font size", "Base size for interface text; chat text and labels scale with it. Independent of ⌘+/⌘− window zoom.", id: "settings-font-size",
                          value: String(Int(p.fontSize)), options: (12 ... 16).map { GOption(id: String($0), label: $0 == 14 ? "14 px (default)" : "\($0) px") }) { v in
                    app.controller.setPrefs { $0.fontSize = Double(v) ?? 14 }
                }
                selectRow("Line height", "Spacing between lines of interface and chat text.", id: "settings-line-height",
                          value: lineId(p.lineScale), options: [("0.9", "Compact"), ("1", "Default"), ("1.1", "Relaxed"), ("1.2", "Loose")].map { GOption(id: $0.0, label: $0.1) }) { v in
                    app.controller.setPrefs { $0.lineScale = Double(v) ?? 1 }
                }
                GWallpaperSection()
                GSkinSection()
            }
            .padding(.top, 24)
        }
    }

    private func lineId(_ v: Double) -> String { [0.9: "0.9", 1.1: "1.1", 1.2: "1.2"][v] ?? "1" }

    private func selectRow(_ title: String, _ detail: String, id: String, value: String, options: [GOption], set: @escaping (String) -> Void) -> some View {
        HStack(spacing: 16) {
            GLabelBlock(title: title, detail: detail)
            GSelect(id: id, value: value, options: options, set: set)
        }
    }
}

private struct GWallpaperSection: View {
    @AppStorage("settings.wallpaper") private var path = ""
    @AppStorage("settings.wallpaperFade") private var fade = 60.0
    var body: some View {
        let image = path.isEmpty ? nil : NSImage(contentsOfFile: path)
        VStack(alignment: .leading, spacing: 12) {
            GLabelBlock(title: "Background image",
                        detail: "Choose a local image for the home and chat background. JPG, PNG or WebP, up to 20 MB. Images stay on this device.")
            if let image {
                ZStack {
                    Image(nsImage: image).resizable().aspectRatio(contentMode: .fill)
                    Theme.background.opacity(fade / 100)
                    Text("Chat background preview").font(.system(size: 12)).foregroundStyle(Theme.foreground)
                        .padding(.horizontal, 20).padding(.vertical, 12)
                        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.card))
                        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
                }
                .frame(maxWidth: .infinity).frame(height: 144)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
            }
            HStack(spacing: 8) {
                GButton(title: image == nil ? "Upload image" : "Replace image", icon: "image-plus", gap: 6, testID: "wallpaper-upload") { choose() }
                if image != nil { GButton(title: "Remove", icon: "trash-2", variant: .ghost, gap: 6) { path = "" } }
            }
            if image != nil {
                HStack(spacing: 12) {
                    Text("Fade background").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.foreground)
                    GRange(value: $fade, range: 0 ... 95, step: 5).frame(width: 160)
                    Text("\(Int(fade))%").font(.system(size: 12).monospacedDigit()).foregroundStyle(Theme.mutedForeground)
                }
            }
        }
    }

    private func choose() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.jpeg, .png, .webP]
        panel.canChooseDirectories = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let dir = Env.dataDir.appendingPathComponent("wallpaper", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = dir.appendingPathComponent("background.\(url.pathExtension.lowercased())")
        try? FileManager.default.removeItem(at: dest)
        if (try? FileManager.default.copyItem(at: url, to: dest)) != nil { path = dest.path }
    }
}

/// WebKit-style range input (`h-1.5 accent-primary`): primary-filled track and a white pill thumb.
private struct GRange: View {
    @Binding var value: Double
    let range: ClosedRange<Double>
    var step: Double = 1
    var body: some View {
        GeometryReader { g in
            let w = g.size.width
            let t = (value - range.lowerBound) / (range.upperBound - range.lowerBound)
            let thumbW: CGFloat = 21, thumbH: CGFloat = 13
            let x = CGFloat(t) * (w - thumbW)
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.input).frame(height: 6)
                Capsule().fill(Theme.primary).frame(width: x + thumbW / 2, height: 6)
                Capsule().fill(Color.white).frame(width: thumbW, height: thumbH)
                    .shadow(color: .black.opacity(0.25), radius: 1, y: 0.5)
                    .offset(x: x)
            }
            .frame(height: g.size.height)
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0).onChanged { d in
                let f = min(1, max(0, (d.location.x - thumbW / 2) / (w - thumbW)))
                let raw = range.lowerBound + Double(f) * (range.upperBound - range.lowerBound)
                value = (raw / step).rounded() * step
            })
        }
        .frame(height: 16)
    }
}

private struct GSkinSection: View {
    @Environment(\.colorScheme) private var scheme
    @State private var pref = GSkinPreference.load()
    @State private var variant: String?

    var body: some View {
        let v = variant ?? (scheme == .dark ? "dark" : "light")
        let base = GSkinPreset.byId(pref.presetId)
        let seeds = v == "dark" ? pref.dark : pref.light
        let dirty = seeds != (v == "dark" ? base.dark : base.light)
        VStack(alignment: .leading, spacing: 20) {
            GLabelBlock(title: "Skin", detail: "Pick a template, then fine-tune the handful of colors everything else derives from. Light and dark are set separately.")
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 8) {
                ForEach(GSkinPreset.all, id: \.id) { p in
                    presetCard(p, selected: pref.presetId == p.id, customized: pref.presetId == p.id && pref != GSkinPreference.from(p))
                }
            }
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    HStack(spacing: 4) {
                        ForEach(["light", "dark"], id: \.self) { k in
                            Button { variant = k } label: {
                                Text(k == "light" ? "Light" : "Dark").font(.system(size: 12, weight: .medium))
                                    .foregroundStyle(v == k ? Theme.foreground : Theme.mutedForeground).lineBox(16.2)
                                    .padding(.horizontal, 10).padding(.vertical, 4)
                                    .background(RoundedRectangle(cornerRadius: 4).fill(v == k ? Theme.background : .clear)
                                        .shadow(color: .black.opacity(v == k ? 0.1 : 0), radius: 1.5, y: 1))
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(2)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Theme.muted))
                    Spacer()
                    GButton(title: "Reset to \(base.name)", icon: "rotate-ccw", variant: .ghost, height: 28, fontSize: 12, gap: 6, disabled: !dirty) {
                        update(v) { $0 = v == "dark" ? base.dark : base.light }
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
                .padding(.bottom, 1)
                VStack(spacing: 12) {
                    let keys: [(String, WritableKeyPath<GSkinSeeds, String>)] = [("Surface", \.surface), ("Ink", \.ink), ("Accent", \.accent),
                                                                                 ("Diff added", \.diffAdded), ("Diff removed", \.diffRemoved), ("Skill", \.skill)]
                    ForEach(0 ..< 3, id: \.self) { r in
                        HStack(spacing: 24) {
                            ForEach(0 ..< 2, id: \.self) { c in
                                let k = keys[r * 2 + c]
                                GSeedRow(label: k.0, value: seeds[keyPath: k.1]) { hex in update(v) { $0[keyPath: k.1] = hex } }
                                    .id("\(v)-\(k.0)")
                            }
                        }
                    }
                    HStack(spacing: 12) {
                        Text("Contrast").font(.system(size: 12)).foregroundStyle(Theme.foreground).lineBox(16.2)
                        Spacer()
                        GRange(value: Binding(get: { Double(seeds.contrast) }, set: { n in update(v) { $0.contrast = Int(n) } }), range: 0 ... 100, step: 5)
                            .frame(width: 160)
                        Text("\(seeds.contrast)").font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.mutedForeground)
                            .frame(width: 32, alignment: .trailing).lineBox(16.2)
                    }
                }
                .padding(12)
            }
            .padding(1)
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
        }
    }

    private func update(_ v: String, _ f: (inout GSkinSeeds) -> Void) {
        if v == "dark" { f(&pref.dark) } else { f(&pref.light) }
        pref.save()
    }

    private func presetCard(_ p: GSkinPreset, selected: Bool, customized: Bool) -> some View {
        Button {
            pref = GSkinPreference.from(p)
            pref.save()
        } label: {
            VStack(spacing: 0) {
                HStack(spacing: 0) { swatch(p.light); swatch(p.dark) }.frame(height: 56)
                HStack(spacing: 8) {
                    (Text(p.name).font(.system(size: 12, weight: .medium)).foregroundColor(Theme.foreground)
                        + Text(customized ? " · customized" : "").font(.system(size: 12)).foregroundColor(Theme.mutedForeground))
                        .lineLimit(1).lineBox(16.2)
                    Spacer(minLength: 0)
                    if selected { Glyph(name: "check", size: 14, color: Theme.primary) }
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
                .overlay(alignment: .top) { Rectangle().fill(Theme.border).frame(height: 1) }
                .padding(.top, 1)
            }
            .padding(1)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(selected ? Theme.primary : Theme.border, lineWidth: 1))
            .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(selected ? Theme.primary : .clear, lineWidth: 1).padding(-1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .testID("skin-\(p.id)")
    }

    private func swatch(_ s: GSkinSeeds) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Aa").font(.system(size: 14, weight: .semibold)).foregroundStyle(gHex(s.ink)).lineBox(14)
            Spacer(minLength: 0)
            HStack(spacing: 4) {
                Circle().fill(gHex(s.accent)).frame(width: 12, height: 12)
                Circle().fill(gHex(s.diffAdded)).frame(width: 8, height: 8)
                Circle().fill(gHex(s.diffRemoved)).frame(width: 8, height: 8)
                Circle().fill(gHex(s.skill)).frame(width: 8, height: 8)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .background(gHex(s.surface))
    }
}

private struct GSeedRow: View {
    let label: String
    let value: String
    let onChange: (String) -> Void
    @State private var text = ""
    var body: some View {
        HStack(spacing: 12) {
            Text(label).font(.system(size: 12)).foregroundStyle(Theme.foreground).lineBox(16.2)
            Spacer(minLength: 0)
            HStack(spacing: 8) {
                Button { pickColor() } label: {
                    RoundedRectangle(cornerRadius: 8).fill(gHex(value))
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border, lineWidth: 1))
                        .frame(width: 24, height: 24)
                }
                .buttonStyle(.plain)
                GInput(placeholder: "", text: $text, width: 96, height: 28, mono: true) { commit() }
            }
        }
        .frame(maxWidth: .infinity)
        .onAppear { text = value }
        .onChange(of: value) { _, v in text = v }
    }

    private func commit() {
        let t = text.trimmingCharacters(in: .whitespaces).lowercased()
        let h = t.hasPrefix("#") ? t : "#\(t)"
        if h.range(of: "^#[0-9a-f]{6}$", options: .regularExpression) != nil { if h != value { onChange(h) } } else { text = value }
    }

    private func pickColor() {
        let panel = NSColorPanel.shared
        panel.color = NSColor(gHex(value))
        panel.showsAlpha = false
        GColorTarget.shared.onChange = { c in
            guard let c = c.usingColorSpace(.sRGB) else { return }
            onChange(String(format: "#%02x%02x%02x", Int(c.redComponent * 255), Int(c.greenComponent * 255), Int(c.blueComponent * 255)))
        }
        panel.setTarget(GColorTarget.shared)
        panel.setAction(#selector(GColorTarget.changed(_:)))
        panel.orderFront(nil)
    }
}

@MainActor
private final class GColorTarget: NSObject {
    static let shared = GColorTarget()
    var onChange: (NSColor) -> Void = { _ in }
    @objc func changed(_ sender: NSColorPanel) { onChange(sender.color) }
}

// MARK: - Keyboard shortcuts

struct GShortcutDef {
    let id: String, label: String, description: String, accelerator: String

    /// SHORTCUT_DEFINITIONS, in Cetus's order.
    static let all: [GShortcutDef] = {
        var s: [GShortcutDef] = [
            .init(id: "commandPalette", label: "Command palette", description: "Open or close the command palette", accelerator: "Cmd+K"),
            .init(id: "findInChat", label: "Find in conversation", description: "Search the open conversation and step through the matches", accelerator: "Cmd+F"),
            .init(id: "newChat", label: "New chat or task", description: "Start a task in the selected folder, or open a new chat without one", accelerator: "Cmd+N"),
            .init(id: "newDefaultChat", label: "New chat", description: "Start a repository-free chat, wherever you are", accelerator: "Alt+Cmd+N"),
            .init(id: "archiveChat", label: "Archive chat", description: "Archive the current chat", accelerator: "Cmd+D"),
            .init(id: "openSettings", label: "Open settings", description: "Open the settings page", accelerator: "Cmd+Comma"),
            .init(id: "switchChats", label: "Switch to chats", description: "Show the chat list", accelerator: "Alt+Cmd+1"),
            .init(id: "switchBoard", label: "Switch to Kanban", description: "Show the Kanban board", accelerator: "Alt+Cmd+2"),
            .init(id: "switchAutomations", label: "Switch to automations", description: "Show scheduled automations", accelerator: "Alt+Cmd+3"),
            .init(id: "switchPreviousView", label: "Switch between recent chats", description: "Tap to go back to the previous chat; hold the modifier to pick from recent chats", accelerator: "Ctrl+Tab"),
            .init(id: "navigateBack", label: "Go back", description: "Go back to the previous page (views and settings)", accelerator: "Cmd+BracketLeft"),
            .init(id: "navigateForward", label: "Go forward", description: "Go forward to the next page after going back", accelerator: "Cmd+BracketRight"),
        ]
        for i in 1 ... 9 { s.append(.init(id: "runtime\(i)", label: "Runtime \(i)", description: "Switch the current chat to runtime \(i) in Settings › Runtimes", accelerator: "Ctrl+\(i)")) }
        s += [
            .init(id: "toggleSidebar", label: "Toggle sidebar", description: "Collapse or expand the left sidebar", accelerator: "Cmd+B"),
            .init(id: "toggleWorkspace", label: "Toggle workspace", description: "Open or close the right workspace panel", accelerator: "Cmd+Backslash"),
            .init(id: "toggleTerminal", label: "Toggle terminal", description: "Open or focus the terminal tab", accelerator: "Cmd+J"),
            .init(id: "openBrowserTab", label: "Open browser tab", description: "Open or focus a browser tab in the workspace", accelerator: "Cmd+T"),
            .init(id: "openFilesTab", label: "Open files tab", description: "Open or focus the files tab in the workspace", accelerator: "Cmd+P"),
            .init(id: "closeWorkspaceTab", label: "Close workspace tab", description: "Close the active right workspace tab", accelerator: "Cmd+W"),
            .init(id: "previousWorkspaceTab", label: "Previous workspace tab", description: "Move to the previous right workspace tab", accelerator: "Cmd+Alt+ArrowLeft"),
            .init(id: "nextWorkspaceTab", label: "Next workspace tab", description: "Move to the next right workspace tab", accelerator: "Cmd+Alt+ArrowRight"),
            .init(id: "previousChat", label: "Previous chat", description: "Move to the previous chat in the sidebar", accelerator: "Cmd+Alt+ArrowUp"),
            .init(id: "nextChat", label: "Next chat", description: "Move to the next chat in the sidebar", accelerator: "Cmd+Alt+ArrowDown"),
            .init(id: "previousChatAlternate", label: "Previous chat (alternate)", description: "Move to the previous chat in the sidebar", accelerator: "Shift+Cmd+BracketLeft"),
            .init(id: "nextChatAlternate", label: "Next chat (alternate)", description: "Move to the next chat in the sidebar", accelerator: "Shift+Cmd+BracketRight"),
        ]
        for i in 1 ... 8 { s.append(.init(id: "chat\(i)", label: "Chat \(i)", description: "Open the chat in position \(i) of the sidebar", accelerator: "Cmd+\(i)")) }
        s.append(.init(id: "lastChat", label: "Last chat", description: "Open the last chat in the sidebar", accelerator: "Cmd+9"))
        return s
    }()

    static let keyLabels: [String: String] = [
        "ArrowUp": "↑", "ArrowDown": "↓", "ArrowLeft": "←", "ArrowRight": "→", "Enter": "⏎", "Space": "Space", "Tab": "⇥",
        "PageUp": "PgUp", "PageDown": "PgDn", "Backspace": "⌫", "Delete": "⌦", "Escape": "Esc", "Comma": ",", "Period": ".",
        "Slash": "/", "Semicolon": ";", "Quote": "'", "BracketLeft": "[", "BracketRight": "]", "Backslash": "\\",
        "Minus": "-", "Equal": "=", "Backquote": "`",
    ]

    /// shortcutChips: ["⌥", "⌘", "1"].
    static func chips(_ accel: String) -> [String] {
        guard !accel.isEmpty else { return [] }
        let mods = ["Ctrl": "⌃", "Alt": "⌥", "Shift": "⇧", "Cmd": "⌘"]
        return Shortcuts.normalize(accel).split(separator: "+").map { p in mods[String(p)] ?? keyLabels[String(p)] ?? String(p) }
    }
}

struct ShortcutsSettingsSection: View {
    @Environment(AppState.self) private var app
    @State private var query = ""
    @State private var recording: String?

    private func value(_ d: GShortcutDef, _ p: Prefs) -> String { p.shortcuts[d.id] ?? d.accelerator }

    var body: some View {
        let p = app.prefs
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let defs = GShortcutDef.all.filter { d in
            q.isEmpty || "\(d.label) \(d.description) \(GShortcutDef.chips(value(d, p)).joined())".lowercased().contains(q)
        }
        var byAccel: [String: [String]] = [:]
        for d in GShortcutDef.all where !value(d, p).isEmpty { byAccel[Shortcuts.normalize(value(d, p)), default: []].append(d.id) }
        let slots = runtimeSlots(p)
        return VStack(alignment: .leading, spacing: 0) {
            GSectionHeading(title: "Keyboard shortcuts",
                            description: "Customize app shortcuts used while Cetus is focused. Global shortcuts for the launcher and meetings stay in their own sections.")
            HStack(spacing: 8) {
                GInput(placeholder: "Search shortcuts", text: $query, width: 384, fill: Theme.background, testID: "shortcut-search")
                GButton(title: "Reset all", icon: "rotate-cw", gap: 6, testID: "shortcuts-reset-all") {
                    app.controller.setPrefs { $0.shortcuts = [:] }
                }
            }
            .padding(.top, 24)
            VStack(spacing: 0) {
                HStack(spacing: 0) {
                    Text("Command").frame(maxWidth: .infinity, alignment: .leading)
                    Text("Keybinding").frame(width: 288, alignment: .leading)
                }
                .font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.mutedForeground).lineBox(16.2)
                .padding(.horizontal, 16).padding(.vertical, 8)
                .background(Theme.muted.opacity(0.3))
                .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
                .padding(.bottom, 1)
                if defs.isEmpty {
                    Text("No shortcuts match your search.").font(.system(size: 14)).foregroundStyle(Theme.mutedForeground).lineBox(20.02)
                        .padding(.horizontal, 16).padding(.vertical, 24).frame(maxWidth: .infinity, alignment: .leading)
                }
                ForEach(Array(defs.enumerated()), id: \.element.id) { i, d in
                    let v = value(d, p)
                    let conflicts = (byAccel[Shortcuts.normalize(v)] ?? []).filter { $0 != d.id }
                    HStack(spacing: 16) {
                        VStack(alignment: .leading, spacing: 0) {
                            Text(d.label).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.foreground).lineLimit(1).lineBox(20.02)
                            Text(slotDescription(d.id, slots) ?? d.description).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
                                .lineLimit(1).truncationMode(.tail).lineBox(16.2)
                            if !v.isEmpty, !conflicts.isEmpty {
                                let names = conflicts.compactMap { c in GShortcutDef.all.first { $0.id == c }?.label }.joined(separator: ", ")
                                Text("Also assigned to \(names).").font(.system(size: 12)).foregroundStyle(Theme.destructive).lineBox(16.2).padding(.top, 4)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        HStack(spacing: 6) {
                            recorder(d, v)
                            GIconButton(icon: "rotate-cw", box: 32, glyph: 14, tip: "Reset to default", disabled: v == d.accelerator, testID: "shortcut-reset-\(d.id)") {
                                app.controller.setPrefs { $0.shortcuts.removeValue(forKey: d.id) }
                            }
                        }
                        .frame(width: 288, alignment: .trailing)
                    }
                    .padding(.horizontal, 16).padding(.vertical, 12)
                    .overlay(alignment: .bottom) { if i < defs.count - 1 { Rectangle().fill(Theme.border).frame(height: 1) } }
                    .padding(.bottom, i < defs.count - 1 ? 1 : 0)
                }
            }
            .padding(1)
            .background(RoundedRectangle(cornerRadius: 10).fill(Theme.background))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
            .padding(.top, 16)
        }
        .onDisappear { if recording != nil { stop() } }
    }

    private func runtimeSlots(_ p: Prefs) -> [String] {
        let presets = GRuntimePreset.load()
        let known = Runtimes.all.map(\.id)
        var order: [String] = []
        for id in p.runtimeOrder + known + presets.map(\.id) where (known.contains(id) || presets.contains { $0.id == id }) && !order.contains(id) { order.append(id) }
        return Array(order.filter { id in !p.disabledRuntimes.contains(presets.first { $0.id == id }?.backend ?? id) }.prefix(9))
            .map { id in presets.first { $0.id == id }?.label ?? Runtimes.byId(id).label }
    }

    private func slotDescription(_ id: String, _ slots: [String]) -> String? {
        guard id.hasPrefix("runtime"), let n = Int(id.dropFirst(7)) else { return nil }
        return n <= slots.count ? "Currently \(slots[n - 1])." : "Empty — enable more runtimes in Settings › Runtimes."
    }

    @ViewBuilder
    private func recorder(_ d: GShortcutDef, _ v: String) -> some View {
        let rec = recording == d.id
        let chips = GShortcutDef.chips(v)
        HStack(spacing: 6) {
            Button { rec ? stop() : start(d.id) } label: {
                HStack(spacing: 4) {
                    if rec {
                        Text("Press keys…").foregroundStyle(Theme.mutedForeground)
                    } else if chips.isEmpty {
                        Text("Unassigned").foregroundStyle(Theme.mutedForeground)
                    } else {
                        ForEach(Array(chips.enumerated()), id: \.offset) { _, c in
                            Text(c).foregroundStyle(Theme.foreground).lineBox(12)
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(RoundedRectangle(cornerRadius: 4).fill(Theme.background)
                                    .shadow(color: .black.opacity(0.1), radius: 1.5, y: 1)
                                    .shadow(color: .black.opacity(0.1), radius: 1, y: 1))
                        }
                    }
                }
                .font(.system(size: 12, weight: .medium))
                .padding(.horizontal, 11)
                .frame(minWidth: 112).frame(height: 32)
                .background(RoundedRectangle(cornerRadius: 8).fill(rec ? Theme.primary.opacity(0.1) : Theme.muted))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(rec ? Theme.primary : Theme.border, lineWidth: 1))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .testID("shortcut-\(d.id)")
            if !v.isEmpty, !rec {
                GIconButton(icon: "x", box: 28, glyph: 14, tip: "Clear shortcut", testID: "shortcut-clear-\(d.id)") {
                    app.controller.setPrefs { $0.shortcuts[d.id] = "" }
                }
            }
        }
    }

    private func start(_ id: String) {
        recording = id
        app.recorder = { event in
            guard event.type == .keyDown else { return false }
            if event.keyCode == 53 { stop(); return true }
            let f = event.modifierFlags
            guard !f.isDisjoint(with: [.command, .control, .option]), let accel = Shortcuts.accelerator(for: event) else { return true }
            let def = GShortcutDef.all.first { $0.id == id }?.accelerator ?? ""
            app.controller.setPrefs { p in
                if Shortcuts.normalize(accel) == Shortcuts.normalize(def) { p.shortcuts.removeValue(forKey: id) } else { p.shortcuts[id] = accel }
            }
            stop()
            return true
        }
    }

    private func stop() {
        recording = nil
        app.recorder = nil
    }
}

// MARK: - Notifications

struct NotificationsSettingsSection: View {
    @Environment(AppState.self) private var app
    @AppStorage("settings.notifyMeeting") private var meeting = true
    var body: some View {
        let n = app.prefs.notifications
        VStack(alignment: .leading, spacing: 0) {
            GSectionHeading(title: "Notifications",
                            description: "Get a desktop notification when a background task finishes or needs you — handy for long agent runs on the board.")
            GToggleRow(title: "Enable notifications", detail: "Master switch for all desktop notifications.", isOn: n.enabled, testID: "toggle-notif-enabled") { v in
                app.controller.setPrefs { $0.notifications.enabled = v }
                if v { GPermissions.request("notifications") { _ in } }
            }
            .padding(.top, 24)
            group("Notify me about", enabled: n.enabled) {
                GToggleRow(title: "Task finished", detail: "An agent run finished — a chat reply, a board task, or a scheduled automation (whether it succeeded or errored).",
                           isOn: n.taskFinished, boxed: true, disabled: !n.enabled) { v in app.controller.setPrefs { $0.notifications.taskFinished = v } }
                RowLine()
                GToggleRow(title: "Needs your input", detail: "The agent is waiting for you to answer a prompt.",
                           isOn: n.awaitingInput, boxed: true, disabled: !n.enabled) { v in app.controller.setPrefs { $0.notifications.awaitingInput = v } }
                RowLine()
                GToggleRow(title: "Meeting capture", detail: "Transcription started, and the notes are ready afterwards.",
                           isOn: meeting, boxed: true, disabled: !n.enabled) { meeting = $0 }
            }
            group("Behavior", enabled: n.enabled) {
                GToggleRow(title: "Mute while Cetus is focused", detail: "Only notify when the window is in the background.",
                           isOn: n.muteWhenFocused, boxed: true, disabled: !n.enabled) { v in app.controller.setPrefs { $0.notifications.muteWhenFocused = v } }
            }
        }
    }

    private func group<C: View>(_ title: String, enabled: Bool, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.mutedForeground).lineBox(16.2)
            VStack(spacing: 0) { content() }
                .padding(1)
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
                // The rows dim individually (disabled switches) and the whole box at 50%, as `opacity-50` on the wrapper.
                .compositingGroup()
                .opacity(enabled ? 1 : 0.5)
                .allowsHitTesting(enabled)
        }
        .padding(.top, 24)
    }
}

private struct RowLine: View {
    var body: some View { Rectangle().fill(Theme.border).frame(height: 1) }
}

// MARK: - Permissions

@MainActor
enum GPermissions {
    struct Meta { let id: String, icon: String, label: String, detail: String, canOpenSettings: Bool }
    static let all: [Meta] = [
        .init(id: "notifications", icon: "bell", label: "Notifications", detail: "Alerts when a task finishes, needs your input, or a meeting is captured.", canOpenSettings: false),
        .init(id: "accessibility", icon: "accessibility", label: "Accessibility", detail: "Global hotkeys, the quick launcher, and typing dictated or agent text into other apps.", canOpenSettings: true),
        .init(id: "screen", icon: "monitor", label: "Screen Recording", detail: "Screenshot launcher and screen-context memory (capturing what's on screen).", canOpenSettings: true),
        .init(id: "microphone", icon: "mic", label: "Microphone", detail: "Voice dictation and meeting transcription.", canOpenSettings: true),
        .init(id: "fullDisk", icon: "hard-drive", label: "Full Disk Access",
              detail: "Lets agents read files inside other apps' folders (Mail, WeChat, Notes…) without macOS asking \"access data from other apps\" every time.", canOpenSettings: false),
    ]

    private static var bundled: Bool { Bundle.main.bundleIdentifier != nil }
    private static func hasUsage(_ key: String) -> Bool { Bundle.main.object(forInfoDictionaryKey: key) != nil }

    static func check(_ id: String, _ done: @escaping @MainActor (Bool) -> Void) {
        switch id {
        case "notifications":
            guard bundled else { done(false); return }
            UNUserNotificationCenter.current().getNotificationSettings { s in
                let ok = s.authorizationStatus == .authorized || s.authorizationStatus == .provisional
                Task { @MainActor in done(ok) }
            }
        case "accessibility": done(AXIsProcessTrusted())
        case "screen": done(CGPreflightScreenCaptureAccess())
        case "microphone": done(AVCaptureDevice.authorizationStatus(for: .audio) == .authorized && SFSpeechRecognizer.authorizationStatus() == .authorized)
        case "fullDisk": done(FileHandle(forReadingAtPath: "\(Env.home)/Library/Application Support/com.apple.TCC/TCC.db") != nil)
        default: done(false)
        }
    }

    static func request(_ id: String, _ done: @escaping @MainActor (Bool) -> Void) {
        switch id {
        case "notifications":
            guard bundled else { done(false); return }
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { ok, _ in Task { @MainActor in done(ok) } }
        case "accessibility":
            done(AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary))
        case "screen": done(CGRequestScreenCaptureAccess())
        case "microphone":
            // Prompting without usage strings would abort the process; fall back to System Settings.
            guard hasUsage("NSMicrophoneUsageDescription"), hasUsage("NSSpeechRecognitionUsageDescription") else { openSettings(id); check(id, done); return }
            AVCaptureDevice.requestAccess(for: .audio) { _ in
                SFSpeechRecognizer.requestAuthorization { _ in Task { @MainActor in check(id, done) } }
            }
        case "fullDisk": openSettings(id); check(id, done)
        default: done(false)
        }
    }

    static func openSettings(_ id: String) {
        let pane = ["accessibility": "Privacy_Accessibility", "screen": "Privacy_ScreenCapture", "microphone": "Privacy_Microphone", "fullDisk": "Privacy_AllFiles"][id] ?? ""
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") { NSWorkspace.shared.open(url) }
    }
}

struct PermissionsSettingsSection: View {
    @State private var status: [String: Bool] = [:]
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            GSectionHeading(title: "Permissions",
                            description: "What cetus can access on this Mac, and what each unlocks. Grant only what you need — every feature works without the others.")
            VStack(spacing: 0) {
                ForEach(Array(GPermissions.all.enumerated()), id: \.element.id) { i, m in
                    GPermissionRow(meta: m, status: status[m.id]) { status[m.id] = $0 }
                        .overlay(alignment: .bottom) { if i < GPermissions.all.count - 1 { RowLine() } }
                        .padding(.bottom, i < GPermissions.all.count - 1 ? 1 : 0)
                }
            }
            .padding(1)
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
            .padding(.top, 24)
            GDetail(text: "macOS may ask you to quit and reopen cetus after granting a permission for it to take effect.").padding(.top, 12)
            GButton(title: "Re-check", icon: "rotate-cw", gap: 6, testID: "permissions-recheck") { reload() }.padding(.top, 16)
        }
        .onAppear { reload() }
    }

    private func reload() {
        for m in GPermissions.all { GPermissions.check(m.id) { status[m.id] = $0 } }
    }
}

struct GPermissionRow: View {
    let meta: GPermissions.Meta
    let status: Bool?
    let changed: (Bool) -> Void
    @State private var busy = false
    var body: some View {
        let granted = status == true
        HStack(spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Glyph(name: meta.icon, size: 16, color: granted ? Theme.success : Theme.mutedForeground)
                    .frame(width: 32, height: 32)
                    .background(RoundedRectangle(cornerRadius: 8).fill(granted ? Theme.success.opacity(0.1) : Theme.muted))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(granted ? Theme.success.opacity(0.3) : Theme.border, lineWidth: 1))
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(meta.label).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.foreground).lineBox(20.02)
                    GDetail(text: meta.detail)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 8) {
                if granted {
                    HStack(spacing: 4) {
                        Glyph(name: "check", size: 14, color: Theme.success)
                        Text("Granted").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.success).lineBox(16.2)
                    }
                } else {
                    if status == false { Text("Needed").font(.system(size: 12)).foregroundStyle(Theme.warning).lineBox(16.2) }
                    GButton(title: "Grant", variant: .primary, disabled: busy, testID: "permission-grant-\(meta.id)") {
                        busy = true
                        GPermissions.request(meta.id) { ok in busy = false; changed(ok) }
                    }
                    if meta.canOpenSettings {
                        GButton(title: "Open Settings", testID: "permission-open-\(meta.id)") { GPermissions.openSettings(meta.id) }
                    }
                }
            }
            .fixedSize()
        }
        .padding(12)
    }
}
