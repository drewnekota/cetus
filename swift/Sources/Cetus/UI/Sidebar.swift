import AppKit
import SwiftUI

/// Sidebar, after Cetus's app-sidebar / workspace-groups / conversation-row.
struct SidebarView: View {
    @Environment(AppState.self) private var app
    @State private var renaming: String?
    @State private var showResources = false
    @State private var reorder = WorkspaceReorder()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if app.page == .kanban { KanbanSidebarGroup() } else { groups }
                }
                .coordinateSpace(.named(WorkspaceReorder.space))
            }
            .scrollIndicators(.automatic)
            footer
        }
        .frame(maxHeight: .infinity)
        .background(Theme.sidebar)
    }

    /// Decoded once (it was read from disk on every sidebar render).
    static let icon = Theme.resource("icon-20@2x.png").flatMap { NSImage(contentsOf: $0) }

    // MARK: Header: drag spacer, brand row, Chats/Kanban, nav rows

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Color.clear.frame(height: 24)
            HStack(spacing: 4) {
                // Pre-downsampled (Lanczos) like WebKit's high-quality image scaling.
                if let icon = SidebarView.icon {
                    Image(nsImage: icon).resizable().interpolation(.high).frame(width: 20, height: 20)
                        .clipShape(RoundedRectangle(cornerRadius: 5))
                }
                Wordmark(text: "Cetus").offset(y: 1)
                Spacer(minLength: 0)
                SidebarCollapseButton()
            }
            .padding(6)
            .frame(height: 32)
            ViewToggle()
            VStack(spacing: 4) {
                MenuRow(icon: "clock", title: "Automations", kbd: Shortcuts.hint("switchAutomations", app.prefs), active: app.page == .automations, testID: "nav-automations") {
                    app.setView(ViewState(page: .automations, active: app.active))
                }
                MenuRow(icon: "plus-circle", title: "New task", kbd: Shortcuts.hint("newChat", app.prefs), active: false, testID: "new-chat") { if app.page == .chats { app.newChat() } else { NewTaskDialog.present(app) } }
                    .tip("New chat", kbd: Shortcuts.hint("newDefaultChat", app.prefs), side: .right)
            }
        }
        .padding(8)
    }

    // MARK: Groups

    @ViewBuilder
    private var groups: some View {
        let all = app.groups()
        let order = all.filter { !app.prefs.collapsedGroups.contains($0.id) }.flatMap { app.visibleItems($0) }
        let folders = all.filter(\.isFolder).compactMap(\.dir)
        let shown = all.filter { !$0.isFolder } + reorder.order(folders).compactMap { d in all.first { $0.isFolder && $0.dir == d } }
        ForEach(shown) { g in
            VStack(alignment: .leading, spacing: 0) {
                GroupHeader(group: g, suppressTap: { reorder.justEnded })
                    .if(g.isFolder) { $0.simultaneousGesture(reorder.gesture(g.dir ?? "", folders: folders, commit: commitOrder)) }
                if !app.prefs.collapsedGroups.contains(g.id) {
                    if g.items.isEmpty {
                        Text("No chats").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
                            .lineBox(16.2)
                            .padding(.horizontal, 8).padding(.vertical, 6)
                    }
                    VStack(spacing: 4) {
                        ForEach(app.visibleItems(g)) { c in
                            ConversationRow(conversation: c, inPinned: g.id == "pinned", number: slot(c.id, order), renaming: $renaming)
                        }
                        if g.id != "pinned" && g.items.count > 5 {
                            let open = app.expandedGroups.contains(g.id)
                            MenuRow(icon: "chevron-down", iconRotation: open ? 180 : 0, title: open ? "Show less" : "Show more (\(g.items.count - 5))", muted: true, active: false, testID: "show-more-\(g.id)") {
                                if open { app.expandedGroups.remove(g.id) } else { app.expandedGroups.insert(g.id) }
                            }
                        }
                    }
                }
            }
            .padding(8)
            .if(g.isFolder) { $0.workspaceReorderItem(g.dir ?? "", reorder) }
        }
    }

    private func commitOrder(_ dirs: [String]) {
        app.controller.setPrefs { $0.recentWorkspaces = dirs }
    }

    /// ⌘1…⌘8 for the first visible rows, ⌘9 on the last one unless it already
    /// has a number (a lone chat is ⌘1, as in chat-slot-hints.tsx).
    private func slot(_ id: String, _ order: [Conversation]) -> String? {
        guard let i = order.firstIndex(where: { $0.id == id }) else { return nil }
        if i < 8 { return Shortcuts.hint("chat\(i + 1)", app.prefs) }
        return i == order.count - 1 ? Shortcuts.hint("lastChat", app.prefs) : nil
    }

    // MARK: Footer

    private var footer: some View {
        VStack(spacing: 4) {
            if let version = AppShellUpdater.state.readyVersion {
                RestartToUpdateRow(version: version)
            }
            HStack(spacing: 4) {
                MenuRow(icon: "settings", title: "Settings", active: false, testID: "open-settings") { app.settings = true }
                Button { showResources.toggle() } label: {
                    Glyph(name: "activity", size: 14, color: Theme.mutedForeground)
                        .frame(width: 24, height: 24)
                        .hoverFill(Theme.sidebarAccent, active: showResources)
                }
                .buttonStyle(.plain)
                .tip("Resources", side: .right)
                .popover(isPresented: $showResources, arrowEdge: .trailing) { ResourcesView() }
            }
        }
        .padding(8)
    }
}

/// Footer row pinned above Settings once an update is downloaded (app-sidebar.tsx:
/// `bg-primary/10 text-primary hover:bg-primary/15`).
private struct RestartToUpdateRow: View {
    let version: String
    @State private var hover = false

    var body: some View {
        Button { AppShellUpdater.restartToUpdate() } label: {
            HStack(spacing: 8) {
                Glyph(name: "refresh-cw", size: 16, color: Theme.primary)
                Text("Restart to update")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.primary)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(8)
            .frame(height: 32)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.primary.opacity(hover ? 0.15 : 0.1)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .tip("Version \(version) downloaded — restart to apply", side: .right)
        .testID("restart-to-update")
    }
}

/// `SidebarMenuButton`: h32, p8, gap 8, 14px ink text, 16px icons, sidebar-accent hover/active.
struct MenuRow: View {
    var icon: String? = nil
    var iconRotation: Double = 0
    let title: String
    var kbd: String = ""
    var muted = false
    let active: Bool
    var testID: String? = nil
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if let icon { Glyph(name: icon, size: 16, color: muted && !hover ? Theme.mutedForeground : Theme.foreground).rotationEffect(.degrees(iconRotation)) }
                Text(title)
                    .font(.system(size: 14, weight: active ? .medium : .regular))
                    .foregroundStyle(muted && !hover ? Theme.mutedForeground : Theme.foreground)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if !kbd.isEmpty { Kbd(text: kbd, bordered: false) }
            }
            .padding(8)
            .frame(height: 32)
            .background(RoundedRectangle(cornerRadius: 8).fill(active || hover ? Theme.sidebarAccent : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .testID(testID)
    }
}

private struct SidebarCollapseButton: View {
    @Environment(AppState.self) private var app
    @State private var hover = false
    var body: some View {
        Button { app.runShortcut("toggleSidebar") } label: {
            Glyph(name: "panel-left", size: 14, color: hover ? Theme.foreground : Theme.mutedForeground)
                .frame(width: 24, height: 24)
                .background(RoundedRectangle(cornerRadius: 8).fill(hover ? Theme.sidebarAccent : .clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .tip("Toggle Sidebar", kbd: Shortcuts.hint("toggleSidebar", app.prefs), side: .right)
        .testID("collapse-sidebar")
    }
}

/// Chats/Kanban capsule switch (view-toggle.tsx).
private struct ViewToggle: View {
    @Environment(AppState.self) private var app
    var body: some View {
        HStack(spacing: 0) {
            segment(.chats, "Chats", "switchChats")
            segment(.kanban, "Kanban", "switchBoard")
        }
        .padding(3) // 1px border + p-0.5
        .background(Capsule().fill(Theme.card))
        .overlay(Capsule().strokeBorder(Theme.border, lineWidth: 1))
        .shadow(color: .black.opacity(0.04), radius: 1, y: 1)
    }

    private func segment(_ p: Page, _ label: String, _ shortcut: String) -> some View {
        let on = app.page == p
        return SegmentButton(on: on, label: label, kbd: Shortcuts.hint(shortcut, app.prefs)) {
            app.setView(ViewState(page: p, active: app.active))
        }
        .testID("page-\(p.rawValue)")
    }

    private struct SegmentButton: View {
        let on: Bool
        let label: String
        let kbd: String
        let action: () -> Void
        @State private var hover = false
        var body: some View {
            Button(action: action) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(label).font(.system(size: 12, weight: .medium))
                        .foregroundStyle(on ? Theme.primaryForeground : hover ? Theme.foreground : Theme.mutedForeground)
                    Text(kbd).font(.system(size: 11).monospacedDigit())
                        .foregroundStyle(on ? Theme.primaryForeground.opacity(0.65) : Theme.mutedForeground.opacity(0.6))
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 2)
                .frame(maxWidth: .infinity)
                .frame(height: 20.2) // py-0.5 + 16.2 line
                .background(Capsule().fill(on ? Theme.primary : .clear))
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .onHover { hover = $0 }
            .help("\(label) (\(kbd))")
        }
    }
}

private struct GroupHeader: View {
    @Environment(AppState.self) private var app
    let group: SidebarGroup
    var suppressTap: () -> Bool = { false }
    @State private var hover = false
    @State private var moreFrame: CGRect = .zero
    private var menuOpen: Bool { app.openMenu == "group-menu-\(group.id)" }

    var body: some View {
        let collapsed = app.prefs.collapsedGroups.contains(group.id)
        let lit = hover || menuOpen
        HStack(spacing: 6) {
            Glyph(name: collapsed ? "chevron-right" : lit ? "chevron-down" : glyph, size: 12, color: lit ? Theme.foreground : Theme.foreground.opacity(0.7))
            Text(group.label).font(.system(size: 12, weight: .medium))
                .foregroundStyle(lit ? Theme.foreground : Theme.foreground.opacity(0.7))
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.leading, 8)
        .padding(.trailing, 64)
        .frame(height: 32)
        .background(RoundedRectangle(cornerRadius: 8).fill(lit ? Theme.sidebarAccent : .clear))
        .contentShape(Rectangle())
        .onTapGesture {
            guard !suppressTap() else { return }
            app.controller.setPrefs { p in
                if let i = p.collapsedGroups.firstIndex(of: group.id) { p.collapsedGroups.remove(at: i) } else { p.collapsedGroups.append(group.id) }
            }
        }
        .overlay(alignment: .trailing) {
            if group.id != "pinned", let dir = group.dir {
                HStack(spacing: 8) {
                    action("square-pen") { if app.page == .kanban && dir != Env.defaultWorkspace { NewTaskDialog.present(app, workspace: dir) } else { app.newChat(dir) } }.help("New chat in \(group.label)")
                    Button { openMenu(dir) } label: {
                        Glyph(name: "more-horizontal", size: 12, color: menuOpen ? Theme.foreground : Theme.mutedForeground).frame(width: 16, height: 16).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .readFrame($moreFrame)
                    .testID("group-more-\(group.id)")
                }
                .padding(.trailing, 8)
                .opacity(lit ? 1 : 0)
            }
        }
        .onHover { hover = $0 }
        .testID("group-\(group.id)")
    }

    private var glyph: String { group.id == "pinned" ? "pin" : group.id == "chat" ? "message-square" : "folder" }

    /// The group's ⋯ menu (system NSMenu), beside the trigger.
    private func openMenu(_ dir: String) {
        app.tooltip = nil
        let isDefault = group.id == "chat"
        var items: [MenuItem] = []
        if !isDefault {
            items.append(MenuItem(id: "reveal", title: "Reveal in Finder", glyph: "folder-open") { System.reveal(dir) })
        }
        items.append(MenuItem(id: "archive", title: "Archive chats", glyph: "archive", enabled: !group.items.isEmpty) {
            for c in group.items { app.controller.archive(c.id) }
        })
        if !isDefault {
            items.append(MenuItem(id: "remove", title: "Remove", glyph: "x", group: " ") {
                app.controller.setPrefs { p in
                    p.recentWorkspaces.removeAll { $0 == dir }
                    if !p.hiddenWorkspaces.contains(dir) { p.hiddenWorkspaces.append(dir) }
                }
            })
        }
        NativeMenu.show(items, anchor: moreFrame, placement: .right, app: app, id: "group-menu-\(group.id)")
    }

    private func action(_ icon: String, _ run: @escaping () -> Void) -> some View {
        Button(action: run) { Glyph(name: icon, size: 12, color: Theme.mutedForeground).frame(width: 16, height: 16).contentShape(Rectangle()) }
            .buttonStyle(.plain)
    }
}

struct ConversationRow: View {
    @Environment(AppState.self) private var app
    let conversation: Conversation
    var inPinned = false
    let number: String?
    @Binding var renaming: String?
    @State private var hover = false
    @State private var draft = ""
    @State private var moreFrame: CGRect = .zero
    @FocusState private var focused: Bool

    var body: some View {
        let c = conversation
        let active = app.page == .chats && app.active == c.id
        let lit = active || hover || menuOpen
        HStack(spacing: 8) {
            if c.pinnedAt != nil && !inPinned { Glyph(name: "pin", size: 16, color: Theme.mutedForeground) }
            if c.sourceAutomationId != nil { Glyph(name: "clock", size: 16, color: Theme.mutedForeground) }
            if renaming == c.id {
                TextField("Untitled", text: $draft)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14))
                    .focused($focused)
                    .onSubmit { commit() }
                    .onExitCommand { renaming = nil }
                    .onChange(of: focused) { _, f in if !f && renaming == c.id { commit() } }
                    .onAppear { draft = c.title; DispatchQueue.main.async { focused = true } }
                    .testID("rename-\(c.id)")
            } else {
                Text(c.title.isEmpty ? "Untitled" : c.title)
                    .font(.system(size: 14, weight: active ? .medium : .regular))
                    .foregroundStyle(Theme.foreground)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.leading, 8)
        .padding(.trailing, 40)
        .frame(height: 32)
        .background(RoundedRectangle(cornerRadius: 8).fill(lit ? Theme.sidebarAccent : .clear))
        .overlay(alignment: .trailing) { if renaming != c.id { trailing(active: active) } }
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        // Inside the tooltip: its own dismiss tap is a child gesture of whatever
        // wraps it, and a child tap beats a parent's, so a row tap applied after
        // `.tip` never fired (clicking a chat did nothing).
        .onTapGesture { app.tooltip = nil; app.openChat(c.id) }
        .if(renaming != c.id) { $0.tip(id: "row-\(c.id)", side: .right, offset: 6, alignStart: true) { RowDetailsCard(id: c.id) } }
        .onRightClick(enabled: renaming != c.id) { openMenu(atPointer: true) }
        .testID("chat-row-\(c.id)")
    }

    @ViewBuilder
    private func trailing(active: Bool) -> some View {
        let c = conversation
        ZStack(alignment: .trailing) {
            // Status slot (fades on hover; the ⌘-held slot chip doesn't).
            Group {
                if app.showNumberHints, let number {
                    Text(number).font(.system(size: 11)).foregroundStyle(Theme.foreground.opacity(0.8))
                        .padding(.horizontal, 6).frame(height: 18)
                        .background(RoundedRectangle(cornerRadius: 4).fill(Theme.background))
                        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Theme.border, lineWidth: 1))
                        .shadow(color: .black.opacity(0.05), radius: 1, y: 1)
                } else if c.runState == .running {
                    Spinner(size: 16, color: Theme.mutedForeground.opacity(0.7)).opacity(hover || menuOpen ? 0 : 1)
                } else if c.unread {
                    Circle().fill(Theme.primary).frame(width: 8, height: 8).opacity(hover || menuOpen ? 0 : 1)
                } else {
                    Text(Fmt.relative(c.updatedAt))
                        .font(.system(size: 12, design: .monospaced).monospacedDigit())
                        .tracking(-0.3)
                        .foregroundStyle(active ? Theme.foreground.opacity(0.7) : Theme.mutedForeground.opacity(0.7))
                        .opacity(hover || menuOpen ? 0 : 1)
                }
            }
            .frame(minWidth: 28)
            .padding(.trailing, 8)

            if (hover || menuOpen) && !app.showNumberHints {
                // Scrim so long titles dissolve under the actions.
                LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: Theme.sidebarAccent, location: 0.45), .init(color: Theme.sidebarAccent, location: 1)],
                               startPoint: .leading, endPoint: .trailing)
                    .frame(width: 96, height: 32)
                    .clipShape(UnevenRoundedRectangle(bottomTrailingRadius: 8, topTrailingRadius: 8))
                    .allowsHitTesting(false)
                HStack(spacing: 8) {
                    Button { openMenu() } label: {
                        Glyph(name: "more-horizontal", size: 14, color: Theme.mutedForeground.opacity(menuOpen ? 1 : 0.8)).frame(width: 16, height: 16).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .readFrame($moreFrame)
                    .testID("more-\(c.id)")
                    Button { if app.active == c.id { app.archiveActive() } else { app.controller.archive(c.id) } } label: {
                        Glyph(name: "archive", size: 14, color: Theme.mutedForeground.opacity(0.8)).frame(width: 16, height: 16).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .tip("Archive", kbd: Shortcuts.hint("archiveChat", app.prefs), side: .right)
                    .testID("archive-\(c.id)")
                }
                .padding(.trailing, 4)
            }
        }
    }


    private var menuOpen: Bool { app.openMenu == "row-menu-\(conversation.id)" }

    /// The row's ⋯ / right-click menu (system NSMenu): Pin/Unpin, Rename.
    private func openMenu(atPointer: Bool = false) {
        let c = conversation
        app.tooltip = nil
        let items = [
            MenuItem(id: "pin", title: c.pinnedAt != nil ? "Unpin" : "Pin", glyph: c.pinnedAt != nil ? "pin-off" : "pin") {
                app.controller.setPinned(c.id, c.pinnedAt == nil)
            },
            MenuItem(id: "rename", title: "Rename", glyph: "pencil") {
                renaming = c.id
            },
        ]
        NativeMenu.show(items, anchor: moreFrame, placement: atPointer ? .pointer : .right, app: app, id: "row-menu-\(c.id)")
    }

    private func commit() {
        let t = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty && t != conversation.title { app.controller.rename(conversation.id, t) }
        renaming = nil
    }
}

/// Details card beside a hovered row (conversation-row.tsx TooltipContent
/// w-60 px-3 py-2.5 gap-2): runtime, model · effort, folder, context, created.
struct RowDetailsCard: View {
    @Environment(AppState.self) private var app
    let id: String
    var body: some View {
        if let c = app.controller.conversation(id) {
            let rt = Runtimes.byId(c.backend)
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Circle().fill(c.backend == "dsh" ? Theme.background : Theme.runtimeColor(c.backend)).frame(width: 6, height: 6)
                    Text(rt.label).font(.system(size: 12, weight: .medium)).lineLimit(1).lineBox(16)
                    Spacer(minLength: 0)
                    if c.runState == .running {
                        HStack(spacing: 6) {
                            Circle().fill(Theme.background.opacity(0.7)).frame(width: 6, height: 6)
                            Text("In progress")
                        }
                        .font(.system(size: 12)).foregroundStyle(Theme.background.opacity(0.7))
                    }
                }
                VStack(alignment: .leading, spacing: 4) {
                    let t = tuning(c)
                    line("cpu", t.effort.map { "\(t.model) · \($0)" } ?? t.model)
                    line("folder", Env.folderName(c.workspaceDir))
                    if c.backend != "pi", let ctx = app.controller.chatIfLoaded(c.id)?.context, ctx.window > 0 {
                        line("gauge", "Context · \(min(100, Int((ctx.used / ctx.window * 100).rounded())))% · \(Fmt.tokens(ctx.used)) / \(Fmt.tokens(ctx.window))")
                    }
                }
                .font(.system(size: 12))
                .foregroundStyle(Theme.background.opacity(0.7))
                Text(Fmt.created(c.createdAt))
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundStyle(Theme.background.opacity(0.5))
                    .lineBox(16)
                    .padding(.top, 7) // border-t + pt-1.5
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(alignment: .top) { Rectangle().fill(Theme.background.opacity(0.15)).frame(height: 1) }
            }
            .foregroundStyle(Theme.background)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(width: 240, alignment: .leading)
        }
    }

    /// runtimeTuning in conversation-row.tsx.
    private func tuning(_ c: Conversation) -> (model: String, effort: String?) {
        if c.backend == "pi" {
            let efforts = ["off": "Quick", "minimal": "Minimal", "low": "Low", "medium": "Medium", "high": "High", "xhigh": "XHigh", "max": "Max"]
            let m = c.cliModel
            let model = m == "flash" ? "DeepSeek V4 Flash" : m == "pro" ? "DeepSeek V4 Pro"
                : (m.split(separator: "/").dropFirst().joined(separator: "/").nonEmpty ?? m)
            return (model, efforts[c.cliEffort])
        }
        let d = app.controller.cliDefaults[c.backend]
        let model = c.cliModel.nonEmpty ?? d?.model ?? "Default"
        return (Self.displayModelName(model), c.cliEffort.nonEmpty ?? d?.effort)
    }

    private static func displayModelName(_ raw: String) -> String {
        guard let m = raw.firstMatch(of: /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.ignoresCase()) else { return raw }
        let fam = m.1.prefix(1).uppercased() + m.1.dropFirst().lowercased()
        return "\(fam) \(m.3.map { "\(m.2).\($0)" } ?? String(m.2))"
    }

    private func line(_ icon: String, _ text: String) -> some View {
        HStack(spacing: 6) {
            Glyph(name: icon, size: 12, color: Theme.background.opacity(0.6))
            Text(text).lineLimit(1).lineBox(16)
        }
    }
}

/// Kanban mode: a "Workspaces" filter group.
private struct KanbanSidebarGroup: View {
    @Environment(AppState.self) private var app
    @State private var reorder = WorkspaceReorder()
    var body: some View {
        let groups = app.groups()
        let chat = groups.filter { $0.id == "chat" }
        let folders = groups.filter(\.isFolder).compactMap(\.dir)
        let all = app.controller.conversations.count
        VStack(alignment: .leading, spacing: 0) {
            Text("Workspaces").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.foreground.opacity(0.7))
                .padding(.horizontal, 8).frame(height: 32)
            VStack(spacing: 4) {
                row(nil, "All workspaces", nil, all)
                ForEach(chat) { g in row(g.dir, g.label, "message-square", g.items.count) }
                ForEach(reorder.order(folders), id: \.self) { dir in
                    if let g = groups.first(where: { $0.isFolder && $0.dir == dir }) {
                        row(dir, g.label, "folder", g.items.count)
                            .simultaneousGesture(reorder.gesture(dir, folders: folders) { order in app.controller.setPrefs { $0.recentWorkspaces = order } })
                            .workspaceReorderItem(dir, reorder)
                            .testID("kanban-workspace-\(dir)")
                    }
                }
            }
        }
        .padding(8)
        .coordinateSpace(.named(WorkspaceReorder.space))
    }

    private func row(_ dir: String?, _ label: String, _ icon: String?, _ count: Int) -> some View {
        let active = app.kanbanFilter == dir
        return Button { if !reorder.justEnded { app.kanbanFilter = dir } } label: {
            HStack(spacing: 8) {
                if let icon { Glyph(name: icon, size: 16, color: Theme.foreground) }
                Text(label).font(.system(size: 14, weight: active ? .medium : .regular)).foregroundStyle(Theme.foreground).lineLimit(1)
                Spacer(minLength: 0)
                Text("\(count)").font(.system(size: 12)).foregroundStyle(active ? Theme.foreground.opacity(0.8) : Theme.mutedForeground)
            }
            .padding(8)
            .frame(height: 32)
            .hoverFill(Theme.sidebarAccent, active: active)
        }
        .buttonStyle(.plain)
    }
}

/// Processes Cetus spawned (agentd and its runtimes), with memory and CPU.
struct ResourcesView: View {
    @State private var rows: [(pid: Int, depth: Int, rss: Int, cpu: Double, name: String)] = []
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Resources").font(.system(size: 12, weight: .semibold))
                .padding(.horizontal, 12).padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
            VStack(alignment: .leading, spacing: 0) {
                if rows.isEmpty {
                    Text("No agent processes running.").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).padding(8)
                }
                ForEach(rows, id: \.pid) { r in
                    HStack(spacing: 8) {
                        Circle().fill(Theme.primary).frame(width: 6, height: 6)
                        Text(String(repeating: "  ", count: r.depth) + r.name).lineLimit(1)
                        Spacer(minLength: 0)
                        Text(String(format: "%.1f%%", r.cpu)).foregroundStyle(Theme.mutedForeground).frame(width: 56, alignment: .trailing)
                        Text(String(format: "%.0f MB", Double(r.rss) / 1024)).foregroundStyle(Theme.mutedForeground).frame(width: 64, alignment: .trailing)
                    }
                    .font(.system(size: 12).monospacedDigit())
                    .padding(.horizontal, 8).padding(.vertical, 6)
                    .hoverFill(Theme.accent)
                }
            }
            .padding(6)
        }
        .frame(width: 320)
        .onAppear(perform: load)
    }

    private func load() {
        DispatchQueue.global().async {
            guard let out = System.run(["ps", "-A", "-o", "pid=,ppid=,rss=,%cpu=,comm="]) else { return }
            var children: [Int: [(Int, Int, Double, String)]] = [:]
            for line in out.split(separator: "\n") {
                let parts = line.split(separator: " ", maxSplits: 4, omittingEmptySubsequences: true)
                guard parts.count == 5, let pid = Int(parts[0]), let ppid = Int(parts[1]), let rss = Int(parts[2]), let cpu = Double(parts[3]) else { continue }
                children[ppid, default: []].append((pid, rss, cpu, URL(fileURLWithPath: String(parts[4])).lastPathComponent))
            }
            var result: [(Int, Int, Int, Double, String)] = []
            func walk(_ pid: Int, _ depth: Int) {
                for c in children[pid] ?? [] {
                    result.append((c.0, depth, c.1, c.2, c.3))
                    walk(c.0, depth + 1)
                }
            }
            walk(Int(ProcessInfo.processInfo.processIdentifier), 0)
            DispatchQueue.main.async { rows = result.map { ($0.0, $0.1, $0.2, $0.3, $0.4) } }
        }
    }
}
