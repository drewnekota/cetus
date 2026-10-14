import AppKit
import SwiftTerm
import SwiftUI

/// A workspace dock (side or bottom) with its own tabs, after Cetus's
/// workspace-panel.tsx. Terminal views are owned by `Terminals`, so shells keep
/// running while the dock or the tab is hidden.
struct WorkspacePanel: View {
    @Environment(AppState.self) private var app
    let layout: WorkspaceState.Layout
    @State private var plusFrame: CGRect = .zero

    var body: some View {
        let ws = app.dock(layout)
        let active = ws.tabs.first { $0.id == ws.active } ?? ws.tabs.first
        VStack(spacing: 0) {
            // `flex h-10 items-center gap-1 border-b px-2`
            HStack(spacing: 4) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 4) {
                        ForEach(ws.tabs) { tab in TabChip(layout: layout, tab: tab, active: tab.id == active?.id) }
                    }
                }
                .fixedSize(horizontal: true, vertical: false)
                GhostIconButton(icon: "plus", color: Theme.foreground, testID: "workspace-new-tab") { openNewTabMenu() }
                    .help("New Terminal tab")
                    .readFrame($plusFrame)
                    // Its wrapper div is 25px tall (inline line box), so the button sits 0.5px high.
                    .offset(y: -0.5)
                Spacer(minLength: 0)
                GhostIconButton(icon: "x", color: Theme.foreground, testID: "workspace-hide-panel") {
                    app.updateDock(layout) { $0.open = false }
                    app.focusComposer()
                }
                .help("Hide panel")
            }
            .padding(.horizontal, 8)
            .frame(height: 39)
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1).offset(y: 1) }
            .padding(.bottom, 1)
            ZStack {
                ForEach(ws.tabs) { tab in
                    let on = tab.id == active?.id
                    Group {
                        switch tab.kind {
                        case .terminal: TerminalTab(tab: tab, focused: on && ws.open)
                        case .files: WorkspaceFilesPanel(root: tab.cwd, testPrefix: "workspace-\(tab.id)", visible: on && ws.open)
                        case .browser: WorkspaceBrowserView(tab: tab, layout: layout, visible: on && ws.open)
                        }
                    }
                    .opacity(on ? 1 : 0)
                    .allowsHitTesting(on)
                }
                if ws.tabs.isEmpty { emptyPanel }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .clipped()
        }
        .background(Theme.background)
        .testID("workspace-panel-\(layout.rawValue)")
    }

    /// Hover/click menu under the plus: `w-36 rounded-md p-1 shadow-md ring-1`.
    private func openNewTabMenu() {
        let id = "workspace-new-tab-\(layout.rawValue)"
        if app.popup?.id == id { app.popup = nil; return }
        let rows: [(String, String, String, TabKind?, String)] = [
            ("terminal", "Terminal", Shortcuts.hint("toggleTerminal", app.prefs), .terminal, "workspace-new-terminal"),
            ("globe", "Browser", Shortcuts.hint("openBrowserTab", app.prefs), .browser, "workspace-new-browser"),
            ("folder", "Files", Shortcuts.hint("openFilesTab", app.prefs), .files, "workspace-new-files"),
        ]
        let content = VStack(spacing: 0) {
            ForEach(rows, id: \.1) { r in
                WorkspaceNewTabRow(icon: r.0, label: r.1, shortcut: r.2) {
                    app.popup = nil
                    if let kind = r.3 { app.addTab(layout, kind) }
                }
                .testID(r.4)
            }
        }
        .padding(4)
        .frame(width: 144)
        // `top-full mt-1` of a 25px-tall wrapper: the menu starts 5px under the 24px button.
        app.popup = PopupSpec(id: id, anchor: CGRect(x: plusFrame.minX, y: plusFrame.minY - 0.5, width: plusFrame.width, height: plusFrame.height + 1.5),
                              style: .dropdown, content: AnyView(content))
    }

    /// `EmptyPanel`: plus tile and three outline buttons.
    private var emptyPanel: some View {
        VStack(spacing: 16) {
            Glyph(name: "plus", size: 20, color: Theme.mutedForeground)
                .frame(width: 48, height: 48)
                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.muted.opacity(0.4)))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border, lineWidth: 1))
            HStack(spacing: 8) {
                emptyButton("folder", "Files") { app.addTab(layout, .files) }.testID("workspace-empty-Files")
                emptyButton("terminal", "Terminal") { app.addTab(layout, .terminal) }.testID("workspace-empty-Terminal")
                emptyButton("globe", "Browser") { app.addTab(layout, .browser) }.testID("workspace-empty-Browser")
            }
        }
        .padding(.horizontal, 24)
    }

    private func emptyButton(_ icon: String, _ label: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) { Glyph(name: icon, size: 14, color: Theme.foreground); Text(label).lineBox(20.02) }
        }
        .buttonStyle(WorkspaceOutlineButtonStyle())
    }
}

/// shadcn `Button size="sm" variant="outline"` (dark: border-input, bg-input/30, hover bg-input/50).
struct WorkspaceOutlineButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { StyledBody(configuration: configuration) }
    private struct StyledBody: View {
        let configuration: Configuration
        @Environment(\.colorScheme) private var scheme
        @State private var hover = false
        var body: some View {
            let dark = scheme == .dark
            configuration.label
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Theme.foreground)
                .padding(.horizontal, 11)
                .frame(height: 32)
                .background(RoundedRectangle(cornerRadius: 9).fill(dark ? Theme.input.opacity(hover ? 0.5 : 0.3) : hover ? Theme.muted : Theme.background).padding(1))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(dark ? Theme.input : Theme.border, lineWidth: 1))
                .shadow(color: .black.opacity(0.05), radius: 1, y: 1)
                .offset(y: configuration.isPressed ? 1 : 0)
                .contentShape(Rectangle())
                .onHover { hover = $0 }
        }
    }
}

/// `NewTabMenuItem`: h-8 gap-2 rounded-sm px-2 text-xs, muted 14px icon, compact Kbd.
private struct WorkspaceNewTabRow: View {
    let icon: String
    let label: String
    let shortcut: String
    let action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Glyph(name: icon, size: 14, color: Theme.mutedForeground)
                Text(label).font(.system(size: 12)).foregroundStyle(Theme.foreground).lineLimit(1).lineBox(16.2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                WorkspaceKbd(text: shortcut)
            }
            .padding(.horizontal, 8)
            .frame(height: 32)
            .background(RoundedRectangle(cornerRadius: 6).fill(hover ? Theme.accent : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

/// `Kbd className="h-3.5 px-0.5 text-2xs"`.
struct WorkspaceKbd: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.system(size: 11))
            .tracking(0.275)
            .foregroundStyle(Theme.mutedForeground.opacity(0.8))
            .padding(.horizontal, 3)
            .frame(height: 14)
            .background(RoundedRectangle(cornerRadius: 4).fill(Theme.muted.opacity(0.4)))
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Theme.border.opacity(0.5), lineWidth: 1))
    }
}

/// `h-7 max-w-36 rounded-md text-xs`: muted fill when active, muted/70 on hover.
private struct TabChip: View {
    @Environment(AppState.self) private var app
    let layout: WorkspaceState.Layout
    let tab: WorkspaceTab
    let active: Bool
    @State private var hover = false
    @State private var closeHover = false

    var body: some View {
        let fg = active || hover ? Theme.foreground : Theme.mutedForeground
        let title = tab.title ?? tab.kind.rawValue
        HStack(spacing: 0) {
            HStack(spacing: 6) {
                Glyph(name: tab.kind == .terminal ? "terminal" : tab.kind == .browser ? "globe" : "folder", size: 14, color: fg)
                Text(title).font(.system(size: 12)).lineLimit(1).truncationMode(.tail)
                    .foregroundStyle(fg).lineBox(16.2)
            }
            .padding(.horizontal, 8)
            Button { app.closeTab(layout, tab.id); WorkspaceBrowsers.close(tab.id) } label: {
                Glyph(name: "x", size: 12, color: fg)
                    .frame(width: 16, height: 16)
                    .background(RoundedRectangle(cornerRadius: 4).fill(closeHover ? Theme.background : .clear))
                    .compositingGroup()
                    .opacity(closeHover ? 1 : 0.6)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { closeHover = $0 }
            .help("Close \(title)")
            .padding(.trailing, 4)
            .testID("workspace-tab-close-\(tab.id)")
        }
        .frame(maxWidth: 144)
        .frame(height: 28)
        .background(RoundedRectangle(cornerRadius: 8).fill(active ? Theme.muted : hover ? Theme.muted.opacity(0.7) : .clear))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture {
            app.updateDock(layout) { $0.active = tab.id; $0.open = true }
            if tab.kind == .terminal { app.focusTerminal(layout) }
        }
        .help(title)
        .testID("workspace-tab-\(tab.kind.rawValue.lowercased())-\(tab.id)")
    }
}

/// Owns terminal views by tab id so shells survive hiding.
@MainActor @Observable
final class Terminals {
    static let shared = Terminals()
    @ObservationIgnored private var views: [Int: LocalProcessTerminalView] = [:]
    @ObservationIgnored private var delegates: [Int: TerminalDelegate] = [:]
    var titles: [Int: String] = [:]

    func view(for tab: WorkspaceTab) -> LocalProcessTerminalView {
        if let v = views[tab.id] { return v }
        let v = LocalProcessTerminalView(frame: NSRect(x: 0, y: 0, width: 600, height: 300))
        let font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        v.font = font
        // xterm: fontSize 12, lineHeight 1.2 over a 15px char box => 18px rows.
        v.lineSpacing = (18 - 0.001) / (font.ascender - font.descender + font.leading)
        Self.applyTheme(v, dark: NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua)
        let d = TerminalDelegate { [weak self] title in self?.titles[tab.id] = title }
        v.processDelegate = d
        delegates[tab.id] = d
        let shell = Env.shell["SHELL"] ?? "/bin/zsh"
        var env = Env.shell
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["TERM_PROGRAM"] = "Cetus"
        let envList = env.map { "\($0.key)=\($0.value)" }
        v.startProcess(executable: shell, args: ["-l"], environment: envList, execName: "-" + (shell as NSString).lastPathComponent, currentDirectory: tab.cwd)
        views[tab.id] = v
        return v
    }

    /// terminal-panel.tsx `terminalTheme()`: the live skin's surface and ink, so
    /// a custom skin carries into the terminal instead of the stock hexes.
    static func applyTheme(_ v: LocalProcessTerminalView, dark: Bool) {
        let seeds = Skin.seeds(dark: dark)
        let bg = seeds.map { Skin.color($0.surface) } ?? NSColor(hex: dark ? 0x0F0F11 : 0xFCFCFD)
        let fg = seeds.map { Skin.color($0.ink) } ?? NSColor(hex: dark ? 0xE3E4E6 : 0x1B1B1B)
        guard v.nativeBackgroundColor != bg || v.nativeForegroundColor != fg else { return }
        v.nativeBackgroundColor = bg
        v.nativeForegroundColor = fg
        v.caretColor = fg
        v.selectedTextBackgroundColor = NSColor(hex: dark ? 0x3F3C70 : 0xDCD9FA)
        v.needsDisplay = true
    }

    /// Re-theme every open terminal (skin or light/dark switch).
    func retheme(dark: Bool? = nil) {
        let d = dark ?? (NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua)
        for v in views.values { Self.applyTheme(v, dark: d) }
    }

    func close(_ id: Int) {
        if let v = views.removeValue(forKey: id) { v.terminate() }
        delegates.removeValue(forKey: id)
        titles.removeValue(forKey: id)
    }

    func existing(_ id: Int) -> LocalProcessTerminalView? { views[id] }
}

final class TerminalDelegate: NSObject, LocalProcessTerminalViewDelegate {
    let onTitle: (String) -> Void
    init(onTitle: @escaping (String) -> Void) { self.onTitle = onTitle }
    func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}
    func setTerminalTitle(source: LocalProcessTerminalView, title: String) { DispatchQueue.main.async { self.onTitle(title) } }
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func processTerminated(source: TerminalView, exitCode: Int32?) {}
}

private struct TerminalTab: View {
    let tab: WorkspaceTab
    let focused: Bool
    var body: some View {
        // `h-full w-full bg-background px-2 py-1` (the insets live in TerminalHost's constraints).
        TerminalHost(tab: tab, focused: focused)
            .testID("workspace-terminal-\(tab.id)")
    }
}

private struct TerminalHost: NSViewRepresentable {
    let tab: WorkspaceTab
    let focused: Bool
    @Environment(\.colorScheme) private var scheme

    func makeNSView(context: Context) -> NSView {
        let container = NSView()
        Self.attach(Terminals.shared.view(for: tab), to: container)
        return container
    }

    private static func attach(_ term: NSView, to container: NSView) {
        term.removeFromSuperview()
        term.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(term)
        NSLayoutConstraint.activate([
            term.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 8),
            term.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -8),
            term.topAnchor.constraint(equalTo: container.topAnchor, constant: 4),
            term.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -4),
        ])
    }

    func updateNSView(_ container: NSView, context: Context) {
        guard let term = Terminals.shared.existing(tab.id) else { return }
        if term.superview !== container { Self.attach(term, to: container) }
        Terminals.applyTheme(term, dark: scheme == .dark)
        if focused, context.coordinator.lastFocused != true {
            DispatchQueue.main.async { term.window?.makeFirstResponder(term) }
        }
        context.coordinator.lastFocused = focused
    }

    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator { var lastFocused: Bool? }
}


/// The bottom dock: `h-[32vh] max-h-[80vh] min-h-56 border-t`, or the height the
/// user dragged to (persisted like `cetus:workspace-bottom-height`), with the
/// 8px resize strip straddling the top border (double-click resets).
struct WorkspaceBottomDock: View {
    @AppStorage("settings.workspaceBottomHeight") private var stored: Double = 0
    @Environment(\.windowHeight) private var vh
    @State private var hover = false
    @State private var dragFrom: CGFloat?

    static let minHeight: CGFloat = 224

    private var maxHeight: CGFloat { max(Self.minHeight, (vh * 0.8).rounded()) }
    private var height: CGFloat {
        stored > 0 ? min(maxHeight, max(Self.minHeight, CGFloat(stored)))
            : max(Self.minHeight, min(vh * 0.32, vh * 0.8))
    }

    var body: some View {
        let h = height
        WorkspacePanel(layout: .bottom)
            .padding(.top, 1)
            .frame(height: h)
            .overlay(alignment: .top) { Rectangle().fill(Theme.border).frame(height: 1) }
            .overlay(alignment: .top) {
                // `absolute inset-x-0 -top-1 h-2`, its `h-0.5` bar at top-1: primary/40 on hover, /60 while dragging.
                Color.clear
                    .frame(height: 8)
                    .overlay(alignment: .top) {
                        Rectangle().fill(dragFrom != nil ? Theme.primary.opacity(0.6) : hover ? Theme.primary.opacity(0.4) : .clear)
                            .frame(height: 2).offset(y: 4)
                    }
                    .contentShape(Rectangle())
                    .offset(y: -4)
                    .onHover { inside in
                        hover = inside
                        if inside { NSCursor.resizeUpDown.push() } else { NSCursor.pop() }
                    }
                    .onTapGesture(count: 2) { stored = 0; dragFrom = nil }
                    .gesture(DragGesture(minimumDistance: 1, coordinateSpace: .global)
                        .onChanged { g in
                            if dragFrom == nil { dragFrom = h }
                            stored = Double(min(maxHeight, max(Self.minHeight, ((dragFrom ?? h) - g.translation.height).rounded())))
                        }
                        .onEnded { _ in dragFrom = nil })
                    .accessibilityLabel("Resize panel")
                    .testID("workspace-resize-handle")
            }
    }
}

/// `workspaceDocksByChat`: each conversation (or the new-chat page) has its own
/// side and bottom docks; switching chats swaps them in and out of AppState.
enum WorkspaceDocks {
    static let newChatKey = "__new_chat__"
    nonisolated(unsafe) static var byChat: [String: (side: WorkspaceState, bottom: WorkspaceState)] = [:]

    static func swap(_ app: AppState, from: String?, to: String?) {
        byChat[from ?? newChatKey] = (app.side, app.bottom)
        let next = byChat[to ?? newChatKey] ?? (WorkspaceState(layout: .side), WorkspaceState(layout: .bottom))
        app.side = next.side
        app.bottom = next.bottom
    }
}
